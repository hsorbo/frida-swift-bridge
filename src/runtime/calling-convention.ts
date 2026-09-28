import { Metadata, MetadataKind } from "../abi/metadata.js";
import { enumerateFields, fieldTypeIn } from "../abi/field-descriptor.js";
import { existentialRepresentation } from "../abi/existential.js";
import { enumerateTupleElements } from "../abi/tuple.js";
import { SwiftError } from "./thrown-error.js";
import { typeName, mangledTypeName, buildMangledTypeToken } from "./type-name.js";
import { ContextDescriptorKind } from "../abi/context-descriptor.js";
import { exportsByPrefix } from "./export-trie.js";
import { demangle } from "./demangle.js";
import { signCode } from "../basic/pac.js";

const MAX_DIRECT_REGISTERS = 4;

const ARCH = Process.arch;

const resilientModules = new Set<string>();
const frozenTypes = new Set<string>();

const FROZEN_BY_DEFAULT_MODULES = new Set(["Swift", "Synchronization"]);

export function markResilientModule(name: string): void {
  resilientModules.add(name);
  resilientValueCache.clear();
}

export function markFrozenType(name: string): void {
  frozenTypes.add(name);
  resilientValueCache.clear();
}

const resilientValueCache = new Map<string, boolean>();

export function isResilientValueType(metadata: Metadata): boolean {
  const kind = metadata.kind;
  if (kind !== MetadataKind.Struct && kind !== MetadataKind.Enum && kind !== MetadataKind.Optional) {
    return false;
  }
  const key = metadata.handle.toString();
  const cached = resilientValueCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  resilientValueCache.set(key, false); // break recursive-type cycles
  const result = isResilientNominal(metadata) || embedsResilientValue(metadata);
  resilientValueCache.set(key, result);
  return result;
}

function embedsResilientValue(metadata: Metadata): boolean {
  for (const field of enumerateFields(metadata.description)) {
    const fieldType = fieldTypeIn(metadata, field);
    if (fieldType !== null && isResilientValueType(fieldType)) {
      return true;
    }
  }
  return false;
}

function isResilientNominal(metadata: Metadata): boolean {
  const description = metadata.description;
  const moduleName = description.moduleName;
  const fullName = description.fullTypeName;
  if (moduleName === null || fullName === null || FROZEN_BY_DEFAULT_MODULES.has(moduleName)) {
    return false;
  }
  const image = Process.findModuleByAddress(description.handle);
  const token = description.isGeneric ? buildMangledTypeToken(description) : mangledTypeName(metadata);
  if (image === null || token === null) {
    return false;
  }
  if (description.kind === ContextDescriptorKind.Enum) {
    return exportsOwnEnumCase(image, token, fullName);
  }
  if (frozenTypes.has(fullName)) {
    return false;
  }
  const isPublic = image.findExportByName(`$s${token}Mn`) !== null;
  return isPublic && (resilientModules.has(moduleName) || isLibraryEvolutionImage(image));
}

function exportsOwnEnumCase(image: Module, token: string, fullName: string): boolean {
  const ownCase = `enum case for ${fullName}.`;
  return exportsByPrefix(image, [`$s${token}`])[0].some((e) => {
    if (!e.name.endsWith("WC")) {
      return false;
    }
    const demangled = demangle(e.name);
    return demangled !== null && demangled.startsWith(ownCase) && /^[^.(<]+[(<]/.test(demangled.slice(ownCase.length));
  });
}

const libraryEvolutionImages = new Map<string, boolean>();

function isLibraryEvolutionImage(image: Module): boolean {
  const key = `${image.path}@${image.base}`;
  let known = libraryEvolutionImages.get(key);
  if (known === undefined) {
    known = image
      .enumerateExports()
      .some((e) => e.name.startsWith("$s") && (e.name.endsWith("Tj") || e.name.endsWith("WC")));
    libraryEvolutionImages.set(key, known);
  }
  return known;
}

// Integer/pointer-class only; floating-point uses the separate v-register budget below.
export function shouldPassIndirectly(metadata: Metadata): boolean {
  if (metadata.kind === MetadataKind.Existential && existentialRepresentation(metadata) === "opaque") {
    return true; // opaque existentials are address-only
  }
  if (isResilientValueType(metadata)) {
    return true;
  }
  return !metadata.valueWitnesses.isBitwiseTakable || registerCount(loweredScalars(metadata)) > MAX_DIRECT_REGISTERS;
}

export type FloatClass = "double" | "float";

export function floatClass(metadata: Metadata): FloatClass | null {
  switch (typeName(metadata)) {
    case "Swift.Double":
    case "Swift.Float64":
      return "double";
    case "Swift.Float":
    case "Swift.Float32":
      return "float";
    default:
      return null;
  }
}

export interface FloatLayout {
  cls: FloatClass;
  count: number;
}

// swiftcc passes each FP leaf in its own v-register; homogeneous and ≤4 (scalar = count 1).
export function floatLayout(metadata: Metadata): FloatLayout | null {
  const scalar = floatClass(metadata);
  if (scalar !== null) {
    return { cls: scalar, count: 1 };
  }
  if (metadata.kind !== MetadataKind.Struct) {
    return null;
  }
  let cls: FloatClass | null = null;
  let count = 0;
  for (const field of enumerateFields(metadata.description)) {
    const fieldType = fieldTypeIn(metadata, field);
    if (fieldType === null) {
      return null;
    }
    const leaf = floatLayout(fieldType);
    if (leaf === null || (cls !== null && leaf.cls !== cls)) {
      return null;
    }
    cls = leaf.cls;
    count += leaf.count;
    if (count > 4) {
      return null;
    }
  }
  return cls === null ? null : { cls, count };
}

export interface LoweredScalar {
  offset: number;
  size: number;
  cls: "int" | FloatClass;
}

interface ScalarLeaf {
  offset: number;
  size: number;
  cls: "bytes" | "i128" | FloatClass;
}

const CHUNK_SIZE = 8;
const STRUCT_DESC_FIELD_OFFSET_VECTOR_OFFSET = 0x18;

const loweredScalarCache = new Map<string, LoweredScalar[]>();

// swiftcc lowers a direct value to scalars the way clang's SwiftAggLowering does: every Float/Double
// stays its own FP scalar, and the integer bytes between them merge within each 8-byte chunk into the
// narrowest aligned power of two covering them. {Int8, Int} passes as (i8, i64), {Double, Bool, Bool}
// as (double, i16), an Int? as (i64, i8). A padding word passes nothing; a Builtin.Int128 stays one i128.
export function loweredScalars(metadata: Metadata): LoweredScalar[] {
  const key = metadata.handle.toString();
  let lowered = loweredScalarCache.get(key);
  if (lowered === undefined) {
    lowered = [];
    let run: { begin: number; end: number } | null = null;
    for (const leaf of scalarLeaves(metadata, 0)) {
      if (leaf.cls === "bytes" && run !== null && chunkOf(run.end - 1) === chunkOf(leaf.offset)) {
        run.end = leaf.offset + leaf.size;
        continue;
      }
      if (run !== null) {
        pushIntegerUnits(run.begin, run.end, lowered);
        run = null;
      }
      if (leaf.cls === "bytes") {
        run = { begin: leaf.offset, end: leaf.offset + leaf.size };
      } else {
        lowered.push({ offset: leaf.offset, size: leaf.size, cls: leaf.cls === "i128" ? "int" : leaf.cls });
      }
    }
    if (run !== null) {
      pushIntegerUnits(run.begin, run.end, lowered);
    }
    loweredScalarCache.set(key, lowered);
  }
  return lowered;
}

export function registerCount(scalars: LoweredScalar[]): number {
  return scalars.reduce((n, s) => n + (s.cls === "int" ? Math.ceil(s.size / 8) : 1), 0);
}

function chunkOf(offset: number): number {
  return Math.floor(offset / CHUNK_SIZE);
}

function pushIntegerUnits(begin: number, end: number, out: LoweredScalar[]): void {
  while (begin < end) {
    const localEnd = Math.min(end, (chunkOf(begin) + 1) * CHUNK_SIZE);
    let size = 1;
    while (Math.floor(begin / size) * size + size < localEnd) {
      size *= 2;
    }
    out.push({ offset: Math.floor(begin / size) * size, size, cls: "int" });
    begin = localEnd;
  }
}

function* scalarLeaves(metadata: Metadata, offset: number): Generator<ScalarLeaf> {
  const fp = floatClass(metadata);
  if (fp !== null) {
    yield { offset, size: metadata.valueWitnesses.size, cls: fp };
    return;
  }
  const members = aggregateMembers(metadata);
  if (members !== null) {
    for (const m of members) {
      yield* scalarLeaves(m.type, offset + m.offset);
    }
    return;
  }
  const size = metadata.valueWitnesses.size;
  if (size > 0) {
    yield { offset, size, cls: typeName(metadata) === "Builtin.Int128" ? "i128" : "bytes" };
  }
}

interface AggregateMember {
  type: Metadata;
  offset: number;
}

function aggregateMembers(metadata: Metadata): AggregateMember[] | null {
  let members: AggregateMember[] | null = null;
  if (metadata.kind === MetadataKind.Struct) {
    members = structMembers(metadata);
  } else if (metadata.kind === MetadataKind.Tuple) {
    members = [...enumerateTupleElements(metadata)];
  } else if (metadata.kind === MetadataKind.Enum) {
    members = singleCasePayload(metadata);
  }
  return members !== null && members.length > 0 ? members : null;
}

function structMembers(metadata: Metadata): AggregateMember[] | null {
  const descriptor = metadata.description;
  const vectorOffset = descriptor.handle.add(STRUCT_DESC_FIELD_OFFSET_VECTOR_OFFSET).readU32();
  if (vectorOffset === 0) {
    return null;
  }
  const offsets = metadata.handle.add(vectorOffset * Process.pointerSize);
  const members: AggregateMember[] = [];
  for (const field of enumerateFields(descriptor)) {
    const type = fieldTypeIn(metadata, field);
    if (type === null) {
      return null;
    }
    members.push({ type, offset: offsets.add(members.length * 4).readU32() });
  }
  return members;
}

function singleCasePayload(metadata: Metadata): AggregateMember[] | null {
  const cases = [...enumerateFields(metadata.description)];
  if (cases.length !== 1 || cases[0].mangledTypeName === null || cases[0].isIndirectCase) {
    return null;
  }
  const payload = fieldTypeIn(metadata, cases[0]);
  return payload === null ? null : [{ type: payload, offset: 0 }];
}

const GP_ARG_REGISTERS = ARCH === "arm64" ? 8 : 6;
const FP_ARG_REGISTERS = 8;
// Darwin arm64 packs a stack-passed scalar at its own size and alignment; AAPCS64 and SysV x86-64
// give each one an 8-byte slot.
const PACKS_STACK_ARGS = ARCH === "arm64" && Process.platform === "darwin";
const I128_STARTS_AT_EVEN_REGISTER = ARCH === "arm64" && !PACKS_STACK_ARGS;

export type RegisterLocation = { register: "gp" | "fp"; index: number };
export type ArgLocation = RegisterLocation | { stackOffset: number };

// swiftcc places each lowered scalar on its own, so an aggregate can straddle the last register and
// the stack. Stack offsets are relative to the first stack-passed argument.
export class ArgumentAllocator {
  private ngrn: number;
  private nsrn = 0;
  stackSize = 0;

  constructor(startReg = 0, private readonly placesResult = false) {
    this.ngrn = startReg;
  }

  gp(width = 8): ArgLocation {
    if (this.ngrn < GP_ARG_REGISTERS) {
      return { register: "gp", index: this.ngrn++ };
    }
    return this.stackSlot(width);
  }

  // arm64 passes an i128 in a register pair that never starts at x7, else in a 16-byte-aligned stack
  // slot that retires x7. AAPCS64 also starts an argument pair at an even register, but not a result.
  // x86-64 compilers disagree on where one goes once r8 is taken.
  gp128(): ArgLocation {
    if (ARCH !== "arm64" && this.ngrn > GP_ARG_REGISTERS - 2) {
      throw new Error("an Int128 argument past r8 is unsupported on x86-64");
    }
    if (I128_STARTS_AT_EVEN_REGISTER && !this.placesResult) {
      this.ngrn += this.ngrn % 2;
    }
    if (this.ngrn < GP_ARG_REGISTERS - 1) {
      const index = this.ngrn;
      this.ngrn += 2;
      return { register: "gp", index };
    }
    this.ngrn = GP_ARG_REGISTERS;
    return this.stackSlot(16);
  }

  fp(width: number): ArgLocation {
    if (this.nsrn < FP_ARG_REGISTERS) {
      return { register: "fp", index: this.nsrn++ };
    }
    return this.stackSlot(width);
  }

  scalar({ size, cls }: LoweredScalar): ArgLocation {
    if (cls !== "int") {
      return this.fp(size);
    }
    return size === 16 ? this.gp128() : this.gp(size);
  }

  private stackSlot(width: number): ArgLocation {
    const size = PACKS_STACK_ARGS ? width : Math.max(width, 8);
    const stackOffset = Math.ceil(this.stackSize / size) * size;
    this.stackSize = stackOffset + size;
    return { stackOffset };
  }
}

// A generic-typed value is always passed indirectly.
export interface GenericRef {
  genericParam: number;
}

// Concrete value the generic callee treats as address-only (e.g. Optional<T>): lowered indirect.
export interface AbstractIndirect {
  metadata: Metadata;
  addressOnly: true;
}

export function indirect(metadata: Metadata): AbstractIndirect {
  return { metadata, addressOnly: true };
}

// thick closure: two direct words [fnPointer, context] passed in normal arg registers, not x20
export interface ClosureRef {
  closure: true;
}

const CLOSURE_WORDS = 2;

export type SwiftArgType = Metadata | GenericRef | AbstractIndirect | ClosureRef;

function isGenericRef(arg: SwiftArgType): arg is GenericRef {
  return !(arg instanceof Metadata) && "genericParam" in arg;
}

function isAbstractIndirect(arg: SwiftArgType): arg is AbstractIndirect {
  return !(arg instanceof Metadata) && "addressOnly" in arg;
}

function isClosureRef(arg: SwiftArgType): arg is ClosureRef {
  return !(arg instanceof Metadata) && "closure" in arg;
}

function wordPieces(count: number): LoweredScalar[] {
  return Array.from({ length: count }, (_, i) => ({ offset: i * 8, size: 8, cls: "int" }));
}

interface LoweredArg {
  indirect: boolean;
  pieces: LoweredScalar[];
}

function lowerArg(arg: SwiftArgType): LoweredArg {
  if (isClosureRef(arg)) {
    return { indirect: false, pieces: wordPieces(CLOSURE_WORDS) };
  }
  if (isGenericRef(arg) || isAbstractIndirect(arg)) {
    return { indirect: true, pieces: [] };
  }
  // indirect before HFA: a resilient float aggregate is @in, not spread across v-registers
  if (shouldPassIndirectly(arg)) {
    return { indirect: true, pieces: [] };
  }
  return { indirect: false, pieces: loweredScalars(arg) };
}

// The arguments are laid out in a frame of every argument register, GP then FP, followed by the
// stack-passed bytes. libffi loads the registers from as many uint64/double arguments and copies the
// trailing uint64 words to the stack verbatim, so placement follows ArgumentAllocator exactly.
const REGISTER_FRAME_SIZE = (GP_ARG_REGISTERS + FP_ARG_REGISTERS) * 8;

function frameOffset(location: ArgLocation): number {
  if ("stackOffset" in location) {
    return REGISTER_FRAME_SIZE + location.stackOffset;
  }
  return (location.register === "gp" ? location.index : GP_ARG_REGISTERS + location.index) * 8;
}

interface PlacedScalar {
  scalar: LoweredScalar;
  location: ArgLocation;
}

// Each result register a direct result uses, stored by the trampoline at its frame offset.
function resultRegisters(placed: PlacedScalar[]): RegisterLocation[] {
  return placed.flatMap(({ scalar, location }) => {
    const { register, index } = location as RegisterLocation;
    const count = register === "gp" ? Math.ceil(scalar.size / 8) : 1;
    return Array.from({ length: count }, (_, k) => ({ register, index: index + k }));
  });
}

export interface SwiftNativeFunctionOptions {
  hasSelf?: boolean;
  throws?: boolean;
  typeArguments?: Metadata[];
  witnessTables?: NativePointer[];
  consumedArgs?: number[];
}

export type SwiftNativeFunction = (...args: NativePointer[]) => NativePointer | null;

// args/result are pointers to value bytes (result freshly allocated; null for void). When
// hasSelf, the first argument is the self/context pointer (x20 / r13).
export function makeSwiftNativeFunction(
  address: NativePointer,
  returnType: SwiftArgType | null,
  argTypes: SwiftArgType[],
  options: SwiftNativeFunctionOptions = {}
): SwiftNativeFunction {
  const hasSelf = options.hasSelf === true;
  const throws = options.throws === true;
  const typeArguments = options.typeArguments ?? [];
  const witnessTables = options.witnessTables ?? [];
  const consumed = new Set(options.consumedArgs ?? []);
  const argMetadata = argTypes.map((a) =>
    a instanceof Metadata ? a : isAbstractIndirect(a) ? a.metadata : null
  );
  const typeArgumentFor = (ref: GenericRef): Metadata => {
    const metadata = typeArguments[ref.genericParam];
    if (metadata === undefined) {
      throw new Error(`no type argument for generic parameter ${ref.genericParam}`);
    }
    return metadata;
  };

  const loweredArgs = argTypes.map(lowerArg);
  // Only a concrete @in argument can be consumed: we hand the callee a private copy to destroy.
  // Direct, generic, and closure args have no such copy; inout is borrowed, never consumed here.
  if (options.consumedArgs !== undefined) {
    const seen = new Set<number>();
    for (const i of options.consumedArgs) {
      if (!Number.isInteger(i) || i < 0 || i >= argTypes.length) {
        throw new Error(`consumedArgs: invalid argument index ${i}`);
      }
      if (seen.has(i)) {
        throw new Error(`consumedArgs: duplicate argument index ${i}`);
      }
      seen.add(i);
      if (argMetadata[i] === null || !loweredArgs[i].indirect) {
        throw new Error(`consumedArgs: argument ${i} is not a concrete indirectly-passed parameter`);
      }
    }
  }
  const allocator = new ArgumentAllocator();
  const argLocations = loweredArgs.map((arg) =>
    arg.indirect ? [allocator.gp()] : arg.pieces.map((piece) => allocator.scalar(piece))
  );
  // trailing implicit args after the formal ones: a type-metadata pointer per param, then witnesses
  const implicitArgs = [...typeArguments.map((m) => m.handle), ...witnessTables];
  const implicitLocations = implicitArgs.map(() => allocator.gp());
  const stackWords = Math.ceil(allocator.stackSize / 8);
  const fridaArgTypes: NativeFunctionArgumentType[] = [
    ...new Array<NativeFunctionArgumentType>(GP_ARG_REGISTERS).fill("uint64"),
    ...new Array<NativeFunctionArgumentType>(FP_ARG_REGISTERS).fill("double"),
    ...new Array<NativeFunctionArgumentType>(stackWords).fill("uint64"),
  ];

  let indirectResult = false;
  let directResult: PlacedScalar[] = [];
  let resultSize = 0;
  let resultStride = 0;
  if (returnType !== null) {
    if (isClosureRef(returnType)) {
      throw new Error("closure return types are not supported");
    }
    const forcedIndirect = isGenericRef(returnType) || isAbstractIndirect(returnType);
    const returnMetadata = isGenericRef(returnType)
      ? typeArgumentFor(returnType)
      : isAbstractIndirect(returnType)
        ? returnType.metadata
        : returnType;
    resultSize = returnMetadata.valueWitnesses.size;
    resultStride = returnMetadata.valueWitnesses.stride;
    if (resultSize > 0) {
      // indirect before HFA, as in lowerArg
      if (forcedIndirect || shouldPassIndirectly(returnMetadata)) {
        indirectResult = true;
      } else {
        const resultAllocator = new ArgumentAllocator(0, true);
        directResult = loweredScalars(returnMetadata).map((scalar) => ({
          scalar,
          location: resultAllocator.scalar(scalar),
        }));
      }
    }
  }

  // The returned closure captures `resources`, keeping the trampoline's baked buffers alive
  // (Frida frees a Memory.alloc when its NativePointer is collected). self/error/scratch and the
  // consumed-argument copies are single shared buffers per function, so the trampoline is not re-entrant.
  const savesContext = hasSelf || throws;
  const code = Memory.alloc(Process.pageSize);
  const save = Memory.alloc(Process.pointerSize * (savesContext ? 4 : 2));
  const scratch = resultSize > 0 ? Memory.alloc(Math.max(resultStride, REGISTER_FRAME_SIZE)) : ptr(0);
  const selfBuffer = hasSelf ? Memory.alloc(Process.pointerSize) : null;
  const errorBuffer = throws ? Memory.alloc(Process.pointerSize) : null;
  const consumedCopies = argMetadata.map((m, i) => (consumed.has(i) ? Memory.alloc(m!.typeLayout.stride) : null));
  writeTrampoline(code, {
    save,
    target: address.strip(),
    selfBuffer,
    errorBuffer,
    indirectResultBuffer: indirectResult ? scratch : null,
    resultBuffer: directResult.length > 0 ? scratch : null,
    resultRegisters: resultRegisters(directResult),
  });
  const resources = {
    code,
    save,
    scratch,
    selfBuffer,
    errorBuffer,
    consumedCopies,
    invoke: new NativeFunction(signCode(code), "void", fridaArgTypes) as unknown as (
      ...args: NativeFunctionArgumentValue[]
    ) => void,
  };

  return (...args: NativePointer[]): NativePointer | null => {
    const expected = argTypes.length + (hasSelf ? 1 : 0);
    if (args.length !== expected) {
      throw new Error(`expected ${expected} argument(s), got ${args.length}`);
    }

    let next = 0;
    if (hasSelf) {
      resources.selfBuffer!.writePointer(args[next++]);
    }

    const frame = Memory.alloc(REGISTER_FRAME_SIZE + stackWords * 8);
    for (let i = 0; i < loweredArgs.length; i++) {
      const lowered = loweredArgs[i];
      const value = args[next++];
      if (lowered.indirect) {
        // consumed (+1): the callee destroys it, so hand it a copy
        const copy = resources.consumedCopies[i];
        if (copy !== null) {
          argMetadata[i]!.valueWitnesses.initializeWithCopy(copy, value);
        }
        frame.add(frameOffset(argLocations[i][0])).writePointer(copy ?? value);
      } else {
        lowered.pieces.forEach((piece, k) => {
          const location = argLocations[i][k];
          const slot = frame.add(frameOffset(location));
          if ("register" in location) {
            slot.writeU64(0);
          }
          Memory.copy(slot, value.add(piece.offset), piece.size);
        });
      }
    }
    implicitArgs.forEach((arg, k) => frame.add(frameOffset(implicitLocations[k])).writePointer(arg));

    const physical: NativeFunctionArgumentValue[] = [];
    for (let i = 0; i < fridaArgTypes.length; i++) {
      const slot = frame.add(i * 8);
      physical.push(fridaArgTypes[i] === "double" ? slot.readDouble() : slot.readU64());
    }
    resources.invoke(...physical);

    if (throws) {
      const error = resources.errorBuffer!.readPointer();
      if (!error.isNull()) {
        throw new SwiftError(error, true);
      }
    }

    if (resultSize === 0) {
      return null;
    }
    const out = Memory.alloc(resultStride);
    if (directResult.length === 0) {
      Memory.copy(out, resources.scratch, resultSize);
    } else {
      for (const { scalar, location } of directResult) {
        Memory.copy(out.add(scalar.offset), resources.scratch.add(frameOffset(location)), scalar.size);
      }
    }
    return out;
  };
}

interface TrampolineConfig {
  save: NativePointer;
  target: NativePointer;
  selfBuffer: NativePointer | null;
  errorBuffer: NativePointer | null;
  indirectResultBuffer: NativePointer | null;
  resultBuffer: NativePointer | null;
  resultRegisters: RegisterLocation[];
}

function writeTrampoline(code: NativePointer, cfg: TrampolineConfig): void {
  if (ARCH === "arm64") {
    writeArm64Trampoline(code, cfg);
  } else {
    writeX86Trampoline(code, cfg);
  }
}

function writeArm64Trampoline(code: NativePointer, cfg: TrampolineConfig): void {
  const savesContext = cfg.selfBuffer !== null || cfg.errorBuffer !== null;

  Memory.patchCode(code, 0x100, (slot) => {
    const writer = new Arm64Writer(slot, { pc: code });

    writer.putLdrRegAddress("x15", cfg.save);
    writer.putStpRegRegRegOffset("x29", "x30", "x15", 0, "post-adjust");
    if (savesContext) {
      writer.putStpRegRegRegOffset("x20", "x21", "x15", 16, "signed-offset");
    }

    if (cfg.selfBuffer !== null) {
      writer.putLdrRegAddress("x15", cfg.selfBuffer);
      writer.putLdrRegRegOffset("x20", "x15", 0);
    }
    if (cfg.errorBuffer !== null) {
      writer.putMovRegReg("x21", "xzr");
    }
    if (cfg.indirectResultBuffer !== null) {
      writer.putLdrRegAddress("x8", cfg.indirectResultBuffer);
    }

    writer.putLdrRegAddress("x14", cfg.target);
    writer.putBlrRegNoAuth("x14");

    if (cfg.resultBuffer !== null) {
      writer.putLdrRegAddress("x15", cfg.resultBuffer);
      for (const location of cfg.resultRegisters) {
        const prefix = location.register === "gp" ? "x" : "d";
        writer.putStrRegRegOffset(`${prefix}${location.index}` as Arm64Register, "x15", frameOffset(location));
      }
    }
    if (cfg.errorBuffer !== null) {
      writer.putLdrRegAddress("x15", cfg.errorBuffer);
      writer.putStrRegRegOffset("x21", "x15", 0);
    }

    writer.putLdrRegAddress("x15", cfg.save);
    writer.putLdpRegRegRegOffset("x29", "x30", "x15", 0, "post-adjust");
    if (savesContext) {
      writer.putLdpRegRegRegOffset("x20", "x21", "x15", 16, "signed-offset");
    }
    writer.putRet();

    writer.flush();
  });
}

const X86_RESULT_GP: X86Register[] = ["rax", "rdx", "rcx", "r8"];

function writeX86Trampoline(code: NativePointer, cfg: TrampolineConfig): void {
  const savesContext = cfg.selfBuffer !== null || cfg.errorBuffer !== null;

  Memory.patchCode(code, 0x200, (slot) => {
    const writer = new X86Writer(slot, { pc: code });

    // Stack-passed args must sit right above the callee's return address, so the return address and
    // the callee-saved r12 (error) / r13 (self) go to the save buffer instead of the stack.
    writer.putMovRegAddress("r11", cfg.save);
    writer.putPopReg("r10");
    writer.putMovRegOffsetPtrReg("r11", 0, "r10");
    if (savesContext) {
      writer.putMovRegOffsetPtrReg("r11", 8, "r12");
      writer.putMovRegOffsetPtrReg("r11", 16, "r13");
    }

    if (cfg.selfBuffer !== null) {
      writer.putMovRegAddress("r11", cfg.selfBuffer);
      writer.putMovRegRegPtr("r13", "r11"); // r13 = swiftcc self/context
    }
    if (cfg.errorBuffer !== null) {
      writer.putBytes([0x45, 0x31, 0xe4]); // xor r12d, r12d — clear the swiftcc error register
    }
    if (cfg.indirectResultBuffer !== null) {
      writer.putMovRegAddress("rax", cfg.indirectResultBuffer); // rax = swiftcc indirect-result pointer
    }

    writer.putMovRegAddress("r11", cfg.target);
    writer.putCallReg("r11");

    if (cfg.errorBuffer !== null) {
      writer.putMovRegAddress("r10", cfg.errorBuffer);
      writer.putBytes([0x4d, 0x89, 0x22]); // mov [r10], r12 — store the thrown error
    }
    if (cfg.resultBuffer !== null) {
      writer.putMovRegAddress("r10", cfg.resultBuffer);
      for (const location of cfg.resultRegisters) {
        if (location.register === "gp") {
          writer.putMovRegOffsetPtrReg("r10", frameOffset(location), X86_RESULT_GP[location.index]);
        } else {
          putFpStoreToR10(writer, "double", frameOffset(location), location.index);
        }
      }
    }

    writer.putMovRegAddress("r11", cfg.save);
    if (savesContext) {
      writer.putMovRegRegOffsetPtr("r12", "r11", 8);
      writer.putMovRegRegOffsetPtr("r13", "r11", 16);
    }
    writer.putMovRegRegOffsetPtr("r10", "r11", 0);
    writer.putPushReg("r10");
    writer.putRet();

    writer.flush();
  });
}

// movss/movsd [r10+off], xmm<index> — X86Writer exposes no SSE store for an arbitrary base/register.
function putFpStoreToR10(writer: X86Writer, cls: FloatClass, off: number, index: number): void {
  const prefix = cls === "double" ? 0xf2 : 0xf3;
  writer.putBytes([prefix, 0x41, 0x0f, 0x11, 0x42 | (index << 3), off & 0xff]);
}

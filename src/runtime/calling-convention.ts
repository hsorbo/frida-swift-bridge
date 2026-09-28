import { Metadata, MetadataKind } from "../abi/metadata.js";
import { enumerateFields, fieldTypeIn } from "../abi/field-descriptor.js";
import { existentialRepresentation } from "../abi/existential.js";
import { SwiftError } from "./thrown-error.js";
import { typeName } from "./type-name.js";
import { signCode } from "../basic/pac.js";

export const MAX_LOADABLE_SIZE = Process.pointerSize * 4;

const ARCH = Process.arch;

const resilientModules = new Set<string>();

export function markResilientModule(name: string): void {
  resilientModules.add(name);
}

const resilientValueCache = new Map<string, boolean>();

// Resilience isn't recorded in metadata (@frozen leaves no trace), so it's inferred from positive
// signals only: the layout-string bit, a caller-declared module, or an embedded resilient field or
// payload (Optional<URL> is address-only because URL is, though Swift.Optional carries no signal).
export function isResilientValueType(metadata: Metadata): boolean {
  const kind = metadata.kind;
  if (kind !== MetadataKind.Struct && kind !== MetadataKind.Enum && kind !== MetadataKind.Optional) {
    return false;
  }
  const description = metadata.description;
  if (description.hasLayoutString || resilientModules.has(description.moduleName ?? "")) {
    return true;
  }
  const key = metadata.handle.toString();
  const cached = resilientValueCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  resilientValueCache.set(key, false); // break recursive-type cycles
  let result = false;
  for (const field of enumerateFields(description)) {
    const fieldType = fieldTypeIn(metadata, field);
    if (fieldType !== null && isResilientValueType(fieldType)) {
      result = true;
      break;
    }
  }
  resilientValueCache.set(key, result);
  return result;
}

// Integer/pointer-class only; floating-point uses the separate v-register budget below.
export function shouldPassIndirectly(metadata: Metadata): boolean {
  if (metadata.kind === MetadataKind.Existential && existentialRepresentation(metadata) === "opaque") {
    return true; // opaque existentials are address-only
  }
  if (isResilientValueType(metadata)) {
    return true;
  }
  const vwt = metadata.valueWitnesses;
  return !vwt.isBitwiseTakable || vwt.size > MAX_LOADABLE_SIZE;
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

// One physical register's worth of a directly-passed value, read out of the value's bytes.
type ArgPiece =
  | { kind: "word"; off: number }
  | { kind: "double"; off: number }
  | { kind: "float"; off: number };

function fridaArgType(piece: ArgPiece): NativeFunctionArgumentType {
  return piece.kind === "word" ? "uint64" : piece.kind;
}

function readArgPiece(piece: ArgPiece, base: NativePointer): NativeFunctionArgumentValue {
  const at = base.add(piece.off);
  switch (piece.kind) {
    case "word":
      return at.readU64();
    case "double":
      return at.readDouble();
    case "float":
      return at.readFloat();
  }
}

// swiftcc spreads a homogeneous-float aggregate with each FP leaf in its own register (≤4), on
// both arm64 (d/s) and x86-64 (xmm) — it is not packed by the SysV eightbyte rule.
function floatPieces(fl: FloatLayout): ArgPiece[] {
  const stride = fl.cls === "double" ? 8 : 4;
  return Array.from({ length: fl.count }, (_, i) => ({ kind: fl.cls, off: i * stride } as ArgPiece));
}

function wordPieces(count: number): ArgPiece[] {
  return Array.from({ length: count }, (_, i) => ({ kind: "word", off: i * 8 }));
}

function directArgPieces(metadata: Metadata): ArgPiece[] {
  const fl = floatLayout(metadata);
  if (fl !== null) {
    return floatPieces(fl);
  }
  return wordPieces(Math.ceil(metadata.valueWitnesses.size / 8));
}

interface LoweredArg {
  indirect: boolean;
  pieces: ArgPiece[];
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
  return { indirect: false, pieces: directArgPieces(arg) };
}

// Where each piece of a direct result lands, harvested back into the result buffer by the trampoline.
type ResultPiece =
  | { reg: "gp"; off: number } // x0.. / rax,rdx,rcx,r8
  | { reg: "fp"; cls: FloatClass; off: number }; // arm64 d/s register, x86-64 xmm register

function resultPieces(metadata: Metadata): ResultPiece[] {
  const fl = floatLayout(metadata);
  if (fl !== null) {
    const stride = fl.cls === "double" ? 8 : 4;
    return Array.from({ length: fl.count }, (_, i) => ({ reg: "fp", cls: fl.cls, off: i * stride }));
  }
  const words = Math.ceil(metadata.valueWitnesses.size / 8);
  return Array.from({ length: words }, (_, i) => ({ reg: "gp", off: i * 8 }));
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
  const fridaArgTypes: NativeFunctionArgumentType[] = [];
  for (const arg of loweredArgs) {
    if (arg.indirect) {
      fridaArgTypes.push("pointer");
    } else {
      for (const piece of arg.pieces) {
        fridaArgTypes.push(fridaArgType(piece));
      }
    }
  }
  // trailing implicit args after the formal ones: a type-metadata pointer per param, then witnesses
  for (let i = 0; i < typeArguments.length + witnessTables.length; i++) {
    fridaArgTypes.push("pointer");
  }

  let indirectResult = false;
  let directResult: ResultPiece[] = [];
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
        directResult = resultPieces(returnMetadata);
      }
    }
  }

  // The returned closure captures `resources`, keeping the trampoline's baked buffers alive
  // (Frida frees a Memory.alloc when its NativePointer is collected). self/error/scratch are
  // single shared buffers per function, so the trampoline is not re-entrant.
  const savesContext = hasSelf || throws;
  const code = Memory.alloc(Process.pageSize);
  const save = Memory.alloc(Process.pointerSize * (savesContext ? 4 : 2));
  const scratch = resultSize > 0 ? Memory.alloc(Math.max(resultStride, 8)) : ptr(0);
  const selfBuffer = hasSelf ? Memory.alloc(Process.pointerSize) : null;
  const errorBuffer = throws ? Memory.alloc(Process.pointerSize) : null;
  writeTrampoline(code, {
    save,
    target: address.strip(),
    selfBuffer,
    errorBuffer,
    indirectResultBuffer: indirectResult ? scratch : null,
    resultBuffer: directResult.length > 0 ? scratch : null,
    resultPieces: directResult,
  });
  const resources = {
    code,
    save,
    scratch,
    selfBuffer,
    errorBuffer,
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

    const physical: NativeFunctionArgumentValue[] = [];
    for (let i = 0; i < loweredArgs.length; i++) {
      const lowered = loweredArgs[i];
      const value = args[next++];
      if (lowered.indirect) {
        // consumed (+1): the callee destroys it, so hand it a copy
        const metadata = argMetadata[i];
        if (consumed.has(i) && metadata !== null) {
          const copy = Memory.alloc(metadata.typeLayout.stride);
          metadata.valueWitnesses.initializeWithCopy(copy, value);
          physical.push(copy);
        } else {
          physical.push(value);
        }
      } else {
        for (const piece of lowered.pieces) {
          physical.push(readArgPiece(piece, value));
        }
      }
    }
    for (const metadata of typeArguments) {
      physical.push(metadata.handle);
    }
    for (const witnessTable of witnessTables) {
      physical.push(witnessTable);
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
    Memory.copy(out, resources.scratch, resultSize);
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
  resultPieces: ResultPiece[];
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
      let gp = 0;
      let vfp = 0;
      for (const piece of cfg.resultPieces) {
        if (piece.reg === "gp") {
          writer.putStrRegRegOffset(`x${gp++}` as Arm64Register, "x15", piece.off);
        } else {
          const prefix = piece.cls === "double" ? "d" : "s";
          writer.putStrRegRegOffset(`${prefix}${vfp++}` as Arm64Register, "x15", piece.off);
        }
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
      let gp = 0;
      let sse = 0;
      for (const piece of cfg.resultPieces) {
        if (piece.reg === "gp") {
          writer.putMovRegOffsetPtrReg("r10", piece.off, X86_RESULT_GP[gp++]);
        } else {
          putFpStoreToR10(writer, piece.cls, piece.off, sse++);
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

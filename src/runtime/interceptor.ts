import { Metadata, MetadataKind } from "../abi/metadata.js";
import { readValue, embedsManagedReference, SwiftValue } from "../abi/instance.js";
import { ValueInstance } from "../abi/value.js";
import { ClassInstance } from "../abi/heap-object.js";
import { decodeThrownError } from "./thrown-error.js";
import {
  shouldPassIndirectly,
  loweredScalars,
  LoweredScalar,
  ArgumentAllocator,
  RegisterLocation,
  FloatClass,
  argumentRegisterUse,
} from "./calling-convention.js";
import { probeSelfOwnership } from "./value-convention.js";
import { AsyncFunctionPointer, isAsyncFunctionPointerSymbol } from "../abi/async-function-pointer.js";
import { AsyncContext } from "../abi/async-context.js";
import {
  symbolicate,
  parseSwiftSignature,
  resolveTypeExpr,
  hasOpaqueLayout,
  parseFunctionTypeSpelling,
  splitBoundTypeName,
  REFERENCE_CONTAINERS,
  resolveType,
  SwiftFunctionSignature,
} from "./symbolication.js";
import { findType } from "../reflection/registry.js";
import { ContextDescriptorKind } from "../abi/context-descriptor.js";
import { typeName } from "./type-name.js";
import { asSwiftObject } from "./object-facade.js";
import { CallResult, SelfOwnership, witnessTableCount } from "./method.js";

export type SwiftInvocationContext = InvocationContext & { self?: CallResult };

export interface SwiftInvocationCallbacks {
  onEnter?: (this: SwiftInvocationContext, args: SwiftValue[]) => void;
  onLeave?: (this: SwiftInvocationContext, retval: CallResult, error?: SwiftValue) => void;
}

export interface SwiftInterceptorOptions {
  self?: SelfOwnership;
}

type TypePlan =
  | { kind: "concrete"; metadata: Metadata }
  | { kind: "param"; paramIndex: number }
  | { kind: "use"; expr: string; indirect: boolean } // param-referencing expression: A?, [A], Array<A>
  | { kind: "metatype" }; // T.Type: one GP holding the metadata pointer directly (loadable POD)

// A small loadable value's self trails the formal args unless the method mutates it; any other
// self is in swiftself.
interface Receiver {
  metadata: Metadata;
  trailing: boolean;
}

interface CallShape {
  args: TypePlan[];
  ret: TypePlan | null;
  genericParams: string[];
  throws: boolean;
  receiver: Receiver | null;
}

function planType(name: string, genericParams: string[]): TypePlan {
  const paramIndex = genericParams.indexOf(name);
  if (paramIndex !== -1) {
    return { kind: "param", paramIndex };
  }
  const metadata = resolveTypeExpr(name, () => null);
  if (metadata !== null) {
    return { kind: "concrete", metadata };
  }
  if (name.endsWith(".Type")) {
    return { kind: "metatype" };
  }
  if (genericParams.some((p) => new RegExp(`\\b${p}\\b`).test(name))) {
    const indirect = hasOpaqueLayout(name, (n) => (genericParams.includes(n) ? "opaque" : null));
    if (!indirect && !isSingleReference(name)) {
      throw new Error(`unsupported direct generic use: ${name}`);
    }
    return { kind: "use", expr: name, indirect };
  }
  throw new Error(`could not resolve type: ${name}`);
}

// Array/Dictionary/Set, a class, or an Optional of one: one register whatever the generic arguments.
function isSingleReference(expr: string): boolean {
  if (expr.endsWith("?")) {
    return isSingleReference(expr.slice(0, -1));
  }
  if (expr.startsWith("[")) {
    return true;
  }
  if (parseFunctionTypeSpelling(expr) !== null) {
    return false;
  }
  const { base, arguments: args } = splitBoundTypeName(expr);
  if (base === "Swift.Optional") {
    return isSingleReference(args[0]);
  }
  return REFERENCE_CONTAINERS.has(base) || findType(base)?.kind === ContextDescriptorKind.Class;
}

function planMetadata(
  plan: Exclude<TypePlan, { kind: "metatype" }>,
  generics: Metadata[],
  genericParams: string[]
): Metadata {
  switch (plan.kind) {
    case "concrete":
      return plan.metadata;
    case "param":
      return generics[plan.paramIndex];
    case "use": {
      const metadata = resolveTypeExpr(plan.expr, (name) => {
        const i = genericParams.indexOf(name);
        return i >= 0 ? generics[i] : null;
      });
      if (metadata === null) {
        throw new Error(`could not resolve generic use: ${plan.expr}`);
      }
      return metadata;
    }
  }
}

// param values and uses storing one inline are address-only → passed indirectly (one GP pointer, or
// x8 for a return); other uses are a single reference.
function isIndirectPlan(plan: TypePlan): boolean {
  return plan.kind === "param" || (plan.kind === "use" && plan.indirect);
}

function callShape(target: NativePointer, ownership?: SelfOwnership, isAsync = false): CallShape {
  const symbol = symbolicate(target);
  if (symbol === null) {
    throw new Error(`no Swift symbol at ${target}`);
  }
  const parsed = parseSwiftSignature(symbol.demangled);
  if (parsed === null) {
    throw new Error(`could not parse signature: ${symbol.demangled}`);
  }

  if (parsed.kind === "function") {
    if (parsed.genericParams.length > 0 && !parsed.simpleGenerics) {
      throw new Error(`unsupported generic signature: ${symbol.demangled}`);
    }
    const gp = parsed.genericParams;
    const args = parsed.argTypeNames.map((n) => planType(n, gp));
    const probe = (metadata: Metadata): SelfOwnership | null =>
      ownership ?? (isAsync ? null : probedOwnership(target, args, parsed, metadata));
    return {
      args,
      ret: parsed.returnTypeName === null ? null : planType(parsed.returnTypeName, gp),
      genericParams: gp,
      throws: parsed.throws,
      receiver: receiverOf(parsed.context, probe, gp.length > 0),
    };
  }

  const memberType = resolveTypeExpr(parsed.typeName, () => null);
  if (memberType === null) {
    throw new Error(`could not resolve accessor type: ${symbol.demangled}`);
  }
  const member: TypePlan = { kind: "concrete", metadata: memberType };
  switch (parsed.kind) {
    case "getter":
      return { args: [], ret: member, genericParams: [], throws: false, receiver: receiverOf(parsed.context, () => "borrowing") };
    case "setter":
      return { args: [member], ret: null, genericParams: [], throws: false, receiver: receiverOf(parsed.context, () => "mutating") };
    default:
      throw new Error(`cannot hook a 'modify' accessor (coroutine ABI): ${symbol.demangled}`);
  }
}

// A generic method's type arguments follow a trailing self, so its convention must be known.
function receiverOf(context: string, ownership: (metadata: Metadata) => SelfOwnership | null, generic = false): Receiver | null {
  const metadata = /^(static |class )|^[^.]+$/.test(context) ? null : resolveType(context);
  if (metadata === null) {
    return null;
  }
  if (metadata.kind === MetadataKind.Class || metadata.kind === MetadataKind.ObjCClassWrapper || shouldPassIndirectly(metadata)) {
    return { metadata, trailing: false };
  }
  const known = ownership(metadata);
  if (known === null && generic) {
    throw new Error(`cannot tell how a generic method of ${typeName(metadata)} takes self; pass { self: "borrowing" | "mutating" }`);
  }
  return known === null ? null : { metadata, trailing: known !== "mutating" };
}

// Read before the hook patches the entry, as calls do (method.ts probedSelfOwnership).
function probedOwnership(target: NativePointer, args: TypePlan[], signature: SwiftFunctionSignature, receiver: Metadata): SelfOwnership | null {
  const argTypes = args.map((plan) => (plan.kind === "concrete" ? plan.metadata : { genericParam: 0 }));
  const implicitWords = signature.genericParams.length + witnessTableCount(signature);
  const trailing = argumentRegisterUse([...argTypes, receiver], implicitWords);
  const inRegister = argumentRegisterUse(argTypes, implicitWords);
  return probeSelfOwnership(target, { gp: [inRegister.gp, trailing.gp], fp: [inRegister.fp, trailing.fp] });
}

function decodeSelf({ metadata }: Receiver, address: NativePointer): CallResult {
  if (metadata.kind === MetadataKind.Class) {
    return asSwiftObject(new ClassInstance(address));
  }
  return metadata.kind === MetadataKind.ObjCClassWrapper ? address : decodeBorrowedValue(metadata, address);
}

// A metatype value is the type-metadata pointer itself, surfaced as its qualified name.
function decodeMetatype(metadataPointer: NativePointer): SwiftValue {
  return typeName(new Metadata(metadataPointer));
}

function returnIsIndirect(ret: TypePlan | null): boolean {
  if (ret === null) {
    return false;
  }
  if (ret.kind === "metatype") {
    return false;
  }
  if (ret.kind !== "concrete") {
    return isIndirectPlan(ret);
  }
  const md = ret.metadata;
  return md.valueWitnesses.size > 0 && md.kind !== MetadataKind.Class && shouldPassIndirectly(md);
}

const ARCH = Process.arch;
const X64_GP_ARGS = ["rdi", "rsi", "rdx", "rcx", "r8", "r9"];
const X64_GP_RESULTS = ["rax", "rdx", "rcx", "r8"];

const FP_HOOK_UNSUPPORTED =
  "hooking floating-point register arguments/returns is unsupported on x86-64 (no XMM in the CPU context)";

// gum surfaces each x86-64 xmm register as a 16-byte ArrayBuffer; the low lane holds the swiftcc scalar.
function readXmm(context: CpuContext, n: number, cls: "double" | "float"): number {
  const buf = (context as unknown as Record<string, ArrayBuffer | undefined>)[`xmm${n}`];
  if (buf === undefined) {
    throw new Error(FP_HOOK_UNSUPPORTED);
  }
  return cls === "double" ? new Float64Array(buf)[0] : new Float32Array(buf)[0];
}

function gpName(context: CpuContext): Record<string, NativePointer> {
  return context as unknown as Record<string, NativePointer>;
}

function gpArg(context: CpuContext, n: number): NativePointer {
  if (ARCH === "arm64") {
    return gpName(context)[`x${n}`];
  }
  return gpName(context)[X64_GP_ARGS[n]];
}

function gpResult(context: CpuContext, n: number): NativePointer {
  return gpName(context)[ARCH === "arm64" ? `x${n}` : X64_GP_RESULTS[n]];
}

function fpArg(context: CpuContext, n: number, cls: "double" | "float"): number {
  if (ARCH === "arm64") {
    return (context as unknown as Record<string, number>)[`${cls === "double" ? "d" : "s"}${n}`];
  }
  return readXmm(context, n, cls);
}

// Stack args start at the entry sp on arm64, past the return address on x86-64.
class ArgumentCursor {
  private readonly allocator: ArgumentAllocator;

  constructor(private readonly context: CpuContext, startReg: number) {
    this.allocator = new ArgumentAllocator(startReg);
  }

  gp(): NativePointer {
    const location = this.allocator.gp();
    if ("stackOffset" in location) {
      return this.stackSlot(location.stackOffset).readPointer();
    }
    return gpArg(this.context, location.index);
  }

  readScalar(scalar: LoweredScalar, value: NativePointer): void {
    const location = this.allocator.scalar(scalar);
    if ("stackOffset" in location) {
      Memory.copy(value.add(scalar.offset), this.stackSlot(location.stackOffset), scalar.size);
      return;
    }
    writeRegisterScalar(
      value,
      scalar,
      location,
      (n) => gpArg(this.context, n),
      (n, cls) => fpArg(this.context, n, cls)
    );
  }

  private stackSlot(stackOffset: number): NativePointer {
    const base = ARCH === "arm64" ? this.context.sp : this.context.sp.add(8);
    return base.add(stackOffset);
  }
}

function writeRegisterScalar(
  value: NativePointer,
  { offset, size, cls }: LoweredScalar,
  { index }: RegisterLocation,
  gp: (n: number) => NativePointer,
  fp: (n: number, cls: FloatClass) => number
): void {
  const at = value.add(offset);
  if (cls === "double") {
    at.writeDouble(fp(index, cls));
  } else if (cls === "float") {
    at.writeFloat(fp(index, cls));
  } else {
    for (let w = 0; w < size; w += 8) {
      Memory.copy(at.add(w), Memory.alloc(8).writePointer(gp(index + w / 8)), Math.min(size, 8));
    }
  }
}

function fpResult(context: CpuContext, n: number, cls: "double" | "float"): number {
  if (ARCH === "arm64") {
    return (context as unknown as Record<string, number>)[`${cls === "double" ? "d" : "s"}${n}`];
  }
  // async completion exposes spilled xmm via `xmmSpill`; a sync hook reads the live CpuContext.
  const spill = (context as unknown as { xmmSpill?: NativePointer }).xmmSpill;
  if (spill === undefined) {
    return readXmm(context, n, cls);
  }
  const at = spill.add(n * 8);
  return cls === "double" ? at.readDouble() : at.readFloat();
}

// arm64 carries the indirect-result pointer in x8 and the thrown error in x21; x86-64 swiftcc uses rax / r12.
function indirectResultRegister(context: CpuContext): NativePointer {
  return ARCH === "arm64" ? gpName(context).x8 : gpName(context).rax;
}

function errorRegister(context: CpuContext): NativePointer {
  return ARCH === "arm64" ? gpName(context).x21 : gpName(context).r12;
}

function asyncContextRegister(context: CpuContext): NativePointer {
  return ARCH === "arm64" ? gpName(context).x22 : gpName(context).r14;
}

function words(metadata: Metadata): number {
  return Math.ceil(metadata.valueWitnesses.size / 8);
}

interface MaterializedArgs {
  values: SwiftValue[];
  generics: Metadata[];
  self: NativePointer | null;
}

// Generic metadata follows the formal args and a trailing self in the GP sequence, so decode after
// walking them.
function materializeArgs(
  context: CpuContext,
  args: TypePlan[],
  genericParams: string[],
  startReg = 0,
  receiver: Receiver | null = null
): MaterializedArgs {
  const cursor = new ArgumentCursor(context, startReg);
  const slots: { plan: TypePlan; address: NativePointer }[] = [];

  for (const plan of args) {
    if (plan.kind === "metatype") {
      slots.push({ plan, address: cursor.gp() }); // address IS the metadata pointer
      continue;
    }
    if (isIndirectPlan(plan)) {
      slots.push({ plan, address: cursor.gp() });
      continue;
    }
    if (plan.kind !== "concrete") {
      slots.push({ plan, address: Memory.alloc(8).writePointer(cursor.gp()) });
      continue;
    }
    const metadata = plan.metadata;
    if (metadata.kind === MetadataKind.Class) {
      slots.push({ plan, address: Memory.alloc(8).writePointer(cursor.gp()) });
    } else if (shouldPassIndirectly(metadata)) {
      slots.push({ plan, address: cursor.gp() });
    } else {
      const scratch = Memory.alloc(Math.max(words(metadata), 1) * 8);
      for (const scalar of loweredScalars(metadata)) {
        cursor.readScalar(scalar, scratch);
      }
      slots.push({ plan, address: scratch });
    }
  }

  let self: NativePointer | null = null;
  if (receiver?.trailing) {
    self = Memory.alloc(Math.max(words(receiver.metadata), 1) * 8);
    for (const scalar of loweredScalars(receiver.metadata)) {
      cursor.readScalar(scalar, self);
    }
  } else if (receiver !== null) {
    self = gpName(context)[ARCH === "arm64" ? "x20" : "r13"];
  }

  const generics: Metadata[] = [];
  for (let i = 0; i < genericParams.length; i++) {
    generics.push(new Metadata(cursor.gp()));
  }

  const values = slots.map((s) => {
    if (s.plan.kind === "metatype") {
      return decodeMetatype(s.address);
    }
    const metadata = planMetadata(s.plan, generics, genericParams);
    return metadata.kind === MetadataKind.Class
      ? readValue(metadata, s.address)
      : decodeBorrowedValue(metadata, s.address);
  });
  return { values, generics, self };
}

// Mirrors method.ts decodeReturn, but borrows: an interceptor only observes the caller's +1, so it
// neither adopts nor destroys. A non-POD value embedding a managed reference can't be deep-copied
// out, so it surfaces as a live facade over the borrowed storage, valid for the callback's duration;
// everything else stays a snapshot. An indirect address is the caller's storage, so writing through
// it edits the argument or return.
function decodeBorrowedValue(metadata: Metadata, address: NativePointer): CallResult {
  if (!metadata.valueWitnesses.isPOD && embedsManagedReference(metadata)) {
    return asSwiftObject(ValueInstance.borrow(metadata, address));
  }
  return readValue(metadata, address);
}

function materializeReturn(
  context: CpuContext,
  ret: TypePlan | null,
  indirectReturn: NativePointer | null,
  generics: Metadata[],
  genericParams: string[]
): CallResult {
  if (ret === null) {
    return null;
  }
  if (ret.kind === "metatype") {
    return decodeMetatype(gpResult(context, 0));
  }
  if (isIndirectPlan(ret)) {
    if (indirectReturn === null) {
      throw new Error("indirect return address was not captured on enter");
    }
    return decodeBorrowedValue(planMetadata(ret, generics, genericParams), indirectReturn);
  }
  if (ret.kind !== "concrete") {
    const metadata = planMetadata(ret, generics, genericParams);
    if (metadata.kind === MetadataKind.Class) {
      return asSwiftObject(new ClassInstance(gpResult(context, 0)));
    }
    return decodeBorrowedValue(metadata, Memory.alloc(8).writePointer(gpResult(context, 0)));
  }

  const returnType = ret.metadata;
  if (returnType.valueWitnesses.size === 0) {
    return null;
  }
  if (returnType.kind === MetadataKind.Class) {
    return asSwiftObject(new ClassInstance(gpResult(context, 0)));
  }
  if (shouldPassIndirectly(returnType)) {
    if (indirectReturn === null) {
      throw new Error("indirect return address was not captured on enter");
    }
    return decodeBorrowedValue(returnType, indirectReturn);
  }

  // Direct multi-register return: the bytes live only in the result registers, so a non-POD value is
  // borrowed over this private reassembly — readable/callable in the callback, not write-through.
  const scratch = Memory.alloc(Math.max(words(returnType), 1) * 8);
  const allocator = new ArgumentAllocator(0, true);
  for (const scalar of loweredScalars(returnType)) {
    writeRegisterScalar(
      scratch,
      scalar,
      allocator.scalar(scalar) as RegisterLocation,
      (n) => gpResult(context, n),
      (n, cls) => fpResult(context, n, cls)
    );
  }
  return decodeBorrowedValue(returnType, scratch);
}

interface SwiftInvocationState {
  indirectReturn?: NativePointer;
  generics?: Metadata[];
  selfAddress?: NativePointer;
}

function attach(target: NativePointer, callbacks: SwiftInvocationCallbacks, options: SwiftInterceptorOptions = {}): InvocationListener {
  const { args, ret, genericParams, throws, receiver } = callShape(target, options.self);
  const captureIndirect = returnIsIndirect(ret);
  const returnNeedsGenerics = ret !== null && (ret.kind === "param" || ret.kind === "use") && genericParams.length > 0;
  const wantsArgs = callbacks.onEnter !== undefined || (callbacks.onLeave !== undefined && receiver !== null) || returnNeedsGenerics;

  const onEnter =
    wantsArgs || captureIndirect
      ? function (this: SwiftInvocationContext) {
          const context = this.context;
          const state = this as unknown as SwiftInvocationState;
          if (captureIndirect) {
            state.indirectReturn = indirectResultRegister(context);
          }
          if (wantsArgs) {
            const { values, generics, self } = materializeArgs(context, args, genericParams, 0, receiver);
            state.generics = generics;
            if (self !== null) {
              state.selfAddress = self;
              this.self = decodeSelf(receiver!, self);
            }
            if (callbacks.onEnter !== undefined) {
              callbacks.onEnter.call(this, values);
            }
          }
        }
      : undefined;

  const onLeave =
    callbacks.onLeave !== undefined
      ? function (this: SwiftInvocationContext) {
          const context = this.context;
          const state = this as unknown as SwiftInvocationState;
          if (state.selfAddress !== undefined) {
            this.self = decodeSelf(receiver!, state.selfAddress);
          }
          const swiftErrorRegister = errorRegister(context); // swiftcc returns a thrown error here
          if (throws && !swiftErrorRegister.isNull()) {
            callbacks.onLeave!.call(this, null, decodeThrownError(swiftErrorRegister));
            return;
          }
          callbacks.onLeave!.call(
            this,
            materializeReturn(
              context,
              ret,
              state.indirectReturn ?? null,
              state.generics ?? [],
              genericParams
            )
          );
        }
      : undefined;

  return Interceptor.attach(target, { onEnter, onLeave });
}

export interface SwiftAsyncCallbacks {
  onEnter?: (this: SwiftInvocationContext, args: SwiftValue[], context: NativePointer) => void;
  // The entry partial function returning: reached the first suspension, not logical completion.
  onFirstSuspend?: (this: InvocationContext) => void;
  onComplete?: (this: InvocationContext, retval: CallResult, error?: SwiftValue) => void;
}

function resolveAsyncEntry(target: NativePointer): NativePointer {
  const symbol = symbolicate(target);
  if (symbol !== null && isAsyncFunctionPointerSymbol(symbol.name)) {
    return new AsyncFunctionPointer(target).code;
  }
  return target;
}

interface CompletionEntry {
  callbacks: SwiftAsyncCallbacks;
  ret: TypePlan | null;
  generics: Metadata[];
  genericParams: string[];
  outBuffer: NativePointer | null;
  throws: boolean;
  owner: Set<CompletionEntry>;
  slot: CompletionSlot;
}

interface CompletionSlot {
  original: NativePointer;
  entries: CompletionEntry[];
}

// Completion is observed by redirecting the frame's ResumeParent (a data pointer) at a persistent
// trampoline; patching the live resumeParent page instead races the completing worker's I-cache.
const pending = new Map<string, CompletionSlot>();
const COMPLETION_TRAMPOLINE_SIZE = 0x200;
let completionTrampoline: NativePointer | null = null;
let completionBridge: NativeCallback<"pointer", ["pointer", "pointer"]> | null = null;

// x86-64 completion spill layout: [rdi rsi rdx rcx r8 r9][xmm0..xmm7, 8B each][r13].
const X64_SPILL_XMM = 0x30;
const X64_SPILL_ERROR = 0x70;
const X64_SPILL_SIZE = 0x80;

function spillContext(spillPtr: NativePointer, asyncContext: NativePointer): CpuContext {
  if (ARCH === "arm64") {
    const ctx: Record<string, NativePointer | number> = {};
    for (let i = 0; i < 8; i++) {
      ctx[`x${i}`] = spillPtr.add(i * 8).readPointer();
    }
    for (let i = 0; i < 8; i++) {
      const at = spillPtr.add(0x40 + i * 8);
      ctx[`d${i}`] = at.readDouble();
      ctx[`s${i}`] = at.readFloat();
    }
    ctx.x20 = spillPtr.add(0x80).readPointer();
    ctx.x22 = asyncContext;
    return ctx as unknown as CpuContext;
  }
  // The resume delivers results in the argument registers; remap them onto the sync result-register
  // names so materializeReturn is shared with the sync path.
  const ctx: Record<string, NativePointer | number> = {};
  ctx.rax = spillPtr.add(0x00).readPointer(); // rdi
  ctx.rdx = spillPtr.add(0x08).readPointer(); // rsi
  ctx.rcx = spillPtr.add(0x10).readPointer(); // rdx
  ctx.r8 = spillPtr.add(0x18).readPointer(); // rcx
  ctx.r13 = spillPtr.add(X64_SPILL_ERROR).readPointer(); // error
  ctx.r14 = asyncContext;
  (ctx as unknown as { xmmSpill: NativePointer }).xmmSpill = spillPtr.add(X64_SPILL_XMM);
  return ctx as unknown as CpuContext;
}

// On the resume, the thrown error rides swiftself (x20 / r13).
function completionErrorValue(context: CpuContext): NativePointer {
  return ARCH === "arm64" ? gpName(context).x20 : gpName(context).r13;
}

function fireCompletion(entry: CompletionEntry, context: CpuContext, self: InvocationContext): void {
  const error = completionErrorValue(context);
  if (entry.throws && !error.isNull()) {
    entry.callbacks.onComplete!.call(self, null, decodeThrownError(error));
    return;
  }
  entry.callbacks.onComplete!.call(
    self,
    materializeReturn(context, entry.ret, entry.outBuffer, entry.generics, entry.genericParams)
  );
}

// x22/x20 are callee-saved so the bridge preserves them; the caller-saved result regs are spilled.
function getCompletionTrampoline(): NativePointer {
  if (completionTrampoline !== null) {
    return completionTrampoline;
  }
  completionBridge = new NativeCallback(function (this: CallbackContext, context: NativePointer, spillPtr: NativePointer): NativePointer {
    const key = context.toString();
    const slot = pending.get(key)!;
    pending.delete(key);
    const completion = spillContext(spillPtr, context);
    const self = { context: completion, returnAddress: this.returnAddress, threadId: Process.getCurrentThreadId() } as unknown as InvocationContext;
    for (const entry of slot.entries) {
      entry.owner.delete(entry);
      // a throwing onComplete must not divert the native resume; isolate it and re-surface next tick
      try {
        fireCompletion(entry, completion, self);
      } catch (e) {
        setImmediate(() => {
          throw e;
        });
      }
    }
    return slot.original;
  }, "pointer", ["pointer", "pointer"]);

  const page = Memory.alloc(Process.pageSize);
  Memory.patchCode(page, COMPLETION_TRAMPOLINE_SIZE, (slot) => {
    if (ARCH === "arm64") {
      writeArm64CompletionTrampoline(slot, page);
    } else {
      writeX64CompletionTrampoline(slot, page);
    }
  });
  completionTrampoline = page;
  return page;
}

function writeArm64CompletionTrampoline(slot: NativePointer, pc: NativePointer): void {
  const w = new Arm64Writer(slot, { pc });
  w.putPushRegReg("x29", "x30");
  w.putSubRegRegImm("sp", "sp", 0x90);
  for (let i = 0; i < 8; i++) {
    w.putStrRegRegOffset(`x${i}` as Arm64Register, "sp", i * 8);
  }
  for (let i = 0; i < 8; i++) {
    w.putStrRegRegOffset(`d${i}` as Arm64Register, "sp", 0x40 + i * 8);
  }
  w.putStrRegRegOffset("x20", "sp", 0x80);
  w.putMovRegReg("x0", "x22");
  w.putAddRegRegImm("x1", "sp", 0);
  w.putLdrRegAddress("x14", completionBridge!);
  w.putBlrReg("x14");
  w.putMovRegReg("x9", "x0");
  for (let i = 0; i < 8; i++) {
    w.putLdrRegRegOffset(`x${i}` as Arm64Register, "sp", i * 8);
  }
  for (let i = 0; i < 8; i++) {
    w.putLdrRegRegOffset(`d${i}` as Arm64Register, "sp", 0x40 + i * 8);
  }
  w.putAddRegRegImm("sp", "sp", 0x90);
  w.putPopRegReg("x29", "x30");
  w.putBrRegNoAuth("x9");
  w.flush();
}

const X64_RESULT_ARG_REGS: X86Register[] = ["rdi", "rsi", "rdx", "rcx", "r8", "r9"];

// Hand-encoded movsd to/from [rsp+off]; the rsp base needs a SIB byte (0x24).
function putXmmStoreToRsp(w: X86Writer, off: number, index: number): void {
  w.putBytes([0xf2, 0x0f, 0x11, 0x44 | (index << 3), 0x24, off & 0xff]);
}
function putXmmLoadFromRsp(w: X86Writer, index: number, off: number): void {
  w.putBytes([0xf2, 0x0f, 0x10, 0x44 | (index << 3), 0x24, off & 0xff]);
}

// r13/r14 are callee-saved so the bridge preserves them; caller-saved result regs are spilled/restored.
function writeX64CompletionTrampoline(slot: NativePointer, pc: NativePointer): void {
  const w = new X86Writer(slot, { pc });
  w.putPushReg("rbp"); // 16-align rsp across the call
  w.putSubRegImm("rsp", X64_SPILL_SIZE);
  X64_RESULT_ARG_REGS.forEach((r, i) => w.putMovRegOffsetPtrReg("rsp", i * 8, r));
  for (let k = 0; k < 8; k++) {
    putXmmStoreToRsp(w, X64_SPILL_XMM + k * 8, k);
  }
  w.putMovRegOffsetPtrReg("rsp", X64_SPILL_ERROR, "r13");
  w.putMovRegReg("rdi", "r14"); // bridge(asyncContext, spillPtr)
  w.putMovRegReg("rsi", "rsp");
  w.putMovRegAddress("r11", completionBridge!);
  w.putCallReg("r11");
  w.putMovRegReg("r11", "rax"); // r11 = original ResumeParent
  X64_RESULT_ARG_REGS.forEach((r, i) => w.putMovRegRegOffsetPtr(r, "rsp", i * 8));
  for (let k = 0; k < 8; k++) {
    putXmmLoadFromRsp(w, k, X64_SPILL_XMM + k * 8);
  }
  w.putAddRegImm("rsp", X64_SPILL_SIZE);
  w.putPopReg("rbp");
  w.putJmpReg("r11");
  w.flush();
}

function attachAsync(target: NativePointer, callbacks: SwiftAsyncCallbacks, options: SwiftInterceptorOptions = {}): InvocationListener {
  if (callbacks.onEnter === undefined && callbacks.onFirstSuspend === undefined && callbacks.onComplete === undefined) {
    throw new Error("attachAsync requires onEnter, onFirstSuspend, or onComplete");
  }
  const code = resolveAsyncEntry(target);
  const { args, ret, genericParams, throws, receiver } = callShape(code, options.self, true);

  const wantsCompletion = callbacks.onComplete !== undefined;
  const indirectReturn = returnIsIndirect(ret);
  const argRegBase = indirectReturn ? 1 : 0; // an @out result takes x0
  const returnNeedsGenerics = wantsCompletion && ret !== null && (ret.kind === "param" || ret.kind === "use") && genericParams.length > 0;
  const wantsArgs = callbacks.onEnter !== undefined || returnNeedsGenerics;
  const liveEntries = new Set<CompletionEntry>();

  const armCompletion = (context: CpuContext, generics: Metadata[]): void => {
    const trampoline = getCompletionTrampoline();
    const taskContext = asyncContextRegister(context);
    const ctx = new AsyncContext(taskContext);
    const key = taskContext.toString();
    let slot = pending.get(key);
    if (slot === undefined) {
      slot = { original: ctx.resumeParent, entries: [] };
      pending.set(key, slot);
      ctx.setResumeParent(trampoline);
    }
    const entry: CompletionEntry = {
      callbacks,
      ret,
      generics,
      genericParams,
      outBuffer: indirectReturn ? gpArg(context, 0) : null,
      throws,
      owner: liveEntries,
      slot,
    };
    slot.entries.push(entry);
    liveEntries.add(entry);
  };

  const onEnter =
    wantsArgs || wantsCompletion
      ? function (this: SwiftInvocationContext) {
          const context = this.context;
          let generics: Metadata[] = [];
          if (wantsArgs) {
            const materialized = materializeArgs(context, args, genericParams, argRegBase, receiver);
            generics = materialized.generics;
            if (materialized.self !== null) {
              this.self = decodeSelf(receiver!, materialized.self);
            }
            if (callbacks.onEnter !== undefined) {
              callbacks.onEnter.call(this, materialized.values, asyncContextRegister(context));
            }
          }
          if (wantsCompletion) {
            armCompletion(context, generics);
          }
        }
      : undefined;

  let entryListener: InvocationListener;
  if (callbacks.onFirstSuspend !== undefined) {
    const onFirstSuspend = callbacks.onFirstSuspend;
    entryListener = Interceptor.attach(code, {
      onEnter,
      onLeave: function (this: InvocationContext) {
        onFirstSuspend.call(this);
      },
    });
  } else {
    // onEnter-only: a bare function is a probe listener, which never traps the return.
    entryListener = Interceptor.attach(code, onEnter!);
  }

  if (!wantsCompletion) {
    return entryListener;
  }
  return {
    detach() {
      entryListener.detach();
      // Only the bridge may delete a slot; a completing worker may already be dereferencing pending[key].
      for (const entry of liveEntries) {
        const entries = entry.slot.entries;
        const i = entries.indexOf(entry);
        if (i !== -1) {
          entries.splice(i, 1);
        }
      }
      liveEntries.clear();
    },
  };
}

export interface SwiftInterceptorApi {
  attach(target: NativePointer, callbacks: SwiftInvocationCallbacks, options?: SwiftInterceptorOptions): InvocationListener;
  attachAsync(target: NativePointer, callbacks: SwiftAsyncCallbacks, options?: SwiftInterceptorOptions): InvocationListener;
}

export const SwiftInterceptor: SwiftInterceptorApi = { attach, attachAsync };

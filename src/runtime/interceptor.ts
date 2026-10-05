import { Metadata, MetadataKind, genericHeaderOffset, readGenericContextHeader } from "../abi/metadata.js";
import { readValue, embedsManagedReference, SwiftValue } from "../abi/instance.js";
import { ValueInstance } from "../abi/value.js";
import { enumerateTupleElements, getUnlabelledTupleTypeMetadata } from "../abi/tuple.js";
import { ClassInstance } from "../abi/heap-object.js";
import { ClassMetadata, classMetadataOf } from "../abi/class-metadata.js";
import { enumerateFields, resolveTypeByMangledName } from "../abi/field-descriptor.js";
import { buildGenericMetadata, genericParamsAreKey, hasFixedLayoutInGenericContext } from "../abi/generic-instantiation.js";
import { decodeThrownError } from "./thrown-error.js";
import {
  shouldPassIndirectly,
  loweredScalars,
  LoweredScalar,
  ArgumentAllocator,
  RegisterLocation,
  FloatClass,
  argumentRegisterUse,
  placeResultScalars,
  placeAsyncResultScalars,
  placeTypedErrorScalars,
  typedErrorReturnsDirectly,
  PlacedResultScalar,
} from "./calling-convention.js";
import { probeSelfOwnership, probeTypedErrorBuffer } from "./value-convention.js";
import { AsyncFunctionPointer, isAsyncFunctionPointerSymbol } from "../abi/async-function-pointer.js";
import { AsyncContext } from "../abi/async-context.js";
import {
  symbolicate,
  parseSwiftSignature,
  resolveParsedType,
  hasOpaqueLayout,
  isSingleReference,
  mentionsParam,
  resolveType,
  SwiftFunctionSignature,
  TypeExpr,
} from "./symbolication.js";
import { findType } from "../reflection/registry.js";
import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { typeName } from "./type-name.js";
import { asSwiftObject } from "./object-facade.js";
import { CallResult, SelfOwnership, witnessTableCount, hookTargetOf, SwiftBoundMethod, SwiftFunction } from "./method.js";
import type { SwiftMember } from "./swift-type.js";
import type { SwiftMemberFunction } from "./qualified-function.js";
import type { SwiftFunctionMatch } from "./function-listing.js";
import type { ParsedSwiftSignature } from "./symbolication.js";
import { SWIFTCC, FP_ARG_REGISTERS, putSseScalarMove } from "./swiftcc.js";

export type SwiftInvocationContext = InvocationContext & { self?: CallResult; typeArguments?: string[] };

export interface SwiftInvocationCallbacks {
  onEnter?: (this: SwiftInvocationContext, args: SwiftValue[]) => void;
  onLeave?: (this: SwiftInvocationContext, retval: CallResult, error?: CallResult) => void;
}

export interface SwiftInterceptorOptions {
  self?: SelfOwnership;
}

type TypePlan =
  | { kind: "concrete"; metadata: Metadata }
  | { kind: "param"; paramIndex: number }
  | { kind: "use"; expr: TypeExpr; indirect: boolean } // param-referencing expression: A?, [A], Array<A>
  | { kind: "metatype" } // T.Type: one GP holding the metadata pointer directly (loadable POD)
  | { kind: "closure" } // a thick function value: two GPs, the function then its context
  | { kind: "inout"; target: ValuePlan }; // the caller's storage by address, whatever its layout

type ValuePlan = Exclude<TypePlan, { kind: "metatype" } | { kind: "closure" } | { kind: "inout" }>;

function inoutPlan(target: TypePlan, text: string): TypePlan {
  if (target.kind === "metatype" || target.kind === "closure" || target.kind === "inout") {
    throw new Error(`unsupported inout parameter type: ${text}`);
  }
  return { kind: "inout", target };
}

// A small loadable value's self trails the formal args unless the method mutates it; any other
// self is in swiftself. trailing is null when neither the symbol nor the callee's code tells. A
// generic type's self is typed only at entry: a class by its isa, an address-only value by the
// Self metadata word past the arguments, a fixed-layout value by the type arguments that follow
// its trailing self (or by Self metadata when mutating). Such a value lowers like a stand-in tuple
// of its field types.
interface FixedLayoutReceiver {
  type: ContextDescriptor;
  standIn: Metadata;
}

interface Receiver {
  metadata: Metadata | "isa" | "selfMetadata" | FixedLayoutReceiver;
  trailing: boolean | null;
}

function isFixedLayoutReceiver(metadata: Receiver["metadata"]): metadata is FixedLayoutReceiver {
  return typeof metadata === "object" && !(metadata instanceof Metadata);
}

// How a receiver's self lowers when it rides the argument registers.
function receiverLowering({ metadata }: Receiver): Metadata | null {
  return metadata instanceof Metadata ? metadata : isFixedLayoutReceiver(metadata) ? metadata.standIn : null;
}

function receiverName({ metadata }: Receiver): string {
  return metadata instanceof Metadata ? typeName(metadata) : isFixedLayoutReceiver(metadata) ? metadata.type.fullTypeName ?? "the type" : "the type";
}

// A generic struct whose layout ignores its parameters lays its fields out as a tuple of their
// types would, so that tuple lowers to the same registers; null when a field's type names a param.
function fixedLayoutStandIn(type: ContextDescriptor): Metadata | null {
  if (type.kind !== ContextDescriptorKind.Struct) {
    return null;
  }
  const fieldTypes: Metadata[] = [];
  for (const field of enumerateFields(type)) {
    const mangled = field.mangledTypeName;
    const metadata = mangled === null ? null : resolveTypeByMangledName(mangled, type);
    if (metadata === null) {
      return null;
    }
    fieldTypes.push(metadata);
  }
  return getUnlabelledTupleTypeMetadata(fieldTypes);
}

function typeKeyArgumentCount(type: ContextDescriptor): number {
  return readGenericContextHeader(type.handle.add(genericHeaderOffset(type))).numKeyArguments;
}

interface CallShape {
  args: TypePlan[];
  ret: TypePlan | null;
  thrown: TypePlan | null; // throws(E)
  witnessWords: number; // witness tables after the generic metadata, ahead of a typed error's buffer
  generics: GenericEnvironment;
  throws: boolean;
  receiver: Receiver | null;
  coroutine?: true;
}

// Where a typed error lands: the result registers it shares with the result, or the buffer the
// caller passes after the generic arguments.
interface ThrownLowering {
  plan: ValuePlan;
  placed: PlacedResultScalar[] | null;
}

// A loadable error rides the result registers since Swift 6.1; a callee built earlier takes the
// buffer for it too, which only its code tells, by reading the buffer's register.
function thrownLowering(shape: CallShape, onResume: boolean, target: NativePointer, startReg: number): ThrownLowering | null {
  const { thrown, ret } = shape;
  if (thrown === null) {
    return null;
  }
  if (thrown.kind === "metatype" || thrown.kind === "closure" || thrown.kind === "inout") {
    throw new Error(`unsupported thrown type: ${thrown.kind}`);
  }
  if (thrown.kind === "concrete" && !returnIsIndirect(ret) && typedErrorReturnsDirectly(thrown.metadata)) {
    const slotRegister = thrownSlotRegister(shape, startReg);
    if (slotRegister === null || probeTypedErrorBuffer(target, slotRegister) !== true) {
      return { plan: thrown, placed: placeTypedErrorScalars(directResultScalars(ret), thrown.metadata, onResume) };
    }
  }
  return { plan: thrown, placed: null };
}

// The argument register past the formal arguments, a trailing self and the generic words; null
// when a trailing self's routing is unknown or the register would be on the stack.
function thrownSlotRegister({ args, receiver, generics, witnessWords }: CallShape, startReg: number): number | null {
  const argTypes = args.map((plan) =>
    plan.kind === "concrete" ? plan.metadata : plan.kind === "closure" ? { closure: true as const } : { genericParam: 0 }
  );
  if (receiver !== null && receiver.trailing !== false) {
    const lowering = receiverLowering(receiver);
    if (receiver.trailing === null || lowering === null) {
      return null;
    }
    argTypes.push(lowering);
  }
  const passedWords = generics.sources.filter((s) => s.kind === "passed").length + (generics.passesSelfMetadata ? 1 : 0);
  const gp = startReg + argumentRegisterUse(argTypes, passedWords + witnessWords).gp;
  return gp < SWIFTCC.gpArgs.length ? gp : null;
}

// A direct result's scalars: a metatype or a single-reference generic use is one word, a thick
// closure two.
function directResultScalars(ret: TypePlan | null): LoweredScalar[] {
  if (ret === null || (ret.kind === "concrete" && ret.metadata.valueWitnesses.size === 0)) {
    return [];
  }
  if (ret.kind === "concrete") {
    return loweredScalars(ret.metadata);
  }
  return Array.from({ length: ret.kind === "closure" ? 2 : 1 }, (_, i) => ({ offset: i * 8, size: 8, cls: "int" as const }));
}

function needsGenerics(plan: TypePlan | null): boolean {
  return plan !== null && (plan.kind === "param" || plan.kind === "use");
}

function planType(type: TypeExpr, genericParams: string[]): TypePlan {
  const paramIndex = type.kind === "param" ? genericParams.indexOf(type.name) : -1;
  if (paramIndex !== -1) {
    return { kind: "param", paramIndex };
  }
  const metadata = resolveParsedType(type, () => null);
  if (metadata !== null) {
    return { kind: "concrete", metadata };
  }
  if (type.kind === "metatype") {
    return { kind: "metatype" };
  }
  if (type.kind === "function") {
    return { kind: "closure" };
  }
  if (mentionsParam(type, genericParams)) {
    const indirect = hasOpaqueLayout(type, (n) => (genericParams.includes(n) ? "opaque" : null));
    if (!indirect && !isSingleReference(type)) {
      throw new Error(`unsupported direct generic use: ${type.text}`);
    }
    return { kind: "use", expr: type, indirect };
  }
  throw new Error(`could not resolve type: ${type.text}`);
}

function planMetadata(plan: ValuePlan | { kind: "inout"; target: ValuePlan }, generics: Metadata[], genericParams: string[]): Metadata {
  switch (plan.kind) {
    case "inout":
      return planMetadata(plan.target, generics, genericParams);
    case "concrete":
      return plan.metadata;
    case "param":
      return generics[plan.paramIndex];
    case "use": {
      const metadata = resolveParsedType(plan.expr, (name) => {
        const i = genericParams.indexOf(name);
        return i >= 0 ? generics[i] : null;
      });
      if (metadata === null) {
        throw new Error(`could not resolve generic use: ${plan.expr.text}`);
      }
      return metadata;
    }
  }
}

// param values and uses storing one inline are address-only → passed indirectly (one GP pointer, or
// x8 for a return); other uses are a single reference. An inout argument is its address.
function isIndirectPlan(plan: TypePlan): boolean {
  return plan.kind === "param" || plan.kind === "inout" || (plan.kind === "use" && plan.indirect);
}

// After the formal arguments and a trailing self, IRGen passes an address-only value self's Self
// metadata, then each parameter no argument carries, the enclosing type's before the method's own.
type ParamSource =
  | { kind: "passed" }
  | { kind: "carried"; from: "selfMetadata" | "selfObject" | "selfMetatype" | number; type: ContextDescriptor | null; path: number[] };

interface GenericEnvironment {
  params: string[];
  sources: ParamSource[];
  passesSelfMetadata: boolean;
  undecodable: string | null;
}

function genericParamName(depth: number, index: number): string {
  let name = "";
  do {
    name += String.fromCharCode(65 + (index % 26));
    index = Math.floor(index / 26);
  } while (index > 0);
  return depth === 0 ? name : `${name}${depth}`;
}

// Each generic context opens a depth; a parameter that isn't a key argument is never passed.
function typeParams(type: ContextDescriptor): { names: string[]; depth: number } {
  const counts: number[] = [];
  for (let c: ContextDescriptor | null = type; c !== null; c = c.parent) {
    if (c.isType && c.isGeneric) {
      counts.unshift(genericParamsAreKey(c).length);
    }
  }
  const isKey = genericParamsAreKey(type);
  const names: string[] = [];
  let depth = 0;
  let start = 0;
  for (const count of counts) {
    if (count === start) {
      continue;
    }
    for (let i = start; i < count; i++) {
      if (isKey[i]) {
        names.push(genericParamName(depth, i - start));
      }
    }
    start = count;
    depth++;
  }
  return { names, depth };
}

function nominalArguments(type: TypeExpr): TypeExpr[] {
  return type.kind === "optional" ? [type.wrapped] : type.kind === "nominal" ? type.args : [];
}

function paramPaths(type: TypeExpr, params: string[], path: number[]): { param: string; path: number[] }[] {
  if (type.kind === "param" && params.includes(type.name)) {
    return [{ param: type.name, path }];
  }
  return nominalArguments(type).flatMap((arg, i) => paramPaths(arg, params, [...path, i]));
}

function genericEnvironment(signature: SwiftFunctionSignature, ownership: SelfOwnership | undefined, trailingSelfLowered = false): GenericEnvironment {
  const isStatic = /^(static|class) /.test(signature.context);
  const type = findType(signature.context.replace(/^(static|class) /, ""));
  const outer = type?.isGeneric ? typeParams(type) : { names: [], depth: 0 };
  const params = [...outer.names, ...signature.genericParams.map((_, i) => genericParamName(outer.depth, i))];
  const carried = new Map<string, ParamSource>();
  let passesSelfMetadata = false;
  let undecodable: string | null = null;
  if (outer.names.length > 0) {
    let from: "selfMetadata" | "selfObject" | "selfMetatype" | null = null;
    if (type!.kind === ContextDescriptorKind.Class) {
      from = isStatic || signature.name === "__allocating_init" ? "selfMetatype" : "selfObject";
    } else if (!isStatic && signature.name !== "init") {
      if (hasFixedLayoutInGenericContext(type!) && ownership !== "mutating") {
        if (!trailingSelfLowered) {
          undecodable = `cannot locate the type arguments of ${signature.context}.${signature.selector}: a fixed-layout generic value passes self by value`;
        }
      } else {
        from = "selfMetadata";
        passesSelfMetadata = true;
      }
    }
    if (from !== null) {
      outer.names.forEach((name, i) => carried.set(name, { kind: "carried", from: from!, type, path: [i] }));
    }
  }
  signature.params.forEach(({ convention, type: expr }, arg) => {
    if (convention === "inout" || expr.kind !== "nominal") {
      return;
    }
    const argType = findType(expr.name);
    if (argType?.kind !== ContextDescriptorKind.Class) {
      return;
    }
    for (const { param, path } of expr.args.flatMap((a, i) => paramPaths(a, params, [i]))) {
      if (!carried.has(param)) {
        carried.set(param, { kind: "carried", from: arg, type: argType, path });
      }
    }
  });
  return { params, sources: params.map((p) => carried.get(p) ?? { kind: "passed" }), passesSelfMetadata, undecodable };
}

function classIn(metadata: ClassMetadata, type: ContextDescriptor): ClassMetadata {
  for (let c: ClassMetadata | null = metadata; c !== null; c = c.superclass) {
    if (c.isTypeMetadata && c.description.handle.equals(type.handle.strip())) {
      return c;
    }
  }
  throw new Error(`${type.fullTypeName} is not a superclass of the object`);
}

function carriedMetadata(
  source: Extract<ParamSource, { kind: "carried" }>,
  context: CpuContext,
  slotObject: (arg: number) => NativePointer,
  selfMetadata: Metadata | null
): Metadata {
  let handle: NativePointer;
  if (source.from === "selfMetadata") {
    handle = selfMetadata!.handle;
  } else {
    const metadata =
      source.from === "selfMetatype"
        ? new ClassMetadata(selfRegister(context))
        : classMetadataOf(source.from === "selfObject" ? selfRegister(context) : slotObject(source.from));
    handle = classIn(metadata, source.type!).handle;
  }
  for (const index of source.path) {
    const args =
      new Metadata(handle).kind === MetadataKind.Class ? new ClassMetadata(handle).genericArguments : new Metadata(handle).genericArguments;
    handle = args.add(index * Process.pointerSize).readPointer();
  }
  return new Metadata(handle);
}

export type HookableTarget = NativePointer | SwiftMember | SwiftBoundMethod | SwiftFunction | SwiftMemberFunction | SwiftFunctionMatch;

interface HookEntry {
  address: NativePointer;
  parsed: ParsedSwiftSignature | null; // null: read off the symbol at the address
}

// A member or function carries the signature it was found with, so hooking it never symbolicates its address.
function hookEntry(target: HookableTarget): HookEntry {
  if (target instanceof NativePointer) {
    return { address: target, parsed: null };
  }
  const member = typeof target === "object" && target !== null ? hookTargetOf(target) : undefined;
  if (member === undefined) {
    throw new Error("hook target must be an address, a member found through a type's reflection, a bound method, a Swift.function or an enumerated function");
  }
  if (member.witnessDispatched) {
    throw new Error(`${member.signature.kind === "function" ? member.signature.selector : "member"} is dispatched through a protocol witness; hook its address`);
  }
  return { address: member.address, parsed: member.signature };
}

function parsedSignatureAt(target: NativePointer): ParsedSwiftSignature {
  const symbol = symbolicate(target);
  if (symbol === null) {
    throw new Error(`no Swift symbol at ${target}`);
  }
  const parsed = parseSwiftSignature(symbol.demangled);
  if (parsed === null) {
    throw new Error(`could not parse signature: ${symbol.demangled}`);
  }
  return parsed;
}

function callShape({ address: target, parsed: known }: HookEntry, ownership?: SelfOwnership, isAsync = false): CallShape {
  const parsed = known ?? parsedSignatureAt(target);

  if (parsed.kind === "function") {
    if (parsed.genericParams.length > 0 && !parsed.simpleGenerics) {
      throw new Error(`unsupported generic signature: ${parsed.context}.${parsed.selector}`);
    }
    // A subscript getter borrows self and a setter or modify mutates it; the setter takes the
    // element it stores ahead of the indices and the modify yields it.
    const accessor = parsed.accessor;
    const accessorOwnership: SelfOwnership | undefined = accessor === undefined ? undefined : accessor === "getter" ? "borrowing" : "mutating";
    ownership ??= accessorOwnership;
    let generics = genericEnvironment(parsed, ownership);
    const gp = generics.params;
    const indices = parsed.params.map((p) => (p.convention === "inout" ? inoutPlan(planType(p.type, gp), p.text) : planType(p.type, gp)));
    const element = parsed.result === null ? null : planType(parsed.result, gp);
    const args = accessor === "setter" ? [element!, ...indices] : indices;
    const ret = accessor === "setter" ? null : element;
    const ownWords = parsed.genericParams.length + witnessTableCount(parsed);
    const probe = (metadata: Metadata, typeKeyArguments = 0): SelfOwnership | null =>
      ownership ??
      (isAsync
        ? null
        : probedOwnership(target, args, metadata, {
            trailingSelf: ownWords + typeKeyArguments,
            selfInRegister: ownWords + (typeKeyArguments > 0 ? 1 : 0),
          }, syncArgumentSlotBase(ret)));
    const receiver = receiverOf(parsed.context, probe, parsed.name === "init", ownership);
    if (receiver !== null && isFixedLayoutReceiver(receiver.metadata) && receiver.trailing !== null) {
      generics = genericEnvironment(parsed, receiver.trailing ? "borrowing" : "mutating", true);
    }
    const shape: CallShape = {
      args,
      ret,
      thrown: parsed.thrownType === null ? null : planType(parsed.thrownType, gp),
      witnessWords: witnessTableCount(parsed),
      generics,
      throws: parsed.throws,
      receiver,
    };
    return accessor === "modify" ? { ...shape, coroutine: true } : shape;
  }

  const memberType = resolveParsedType(parsed.type, () => null);
  if (memberType === null) {
    throw new Error(`could not resolve accessor type: ${parsed.typeName}`);
  }
  const member: TypePlan = { kind: "concrete", metadata: memberType };
  const generics: GenericEnvironment = { params: [], sources: [], passesSelfMetadata: false, undecodable: null };
  switch (parsed.kind) {
    case "getter":
      return { args: [], ret: member, thrown: null, witnessWords: 0, generics, throws: false, receiver: receiverOf(parsed.context, () => "borrowing") };
    case "setter":
      return { args: [member], ret: null, thrown: null, witnessWords: 0, generics, throws: false, receiver: receiverOf(parsed.context, () => "mutating") };
    default:
      return { args: [], ret: member, thrown: null, witnessWords: 0, generics, throws: false, receiver: receiverOf(parsed.context, () => "mutating"), coroutine: true };
  }
}

// A class's initializing init takes the instance as self; a value type's init has none, its @thin
// metatype being erased, so it lowers like a static.
function receiverOf(
  context: string,
  ownership: (metadata: Metadata, typeKeyArguments?: number) => SelfOwnership | null,
  isInit = false,
  statedOwnership?: SelfOwnership
): Receiver | null {
  if (/^(static |class )|^[^.]+$/.test(context)) {
    return null;
  }
  const metadata = resolveType(context);
  if (metadata === null) {
    const type = findType(context);
    if (type === null || !type.isGeneric || (isInit && type.kind !== ContextDescriptorKind.Class)) {
      return null;
    }
    if (type.kind === ContextDescriptorKind.Class) {
      return { metadata: "isa", trailing: false };
    }
    if (!hasFixedLayoutInGenericContext(type)) {
      return { metadata: "selfMetadata", trailing: false };
    }
    const standIn = fixedLayoutStandIn(type);
    if (standIn === null) {
      return statedOwnership === "mutating" ? { metadata: "selfMetadata", trailing: false } : null;
    }
    const known = statedOwnership ?? ownership(standIn, typeKeyArgumentCount(type));
    return { metadata: { type, standIn }, trailing: known === null ? null : known !== "mutating" };
  }
  if (metadata.kind === MetadataKind.Class || metadata.kind === MetadataKind.ObjCClassWrapper) {
    return { metadata, trailing: false };
  }
  if (isInit) {
    return null;
  }
  if (shouldPassIndirectly(metadata)) {
    return { metadata, trailing: false };
  }
  const known = ownership(metadata);
  return { metadata, trailing: known === null ? null : known !== "mutating" };
}

// A generic method's type arguments follow a trailing self, so locating them needs its convention.
function unlocatableGenerics({ receiver, generics }: CallShape): string | null {
  if (generics.undecodable !== null) {
    return generics.undecodable;
  }
  if (receiver?.trailing === null && generics.params.length > 0) {
    return `cannot tell how a generic method of ${receiverName(receiver)} takes self; pass { self: "borrowing" | "mutating" }`;
  }
  return null;
}

function knownReceiver(shape: CallShape, decodesArgs: boolean): Receiver | null {
  const unlocatable = unlocatableGenerics(shape);
  if (decodesArgs && unlocatable !== null) {
    throw new Error(unlocatable);
  }
  return shape.receiver?.trailing === null ? null : shape.receiver;
}

function exposeTypeArguments(invocation: object, generics: Metadata[] | string): void {
  let names: string[] | undefined;
  Object.defineProperty(invocation, "typeArguments", {
    configurable: true,
    get: () => {
      if (typeof generics === "string") {
        throw new Error(generics);
      }
      return (names ??= generics.map((m) => typeName(m)));
    },
  });
}

// Decoded only when read. A self in swiftself is still there on leave: the register is callee-saved.
function exposeSelf(invocation: SwiftInvocationContext, receiver: Receiver, address: NativePointer, selfMetadata: Metadata | null): void {
  let decoded: CallResult | undefined;
  Object.defineProperty(invocation, "self", { configurable: true, get: () => (decoded ??= decodeSelf(receiver, address, selfMetadata)) });
}

function selfRegister(context: CpuContext): NativePointer {
  return gpName(context)[SWIFTCC.self];
}

// Read before the hook patches the entry, as calls do (method.ts probedSelfOwnership).
function probedOwnership(
  target: NativePointer,
  args: TypePlan[],
  receiver: Metadata,
  implicitWords: { trailingSelf: number; selfInRegister: number },
  startReg: number
): SelfOwnership | null {
  const argTypes = args.map((plan) =>
    plan.kind === "concrete" ? plan.metadata : plan.kind === "closure" ? { closure: true as const } : { genericParam: 0 }
  );
  const trailing = argumentRegisterUse([...argTypes, receiver], implicitWords.trailingSelf, startReg);
  const inRegister = argumentRegisterUse(argTypes, implicitWords.selfInRegister, startReg);
  return probeSelfOwnership(target, { gp: [inRegister.gp, trailing.gp], fp: [inRegister.fp, trailing.fp] });
}

function decodeSelf({ metadata }: Receiver, address: NativePointer, selfMetadata: Metadata | null): CallResult {
  if (metadata === "isa" || (metadata instanceof Metadata && metadata.kind === MetadataKind.Class)) {
    return asSwiftObject(new ClassInstance(address));
  }
  if (metadata === "selfMetadata" || isFixedLayoutReceiver(metadata)) {
    return decodeBorrowedValue(selfMetadata!, address);
  }
  return metadata.kind === MetadataKind.ObjCClassWrapper ? address : decodeBorrowedValue(metadata, address);
}

// A metatype value is the type-metadata pointer itself, surfaced as its qualified name.
function decodeMetatype(metadataPointer: NativePointer): SwiftValue {
  return typeName(new Metadata(metadataPointer));
}

function decodeClosure(fn: NativePointer, context: NativePointer): SwiftValue {
  return { function: fn.strip(), context };
}

// An async indirect result's pointer takes the first argument slot everywhere; a sync one only where
// the convention passes it as an argument.
function syncArgumentSlotBase(ret: TypePlan | null): number {
  return SWIFTCC.indirectResultIsArgument && returnIsIndirect(ret) ? 1 : 0;
}

function returnIsIndirect(ret: TypePlan | null): boolean {
  if (ret === null) {
    return false;
  }
  if (ret.kind === "metatype" || ret.kind === "closure") {
    return false;
  }
  if (ret.kind !== "concrete") {
    return isIndirectPlan(ret);
  }
  const md = ret.metadata;
  return md.valueWitnesses.size > 0 && md.kind !== MetadataKind.Class && shouldPassIndirectly(md);
}

const ARCH = Process.arch;

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
  return gpName(context)[SWIFTCC.gpArgs[n]];
}

function gpResult(context: CpuContext, n: number): NativePointer {
  return gpName(context)[SWIFTCC.gpResults[n]];
}

// The arm64 completion spill carries every argument register under its own name; x86-64's is
// remapped onto the result names in spillContext.
function resumeGp(context: CpuContext, n: number): NativePointer {
  return gpName(context)[ARCH === "arm64" ? SWIFTCC.gpArgs[n] : SWIFTCC.gpResults[n]];
}

function fpArg(context: CpuContext, n: number, cls: "double" | "float"): number {
  if (ARCH === "arm64") {
    return (context as unknown as Record<string, number>)[SWIFTCC.fpArg(cls, n)];
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
    const base = ARCH === "arm64" ? this.context.sp : this.context.sp.add(8 + SWIFTCC.homeAreaSize);
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
    return (context as unknown as Record<string, number>)[SWIFTCC.fpArg(cls, n)];
  }
  // async completion exposes spilled xmm via `xmmSpill`; a sync hook reads the live CpuContext.
  const spill = (context as unknown as { xmmSpill?: NativePointer }).xmmSpill;
  if (spill === undefined) {
    return readXmm(context, n, cls);
  }
  const at = spill.add(n * 8);
  return cls === "double" ? at.readDouble() : at.readFloat();
}

function indirectResultRegister(context: CpuContext): NativePointer {
  return gpName(context)[SWIFTCC.indirectResult];
}

function errorRegister(context: CpuContext): NativePointer {
  return gpName(context)[SWIFTCC.error];
}

function asyncContextRegister(context: CpuContext): NativePointer {
  return gpName(context)[SWIFTCC.asyncContext];
}

function words(metadata: Metadata): number {
  return Math.ceil(metadata.valueWitnesses.size / 8);
}

interface MaterializedArgs {
  values(): SwiftValue[];
  generics: Metadata[];
  trailingSelf: NativePointer | null;
  selfMetadata: Metadata | null;
  thrownSlot: NativePointer | null;
}

// Generic metadata follows the formal args and a trailing self in the GP sequence, so decode after
// walking them; a typed error's buffer follows the generic metadata.
function materializeArgs(
  context: CpuContext,
  args: TypePlan[],
  environment: GenericEnvironment,
  startReg = 0,
  receiver: Receiver | null = null,
  thrownSlotAfterWords: number | null = null // the witness-table words it follows; null: no buffer
): MaterializedArgs {
  const cursor = new ArgumentCursor(context, startReg);
  const slots: { plan: TypePlan; address: NativePointer }[] = [];

  for (const plan of args) {
    if (plan.kind === "metatype") {
      slots.push({ plan, address: cursor.gp() }); // address IS the metadata pointer
      continue;
    }
    if (plan.kind === "closure") {
      const words = Memory.alloc(2 * Process.pointerSize);
      words.writePointer(cursor.gp());
      words.add(Process.pointerSize).writePointer(cursor.gp());
      slots.push({ plan, address: words });
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

  let trailingSelf: NativePointer | null = null;
  const lowering = receiver === null ? null : receiverLowering(receiver);
  if (receiver?.trailing && lowering !== null) {
    trailingSelf = Memory.alloc(Math.max(words(lowering), 1) * 8);
    for (const scalar of loweredScalars(lowering)) {
      cursor.readScalar(scalar, trailingSelf);
    }
  }

  let selfMetadata = environment.passesSelfMetadata ? new Metadata(cursor.gp()) : null;
  const generics = environment.sources.map((source) =>
    source.kind === "passed"
      ? new Metadata(cursor.gp())
      : carriedMetadata(source, context, (arg) => slots[arg].address.readPointer(), selfMetadata)
  );
  if (receiver !== null && isFixedLayoutReceiver(receiver.metadata) && selfMetadata === null) {
    const { type } = receiver.metadata;
    selfMetadata = buildGenericMetadata(type, generics.slice(0, typeParams(type).names.length));
  }
  let thrownSlot: NativePointer | null = null;
  if (thrownSlotAfterWords !== null) {
    for (let i = 0; i < thrownSlotAfterWords; i++) {
      cursor.gp();
    }
    thrownSlot = cursor.gp();
  }

  const values = (): SwiftValue[] =>
    slots.map((s) => {
      if (s.plan.kind === "metatype") {
        return decodeMetatype(s.address);
      }
      if (s.plan.kind === "closure") {
        return decodeClosure(s.address.readPointer(), s.address.add(Process.pointerSize).readPointer());
      }
      const metadata = planMetadata(s.plan, generics, environment.params);
      if (s.plan.kind === "inout") {
        return decodeInoutArgument(metadata, s.address);
      }
      return metadata.kind === MetadataKind.Class
        ? readValue(metadata, s.address)
        : decodeBorrowedValue(metadata, s.address);
    });
  return { values, generics, trailingSelf, selfMetadata, thrownSlot };
}

function materializeThrown(
  context: CpuContext,
  lowering: ThrownLowering,
  slot: NativePointer | null,
  generics: Metadata[],
  genericParams: string[],
  onResume = false
): CallResult {
  const metadata = planMetadata(lowering.plan, generics, genericParams);
  if (lowering.placed === null) {
    if (slot === null) {
      throw new Error("typed error buffer was not captured on enter");
    }
    return decodeBorrowedValue(metadata, slot);
  }
  const scratch = Memory.alloc(Math.max(words(metadata), 1) * 8);
  for (const { scalar, location } of lowering.placed) {
    writeRegisterScalar(
      scratch,
      scalar,
      location,
      (n) => (onResume ? resumeGp(context, n) : gpResult(context, n)),
      (n, cls) => fpResult(context, n, cls)
    );
  }
  return decodeBorrowedValue(metadata, scratch);
}

// Mirrors method.ts decodeReturn, but borrows: an interceptor only observes the caller's +1, so it
// neither adopts nor destroys. A non-POD value embedding a managed reference can't be deep-copied
// out, so it surfaces as a live facade over the borrowed storage, valid for the callback's duration;
// everything else stays a snapshot. An indirect address is the caller's storage, so writing through
// it edits the argument or return.
function decodeBorrowedValue(metadata: Metadata, address: NativePointer, parent: ValueInstance | null = null): CallResult {
  if (metadata.kind === MetadataKind.Tuple) {
    const tuple = ValueInstance.borrow(metadata, address, parent);
    return [...enumerateTupleElements(metadata)].map((e) => decodeBorrowedValue(e.type, address.add(e.offset), tuple));
  }
  if (metadata.kind === MetadataKind.Class) {
    return asSwiftObject(new ClassInstance(address.readPointer()));
  }
  if (metadata.kind === MetadataKind.ObjCClassWrapper) {
    return address.readPointer();
  }
  if (!metadata.valueWitnesses.isPOD && embedsManagedReference(metadata)) {
    return asSwiftObject(ValueInstance.borrow(metadata, address, parent));
  }
  return readValue(metadata, address);
}

// The caller's storage itself, as a facade whose writes the callee and then the caller see; a
// class reference is the object it holds.
function decodeInoutArgument(metadata: Metadata, address: NativePointer): CallResult {
  if (metadata.kind === MetadataKind.Class) {
    return asSwiftObject(new ClassInstance(address.readPointer()));
  }
  if (metadata.kind === MetadataKind.ObjCClassWrapper) {
    return address.readPointer();
  }
  return asSwiftObject(ValueInstance.borrow(metadata, address));
}

function materializeReturn(
  context: CpuContext,
  ret: TypePlan | null,
  indirectReturn: NativePointer | null,
  generics: Metadata[],
  genericParams: string[],
  onResume = false
): CallResult {
  if (ret === null) {
    return null;
  }
  if (ret.kind === "metatype") {
    return decodeMetatype(gpResult(context, 0));
  }
  if (ret.kind === "closure") {
    return decodeClosure(gpResult(context, 0), gpResult(context, 1));
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
  const placed = onResume ? placeAsyncResultScalars(returnType) : placeResultScalars(returnType);
  for (const { scalar, location } of placed) {
    writeRegisterScalar(
      scratch,
      scalar,
      location,
      (n) => (onResume ? resumeGp(context, n) : gpResult(context, n)),
      (n, cls) => fpResult(context, n, cls)
    );
  }
  return decodeBorrowedValue(returnType, scratch);
}

interface SwiftInvocationState {
  indirectReturn?: NativePointer;
  generics?: Metadata[];
  trailingSelf?: NativePointer;
  selfMetadata?: Metadata;
  thrownSlot?: NativePointer;
}

function attach(hookable: HookableTarget, callbacks: SwiftInvocationCallbacks, options: SwiftInterceptorOptions = {}): InvocationListener {
  const entry = hookEntry(hookable);
  const target = entry.address;
  const shape = callShape(entry, options.self);
  if (shape.coroutine) {
    return attachModify(target, shape, callbacks);
  }
  const { args, ret, generics: environment, throws } = shape;
  const genericParams = environment.params;
  const argRegBase = syncArgumentSlotBase(ret);
  const thrown = thrownLowering(shape, false, target, argRegBase);
  const captureIndirect = returnIsIndirect(ret);
  const returnNeedsGenerics = (needsGenerics(ret) || needsGenerics(shape.thrown)) && genericParams.length > 0;
  const decodesArgs = callbacks.onEnter !== undefined || returnNeedsGenerics;
  const receiver = knownReceiver(shape, decodesArgs);
  const unlocatable = unlocatableGenerics(shape);
  const capturesGenerics = callbacks.onLeave !== undefined && genericParams.length > 0 && unlocatable === null;
  const selfReadOnEnter = receiver !== null && (receiver.trailing === true || !(receiver.metadata instanceof Metadata || receiver.metadata === "isa"));
  const takesThrownSlot = thrown !== null && thrown.placed === null;
  const wantsArgs = decodesArgs || (selfReadOnEnter && callbacks.onLeave !== undefined) || capturesGenerics || (takesThrownSlot && callbacks.onLeave !== undefined);

  const onEnter =
    wantsArgs || captureIndirect
      ? function (this: SwiftInvocationContext) {
          const context = this.context;
          const state = this as unknown as SwiftInvocationState;
          if (captureIndirect) {
            state.indirectReturn = indirectResultRegister(context);
          }
          if (wantsArgs) {
            const { values, generics, trailingSelf, selfMetadata, thrownSlot } = materializeArgs(context, args, environment, argRegBase, receiver, takesThrownSlot ? shape.witnessWords : null);
            state.generics = generics;
            exposeTypeArguments(this, generics);
            if (trailingSelf !== null) {
              state.trailingSelf = trailingSelf;
            }
            if (selfMetadata !== null) {
              state.selfMetadata = selfMetadata;
            }
            if (thrownSlot !== null) {
              state.thrownSlot = thrownSlot;
            }
            if (receiver !== null) {
              exposeSelf(this, receiver, trailingSelf ?? selfRegister(context), selfMetadata);
            }
            if (callbacks.onEnter !== undefined) {
              callbacks.onEnter.call(this, values());
            }
          }
        }
      : undefined;

  const onLeave =
    callbacks.onLeave !== undefined
      ? function (this: SwiftInvocationContext) {
          const context = this.context;
          const state = this as unknown as SwiftInvocationState;
          if (receiver !== null) {
            exposeSelf(this, receiver, state.trailingSelf ?? selfRegister(context), state.selfMetadata ?? null);
          }
          exposeTypeArguments(this, state.generics ?? unlocatable ?? []);
          const swiftErrorRegister = errorRegister(context); // swiftcc returns a thrown error here, or a flag for a typed one
          if (throws && !swiftErrorRegister.isNull()) {
            const error =
              thrown === null
                ? decodeThrownError(swiftErrorRegister)
                : materializeThrown(context, thrown, state.thrownSlot ?? null, state.generics ?? [], genericParams);
            callbacks.onLeave!.call(this, null, error);
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

interface ResumeEntry {
  callbacks: SwiftInvocationCallbacks;
  metadata: Metadata;
  receiver: Receiver | null;
  selfAddress: NativePointer;
  selfMetadata: Metadata | null;
  owner: Set<ResumeEntry>;
  slot: ResumeSlot;
}

interface ResumeSlot {
  continuation: NativePointer;
  yielded: NativePointer;
  entries: ResumeEntry[];
}

// A modify accessor is a yield-once coroutine: the ramp takes the caller's coroutine buffer as its
// first argument and returns the continuation with the yielded address; the caller mutates through
// that address, then resumes continuation(buffer, isUnwind). The resume is observed by handing the
// caller a trampoline in the continuation's place, keyed by the buffer, which is live until resumed.
// On arm64e the continuation is signed with the IA key, discriminated by the buffer's address
// blended with the stable hash of the coroutine's yield convention, "yield_once:1:inout:".
const MODIFY_CONTINUATION_DISCRIMINATOR = 0xf45;
const pendingResumes = new Map<string, ResumeSlot>();
const RESUME_TRAMPOLINE_SIZE = 0x80;
let resumeTrampoline: NativePointer | null = null;
let resumeBridge: NativeCallback<"pointer", ["pointer"]> | null = null;

function getResumeTrampoline(): NativePointer {
  if (resumeTrampoline !== null) {
    return resumeTrampoline;
  }
  resumeBridge = new NativeCallback(function (this: CallbackContext, buffer: NativePointer): NativePointer {
    const key = buffer.toString();
    const slot = pendingResumes.get(key)!;
    pendingResumes.delete(key);
    const self = { context: this.context, returnAddress: this.returnAddress, threadId: Process.getCurrentThreadId() } as unknown as SwiftInvocationContext;
    for (const entry of slot.entries) {
      entry.owner.delete(entry);
      // a throwing onLeave must not divert the native resume; isolate it and re-surface next tick
      try {
        if (entry.receiver !== null) {
          exposeSelf(self, entry.receiver, entry.selfAddress, entry.selfMetadata);
        }
        entry.callbacks.onLeave!.call(self, decodeBorrowedValue(entry.metadata, slot.yielded));
      } catch (e) {
        setImmediate(() => {
          throw e;
        });
      }
    }
    return slot.continuation;
  }, "pointer", ["pointer"]);

  const page = Memory.alloc(Process.pageSize);
  Memory.patchCode(page, RESUME_TRAMPOLINE_SIZE, (slot) => {
    if (ARCH === "arm64") {
      const w = new Arm64Writer(slot, { pc: page });
      w.putPushRegReg("x0", "x1");
      w.putPushRegReg("x29", "x30");
      w.putLdrRegAddress("x14", resumeBridge!);
      w.putBlrReg("x14");
      w.putMovRegReg("x16", "x0");
      w.putPopRegReg("x29", "x30");
      w.putPopRegReg("x0", "x1");
      w.putBrRegNoAuth("x16");
      w.flush();
    } else {
      const w = new X86Writer(slot, { pc: page });
      const [buffer, isUnwind] = SWIFTCC.gpArgs as X86Register[];
      w.putPushReg(buffer);
      w.putPushReg(isUnwind);
      w.putPushReg("rbp"); // 16-align rsp across the call
      if (SWIFTCC.homeAreaSize > 0) {
        w.putSubRegImm("rsp", SWIFTCC.homeAreaSize);
      }
      w.putMovRegAddress("r11", resumeBridge!);
      w.putCallReg("r11");
      if (SWIFTCC.homeAreaSize > 0) {
        w.putAddRegImm("rsp", SWIFTCC.homeAreaSize);
      }
      w.putMovRegReg("r11", "rax");
      w.putPopReg("rbp");
      w.putPopReg(isUnwind);
      w.putPopReg(buffer);
      w.putJmpReg("r11");
      w.flush();
    }
  });
  resumeTrampoline = page;
  return page;
}

interface ModifyInvocationState {
  buffer?: NativePointer;
  selfAddress?: NativePointer;
  selfMetadata?: Metadata;
}

// A ramp whose frame needs no buffer never reads x0, which Frida then takes as the redirect's
// scratch register, so the hook is told to use x16 to keep the buffer readable on enter.
function rampTarget(target: NativePointer): NativePointerValue | InstrumentationTarget {
  return ARCH === "arm64" ? { target, scratchRegister: "x16" } : target;
}

function attachModify(target: NativePointer, shape: CallShape, callbacks: SwiftInvocationCallbacks): InvocationListener {
  const receiver = knownReceiver(shape, true);
  const metadata = (shape.ret as { metadata: Metadata }).metadata;
  const liveEntries = new Set<ResumeEntry>();

  const onEnter = function (this: SwiftInvocationContext) {
    const context = this.context;
    const state = this as unknown as ModifyInvocationState;
    const { values, trailingSelf, selfMetadata } = materializeArgs(context, shape.args, shape.generics, 1, receiver);
    state.buffer = gpArg(context, 0);
    state.selfAddress = trailingSelf ?? selfRegister(context);
    if (selfMetadata !== null) {
      state.selfMetadata = selfMetadata;
    }
    if (receiver !== null) {
      exposeSelf(this, receiver, state.selfAddress, selfMetadata);
    }
    if (callbacks.onEnter !== undefined) {
      callbacks.onEnter.call(this, values());
    }
  };

  const onLeave =
    callbacks.onLeave !== undefined
      ? function (this: SwiftInvocationContext, continuation: InvocationReturnValue) {
          const context = this.context;
          const state = this as unknown as ModifyInvocationState;
          const buffer = state.buffer!;
          const key = buffer.toString();
          let slot = pendingResumes.get(key);
          if (slot === undefined) {
            slot = { continuation: gpResult(context, 0).strip(), yielded: gpResult(context, 1), entries: [] };
            pendingResumes.set(key, slot);
            continuation.replace(getResumeTrampoline().sign("ia", buffer.blend(MODIFY_CONTINUATION_DISCRIMINATOR)));
          }
          const entry: ResumeEntry = {
            callbacks,
            metadata,
            receiver,
            selfAddress: state.selfAddress!,
            selfMetadata: state.selfMetadata ?? null,
            owner: liveEntries,
            slot,
          };
          slot.entries.push(entry);
          liveEntries.add(entry);
        }
      : undefined;

  const listener = Interceptor.attach(rampTarget(target), { onEnter, onLeave });
  return {
    detach() {
      listener.detach();
      // Only the bridge may delete a slot; a resuming caller may already be dereferencing pendingResumes[key].
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

export interface SwiftAsyncCallbacks {
  onEnter?: (this: SwiftInvocationContext, args: SwiftValue[], context: NativePointer) => void;
  // The entry partial function returning: reached the first suspension, not logical completion.
  onFirstSuspend?: (this: InvocationContext) => void;
  onComplete?: (this: InvocationContext & { typeArguments?: string[] }, retval: CallResult, error?: CallResult) => void;
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
  thrown: ThrownLowering | null;
  thrownSlot: NativePointer | null;
  generics: Metadata[];
  genericParams: string[];
  typeArguments: Metadata[] | string;
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
  const ctx: Record<string, NativePointer | number> = {};
  if (ARCH === "arm64") {
    SWIFTCC.gpArgs.forEach((reg, i) => {
      ctx[reg] = spillPtr.add(i * 8).readPointer();
    });
    for (let i = 0; i < FP_ARG_REGISTERS; i++) {
      const at = spillPtr.add(0x40 + i * 8);
      ctx[SWIFTCC.fpArg("double", i)] = at.readDouble();
      ctx[SWIFTCC.fpArg("float", i)] = at.readFloat();
    }
    ctx[SWIFTCC.self] = spillPtr.add(0x80).readPointer();
    ctx[SWIFTCC.asyncContext] = asyncContext;
    return ctx as unknown as CpuContext;
  }
  // The resume delivers results in the argument registers; remap them onto the sync result-register
  // names so materializeReturn is shared with the sync path.
  SWIFTCC.gpResults.forEach((reg, i) => {
    ctx[reg] = spillPtr.add(i * 8).readPointer();
  });
  ctx[SWIFTCC.self] = spillPtr.add(X64_SPILL_ERROR).readPointer(); // error
  ctx[SWIFTCC.asyncContext] = asyncContext;
  (ctx as unknown as { xmmSpill: NativePointer }).xmmSpill = spillPtr.add(X64_SPILL_XMM);
  return ctx as unknown as CpuContext;
}

// On the resume, the thrown error rides swiftself (x20 / r13).
function completionErrorValue(context: CpuContext): NativePointer {
  return gpName(context)[SWIFTCC.self];
}

function fireCompletion(entry: CompletionEntry, context: CpuContext, self: InvocationContext): void {
  exposeTypeArguments(self, entry.typeArguments);
  const error = completionErrorValue(context);
  if (entry.throws && !error.isNull()) {
    const thrown =
      entry.thrown === null
        ? decodeThrownError(error)
        : materializeThrown(context, entry.thrown, entry.thrownSlot, entry.generics, entry.genericParams, true);
    entry.callbacks.onComplete!.call(self, null, thrown);
    return;
  }
  entry.callbacks.onComplete!.call(
    self,
    materializeReturn(context, entry.ret, entry.outBuffer, entry.generics, entry.genericParams, true)
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

const X64_RESULT_ARG_REGS = SWIFTCC.gpArgs as X86Register[];

// r13/r14 are callee-saved so the bridge preserves them; caller-saved result regs are spilled/restored.
// The spill sits above the bridge's home area, addressed through r10.
function writeX64CompletionTrampoline(slot: NativePointer, pc: NativePointer): void {
  const w = new X86Writer(slot, { pc });
  const homeArea = SWIFTCC.homeAreaSize;
  const [asyncContext, spillPtr] = SWIFTCC.gpArgs as X86Register[];
  w.putPushReg("rbp"); // 16-align rsp across the call
  w.putSubRegImm("rsp", homeArea + X64_SPILL_SIZE);
  w.putMovRegReg("r10", "rsp");
  w.putAddRegImm("r10", homeArea);
  X64_RESULT_ARG_REGS.forEach((r, i) => w.putMovRegOffsetPtrReg("r10", i * 8, r));
  for (let k = 0; k < 8; k++) {
    putSseScalarMove(w, "store", "double", k, "r10", X64_SPILL_XMM + k * 8);
  }
  w.putMovRegOffsetPtrReg("r10", X64_SPILL_ERROR, "r13");
  w.putMovRegReg(asyncContext, "r14"); // bridge(asyncContext, spillPtr)
  w.putMovRegReg(spillPtr, "r10");
  w.putMovRegAddress("r11", completionBridge!);
  w.putCallReg("r11");
  w.putMovRegReg("r11", "rax"); // r11 = original ResumeParent
  w.putMovRegReg("r10", "rsp");
  w.putAddRegImm("r10", homeArea);
  X64_RESULT_ARG_REGS.forEach((r, i) => w.putMovRegRegOffsetPtr(r, "r10", i * 8));
  for (let k = 0; k < 8; k++) {
    putSseScalarMove(w, "load", "double", k, "r10", X64_SPILL_XMM + k * 8);
  }
  w.putAddRegImm("rsp", homeArea + X64_SPILL_SIZE);
  w.putPopReg("rbp");
  w.putJmpReg("r11");
  w.flush();
}

function attachAsync(hookable: HookableTarget, callbacks: SwiftAsyncCallbacks, options: SwiftInterceptorOptions = {}): InvocationListener {
  if (callbacks.onEnter === undefined && callbacks.onFirstSuspend === undefined && callbacks.onComplete === undefined) {
    throw new Error("attachAsync requires onEnter, onFirstSuspend, or onComplete");
  }
  const entry = hookEntry(hookable);
  const code = entry.parsed === null ? resolveAsyncEntry(entry.address) : entry.address;
  const shape = callShape({ address: code, parsed: entry.parsed }, options.self, true);
  const { args, ret, generics: environment, throws } = shape;
  const genericParams = environment.params;

  const wantsCompletion = callbacks.onComplete !== undefined;
  const indirectReturn = returnIsIndirect(ret);
  const argRegBase = indirectReturn ? 1 : 0; // an @out result takes x0
  const thrown = thrownLowering(shape, true, code, argRegBase);
  const takesThrownSlot = thrown !== null && thrown.placed === null;
  const returnNeedsGenerics = wantsCompletion && (needsGenerics(ret) || needsGenerics(shape.thrown)) && genericParams.length > 0;
  const wantsArgs = callbacks.onEnter !== undefined || returnNeedsGenerics || (wantsCompletion && takesThrownSlot);
  const receiver = knownReceiver(shape, wantsArgs);
  const unlocatable = unlocatableGenerics(shape);
  const capturesGenerics = wantsCompletion && genericParams.length > 0 && unlocatable === null;
  const liveEntries = new Set<CompletionEntry>();

  const armCompletion = (context: CpuContext, generics: Metadata[] | null, thrownSlot: NativePointer | null): void => {
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
      thrown,
      thrownSlot,
      generics: generics ?? [],
      genericParams,
      typeArguments: generics ?? unlocatable ?? [],
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
          let generics: Metadata[] | null = null;
          let thrownSlot: NativePointer | null = null;
          if (wantsArgs || capturesGenerics) {
            const materialized = materializeArgs(context, args, environment, argRegBase, receiver, takesThrownSlot ? shape.witnessWords : null);
            generics = materialized.generics;
            thrownSlot = materialized.thrownSlot;
            exposeTypeArguments(this, generics);
            if (receiver !== null) {
              exposeSelf(this, receiver, materialized.trailingSelf ?? selfRegister(context), materialized.selfMetadata);
            }
            if (callbacks.onEnter !== undefined) {
              callbacks.onEnter.call(this, materialized.values(), asyncContextRegister(context));
            }
          }
          if (wantsCompletion) {
            armCompletion(context, generics, thrownSlot);
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
  attach(target: HookableTarget, callbacks: SwiftInvocationCallbacks, options?: SwiftInterceptorOptions): InvocationListener;
  attachAsync(target: HookableTarget, callbacks: SwiftAsyncCallbacks, options?: SwiftInterceptorOptions): InvocationListener;
}

export const SwiftInterceptor: SwiftInterceptorApi = { attach, attachAsync };

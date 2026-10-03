import { Metadata, MetadataKind, getMetadata } from "../abi/metadata.js";
import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { ClassMetadata, objcClassOf } from "../abi/class-metadata.js";
import { readVTableChain } from "../abi/class-descriptor.js";
import { ClassInstance } from "../abi/heap-object.js";
import { asSwiftObject, SwiftObject, SwiftValueObject, SwiftField, RAW } from "./object-facade.js";
import { ValueInstance } from "../abi/value.js";
import { readValue, writeValue, embedsManagedReference, SwiftValue } from "../abi/instance.js";
import { readEnumCase, projectEnumData, projectBox } from "../abi/enum.js";
import { enumerateTupleElements } from "../abi/tuple.js";
import { findType, withoutTypeArguments } from "../reflection/registry.js";
import { demangle } from "./demangle.js";
import {
  parseSwiftSignature,
  parseTypeExpr,
  TypeExpr,
  TypeExprParam,
  mentionsParam,
  voidMetadata,
  resolveType,
  resolveParsedType,
  ResolveParam,
  hasOpaqueLayout,
  destructuredTupleLayout,
  ParamLayout,
  REFERENCE_CONTAINERS,
  SwiftFunctionSignature,
  GenericRequirement,
  SwiftAccessorSignature,
  ParsedSwiftSignature,
  ParamConvention,
  symbolicate,
} from "./symbolication.js";
import {
  makeSwiftNativeFunction,
  SwiftNativeFunction,
  SwiftArgType,
  shouldPassIndirectly,
  loweredScalars,
  ArgumentAllocator,
  LoweredScalar,
  argumentRegisterUse,
  placeAsyncResultScalars,
  placeTypedErrorScalars,
  typedErrorReturnsDirectly,
  indirect,
} from "./calling-convention.js";
import { probeSelfOwnership, RegisterRange } from "./value-convention.js";
import { AsyncFunctionPointer, findAsyncFunctionPointer } from "../abi/async-function-pointer.js";
import { callAsync, AsyncCallOptions, AsyncResultShape, AsyncFloatArg, FloatClass, SerialExecutorRef } from "./async-call.js";
import { SwiftClosure, ClosureSpec, ClosureBody, LoadableClosureBody, SwiftThrow } from "./closure.js";
import { closureDiscriminator, closureHashString, INDIRECT } from "./closure-discriminator.js";
import { typeName, mangledTypeName, buildMangledTypeToken } from "./type-name.js";
import { lookUpObjCProtocol } from "./objc.js";
import { getSwiftCoreApi } from "./api.js";
import { readString, createString } from "../abi/string.js";
import {
  isClassExistential,
  existentialRepresentation,
  projectErrorExistential,
  projectOpaqueExistential,
  protocolClassConstraint,
  compareProtocolDescriptors,
  getExistentialTypeMetadata,
} from "../abi/existential.js";
import { PrefixedExport, moduleKey, swiftExportsOfTokens, hasSwiftSymbolWithPrefix, initializerSymbols, initializerSymbolsWithPrefix } from "./symbol-index.js";
import {
  findProtocol,
  conformsToProtocol,
  conformingProtocols,
  conformingTypes,
  ProtocolConformance,
} from "../abi/protocol-conformance.js";
import {
  ProtocolRequirement,
  ProtocolRequirementKind,
  readProtocolRequirements,
  readRequirementSignature,
} from "../abi/protocol-descriptor.js";
import {
  GenericRequirementDescriptor,
  GenericRequirementKind,
  GenericRequirementLayoutKind,
} from "../abi/generic-requirement-descriptor.js";
import { WitnessTable } from "../abi/witness-table.js";
import { genericRequirements, hasFixedLayoutInGenericContext, keyGenericArguments } from "../abi/generic-instantiation.js";
import type { SwiftType } from "./swift-type.js";
import type { SwiftTypeFacade } from "./type-facade.js";
import { metadataOf, typeOf } from "./swift-type.js";

export type MethodKind = "method" | "init" | "subscript";

export type CallResult = SwiftValue | SwiftObject;

export function isSwiftObject(value: CallResult): value is SwiftObject {
  return typeof value === "object" && value !== null && "$kind" in value;
}

// A SwiftField ($field view) is a borrowed ValueInstance at runtime, which marshalArg accepts.
export type CallArg = SwiftValue | SwiftObject | SwiftField | ClosureSpec;

// Resolution order is own, then extension in another module, then protocol extension.
export type MemberOrigin =
  | { kind: "own" | "extension"; type: string; module: string }
  | { kind: "protocolExtension"; protocol: string; module: string };

// What a member was declared with, as its symbol spells it: the names round-trip into the
// { argTypes } and { returnType } lookup filters.
export interface SwiftMemberSignature {
  readonly labels: (string | null)[];
  readonly argTypeNames: string[];
  readonly returnTypeName: string | null;
  readonly throws: boolean;
  readonly thrownTypeName: string | null;
  readonly isAsync: boolean;
  readonly genericParams: string[];
}

// A bound member's types are resolved; a parameter the bridge builds no metadata for (a closure)
// and a type that is still generic read as null.
export interface SwiftBoundSignature extends SwiftMemberSignature {
  readonly argTypes: (SwiftType | null)[];
  readonly returnType: SwiftType | null;
}

export function memberSignature(signature: SwiftFunctionSignature): SwiftMemberSignature {
  return {
    labels: signature.argLabels,
    argTypeNames: signature.argTypeNames,
    returnTypeName: signature.returnTypeName,
    throws: signature.throws,
    thrownTypeName: signature.thrownType?.text ?? null,
    isAsync: signature.async,
    genericParams: signature.genericParams,
  };
}

export function boundSignature(signature: SwiftFunctionSignature, argTypes: (Metadata | null)[], returnType: Metadata | null): SwiftBoundSignature {
  return {
    ...memberSignature(signature),
    argTypes: argTypes.map((m) => (m === null ? null : typeOf(m))),
    returnType: returnType === null ? null : typeOf(returnType),
  };
}

// The types a member's symbol names, where the bridge can build them without type arguments.
export function unboundSignature(signature: SwiftFunctionSignature): SwiftBoundSignature {
  const concrete = (type: TypeExpr): Metadata | null => resolveParsedType(type, () => null);
  return boundSignature(signature, signature.params.map((p) => concrete(p.type)), signature.result === null ? null : concrete(signature.result));
}

// What a hook plans from when it is handed a member instead of an address.
export interface HookTarget {
  address: NativePointer;
  signature: SwiftFunctionSignature;
  witnessDispatched: boolean;
}

const hookTargets = new WeakMap<object, HookTarget>();

export function hookTargetOf(member: object): HookTarget | undefined {
  return hookTargets.get(member);
}

export function withHookTarget<T extends object>(member: T, target: HookTarget | null): T {
  if (target !== null) {
    hookTargets.set(member, target);
  }
  return member;
}

export interface SwiftBoundMethod {
  readonly address: NativePointer;
  readonly origin: MemberOrigin;
  readonly signature: SwiftBoundSignature;
  call(...args: CallArg[]): CallResult | Promise<CallResult>;
}

interface ResolvedBoundMethod {
  readonly address: NativePointer;
  readonly origin?: MemberOrigin;
  readonly signature: SwiftBoundSignature;
  readonly hookTarget: HookTarget | null;
  call(...args: CallArg[]): CallResult | Promise<CallResult>;
}

export function narrowBoundMethod(binder: ResolvedBoundMethod, receiver?: RawInstance): SwiftBoundMethod {
  return withHookTarget(
    {
      address: binder.address,
      origin: binder.origin!,
      signature: binder.signature,
      call: (...args) => {
        receiver?.checkLive(); // roots the receiver past its GC release and rejects a disposed one
        return binder.call(...args);
      },
    },
    binder.hookTarget
  );
}

export interface SwiftBoundInitializer {
  readonly address: NativePointer;
  call(...args: CallArg[]): SwiftValueObject | null;
}

export function narrowBoundInitializer(binder: SwiftBoundInitializer): SwiftBoundInitializer {
  return { address: binder.address, call: (...args) => binder.call(...args) };
}

export interface RawInstance {
  readonly handle: NativePointer;
  readonly owned: boolean;
  readonly kind: "object" | "value";
  readonly type: SwiftType;
  get(name: string): CallResult;
  set(name: string, value: CallArg): void;
  call(name: string, ...args: CallArg[]): CallResult | Promise<CallResult>;
  field(name: string): ValueInstance;
  dispose(): void;
  checkLive(): void;
  [Symbol.dispose](): void;
}

export interface MethodInfo {
  name: string;
  kind: MethodKind;
  isStatic: boolean;
  address: NativePointer;
  argTypeNames: string[];
  argLabels: (string | null)[];
  returnTypeName: string | null;
  selector: string;
  genericParams: string[]; // placeholders that may appear in argTypeNames/returnTypeName, e.g. "A"
  throws: boolean;
  mangled: string;
}

// A typed throw's error type; abstract when the callee sees it as a type parameter, which keeps
// it out of the result registers whatever its concrete layout.
export interface ThrownType {
  metadata: Metadata;
  abstract: boolean;
}

export interface ResolvedMethod {
  address: NativePointer;
  argTypes: Metadata[];
  returnType: Metadata | null;
  throws: boolean;
  thrown?: ThrownType;
  isStatic: boolean;
  selector: string;
  signature?: SwiftFunctionSignature;
  async?: boolean;
  asyncFunctionPointer?: AsyncFunctionPointer;
  witnessSelf?: WitnessTable;
  witnessTables?: NativePointer[];
  abstractArgs?: boolean[];
  abstractReturn?: Abstraction;
  argConventions?: ParamConvention[];
  origin?: MemberOrigin;
}

// true: passed by address; an array: a tuple destructured per element, each by address or direct.
export type Abstraction = boolean | boolean[];

interface BaseResolveOptions {
  arity?: number;
  labels?: (string | null)[]; // null = unlabelled
  argTypes?: string[]; // exact match against the signature's demangled argument-type names
  returnType?: string | null; // exact match against the demangled return-type name; null = Void
  static?: boolean;
  accessor?: AccessorKind; // a subscript's getter or setter; a method lookup names neither
}

export interface MethodResolveOptions extends BaseResolveOptions {
  typeArguments?: (SwiftType | SwiftTypeFacade)[]; // one entry per generic parameter
}

export type SelfOwnership = "borrowing" | "mutating" | "consuming";

// How self is taken is unrecoverable from the symbol; the caller supplies it. It only changes self
// routing for small loadable receivers: required for generic methods, optional for async ones.
export interface ValueMethodResolveOptions extends MethodResolveOptions {
  self?: SelfOwnership;
}

export interface RawMethodResolveOptions extends BaseResolveOptions {
  typeArguments?: Metadata[];
  witnessTables?: NativePointer[]; // overrides the witnesses auto-resolved from the where-clause
}

export interface RawValueMethodResolveOptions extends RawMethodResolveOptions {
  self?: SelfOwnership;
}

// A member named by its selector, as the listings spell it ("deriveKey(inputKeyMaterial:_:)"),
// carries its labels in the name.
export function splitSelector<T extends BaseResolveOptions>(name: string, options: T): { name: string; options: T } {
  const open = name.indexOf("(");
  if (open === -1) {
    return { name, options };
  }
  const inner = name.slice(open + 1, -1);
  const parts = inner.split(":");
  if (!name.endsWith(")") || parts.pop() !== "" || parts.some((p) => p === "")) {
    throw new Error(`malformed selector ${name}`);
  }
  if (options.labels !== undefined) {
    throw new Error(`${name} names its labels; drop { labels }`);
  }
  return { name: name.slice(0, open), options: { ...options, labels: parts.map((p) => (p === "_" ? null : p)) } };
}

export function initializerLookup<T extends BaseResolveOptions>(selector: string | T | undefined, options: T): T {
  if (typeof selector !== "string") {
    return selector ?? options;
  }
  const split = splitSelector(selector, options);
  if (split.name !== "init") {
    throw new Error(`${selector} is not an initializer selector`);
  }
  return split.options;
}

export function lowerResolveOptions(stable: ValueMethodResolveOptions): RawValueMethodResolveOptions {
  const { arity, labels, argTypes, returnType, static: isStatic, accessor, self, typeArguments } = stable;
  const raw: RawValueMethodResolveOptions = { arity, labels, argTypes, returnType, static: isStatic, accessor, self };
  if (typeArguments !== undefined) {
    raw.typeArguments = typeArguments.map((t) => metadataOf(t));
  }
  return raw;
}

interface MethodCandidate {
  address: NativePointer;
  name: string;
  mangled: string;
  isStatic: boolean;
  signature: SwiftFunctionSignature;
  constraints: string[];
}

export type AccessorKind = "getter" | "setter";

interface AccessorCandidate {
  address: NativePointer;
  member: string;
  kind: AccessorKind | "modify";
  type: TypeExpr;
  typeName: string;
  isStatic: boolean;
  constraints: string[];
}

interface TypeMembers {
  methods: MethodCandidate[];
  accessors: AccessorCandidate[];
}

const tableCache = new Map<string, TypeMembers>();
const idleInvokers = new Map<string, SwiftNativeFunction[]>();

function rawArg(value: CallArg): CallArg | ClassInstance | ValueInstance {
  return value !== null && typeof value === "object"
    ? (value as { [RAW]?: ClassInstance | ValueInstance })[RAW] ?? value
    : value;
}

function assertClassAssignable(arg: ClassInstance, declared: Metadata): void {
  const declaredClass =
    declared.kind === MetadataKind.ObjCClassWrapper ? objcClassOf(declared) : declared.handle;
  for (let cls: ClassMetadata | null = arg.metadata; cls !== null; cls = cls.superclass) {
    if (cls.handle.equals(declaredClass)) {
      return;
    }
  }
  throw new Error(`argument is a ${typeName(arg.dynamicType)}, expected ${typeName(declared)}`);
}

function marshalArg(metadata: Metadata, value: CallArg): NativePointer {
  const arg = rawArg(value);
  const buffer = Memory.alloc(metadata.typeLayout.stride);
  if (arg instanceof ValueInstance) {
    if (!arg.metadata.handle.equals(metadata.handle)) {
      throw new Error(`argument is a ${typeName(arg.metadata)} value, expected ${typeName(metadata)}`);
    }
    arg.copyInto(buffer);
  } else if (arg instanceof ClassInstance) {
    const referenceType =
      metadata.kind === MetadataKind.Optional ? new Metadata(metadata.genericArguments.readPointer()) : metadata;
    if (!isClassType(referenceType)) {
      throw new Error(`argument is a class instance, expected ${typeName(metadata)}`);
    }
    assertClassAssignable(arg, referenceType);
    // Optional<class> is the bare reference; unlike a class arg, its temp owns it like any value temp.
    buffer.writePointer(referenceType === metadata ? arg.handle : getSwiftCoreApi().swift_unknownObjectRetain(arg.handle));
  } else if (metadata.kind === MetadataKind.ObjCClassWrapper && arg instanceof NativePointer) {
    buffer.writePointer(arg); // an ObjC reference is raw both ways, as decodeReturn hands it back
  } else if (metadata.kind === MetadataKind.Class) {
    throw new Error(`expected a ${typeName(metadata)} object; a raw pointer is only accepted via /abi`);
  } else {
    writeValue(metadata, buffer, arg as SwiftValue);
  }
  return buffer;
}

function existentialPayloadEmbedsManagedReference(metadata: Metadata, container: NativePointer): boolean {
  const payload =
    existentialRepresentation(metadata) === "error"
      ? projectErrorExistential(container)
      : projectOpaqueExistential(container);
  return embedsManagedReference(payload.type);
}

// `.none` returns null; `.some`'s bare T sits at offset 0 (single-payload), so it decodes in place
// and the Optional wrapper is never destroyed — destroying it faults on resilient payloads (URL).
function projectOptionalPayload(
  metadata: Metadata,
  ret: NativePointer
): { payloadType: Metadata; address: NativePointer } | null {
  const { payloadType, isIndirect } = readEnumCase(metadata, ret);
  if (payloadType === null) {
    return null;
  }
  if (!isIndirect) {
    return { payloadType, address: ret };
  }
  projectEnumData(metadata, ret);
  return { payloadType, address: projectBox(ret.readPointer()) };
}

// Returns are +1: adopt a class; destroy a read non-POD temp; POD owns nothing. A value embedding a
// managed reference would dangle on that destroy, so hand it back as an owned ValueInstance instead.
export function decodeReturn(returnType: Metadata | null, ret: NativePointer | null): CallResult {
  if (returnType === null || ret === null) {
    return null;
  }
  if (returnType.kind === MetadataKind.Class) {
    return asSwiftObject(ClassInstance.adopt(ret.readPointer()));
  }
  // An imported ObjC class is not a Swift heap object; hand back the raw ref to wrap in ObjC.Object.
  if (returnType.kind === MetadataKind.ObjCClassWrapper) {
    return ret.readPointer();
  }
  if (returnType.kind === MetadataKind.Optional) {
    const some = projectOptionalPayload(returnType, ret);
    return some === null ? null : decodeReturn(some.payloadType, some.address);
  }
  // A tuple decodes to an array, each element consumed in place by the recursion (not one facade).
  if (returnType.kind === MetadataKind.Tuple) {
    return [...enumerateTupleElements(returnType)].map((e) => decodeReturn(e.type, ret.add(e.offset)));
  }
  // A class existential owns its +1 class ref in the first word; adopt it and skip the container
  // destroy, which would release that same ref and dangle the returned object.
  const isExistential =
    returnType.kind === MetadataKind.Existential ||
    returnType.kind === MetadataKind.ExtendedExistential;
  if (isExistential && isClassExistential(returnType)) {
    return asSwiftObject(ClassInstance.adopt(ret.readPointer()));
  }
  if (returnType.kind === MetadataKind.Existential && existentialPayloadEmbedsManagedReference(returnType, ret)) {
    return asSwiftObject(ValueInstance.adopt(returnType, ret));
  }
  if (!returnType.valueWitnesses.isPOD && embedsManagedReference(returnType)) {
    return asSwiftObject(ValueInstance.adopt(returnType, ret));
  }
  const value = readValue(returnType, ret);
  if (!returnType.valueWitnesses.isPOD) {
    returnType.valueWitnesses.destroy(ret);
  }
  return value;
}

// A borrowed non-POD arg temp is ours to destroy; a class arg is a bare borrowed pointer and a POD
// value owns nothing, so neither is destroyed here.
function destroyArgTemp(metadata: Metadata, ptr: NativePointer): void {
  if (metadata.kind !== MetadataKind.Class && !metadata.valueWitnesses.isPOD) {
    metadata.valueWitnesses.destroy(ptr);
  }
}

// An owned arg's temp is consumed by the callee, and an inout arg is the caller's own value.
function destroyBorrowedTemps(argTypes: Metadata[], buffers: NativePointer[], conventions: ParamConvention[]): void {
  buffers.forEach((ptr, i) => {
    if ((conventions[i] ?? "borrowed") === "borrowed") {
      destroyArgTemp(argTypes[i], ptr);
    }
  });
}

// inout passes the caller's value by address, so the callee's writes land in it.
function inoutArg(metadata: Metadata, value: CallArg): NativePointer {
  const arg = rawArg(value);
  if (!(arg instanceof ValueInstance)) {
    throw new Error(`an inout ${typeName(metadata)} argument must be a value facade to write back into`);
  }
  if (!arg.metadata.handle.equals(metadata.handle)) {
    throw new Error(`argument is a ${typeName(arg.metadata)} value, expected ${typeName(metadata)}`);
  }
  arg.checkLive();
  return arg.handle;
}

// A class arg marshals as a bare borrowed pointer, so an owned (+1) one needs its own retain.
function marshalArgsOrCleanup(argTypes: Metadata[], args: CallArg[], conventions: ParamConvention[] = []): NativePointer[] {
  const buffers: NativePointer[] = [];
  try {
    for (let i = 0; i < argTypes.length; i++) {
      buffers.push(conventions[i] === "inout" ? inoutArg(argTypes[i], args[i]) : marshalArg(argTypes[i], args[i]));
    }
  } catch (e) {
    buffers.forEach((ptr, i) => {
      if (conventions[i] !== "inout") {
        destroyArgTemp(argTypes[i], ptr);
      }
    });
    throw e;
  }
  conventions.forEach((convention, i) => {
    if (convention === "owned" && argTypes[i].kind === MetadataKind.Class) {
      new ClassInstance(buffers[i].readPointer()).retain();
    }
  });
  return buffers;
}

export function marshalConsumedArgs(argTypes: Metadata[], args: CallArg[]): NativePointer[] {
  return marshalArgsOrCleanup(argTypes, args, argTypes.map(() => "owned"));
}

export function callMarshalled(
  argTypes: Metadata[],
  args: CallArg[],
  returnType: Metadata | null,
  invoke: (argPtrs: NativePointer[]) => NativePointer | null,
  conventions: ParamConvention[] = []
): CallResult {
  if (args.length !== argTypes.length) {
    throw new Error(`expected ${argTypes.length} argument(s), got ${args.length}`);
  }
  const argPtrs = marshalArgsOrCleanup(argTypes, args, conventions);
  try {
    return decodeReturn(returnType, invoke(argPtrs));
  } finally {
    destroyBorrowedTemps(argTypes, argPtrs, conventions);
  }
}

function stripReceiverKeyword(context: string): { context: string; isStatic: boolean } {
  for (const keyword of ["static ", "class "]) {
    if (context.startsWith(keyword)) {
      return { context: context.slice(keyword.length), isStatic: true };
    }
  }
  return { context, isStatic: false };
}

function methodKind(name: string): MethodKind {
  return name === "init" || name === "__allocating_init" ? "init" : "method";
}

function splitParams(params: TypeExprParam[]): { types: TypeExpr[]; conventions: ParamConvention[] } {
  return { types: params.map((p) => p.type), conventions: params.map((p) => p.convention) };
}

function signatureMetadata(
  signature: SwiftFunctionSignature,
  resolveParam: ResolveParam = () => null,
  thrownIsAbstract: (type: TypeExpr) => boolean = () => false
): { argTypes: Metadata[]; returnType: Metadata | null; thrown?: ThrownType } {
  const argTypes = signature.params.map(({ type }) => {
    const metadata = resolveParsedType(type, resolveParam);
    if (metadata === null) {
      throw new Error(`cannot resolve argument type ${type.text} of ${signature.selector}`);
    }
    return metadata;
  });
  let returnType: Metadata | null = null;
  if (signature.result !== null) {
    returnType = resolveParsedType(signature.result, resolveParam);
    if (returnType === null) {
      throw new Error(`cannot resolve return type ${signature.result.text} of ${signature.selector}`);
    }
  }
  return { argTypes, returnType, thrown: resolveThrownType(signature, resolveParam, thrownIsAbstract) };
}

function resolveThrownType(
  signature: SwiftFunctionSignature,
  resolveParam: ResolveParam,
  thrownIsAbstract: (type: TypeExpr) => boolean
): ThrownType | undefined {
  if (signature.thrownType === null) {
    return undefined;
  }
  const metadata = resolveParsedType(signature.thrownType, resolveParam);
  if (metadata === null) {
    throw new Error(`cannot resolve thrown type ${signature.thrownType.text} of ${signature.selector}`);
  }
  return { metadata, abstract: thrownIsAbstract(signature.thrownType) };
}

function sequenceEqual<T>(actual: T[], wanted: T[]): boolean {
  return actual.length === wanted.length && actual.every((value, i) => value === wanted[i]);
}

function applyOverloadFilters<T extends { isStatic: boolean; signature: SwiftFunctionSignature }>(
  candidates: T[],
  options: RawMethodResolveOptions
): T[] {
  candidates = candidates.filter((c) => (c.signature.accessor ?? null) === (options.accessor ?? null));
  if (options.static !== undefined) {
    candidates = candidates.filter((c) => c.isStatic === options.static);
  }
  if (options.arity !== undefined) {
    candidates = candidates.filter((c) => c.signature.argTypeNames.length === options.arity);
  }
  if (options.labels !== undefined) {
    candidates = candidates.filter((c) => sequenceEqual(c.signature.argLabels, options.labels!));
  }
  if (options.argTypes !== undefined) {
    candidates = candidates.filter((c) => sequenceEqual(c.signature.argTypeNames, options.argTypes!));
  }
  if (options.returnType !== undefined) {
    candidates = candidates.filter((c) => c.signature.returnTypeName === options.returnType);
  }
  return candidates;
}

function describeOverload(signature: SwiftFunctionSignature): string {
  return `${signature.selector} (${signature.argTypeNames.join(", ")}) -> ${signature.returnTypeName ?? "()"}`;
}

function imageName(address: NativePointer): string {
  return Process.findModuleByAddress(address.strip())?.name ?? "<unknown image>";
}

function describeOverloads(candidates: MethodCandidate[]): string {
  const images = candidates.map((c) => imageName(c.address));
  const spansImages = new Set(images).size > 1;
  return candidates
    .map((c, i) => describeOverload(c.signature) + (spansImages ? ` in ${images[i]}` : ""))
    .join(", ");
}

function memberOrigin(address: NativePointer, type: string): MemberOrigin {
  const module = imageName(address);
  const owner = imageName(findType(type)!.handle);
  return { kind: module === owner ? "own" : "extension", type, module };
}

// swift_getTypeName spells a private type's anonymous parent as "(unknown context at $<address>)";
// its symbols spell the type itself as "(Name in _<discriminator>)". Both collapse to the plain name.
const RUNTIME_ANONYMOUS_CONTEXT = /\(unknown context at \$[0-9a-f]+\)\./g;
const PRIVATE_DECL_NAME = /\(([^()\s]+) in _[0-9A-F]+\)/g;

function canonicalTypeName(typeName: string): string {
  const descriptor = findType(withoutTypeArguments(typeName).replace(RUNTIME_ANONYMOUS_CONTEXT, ""));
  if (descriptor === null) {
    throw new Error(`unknown type: ${typeName}`);
  }
  const full = descriptor.fullTypeName;
  if (full === null) {
    throw new Error(`type ${typeName} has no full name`);
  }
  return full;
}

// A member is keyed to its declaring class, so inherited ones need the superclass chain.
// Most-derived first; non-class/generic types collapse to one level.
function classChainNames(fullName: string): string[] {
  const descriptor = findType(fullName);
  if (descriptor === null || descriptor.kind !== ContextDescriptorKind.Class || descriptor.isGeneric) {
    return [fullName];
  }
  const names: string[] = [];
  let cls: ClassMetadata | null = new ClassMetadata(getMetadata(descriptor).handle);
  while (cls !== null && cls.isTypeMetadata) {
    const name = cls.description.fullTypeName;
    if (name === null) {
      break;
    }
    names.push(name);
    cls = cls.superclass;
  }
  return names.length === 0 ? [fullName] : names;
}

// Every entity symbol leads with its context's mangled node, so the raw name can be tested for it
// before demangling. A spelling the runtime and the compiler disagree on (a private discriminator,
// say) diverges for all of a type's symbols or none, so an empty scan is what signals the retry.
function mangledTypeToken(descriptor: ContextDescriptor): string | null {
  if (descriptor.isGeneric) {
    return buildMangledTypeToken(descriptor);
  }
  try {
    return mangledTypeName(getMetadata(descriptor));
  } catch {
    return null;
  }
}

const provenTokens = new Map<string, string | null>();

function provenToken(fullName: string, descriptor: ContextDescriptor, owner: Module): string | null {
  const cached = provenTokens.get(fullName);
  if (cached !== undefined) {
    return cached;
  }
  const token = mangledTypeToken(descriptor);
  const proven =
    token === null || !descriptor.isGeneric || carriesToken(owner, token) ? token : null;
  provenTokens.set(fullName, proven);
  return proven;
}

function carriesToken(module: Module, token: string): boolean {
  return swiftExportsOfTokens(module, [token])[0].length > 0 || hasSwiftSymbolWithPrefix(module, `$s${token}`);
}

const foreignScans = new Map<string, TypeMembers>();

type SymbolFilter = (symbol: string) => boolean;

// Keyed on the module, not on the answer: a loaded module's symbols can't change, while
// "type T has no member m" stops being true as soon as another module is loaded.
function foreignMembers(fullName: string, mayName: SymbolFilter | null = null): TypeMembers {
  const methods: MethodCandidate[] = [];
  const accessors: AccessorCandidate[] = [];
  const descriptor = findType(fullName)!;
  const owner = Process.findModuleByAddress(descriptor.handle);
  if (owner === null) {
    return { methods, accessors };
  }
  const token = provenToken(fullName, descriptor, owner);
  if (token === null) {
    return { methods, accessors };
  }
  for (const module of Process.enumerateModules()) {
    if (module.base.equals(owner.base)) {
      continue;
    }
    forEachExportedMembers(module, [{ fullName, token, withConstrainedExtensions: false }], mayName, (_, found) => {
      methods.push(...found.methods);
      accessors.push(...found.accessors);
    });
  }
  return { methods, accessors };
}

interface MemberTarget {
  fullName: string;
  token: string;
  withConstrainedExtensions: boolean;
}

function forEachExportedMembers(
  module: Module,
  targets: MemberTarget[],
  mayName: SymbolFilter | null,
  visit: (targetIndex: number, members: TypeMembers) => void
): void {
  const found = swiftExportsOfTokens(module, targets.map((t) => t.token));
  targets.forEach((target, i) => {
    const exports = found[i];
    if (exports.length === 0) {
      return;
    }
    if (mayName !== null) {
      visit(i, membersAmong(exports.filter((e) => mayName(e.name)), target));
      return;
    }
    const key = `${moduleKey(module)}|${target.token}`;
    let members = foreignScans.get(key);
    if (members === undefined) {
      members = membersAmong(exports, target);
      foreignScans.set(key, members);
    }
    visit(i, members);
  });
}

function membersAmong(exports: PrefixedExport[], target: MemberTarget): TypeMembers {
  const members: TypeMembers = { methods: [], accessors: [] };
  const seen = new Set<string>();
  for (const e of exports) {
    considerMember(members, seen, target.fullName, e.name, e.address, false, target.withConstrainedExtensions);
  }
  return members;
}

// A word substitution only refers back to a word spelled out earlier in the same symbol, so every
// word of the name appears verbatim even when the identifier itself is mangled with substitutions.
function symbolMayName(name: string): SymbolFilter | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return null;
  }
  const words = name
    .replace(/([^A-Z])([A-Z])/g, "$1_$2")
    .split("_")
    .map((w) => w.replace(/^[0-9]+/, ""))
    .filter((w) => w.length > 0);
  return (symbol) => words.every((w) => symbol.includes(w));
}

export interface MemberKinds {
  method: boolean;
  property: boolean;
  writable: boolean;
}

export function memberKindsInOtherModules(typeName: string, name: string, isStatic = false): MemberKinds {
  const fullName = canonicalTypeName(typeName);
  const mayName = symbolMayName(name);
  const found: MemberKinds = { method: false, property: false, writable: false };
  const consider = (members: TypeMembers, isMethod: (c: MethodCandidate) => boolean): void => {
    found.method ||= members.methods.some((c) => c.name === name && isMethod(c));
    found.property ||= members.accessors.some((a) => a.member === name && a.isStatic === isStatic);
    found.writable ||= members.accessors.some((a) => a.member === name && a.isStatic === isStatic && a.kind === "setter");
  };
  const isMethod = (c: MethodCandidate): boolean => c.isStatic === isStatic && c.signature.accessor === undefined && methodKind(c.name) === "method";
  for (const className of classChainNames(fullName)) {
    consider(foreignMembers(className, mayName), isMethod);
  }
  for (const conformance of conformanceMembers(fullName, mayName)) {
    consider(conformance.members, (c) => isConformanceMethod(c) && isMethod(c));
  }
  return found;
}

const STANDARD_PROTOCOL_SUBSTITUTION = /^S(?:c)?[A-Za-z]$/;
const protocolTokens = new Map<string, string | null>();

// The runtime spells `any P` as P's protocol-list entry plus `_p`: the stdlib's as a substitution
// (ST), any other without the P an extension's context carries.
function protocolToken(protocol: ContextDescriptor): string | null {
  const key = protocol.handle.toString();
  let token = protocolTokens.get(key);
  if (token === undefined) {
    const existential = mangledTypeName(getExistentialTypeMetadata([protocol]));
    const entry = existential?.endsWith("_p") ? existential.slice(0, -2) : null;
    token = entry === null || STANDARD_PROTOCOL_SUBSTITUTION.test(entry) ? entry : `${entry}P`;
    protocolTokens.set(key, token);
  }
  return token;
}

function protocolExtensionTarget(protocol: ContextDescriptor): MemberTarget | null {
  const fullName = protocol.fullTypeName;
  const token = protocolToken(protocol);
  return fullName === null || token === null ? null : { fullName, token, withConstrainedExtensions: true };
}

function protocolExtensionMembersOfAll(protocols: ContextDescriptor[], mayName: SymbolFilter | null = null): TypeMembers[] {
  const result = protocols.map((): TypeMembers => ({ methods: [], accessors: [] }));
  const targets: MemberTarget[] = [];
  const slots: number[] = [];
  protocols.forEach((protocol, i) => {
    const target = protocolExtensionTarget(protocol);
    if (target !== null) {
      targets.push(target);
      slots.push(i);
    }
  });
  if (targets.length === 0) {
    return result;
  }
  for (const module of Process.enumerateModules()) {
    forEachExportedMembers(module, targets, mayName, (i, found) => {
      result[slots[i]].methods.push(...found.methods);
      result[slots[i]].accessors.push(...found.accessors);
    });
  }
  return result;
}

function protocolExtensionMembers(protocol: ContextDescriptor): TypeMembers {
  return protocolExtensionMembersOfAll([protocol])[0];
}

export type ModuleScope = "definingModule" | "allLoadedModules";

type MemberSource = (fullName: string) => TypeMembers;

function allLoadedModuleMembers(fullName: string): TypeMembers {
  const own = definingModuleMembers(fullName);
  const foreign = foreignMembers(fullName);
  return {
    methods: [...own.methods, ...foreign.methods],
    accessors: [...own.accessors, ...foreign.accessors],
  };
}

function definingModuleMembers(fullName: string): TypeMembers {
  const cached = tableCache.get(fullName);
  if (cached !== undefined) {
    return cached;
  }
  const descriptor = findType(fullName)!;
  const module = Process.findModuleByAddress(descriptor.handle);
  if (module === null) {
    throw new Error(`no module owns ${fullName}`);
  }
  const token = mangledTypeToken(descriptor);
  const members = scanMembers(module, fullName, token === null || tokenIsSpelled(module, token) ? token : null);
  tableCache.set(fullName, members);
  return members;
}

// A spelling the runtime and the compiler disagree on (a private discriminator, say) diverges for all
// of a type's symbols or none, so a token no symbol leads with is what calls for the unfiltered scan;
// a type with symbols but no members is not.
function tokenIsSpelled(module: Module, token: string): boolean {
  return swiftExportsOfTokens(module, [token])[0].length > 0 || initializerSymbolsWithPrefix(module, `$s${token}`).length > 0;
}

function scanMembers(module: Module, fullName: string, token: string | null): TypeMembers {
  if (token === null) {
    const exported = exportedByContext(module).get(fullName) ?? { methods: [], accessors: [] };
    const seen = new Set(exported.methods.map((c) => c.address.strip().toString()));
    const inits = (initializersByContext(module).get(fullName)?.methods ?? []).filter((c) => !seen.has(c.address.strip().toString()));
    return { methods: [...exported.methods, ...inits], accessors: exported.accessors };
  }
  const members: TypeMembers = { methods: [], accessors: [] };
  const seen = new Set<string>();
  const prefix = `$s${token}`;
  for (const e of swiftExportsOfTokens(module, [token])[0]) {
    considerMember(members, seen, fullName, e.name, e.address, false, false);
  }
  for (const s of initializerSymbolsWithPrefix(module, prefix)) {
    considerMember(members, seen, fullName, s.name, s.address, true, false);
  }
  return members;
}

const exportedIndexes = new Map<string, Map<string, TypeMembers>>();
const initializerIndexes = new Map<string, Map<string, TypeMembers>>();

function exportedByContext(module: Module): Map<string, TypeMembers> {
  const key = moduleKey(module);
  let index = exportedIndexes.get(key);
  if (index === undefined) {
    index = indexByContext(module.enumerateExports(), false);
    exportedIndexes.set(key, index);
  }
  return index;
}

function initializersByContext(module: Module): Map<string, TypeMembers> {
  const key = moduleKey(module);
  let index = initializerIndexes.get(key);
  if (index === undefined) {
    index = indexByContext(initializerSymbols(module), true);
    initializerIndexes.set(key, index);
  }
  return index;
}

function indexByContext(symbols: PrefixedExport[], initsOnly: boolean): Map<string, TypeMembers> {
  const byContext = new Map<string, TypeMembers>();
  const seen = new Set<string>();
  for (const s of symbols) {
    const key = s.address.strip().toString();
    if (s.address.isNull() || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const demangled = demangledMember(s.name);
    const parsed = demangled === null ? null : parseMember(demangled, s.name, s.address, initsOnly, false);
    if (parsed === null) {
      continue;
    }
    let members = byContext.get(parsed.context);
    if (members === undefined) {
      members = { methods: [], accessors: [] };
      byContext.set(parsed.context, members);
    }
    addMember(members, parsed);
  }
  return byContext;
}

function considerMember(
  members: TypeMembers,
  seen: Set<string>,
  fullName: string,
  name: string,
  address: NativePointer,
  initsOnly: boolean,
  withConstrainedExtensions: boolean
): void {
  const key = address.strip().toString();
  if (address.isNull() || seen.has(key)) {
    return;
  }
  seen.add(key);
  const demangled = demangledMember(name);
  if (demangled === null || !demangled.includes(fullName)) {
    return;
  }
  const parsed = parseMember(demangled, name, address, initsOnly, withConstrainedExtensions);
  if (parsed !== null && parsed.context === fullName) {
    addMember(members, parsed);
  }
}

interface ParsedMember {
  context: string;
  method: MethodCandidate | null;
  accessor: AccessorCandidate | null;
}

function demangledMember(name: string): string | null {
  return demangle(name)?.replace(PRIVATE_DECL_NAME, "$1") ?? null;
}

function parseMember(
  demangled: string,
  name: string,
  address: NativePointer,
  initsOnly: boolean,
  withConstrainedExtensions: boolean
): ParsedMember | null {
  const signature = parseSwiftSignature(demangled);
  if (signature === null) {
    return null;
  }
  if (signature.kind === "function") {
    if ((initsOnly && signature.name !== "init") || signature.accessor === "modify") {
      return null;
    }
    const { context, isStatic, constraints } = memberContext(signature, withConstrainedExtensions);
    return { context, method: { address, name: signature.name, mangled: name, isStatic, signature, constraints }, accessor: null };
  }
  if (initsOnly) {
    return null;
  }
  const { context, isStatic, constraints } = memberContext(signature, withConstrainedExtensions);
  return {
    context,
    method: null,
    accessor: { address, member: signature.member, kind: signature.kind, type: signature.type, typeName: signature.typeName, isStatic, constraints },
  };
}

function addMember(members: TypeMembers, parsed: ParsedMember): void {
  if (parsed.method !== null) {
    members.methods.push(parsed.method);
  } else if (parsed.accessor !== null) {
    members.accessors.push(parsed.accessor);
  }
}

// A constrained protocol extension's members demangle under `P< where A: Q, A.T == U>`; unless
// those are wanted, the member is kept out by a context no type is named as.
function memberContext(
  signature: ParsedSwiftSignature,
  withConstrainedExtensions: boolean
): { context: string; isStatic: boolean; constraints: string[] } {
  const receiver = stripReceiverKeyword(signature.context);
  const constraints = signature.contextConstraints;
  if (constraints.length > 0 && !withConstrainedExtensions) {
    return { context: `${receiver.context}< where ${constraints.join(", ")}>`, isStatic: receiver.isStatic, constraints: [] };
  }
  return { ...receiver, constraints };
}

export type TypeScope = "thisType" | "withSuperclasses";

function memberSource(modules: ModuleScope): MemberSource {
  return modules === "definingModule" ? definingModuleMembers : allLoadedModuleMembers;
}

export function enumerateMethods(
  typeName: string,
  modules: ModuleScope = "allLoadedModules",
  types: TypeScope = "withSuperclasses"
): MethodInfo[] {
  const members = memberSource(modules);
  const seen = new Set<string>();
  const methods: MethodInfo[] = [];
  const fullName = canonicalTypeName(typeName);
  const add = (c: MethodCandidate): void => {
    const key = `${c.isStatic ? "s" : "i"}:${c.signature.selector}:${c.signature.argTypeNames.join(",")}->${c.signature.returnTypeName}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    methods.push({
      name: c.name,
      kind: c.signature.accessor === undefined ? methodKind(c.name) : "subscript",
      isStatic: c.isStatic,
      address: c.address,
      argTypeNames: c.signature.argTypeNames,
      argLabels: c.signature.argLabels,
      returnTypeName: c.signature.returnTypeName,
      selector: c.signature.selector,
      genericParams: c.signature.genericParams,
      throws: c.signature.throws,
      mangled: c.mangled,
    });
  };
  for (const className of types === "withSuperclasses" ? classChainNames(fullName) : [fullName]) {
    members(className).methods.forEach(add);
  }
  if (modules === "allLoadedModules" && types === "withSuperclasses") {
    for (const conformance of conformanceMembers(fullName)) {
      conformance.members.methods.filter(isConformanceMethod).forEach(add);
    }
  }
  return methods;
}

export interface PropertyInfo {
  name: string;
  typeName: string;
  isStatic: boolean;
  writable: boolean;
}

// One entry per property, its accessors merged. writable tracks an exported setter, the only
// accessor $set resolves (a get/_modify property still gets a synthesized one). Walks the class
// chain like enumerateMethods so a subclass property shadows the superclass one of the same name.
export function enumerateProperties(
  typeName: string,
  modules: ModuleScope = "allLoadedModules"
): PropertyInfo[] {
  const members = memberSource(modules);
  const seen = new Set<string>();
  const properties: PropertyInfo[] = [];
  const fullName = canonicalTypeName(typeName);
  const levels = classChainNames(fullName).map((className) => members(className).accessors);
  if (modules === "allLoadedModules") {
    levels.push(conformanceMembers(fullName).flatMap((c) => c.members.accessors));
  }
  for (const accessors of levels) {
    const atThisLevel = new Map<string, PropertyInfo>();
    for (const a of accessors) {
      const key = `${a.isStatic ? "s" : "i"}:${a.member}`;
      if (seen.has(key)) {
        continue;
      }
      let info = atThisLevel.get(key);
      if (info === undefined) {
        info = { name: a.member, typeName: a.typeName, isStatic: a.isStatic, writable: false };
        atThisLevel.set(key, info);
        properties.push(info);
      }
      if (a.kind === "setter") {
        info.writable = true;
      }
    }
    for (const key of atThisLevel.keys()) {
      seen.add(key);
    }
  }
  return properties;
}

export function resolveMethod(
  typeName: string,
  methodName: string,
  options: RawMethodResolveOptions = {}
): ResolvedMethod {
  const resolved = findMethod(typeName, methodName, options);
  if (resolved === null) {
    throw noMethodError(canonicalTypeName(typeName), methodName);
  }
  return resolved;
}

function noMethodError(fullName: string, methodName: string): Error {
  const maxDistance = Math.max(1, Math.floor(methodName.length / 3));
  let suggestion: string | null = null;
  let best = maxDistance + 1;
  for (const name of new Set(enumerateMethods(fullName).map((m) => m.name))) {
    const distance = editDistance(methodName, name);
    if (distance > 0 && distance < best) {
      best = distance;
      suggestion = name;
    }
  }
  const hint = suggestion === null ? "" : ` (did you mean ${suggestion}?)`;
  return new Error(`no method ${methodName} on ${fullName}${hint}`);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

export function findMethod(
  typeName: string,
  methodName: string,
  options: RawMethodResolveOptions = {}
): ResolvedMethod | null {
  const fullName = canonicalTypeName(typeName);
  return (
    resolveMethodIn(fullName, methodName, options, definingModuleMembers) ??
    resolveMethodIn(fullName, methodName, options, allLoadedModuleMembers)
  );
}

export interface FoundMember {
  address: NativePointer;
  selector: string;
  generic: boolean;
  isStatic: boolean;
  async: boolean;
  origin: MemberOrigin;
  signature: SwiftFunctionSignature;
}

// Finds a member by name and overload filters alone. No type is resolved, so unlike findMethod it
// also finds generic members and members whose types mention the receiver's type parameters.
export function findMember(
  typeName: string,
  methodName: string,
  options: RawMethodResolveOptions = {}
): FoundMember | null {
  const fullName = canonicalTypeName(typeName);
  const candidates = matchingMethods(fullName, options, (c) => c.name === methodName);
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length > 1) {
    throw new Error(
      `ambiguous method ${methodName} on ${fullName}: ${describeOverloads(candidates)} (disambiguate with { arity }, { labels }, { argTypes }, or { returnType })`
    );
  }
  const { signature, isStatic } = candidates[0];
  const address = candidates[0].address.strip();
  return {
    address,
    selector: signature.selector,
    generic: signature.genericParams.length > 0,
    isStatic,
    async: signature.async,
    origin: memberOrigin(address, fullName),
    signature,
  };
}

function resolveMethodIn(
  fullName: string,
  methodName: string,
  options: RawMethodResolveOptions,
  members: MemberSource
): ResolvedMethod | null {
  for (const className of classChainNames(fullName)) {
    const candidates = applyOverloadFilters(
      members(className).methods.filter(
        (c) => c.name === methodName && c.signature.genericParams.length === 0
      ),
      options
    );
    if (candidates.length === 0) {
      continue;
    }
    if (candidates.length > 1) {
      const overloads = describeOverloads(candidates);
      throw new Error(
        `ambiguous method ${methodName} on ${className}: ${overloads} (disambiguate with { arity }, { labels }, { argTypes }, or { returnType })`
      );
    }

    const { isStatic, signature, mangled } = candidates[0];
    const params = splitParams(signature.params);
    const address = candidates[0].address.strip();
    const { argTypes, returnType, thrown } = signatureMetadata(signature);
    let asyncFunctionPointer: AsyncFunctionPointer | undefined;
    if (signature.async) {
      const module = Process.findModuleByAddress(address.strip());
      const afp = module === null ? null : findAsyncFunctionPointer(module, mangled);
      if (afp === null) {
        throw new Error(`cannot resolve async function pointer for ${signature.selector}`);
      }
      asyncFunctionPointer = afp;
    }
    const origin = memberOrigin(address, className);
    return setterShape({ address, argTypes, returnType, throws: signature.throws, thrown, isStatic, selector: signature.selector, signature, async: signature.async, asyncFunctionPointer, argConventions: params.conventions, origin });
  }
  return null;
}

// A subscript setter stores the element it is handed, +1, ahead of the indices and returns nothing.
function setterShape(resolved: ResolvedMethod): ResolvedMethod {
  if (resolved.signature?.accessor !== "setter") {
    return resolved;
  }
  return {
    ...resolved,
    argTypes: [resolved.returnType!, ...resolved.argTypes],
    returnType: null,
    argConventions: ["owned", ...(resolved.argConventions ?? resolved.argTypes.map(() => "borrowed" as const))],
  };
}

function setterPlan(plan: CallPlan): CallPlan {
  if (plan.signature?.accessor !== "setter") {
    return plan;
  }
  return { ...plan, argPlans: [plan.returnPlan!, ...plan.argPlans], returnPlan: null, argConventions: ["owned", ...plan.argConventions] };
}

function passedByAddress(resolved: ResolvedMethod, i: number): boolean {
  return resolved.abstractArgs?.[i] === true || resolved.argConventions?.[i] === "inout";
}

// witness_method CC: Self metadata + witness table trail the formal args; defaults depend on them.
function witnessSelfArgs(
  table: WitnessTable | undefined,
  witnessTables?: NativePointer[]
): { typeArguments?: Metadata[]; witnessTables?: NativePointer[] } {
  return table === undefined
    ? {}
    : { typeArguments: [table.conformingType], witnessTables: witnessTables ?? [table.handle] };
}

function planOf(resolved: ResolvedMethod): CallPlan {
  const { returnType, thrown } = resolved;
  const implicit = witnessSelfArgs(resolved.witnessSelf, resolved.witnessTables);
  if (thrown !== undefined && resolved.witnessSelf !== undefined && !thrownRidesResultRegisters(thrown, returnType, resolved.abstractReturn === true)) {
    throw new Error(`${resolved.selector}: a typed throw returned through a buffer is unsupported through a protocol witness`);
  }
  return {
    address: resolved.address,
    selector: resolved.selector,
    argPlans: resolved.argTypes.map((metadata, i) =>
      passedByAddress(resolved, i) ? { kind: "abstractIndirect", metadata } : { kind: "concrete", metadata }
    ),
    returnPlan:
      returnType === null
        ? null
        : Array.isArray(resolved.abstractReturn)
          ? { kind: "destructuredTuple", metadata: returnType, byAddress: resolved.abstractReturn }
          : resolved.abstractReturn === true
            ? { kind: "abstractIndirect", metadata: returnType }
            : { kind: "concrete", metadata: returnType },
    throws: resolved.throws,
    thrown,
    async: resolved.async === true,
    asyncFunctionPointer: resolved.asyncFunctionPointer,
    typeArguments: implicit.typeArguments ?? [],
    witnessTables: implicit.witnessTables ?? [],
    argConventions: resolved.argConventions ?? resolved.argTypes.map(() => "borrowed"),
    origin: resolved.origin,
    signature: resolved.signature,
    witnessDispatched: resolved.witnessSelf !== undefined,
  };
}

// The buffer for a typed error trails the witness-method's own Self arguments, which the plan's
// implicit arguments cannot express; the register form needs no buffer.
function thrownRidesResultRegisters(thrown: ThrownType, returnType: Metadata | null, returnIsAbstract: boolean): boolean {
  const returnDirect = returnType === null || (!returnIsAbstract && !shouldPassIndirectly(returnType));
  return !thrown.abstract && returnDirect && typedErrorReturnsDirectly(thrown.metadata);
}

function argPlanKey(plan: ArgPlan): string {
  switch (plan.kind) {
    case "closure":
      return "c";
    case "generic":
      return `g${plan.index}`;
    case "concrete":
      return plan.metadata.handle.toString();
    case "abstractIndirect":
      return `@${plan.metadata.handle}`;
    case "destructuredTuple":
      return `(${plan.metadata.handle}:${plan.byAddress.map(Number).join("")})`;
  }
}

function makeInvoker(plan: CallPlan, hasSelf: boolean, trailingSelf: Metadata | null): SwiftNativeFunction {
  const argTypes = plan.argPlans.map(swiftArgType);
  if (trailingSelf !== null) {
    argTypes.push(trailingSelf);
  }
  return makeSwiftNativeFunction(plan.address, plan.returnPlan === null ? null : swiftArgType(plan.returnPlan), argTypes, {
    hasSelf,
    throws: plan.throws,
    errorType: plan.thrown === undefined ? undefined : plan.thrown.abstract ? indirect(plan.thrown.metadata) : plan.thrown.metadata,
    typeArguments: plan.typeArguments,
    witnessTables: plan.witnessTables,
  });
}

// Trampolines are pooled per distinct lowering, whichever route planned the call: the key is the
// lowering, not the address, so an index invocation never reuses a symbol-route invoker built for
// other types. A trampoline's save and result buffers are its own, so a call nested inside one in
// flight (a closure body calling the method that runs it) takes another; idle ones are reused.
function withInvoker<T>(plan: CallPlan, hasSelf: boolean, trailingSelf: Metadata | null, use: (fn: SwiftNativeFunction) => T): T {
  const key = [
    plan.address,
    hasSelf ? "s" : "",
    trailingSelf?.handle ?? "",
    plan.argPlans.map(argPlanKey).join(","),
    plan.returnPlan === null ? "v" : argPlanKey(plan.returnPlan),
    plan.throws ? "t" : "n",
    plan.thrown === undefined ? "" : `${plan.thrown.abstract ? "@" : ""}${plan.thrown.metadata.handle}`,
    plan.typeArguments.map((m) => m.handle).join(","),
    plan.witnessTables.join(","),
  ].join("|");
  let idle = idleInvokers.get(key);
  if (idle === undefined) {
    idle = [];
    idleInvokers.set(key, idle);
  }
  const fn = idle.pop() ?? makeInvoker(plan, hasSelf, trailingSelf);
  try {
    return use(fn);
  } finally {
    idle.push(fn);
  }
}

// A generic or abstract return is @out even when its concrete type would ride registers.
function resultShapeOf(plan: CallPlan): AsyncResultShape | null {
  if (plan.returnPlan === null) {
    return null;
  }
  const metadata = planMetadata(plan.returnPlan);
  if (plan.returnPlan.kind === "generic" || plan.returnPlan.kind === "abstractIndirect") {
    return metadata.valueWitnesses.size === 0 ? null : { kind: "indirect", stride: metadata.valueWitnesses.stride };
  }
  return asyncResultShape(metadata);
}

export interface Binding {
  self?: NativePointer | null;
  routing?: SelfRouting;
  consumedSelf?: Metadata | null; // a consuming method takes a +1 copy, so the caller's value survives
  executor?: SerialExecutorRef | null;
  adoptResult?: boolean; // an initializer's +1 result is adopted as an owned value, Optional<Self> if failable
}

export function bindResolved(resolved: ResolvedMethod, self: NativePointer | null, binding: Omit<Binding, "self"> = {}): BoundMethod {
  return new BoundMethod(planOf(resolved), { ...binding, self });
}

// A planned call bound to its receiver. Self rides in x20 (indirect), trails the formal args as a
// loadable value, or both when the symbol doesn't say which the callee reads; type metadata and
// witness tables trail everything. A sync call goes through a cached trampoline, an async one
// through callAsync with the same lowering, its borrowed temps destroyed on settle.
export class BoundMethod {
  readonly address: NativePointer;
  readonly selector: string;
  readonly origin: MemberOrigin | undefined;
  receiverKeepalive: unknown = null;
  private readonly self: NativePointer | null;
  private readonly routing: SelfRouting;
  private readonly consumedSelf: Metadata | null;
  private readonly executor: SerialExecutorRef | null;
  private readonly adoptResult: boolean;
  private readonly hasSelf: boolean;
  private readonly trailingSelf: Metadata | null;
  private readonly result: AsyncResultShape | null;

  constructor(readonly plan: CallPlan, binding: Binding = {}) {
    this.address = plan.address;
    this.selector = plan.selector;
    this.origin = plan.origin;
    this.self = binding.self ?? null;
    this.routing = binding.routing ?? { indirect: true };
    this.consumedSelf = binding.consumedSelf ?? null;
    this.executor = binding.executor ?? null;
    this.adoptResult = binding.adoptResult === true;
    this.hasSelf = this.self !== null && this.selfInRegister();
    this.trailingSelf = this.self !== null && !this.routing.indirect ? this.routing.receiver : null;
    if (plan.async) {
      if (plan.asyncFunctionPointer === undefined) {
        throw new Error(`${plan.selector} is not async`);
      }
      if (plan.returnPlan?.kind === "destructuredTuple") {
        throw new Error(`${plan.selector}: an async tuple result with an opaque element is unsupported`);
      }
      this.result = resultShapeOf(plan);
    } else {
      withInvoker(plan, this.hasSelf, this.trailingSelf, () => undefined); // lowering errors surface at bind
      this.result = null;
    }
  }

  get isAsync(): boolean {
    return this.plan.async;
  }

  get signature(): SwiftBoundSignature {
    const { plan } = this;
    if (plan.signature === undefined) {
      throw new Error(`${this.selector} was bound without a signature`);
    }
    const metadataOrNull = (argPlan: ArgPlan | null): Metadata | null => (argPlan === null || argPlan.kind === "closure" ? null : argPlan.metadata);
    const [element, ...indices] = plan.argPlans;
    return plan.signature.accessor === "setter"
      ? boundSignature(plan.signature, indices.map(metadataOrNull), metadataOrNull(element))
      : boundSignature(plan.signature, plan.argPlans.map(metadataOrNull), metadataOrNull(plan.returnPlan));
  }

  get hookTarget(): HookTarget | null {
    const { plan } = this;
    return plan.signature === undefined ? null : { address: plan.address, signature: plan.signature, witnessDispatched: plan.witnessDispatched === true };
  }

  get asyncFunctionPointer(): AsyncFunctionPointer {
    if (this.plan.asyncFunctionPointer === undefined) {
      throw new Error(`${this.selector} is not async`);
    }
    return this.plan.asyncFunctionPointer;
  }

  private selfInRegister(): boolean {
    return this.routing.indirect || this.routing.bothWays === true;
  }

  call(...args: CallArg[]): CallResult | Promise<CallResult> {
    const plans = this.plan.argPlans;
    if (args.length !== plans.length) {
      throw new Error(`${this.selector} expects ${plans.length} argument(s), got ${args.length}`);
    }
    const marshalled = marshalPlannedArgs(this.plan, args);
    const self = this.self !== null && this.consumedSelf !== null ? copyOfValue(this.consumedSelf, this.self) : this.self;
    return this.plan.async
      ? this.invokeAsync(marshalled, self)
      : withInvoker(this.plan, this.hasSelf, this.trailingSelf, (fn) => this.invokeSync(fn, marshalled, self));
  }

  private invokeSync(fn: SwiftNativeFunction, marshalled: PlannedArgs, self: NativePointer | null): CallResult {
    try {
      const ptrs = marshalled.ptrs;
      let ret: NativePointer | null;
      if (self === null) {
        ret = fn(...ptrs);
      } else if (this.routing.indirect) {
        ret = fn(self, ...ptrs);
      } else if (this.routing.bothWays === true) {
        ret = fn(self, ...ptrs, self);
      } else {
        ret = fn(...ptrs, self);
      }
      return this.decode(ret);
    } finally {
      marshalled.destroyBorrowedTemps();
    }
  }

  private decode(ret: NativePointer | null): CallResult {
    const returnType = this.plan.returnPlan === null ? null : planMetadata(this.plan.returnPlan);
    if (!this.adoptResult) {
      return decodeReturn(returnType, ret);
    }
    if (returnType === null || ret === null) {
      throw new Error(`${this.selector} returned no value`);
    }
    if (returnType.kind === MetadataKind.Optional) {
      const some = projectOptionalPayload(returnType, ret);
      return some === null ? null : asSwiftObject(ValueInstance.adopt(some.payloadType, some.address));
    }
    return asSwiftObject(ValueInstance.adopt(returnType, ret));
  }

  private invokeAsync(marshalled: PlannedArgs, self: NativePointer | null): Promise<CallResult> {
    const { plan } = this;
    const { closures } = marshalled;
    const cleanup = (): void => {
      marshalled.destroyBorrowedTemps();
    };
    const lowered = new AsyncArgs(this.result?.kind === "indirect" ? 1 : 0);
    plan.argPlans.forEach((argPlan, i) => {
      const closure = closures[i];
      if (closure !== null) {
        lowered.pushWord(closure.fnPointer);
        lowered.pushWord(closure.context);
      } else if (argPlan.kind === "generic" || argPlan.kind === "abstractIndirect") {
        lowered.pushWord(marshalled.ptrs[i]);
      } else {
        lowered.push(planMetadata(argPlan), marshalled.ptrs[i]);
      }
    });
    const options: AsyncCallOptions = { throws: plan.throws };
    if (this.executor !== null) {
      options.onActor = this.executor;
    }
    if (self !== null) {
      if (this.selfInRegister()) {
        options.receiver = self;
      }
      if (!this.routing.indirect) {
        const stackSize = lowered.stackSize;
        lowered.push(this.routing.receiver, self);
        if (this.routing.bothWays === true && lowered.stackSize !== stackSize) {
          cleanup();
          if (self !== this.self) {
            this.consumedSelf!.valueWitnesses.destroy(self);
          }
          const { selector } = plan;
          throw new Error(
            `${selector} on ${typeName(this.routing.receiver)}: a trailing self past the async argument registers ` +
              `is only safe if the method takes it; call it as $method("${selector}", { self: "borrowing" }).call(...), ` +
              `or { self: "mutating" } if it mutates`
          );
        }
      }
    }
    for (const metadata of plan.typeArguments) {
      lowered.pushWord(metadata.handle);
    }
    for (const witnessTable of plan.witnessTables) {
      lowered.pushWord(witnessTable);
    }
    if (plan.thrown !== undefined) {
      const { metadata } = plan.thrown;
      if (thrownRidesResultRegisters(plan.thrown, this.result === null ? null : planMetadata(plan.returnPlan!), this.result?.kind === "indirect")) {
        const resultScalars = this.result?.kind === "scalars" ? loweredScalars(planMetadata(plan.returnPlan!)) : [];
        options.result = { kind: "scalars", placed: this.result?.kind === "scalars" ? this.result.placed : [], stride: this.result?.kind === "scalars" ? this.result.stride : 0 };
        options.typedError = { type: metadata, placed: placeTypedErrorScalars(resultScalars, metadata, true) };
      } else {
        const slot = Memory.alloc(Math.max(metadata.typeLayout.stride, 1));
        lowered.pushWord(slot);
        options.typedError = { type: metadata, slot };
      }
    }
    const { gp, fp } = lowered;
    if (fp.length > 0) {
      options.floatArgs = fp;
    }
    if (lowered.stackSize > 0) {
      options.stackArgs = lowered.stackWords();
    }
    if (this.result !== null && options.result === undefined) {
      options.result = this.result;
    }
    return callAsync(this.asyncFunctionPointer, gp, options).then(
      (ret) => {
        try {
          return this.decode(this.result === null ? null : ret);
        } finally {
          cleanup();
          void self; // the trampoline embeds its address; keep it allocated until settle
          void closures; // Swift invokes them in-flight
        }
      },
      (error) => {
        cleanup();
        throw error;
      }
    );
  }
}

// null ⇒ Void; check indirect before lowering, matching lowerArg (a resilient float aggregate is @out).
function asyncResultShape(returnType: Metadata | null): AsyncResultShape | null {
  if (returnType === null || returnType.valueWitnesses.size === 0) {
    return null;
  }
  if (shouldPassIndirectly(returnType)) {
    return { kind: "indirect", stride: returnType.valueWitnesses.stride };
  }
  return { kind: "scalars", placed: placeAsyncResultScalars(returnType), stride: returnType.valueWitnesses.stride };
}

class AsyncArgs {
  readonly gp: NativePointer[] = [];
  readonly fp: AsyncFloatArg[] = [];
  private readonly stackBytes: { offset: number; bytes: ArrayBuffer }[] = [];
  private readonly allocator: ArgumentAllocator;

  constructor(private readonly gpBase: number) {
    this.allocator = new ArgumentAllocator(gpBase);
  }

  pushWord(word: NativePointer): void {
    const value = Memory.alloc(Process.pointerSize).writePointer(word);
    this.place({ offset: 0, size: Process.pointerSize, cls: "int" }, value);
  }

  push(metadata: Metadata, buffer: NativePointer): void {
    if (metadata.kind === MetadataKind.Class) {
      this.pushWord(buffer.readPointer());
    } else if (shouldPassIndirectly(metadata)) {
      this.pushWord(buffer);
    } else {
      for (const scalar of loweredScalars(metadata)) {
        this.place(scalar, buffer);
      }
    }
  }

  get stackSize(): number {
    return this.allocator.stackSize;
  }

  stackWords(): NativePointer[] {
    const image = Memory.alloc(Math.max(this.stackSize, 1));
    const words = Math.ceil(this.stackSize / 8);
    for (let i = 0; i < words; i++) {
      image.add(i * 8).writeU64(0);
    }
    for (const { offset, bytes } of this.stackBytes) {
      image.add(offset).writeByteArray(bytes);
    }
    return Array.from({ length: words }, (_, i) => image.add(i * 8).readPointer());
  }

  private place(scalar: LoweredScalar, value: NativePointer): void {
    const location = this.allocator.scalar(scalar);
    if ("stackOffset" in location) {
      this.stackBytes.push({ offset: location.stackOffset, bytes: value.add(scalar.offset).readByteArray(scalar.size)! });
      return;
    }
    const bytes = value.add(scalar.offset);
    if (location.register === "fp") {
      this.fp.push({ bytes, cls: scalar.cls as FloatClass });
      return;
    }
    for (let w = 0; w < scalar.size; w += 8) {
      const word = Memory.alloc(8).writeU64(0);
      Memory.copy(word, bytes.add(w), Math.min(scalar.size - w, 8));
      while (this.gp.length < location.index - this.gpBase + w / 8) {
        this.gp.push(NULL);
      }
      this.gp.push(word.readPointer());
    }
  }
}

// The settle reactions root the binder, so a keepalive stored here keeps the receiver's owning
// instance reachable for the whole flight — its GC release would free the object while a job
// referencing it sits queued on an executor thread.
export function rootAsyncReceiver<T>(binder: T, receiver: unknown): T {
  if (binder instanceof BoundMethod && binder.isAsync) {
    binder.receiverKeepalive = receiver;
  }
  return binder;
}

// A Swift facade's $handle, an ObjC.Object's handle, or a raw swiftself pointer.
export type AsyncReceiver = NativePointer | { $handle: NativePointer } | { handle: NativePointer };

function toReceiverPointer(receiver: AsyncReceiver): NativePointer {
  if (receiver instanceof NativePointer) {
    return receiver;
  }
  const handle = (receiver as { $handle?: unknown }).$handle ?? (receiver as { handle?: unknown }).handle;
  if (handle instanceof NativePointer) {
    return handle;
  }
  throw new Error("receiver must be a Swift object, an ObjC.Object, or a NativePointer");
}

const MODULE_CONTEXT = /^[^.\s]+$/;

interface FunctionReceiver {
  instanceType: Metadata | null;
  metatypeSelf: NativePointer | null;
}

function isClassType(type: Metadata): boolean {
  return type.kind === MetadataKind.Class || type.kind === MetadataKind.ObjCClassWrapper;
}

// A static method's self is its metatype: thick (the metadata) for a class, thin (erased) otherwise.
function resolveReceiver(signature: SwiftFunctionSignature): FunctionReceiver {
  const { context, isStatic } = stripReceiverKeyword(signature.context);
  if (MODULE_CONTEXT.test(context)) {
    return { instanceType: null, metatypeSelf: null };
  }
  const type = resolveType(context);
  if (type === null) {
    if (findType(context)?.isGeneric === true) {
      throw new Error(
        `${signature.selector} is a member of generic type ${context}; generic functions are not supported here`
      );
    }
    throw new Error(`${signature.selector}: cannot resolve receiver type ${context}`);
  }
  if (!isStatic) {
    return { instanceType: type, metatypeSelf: null };
  }
  return { instanceType: null, metatypeSelf: isClassType(type) ? type.handle : null };
}

// Swift.NativeFunction resolved from a symbol: call() for a free function, bind(self) for a method.
// An async symbol's calls return a Promise, as method calls do. Generic like NativeFunction<Ret, Args>:
// the caller annotates the marshalled return and argument types so a call site is typed without
// casting; both default to the untyped CallResult/CallArg.
export class SwiftFunction<Ret = CallResult | Promise<CallResult>, Args extends CallArg[] = CallArg[]> {
  constructor(
    private readonly resolved: ResolvedMethod,
    private readonly receiver: FunctionReceiver
  ) {}

  get address(): NativePointer {
    return this.resolved.address;
  }

  call(...args: Args): Ret {
    if (this.receiver.instanceType !== null) {
      throw new Error(`${this.resolved.selector} is an instance method; bind a receiver with .bind(self)`);
    }
    return this.boundTo(this.receiver.metatypeSelf).call(...args) as Ret;
  }

  bind(receiver: AsyncReceiver): (...args: Args) => Ret {
    const { instanceType } = this.receiver;
    if (instanceType === null) {
      throw new Error(`${this.resolved.selector} takes no receiver`);
    }
    if (!isClassType(instanceType)) {
      throw new Error(`receiver binding is only supported for class receivers, not ${typeName(instanceType)}`);
    }
    const self = toReceiverPointer(receiver);
    return (...args: Args) => rootAsyncReceiver(this.boundTo(self), receiver).call(...args) as Ret;
  }

  private boundTo(self: NativePointer | null): BoundMethod {
    return bindResolved(this.resolved, self);
  }
}

export class SwiftAsyncFunction<Ret = CallResult, Args extends CallArg[] = CallArg[]> extends SwiftFunction<
  Promise<Ret>,
  Args
> {}

function parseFunctionSymbol(mangled: string): SwiftFunctionSignature {
  const demangled = demangle(mangled);
  if (demangled === null) {
    throw new Error(`not a Swift symbol: ${mangled}`);
  }
  const signature = parseSwiftSignature(demangled);
  if (signature === null || signature.kind !== "function") {
    throw new Error(`cannot parse a function signature from ${demangled}`);
  }
  return signature;
}

export function resolveFunction<Ret = CallResult | Promise<CallResult>, Args extends CallArg[] = CallArg[]>(
  module: Module,
  mangled: string
): SwiftFunction<Ret, Args> {
  const signature = parseFunctionSymbol(mangled);
  if (signature.genericParams.length > 0) {
    throw new Error(`${signature.selector} is generic; generic functions are not supported here`);
  }
  const resolved = signature.async
    ? resolveAsyncSymbol(module, mangled, signature)
    : resolveSyncSymbol(module, mangled, signature);
  return new SwiftFunction<Ret, Args>(resolved, resolveReceiver(signature));
}

export function resolveAsyncFunction<Ret = CallResult, Args extends CallArg[] = CallArg[]>(
  module: Module,
  mangled: string
): SwiftAsyncFunction<Ret, Args> {
  const signature = parseFunctionSymbol(mangled);
  if (!signature.async) {
    throw new Error(`${signature.selector} is not async; use Swift.function`);
  }
  if (signature.genericParams.length > 0) {
    throw new Error(`${signature.selector} is generic; async generics are not supported here`);
  }
  return new SwiftAsyncFunction<Ret, Args>(
    resolveAsyncSymbol(module, mangled, signature),
    resolveReceiver(signature)
  );
}

function resolveSyncSymbol(module: Module, mangled: string, signature: SwiftFunctionSignature): ResolvedMethod {
  const address = module.findExportByName(mangled) ?? module.findSymbolByName(mangled);
  if (address === null) {
    throw new Error(`no symbol ${mangled} in ${module.name}`);
  }
  return {
    address: address.strip(),
    ...resolveSignatureTypes(signature),
    throws: signature.throws,
    isStatic: false,
    selector: signature.selector,
    signature,
    async: false,
  };
}

function resolveAsyncSymbol(module: Module, mangled: string, signature: SwiftFunctionSignature): ResolvedMethod {
  const afp = findAsyncFunctionPointer(module, mangled);
  if (afp === null) {
    throw new Error(`no async function pointer for ${mangled} in ${module.name}`);
  }
  return {
    address: afp.code,
    ...resolveSignatureTypes(signature),
    throws: signature.throws,
    isStatic: false,
    selector: signature.selector,
    signature,
    async: true,
    asyncFunctionPointer: afp,
  };
}

function resolveSignatureTypes(
  signature: SwiftFunctionSignature
): { argTypes: Metadata[]; returnType: Metadata | null; thrown?: ThrownType; argConventions: ParamConvention[] } {
  if (methodKind(signature.name) === "init") {
    throw new Error(
      `${signature.selector} is an initializer, which consumes its arguments; construct through Swift.type(...).init`
    );
  }
  const params = splitParams(signature.params);
  const { argTypes, returnType, thrown } = signatureMetadata(signature);
  return { argTypes, returnType, thrown, argConventions: params.conventions };
}

// Thin metatype: no self passed.
export function bindStaticMethod(
  receiver: Metadata,
  name: string,
  options: RawMethodResolveOptions = {}
): BoundMethod {
  const staticOptions = { ...options, static: true };
  const resolved = findMethod(typeName(receiver), name, staticOptions);
  if (resolved === null) {
    return bindConformanceMethod(typeName(receiver), receiver.handle, name, staticOptions);
  }
  return bindResolved(resolved, null);
}

// A value-type initializer is self-less: the @thin metatype self is erased, so it lowers like a
// static factory returning the type, adopted as an owned value. Init params are +1/consumed: the
// callee owns the arg temps. Mirrors ClassType.init.
export function bindValueInitializer(
  receiver: Metadata,
  options: RawMethodResolveOptions = {}
): SwiftBoundInitializer {
  if (options.typeArguments !== undefined) {
    const plan = planGenericMethod(typeName(receiver), "init", options);
    const argConventions = plan.argPlans.map((_, i): ParamConvention => (plan.argConventions?.[i] === "inout" ? "inout" : "owned"));
    const bound = new BoundMethod({ ...plan, argConventions }, { adoptResult: true });
    return { address: bound.address, call: (...args) => bound.call(...args) as SwiftValueObject | null };
  }
  const resolved = resolveMethod(typeName(receiver), "init", options);
  if (resolved.returnType === null) {
    throw new Error(`${resolved.selector} is not a value initializer`);
  }
  const argConventions = resolved.argTypes.map((_, i): ParamConvention => (resolved.argConventions?.[i] === "inout" ? "inout" : "owned"));
  const bound = bindResolved({ ...resolved, argConventions }, null, { adoptResult: true });
  return { address: bound.address, call: (...args) => bound.call(...args) as SwiftValueObject | null };
}

export type SelfRouting = { indirect: true } | { indirect: false; receiver: Metadata; bothWays?: boolean };

// Value-type self is indirect (x20) when mutating/inout or large/non-POD; else it rides as a trailing
// arg. Only a small loadable receiver's routing depends on `mutating`, which isn't recoverable from the
// symbol. Plain calls pass self both ways (bindValueMethod); generic ones can't, since a
// trailing self shifts the metadata args, so there it's probed from the callee or stated by the caller.
function valueSelfRouting(receiver: Metadata, selector: string, ownership: SelfOwnership | undefined): SelfRouting {
  if (shouldPassIndirectly(receiver)) {
    return { indirect: true };
  }
  if (ownership === undefined) {
    throw new Error(
      `${selector} on small loadable ${typeName(receiver)}: self routing depends on whether it mutates; ` +
        `call it as $method("${selector}", { self: "borrowing" }).call(...), or { self: "mutating" } if it mutates`
    );
  }
  return ownership === "mutating" ? { indirect: true } : { indirect: false, receiver };
}

// A consuming method takes ownership of self, so it gets a +1 copy and the caller's value survives.
function copyOfValue(type: Metadata, value: NativePointer): NativePointer {
  const copy = Memory.alloc(type.typeLayout.stride);
  type.valueWitnesses.initializeWithCopy(copy, value);
  return copy;
}

function consumedSelf(receiver: Metadata, options: RawValueMethodResolveOptions): Metadata | null {
  return options.self === "consuming" ? receiver : null;
}

// A small loadable self rides as trailing args if the method doesn't mutate, or by address in x20 if
// it does, and the symbol doesn't say which. A sync call passes it both ways: each callee reads only
// its own, and the other is an unused arg or a callee-saved register. An async callee pops its own
// stack args, so a guessed trailing self must fit in registers.
export function bindValueMethod(
  receiver: Metadata,
  self: NativePointer,
  name: string,
  options: RawValueMethodResolveOptions = {}
): BoundMethod {
  const resolved = findMethod(typeName(receiver), name, options);
  if (resolved === null) {
    return bindConformanceMethod(typeName(receiver), self, name, options);
  }
  let routing: SelfRouting;
  if (resolved.async !== true) {
    routing = shouldPassIndirectly(receiver) ? { indirect: true } : { indirect: false, receiver, bothWays: true };
  } else {
    routing = valueSelfRouting(receiver, resolved.selector, options.self ?? "borrowing");
    if (!routing.indirect && options.self === undefined) {
      routing.bothWays = true;
    }
  }
  return bindResolved(resolved, self, { routing, consumedSelf: consumedSelf(receiver, options) });
}

// buffer: (UnsafeRawBufferPointer) -> @out, via an asm trampoline. loadable: register params and
// result. loadableIndirect: register params, @out result (e.g. (Int) -> R).
type ClosureShape =
  | { mode: "buffer" }
  | { mode: "loadable"; params: LoadableScalar[]; result: LoadableScalar | null; throws: boolean }
  | { mode: "loadableIndirect"; params: LoadableScalar[]; resultMetadata: Metadata; throws: boolean };

export type ArgPlan =
  | { kind: "generic"; index: number; metadata: Metadata }
  | { kind: "concrete"; metadata: Metadata }
  | { kind: "abstractIndirect"; metadata: Metadata }
  | { kind: "destructuredTuple"; metadata: Metadata; byAddress: boolean[] }
  | { kind: "closure"; discriminator: number; shape: ClosureShape };

const RAW_BUFFER_PARAM = "Swift.UnsafeRawBufferPointer";
const RAW_BUFFER_TOKEN = "$sSW"; // $s mangling of UnsafeRawBufferPointer

interface LoadableScalar {
  token: string; // $s mangling feeding the pointer-auth discriminator
  nativeType: NativeCallbackArgumentType;
  decode?: (raw: NativeCallbackArgumentValue) => unknown; // set only by non-scalar wire shapes (String)
  encode?: (value: unknown) => NativeCallbackReturnValue;
}

const STRING_WORDS: NativeCallbackArgumentType = ["pointer", "pointer"];

function decodeString(raw: NativeCallbackArgumentValue): string {
  const words = raw as NativePointer[];
  const buffer = Memory.alloc(Process.pointerSize * 2);
  buffer.writePointer(words[0]);
  buffer.add(Process.pointerSize).writePointer(words[1]);
  return readString(buffer) ?? "";
}

// createString's +1 rides the words to Swift, which owns the closure result.
function encodeString(value: unknown): NativePointer[] {
  const s = createString(value as string);
  return [s.readPointer(), s.add(Process.pointerSize).readPointer()];
}

// $s manglings feeding the discriminator (verified against the fixture's blraa); Frida type marshals.
// A class-bound result is returned +1, so the reference handed back is retained.
const CLASS_REFERENCE_RESULT: LoadableScalar = {
  token: "-class",
  nativeType: "pointer",
  encode: (value) => {
    const arg = rawArg(value as CallArg);
    const reference = arg instanceof ClassInstance ? arg.handle : (arg as NativePointer);
    return getSwiftCoreApi().swift_unknownObjectRetain(reference);
  },
};

const LOADABLE_SCALARS: Record<string, LoadableScalar> = {
  "Swift.Int": { token: "$sSi", nativeType: "int64" },
  "Swift.UInt": { token: "$sSu", nativeType: "uint64" },
  "Swift.Bool": { token: "$sSb", nativeType: "bool" },
  "Swift.Double": { token: "$sSd", nativeType: "double" },
  "Swift.Float": { token: "$sSf", nativeType: "float" },
  "Swift.Int8": { token: "$ss4Int8V", nativeType: "int8" },
  "Swift.Int16": { token: "$ss5Int16V", nativeType: "int16" },
  "Swift.Int32": { token: "$ss5Int32V", nativeType: "int32" },
  "Swift.Int64": { token: "$ss5Int64V", nativeType: "int64" },
  "Swift.UInt8": { token: "$ss5UInt8V", nativeType: "uint8" },
  "Swift.UInt16": { token: "$ss6UInt16V", nativeType: "uint16" },
  "Swift.UInt32": { token: "$ss6UInt32V", nativeType: "uint32" },
  "Swift.UInt64": { token: "$ss6UInt64V", nativeType: "uint64" },
  "Swift.UnsafeRawPointer": { token: "$sSV", nativeType: "pointer" },
  "Swift.UnsafeMutableRawPointer": { token: "$sSv", nativeType: "pointer" },
  "Swift.String": { token: "$sSS", nativeType: STRING_WORDS, decode: decodeString, encode: encodeString },
};

function closurePlan(paramTokens: string[], resultTokens: string[], shape: ClosureShape): ArgPlan {
  return {
    kind: "closure",
    discriminator: closureDiscriminator(closureHashString(paramTokens, resultTokens)),
    shape,
  };
}

function planClosureType(
  spelling: Extract<TypeExpr, { kind: "function" }>,
  genericParams: string[],
  typeArguments: Metadata[],
  classBoundParams: Set<string>
): ArgPlan {
  if (spelling.params.some((p) => p.convention !== "borrowed")) {
    throw new Error(`unsupported closure type ${spelling.text}: parameter conventions are unsupported`);
  }
  const params = spelling.params.map((p) => p.type.text);
  const result = spelling.result.text;
  const resultIsReference = classBoundParams.has(result);
  const resultIsGeneric = genericParams.includes(result) && !resultIsReference;
  const resultIsVoid = result === "()" || result === "Swift.Void";
  const takesBuffer = params.length === 1 && params[0] === RAW_BUFFER_PARAM;
  if ((params.length === 0 || takesBuffer) && (resultIsVoid || resultIsGeneric)) {
    const paramTokens = takesBuffer ? [RAW_BUFFER_TOKEN] : [];
    const resultTokens = resultIsGeneric ? [INDIRECT] : [];
    return closurePlan(paramTokens, resultTokens, { mode: "buffer" });
  }

  const loadable = params.map((p) => LOADABLE_SCALARS[p] ?? null);
  if (loadable.every((p) => p !== null)) {
    const scalars = loadable as LoadableScalar[];
    const paramTokens = scalars.map((p) => p.token);
    if (resultIsGeneric) {
      const resultMetadata = typeArguments[genericParams.indexOf(result)];
      if (resultMetadata === undefined) {
        throw new Error(`missing type argument for closure result ${result}`);
      }
      return closurePlan(paramTokens, [INDIRECT], {
        mode: "loadableIndirect",
        params: scalars,
        resultMetadata,
        throws: spelling.throws,
      });
    }
    const resultScalar = resultIsVoid ? null : resultIsReference ? CLASS_REFERENCE_RESULT : LOADABLE_SCALARS[result] ?? null;
    if (resultIsVoid || resultScalar !== null) {
      return closurePlan(paramTokens, resultScalar === null ? [] : [resultScalar.token], {
        mode: "loadable",
        params: scalars,
        result: resultScalar,
        throws: spelling.throws,
      });
    }
  }

  throw new Error(
    `unsupported closure type (${params.join(", ")}) -> ${result}; supported: () or (${RAW_BUFFER_PARAM}) returning Void or a generic, or loadable scalars (${Object.keys(LOADABLE_SCALARS).join(", ")}) returning a scalar, Void, or a generic`
  );
}

// A class-bound generic parameter lowers as a bare reference, not address-only.
function planGenericType(
  type: TypeExpr,
  genericParams: string[],
  typeArguments: Metadata[],
  classBoundParams: Set<string>
): ArgPlan {
  if (type.kind === "function") {
    return planClosureType(type, genericParams, typeArguments, classBoundParams);
  }
  const index = type.kind === "param" ? genericParams.indexOf(type.name) : -1;
  if (index !== -1) {
    const metadata = typeArguments[index];
    if (metadata === undefined) {
      throw new Error(`missing type argument for generic parameter ${type.text}`);
    }
    return classBoundParams.has(type.text) ? { kind: "concrete", metadata } : { kind: "generic", index, metadata };
  }
  const concrete = resolveType(type.text);
  if (concrete !== null) {
    return { kind: "concrete", metadata: concrete };
  }
  return planCompoundType(type, genericParams, typeArguments, classBoundParams);
}

function planCompoundType(
  type: TypeExpr,
  genericParams: string[],
  typeArguments: Metadata[],
  classBoundParams: Set<string>
): ArgPlan {
  const metadata = resolveParsedType(type, (name) => {
    const i = genericParams.indexOf(name);
    return i === -1 ? null : typeArguments[i] ?? null;
  });
  if (metadata === null) {
    throw new Error(`cannot resolve generic signature type ${type.text}`);
  }
  return compoundIsAddressOnly(type, genericParams, classBoundParams)
    ? { kind: "abstractIndirect", metadata }
    : { kind: "concrete", metadata };
}

// Array/Set/Dictionary are a fixed-layout buffer (direct); Optional<param> embeds the abstract param
// (indirect) unless the param is class-bound, which makes it a nullable reference.
function compoundIsAddressOnly(type: TypeExpr, genericParams: string[], classBoundParams: Set<string>): boolean {
  if (type.kind === "variadic") {
    return false;
  }
  if (type.kind === "optional") {
    const payload = type.wrapped;
    if (payload.kind === "param" && genericParams.includes(payload.name)) {
      return !classBoundParams.has(payload.name);
    }
    throw new Error(`unsupported compound generic signature type ${type.text} (Optional payload must be a generic parameter)`);
  }
  if (type.kind === "nominal") {
    if (REFERENCE_CONTAINERS.has(type.name)) {
      return false;
    }
    const descriptor = findType(type.name);
    if (descriptor?.kind === ContextDescriptorKind.Class) {
      return false;
    }
    if (descriptor?.isGeneric === true && type.args.length > 0) {
      return (
        !hasFixedLayoutInGenericContext(descriptor) &&
        hasOpaqueLayout(type, (name) => (genericParams.includes(name) && !classBoundParams.has(name) ? "opaque" : null))
      );
    }
  }
  throw new Error(`unsupported compound generic signature type ${type.text} (only [T], [K: V], T? and a nominal type are supported)`);
}

// inout passes the caller's value by address whatever its layout.
function planParam(plan: ArgPlan, convention: ParamConvention, selector: string): ArgPlan {
  if (convention === "borrowed") {
    return plan;
  }
  if (plan.kind === "closure") {
    throw new Error(`${selector}: ${convention} closure parameters are unsupported`);
  }
  return convention === "inout" && plan.kind === "concrete" ? { kind: "abstractIndirect", metadata: plan.metadata } : plan;
}

function swiftArgType(plan: ArgPlan): SwiftArgType {
  switch (plan.kind) {
    case "generic":
      return { genericParam: plan.index };
    case "concrete":
      return plan.metadata;
    case "abstractIndirect":
      return { metadata: plan.metadata, addressOnly: true };
    case "destructuredTuple":
      return { tuple: plan.metadata, byAddress: plan.byAddress };
    case "closure":
      return { closure: true };
  }
}

const MARKER_PROTOCOLS = new Set(["Swift.Sendable", "Swift.SendableMetatype", "Swift.BitwiseCopyable"]);

interface RequirementBound {
  witnessed: ContextDescriptor | null;
  classBound: boolean;
}

// Only a Swift protocol with a descriptor takes a witness table. AnyObject, a superclass and an ObjC
// protocol (imported, or declared @objc in Swift) make the subject a bare reference.
function requirementBound(req: GenericRequirement): RequirementBound {
  const bound = req.protocol;
  if (bound === "AnyObject" || bound === "Swift.AnyObject" || bound.startsWith("__C.")) {
    return { witnessed: null, classBound: true };
  }
  const protocol = findProtocol(bound);
  if (protocol !== null) {
    return { witnessed: protocol, classBound: protocolClassConstraint(protocol) === 0 };
  }
  const superclass = resolveType(bound);
  if ((superclass !== null && isClassType(superclass)) || lookUpObjCProtocol(objCRuntimeName(bound)) !== null) {
    return { witnessed: null, classBound: true };
  }
  if (MARKER_PROTOCOLS.has(bound)) {
    return { witnessed: null, classBound: false };
  }
  throw new Error(`cannot resolve protocol ${bound} for requirement ${req.subject}`);
}

function objCRuntimeName(swiftName: string): string {
  return `_TtP${swiftName.split(".").map((part) => `${part.length}${part}`).join("")}_`;
}

export function witnessTableCount(signature: SwiftFunctionSignature): number {
  return signature.conformanceRequirements.filter((req) => requirementBound(req).witnessed !== null).length;
}

function autoWitnessTables(
  signature: SwiftFunctionSignature,
  typeArguments: Metadata[]
): NativePointer[] {
  const witnessed = signature.conformanceRequirements.flatMap((req) => {
    const protocol = requirementBound(req).witnessed;
    return protocol === null ? [] : [{ req, protocol }];
  });
  return witnessed.map(({ req, protocol }) => {
    const index = signature.genericParams.indexOf(req.subject);
    if (index === -1) {
      throw new Error(`cannot resolve protocol ${req.protocol} for requirement ${req.subject}`);
    }
    const witnessTable = conformsToProtocol(typeArguments[index], protocol);
    if (witnessTable === null) {
      throw new Error(`${typeName(typeArguments[index])} does not conform to ${req.protocol}`);
    }
    return witnessTable;
  });
}

// Everything a call needs besides its receiver: per-arg lowering, the implicit trailing words, and
// the return shape. Each resolution route builds one; BoundMethod runs it.
export interface CallPlan {
  address: NativePointer;
  selector: string;
  argPlans: ArgPlan[];
  returnPlan: ArgPlan | null;
  throws: boolean;
  thrown?: ThrownType;
  async: boolean;
  asyncFunctionPointer?: AsyncFunctionPointer;
  typeArguments: Metadata[];
  witnessTables: NativePointer[];
  argConventions: ParamConvention[];
  origin?: MemberOrigin;
  signature?: SwiftFunctionSignature;
  witnessDispatched?: boolean;
}

interface PlannedArgs {
  ptrs: NativePointer[];
  closures: (SwiftClosure | null)[]; // referenced through the call: Swift invokes them in-flight
  destroyBorrowedTemps(): void;
}

function marshalPlannedArgs(plan: CallPlan, args: CallArg[]): PlannedArgs {
  const plans = plan.argPlans;
  const closures = plans.map((p, i) => (p.kind === "closure" ? marshalClosure(p, args[i]) : null));
  const valueIndices = plans.flatMap((p, i) => (p.kind === "closure" ? [] : [i]));
  const metas = valueIndices.map((i) => planMetadata(plans[i]));
  const conventions = valueIndices.map((i) => plan.argConventions[i]);
  const buffers = marshalArgsOrCleanup(metas, valueIndices.map((i) => args[i]), conventions);
  return {
    ptrs: plans.map((_, i) => closures[i]?.value() ?? buffers[valueIndices.indexOf(i)]),
    closures,
    destroyBorrowedTemps: () => destroyBorrowedTemps(metas, buffers, conventions),
  };
}

function planMetadata(plan: ArgPlan): Metadata {
  if (plan.kind === "closure") {
    throw new Error("closure types are only supported as arguments");
  }
  return plan.metadata;
}

function loadableNativeTypes(params: LoadableScalar[]): NativeCallbackArgumentType[] {
  return params.map((p) => p.nativeType);
}

function decodeArgs(raw: NativeCallbackArgumentValue[], params: LoadableScalar[]): unknown[] {
  return raw.map((value, i) => (params[i].decode ? params[i].decode!(value) : value));
}

function marshalClosure(plan: { discriminator: number; shape: ClosureShape }, arg: CallArg): SwiftClosure {
  if (!(arg instanceof ClosureSpec)) {
    throw new Error("expected a Swift.closure() argument for a function-typed parameter");
  }
  const shape = plan.shape;
  if (shape.mode === "loadable") {
    const userBody = arg.body;
    const encode = shape.result?.encode;
    const body: LoadableClosureBody = (...raw) => {
      const r = userBody(...decodeArgs(raw as NativeCallbackArgumentValue[], shape.params));
      return r instanceof SwiftThrow || encode === undefined ? r : (encode(r) as never);
    };
    return SwiftClosure.loadable(body, loadableNativeTypes(shape.params), shape.result?.nativeType ?? "void", plan.discriminator, {
      throws: shape.throws,
    });
  }
  if (shape.mode === "loadableIndirect") {
    const userBody = arg.body;
    const resultMetadata = shape.resultMetadata;
    return SwiftClosure.loadableProducing(
      (raw, result) => {
        const r = userBody(...decodeArgs(raw as NativeCallbackArgumentValue[], shape.params));
        if (r instanceof SwiftThrow) {
          return r;
        }
        writeValue(resultMetadata, result, r);
      },
      loadableNativeTypes(shape.params),
      plan.discriminator,
      { throws: shape.throws }
    );
  }
  return SwiftClosure.overBytes(arg.body as ClosureBody, plan.discriminator);
}

function inferClosureTypeArguments(signature: SwiftFunctionSignature): Metadata[] {
  const closureResultParams = new Set<string>();
  for (const { type } of signature.params) {
    if (type.kind === "function" && type.result.kind === "param" && signature.genericParams.includes(type.result.name)) {
      closureResultParams.add(type.result.name);
    }
  }
  return signature.genericParams.map((param) => {
    if (!closureResultParams.has(param)) {
      throw new Error(`cannot infer type argument ${param} of ${signature.selector}; supply it via { typeArguments }`);
    }
    return voidMetadata(); // value-less JS closure ⇒ Void result
  });
}

function matchingMethods(
  fullName: string,
  options: RawMethodResolveOptions,
  match: (candidate: MethodCandidate) => boolean
): MethodCandidate[] {
  const own = applyOverloadFilters(definingModuleMembers(fullName).methods.filter(match), options);
  return own.length > 0
    ? own
    : applyOverloadFilters(allLoadedModuleMembers(fullName).methods.filter(match), options);
}

// planGenericMethod also binds a non-generic method whose closure parameter needs ArgPlan lowering.
function argPlanBound(signature: SwiftFunctionSignature): boolean {
  return signature.genericParams.length > 0
    ? signature.simpleGenerics
    : signature.params.some((p) => p.type.kind === "function");
}

function planGenericMethod(typeNameArg: string, methodName: string, options: RawMethodResolveOptions): CallPlan {
  const fullName = canonicalTypeName(typeNameArg);
  const typeArguments = options.typeArguments ?? [];
  const candidates = matchingMethods(
    fullName,
    options,
    (c) => c.name === methodName && argPlanBound(c.signature)
  );
  if (candidates.length === 0) {
    throw new Error(`no generic or closure-taking method ${methodName} on ${fullName}`);
  }
  if (candidates.length > 1) {
    const selectors = candidates.map((c) => c.signature.selector).join(", ");
    throw new Error(`ambiguous generic method ${methodName} on ${fullName}: ${selectors} (disambiguate with { arity } or { labels })`);
  }
  const { address, signature, mangled } = candidates[0];
  const resolvedTypeArguments =
    typeArguments.length === 0 && signature.genericParams.length > 0
      ? inferClosureTypeArguments(signature)
      : typeArguments;
  if (resolvedTypeArguments.length !== signature.genericParams.length) {
    throw new Error(`${signature.selector} needs ${signature.genericParams.length} type argument(s), got ${typeArguments.length}`);
  }
  const params = splitParams(signature.params);
  const classBoundParams = new Set(
    signature.conformanceRequirements.filter((r) => requirementBound(r).classBound).map((r) => r.subject)
  );
  const argPlans = params.types.map((n, i) =>
    planParam(planGenericType(n, signature.genericParams, resolvedTypeArguments, classBoundParams), params.conventions[i], signature.selector)
  );
  const returnPlan =
    signature.result === null
      ? null
      : planGenericType(signature.result, signature.genericParams, resolvedTypeArguments, classBoundParams);
  const thrown = planThrownType(signature, signature.genericParams, resolvedTypeArguments);
  const witnessTables = options.witnessTables ?? autoWitnessTables(signature, resolvedTypeArguments);
  let asyncFunctionPointer: AsyncFunctionPointer | undefined;
  if (signature.async) {
    const module = Process.findModuleByAddress(address.strip());
    asyncFunctionPointer = module === null ? undefined : findAsyncFunctionPointer(module, mangled) ?? undefined;
    if (asyncFunctionPointer === undefined) {
      throw new Error(`cannot resolve async function pointer for ${signature.selector}`);
    }
  }
  const origin = memberOrigin(address, fullName);
  return setterPlan({ address, selector: signature.selector, argPlans, returnPlan, throws: signature.throws, thrown, async: signature.async, asyncFunctionPointer, typeArguments: resolvedTypeArguments, witnessTables, argConventions: params.conventions, origin, signature });
}

function planThrownType(signature: SwiftFunctionSignature, typeParams: string[], typeArguments: Metadata[]): ThrownType | undefined {
  const resolveParam = (name: string): Metadata | null => {
    const i = typeParams.indexOf(name);
    return i === -1 ? null : typeArguments[i] ?? null;
  };
  return resolveThrownType(signature, resolveParam, (type) => mentionsParam(type, typeParams));
}

export function bindGenericMethod(
  typeName: string,
  methodName: string,
  self: NativePointer,
  options: RawMethodResolveOptions = {}
): BoundMethod {
  return new BoundMethod(planGenericMethod(typeName, methodName, options), { self });
}

// Unless stated, a small loadable self's ownership is read off which layout the callee uses: a
// borrowing self trails the formal args, ahead of the implicit ones; a mutating self rides in x20.
function genericValueSelfRouting(
  receiver: Metadata,
  plan: CallPlan,
  ownership: SelfOwnership | undefined,
  implicitWords: { trailingSelf: number; selfInRegister: number }
): SelfRouting {
  if (ownership === undefined && !shouldPassIndirectly(receiver)) {
    ownership = probedSelfOwnership(receiver, plan, implicitWords);
  }
  return valueSelfRouting(receiver, plan.selector, ownership);
}

const probedSelfOwnerships = new Map<string, SelfOwnership | undefined>();

function probedSelfOwnership(
  receiver: Metadata,
  plan: CallPlan,
  implicitWords: { trailingSelf: number; selfInRegister: number }
): SelfOwnership | undefined {
  const argTypes = plan.argPlans.map(swiftArgType);
  const trailing = argumentRegisterUse([...argTypes, receiver], implicitWords.trailingSelf);
  const inRegister = argumentRegisterUse(argTypes, implicitWords.selfInRegister);
  const key = `${plan.address}:${trailing.gp}:${trailing.fp}:${inRegister.gp}:${inRegister.fp}`;
  if (!probedSelfOwnerships.has(key)) {
    const directOnly: RegisterRange = { gp: [inRegister.gp, trailing.gp], fp: [inRegister.fp, trailing.fp] };
    probedSelfOwnerships.set(key, probeSelfOwnership(plan.address, directOnly) ?? undefined);
  }
  return probedSelfOwnerships.get(key);
}

export function bindGenericValueMethod(
  receiver: Metadata,
  self: NativePointer,
  methodName: string,
  options: RawValueMethodResolveOptions = {}
): BoundMethod {
  const plan = planGenericMethod(typeName(receiver), methodName, options);
  const implicitWords = plan.typeArguments.length + plan.witnessTables.length;
  const routing = genericValueSelfRouting(receiver, plan, options.self, { trailingSelf: implicitWords, selfInRegister: implicitWords });
  return new BoundMethod(plan, { self, routing, consumedSelf: consumedSelf(receiver, options) });
}

// A bare type parameter (T) is address-only in the generic context, unless class-bound, but concretely
// sized by the instance's type argument; concrete and compound types lower as elsewhere.
function planTypeMemberArg(
  type: TypeExpr,
  typeParams: string[],
  typeArguments: Metadata[],
  classBoundParams: Set<string>
): ArgPlan {
  const index = type.kind === "param" ? typeParams.indexOf(type.name) : -1;
  if (index !== -1) {
    const metadata = typeArguments[index];
    return classBoundParams.has(type.text) ? { kind: "concrete", metadata } : { kind: "abstractIndirect", metadata };
  }
  const concrete = resolveType(type.text);
  if (concrete !== null) {
    return { kind: "concrete", metadata: concrete };
  }
  return planCompoundType(type, typeParams, typeArguments, classBoundParams);
}

// Depth-0 generic parameters mangle as x, q_, q0_, q1_...
function typeParamIndex(mangled: string): number | null {
  if (mangled === "x") {
    return 0;
  }
  const match = /^q(\d*)_$/.exec(mangled);
  return match === null ? null : match[1] === "" ? 1 : parseInt(match[1], 10) + 2;
}

function classBoundTypeParams(descriptor: ContextDescriptor, typeParams: string[]): Set<string> {
  const bound = new Set<string>();
  for (const requirement of genericRequirements(descriptor)) {
    const index = typeParamIndex(mangledParam(requirement));
    if (index !== null && index < typeParams.length && isClassBound(requirement)) {
      bound.add(typeParams[index]);
    }
  }
  return bound;
}

// The enclosing generic type's concrete arguments, recovered from the instance's bound type name
// ("Foo<Swift.Int>" → Int) so it works for both value and class metadata. Parameters are named A,
// B... by declaration order to match the demangled signatures.
function genericTypeArguments(receiver: Metadata): { unboundName: string; typeParams: string[]; typeArguments: Metadata[] } {
  const bound = parseTypeExpr(typeName(receiver));
  if (bound === null || bound.kind !== "nominal") {
    throw new Error(`cannot read the type arguments of ${typeName(receiver)}`);
  }
  const typeArguments = bound.args.map((arg) => {
    const metadata = resolveParsedType(arg, () => null);
    if (metadata === null) {
      throw new Error(`cannot resolve type argument ${arg.text} of ${bound.name}`);
    }
    return metadata;
  });
  return { unboundName: bound.name, typeParams: typeArguments.map((_, i) => String.fromCharCode(65 + i)), typeArguments };
}

// Methods on a generic type, no method-level generics. self is indirect (class: object in x20;
// value: its bytes, address-only in the generic context). A value type trails its Self metadata
// — the callee reads T's metadata + witnesses from that vector; a class recovers them from the isa.
// A value type whose layout is fixed in the generic context is routed by bindGenericTypeValueMethod.
function planGenericTypeMethod(receiver: Metadata, methodName: string, options: RawMethodResolveOptions, trailsSelfMetadata: boolean): CallPlan {
  const { unboundName, typeParams, typeArguments } = genericTypeArguments(receiver);
  const candidates = matchingMethods(
    unboundName,
    options,
    (c) => c.name === methodName && c.signature.genericParams.length === 0 && c.signature.simpleGenerics
  );
  if (candidates.length === 0) {
    throw noMethodError(unboundName, methodName);
  }
  if (candidates.length > 1) {
    const overloads = describeOverloads(candidates);
    throw new Error(`ambiguous method ${methodName} on ${unboundName}: ${overloads} (disambiguate with { arity }, { labels }, { argTypes }, or { returnType })`);
  }
  const { address, signature, mangled } = candidates[0];
  const params = splitParams(signature.params);
  const classBound = classBoundTypeParams(findType(unboundName)!, typeParams);
  const argPlans = params.types.map((n, i) =>
    planParam(planTypeMemberArg(n, typeParams, typeArguments, classBound), params.conventions[i], signature.selector)
  );
  const returnPlan =
    signature.result === null
      ? null
      : planTypeMemberArg(signature.result, typeParams, typeArguments, classBound);
  const thrown = planThrownType(signature, typeParams, typeArguments);
  let asyncFunctionPointer: AsyncFunctionPointer | undefined;
  if (signature.async) {
    const module = Process.findModuleByAddress(address.strip());
    asyncFunctionPointer = module === null ? undefined : findAsyncFunctionPointer(module, mangled) ?? undefined;
    if (asyncFunctionPointer === undefined) {
      throw new Error(`cannot resolve async function pointer for ${signature.selector}`);
    }
  }
  return setterPlan({
    address: address.strip(),
    selector: signature.selector,
    argPlans,
    returnPlan,
    throws: signature.throws,
    thrown,
    async: signature.async,
    asyncFunctionPointer,
    typeArguments: trailsSelfMetadata ? [receiver] : [],
    witnessTables: [],
    argConventions: params.conventions,
    origin: memberOrigin(address, unboundName),
    signature,
  });
}

export function bindGenericTypeValueMethod(
  receiver: Metadata,
  self: NativePointer,
  methodName: string,
  options: RawValueMethodResolveOptions = {}
): BoundMethod {
  const plan = planGenericTypeMethod(receiver, methodName, options, true);
  let routing: SelfRouting = { indirect: true };
  if (hasFixedLayoutInGenericContext(receiver.description)) {
    const keyArguments = keyGenericArguments(receiver);
    routing = genericValueSelfRouting(receiver, plan, options.self, {
      trailingSelf: keyArguments.typeArguments.length + keyArguments.witnessTables.length,
      selfInRegister: plan.typeArguments.length,
    });
    if (!routing.indirect) {
      Object.assign(plan, keyArguments);
    }
  }
  return new BoundMethod(plan, { self, routing, consumedSelf: consumedSelf(receiver, options) });
}

export function bindGenericTypeClassMethod(
  receiver: Metadata,
  self: NativePointer,
  methodName: string,
  options: RawMethodResolveOptions = {}
): BoundMethod {
  return new BoundMethod(planGenericTypeMethod(receiver, methodName, options, false), { self });
}

// A type method of a specialization. A class takes its metadata as the thick metatype self; a value
// type's metatype is thin, so the specialization's key arguments trail the formal ones instead.
export function bindGenericTypeStaticMethod(receiver: Metadata, methodName: string, options: RawMethodResolveOptions = {}): BoundMethod {
  const plan = planGenericTypeMethod(receiver, methodName, { ...options, static: true }, false);
  if (receiver.kind === MetadataKind.Class) {
    return new BoundMethod(plan, { self: receiver.handle });
  }
  Object.assign(plan, keyGenericArguments(receiver));
  return new BoundMethod(plan);
}

// An initializer of a specialization, self-less like its statics; a class allocates through its
// metadata. The arguments are consumed and the +1 result adopted, as bindValueInitializer does.
export function bindGenericTypeInitializer(receiver: Metadata, options: RawMethodResolveOptions = {}): SwiftBoundInitializer {
  const isClass = receiver.kind === MetadataKind.Class;
  const plan = planGenericTypeMethod(receiver, isClass ? "__allocating_init" : "init", options, false);
  const argConventions = plan.argPlans.map((_, i): ParamConvention => (plan.argConventions?.[i] === "inout" ? "inout" : "owned"));
  let bound: BoundMethod;
  if (isClass) {
    bound = new BoundMethod({ ...plan, argConventions }, { self: receiver.handle });
  } else {
    Object.assign(plan, keyGenericArguments(receiver));
    bound = new BoundMethod({ ...plan, argConventions }, { adoptResult: true });
  }
  return { address: bound.address, call: (...args) => bound.call(...args) as SwiftValueObject | null };
}

interface ResolvedAccessor {
  address: NativePointer;
  type: Metadata;
  kind: AccessorKind;
}

// Instance accessors only, walking the superclass chain like enumerateProperties so a subclass
// shadows an inherited property and a static accessor of the same name is never mistaken for it.
function resolveAccessor(typeName: string, member: string, kind: AccessorKind): ResolvedAccessor {
  const resolved = findAccessor(typeName, member, kind);
  if (resolved === null) {
    throw new Error(`no ${kind} for ${member} on ${canonicalTypeName(typeName)}`);
  }
  return resolved;
}

function findAccessor(typeName: string, member: string, kind: AccessorKind, isStatic = false): ResolvedAccessor | null {
  const fullName = canonicalTypeName(typeName);
  return (
    resolveAccessorIn(fullName, member, kind, isStatic, definingModuleMembers) ??
    resolveAccessorIn(fullName, member, kind, isStatic, allLoadedModuleMembers)
  );
}

function resolveAccessorIn(
  fullName: string,
  member: string,
  kind: AccessorKind,
  isStatic: boolean,
  members: MemberSource
): ResolvedAccessor | null {
  for (const className of classChainNames(fullName)) {
    const candidate = members(className).accessors.find(
      (a) => a.member === member && a.kind === kind && a.isStatic === isStatic
    );
    if (candidate === undefined) {
      continue;
    }
    const type = resolveParsedType(candidate.type, () => null);
    if (type === null) {
      throw new Error(`cannot resolve ${kind} type ${candidate.typeName} of ${className}.${member}`);
    }
    return { address: candidate.address, type, kind };
  }
  return null;
}

// A getter borrows self, so a small loadable value receiver rides in registers by value — passed as a
// trailing loadable arg, not the x20 self-pointer used for classes and large/address-only receivers.
function getterSelfByValue(receiverTypeName: string): Metadata | null {
  const receiver = resolveType(receiverTypeName);
  if (receiver === null || receiver.kind === MetadataKind.Class || shouldPassIndirectly(receiver)) {
    return null;
  }
  return receiver;
}

function accessorPlan(
  address: NativePointer,
  type: Metadata,
  kind: AccessorKind,
  abstract = false,
  implicit: { typeArguments?: Metadata[]; witnessTables?: NativePointer[] } = {}
): CallPlan {
  const typePlan: ArgPlan = abstract ? { kind: "abstractIndirect", metadata: type } : { kind: "concrete", metadata: type };
  return {
    address,
    selector: kind,
    argPlans: kind === "getter" ? [] : [typePlan],
    returnPlan: kind === "getter" ? typePlan : null,
    throws: false,
    async: false,
    typeArguments: implicit.typeArguments ?? [],
    witnessTables: implicit.witnessTables ?? [],
    argConventions: kind === "getter" ? [] : ["owned"], // newValue is +1: the callee consumes the temp
  };
}

export function getProperty(self: NativePointer, typeName: string, member: string): CallResult {
  const accessor = findAccessor(typeName, member, "getter");
  if (accessor === null) {
    return conformanceGetProperty(canonicalTypeName(typeName), self, member);
  }
  const selfByValue = getterSelfByValue(typeName);
  const routing: SelfRouting = selfByValue === null ? { indirect: true } : { indirect: false, receiver: selfByValue };
  return new BoundMethod(accessorPlan(accessor.address, accessor.type, "getter"), { self, routing }).call() as CallResult;
}

// Self is the metatype: thick (the metadata) for a class or a protocol extension, erased for a value type.
export function getStaticProperty(receiver: Metadata, member: string): CallResult {
  const name = typeName(receiver);
  const accessor = findAccessor(name, member, "getter", true);
  if (accessor === null) {
    return conformanceGetProperty(canonicalTypeName(name), receiver.handle, member, true);
  }
  return new BoundMethod(accessorPlan(accessor.address, accessor.type, "getter"), { self: receiver.handle }).call() as CallResult;
}

export function setStaticProperty(receiver: Metadata, member: string, value: CallArg): void {
  const name = typeName(receiver);
  const accessor = findAccessor(name, member, "setter", true);
  if (accessor === null) {
    throw new Error(`no static setter for ${member} on ${name}`);
  }
  new BoundMethod(accessorPlan(accessor.address, accessor.type, "setter"), { self: receiver.handle }).call(value);
}

// Setter self is inout (mutating), so it stays indirect.
export function setProperty(self: NativePointer, typeName: string, member: string, value: CallArg): void {
  const accessor = resolveAccessor(typeName, member, "setter");
  new BoundMethod(accessorPlan(accessor.address, accessor.type, "setter"), { self }).call(value);
}

interface ConformanceMembers {
  table: WitnessTable;
  protocol: ContextDescriptor;
  members: TypeMembers;
}

function conformanceMembers(fullName: string, mayName: SymbolFilter | null = null): ConformanceMembers[] {
  const descriptor = findType(fullName);
  const receiver = descriptor === null || descriptor.isGeneric ? null : resolveType(fullName);
  if (receiver === null) {
    return [];
  }
  const conformances: { table: WitnessTable; protocol: ContextDescriptor }[] = [];
  const seen = new Set<string>();
  for (const className of classChainNames(fullName)) {
    for (const protocol of conformingProtocols(findType(className)!.handle)) {
      const key = protocol.handle.toString();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const table = conformsToProtocol(receiver, protocol);
      if (table !== null) {
        conformances.push({ table: new WitnessTable(table, receiver), protocol });
      }
    }
  }
  const members = protocolExtensionMembersOfAll(conformances.map((c) => c.protocol), mayName);
  return conformances.map((c, i) => ({ ...c, members: applicableMembers(members[i], c.table) }));
}

function applicableMembers(members: TypeMembers, table: WitnessTable): TypeMembers {
  const applies = (c: { constraints: string[] }): boolean =>
    c.constraints.length === 0 || selfSignature(table, c.constraints) !== null;
  return { methods: members.methods.filter(applies), accessors: members.accessors.filter(applies) };
}

function unshadowedMembers<T extends { constraints: string[] }>(candidates: T[], identity: (c: T) => string): T[] {
  return candidates.filter(
    (c) =>
      !candidates.some(
        (other) =>
          identity(other) === identity(c) &&
          other.constraints.length > c.constraints.length &&
          c.constraints.every((constraint) => other.constraints.includes(constraint))
      )
  );
}

interface SelfSignature {
  witnessTables: NativePointer[];
  classBound: Set<string>;
}

// The compiler lowers Self: P plus the where clause as a minimized, canonically ordered signature:
// Self's witness tables by protocol (Self: P dropped when another requirement implies it), then its
// associated types'. null when the conforming type misses a requirement or one isn't checkable here.
function selfSignature(table: WitnessTable, constraints: string[]): SelfSignature | null {
  const protocol = protocolOf(table);
  const selfWitnesses = [{ protocol, witness: table.handle }];
  const associatedWitnesses: NativePointer[] = [];
  const classBound = new Set<string>();
  if (protocolClassConstraint(protocol) === 0) {
    classBound.add("A");
  }
  let impliesProtocol = false;
  for (const constraint of constraints) {
    const match = /^(A(?:\.\w+)?): (.+)$/.exec(constraint);
    const subject = match === null ? null : resolveWitnessSelfOrAssociatedType(table, match[1]);
    if (match === null || subject === null) {
      return null;
    }
    const [, subjectName, bound] = match;
    if (bound === "AnyObject") {
      if (!isAnyClass(subject)) {
        return null;
      }
      classBound.add(subjectName);
      continue;
    }
    const superclass =
      subject.kind === MetadataKind.Class ? selfOrSuperclassNamed(new ClassMetadata(subject.handle), bound) : null;
    if (superclass !== null) {
      classBound.add(subjectName);
      impliesProtocol ||= subjectName === "A" && conformsToProtocol(superclass, protocol) !== null;
      continue;
    }
    const required = whereClauseProtocol(bound);
    const witness = required === null ? null : conformsToProtocol(subject, required);
    if (required === null || witness === null) {
      return null;
    }
    if (protocolClassConstraint(required) === 0) {
      classBound.add(subjectName);
    }
    if (subjectName !== "A") {
      associatedWitnesses.push(witness);
      continue;
    }
    selfWitnesses.push({ protocol: required, witness });
    impliesProtocol ||= refinesProtocol(required, protocol);
  }
  const selfWitnessTables = (impliesProtocol ? selfWitnesses.slice(1) : selfWitnesses)
    .sort((a, b) => compareProtocolDescriptors(a.protocol, b.protocol))
    .map((w) => w.witness);
  return { witnessTables: [...selfWitnessTables, ...associatedWitnesses], classBound };
}

function isAnyClass(type: Metadata): boolean {
  return (
    type.kind === MetadataKind.Class ||
    type.kind === MetadataKind.ObjCClassWrapper ||
    type.kind === MetadataKind.ForeignClass
  );
}

// swift_getTypeName names a pure ObjC class without its __C module.
function selfOrSuperclassNamed(type: ClassMetadata, name: string): Metadata | null {
  const printed = name.startsWith("__C.") ? name.slice("__C.".length) : name;
  for (let cls: ClassMetadata | null = type; cls !== null; cls = cls.superclass) {
    const metadata = new Metadata(cls.handle);
    if (typeName(metadata) === printed) {
      return metadata;
    }
  }
  return null;
}

// An extension's image links the images declaring its where clause's protocols, so a miss is final.
const whereClauseProtocols = new Map<string, ContextDescriptor | null>();

function whereClauseProtocol(name: string): ContextDescriptor | null {
  let protocol = whereClauseProtocols.get(name);
  if (protocol === undefined) {
    protocol = findProtocol(name);
    whereClauseProtocols.set(name, protocol);
  }
  return protocol;
}

function refinesProtocol(protocol: ContextDescriptor, ancestor: ContextDescriptor): boolean {
  return readRequirementSignature(protocol).some(
    (r) =>
      r.kind === GenericRequirementKind.Protocol &&
      r.protocol !== null &&
      requirementSubject(r) === "A" &&
      (r.protocol.handle.equals(ancestor.handle) || refinesProtocol(r.protocol, ancestor))
  );
}

function isConformanceMethod(c: MethodCandidate): boolean {
  return c.signature.genericParams.length === 0;
}

function conformanceMethodOverloads(
  members: TypeMembers,
  name: string,
  options: RawMethodResolveOptions
): MethodCandidate[] {
  return applyOverloadFilters(
    members.methods.filter((c) => c.name === name && isConformanceMethod(c)),
    { ...options, static: options.static ?? false }
  );
}

function conformanceDeclaring(
  fullName: string,
  member: string,
  declares: (members: TypeMembers) => boolean
): ConformanceMembers | null {
  const owners = conformanceMembers(fullName).filter((c) => declares(c.members));
  if (owners.length > 1) {
    const protocols = owners.map((c) => c.protocol.fullTypeName).join(", ");
    throw new Error(`ambiguous ${member} on ${fullName}: declared by extensions of ${protocols}`);
  }
  return owners[0] ?? null;
}

// Self is @in_guaranteed unless the callee's signature makes it class-bound, so a class reference needs a cell.
function witnessReceiver(table: WitnessTable, classBound: Set<string>, self: NativePointer): NativePointer {
  if (table.conformingType.kind !== MetadataKind.Class || classBound.has("A")) {
    return self;
  }
  const cell = Memory.alloc(Process.pointerSize);
  cell.writePointer(self);
  return cell;
}

export function bindConformanceMethod(
  fullName: string,
  self: NativePointer,
  name: string,
  options: RawMethodResolveOptions = {}
): BoundMethod {
  const conformance = conformanceDeclaring(
    fullName,
    name,
    (m) => conformanceMethodOverloads(m, name, options).length > 0
  );
  if (conformance === null) {
    throw noMethodError(fullName, name);
  }
  const resolved = resolveExtensionMethod(conformance.table, name, options);
  const receiver = resolved.isStatic ? self : witnessReceiver(conformance.table, resolved.classBound, self);
  return bindResolved(resolved, receiver);
}

function conformanceGetProperty(fullName: string, self: NativePointer, member: string, isStatic = false): CallResult {
  const conformance = conformanceDeclaring(fullName, member, (m) =>
    m.accessors.some((a) => a.member === member && a.kind === "getter" && a.isStatic === isStatic)
  );
  if (conformance === null) {
    throw new Error(`no ${isStatic ? "static " : ""}getter for ${member} on ${fullName}`);
  }
  const accessor = resolveExtensionAccessor(conformance.table, member, "getter", isStatic);
  const receiver = isStatic ? self : witnessReceiver(conformance.table, accessor.classBound, self);
  return new BoundMethod(witnessAccessorPlan(accessor), { self: receiver }).call() as CallResult;
}

function protocolOf(table: WitnessTable): ContextDescriptor {
  const protocol = new ProtocolConformance(table.conformanceDescriptor).protocol;
  if (protocol === null) {
    throw new Error("witness table's conformance descriptor has no protocol");
  }
  return protocol;
}

function stripWitnessWrapper(demangled: string): string | null {
  const prefix = "protocol witness for ";
  if (!demangled.startsWith(prefix)) {
    return null;
  }
  const rest = demangled.slice(prefix.length);
  const at = rest.indexOf(" in conformance ");
  return at === -1 ? rest : rest.slice(0, at);
}

const CALLABLE_REQUIREMENT_KINDS = new Set<ProtocolRequirementKind>([
  ProtocolRequirementKind.Method,
  ProtocolRequirementKind.Init,
  ProtocolRequirementKind.Getter,
  ProtocolRequirementKind.Setter,
]);

export interface NamedRequirement {
  requirement: ProtocolRequirement;
  name: string; // bare name — round-trips into WitnessTable.method()/get()/set()
  signature: SwiftFunctionSignature | SwiftAccessorSignature;
}

interface RequirementNaming {
  pending: ProtocolRequirement[];
  found: Map<number, NamedRequirement>;
  visitedTypes: Set<string>;
}

const namingByProtocol = new Map<string, RequirementNaming>();

// A requirement's witnessIndex is protocol-global: every conformance lays its witness table out in
// the same requirement order, so a name recovered from one conformance's thunk is valid to attach
// to any other conformance's table at the same index. Scanning every conforming type (rather than
// requiring one caller-supplied table) both gives reflection a name with no invocation in hand and
// lets a stripped conformance's own unrecoverable thunk still resolve by name via a sibling.
export function namedProtocolRequirements(protocol: ContextDescriptor): NamedRequirement[] {
  const key = protocol.handle.toString();
  let naming = namingByProtocol.get(key);
  if (naming === undefined) {
    // Async is unlocked only for methods (driven through callAsync); an async accessor would be
    // mis-driven synchronously by witnessGetProperty/Set, so keep it out of naming.
    const pending = readProtocolRequirements(protocol).filter(
      (r) => CALLABLE_REQUIREMENT_KINDS.has(r.kind) && (!r.isAsync || r.kind === ProtocolRequirementKind.Method)
    );
    naming = { pending, found: new Map(), visitedTypes: new Set() };
    namingByProtocol.set(key, naming);
  }
  const { pending, found, visitedTypes } = naming;

  for (const typeDescriptor of found.size < pending.length ? conformingTypes(protocol) : []) {
    if (found.size === pending.length) {
      break;
    }
    const typeKey = typeDescriptor.handle.toString();
    if (visitedTypes.has(typeKey)) {
      continue;
    }
    visitedTypes.add(typeKey);
    const table = conformanceTable(typeDescriptor, protocol);
    if (table === null) {
      continue;
    }
    for (const requirement of pending) {
      if (found.has(requirement.witnessIndex)) {
        continue;
      }
      const slot = table.requirement(requirement.witnessIndex);
      const demangled = symbolicate(requirement.isAsync ? new AsyncFunctionPointer(slot).code : slot)?.demangled ?? null;
      if (demangled === null) {
        continue;
      }
      const stripped = stripWitnessWrapper(demangled);
      if (stripped === null) {
        continue;
      }
      const signature = parseSwiftSignature(stripped);
      if (signature === null) {
        continue;
      }
      const name = signature.kind === "function" ? signature.name : signature.member;
      found.set(requirement.witnessIndex, { requirement, name, signature });
    }
  }

  return [...found.values()];
}

function conformanceTable(typeDescriptor: ContextDescriptor, protocol: ContextDescriptor): WitnessTable | null {
  if (typeDescriptor.isGeneric) {
    return null; // no accessFunction to call without type arguments
  }
  let type: Metadata;
  try {
    type = getMetadata(typeDescriptor);
  } catch {
    return null;
  }
  const tableAddr = conformsToProtocol(type, protocol);
  return tableAddr === null ? null : new WitnessTable(tableAddr, type);
}

function witnessCandidates(table: WitnessTable): NamedRequirement[] {
  return namedProtocolRequirements(protocolOf(table));
}

// witness signatures mangle Self as "A" and its associated types as "A.<name>"
function resolveWitnessSelfOrAssociatedType(table: WitnessTable, name: string): Metadata | null {
  if (name === "A") {
    return table.conformingType;
  }
  if (name.startsWith("A.")) {
    try {
      return table.associatedType(name.slice(2));
    } catch {
      return null;
    }
  }
  return null;
}

export function resolveWitnessMethod(table: WitnessTable, methodName: string): ResolvedMethod {
  const protocolName = protocolOf(table).fullTypeName ?? "protocol";
  const matches = witnessCandidates(table).filter(
    (c): c is NamedRequirement & { signature: SwiftFunctionSignature } =>
      c.signature.kind === "function" && c.signature.name === methodName
  );
  if (matches.length === 0) {
    return resolveExtensionMethod(table, methodName);
  }
  if (matches.length > 1) {
    const overloads = matches.map((m) => m.signature.selector).join(", ");
    throw new Error(`ambiguous requirement ${methodName} on ${protocolName}: ${overloads}`);
  }
  const { requirement, signature } = matches[0];
  const address = table.requirement(requirement.witnessIndex);
  return {
    address,
    ...resolveWitnessSignature(table, signature, new Set()),
    isStatic: !requirement.isInstance,
    signature,
    // An async requirement's slot holds the …Tu record (GenProto.cpp getAddrOfAsyncFunctionPointer).
    async: requirement.isAsync,
    asyncFunctionPointer: requirement.isAsync ? new AsyncFunctionPointer(address) : undefined,
    witnessSelf: table,
  };
}

function resolveExtensionMethod(
  table: WitnessTable,
  methodName: string,
  options: RawMethodResolveOptions = {}
): ResolvedMethod & { classBound: Set<string> } {
  const protocol = protocolOf(table);
  const protocolName = protocol.fullTypeName ?? "protocol";
  const matches = unshadowedMembers(
    conformanceMethodOverloads(applicableMembers(protocolExtensionMembers(protocol), table), methodName, options),
    ({ signature }) => `${signature.selector}(${signature.argTypeNames.join(", ")}) -> ${signature.returnTypeName}`
  );
  if (matches.length === 0) {
    throw new Error(`no requirement ${methodName} on ${protocolName}`);
  }
  if (matches.length > 1) {
    const overloads = matches.map((m) => describeOverload(m.signature)).join(", ");
    throw new Error(
      `ambiguous extension method ${methodName} on ${protocolName}: ${overloads} (disambiguate with { arity }, { labels }, { argTypes }, or { returnType })`
    );
  }
  const { signature, mangled, constraints, isStatic } = matches[0];
  const requirement = requirementImplementedBy(
    table,
    (r) => r.kind === ProtocolRequirementKind.Method && r.isAsync === signature.async && r.isInstance !== isStatic,
    (s) =>
      s.kind === "function" &&
      s.selector === signature.selector &&
      sequenceEqual(s.argTypeNames, signature.argTypeNames) &&
      s.returnTypeName === signature.returnTypeName
  );
  if (requirement === "undecodable") {
    throw new Error(`cannot tell whether ${signature.selector} is a requirement of ${protocolName}`);
  }
  let address: NativePointer;
  let asyncFunctionPointer: AsyncFunctionPointer | undefined;
  if (requirement !== null) {
    address = table.requirement(requirement.witnessIndex);
    asyncFunctionPointer = signature.async ? new AsyncFunctionPointer(address) : undefined;
  } else {
    address = matches[0].address.strip();
    if (signature.async) {
      const module = Process.findModuleByAddress(address);
      const afp = module === null ? null : findAsyncFunctionPointer(module, mangled);
      if (afp === null) {
        throw new Error(`cannot resolve async function pointer for ${signature.selector}`);
      }
      asyncFunctionPointer = afp;
    }
  }
  const { witnessTables, classBound } = selfSignature(table, requirement === null ? constraints : [])!;
  return {
    address,
    ...resolveWitnessSignature(table, signature, classBound),
    isStatic,
    signature,
    async: signature.async,
    asyncFunctionPointer,
    witnessSelf: table,
    witnessTables,
    classBound,
    origin: { kind: "protocolExtension", protocol: protocolName, module: imageName(matches[0].address) },
  };
}

// Stripped binaries only reveal a requirement's default through where the witness thunk branches.
function requirementImplementedBy(
  table: WitnessTable,
  isCandidate: (requirement: ProtocolRequirement) => boolean,
  isImplementation: (signature: ParsedSwiftSignature) => boolean
): ProtocolRequirement | null | "undecodable" {
  let undecodable = false;
  const protocol = protocolOf(table);
  for (const requirement of readProtocolRequirements(protocol).filter(isCandidate)) {
    const signature =
      witnessTargetSignature(table, requirement) ??
      witnessThunkSignature(table, requirement) ??
      siblingWitnessSignature(protocol, requirement);
    if (signature === null) {
      undecodable = true;
    } else if (isImplementation(signature)) {
      return requirement;
    }
  }
  return undecodable ? "undecodable" : null;
}

function siblingWitnessSignature(
  protocol: ContextDescriptor,
  requirement: ProtocolRequirement
): ParsedSwiftSignature | null {
  for (const typeDescriptor of conformingTypes(protocol)) {
    const table = conformanceTable(typeDescriptor, protocol);
    if (table === null) {
      continue;
    }
    const signature = witnessThunkSignature(table, requirement) ?? witnessTargetSignature(table, requirement);
    if (signature !== null && isWitnessOf(signature, requirement, typeDescriptor, protocol)) {
      return signature;
    }
  }
  return null;
}

const WITNESS_KIND: Partial<Record<ProtocolRequirementKind, ParsedSwiftSignature["kind"]>> = {
  [ProtocolRequirementKind.Method]: "function",
  [ProtocolRequirementKind.Getter]: "getter",
  [ProtocolRequirementKind.Setter]: "setter",
};

// An optimized thunk may inline its witness, so its first branch can be any callee of that witness.
function isWitnessOf(
  signature: ParsedSwiftSignature,
  requirement: ProtocolRequirement,
  conformingType: ContextDescriptor,
  protocol: ContextDescriptor
): boolean {
  const { context } = stripReceiverKeyword(signature.context);
  return (
    accessorKind(signature) === WITNESS_KIND[requirement.kind] &&
    (context === conformingType.fullTypeName || context === protocol.fullTypeName)
  );
}

// A subscript accessor parses as a function named subscript; its witness kind is the accessor's.
function accessorKind(signature: ParsedSwiftSignature): string {
  return signature.kind === "function" && signature.accessor !== undefined ? signature.accessor : signature.kind;
}

function witnessTargetSignature(table: WitnessTable, requirement: ProtocolRequirement): ParsedSwiftSignature | null {
  const target = witnessTarget(table, requirement);
  const demangled = target === null ? null : symbolicate(target.address)?.demangled ?? null;
  return demangled === null ? null : parseSwiftSignature(demangled);
}

function witnessThunkSignature(table: WitnessTable, requirement: ProtocolRequirement): ParsedSwiftSignature | null {
  const slot = table.requirement(requirement.witnessIndex);
  const demangled = symbolicate(requirement.isAsync ? new AsyncFunctionPointer(slot).code : slot)?.demangled ?? null;
  const stripped = demangled === null ? null : stripWitnessWrapper(demangled);
  return stripped === null ? null : parseSwiftSignature(stripped);
}

function resolveWitnessSignature(
  table: WitnessTable,
  signature: SwiftFunctionSignature,
  classBound: Set<string>
): Pick<ResolvedMethod, "argTypes" | "returnType" | "throws" | "thrown" | "selector" | "abstractArgs" | "abstractReturn" | "argConventions"> {
  const params = splitParams(signature.params);
  const layout = protocolLevelParamLayout(table, classBound);
  const { argTypes, returnType, thrown } = signatureMetadata(
    signature,
    (n) => resolveWitnessSelfOrAssociatedType(table, n),
    (type) => hasOpaqueLayout(type, layout)
  );
  return {
    argTypes,
    returnType,
    throws: signature.throws,
    thrown,
    selector: signature.selector,
    abstractArgs: params.types.map((t) => hasOpaqueLayout(t, layout)),
    abstractReturn:
      signature.result === null ? false : destructuredTupleLayout(signature.result, layout) ?? hasOpaqueLayout(signature.result, layout),
    argConventions: params.conventions,
  };
}

export function bindWitnessMethod(
  table: WitnessTable,
  self: NativePointer,
  methodName: string
): BoundMethod {
  return bindResolved(resolveWitnessMethod(table, methodName), self);
}

export interface WitnessMethodSignature {
  argTypes: Metadata[];
  returnType: Metadata | null;
  throws?: boolean;
}

export function bindWitnessMethodAt(
  table: WitnessTable,
  witnessIndex: number,
  self: NativePointer,
  signature: WitnessMethodSignature
): BoundMethod {
  const resolved: ResolvedMethod = {
    address: table.requirement(witnessIndex),
    argTypes: signature.argTypes,
    returnType: signature.returnType,
    throws: signature.throws ?? false,
    isStatic: false,
    selector: `#${witnessIndex}`,
    witnessSelf: table,
  };
  return bindResolved(resolved, self);
}

interface ResolvedWitnessAccessor extends SelfSignature {
  address: NativePointer;
  type: Metadata;
  kind: AccessorKind;
  // Self ("A") and associated types ("A.<name>") are opaque at the protocol level, so the witness
  // thunk passes/returns any type storing one inline indirectly, even when the concrete type is loadable.
  abstract: boolean;
  table: WitnessTable;
}

function resolveWitnessAccessor(table: WitnessTable, member: string, kind: AccessorKind): ResolvedWitnessAccessor {
  const match = witnessCandidates(table).find(
    (c): c is NamedRequirement & { signature: SwiftAccessorSignature } =>
      c.signature.kind === kind && c.signature.member === member
  );
  if (match === undefined) {
    return resolveExtensionAccessor(table, member, kind);
  }
  const address = table.requirement(match.requirement.witnessIndex);
  return witnessAccessor(table, address, member, kind, match.signature.type, selfSignature(table, [])!);
}

function resolveExtensionAccessor(
  table: WitnessTable,
  member: string,
  kind: AccessorKind,
  isStatic = false
): ResolvedWitnessAccessor {
  const protocol = protocolOf(table);
  const protocolName = protocol.fullTypeName ?? "protocol";
  const [match] = unshadowedMembers(
    applicableMembers(protocolExtensionMembers(protocol), table).accessors.filter(
      (a) => a.member === member && a.kind === kind && a.isStatic === isStatic
    ),
    (a) => a.typeName
  );
  if (match === undefined) {
    throw new Error(`no ${kind} for ${member} on ${protocolName}`);
  }
  const requirementKind = kind === "getter" ? ProtocolRequirementKind.Getter : ProtocolRequirementKind.Setter;
  const requirement = requirementImplementedBy(
    table,
    (r) => r.kind === requirementKind && r.isInstance !== isStatic,
    (s) => s.kind === kind && s.member === member
  );
  if (requirement === "undecodable") {
    throw new Error(`cannot tell whether ${member} is a requirement of ${protocolName}`);
  }
  const address = requirement === null ? match.address.strip() : table.requirement(requirement.witnessIndex);
  const signature = selfSignature(table, requirement === null ? match.constraints : [])!;
  return witnessAccessor(table, address, member, kind, match.type, signature);
}

function witnessAccessor(
  table: WitnessTable,
  address: NativePointer,
  member: string,
  kind: AccessorKind,
  spelled: TypeExpr,
  signature: SelfSignature
): ResolvedWitnessAccessor {
  const type = resolveParsedType(spelled, (n) => resolveWitnessSelfOrAssociatedType(table, n));
  if (type === null) {
    throw new Error(`cannot resolve ${kind} type ${spelled.text} of ${member}`);
  }
  const abstract = protocolLevelOpaque(table, signature.classBound)(spelled);
  return { address, type, kind, abstract, table, ...signature };
}

function protocolLevelOpaque(table: WitnessTable, signatureClassBound: Set<string>): (type: TypeExpr) => boolean {
  const layout = protocolLevelParamLayout(table, signatureClassBound);
  return (type) => hasOpaqueLayout(type, layout);
}

function protocolLevelParamLayout(table: WitnessTable, signatureClassBound: Set<string>): (name: string) => ParamLayout | null {
  const classBound = classBoundSubjects(protocolOf(table));
  for (const subject of signatureClassBound) {
    classBound.add(subject);
  }
  return (name) => {
    if (name !== "A" && !name.startsWith("A.")) {
      return null;
    }
    return classBound.has(name) ? "reference" : "opaque";
  };
}

function classBoundSubjects(protocol: ContextDescriptor): Set<string> {
  const subjects = new Set<string>();
  for (const requirement of readRequirementSignature(protocol)) {
    const subject = requirementSubject(requirement);
    if (subject !== null && isClassBound(requirement)) {
      subjects.add(subject);
    }
  }
  return subjects;
}

// "x" is Self; "<len><name><protocol ref>Qz" is Self.<name>.
function requirementSubject(requirement: GenericRequirementDescriptor): string | null {
  const mangled = mangledParam(requirement);
  if (mangled === "x") {
    return "A";
  }
  const match = /^(\d+)/.exec(mangled);
  if (match === null || !mangled.endsWith("Qz")) {
    return null;
  }
  return "A." + mangled.substr(match[1].length, parseInt(match[1], 10));
}

function mangledParam(requirement: GenericRequirementDescriptor): string {
  const { address, length } = requirement.param;
  return String.fromCharCode(...new Uint8Array(address.readByteArray(length)!));
}

function isClassBound(requirement: GenericRequirementDescriptor): boolean {
  switch (requirement.kind) {
    case GenericRequirementKind.Layout:
      return requirement.layoutKind === GenericRequirementLayoutKind.Class;
    case GenericRequirementKind.BaseClass:
      return true;
    case GenericRequirementKind.Protocol:
      return requirement.isObjCProtocol || (requirement.protocol !== null && protocolClassConstraint(requirement.protocol) === 0);
    default:
      return false;
  }
}

function witnessAccessorPlan(accessor: ResolvedWitnessAccessor): CallPlan {
  return accessorPlan(accessor.address, accessor.type, accessor.kind, accessor.abstract, witnessSelfArgs(accessor.table, accessor.witnessTables));
}

export function witnessGetProperty(table: WitnessTable, self: NativePointer, name: string): CallResult {
  const accessor = resolveWitnessAccessor(table, name, "getter");
  return new BoundMethod(witnessAccessorPlan(accessor), { self }).call() as CallResult;
}

export function witnessSetProperty(table: WitnessTable, self: NativePointer, name: string, value: CallArg): void {
  const accessor = resolveWitnessAccessor(table, name, "setter");
  new BoundMethod(witnessAccessorPlan(accessor), { self }).call(value);
}

let actorProtocol: ContextDescriptor | null | undefined;
let unownedSerialExecutorType: Metadata | null | undefined;

// Reads the actor's Actor.unownedExecutor: {actor, 0} for a default actor, {executor, witness-table} for a custom one.
export function actorSerialExecutor(actorType: Metadata, self: NativePointer): SerialExecutorRef | null {
  if (actorProtocol === undefined) {
    actorProtocol = findProtocol("Swift.Actor");
  }
  if (actorProtocol === null) {
    return null;
  }
  const tableAddr = conformsToProtocol(actorType, actorProtocol);
  if (tableAddr === null) {
    return null;
  }
  const getter = readProtocolRequirements(actorProtocol).find((r) => r.kind === ProtocolRequirementKind.Getter);
  if (getter === undefined) {
    return null;
  }
  if (unownedSerialExecutorType === undefined) {
    unownedSerialExecutorType = resolveType("Swift.UnownedSerialExecutor");
  }
  if (unownedSerialExecutorType === null) {
    return null;
  }
  const address = new WitnessTable(tableAddr, actorType).requirement(getter.witnessIndex);
  const plan = accessorPlan(address, unownedSerialExecutorType, "getter");
  const ref = withInvoker(plan, true, null, (fn) => fn(self));
  if (ref === null) {
    return null;
  }
  return { identity: ref.readPointer(), implementation: ref.add(Process.pointerSize).readPointer() };
}

const DIRECT_BRANCH_MNEMONICS: Partial<Record<Architecture, ReadonlySet<string>>> = {
  arm64: new Set(["b", "bl"]),
  x64: new Set(["call", "jmp"]),
};

// Register-target branch into a resolved vtable slot. On x64 these share call/jmp with the
// direct set; the operand kind (imm vs reg) is what disambiguates a fixed branch from an indirect.
const INDIRECT_BRANCH_MNEMONICS: Partial<Record<Architecture, ReadonlySet<string>>> = {
  arm64: new Set(["blr", "blraa", "blrab", "br", "braa", "brab"]),
  x64: new Set(["call", "jmp"]),
};

function isArm64AuthInPlace(mnemonic: string): boolean {
  return mnemonic.startsWith("aut") || mnemonic.startsWith("xpac");
}

const CONTROL_FLOW_GROUPS = new Set(["jump", "call", "ret", "return"]);

type BranchClassification =
  | { kind: "direct"; target: NativePointer }
  | { kind: "vtable"; metadataOffset: number }
  | { kind: "unknown" };

type LoadState =
  | { phase: "seekingMetadata" }
  | { phase: "haveMetadata"; reg: string }
  | { phase: "haveSlot"; reg: string; offset: number };

const SELF_REG: Partial<Record<Architecture, string>> = { arm64: "x20", x64: "r13" }; // swiftself
const LOAD_MNEMONIC: Partial<Record<Architecture, string>> = { arm64: "ldr", x64: "mov" };

function asMemLoad(insn: Instruction): { dest: string; base: string; disp: number } | null {
  if (insn.mnemonic !== LOAD_MNEMONIC[Process.arch]) {
    return null;
  }
  const [dest, src] = (insn as Arm64Instruction | X86Instruction).operands;
  if (dest?.type !== "reg" || src?.type !== "mem" || src.value.base === undefined) {
    return null;
  }
  return { dest: dest.value, base: src.value.base, disp: src.value.disp };
}

// A witness thunk is a prologue, then a fixed branch, or a self→metadata→vtable-slot load chain
// into an indirect one; anything else resets the chain rather than guessing.
function classifyBranch(address: NativePointer, maxInstructions = 16): BranchClassification {
  const directMnemonics = DIRECT_BRANCH_MNEMONICS[Process.arch];
  const indirectMnemonics = INDIRECT_BRANCH_MNEMONICS[Process.arch];
  const selfReg = SELF_REG[Process.arch];
  if (directMnemonics === undefined || indirectMnemonics === undefined || selfReg === undefined) {
    return { kind: "unknown" };
  }
  let cursor = address;
  let state: LoadState = { phase: "seekingMetadata" };
  for (let i = 0; i < maxInstructions; i++) {
    const insn = Instruction.parse(cursor);
    if (insn.groups.some((g) => CONTROL_FLOW_GROUPS.has(g))) {
      const operand = (insn as Arm64Instruction | X86Instruction).operands[0];
      if (directMnemonics.has(insn.mnemonic) && operand?.type === "imm") {
        return { kind: "direct", target: ptr(operand.value.toString()) };
      }
      if (
        state.phase === "haveSlot" &&
        indirectMnemonics.has(insn.mnemonic) &&
        operand?.type === "reg" &&
        operand.value === state.reg
      ) {
        return { kind: "vtable", metadataOffset: state.offset / Process.pointerSize };
      }
      return { kind: "unknown" };
    }
    const load = asMemLoad(insn);
    const isSelfRedirect = load !== null && load.base === selfReg && load.dest === selfReg && load.disp === 0;
    if (isSelfRedirect) {
      cursor = insn.next;
      continue;
    }
    if (state.phase === "seekingMetadata" && load !== null && load.base === selfReg && load.disp === 0) {
      state = { phase: "haveMetadata", reg: load.dest };
    } else if (
      state.phase === "haveMetadata" &&
      load !== null &&
      load.base === state.reg &&
      load.disp !== 0 &&
      load.disp % Process.pointerSize === 0
    ) {
      // arm64e loads the slot into a fresh register (`ldr x8, [x16, #off]!`); arm64/x64 reuse the
      // metadata register. Track whichever holds the slot.
      state = { phase: "haveSlot", reg: load.dest, offset: load.disp };
    } else if (
      state.phase !== "seekingMetadata" &&
      (isArm64AuthInPlace(insn.mnemonic) || (insn as Arm64Instruction | X86Instruction).operands[0]?.value !== state.reg)
    ) {
      // A scratch instruction that doesn't overwrite the tracked register (the arm64e auth sequence)
      // — keep the chain rather than resetting.
    } else {
      state = { phase: "seekingMetadata" };
    }
    cursor = insn.next;
  }
  return { kind: "unknown" };
}

// conformingType may be a subclass reusing an inherited conformance, so the resolved target must
// be its own live slot, not class-descriptor.ts's static declaredImpl (only accurate for the class
// that itself declared or overrode the method).
function resolveVTableTarget(table: WitnessTable, metadataOffset: number): NativePointer | null {
  try {
    const classMetadata = new ClassMetadata(table.conformingType.handle);
    const hasVTableSlot = readVTableChain(classMetadata).some((e) => e.metadataOffset === metadataOffset);
    return hasVTableSlot ? classMetadata.handle.add(metadataOffset * Process.pointerSize).readPointer().strip() : null;
  } catch {
    return null;
  }
}

export type WitnessOrigin =
  | { kind: "default"; symbol: string; dispatch: "direct" | "vtable" }
  | { kind: "override"; symbol: string; dispatch: "direct" | "vtable" }
  | { kind: "unknown" };

const EXTENSION_PREFIX = /^\(extension in [^)]*\):/;

function witnessTarget(
  table: WitnessTable,
  requirement: ProtocolRequirement
): { address: NativePointer; dispatch: "direct" | "vtable" } | null {
  if (requirement.isAsync) {
    return null;
  }
  const branch = classifyBranch(table.requirement(requirement.witnessIndex));
  const address =
    branch.kind === "direct"
      ? branch.target
      : branch.kind === "vtable"
        ? resolveVTableTarget(table, branch.metadataOffset)
        : null;
  return address === null ? null : { address, dispatch: branch.kind === "vtable" ? "vtable" : "direct" };
}

export function classifyWitnessOrigin(table: WitnessTable, requirement: ProtocolRequirement): WitnessOrigin {
  if (requirement.isAsync || !CALLABLE_REQUIREMENT_KINDS.has(requirement.kind)) {
    return { kind: "unknown" };
  }
  const target = witnessTarget(table, requirement);
  if (target === null) {
    return { kind: "unknown" };
  }
  const demangled = symbolicate(target.address)?.demangled ?? null;
  if (demangled === null) {
    return { kind: "unknown" };
  }
  const unwrapped = demangled.replace(EXTENSION_PREFIX, "");
  const protocolName = protocolOf(table).fullTypeName;
  const { dispatch } = target;
  return unwrapped.startsWith(`${protocolName}.`)
    ? { kind: "default", symbol: demangled, dispatch }
    : { kind: "override", symbol: demangled, dispatch };
}


import { Metadata, MetadataKind, getMetadata } from "../abi/metadata.js";
import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { ClassMetadata } from "../abi/class-metadata.js";
import { readVTableChain } from "../abi/class-descriptor.js";
import { ClassInstance } from "../abi/heap-object.js";
import { asSwiftObject, SwiftObject, SwiftValueObject, SwiftField, RAW } from "./object-facade.js";
import { ValueInstance } from "../abi/value.js";
import { readValue, writeValue, embedsManagedReference, SwiftValue } from "../abi/instance.js";
import { readEnumCase, projectEnumData, projectBox } from "../abi/enum.js";
import { enumerateTupleElements } from "../abi/tuple.js";
import { findType } from "../reflection/registry.js";
import { demangle } from "./demangle.js";
import {
  parseSwiftSignature,
  parseFunctionTypeSpelling,
  FunctionTypeSpelling,
  voidMetadata,
  resolveType,
  resolveTypeExpr,
  hasOpaqueLayout,
  ParamLayout,
  splitBoundTypeName,
  SwiftFunctionSignature,
  GenericRequirement,
  SwiftAccessorSignature,
  ParsedSwiftSignature,
  splitTopLevel,
  splitParamConvention,
  ParamConvention,
} from "./symbolication.js";
import {
  makeSwiftNativeFunction,
  SwiftNativeFunction,
  SwiftArgType,
  shouldPassIndirectly,
  loweredScalars,
  ArgumentAllocator,
  LoweredScalar,
  RegisterLocation,
  indirect,
  argumentRegisterUse,
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
import { exportsByPrefix, PrefixedExport } from "./export-trie.js";
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
import { metadataOf } from "./swift-type.js";

export type MethodKind = "method" | "init";

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

export interface SwiftBoundMethod {
  readonly address: NativePointer;
  readonly origin: MemberOrigin;
  call(...args: CallArg[]): CallResult | Promise<CallResult>;
}

interface ResolvedBoundMethod {
  readonly address: NativePointer;
  readonly origin?: MemberOrigin;
  call(...args: CallArg[]): CallResult | Promise<CallResult>;
}

export function narrowBoundMethod(binder: ResolvedBoundMethod, receiver?: RawInstance): SwiftBoundMethod {
  return {
    address: binder.address,
    origin: binder.origin!,
    call: (...args) => {
      receiver?.checkLive(); // roots the receiver past its GC release and rejects a disposed one
      return binder.call(...args);
    },
  };
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

export interface ResolvedMethod {
  address: NativePointer;
  argTypes: Metadata[];
  returnType: Metadata | null;
  throws: boolean;
  isStatic: boolean;
  selector: string;
  async?: boolean;
  asyncFunctionPointer?: AsyncFunctionPointer;
  witnessSelf?: WitnessTable;
  witnessTables?: NativePointer[];
  abstractArgs?: boolean[];
  abstractReturn?: boolean;
  argConventions?: ParamConvention[];
  origin?: MemberOrigin;
}

interface BaseResolveOptions {
  arity?: number;
  labels?: (string | null)[]; // null = unlabelled
  argTypes?: string[]; // exact match against the signature's demangled argument-type names
  returnType?: string | null; // exact match against the demangled return-type name; null = Void
  static?: boolean;
}

export interface MethodResolveOptions extends BaseResolveOptions {
  typeArguments?: SwiftType[]; // one entry per generic parameter
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

export function lowerResolveOptions(stable: ValueMethodResolveOptions): RawValueMethodResolveOptions {
  const { arity, labels, argTypes, returnType, static: isStatic, self, typeArguments } = stable;
  const raw: RawValueMethodResolveOptions = { arity, labels, argTypes, returnType, static: isStatic, self };
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
  typeName: string;
  isStatic: boolean;
  constraints: string[];
}

interface TypeMembers {
  methods: MethodCandidate[];
  accessors: AccessorCandidate[];
}

const tableCache = new Map<string, TypeMembers>();
const invokerCache = new Map<string, SwiftNativeFunction>();

function rawArg(value: CallArg): CallArg | ClassInstance | ValueInstance {
  return value !== null && typeof value === "object"
    ? (value as { [RAW]?: ClassInstance | ValueInstance })[RAW] ?? value
    : value;
}

function assertClassAssignable(arg: ClassInstance, declared: Metadata): void {
  const declaredClass =
    declared.kind === MetadataKind.ObjCClassWrapper ? declared.handle.add(Process.pointerSize).readPointer().strip() : declared.handle;
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
function decodeReturn(returnType: Metadata | null, ret: NativePointer | null): CallResult {
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

function splitParams(argTypeNames: string[]): { types: string[]; conventions: ParamConvention[] } {
  const params = argTypeNames.map(splitParamConvention);
  return { types: params.map((p) => p.type), conventions: params.map((p) => p.convention) };
}

function sequenceEqual<T>(actual: T[], wanted: T[]): boolean {
  return actual.length === wanted.length && actual.every((value, i) => value === wanted[i]);
}

function applyOverloadFilters<T extends { isStatic: boolean; signature: SwiftFunctionSignature }>(
  candidates: T[],
  options: RawMethodResolveOptions
): T[] {
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
  const descriptor = findType(typeName.replace(RUNTIME_ANONYMOUS_CONTEXT, ""));
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
  for (const e of module.enumerateExports()) {
    if (e.name.includes(token)) {
      return true;
    }
  }
  for (const s of module.enumerateSymbols()) {
    if (s.name.includes(token)) {
      return true;
    }
  }
  return false;
}

const exportScans = new Map<string, ModuleExportScan>();
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

interface ModuleExportScan {
  scannedTokens: Set<string>;
  exportsByToken: Map<string, PrefixedExport[]>;
}

// Only the tokens a module actually exports under are kept, so the common "nothing here" answer
// costs one set lookup per target and allocates nothing.
function forEachExportedMembers(
  module: Module,
  targets: MemberTarget[],
  mayName: SymbolFilter | null,
  visit: (targetIndex: number, members: TypeMembers) => void
): void {
  const moduleKey = `${module.path}@${module.base}`;
  let scan = exportScans.get(moduleKey);
  if (scan === undefined) {
    scan = { scannedTokens: new Set(), exportsByToken: new Map() };
    exportScans.set(moduleKey, scan);
  }
  const { scannedTokens, exportsByToken } = scan;
  const pending = targets.filter((t) => !scannedTokens.has(t.token));
  if (pending.length > 0) {
    const found = exportsByPrefix(module, pending.map((t) => `$s${t.token}`));
    pending.forEach((target, i) => {
      scannedTokens.add(target.token);
      if (found[i].length > 0) {
        exportsByToken.set(target.token, found[i]);
      }
    });
  }
  if (exportsByToken.size === 0) {
    return;
  }
  targets.forEach((target, i) => {
    const exports = exportsByToken.get(target.token);
    if (exports === undefined) {
      return;
    }
    if (mayName !== null) {
      visit(i, membersAmong(exports.filter((e) => mayName(e.name)), target));
      return;
    }
    const key = `${moduleKey}|${target.token}`;
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

export interface InstanceMemberKinds {
  method: boolean;
  property: boolean;
  writable: boolean;
}

export function instanceMemberKindsInOtherModules(typeName: string, name: string): InstanceMemberKinds {
  const fullName = canonicalTypeName(typeName);
  const mayName = symbolMayName(name);
  const found: InstanceMemberKinds = { method: false, property: false, writable: false };
  const consider = (members: TypeMembers, isMethod: (c: MethodCandidate) => boolean): void => {
    found.method ||= members.methods.some((c) => c.name === name && isMethod(c));
    found.property ||= members.accessors.some((a) => a.member === name && !a.isStatic);
    found.writable ||= members.accessors.some((a) => a.member === name && !a.isStatic && a.kind === "setter");
  };
  const isInstanceMethod = (c: MethodCandidate): boolean => !c.isStatic && methodKind(c.name) === "method";
  for (const className of classChainNames(fullName)) {
    consider(foreignMembers(className, mayName), isInstanceMethod);
  }
  for (const conformance of conformanceMembers(fullName, mayName)) {
    consider(conformance.members, (c) => isConformanceMethod(c) && isInstanceMethod(c));
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
  let members = scanMembers([module], fullName, token, true);
  if (token !== null && members.methods.length === 0 && members.accessors.length === 0) {
    members = scanMembers([module], fullName, null, true);
  }
  tableCache.set(fullName, members);
  return members;
}

function scanMembers(
  modules: Module[],
  fullName: string,
  token: string | null,
  withSymbols: boolean
): TypeMembers {
  const members: TypeMembers = { methods: [], accessors: [] };
  const seen = new Set<string>();
  // initsOnly restricts the symbol-table pass to initializers: value-type inits are omitted from the
  // export trie in non-library-evolution builds, but regular non-exported methods stay reachable only
  // via the vtable, not the symbol route. The export trie carries everything else.
  const consider = (name: string, address: NativePointer, initsOnly: boolean): void => {
    if (token === null || name.includes(token)) {
      considerMember(members, seen, fullName, name, address, initsOnly, false);
    }
  };
  for (const module of modules) {
    for (const e of module.enumerateExports()) {
      consider(e.name, e.address, false);
    }
    if (!withSymbols) {
      continue;
    }
    for (const s of module.enumerateSymbols()) {
      consider(s.name, s.address, true);
    }
  }
  return members;
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
  const demangled = demangle(name)?.replace(PRIVATE_DECL_NAME, "$1") ?? null;
  if (demangled === null) {
    return;
  }
  if (!demangled.includes(fullName)) {
    return;
  }
  const signature = parseSwiftSignature(demangled);
  if (signature === null) {
    return;
  }
  if (signature.kind === "function") {
    if (initsOnly && signature.name !== "init") {
      return;
    }
    const { context, isStatic, constraints } = memberContext(signature.context, withConstrainedExtensions);
    if (context === fullName) {
      members.methods.push({ address, name: signature.name, mangled: name, isStatic, signature, constraints });
    }
  } else if (!initsOnly) {
    const { context, isStatic, constraints } = memberContext(signature.context, withConstrainedExtensions);
    if (context === fullName) {
      members.accessors.push({ address, member: signature.member, kind: signature.kind, typeName: signature.typeName, isStatic, constraints });
    }
  }
}

// A constrained protocol extension's members demangle under `P< where A: Q, A.T == U>`.
function memberContext(
  context: string,
  withConstrainedExtensions: boolean
): { context: string; isStatic: boolean; constraints: string[] } {
  const receiver = stripReceiverKeyword(context);
  const constrained = withConstrainedExtensions ? /^([^<]*)< where (.*)>$/.exec(receiver.context) : null;
  return constrained === null
    ? { ...receiver, constraints: [] }
    : { context: constrained[1], isStatic: receiver.isStatic, constraints: splitTopLevel(constrained[2], ",") };
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
    const key = `${c.isStatic ? "s" : "i"}:${c.signature.selector}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    methods.push({
      name: c.name,
      kind: methodKind(c.name),
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
  origin: MemberOrigin;
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
  const { signature } = candidates[0];
  const address = candidates[0].address.strip();
  return { address, selector: signature.selector, generic: signature.genericParams.length > 0, origin: memberOrigin(address, fullName) };
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
    const params = splitParams(signature.argTypeNames);
    const address = candidates[0].address.strip();
    const argTypes = params.types.map((name) => {
      const metadata = resolveTypeExpr(name, () => null);
      if (metadata === null) {
        throw new Error(`cannot resolve argument type ${name} of ${signature.selector}`);
      }
      return metadata;
    });
    let returnType: Metadata | null = null;
    if (signature.returnTypeName !== null) {
      returnType = resolveTypeExpr(signature.returnTypeName, () => null);
      if (returnType === null) {
        throw new Error(`cannot resolve return type ${signature.returnTypeName} of ${signature.selector}`);
      }
    }
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
    return { address, argTypes, returnType, throws: signature.throws, isStatic, selector: signature.selector, async: signature.async, asyncFunctionPointer, argConventions: params.conventions, origin };
  }
  return null;
}

function passedByAddress(resolved: ResolvedMethod, i: number): boolean {
  return resolved.abstractArgs?.[i] === true || resolved.argConventions?.[i] === "inout";
}

function loweredArgTypes(resolved: ResolvedMethod): SwiftArgType[] {
  return resolved.argTypes.map((t, i) => (passedByAddress(resolved, i) ? indirect(t) : t));
}

// Keyed by full signature, not bare address: an index invocation must not reuse a symbol-route
// invoker built for different types at the same impl.
function instanceInvokerKey(resolved: ResolvedMethod): string {
  const ret = resolved.returnType === null ? "v" : `${resolved.returnType.handle}${resolved.abstractReturn ? "@" : ""}`;
  const args = resolved.argTypes.map((t, i) => `${t.handle}${passedByAddress(resolved, i) ? "@" : ""}`).join(",");
  const witness = resolved.witnessSelf === undefined ? "" : `|${resolved.witnessSelf.handle}`;
  return `${resolved.address}|self|${ret}|${args}|${resolved.throws ? "t" : "n"}${witness}`;
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

function invokerFor(resolved: ResolvedMethod): SwiftNativeFunction {
  const key = instanceInvokerKey(resolved);
  let fn = invokerCache.get(key);
  if (fn === undefined) {
    const returnType = resolved.returnType !== null && resolved.abstractReturn ? indirect(resolved.returnType) : resolved.returnType;
    fn = makeSwiftNativeFunction(resolved.address, returnType, loweredArgTypes(resolved), {
      hasSelf: true,
      throws: resolved.throws,
      ...witnessSelfArgs(resolved.witnessSelf, resolved.witnessTables),
    });
    invokerCache.set(key, fn);
  }
  return fn;
}

export class BoundMethod {
  private readonly fn: SwiftNativeFunction;

  constructor(
    readonly resolved: ResolvedMethod,
    private readonly self: NativePointer
  ) {
    this.fn = invokerFor(resolved);
  }

  get address(): NativePointer {
    return this.resolved.address;
  }

  get origin(): MemberOrigin | undefined {
    return this.resolved.origin;
  }

  get raw(): SwiftNativeFunction {
    return this.fn;
  }

  call(...args: CallArg[]): CallResult {
    const { argTypes, returnType } = this.resolved;
    if (args.length !== argTypes.length) {
      throw new Error(`${this.resolved.selector} expects ${argTypes.length} argument(s), got ${args.length}`);
    }
    return callMarshalled(argTypes, args, returnType, (argPtrs) => this.fn(this.self, ...argPtrs), this.resolved.argConventions);
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
  const allocator = new ArgumentAllocator(0, true);
  const placed = loweredScalars(returnType).map((scalar) => ({
    scalar,
    location: allocator.scalar(scalar) as RegisterLocation,
  }));
  return { kind: "scalars", placed, stride: returnType.valueWitnesses.stride };
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

function lowerAsyncArgs(resolved: ResolvedMethod, buffers: NativePointer[], result: AsyncResultShape | null): AsyncArgs {
  const { argTypes } = resolved;
  const lowered = new AsyncArgs(result?.kind === "indirect" ? 1 : 0);
  for (let i = 0; i < argTypes.length; i++) {
    if (passedByAddress(resolved, i)) {
      lowered.pushWord(buffers[i]);
    } else {
      lowered.push(argTypes[i], buffers[i]);
    }
  }
  return lowered;
}

// The settle reactions root the binder, so a keepalive stored here keeps the receiver's owning
// instance reachable for the whole flight — its GC release would free the object while a job
// referencing it sits queued on an executor thread.
export function rootAsyncReceiver<T>(binder: T, receiver: unknown): T {
  if (binder instanceof BoundAsyncMethod || binder instanceof GenericBoundAsyncMethod) {
    binder.receiverKeepalive = receiver;
  }
  return binder;
}

// Arg temps are borrowed for the whole async call, so they are destroyed on settle, not synchronously.
export class BoundAsyncMethod {
  readonly asyncFunctionPointer: AsyncFunctionPointer;
  receiverKeepalive: unknown = null;
  private readonly result: AsyncResultShape | null;

  constructor(
    readonly resolved: ResolvedMethod,
    private readonly self: NativePointer | null,
    private readonly selfRouting: SelfRouting = { indirect: true },
    private readonly executor: SerialExecutorRef | null = null,
    private readonly consumedSelf: Metadata | null = null
  ) {
    if (resolved.asyncFunctionPointer === undefined) {
      throw new Error(`${resolved.selector} is not async`);
    }
    this.asyncFunctionPointer = resolved.asyncFunctionPointer;
    const { returnType, abstractReturn } = resolved;
    this.result =
      returnType !== null && abstractReturn === true && returnType.valueWitnesses.size > 0
        ? { kind: "indirect", stride: returnType.valueWitnesses.stride }
        : asyncResultShape(returnType);
  }

  get address(): NativePointer {
    return this.resolved.address;
  }

  get origin(): MemberOrigin | undefined {
    return this.resolved.origin;
  }

  call(...args: CallArg[]): Promise<CallResult> {
    const { argTypes, returnType, throws } = this.resolved;
    if (args.length !== argTypes.length) {
      throw new Error(`${this.resolved.selector} expects ${argTypes.length} argument(s), got ${args.length}`);
    }
    const conventions = this.resolved.argConventions ?? [];
    const buffers = marshalArgsOrCleanup(argTypes, args, conventions);
    const cleanup = (): void => {
      destroyBorrowedTemps(argTypes, buffers, conventions);
    };
    const lowered = lowerAsyncArgs(this.resolved, buffers, this.result);
    const options: AsyncCallOptions = { throws };
    if (this.executor !== null) {
      options.onActor = this.executor;
    }
    const self = this.self !== null && this.consumedSelf !== null ? copyOfValue(this.consumedSelf, this.self) : this.self;
    const discardSelf = (): void => {
      if (self !== this.self) this.consumedSelf!.valueWitnesses.destroy(self!);
    };
    if (self !== null) {
      options.receiver = self;
      if (!this.selfRouting.indirect) {
        const stackSize = lowered.stackSize;
        lowered.push(this.selfRouting.receiver, self);
        if (this.selfRouting.bothWays === true && lowered.stackSize !== stackSize) {
          cleanup();
          discardSelf();
          const { selector } = this.resolved;
          const baseName = selector.split("(")[0];
          throw new Error(
            `${selector} on ${typeName(this.selfRouting.receiver)}: a trailing self past the async argument registers ` +
              `is only safe if the method takes it; call it as $method("${baseName}", { self: "borrowing" }).call(...), ` +
              `or { self: "mutating" } if it mutates`
          );
        }
      }
    }
    if (this.resolved.witnessSelf !== undefined) {
      const { conformingType, handle } = this.resolved.witnessSelf;
      for (const word of [conformingType.handle, ...(this.resolved.witnessTables ?? [handle])]) {
        lowered.pushWord(word);
      }
    }
    const { gp, fp } = lowered;
    if (fp.length > 0) {
      options.floatArgs = fp;
    }
    if (lowered.stackSize > 0) {
      options.stackArgs = lowered.stackWords();
    }
    if (this.result !== null) {
      options.result = this.result;
    }
    return callAsync(this.asyncFunctionPointer, gp, options).then(
      (ret) => {
        try {
          return decodeReturn(returnType, this.result === null ? null : ret);
        } finally {
          cleanup();
          void self; // the trampoline embeds its address; keep it allocated until settle
        }
      },
      (error) => {
        cleanup();
        throw error;
      }
    );
  }
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

  private boundTo(self: NativePointer | null): BoundMethod | BoundStaticMethod | BoundAsyncMethod {
    if (this.resolved.async === true) {
      return new BoundAsyncMethod(this.resolved, self);
    }
    return self === null ? new BoundStaticMethod(this.resolved) : new BoundMethod(this.resolved, self);
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
    async: true,
    asyncFunctionPointer: afp,
  };
}

function resolveSignatureTypes(
  signature: SwiftFunctionSignature
): { argTypes: Metadata[]; returnType: Metadata | null; argConventions: ParamConvention[] } {
  if (methodKind(signature.name) === "init") {
    throw new Error(
      `${signature.selector} is an initializer, which consumes its arguments; construct through Swift.type(...).init`
    );
  }
  const params = splitParams(signature.argTypeNames);
  const argTypes = params.types.map((name) => {
    const metadata = resolveTypeExpr(name, () => null);
    if (metadata === null) {
      throw new Error(`cannot resolve argument type ${name} of ${signature.selector}`);
    }
    return metadata;
  });
  let returnType: Metadata | null = null;
  if (signature.returnTypeName !== null) {
    returnType = resolveTypeExpr(signature.returnTypeName, () => null);
    if (returnType === null) {
      throw new Error(`cannot resolve return type ${signature.returnTypeName} of ${signature.selector}`);
    }
  }
  return { argTypes, returnType, argConventions: params.conventions };
}

function staticInvokerFor(resolved: ResolvedMethod): SwiftNativeFunction {
  const key = `${resolved.address}:static`;
  let fn = invokerCache.get(key);
  if (fn === undefined) {
    fn = makeSwiftNativeFunction(resolved.address, resolved.returnType, loweredArgTypes(resolved), {
      throws: resolved.throws,
    });
    invokerCache.set(key, fn);
  }
  return fn;
}

// Thin metatype: no self passed.
export class BoundStaticMethod {
  private readonly fn: SwiftNativeFunction;

  constructor(readonly resolved: ResolvedMethod) {
    this.fn = staticInvokerFor(resolved);
  }

  get address(): NativePointer {
    return this.resolved.address;
  }

  get origin(): MemberOrigin | undefined {
    return this.resolved.origin;
  }

  call(...args: CallArg[]): CallResult {
    const { argTypes, returnType } = this.resolved;
    if (args.length !== argTypes.length) {
      throw new Error(`${this.resolved.selector} expects ${argTypes.length} argument(s), got ${args.length}`);
    }
    return callMarshalled(argTypes, args, returnType, (argPtrs) => this.fn(...argPtrs), this.resolved.argConventions);
  }
}

export function bindStaticMethod(
  receiver: Metadata,
  name: string,
  options: RawMethodResolveOptions = {}
): BoundStaticMethod | BoundMethod | BoundAsyncMethod {
  const staticOptions = { ...options, static: true };
  const resolved = findMethod(typeName(receiver), name, staticOptions);
  if (resolved === null) {
    return bindConformanceMethod(typeName(receiver), receiver.handle, name, staticOptions);
  }
  return resolved.async === true ? new BoundAsyncMethod(resolved, null) : new BoundStaticMethod(resolved);
}

// A value-type initializer is self-less: the @thin metatype self is erased, so it lowers like a
// static factory returning the type (the +1/owned return is adopted as a ValueInstance). Init params are
// +1/consumed — the callee owns the arg temps, so they are not destroyed here. Mirrors ClassType.init.
export class BoundValueInitializer {
  private readonly fn: SwiftNativeFunction;

  constructor(readonly resolved: ResolvedMethod) {
    this.fn = staticInvokerFor(resolved);
  }

  get address(): NativePointer {
    return this.resolved.address;
  }

  call(...args: CallArg[]): SwiftValueObject | null {
    const { argTypes, returnType, selector } = this.resolved;
    if (returnType === null) {
      throw new Error(`${selector} is not a value initializer`);
    }
    if (args.length !== argTypes.length) {
      throw new Error(`${selector} expects ${argTypes.length} argument(s), got ${args.length}`);
    }
    const conventions = argTypes.map((_, i): ParamConvention => (this.resolved.argConventions?.[i] === "inout" ? "inout" : "owned"));
    const ret = this.fn(...marshalArgsOrCleanup(argTypes, args, conventions));
    if (ret === null) {
      throw new Error(`${selector} returned no value`);
    }
    // A failable initializer (`init?`) returns Optional<Self>.
    if (returnType.kind === MetadataKind.Optional) {
      const some = projectOptionalPayload(returnType, ret);
      return some === null ? null : asSwiftObject(ValueInstance.adopt(some.payloadType, some.address));
    }
    return asSwiftObject(ValueInstance.adopt(returnType, ret));
  }
}

export function bindValueInitializer(
  receiver: Metadata,
  options: RawMethodResolveOptions = {}
): BoundValueInitializer {
  return new BoundValueInitializer(resolveMethod(typeName(receiver), "init", options));
}

export type SelfRouting = { indirect: true } | { indirect: false; receiver: Metadata; bothWays?: boolean };

// Value-type self is indirect (x20) when mutating/inout or large/non-POD; else it rides as a trailing
// arg. Only a small loadable receiver's routing depends on `mutating`, which isn't recoverable from the
// symbol. Plain calls pass self both ways (valueInvoker, BoundAsyncMethod); generic ones can't, since a
// trailing self shifts the metadata args, so there it's probed from the callee or stated by the caller.
function valueSelfRouting(receiver: Metadata, selector: string, ownership: SelfOwnership | undefined): SelfRouting {
  if (shouldPassIndirectly(receiver)) {
    return { indirect: true };
  }
  if (ownership === undefined) {
    const baseName = selector.split("(")[0];
    throw new Error(
      `${selector} on small loadable ${typeName(receiver)}: self routing depends on whether it mutates; ` +
        `call it as $method("${baseName}", { self: "borrowing" }).call(...), or { self: "mutating" } if it mutates`
    );
  }
  return ownership === "mutating" ? { indirect: true } : { indirect: false, receiver };
}

// A small loadable self rides as trailing args if the method doesn't mutate, or by address in x20 if
// it does, and the symbol doesn't say which. Pass it both ways: each callee reads only its own, and the
// other is an unused arg or a callee-saved register.
function valueInvoker(resolved: ResolvedMethod, receiver: Metadata): SwiftNativeFunction {
  const key = `${resolved.address}:value-self`;
  let fn = invokerCache.get(key);
  if (fn === undefined) {
    const argTypes = shouldPassIndirectly(receiver) ? loweredArgTypes(resolved) : [...loweredArgTypes(resolved), receiver];
    fn = makeSwiftNativeFunction(resolved.address, resolved.returnType, argTypes, {
      hasSelf: true,
      throws: resolved.throws,
    });
    invokerCache.set(key, fn);
  }
  return fn;
}

export class BoundValueMethod {
  private readonly fn: SwiftNativeFunction;
  private readonly trailingSelf: boolean;

  constructor(
    readonly resolved: ResolvedMethod,
    private readonly receiver: Metadata,
    private readonly self: NativePointer,
    private readonly consuming: boolean
  ) {
    this.trailingSelf = !shouldPassIndirectly(receiver);
    this.fn = valueInvoker(resolved, receiver);
  }

  get address(): NativePointer {
    return this.resolved.address;
  }

  get origin(): MemberOrigin | undefined {
    return this.resolved.origin;
  }

  call(...args: CallArg[]): CallResult {
    const { argTypes, returnType } = this.resolved;
    if (args.length !== argTypes.length) {
      throw new Error(`${this.resolved.selector} expects ${argTypes.length} argument(s), got ${args.length}`);
    }
    return callMarshalled(
      argTypes,
      args,
      returnType,
      (argPtrs) => {
        const self = this.consuming ? copyOfValue(this.receiver, this.self) : this.self;
        return this.trailingSelf ? this.fn(self, ...argPtrs, self) : this.fn(self, ...argPtrs);
      },
      this.resolved.argConventions
    );
  }
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

export function bindValueMethod(
  receiver: Metadata,
  self: NativePointer,
  name: string,
  options: RawValueMethodResolveOptions = {}
): BoundValueMethod | BoundMethod | BoundAsyncMethod {
  const resolved = findMethod(typeName(receiver), name, options);
  if (resolved === null) {
    return bindConformanceMethod(typeName(receiver), self, name, options);
  }
  if (resolved.async !== true) {
    return new BoundValueMethod(resolved, receiver, self, options.self === "consuming");
  }
  // Both ways unless self is stated. An async callee pops its own stack args, so a guessed trailing self must fit in registers.
  const routing = valueSelfRouting(receiver, resolved.selector, options.self ?? "borrowing");
  if (!routing.indirect && options.self === undefined) {
    routing.bothWays = true;
  }
  return new BoundAsyncMethod(resolved, self, routing, null, consumedSelf(receiver, options));
}

// buffer: (UnsafeRawBufferPointer) -> @out, via an asm trampoline. loadable: register params and
// result. loadableIndirect: register params, @out result (e.g. (Int) -> R).
type ClosureShape =
  | { mode: "buffer" }
  | { mode: "loadable"; params: LoadableScalar[]; result: LoadableScalar | null; throws: boolean }
  | { mode: "loadableIndirect"; params: LoadableScalar[]; resultMetadata: Metadata; throws: boolean };

type ArgPlan =
  | { kind: "generic"; index: number; metadata: Metadata }
  | { kind: "concrete"; metadata: Metadata }
  | { kind: "abstractIndirect"; metadata: Metadata }
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
  spelling: FunctionTypeSpelling,
  genericParams: string[],
  typeArguments: Metadata[],
  classBoundParams: Set<string>
): ArgPlan {
  const result = spelling.result.trim();
  const resultIsReference = classBoundParams.has(result);
  const resultIsGeneric = genericParams.includes(result) && !resultIsReference;
  const resultIsVoid = result === "()" || result === "Swift.Void";
  const takesBuffer = spelling.params.length === 1 && spelling.params[0].trim() === RAW_BUFFER_PARAM;
  if ((spelling.params.length === 0 || takesBuffer) && (resultIsVoid || resultIsGeneric)) {
    const paramTokens = takesBuffer ? [RAW_BUFFER_TOKEN] : [];
    const resultTokens = resultIsGeneric ? [INDIRECT] : [];
    return closurePlan(paramTokens, resultTokens, { mode: "buffer" });
  }

  const params = spelling.params.map((p) => LOADABLE_SCALARS[p.trim()] ?? null);
  if (params.every((p) => p !== null)) {
    const scalars = params as LoadableScalar[];
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
    `unsupported closure type (${spelling.params.join(", ")}) -> ${result}; supported: () or (${RAW_BUFFER_PARAM}) returning Void or a generic, or loadable scalars (${Object.keys(LOADABLE_SCALARS).join(", ")}) returning a scalar, Void, or a generic`
  );
}

// A class-bound generic parameter lowers as a bare reference, not address-only.
function planGenericType(
  name: string,
  genericParams: string[],
  typeArguments: Metadata[],
  classBoundParams: Set<string>
): ArgPlan {
  const fn = parseFunctionTypeSpelling(name);
  if (fn !== null) {
    return planClosureType(fn, genericParams, typeArguments, classBoundParams);
  }
  const index = genericParams.indexOf(name);
  if (index !== -1) {
    const metadata = typeArguments[index];
    if (metadata === undefined) {
      throw new Error(`missing type argument for generic parameter ${name}`);
    }
    return classBoundParams.has(name) ? { kind: "concrete", metadata } : { kind: "generic", index, metadata };
  }
  const concrete = resolveType(name);
  if (concrete !== null) {
    return { kind: "concrete", metadata: concrete };
  }
  return planCompoundType(name, genericParams, typeArguments, classBoundParams);
}

function planCompoundType(
  expr: string,
  genericParams: string[],
  typeArguments: Metadata[],
  classBoundParams: Set<string>
): ArgPlan {
  const metadata = resolveTypeExpr(expr, (name) => {
    const i = genericParams.indexOf(name);
    return i === -1 ? null : typeArguments[i] ?? null;
  });
  if (metadata === null) {
    throw new Error(`cannot resolve generic signature type ${expr}`);
  }
  return compoundIsAddressOnly(expr, genericParams, classBoundParams)
    ? { kind: "abstractIndirect", metadata }
    : { kind: "concrete", metadata };
}

// Accepts the demangler's desugared spelling (Swift.Array<A>) and the sugared one ([A]). Array/Set/
// Dictionary are a fixed-layout buffer (direct); Optional<param> embeds the abstract param (indirect)
// unless the param is class-bound, which makes it a nullable reference.
function compoundIsAddressOnly(expr: string, genericParams: string[], classBoundParams: Set<string>): boolean {
  const t = expr.trim();
  if (t.endsWith("?") || t.endsWith("!")) {
    return optionalIsAddressOnly(t.slice(0, -1), genericParams, classBoundParams, expr);
  }
  if (t.startsWith("[") && t.endsWith("]")) {
    return false;
  }
  const lt = t.indexOf("<");
  if (lt !== -1 && t.endsWith(">")) {
    const base = t.slice(0, lt);
    if (base === "Swift.Array" || base === "Swift.Dictionary" || base === "Swift.Set") {
      return false;
    }
    if (base === "Swift.Optional") {
      return optionalIsAddressOnly(t.slice(lt + 1, -1), genericParams, classBoundParams, expr);
    }
  }
  throw new Error(`unsupported compound generic signature type ${expr} (only [T], [K: V] and T? are supported)`);
}

function optionalIsAddressOnly(
  payload: string,
  genericParams: string[],
  classBoundParams: Set<string>,
  expr: string
): boolean {
  if (genericParams.includes(payload.trim())) {
    return !classBoundParams.has(payload.trim());
  }
  throw new Error(`unsupported compound generic signature type ${expr} (Optional payload must be a generic parameter)`);
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

export interface GenericMethodPlan {
  address: NativePointer;
  selector: string;
  argPlans: ArgPlan[];
  returnPlan: ArgPlan | null;
  throws: boolean;
  async: boolean;
  asyncFunctionPointer?: AsyncFunctionPointer;
  typeArguments: Metadata[];
  witnessTables: NativePointer[];
  argConventions: ParamConvention[];
  origin: MemberOrigin;
}

interface PlannedArgs {
  ptrs: NativePointer[];
  closures: (SwiftClosure | null)[]; // referenced through the call: Swift invokes them in-flight
  destroyBorrowedTemps(): void;
}

function marshalPlannedArgs(plan: GenericMethodPlan, args: CallArg[]): PlannedArgs {
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

// Type-metadata + witness pointers trail the formal args, so a trailing-exploded value self lands
// before them; indirect self rides in x20 (hasSelf).
export class GenericBoundMethod {
  private readonly fn: SwiftNativeFunction;
  private readonly indirectSelf: boolean;
  readonly address: NativePointer;
  readonly selector: string;
  readonly origin: MemberOrigin;

  constructor(
    private readonly plan: GenericMethodPlan,
    private readonly self: NativePointer,
    routing: SelfRouting,
    private readonly consumedSelf: Metadata | null = null
  ) {
    this.address = plan.address;
    this.selector = plan.selector;
    this.origin = plan.origin;
    this.indirectSelf = routing.indirect;
    const returnType = plan.returnPlan === null ? null : swiftArgType(plan.returnPlan);
    const argTypes = plan.argPlans.map(swiftArgType);
    const opts = { throws: plan.throws, typeArguments: plan.typeArguments, witnessTables: plan.witnessTables };
    this.fn = routing.indirect
      ? makeSwiftNativeFunction(plan.address, returnType, argTypes, { hasSelf: true, ...opts })
      : makeSwiftNativeFunction(plan.address, returnType, [...argTypes, routing.receiver], opts);
  }

  call(...args: CallArg[]): CallResult {
    const plans = this.plan.argPlans;
    if (args.length !== plans.length) {
      throw new Error(`${this.selector} expects ${plans.length} argument(s), got ${args.length}`);
    }
    const marshalled = marshalPlannedArgs(this.plan, args);
    const argPtrs = marshalled.ptrs;
    const returnType = this.plan.returnPlan === null ? null : planMetadata(this.plan.returnPlan);
    try {
      const self = this.consumedSelf === null ? this.self : copyOfValue(this.consumedSelf, this.self);
      const ret = this.indirectSelf ? this.fn(self, ...argPtrs) : this.fn(...argPtrs, self);
      return decodeReturn(returnType, ret);
    } finally {
      marshalled.destroyBorrowedTemps();
    }
  }
}

// A generic return is address-only (@out), even when the concrete type would ride registers.
function genericAsyncResultShape(returnPlan: ArgPlan | null): AsyncResultShape | null {
  if (returnPlan === null) {
    return null;
  }
  const metadata = planMetadata(returnPlan);
  if (returnPlan.kind === "generic" || returnPlan.kind === "abstractIndirect") {
    return metadata.valueWitnesses.size === 0 ? null : { kind: "indirect", stride: metadata.valueWitnesses.stride };
  }
  return asyncResultShape(metadata);
}

// Like BoundAsyncMethod, but generic/abstract params are @in pointers, and type-metadata + witnesses
// trail the formal args and any trailing value self.
export class GenericBoundAsyncMethod {
  readonly address: NativePointer;
  readonly selector: string;
  readonly origin: MemberOrigin;
  readonly asyncFunctionPointer: AsyncFunctionPointer;
  receiverKeepalive: unknown = null;
  private readonly result: AsyncResultShape | null;

  constructor(
    private readonly plan: GenericMethodPlan,
    private readonly self: NativePointer,
    private readonly routing: SelfRouting,
    private readonly consumedSelf: Metadata | null = null
  ) {
    if (plan.asyncFunctionPointer === undefined) {
      throw new Error(`${plan.selector} is not async`);
    }
    this.address = plan.address;
    this.selector = plan.selector;
    this.origin = plan.origin;
    this.asyncFunctionPointer = plan.asyncFunctionPointer;
    this.result = genericAsyncResultShape(plan.returnPlan);
  }

  call(...args: CallArg[]): Promise<CallResult> {
    const plans = this.plan.argPlans;
    if (args.length !== plans.length) {
      throw new Error(`${this.selector} expects ${plans.length} argument(s), got ${args.length}`);
    }
    const marshalled = marshalPlannedArgs(this.plan, args);
    const { closures } = marshalled;
    const cleanup = (): void => {
      marshalled.destroyBorrowedTemps();
    };
    const lowered = new AsyncArgs(this.result?.kind === "indirect" ? 1 : 0);
    plans.forEach((plan, i) => {
      const closure = closures[i];
      if (closure !== null) {
        lowered.pushWord(closure.fnPointer);
        lowered.pushWord(closure.context);
      } else if (plan.kind === "generic" || plan.kind === "abstractIndirect") {
        lowered.pushWord(marshalled.ptrs[i]);
      } else {
        lowered.push(planMetadata(plan), marshalled.ptrs[i]);
      }
    });
    const self = this.consumedSelf === null ? this.self : copyOfValue(this.consumedSelf, this.self);
    const options: AsyncCallOptions = { throws: this.plan.throws };
    if (this.routing.indirect) {
      options.receiver = self;
    } else {
      lowered.push(this.routing.receiver, self);
    }
    for (const metadata of this.plan.typeArguments) {
      lowered.pushWord(metadata.handle);
    }
    for (const witnessTable of this.plan.witnessTables) {
      lowered.pushWord(witnessTable);
    }
    const { gp, fp } = lowered;
    if (fp.length > 0) {
      options.floatArgs = fp;
    }
    if (lowered.stackSize > 0) {
      options.stackArgs = lowered.stackWords();
    }
    if (this.result !== null) {
      options.result = this.result;
    }
    const returnType = this.plan.returnPlan === null ? null : planMetadata(this.plan.returnPlan);
    return callAsync(this.asyncFunctionPointer, gp, options).then(
      (ret) => {
        try {
          return decodeReturn(returnType, this.result === null ? null : ret);
        } finally {
          cleanup();
          void self; // the trampoline embeds its address; keep it allocated until settle
          void closures;
        }
      },
      (error) => {
        cleanup();
        throw error;
      }
    );
  }
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
  for (const argName of signature.argTypeNames) {
    const fn = parseFunctionTypeSpelling(argName);
    if (fn !== null && signature.genericParams.includes(fn.result.trim())) {
      closureResultParams.add(fn.result.trim());
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
    : signature.argTypeNames.some((n) => parseFunctionTypeSpelling(n) !== null);
}

function planGenericMethod(typeNameArg: string, methodName: string, options: RawMethodResolveOptions): GenericMethodPlan {
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
  const params = splitParams(signature.argTypeNames);
  const classBoundParams = new Set(
    signature.conformanceRequirements.filter((r) => requirementBound(r).classBound).map((r) => r.subject)
  );
  const argPlans = params.types.map((n, i) =>
    planParam(planGenericType(n, signature.genericParams, resolvedTypeArguments, classBoundParams), params.conventions[i], signature.selector)
  );
  const returnPlan =
    signature.returnTypeName === null
      ? null
      : planGenericType(signature.returnTypeName, signature.genericParams, resolvedTypeArguments, classBoundParams);
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
  return { address, selector: signature.selector, argPlans, returnPlan, throws: signature.throws, async: signature.async, asyncFunctionPointer, typeArguments: resolvedTypeArguments, witnessTables, argConventions: params.conventions, origin };
}

export function bindGenericMethod(
  typeName: string,
  methodName: string,
  self: NativePointer,
  options: RawMethodResolveOptions = {}
): GenericBoundMethod | GenericBoundAsyncMethod {
  const plan = planGenericMethod(typeName, methodName, options);
  const routing: SelfRouting = { indirect: true };
  return plan.async ? new GenericBoundAsyncMethod(plan, self, routing) : new GenericBoundMethod(plan, self, routing);
}

// Unless stated, a small loadable self's ownership is read off which layout the callee uses: a
// borrowing self trails the formal args, ahead of the implicit ones; a mutating self rides in x20.
function genericValueSelfRouting(
  receiver: Metadata,
  plan: GenericMethodPlan,
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
  plan: GenericMethodPlan,
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
): GenericBoundMethod | GenericBoundAsyncMethod {
  const plan = planGenericMethod(typeName(receiver), methodName, options);
  const implicitWords = plan.typeArguments.length + plan.witnessTables.length;
  const routing = genericValueSelfRouting(receiver, plan, options.self, { trailingSelf: implicitWords, selfInRegister: implicitWords });
  const consumed = consumedSelf(receiver, options);
  return plan.async
    ? new GenericBoundAsyncMethod(plan, self, routing, consumed)
    : new GenericBoundMethod(plan, self, routing, consumed);
}

// A bare type parameter (T) is address-only in the generic context, unless class-bound, but concretely
// sized by the instance's type argument; concrete and compound types lower as elsewhere.
function planTypeMemberArg(
  name: string,
  typeParams: string[],
  typeArguments: Metadata[],
  classBoundParams: Set<string>
): ArgPlan {
  const index = typeParams.indexOf(name.trim());
  if (index !== -1) {
    const metadata = typeArguments[index];
    return classBoundParams.has(name.trim()) ? { kind: "concrete", metadata } : { kind: "abstractIndirect", metadata };
  }
  const concrete = resolveType(name);
  if (concrete !== null) {
    return { kind: "concrete", metadata: concrete };
  }
  return planCompoundType(name, typeParams, typeArguments, classBoundParams);
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
  const { base, arguments: argNames } = splitBoundTypeName(typeName(receiver));
  const typeArguments = argNames.map((n) => {
    const metadata = resolveTypeExpr(n, () => null);
    if (metadata === null) {
      throw new Error(`cannot resolve type argument ${n} of ${base}`);
    }
    return metadata;
  });
  return { unboundName: base, typeParams: typeArguments.map((_, i) => String.fromCharCode(65 + i)), typeArguments };
}

// Methods on a generic type, no method-level generics. self is indirect (class: object in x20;
// value: its bytes, address-only in the generic context). A value type trails its Self metadata
// — the callee reads T's metadata + witnesses from that vector; a class recovers them from the isa.
// A value type whose layout is fixed in the generic context is routed by bindGenericTypeValueMethod.
function planGenericTypeMethod(receiver: Metadata, methodName: string, options: RawMethodResolveOptions, trailsSelfMetadata: boolean): GenericMethodPlan {
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
  const params = splitParams(signature.argTypeNames);
  const classBound = classBoundTypeParams(findType(unboundName)!, typeParams);
  const argPlans = params.types.map((n, i) =>
    planParam(planTypeMemberArg(n, typeParams, typeArguments, classBound), params.conventions[i], signature.selector)
  );
  const returnPlan =
    signature.returnTypeName === null
      ? null
      : planTypeMemberArg(signature.returnTypeName, typeParams, typeArguments, classBound);
  let asyncFunctionPointer: AsyncFunctionPointer | undefined;
  if (signature.async) {
    const module = Process.findModuleByAddress(address.strip());
    asyncFunctionPointer = module === null ? undefined : findAsyncFunctionPointer(module, mangled) ?? undefined;
    if (asyncFunctionPointer === undefined) {
      throw new Error(`cannot resolve async function pointer for ${signature.selector}`);
    }
  }
  return {
    address,
    selector: signature.selector,
    argPlans,
    returnPlan,
    throws: signature.throws,
    async: signature.async,
    asyncFunctionPointer,
    typeArguments: trailsSelfMetadata ? [receiver] : [],
    witnessTables: [],
    argConventions: params.conventions,
    origin: memberOrigin(address, unboundName),
  };
}

export function bindGenericTypeValueMethod(
  receiver: Metadata,
  self: NativePointer,
  methodName: string,
  options: RawValueMethodResolveOptions = {}
): GenericBoundMethod | GenericBoundAsyncMethod {
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
  const consumed = consumedSelf(receiver, options);
  return plan.async
    ? new GenericBoundAsyncMethod(plan, self, routing, consumed)
    : new GenericBoundMethod(plan, self, routing, consumed);
}

export function bindGenericTypeClassMethod(
  receiver: Metadata,
  self: NativePointer,
  methodName: string,
  options: RawMethodResolveOptions = {}
): GenericBoundMethod | GenericBoundAsyncMethod {
  const plan = planGenericTypeMethod(receiver, methodName, options, false);
  return plan.async
    ? new GenericBoundAsyncMethod(plan, self, { indirect: true })
    : new GenericBoundMethod(plan, self, { indirect: true });
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
    // resolveTypeExpr, not a bare nominal lookup: an accessor type can be generic (`Int?`, `[Int]`, …).
    const type = resolveTypeExpr(candidate.typeName, () => null);
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

function invokerForAccessor(accessor: ResolvedAccessor, selfByValue: Metadata | null): SwiftNativeFunction {
  const key = `${accessor.address}:${selfByValue === null ? "i" : "v"}`;
  let fn = invokerCache.get(key);
  if (fn === undefined) {
    if (accessor.kind === "setter") {
      fn = makeSwiftNativeFunction(accessor.address, null, [accessor.type], { hasSelf: true });
    } else if (selfByValue !== null) {
      fn = makeSwiftNativeFunction(accessor.address, accessor.type, [selfByValue], {});
    } else {
      fn = makeSwiftNativeFunction(accessor.address, accessor.type, [], { hasSelf: true });
    }
    invokerCache.set(key, fn);
  }
  return fn;
}

export function getProperty(self: NativePointer, typeName: string, member: string): CallResult {
  const accessor = findAccessor(typeName, member, "getter");
  if (accessor === null) {
    return conformanceGetProperty(canonicalTypeName(typeName), self, member);
  }
  return decodeReturn(accessor.type, invokerForAccessor(accessor, getterSelfByValue(typeName))(self));
}

// Self is the metatype: thick (the metadata) for a class or a protocol extension, erased for a value type.
export function getStaticProperty(receiver: Metadata, member: string): CallResult {
  const name = typeName(receiver);
  const accessor = findAccessor(name, member, "getter", true);
  if (accessor === null) {
    return conformanceGetProperty(canonicalTypeName(name), receiver.handle, member, true);
  }
  return decodeReturn(accessor.type, invokerForAccessor(accessor, null)(receiver.handle));
}

// Setter self is inout (mutating), so it stays indirect; newValue is +1/owned and the callee consumes
// the temp, so it is not destroyed here.
export function setProperty(self: NativePointer, typeName: string, member: string, value: CallArg): void {
  const accessor = resolveAccessor(typeName, member, "setter");
  invokerForAccessor(accessor, null)(self, marshalConsumedArgs([accessor.type], [value])[0]);
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
): BoundMethod | BoundAsyncMethod {
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
  return resolved.async === true ? new BoundAsyncMethod(resolved, receiver) : new BoundMethod(resolved, receiver);
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
  return decodeReturn(accessor.type, invokerForWitnessAccessor(accessor)(receiver));
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

const symbolsByModule = new Map<string, Map<string, string>>();

// Witness thunks are usually private linkage, invisible to symbolicate()'s exports-only lookup.
function symbolicateLocal(address: NativePointer): string | null {
  address = address.strip();
  const module = Process.findModuleByAddress(address.strip());
  if (module === null) {
    return null;
  }
  let names = symbolsByModule.get(module.path);
  if (names === undefined) {
    names = new Map<string, string>();
    for (const s of module.enumerateSymbols()) {
      names.set(s.address.strip().toString(), s.name);
    }
    symbolsByModule.set(module.path, names);
  }
  const name = names.get(address.toString());
  return name === undefined ? null : demangle(name);
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
    // Async is unlocked only for methods (driven via BoundAsyncMethod); an async accessor would be
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
      const demangled = symbolicateLocal(requirement.isAsync ? new AsyncFunctionPointer(slot).code : slot);
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
    signature.kind === WITNESS_KIND[requirement.kind] &&
    (context === conformingType.fullTypeName || context === protocol.fullTypeName)
  );
}

function witnessTargetSignature(table: WitnessTable, requirement: ProtocolRequirement): ParsedSwiftSignature | null {
  const target = witnessTarget(table, requirement);
  const demangled = target === null ? null : symbolicateLocal(target.address);
  return demangled === null ? null : parseSwiftSignature(demangled);
}

function witnessThunkSignature(table: WitnessTable, requirement: ProtocolRequirement): ParsedSwiftSignature | null {
  const slot = table.requirement(requirement.witnessIndex);
  const demangled = symbolicateLocal(requirement.isAsync ? new AsyncFunctionPointer(slot).code : slot);
  const stripped = demangled === null ? null : stripWitnessWrapper(demangled);
  return stripped === null ? null : parseSwiftSignature(stripped);
}

function resolveWitnessSignature(
  table: WitnessTable,
  signature: SwiftFunctionSignature,
  classBound: Set<string>
): Pick<ResolvedMethod, "argTypes" | "returnType" | "throws" | "selector" | "abstractArgs" | "abstractReturn" | "argConventions"> {
  const params = splitParams(signature.argTypeNames);
  const argTypes = params.types.map((name) => {
    const metadata = resolveTypeExpr(name, (n) => resolveWitnessSelfOrAssociatedType(table, n));
    if (metadata === null) {
      throw new Error(`cannot resolve argument type ${name} of ${signature.selector}`);
    }
    return metadata;
  });
  let returnType: Metadata | null = null;
  if (signature.returnTypeName !== null) {
    returnType = resolveTypeExpr(signature.returnTypeName, (n) => resolveWitnessSelfOrAssociatedType(table, n));
    if (returnType === null) {
      throw new Error(`cannot resolve return type ${signature.returnTypeName} of ${signature.selector}`);
    }
  }
  const isAbstract = protocolLevelOpaque(table, classBound);
  return {
    argTypes,
    returnType,
    throws: signature.throws,
    selector: signature.selector,
    abstractArgs: params.types.map(isAbstract),
    abstractReturn: signature.returnTypeName !== null && isAbstract(signature.returnTypeName),
    argConventions: params.conventions,
  };
}

export function bindWitnessMethod(
  table: WitnessTable,
  self: NativePointer,
  methodName: string
): BoundMethod | BoundAsyncMethod {
  const resolved = resolveWitnessMethod(table, methodName);
  return resolved.async === true ? new BoundAsyncMethod(resolved, self) : new BoundMethod(resolved, self);
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
  return new BoundMethod(resolved, self);
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
  return witnessAccessor(table, address, member, kind, match.signature.typeName, selfSignature(table, [])!);
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
  return witnessAccessor(table, address, member, kind, match.typeName, signature);
}

function witnessAccessor(
  table: WitnessTable,
  address: NativePointer,
  member: string,
  kind: AccessorKind,
  typeName: string,
  signature: SelfSignature
): ResolvedWitnessAccessor {
  const type = resolveTypeExpr(typeName, (n) => resolveWitnessSelfOrAssociatedType(table, n));
  if (type === null) {
    throw new Error(`cannot resolve ${kind} type ${typeName} of ${member}`);
  }
  const abstract = protocolLevelOpaque(table, signature.classBound)(typeName);
  return { address, type, kind, abstract, table, ...signature };
}

function protocolLevelOpaque(table: WitnessTable, signatureClassBound: Set<string>): (typeName: string) => boolean {
  const classBound = classBoundSubjects(protocolOf(table));
  for (const subject of signatureClassBound) {
    classBound.add(subject);
  }
  return (typeName) =>
    hasOpaqueLayout(typeName, (name): ParamLayout | null => {
      if (name !== "A" && !name.startsWith("A.")) {
        return null;
      }
      return classBound.has(name) ? "reference" : "opaque";
    });
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

function invokerForWitnessAccessor(accessor: ResolvedWitnessAccessor): SwiftNativeFunction {
  const key = `witness:${accessor.address}|${accessor.table.handle}`;
  let fn = invokerCache.get(key);
  if (fn === undefined) {
    const type: SwiftArgType = accessor.abstract ? indirect(accessor.type) : accessor.type;
    const options = { hasSelf: true, ...witnessSelfArgs(accessor.table, accessor.witnessTables) };
    fn =
      accessor.kind === "getter"
        ? makeSwiftNativeFunction(accessor.address, type, [], options)
        : makeSwiftNativeFunction(accessor.address, null, [type], options);
    invokerCache.set(key, fn);
  }
  return fn;
}

export function witnessGetProperty(table: WitnessTable, self: NativePointer, name: string): CallResult {
  const accessor = resolveWitnessAccessor(table, name, "getter");
  return decodeReturn(accessor.type, invokerForWitnessAccessor(accessor)(self));
}

export function witnessSetProperty(table: WitnessTable, self: NativePointer, name: string, value: CallArg): void {
  const accessor = resolveWitnessAccessor(table, name, "setter");
  invokerForWitnessAccessor(accessor)(self, marshalConsumedArgs([accessor.type], [value])[0]);
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
  const key = `actor-executor:${address}`;
  let fn = invokerCache.get(key);
  if (fn === undefined) {
    fn = makeSwiftNativeFunction(address, unownedSerialExecutorType, [], { hasSelf: true });
    invokerCache.set(key, fn);
  }
  const ref = fn(self);
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
  const demangled = symbolicateLocal(target.address);
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

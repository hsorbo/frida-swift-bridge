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
  SwiftAccessorSignature,
  ParsedSwiftSignature,
} from "./symbolication.js";
import {
  makeSwiftNativeFunction,
  SwiftNativeFunction,
  SwiftArgType,
  shouldPassIndirectly,
  floatLayout,
  indirect,
} from "./calling-convention.js";
import { AsyncFunctionPointer, findAsyncFunctionPointer } from "../abi/async-function-pointer.js";
import { callAsync, asyncArgsFitRegisters, AsyncCallOptions, AsyncResultShape, AsyncFloatArg, SerialExecutorRef } from "./async-call.js";
import { SwiftClosure, ClosureSpec, ClosureBody, LoadableClosureBody, SwiftThrow } from "./closure.js";
import { closureDiscriminator, closureHashString, INDIRECT } from "./closure-discriminator.js";
import { typeName, mangledTypeName } from "./type-name.js";
import { readString, createString } from "../abi/string.js";
import {
  isClassExistential,
  existentialRepresentation,
  projectErrorExistential,
  projectOpaqueExistential,
  protocolClassConstraint,
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
import type { SwiftType } from "./swift-type.js";
import { metadataOf } from "./swift-type.js";

export type MethodKind = "method" | "init";

export type CallResult = SwiftValue | SwiftObject;

export function isSwiftObject(value: CallResult): value is SwiftObject {
  return typeof value === "object" && value !== null && "$kind" in value;
}

// A SwiftField ($field view) is a borrowed ValueInstance at runtime, which marshalArg accepts.
export type CallArg = SwiftValue | SwiftObject | SwiftField | ClosureSpec;

export interface SwiftBoundMethod {
  readonly address: NativePointer;
  call(...args: CallArg[]): CallResult | Promise<CallResult>;
}

export function narrowBoundMethod(binder: SwiftBoundMethod, receiver?: RawInstance): SwiftBoundMethod {
  return {
    address: binder.address,
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

// mutating and consuming are unrecoverable from the symbol; the caller supplies them. mutating only
// changes self routing for small loadable receivers: required for generic methods, optional for async ones.
export interface ValueMethodResolveOptions extends MethodResolveOptions {
  mutating?: boolean;
  consuming?: boolean;
}

export interface RawMethodResolveOptions extends BaseResolveOptions {
  typeArguments?: Metadata[];
  witnessTables?: NativePointer[]; // overrides the witnesses auto-resolved from the where-clause
}

export interface RawValueMethodResolveOptions extends RawMethodResolveOptions {
  mutating?: boolean;
  consuming?: boolean;
}

export function lowerResolveOptions(stable: ValueMethodResolveOptions): RawValueMethodResolveOptions {
  const { arity, labels, argTypes, returnType, static: isStatic, mutating, consuming, typeArguments } = stable;
  const raw: RawValueMethodResolveOptions = { arity, labels, argTypes, returnType, static: isStatic, mutating, consuming };
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
}

export type AccessorKind = "getter" | "setter";

interface AccessorCandidate {
  address: NativePointer;
  member: string;
  kind: AccessorKind | "modify";
  typeName: string;
  isStatic: boolean;
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
  for (let cls: ClassMetadata | null = arg.metadata; cls !== null; cls = cls.superclass) {
    if (cls.handle.equals(declared.handle)) {
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
    if (metadata.kind !== MetadataKind.Class) {
      throw new Error(`argument is a class instance, expected ${typeName(metadata)}`);
    }
    assertClassAssignable(arg, metadata);
    buffer.writePointer(arg.handle);
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

function marshalArgsOrCleanup(argTypes: Metadata[], args: CallArg[]): NativePointer[] {
  const buffers: NativePointer[] = [];
  try {
    for (let i = 0; i < argTypes.length; i++) {
      buffers.push(marshalArg(argTypes[i], args[i]));
    }
  } catch (e) {
    buffers.forEach((ptr, i) => destroyArgTemp(argTypes[i], ptr));
    throw e;
  }
  return buffers;
}

// A class arg marshals as a bare borrowed pointer, so a +1/consumed callee needs its own retain.
export function marshalConsumedArgs(argTypes: Metadata[], args: CallArg[]): NativePointer[] {
  const buffers = marshalArgsOrCleanup(argTypes, args);
  for (let i = 0; i < argTypes.length; i++) {
    if (argTypes[i].kind === MetadataKind.Class) {
      new ClassInstance(buffers[i].readPointer()).retain();
    }
  }
  return buffers;
}

export function callBorrowingArgs(
  argTypes: Metadata[],
  args: CallArg[],
  returnType: Metadata | null,
  invoke: (argPtrs: NativePointer[]) => NativePointer | null
): CallResult {
  if (args.length !== argTypes.length) {
    throw new Error(`expected ${argTypes.length} argument(s), got ${args.length}`);
  }
  const argPtrs = marshalArgsOrCleanup(argTypes, args);
  try {
    return decodeReturn(returnType, invoke(argPtrs));
  } finally {
    argPtrs.forEach((ptr, i) => destroyArgTemp(argTypes[i], ptr));
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

// The marshalled path borrows every argument; a consuming (__owned) or inout parameter would
// double-free or desync self.
const NON_BORROWING_ARG = /^(?:__owned|inout)\s/;

export function assertBorrowingArgs(argTypeNames: string[], selector: string): void {
  const offending = argTypeNames.find((n) => NON_BORROWING_ARG.test(n));
  if (offending !== undefined) {
    throw new Error(
      `${selector} has a non-borrowing parameter (${offending}); its calling convention is unsupported ` +
        `by the stable API. Bind it through /abi, supplying the ABI signature and ownership by hand.`
    );
  }
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

const MANGLED_KIND_CHARS: { [kind: number]: string } = {
  [ContextDescriptorKind.Class]: "C",
  [ContextDescriptorKind.Struct]: "V",
  [ContextDescriptorKind.Enum]: "O",
  [ContextDescriptorKind.Protocol]: "P",
};

export function buildMangledTypeToken(descriptor: ContextDescriptor): string | null {
  let token = "";
  for (let context: ContextDescriptor | null = descriptor; context !== null; context = context.parent) {
    const isModule = context.kind === ContextDescriptorKind.Module;
    const kindChar = MANGLED_KIND_CHARS[context.kind];
    if (!isModule && kindChar === undefined) {
      return null;
    }
    const name = context.name;
    if (name === null) {
      return null;
    }
    if (isModule) {
      return `${name.length}${name}${token}`;
    }
    token = `${name.length}${name}${kindChar}${token}`;
  }
  return null;
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
    forEachExportedMembers(module, [{ fullName, token }], mayName, (_, found) => {
      methods.push(...found.methods);
      accessors.push(...found.accessors);
    });
  }
  return { methods, accessors };
}

interface MemberTarget {
  fullName: string;
  token: string;
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
      visit(i, membersAmong(exports.filter((e) => mayName(e.name)), target.fullName));
      return;
    }
    const key = `${moduleKey}|${target.token}`;
    let members = foreignScans.get(key);
    if (members === undefined) {
      members = membersAmong(exports, target.fullName);
      foreignScans.set(key, members);
    }
    visit(i, members);
  });
}

function membersAmong(exports: PrefixedExport[], fullName: string): TypeMembers {
  const members: TypeMembers = { methods: [], accessors: [] };
  const seen = new Set<string>();
  for (const e of exports) {
    considerMember(members, seen, fullName, e.name, e.address, false);
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

// The stdlib and imported ObjC modules mangle as substitutions (`s`, `So`), never as a spelled-out token.
const SUBSTITUTED_MODULES = new Set(["Swift", "__C"]);

function protocolExtensionTarget(protocol: ContextDescriptor): MemberTarget | null {
  const fullName = protocol.fullTypeName;
  const token = SUBSTITUTED_MODULES.has(protocol.moduleName ?? "") ? null : buildMangledTypeToken(protocol);
  return fullName === null || token === null ? null : { fullName, token };
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
      considerMember(members, seen, fullName, name, address, initsOnly);
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
  initsOnly: boolean
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
    const { context, isStatic } = stripReceiverKeyword(signature.context);
    if (context === fullName) {
      members.methods.push({ address, name: signature.name, mangled: name, isStatic, signature });
    }
  } else if (!initsOnly) {
    const { context, isStatic } = stripReceiverKeyword(signature.context);
    if (context === fullName) {
      members.accessors.push({ address, member: signature.member, kind: signature.kind, typeName: signature.typeName, isStatic });
    }
  }
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
    levels.push(conformanceMembers(fullName).flatMap((c) => c.members.accessors.filter((a) => !a.isStatic)));
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
  for (const name of new Set(enumerateMethods(fullName, "definingModule").map((m) => m.name))) {
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
      const overloads = candidates.map((c) => describeOverload(c.signature)).join(", ");
      throw new Error(
        `ambiguous method ${methodName} on ${className}: ${overloads} (disambiguate with { arity }, { labels }, { argTypes }, or { returnType })`
      );
    }

    const { isStatic, signature, mangled } = candidates[0];
    assertBorrowingArgs(signature.argTypeNames, signature.selector);
    const address = candidates[0].address.strip();
    const argTypes = signature.argTypeNames.map((name) => {
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
    return { address, argTypes, returnType, throws: signature.throws, isStatic, selector: signature.selector, async: signature.async, asyncFunctionPointer };
  }
  return null;
}

// Keyed by full signature, not bare address: an index invocation must not reuse a symbol-route
// invoker built for different types at the same impl.
function instanceInvokerKey(resolved: ResolvedMethod): string {
  const ret = resolved.returnType === null ? "v" : resolved.returnType.handle.toString();
  const args = resolved.argTypes.map((t) => t.handle.toString()).join(",");
  const witness = resolved.witnessSelf === undefined ? "" : `|${resolved.witnessSelf.handle}`;
  return `${resolved.address}|self|${ret}|${args}|${resolved.throws ? "t" : "n"}${witness}`;
}

// witness_method CC: Self metadata + witness table trail the formal args; defaults depend on them.
function witnessSelfArgs(table: WitnessTable | undefined): { typeArguments?: Metadata[]; witnessTables?: NativePointer[] } {
  return table === undefined ? {} : { typeArguments: [table.conformingType], witnessTables: [table.handle] };
}

function invokerFor(resolved: ResolvedMethod): SwiftNativeFunction {
  const key = instanceInvokerKey(resolved);
  let fn = invokerCache.get(key);
  if (fn === undefined) {
    fn = makeSwiftNativeFunction(resolved.address, resolved.returnType, resolved.argTypes, {
      hasSelf: true,
      throws: resolved.throws,
      ...witnessSelfArgs(resolved.witnessSelf),
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

  get raw(): SwiftNativeFunction {
    return this.fn;
  }

  call(...args: CallArg[]): CallResult {
    const { argTypes, returnType } = this.resolved;
    if (args.length !== argTypes.length) {
      throw new Error(`${this.resolved.selector} expects ${argTypes.length} argument(s), got ${args.length}`);
    }
    return callBorrowingArgs(argTypes, args, returnType, (argPtrs) => this.fn(this.self, ...argPtrs));
  }
}

// null ⇒ Void; check indirect before float, matching lowerArg (a resilient float aggregate is @out).
function asyncResultShape(returnType: Metadata | null): AsyncResultShape | null {
  if (returnType === null || returnType.valueWitnesses.size === 0) {
    return null;
  }
  if (shouldPassIndirectly(returnType)) {
    return { kind: "indirect", stride: returnType.valueWitnesses.stride };
  }
  const fl = floatLayout(returnType);
  if (fl !== null) {
    return { kind: "float", cls: fl.cls, count: fl.count };
  }
  return { kind: "gp", words: Math.ceil(returnType.valueWitnesses.size / Process.pointerSize) };
}

interface LoweredAsyncArgs {
  gp: NativePointer[];
  fp: AsyncFloatArg[];
}

function pushAsyncArg(metadata: Metadata, buffer: NativePointer, gp: NativePointer[], fp: AsyncFloatArg[]): void {
  if (metadata.kind === MetadataKind.Class) {
    gp.push(buffer.readPointer());
    return;
  }
  if (shouldPassIndirectly(metadata)) {
    gp.push(buffer);
    return;
  }
  const fl = floatLayout(metadata);
  if (fl !== null) {
    const stride = fl.cls === "double" ? 8 : 4;
    for (let k = 0; k < fl.count; k++) {
      fp.push({ bytes: buffer.add(k * stride), cls: fl.cls });
    }
    return;
  }
  const words = Math.ceil(metadata.valueWitnesses.size / Process.pointerSize);
  for (let w = 0; w < words; w++) {
    gp.push(buffer.add(w * Process.pointerSize).readPointer());
  }
}

function lowerAsyncArgs(argTypes: Metadata[], buffers: NativePointer[]): LoweredAsyncArgs {
  const gp: NativePointer[] = [];
  const fp: AsyncFloatArg[] = [];
  for (let i = 0; i < argTypes.length; i++) {
    pushAsyncArg(argTypes[i], buffers[i], gp, fp);
  }
  return { gp, fp };
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
    private readonly executor: SerialExecutorRef | null = null
  ) {
    if (resolved.asyncFunctionPointer === undefined) {
      throw new Error(`${resolved.selector} is not async`);
    }
    this.asyncFunctionPointer = resolved.asyncFunctionPointer;
    this.result = asyncResultShape(resolved.returnType);
  }

  get address(): NativePointer {
    return this.resolved.address;
  }

  call(...args: CallArg[]): Promise<CallResult> {
    const { argTypes, returnType, throws } = this.resolved;
    if (args.length !== argTypes.length) {
      throw new Error(`${this.resolved.selector} expects ${argTypes.length} argument(s), got ${args.length}`);
    }
    const buffers = marshalArgsOrCleanup(argTypes, args);
    const cleanup = (): void => {
      buffers.forEach((ptr, i) => destroyArgTemp(argTypes[i], ptr));
    };
    const { gp, fp } = lowerAsyncArgs(argTypes, buffers);
    const options: AsyncCallOptions = { throws };
    if (this.executor !== null) {
      options.onActor = this.executor;
    }
    if (this.self !== null) {
      options.receiver = this.self;
      if (!this.selfRouting.indirect) {
        const argsFit = asyncArgsFitRegisters(gp.length, fp.length, this.result);
        pushAsyncArg(this.selfRouting.receiver, this.self, gp, fp); // both ways, as in valueInvoker
        if (argsFit && !asyncArgsFitRegisters(gp.length, fp.length, this.result)) {
          cleanup();
          const { selector } = this.resolved;
          throw new Error(
            `${selector} on ${typeName(this.selfRouting.receiver)}: args plus a trailing self exceed the async ` +
              `argument registers; if it mutates, call it as $method("${selector.split("(")[0]}", { mutating: true }).call(...)`
          );
        }
      }
    }
    if (this.resolved.witnessSelf !== undefined) {
      gp.push(this.resolved.witnessSelf.conformingType.handle, this.resolved.witnessSelf.handle);
    }
    if (fp.length > 0) {
      options.floatArgs = fp;
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

// A static method's thin-metatype self is erased (null).
function resolveReceiverType(context: string): Metadata | null {
  const { context: base, isStatic } = stripReceiverKeyword(context);
  return isStatic ? null : resolveType(base);
}

// The async sibling of Swift.NativeFunction: call() for a free function, bind(self) for a method.
// Generic like NativeFunction<Ret, Args>: the caller annotates the marshalled return and argument
// types so a call site is typed without casting; both default to the untyped CallResult/CallArg.
export class SwiftAsyncFunction<Ret = CallResult, Args extends CallArg[] = CallArg[]> {
  private readonly unbound: BoundAsyncMethod;

  constructor(
    private readonly resolved: ResolvedMethod,
    private readonly receiverType: Metadata | null
  ) {
    this.unbound = new BoundAsyncMethod(resolved, null);
  }

  get address(): NativePointer {
    return this.resolved.address;
  }

  call(...args: Args): Promise<Ret> {
    if (this.receiverType !== null) {
      throw new Error(`${this.resolved.selector} is an instance method; bind a receiver with .bind(self)`);
    }
    return this.unbound.call(...args) as Promise<Ret>;
  }

  bind(receiver: AsyncReceiver): (...args: Args) => Promise<Ret> {
    if (this.receiverType === null) {
      throw new Error(`${this.resolved.selector} takes no receiver`);
    }
    if (this.receiverType.kind !== MetadataKind.Class && this.receiverType.kind !== MetadataKind.ObjCClassWrapper) {
      throw new Error(`receiver binding is only supported for class receivers, not ${typeName(this.receiverType)}`);
    }
    const bound = new BoundAsyncMethod(this.resolved, toReceiverPointer(receiver), { indirect: true });
    rootAsyncReceiver(bound, receiver);
    return (...args: Args) => bound.call(...args) as Promise<Ret>;
  }
}

export function resolveAsyncFunction<Ret = CallResult, Args extends CallArg[] = CallArg[]>(
  module: Module,
  mangled: string
): SwiftAsyncFunction<Ret, Args> {
  const demangled = demangle(mangled);
  if (demangled === null) {
    throw new Error(`not a Swift symbol: ${mangled}`);
  }
  const signature = parseSwiftSignature(demangled);
  if (signature === null || signature.kind !== "function") {
    throw new Error(`cannot parse a function signature from ${demangled}`);
  }
  if (!signature.async) {
    throw new Error(`${signature.selector} is not async; use Swift.NativeFunction`);
  }
  if (signature.genericParams.length > 0) {
    throw new Error(`${signature.selector} is generic; async generics are not supported here`);
  }
  const afp = findAsyncFunctionPointer(module, mangled);
  if (afp === null) {
    throw new Error(`no async function pointer for ${mangled} in ${module.name}`);
  }
  assertBorrowingArgs(signature.argTypeNames, signature.selector);
  const argTypes = signature.argTypeNames.map((name) => {
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
  const resolved: ResolvedMethod = {
    address: afp.code,
    argTypes,
    returnType,
    throws: signature.throws,
    isStatic: false,
    selector: signature.selector,
    async: true,
    asyncFunctionPointer: afp,
  };
  return new SwiftAsyncFunction<Ret, Args>(resolved, resolveReceiverType(signature.context));
}

function staticInvokerFor(resolved: ResolvedMethod): SwiftNativeFunction {
  const key = `${resolved.address}:static`;
  let fn = invokerCache.get(key);
  if (fn === undefined) {
    fn = makeSwiftNativeFunction(resolved.address, resolved.returnType, resolved.argTypes, {
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

  call(...args: CallArg[]): CallResult {
    const { argTypes, returnType } = this.resolved;
    if (args.length !== argTypes.length) {
      throw new Error(`${this.resolved.selector} expects ${argTypes.length} argument(s), got ${args.length}`);
    }
    return callBorrowingArgs(argTypes, args, returnType, (argPtrs) => this.fn(...argPtrs));
  }
}

export function bindStaticMethod(
  receiver: Metadata,
  name: string,
  options: RawMethodResolveOptions = {}
): BoundStaticMethod | BoundAsyncMethod {
  const resolved = resolveMethod(typeName(receiver), name, { ...options, static: true });
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
    const buffers = marshalConsumedArgs(argTypes, args);
    const ret = this.fn(...buffers);
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

export type SelfRouting = { indirect: true } | { indirect: false; receiver: Metadata };

// Value-type self is indirect (x20) when mutating/inout or large/non-POD; else it rides as a trailing
// arg. Only a small loadable receiver's routing depends on `mutating`, which isn't recoverable from the
// symbol. Plain calls pass self both ways (valueInvoker, BoundAsyncMethod); generic ones can't, since a
// trailing self shifts the metadata args, so there the caller must state it.
function valueSelfRouting(receiver: Metadata, selector: string, mutating: boolean | undefined): SelfRouting {
  if (shouldPassIndirectly(receiver)) {
    return { indirect: true };
  }
  if (mutating === undefined) {
    const baseName = selector.split("(")[0];
    throw new Error(
      `${selector} on small loadable ${typeName(receiver)}: self routing depends on whether it mutates; ` +
        `call it as $method("${baseName}", { mutating: false }).call(...), or { mutating: true } if it mutates`
    );
  }
  return mutating ? { indirect: true } : { indirect: false, receiver };
}

// A small loadable self rides as trailing args if the method doesn't mutate, or by address in x20 if
// it does, and the symbol doesn't say which. Pass it both ways: each callee reads only its own, and the
// other is an unused arg or a callee-saved register.
function valueInvoker(resolved: ResolvedMethod, receiver: Metadata): SwiftNativeFunction {
  const key = `${resolved.address}:value-self`;
  let fn = invokerCache.get(key);
  if (fn === undefined) {
    const argTypes = shouldPassIndirectly(receiver) ? resolved.argTypes : [...resolved.argTypes, receiver];
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

  call(...args: CallArg[]): CallResult {
    const { argTypes, returnType } = this.resolved;
    if (args.length !== argTypes.length) {
      throw new Error(`${this.resolved.selector} expects ${argTypes.length} argument(s), got ${args.length}`);
    }
    const self = this.consuming ? this.copyOfSelf() : this.self;
    return callBorrowingArgs(argTypes, args, returnType, (argPtrs) =>
      this.trailingSelf ? this.fn(self, ...argPtrs, self) : this.fn(self, ...argPtrs)
    );
  }

  private copyOfSelf(): NativePointer {
    const copy = Memory.alloc(this.receiver.typeLayout.stride);
    this.receiver.valueWitnesses.initializeWithCopy(copy, this.self);
    return copy;
  }
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
  // Both ways unless { mutating: true }, which keeps self out of the async trampoline's scarce arg registers.
  return resolved.async === true
    ? new BoundAsyncMethod(resolved, self, valueSelfRouting(receiver, resolved.selector, options.mutating ?? false))
    : new BoundValueMethod(resolved, receiver, self, options.consuming === true);
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

function planClosureType(spelling: FunctionTypeSpelling, genericParams: string[], typeArguments: Metadata[]): ArgPlan {
  const result = spelling.result.trim();
  const resultIsGeneric = genericParams.includes(result);
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
    const resultScalar = resultIsVoid ? null : LOADABLE_SCALARS[result] ?? null;
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

function planGenericType(name: string, genericParams: string[], typeArguments: Metadata[]): ArgPlan {
  const fn = parseFunctionTypeSpelling(name);
  if (fn !== null) {
    return planClosureType(fn, genericParams, typeArguments);
  }
  const index = genericParams.indexOf(name);
  if (index !== -1) {
    const metadata = typeArguments[index];
    if (metadata === undefined) {
      throw new Error(`missing type argument for generic parameter ${name}`);
    }
    return { kind: "generic", index, metadata };
  }
  const concrete = resolveType(name);
  if (concrete !== null) {
    return { kind: "concrete", metadata: concrete };
  }
  return planCompoundType(name, genericParams, typeArguments);
}

function planCompoundType(expr: string, genericParams: string[], typeArguments: Metadata[]): ArgPlan {
  const metadata = resolveTypeExpr(expr, (name) => {
    const i = genericParams.indexOf(name);
    return i === -1 ? null : typeArguments[i] ?? null;
  });
  if (metadata === null) {
    throw new Error(`cannot resolve generic signature type ${expr}`);
  }
  return compoundIsAddressOnly(expr, genericParams)
    ? { kind: "abstractIndirect", metadata }
    : { kind: "concrete", metadata };
}

// Accepts the demangler's desugared spelling (Swift.Array<A>) and the sugared one ([A]). Array/Set/
// Dictionary are a fixed-layout buffer (direct); Optional<param> embeds the abstract param (indirect).
function compoundIsAddressOnly(expr: string, genericParams: string[]): boolean {
  const t = expr.trim();
  if (t.endsWith("?") || t.endsWith("!")) {
    return optionalIsAddressOnly(t.slice(0, -1), genericParams, expr);
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
      return optionalIsAddressOnly(t.slice(lt + 1, -1), genericParams, expr);
    }
  }
  throw new Error(`unsupported compound generic signature type ${expr} (only [T], [K: V] and T? are supported)`);
}

function optionalIsAddressOnly(payload: string, genericParams: string[], expr: string): boolean {
  if (genericParams.includes(payload.trim())) {
    return true;
  }
  throw new Error(`unsupported compound generic signature type ${expr} (Optional payload must be a generic parameter)`);
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

function autoWitnessTables(
  signature: SwiftFunctionSignature,
  typeArguments: Metadata[]
): NativePointer[] {
  return signature.conformanceRequirements.map((req) => {
    const index = signature.genericParams.indexOf(req.subject);
    const protocol = index === -1 ? null : findProtocol(req.protocol);
    if (protocol === null) {
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
}

// Type-metadata + witness pointers trail the formal args, so a trailing-exploded value self lands
// before them; indirect self rides in x20 (hasSelf).
export class GenericBoundMethod {
  private readonly fn: SwiftNativeFunction;
  private readonly indirectSelf: boolean;
  readonly address: NativePointer;
  readonly selector: string;

  constructor(
    private readonly plan: GenericMethodPlan,
    private readonly self: NativePointer,
    routing: SelfRouting
  ) {
    this.address = plan.address;
    this.selector = plan.selector;
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
    const closures: SwiftClosure[] = []; // in scope through the call: Swift invokes them in-flight
    const argPtrs: NativePointer[] = [];
    const borrowed: { metadata: Metadata; ptr: NativePointer }[] = [];
    try {
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i];
        if (plan.kind === "closure") {
          const closure = marshalClosure(plan, args[i]);
          closures.push(closure);
          argPtrs.push(closure.value());
          continue;
        }
        const ptr = marshalArg(plan.metadata, args[i]);
        argPtrs.push(ptr);
        if (plan.metadata.kind !== MetadataKind.Class && !plan.metadata.valueWitnesses.isPOD) {
          borrowed.push({ metadata: plan.metadata, ptr });
        }
      }
    } catch (e) {
      for (const b of borrowed) destroyArgTemp(b.metadata, b.ptr);
      throw e;
    }
    const returnType = this.plan.returnPlan === null ? null : planMetadata(this.plan.returnPlan);
    try {
      const ret = this.indirectSelf ? this.fn(this.self, ...argPtrs) : this.fn(...argPtrs, this.self);
      return decodeReturn(returnType, ret);
    } finally {
      for (const b of borrowed) {
        b.metadata.valueWitnesses.destroy(b.ptr);
      }
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

// Like BoundAsyncMethod, but generic/abstract params are @in pointers and type-metadata + witnesses
// trail the formal args (indirect self only).
export class GenericBoundAsyncMethod {
  readonly address: NativePointer;
  readonly selector: string;
  readonly asyncFunctionPointer: AsyncFunctionPointer;
  receiverKeepalive: unknown = null;
  private readonly result: AsyncResultShape | null;

  constructor(
    private readonly plan: GenericMethodPlan,
    private readonly self: NativePointer,
    routing: SelfRouting
  ) {
    if (plan.asyncFunctionPointer === undefined) {
      throw new Error(`${plan.selector} is not async`);
    }
    if (!routing.indirect) {
      throw new Error(`${plan.selector}: trailing value self is unsupported for async generic methods`);
    }
    this.address = plan.address;
    this.selector = plan.selector;
    this.asyncFunctionPointer = plan.asyncFunctionPointer;
    this.result = genericAsyncResultShape(plan.returnPlan);
  }

  call(...args: CallArg[]): Promise<CallResult> {
    const plans = this.plan.argPlans;
    if (args.length !== plans.length) {
      throw new Error(`${this.selector} expects ${plans.length} argument(s), got ${args.length}`);
    }
    if (plans.some((p) => p.kind === "closure")) {
      throw new Error(`${this.selector}: closure arguments are unsupported for async generic methods`);
    }
    const metas = plans.map(planMetadata);
    const buffers = marshalArgsOrCleanup(metas, args);
    const cleanup = (): void => {
      buffers.forEach((ptr, i) => destroyArgTemp(metas[i], ptr));
    };
    const gp: NativePointer[] = [];
    const fp: AsyncFloatArg[] = [];
    plans.forEach((plan, i) => {
      if (plan.kind === "generic" || plan.kind === "abstractIndirect") {
        gp.push(buffers[i]);
      } else {
        pushAsyncArg(metas[i], buffers[i], gp, fp);
      }
    });
    for (const metadata of this.plan.typeArguments) {
      gp.push(metadata.handle);
    }
    for (const witnessTable of this.plan.witnessTables) {
      gp.push(witnessTable);
    }
    const options: AsyncCallOptions = { throws: this.plan.throws, receiver: this.self };
    if (fp.length > 0) {
      options.floatArgs = fp;
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
  assertBorrowingArgs(signature.argTypeNames, signature.selector);
  const argPlans = signature.argTypeNames.map((n) => planGenericType(n, signature.genericParams, resolvedTypeArguments));
  const returnPlan =
    signature.returnTypeName === null
      ? null
      : planGenericType(signature.returnTypeName, signature.genericParams, resolvedTypeArguments);
  const witnessTables = options.witnessTables ?? autoWitnessTables(signature, resolvedTypeArguments);
  let asyncFunctionPointer: AsyncFunctionPointer | undefined;
  if (signature.async) {
    const module = Process.findModuleByAddress(address.strip());
    asyncFunctionPointer = module === null ? undefined : findAsyncFunctionPointer(module, mangled) ?? undefined;
    if (asyncFunctionPointer === undefined) {
      throw new Error(`cannot resolve async function pointer for ${signature.selector}`);
    }
  }
  return { address, selector: signature.selector, argPlans, returnPlan, throws: signature.throws, async: signature.async, asyncFunctionPointer, typeArguments: resolvedTypeArguments, witnessTables };
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

export function bindGenericValueMethod(
  receiver: Metadata,
  self: NativePointer,
  methodName: string,
  options: RawValueMethodResolveOptions = {}
): GenericBoundMethod | GenericBoundAsyncMethod {
  const plan = planGenericMethod(typeName(receiver), methodName, options);
  const routing = valueSelfRouting(receiver, plan.selector, options.mutating);
  return plan.async ? new GenericBoundAsyncMethod(plan, self, routing) : new GenericBoundMethod(plan, self, routing);
}

// A bare type parameter (T) is address-only in the generic context but concretely sized by the
// instance's type argument; concrete and compound types lower as elsewhere.
function planTypeMemberArg(name: string, typeParams: string[], typeArguments: Metadata[]): ArgPlan {
  const index = typeParams.indexOf(name.trim());
  if (index !== -1) {
    return { kind: "abstractIndirect", metadata: typeArguments[index] };
  }
  const concrete = resolveType(name);
  if (concrete !== null) {
    return { kind: "concrete", metadata: concrete };
  }
  return planCompoundType(name, typeParams, typeArguments);
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

// Methods on a generic type, no method-level generics. self is always indirect (class: object in
// x20; value: its bytes, address-only in the generic context). A value type trails its Self metadata
// — the callee reads T's metadata + witnesses from that vector; a class recovers them from the isa.
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
    const overloads = candidates.map((c) => describeOverload(c.signature)).join(", ");
    throw new Error(`ambiguous method ${methodName} on ${unboundName}: ${overloads} (disambiguate with { arity }, { labels }, { argTypes }, or { returnType })`);
  }
  const { address, signature, mangled } = candidates[0];
  assertBorrowingArgs(signature.argTypeNames, signature.selector);
  const argPlans = signature.argTypeNames.map((n) => planTypeMemberArg(n, typeParams, typeArguments));
  const returnPlan =
    signature.returnTypeName === null ? null : planTypeMemberArg(signature.returnTypeName, typeParams, typeArguments);
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
  };
}

export function bindGenericTypeValueMethod(
  receiver: Metadata,
  self: NativePointer,
  methodName: string,
  options: RawMethodResolveOptions = {}
): GenericBoundMethod | GenericBoundAsyncMethod {
  const plan = planGenericTypeMethod(receiver, methodName, options, true);
  return plan.async
    ? new GenericBoundAsyncMethod(plan, self, { indirect: true })
    : new GenericBoundMethod(plan, self, { indirect: true });
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

function findAccessor(typeName: string, member: string, kind: AccessorKind): ResolvedAccessor | null {
  const fullName = canonicalTypeName(typeName);
  return (
    resolveAccessorIn(fullName, member, kind, definingModuleMembers) ??
    resolveAccessorIn(fullName, member, kind, allLoadedModuleMembers)
  );
}

function resolveAccessorIn(
  fullName: string,
  member: string,
  kind: AccessorKind,
  members: MemberSource
): ResolvedAccessor | null {
  for (const className of classChainNames(fullName)) {
    const candidate = members(className).accessors.find(
      (a) => a.member === member && a.kind === kind && !a.isStatic
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
  return conformances.map((c, i) => ({ ...c, members: members[i] }));
}

function isConformanceMethod(c: MethodCandidate): boolean {
  return !c.isStatic && c.signature.genericParams.length === 0;
}

function conformanceMethodOverloads(
  members: TypeMembers,
  name: string,
  options: RawMethodResolveOptions
): MethodCandidate[] {
  return applyOverloadFilters(
    members.methods.filter((c) => c.name === name && isConformanceMethod(c)),
    options
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

// Self is @in_guaranteed unless the protocol is class-bound, so a class reference needs a cell.
function witnessReceiver(conformance: ConformanceMembers, self: NativePointer): NativePointer {
  if (conformance.table.conformingType.kind !== MetadataKind.Class || protocolClassConstraint(conformance.protocol) === 0) {
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
  const receiver = witnessReceiver(conformance, self);
  return resolved.async === true ? new BoundAsyncMethod(resolved, receiver) : new BoundMethod(resolved, receiver);
}

function conformanceGetProperty(fullName: string, self: NativePointer, member: string): CallResult {
  const conformance = conformanceDeclaring(fullName, member, (m) =>
    m.accessors.some((a) => a.member === member && a.kind === "getter" && !a.isStatic)
  );
  if (conformance === null) {
    throw new Error(`no getter for ${member} on ${fullName}`);
  }
  const accessor = resolveExtensionAccessor(conformance.table, member, "getter");
  return decodeReturn(accessor.type, invokerForWitnessAccessor(accessor)(witnessReceiver(conformance, self)));
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
    if (typeDescriptor.isGeneric) {
      continue; // no accessFunction to call without type arguments — never nameable this way
    }
    let type: Metadata;
    try {
      type = getMetadata(typeDescriptor);
    } catch {
      continue;
    }
    const tableAddr = conformsToProtocol(type, protocol);
    if (tableAddr === null) {
      continue;
    }
    const table = new WitnessTable(tableAddr, type);
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
    ...resolveWitnessSignature(table, signature),
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
): ResolvedMethod {
  const protocol = protocolOf(table);
  const protocolName = protocol.fullTypeName ?? "protocol";
  const matches = conformanceMethodOverloads(protocolExtensionMembers(protocol), methodName, options);
  if (matches.length === 0) {
    throw new Error(`no requirement ${methodName} on ${protocolName}`);
  }
  if (matches.length > 1) {
    const overloads = matches.map((m) => describeOverload(m.signature)).join(", ");
    throw new Error(
      `ambiguous extension method ${methodName} on ${protocolName}: ${overloads} (disambiguate with { arity }, { labels }, { argTypes }, or { returnType })`
    );
  }
  const { signature, mangled } = matches[0];
  const requirement = requirementImplementedBy(
    table,
    (r) => r.kind === ProtocolRequirementKind.Method && r.isAsync === signature.async,
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
  return {
    address,
    ...resolveWitnessSignature(table, signature),
    isStatic: false,
    async: signature.async,
    asyncFunctionPointer,
    witnessSelf: table,
  };
}

// Stripped binaries only reveal a requirement's default through where the witness thunk branches.
function requirementImplementedBy(
  table: WitnessTable,
  isCandidate: (requirement: ProtocolRequirement) => boolean,
  isImplementation: (signature: ParsedSwiftSignature) => boolean
): ProtocolRequirement | null | "undecodable" {
  let undecodable = false;
  for (const requirement of readProtocolRequirements(protocolOf(table)).filter(isCandidate)) {
    const signature = witnessTargetSignature(table, requirement) ?? witnessThunkSignature(table, requirement);
    if (signature === null) {
      undecodable = true;
    } else if (isImplementation(signature)) {
      return requirement;
    }
  }
  return undecodable ? "undecodable" : null;
}

function witnessTargetSignature(table: WitnessTable, requirement: ProtocolRequirement): ParsedSwiftSignature | null {
  const target = witnessTarget(table, requirement);
  const demangled = target === null ? null : symbolicateLocal(target.address);
  return demangled === null ? null : parseSwiftSignature(demangled);
}

function witnessThunkSignature(table: WitnessTable, requirement: ProtocolRequirement): ParsedSwiftSignature | null {
  const demangled = symbolicateLocal(table.requirement(requirement.witnessIndex));
  const stripped = demangled === null ? null : stripWitnessWrapper(demangled);
  return stripped === null ? null : parseSwiftSignature(stripped);
}

function resolveWitnessSignature(
  table: WitnessTable,
  signature: SwiftFunctionSignature
): Pick<ResolvedMethod, "argTypes" | "returnType" | "throws" | "selector"> {
  assertBorrowingArgs(signature.argTypeNames, signature.selector);
  const argTypes = signature.argTypeNames.map((name) => {
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
  return { argTypes, returnType, throws: signature.throws, selector: signature.selector };
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

interface ResolvedWitnessAccessor {
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
  return witnessAccessor(table, address, member, kind, match.signature.typeName);
}

function resolveExtensionAccessor(table: WitnessTable, member: string, kind: AccessorKind): ResolvedWitnessAccessor {
  const protocol = protocolOf(table);
  const protocolName = protocol.fullTypeName ?? "protocol";
  const match = protocolExtensionMembers(protocol).accessors.find(
    (a) => a.member === member && a.kind === kind && !a.isStatic
  );
  if (match === undefined) {
    throw new Error(`no ${kind} for ${member} on ${protocolName}`);
  }
  const requirementKind = kind === "getter" ? ProtocolRequirementKind.Getter : ProtocolRequirementKind.Setter;
  const requirement = requirementImplementedBy(
    table,
    (r) => r.kind === requirementKind,
    (s) => s.kind === kind && s.member === member
  );
  if (requirement === "undecodable") {
    throw new Error(`cannot tell whether ${member} is a requirement of ${protocolName}`);
  }
  const address = requirement === null ? match.address.strip() : table.requirement(requirement.witnessIndex);
  return witnessAccessor(table, address, member, kind, match.typeName);
}

function witnessAccessor(
  table: WitnessTable,
  address: NativePointer,
  member: string,
  kind: AccessorKind,
  typeName: string
): ResolvedWitnessAccessor {
  const type = resolveTypeExpr(typeName, (n) => resolveWitnessSelfOrAssociatedType(table, n));
  if (type === null) {
    throw new Error(`cannot resolve ${kind} type ${typeName} of ${member}`);
  }
  const classBound = classBoundSubjects(protocolOf(table));
  const abstract = hasOpaqueLayout(typeName, (name): ParamLayout | null => {
    if (name !== "A" && !name.startsWith("A.")) {
      return null;
    }
    return classBound.has(name) ? "reference" : "opaque";
  });
  return { address, type, kind, abstract, table };
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
  const { address, length } = requirement.param;
  const mangled = String.fromCharCode(...new Uint8Array(address.readByteArray(length)!));
  if (mangled === "x") {
    return "A";
  }
  const match = /^(\d+)/.exec(mangled);
  if (match === null || !mangled.endsWith("Qz")) {
    return null;
  }
  return "A." + mangled.substr(match[1].length, parseInt(match[1], 10));
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
    const options = { hasSelf: true, ...witnessSelfArgs(accessor.table) };
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

const CONTROL_FLOW_GROUPS = new Set(["jump", "call", "ret"]);

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

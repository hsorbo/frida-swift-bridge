import { Metadata, MetadataKind, getMetadata } from "../abi/metadata.js";
import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { ClassMetadata } from "../abi/class-metadata.js";
import { isActor, isDefaultActor } from "../abi/class-descriptor.js";
import { ValueInstance } from "../abi/value.js";
import { ClassInstance } from "../abi/heap-object.js";
import { asSwiftObject, SwiftClassObject, SwiftValueObject, SwiftObject, RAW } from "./object-facade.js";
import { SwiftValue } from "../abi/instance.js";
import { enumerateFields, fieldTypeIn } from "../abi/field-descriptor.js";
import { makeSwiftNativeFunction, indirect } from "./calling-convention.js";
import { parseSwiftSignature, resolveType, symbolicate, splitParamConvention, ParamConvention } from "./symbolication.js";
import {
  BoundMethod,
  BoundAsyncMethod,
  SwiftBoundMethod,
  SwiftBoundInitializer,
  narrowBoundMethod,
  narrowBoundInitializer,
  marshalConsumedArgs,
  CallArg,
  CallResult,
  MethodResolveOptions,
  ValueMethodResolveOptions,
  MemberOrigin,
  PropertyInfo,
  bindStaticMethod,
  bindValueInitializer,
  callMarshalled,
  enumerateMethods,
  ModuleScope,
  enumerateProperties,
  getStaticProperty,
  setStaticProperty,
  lowerResolveOptions,
  findMethod,
  findMember,
  FoundMember,
  bindConformanceMethod,
} from "./method.js";
import { enumerateTupleElements, tupleLabels } from "../abi/tuple.js";
import { metatypeInstanceType } from "../abi/metatype.js";
import { readFunctionType, ParameterOwnership } from "../abi/function-type.js";
import { demangle } from "./demangle.js";
import { typeName } from "./type-name.js";
import { Protocol, protocolsForType } from "./protocol.js";
import { findType, swiftTypes } from "../reflection/registry.js";
import { POISON, isBridgeMember, invokeOptions, facadeMembers, callableCache } from "./facade-members.js";

export interface TypeMember {
  name: string;
  type: SwiftType | null;
  isVar: boolean;
}

export interface MethodQuery {
  inherited?: boolean;
}

// The type-level lookups each name one kind of member, so they take no static option.
export type MemberLookupOptions = Omit<ValueMethodResolveOptions, "static">;

export interface SwiftInstanceMethod {
  readonly address: NativePointer;
  readonly origin: MemberOrigin;
  bind(receiver: SwiftObject): SwiftBoundMethod;
}

export type TypeKind =
  | "class"
  | "struct"
  | "enum"
  | "tuple"
  | "metatype"
  | "function"
  | "existential"
  | "objc-class"
  | "foreign-class"
  | "foreign-reference"
  | "type";

function typeKindName(metadata: Metadata): TypeKind {
  switch (metadata.kind) {
    case MetadataKind.Class:
      return "class";
    case MetadataKind.Struct:
      return "struct";
    case MetadataKind.Enum:
    case MetadataKind.Optional:
      return "enum";
    case MetadataKind.Tuple:
      return "tuple";
    case MetadataKind.Metatype:
      return "metatype";
    case MetadataKind.Function:
      return "function";
    case MetadataKind.ObjCClassWrapper:
      return "objc-class";
    case MetadataKind.Existential:
    case MetadataKind.ExtendedExistential:
      return "existential";
    case MetadataKind.ForeignClass:
      return "foreign-class";
    case MetadataKind.ForeignReferenceType:
      return "foreign-reference";
    default:
      return "type";
  }
}

interface RawState {
  descriptor: ContextDescriptor | null;
  metadata: Metadata | null;
}

const rawState = new WeakMap<SwiftType, RawState>();

export class SwiftType {
  /**
   * @internal Construct wrappers through `typeOf` (from a Metadata) or `typeFromDescriptor`
   * (from a ContextDescriptor); both source types are /abi records. Kept in the emitted
   * declarations (`stripInternal` is off), so this is a documentation-level boundary only.
   */
  constructor(source: Metadata | ContextDescriptor) {
    rawState.set(
      this,
      source instanceof ContextDescriptor
        ? { descriptor: source, metadata: null }
        : { descriptor: null, metadata: source }
    );
  }

  // The facade answers any Swift member name; raw metadata and descriptor stay under /abi.
  [key: string]: any;
  declare readonly metadata?: never;
  declare readonly descriptor?: never;

  toString(): string {
    return this.$name;
  }

  get $name(): string {
    return backingDescriptorOf(this)?.fullTypeName ?? typeName(metadataOf(this));
  }

  get $superClass(): SwiftType | null {
    return null;
  }

  get $moduleName(): string | null {
    return descriptorOf(this).moduleName;
  }

  toJSON(): { kind: string; name: string; module: string | null } {
    return { kind: this.$kind, name: this.$name, module: this.jsonModule() };
  }

  get $kind(): TypeKind {
    switch (backingDescriptorOf(this)?.kind) {
      case ContextDescriptorKind.Class:
        return "class";
      case ContextDescriptorKind.Struct:
        return "struct";
      case ContextDescriptorKind.Enum:
        return "enum";
      default:
        return typeKindName(metadataOf(this));
    }
  }

  private jsonModule(): string | null {
    if (backingDescriptorOf(this) === null) {
      const kind = metadataOf(this).kind;
      if (
        kind !== MetadataKind.Class &&
        kind !== MetadataKind.Struct &&
        kind !== MetadataKind.Enum &&
        kind !== MetadataKind.Optional
      ) {
        return null;
      }
    }
    return this.$moduleName;
  }

}

// A class, struct or enum: the wrappers with Swift members, and the ones the type facade wraps.
export abstract class NominalType extends SwiftType {
  $typeMethods(options: MethodQuery = {}): string[] {
    return this.selectors(true, options);
  }

  $instanceMethods(options: MethodQuery = {}): string[] {
    return this.selectors(false, options);
  }

  // Found by name alone, so it has no receiver: hook its address, or bind an instance to call it.
  $instanceMethod(name: string, options: MemberLookupOptions = {}): SwiftInstanceMethod {
    const member = findMember(this.$name, name, { ...lowerResolveOptions(options), static: false });
    if (member === null) {
      throw new Error(`no instance method ${name} on ${this.$name}`);
    }
    return {
      address: member.address,
      origin: member.origin,
      bind: (receiver) => receiver.$method(name, options),
    };
  }

  private selectors(isStatic: boolean, { inherited = true }: MethodQuery): string[] {
    return enumerateMethods(this.$name, "allLoadedModules", inherited ? "withSuperclasses" : "thisType")
      .filter((m) => m.kind === "method" && m.isStatic === isStatic)
      .map((m) => m.selector);
  }

  $protocols(): { [name: string]: Protocol } {
    return protocolsForType(descriptorOf(this).handle);
  }

  get $properties(): PropertyInfo[] {
    return enumerateProperties(this.$name);
  }

  $get(name: string): CallResult {
    return getStaticProperty(metadataOf(this), name);
  }

  abstract $typeMethod(name: string, options?: MemberLookupOptions): SwiftBoundMethod;
  abstract $initializer(options?: MemberLookupOptions): SwiftBoundInitializer | SwiftClassBoundInitializer;
  protected abstract hasInitializer(labels: string[]): boolean;

  $call(name: string, ...args: CallArg[]): CallResult | Promise<CallResult> {
    return this.$typeMethod(name, invokeOptions(args)).call(...args);
  }

  // A lone { label: value } object selects a labeled initializer when the type declares one.
  protected initLookup(args: CallArg[]): { options: MemberLookupOptions; args: CallArg[] } {
    const labeled = asLabeledArgs(args);
    return labeled !== null && this.hasInitializer(labeled.labels)
      ? { options: { labels: labeled.labels }, args: labeled.values }
      : { options: { arity: args.length }, args };
  }
}

export class ValueType extends NominalType {
  $typeMethod(name: string, options: MemberLookupOptions = {}): SwiftBoundMethod {
    const raw = lowerResolveOptions(options);
    const lookup = { ...raw, static: true };
    if (isUnboundGeneric(this)) {
      return unboundGenericMethod(this.$name, name, lookup);
    }
    if (findMethod(this.$name, name, lookup) === null) {
      const generic = genericMember(this.$name, name, lookup);
      if (generic !== null) {
        return generic;
      }
    }
    return narrowBoundMethod(bindStaticMethod(metadataOf(this), name, raw));
  }

  $initializer(options: MemberLookupOptions = {}): SwiftBoundInitializer {
    const raw = lowerResolveOptions(options);
    if (isUnboundGeneric(this)) {
      return unboundGenericMethod(this.$name, "init", raw);
    }
    if (findMethod(this.$name, "init", raw) === null) {
      const generic = genericMember(this.$name, "init", raw);
      if (generic !== null) {
        return generic;
      }
    }
    return narrowBoundInitializer(bindValueInitializer(metadataOf(this), raw));
  }

  init(...args: CallArg[]): SwiftValueObject | null {
    const lookup = this.initLookup(args);
    return this.$initializer(lookup.options).call(...lookup.args);
  }

  protected hasInitializer(labels: string[]): boolean {
    const declares = (modules: ModuleScope): boolean =>
      enumerateMethods(this.$name, modules).some(
        (m) => m.name === "init" && sameSequence(m.argLabels, labels)
      );
    return declares("definingModule") || declares("allLoadedModules");
  }

  $new(value: SwiftValue): SwiftValueObject {
    return asSwiftObject(ValueInstance.fromJS(metadataOf(this), value));
  }

  $borrow(address: NativePointer): SwiftValueObject {
    return asSwiftObject(ValueInstance.borrow(metadataOf(this), address));
  }

  $copy(address: NativePointer): SwiftValueObject {
    return asSwiftObject(ValueInstance.fromCopy(metadataOf(this), address));
  }

  $adopt(address: NativePointer): SwiftValueObject {
    return asSwiftObject(ValueInstance.adopt(metadataOf(this), address));
  }
}

export class StructType extends ValueType {
  get $fields(): TypeMember[] {
    const metadata = metadataOf(this);
    return [...enumerateFields(metadata.description)].map((f) => {
      const type = fieldTypeIn(metadata, f);
      return { name: f.name, type: type === null ? null : typeOf(type), isVar: f.isVar };
    });
  }
}

export class EnumType extends ValueType {
  $case(name: string, payload?: SwiftValue): SwiftValueObject {
    return asSwiftObject(ValueInstance.fromJS(metadataOf(this), payload === undefined ? name : { [name]: payload }));
  }

  get $cases(): TypeMember[] {
    const metadata = metadataOf(this);
    return [...enumerateFields(metadata.description)].map((f) => {
      const type = f.mangledTypeName !== null ? fieldTypeIn(metadata, f) : null;
      return { name: f.name, type: type === null ? null : typeOf(type), isVar: f.isVar };
    });
  }
}

export class ObjCClassWrapperType extends SwiftType {
  get $objcClass(): NativePointer {
    return metadataOf(this).handle.add(Process.pointerSize).readPointer().strip();
  }
}

export class ForeignClassType extends SwiftType {
  get $superClass(): ForeignClassType | null {
    const superclass = metadataOf(this).handle.add(2 * Process.pointerSize).readPointer().strip();
    return superclass.isNull() ? null : (typeOf(new Metadata(superclass)) as ForeignClassType);
  }
}

export class ForeignReferenceType extends SwiftType {}

interface ClassInitializer {
  address: NativePointer;
  argTypes: Metadata[];
  argLabels: (string | null)[];
  argTypeNames: string[];
  throws: boolean;
  failable: boolean;
}

export interface SwiftClassBoundInitializer {
  readonly address: NativePointer;
  call(...args: CallArg[]): SwiftClassObject;
}

function isOptionalTypeName(name: string): boolean {
  return /[?!]$/.test(name) || name.startsWith("Swift.Optional<");
}

// A lone plain { label: value } object selects a labeled initializer, keys mapping to labels in order;
// a facade, pointer, array, or empty object is not a label spec and stays a positional argument.
function asLabeledArgs(args: CallArg[]): { labels: string[]; values: CallArg[] } | null {
  if (args.length !== 1) {
    return null;
  }
  const spec = args[0];
  if (
    spec === null ||
    typeof spec !== "object" ||
    Array.isArray(spec) ||
    spec instanceof NativePointer ||
    (spec as { [RAW]?: unknown })[RAW] !== undefined
  ) {
    return null;
  }
  const entries = Object.entries(spec as Record<string, CallArg>);
  return entries.length === 0
    ? null
    : { labels: entries.map(([k]) => k), values: entries.map(([, v]) => v) };
}

function sameSequence(a: (string | null)[], b: (string | null)[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function matchInitializers(candidates: ClassInitializer[], options: MethodResolveOptions): ClassInitializer[] {
  let matches = candidates;
  if (options.arity !== undefined) {
    matches = matches.filter((c) => c.argTypes.length === options.arity);
  }
  if (options.labels !== undefined) {
    matches = matches.filter((c) => sameSequence(c.argLabels, options.labels!));
  }
  if (options.argTypes !== undefined) {
    matches = matches.filter((c) => sameSequence(c.argTypeNames, options.argTypes!));
  }
  return matches;
}

function selectInitializer(candidates: ClassInitializer[], options: MethodResolveOptions): ClassInitializer {
  if (candidates.length === 0) {
    throw new Error("no initializer found");
  }
  const matches = matchInitializers(candidates, options);
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length === 0) {
    const arities = [...new Set(candidates.map((c) => c.argTypes.length))].sort((a, b) => a - b).join(" or ");
    throw new Error(`init expects ${arities} argument(s), got ${options.arity}`);
  }
  const overloads = matches.map((c) => `init(${c.argLabels.map((l) => `${l ?? "_"}:`).join("")})`).join(", ");
  throw new Error(`init is ambiguous: ${overloads} (disambiguate with { labels } or { argTypes })`);
}

const ALLOCATING_CONSTRUCTOR = "fC";

export class ClassType extends NominalType {
  private initializers = new Map<ModuleScope, ClassInitializer[]>();

  get $superClass(): SwiftType | null {
    const superclass = new ClassMetadata(metadataOf(this).handle).superclass;
    return superclass !== null && superclass.isTypeMetadata
      ? typeOf(new Metadata(superclass.handle))
      : null;
  }

  get $isActor(): boolean {
    return isActor(descriptorOf(this));
  }

  get $isDefaultActor(): boolean {
    return isDefaultActor(descriptorOf(this));
  }

  init(...args: CallArg[]): SwiftClassObject {
    const lookup = this.initLookup(args);
    return this.$initializer(lookup.options).call(...lookup.args);
  }

  protected hasInitializer(labels: string[]): boolean {
    const declares = (modules: ModuleScope): boolean =>
      this.resolveInitializers(modules).some((c) => sameSequence(c.argLabels, labels));
    return declares("definingModule") || declares("allLoadedModules");
  }

  $initializer(options: MemberLookupOptions = {}): SwiftClassBoundInitializer {
    const own = matchInitializers(this.resolveInitializers("definingModule"), options);
    const chosen =
      own.length === 1 ? own[0] : selectInitializer(this.resolveInitializers("allLoadedModules"), options);
    const metadata = metadataOf(this);
    const fullName = this.fullName;
    const call = makeSwiftNativeFunction(chosen.address, metadata, chosen.argTypes, {
      hasSelf: true,
      throws: chosen.throws,
    });
    return {
      address: chosen.address,
      call: (...args) => {
        if (args.length !== chosen.argTypes.length) {
          throw new Error(`init expects ${chosen.argTypes.length} argument(s), got ${args.length}`);
        }
        const argPtrs = marshalConsumedArgs(chosen.argTypes, args);
        const instance = call(metadata.handle, ...argPtrs)!.readPointer();
        if (chosen.failable && instance.isNull()) {
          throw new Error(`${fullName}.init returned nil`);
        }
        return asSwiftObject(ClassInstance.adopt(instance));
      },
    };
  }

  $typeMethod(name: string, options: MemberLookupOptions = {}): SwiftBoundMethod {
    const raw = lowerResolveOptions({ ...options, static: true });
    if (isUnboundGeneric(this)) {
      return unboundGenericMethod(this.fullName, name, raw);
    }
    const resolved = findMethod(this.fullName, name, raw);
    const selfMetadata = metadataOf(this).handle;
    if (resolved === null) {
      return genericMember(this.fullName, name, raw) ?? narrowBoundMethod(bindConformanceMethod(this.fullName, selfMetadata, name, raw));
    }
    return narrowBoundMethod(
      resolved.async === true
        ? new BoundAsyncMethod(resolved, selfMetadata)
        : new BoundMethod(resolved, selfMetadata)
    );
  }

  private get fullName(): string {
    const name = descriptorOf(this).fullTypeName;
    if (name === null) {
      throw new Error("class has no type name");
    }
    return name;
  }

  private resolveInitializers(modules: ModuleScope): ClassInitializer[] {
    const cached = this.initializers.get(modules);
    if (cached !== undefined) {
      return cached;
    }
    const candidates = enumerateMethods(this.$name, modules, "thisType")
      .filter((m) => m.mangled.endsWith(ALLOCATING_CONSTRUCTOR))
      .map((m) => ({
        address: m.address,
        argTypes: m.argTypeNames.map((n) => {
          const metadata = resolveType(n);
          if (metadata === null) {
            throw new Error(`cannot resolve init argument type ${n}`);
          }
          return metadata;
        }),
        argLabels: m.argLabels,
        argTypeNames: m.argTypeNames,
        throws: m.throws,
        failable: m.returnTypeName !== null && isOptionalTypeName(m.returnTypeName),
      }));
    this.initializers.set(modules, candidates);
    return candidates;
  }
}

export interface TupleTypeElement {
  label: string | null;
  type: SwiftType;
}

export class TupleType extends SwiftType {
  get $elements(): TupleTypeElement[] {
    const metadata = metadataOf(this);
    // Swift stores the labels as one space-separated string, one token per element (empty = none).
    const labelString = tupleLabels(metadata);
    const labels = labelString === null ? [] : labelString.split(" ");
    return [...enumerateTupleElements(metadata)].map((e, i) => ({
      label: labels[i] ? labels[i] : null,
      type: typeOf(e.type),
    }));
  }
}

export class MetatypeType extends SwiftType {
  get $instanceType(): SwiftType {
    return typeOf(metatypeInstanceType(metadataOf(this)));
  }
}

export type ParameterConvention = "borrowing" | "consuming" | "inout";

export interface FunctionTypeParameter {
  type: SwiftType;
  convention: ParameterConvention;
  isVariadic: boolean;
}

export interface FunctionTypeSignature {
  parameters: FunctionTypeParameter[];
  result: SwiftType;
  throws: boolean;
  isAsync: boolean;
  isEscaping: boolean;
}

function parameterConvention(ownership: ParameterOwnership): ParameterConvention {
  switch (ownership) {
    case ParameterOwnership.InOut:
      return "inout";
    case ParameterOwnership.Owned:
      return "consuming";
    default:
      return "borrowing";
  }
}

export class FunctionType extends SwiftType {
  get $signature(): FunctionTypeSignature {
    const raw = readFunctionType(metadataOf(this));
    return {
      parameters: raw.parameters.map((p) => ({
        type: typeOf(p.type),
        convention: parameterConvention(p.ownership),
        isVariadic: p.isVariadic,
      })),
      result: typeOf(raw.resultType),
      throws: raw.isThrowing,
      isAsync: raw.isAsync,
      isEscaping: raw.isEscaping,
    };
  }
}

export function metadataOf(type: SwiftType): Metadata {
  const state = rawState.get(type)!;
  if (state.metadata === null) {
    state.metadata = getMetadata(state.descriptor!);
  }
  return state.metadata;
}

export function descriptorOf(type: SwiftType): ContextDescriptor {
  const state = rawState.get(type)!;
  return state.descriptor ?? metadataDescriptorOf(type);
}

function backingDescriptorOf(type: SwiftType): ContextDescriptor | null {
  return rawState.get(type)!.descriptor;
}

// A generic type named without its arguments has a descriptor but no metadata.
function isUnboundGeneric(type: SwiftType): boolean {
  const state = rawState.get(type)!;
  return state.metadata === null && state.descriptor !== null && state.descriptor.isGeneric;
}

type LookupOptions = ReturnType<typeof lowerResolveOptions>;

// A member found by name alone: its address can be hooked, but call refuses rather than guess at
// what binding it needs. Its call never returns, so it stands in for a bound method or initializer.
interface SwiftAddressOnly {
  readonly address: NativePointer;
  readonly origin: MemberOrigin;
  call(...args: CallArg[]): never;
}

function addressOnly(member: FoundMember, refusal: string): SwiftAddressOnly {
  return {
    address: member.address,
    origin: member.origin,
    call: () => {
      throw new Error(refusal);
    },
  };
}

// Every specialization shares a member's unspecialized code, so it is found without type arguments;
// calling it would need them as self metadata.
function unboundGenericMethod(typeName: string, name: string, options: LookupOptions): SwiftAddressOnly {
  const member = findMember(typeName, name, options);
  if (member === null) {
    throw new Error(`no method ${name} on ${typeName}`);
  }
  return addressOnly(member, `${typeName}.${member.selector} needs ${typeName}'s type arguments`);
}

// A generic member, e.g. init<D>(data: D), which findMethod skips.
function genericMember(typeName: string, name: string, options: LookupOptions): SwiftAddressOnly | null {
  const member = findMember(typeName, name, options);
  if (member === null || !member.generic) {
    return null;
  }
  return addressOnly(member, `${typeName}.${member.selector} is generic; calling it through its type is not supported yet`);
}

function metadataDescriptorOf(type: SwiftType): ContextDescriptor {
  const metadata = metadataOf(type);
  if (type instanceof ClassType) {
    return new ClassMetadata(metadata.handle).description;
  }
  if (type instanceof ForeignClassType || type instanceof ForeignReferenceType) {
    return new ContextDescriptor(metadata.handle.add(Process.pointerSize).readPointer().strip());
  }
  return metadata.description;
}

// Not existential: the marshalled path cannot construct protocol-existential arguments nor safely
// destroy an opaque existential return.
export type NativeFunctionType = SwiftType;

export interface MarshalledFunctionOptions {
  throws?: boolean;
}

function concreteMetadataOf(type: NativeFunctionType, role: string): Metadata {
  if (!(type instanceof SwiftType)) {
    throw new Error(`swiftFunction: ${role} is not a SwiftType`);
  }
  const metadata = metadataOf(type);
  if (metadata.kind === MetadataKind.Existential || metadata.kind === MetadataKind.ExtendedExistential) {
    throw new Error(`swiftFunction: ${role} ${typeName(metadata)} is existential; only concrete types are supported`);
  }
  return metadata;
}

// Best-effort: an address with no exported symbol (stripped/private) is assumed to borrow its arguments.
function paramConventionsAt(address: NativePointer): ParamConvention[] {
  const symbol = symbolicate(address);
  const parsed = symbol === null ? null : parseSwiftSignature(symbol.demangled);
  return parsed !== null && parsed.kind === "function" ? parsed.argTypeNames.map((n) => splitParamConvention(n).convention) : [];
}

export function swiftFunction(
  address: NativePointer,
  returnType: NativeFunctionType | null,
  argTypes: NativeFunctionType[],
  options: MarshalledFunctionOptions = {}
): (...args: CallArg[]) => CallResult {
  const conventions = paramConventionsAt(address);
  const argMetadata = argTypes.map((t, i) => concreteMetadataOf(t, `argument type ${i}`));
  const returnMetadata = returnType === null ? null : concreteMetadataOf(returnType, "return type");
  const lowered = argMetadata.map((m, i) => (conventions[i] === "inout" ? indirect(m) : m));
  const raw = makeSwiftNativeFunction(address, returnMetadata, lowered, { throws: options.throws });
  return (...args: CallArg[]): CallResult =>
    callMarshalled(argMetadata, args, returnMetadata, (argPtrs) => raw(...argPtrs), conventions);
}

const RESERVED = new Set(["constructor", "toString", "valueOf", "toJSON", "hasOwnProperty", "init"]);

// A nominal type's facade: its type methods, static properties, enum cases and nested types under
// their Swift names, the bridge's own members under $. Resolution is per name and lazy, like an
// object's; the listing stays shallow (the defining module).
function typeFacade<T extends NominalType>(target: T): T {
  const name = (): string => target.$name;
  const enumType = target instanceof EnumType ? target : null;

  const members = facadeMembers(name, true);

  let payloadByCase: Map<string, boolean> | null = null;
  const cases = (): Map<string, boolean> => {
    if (payloadByCase === null) {
      payloadByCase = new Map();
      if (enumType !== null) {
        for (const field of enumerateFields(descriptorOf(enumType))) {
          payloadByCase.set(field.name, field.mangledTypeName !== null);
        }
      }
    }
    return payloadByCase;
  };

  const nestedType = (key: string): SwiftType | null => {
    const descriptor = findType(`${name()}.${key}`);
    return descriptor === null ? null : typeFromDescriptor(descriptor);
  };
  const nestedTypeNames = (): string[] => {
    const prefix = `${name()}.`;
    const names: string[] = [];
    for (const descriptor of swiftTypes()) {
      const simple = descriptor.name;
      if (simple !== null && descriptor.fullTypeName === prefix + simple) {
        names.push(simple);
      }
    }
    return names;
  };

  const has = (key: string): boolean => {
    if (isBridgeMember(key, RESERVED)) {
      return Reflect.has(target, key);
    }
    if (POISON.has(key)) {
      return false;
    }
    const m = members.including(key);
    return m.methods.has(key) || m.properties.has(key) || cases().has(key) || nestedType(key) !== null;
  };

  const callable = callableCache((method, args) => target.$typeMethod(method, invokeOptions(args)).call(...args));

  const proxy = new Proxy(target, {
    has(t, key) {
      return typeof key === "string" ? has(key) : Reflect.has(t, key);
    },
    get(t, key) {
      if (typeof key === "symbol") {
        return Reflect.get(t, key);
      }
      if (key === "hasOwnProperty") {
        return has;
      }
      if (isBridgeMember(key, RESERVED)) {
        const member = Reflect.get(t, key, t);
        return typeof member === "function" && key !== "constructor" ? member.bind(t) : member;
      }
      if (POISON.has(key)) {
        return undefined;
      }
      const m = members.including(key);
      if (m.properties.has(key)) {
        return getStaticProperty(metadataOf(t), key);
      }
      if (m.methods.has(key)) {
        return callable(key);
      }
      const hasPayload = cases().get(key);
      if (hasPayload !== undefined) {
        return hasPayload ? (payload: SwiftValue) => enumType!.$case(key, payload) : enumType!.$case(key);
      }
      return nestedType(key) ?? undefined;
    },
    set(t, key, value) {
      if (typeof key !== "string") {
        return false;
      }
      const m = isBridgeMember(key, RESERVED) || POISON.has(key) ? null : members.including(key);
      if (m === null || !m.properties.has(key)) {
        throw new Error(`no static property ${key} on ${name()}`);
      }
      if (!m.writableProperties.has(key)) {
        throw new Error(`${key} on ${name()} is read-only`);
      }
      setStaticProperty(metadataOf(t), key, value);
      return true;
    },
    ownKeys() {
      const m = members.own();
      return [...new Set([...m.methods, ...m.properties, ...cases().keys(), ...nestedTypeNames()])];
    },
    getOwnPropertyDescriptor(_t, key) {
      const writable = typeof key === "string" && members.own().writableProperties.has(key);
      return { writable, configurable: true, enumerable: true };
    },
  });
  rawState.set(proxy, rawState.get(target)!);
  return proxy;
}

const wrappers = new Map<string, SwiftType>();

function cachedWrapper<T extends SwiftType>(key: NativePointer, make: () => T): T {
  const id = key.toString();
  let wrapper = wrappers.get(id);
  if (wrapper === undefined) {
    wrapper = make();
    wrappers.set(id, wrapper);
  }
  return wrapper as T;
}

function wrapperFromDescriptor(descriptor: ContextDescriptor): NominalType {
  switch (descriptor.kind) {
    case ContextDescriptorKind.Class:
      return typeFacade(new ClassType(descriptor));
    case ContextDescriptorKind.Struct:
      return typeFacade(new StructType(descriptor));
    case ContextDescriptorKind.Enum:
      return typeFacade(new EnumType(descriptor));
    default:
      throw new Error(`descriptor kind ${descriptor.kind} is not a type`);
  }
}

export function typeFromDescriptor(descriptor: ContextDescriptor): NominalType {
  return cachedWrapper(descriptor.handle, () => wrapperFromDescriptor(descriptor));
}

function wrapperFromMetadata(metadata: Metadata): SwiftType {
  switch (metadata.kind) {
    case MetadataKind.Struct:
      return typeFacade(new StructType(metadata));
    case MetadataKind.Enum:
    case MetadataKind.Optional:
      return typeFacade(new EnumType(metadata));
    case MetadataKind.Class:
      return typeFacade(new ClassType(metadata));
    case MetadataKind.Tuple:
      return new TupleType(metadata);
    case MetadataKind.Metatype:
      return new MetatypeType(metadata);
    case MetadataKind.Function:
      return new FunctionType(metadata);
    case MetadataKind.ObjCClassWrapper:
      return new ObjCClassWrapperType(metadata);
    case MetadataKind.ForeignClass:
      return new ForeignClassType(metadata);
    case MetadataKind.ForeignReferenceType:
      return new ForeignReferenceType(metadata);
    case MetadataKind.FixedArray:
    case MetadataKind.Borrow:
      throw new Error(`unsupported metadata kind ${MetadataKind[metadata.kind]}`);
    default:
      return new SwiftType(metadata);
  }
}

function nominalDescriptorOf(metadata: Metadata): ContextDescriptor | null {
  switch (metadata.kind) {
    case MetadataKind.Struct:
    case MetadataKind.Enum:
    case MetadataKind.Optional:
      return metadata.description;
    case MetadataKind.Class: {
      const cls = new ClassMetadata(metadata.handle);
      return cls.isTypeMetadata ? cls.description : null;
    }
    default:
      return null;
  }
}

// A non-generic nominal type has one wrapper, shared by its descriptor and its metadata; every
// generic specialization and every structural type is keyed by its runtime-uniqued metadata.
export function typeOf(metadata: Metadata): SwiftType {
  const descriptor = nominalDescriptorOf(metadata);
  if (descriptor === null || descriptor.isGeneric) {
    return cachedWrapper(metadata.handle, () => wrapperFromMetadata(metadata));
  }
  const wrapper = cachedWrapper(descriptor.handle, () => wrapperFromMetadata(metadata));
  const state = rawState.get(wrapper)!;
  state.metadata ??= metadata;
  state.descriptor ??= descriptor;
  return wrapper;
}

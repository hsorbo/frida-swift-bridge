import { Metadata, MetadataKind, getMetadata } from "../abi/metadata.js";
import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { ClassMetadata } from "../abi/class-metadata.js";
import { isActor, isDefaultActor } from "../abi/class-descriptor.js";
import { ValueInstance } from "../abi/value.js";
import { ClassInstance } from "../abi/heap-object.js";
import { asSwiftObject, SwiftClassObject, SwiftValueObject, RAW } from "./object-facade.js";
import { SwiftValue } from "../abi/instance.js";
import { enumerateFields, fieldTypeIn } from "../abi/field-descriptor.js";
import { makeSwiftNativeFunction } from "./calling-convention.js";
import { parseSwiftSignature, resolveType, symbolicate } from "./symbolication.js";
import {
  BoundMethod,
  BoundAsyncMethod,
  SwiftBoundMethod,
  SwiftBoundInitializer,
  narrowBoundMethod,
  narrowBoundInitializer,
  marshalConsumedArgs,
  assertBorrowingArgs,
  CallArg,
  CallResult,
  MethodResolveOptions,
  PropertyInfo,
  bindStaticMethod,
  bindValueInitializer,
  callBorrowingArgs,
  enumerateMethods,
  ModuleScope,
  enumerateProperties,
  lowerResolveOptions,
  findMethod,
  bindConformanceMethod,
} from "./method.js";
import { enumerateTupleElements, tupleLabels } from "../abi/tuple.js";
import { metatypeInstanceType } from "../abi/metatype.js";
import { readFunctionType, ParameterOwnership } from "../abi/function-type.js";
import { demangle } from "./demangle.js";
import { typeName } from "./type-name.js";
import { Protocol, protocolsForType } from "./protocol.js";

export interface TypeMember {
  name: string;
  type: SwiftType | null;
  isVar: boolean;
}

export interface MethodQuery {
  static?: boolean;
  inherited?: boolean;
}

function typeKindName(metadata: Metadata): string {
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

  get name(): string {
    return backingDescriptorOf(this)?.fullTypeName ?? typeName(metadataOf(this));
  }

  get superClass(): SwiftType | null {
    return null;
  }

  get moduleName(): string | null {
    return descriptorOf(this).moduleName;
  }

  toJSON(): { kind: string; name: string; module: string | null } {
    return { kind: this.kindName, name: this.name, module: this.jsonModule() };
  }

  private get kindName(): string {
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
    return this.moduleName;
  }

  methods(options: MethodQuery = {}): string[] {
    const { static: wantStatic = false, inherited = true } = options;
    return enumerateMethods(this.name, "allLoadedModules", inherited ? "withSuperclasses" : "thisType")
      .filter((m) => m.kind === "method" && m.isStatic === wantStatic)
      .map((m) => m.selector);
  }

  protocols(): { [name: string]: Protocol } {
    return protocolsForType(descriptorOf(this).handle);
  }

  get properties(): PropertyInfo[] {
    return enumerateProperties(this.name);
  }
}

export class ValueType extends SwiftType {
  method(name: string, options: MethodResolveOptions = {}): SwiftBoundMethod {
    return narrowBoundMethod(bindStaticMethod(metadataOf(this), name, lowerResolveOptions(options)));
  }

  call(name: string, ...args: SwiftValue[]): CallResult | Promise<CallResult> {
    return this.method(name).call(...args);
  }

  initializer(options: MethodResolveOptions = {}): SwiftBoundInitializer {
    return narrowBoundInitializer(bindValueInitializer(metadataOf(this), lowerResolveOptions(options)));
  }

  init(...args: CallArg[]): SwiftValueObject | null {
    const labeled = asLabeledArgs(args);
    if (labeled !== null && this.hasInitializer(labeled.labels)) {
      return this.initializer({ labels: labeled.labels }).call(...labeled.values);
    }
    return this.initializer({ arity: args.length }).call(...args);
  }

  private hasInitializer(labels: string[]): boolean {
    const declares = (modules: ModuleScope): boolean =>
      enumerateMethods(this.name, modules).some(
        (m) => m.name === "init" && sameSequence(m.argLabels, labels)
      );
    return declares("definingModule") || declares("allLoadedModules");
  }

  fromJS(value: SwiftValue): SwiftValueObject {
    return asSwiftObject(ValueInstance.fromJS(metadataOf(this), value));
  }

  borrow(address: NativePointer): SwiftValueObject {
    return asSwiftObject(ValueInstance.borrow(metadataOf(this), address));
  }

  copy(address: NativePointer): SwiftValueObject {
    return asSwiftObject(ValueInstance.fromCopy(metadataOf(this), address));
  }

  adopt(address: NativePointer): SwiftValueObject {
    return asSwiftObject(ValueInstance.adopt(metadataOf(this), address));
  }
}

export class StructType extends ValueType {
  new(value: SwiftValue): SwiftValueObject {
    return this.fromJS(value);
  }

  get fields(): TypeMember[] {
    const metadata = metadataOf(this);
    return [...enumerateFields(metadata.description)].map((f) => {
      const type = fieldTypeIn(metadata, f);
      return { name: f.name, type: type === null ? null : typeOf(type), isVar: f.isVar };
    });
  }
}

export class EnumType extends ValueType {
  case(name: string, payload?: SwiftValue): SwiftValueObject {
    return asSwiftObject(ValueInstance.fromJS(metadataOf(this), payload === undefined ? name : { [name]: payload }));
  }

  get cases(): TypeMember[] {
    const metadata = metadataOf(this);
    return [...enumerateFields(metadata.description)].map((f) => {
      const type = f.mangledTypeName !== null ? fieldTypeIn(metadata, f) : null;
      return { name: f.name, type: type === null ? null : typeOf(type), isVar: f.isVar };
    });
  }
}

export class ObjCClassWrapperType extends SwiftType {
  get objcClass(): NativePointer {
    return metadataOf(this).handle.add(Process.pointerSize).readPointer().strip();
  }
}

export class ForeignClassType extends SwiftType {
  get superClass(): ForeignClassType | null {
    const superclass = metadataOf(this).handle.add(2 * Process.pointerSize).readPointer().strip();
    return superclass.isNull() ? null : new ForeignClassType(new Metadata(superclass));
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

export class ClassType extends SwiftType {
  private initializers = new Map<ModuleScope, ClassInitializer[]>();

  get superClass(): SwiftType | null {
    const superclass = new ClassMetadata(metadataOf(this).handle).superclass;
    return superclass !== null && superclass.isTypeMetadata
      ? typeOf(new Metadata(superclass.handle))
      : null;
  }

  get isActor(): boolean {
    return isActor(descriptorOf(this));
  }

  get isDefaultActor(): boolean {
    return isDefaultActor(descriptorOf(this));
  }

  init(...args: CallArg[]): SwiftClassObject {
    const labeled = asLabeledArgs(args);
    if (labeled !== null && this.hasInitializer(labeled.labels)) {
      return this.initializer({ labels: labeled.labels }).call(...labeled.values);
    }
    return this.initializer({ arity: args.length }).call(...args);
  }

  private hasInitializer(labels: string[]): boolean {
    const declares = (modules: ModuleScope): boolean =>
      this.resolveInitializers(modules).some((c) => sameSequence(c.argLabels, labels));
    return declares("definingModule") || declares("allLoadedModules");
  }

  initializer(options: MethodResolveOptions = {}): SwiftClassBoundInitializer {
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

  method(name: string, options: MethodResolveOptions = {}): SwiftBoundMethod {
    const raw = lowerResolveOptions({ ...options, static: true });
    const resolved = findMethod(this.fullName, name, raw);
    const selfMetadata = metadataOf(this).handle;
    if (resolved === null) {
      return narrowBoundMethod(bindConformanceMethod(this.fullName, selfMetadata, name, raw));
    }
    return narrowBoundMethod(
      resolved.async === true
        ? new BoundAsyncMethod(resolved, selfMetadata)
        : new BoundMethod(resolved, selfMetadata)
    );
  }

  call(name: string, ...args: SwiftValue[]): CallResult | Promise<CallResult> {
    return this.method(name).call(...args);
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
    const candidates = enumerateMethods(this.name, modules, "thisType")
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
  get elements(): TupleTypeElement[] {
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
  get instanceType(): SwiftType {
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
  get signature(): FunctionTypeSignature {
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

// Best-effort: an address with no exported symbol (stripped/private) is assumed to borrow its
// arguments, the only convention callBorrowingArgs is safe for. A consuming (__owned) or inout
// parameter must be bound through /abi's makeSwiftNativeFunction with { consumedArgs }.
function rejectNonBorrowing(address: NativePointer): void {
  const symbol = symbolicate(address);
  if (symbol === null) {
    return;
  }
  const parsed = parseSwiftSignature(symbol.demangled);
  if (parsed !== null && parsed.kind === "function") {
    assertBorrowingArgs(parsed.argTypeNames, symbol.demangled);
  }
}

export function swiftFunction(
  address: NativePointer,
  returnType: NativeFunctionType | null,
  argTypes: NativeFunctionType[],
  options: MarshalledFunctionOptions = {}
): (...args: CallArg[]) => CallResult {
  rejectNonBorrowing(address);
  const argMetadata = argTypes.map((t, i) => concreteMetadataOf(t, `argument type ${i}`));
  const returnMetadata = returnType === null ? null : concreteMetadataOf(returnType, "return type");
  const raw = makeSwiftNativeFunction(address, returnMetadata, argMetadata, { throws: options.throws });
  return (...args: CallArg[]): CallResult =>
    callBorrowingArgs(argMetadata, args, returnMetadata, (argPtrs) => raw(...argPtrs));
}

export function typeFromDescriptor(descriptor: ContextDescriptor): SwiftType {
  switch (descriptor.kind) {
    case ContextDescriptorKind.Class:
      return new ClassType(descriptor);
    case ContextDescriptorKind.Struct:
      return new StructType(descriptor);
    case ContextDescriptorKind.Enum:
      return new EnumType(descriptor);
    default:
      throw new Error(`descriptor kind ${descriptor.kind} is not a type`);
  }
}

export function typeOf(metadata: Metadata): SwiftType {
  switch (metadata.kind) {
    case MetadataKind.Struct:
      return new StructType(metadata);
    case MetadataKind.Enum:
    case MetadataKind.Optional:
      return new EnumType(metadata);
    case MetadataKind.Class:
      return new ClassType(metadata);
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

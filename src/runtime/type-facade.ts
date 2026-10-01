import { ValueInstance } from "../abi/value.js";
import { ClassInstance } from "../abi/heap-object.js";
import { SwiftValue } from "../abi/instance.js";
import { enumerateFields } from "../abi/field-descriptor.js";
import { asSwiftObject, SwiftClassObject, SwiftValueObject, SwiftObject, RAW } from "./object-facade.js";
import { makeSwiftNativeFunction } from "./calling-convention.js";
import { resolveType, parseTypeExpr } from "./symbolication.js";
import {
  bindResolved,
  SwiftBoundMethod,
  SwiftBoundInitializer,
  narrowBoundMethod,
  narrowBoundInitializer,
  marshalConsumedArgs,
  CallArg,
  CallResult,
  MethodResolveOptions,
  MemberOrigin,
  bindStaticMethod,
  bindValueInitializer,
  enumerateMethods,
  ModuleScope,
  getStaticProperty,
  setStaticProperty,
  lowerResolveOptions,
  splitSelector,
  initializerLookup,
  findMethod,
  findMember,
  FoundMember,
  bindConformanceMethod,
} from "./method.js";
import { findType, swiftTypes } from "../reflection/registry.js";
import { POISON, isBridgeMember, invokeOptions, facadeMembers, callableCache, FacadeMembers, FacadeCallable } from "./facade-members.js";
import {
  NominalType,
  ClassType,
  StructType,
  EnumType,
  MemberLookupOptions,
  SwiftMember,
  metadataOf,
  descriptorOf,
  isUnboundGeneric,
  typeFromDescriptor,
} from "./swift-type.js";

export interface SwiftClassBoundInitializer {
  readonly address: NativePointer;
  call(...args: CallArg[]): SwiftClassObject;
}

// A nominal type's facade: its type methods, static properties, enum cases and nested types under
// their Swift names, the bridge's own members under $, and reflection on the type through $type.
export abstract class SwiftTypeFacade {
  [key: string]: any;

  /** @internal Reached through a NominalType's `facade`, `Swift.type` and `Swift.modules`. */
  constructor(readonly $type: NominalType) {}

  toString(): string {
    return this.$type.name;
  }

  toJSON(): { kind: string; name: string; module: string | null } {
    return this.$type.toJSON();
  }

  $get(name: string): CallResult {
    return getStaticProperty(metadataOf(this.$type), name);
  }

  $set(name: string, value: CallArg): void {
    setStaticProperty(metadataOf(this.$type), name, value);
  }

  $call(name: string, ...args: CallArg[]): CallResult | Promise<CallResult> {
    return this.$typeMethod(name, invokeOptions(args)).call(...args);
  }

  abstract $typeMethod(name: string, options?: MemberLookupOptions): SwiftBoundMethod;
  abstract $initializer(
    selector?: string | MemberLookupOptions,
    options?: MemberLookupOptions
  ): SwiftBoundInitializer | SwiftClassBoundInitializer;
  abstract init(...args: CallArg[]): SwiftObject | null;
  protected abstract hasInitializer(labels: string[]): boolean;

  // A lone { label: value } object selects a labeled initializer when the type declares one.
  protected initLookup(args: CallArg[]): { options: MemberLookupOptions; args: CallArg[] } {
    const labeled = asLabeledArgs(args);
    return labeled !== null && this.hasInitializer(labeled.labels)
      ? { options: { labels: labeled.labels }, args: labeled.values }
      : { options: { arity: args.length }, args };
  }
}

export abstract class SwiftValueType extends SwiftTypeFacade {
  declare readonly $type: StructType | EnumType;

  $typeMethod(selector: string, selectorOptions: MemberLookupOptions = {}): SwiftBoundMethod {
    const { name, options } = splitSelector(selector, selectorOptions);
    const type = this.$type;
    const raw = lowerResolveOptions(options);
    const lookup = { ...raw, static: true };
    if (isUnboundGeneric(type)) {
      return needsTypeArguments(type, type.typeMethod(name, options));
    }
    if (findMethod(type.name, name, lookup) === null) {
      const generic = genericMember(type.name, name, lookup);
      if (generic !== null) {
        return generic;
      }
    }
    return narrowBoundMethod(bindStaticMethod(metadataOf(type), name, raw));
  }

  $initializer(selector?: string | MemberLookupOptions, selectorOptions: MemberLookupOptions = {}): SwiftBoundInitializer {
    const options = initializerLookup(selector, selectorOptions);
    const type = this.$type;
    const raw = lowerResolveOptions(options);
    if (isUnboundGeneric(type)) {
      return needsTypeArguments(type, type.initializer(options));
    }
    if (findMethod(type.name, "init", raw) === null) {
      const generic = genericMember(type.name, "init", raw);
      if (generic !== null) {
        return generic;
      }
    }
    return narrowBoundInitializer(bindValueInitializer(metadataOf(type), raw));
  }

  init(...args: CallArg[]): SwiftValueObject | null {
    const lookup = this.initLookup(args);
    return this.$initializer(lookup.options).call(...lookup.args);
  }

  protected hasInitializer(labels: string[]): boolean {
    const declares = (modules: ModuleScope): boolean =>
      enumerateMethods(this.$type.name, modules).some(
        (m) => m.name === "init" && sameSequence(m.argLabels, labels)
      );
    return declares("definingModule") || declares("allLoadedModules");
  }

  $new(value: SwiftValue): SwiftValueObject {
    return asSwiftObject(ValueInstance.fromJS(metadataOf(this.$type), value));
  }

  $borrow(address: NativePointer): SwiftValueObject {
    return asSwiftObject(ValueInstance.borrow(metadataOf(this.$type), address));
  }

  $copy(address: NativePointer): SwiftValueObject {
    return asSwiftObject(ValueInstance.fromCopy(metadataOf(this.$type), address));
  }

  $adopt(address: NativePointer): SwiftValueObject {
    return asSwiftObject(ValueInstance.adopt(metadataOf(this.$type), address));
  }
}

export class SwiftStruct extends SwiftValueType {
  declare readonly $type: StructType;
}

export class SwiftEnum extends SwiftValueType {
  declare readonly $type: EnumType;

  $case(name: string, payload?: SwiftValue): SwiftValueObject {
    return asSwiftObject(ValueInstance.fromJS(metadataOf(this.$type), payload === undefined ? name : { [name]: payload }));
  }
}

interface ClassInitializer {
  address: NativePointer;
  argLabels: (string | null)[];
  argTypeNames: string[];
  throws: boolean;
  failable: boolean;
}

function isOptionalTypeName(name: string): boolean {
  return parseTypeExpr(name)?.kind === "optional";
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
    matches = matches.filter((c) => c.argTypeNames.length === options.arity);
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
    const arities = [...new Set(candidates.map((c) => c.argTypeNames.length))].sort((a, b) => a - b).join(" or ");
    throw new Error(`init expects ${arities} argument(s), got ${options.arity}`);
  }
  const overloads = matches.map((c) => `init(${c.argLabels.map((l) => `${l ?? "_"}:`).join("")})`).join(", ");
  throw new Error(`init is ambiguous: ${overloads} (disambiguate with { labels } or { argTypes })`);
}

const ALLOCATING_CONSTRUCTOR = "fC";

export class SwiftClass extends SwiftTypeFacade {
  declare readonly $type: ClassType;
  private initializers = new Map<ModuleScope, ClassInitializer[]>();
  private initializersAmongModules = 0;

  init(...args: CallArg[]): SwiftClassObject {
    const lookup = this.initLookup(args);
    return this.$initializer(lookup.options).call(...lookup.args);
  }

  protected hasInitializer(labels: string[]): boolean {
    const declares = (modules: ModuleScope): boolean =>
      this.resolveInitializers(modules).some((c) => sameSequence(c.argLabels, labels));
    return declares("definingModule") || declares("allLoadedModules");
  }

  $initializer(selector?: string | MemberLookupOptions, selectorOptions: MemberLookupOptions = {}): SwiftClassBoundInitializer {
    const options = initializerLookup(selector, selectorOptions);
    const own = matchInitializers(this.resolveInitializers("definingModule"), options);
    const chosen =
      own.length === 1 ? own[0] : selectInitializer(this.resolveInitializers("allLoadedModules"), options);
    const metadata = metadataOf(this.$type);
    const fullName = this.$type.name;
    const argTypes = chosen.argTypeNames.map((n) => {
      const argType = resolveType(n);
      if (argType === null) {
        throw new Error(`cannot resolve init argument type ${n}`);
      }
      return argType;
    });
    const call = makeSwiftNativeFunction(chosen.address, metadata, argTypes, {
      hasSelf: true,
      throws: chosen.throws,
    });
    return {
      address: chosen.address,
      call: (...args) => {
        if (args.length !== argTypes.length) {
          throw new Error(`init expects ${argTypes.length} argument(s), got ${args.length}`);
        }
        const argPtrs = marshalConsumedArgs(argTypes, args);
        const instance = call(metadata.handle, ...argPtrs)!.readPointer();
        if (chosen.failable && instance.isNull()) {
          throw new Error(`${fullName}.init returned nil`);
        }
        return asSwiftObject(ClassInstance.adopt(instance));
      },
    };
  }

  $typeMethod(selector: string, selectorOptions: MemberLookupOptions = {}): SwiftBoundMethod {
    const { name, options } = splitSelector(selector, selectorOptions);
    const type = this.$type;
    const raw = lowerResolveOptions({ ...options, static: true });
    if (isUnboundGeneric(type)) {
      return needsTypeArguments(type, type.typeMethod(name, options));
    }
    const resolved = findMethod(type.name, name, raw);
    const selfMetadata = metadataOf(type).handle;
    if (resolved === null) {
      return genericMember(type.name, name, raw) ?? narrowBoundMethod(bindConformanceMethod(type.name, selfMetadata, name, raw));
    }
    return narrowBoundMethod(bindResolved(resolved, selfMetadata));
  }

  private resolveInitializers(modules: ModuleScope): ClassInitializer[] {
    if (modules === "allLoadedModules") {
      const moduleCount = Process.enumerateModules().length;
      if (moduleCount !== this.initializersAmongModules) {
        this.initializers.delete(modules);
        this.initializersAmongModules = moduleCount;
      }
    }
    const cached = this.initializers.get(modules);
    if (cached !== undefined) {
      return cached;
    }
    const candidates = enumerateMethods(this.$type.name, modules, "thisType")
      .filter((m) => m.mangled.endsWith(ALLOCATING_CONSTRUCTOR))
      .map((m) => ({
        address: m.address.strip(),
        argLabels: m.argLabels,
        argTypeNames: m.argTypeNames,
        throws: m.throws,
        failable: m.returnTypeName !== null && isOptionalTypeName(m.returnTypeName),
      }));
    this.initializers.set(modules, candidates);
    return candidates;
  }
}

type LookupOptions = ReturnType<typeof lowerResolveOptions>;

// A member found by name alone: its address can be hooked, but call refuses rather than guess at
// what binding it needs. Its call never returns, so it stands in for a bound method or initializer.
interface SwiftAddressOnly {
  readonly address: NativePointer;
  readonly origin: MemberOrigin;
  call(...args: CallArg[]): never;
}

function addressOnly(member: SwiftMember | FoundMember, refusal: string): SwiftAddressOnly {
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
function needsTypeArguments(type: NominalType, member: SwiftMember): SwiftAddressOnly {
  return addressOnly(member, `${type.name}.${member.selector} needs ${type.name}'s type arguments`);
}

// A generic member, e.g. init<D>(data: D), which findMethod skips.
function genericMember(typeName: string, name: string, options: LookupOptions): SwiftAddressOnly | null {
  const member = findMember(typeName, name, options);
  if (member === null || !member.generic) {
    return null;
  }
  return addressOnly(member, `${typeName}.${member.selector} is generic; calling it through its type is not supported yet`);
}

const RESERVED = new Set(["constructor", "toString", "valueOf", "toJSON", "hasOwnProperty", "init"]);

// Resolution is per name and lazy, like an object's; the listing stays shallow (the defining module).
export function typeFacade<T extends SwiftTypeFacade>(target: T): T {
  return new Proxy(target, typeFacadeHandler as ProxyHandler<T>);
}

interface TypeFacadeState {
  members: FacadeMembers;
  callable: (name: string) => FacadeCallable;
  cases: Map<string, boolean> | null;
  has: (key: string) => boolean;
}

const typeFacadeStates = new WeakMap<SwiftTypeFacade, TypeFacadeState>();

function typeFacadeState(target: SwiftTypeFacade): TypeFacadeState {
  let state = typeFacadeStates.get(target);
  if (state === undefined) {
    state = {
      members: facadeMembers(() => target.$type.name, true),
      callable: callableCache((method, args) => target.$typeMethod(method, invokeOptions(args)).call(...args)),
      cases: null,
      has: (key) => typeFacadeHas(target, key),
    };
    typeFacadeStates.set(target, state);
  }
  return state;
}

function enumCases(target: SwiftTypeFacade): Map<string, boolean> {
  const state = typeFacadeState(target);
  if (state.cases === null) {
    state.cases = new Map();
    if (target instanceof SwiftEnum) {
      for (const field of enumerateFields(descriptorOf(target.$type))) {
        state.cases.set(field.name, field.mangledTypeName !== null);
      }
    }
  }
  return state.cases;
}

function nestedType(target: SwiftTypeFacade, key: string): SwiftTypeFacade | null {
  const descriptor = findType(`${target.$type.name}.${key}`);
  return descriptor === null ? null : typeFromDescriptor(descriptor).facade;
}

function nestedTypeNames(target: SwiftTypeFacade): string[] {
  const prefix = `${target.$type.name}.`;
  const names: string[] = [];
  for (const descriptor of swiftTypes()) {
    const simple = descriptor.name;
    if (simple !== null && descriptor.fullTypeName === prefix + simple) {
      names.push(simple);
    }
  }
  return names;
}

function typeFacadeHas(target: SwiftTypeFacade, key: string): boolean {
  if (isBridgeMember(key, RESERVED)) {
    return Reflect.has(target, key);
  }
  if (POISON.has(key)) {
    return false;
  }
  const m = typeFacadeState(target).members.including(key);
  return m.methods.has(key) || m.properties.has(key) || enumCases(target).has(key) || nestedType(target, key) !== null;
}

const typeFacadeHandler: ProxyHandler<SwiftTypeFacade> = {
  has(t, key) {
    return typeof key === "string" ? typeFacadeHas(t, key) : Reflect.has(t, key);
  },
  get(t, key) {
    if (typeof key === "symbol") {
      return Reflect.get(t, key);
    }
    if (key === "hasOwnProperty") {
      return typeFacadeState(t).has;
    }
    if (isBridgeMember(key, RESERVED)) {
      const member = Reflect.get(t, key, t);
      return typeof member === "function" && key !== "constructor" ? member.bind(t) : member;
    }
    if (POISON.has(key)) {
      return undefined;
    }
    const state = typeFacadeState(t);
    const m = state.members.including(key);
    if (m.properties.has(key)) {
      return getStaticProperty(metadataOf(t.$type), key);
    }
    if (m.methods.has(key)) {
      return state.callable(key);
    }
    const hasPayload = enumCases(t).get(key);
    if (hasPayload !== undefined) {
      const enumType = t as SwiftEnum;
      return hasPayload ? (payload: SwiftValue) => enumType.$case(key, payload) : enumType.$case(key);
    }
    return nestedType(t, key) ?? undefined;
  },
  set(t, key, value) {
    if (typeof key !== "string") {
      return false;
    }
    const m = isBridgeMember(key, RESERVED) || POISON.has(key) ? null : typeFacadeState(t).members.including(key);
    if (m === null || !m.properties.has(key)) {
      throw new Error(`no static property ${key} on ${t.$type.name}`);
    }
    if (!m.writableProperties.has(key)) {
      throw new Error(`${key} on ${t.$type.name} is read-only`);
    }
    setStaticProperty(metadataOf(t.$type), key, value);
    return true;
  },
  ownKeys(t) {
    const m = typeFacadeState(t).members.own();
    return [...new Set([...m.methods, ...m.properties, ...enumCases(t).keys(), ...nestedTypeNames(t)])];
  },
  getOwnPropertyDescriptor(t, key) {
    if (typeof key !== "string" || !typeFacadeHas(t, key)) {
      return undefined;
    }
    return { writable: typeFacadeState(t).members.own().writableProperties.has(key), configurable: true, enumerable: true };
  },
};

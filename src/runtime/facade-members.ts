import {
  AccessorKind,
  CallArg,
  CallResult,
  MemberOrigin,
  SwiftBoundMethod,
  SwiftBoundSignature,
  ValueMethodResolveOptions,
  enumerateMethods,
  enumerateProperties,
  hookTargetOf,
  memberKindsInOtherModules,
  splitSelector,
  withHookTarget,
} from "./method.js";
import type { MemberLookupOptions } from "./swift-type.js";
import { ClosureSpec, isSwiftClosureValue } from "./closure.js";

// A synthesized `then` would make a facade thenable and silently break `await`; never a member.
export const POISON = new Set(["then", "catch", "finally"]);

// The bridge's own members live under $; `reserved` adds the JS protocol names a facade answers itself.
export function isBridgeMember(key: string, reserved: Set<string>): boolean {
  return key.startsWith("$") || reserved.has(key);
}

// A subscript picked by selector ("subscript(row:column:)") or lookup options, its indices kept
// apart from both; the getter and the setter each resolve on first use, by the index count that
// use supplies unless the lookup names an arity.
export interface SwiftBoundSubscript {
  get(...indices: CallArg[]): CallResult;
  set(...indicesThenValue: CallArg[]): void;
}

export function bindSubscript(
  selector: string | MemberLookupOptions | undefined,
  options: MemberLookupOptions,
  resolve: (options: MemberLookupOptions) => SwiftBoundMethod
): SwiftBoundSubscript {
  const lookup = typeof selector === "string" ? splitSelector(selector, options) : { name: "subscript", options: selector ?? options };
  if (lookup.name !== "subscript") {
    throw new Error(`${selector} is not a subscript selector`);
  }
  const accessor = (kind: AccessorKind, indexCount: number): SwiftBoundMethod =>
    resolve({ ...lookup.options, arity: lookup.options.arity ?? indexCount, accessor: kind });
  let getter: SwiftBoundMethod | null = null;
  let setter: SwiftBoundMethod | null = null;
  return {
    get(...indices) {
      getter ??= accessor("getter", indices.length);
      return getter.call(...indices) as CallResult;
    },
    set(...indicesThenValue) {
      if (indicesThenValue.length === 0) {
        throw new Error("set takes the indices and then the element to store");
      }
      const value = indicesThenValue[indicesThenValue.length - 1];
      const indices = indicesThenValue.slice(0, -1);
      setter ??= accessor("setter", indices.length);
      setter.call(value, ...indices);
    },
  };
}

export function invokeOptions(args: CallArg[]): ValueMethodResolveOptions {
  const options: ValueMethodResolveOptions = { arity: args.length };
  if (args.some((a) => a instanceof ClosureSpec || isSwiftClosureValue(a))) {
    options.typeArguments = []; // generic path; planGenericMethod infers the closure-result R
  }
  return options;
}

export interface MemberIndex {
  methods: Set<string>;
  properties: Set<string>;
  writableProperties: Set<string>;
}

export interface FacadeMembers {
  own(): MemberIndex;
  including(key: string): MemberIndex;
}

// The Swift members a facade answers: the defining module's are indexed up front; one another
// module or a protocol extension adds joins the index when its name is first asked for. A miss is
// remembered only until another module loads.
export function facadeMembers(typeName: () => string, isStatic: boolean): FacadeMembers {
  let index: MemberIndex | null = null;
  const own = (): MemberIndex => {
    if (index === null) {
      const properties = enumerateProperties(typeName(), "definingModule").filter((p) => p.isStatic === isStatic);
      index = {
        methods: new Set(
          enumerateMethods(typeName(), "definingModule")
            .filter((m) => m.kind === "method" && m.isStatic === isStatic)
            .map((m) => m.name)
        ),
        properties: new Set(properties.map((p) => p.name)),
        writableProperties: new Set(properties.filter((p) => p.writable).map((p) => p.name)),
      };
    }
    return index;
  };
  let searched = new Set<string>();
  let searchedAmongModules = 0;
  const including = (key: string): MemberIndex => {
    const members = own();
    if (members.methods.has(key) || members.properties.has(key)) {
      return members;
    }
    const moduleCount = Process.enumerateModules().length;
    if (moduleCount !== searchedAmongModules) {
      searched = new Set();
      searchedAmongModules = moduleCount;
    }
    if (searched.has(key)) {
      return members;
    }
    searched.add(key);
    const found = memberKindsInOtherModules(typeName(), key, isStatic);
    if (found.method) {
      members.methods.add(key);
    }
    if (found.property) {
      members.properties.add(key);
    }
    if (found.writable) {
      members.writableProperties.add(key);
    }
    return members;
  };
  return { own, including };
}

// A facade's method: called like a function, hooked like the member it names.
export interface FacadeCallable {
  (...args: CallArg[]): CallResult | Promise<CallResult>;
  readonly address: NativePointer;
  readonly origin: MemberOrigin;
  readonly signature: SwiftBoundSignature;
}

// What a facade's proxy needs from its target: the Swift member index and how to read, write and
// call a member, plus its own bridge members and the keys only it answers (enum cases, nested types).
export interface MemberProxyParts<T extends object> {
  members: FacadeMembers;
  reserved: Set<string>;
  has(key: string): boolean;
  bridgeMember(target: T, key: string | symbol): unknown;
  read(key: string): CallResult;
  write(key: string, value: CallArg): void;
  callable(key: string): FacadeCallable;
  fallback(target: T, key: string): unknown;
  ownKeys(target: T, own: MemberIndex): string[];
  owner(): string;
  propertyNoun: string;
}

// Swift members answer to their bare names and resolve when read; the bridge's own are $-prefixed
// or reserved; POISON names are never members.
export function memberProxyHandler<T extends object>(partsOf: (target: T) => MemberProxyParts<T>): ProxyHandler<T> {
  return {
    has(t, key) {
      return typeof key === "string" ? partsOf(t).has(key) : Reflect.has(t, key);
    },
    get(t, key) {
      const parts = partsOf(t);
      if (typeof key === "symbol" || isBridgeMember(key, parts.reserved)) {
        return parts.bridgeMember(t, key);
      }
      if (POISON.has(key)) {
        return undefined;
      }
      const m = parts.members.including(key);
      if (m.properties.has(key)) {
        return parts.read(key);
      }
      if (m.methods.has(key)) {
        return parts.callable(key);
      }
      return parts.fallback(t, key);
    },
    set(t, key, value) {
      if (typeof key !== "string") {
        return false;
      }
      const parts = partsOf(t);
      const m = isBridgeMember(key, parts.reserved) || POISON.has(key) ? null : parts.members.including(key);
      if (m === null || !m.properties.has(key)) {
        throw new Error(`no ${parts.propertyNoun} ${key} on ${parts.owner()}`);
      }
      if (!m.writableProperties.has(key)) {
        throw new Error(`${key} on ${parts.owner()} is read-only`);
      }
      parts.write(key, value as CallArg);
      return true;
    },
    ownKeys(t) {
      const parts = partsOf(t);
      return parts.ownKeys(t, parts.members.own());
    },
    getOwnPropertyDescriptor(t, key) {
      const parts = partsOf(t);
      if (typeof key !== "string" || !parts.has(key)) {
        return undefined;
      }
      return { writable: parts.members.own().writableProperties.has(key), configurable: true, enumerable: true };
    },
  };
}

// One function per name, so a facade's method compares equal to itself across reads. Calling it
// resolves per call from the arguments; its address and signature resolve once from the bare name,
// so an overloaded name refuses there and points at $method.
export function callableCache(
  invoke: (name: string, args: CallArg[]) => CallResult | Promise<CallResult>,
  resolve: (name: string) => SwiftBoundMethod
): (name: string) => FacadeCallable {
  const callables = new Map<string, FacadeCallable>();
  return (name) => {
    let fn = callables.get(name);
    if (fn === undefined) {
      fn = hookableCallable((...args) => invoke(name, args), () => resolve(name));
      callables.set(name, fn);
    }
    return fn;
  };
}

function hookableCallable(fn: (...args: CallArg[]) => CallResult | Promise<CallResult>, resolve: () => SwiftBoundMethod): FacadeCallable {
  let resolved: SwiftBoundMethod | null = null;
  const method = (): SwiftBoundMethod => (resolved ??= resolve());
  withHookTarget(fn, () => hookTargetOf(method()));
  return Object.defineProperties(fn, {
    address: { get: () => method().address },
    origin: { get: () => method().origin },
    signature: { get: () => method().signature },
  }) as FacadeCallable;
}

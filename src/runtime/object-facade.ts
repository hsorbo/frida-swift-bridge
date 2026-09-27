import { ClassInstance } from "../abi/heap-object.js";
import { ValueInstance } from "../abi/value.js";
import { Metadata } from "../abi/metadata.js";
import { SwiftValue } from "../abi/instance.js";
import {
  SwiftBoundMethod,
  narrowBoundMethod,
  CallResult,
  CallArg,
  MethodResolveOptions,
  ValueMethodResolveOptions,
  lowerResolveOptions,
  enumerateMethods,
  enumerateProperties,
  instanceMemberKindsInOtherModules,
} from "./method.js";
import { typeName } from "./type-name.js";
import { SwiftType } from "./swift-type.js";
import { ClosureSpec } from "./closure.js";

const RESERVED = new Set([
  "toString",
  "valueOf",
  "toJSON",
  "equals",
  "hasOwnProperty",
  "$kind",
  "$type",
  "$handle",
  "$className",
  "$fields",
  "$instanceMethods",
  "$typeMethods",
  "$owned",
  "$call",
  "$method",
  "$get",
  "$set",
  "$field",
  "$container",
  "$dispose",
]);

// A synthesized `then` would make the facade thenable and silently break `await`; never a member.
const POISON = new Set(["then", "catch", "finally"]);

export const RAW: unique symbol = Symbol("swift.raw");

export type SwiftClassBoundMethod = SwiftBoundMethod;
export type SwiftValueBoundMethod = SwiftBoundMethod;

// The borrowed ValueInstance structurally implements this; $field returns it as-is so it stays a
// real ValueInstance, reachable through /abi. Its raw ops are just hidden behind this narrow type.
export interface SwiftField {
  readonly handle: NativePointer;
  readonly type: SwiftType;
  read(): SwiftValue;
  write(value: SwiftValue): void;
}

export interface SwiftObjectBase {
  readonly $type: SwiftType;
  readonly $handle: NativePointer;
  readonly $className: string;
  readonly $fields: { [name: string]: SwiftValue } | SwiftValue;
  readonly $instanceMethods: string[];
  readonly $typeMethods: string[];
  readonly $owned: boolean;
  $call(method: string, ...args: CallArg[]): CallResult | Promise<CallResult>;
  $get(name: string): CallResult;
  $set(name: string, value: CallArg): void;
  $field(name: string): SwiftField;
  $dispose(): void;
  equals(other: SwiftObject | NativePointer): boolean;
  toString(): string;
  [Symbol.dispose](): void;
  // Raw ClassInstance ops live under /abi; never a member the index sugar can launder into `any`.
  $retain?: never;
  $release?: never;
  $retainCount?: never;
  $isUniquelyReferenced?: never;
  $vtable?: never;
  $vtableMethod?: never;
  [key: string]: any;
}

export interface SwiftClassObject extends SwiftObjectBase {
  readonly $kind: "object";
  $method(name: string, options?: MethodResolveOptions): SwiftClassBoundMethod;
  $container?: never;
}

export interface SwiftValueObject extends SwiftObjectBase {
  readonly $kind: "value";
  $method(name: string, options?: ValueMethodResolveOptions): SwiftValueBoundMethod;
  $container(): SwiftValue;
}

export type SwiftObject = SwiftClassObject | SwiftValueObject;

function handleOf(other: SwiftObject | ClassInstance | ValueInstance | NativePointer): NativePointer {
  if (other instanceof NativePointer) return other;
  // A facade is `instanceof ClassInstance/ValueInstance` (proxy prototype), so unwrap it first.
  const raw = (other as { [RAW]?: ClassInstance | ValueInstance })[RAW] ?? other;
  return raw.handle;
}

interface MemberIndex {
  methods: Set<string>;
  properties: Set<string>;
  writableProperties: Set<string>;
}

// One facade for class and value alike; $kind discriminates. The proxy roots its target, so an
// owned target's +1 releases only when the proxy is GC'd.
export function asSwiftObject(source: ClassInstance | NativePointer): SwiftClassObject;
export function asSwiftObject(source: ValueInstance): SwiftValueObject;
export function asSwiftObject(source: NativePointer | ClassInstance | ValueInstance): SwiftObject;
export function asSwiftObject(source: NativePointer | ClassInstance | ValueInstance): SwiftObject {
  const target =
    source instanceof ClassInstance || source instanceof ValueInstance
      ? source
      : new ClassInstance(source);
  const isValue = target instanceof ValueInstance;
  const value = target as ValueInstance;
  const object = target as ClassInstance;

  const handle = (): NativePointer => target.handle;
  const dynamicType = (): Metadata => (isValue ? value.metadata : object.dynamicType);
  const fullName = (): string =>
    (isValue ? value.metadata : object.metadata).description.fullTypeName ?? "";

  const readProperty = (name: string): CallResult => (isValue ? value.get(name) : object.get(name));
  const writeProperty = (name: string, v: CallArg): void =>
    isValue ? value.set(name, v) : object.set(name, v);
  const method = (name: string, options: ValueMethodResolveOptions = {}) => {
    const raw = lowerResolveOptions(options);
    return isValue ? value.method(name, raw) : object.method(name, raw);
  };
  const invoke = (name: string, args: CallArg[]): CallResult | Promise<CallResult> => {
    const options: ValueMethodResolveOptions = { arity: args.length };
    if (args.some((a) => a instanceof ClosureSpec)) {
      options.typeArguments = []; // generic path; planGenericMethod infers the closure-result R
    }
    return method(name, options).call(...args);
  };

  let index: MemberIndex | null = null;
  const buildIndex = (): MemberIndex => {
    const properties = enumerateProperties(fullName(), "definingModule").filter((p) => !p.isStatic);
    return {
      methods: new Set(
        enumerateMethods(fullName(), "definingModule")
          .filter((m) => m.kind === "method" && !m.isStatic)
          .map((m) => m.name)
      ),
      properties: new Set(properties.map((p) => p.name)),
      writableProperties: new Set(properties.filter((p) => p.writable).map((p) => p.name)),
    };
  };
  const members = (): MemberIndex => {
    if (index === null) {
      index = buildIndex();
    }
    return index;
  };
  const searchedInOtherModules = new Set<string>();
  const membersIncludingOtherModules = (key: string): MemberIndex => {
    const own = members();
    if (own.methods.has(key) || own.properties.has(key) || searchedInOtherModules.has(key)) {
      return own;
    }
    searchedInOtherModules.add(key);
    const found = instanceMemberKindsInOtherModules(fullName(), key);
    if (found.method) {
      own.methods.add(key);
    }
    if (found.property) {
      own.properties.add(key);
    }
    if (found.writable) {
      own.writableProperties.add(key);
    }
    return own;
  };

  const callables = new Map<string, (...args: CallArg[]) => CallResult | Promise<CallResult>>();

  const proxy = new Proxy(target, {
    has(t, key) {
      if (typeof key !== "string") {
        return Reflect.has(t, key);
      }
      const m = members();
      return RESERVED.has(key) || m.methods.has(key) || m.properties.has(key);
    },
    get(t, key) {
      if (typeof key === "symbol") {
        if (key === RAW) {
          return t;
        }
        const member = Reflect.get(t, key);
        return typeof member === "function" ? member.bind(t) : member;
      }
      switch (key) {
        case "$handle":
          return handle();
        case "$kind":
          return target.kind;
        case "$type":
          return target.type;
        case "$className":
          return typeName(dynamicType());
        case "$fields":
          return isValue ? value.read() : object.read();
        case "$instanceMethods":
          return target.type.methods();
        case "$typeMethods":
          return target.type.methods({ static: true });
        case "$owned":
          return target.owned;
        case "$call":
          return (name: string, ...args: CallArg[]) => invoke(name, args);
        case "$method":
          return (name: string, options: ValueMethodResolveOptions = {}) =>
            narrowBoundMethod(method(name, options), target);
        case "$get":
          return (name: string) => readProperty(name);
        case "$set":
          return (name: string, v: CallArg) => writeProperty(name, v);
        case "$field":
          return (name: string) => target.field(name);
        case "$container":
          return () => {
            if (!isValue) throw new Error("$container is only valid on value instances");
            return value.container();
          };
        case "$dispose":
          return () => target.dispose();
        case "toJSON":
          return () => target.toJSON();
        case "equals":
          return (other: SwiftObject | ClassInstance | ValueInstance | NativePointer) =>
            handle().equals(handleOf(other));
        case "hasOwnProperty":
          return (k: string) => {
            const m = members();
            return RESERVED.has(k) || m.methods.has(k) || m.properties.has(k);
          };
        case "toString":
        case "valueOf":
          return () => `<${fullName() || "Swift.Object"}: ${handle()}>`;
      }
      if (POISON.has(key)) {
        return undefined;
      }
      const m = membersIncludingOtherModules(key);
      if (m.properties.has(key)) {
        return readProperty(key);
      }
      if (m.methods.has(key)) {
        let fn = callables.get(key);
        if (fn === undefined) {
          fn = (...args: CallArg[]) => invoke(key, args);
          callables.set(key, fn);
        }
        return fn;
      }
      return undefined;
    },
    set(_t, key, v) {
      if (typeof key !== "string") {
        return false;
      }
      const m = RESERVED.has(key) || POISON.has(key) ? null : membersIncludingOtherModules(key);
      if (m === null || !m.properties.has(key)) {
        throw new Error(`no property ${key} on ${fullName()}`);
      }
      if (!m.writableProperties.has(key)) {
        throw new Error(`${key} on ${fullName()} is read-only`);
      }
      writeProperty(key, v);
      return true;
    },
    ownKeys() {
      const m = members();
      return ["$handle", ...m.methods, ...m.properties];
    },
    getOwnPropertyDescriptor(_t, key) {
      const writable = typeof key === "string" && members().writableProperties.has(key);
      return { writable, configurable: true, enumerable: true };
    },
  });
  return proxy as unknown as SwiftObject;
}

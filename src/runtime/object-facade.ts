import { ClassInstance } from "../abi/heap-object.js";
import { ValueInstance } from "../abi/value.js";
import { SwiftValue } from "../abi/instance.js";
import {
  SwiftBoundMethod,
  narrowBoundMethod,
  CallResult,
  CallArg,
  MethodResolveOptions,
  ValueMethodResolveOptions,
  lowerResolveOptions,
  splitSelector,
} from "./method.js";
import { SwiftType, NominalType, ClassType, StructType, EnumType } from "./swift-type.js";
import { POISON, invokeOptions, splitSubscriptArgs, facadeMembers, callableCache, memberProxyHandler, MemberProxyParts } from "./facade-members.js";

const RESERVED = new Set([
  "toString",
  "valueOf",
  "toJSON",
  "equals",
  "hasOwnProperty",
  "constructor",
  "$kind",
  "$type",
  "$handle",
  "$fields",
  "$owned",
  "$call",
  "$method",
  "$subscript",
  "$setSubscript",
  "$get",
  "$set",
  "$field",
  "$container",
  "$dispose",
]);

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
  // Reflection on the dynamic type. A pure Objective-C object or a tuple value, both reached only
  // through /abi, report their own reflection kind at runtime.
  readonly $type: NominalType;
  readonly $handle: NativePointer;
  readonly $fields: { [name: string]: SwiftValue } | SwiftValue;
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
  readonly $type: ClassType;
  $method(name: string, options?: MethodResolveOptions): SwiftClassBoundMethod;
  $subscript(...indicesThenOptions: unknown[]): CallResult;
  $setSubscript(value: CallArg, ...indicesThenOptions: unknown[]): void;
  $container?: never;
}

export interface SwiftValueObject extends SwiftObjectBase {
  readonly $kind: "value";
  readonly $type: StructType | EnumType;
  $method(name: string, options?: ValueMethodResolveOptions): SwiftValueBoundMethod;
  $subscript(...indicesThenOptions: unknown[]): CallResult;
  $setSubscript(value: CallArg, ...indicesThenOptions: unknown[]): void;
  $container(): SwiftValue;
}

export type SwiftObject = SwiftClassObject | SwiftValueObject;

function handleOf(other: SwiftObject | ClassInstance | ValueInstance | NativePointer): NativePointer {
  if (other instanceof NativePointer) return other;
  // A facade is `instanceof ClassInstance/ValueInstance` (proxy prototype), so unwrap it first.
  const raw = (other as { [RAW]?: ClassInstance | ValueInstance })[RAW] ?? other;
  return raw.handle;
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
  const fullName = (): string =>
    (isValue ? value.metadata : object.metadata).description.fullTypeName ?? "";

  const readProperty = (name: string): CallResult => (isValue ? value.get(name) : object.get(name));
  const writeProperty = (name: string, v: CallArg): void =>
    isValue ? value.set(name, v) : object.set(name, v);
  const method = (selector: string, selectorOptions: ValueMethodResolveOptions = {}) => {
    const { name, options } = splitSelector(selector, selectorOptions);
    const raw = lowerResolveOptions(options);
    return isValue ? value.method(name, raw) : object.method(name, raw);
  };
  const invoke = (name: string, args: CallArg[]): CallResult | Promise<CallResult> =>
    method(name, invokeOptions(args)).call(...args);
  const subscript = (accessor: "getter" | "setter", args: unknown[], stored: CallArg[]): CallResult => {
    const { indices, selector, options } = splitSubscriptArgs(args);
    const { name, options: split } = splitSelector(selector, { ...options, arity: options.arity ?? indices.length });
    if (name !== "subscript") {
      throw new Error(`${selector} is not a subscript selector`);
    }
    const raw = { ...lowerResolveOptions(split), accessor };
    const bound = isValue ? value.method("subscript", raw) : object.method("subscript", raw);
    return bound.call(...stored, ...indices) as CallResult;
  };

  const members = facadeMembers(fullName, false);

  const callable = callableCache(invoke);

  const has = (key: string): boolean => {
    if (RESERVED.has(key)) {
      return true;
    }
    if (key.startsWith("$") || POISON.has(key)) {
      return false;
    }
    const m = members.including(key);
    return m.methods.has(key) || m.properties.has(key);
  };

  const parts: MemberProxyParts<typeof target> = {
    members,
    reserved: RESERVED,
    has,
    read: readProperty,
    write: writeProperty,
    callable,
    fallback: () => undefined,
    ownKeys: (_t, own) => ["$handle", ...own.methods, ...own.properties],
    owner: fullName,
    propertyNoun: "property",
    bridgeMember(t, key) {
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
        case "$fields":
          return isValue ? value.read() : object.read();
        case "$owned":
          return target.owned;
        case "$call":
          return (name: string, ...args: CallArg[]) => invoke(name, args);
        case "$method":
          return (name: string, options: ValueMethodResolveOptions = {}) =>
            narrowBoundMethod(method(name, options), target);
        case "$subscript":
          return (...args: unknown[]) => subscript("getter", args, []);
        case "$setSubscript":
          return (v: CallArg, ...args: unknown[]) => {
            subscript("setter", args, [v]);
          };
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
          return has;
        case "toString":
        case "valueOf":
          return () => `<${fullName() || "Swift.Object"}: ${handle()}>`;
        case "constructor":
          return Reflect.get(t, key);
      }
      return undefined;
    },
  };
  const proxy = new Proxy(target, memberProxyHandler(() => parts));
  return proxy as unknown as SwiftObject;
}

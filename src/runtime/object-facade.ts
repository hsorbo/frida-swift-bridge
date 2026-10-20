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
  bindRequirementAt,
} from "./method.js";
import { SwiftType, NominalType, ClassType, StructType, EnumType, SlotSignature, MemberLookupOptions } from "./swift-type.js";
import { findProtocol, conformsToProtocol } from "../abi/protocol-conformance.js";
import { WitnessTable } from "../abi/witness-table.js";
import { typeName } from "./type-name.js";
import { POISON, invokeOptions, bindSubscript, SwiftBoundSubscript, facadeMembers, callableCache, memberProxyHandler, MemberProxyParts } from "./facade-members.js";
import { sequenceIterator } from "./sequence.js";

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
  "$get",
  "$set",
  "$field",
  "$container",
  "$retained",
  "$dispose",
]);

export const RAW: unique symbol = Symbol("swift.raw");

type SwiftNameStart =
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m" | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z"
  | "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L" | "M" | "N" | "O" | "P" | "Q" | "R" | "S" | "T" | "U" | "V" | "W" | "X" | "Y" | "Z"
  | "_"
  | "/" | "=" | "-" | "+" | "!" | "*" | "%" | "<" | ">" | "&" | "|" | "^" | "~" | "?" | ".";

// A Swift member (an identifier or an operator) answers to its bare name through the index
// signature; a `$` name is the bridge's and must be declared, so a misspelled or stale control is
// a compile error rather than `any`.
export type SwiftMemberKey = `${SwiftNameStart}${string}`;

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
  // Present at runtime only when the type conforms to Sequence.
  [Symbol.iterator](): Iterator<CallResult>;
  equals(other: SwiftObject | NativePointer): boolean;
  toString(): string;
  [Symbol.dispose](): void;
  [key: SwiftMemberKey]: any;
}

export interface SwiftClassObject extends SwiftObjectBase {
  readonly $kind: "object";
  readonly $type: ClassType;
  $method(name: string, options?: MethodResolveOptions | SlotSignature): SwiftClassBoundMethod;
  $subscript(selector?: string | MemberLookupOptions, options?: MemberLookupOptions): SwiftBoundSubscript;
  // A separately owned facade of the same object, whatever this one's ownership.
  $retained(): SwiftClassObject;
  $container?: never;
}

export interface SwiftValueObject extends SwiftObjectBase {
  readonly $kind: "value";
  readonly $type: StructType | EnumType;
  $method(name: string, options?: ValueMethodResolveOptions | SlotSignature): SwiftValueBoundMethod;
  $subscript(selector?: string | MemberLookupOptions, options?: MemberLookupOptions): SwiftBoundSubscript;
  $container(): SwiftValue;
  $retained?: never;
}

export type SwiftObject = SwiftClassObject | SwiftValueObject;

function handleOf(other: SwiftObject | ClassInstance | ValueInstance | NativePointer): NativePointer {
  if (other instanceof NativePointer) return other;
  // A facade is `instanceof ClassInstance/ValueInstance` (proxy prototype), so unwrap it first.
  const raw = (other as { [RAW]?: ClassInstance | ValueInstance })[RAW] ?? other;
  return raw.handle;
}

// Swift ==: a value compares through its type's Equatable conformance, never bytewise.
function equatableEquals(value: ValueInstance, other: SwiftObject | ClassInstance | ValueInstance | NativePointer): boolean {
  const raw = (other as { [RAW]?: ClassInstance | ValueInstance })[RAW] ?? other;
  if (!(raw instanceof ValueInstance) || !raw.metadata.handle.equals(value.metadata.handle)) {
    return false;
  }
  const table = conformsToProtocol(value.metadata, findProtocol("Swift.Equatable")!);
  if (table === null) {
    throw new Error(`${typeName(value.metadata)} does not conform to Swift.Equatable; ValueInstance.equals under /abi compares storage`);
  }
  const equals = bindRequirementAt(new WitnessTable(table, value.metadata), 0, "static Swift.Equatable.== infix(A, A) -> Swift.Bool", value.metadata.handle);
  return equals.call(value, raw) === true;
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
  const fullName = (): string => (isValue ? value.metadata.description.fullTypeName ?? "" : object.typeName);

  const readProperty = (name: string): CallResult => (isValue ? value.get(name) : object.get(name));
  const writeProperty = (name: string, v: CallArg): void =>
    isValue ? value.set(name, v) : object.set(name, v);
  const method = (selector: string, selectorOptions: ValueMethodResolveOptions | SlotSignature = {}) => {
    if (typeof selectorOptions === "string") {
      return isValue ? value.slot(selector, selectorOptions) : object.slot(selector, selectorOptions);
    }
    const { name, options } = splitSelector(selector, selectorOptions);
    const raw = lowerResolveOptions(options);
    return isValue ? value.method(name, raw) : object.method(name, raw);
  };
  const invoke = (name: string, args: CallArg[]): CallResult | Promise<CallResult> =>
    method(name, invokeOptions(args)).call(...args);

  const members = facadeMembers(fullName, false);

  const callable = callableCache(invoke, (name) => narrowBoundMethod(method(name), target));

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
        if (key === Symbol.iterator) {
          return sequenceIterator(target);
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
          return (name: string, options: ValueMethodResolveOptions | SlotSignature = {}) =>
            narrowBoundMethod(method(name, options), target);
        case "$subscript":
          return (selector?: string | MemberLookupOptions, options: MemberLookupOptions = {}) =>
            bindSubscript(selector, options, (lookup) => narrowBoundMethod(method("subscript", lookup), target));
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
        case "$retained":
          return () => {
            if (isValue) throw new Error("$retained is only valid on class objects; a value is copied with its type's $copy");
            return asSwiftObject(object.retained());
          };
        case "$dispose":
          return () => target.dispose();
        case "toJSON":
          return () => target.toJSON();
        case "equals":
          return (other: SwiftObject | ClassInstance | ValueInstance | NativePointer) =>
            isValue ? equatableEquals(value, other) : handle().equals(handleOf(other));
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

import { Metadata, MetadataKind } from "./metadata.js";
import { enumerateFields, fieldTypeIn, resolveFieldType } from "./field-descriptor.js";
import { readEnumCase, projectEnumData, projectBox, setEnumTag } from "./enum.js";
import { enumerateTupleElements } from "./tuple.js";
import { readString, writeString } from "./string.js";
import {
  existentialRepresentation,
  isClassExistential,
  extendedExistentialSpecialKind,
  ExtendedExistentialSpecialKind,
  projectOpaqueExistential,
  projectErrorExistential,
} from "./existential.js";
import { ClassMetadata, classMetadataOf, enumerateClassFields } from "./class-metadata.js";
import { typeName } from "../runtime/type-name.js";

const STRUCT_DESC_FIELD_OFFSET_VECTOR_OFFSET = 0x18;

export interface InstanceField {
  name: string;
  type: Metadata | null;
  address: NativePointer;
}

export type SwiftValue =
  | number
  | Int64
  | UInt64
  | bigint
  | boolean
  | string
  | NativePointer
  | { [field: string]: SwiftValue }
  | SwiftValue[]
  | null;

const U64_MASK = (1n << 64n) - 1n;

function readU128(p: NativePointer): bigint {
  return (BigInt(p.add(8).readU64().toString()) << 64n) | BigInt(p.readU64().toString());
}

function writeU128(p: NativePointer, v: bigint): void {
  p.writeU64(uint64((v & U64_MASK).toString()));
  p.add(8).writeU64(uint64((v >> 64n).toString()));
}

const PRIMITIVE_READERS: { [typeName: string]: (p: NativePointer) => SwiftValue } = {
  "Swift.Int": (p) => p.readS64(),
  "Swift.UInt": (p) => p.readU64(),
  "Swift.Int64": (p) => p.readS64(),
  "Swift.UInt64": (p) => p.readU64(),
  "Swift.Int128": (p) => BigInt.asIntN(128, readU128(p)),
  "Swift.UInt128": (p) => readU128(p),
  "Swift.Int32": (p) => p.readS32(),
  "Swift.UInt32": (p) => p.readU32(),
  "Swift.Int16": (p) => p.readS16(),
  "Swift.UInt16": (p) => p.readU16(),
  "Swift.Int8": (p) => p.readS8(),
  "Swift.UInt8": (p) => p.readU8(),
  "Swift.Bool": (p) => p.readU8() !== 0,
  "Swift.Double": (p) => p.readDouble(),
  "Swift.Float": (p) => p.readFloat(),
  "Swift.String": (p) => readString(p),
  "Swift.UnsafeRawPointer": (p) => p.readPointer(),
  "Swift.UnsafeMutableRawPointer": (p) => p.readPointer(),
  "Swift.OpaquePointer": (p) => p.readPointer(),
};

const PRIMITIVE_WRITERS: { [typeName: string]: (p: NativePointer, v: SwiftValue) => void } = {
  "Swift.Int": (p, v) => p.writeS64(v as number | Int64),
  "Swift.UInt": (p, v) => p.writeU64(v as number | UInt64),
  "Swift.Int64": (p, v) => p.writeS64(v as number | Int64),
  "Swift.UInt64": (p, v) => p.writeU64(v as number | UInt64),
  "Swift.Int128": (p, v) => writeU128(p, BigInt.asUintN(128, v as bigint)),
  "Swift.UInt128": (p, v) => writeU128(p, v as bigint),
  "Swift.Int32": (p, v) => p.writeS32(v as number),
  "Swift.UInt32": (p, v) => p.writeU32(v as number),
  "Swift.Int16": (p, v) => p.writeS16(v as number),
  "Swift.UInt16": (p, v) => p.writeU16(v as number),
  "Swift.Int8": (p, v) => p.writeS8(v as number),
  "Swift.UInt8": (p, v) => p.writeU8(v as number),
  "Swift.Bool": (p, v) => p.writeU8(v ? 1 : 0),
  "Swift.Double": (p, v) => p.writeDouble(v as number),
  "Swift.Float": (p, v) => p.writeFloat(v as number),
  "Swift.String": (p, v) => writeString(p, v as string),
  "Swift.UnsafeRawPointer": (p, v) => p.writePointer(v as NativePointer),
  "Swift.UnsafeMutableRawPointer": (p, v) => p.writePointer(v as NativePointer),
  "Swift.OpaquePointer": (p, v) => p.writePointer(v as NativePointer),
};

const isIntValue = (v: SwiftValue): boolean =>
  typeof v === "number" || v instanceof Int64 || v instanceof UInt64;

const INT_RANGES: { [typeName: string]: { min: number; max: number } } = {
  "Swift.Int32": { min: -0x80000000, max: 0x7fffffff },
  "Swift.UInt32": { min: 0, max: 0xffffffff },
  "Swift.Int16": { min: -0x8000, max: 0x7fff },
  "Swift.UInt16": { min: 0, max: 0xffff },
  "Swift.Int8": { min: -0x80, max: 0x7f },
  "Swift.UInt8": { min: 0, max: 0xff },
};
const WIDE_SIGNED = new Set(["Swift.Int", "Swift.Int64"]);
const WIDE_UNSIGNED = new Set(["Swift.UInt", "Swift.UInt64"]);
const WIDE_128 = new Map([
  ["Swift.Int128", (v: bigint) => BigInt.asIntN(128, v) === v],
  ["Swift.UInt128", (v: bigint) => BigInt.asUintN(128, v) === v],
]);

const describeRejected = (v: SwiftValue): string =>
  typeof v === "number" || typeof v === "bigint" || v instanceof Int64 || v instanceof UInt64 ? String(v) : typeof v;

function normalizePrimitive(name: string, value: SwiftValue): SwiftValue {
  const range = INT_RANGES[name];
  if (range !== undefined) {
    const n = value instanceof Int64 || value instanceof UInt64 ? value.toNumber() : value;
    if (typeof n !== "number" || !Number.isInteger(n) || n < range.min || n > range.max) {
      throw new Error(`writeValue: ${String(value)} is out of range for ${name}`);
    }
    return n;
  }
  if (WIDE_SIGNED.has(name)) {
    if (value instanceof Int64) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    throw new Error(`writeValue: cannot write ${describeRejected(value)} as ${name}; pass a safe integer or Int64`);
  }
  if (WIDE_UNSIGNED.has(name)) {
    if (value instanceof UInt64) return value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    throw new Error(`writeValue: cannot write ${describeRejected(value)} as ${name}; pass a non-negative safe integer or UInt64`);
  }
  const fits128 = WIDE_128.get(name);
  if (fits128 !== undefined) {
    const wide =
      typeof value === "bigint" ? value
      : (typeof value === "number" && Number.isSafeInteger(value)) || value instanceof Int64 || value instanceof UInt64 ? BigInt(value.toString())
      : null;
    if (wide !== null && fits128(wide)) return wide;
    throw new Error(`writeValue: cannot write ${describeRejected(value)} as ${name}; pass a BigInt in range`);
  }
  if (!PRIMITIVE_VALIDATORS[name](value)) {
    throw new Error(`writeValue: cannot write ${typeof value} as ${name}`);
  }
  return value;
}
const isFloatValue = (v: SwiftValue): boolean => typeof v === "number";
const isPointerValue = (v: SwiftValue): boolean => v instanceof NativePointer;

const PRIMITIVE_VALIDATORS: { [typeName: string]: (v: SwiftValue) => boolean } = {
  "Swift.Int": isIntValue,
  "Swift.UInt": isIntValue,
  "Swift.Int64": isIntValue,
  "Swift.UInt64": isIntValue,
  "Swift.Int32": isIntValue,
  "Swift.UInt32": isIntValue,
  "Swift.Int16": isIntValue,
  "Swift.UInt16": isIntValue,
  "Swift.Int8": isIntValue,
  "Swift.UInt8": isIntValue,
  "Swift.Bool": (v) => typeof v === "boolean",
  "Swift.Double": isFloatValue,
  "Swift.Float": isFloatValue,
  "Swift.String": (v) => typeof v === "string",
  "Swift.UnsafeRawPointer": isPointerValue,
  "Swift.UnsafeMutableRawPointer": isPointerValue,
  "Swift.OpaquePointer": isPointerValue,
};

type WritePlan = (address: NativePointer) => void;

// Reads every caller property exactly once and validates it, so a Proxy or getter cannot change the
// value between validation and the write, and a failing aggregate never initializes a partial result.
function planWrite(metadata: Metadata, value: SwiftValue): WritePlan {
  switch (metadata.kind) {
    case MetadataKind.Struct: {
      const name = metadata.description.fullTypeName ?? "";
      const writer = PRIMITIVE_WRITERS[name];
      if (writer !== undefined) {
        const normalized = normalizePrimitive(name, value);
        return (address) => writer(address, normalized);
      }
      if (value === null || typeof value !== "object") {
        throw new Error(`writeValue: expected a field object for ${typeName(metadata)}`);
      }
      const fields = value as { [field: string]: SwiftValue };
      const fieldPlans: WritePlan[] = [];
      for (const field of enumerateFields(metadata.description)) {
        const fieldType = fieldTypeIn(metadata, field);
        if (fieldType === null) {
          throw new Error(`writeValue: unresolved type for field ${field.name}`);
        }
        if (!(field.name in fields)) {
          throw new Error(`writeValue: missing field ${field.name}`);
        }
        fieldPlans.push(planWrite(fieldType, fields[field.name]));
      }
      return (address) => {
        let i = 0;
        for (const field of enumerateInstanceFields(metadata, address)) {
          fieldPlans[i++](field.address);
        }
      };
    }
    case MetadataKind.Enum:
    case MetadataKind.Optional: {
      const { caseName, payload } =
        metadata.kind === MetadataKind.Optional && value === null
          ? { caseName: "none", payload: undefined } // JS null ↔ Swift .none, the inverse of readEnum
          : parseEnumValue(value);
      const cases = [...enumerateFields(metadata.description)];
      const tag = cases.findIndex((c) => c.name === caseName);
      if (tag === -1) {
        throw new Error(`writeValue: unknown enum case ${caseName}`);
      }
      const field = cases[tag];
      let payloadPlan: WritePlan | null = null;
      if (field.mangledTypeName !== null) {
        if (field.isIndirectCase) {
          throw new Error(`writeValue: indirect enum case ${caseName} not supported`);
        }
        const payloadType = fieldTypeIn(metadata, field);
        if (payloadType === null) {
          throw new Error(`writeValue: unresolved payload type for case ${caseName}`);
        }
        payloadPlan = planWrite(payloadType, payload as SwiftValue);
      }
      return (address) => {
        payloadPlan?.(address);
        setEnumTag(metadata, address, tag);
      };
    }
    default:
      throw new Error(`writeValue: unsupported metadata kind ${metadata.kind}`);
  }
}

function parseEnumValue(value: SwiftValue): { caseName: string; payload?: SwiftValue } {
  if (typeof value === "string") {
    return { caseName: value };
  }
  if (value === null || typeof value !== "object") {
    throw new Error("writeValue: enum value must be a case name or { case: payload }");
  }
  const entries = Object.entries(value as { [k: string]: SwiftValue });
  if (entries.length !== 1) {
    throw new Error("writeValue: enum value must be a case name or { case: payload }");
  }
  const [caseName, payload] = entries[0];
  return { caseName, payload };
}

export function writeValue(metadata: Metadata, address: NativePointer, value: SwiftValue): void {
  planWrite(metadata, value)(address);
}

export function readValue(metadata: Metadata, address: NativePointer): SwiftValue {
  switch (metadata.kind) {
    case MetadataKind.Struct: {
      const reader = PRIMITIVE_READERS[metadata.description.fullTypeName ?? ""];
      if (reader !== undefined) {
        return reader(address);
      }
      const value: { [field: string]: SwiftValue } = {};
      for (const field of enumerateInstanceFields(metadata, address)) {
        value[field.name] = field.type === null ? null : readValue(field.type, field.address);
      }
      return value;
    }
    case MetadataKind.Enum:
    case MetadataKind.Optional:
      return readEnum(metadata, address);
    case MetadataKind.Class:
      return address.readPointer(); // reference; decode with readObject()
    case MetadataKind.Existential:
      return readExistential(metadata, address);
    case MetadataKind.ExtendedExistential:
      return readExtendedExistential(metadata, address);
    case MetadataKind.Tuple: {
      const elements: SwiftValue[] = [];
      for (const element of enumerateTupleElements(metadata)) {
        elements.push(readValue(element.type, address.add(element.offset)));
      }
      return elements;
    }
    default:
      return null;
  }
}

export function swiftValueEquals(a: SwiftValue, b: SwiftValue): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if (a instanceof NativePointer || b instanceof NativePointer) {
    return a instanceof NativePointer && b instanceof NativePointer && a.equals(b);
  }
  if (a instanceof Int64 || b instanceof Int64) {
    return a instanceof Int64 && b instanceof Int64 && a.equals(b);
  }
  if (a instanceof UInt64 || b instanceof UInt64) {
    return a instanceof UInt64 && b instanceof UInt64 && a.equals(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((element, i) => swiftValueEquals(element, b[i]))
    );
  }
  if (typeof a === "object" || typeof b === "object") {
    if (typeof a !== "object" || typeof b !== "object") {
      return false;
    }
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => k in b && swiftValueEquals(a[k], b[k]))
    );
  }
  return a === b;
}

const managedRefCache = new Map<string, boolean>();

// Mirrors readValue: a reference it can't deep-copy out — a class ref, or the non-POD Opaque leaf
// (Builtin.BridgeObject) backing Array/Set/Dictionary. Excludes primitives (String) and existentials.
export function embedsManagedReference(metadata: Metadata): boolean {
  if (metadata.kind === MetadataKind.Class) {
    return true;
  }
  const isStruct = metadata.kind === MetadataKind.Struct;
  const isEnum = metadata.kind === MetadataKind.Enum || metadata.kind === MetadataKind.Optional;
  if (!isStruct && !isEnum) {
    return metadata.kind !== MetadataKind.Existential && !metadata.valueWitnesses.isPOD;
  }
  if (isStruct && PRIMITIVE_READERS[metadata.description.fullTypeName ?? ""] !== undefined) {
    return false;
  }
  const key = metadata.handle.toString();
  const cached = managedRefCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  managedRefCache.set(key, false); // break recursive-type cycles
  let result = false;
  for (const field of enumerateFields(metadata.description)) {
    const fieldType = fieldTypeIn(metadata, field);
    if (fieldType !== null && (isClassExistentialField(fieldType) || embedsManagedReference(fieldType))) {
      result = true;
      break;
    }
  }
  managedRefCache.set(key, result);
  return result;
}

// A top-level existential is projected to its dynamic value, but a stored class existential is a reference.
function isClassExistentialField(metadata: Metadata): boolean {
  const isExistential = metadata.kind === MetadataKind.Existential || metadata.kind === MetadataKind.ExtendedExistential;
  return isExistential && isClassExistential(metadata);
}

function readExistential(metadata: Metadata, address: NativePointer): SwiftValue {
  const representation = existentialRepresentation(metadata);
  if (representation === "class") {
    // reference; decode with readObject(). Snapshot-only for a by-value existential return: the
    // return's non-POD destroy releases the container, so the pointer is valid only at read time.
    return address.readPointer();
  }
  const { type, value } =
    representation === "error"
      ? projectErrorExistential(address)
      : projectOpaqueExistential(address);
  return readValue(type, value);
}

function readExtendedExistential(metadata: Metadata, address: NativePointer): SwiftValue {
  switch (extendedExistentialSpecialKind(metadata)) {
    case ExtendedExistentialSpecialKind.Class:
      return address.readPointer(); // reference; decode with readObject()
    case ExtendedExistentialSpecialKind.None: {
      const { type, value } = projectOpaqueExistential(address);
      return readValue(type, value);
    }
    case ExtendedExistentialSpecialKind.Metatype:
      return typeName(new Metadata(address.readPointer())); // inline word is the stored Metadata*
    default:
      throw new Error("ExtendedExistential: only opaque, class, and metatype special kinds are supported");
  }
}

export function* enumerateClassInstanceFields(object: NativePointer): Generator<InstanceField> {
  const chain: ClassMetadata[] = [];
  let cls: ClassMetadata | null = classMetadataOf(object);
  while (cls !== null && cls.isTypeMetadata) {
    chain.push(cls);
    cls = cls.superclass;
  }

  // Base-class fields first, matching ascending in-instance offsets.
  for (const metadata of chain.reverse()) {
    const descriptor = metadata.description;
    const genericArguments = descriptor.isGeneric ? metadata.genericArguments : null;
    for (const { field, offset } of enumerateClassFields(metadata)) {
      yield {
        name: field.name,
        type: resolveFieldType(field, descriptor, genericArguments),
        address: object.add(offset),
      };
    }
  }
}

export function readObject(object: NativePointer): { [field: string]: SwiftValue } {
  const value: { [field: string]: SwiftValue } = {};
  for (const { name, type, address } of enumerateClassInstanceFields(object)) {
    value[name] = type === null ? null : readValue(type, address);
  }
  return value;
}

function readEnum(metadata: Metadata, address: NativePointer): SwiftValue {
  const { name, payloadType, isIndirect } = readEnumCase(metadata, address);
  if (payloadType === null) {
    return name;
  }
  const scratch = Memory.alloc(metadata.typeLayout.stride);
  Memory.copy(scratch, address, metadata.typeLayout.stride);
  projectEnumData(metadata, scratch);
  const payloadAddress = isIndirect ? projectBox(scratch.readPointer()) : scratch;
  return { [name]: readValue(payloadType, payloadAddress) };
}

export function* enumerateInstanceFields(
  metadata: Metadata,
  address: NativePointer
): Generator<InstanceField> {
  if (metadata.kind !== MetadataKind.Struct) {
    throw new Error("enumerateInstanceFields currently supports struct values only");
  }

  const descriptor = metadata.description;
  const vectorOffset = descriptor.handle
    .add(STRUCT_DESC_FIELD_OFFSET_VECTOR_OFFSET)
    .readU32();
  if (vectorOffset === 0) {
    return;
  }
  const offsets = metadata.handle.add(vectorOffset * Process.pointerSize);

  let index = 0;
  for (const field of enumerateFields(descriptor)) {
    const offset = offsets.add(index * 4).readU32();
    yield {
      name: field.name,
      type: fieldTypeIn(metadata, field),
      address: address.add(offset),
    };
    index++;
  }
}

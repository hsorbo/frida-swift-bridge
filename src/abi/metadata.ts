import { ContextDescriptor, ContextDescriptorKind } from "./context-descriptor.js";
import { ValueWitnessTable } from "./value-witness.js";
import { signCode } from "../basic/pac.js";

export enum MetadataKind {
  Class = 0x0,
  Struct = 0x200,
  Enum = 0x201,
  Optional = 0x202,
  ForeignClass = 0x203,
  ForeignReferenceType = 0x204,
  Existential = 0x303,
  ExtendedExistential = 0x307,
  Metatype = 0x304,
  ObjCClassWrapper = 0x305,
  Tuple = 0x301,
  Function = 0x302,
  FixedArray = 0x308,
  Borrow = 0x309,
  HeapLocalVariable = 0x400,
  HeapGenericLocalVariable = 0x500,
}

const OFFSETOF_KIND = 0x0;
const LAST_ENUMERATED = 0x7ff;

const METADATA_REQUEST_COMPLETE = 0;

const OFFSETOF_VALUE_TYPE_GENERIC_HEADER = 0x24;
const OFFSETOF_CLASS_GENERIC_HEADER = 0x34;
const OFFSETOF_EXTENSION_GENERIC_HEADER = 0xc;
const OFFSETOF_ANONYMOUS_GENERIC_HEADER = 0x8;
const OFFSETOF_OPAQUE_TYPE_GENERIC_HEADER = 0x8;
const OFFSETOF_GENERIC_HEADER_NUM_REQUIREMENTS = 0x2;
const OFFSETOF_GENERIC_HEADER_NUM_KEY_ARGUMENTS = 0x4;
const OFFSETOF_GENERIC_HEADER_FLAGS = 0x6;
export const GENERIC_CONTEXT_HEADER_SIZE = 0x8;

export interface GenericContextHeader {
  numParams: number;
  numRequirements: number;
  numKeyArguments: number;
  flags: number;
}

export function readGenericContextHeader(header: NativePointer): GenericContextHeader {
  return {
    numParams: header.readU16(),
    numRequirements: header.add(OFFSETOF_GENERIC_HEADER_NUM_REQUIREMENTS).readU16(),
    numKeyArguments: header.add(OFFSETOF_GENERIC_HEADER_NUM_KEY_ARGUMENTS).readU16(),
    flags: header.add(OFFSETOF_GENERIC_HEADER_FLAGS).readU16(),
  };
}

export interface TypeLayout {
  size: number;
  stride: number;
  alignment: number;
}

export class Metadata {
  constructor(readonly handle: NativePointer) {}

  get kind(): MetadataKind {
    const raw = this.handle.add(OFFSETOF_KIND).readU32();
    return raw > LAST_ENUMERATED ? MetadataKind.Class : raw;
  }

  get valueWitnessTable(): NativePointer {
    return this.handle.sub(Process.pointerSize).readPointer().strip();
  }

  get valueWitnesses(): ValueWitnessTable {
    return new ValueWitnessTable(this.valueWitnessTable, this.handle);
  }

  get description(): ContextDescriptor {
    const kind = this.kind;
    if (
      kind !== MetadataKind.Struct &&
      kind !== MetadataKind.Enum &&
      kind !== MetadataKind.Optional
    ) {
      throw new Error(
        `Metadata.description is valid for value-type metadata only (kind ${kind}); use ClassMetadata for classes`
      );
    }
    return new ContextDescriptor(
      this.handle.add(Process.pointerSize).readPointer().strip()
    );
  }

  get genericArguments(): NativePointer {
    return this.handle.add(2 * Process.pointerSize);
  }

  get typeLayout(): TypeLayout {
    const vwt = this.valueWitnesses;
    return { size: vwt.size, stride: vwt.stride, alignment: vwt.alignment };
  }
}

const cache = new Map<string, Metadata>();

export function getMetadata(descriptor: ContextDescriptor): Metadata {
  if (descriptor.isGeneric) {
    throw new Error("getMetadata requires type arguments for a generic type");
  }
  const accessFunction = descriptor.accessFunction;
  if (accessFunction === null) {
    throw new Error("descriptor has no metadata access function");
  }

  const key = descriptor.handle.toString();
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const access = new NativeFunction(signCode(accessFunction), "pointer", ["size_t"]);
  const metadata = new Metadata(access(METADATA_REQUEST_COMPLETE) as NativePointer);
  cache.set(key, metadata);
  return metadata;
}

const genericCache = new Map<string, Metadata>();

export function getGenericMetadata(
  descriptor: ContextDescriptor,
  typeArguments: Metadata[]
): Metadata {
  const { numParams, numKeyArguments } = readGenericContextHeader(genericHeader(descriptor));
  if (typeArguments.length !== numParams) {
    throw new Error(`expected ${numParams} type argument(s), got ${typeArguments.length}`);
  }
  if (numKeyArguments !== numParams) {
    throw new Error(
      "generic conformance requirements are not supported; use instantiateGenericMetadata"
    );
  }
  return instantiateGenericMetadata(descriptor, typeArguments.map((m) => m.handle));
}

export function instantiateGenericMetadata(
  descriptor: ContextDescriptor,
  keyArguments: NativePointer[]
): Metadata {
  const { numKeyArguments } = readGenericContextHeader(genericHeader(descriptor));
  if (keyArguments.length !== numKeyArguments) {
    throw new Error(`expected ${numKeyArguments} key argument(s), got ${keyArguments.length}`);
  }

  const accessFunction = descriptor.accessFunction;
  if (accessFunction === null) {
    throw new Error("descriptor has no metadata access function");
  }

  const key =
    descriptor.handle.toString() + "<" + keyArguments.map((h) => h.toString()).join(",") + ">";
  const cached = genericCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const metadata = new Metadata(invokeAccessor(accessFunction, keyArguments));
  genericCache.set(key, metadata);
  return metadata;
}

export function genericHeaderOffset(descriptor: ContextDescriptor): number {
  if (!descriptor.isGeneric) {
    throw new Error("not a generic type; use getMetadata");
  }
  switch (descriptor.kind) {
    case ContextDescriptorKind.Struct:
    case ContextDescriptorKind.Enum:
      return OFFSETOF_VALUE_TYPE_GENERIC_HEADER;
    case ContextDescriptorKind.Class:
      return OFFSETOF_CLASS_GENERIC_HEADER;
    case ContextDescriptorKind.Extension:
      return OFFSETOF_EXTENSION_GENERIC_HEADER;
    case ContextDescriptorKind.Anonymous:
      return OFFSETOF_ANONYMOUS_GENERIC_HEADER;
    case ContextDescriptorKind.OpaqueType:
      return OFFSETOF_OPAQUE_TYPE_GENERIC_HEADER;
    default:
      throw new Error(`generic metadata for descriptor kind ${descriptor.kind} is not supported`);
  }
}

function genericHeader(descriptor: ContextDescriptor): NativePointer {
  if (descriptor.kind === ContextDescriptorKind.OpaqueType) {
    throw new Error("generic metadata instantiation is not supported for opaque type descriptors");
  }
  return descriptor.handle.add(genericHeaderOffset(descriptor));
}

function invokeAccessor(bareFn: NativePointer, args: NativePointer[]): NativePointer {
  const fn = signCode(bareFn);
  const request = METADATA_REQUEST_COMPLETE;
  switch (args.length) {
    case 1:
      return new NativeFunction(fn, "pointer", ["size_t", "pointer"])(
        request, args[0]
      ) as NativePointer;
    case 2:
      return new NativeFunction(fn, "pointer", ["size_t", "pointer", "pointer"])(
        request, args[0], args[1]
      ) as NativePointer;
    case 3:
      return new NativeFunction(fn, "pointer", ["size_t", "pointer", "pointer", "pointer"])(
        request, args[0], args[1], args[2]
      ) as NativePointer;
    default: {
      const buffer = Memory.alloc(args.length * Process.pointerSize);
      args.forEach((a, i) => buffer.add(i * Process.pointerSize).writePointer(a));
      return new NativeFunction(fn, "pointer", ["size_t", "pointer"])(
        request, buffer
      ) as NativePointer;
    }
  }
}

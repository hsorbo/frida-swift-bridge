import { ContextDescriptor } from "./context-descriptor.js";
import { Metadata, instantiateGenericMetadata, genericHeaderOffset } from "./metadata.js";
import { conformsToProtocol } from "./protocol-conformance.js";
import { resolveTypeByMangledName, symbolicMangledNameLength } from "./field-descriptor.js";
import {
  GenericRequirementDescriptor,
  readGenericRequirementDescriptors,
} from "./generic-requirement-descriptor.js";
import { RelativeDirectPointer } from "../basic/relative-pointer.js";

const OFFSETOF_NUM_REQUIREMENTS = 0x2;
const OFFSETOF_HEADER_FLAGS = 0x6;
const OFFSETOF_GENERIC_PARAMS = 0x8;

const FLAG_HAS_KEY_ARGUMENT = 0x80;
const GENERIC_PARAM_KIND_MASK = 0x3f;
const GENERIC_PARAM_KIND_TYPE = 0x0;

const REQUIREMENT_SIZE = 0xc;
const OFFSETOF_REQ_PARAM = 0x4;
const OFFSETOF_REQ_PROTOCOL = 0x8;
const REQUIREMENT_KIND_MASK = 0x1f;
const REQUIREMENT_KIND_PROTOCOL = 0x0;
const PROTOCOL_REF_OBJC_BIT = 0x2;

const FLAG_HAS_TYPE_PACKS = 0x1;
const FLAG_HAS_CONDITIONAL_INVERTED_PROTOCOLS = 0x2;
const FLAG_HAS_VALUES = 0x4;

const SIZEOF_PACK_SHAPE_HEADER = 0x4;
const SIZEOF_PACK_SHAPE_DESCRIPTOR = 0x8;
const SIZEOF_CONDITIONAL_INVERTIBLE_PROTOCOL_SET = 0x2;
const SIZEOF_CONDITIONAL_REQUIREMENT_COUNT = 0x2;
const SIZEOF_VALUE_HEADER = 0x4;
const SIZEOF_VALUE_DESCRIPTOR = 0x4;

// Params are padded to a 4-byte boundary before the requirements array begins.
function genericRequirementsOffset(paramsOffset: number, numParams: number): number {
  return (paramsOffset + numParams + 3) & ~3;
}

function popcount16(bits: number): number {
  let count = 0;
  for (let n = bits; n !== 0; n >>>= 1) {
    count += n & 1;
  }
  return count;
}

// Trailing order past the requirements array: GenericPackShapeHeader/Descriptors (parameter
// packs), ConditionalInvertibleProtocolSet/RequirementCounts/Requirements (~Copyable/~Escapable
// conditional conformances), GenericValueHeader/Descriptors (generic value parameters) — each
// gated by its own bit in the generic context header's Flags.
export function genericContextEnd(descriptor: ContextDescriptor): number {
  const base = genericHeaderOffset(descriptor);
  const handle = descriptor.handle;
  const numParams = handle.add(base).readU16();
  const numRequirements = handle.add(base + OFFSETOF_NUM_REQUIREMENTS).readU16();
  const flags = handle.add(base + OFFSETOF_HEADER_FLAGS).readU16();
  const paramsOffset = base + OFFSETOF_GENERIC_PARAMS;
  let offset = genericRequirementsOffset(paramsOffset, numParams) + numRequirements * REQUIREMENT_SIZE;

  if ((flags & FLAG_HAS_TYPE_PACKS) !== 0) {
    const numPacks = handle.add(offset).readU16();
    offset += SIZEOF_PACK_SHAPE_HEADER + numPacks * SIZEOF_PACK_SHAPE_DESCRIPTOR;
  }

  if ((flags & FLAG_HAS_CONDITIONAL_INVERTED_PROTOCOLS) !== 0) {
    const invertedSet = handle.add(offset).readU16();
    offset += SIZEOF_CONDITIONAL_INVERTIBLE_PROTOCOL_SET;
    const numCounts = popcount16(invertedSet);
    const totalRequirements =
      numCounts === 0
        ? 0
        : handle.add(offset + (numCounts - 1) * SIZEOF_CONDITIONAL_REQUIREMENT_COUNT).readU16();
    offset += numCounts * SIZEOF_CONDITIONAL_REQUIREMENT_COUNT;
    offset = (offset + 3) & ~3;
    offset += totalRequirements * REQUIREMENT_SIZE;
  }

  if ((flags & FLAG_HAS_VALUES) !== 0) {
    const numValues = handle.add(offset).readU32();
    offset += SIZEOF_VALUE_HEADER + numValues * SIZEOF_VALUE_DESCRIPTOR;
  }

  return offset;
}

export function genericRequirements(descriptor: ContextDescriptor): GenericRequirementDescriptor[] {
  const base = genericHeaderOffset(descriptor);
  const handle = descriptor.handle;
  const numParams = handle.add(base).readU16();
  const numRequirements = handle.add(base + OFFSETOF_NUM_REQUIREMENTS).readU16();
  const paramsOffset = base + OFFSETOF_GENERIC_PARAMS;
  const requirementsOffset = genericRequirementsOffset(paramsOffset, numParams);
  return readGenericRequirementDescriptors(handle.add(requirementsOffset), numRequirements);
}

export function buildGenericMetadata(
  descriptor: ContextDescriptor,
  typeArguments: Metadata[]
): Metadata {
  const base = genericHeaderOffset(descriptor); // throws for non-generic / unsupported kinds
  const handle = descriptor.handle;
  const numParams = handle.add(base).readU16();
  const numRequirements = handle.add(base + OFFSETOF_NUM_REQUIREMENTS).readU16();
  if (typeArguments.length !== numParams) {
    throw new Error(`expected ${numParams} type argument(s), got ${typeArguments.length}`);
  }

  const paramsOffset = base + OFFSETOF_GENERIC_PARAMS;
  const paramHandles: NativePointer[] = [];
  for (let i = 0; i < numParams; i++) {
    const param = handle.add(paramsOffset + i).readU8();
    if ((param & GENERIC_PARAM_KIND_MASK) !== GENERIC_PARAM_KIND_TYPE) {
      throw new Error("non-type generic parameters are not supported");
    }
    if ((param & FLAG_HAS_KEY_ARGUMENT) !== 0) {
      paramHandles.push(typeArguments[i].handle);
    }
  }

  if (numRequirements === 0) {
    return instantiateGenericMetadata(descriptor, paramHandles);
  }

  const paramVector = Memory.alloc(Math.max(1, paramHandles.length) * Process.pointerSize);
  paramHandles.forEach((h, i) => paramVector.add(i * Process.pointerSize).writePointer(h));

  const witnessTables: NativePointer[] = [];
  const requirements = handle.add(genericRequirementsOffset(paramsOffset, numParams));
  for (let i = 0; i < numRequirements; i++) {
    const requirement = requirements.add(i * REQUIREMENT_SIZE);
    const flags = requirement.readU32();
    if ((flags & FLAG_HAS_KEY_ARGUMENT) === 0) {
      continue;
    }
    if ((flags & REQUIREMENT_KIND_MASK) !== REQUIREMENT_KIND_PROTOCOL) {
      throw new Error("only protocol conformance requirements are supported");
    }
    witnessTables.push(witnessTableFor(descriptor, requirement, paramVector));
  }

  return instantiateGenericMetadata(descriptor, [...paramHandles, ...witnessTables]);
}

function witnessTableFor(
  descriptor: ContextDescriptor,
  requirement: NativePointer,
  paramVector: NativePointer
): NativePointer {
  const subjectName = RelativeDirectPointer.resolve(requirement.add(OFFSETOF_REQ_PARAM));
  if (subjectName === null) {
    throw new Error("conformance requirement has no subject");
  }
  const subject = resolveTypeByMangledName(
    { address: subjectName, length: symbolicMangledNameLength(subjectName) },
    descriptor,
    paramVector
  );
  if (subject === null) {
    throw new Error("could not resolve conformance requirement subject");
  }

  const protocol = resolveRequirementProtocol(requirement.add(OFFSETOF_REQ_PROTOCOL));
  const witnessTable = conformsToProtocol(subject, protocol);
  if (witnessTable === null) {
    throw new Error("type does not satisfy a conformance requirement");
  }
  return witnessTable;
}

function resolveRequirementProtocol(field: NativePointer): ContextDescriptor {
  const offset = field.readS32() & ~PROTOCOL_REF_OBJC_BIT;
  const address = field.add(offset & ~1);
  const descriptor = (offset & 1) !== 0 ? address.readPointer().strip() : address;
  return new ContextDescriptor(descriptor);
}

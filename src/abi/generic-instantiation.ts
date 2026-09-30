import { ContextDescriptor } from "./context-descriptor.js";
import { Metadata, MetadataKind, instantiateGenericMetadata, genericHeaderOffset } from "./metadata.js";
import { conformsToProtocol } from "./protocol-conformance.js";
import { resolveTypeByMangledName } from "./field-descriptor.js";
import { isObjCExistential } from "./existential.js";
import {
  GenericRequirementDescriptor,
  GenericRequirementKind,
  GenericRequirementLayoutKind,
  readGenericRequirementDescriptors,
} from "./generic-requirement-descriptor.js";
import { getSwiftCoreApi } from "../runtime/api.js";
import { ValueWitnessTable } from "./value-witness.js";
import { RelativeDirectPointer, RelativeIndirectablePointer } from "../basic/relative-pointer.js";

const OFFSETOF_NUM_REQUIREMENTS = 0x2;
const OFFSETOF_NUM_KEY_ARGUMENTS = 0x4;
const OFFSETOF_HEADER_FLAGS = 0x6;
const OFFSETOF_GENERIC_PARAMS = 0x8;

const FLAG_HAS_KEY_ARGUMENT = 0x80;
const GENERIC_PARAM_KIND_MASK = 0x3f;
const GENERIC_PARAM_KIND_TYPE = 0x0;

const REQUIREMENT_SIZE = 0xc;

const FLAG_HAS_TYPE_PACKS = 0x1;
const FLAG_HAS_CONDITIONAL_INVERTED_PROTOCOLS = 0x2;
const FLAG_HAS_VALUES = 0x4;

const SIZEOF_PACK_SHAPE_HEADER = 0x4;
const SIZEOF_PACK_SHAPE_DESCRIPTOR = 0x8;
const SIZEOF_CONDITIONAL_INVERTIBLE_PROTOCOL_SET = 0x2;
const SIZEOF_CONDITIONAL_REQUIREMENT_COUNT = 0x2;
const SIZEOF_VALUE_HEADER = 0x4;
const SIZEOF_VALUE_DESCRIPTOR = 0x4;

const OFFSETOF_PATTERN_VALUE_WITNESSES = 0xc;

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

// The instantiation pattern's witnesses describe the type in its own generic context, and are
// Incomplete exactly when its layout depends on the generic arguments.
export function hasFixedLayoutInGenericContext(descriptor: ContextDescriptor): boolean {
  const patternField = descriptor.handle.add(genericHeaderOffset(descriptor) - RelativeDirectPointer.sizeOf);
  const pattern = RelativeDirectPointer.resolve(patternField);
  const witnesses = pattern === null ? null : RelativeIndirectablePointer.resolve(pattern.add(OFFSETOF_PATTERN_VALUE_WITNESSES));
  return witnesses !== null && !new ValueWitnessTable(witnesses, NULL).isIncomplete;
}

// One entry per generic parameter in scope, the enclosing contexts' first.
export function genericParamsAreKey(descriptor: ContextDescriptor): boolean[] {
  const base = genericHeaderOffset(descriptor);
  const numParams = descriptor.handle.add(base).readU16();
  return Array.from(
    { length: numParams },
    (_, i) => (descriptor.handle.add(base + OFFSETOF_GENERIC_PARAMS + i).readU8() & FLAG_HAS_KEY_ARGUMENT) !== 0
  );
}

export function keyGenericArguments(metadata: Metadata): { typeArguments: Metadata[]; witnessTables: NativePointer[] } {
  const descriptor = metadata.description;
  const numKeyArguments = descriptor.handle.add(genericHeaderOffset(descriptor) + OFFSETOF_NUM_KEY_ARGUMENTS).readU16();
  const numKeyParams = genericParamsAreKey(descriptor).filter((isKey) => isKey).length;
  const keyArguments: NativePointer[] = [];
  for (let i = 0; i < numKeyArguments; i++) {
    keyArguments.push(metadata.genericArguments.add(i * Process.pointerSize).readPointer());
  }
  return {
    typeArguments: keyArguments.slice(0, numKeyParams).map((h) => new Metadata(h)),
    witnessTables: keyArguments.slice(numKeyParams),
  };
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

  const keyArguments = [...paramHandles];
  const keyArgumentVector = Memory.alloc((paramHandles.length + numRequirements) * Process.pointerSize);
  paramHandles.forEach((h, i) => keyArgumentVector.add(i * Process.pointerSize).writePointer(h));

  for (const requirement of genericRequirements(descriptor)) {
    const witnessTable = checkRequirement(descriptor, requirement, keyArgumentVector);
    if (requirement.hasKeyArgument) {
      if (witnessTable === null) {
        throw new Error("only protocol conformance requirements are supported");
      }
      keyArgumentVector.add(keyArguments.length * Process.pointerSize).writePointer(witnessTable);
      keyArguments.push(witnessTable);
    }
  }

  return instantiateGenericMetadata(descriptor, keyArguments);
}

// Mirrors the runtime's checkGenericRequirement; returns the witness table of a Swift protocol requirement.
function checkRequirement(
  descriptor: ContextDescriptor,
  requirement: GenericRequirementDescriptor,
  keyArguments: NativePointer
): NativePointer | null {
  const subject = resolveTypeByMangledName(requirement.param, descriptor, keyArguments);
  if (subject === null) {
    throw new Error("could not resolve generic requirement subject");
  }

  switch (requirement.kind) {
    case GenericRequirementKind.Protocol: {
      if (requirement.isObjCProtocol) {
        const cast = getSwiftCoreApi().swift_dynamicCastTypeToObjCProtocolConditional!;
        const protocols = Memory.alloc(Process.pointerSize).writePointer(requirement.objCProtocol!);
        if (cast(subject.handle, 1, protocols).isNull()) {
          throw new Error("type does not conform to a required Objective-C protocol");
        }
        return null;
      }
      const witnessTable = conformsToProtocol(subject, requirement.protocol!);
      if (witnessTable === null) {
        throw new Error("type does not satisfy a conformance requirement");
      }
      return witnessTable;
    }
    case GenericRequirementKind.SameType: {
      const other = resolveTypeByMangledName(requirement.sameTypeName!, descriptor, keyArguments);
      if (other === null || !other.handle.equals(subject.handle)) {
        throw new Error("type does not satisfy a same-type requirement");
      }
      return null;
    }
    case GenericRequirementKind.BaseClass: {
      const superclass = resolveTypeByMangledName(requirement.sameTypeName!, descriptor, keyArguments);
      if (superclass === null || getSwiftCoreApi().swift_dynamicCastMetatype(subject.handle, superclass.handle).isNull()) {
        throw new Error("type is not a subclass of the required superclass");
      }
      return null;
    }
    case GenericRequirementKind.Layout: {
      if (requirement.layoutKind !== GenericRequirementLayoutKind.Class) {
        throw new Error(`unknown generic requirement layout kind ${requirement.layoutKind}`);
      }
      if (!satisfiesClassConstraint(subject)) {
        throw new Error("type does not satisfy a class constraint");
      }
      return null;
    }
    default:
      return null;
  }
}

function satisfiesClassConstraint(type: Metadata): boolean {
  switch (type.kind) {
    case MetadataKind.Class:
    case MetadataKind.ObjCClassWrapper:
    case MetadataKind.ForeignClass:
      return true;
    case MetadataKind.Existential:
      return isObjCExistential(type);
    default:
      return false;
  }
}

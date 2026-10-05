import { ContextDescriptor, ContextDescriptorKind } from "./context-descriptor.js";
import {
  Metadata,
  MetadataKind,
  instantiateGenericMetadata,
  genericHeaderOffset,
  readGenericContextHeader,
  GENERIC_CONTEXT_HEADER_SIZE,
} from "./metadata.js";
import { conformsToProtocol } from "./protocol-conformance.js";
import { resolveTypeByMangledName } from "./field-descriptor.js";
import {
  isObjCExistential,
  existentialSuperclassConstraint,
  extendedExistentialRequirementSignature,
  extendedExistentialSpecialKind,
  ExtendedExistentialSpecialKind,
} from "./existential.js";
import { enumerateTupleElements } from "./tuple.js";
import { readFunctionType, FunctionMetadataConvention } from "./function-type.js";
import { metadataInitializationKind, MetadataInitializationKind } from "./class-descriptor.js";
import {
  GENERIC_REQUIREMENT_DESCRIPTOR_SIZE,
  GenericRequirementDescriptor,
  GenericRequirementKind,
  GenericRequirementLayoutKind,
  InvertibleProtocolKind,
  readGenericRequirementDescriptors,
} from "./generic-requirement-descriptor.js";
import { getSwiftCoreApi } from "../runtime/api.js";
import { ValueWitnessTable } from "./value-witness.js";
import { RelativeDirectPointer, RelativeIndirectablePointer } from "../basic/relative-pointer.js";

const FLAG_HAS_KEY_ARGUMENT = 0x80;
const GENERIC_PARAM_KIND_MASK = 0x3f;
const GENERIC_PARAM_KIND_TYPE = 0x0;

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

const FLAG_HAS_INVERTIBLE_PROTOCOLS = 0x20;
const KIND_FLAGS_SHIFT = 16;
const KIND_FLAG_HAS_CANONICAL_METADATA_PRESPECIALIZATIONS = 0x8;
const OFFSETOF_VALUE_TYPE_TRAILING_OBJECTS = 0x1c;
const SIZEOF_FOREIGN_METADATA_INITIALIZATION = 0x4;
const SIZEOF_SINGLETON_METADATA_INITIALIZATION = 0xc;
const SIZEOF_METADATA_LIST_COUNT = 0x4;
const SIZEOF_METADATA_LIST_ENTRY = 0x4;
const SIZEOF_METADATA_CACHING_ONCE_TOKEN = 0x4;
const OFFSETOF_INSTANTIATION_CACHE_BEFORE_GENERIC_HEADER = -0x8;
const OFFSETOF_CACHE_ELEMENT_COUNT = 0x4;
const OFFSETOF_CACHE_ELEMENTS = 0x8;

const INVERTED_PROTOCOLS_SUBJECT_FORM = 0xffff;
const INVERTIBLE_PROTOCOL_NAMES = ["Copyable", "Escapable"];
const ESCAPABLE_BIT = 1 << InvertibleProtocolKind.Escapable;

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

// The runtime keeps every metadata it hands out for a generic type in a hash map built lazily in the
// descriptor's InstantiationCache private data: its dense element array holds one GenericCacheEntry
// pointer per specialization. Null when the descriptor carries no cache and the runtime uses its
// global map instead.
export function genericCacheEntries(descriptor: ContextDescriptor): NativePointer[] | null {
  const header = descriptor.handle.add(genericHeaderOffset(descriptor));
  const cache = RelativeDirectPointer.resolve(header.add(OFFSETOF_INSTANTIATION_CACHE_BEFORE_GENERIC_HEADER));
  if (cache === null) {
    return null;
  }
  const count = cache.add(OFFSETOF_CACHE_ELEMENT_COUNT).readU32();
  const elements = cache.add(OFFSETOF_CACHE_ELEMENTS).readPointer();
  if (count === 0 || elements.isNull()) {
    return [];
  }
  const entries = elements.add(Process.pointerSize);
  return Array.from({ length: count }, (_, i) => entries.add(i * Process.pointerSize).readPointer());
}

// Trailing order past the requirements array: GenericPackShapeHeader/Descriptors (parameter
// packs), ConditionalInvertibleProtocolSet/RequirementCounts/Requirements (~Copyable/~Escapable
// conditional conformances), GenericValueHeader/Descriptors (generic value parameters) — each
// gated by its own bit in the generic context header's Flags.
export function genericContextEnd(descriptor: ContextDescriptor): number {
  const handle = descriptor.handle;
  const { flags } = readGenericContextHeader(handle.add(genericHeaderOffset(descriptor)));
  let offset = packShapesEnd(descriptor);

  if ((flags & FLAG_HAS_CONDITIONAL_INVERTED_PROTOCOLS) !== 0) {
    offset = conditionalInvertedProtocolsSection(descriptor)!.end;
  }

  if ((flags & FLAG_HAS_VALUES) !== 0) {
    const numValues = handle.add(offset).readU32();
    offset += SIZEOF_VALUE_HEADER + numValues * SIZEOF_VALUE_DESCRIPTOR;
  }

  return offset;
}

function packShapesEnd(descriptor: ContextDescriptor): number {
  const base = genericHeaderOffset(descriptor);
  const handle = descriptor.handle;
  const { numParams, numRequirements, flags } = readGenericContextHeader(handle.add(base));
  const paramsOffset = base + GENERIC_CONTEXT_HEADER_SIZE;
  let offset = genericRequirementsOffset(paramsOffset, numParams) + numRequirements * GENERIC_REQUIREMENT_DESCRIPTOR_SIZE;
  if ((flags & FLAG_HAS_TYPE_PACKS) !== 0) {
    const numPacks = handle.add(offset).readU16();
    offset += SIZEOF_PACK_SHAPE_HEADER + numPacks * SIZEOF_PACK_SHAPE_DESCRIPTOR;
  }
  return offset;
}

interface ConditionalInvertedProtocolsSection {
  protocolBits: number;
  cumulativeRequirementCounts: number[]; // one per set bit, in bit order
  requirementsOffset: number;
  end: number;
}

// The invertible protocols a generic type conforms to only under conditions, with the
// requirements of each conditional conformance.
function conditionalInvertedProtocolsSection(descriptor: ContextDescriptor): ConditionalInvertedProtocolsSection | null {
  const handle = descriptor.handle;
  const { flags } = readGenericContextHeader(handle.add(genericHeaderOffset(descriptor)));
  if ((flags & FLAG_HAS_CONDITIONAL_INVERTED_PROTOCOLS) === 0) {
    return null;
  }
  let offset = packShapesEnd(descriptor);
  const protocolBits = handle.add(offset).readU16();
  offset += SIZEOF_CONDITIONAL_INVERTIBLE_PROTOCOL_SET;
  const cumulativeRequirementCounts: number[] = [];
  for (let i = 0; i < popcount16(protocolBits); i++) {
    cumulativeRequirementCounts.push(handle.add(offset + i * SIZEOF_CONDITIONAL_REQUIREMENT_COUNT).readU16());
  }
  offset += cumulativeRequirementCounts.length * SIZEOF_CONDITIONAL_REQUIREMENT_COUNT;
  const requirementsOffset = (offset + 3) & ~3;
  const totalRequirements = cumulativeRequirementCounts[cumulativeRequirementCounts.length - 1] ?? 0;
  return {
    protocolBits,
    cumulativeRequirementCounts,
    requirementsOffset,
    end: requirementsOffset + totalRequirements * GENERIC_REQUIREMENT_DESCRIPTOR_SIZE,
  };
}

function conditionalRequirementsFor(
  descriptor: ContextDescriptor,
  section: ConditionalInvertedProtocolsSection,
  kind: InvertibleProtocolKind
): GenericRequirementDescriptor[] {
  const position = popcount16(section.protocolBits & ((1 << kind) - 1));
  const start = position === 0 ? 0 : section.cumulativeRequirementCounts[position - 1];
  const end = section.cumulativeRequirementCounts[position];
  return readGenericRequirementDescriptors(
    descriptor.handle.add(section.requirementsOffset + start * GENERIC_REQUIREMENT_DESCRIPTOR_SIZE),
    end - start
  );
}

// The invertible protocols a struct or enum's primary definition suppresses (~Copyable,
// ~Escapable); a class suppresses none. Trails the generic context, the metadata initialization
// record and the canonical prespecialization list.
function invertedProtocols(descriptor: ContextDescriptor): number {
  const kind = descriptor.kind;
  if (
    (descriptor.flags & FLAG_HAS_INVERTIBLE_PROTOCOLS) === 0 ||
    (kind !== ContextDescriptorKind.Struct && kind !== ContextDescriptorKind.Enum)
  ) {
    return 0;
  }
  const handle = descriptor.handle;
  let offset = descriptor.isGeneric ? genericContextEnd(descriptor) : OFFSETOF_VALUE_TYPE_TRAILING_OBJECTS;
  switch (metadataInitializationKind(descriptor)) {
    case MetadataInitializationKind.Foreign:
      offset += SIZEOF_FOREIGN_METADATA_INITIALIZATION;
      break;
    case MetadataInitializationKind.Singleton:
      offset += SIZEOF_SINGLETON_METADATA_INITIALIZATION;
      break;
    case MetadataInitializationKind.None:
      break;
  }
  if (descriptor.isGeneric && ((descriptor.flags >>> KIND_FLAGS_SHIFT) & KIND_FLAG_HAS_CANONICAL_METADATA_PRESPECIALIZATIONS) !== 0) {
    const count = handle.add(offset).readU32();
    offset += SIZEOF_METADATA_LIST_COUNT + count * SIZEOF_METADATA_LIST_ENTRY + SIZEOF_METADATA_CACHING_ONCE_TOKEN;
  }
  return handle.add(offset).readU16();
}

function requireNoneMissing(suppressed: number, ignored: number): void {
  const missing = suppressed & ~ignored;
  if (missing !== 0) {
    const names = INVERTIBLE_PROTOCOL_NAMES.filter((_, bit) => (missing & (1 << bit)) !== 0);
    throw new Error(`type does not satisfy a ${names.join(" and ")} requirement`);
  }
}

// Mirrors the runtime's checkInvertibleRequirements: the type must conform to every invertible
// protocol except those in ignored.
function checkInvertibleRequirements(type: Metadata, ignored: number): void {
  switch (type.kind) {
    case MetadataKind.Struct:
    case MetadataKind.Enum:
    case MetadataKind.Optional:
      checkNominalInvertibleRequirements(type, ignored);
      return;
    case MetadataKind.Tuple:
      for (const element of enumerateTupleElements(type)) {
        checkInvertibleRequirements(element.type, ignored);
      }
      return;
    case MetadataKind.Function: {
      const fn = readFunctionType(type);
      const nonEscaping = fn.convention === FunctionMetadataConvention.Swift && !fn.isEscaping;
      requireNoneMissing(fn.invertedProtocols | (nonEscaping ? ESCAPABLE_BIT : 0), ignored);
      return;
    }
    case MetadataKind.ExtendedExistential:
      if (extendedExistentialSpecialKind(type) === ExtendedExistentialSpecialKind.Metatype) {
        return;
      }
      for (const requirement of extendedExistentialRequirementSignature(type)) {
        if (requirement.kind === GenericRequirementKind.InvertedProtocols) {
          requireNoneMissing(requirement.invertedProtocols!.protocolBits, ignored);
        }
      }
      return;
    default:
      return;
  }
}

function checkNominalInvertibleRequirements(type: Metadata, ignored: number): void {
  const descriptor = type.description;
  const missing = invertedProtocols(descriptor) & ~ignored;
  if (missing === 0) {
    return;
  }
  const conditional = descriptor.isGeneric ? conditionalInvertedProtocolsSection(descriptor) : null;
  requireNoneMissing(missing, conditional?.protocolBits ?? 0);
  const { typeArguments } = keyGenericArguments(type);
  for (let kind = 0; kind < INVERTIBLE_PROTOCOL_NAMES.length; kind++) {
    if ((missing & (1 << kind)) !== 0) {
      checkRequirements(descriptor, conditionalRequirementsFor(descriptor, conditional!, kind), type.genericArguments, typeArguments);
    }
  }
}

// Mirrors the runtime's _checkGenericRequirements: witness tables of satisfied conformance
// requirements in requirement order, after every key argument has been checked against the
// invertible protocols the requirements left unsuppressed.
function checkRequirements(
  descriptor: ContextDescriptor,
  requirements: GenericRequirementDescriptor[],
  keyArguments: NativePointer,
  keyTypeArguments: Metadata[],
  onWitnessTable: (table: NativePointer) => void = () => {}
): void {
  const suppressed: number[] = [];
  for (const requirement of requirements) {
    const witnessTable = checkRequirement(descriptor, requirement, keyArguments, suppressed);
    if (requirement.hasKeyArgument) {
      if (witnessTable === null) {
        throw new Error("only protocol conformance requirements are supported");
      }
      onWitnessTable(witnessTable);
    }
  }
  let keyIndex = 0;
  genericParamsAreKey(descriptor).forEach((isKey, index) => {
    if (isKey) {
      checkInvertibleRequirements(keyTypeArguments[keyIndex++], suppressed[index] ?? 0);
    }
  });
}

export function genericRequirements(descriptor: ContextDescriptor): GenericRequirementDescriptor[] {
  const base = genericHeaderOffset(descriptor);
  const handle = descriptor.handle;
  const { numParams, numRequirements } = readGenericContextHeader(handle.add(base));
  const paramsOffset = base + GENERIC_CONTEXT_HEADER_SIZE;
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
  const { numParams } = readGenericContextHeader(descriptor.handle.add(base));
  return Array.from(
    { length: numParams },
    (_, i) => (descriptor.handle.add(base + GENERIC_CONTEXT_HEADER_SIZE + i).readU8() & FLAG_HAS_KEY_ARGUMENT) !== 0
  );
}

export function keyGenericArguments(metadata: Metadata): { typeArguments: Metadata[]; witnessTables: NativePointer[] } {
  const descriptor = metadata.description;
  const { numKeyArguments } = readGenericContextHeader(descriptor.handle.add(genericHeaderOffset(descriptor)));
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
  const { numParams, numRequirements } = readGenericContextHeader(handle.add(base));
  if (typeArguments.length !== numParams) {
    throw new Error(`expected ${numParams} type argument(s), got ${typeArguments.length}`);
  }

  const paramsOffset = base + GENERIC_CONTEXT_HEADER_SIZE;
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

  const keyArguments = [...paramHandles];
  const keyArgumentVector = Memory.alloc((paramHandles.length + numRequirements) * Process.pointerSize);
  paramHandles.forEach((h, i) => keyArgumentVector.add(i * Process.pointerSize).writePointer(h));
  const isKey = genericParamsAreKey(descriptor);
  const keyTypeArguments = typeArguments.filter((_, i) => isKey[i]);

  checkRequirements(descriptor, genericRequirements(descriptor), keyArgumentVector, keyTypeArguments, (witnessTable) => {
    keyArgumentVector.add(keyArguments.length * Process.pointerSize).writePointer(witnessTable);
    keyArguments.push(witnessTable);
  });

  return instantiateGenericMetadata(descriptor, keyArguments);
}

// Mirrors the runtime's checkGenericRequirement; returns the witness table of a Swift protocol requirement.
function checkRequirement(
  descriptor: ContextDescriptor,
  requirement: GenericRequirementDescriptor,
  keyArguments: NativePointer,
  suppressed: number[]
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
      const subclass = subject.kind === MetadataKind.Existential ? existentialSuperclassConstraint(subject) ?? subject : subject;
      if (superclass === null || getSwiftCoreApi().swift_dynamicCastMetatype(subclass.handle, superclass.handle).isNull()) {
        throw new Error("type is not a subclass of the required superclass");
      }
      return null;
    }
    case GenericRequirementKind.InvertedProtocols: {
      const { genericParamIndex, protocolBits } = requirement.invertedProtocols!;
      if (genericParamIndex === INVERTED_PROTOCOLS_SUBJECT_FORM) {
        checkInvertibleRequirements(subject, protocolBits);
      } else {
        suppressed[genericParamIndex] = (suppressed[genericParamIndex] ?? 0) | protocolBits;
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

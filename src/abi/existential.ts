import { Metadata, MetadataKind, readGenericContextHeader, GENERIC_CONTEXT_HEADER_SIZE } from "./metadata.js";
import { ContextDescriptor, ContextDescriptorKind } from "./context-descriptor.js";
import {
  GenericRequirementDescriptor,
  GenericRequirementKind,
  readGenericRequirementDescriptors,
} from "./generic-requirement-descriptor.js";
import { MangledName } from "./field-descriptor.js";
import { dynamicTypeOf } from "./class-metadata.js";
import { metatypeInstanceType } from "./metatype.js";
import { getSwiftCoreApi } from "../runtime/api.js";
import { RelativeDirectPointer } from "../basic/relative-pointer.js";

const FLAGS_OFFSET = Process.pointerSize;
const NUM_PROTOCOLS_OFFSET = Process.pointerSize + 4;
const TYPE_OFFSET = 3 * Process.pointerSize;

const SPECIAL_PROTOCOL_MASK = 0x3f000000;
const SPECIAL_PROTOCOL_ERROR = 0x01000000;
const NOT_CLASS_CONSTRAINED = 0x80000000;
const HAS_SUPERCLASS_CONSTRAINT = 0x40000000;
const NUM_WITNESS_TABLES_MASK = 0x00ffffff;
const PROTOCOL_DESCRIPTOR_REF_IS_OBJC = 1;

const SHAPE_SPECIAL_KIND_MASK = 0xff;
const SHAPE_HAS_GENERALIZATION_SIGNATURE = 0x100;
const SHAPE_HAS_TYPE_EXPRESSION = 0x200;
const SHAPE_HAS_SUGGESTED_VALUE_WITNESSES = 0x400;
const SHAPE_HAS_IMPLICIT_REQ_SIG_PARAMS = 0x800;
const SHAPE_HAS_IMPLICIT_GEN_SIG_PARAMS = 0x1000;
const SHAPE_REQ_SIG_HEADER_OFFSET = 0x8;
const SHAPE_GEN_SIG_HEADER_OFFSET = 0x10;
const RELATIVE_POINTER_SIZE = 4;
const GENERALIZATION_ARGUMENTS_OFFSET = 2 * Process.pointerSize;

// Self is opened one depth below the generalization parameters: τ_1_0, or τ_0_0 when there are none.
const OPENED_SELF_BEHIND_GENERALIZATION = "qd__";
const OPENED_SELF_ALONE = "x";
const ASSOCIATED_TYPE_OF_OPENED_SELF = "Qyd__";
const SYMBOLIC_REFERENCE_DIRECT = 0x01;
const SYMBOLIC_REFERENCE_INDIRECT = 0x02;

export type ExistentialRepresentation = "opaque" | "class" | "error";

export function existentialRepresentation(metadata: Metadata): ExistentialRepresentation {
  const flags = metadata.handle.add(FLAGS_OFFSET).readU32();
  if ((flags & SPECIAL_PROTOCOL_MASK) === SPECIAL_PROTOCOL_ERROR) {
    return "error";
  }
  return (flags & NOT_CLASS_CONSTRAINED) !== 0 ? "opaque" : "class";
}

export function isObjCExistential(metadata: Metadata): boolean {
  const flags = metadata.handle.add(FLAGS_OFFSET).readU32();
  return (flags & NOT_CLASS_CONSTRAINED) === 0 && (flags & NUM_WITNESS_TABLES_MASK) === 0;
}

export interface OpaqueExistential {
  type: Metadata;
  value: NativePointer;
}

export function projectOpaqueExistential(container: NativePointer): OpaqueExistential {
  const type = new Metadata(container.add(TYPE_OFFSET).readPointer());
  return { type, value: type.valueWitnesses.projectBuffer(container) };
}

export function projectClassExistential(container: NativePointer): OpaqueExistential {
  const value = container.readPointer();
  return { type: dynamicTypeOf(value), value };
}

export enum ExtendedExistentialSpecialKind {
  None = 0,
  Class = 1,
  Metatype = 2,
  ExplicitLayout = 3,
}

function extendedExistentialShape(metadata: Metadata): NativePointer {
  return metadata.handle.add(Process.pointerSize).readPointer().strip();
}

export function extendedExistentialSpecialKind(metadata: Metadata): ExtendedExistentialSpecialKind {
  return extendedExistentialShape(metadata).readU32() & SHAPE_SPECIAL_KIND_MASK;
}

function hasGeneralizationSignature(shape: NativePointer): boolean {
  return (shape.readU32() & SHAPE_HAS_GENERALIZATION_SIGNATURE) !== 0;
}

function numGeneralizationParams(shape: NativePointer): number {
  return hasGeneralizationSignature(shape) ? readGenericContextHeader(shape.add(SHAPE_GEN_SIG_HEADER_OFFSET)).numParams : 0;
}

export function extendedExistentialRequirementSignature(metadata: Metadata): GenericRequirementDescriptor[] {
  const shape = extendedExistentialShape(metadata);
  const flags = shape.readU32();
  const { numParams: numReqSigParams, numRequirements: numReqSigRequirements } = readGenericContextHeader(
    shape.add(SHAPE_REQ_SIG_HEADER_OFFSET)
  );
  let offset = SHAPE_GEN_SIG_HEADER_OFFSET;
  if (hasGeneralizationSignature(shape)) {
    offset += GENERIC_CONTEXT_HEADER_SIZE;
  }
  if ((flags & SHAPE_HAS_TYPE_EXPRESSION) !== 0) {
    offset += RELATIVE_POINTER_SIZE;
  }
  if ((flags & SHAPE_HAS_SUGGESTED_VALUE_WITNESSES) !== 0) {
    offset += RELATIVE_POINTER_SIZE;
  }
  if ((flags & SHAPE_HAS_IMPLICIT_REQ_SIG_PARAMS) === 0) {
    offset += numReqSigParams;
  }
  if ((flags & SHAPE_HAS_IMPLICIT_GEN_SIG_PARAMS) === 0) {
    offset += numGeneralizationParams(shape);
  }
  return readGenericRequirementDescriptors(shape.add((offset + 3) & ~3), numReqSigRequirements);
}

// Only the leading type metadata; witness tables for the generalization signature's conformances follow.
export function extendedExistentialGeneralizationArguments(metadata: Metadata): Metadata[] {
  const numParams = numGeneralizationParams(extendedExistentialShape(metadata));
  const args = metadata.handle.add(GENERALIZATION_ARGUMENTS_OFFSET);
  const result: Metadata[] = [];
  for (let i = 0; i < numParams; i++) {
    result.push(new Metadata(args.add(i * Process.pointerSize).readPointer()));
  }
  return result;
}

export interface BoundAssociatedType {
  name: string;
  protocol: ContextDescriptor | null;
  type: Metadata;
}

// The generalization arguments of any P<A, B>, each paired with the associated type its
// same-type requirement (τ_0_i == Self.Name) binds it to.
export function extendedExistentialBoundAssociatedTypes(metadata: Metadata): BoundAssociatedType[] {
  const args = extendedExistentialGeneralizationArguments(metadata);
  const bound: BoundAssociatedType[] = [];
  for (const requirement of extendedExistentialRequirementSignature(metadata)) {
    if (requirement.kind !== GenericRequirementKind.SameType || requirement.sameTypeName === null) {
      continue;
    }
    const index = generalizationParamIndex(requirement.param);
    const associated = openedSelfAssociatedType(requirement.sameTypeName);
    if (index !== null && index < args.length && associated !== null) {
      bound.push({ ...associated, type: args[index] });
    }
  }
  return bound;
}

// x is τ_0_0; q_ is τ_0_1; q<n>_ is τ_0_(n+2).
function generalizationParamIndex({ address, length }: MangledName): number | null {
  const text = address.readUtf8String(length)!;
  if (text === "x") {
    return 0;
  }
  const match = /^q(\d*)_$/.exec(text);
  if (match === null) {
    return null;
  }
  return match[1] === "" ? 1 : Number(match[1]) + 2;
}

// <identifier> <symbolic protocol reference> Qy d__: the named associated type of the opened Self.
function openedSelfAssociatedType({ address, length }: MangledName): { name: string; protocol: ContextDescriptor | null } | null {
  let nameLength = 0;
  let cursor = 0;
  for (; cursor < length; cursor++) {
    const byte = address.add(cursor).readU8();
    if (byte < 0x30 || byte > 0x39) {
      break;
    }
    nameLength = nameLength * 10 + (byte - 0x30);
  }
  if (cursor === 0 || nameLength === 0) {
    return null;
  }
  const name = address.add(cursor).readUtf8String(nameLength)!;
  cursor += nameLength;
  const referenceKind = address.add(cursor).readU8();
  let protocol: ContextDescriptor | null = null;
  if (referenceKind === SYMBOLIC_REFERENCE_DIRECT || referenceKind === SYMBOLIC_REFERENCE_INDIRECT) {
    const target = RelativeDirectPointer.resolve(address.add(cursor + 1));
    if (target !== null) {
      protocol = new ContextDescriptor(referenceKind === SYMBOLIC_REFERENCE_INDIRECT ? target.readPointer().strip() : target);
    }
    cursor += 1 + RELATIVE_POINTER_SIZE;
  }
  const tail = address.add(cursor).readUtf8String(length - cursor);
  return tail === ASSOCIATED_TYPE_OF_OPENED_SELF ? { name, protocol } : null;
}

function extendedExistentialProtocols(metadata: Metadata): ContextDescriptor[] {
  const self = hasGeneralizationSignature(extendedExistentialShape(metadata))
    ? OPENED_SELF_BEHIND_GENERALIZATION
    : OPENED_SELF_ALONE;
  const protocols: ContextDescriptor[] = [];
  for (const requirement of extendedExistentialRequirementSignature(metadata)) {
    const { address, length } = requirement.param;
    if (
      requirement.kind === GenericRequirementKind.Protocol &&
      requirement.protocol !== null &&
      length === self.length &&
      address.readUtf8String(length) === self
    ) {
      protocols.push(requirement.protocol);
    }
  }
  return protocols;
}

export function isClassExistential(metadata: Metadata): boolean {
  return metadata.kind === MetadataKind.ExtendedExistential
    ? extendedExistentialSpecialKind(metadata) === ExtendedExistentialSpecialKind.Class
    : existentialRepresentation(metadata) === "class";
}

export function projectExistentialValue(metadata: Metadata, container: NativePointer): OpaqueExistential {
  if (metadata.kind === MetadataKind.ExtendedExistential) {
    switch (extendedExistentialSpecialKind(metadata)) {
      case ExtendedExistentialSpecialKind.None:
        return projectOpaqueExistential(container);
      case ExtendedExistentialSpecialKind.Class:
        return projectClassExistential(container);
      default:
        throw new Error("projectExistentialValue: only opaque and class extended existentials are supported");
    }
  }
  const representation = existentialRepresentation(metadata);
  if (representation === "class") {
    return projectClassExistential(container);
  }
  if (representation === "opaque") {
    return projectOpaqueExistential(container);
  }
  throw new Error("projectExistentialValue: Error existentials are not supported; use projectErrorExistential");
}

// Swift protocol descriptors of an Existential or ExtendedExistential metadata; ObjC refs (low bit set) are skipped.
export function existentialProtocols(metadata: Metadata): ContextDescriptor[] {
  if (metadata.kind === MetadataKind.ExtendedExistential) {
    return extendedExistentialProtocols(metadata);
  }
  if (metadata.kind === MetadataKind.ExistentialMetatype) {
    return existentialProtocols(metatypeInstanceType(metadata));
  }
  const flags = metadata.handle.add(FLAGS_OFFSET).readU32();
  const numProtocols = metadata.handle.add(NUM_PROTOCOLS_OFFSET).readU32();
  let cursor = metadata.handle.add(NUM_PROTOCOLS_OFFSET + 4);
  if ((flags & HAS_SUPERCLASS_CONSTRAINT) !== 0) {
    cursor = cursor.add(Process.pointerSize);
  }
  const protocols: ContextDescriptor[] = [];
  for (let i = 0; i < numProtocols; i++) {
    const ref = cursor.add(i * Process.pointerSize).readPointer();
    if (!ref.and(PROTOCOL_DESCRIPTOR_REF_IS_OBJC).isNull()) {
      continue;
    }
    protocols.push(new ContextDescriptor(ref));
  }
  return protocols;
}

export function existentialSuperclassConstraint(metadata: Metadata): Metadata | null {
  const flags = metadata.handle.add(FLAGS_OFFSET).readU32();
  if ((flags & HAS_SUPERCLASS_CONSTRAINT) === 0) {
    return null;
  }
  return new Metadata(metadata.handle.add(NUM_PROTOCOLS_OFFSET + 4).readPointer());
}

export function projectErrorExistential(container: NativePointer): OpaqueExistential {
  const errorBox = container.readPointer();
  const bridgedNSErrorScratch = Memory.alloc(Process.pointerSize);
  const result = Memory.alloc(3 * Process.pointerSize);
  getSwiftCoreApi().swift_getErrorValue(errorBox, bridgedNSErrorScratch, result);
  return {
    value: result.readPointer(),
    type: new Metadata(result.add(Process.pointerSize).readPointer()),
  };
}

// Fills a container with a copy of a value of a conforming type: inline or boxed with its type for
// the opaque representation, the retained reference for the class one, then the witness tables in
// the metadata's protocol order. The container's own value witnesses destroy it.
export function initializeExistentialWithCopy(
  metadata: Metadata,
  container: NativePointer,
  type: Metadata,
  src: NativePointer,
  witnessTables: NativePointer[]
): void {
  const representation = existentialRepresentation(metadata);
  if (representation === "error") {
    throw new Error("initializeExistentialWithCopy: Error existentials are not supported");
  }
  let tables: NativePointer;
  if (representation === "class") {
    type.valueWitnesses.initializeWithCopy(container, src);
    tables = container.add(Process.pointerSize);
  } else {
    const witnesses = type.valueWitnesses;
    if (witnesses.isInlineStorage) {
      witnesses.initializeWithCopy(container, src);
    } else {
      const [box, storage] = getSwiftCoreApi().swift_allocBox(type.handle);
      witnesses.initializeWithCopy(storage, src);
      container.writePointer(box);
    }
    container.add(TYPE_OFFSET).writePointer(type.handle);
    tables = container.add(TYPE_OFFSET + Process.pointerSize);
  }
  witnessTables.forEach((table, i) => tables.add(i * Process.pointerSize).writePointer(table));
}

// ProtocolClassConstraint ABI value: Class = 0 (class-only), Any = 1.
export function protocolClassConstraint(descriptor: ContextDescriptor): number {
  return (descriptor.flags >>> 16) & 0x1;
}

export function getExistentialTypeMetadata(protocols: ContextDescriptor[]): Metadata {
  // swift_getExistentialTypeMetadata trusts the caller to pre-sort the protocol list by the
  // compiler's canonical order; otherwise the runtime uniques a distinct-but-equivalent instance
  // that won't pointer-match compiler-emitted existentials.
  const sorted = [...protocols].sort(compareProtocolDescriptors);
  const refs = Memory.alloc(Process.pointerSize * Math.max(sorted.length, 1));
  sorted.forEach((p, i) => refs.add(i * Process.pointerSize).writePointer(p.handle));
  const classConstraint =
    sorted.length === 0 ? 1 : Math.min(...sorted.map(protocolClassConstraint));
  const handle = getSwiftCoreApi().swift_getExistentialTypeMetadata(
    classConstraint,
    ptr(0),
    sorted.length,
    refs
  );
  return new Metadata(handle);
}

// TypeDecl::compare: shallower nesting first, then the module (top level) or enclosing type, then the name.
export function compareProtocolDescriptors(a: ContextDescriptor, b: ContextDescriptor): number {
  const aEnclosing = enclosingTypeOf(a);
  const bEnclosing = enclosingTypeOf(b);
  const byDepth = nestingDepth(aEnclosing) - nestingDepth(bEnclosing);
  if (byDepth !== 0) return byDepth;
  const byContext =
    aEnclosing !== null && bEnclosing !== null
      ? compareProtocolDescriptors(aEnclosing, bEnclosing)
      : compareNames(a.moduleName, b.moduleName);
  return byContext !== 0 ? byContext : compareNames(a.name, b.name);
}

function compareNames(a: string | null, b: string | null): number {
  const an = a ?? "";
  const bn = b ?? "";
  return an === bn ? 0 : an < bn ? -1 : 1;
}

function nestingDepth(type: ContextDescriptor | null): number {
  return type === null ? 0 : 1 + nestingDepth(enclosingTypeOf(type));
}

function enclosingTypeOf(descriptor: ContextDescriptor): ContextDescriptor | null {
  for (let ctx = descriptor.parent; ctx !== null; ctx = ctx.parent) {
    if (ctx.kind === ContextDescriptorKind.Extension) return ctx.extendedTypeDescriptor;
    if (ctx.isType) return ctx;
    if (ctx.kind === ContextDescriptorKind.Module) return null;
  }
  return null;
}

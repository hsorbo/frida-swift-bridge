import { ContextDescriptor } from "./context-descriptor.js";
import { MangledName, symbolicMangledNameLength } from "./field-descriptor.js";
import { RelativeDirectPointer, RelativeIndirectablePointer } from "../basic/relative-pointer.js";
import { ProtocolConformance } from "./protocol-conformance.js";

export const GENERIC_REQUIREMENT_DESCRIPTOR_SIZE = 0xc;

const OFFSETOF_PARAM = 0x4;
const OFFSETOF_UNION = 0x8;

const KIND_MASK = 0x1f;
const HAS_KEY_ARGUMENT = 0x80;

// unlike RelativeIndirectablePointer, this pointer format reserves an extra bit for isObjC
const OBJC_PROTOCOL_BIT = 0x2;

export enum GenericRequirementKind {
  Protocol = 0,
  SameType = 1,
  BaseClass = 2,
  SameConformance = 3,
  SameShape = 4,
  InvertedProtocols = 5,
  Layout = 0x1f,
}

export enum GenericRequirementLayoutKind {
  Class = 0,
}

export enum InvertibleProtocolKind {
  Copyable = 0,
  Escapable = 1,
}

export interface InvertedProtocolsRequirement {
  // 0xffff: constrains the subject type rather than a generic parameter.
  genericParamIndex: number;
  protocolBits: number;
}

export interface GenericRequirementDescriptor {
  kind: GenericRequirementKind;
  hasKeyArgument: boolean;
  param: MangledName;
  protocol: ContextDescriptor | null;
  isObjCProtocol: boolean;
  objCProtocol: NativePointer | null;
  sameTypeName: MangledName | null;
  layoutKind: GenericRequirementLayoutKind | null;
  conformance: ProtocolConformance | null;
  invertedProtocols: InvertedProtocolsRequirement | null;
  address: NativePointer;
}

function readMangledName(at: NativePointer): MangledName | null {
  const ptr = RelativeDirectPointer.resolve(at);
  return ptr === null ? null : { address: ptr, length: symbolicMangledNameLength(ptr) };
}

export function resolveProtocolConstraint(
  at: NativePointer
): { protocol: ContextDescriptor | null; isObjC: boolean; objCProtocol: NativePointer | null } {
  const raw = at.readS32();
  const isObjC = (raw & OBJC_PROTOCOL_BIT) !== 0;
  const offset = raw & ~OBJC_PROTOCOL_BIT;
  if (offset === 0) {
    return { protocol: null, isObjC, objCProtocol: null };
  }
  const address = at.add(offset & ~1);
  const resolved = (offset & 1) !== 0 ? address.readPointer().strip() : address;
  return isObjC
    ? { protocol: null, isObjC: true, objCProtocol: resolved }
    : { protocol: new ContextDescriptor(resolved), isObjC: false, objCProtocol: null };
}

export function readGenericRequirementDescriptors(
  base: NativePointer,
  count: number
): GenericRequirementDescriptor[] {
  const entries: GenericRequirementDescriptor[] = [];
  for (let i = 0; i < count; i++) {
    const address = base.add(i * GENERIC_REQUIREMENT_DESCRIPTOR_SIZE);
    const flags = address.readU32();
    const kind: GenericRequirementKind = flags & KIND_MASK;
    const param = readMangledName(address.add(OFFSETOF_PARAM))!;

    let protocol: ContextDescriptor | null = null;
    let isObjCProtocol = false;
    let objCProtocol: NativePointer | null = null;
    let sameTypeName: MangledName | null = null;
    let layoutKind: GenericRequirementLayoutKind | null = null;
    let conformance: ProtocolConformance | null = null;
    let invertedProtocols: InvertedProtocolsRequirement | null = null;
    if (kind === GenericRequirementKind.Protocol) {
      ({ protocol, isObjC: isObjCProtocol, objCProtocol } = resolveProtocolConstraint(address.add(OFFSETOF_UNION)));
    } else if (
      kind === GenericRequirementKind.SameType ||
      kind === GenericRequirementKind.BaseClass ||
      kind === GenericRequirementKind.SameShape
    ) {
      sameTypeName = readMangledName(address.add(OFFSETOF_UNION));
    } else if (kind === GenericRequirementKind.Layout) {
      layoutKind = address.add(OFFSETOF_UNION).readU32();
    } else if (kind === GenericRequirementKind.SameConformance) {
      const p = RelativeIndirectablePointer.resolve(address.add(OFFSETOF_UNION));
      conformance = p === null ? null : new ProtocolConformance(p);
    } else if (kind === GenericRequirementKind.InvertedProtocols) {
      const at = address.add(OFFSETOF_UNION);
      invertedProtocols = { genericParamIndex: at.readU16(), protocolBits: at.add(2).readU16() };
    }

    entries.push({
      kind,
      hasKeyArgument: (flags & HAS_KEY_ARGUMENT) !== 0,
      param,
      protocol,
      isObjCProtocol,
      objCProtocol,
      sameTypeName,
      layoutKind,
      conformance,
      invertedProtocols,
      address,
    });
  }
  return entries;
}

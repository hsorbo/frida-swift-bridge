import { ContextDescriptor, ContextDescriptorKind } from "./context-descriptor.js";
import { Metadata } from "./metadata.js";
import {
  RelativeDirectPointer,
  RelativeIndirectablePointer,
} from "../basic/relative-pointer.js";
import { getSwiftSection } from "../image/sections.js";
import { swiftMatches, NameFilter, nameQuery } from "../runtime/swift-resolver.js";
import { getSwiftCoreApi } from "../runtime/api.js";
import {
  GenericRequirementDescriptor,
  readGenericRequirementDescriptors,
} from "./generic-requirement-descriptor.js";

const RECORD_SIZE = 4;
const PROTOCOL_RECORD_INT_MASK = 0x2;

const OFFSETOF_CONF_PROTOCOL = 0x0;
const OFFSETOF_CONF_TYPE_REF = 0x4;
const OFFSETOF_CONF_FLAGS = 0xc;
const OFFSETOF_CONF_TRAILING_OBJECTS = 0x10;

const CONFORMANCE_FLAG_IS_RETROACTIVE = 0x40;
const CONFORMANCE_NUM_CONDITIONAL_REQUIREMENTS_SHIFT = 8;
const CONFORMANCE_NUM_CONDITIONAL_REQUIREMENTS_MASK = 0xff;

const enum TypeReferenceKind {
  DirectTypeDescriptor = 0,
  IndirectTypeDescriptor = 1,
  DirectObjCClassName = 2,
  IndirectObjCClass = 3,
}

export class ProtocolConformance {
  constructor(readonly handle: NativePointer) {}

  get protocol(): ContextDescriptor | null {
    const p = RelativeIndirectablePointer.resolve(this.handle.add(OFFSETOF_CONF_PROTOCOL));
    return p === null ? null : new ContextDescriptor(p);
  }

  get flags(): number {
    return this.handle.add(OFFSETOF_CONF_FLAGS).readU32();
  }

  // Null for ObjC class references: those name a class, not a Swift nominal descriptor.
  get typeDescriptor(): NativePointer | null {
    const at = this.handle.add(OFFSETOF_CONF_TYPE_REF);
    switch ((this.flags >> 3) & 0x7) {
      case TypeReferenceKind.DirectTypeDescriptor:
        return RelativeDirectPointer.resolve(at);
      case TypeReferenceKind.IndirectTypeDescriptor: {
        const indirect = RelativeDirectPointer.resolve(at);
        return indirect === null ? null : indirect.readPointer().strip();
      }
      default:
        return null;
    }
  }

  get isRetroactive(): boolean {
    return (this.flags & CONFORMANCE_FLAG_IS_RETROACTIVE) !== 0;
  }

  get numConditionalRequirements(): number {
    return (this.flags >> CONFORMANCE_NUM_CONDITIONAL_REQUIREMENTS_SHIFT) &
      CONFORMANCE_NUM_CONDITIONAL_REQUIREMENTS_MASK;
  }

  // swift_conformsToProtocol already checked these before returning a table; this is introspection only.
  get conditionalRequirements(): GenericRequirementDescriptor[] {
    const count = this.numConditionalRequirements;
    if (count === 0) {
      return [];
    }
    const base = this.handle.add(OFFSETOF_CONF_TRAILING_OBJECTS + (this.isRetroactive ? 4 : 0));
    return readGenericRequirementDescriptors(base, count);
  }
}

export function* enumerateProtocolConformances(module: Module): Generator<ProtocolConformance> {
  const section = getSwiftSection(module, "__swift5_proto");
  if (section === null) {
    return;
  }
  const count = section.size / RECORD_SIZE;
  for (let i = 0; i < count; i++) {
    const descriptor = RelativeIndirectablePointer.resolve(section.address.add(i * RECORD_SIZE));
    if (descriptor !== null) {
      yield new ProtocolConformance(descriptor);
    }
  }
}

export function* enumerateProtocols(module: Module): Generator<ContextDescriptor> {
  const section = getSwiftSection(module, "__swift5_protos");
  if (section === null) {
    return;
  }
  const count = section.size / RECORD_SIZE;
  for (let i = 0; i < count; i++) {
    const descriptor = resolveProtocolRecord(section.address.add(i * RECORD_SIZE));
    if (descriptor !== null) {
      yield new ContextDescriptor(descriptor);
    }
  }
}

function resolveProtocolRecord(record: NativePointer): NativePointer | null {
  const offset = record.readS32() & ~PROTOCOL_RECORD_INT_MASK;
  if (offset === 0) {
    return null;
  }
  const address = record.add(offset & ~1);
  return (offset & 1) !== 0 ? address.readPointer().strip() : address;
}

function* protocolsMatching(query: string): Generator<ContextDescriptor> {
  for (const match of swiftMatches(query)) {
    yield new ContextDescriptor(match.address);
  }
}

export function protocolDescriptors(filter?: NameFilter): Generator<ContextDescriptor> {
  return protocolsMatching(nameQuery("protocols", filter));
}

export function* protocolsNamedUnder(moduleName: string): Generator<ContextDescriptor> {
  yield* protocolsMatching(`protocols:*!${moduleName}.*`);
}

// Hits only: a qualified name's descriptor never changes, while a miss can be answered by a module
// loaded later.
const resolvedProtocols = new Map<string, ContextDescriptor>();

export function findProtocol(name: string): ContextDescriptor | null {
  const hit = resolvedProtocols.get(name);
  if (hit !== undefined) {
    return hit;
  }
  if (name.includes(".")) {
    for (const protocol of protocolsMatching(`protocols:*!${name}`)) {
      if (protocol.fullTypeName === name) {
        resolvedProtocols.set(name, protocol);
        return protocol;
      }
    }
    return null;
  }
  // Never cached: a later-loaded image can make a bare name ambiguous.
  let match: ContextDescriptor | null = null;
  const candidateNames = new Set<string>();
  for (const protocol of protocolsMatching(`protocols:*!*.${name}`)) {
    const fullName = protocol.fullTypeName;
    if (fullName === null || protocol.name !== name) {
      continue;
    }
    match = protocol;
    candidateNames.add(fullName);
  }
  if (candidateNames.size > 1) {
    throw new Error(`ambiguous protocol name "${name}": ${[...candidateNames].sort().join(", ")}; qualify it with a module`);
  }
  return match;
}

export function conformsToProtocol(
  type: Metadata,
  protocol: ContextDescriptor
): NativePointer | null {
  const witnessTable = getSwiftCoreApi().swift_conformsToProtocol(type.handle, protocol.handle);
  return witnessTable.isNull() ? null : witnessTable;
}

function* conformancesMatching(query: string): Generator<ProtocolConformance> {
  for (const match of swiftMatches(query)) {
    yield new ProtocolConformance(match.address);
  }
}

function distinct(descriptors: Iterable<ContextDescriptor>): ContextDescriptor[] {
  const seen = new Set<string>();
  const result: ContextDescriptor[] = [];
  for (const descriptor of descriptors) {
    const key = descriptor.handle.toString();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(descriptor);
    }
  }
  return result;
}

export function conformingProtocols(typeDescriptor: NativePointer): ContextDescriptor[] {
  const descriptor = new ContextDescriptor(typeDescriptor);
  const name = descriptor.fullTypeName;
  if (name === null) {
    return [];
  }
  // The resolver spells a type declared in another module's extension as the demangler does,
  // `(extension in M):Outer<A>.Name`, so such a type is matched by its last component instead.
  const query = declaredInExtension(descriptor) ? `conformances:*.${descriptor.name}!*` : `conformances:${name}!*`;
  const protocols: ContextDescriptor[] = [];
  for (const conformance of conformancesMatching(query)) {
    const protocol = conformance.protocol;
    if (protocol !== null && conformance.typeDescriptor?.equals(typeDescriptor)) {
      protocols.push(protocol);
    }
  }
  return distinct(protocols);
}

function declaredInExtension(descriptor: ContextDescriptor): boolean {
  for (let context = descriptor.parent; context !== null; context = context.parent) {
    if (context.kind === ContextDescriptorKind.Extension) {
      return true;
    }
  }
  return false;
}

export function conformingTypes(protocol: ContextDescriptor): ContextDescriptor[] {
  const name = protocol.fullTypeName;
  if (name === null) {
    return [];
  }
  const types: ContextDescriptor[] = [];
  for (const conformance of conformancesMatching(`conformances:*!${name}`)) {
    const type = conformance.typeDescriptor;
    if (type !== null) {
      const descriptor = new ContextDescriptor(type);
      if (descriptor.isType) {
        types.push(descriptor);
      }
    }
  }
  return distinct(types);
}

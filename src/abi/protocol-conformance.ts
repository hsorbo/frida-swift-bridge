import { ContextDescriptor } from "./context-descriptor.js";
import { Metadata } from "./metadata.js";
import {
  RelativeDirectPointer,
  RelativeIndirectablePointer,
} from "../basic/relative-pointer.js";
import { getSwiftSection, SwiftSection } from "../image/sections.js";
import { conformanceScanner, ConformanceScanner } from "./conformance-scan.js";
import { enumerateSwiftModules } from "../reflection/registry.js";
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

const cachedProtocolsByModulePath = new Map<string, ContextDescriptor[]>();

function protocolsOf(module: Module): ContextDescriptor[] {
  let list = cachedProtocolsByModulePath.get(module.path);
  if (list === undefined) {
    list = [...enumerateProtocols(module)];
    cachedProtocolsByModulePath.set(module.path, list);
  }
  return list;
}

export function* protocolDescriptors(module?: Module): Generator<ContextDescriptor> {
  if (module !== undefined) {
    yield* protocolsOf(module);
    return;
  }
  for (const m of enumerateSwiftModules()) {
    yield* protocolsOf(m);
  }
}

const resolvedProtocols = new Map<string, ContextDescriptor>();

export function findProtocol(name: string): ContextDescriptor | null {
  const hit = resolvedProtocols.get(name);
  if (hit !== undefined) {
    return hit;
  }

  const dot = name.lastIndexOf(".");
  const simpleName = dot === -1 ? name : name.slice(dot + 1);
  const moduleName = dot === -1 ? null : name.slice(0, dot);

  for (const module of enumerateSwiftModules()) {
    for (const protocol of protocolsOf(module)) {
      if (protocol.name !== simpleName) {
        continue;
      }
      if (moduleName !== null && protocol.moduleName !== moduleName) {
        continue;
      }
      resolvedProtocols.set(name, protocol);
      return protocol;
    }
  }

  return null;
}

export function conformsToProtocol(
  type: Metadata,
  protocol: ContextDescriptor
): NativePointer | null {
  const witnessTable = getSwiftCoreApi().swift_conformsToProtocol(type.handle, protocol.handle);
  return witnessTable.isNull() ? null : witnessTable;
}

interface ConformanceIndex {
  protocolsByType: Map<string, ContextDescriptor[]>;
  typesByProtocol: Map<string, ContextDescriptor[]>;
}

const conformanceIndexes = new Map<string, ConformanceIndex>();

// Keyed on the module, not on the answer: "T conforms to nothing" stops being true as soon as a
// module declaring a retroactive conformance is loaded.
function conformanceIndexOf(module: Module): ConformanceIndex {
  const key = `${module.path}@${module.base}`;
  let index = conformanceIndexes.get(key);
  if (index === undefined) {
    index = { protocolsByType: new Map(), typesByProtocol: new Map() };
    for (const conformance of enumerateProtocolConformances(module)) {
      const type = conformance.typeDescriptor;
      const protocol = conformance.protocol;
      if (type === null || protocol === null) {
        continue;
      }
      appendTo(index.protocolsByType, type.toString(), protocol);
      appendTo(index.typesByProtocol, protocol.handle.toString(), new ContextDescriptor(type));
    }
    conformanceIndexes.set(key, index);
  }
  return index;
}

function appendTo(map: Map<string, ContextDescriptor[]>, key: string, value: ContextDescriptor): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
}

function collectAcrossModules(
  scan: (scanner: ConformanceScanner, section: SwiftSection) => NativePointer[],
  select: (index: ConformanceIndex) => ContextDescriptor[] | undefined
): ContextDescriptor[] {
  const result: ContextDescriptor[] = [];
  const seen = new Set<string>();
  const add = (descriptor: ContextDescriptor): void => {
    const handle = descriptor.handle.toString();
    if (!seen.has(handle)) {
      seen.add(handle);
      result.push(descriptor);
    }
  };
  const scanner = conformanceScanner();
  for (const module of enumerateSwiftModules()) {
    if (scanner === null) {
      (select(conformanceIndexOf(module)) ?? []).forEach(add);
      continue;
    }
    const section = getSwiftSection(module, "__swift5_proto");
    if (section !== null) {
      scan(scanner, section).forEach((handle) => add(new ContextDescriptor(handle)));
    }
  }
  return result;
}

export function conformingProtocols(typeDescriptor: NativePointer): ContextDescriptor[] {
  const key = typeDescriptor.toString();
  return collectAcrossModules(
    (scanner, section) => scanner.protocolsOf(section, typeDescriptor),
    (index) => index.protocolsByType.get(key)
  );
}

export function conformingTypes(protocol: ContextDescriptor): ContextDescriptor[] {
  const key = protocol.handle.toString();
  return collectAcrossModules(
    (scanner, section) => scanner.typesOf(section, protocol.handle),
    (index) => index.typesByProtocol.get(key)
  );
}

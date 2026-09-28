import { getSwiftCoreApi } from "../runtime/api.js";
import { Metadata } from "./metadata.js";
import { ProtocolConformance, conformsToProtocol } from "./protocol-conformance.js";
import {
  ProtocolRequirement,
  ProtocolRequirementKind,
  readAssociatedTypeNames,
  readProtocolRequirements,
  readRequirementSignature,
  requirementBaseDescriptor,
} from "./protocol-descriptor.js";
import { GenericRequirementDescriptor, GenericRequirementKind } from "./generic-requirement-descriptor.js";
import { WitnessTable } from "./witness-table.js";
import { ContextDescriptor } from "./context-descriptor.js";

function protocolOf(table: WitnessTable): ContextDescriptor {
  const protocol = new ProtocolConformance(table.conformanceDescriptor).protocol;
  if (protocol === null) {
    throw new Error("witness table's conformance descriptor has no protocol");
  }
  return protocol;
}

// MetadataRequest(state: Complete, isNonBlocking: false)
const REQUEST_BLOCKING_COMPLETE = 0;

export function resolveAssociatedType(table: WitnessTable, name: string): Metadata {
  const resolved = findAssociatedType(table, name);
  if (resolved === null) {
    throw new Error(`no associated type ${name} on ${protocolOf(table).fullTypeName ?? "protocol"}`);
  }
  return resolved;
}

function findAssociatedType(table: WitnessTable, name: string): Metadata | null {
  const protocol = protocolOf(table);
  const index = readAssociatedTypeNames(protocol).indexOf(name);
  if (index === -1) {
    for (const base of baseProtocols(protocol)) {
      const baseTable = conformsToProtocol(table.conformingType, base);
      const resolved = baseTable === null ? null : findAssociatedType(new WitnessTable(baseTable, table.conformingType), name);
      if (resolved !== null) {
        return resolved;
      }
    }
    return null;
  }
  const requirement = readProtocolRequirements(protocol).filter(
    (r) => r.kind === ProtocolRequirementKind.AssociatedTypeAccessFunction
  )[index];
  const [value] = getSwiftCoreApi().swift_getAssociatedTypeWitness(
    REQUEST_BLOCKING_COMPLETE,
    table.handle,
    table.conformingType.handle,
    requirementBaseDescriptor(requirement),
    requirement.address
  );
  if (value.isNull()) {
    throw new Error(`failed to resolve associated type ${name}`);
  }
  return new Metadata(value);
}

function baseProtocols(protocol: ContextDescriptor): ContextDescriptor[] {
  return readRequirementSignature(protocol)
    .filter((r) => r.kind === GenericRequirementKind.Protocol && !r.isObjCProtocol && constrainsSelf(r))
    .map((r) => r.protocol)
    .filter((p): p is ContextDescriptor => p !== null);
}

function constrainsSelf(requirement: GenericRequirementDescriptor): boolean {
  const { address, length } = requirement.param;
  return length === 1 && address.readU8() === "x".charCodeAt(0);
}

export function resolveAssociatedConformance(
  table: WitnessTable,
  associatedType: Metadata,
  requirement: ProtocolRequirement
): WitnessTable {
  if (requirement.kind !== ProtocolRequirementKind.AssociatedConformanceAccessFunction) {
    throw new Error("requirement is not an associated-conformance accessor");
  }
  const raw = getSwiftCoreApi().swift_getAssociatedConformanceWitness(
    table.handle,
    table.conformingType.handle,
    associatedType.handle,
    requirementBaseDescriptor(requirement),
    requirement.address
  );
  if (raw.isNull()) {
    throw new Error("failed to resolve associated conformance");
  }
  return new WitnessTable(raw, associatedType);
}

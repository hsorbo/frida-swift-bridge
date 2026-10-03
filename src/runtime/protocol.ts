import { ContextDescriptor } from "../abi/context-descriptor.js";
import { Metadata } from "../abi/metadata.js";
import {
  findProtocol,
  conformsToProtocol,
  conformingProtocols,
  conformingTypes,
  protocolDescriptors,
} from "../abi/protocol-conformance.js";
import type { NameFilter } from "./swift-resolver.js";
import {
  getExistentialTypeMetadata,
  protocolClassConstraint,
} from "../abi/existential.js";
import {
  ProtocolRequirement,
  numProtocolRequirements,
  readProtocolRequirements,
  readRequirementSignature,
} from "../abi/protocol-descriptor.js";
import { NamedRequirement, namedProtocolRequirements } from "./method.js";
import { GenericRequirementDescriptor } from "../abi/generic-requirement-descriptor.js";
import { WitnessTable } from "../abi/witness-table.js";
import { NominalType, typeFromDescriptor } from "./swift-type.js";

// The stable root's view of a protocol: identity plus conformer enumeration. Raw requirement,
// witness-table, and descriptor inspection stay on the full class, reachable only through /abi.
export interface StableProtocol {
  readonly name: string;
  readonly moduleName: string | null;
  readonly fullName: string;
  readonly isClassOnly: boolean;
  conformingTypes(): NominalType[];
  toJSON(): { kind: "protocol"; name: string; isClassOnly: boolean; numRequirements: number };
}

export interface StableProtocolComposition {
  readonly protocols: StableProtocol[];
  readonly numProtocols: number;
  readonly isClassOnly: boolean;
}

export class Protocol implements StableProtocol {
  constructor(readonly descriptor: ContextDescriptor) {}

  static find(name: string): Protocol | null {
    const descriptor = findProtocol(name);
    return descriptor === null ? null : new Protocol(descriptor);
  }

  get name(): string {
    const name = this.descriptor.name;
    if (name === null) {
      throw new Error("protocol descriptor has no name");
    }
    return name;
  }

  get moduleName(): string | null {
    return this.descriptor.moduleName;
  }

  get fullName(): string {
    const name = this.descriptor.fullTypeName;
    if (name === null) {
      throw new Error("protocol descriptor has no name");
    }
    return name;
  }

  get numRequirements(): number {
    return numProtocolRequirements(this.descriptor);
  }

  get requirements(): ProtocolRequirement[] {
    return readProtocolRequirements(this.descriptor);
  }

  namedRequirements(): NamedRequirement[] {
    return namedProtocolRequirements(this.descriptor);
  }

  get requirementSignature(): GenericRequirementDescriptor[] {
    return readRequirementSignature(this.descriptor);
  }

  get isClassOnly(): boolean {
    return protocolClassConstraint(this.descriptor) === 0;
  }

  toJSON(): { kind: "protocol"; name: string; isClassOnly: boolean; numRequirements: number } {
    return {
      kind: "protocol",
      name: this.name,
      isClassOnly: this.isClassOnly,
      numRequirements: this.numRequirements,
    };
  }

  conformanceFor(type: Metadata): WitnessTable | null {
    const table = conformsToProtocol(type, this.descriptor);
    return table === null ? null : new WitnessTable(table, type);
  }

  conformingTypes(): NominalType[] {
    return conformingTypes(this.descriptor).map((d) => typeFromDescriptor(d));
  }
}

export function swiftProtocols(filter?: NameFilter): Generator<Protocol> {
  return protocolsOf(protocolDescriptors(filter));
}

function* protocolsOf(descriptors: Generator<ContextDescriptor>): Generator<Protocol> {
  for (const descriptor of descriptors) {
    if (descriptor.fullTypeName !== null) {
      yield new Protocol(descriptor);
    }
  }
}

export function protocolsForType(typeDescriptor: NativePointer): { [name: string]: Protocol } {
  const map: { [name: string]: Protocol } = {};
  for (const descriptor of conformingProtocols(typeDescriptor)) {
    const name = descriptor.fullTypeName;
    if (name !== null) {
      map[name] = new Protocol(descriptor);
    }
  }
  return map;
}

export class ProtocolComposition implements StableProtocolComposition {
  readonly protocols: Protocol[];
  private cachedMetadata: Metadata | null = null;

  constructor(...protocols: Protocol[]) {
    this.protocols = protocols;
  }

  static fromSignature(signature: string): ProtocolComposition {
    const names = signature
      .split("&")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const protocols = names.map((name) => {
      const protocol = Protocol.find(name);
      if (protocol === null) {
        throw new Error(`unknown protocol: ${name}`);
      }
      return protocol;
    });
    return new ProtocolComposition(...protocols);
  }

  get numProtocols(): number {
    return this.protocols.length;
  }

  get isClassOnly(): boolean {
    return this.protocols.some((p) => p.isClassOnly);
  }

  // The existential metadata for `any P1 & P2 & …`; its value witnesses carry the real
  // container layout, so no hand-rolled sizeofExistentialContainer math is needed.
  get metadata(): Metadata {
    if (this.cachedMetadata === null) {
      this.cachedMetadata = getExistentialTypeMetadata(
        this.protocols.map((p) => p.descriptor)
      );
    }
    return this.cachedMetadata;
  }
}

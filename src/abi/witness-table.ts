import {
  BoundMethod,
  CallArg,
  CallResult,
  WitnessOrigin,
  bindWitnessMethod,
  classifyWitnessOrigin,
  witnessGetProperty,
  witnessSetProperty,
} from "../runtime/method.js";
import { Metadata } from "./metadata.js";
import { ProtocolRequirement } from "./protocol-descriptor.js";
import { resolveAssociatedConformance, resolveAssociatedType } from "./associated-type.js";
import { ConditionalRequirement, resolveConditionalRequirements } from "./conditional-conformance.js";

export class WitnessTable {
  constructor(readonly handle: NativePointer, readonly conformingType: Metadata) {}

  get conformanceDescriptor(): NativePointer {
    return this.handle.readPointer().strip();
  }

  requirement(witnessIndex: number): NativePointer {
    return this.handle.add(witnessIndex * Process.pointerSize).readPointer().strip();
  }

  method(self: NativePointer, name: string): BoundMethod {
    return bindWitnessMethod(this, self, name);
  }

  get(self: NativePointer, name: string): CallResult {
    return witnessGetProperty(this, self, name);
  }

  set(self: NativePointer, name: string, value: CallArg): void {
    witnessSetProperty(this, self, name, value);
  }

  associatedType(name: string): Metadata {
    return resolveAssociatedType(this, name);
  }

  associatedConformance(associatedType: Metadata, requirement: ProtocolRequirement): WitnessTable {
    return resolveAssociatedConformance(this, associatedType, requirement);
  }

  get conditionalRequirements(): ConditionalRequirement[] {
    return resolveConditionalRequirements(this);
  }

  originOf(requirement: ProtocolRequirement): WitnessOrigin {
    return classifyWitnessOrigin(this, requirement);
  }
}

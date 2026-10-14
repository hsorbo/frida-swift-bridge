import { ClassInstance } from "../abi/heap-object.js";
import { ValueInstance } from "../abi/value.js";
import { Metadata, MetadataKind } from "../abi/metadata.js";
import { ContextDescriptor } from "../abi/context-descriptor.js";
import { findProtocol, conformsToProtocol } from "../abi/protocol-conformance.js";
import { ProtocolRequirementKind, readProtocolRequirements } from "../abi/protocol-descriptor.js";
import { WitnessTable } from "../abi/witness-table.js";
import { CallResult, ResolvedMethod, bindResolved, resolveWitnessRequirement, decodeReturn, copyOfValue } from "./method.js";
import { RAW } from "./object-facade.js";
import { SwiftFunctionSignature, parseSwiftSignature } from "./type-expr.js";

// A facade's Symbol.iterator: the Swift iterator driven through the Sequence and IteratorProtocol
// witness tables, so it reaches every conformer, not only the containers $container() can decode.
// undefined when the type is no Sequence, so JavaScript's own "is not iterable" applies.
export function sequenceIterator(instance: ClassInstance | ValueInstance): (() => Iterator<CallResult>) | undefined {
  const protocol = findProtocol("Swift.Sequence");
  if (protocol === null) {
    return undefined;
  }
  const metadata = instance instanceof ValueInstance ? instance.metadata : instance.dynamicType;
  const table = conformsToProtocol(metadata, protocol);
  if (table === null) {
    return undefined;
  }
  const sequence = new WitnessTable(table, metadata);
  return () => iterate(protocol, sequence, witnessSelf(metadata, instance.handle));
}

// Self is @in_guaranteed through a witness thunk, so a class reference is passed in a cell.
function witnessSelf(metadata: Metadata, handle: NativePointer): NativePointer {
  if (metadata.kind !== MetadataKind.Class) {
    return handle;
  }
  const cell = Memory.alloc(Process.pointerSize);
  cell.writePointer(handle);
  return cell;
}

function* iterate(protocol: ContextDescriptor, sequence: WitnessTable, self: NativePointer): Generator<CallResult> {
  // makeIterator() is __consuming: the thunk takes self at +1, so it gets a copy and the facade keeps its own.
  const makeIterator = bindResolved(firstMethodWitness(sequence, protocol, "Swift.Sequence.makeIterator() -> A.Iterator"), self, {
    adoptResult: true,
    consumedSelf: sequence.conformingType,
  });
  const iterator = rawValue(makeIterator.call() as CallResult);
  try {
    const iteratorProtocol = findProtocol("Swift.IteratorProtocol")!;
    const table = new WitnessTable(conformsToProtocol(iterator.metadata, iteratorProtocol)!, iterator.metadata);
    // next() returns Element?; when Element is itself optional the decoder would fold .some(nil)
    // into the end of the sequence, so the element is adopted whole and decoded from a copy.
    const optionalElement = sequence.associatedType("Element").kind === MetadataKind.Optional;
    const next = bindResolved(firstMethodWitness(table, iteratorProtocol, "Swift.IteratorProtocol.next() -> A.Element?"), iterator.handle, {
      adoptResult: optionalElement,
    });
    for (;;) {
      const result = next.call() as CallResult;
      if (result === null) {
        return;
      }
      yield optionalElement ? decodeOptionalElement(rawValue(result)) : result;
    }
  } finally {
    iterator.dispose();
  }
}

// Witness thunks have no symbol on PE, so the witness is taken by position: a protocol's requirement
// order is ABI, and makeIterator and next are the first method requirements of their protocols.
function firstMethodWitness(table: WitnessTable, protocol: ContextDescriptor, spelling: string): ResolvedMethod {
  const requirement = readProtocolRequirements(protocol).find((r) => r.kind === ProtocolRequirementKind.Method)!;
  return resolveWitnessRequirement(table, requirement, parseSwiftSignature(spelling) as SwiftFunctionSignature);
}

function decodeOptionalElement(element: ValueInstance): CallResult {
  const decoded = decodeReturn(element.metadata, copyOfValue(element.metadata, element.handle));
  element.dispose();
  return decoded;
}

function rawValue(facade: CallResult): ValueInstance {
  return (facade as unknown as { [RAW]: ValueInstance })[RAW];
}

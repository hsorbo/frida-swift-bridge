import { ClassInstance } from "../abi/heap-object.js";
import { ValueInstance } from "../abi/value.js";
import { Metadata, MetadataKind } from "../abi/metadata.js";
import { findProtocol, conformsToProtocol } from "../abi/protocol-conformance.js";
import { WitnessTable } from "../abi/witness-table.js";
import { CallResult, bindResolved, resolveWitnessMethod, decodeReturn, copyOfValue } from "./method.js";
import { RAW } from "./object-facade.js";

// A facade's Symbol.iterator: the Swift iterator driven through the Sequence and IteratorProtocol
// witness tables, so it reaches every conformer, not only the containers $container() can decode.
// undefined when the type is no Sequence, so JavaScript's own "is not iterable" applies.
export function sequenceIterator(instance: ClassInstance | ValueInstance): (() => Iterator<CallResult>) | undefined {
  const protocol = findProtocol("Swift.Sequence");
  const metadata = instance instanceof ValueInstance ? instance.metadata : instance.dynamicType;
  const table = protocol === null ? null : conformsToProtocol(metadata, protocol);
  if (table === null) {
    return undefined;
  }
  const sequence = new WitnessTable(table, metadata);
  return () => iterate(sequence, witnessSelf(metadata, instance.handle));
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

function* iterate(sequence: WitnessTable, self: NativePointer): Generator<CallResult> {
  // makeIterator() is __consuming: the thunk takes self at +1, so it gets a copy and the facade keeps its own.
  const makeIterator = bindResolved(resolveWitnessMethod(sequence, "makeIterator"), self, { adoptResult: true, consumedSelf: sequence.conformingType });
  const iterator = rawValue(makeIterator.call() as CallResult);
  try {
    const table = new WitnessTable(conformsToProtocol(iterator.metadata, findProtocol("Swift.IteratorProtocol")!)!, iterator.metadata);
    // next() returns Element?; when Element is itself optional the decoder would fold .some(nil)
    // into the end of the sequence, so the element is adopted whole and decoded from a copy.
    const optionalElement = sequence.associatedType("Element").kind === MetadataKind.Optional;
    const next = bindResolved(resolveWitnessMethod(table, "next"), iterator.handle, { adoptResult: optionalElement });
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

function decodeOptionalElement(element: ValueInstance): CallResult {
  const decoded = decodeReturn(element.metadata, copyOfValue(element.metadata, element.handle));
  element.dispose();
  return decoded;
}

function rawValue(facade: CallResult): ValueInstance {
  return (facade as unknown as { [RAW]: ValueInstance })[RAW];
}

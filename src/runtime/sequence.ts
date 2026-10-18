import { ClassInstance } from "../abi/heap-object.js";
import { ValueInstance } from "../abi/value.js";
import { Metadata, MetadataKind } from "../abi/metadata.js";
import { findProtocol, conformsToProtocol } from "../abi/protocol-conformance.js";
import { WitnessTable } from "../abi/witness-table.js";
import { CallResult, bindRequirementAt, decodeReturn, copyOfValue } from "./method.js";
import { RAW } from "./object-facade.js";

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
  return () => iterate(sequence, witnessSelf(metadata, instance.handle));
}

// A facade's integer key: Swift traps on an index outside startIndex..<endIndex and takes the
// process with it, so the key reads an element only when the type is a Collection indexed by Int
// and the index lies within those bounds, both read through the Collection witness table.
export function isCollectionIndex(instance: ClassInstance | ValueInstance, index: number): boolean {
  const protocol = findProtocol("Swift.Collection");
  if (protocol === null) {
    return false;
  }
  const metadata = instance instanceof ValueInstance ? instance.metadata : instance.dynamicType;
  const table = conformsToProtocol(metadata, protocol);
  if (table === null) {
    return false;
  }
  const collection = new WitnessTable(table, metadata);
  const indexType = collection.associatedType("Index");
  if (indexType.kind !== MetadataKind.Struct || indexType.description.fullTypeName !== "Swift.Int") {
    return false;
  }
  const self = witnessSelf(metadata, instance.handle);
  const startIndex = bindRequirementAt(collection, 0, "Swift.Collection.startIndex.getter : A.Index", self);
  const endIndex = bindRequirementAt(collection, 1, "Swift.Collection.endIndex.getter : A.Index", self);
  return Number(startIndex.call()) <= index && index < Number(endIndex.call());
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
  const makeIterator = bindRequirementAt(sequence, 0, "Swift.Sequence.makeIterator() -> A.Iterator", self, {
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
    const next = bindRequirementAt(table, 0, "Swift.IteratorProtocol.next() -> A.Element?", iterator.handle, {
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

function decodeOptionalElement(element: ValueInstance): CallResult {
  const decoded = decodeReturn(element.metadata, copyOfValue(element.metadata, element.handle));
  element.dispose();
  return decoded;
}

function rawValue(facade: CallResult): ValueInstance {
  return (facade as unknown as { [RAW]: ValueInstance })[RAW];
}

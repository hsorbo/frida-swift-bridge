import { Metadata } from "./metadata.js";
import { getSwiftCoreApi } from "../runtime/api.js";

const METADATA_REQUEST_COMPLETE = 0;
const TUPLE_NUM_ELEMENTS_MASK = 0xffff;

const OFFSETOF_NUM_ELEMENTS = Process.pointerSize;
const OFFSETOF_LABELS = 2 * Process.pointerSize;
const OFFSETOF_ELEMENTS = 3 * Process.pointerSize;

const OFFSETOF_ELEMENT_TYPE = 0x0;
const OFFSETOF_ELEMENT_OFFSET = Process.pointerSize;
// Offset is StoredSize on Apple, uint32_t elsewhere; alignment pads Element to 2 words either way.
const ELEMENT_SIZE = 2 * Process.pointerSize;

export interface TupleElement {
  type: Metadata;
  offset: number;
}

export function tupleNumElements(metadata: Metadata): number {
  return metadata.handle.readU32(OFFSETOF_NUM_ELEMENTS);
}

export function tupleLabels(metadata: Metadata): string | null {
  const ptr = metadata.handle.readPointer(OFFSETOF_LABELS);
  return ptr.isNull() ? null : ptr.readUtf8String();
}

export function* enumerateTupleElements(metadata: Metadata): Generator<TupleElement> {
  const numElements = tupleNumElements(metadata);
  const elements = metadata.handle.add(OFFSETOF_ELEMENTS);
  for (let i = 0; i < numElements; i++) {
    const element = elements.add(i * ELEMENT_SIZE);
    yield {
      type: new Metadata(element.readPointer(OFFSETOF_ELEMENT_TYPE)),
      offset: element.readU32(OFFSETOF_ELEMENT_OFFSET),
    };
  }
}

export function getUnlabelledTupleTypeMetadata(elements: Metadata[]): Metadata {
  if (elements.length > TUPLE_NUM_ELEMENTS_MASK) {
    throw new Error(`tuple has too many elements: ${elements.length}`);
  }
  const buffer = Memory.alloc(Math.max(elements.length, 1) * Process.pointerSize);
  elements.forEach((m, i) => buffer.writePointer(m.handle, i * Process.pointerSize));
  const metadata = getSwiftCoreApi().swift_getTupleTypeMetadata(
    METADATA_REQUEST_COMPLETE,
    elements.length,
    buffer,
    NULL,
    NULL
  );
  return new Metadata(metadata);
}

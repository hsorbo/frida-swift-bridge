import { Metadata } from "./metadata.js";

const OFFSETOF_COUNT = Process.pointerSize;
const OFFSETOF_ELEMENT = 2 * Process.pointerSize;

export interface FixedArrayElement {
  type: Metadata;
  offset: number;
}

// A negative count is laid out empty, like the runtime's getRealizedCount.
export function fixedArrayCount(metadata: Metadata): number {
  return Math.max(0, metadata.handle.add(OFFSETOF_COUNT).readS64().toNumber());
}

export function fixedArrayElementType(metadata: Metadata): Metadata {
  return new Metadata(metadata.handle.add(OFFSETOF_ELEMENT).readPointer());
}

export function* enumerateFixedArrayElements(metadata: Metadata): Generator<FixedArrayElement> {
  const type = fixedArrayElementType(metadata);
  const stride = type.typeLayout.stride;
  const count = fixedArrayCount(metadata);
  for (let i = 0; i < count; i++) {
    yield { type, offset: i * stride };
  }
}

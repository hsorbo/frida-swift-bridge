import { Metadata } from "./metadata.js";

const OFFSETOF_REFERENT = Process.pointerSize;
const MAX_INLINE_BORROW_WORDS = 4;

export function borrowReferentType(metadata: Metadata): Metadata {
  return new Metadata(metadata.handle.add(OFFSETOF_REFERENT).readPointer());
}

// Mirrors swift_getBorrowRepresentation: a referent of at most four words that is bitwise
// borrowable and not addressable for dependencies is copied into the borrow, any other is pointed to.
export function borrowedValueAddress(metadata: Metadata, borrow: NativePointer): NativePointer {
  const referent = borrowReferentType(metadata).valueWitnesses;
  const inline =
    referent.size <= MAX_INLINE_BORROW_WORDS * Process.pointerSize &&
    referent.isBitwiseBorrowable &&
    !referent.isAddressableForDependencies;
  return inline ? borrow : borrow.readPointer();
}

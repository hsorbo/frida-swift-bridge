import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift, loadSwiftCore } from "./swift.js";

import { BorrowType } from "../src/index.js";
import { Metadata, MetadataKind, metadataFor, readValue, typeOf, getUnlabelledTupleTypeMetadata } from "../src/abi.js";
import { borrowReferentType, borrowedValueAddress } from "../src/abi/borrow.js";

const METADATA_REQUEST_COMPLETE = 0;

// Builtin.Borrow<referent> from the runtime, and a borrow of a value laid out by the runtime's own
// representation rule; both entry points arrived with Swift 6.4.
function borrowMetadata(referent: Metadata): Metadata | null {
  const entry = loadSwiftCore().findExportByName("swift_getBorrowTypeMetadata");
  if (entry === null) {
    return null;
  }
  const getMetadata = new NativeFunction(entry, "pointer", ["size_t", "pointer"]);
  return new Metadata(getMetadata(METADATA_REQUEST_COMPLETE, referent.handle));
}

function borrowOf(referent: Metadata, value: NativePointer): NativePointer {
  const borrow = Memory.alloc(Process.pointerSize);
  const initBorrow = new NativeFunction(loadSwiftCore().getExportByName("swift_initBorrow"), "void", ["pointer", "pointer", "pointer"]);
  initBorrow(referent.handle, borrow, value);
  return borrow;
}

function fiveInts(): Metadata {
  const int = metadataFor("Swift.Int")!;
  return getUnlabelledTupleTypeMetadata([int, int, int, int, int]);
}

describe("borrow metadata", () => {
  test("reads the referent and locates the value inline or behind a pointer by the referent's layout", () => {
    requireSwift();
    const int = metadataFor("Swift.Int")!;
    const handle = Memory.alloc(2 * Process.pointerSize);
    handle.writeU32(MetadataKind.Borrow);
    handle.add(Process.pointerSize).writePointer(int.handle);
    const metadata = new Metadata(handle);
    expect(borrowReferentType(metadata).handle.equals(int.handle)).toBeTruthy();
    const borrow = Memory.alloc(Process.pointerSize);
    expect(borrowedValueAddress(metadata, borrow).equals(borrow)).toBeTruthy();

    handle.add(Process.pointerSize).writePointer(fiveInts().handle);
    const value = Memory.alloc(5 * 8);
    borrow.writePointer(value);
    expect(borrowedValueAddress(metadata, borrow).equals(value)).toBeTruthy();
  });

  test("wraps runtime metadata as a BorrowType spelled like the demangler", (ctx) => {
    requireSwift();
    const metadata = borrowMetadata(metadataFor("Swift.Int")!);
    if (metadata === null) ctx.skip("runtime without Builtin.Borrow (Swift < 6.4)");
    expect(metadata!.kind).toBe(MetadataKind.Borrow);
    const type = typeOf(metadata!);
    expect(type instanceof BorrowType).toBeTruthy();
    expect(type.kind).toBe("borrow");
    expect(type.name).toBe("Builtin.Borrow<Swift.Int>");
    expect((type as BorrowType).referentType.name).toBe("Swift.Int");
    expect(typeOf(metadata!)).toBe(type);
  });

  test("reads the referent's value through an inline and a pointer borrow", (ctx) => {
    requireSwift();
    const int = metadataFor("Swift.Int")!;
    const inline = borrowMetadata(int);
    if (inline === null) ctx.skip("runtime without Builtin.Borrow (Swift < 6.4)");
    expect(inline!.typeLayout.size).toBe(8);
    expect(readValue(inline!, borrowOf(int, Memory.alloc(8).writeS64(42)))).toEqual(int64(42));

    const tuple = fiveInts();
    const pointer = borrowMetadata(tuple)!;
    expect(pointer.typeLayout.size).toBe(Process.pointerSize);
    const value = Memory.alloc(5 * 8);
    [1, 2, 3, 4, 5].forEach((n, i) => value.add(i * 8).writeS64(n));
    expect(readValue(pointer, borrowOf(tuple, value))).toEqual([int64(1), int64(2), int64(3), int64(4), int64(5)]);
  });
});

import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";
import { loadSwiftCore } from "./swift.js";

import { Swift, FixedArrayType, StructType } from "../src/index.js";
import { Metadata, MetadataKind, metadataFor, readValue, writeValue, typeOf } from "../src/abi.js";
import { fixedArrayCount, fixedArrayElementType, enumerateFixedArrayElements } from "../src/abi/fixed-array.js";

const METADATA_REQUEST_COMPLETE = 0;

// Builtin.FixedArray<count, element> from the runtime; the entry point arrived with Swift 6.2.
function fixedArrayMetadata(count: number, element: Metadata): Metadata | null {
  const entry = loadSwiftCore().findExportByName("swift_getFixedArrayTypeMetadata");
  if (entry === null) {
    return null;
  }
  const getMetadata = new NativeFunction(entry, "pointer", ["size_t", "int64", "pointer"]);
  return new Metadata(getMetadata(METADATA_REQUEST_COMPLETE, count, element.handle));
}

function syntheticFixedArray(count: number, element: Metadata): Metadata {
  const handle = Memory.alloc(3 * Process.pointerSize);
  handle.writeU32(MetadataKind.FixedArray);
  handle.add(Process.pointerSize).writeS64(count);
  handle.add(2 * Process.pointerSize).writePointer(element.handle);
  return new Metadata(handle);
}

describe("fixed array metadata", () => {
  beforeEach(() => { loadFixture(); });

  test("reads the count, the element type and one offset per element stride", () => {
    const int = metadataFor("Swift.Int")!;
    const metadata = syntheticFixedArray(3, int);
    expect(fixedArrayCount(metadata)).toBe(3);
    expect(fixedArrayElementType(metadata).handle.equals(int.handle)).toBeTruthy();
    expect([...enumerateFixedArrayElements(metadata)].map((e) => e.offset)).toEqual([0, 8, 16]);
    expect(fixedArrayCount(syntheticFixedArray(-1, int))).toBe(0);
  });

  test("wraps runtime metadata as a FixedArrayType spelled like the demangler", (ctx) => {
    const metadata = fixedArrayMetadata(3, metadataFor("Swift.Int")!);
    if (metadata === null) ctx.skip("runtime without Builtin.FixedArray (Swift < 6.2)");
    expect(metadata!.kind).toBe(MetadataKind.FixedArray);
    const type = typeOf(metadata!);
    expect(type instanceof FixedArrayType).toBeTruthy();
    expect(type.kind).toBe("fixed-array");
    expect(type.name).toBe("Builtin.FixedArray<3, Swift.Int>");
    expect((type as FixedArrayType).count).toBe(3);
    expect((type as FixedArrayType).elementType.name).toBe("Swift.Int");
    expect(type.toJSON()).toEqual({ kind: "fixed-array", name: "Builtin.FixedArray<3, Swift.Int>", module: null });
    expect(typeOf(metadata!)).toBe(type);
  });

  test("reads and writes the elements as an array", (ctx) => {
    const found = fixedArrayMetadata(3, metadataFor("Swift.Int")!);
    if (found === null) ctx.skip("runtime without Builtin.FixedArray (Swift < 6.2)");
    const metadata = found!;
    expect(metadata.typeLayout.size).toBe(24);
    const storage = Memory.alloc(metadata.typeLayout.stride);
    writeValue(metadata, storage, [1, 2, 3]);
    expect(storage.add(8).readS64().toNumber()).toBe(2);
    expect(readValue(metadata, storage)).toEqual([int64(1), int64(2), int64(3)]);
    expect(() => writeValue(metadata, storage, [1, 2])).toThrow(/3 elements/);
    expect(() => writeValue(metadata, storage, 7)).toThrow(/3 elements/);
  });

  test("surfaces an InlineArray field's storage and passes it through a call", (ctx) => {
    const found = Swift.struct("fixture.Voxel");
    if (found === null || fixedArrayMetadata(1, metadataFor("Swift.Int")!) === null) {
      ctx.skip("fixture or runtime without InlineArray (Swift < 6.2)");
    }
    const Voxel = found!;
    const cells = Voxel.$type.fields[0];
    expect(cells.name).toBe("cells");
    expect(cells.type!.name).toBe("Swift.InlineArray<3, Swift.Int>");
    const storage = (cells.type as StructType).fields[0];
    expect(storage.name).toBe("_storage");
    expect(storage.type instanceof FixedArrayType).toBeTruthy();
    expect((storage.type as FixedArrayType).count).toBe(3);

    const makeVoxel = Swift.NativeFunction(fixtureExport("fixture.makeVoxel("), Voxel, []);
    expect(makeVoxel()).toEqual({ cells: { _storage: [int64(1), int64(2), int64(3)] } });
    const scaleVoxel = Swift.NativeFunction(fixtureExport("fixture.scaleVoxel("), Voxel, [Voxel, Swift.type("Swift.Int")!]);
    const voxel = Voxel.$new({ cells: { _storage: [1, 2, 3] } });
    expect(scaleVoxel(voxel, 10)).toEqual({ cells: { _storage: [int64(10), int64(20), int64(30)] } });
  });
});

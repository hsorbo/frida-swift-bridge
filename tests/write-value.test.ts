import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { readValue, writeValue, projectBox, metadataFor } from "../src/abi.js";
import { getSwiftCoreApi } from "../src/runtime/api.js";

import { Swift } from "../src/index.js";
function roundTrip(metadata: ReturnType<typeof metadataFor>) {
  const storage = Memory.alloc(metadata!.typeLayout.stride);
  return {
    storage,
    write: (v: Parameters<typeof writeValue>[2]) => {
      writeValue(metadata!, storage, v);
      return readValue(metadata!, storage);
    },
  };
}

describe("writeValue", () => {
  beforeEach(() => { loadFixture(); });

  test("materializes integer primitives", () => {
    expect(roundTrip(metadataFor("Swift.Int")).write(-42)).toEqual(int64(-42));
    expect(roundTrip(metadataFor("Swift.UInt8")).write(200)).toBe(200);
    expect(roundTrip(metadataFor("Swift.Bool")).write(true)).toBe(true);
    expect(roundTrip(metadataFor("Swift.Double")).write(3.5)).toBe(3.5);
  });

  test("round-trips Int128 and UInt128 as BigInt", (ctx) => {
    const Int128 = metadataFor("Swift.Int128");
    if (Int128 === null) ctx.skip("stdlib without Int128 (Swift < 6.0)");
    const UInt128 = metadataFor("Swift.UInt128");
    expect(roundTrip(Int128).write(-(1n << 100n) - 7n)).toBe(-(1n << 100n) - 7n);
    expect(roundTrip(Int128).write(-42)).toBe(-42n);
    expect(roundTrip(Int128).write(int64(-43))).toBe(-43n);
    expect(roundTrip(UInt128).write((1n << 127n) | 9n)).toBe((1n << 127n) | 9n);
    expect(() => roundTrip(Int128).write(1n << 127n)).toThrow(/in range/);
    expect(() => roundTrip(UInt128).write(-1n)).toThrow(/in range/);
    expect(() => roundTrip(Int128).write(1.5)).toThrow(/in range/);
  });

  test("marshals JS null as Optional .none", () => {
    const opt = roundTrip(metadataFor("Swift.Optional", [metadataFor("Swift.Int")!]));
    expect(opt.write(null)).toBe("none");
    expect(opt.write({ some: 7 })).toEqual({ some: int64(7) });
  });

  test("accepts an Int64-wrapped value for a narrow field, range-checked", () => {
    expect(roundTrip(metadataFor("Swift.UInt8")).write(int64(200))).toBe(200);
    expect(roundTrip(metadataFor("Swift.Int8")).write(int64(-5))).toEqual(-5);
    expect(() => roundTrip(metadataFor("Swift.UInt8")).write(300)).toThrow(/out of range/);
    expect(() => roundTrip(metadataFor("Swift.Int8")).write(200)).toThrow(/out of range/);
  });

  test("an out-of-range narrow field is rejected before a preceding String is written", () => {
    const Badge = metadataFor("fixture.Badge")!;
    const stride = Badge.typeLayout.stride;
    const storage = Memory.alloc(stride);
    const sentinel = new Array(stride).fill(0xaa);
    storage.writeByteArray(sentinel);
    expect(() => writeValue(Badge, storage, { title: "gold", level: 300 })).toThrow(/out of range/);
    const bytes = new Uint8Array(storage.readByteArray(stride)!);
    expect(bytes.every((b) => b === 0xaa)).toBe(true);
  });

  test("recurses into nested struct fields", () => {
    const Loadable = metadataFor("fixture.LoadableStruct");
    expect(roundTrip(Loadable).write({ a: 1, b: 2, c: 3, d: 4 })).toEqual({
      a: int64(1),
      b: int64(2),
      c: int64(3),
      d: int64(4),
    });
  });

  test("injects a payload enum case", () => {
    expect(roundTrip(metadataFor("fixture.Pick")).write({ value: 7 })).toEqual({ value: int64(7) });
  });

  test("injects an empty enum case", () => {
    expect(roundTrip(metadataFor("fixture.Pick")).write("empty")).toBe("empty");
  });

  test("constructs a String from a JS literal", () => {
    const String_ = metadataFor("Swift.String")!;
    const storage = Memory.alloc(String_.typeLayout.stride);
    writeValue(String_, storage, "hi");
    expect(readValue(String_, storage)).toBe("hi");
  });

  test("a mismatch deep in an aggregate is rejected before anything is written", () => {
    const Loadable = metadataFor("fixture.LoadableStruct")!;
    const stride = Loadable.typeLayout.stride;
    const storage = Memory.alloc(stride);
    const sentinel = new Array(stride).fill(0xaa);
    storage.writeByteArray(sentinel);
    expect(() =>
      writeValue(Loadable, storage, { a: 1, b: "bad" as never, c: 3, d: 4 })
    ).toThrow(/cannot write string as Swift.Int/);
    expect(() => writeValue(Loadable, storage, { a: 1, b: 2, c: 3 })).toThrow(/missing field d/);
    const bytes = new Uint8Array(storage.readByteArray(stride)!);
    expect(bytes.every((b) => b === 0xaa)).toBe(true);
  });

  test("a mismatched enum payload is rejected before the tag is set", () => {
    const Pick = metadataFor("fixture.Pick")!;
    const stride = Pick.typeLayout.stride;
    const storage = Memory.alloc(stride);
    const sentinel = new Array(stride).fill(0xaa);
    storage.writeByteArray(sentinel);
    expect(() => writeValue(Pick, storage, { value: "bad" as never })).toThrow();
    expect(() => writeValue(Pick, storage, "nosuchcase")).toThrow(/unknown enum case/);
    const bytes = new Uint8Array(storage.readByteArray(stride)!);
    expect(bytes.every((b) => b === 0xaa)).toBe(true);
  });

  test("reads each caller field exactly once, immune to a getter that mutates between passes", () => {
    const Loadable = metadataFor("fixture.LoadableStruct")!;
    let reads = 0;
    const value = {
      a: 1,
      get b() {
        // Valid on the first read; a second read would change the outcome.
        return reads++ === 0 ? 2 : ("poison" as never);
      },
      c: 3,
      d: 4,
    };
    const result = roundTrip(Loadable).write(value);
    expect(result).toEqual({ a: int64(1), b: int64(2), c: int64(3), d: int64(4) });
    expect(reads).toBe(1);
  });

  test("rejects an unsupported metadata kind", () => {
    const Counter = metadataFor("fixture.Counter")!;
    expect(() => writeValue(Counter, Memory.alloc(Counter.typeLayout.stride), ptr(0))).toThrow();
  });

  test("writes into a freshly allocated box", () => {
    const Int = metadataFor("Swift.Int")!;
    const { swift_allocBox, swift_release } = getSwiftCoreApi();
    const object = swift_allocBox(Int.handle);
    const buffer = projectBox(object);
    writeValue(Int, buffer, 99);
    expect(readValue(Int, buffer)).toEqual(int64(99));
    swift_release(object);
  });
});

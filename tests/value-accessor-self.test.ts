import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { StructType, SwiftStruct } from "../src/index.js";
import { metadataFor, typeOf } from "../src/abi.js";

function st(name: string): SwiftStruct {
  return (typeOf(metadataFor(name)!) as StructType).facade;
}

describe("value-type property accessor self routing", () => {
  beforeEach(() => { loadFixture(); });

  // A getter borrows a small loadable receiver by value; passing the self pointer instead makes the
  // getter read the pointer as the value (Point.x returns the pointer, doubled returns twice it).
  test("getters on a small loadable value type pass self by value", () => {
    const p = st("fixture.Point").$new({ x: 5 });
    expect(p.$get("x")).toEqual(int64(5));
    expect(p.$get("doubled")).toEqual(int64(10));
  });

  // A mutating setter keeps self indirect so the write reaches the caller's storage.
  test("a mutating setter writes back, and the stored getter reads it", () => {
    const r = st("fixture.Rect").$new({ width: 3 });
    expect(r.$get("scaled")).toEqual(int64(6));
    r.$set("scaled", 10);
    expect(r.$get("width")).toEqual(int64(5));
  });
});

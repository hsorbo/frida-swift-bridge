import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";
import { requireDarwin } from "./swift.js";

import { Swift, SwiftValueObject } from "../src/index.js";

function bagValue(method: string): SwiftValueObject {
  return Swift.struct("fixture.Bag")!.$call(method) as SwiftValueObject;
}

describe("indexing a Collection facade", () => {
  beforeEach(() => {
    loadFixture();
  });

  test("an Array reads the element at a Swift index", () => {
    using ints = bagValue("ints");
    expect(ints[0]).toEqual(int64(10));
    expect(ints[2]).toEqual(int64(30));
    using points = bagValue("points");
    expect(points[1].y).toEqual(int64(4));
    using contiguous = bagValue("contiguous");
    expect(contiguous[1]).toEqual(int64(8));
  });

  test("an index outside startIndex..<endIndex answers undefined", () => {
    using ints = bagValue("ints");
    expect(ints[3]).toBeUndefined();
    expect(ints[1e9]).toBeUndefined();
    using empty = bagValue("empty");
    expect(empty[0]).toBeUndefined();
  });

  test("a slice is indexed from its startIndex, not from zero", () => {
    using slice = bagValue("slice");
    expect(slice[0]).toBeUndefined();
    expect(slice[2]).toEqual(int64(30));
    expect(slice[3]).toEqual(int64(40));
    expect(slice[4]).toBeUndefined();
  });

  test("a Data slice keeps its parent's indices", (ctx) => {
    requireDarwin(ctx);
    using data = Swift.struct("Foundation.Data")!.init({ count: 4 }) as SwiftValueObject;
    expect(data[0]).toEqual(0);
    using tail = data.$method("suffix", { labels: ["from"] }).call(2) as SwiftValueObject;
    expect(tail[0]).toBeUndefined();
    expect(tail[2]).toEqual(0);
    expect(tail[4]).toBeUndefined();
  });

  test("a Collection struct and class read through their own subscript", () => {
    using trio = Swift.struct("fixture.Trio")!.$new({ a: 1, b: 2, c: 3 });
    expect(trio[2]).toEqual(int64(3));
    expect(trio[3]).toBeUndefined();
    using shelf = Swift.class("fixture.Shelf")!.init({ items: ["x", "y"] });
    expect(shelf[1]).toBe("y");
    expect(shelf[2]).toBeUndefined();
  });

  test("only a canonical array-index key is an index", () => {
    using ints = bagValue("ints");
    expect(ints["01"]).toBeUndefined();
    expect(ints["-1"]).toBeUndefined();
    expect(ints["1.0"]).toBeUndefined();
  });

  test("a type that is no Collection indexed by Int answers undefined", () => {
    using intKeyed = bagValue("intKeyed");
    expect(intKeyed[0]).toBeUndefined();
    using grid = Swift.struct("fixture.Grid")!.init([1, 2]) as SwiftValueObject;
    expect(grid[0]).toBeUndefined();
    using set = bagValue("intSet");
    expect(set[0]).toBeUndefined();
  });

  test("in follows the bounds, keys list no index, and assignment throws", () => {
    using ints = bagValue("ints");
    expect(0 in ints).toBe(true);
    expect(3 in ints).toBe(false);
    expect(Object.keys(ints)).not.toContain("0");
    expect(() => {
      ints[0] = 5;
    }).toThrow(/read-only/);
    expect(ints[0]).toEqual(int64(10));
  });
});

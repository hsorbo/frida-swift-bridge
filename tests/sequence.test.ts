import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, SwiftValueObject } from "../src/index.js";

function bagValue(method: string): SwiftValueObject {
  return Swift.struct("fixture.Bag")!.$call(method) as SwiftValueObject;
}

function byFirst(a: unknown[], b: unknown[]): number {
  return Number(a[0]) - Number(b[0]);
}

describe("iterating a Sequence facade", () => {
  beforeEach(() => {
    loadFixture();
  });

  test("an Array yields what $container() decodes", () => {
    using ints = bagValue("ints");
    expect([...ints]).toEqual(ints.$container());
    using strings = bagValue("strings");
    expect([...strings]).toEqual(["a", "bb", "ccc"]);
    using empty = bagValue("empty");
    expect([...empty]).toEqual([]);
  });

  test("a Set yields its elements", () => {
    using set = bagValue("intSet");
    expect([...set].sort((a, b) => Number(a) - Number(b))).toEqual([int64(1), int64(2), int64(3)]);
  });

  test("a Dictionary yields [key, value] pairs", () => {
    using map = bagValue("intMap");
    const entries = ([...map] as unknown[][]).sort(byFirst);
    expect(entries).toEqual([
      [int64(1), int64(100)],
      [int64(2), int64(200)],
    ]);
  });

  test("an Array of optionals yields null for nil without ending early", () => {
    using values = bagValue("optionals");
    expect([...values]).toEqual([int64(1), null, int64(3)]);
  });

  test("a Collection-only struct iterates through its implied Sequence conformance", () => {
    using trio = Swift.struct("fixture.Trio")!.$new({ a: 1, b: 2, c: 3 });
    expect([...trio]).toEqual([int64(1), int64(2), int64(3)]);
  });

  test("a struct that is its own iterator advances a copy", () => {
    using countdown = Swift.struct("fixture.Countdown")!.$new({ n: 3 });
    expect([...countdown]).toEqual([int64(3), int64(2), int64(1)]);
    expect(Number(countdown.n)).toBe(3);
  });

  test("a class conformer passes self through a cell", () => {
    using playlist = Swift.class("fixture.Playlist")!.init({ names: ["x", "y"] })!;
    expect([...playlist]).toEqual(["x", "y"]);
  });

  test("for...of stops at a break and the facade iterates again", () => {
    using ints = bagValue("ints");
    const seen: unknown[] = [];
    for (const x of ints) {
      seen.push(x);
      if (seen.length === 2) {
        break;
      }
    }
    expect(seen).toEqual([int64(10), int64(20)]);
    expect([...ints]).toEqual([int64(10), int64(20), int64(30)]);
  });

  test("a facade of a non-Sequence type is not iterable", () => {
    using point = Swift.struct("fixture.Point")!.$new({ x: 1 });
    expect(point[Symbol.iterator]).toBeUndefined();
    expect(() => [...point]).toThrow();
  });
});

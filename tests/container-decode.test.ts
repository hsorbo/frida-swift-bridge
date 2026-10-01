import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, StructType, SwiftValueObject } from "../src/index.js";

import { metadataFor, typeOf } from "../src/abi.js";
function bag(): StructType {
  return typeOf(metadataFor("fixture.Bag")!) as StructType;
}

function decoded(method: string): SwiftValueObject {
  const result = bag().$call(method) as SwiftValueObject;
  expect(result.$kind).toBe("value");
  return result;
}

describe("bridged container decode", () => {
  beforeEach(() => { loadFixture(); });

  test("Array<Int> projects to a JS array of numbers", () => {
    using arr = decoded("ints");
    expect(arr.$container()).toEqual([int64(10), int64(20), int64(30)]);
  });

  test("Array<String> recurses into element decode", () => {
    using arr = decoded("strings");
    expect(arr.$container()).toEqual(["a", "bb", "ccc"]);
  });

  test("empty Array decodes to []", () => {
    using arr = decoded("empty");
    expect(arr.$container()).toEqual([]);
  });

  test("Set<Int> projects to its elements", () => {
    using set = decoded("intSet");
    const elements = (set.$container() as number[]).slice().sort((a, b) => a - b);
    expect(elements).toEqual([int64(1), int64(2), int64(3)]);
  });

  test("Dictionary<Int, Int> projects to key/value entries", () => {
    using map = decoded("intMap");
    const entries = (map.$container() as { key: number; value: number }[])
      .slice()
      .sort((a, b) => a.key - b.key);
    expect(entries).toEqual([
      { key: int64(1), value: int64(100) },
      { key: int64(2), value: int64(200) },
    ]);
  });
});

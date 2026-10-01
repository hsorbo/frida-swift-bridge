import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, StructType, EnumType } from "../src/index.js";

import { metadataFor, typeOf } from "../src/abi.js";
function structType(name: string): StructType {
  return typeOf(metadataFor(name)!) as StructType;
}

describe("Static value-type method invocation", () => {
  beforeEach(() => { loadFixture(); });

  test("static method on a struct passes no self", () => {
    expect(structType("fixture.Accumulator").$call("summing", 4, 5)).toEqual(int64(9));
  });

  test("static factory returns the value type", () => {
    expect(structType("fixture.Accumulator").$call("zero")).toEqual({ total: int64(0) });
  });

  test("static method on an enum passes no self", () => {
    const t = typeOf(metadataFor("fixture.Pick")!) as EnumType;
    expect(t.$call("tag", 21)).toEqual(int64(42));
  });

  test("a bound static method is reusable across calls", () => {
    const summing = structType("fixture.Accumulator").$typeMethod("summing");
    expect(summing.call(1, 2)).toEqual(int64(3));
    expect(summing.call(10, 20)).toEqual(int64(30));
  });
});

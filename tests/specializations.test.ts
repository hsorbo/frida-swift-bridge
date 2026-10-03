import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift } from "../src/index.js";
import { metadataOf } from "../src/abi.js";

describe("NominalType.specializations", () => {
  beforeEach(() => { loadFixture(); });

  test("lists the specializations of a generic struct built so far, each once", () => {
    const KeyedInt = Swift.struct("fixture.Keyed<Swift.Int>")!;
    const KeyedString = Swift.struct("fixture.Keyed<Swift.String>")!;
    const found = Swift.struct("fixture.Keyed")!.$type.specializations();
    expect(found).toContain(KeyedInt);
    expect(found).toContain(KeyedString);
    expect(new Set(found).size).toBe(found.length);
  });

  test("lists the specializations of a generic class whether or not an instance lives", () => {
    const IntCell = Swift.class("fixture.Cell<Swift.Int>")!;
    const StringCell = Swift.class("fixture.Cell<Swift.String>")!;
    const found = Swift.class("fixture.Cell")!.$type.specializations();
    expect(found).toContain(IntCell);
    expect(found).toContain(StringCell);
  });

  test("lists a specialization whose metadata is the compiler's record in read-only image data", (ctx) => {
    const OptionalInt = Swift.enum("Swift.Optional<Swift.Int>")!;
    const range = Process.findRangeByAddress(metadataOf(OptionalInt.$type).handle)!;
    if (range.protection !== "r--") ctx.skip("Optional<Int> is not prespecialized on this host");
    expect(Swift.enum("Swift.Optional")!.$type.specializations()).toContain(OptionalInt);
  });

  test("a specialization or a non-generic type has none to list", () => {
    expect(() => Swift.type("fixture.Keyed<Swift.Int>")!.$type.specializations()).toThrow("is not a generic type named without its arguments");
    expect(() => Swift.type("fixture.Robot")!.$type.specializations()).toThrow("is not a generic type named without its arguments");
  });
});

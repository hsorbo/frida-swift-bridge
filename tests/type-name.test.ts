import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift } from "./swift.js";

import { Swift } from "../src/index.js";

describe("a type's name", () => {
  test("names a concrete stdlib type", () => {
    requireSwift();
    expect(Swift.type("Swift.Int")!.$type.name).toBe("Swift.Int");
  });

  test("names a generic instantiation with its type arguments", () => {
    requireSwift();
    const arrayInt = Swift.type("Swift.Array<Swift.Int>")!.$type.name;
    expect(arrayInt).toContain("Array");
    expect(arrayInt).toContain("Int");

    const dict = Swift.type("Swift.Dictionary<Swift.String, Swift.Int>")!.$type.name;
    expect(dict).toContain("Dictionary");
    expect(dict).toContain("String");
    expect(dict).toContain("Int");
  });

  test("names a stdlib enum", () => {
    requireSwift();
    expect(Swift.type("Swift.Bool")!.$type.name).toBe("Swift.Bool");
  });
});

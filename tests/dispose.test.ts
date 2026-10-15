import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift } from "./swift.js";

import { Swift, SwiftValueObject } from "../src/index.js";

describe("Symbol.dispose", () => {
  test("[Symbol.dispose]() aliases $dispose() and is idempotent", () => {
    requireSwift();
    const v = Swift.struct("Swift.Int")!.$new(42);
    v[Symbol.dispose]();
    v[Symbol.dispose]();
    expect(() => v.$fields).toThrow();
  });

  test("using disposes an owned value at block scope", () => {
    requireSwift();
    let captured: SwiftValueObject;
    {
      using v = Swift.struct("Swift.Int")!.$new(7);
      captured = v;
      expect(v.$fields).toEqual(int64(7));
    }
    expect(() => captured.$fields).toThrow();
  });
});

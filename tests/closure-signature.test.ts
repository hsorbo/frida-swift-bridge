import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { Swift, SwiftClosureValue, SwiftValueObject } from "../src/index.js";

const MAKE_HANDLER = "$s7fixture11makeHandleryAA0C0VSiF";
const MAKE_LABELER = "$s7fixture11makeLabelerySSSicSSF";
const INVOKE_MAPPING = "$s7fixture13invokeMappingyS2i_S2iXEtF";
const INVOKE_MAPPING_WITH_OFFSET = "$s7fixture23invokeMappingWithOffsetyS2i_SitF";

function retainCount(context: NativePointer): number {
  return Number(Swift.api.swift_retainCount(context));
}

describe("closure views called by a supplied signature", () => {
  let module: Module;
  beforeEach(() => {
    module = loadFixture();
  });

  test("a non-escaping closure argument is called inside the hook with the signature given to $as", () => {
    let result: unknown = null;
    const listener = Swift.Interceptor.attach(Swift.function(module, INVOKE_MAPPING), {
      onEnter(args) {
        result = (args[1] as SwiftClosureValue).$as("(Swift.Int) -> Swift.Int")(5);
      },
    });
    try {
      expect(Swift.function(module, INVOKE_MAPPING_WITH_OFFSET).call(40, 2)).toEqual(int64(42));
    } finally {
      listener.detach();
    }
    expect(result).toEqual(int64(7));
  });

  test("a closure read from a struct field is called by its signature and stays a borrowed view", () => {
    const handler = Swift.function(module, MAKE_HANDLER).call(5) as SwiftValueObject;
    const action = (handler.$field("action").read() as SwiftClosureValue).$as("() -> Swift.Int");
    expect(action.$owned).toBe(false);
    expect(action()).toEqual(int64(5));
    expect(action.$captures().map((c) => c.read())).toEqual([int64(5)]);
  });

  test("$retained keeps the signature, in either order", () => {
    const handler = Swift.function(module, MAKE_HANDLER).call(5) as SwiftValueObject;
    const action = handler.$field("action").read() as SwiftClosureValue;
    const before = retainCount(action.context);
    const kept = action.$retained();
    const keptThenTyped = kept.$as("() -> Swift.Int");
    const typedThenKept = action.$as("() -> Swift.Int").$retained();
    expect(retainCount(action.context)).toBe(before + 3);
    expect(keptThenTyped.$owned).toBe(true);
    expect(typedThenKept.$owned).toBe(true);
    expect(keptThenTyped()).toEqual(int64(5));
    expect(typedThenKept()).toEqual(int64(5));
    kept.$dispose();
    keptThenTyped.$dispose();
    typedThenKept.$dispose();
    expect(retainCount(action.context)).toBe(before);
  });

  test("a String result is marshalled as for a returned closure", () => {
    const label = Swift.function(module, MAKE_LABELER).call("n=") as SwiftClosureValue;
    const retyped = Swift.borrowClosure({ function: label.function, context: label.context }).$as("(Swift.Int) -> Swift.String");
    expect(retyped(7)).toBe("n=7");
  });

  test("$as refuses a non-function signature and a view with no function pointer", () => {
    const handler = Swift.function(module, MAKE_HANDLER).call(5) as SwiftValueObject;
    const action = handler.$field("action").read() as SwiftClosureValue;
    expect(() => action.$as("Swift.Int")).toThrow(/not a function type/);
    const contextOnly = Swift.borrowClosure(new NativeFunction(fixtureExport("capturingContext"), "pointer", [])() as NativePointer);
    expect(() => contextOnly.$as("() -> ()")).toThrow(/no function/);
  });
});

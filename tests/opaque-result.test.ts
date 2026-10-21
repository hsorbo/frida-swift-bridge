import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";
import { fieldsOf } from "./swift.js";

import { Swift, SwiftValueObject } from "../src/index.js";

describe("a result of opaque type", () => {
  let module: Module;
  beforeEach(() => {
    module = loadFixture();
  });

  test("a function returns its underlying value", () => {
    expect(fieldsOf(Swift.function(module, "$s7fixture17makeOpaqueGreeterQryF").call())).toEqual({ name: "Ada" });
  });

  test("a property reads as its underlying value", () => {
    const host = Swift.struct("fixture.OpaqueHost")!.$new({ name: "Ada" });
    const body = host.$get("body") as SwiftValueObject;
    expect(fieldsOf(body)).toEqual({ name: "Ada" });
    expect(body.greet()).toBe("Hello, Ada");
  });

  test("a method returns its underlying value", () => {
    const host = Swift.struct("fixture.OpaqueHost")!.$new({ name: "Ada" });
    expect(fieldsOf(host.renamed("Grace"))).toEqual({ name: "Grace" });
  });

  test("an underlying value is read from the result buffer, not the result registers", () => {
    expect(Swift.function(module, "$s7fixture15makeOpaqueCountQryF").call()).toEqual(int64(42));
    expect(Swift.struct("fixture.OpaqueHost")!.$new({ name: "Ada" }).$get("length")).toEqual(int64(3));
  });
});

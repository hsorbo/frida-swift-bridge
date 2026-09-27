import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { ValueInstance, asSwiftObject, metadataFor } from "../src/abi.js";

function value(typeName: string, fields: { [k: string]: number }): ValueInstance {
  return ValueInstance.fromJS(metadataFor(typeName)!, fields);
}

describe("ValueInstance method invocation", () => {
  beforeEach(() => { loadFixture(); });

  test("non-mutating method on a small loadable struct (self as trailing arg)", () => {
    expect(value("fixture.Accumulator", { total: 5 }).method("peek", { mutating: false }).call(10)).toEqual(int64(15));
  });

  test("mutating method writes back through the inout self pointer", () => {
    const v = value("fixture.Accumulator", { total: 5 });
    v.method("add", { mutating: true }).call(3);
    expect((v.read() as { total: number }).total).toEqual(int64(8));
  });

  test("String arg and return marshal across a trailing-self call", () => {
    expect(value("fixture.Accumulator", { total: 7 }).method("describe", { mutating: false }).call("T")).toBe("T: 7");
  });

  test("multi-word loadable self rides in successive registers after the args", () => {
    expect(value("fixture.LoadableStruct", { a: 1, b: 2, c: 3, d: 4 }).method("dot", { mutating: false }).call(2)).toEqual(int64(20));
  });

  test("large struct passes self indirectly in x20", () => {
    expect(value("fixture.BigStruct", { a: 1, b: 2, c: 3, d: 4, e: 5 }).call("total")).toEqual(int64(15));
  });

  test("a small loadable receiver requires an explicit mutating flag", () => {
    expect(() => value("fixture.Accumulator", { total: 5 }).method("peek")).toThrow(/mutating/);
  });

  test("a bound value method is reusable across calls", () => {
    const peek = value("fixture.Accumulator", { total: 100 }).method("peek", { mutating: false });
    expect(peek.call(1)).toEqual(int64(101));
    expect(peek.call(2)).toEqual(int64(102));
  });
});

describe("facade method routing on a small loadable value", () => {
  beforeEach(() => { loadFixture(); });

  function accumulator(total: number) {
    return asSwiftObject(ValueInstance.fromJS(metadataFor("fixture.Accumulator")!, { total }));
  }

  test("string $call throws without an explicit mutating flag", () => {
    expect(() => accumulator(5).$call("peek", 10)).toThrow(/mutating/);
  });

  test("property-style invocation throws without an explicit mutating flag", () => {
    expect(() => accumulator(5).peek(10)).toThrow(/mutating/);
  });

  test("the missing-flag error names the working call form", () => {
    expect(() => accumulator(5).peek(10)).toThrow('$method("peek", { mutating: false }).call(...)');
  });

  test("$method({ mutating: false }) invokes a non-mutating method", () => {
    expect(accumulator(5).$method("peek", { mutating: false }).call(10)).toEqual(int64(15));
  });

  test("$method({ mutating: true }) writes back through self", () => {
    const acc = accumulator(5);
    acc.$method("add", { mutating: true }).call(3);
    expect((acc.$fields as { total: number }).total).toEqual(int64(8));
  });

  test("a bound value method from the facade is reusable", () => {
    const peek = accumulator(100).$method("peek", { mutating: false });
    expect(peek.call(1)).toEqual(int64(101));
  });
});

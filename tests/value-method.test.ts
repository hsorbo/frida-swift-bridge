import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadNoMetadata } from "./fixtures/load.js";

import { ValueInstance, asSwiftObject, metadataFor } from "../src/abi.js";
import { Swift } from "../src/index.js";

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

  test("a non-mutating method on a small loadable receiver needs no mutating flag", () => {
    expect(value("fixture.Accumulator", { total: 5 }).method("peek").call(10)).toEqual(int64(15));
  });

  test("a mutating method on a small loadable receiver needs no mutating flag", () => {
    const v = value("fixture.Accumulator", { total: 5 });
    v.method("add").call(3);
    expect((v.read() as { total: number }).total).toEqual(int64(8));
  });

  test("a trailing self split across the last registers and the stack", () => {
    const v = value("fixture.LoadableStruct", { a: 1, b: 2, c: 3, d: 4 });
    expect(v.method("weighted").call(1, 2, 3, 4, 5, 6)).toEqual(int64(214321));
  });

  test("a mutating method whose args fill every register", () => {
    const v = value("fixture.Accumulator", { total: 5 });
    v.method("addEight").call(1, 2, 3, 4, 5, 6, 7, 8);
    expect((v.read() as { total: number }).total).toEqual(int64(41));
  });

  test("a mutating method on a borrowed field writes into the parent", () => {
    const ledger = ValueInstance.fromJS(metadataFor("fixture.Ledger")!, { entry: { total: 5 }, id: 1 });
    ledger.field("entry").method("add").call(3);
    expect((ledger.read() as { entry: { total: number } }).entry.total).toEqual(int64(8));
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

  test("string $call invokes a non-mutating method", () => {
    expect(accumulator(5).$call("peek", 10)).toEqual(int64(15));
  });

  test("property-style invocation of a non-mutating method", () => {
    expect(accumulator(5).peek(10)).toEqual(int64(15));
  });

  test("property-style invocation of a mutating method writes back", () => {
    const acc = accumulator(5);
    acc.add(3);
    expect((acc.$fields as { total: number }).total).toEqual(int64(8));
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

describe("stdlib methods on small loadable values", () => {
  test("Swift.Int.signum() needs no mutating flag", () => {
    expect(Swift.struct("Swift.Int")!.new(-5).signum()).toEqual(int64(-1));
  });
});

describe("extension methods on Swift.String from another module", () => {
  beforeEach(() => { loadNoMetadata(); });

  test("a non-mutating one returns without touching self", () => {
    const s = Swift.struct("Swift.String")!.new("kake");
    expect(s.shouted()).toBe("KAKE!");
    expect(s.shouted()).toBe("KAKE!");
  });

  test("a mutating one writes back through self", () => {
    const s = ValueInstance.fromJS(metadataFor("Swift.String")!, "kake");
    s.method("exclaim").call();
    s.method("exclaim").call();
    expect(s.read()).toBe("kake!!");
  });
});

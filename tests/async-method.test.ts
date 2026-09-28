import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { ClassType, ValueType, ValueInstance, BoundAsyncMethod, GenericBoundAsyncMethod, SwiftError, asSwiftObject, metadataFor, typeOf } from "../src/abi.js";

import { Swift } from "../src/index.js";
function calc(base: number) {
  return (typeOf(metadataFor("fixture.AsyncCalc")!) as ClassType).init(base);
}

describe("async method", () => {
  beforeEach(() => { loadFixture(); });

  test("awaits an async method through the facade: calc(100).addAsync(5) ⇒ 105", async () => {
    expect(await calc(100).addAsync(5)).toEqual(int64(105));
  });

  test("$method hands back a narrow bound method, not the concrete binder", async () => {
    const m = calc(100).$method("addAsync");
    expect(m instanceof BoundAsyncMethod).toBe(false);
    expect(m.address.isNull()).toBe(false);
    expect(await m.call(5)).toEqual(int64(105));
  });

  test("resolves an async throwing method that does not throw", async () => {
    expect(await calc(100).divideBaseBy(2)).toEqual(int64(50));
  });

  test("rejects with SwiftError when the async throwing method throws", async () => {
    await expect(calc(100).divideBaseBy(0)).rejects.toThrow(SwiftError);
  });

  test("passes and returns a Double: calc(100).scaleAsync(1.5) ⇒ 150", async () => {
    expect(await calc(100).scaleAsync(1.5)).toBe(150);
  });

  test("returns a large struct through an @out buffer: calc(100).quadAsync()", async () => {
    const q = (await calc(100).quadAsync()) as { a: number; b: number; c: number; d: number; e: number };
    expect(q.a).toEqual(int64(100));
    expect(q.e).toEqual(int64(104));
  });

  test("$method on an async generic method also hands back a narrow bound method", () => {
    const Int = metadataFor("Swift.Int")!;
    const m = calc(100).$method("echoAsync", { typeArguments: [typeOf(Int)] });
    expect(m instanceof GenericBoundAsyncMethod).toBe(false);
    expect(typeof m.call).toBe("function");
  });

  test("drives an async generic method (metadata only): echoAsync<Int>(21) ⇒ 21", async () => {
    const Int = metadataFor("Swift.Int")!;
    expect(await calc(100).$method("echoAsync", { typeArguments: [typeOf(Int)] }).call(21)).toEqual(int64(21));
  });

  test("round-trips a non-POD generic argument: echoAsync<String>(\"hi\") ⇒ \"hi\"", async () => {
    const Str = metadataFor("Swift.String")!;
    expect(await calc(100).$method("echoAsync", { typeArguments: [typeOf(Str)] }).call("hi")).toBe("hi");
  });

  test("passes a witness table for a constrained generic: pickLargerAsync<Int>(3, 8) ⇒ 8", async () => {
    const Int = metadataFor("Swift.Int")!;
    expect(await calc(100).$method("pickLargerAsync", { typeArguments: [typeOf(Int)] }).call(3, 8)).toEqual(int64(8));
  });

  test("async method on a small loadable value type trails self after the args: Accumulator.peekAsync(10) ⇒ 15", async () => {
    const acc = ValueInstance.fromJS(metadataFor("fixture.Accumulator")!, { total: 5 });
    expect(await acc.method("peekAsync", { self: "borrowing" }).call(10)).toEqual(int64(15));
  });

  test("a non-mutating async method on a small loadable value needs no self option", async () => {
    const acc = ValueInstance.fromJS(metadataFor("fixture.Accumulator")!, { total: 5 });
    expect(await acc.method("peekAsync").call(10)).toEqual(int64(15));
  });

  test("a mutating async method on a small loadable value needs no self option", async () => {
    const acc = ValueInstance.fromJS(metadataFor("fixture.Accumulator")!, { total: 5 });
    await acc.method("depositAsync").call(3);
    expect((acc.read() as { total: number }).total).toEqual(int64(8));
  });

  test('a mutating async method still accepts { self: "mutating" }', async () => {
    const acc = ValueInstance.fromJS(metadataFor("fixture.Accumulator")!, { total: 5 });
    await acc.method("depositAsync", { self: "mutating" }).call(3);
    expect((acc.read() as { total: number }).total).toEqual(int64(8));
  });

  test('an async method whose trailing self overflows the registers asks for { self: "mutating" }', () => {
    const quad = ValueInstance.fromJS(metadataFor("fixture.DoubleQuad")!, { a: 1, b: 2, c: 3, d: 4 });
    expect(() => quad.method("shiftAsync").call(1, 1, 1, 1, 2)).toThrow('{ self: "mutating" }');
  });

  test('{ self: "borrowing" } passes a trailing self past the registers on the stack', async () => {
    const quad = ValueInstance.fromJS(metadataFor("fixture.DoubleQuad")!, { a: 1, b: 2, c: 3, d: 4 });
    expect(await quad.method("weighAsync", { self: "borrowing" }).call(1, 10, 100, 1000, 2)).toBe(8642);
  });

  test('{ self: "mutating" } keeps self out of the async argument registers', async () => {
    const quad = ValueInstance.fromJS(metadataFor("fixture.DoubleQuad")!, { a: 1, b: 2, c: 3, d: 4 });
    await quad.method("shiftAsync", { self: "mutating" }).call(1, 1, 1, 1, 2);
    expect(quad.read()).toEqual({ a: 4, b: 6, c: 8, d: 10 });
  });

  test("property-style invocation of an async method on a small loadable value", async () => {
    expect(await asSwiftObject(ValueInstance.fromJS(metadataFor("fixture.Accumulator")!, { total: 5 })).peekAsync(10)).toEqual(int64(15));
  });

  test("static async method on a value type (no self): Accumulator.sumStaticAsync(4, 5) ⇒ 9", async () => {
    const t = typeOf(metadataFor("fixture.Accumulator")!) as ValueType;
    expect(await t.call("sumStaticAsync", 4, 5)).toEqual(int64(9));
  });

  test("static async method on a class: AsyncCalc.combineAsync(3, 4) ⇒ 34", async () => {
    const t = typeOf(metadataFor("fixture.AsyncCalc")!) as ClassType;
    expect(await t.call("combineAsync", 3, 4)).toEqual(int64(34));
  });
});

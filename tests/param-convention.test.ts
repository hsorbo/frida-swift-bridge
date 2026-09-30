import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { Swift, ClassType, StructType, SwiftObject } from "../src/index.js";
import { ClassInstance } from "../src/abi.js";

function robot(name: string): SwiftObject {
  return (Swift.type("fixture.Robot") as ClassType).init(name);
}

function int(n: number): SwiftObject {
  return (Swift.type("Swift.Int") as StructType).new(n);
}

function box(): SwiftObject {
  return (Swift.type("fixture.Box") as ClassType).init();
}

describe("__owned parameters", () => {
  beforeEach(() => { loadFixture(); });

  test("an owned class argument is retained for the callee to consume", () => {
    const other = robot("Bee");
    const view = new ClassInstance(other.$handle);
    const before = view.retainCount;
    expect(robot("Ada").absorb(other)).toBe("Bee");
    expect(view.retainCount).toBe(before);
  });

  test("an owned value argument's temp is left to the callee", () => {
    const Int = Swift.type("Swift.Int");
    const Token = Swift.type("fixture.Token") as ClassType;
    const Wrapper = Swift.type("fixture.Wrapper") as StructType;
    const token = Token.init(5);
    const wrapper = Wrapper.call("make", token) as SwiftObject;
    const view = new ClassInstance(token.$handle);
    const before = view.retainCount;
    const consume = Swift.NativeFunction(fixtureExport("fixture.consumeWrapper"), Int, [Wrapper]);
    expect(consume(wrapper)).toEqual(int64(5));
    expect(view.retainCount).toBe(before);
  });

  test("an owned generic argument is consumed by the callee", () => {
    const String_ = Swift.type("Swift.String")!;
    const long = "a string long enough to live on the heap";
    for (let i = 0; i < 3; i++) {
      expect(box().$method("kept", { typeArguments: [String_] }).call(long)).toBe(long);
    }
  });
});

describe("inout parameters", () => {
  beforeEach(() => { loadFixture(); });

  test("writes back into a value facade", () => {
    const n = int(21);
    robot("Ada").doubled(n);
    expect(n.$fields).toEqual(int64(42));
  });

  test("writes a non-POD value back", () => {
    const s = (Swift.type("Swift.String") as StructType).new("hi");
    robot("Ada").exclaim(s);
    expect(s.$fields).toBe("hi!");
  });

  test("writes into a field view of its parent", () => {
    const acc = (Swift.type("fixture.Accumulator") as StructType).new({ total: 4 });
    robot("Ada").doubled(acc.$field("total"));
    expect(acc.total).toEqual(int64(8));
  });

  test("a value method and a static method take inout arguments", () => {
    const Accumulator = Swift.type("fixture.Accumulator") as StructType;
    const sink = int(1);
    Accumulator.new({ total: 4 }).drain(sink);
    expect(sink.$fields).toEqual(int64(5));
    Accumulator.call("doubled", sink);
    expect(sink.$fields).toEqual(int64(10));
  });

  test("generic inout arguments swap", () => {
    const Int = Swift.type("Swift.Int")!;
    const a = int(1);
    const b = int(2);
    box().$method("swapped", { typeArguments: [Int] }).call(a, b);
    expect([a.$fields, b.$fields]).toEqual([int64(2), int64(1)]);
  });

  test("an async method writes back before it settles", async () => {
    const n = int(5);
    await (Swift.type("fixture.AsyncCalc") as ClassType).init(100).accumulateAsync(n);
    expect(n.$fields).toEqual(int64(105));
  });

  test("a plain JS value has nowhere to write back to", () => {
    expect(() => robot("Ada").doubled(21)).toThrow("must be a value facade");
  });

  test("a value facade of another type is rejected", () => {
    expect(() => robot("Ada").doubled((Swift.type("Swift.String") as StructType).new("x"))).toThrow("expected Swift.Int");
  });
});

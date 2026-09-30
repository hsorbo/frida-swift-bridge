import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadOptimized } from "./fixtures/load.js";

import { ValueInstance, metadataFor } from "../src/abi.js";

import { Swift } from "../src/index.js";
function box(typeName: string, fields: { [k: string]: number }): ValueInstance {
  return ValueInstance.fromJS(metadataFor(typeName)!, fields);
}

describe("generic methods on value receivers", () => {
  beforeEach(() => { loadFixture(); });

  test("small loadable receiver: generic arg/return with self as a trailing exploded arg", () => {
    const Int = metadataFor("Swift.Int")!;
    expect(box("fixture.SmallGenericBox", { base: 5 }).method("echo", { typeArguments: [Int], self: "borrowing" }).call(7)).toEqual(int64(7));
  });

  test("small loadable receiver: a borrowing self is inferred from the callee reading the trailing args", () => {
    const Int = metadataFor("Swift.Int")!;
    expect(box("fixture.SmallGenericBox", { base: 5 }).method("echo", { typeArguments: [Int] }).call(7)).toEqual(int64(7));
    expect(box("fixture.SmallGenericBox", { base: 10 }).method("scaledBy", { typeArguments: [Int] }).call(3, 7)).toEqual(int64(31));
  });

  test("small loadable receiver: a mutating self is inferred from the callee reading x20", () => {
    const Int = metadataFor("Swift.Int")!;
    const value = box("fixture.SmallGenericBox", { base: 10 });
    value.method("accumulate", { typeArguments: [Int] }).call(3, 7);
    expect(value.field("base").read()).toEqual(int64(31));
  });

  test("small loadable receiver: a -Onone debug spill of x20 marks the method mutating", () => {
    const Int = metadataFor("Swift.Int")!;
    const value = box("fixture.SmallGenericBox", { base: 10 });
    value.method("store", { typeArguments: [Int] }).call(4);
    expect(value.field("base").read()).toEqual(int64(4));
  });

  test("small receiver: a String generic argument routes through the value self", () => {
    const Str = metadataFor("Swift.String")!;
    expect(box("fixture.SmallGenericBox", { base: 1 }).method("echo", { typeArguments: [Str], self: "borrowing" }).call("hi")).toBe("hi");
  });

  test("small receiver: self + generic arg + witness combine (trailing-self ordering)", () => {
    const Int = metadataFor("Swift.Int")!;
    // base 10 + 3.scaled(by: 7) = 31; a wrong self/metadata order corrupts base or the witness call.
    expect(box("fixture.SmallGenericBox", { base: 10 }).method("scaledBy", { typeArguments: [Int], self: "borrowing" }).call(3, 7)).toEqual(int64(31));
  });

  test("large receiver: self passed indirectly in x20 alongside trailing metadata", () => {
    const Int = metadataFor("Swift.Int")!;
    // a..e sum 15 + 3.scaled(by: 7) = 36.
    expect(
      box("fixture.BigGenericBox", { a: 1, b: 2, c: 3, d: 4, e: 5 }).method("scaledBy", { typeArguments: [Int] }).call(3, 7)
    ).toEqual(int64(36));
  });

  test("small receiver, async: a borrowing self trails the args, ahead of the metadata and witness", async () => {
    const Int = metadataFor("Swift.Int")!;
    const value = box("fixture.SmallGenericBox", { base: 10 });
    expect(await value.method("scaledByAsync", { typeArguments: [Int], self: "borrowing" }).call(3, 7)).toEqual(int64(31));
  });

  test("small receiver, async: a mutating self rides in x20", async () => {
    const Int = metadataFor("Swift.Int")!;
    const value = box("fixture.SmallGenericBox", { base: 10 });
    await value.method("accumulateAsync", { typeArguments: [Int], self: "mutating" }).call(3, 7);
    expect(value.field("base").read()).toEqual(int64(31));
  });

  test("small receiver, async: the self option is required, as the entry never reveals it", () => {
    const Int = metadataFor("Swift.Int")!;
    expect(() => box("fixture.SmallGenericBox", { base: 10 }).method("scaledByAsync", { typeArguments: [Int] })).toThrow('{ self: "borrowing" }');
  });
});

describe("inferred self convention of optimized generic methods on a small value type", () => {
  beforeEach(() => { loadOptimized(); });

  test("borrowing and mutating methods are told apart", () => {
    const Int = metadataFor("Swift.Int")!;
    const counter = box("optimized.Counter", { total: 10 });
    expect(counter.method("weighted", { typeArguments: [Int] }).call(5)).toEqual(int64(15));
    counter.method("add", { typeArguments: [Int] }).call(5);
    expect(counter.field("total").read()).toEqual(int64(15));
    counter.method("reset", { typeArguments: [Int] }).call(5);
    expect(counter.field("total").read()).toEqual(int64(0));
  });

  test("a callee that reads neither layout still requires the self option", () => {
    const Int = metadataFor("Swift.Int")!;
    expect(() => box("optimized.Counter", { total: 1 }).method("ignore", { typeArguments: [Int] })).toThrow('$method("ignore", { self: "borrowing" }).call(...)');
  });
});

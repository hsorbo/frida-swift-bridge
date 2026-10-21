import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";
import { requireDarwin, requireSwift } from "./swift.js";

import { Swift, SwiftObject } from "../src/index.js";

function box(): SwiftObject {
  return Swift.class("fixture.Box")!.init()!;
}

function robot(name: string): SwiftObject {
  return Swift.class("fixture.Robot")!.init(name)!;
}

describe("generic method invocation", () => {
  beforeEach(() => { loadFixture(); });

  test("an ambiguity only argument types separate lists each overload's signature and suggests { argTypes }", () => {
    const Int = Swift.type("Swift.Int")!;
    const ambiguous = () => box().$method("head", { typeArguments: [Int] });
    expect(ambiguous).toThrow(/head\(_:\) \(A\) -> A/);
    expect(ambiguous).toThrow(/head\(_:\) \(Swift\.Array<A>\) -> A/);
    expect(ambiguous).toThrow(/\{ argTypes \}/);
    expect(box().$method("head", { typeArguments: [Int], argTypes: ["A"] }).call(7)).toEqual(int64(7));
  });

  test("calls an unconstrained generic method with a supplied type argument", () => {
    const Int = Swift.type("Swift.Int")!;
    expect(box().$method("echo", { typeArguments: [Int] }).call(7)).toEqual(int64(7));
  });

  test("the same method works for a different concrete type argument", () => {
    const Str = Swift.type("Swift.String")!;
    expect(box().$method("echo", { typeArguments: [Str] }).call("hi")).toBe("hi");
  });

  test("appends one metadata argument per generic parameter", () => {
    const Int = Swift.type("Swift.Int")!;
    const Str = Swift.type("Swift.String")!;
    expect(box().$method("pick", { typeArguments: [Int, Str] }).call(11, "x")).toEqual(int64(11));
  });

  test("auto-resolves a witness table for a constrained requirement", () => {
    const Int = Swift.type("Swift.Int")!;
    expect(box().$method("scaled", { typeArguments: [Int] }).call(6, 7)).toEqual(int64(42));
  });

  test("passes a class-bound generic argument directly", () => {
    const Widget = Swift.class("fixture.Widget")!;
    const widget = Widget.init("Bee")!;
    expect(box().$method("labelOf", { typeArguments: [Widget] }).call(widget)).toBe("Bee");
    widget.$dispose();
  });

  test("an Objective-C protocol requirement takes no witness table", (ctx) => {
    requireDarwin(ctx);
    const Conformer = Swift.class("fixture.ObjCConformer")!;
    const Int = Swift.type("Swift.Int")!;
    const conformer = Conformer.init()!;
    const method = box().$method("scaledIfObject", { typeArguments: [Conformer, Int] });
    expect(method.call(conformer, 6, 7)).toEqual(int64(42));
    conformer.$dispose();
  });

  test("passes a class-typed generic argument by reference", () => {
    const Robot = Swift.class("fixture.Robot")!;
    const r = robot("R2");
    const back = box().$method("echo", { typeArguments: [Robot] }).call(r) as SwiftObject;
    expect(back.$handle.equals(r.$handle)).toBe(true);
  });

  test("a bound generic method is reusable across calls", () => {
    const Int = Swift.type("Swift.Int")!;
    const echo = box().$method("echo", { typeArguments: [Int] });
    expect(echo.call(1)).toEqual(int64(1));
    expect(echo.call(2)).toEqual(int64(2));
  });

  test("rejects a type that fails the conformance requirement", () => {
    const Str = Swift.type("Swift.String")!;
    expect(() => box().$method("scaled", { typeArguments: [Str] })).toThrow();
  });

  test("rejects a mismatched type-argument count", () => {
    const Int = Swift.type("Swift.Int")!;
    expect(() => box().$method("pick", { typeArguments: [Int] })).toThrow();
  });
});

describe("generic stdlib method with an associated-type constraint", () => {
  // append<A where A: Sequence, A.Element == Character>: the same-type clause fixes no parameter, so
  // A's metadata and its Sequence witness are passed like any simple generic.
  test("String.append(contentsOf:) binds with a Sequence type argument", () => {
    requireSwift();
    const Str = Swift.struct("Swift.String")!;
    const s = Str.$new("ab");
    s.$method("append(contentsOf:)", { typeArguments: [Str], self: "mutating" }).call("cd");
    expect(s.$fields).toBe("abcd");
  });

  // String.init<A: BinaryInteger>(_:radix:uppercase:): a generic initializer on a non-generic type.
  test("String.init(_:radix:uppercase:) binds with a BinaryInteger type argument", () => {
    requireSwift();
    const Int = Swift.type("Swift.Int")!;
    const Str = Swift.type("Swift.String")!;
    const init = Str.$initializer("init(_:radix:uppercase:)", { typeArguments: [Int] });
    expect(init.call(255, 16, true)!.$fields).toBe("FF");
    expect(init.call(-10, 2, false)!.$fields).toBe("-1010");
  });

  test("a generic initializer without type arguments asks for them", () => {
    requireSwift();
    const Str = Swift.type("Swift.String")!;
    expect(() => Str.$initializer("init(_:radix:uppercase:)").call(255, 16, true)).toThrow(/typeArguments/);
  });
});

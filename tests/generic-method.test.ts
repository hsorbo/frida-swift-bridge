import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";
import { requireDarwin } from "./swift.js";

import { Swift, ClassType, SwiftObject } from "../src/index.js";

import { metadataFor, typeOf } from "../src/abi.js";
function box(): SwiftObject {
  return (typeOf(metadataFor("fixture.Box")!) as ClassType).facade.init();
}

function robot(name: string): SwiftObject {
  return (typeOf(metadataFor("fixture.Robot")!) as ClassType).facade.init(name);
}

describe("generic method invocation", () => {
  beforeEach(() => { loadFixture(); });

  test("calls an unconstrained generic method with a supplied type argument", () => {
    const Int = metadataFor("Swift.Int")!;
    expect(box().$method("echo", { typeArguments: [typeOf(Int)] }).call(7)).toEqual(int64(7));
  });

  test("the same method works for a different concrete type argument", () => {
    const Str = metadataFor("Swift.String")!;
    expect(box().$method("echo", { typeArguments: [typeOf(Str)] }).call("hi")).toBe("hi");
  });

  test("appends one metadata argument per generic parameter", () => {
    const Int = metadataFor("Swift.Int")!;
    const Str = metadataFor("Swift.String")!;
    expect(box().$method("pick", { typeArguments: [typeOf(Int), typeOf(Str)] }).call(11, "x")).toEqual(int64(11));
  });

  test("auto-resolves a witness table for a constrained requirement", () => {
    const Int = metadataFor("Swift.Int")!;
    expect(box().$method("scaled", { typeArguments: [typeOf(Int)] }).call(6, 7)).toEqual(int64(42));
  });

  test("passes a class-bound generic argument directly", () => {
    const Widget = (typeOf(metadataFor("fixture.Widget")!) as ClassType).facade;
    const widget = Widget.init("Bee");
    expect(box().$method("labelOf", { typeArguments: [Widget] }).call(widget)).toBe("Bee");
    widget.$dispose();
  });

  test("an Objective-C protocol requirement takes no witness table", (ctx) => {
    requireDarwin(ctx);
    const Conformer = (typeOf(metadataFor("fixture.ObjCConformer")!) as ClassType).facade;
    const Int = metadataFor("Swift.Int")!;
    const conformer = Conformer.init();
    const method = box().$method("scaledIfObject", { typeArguments: [Conformer, typeOf(Int)] });
    expect(method.call(conformer, 6, 7)).toEqual(int64(42));
    conformer.$dispose();
  });

  test("passes a class-typed generic argument by reference", () => {
    const Robot = metadataFor("fixture.Robot")!;
    const r = robot("R2");
    const back = box().$method("echo", { typeArguments: [typeOf(Robot)] }).call(r) as SwiftObject;
    expect(back.$handle.equals(r.$handle)).toBe(true);
  });

  test("a bound generic method is reusable across calls", () => {
    const Int = metadataFor("Swift.Int")!;
    const echo = box().$method("echo", { typeArguments: [typeOf(Int)] });
    expect(echo.call(1)).toEqual(int64(1));
    expect(echo.call(2)).toEqual(int64(2));
  });

  test("rejects a type that fails the conformance requirement", () => {
    const Str = metadataFor("Swift.String")!;
    expect(() => box().$method("scaled", { typeArguments: [typeOf(Str)] })).toThrow();
  });

  test("rejects a mismatched type-argument count", () => {
    const Int = metadataFor("Swift.Int")!;
    expect(() => box().$method("pick", { typeArguments: [typeOf(Int)] })).toThrow();
  });
});

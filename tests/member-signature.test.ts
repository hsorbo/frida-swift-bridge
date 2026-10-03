import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, SwiftClass, SwiftStruct, type SwiftObject, type CallResult, type SwiftValue } from "../src/index.js";
import { SwiftInterceptor } from "../src/runtime/interceptor.js";

function robot(name: string): SwiftObject {
  return (Swift.type("fixture.Robot") as SwiftClass).init(name);
}

describe("a member's signature", () => {
  beforeEach(() => { loadFixture(); });

  test("a member found through reflection names its labels and types", () => {
    const greet = (Swift.type("fixture.Robot") as SwiftClass).$type.instanceMethod("greet");
    expect(greet.signature).toEqual({
      labels: [null],
      argTypeNames: ["Swift.String"],
      returnTypeName: "Swift.String",
      throws: false,
      thrownTypeName: null,
      isAsync: false,
      genericParams: [],
    });
    const absorb = (Swift.type("fixture.Robot") as SwiftClass).$type.instanceMethod("absorb");
    expect(absorb.signature.argTypeNames).toEqual(["__owned fixture.Robot"]);
    expect((Swift.type("fixture.Box") as SwiftClass).$type.instanceMethod("echo").signature.genericParams).toEqual(["A"]);
  });

  test("a bound method resolves its signature's types", () => {
    const move = robot("R2").$method("move", { labels: ["to"] });
    expect(move.signature.labels).toEqual(["to"]);
    expect(move.signature.argTypes.map((t) => t!.name)).toEqual(["Swift.Int"]);
    expect(move.signature.returnType!.name).toBe("Swift.Int");
    expect(robot("R2").$method("rename").signature.returnType).toBe(null);
    const Int = Swift.type("Swift.Int")!;
    const echo = (Swift.type("fixture.Box") as SwiftClass).init().$method("echo", { typeArguments: [Int] });
    expect(echo.signature.argTypeNames).toEqual(["A"]);
    expect(echo.signature.argTypes[0]!.name).toBe("Swift.Int");
    const run = (Swift.type("fixture.ByteSource") as SwiftStruct).$type.instanceMethod("run");
    expect(run.signature.argTypeNames).toEqual(["() -> ()"]);
  });

  test("effects and a typed throw are part of the signature", (ctx) => {
    if (Swift.type("fixture.TypedThrower") === null) ctx.skip("fixture compiled without typed throws (Swift < 6.0)");
    const thrower = (Swift.type("fixture.TypedThrower") as SwiftClass).init(1);
    const scaled = thrower.$method("scaled").signature;
    expect([scaled.throws, scaled.thrownTypeName, scaled.isAsync]).toEqual([true, "fixture.CodedFailure", false]);
    const scaledAsync = thrower.$method("scaledAsync").signature;
    expect([scaledAsync.throws, scaledAsync.isAsync]).toEqual([true, true]);
    expect((Swift.type("fixture.Accumulator") as SwiftStruct).$typeMethod("sumStaticAsync").signature.isAsync).toBe(true);
  });

  test("a generic member found by name resolves the types it can", () => {
    const first = (Swift.type("fixture.Keyed") as SwiftStruct).$typeMethod("first");
    expect(first.signature.genericParams).toEqual(["A"]); // the demangler spells the type's parameter at the method
    expect(first.signature.argTypeNames).toEqual(["A1", "A"]);
    expect(first.signature.argTypes).toEqual([null, null]);
    const label = (Swift.type("fixture.Keyed") as SwiftStruct).$typeMethod("label");
    expect(label.signature.argTypes[0]!.name).toBe("Swift.Int");
  });
});

describe("hooking a member", () => {
  beforeEach(() => { loadFixture(); });

  test("a bound method and a reflected member hook the same code with their own signature", () => {
    const seen: { labels: (string | null)[]; args: SwiftValue[] }[] = [];
    const greet = robot("R2").$method("greet");
    const listener = SwiftInterceptor.attach(greet, {
      onEnter(args) {
        seen.push({ labels: greet.signature.labels, args });
      },
    });
    const viaType = SwiftInterceptor.attach((Swift.type("fixture.Robot") as SwiftClass).$type.instanceMethod("greet"), {
      onLeave(ret) {
        seen.push({ labels: [], args: [ret as SwiftValue] });
      },
    });
    try {
      robot("R2").greet("X");
    } finally {
      listener.detach();
      viaType.detach();
    }
    expect(seen).toEqual([{ labels: [null], args: ["X"] }, { labels: [], args: ["Hello X, I am R2"] }]);
  });

  test("an async bound method hooks its completion", async () => {
    const calc = (Swift.type("fixture.AsyncCalc") as SwiftClass).init(100);
    let seen: CallResult = null;
    const listener = SwiftInterceptor.attachAsync(calc.$method("addAsync"), {
      onComplete(ret) {
        seen = ret;
      },
    });
    try {
      expect(await calc.addAsync(5)).toEqual(int64(105));
    } finally {
      listener.detach();
    }
    expect(seen).toEqual(int64(105));
  });

  test("a generic member hooks without type arguments and reads them per call", () => {
    const Int = Swift.type("Swift.Int")!;
    const box = (Swift.type("fixture.Box") as SwiftClass).init();
    let seen: string[] | null = null;
    const listener = SwiftInterceptor.attach(box.$type.instanceMethod("echo"), {
      onEnter() {
        seen = this.typeArguments ?? null;
      },
    });
    try {
      box.$method("echo", { typeArguments: [Int] }).call(3);
    } finally {
      listener.detach();
    }
    expect(seen).toEqual(["Swift.Int"]);
  });

  test("a protocol-dispatched member and a plain object are refused", () => {
    const describer = (Swift.type("fixture.DefaultDescriber") as SwiftStruct).$new({ displayName: "Ada" });
    expect(() => SwiftInterceptor.attach(describer.$method("shout"), { onEnter() {} })).toThrow(/protocol witness/);
    expect(() => SwiftInterceptor.attach({ address: ptr(1) } as never, { onEnter() {} })).toThrow(/hook target/);
  });
});

import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms, loadOptimized, fixtureExport } from "./fixtures/load.js";

import { Swift, SwiftObject, type CallResult, SwiftClass, SwiftStruct } from "../src/index.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";
import { metadataFor } from "../src/abi.js";

function robot(name: string): SwiftObject {
  return (Swift.type("fixture.Robot") as SwiftClass).init(name);
}

function accumulator(total: number): SwiftObject {
  return (Swift.type("fixture.Accumulator") as SwiftStruct).$new({ total });
}

describe("Interceptor self", () => {
  beforeEach(() => { loadFixture(); });

  test("a class method's self is a facade over the receiver", () => {
    const ada = robot("Ada");
    let seen: SwiftObject | null = null;
    const listener = Swift.Interceptor.attach(ada.$method("greet").address, {
      onEnter() {
        seen = this.self as SwiftObject;
      },
    });
    ada.greet("X");
    listener.detach();
    expect(seen!.$handle.equals(ada.$handle)).toBe(true);
    expect(seen!.name).toBe("Ada");
  });

  test("a small value's borrowing self is read from the trailing arguments", () => {
    const acc = accumulator(5);
    let seen: CallResult = null;
    const listener = Swift.Interceptor.attach(acc.$method("peek").address, {
      onEnter() {
        seen = this.self!;
      },
    });
    acc.peek(10);
    listener.detach();
    expect(seen).toEqual({ total: int64(5) });
  });

  test("a mutating self is read through swiftself, and again on leave", () => {
    const acc = accumulator(5);
    const seen: CallResult[] = [];
    const listener = Swift.Interceptor.attach(acc.$method("add").address, {
      onEnter() {
        seen.push(this.self!);
      },
      onLeave() {
        seen.push(this.self!);
      },
    });
    acc.add(3);
    listener.detach();
    expect(seen).toEqual([{ total: int64(5) }, { total: int64(8) }]);
  });

  test("a setter's self is mutating and a getter's borrowing", () => {
    const gauge = (Swift.type("fixture.Gauge") as SwiftStruct).$new({ raw: 0 });
    const seen: CallResult[] = [];
    const setter = Swift.Interceptor.attach(fixtureExport("fixture.Gauge.level.setter"), {
      onLeave() {
        seen.push(this.self!);
      },
    });
    const getter = Swift.Interceptor.attach(fixtureExport("fixture.Gauge.level.getter"), {
      onLeave() {
        seen.push(this.self!);
      },
    });
    gauge.level = 5;
    expect(gauge.level).toEqual(int64(11));
    setter.detach();
    getter.detach();
    expect(seen).toEqual([{ raw: int64(12) }, { raw: int64(12) }]);
  });

  test("a large value's self is read through swiftself", () => {
    const big = (Swift.type("fixture.BigStruct") as SwiftStruct).$new({ a: 1, b: 2, c: 3, d: 4, e: 5 });
    let seen: CallResult = null;
    const listener = Swift.Interceptor.attach(big.$method("total").address, {
      onEnter() {
        seen = this.self!;
      },
    });
    expect(big.total()).toEqual(int64(15));
    listener.detach();
    expect(seen).toEqual({ a: int64(1), b: int64(2), c: int64(3), d: int64(4), e: int64(5) });
  });

  test("a generic method's arguments decode past a trailing self", () => {
    const Int = Swift.type("Swift.Int")!;
    const box = (Swift.type("fixture.SmallGenericBox") as SwiftStruct).$new({ base: 10 });
    const method = box.$method("scaledBy", { typeArguments: [Int] });
    let seen: { self: CallResult; args: unknown[] } | null = null;
    const listener = Swift.Interceptor.attach(method.address, {
      onEnter(args) {
        seen = { self: this.self!, args };
      },
    });
    expect(method.call(3, 7)).toEqual(int64(31));
    listener.detach();
    expect(seen).toEqual({ self: { base: int64(10) }, args: [int64(3), int64(7)] });
  });

  test("a generic struct's self is decoded against the Self metadata passed at entry, on enter and on leave", () => {
    const keyed = Swift.struct("fixture.Keyed<Swift.Int>")!.init(21)!;
    const method = keyed.$method("get");
    const seen: CallResult[] = [];
    const listener = Swift.Interceptor.attach(method.address, {
      onEnter() {
        seen.push(this.self!);
      },
      onLeave() {
        seen.push(this.self!);
      },
    });
    expect(method.call()).toEqual(int64(21));
    listener.detach();
    expect(seen).toEqual([{ value: int64(21) }, { value: int64(21) }]);
  });

  test("an onLeave-only hook reads a generic struct's Self metadata on enter for its self", () => {
    loadFixtureSyms();
    const keyed = Swift.struct("fixturesyms.Keyed<Swift.Int>")!.init(8)!;
    const method = keyed.$method("get");
    let seen: CallResult = null;
    const listener = Swift.Interceptor.attach(method.address, {
      onLeave() {
        seen = this.self!;
      },
    });
    expect(method.call()).toEqual(int64(8));
    listener.detach();
    expect(seen).toEqual({ value: int64(8) });
  });

  test("a generic class's self is a facade over the receiver", () => {
    const seen: unknown[] = [];
    const listener = Swift.Interceptor.attach(Swift.class("fixture.KeyedHolder")!.$type.instanceMethod("paired").address, {
      onLeave() {
        seen.push((this.self as SwiftObject).$fields, (this.self as SwiftObject).$type.name, this.typeArguments);
      },
    });
    try {
      makeSwiftNativeFunction(fixtureExport("fixture.driveKeyed"), metadataFor("Swift.Int")!, [])();
    } finally {
      listener.detach();
    }
    expect(seen).toEqual([{ value: "e" }, "fixture.KeyedHolder<Swift.String>", ["Swift.String", "Swift.Int"]]);
  });

  test("a generic method whose code doesn't reveal self's convention needs { self }", () => {
    loadOptimized();
    const Int = Swift.type("Swift.Int")!;
    const counter = (Swift.type("optimized.Counter") as SwiftStruct).$new({ total: 3 });
    const method = counter.$method("ignore", { typeArguments: [Int], self: "borrowing" });
    expect(() => Swift.Interceptor.attach(method.address, { onEnter() {} })).toThrow("pass { self");
  });

  test("a hook that decodes nothing needs no self convention", () => {
    const Int = Swift.type("Swift.Int")!;
    const box = (Swift.type("fixture.SmallGenericBox") as SwiftStruct).$new({ base: 1 });
    const method = box.$method("scaledByAsync", { typeArguments: [Int], self: "borrowing" });
    Swift.Interceptor.attachAsync(method.address, { onFirstSuspend() {} }).detach();
  });

  test("an onLeave-only hook reads a class self from swiftself on leave", () => {
    const ada = robot("Ada");
    let seen: SwiftObject | null = null;
    const listener = Swift.Interceptor.attach(ada.$method("greet").address, {
      onLeave() {
        seen = this.self as SwiftObject;
      },
    });
    ada.greet("X");
    listener.detach();
    expect(seen!.name).toBe("Ada");
  });

  test("a stated self convention is used as given", () => {
    const Int = Swift.type("Swift.Int")!;
    const box = (Swift.type("fixture.SmallGenericBox") as SwiftStruct).$new({ base: 10 });
    const method = box.$method("echo", { typeArguments: [Int], self: "borrowing" });
    let seen: { self: CallResult; args: unknown[] } | null = null;
    const listener = Swift.Interceptor.attach(
      method.address,
      {
        onEnter(args) {
          seen = { self: this.self!, args };
        },
      },
      { self: "borrowing" }
    );
    expect(method.call(8)).toEqual(int64(8));
    listener.detach();
    expect(seen).toEqual({ self: { base: int64(10) }, args: [int64(8)] });
  });

  test("a free function has no self", () => {
    let seen: CallResult | undefined = null;
    const listener = Swift.Interceptor.attach(fixtureExport("fixture.addInts"), {
      onEnter() {
        seen = this.self;
      },
    });
    Swift.NativeFunction(fixtureExport("fixture.addInts"), Swift.type("Swift.Int"), [Swift.type("Swift.Int")!, Swift.type("Swift.Int")!])(1, 2);
    listener.detach();
    expect(seen).toBe(undefined);
  });

  test("an async class method's self is set on enter", async () => {
    const calc = (Swift.type("fixture.AsyncCalc") as SwiftClass).init(100);
    let seen: SwiftObject | null = null;
    const listener = Swift.Interceptor.attachAsync(calc.$method("addAsync").address, {
      onEnter() {
        seen = this.self as SwiftObject;
      },
    });
    expect(await calc.addAsync(5)).toEqual(int64(105));
    listener.detach();
    expect(seen!.base).toEqual(int64(100));
  });
});

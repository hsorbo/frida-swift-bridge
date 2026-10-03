import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, SwiftClass, SwiftStruct, type SwiftObject, type SwiftValueObject, type CallResult } from "../src/index.js";
import { SwiftInterceptor } from "../src/runtime/interceptor.js";

function robot(name: string): SwiftObject {
  return (Swift.type("fixture.Robot") as SwiftClass).init(name);
}

function int(n: number): SwiftObject {
  return (Swift.type("Swift.Int") as SwiftStruct).$new(n);
}

describe("hooks on functions with inout parameters", () => {
  beforeEach(() => { loadFixture(); });

  test("an inout argument is a facade over the caller's storage, writable before and readable after", () => {
    const n = int(21);
    let entered: SwiftValueObject | null = null;
    let left: CallResult = null;
    const listener = SwiftInterceptor.attach(robot("Ada").$method("doubled").address, {
      onEnter(args) {
        entered = args[0] as SwiftValueObject;
        expect(entered.$fields).toEqual(int64(21));
        expect(entered.$handle.equals(n.$handle)).toBe(true);
        entered.$handle.writeS64(5);
      },
      onLeave() {
        left = entered!.$fields;
      },
    });
    try {
      robot("Ada").doubled(n);
    } finally {
      listener.detach();
    }
    expect(left).toEqual(int64(10));
    expect(n.$fields).toEqual(int64(10));
  });

  test("a non-POD inout argument reads before and after the callee's write", () => {
    const s = (Swift.type("Swift.String") as SwiftStruct).$new("hi");
    const seen: CallResult[] = [];
    let view: SwiftValueObject | null = null;
    const listener = SwiftInterceptor.attach(robot("Ada").$method("exclaim").address, {
      onEnter(args) {
        view = args[0] as SwiftValueObject;
        seen.push(view.$fields);
      },
      onLeave() {
        seen.push(view!.$fields);
      },
    });
    try {
      robot("Ada").exclaim(s);
    } finally {
      listener.detach();
    }
    expect(seen).toEqual(["hi", "hi!"]);
  });

  test("a generic method's inout arguments decode by its type arguments", () => {
    const Int = Swift.type("Swift.Int")!;
    const a = int(1);
    const b = int(2);
    const seen: CallResult[][] = [];
    let views: SwiftValueObject[] = [];
    const box = (Swift.type("fixture.Box") as SwiftClass).init();
    const listener = SwiftInterceptor.attach(box.$method("swapped", { typeArguments: [Int] }).address, {
      onEnter(args) {
        expect(this.typeArguments).toEqual(["Swift.Int"]);
        views = args as SwiftValueObject[];
        seen.push(views.map((v) => v.$fields));
      },
      onLeave() {
        seen.push(views.map((v) => v.$fields));
      },
    });
    try {
      box.$method("swapped", { typeArguments: [Int] }).call(a, b);
    } finally {
      listener.detach();
    }
    expect(seen).toEqual([[int64(1), int64(2)], [int64(2), int64(1)]]);
  });

  test("an async hook sees the inout argument on entry and its update on completion", async () => {
    const n = int(5);
    const calc = (Swift.type("fixture.AsyncCalc") as SwiftClass).init(100);
    const seen: CallResult[] = [];
    let view: SwiftValueObject | null = null;
    const listener = SwiftInterceptor.attachAsync(calc.$method("accumulateAsync").address, {
      onEnter(args) {
        view = args[0] as SwiftValueObject;
        seen.push(view.$fields);
      },
      onComplete() {
        seen.push(view!.$fields);
      },
    });
    try {
      await calc.accumulateAsync(n);
    } finally {
      listener.detach();
    }
    expect(seen).toEqual([int64(5), int64(105)]);
  });
});

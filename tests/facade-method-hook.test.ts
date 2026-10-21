import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, SwiftClass, type SwiftObject, type CallResult } from "../src/index.js";

function robotType(): SwiftClass {
  return Swift.type("fixture.Robot") as SwiftClass;
}

function robot(name: string): SwiftObject {
  return robotType().init(name)!;
}

describe("a facade's method as a hook target", () => {
  beforeEach(() => { loadFixture(); });

  test("carries the address, origin and signature of the member it names", () => {
    const r = robot("Ada");
    const bound = r.$method("greet");
    expect(r.greet).toBe(r.greet);
    expect(r.greet.address.equals(bound.address)).toBe(true);
    expect(r.greet.origin).toEqual(bound.origin);
    expect(r.greet.signature.argTypeNames).toEqual(["Swift.String"]);
    expect(r.greet("Bob")).toBe("Hello Bob, I am Ada");
  });

  test("hooks through Swift.Interceptor.attach like the bound method", () => {
    const seen: CallResult[] = [];
    const listener = Swift.Interceptor.attach(robot("Ada").greet, {
      onEnter(args) {
        seen.push(args[0]);
      },
    });
    try {
      expect(robot("Eve").greet("Bob")).toBe("Hello Bob, I am Eve");
    } finally {
      listener.detach();
    }
    expect(seen).toEqual(["Bob"]);
  });

  test("an overloaded name still calls by arity but refuses an address", () => {
    const r = robot("Ada");
    expect(r.at(1)).toEqual(int64(1));
    expect(r.at(1, 2)).toEqual(int64(3));
    expect(() => r.at.address).toThrow(/ambiguous method at on fixture\.Robot/);
    expect(() => Swift.Interceptor.attach(r.at, { onEnter() {} })).toThrow(/ambiguous method at/);
  });

  test("a bound initializer and a bound type method are hook targets", () => {
    const seen: CallResult[] = [];
    const listener = Swift.Interceptor.attach(robotType().$initializer("init(name:)"), {
      onEnter(args) {
        seen.push(args[0]);
      },
    });
    try {
      expect(robotType().$initializer("init(name:)").call("Ada")!.name).toBe("Ada");
    } finally {
      listener.detach();
    }
    expect(seen).toEqual(["Ada"]);

    const dialInit = Swift.struct("fixture.Dial")!.$initializer("init(value:)");
    const keyedInit = Swift.struct("fixture.Keyed<Swift.Int>")!.$initializer("init(_:)");
    const make = robotType().$typeMethod("make(name:)");
    for (const [target, arg, expected] of [[dialInit, 7, int64(7)], [keyedInit, 5, int64(5)], [make, "Eve", "Eve"]] as const) {
      seen.length = 0;
      const l = Swift.Interceptor.attach(target, {
        onEnter(args) {
          seen.push(args[0]);
        },
      });
      try {
        target.call(arg);
      } finally {
        l.detach();
      }
      expect(seen).toEqual([expected]);
    }
  });

  test("a type facade's static method is hookable the same way", () => {
    const type = robotType();
    expect(type.make.address.equals(type.$typeMethod("make").address)).toBe(true);
    const listener = Swift.Interceptor.attach(type.make, { onEnter() {} });
    listener.detach();
  });
});

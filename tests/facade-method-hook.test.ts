import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, SwiftClass, type SwiftObject, type SwiftValue } from "../src/index.js";
import { SwiftInterceptor } from "../src/runtime/interceptor.js";

function robotType(): SwiftClass {
  return Swift.type("fixture.Robot") as SwiftClass;
}

function robot(name: string): SwiftObject {
  return robotType().init(name);
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
    const seen: SwiftValue[] = [];
    const listener = SwiftInterceptor.attach(robot("Ada").greet, {
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
    expect(() => SwiftInterceptor.attach(r.at, { onEnter() {} })).toThrow(/ambiguous method at/);
  });

  test("a type facade's static method is hookable the same way", () => {
    const type = robotType();
    expect(type.make.address.equals(type.$typeMethod("make").address)).toBe(true);
    const listener = SwiftInterceptor.attach(type.make, { onEnter() {} });
    listener.detach();
  });
});

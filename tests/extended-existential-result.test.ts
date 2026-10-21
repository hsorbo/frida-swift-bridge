import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { fixtureExport, compiledType, loadFixture } from "./fixtures/load.js";

import { ClassInstance } from "../src/abi.js";
import { Swift, type SwiftValueObject } from "../src/index.js";

describe("a parameterized existential result", () => {
  beforeEach(() => { loadFixture(); });

  test("a struct payload is a facade of its own type whose members answer", () => {
    const Holder = compiledType("fixture.holderIntType");
    const holder = Swift.NativeFunction(fixtureExport("fixture.makeHolderInt"), Holder, [])() as SwiftValueObject;
    expect([holder.$kind, holder.$owned, holder.$type.name]).toEqual(["value", true, "fixture.IntHolder"]);
    expect(holder.$fields).toEqual({ item: int64(42) });
    expect(holder.item).toEqual(int64(42));
    expect(holder.tag).toEqual(int64(84));
  });

  test("a reference-bearing struct payload owns its reference until disposed", () => {
    const Holder = compiledType("fixture.holderIntType");
    const Int = Swift.type("Swift.Int")!;
    const token = Swift.class("fixture.Token")!.init(4)!;
    const count = new ClassInstance(token.$handle);
    const before = count.retainCount;
    const make = Swift.NativeFunction(fixtureExport("fixture.makeTokenHolderInt"), Holder, [Swift.type("fixture.Token")!, Int]);
    const holder = make(token, 3) as SwiftValueObject;
    expect(holder.$type.name).toBe("fixture.TokenHolder");
    expect(count.retainCount).toBe(before + 1);
    expect(holder.tag).toEqual(int64(7));
    holder.$dispose();
    expect(count.retainCount).toBe(before);
  });

  test("a class payload stays boxed and alive until the facade is disposed", () => {
    const Holder = compiledType("fixture.holderIntType");
    const Int = Swift.type("Swift.Int")!;
    const holder = Swift.NativeFunction(fixtureExport("fixture.makeClassHolderInt"), Holder, [Int])(5) as SwiftValueObject;
    expect([holder.$kind, holder.$owned]).toEqual(["value", true]);
    holder.$dispose();
  });
});

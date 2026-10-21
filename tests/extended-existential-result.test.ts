import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { fixtureExport, compiledType, loadFixture } from "./fixtures/load.js";

import { ClassInstance } from "../src/abi.js";
import { Swift, type SwiftClassObject, type SwiftValueObject } from "../src/index.js";

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

  test("a hook observes the payload as a borrowed facade of its own type", () => {
    const addr = fixtureExport("fixture.makeHolderInt");
    let seen: unknown[] | null = null;
    const listener = Swift.Interceptor.attach(addr, {
      onLeave(ret) {
        const holder = ret as SwiftValueObject;
        seen = [holder.$kind, holder.$owned, holder.$type.name, holder.item, holder.tag];
      },
    });
    Swift.NativeFunction(addr, compiledType("fixture.holderIntType"), [])();
    listener.detach();
    expect(seen).toEqual(["value", false, "fixture.IntHolder", int64(42), int64(84)]);
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

  test("a class payload is the dynamic object, owned by its facade alone", () => {
    const Holder = compiledType("fixture.holderIntType");
    const Int = Swift.type("Swift.Int")!;
    const holder = Swift.NativeFunction(fixtureExport("fixture.makeClassHolderInt"), Holder, [Int])(5) as SwiftClassObject;
    expect([holder.$kind, holder.$owned, holder.$type.name]).toEqual(["object", true, "fixture.ClassIntHolder"]);
    expect(holder.item).toEqual(int64(5));
    expect(holder.tag).toEqual(int64(5));
    expect(new ClassInstance(holder.$handle).retainCount).toBe(1);
    holder.$dispose();
  });

  test("a hook observes a class payload as a borrowed object", () => {
    const addr = fixtureExport("fixture.makeClassHolderInt");
    let seen: unknown[] | null = null;
    const listener = Swift.Interceptor.attach(addr, {
      onLeave(ret) {
        const holder = ret as SwiftClassObject;
        seen = [holder.$kind, holder.$owned, holder.$type.name, holder.item, holder.tag];
      },
    });
    Swift.NativeFunction(addr, compiledType("fixture.holderIntType"), [Swift.type("Swift.Int")!])(6);
    listener.detach();
    expect(seen).toEqual(["object", false, "fixture.ClassIntHolder", int64(6), int64(6)]);
  });
});

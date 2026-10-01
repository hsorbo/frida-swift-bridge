import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, ClassType, EnumType, StructType } from "../src/index.js";

describe("Swift type member sugar", () => {
  beforeEach(() => { loadFixture(); });

  test("calls a type method by its bare name", () => {
    const Robot = Swift.type("fixture.Robot") as ClassType;
    expect(Robot.make("Zed").greet("Ann")).toBe("Hello Ann, I am Zed");
    expect(Swift.type("fixture.Accumulator")!.summing(4, 5)).toEqual(int64(9));
    expect(Swift.type("fixture.Pick")!.tag(21)).toEqual(int64(42));
  });

  test("$call mirrors the bare-name call", () => {
    const Accumulator = Swift.type("fixture.Accumulator")!;
    expect(Accumulator.$call("summing", 1, 2)).toEqual(Accumulator.summing(1, 2));
  });

  test("an async type method returns a promise", async () => {
    expect(await Swift.type("fixture.Accumulator")!.sumStaticAsync(4, 5)).toEqual(int64(9));
  });

  test("reads static properties by bare name, a protocol extension's included", () => {
    const Duckling = Swift.type("fixture.Duckling")!;
    expect(Duckling.flockSize).toEqual(int64(12));
    expect(Duckling.motto).toBe("quack");
    expect(Duckling.species).toBe("duck");
    expect(Duckling.nursery).toBe("duck nursery");
  });

  test("$set mirrors assignment to a static var", () => {
    const Duckling = Swift.type("fixture.Duckling")!;
    Duckling.$set("flockSize", 14);
    try {
      expect(Duckling.$get("flockSize")).toEqual(int64(14));
    } finally {
      Duckling.flockSize = 12;
    }
    expect(() => Duckling.$set("motto", "quark")).toThrow("no static setter for motto on fixture.Duckling");
  });

  test("assigns a static var through its setter; a let and an unknown name throw", () => {
    const Duckling = Swift.type("fixture.Duckling")!;
    Duckling.flockSize = 13;
    try {
      expect(Duckling.flockSize).toEqual(int64(13));
    } finally {
      Duckling.flockSize = 12;
    }
    expect(() => { Duckling.motto = "quark"; }).toThrow("motto on fixture.Duckling is read-only");
    expect(() => { Duckling.nope = 1; }).toThrow("no static property nope on fixture.Duckling");
  });

  test("builds enum cases by bare name, a payload case as a call", () => {
    const Pick = Swift.type("fixture.Pick") as EnumType;
    expect(Pick.empty.$fields).toBe("empty");
    expect(Pick.value(7).$fields).toEqual({ value: int64(7) });
    expect(Pick.empty.$type).toBe(Pick);
  });

  test("reaches a nested type, from Swift.modules too", () => {
    const Outer = Swift.modules.fixture.Outer as StructType;
    expect(Outer.Inner).toBe(Swift.type("fixture.Outer.Inner"));
    expect(Outer.FromExt.$name).toBe("fixture.Outer.FromExt");
    expect(Outer.Inner.$new({ value: 21 }).doubled()).toEqual(int64(42));
  });

  test("dispatches a type method through an instance's $type", () => {
    const robot = (Swift.type("fixture.Robot") as ClassType).init("R2");
    expect(robot.$type.make("Q").greet("A")).toBe("Hello A, I am Q");
  });

  test("an unknown member reads as undefined and is not in", () => {
    const Robot = Swift.type("fixture.Robot")!;
    expect(Robot.noSuchMemberQX).toBeUndefined();
    expect("noSuchMemberQX" in Robot).toBe(false);
    expect("make" in Robot).toBe(true);
    expect("$name" in Robot).toBe(true);
    expect("$noSuchQX" in Robot).toBe(false);
  });

  test("lists own type methods, static properties, cases and nested types, consistently with has", () => {
    const pick = Object.keys(Swift.type("fixture.Pick")!);
    expect(pick).toContain("tag");
    expect(pick).toContain("empty");
    expect(pick).toContain("value");
    const outer = Object.keys(Swift.type("fixture.Outer")!);
    expect(outer).toContain("Inner");
    expect(outer).toContain("FromExt");
    const Duckling = Swift.type("fixture.Duckling")!;
    const duckling = Object.keys(Duckling);
    expect(duckling).toContain("flockSize");
    expect(duckling).toContain("species");
    expect(Duckling.nursery).toBe("duck nursery"); // another module's or a protocol extension's joins the listing once read
    expect(Object.keys(Duckling)).toContain("nursery");
    expect(duckling).not.toContain("$name");
    for (const k of duckling) {
      expect(k in Duckling).toBe(true);
    }
    expect(Object.getOwnPropertyDescriptor(Duckling, "flockSize")!.writable).toBe(true);
    expect(Object.getOwnPropertyDescriptor(Duckling, "motto")!.writable).toBe(false);
  });

  test("never becomes thenable, so await hands the type back", async () => {
    const Robot = Swift.type("fixture.Robot")!;
    expect(await Robot).toBe(Robot);
    expect("then" in Robot).toBe(false);
  });

  test("toString and JSON stay the type's identity", () => {
    const Robot = Swift.type("fixture.Robot")!;
    expect(String(Robot)).toBe("fixture.Robot");
    expect(JSON.parse(JSON.stringify(Robot))).toEqual({ kind: "class", name: "fixture.Robot", module: "fixture" });
  });
});

describe("Swift type collision-proofing", () => {
  beforeEach(() => { loadFixture(); });

  test("bare names reach type members that clash with the bridge's spellings", () => {
    const Clashing = Swift.type("fixture.ClashingType")!;
    expect(Clashing.name).toBe("clash");            // static property, not the type's name
    expect(Clashing.get()).toBe("got");             // type method named get, not the property reader
    expect(Clashing.call()).toEqual(int64(14));     // type method named call, not the bridge invoker
  });

  test("$-prefixed members stay available alongside the clashing ones", () => {
    const Clashing = Swift.type("fixture.ClashingType")!;
    expect(Clashing.$name).toBe("fixture.ClashingType");
    expect(Clashing.$get("name")).toBe("clash");
    expect(Clashing.$call("get")).toBe("got");
  });

  test("a reserved name keeps the bridge's meaning; $call reaches the Swift member", () => {
    const Clashing = Swift.type("fixture.ClashingType")!;
    expect(Clashing.toString()).toBe("fixture.ClashingType");
    expect(Clashing.$call("toString")).toBe("swift");
  });

  test("bridge spellings are not leaked when no Swift member shadows them", () => {
    const Robot = Swift.type("fixture.Robot")!;
    expect(Robot.name).toBeUndefined();
    expect(Robot.get).toBeUndefined();
    expect(Robot.call).toBeUndefined();
  });
});

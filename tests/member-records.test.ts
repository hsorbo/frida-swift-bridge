import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, type SwiftClass, type SwiftMemberRecord } from "../src/index.js";

// One record per overload, carrying what selects it; the selector lists are these records' selectors.
describe("members()", () => {
  beforeEach(() => {
    loadFixture();
  });

  function robotMembers(): SwiftMemberRecord[] {
    return Swift.class("fixture.Robot")!.$type.members();
  }

  test("lists one record per overload, each selectable by what it carries", () => {
    const Robot = Swift.class("fixture.Robot")!.$type;
    const picks = robotMembers().filter((m) => m.selector === "pick()");
    expect(picks.map((m) => String(m.signature!.returnTypeName)).sort()).toEqual(["Swift.Int", "Swift.String", "null"]);
    for (const pick of picks) {
      const found = Robot.instanceMethod("pick()", { returnType: pick.signature!.returnTypeName });
      expect(found.address.equals(pick.address)).toBe(true);
      expect([pick.kind, pick.accessor, pick.isStatic, pick.isGeneric, pick.origin]).toEqual(["method", null, false, false, found.origin]);
    }
    const tagged = robotMembers().filter((m) => m.selector === "tagged(_:)");
    expect(tagged.map((m) => m.signature!.argTypeNames[0]).sort()).toEqual(["Swift.Int", "Swift.String"]);
    for (const t of tagged) {
      expect(Robot.instanceMethod("tagged(_:)", { argTypes: t.signature!.argTypeNames }).address.equals(t.address)).toBe(true);
    }
  });

  test("lists initializers once, as the type's initializer finds them, and type methods as static", () => {
    const Robot = Swift.class("fixture.Robot")!.$type;
    const inits = robotMembers().filter((m) => m.kind === "init");
    expect(inits.map((m) => m.selector)).toEqual(["init(name:)"]);
    expect(Robot.initializer("init(name:)").address.equals(inits[0].address)).toBe(true);
    const make = robotMembers().find((m) => m.selector === "make(name:)")!;
    expect([make.kind, make.isStatic]).toEqual(["method", true]);
    expect(Robot.typeMethod("make(name:)").address.equals(make.address)).toBe(true);
  });

  test("lists constrained-extension overloads as the lookup sees them: all on the unbound type, the matching ones on a specialization", () => {
    const presses = (name: string): string[] =>
      Swift.struct(name)!.$type.members().filter((m) => m.selector === "init(_:action:)").map((m) => m.signature!.argTypeNames[0]).sort();
    expect(presses("fixture.Pressable")).toEqual(["Swift.Double", "Swift.Int", "Swift.String"]);
    expect(presses("fixture.Pressable<Swift.Int>")).toEqual(["Swift.Int"]);
    expect(presses("fixture.Pressable<Swift.Double>")).toEqual(["Swift.Double"]);
  });

  test("lists subscript accessors by kind, as the type's subscript finds them", () => {
    const Grid = Swift.struct("fixture.Grid")!.$type;
    const cells = Grid.members().filter((m) => m.kind === "subscript" && m.selector === "subscript(row:column:)");
    expect(cells.map((m) => m.accessor).sort()).toEqual(["getter", "setter"]);
    const getter = cells.find((m) => m.accessor === "getter")!;
    expect(Grid.subscript("subscript(row:column:)").address.equals(getter.address)).toBe(true);
    expect(getter.signature!.labels).toEqual(["row", "column"]);
  });

  test("the selector lists are the records' selectors by kind, shallow and deep alike", () => {
    const Robot = Swift.class("fixture.Robot")!.$type;
    for (const query of [{}, { deep: true }, { inherited: false }]) {
      const records = Robot.members(query);
      expect(Robot.instanceMethods(query)).toEqual(records.filter((m) => m.kind === "method" && !m.isStatic).map((m) => m.selector));
      expect(Robot.typeMethods(query)).toEqual(records.filter((m) => m.kind === "method" && m.isStatic).map((m) => m.selector));
    }
  });

  test("a slot no symbol names is a record with a null signature", () => {
    const slots = Swift.class("fixture.Dispatcher")!.$type.members().filter((m) => /^vtable#\d+$/.test(m.selector));
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((m) => m.signature === null && m.kind === "method" && m.accessor === null)).toBe(true);
  });

  test("a record hooks as a found member does", () => {
    const robot = (Swift.class("fixture.Robot") as SwiftClass).init("R2")!;
    const greet = robotMembers().find((m) => m.selector === "greet(_:)")!;
    let seen: unknown = null;
    const listener = Swift.Interceptor.attach(greet, {
      onEnter(args) {
        seen = args[0];
      },
    });
    try {
      expect(robot.greet("you")).toBe("Hello you, I am R2");
    } finally {
      listener.detach();
    }
    expect(seen).toBe("you");
  });
});

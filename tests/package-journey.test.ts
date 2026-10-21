import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import Swift, { SwiftError, type SwiftClass, type SwiftClassObject, type SwiftStruct } from "frida-swift-bridge2";

// A user's path through the built package, by its root entry point alone: find a type, construct,
// call, mutate, catch a throw, observe a call through a hook, keep what the hook showed, release.
describe("the published package, end to end", () => {
  beforeEach(() => {
    loadFixture();
  });

  test("finds a type by three routes and lists what it declares", () => {
    expect(Swift.available).toBe(true);
    const Robot = Swift.class("fixture.Robot")!;
    expect(Swift.type("fixture.Robot") === Robot).toBe(true);
    expect(Swift.modules.fixture.Robot === Robot).toBe(true);
    expect(Robot.$type.members().some((m) => m.selector === "greet(_:)" && m.kind === "method" && !m.isStatic)).toBe(true);
    expect(Robot.$type.properties().map((p) => p.name).sort()).toEqual(["badge", "name"]);
  });

  test("constructs, calls, mutates and reads back", () => {
    const robot = (Swift.class("fixture.Robot") as SwiftClass).init("R2")!;
    expect(robot.greet("Alice")).toBe("Hello Alice, I am R2");
    robot.rename("R3");
    expect(robot.name).toBe("R3");
    robot.badge = "D2";
    expect(robot.name).toBe("D2");
    robot.$dispose();

    const acc = (Swift.struct("fixture.Accumulator") as SwiftStruct).$new({ total: 5 });
    expect(acc.peek(10)).toEqual(int64(15));
    acc.add(3);
    expect([acc.total, acc.$fields]).toEqual([int64(8), { total: int64(8) }]);
    acc.$dispose();
  });

  test("awaits an async method and catches a Swift throw as SwiftError", async () => {
    const calc = Swift.class("fixture.AsyncCalc")!.init(100)!;
    expect(await calc.addAsync(5)).toEqual(int64(105));
    await expect(calc.divideBaseBy(0)).rejects.toThrow(SwiftError);
  });

  test("observes a call through a hook and keeps what it showed past the hook", () => {
    const Robot = Swift.class("fixture.Robot") as SwiftClass;
    const robot = Robot.init("A")!;
    const other = Robot.init("B")!;
    const retainCount = (): number => Number(Swift.api.swift_retainCount(other.$handle));
    const before = retainCount();
    let seen: unknown[] = [];
    let kept: SwiftClassObject | null = null;
    const listener = Swift.Interceptor.attach(robot.merged, {
      onEnter(args) {
        const arg = args[0] as SwiftClassObject;
        seen.push(arg.$owned, arg.name);
        kept = arg.$retained();
      },
      onLeave(ret) {
        seen.push(ret);
      },
    });
    try {
      expect(robot.merged(other)).toBe("A+B");
    } finally {
      listener.detach();
    }
    expect(seen).toEqual([false, "B", "A+B"]);
    expect([kept!.$owned, kept!.name, retainCount()]).toEqual([true, "B", before + 1]);
    kept!.$dispose();
    expect(retainCount()).toBe(before);
  });

  test("a protocol names what it requires and who conforms", () => {
    const greeter = Swift.Protocol.find("fixture.Greeter")!;
    expect(greeter.conformingTypes().map((t) => t.name)).toContain("fixture.Person");
    expect(greeter.requirements().map((r) => r.kind)).toEqual(["method"]);
    expect(Swift.struct("fixture.Person")!.$type.conformsTo(greeter)).toBe(true);
  });
});

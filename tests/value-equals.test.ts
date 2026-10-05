import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";
import { requireSymbolTable } from "./swift.js";

import { Swift } from "../src/index.js";

describe("facade equals", () => {
  beforeEach(() => { loadFixture(); });

  test("a POD struct compares through its synthesized ==", (ctx) => {
    requireSymbolTable(ctx);
    const GridPoint = Swift.struct("fixture.GridPoint")!;
    expect(GridPoint.$new({ x: 1, y: 2 }).equals(GridPoint.$new({ x: 1, y: 2 }))).toBe(true);
    expect(GridPoint.$new({ x: 1, y: 2 }).equals(GridPoint.$new({ x: 2, y: 1 }))).toBe(false);
  });

  test("a String-holding struct compares its contents", (ctx) => {
    requireSymbolTable(ctx);
    const TaggedCount = Swift.struct("fixture.TaggedCount")!;
    expect(TaggedCount.$new({ tag: "a long enough tag to live on the heap", n: 1 }).equals(TaggedCount.$new({ tag: "a long enough tag to live on the heap", n: 1 }))).toBe(true);
    expect(TaggedCount.$new({ tag: "a", n: 1 }).equals(TaggedCount.$new({ tag: "b", n: 1 }))).toBe(false);
  });

  test("a custom == decides, not the storage", (ctx) => {
    requireSymbolTable(ctx);
    const Approx = Swift.struct("fixture.Approx")!;
    const one = Approx.$new({ v: 1.0 });
    expect(one.equals(Approx.$new({ v: 1.2 }))).toBe(true);
    expect(one.equals(Approx.$new({ v: 2.0 }))).toBe(false);
  });

  test("a value of another type is never equal", () => {
    expect(Swift.struct("fixture.GridPoint")!.$new({ x: 1, y: 2 }).equals(Swift.struct("fixture.TaggedCount")!.$new({ tag: "x", n: 1 }))).toBe(false);
  });

  test("a value type without an Equatable conformance throws, naming the structural alternative", () => {
    const Selectors = Swift.struct("fixture.Selectors")!;
    expect(() => Selectors.$new({ n: 3 }).equals(Selectors.$new({ n: 3 }))).toThrow(/fixture\.Selectors does not conform to Swift\.Equatable.*ValueInstance\.equals/);
  });

  test("a class facade compares identity", () => {
    const Robot = Swift.class("fixture.Robot")!;
    const robot = Robot.init("R2");
    expect(robot.equals(Swift.borrowObject(robot.$handle))).toBe(true);
    expect(robot.equals(Robot.init("R2"))).toBe(false);
  });
});

import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadNoMetadata } from "./fixtures/load.js";

import { Swift, SwiftClass, SwiftStruct } from "../src/index.js";

describe("member listing depth and lookup scope", () => {
  beforeEach(() => {
    loadFixture();
    loadNoMetadata();
  });

  test("listing is shallow by default and deep on request", () => {
    const Robot = (Swift.type("fixture.Robot") as SwiftClass).$type;
    expect(Robot.instanceMethods()).toContain("greet(_:)");
    expect(Robot.instanceMethods()).not.toContain("fly()");
    expect(Robot.instanceMethods({ deep: true })).toContain("fly()");
    const Describer = (Swift.type("fixture.DefaultDescriber") as SwiftStruct).$type;
    expect(Describer.instanceMethods()).not.toContain("shout()");
    expect(Describer.instanceMethods({ deep: true })).toContain("shout()");
    expect(Describer.properties().map((p) => p.name)).toEqual(["displayName"]);
    expect(Describer.properties({ deep: true }).map((p) => p.name)).toContain("initial");
    expect(Object.keys((Swift.type("fixture.Robot") as SwiftClass).init("R2"))).not.toContain("fly");
  });

  test("lookup by name reaches other modules unless deep is false", () => {
    const robot = (Swift.type("fixture.Robot") as SwiftClass).init("R2");
    expect(robot.$method("fly").origin.kind).toBe("extension");
    expect(() => robot.$method("fly", { deep: false })).toThrow(/no method fly/);
    expect(robot.$method("greet", { deep: false }).call("X")).toBe("Hello X, I am R2");
    const describer = (Swift.type("fixture.DefaultDescriber") as SwiftStruct).$new({ displayName: "Ada" });
    expect(describer.$method("shout").origin.kind).toBe("protocolExtension");
    expect(() => describer.$method("shout", { deep: false })).toThrow(/no method shout/);
    const Robot = (Swift.type("fixture.Robot") as SwiftClass).$type;
    expect(Robot.instanceMethod("fly").origin.kind).toBe("extension");
    expect(() => Robot.instanceMethod("fly", { deep: false })).toThrow(/no instance method fly/);
    const Duckling = Swift.type("fixture.Duckling") as SwiftStruct;
    expect(Duckling.$typeMethod("hatch").origin.kind).toBe("protocolExtension");
    expect(() => Duckling.$typeMethod("hatch", { deep: false })).toThrow(/no method hatch/);
  });
});

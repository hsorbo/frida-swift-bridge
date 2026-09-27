import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, ClassType, StructType } from "../src/index.js";

describe("protocol-extension members on a conforming type", () => {
  beforeEach(() => { loadFixture(); });

  test("a value type lists and calls its protocol's default and extension method", () => {
    const type = Swift.type("fixture.DefaultDescriber") as StructType;
    expect(type.methods()).toContain("describe()");
    expect(type.methods()).toContain("shout()");

    const describer = type.new({ displayName: "Ada" });
    expect(describer.describe()).toBe("<Ada>");
    expect(describer.shout()).toBe("ADA");
  });

  test("a value type reads its protocol's extension property", () => {
    const type = Swift.type("fixture.DefaultDescriber") as StructType;
    expect(type.properties.map((p) => p.name)).toContain("initial");
    expect(type.new({ displayName: "Ada" }).initial).toBe("A");
  });

  test("the type's own implementation shadows the protocol's default", () => {
    const type = Swift.type("fixture.CustomDescriber") as StructType;
    expect(type.methods().filter((m) => m === "describe()").length).toBe(1);
    expect(type.new({ displayName: "Ada" }).$method("describe", { mutating: false }).call()).toBe("custom:Ada");
  });

  test("a class reaches an extension method of a protocol that is not class-bound", () => {
    const speaker = (Swift.type("fixture.SubSpeaker") as ClassType).init();
    expect(speaker.speakTwice()).toBe("subsub");
  });

  test("a class reaches an extension method of a class-bound protocol", () => {
    const squawker = (Swift.type("fixture.SubSquawker") as ClassType).init();
    expect(squawker.squawkTwice()).toBe("subsub");
  });
});

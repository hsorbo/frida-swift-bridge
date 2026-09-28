import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms } from "./fixtures/load.js";

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

  test("an overloaded extension method is picked by call arity", () => {
    const n = (Swift.type("fixture.NarrowScalar") as StructType).new({ n: 11 });
    expect(n.scaledTwice()).toEqual(int64(22));
  });

  test("an overloaded extension method is picked by labels", () => {
    const n = (Swift.type("fixture.NarrowScalar") as StructType).new({ n: 11 });
    expect(n.$method("scaledTwice", { labels: [null] }).call(3)).toEqual(int64(66));
    expect(n.$method("scaledTwice", { labels: ["by"] }).call(3)).toEqual(int64(67));
  });

  test("an extension method resolves when the requirement's witness thunk inlines the implementation", () => {
    loadFixtureSyms();
    const w = (Swift.type("fixturesyms.WideScalar") as StructType).new({ a: 1, b: 2, c: 3, d: 4, e: 5 });
    expect(w.scaledTwice()).toEqual(int64(30));
  });

  test("an extension method differing from a requirement only in return type is not called through its witness", () => {
    const c = (Swift.type("fixture.IntChooser") as StructType).new({ n: 4 });
    expect(c.$method("choose", { returnType: "Swift.String", mutating: false }).call()).toBe("ext");
    expect(c.$method("choose", { returnType: "Swift.Int", mutating: false }).call()).toEqual(int64(4));
  });

  test("an extension method still ambiguous after filtering lists its overloads", () => {
    const n = (Swift.type("fixture.NarrowScalar") as StructType).new({ n: 11 });
    expect(() => n.scaledTwice(3)).toThrow(
      /ambiguous extension method scaledTwice on fixture\.Scalable: .*scaledTwice\(_:\).*\{ arity \}, \{ labels \}/
    );
  });
});

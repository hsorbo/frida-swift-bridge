import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, SwiftClassObject } from "../src/index.js";

describe("members declared on a generic superclass", () => {
  beforeEach(() => { loadFixture(); });

  function genericLabeled(n: number): SwiftClassObject {
    return Swift.class("fixture.GenericLabeledHolder<Swift.Int>")!.init(n, "L")!;
  }

  test("a generic subclass object finds a method declared on its generic superclass", () => {
    expect(genericLabeled(9).stored()).toEqual(int64(9));
    expect(genericLabeled(9).$method("stored").call()).toEqual(int64(9));
  });

  test("the subclass's own override shadows the inherited one", () => {
    // 3.scaled(by: 7) + 1 = 22.
    expect(genericLabeled(3).scaledStored(7)).toEqual(int64(22));
  });

  test("a non-generic subclass object finds a method declared on its generic superclass", () => {
    const labeled = Swift.class("fixture.LabeledHolder")!.init(7, "L")!;
    expect(labeled.stored()).toEqual(int64(7));
    expect(labeled.scaledStored(3)).toEqual(int64(21));
  });

  test("a miss still names the object's own type", () => {
    expect(() => genericLabeled(1).$method("nope")).toThrow(/no method nope on fixture\.GenericLabeledHolder/);
  });

  test("the inherited listing reaches through the generic superclass", () => {
    const names = genericLabeled(1).$type.instanceMethods();
    expect(names).toContain("stored()");
    expect(names.filter((s) => s === "scaledStored(by:)").length).toBe(1);
    expect(genericLabeled(1).$type.instanceMethods({ inherited: false })).not.toContain("stored()");
  });
});

import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, SwiftClassObject, SwiftValueObject } from "../src/index.js";

const MAKE_SCOREBOARD = "$s7fixture14makeScoreboard4upToAA0C0VySiGSi_tF";
const MAKE_SCOREBOARD_HOLDER = "$s7fixture20makeScoreboardHolder4upToAA0cD0CySiGSi_tF";

function scoreboard(upTo: number): SwiftValueObject {
  return Swift.function(loadFixture(), MAKE_SCOREBOARD).call(upTo) as SwiftValueObject;
}

describe("accessors on a generic type", () => {
  beforeEach(() => { loadFixture(); });

  test("stdlib collections' computed properties read through the key arguments", () => {
    const bag = Swift.struct("fixture.Bag")!;
    expect((bag.ints() as SwiftValueObject).$get("count")).toEqual(int64(3));
    expect((bag.intSet() as SwiftValueObject).$get("count")).toEqual(int64(3));
    expect((bag.intMap() as SwiftValueObject).$get("count")).toEqual(int64(2));
  });

  test("fixed-layout value type: self by value, the key arguments trailing", () => {
    expect(scoreboard(3).$get("count")).toEqual(int64(3));
  });

  test("a getter typed by the type parameter decodes via the specialization", () => {
    expect(scoreboard(3).$get("head")).toEqual(int64(1));
    expect(scoreboard(0).$get("head")).toBeNull();
  });

  test("a getter calling a witness of T, and its setter writing back", () => {
    const board = scoreboard(2);
    expect(board.$get("scaledTotal")).toEqual(int64(6));
    board.$set("scaledTotal", 100);
    expect(board.$get("scaledTotal")).toEqual(int64(106));
    expect(board.$field("bonus").read()).toEqual(int64(100));
  });

  test("address-only value type: self in x20, Self metadata trailing", () => {
    const pouch = Swift.struct("fixture.Pouch<Swift.Int>")!.$new({ value: 7 });
    expect(pouch.$get("tripled")).toEqual(int64(21));
    expect(pouch.$get("copy")).toEqual(int64(7));
  });

  test("a static accessor on a generic value type takes the key arguments", () => {
    expect(Swift.struct("fixture.Scoreboard<Swift.Int>")!.$get("label")).toBe("scoreboard of Int");
    expect(() => Swift.struct("fixture.Scoreboard")!.$get("label")).toThrow(/type arguments/);
  });

  test("a generic class reads its arguments off the isa", () => {
    const holder = Swift.function(loadFixture(), MAKE_SCOREBOARD_HOLDER).call(2) as SwiftClassObject;
    expect(holder.$get("count")).toEqual(int64(2));
    expect(holder.$get("head")).toEqual(int64(1));
    expect(Swift.class("fixture.ScoreboardHolder<Swift.Int>")!.$get("label")).toBe("holder of Int");
  });
});

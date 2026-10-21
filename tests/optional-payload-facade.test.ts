import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { fixtureExport, loadFixture } from "./fixtures/load.js";

import { Swift, type CallArg, type SwiftValueObject } from "../src/index.js";
import { ClassInstance } from "../src/abi.js";

function echo(name: string, type: string) {
  const T = Swift.reflect(type)!;
  return Swift.NativeFunction(fixtureExport(`fixture.${name}`), T, [T]);
}

describe("a nominal Optional payload", () => {
  beforeEach(() => { loadFixture(); });

  test("a struct result is a facade of the payload type that passes back as the Optional", () => {
    const echoPoint = echo("echoOptionalPoint", "fixture.Point?");
    const point = echoPoint({ x: 7 }) as SwiftValueObject;
    expect(point.$type.name).toBe("fixture.Point");
    expect(point.$owned).toBe(true);
    const again = echoPoint(point) as SwiftValueObject;
    expect(again.$fields).toEqual({ x: int64(7) });
    expect((echoPoint(again) as SwiftValueObject).$fields).toEqual({ x: int64(7) });
    expect(echoPoint(null)).toBeNull();
    expect((echoPoint(Swift.struct("fixture.Point")!.$new({ x: 3 })) as SwiftValueObject).x).toEqual(int64(3));
  });

  test("an enum result passes back the same way", () => {
    const echoTint = echo("echoOptionalTint", "fixture.Tint?");
    const tint = echoTint("green") as SwiftValueObject;
    expect(tint.$type.name).toBe("fixture.Tint");
    expect((echoTint(tint) as SwiftValueObject).$fields).toBe("green");
    expect(echoTint(null)).toBeNull();
  });

  test("a reference-bearing struct is copied in and the temp released", () => {
    const echoWrapper = echo("echoOptionalWrapper", "fixture.Wrapper?");
    const token = Swift.class("fixture.Token")!.init(4)!;
    const count = new ClassInstance(token.$handle);
    const before = count.retainCount;
    const Wrapper = Swift.type("fixture.Wrapper")!;
    const made = Swift.NativeFunction(fixtureExport("fixture.makeWrapper"), Wrapper, [Swift.type("fixture.Token")!])(token) as SwiftValueObject;
    expect(count.retainCount).toBe(before + 1);
    const wrapper = echoWrapper(made) as SwiftValueObject;
    made.$dispose();
    expect(count.retainCount).toBe(before + 1);
    const again = echoWrapper(wrapper) as SwiftValueObject;
    expect(count.retainCount).toBe(before + 2);
    expect(again.a).toEqual(int64(1));
    wrapper.$dispose();
    again.$dispose();
    expect(count.retainCount).toBe(before);
  });

  test("a nested Optional keeps its { some } wrapper around the facade both ways", () => {
    const echoNested = echo("echoNestedOptionalPoint", "fixture.Point??");
    const some = echoNested({ some: { x: 7 } }) as { some: SwiftValueObject };
    expect(some.some.$type.name).toBe("fixture.Point");
    const again = echoNested(some as CallArg) as { some: SwiftValueObject };
    expect(again.some.$fields).toEqual({ x: int64(7) });
    expect(echoNested({ some: null })).toEqual({ some: null });
    expect(echoNested(null)).toBeNull();
  });

  test("a facade of another type is refused", () => {
    const echoPoint = echo("echoOptionalPoint", "fixture.Point?");
    const rect = Swift.struct("fixture.Rect")!.$new({ width: 2 });
    expect(() => echoPoint(rect)).toThrow(/fixture\.Rect value, expected .*fixture\.Point/);
  });
});

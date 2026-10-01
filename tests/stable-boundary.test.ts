import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms, fixtureExport } from "./fixtures/load.js";

import { Swift, ClassType, StructType, SwiftClassObject } from "../src/index.js";
import { ValueInstance, metadataFor, typeOf } from "../src/abi.js";

function robot(name: string) {
  return (typeOf(metadataFor("fixture.Robot")!) as ClassType).facade.init(name);
}

describe("stable object boundary", () => {
  beforeEach(() => { loadFixture(); });

  test("$method returns a narrow view without resolution internals", () => {
    const m = robot("R2").$method("greet") as any;
    expect(typeof m.call).toBe("function");
    expect(m.address.isNull()).toBe(false);
    expect(m.resolved).toBeUndefined();
    expect(m.raw).toBeUndefined();
    expect(m.call("Ada")).toBe("Hello Ada, I am R2");
  });

  test("a detached bound method roots its receiver across GC", () => {
    let r: SwiftClassObject | null = robot("R2");
    const m = r.$method("greet");
    r = null;
    (globalThis as { gc?: () => void }).gc?.();
    expect(m.call("Ada")).toBe("Hello Ada, I am R2");
  });

  test("a detached bound method rejects a call after the receiver is disposed", () => {
    const r = robot("R2");
    const m = r.$method("greet");
    r.$dispose();
    expect(() => m.call("Ada")).toThrow(/disposed/);
  });

  test("a borrowed field rejects access after its owning instance is disposed", () => {
    const r = robot("R2");
    const f = r.$field("name");
    r.$dispose();
    expect(() => f.read()).toThrow(/disposed/);
    expect(() => f.write("D2")).toThrow(/disposed/);
  });

  test("initializer() returns a narrow view without resolution internals", () => {
    loadFixtureSyms();
    const init = (typeOf(metadataFor("fixturesyms.Point")!) as StructType).facade.$initializer() as any;
    expect(typeof init.call).toBe("function");
    expect(init.address.isNull()).toBe(false);
    expect(init.resolved).toBeUndefined();
    expect(init.call(3).$fields).toEqual({ x: int64(3) });
  });

  test("$field returns the backing ValueInstance, narrowed to SwiftField", () => {
    const f = robot("R2").$field("name") as any;
    // Same object at runtime: identity and /abi ops survive, only the stable type is narrowed.
    expect(f instanceof ValueInstance).toBe(true);
    expect(typeof f.copyInto).toBe("function");
    expect(f.metadata).toBeDefined();
    expect(f.read()).toBe("R2");
    f.write("D2");
    expect(f.read()).toBe("D2");
  });

  test("a $field view is usable as a ValueInstance via /abi", () => {
    const f = robot("R2").$field("name") as unknown as ValueInstance;
    const copy = f.copy();
    expect(copy.read()).toBe("R2");
    copy.dispose();
  });

  test("a $field view type-checks and marshals as a call argument", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const s = (typeOf(metadataFor("fixture.LoadableStruct")!) as StructType).facade.$new({ a: 3, b: 4, c: 0, d: 0 });
    const fieldA = s.$field("a");
    const add = Swift.NativeFunction(fixtureExport("fixture.addInts"), Int, [Int, Int]);
    expect(add(fieldA, fieldA)).toEqual(int64(6));
  });
});

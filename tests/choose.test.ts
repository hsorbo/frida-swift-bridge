import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";
import { requireDarwin } from "./swift.js";

import { Swift, SwiftClassObject } from "../src/index.js";

function handles(objects: SwiftClassObject[]): string[] {
  return objects.map((o) => o.$handle.toString());
}

describe("Swift.choose", () => {
  beforeEach(() => { loadFixture(); });

  test("finds the live instances of a class as borrowed facades", () => {
    const Base = Swift.class("fixture.Base")!;
    const first = Base.init({ kind: 1 });
    const second = Base.init({ kind: 2 });
    const found = Swift.choose(Base, { subclasses: false });
    expect(handles(found)).toContain(first.$handle.toString());
    expect(handles(found)).toContain(second.$handle.toString());
    expect(found.every((o) => o.$type.name === "fixture.Base" && !o.$owned)).toBe(true);
    expect(found.find((o) => o.$handle.equals(second.$handle))!.kind).toEqual(int64(2));
  }, { timeout: 30000 });

  test("includes subclass instances by default and excludes them on request", () => {
    const Base = Swift.class("fixture.Base")!;
    const derived = Swift.class("fixture.Derived")!.init();
    const withSubclasses = Swift.choose(Base);
    expect(handles(withSubclasses)).toContain(derived.$handle.toString());
    expect(withSubclasses.find((o) => o.$handle.equals(derived.$handle))!.$type.name).toBe("fixture.Derived");
    expect(handles(Swift.choose(Base, { subclasses: false }))).not.toContain(derived.$handle.toString());
  }, { timeout: 30000 });

  test("a generic class named without arguments covers its live specializations", () => {
    const intCell = Swift.class("fixture.Cell<Swift.Int>")!.init(5);
    const stringCell = Swift.class("fixture.Cell<Swift.String>")!.init("five");
    const found = Swift.choose(Swift.class("fixture.Cell")!);
    expect(handles(found)).toContain(intCell.$handle.toString());
    expect(handles(found)).toContain(stringCell.$handle.toString());
    expect(handles(Swift.choose(Swift.class("fixture.Cell<Swift.Int>")!))).not.toContain(stringCell.$handle.toString());
  });

  test("reaches a subclass of a generic superclass", () => {
    const coop = Swift.class("fixture.HenCoop")!.init();
    const found = Swift.choose(Swift.class("fixture.Coop")!);
    expect(handles(found)).toContain(coop.$handle.toString());
    expect(handles(Swift.choose(Swift.class("fixture.HenCoop")!))).toEqual([coop.$handle.toString()]);
  });

  test("finds instances of a Swift subclass of an ObjC class", (ctx) => {
    requireDarwin(ctx);
    const starling = Swift.class("fixture.Starling")!.init();
    expect(handles(Swift.choose(Swift.class("fixture.Starling")!))).toContain(starling.$handle.toString());
  });

  test("rejects malloc blocks shaped like the runtime's type-name cache buckets", () => {
    const HenCoop = Swift.class("fixture.HenCoop")!;
    const coop = HenCoop.init();
    const isa = coop.$handle.readPointer();
    const malloc = new NativeFunction(Module.getGlobalExportByName("malloc"), "pointer", ["size_t"]);
    const free = new NativeFunction(Module.getGlobalExportByName("free"), "void", ["pointer"]);
    const buckets = [isa, isa.or(4)].map((key) => {
      const block = malloc(64);
      block.writePointer(key).add(8).writePointer(block.add(32)).add(8).writeU64(15);
      return block;
    });
    try {
      const found = handles(Swift.choose(HenCoop));
      expect(found).toContain(coop.$handle.toString());
      for (const block of buckets) {
        expect(found).not.toContain(block.toString());
      }
    } finally {
      for (const block of buckets) {
        free(block);
      }
    }
  });

  test("rejects anything but a class facade", () => {
    expect(() => Swift.choose(Swift.struct("fixture.Point")! as any)).toThrow("takes a class facade");
  });
});

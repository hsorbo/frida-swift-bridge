import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadResilient } from "./fixtures/load.js";

import { indirect, isResilientValueType, makeSwiftNativeFunction, metadataFor } from "../src/abi.js";

import { Swift } from "../src/index.js";
// resilient.dylib (-enable-library-evolution) gives a real resilience boundary without a system
// framework: ResilientPoint crosses it address-only, FrozenPoint stays direct.

function resilientFn(mod: Module, needle: string): NativePointer {
  for (const e of mod.enumerateExports()) {
    const d = Swift.demangle(e.name);
    if (d !== null && d.includes(needle)) {
      return e.address;
    }
  }
  throw new Error(`resilient export not found: ${needle}`);
}

function point(x: number, y: number): NativePointer {
  const p = Memory.alloc(16);
  p.writeU64(x);
  p.add(8).writeU64(y);
  return p;
}

function int(v: number): NativePointer {
  const p = Memory.alloc(8);
  p.writeU64(v);
  return p;
}

function xy(result: NativePointer): [number, number] {
  return [result.readU64().toNumber(), result.add(8).readU64().toNumber()];
}

describe("resilient calling convention (local library-evolution fixture)", () => {
  beforeEach(() => { loadResilient(); });

  test("a non-frozen resilient struct is passed @in / returned @out", () => {
    const mod = loadResilient();
    const RP = metadataFor("resilient.ResilientPoint")!;
    const Int = metadataFor("Swift.Int")!;
    const translate = resilientFn(mod, "resilient.translate(");

    const fn = makeSwiftNativeFunction(translate, indirect(RP), [indirect(RP), Int, Int]);
    expect(xy(fn(point(1, 2), int(10), int(20))!)).toEqual([11, 22]);
  });

  test("a resilient struct is lowered @in / @out from plain metadata", () => {
    const mod = loadResilient();
    const RP = metadataFor("resilient.ResilientPoint")!;
    const Int = metadataFor("Swift.Int")!;
    const translate = resilientFn(mod, "resilient.translate(");

    const fn = makeSwiftNativeFunction(translate, RP, [RP, Int, Int]);
    expect(xy(fn(point(1, 2), int(10), int(20))!)).toEqual([11, 22]);
  });

  test("a @frozen struct marked frozen keeps the direct ABI", () => {
    const mod = loadResilient();
    Swift.markFrozen("resilient.FrozenPoint");
    const FP = metadataFor("resilient.FrozenPoint")!;
    const Int = metadataFor("Swift.Int")!;
    const translate = resilientFn(mod, "resilient.translateFrozen(");

    expect(isResilientValueType(FP)).toBe(false);
    const fn = makeSwiftNativeFunction(translate, FP, [FP, Int, Int]);
    expect(xy(fn(point(3, 4), int(100), int(200))!)).toEqual([103, 204]);
  });

  test("resilience is detected from the module's exports", () => {
    expect(isResilientValueType(metadataFor("resilient.ResilientPoint")!)).toBe(true);
    expect(isResilientValueType(metadataFor("resilient.ResilientMode")!)).toBe(true);
    expect(isResilientValueType(metadataFor("resilient.FrozenMode")!)).toBe(false);
    expect(isResilientValueType(metadataFor("resilient.InternalPoint")!)).toBe(false);
    loadFixture();
    expect(isResilientValueType(metadataFor("fixture.LoadableStruct")!)).toBe(false);
    expect(isResilientValueType(metadataFor("Swift.Int")!)).toBe(false);
  });

  test("a resilient enum is passed @in and returned @out", () => {
    const mod = loadResilient();
    const Mode = Swift.enum("resilient.ResilientMode")!;
    const Int = Swift.type("Swift.Int")!;

    const modeIndex = Swift.NativeFunction(resilientFn(mod, "resilient.modeIndex("), Int, [Mode]);
    expect(modeIndex(Mode.case("second"))).toEqual(int64(2));

    const flipMode = Swift.NativeFunction(resilientFn(mod, "resilient.flipMode("), Mode, [Mode]);
    expect(flipMode(Mode.case("first"))).toBe("second");
  });
});

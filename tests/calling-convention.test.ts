import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { Swift } from "../src/index.js";
import {
  shouldPassIndirectly,
  makeSwiftNativeFunction,
} from "../src/runtime/calling-convention.js";
import { SwiftError } from "../src/runtime/thrown-error.js";
import { readString } from "../src/abi/string.js";
import { findProtocol, conformsToProtocol } from "../src/abi/protocol-conformance.js";

import { metadataFor } from "../src/abi.js";
// Exposed by the GumJS runtime, not declared in @types/frida-gum.
declare function gc(): void;

function intValue(v: number): NativePointer {
  const p = Memory.alloc(8);
  p.writeU64(v);
  return p;
}

describe("shouldPassIndirectly", () => {
  beforeEach(() => { loadFixture(); });

  test("scalars and register-sized aggregates pass directly", () => {
    expect(shouldPassIndirectly(metadataFor("Swift.Int")!)).toBe(false);
    expect(shouldPassIndirectly(metadataFor("Swift.Bool")!)).toBe(false);
  });

  test("four-word struct is at the loadable boundary, five-word is indirect", () => {
    expect(shouldPassIndirectly(metadataFor("fixture.LoadableStruct")!)).toBe(false);
    expect(shouldPassIndirectly(metadataFor("fixture.BigStruct")!)).toBe(true);
  });

  test("more than four lowered scalars is indirect even within four words", () => {
    expect(shouldPassIndirectly(metadataFor("fixture.MixedPair")!)).toBe(false);
    expect(shouldPassIndirectly(metadataFor("fixture.FloatQuadTagged")!)).toBe(true);
  });
});

describe("makeSwiftNativeFunction", () => {
  beforeEach(() => { loadFixture(); });

  test("scalar arguments and a scalar return", () => {
    const Int = metadataFor("Swift.Int")!;
    const add = makeSwiftNativeFunction(fixtureExport("fixture.addInts"), Int, [Int, Int]);
    expect(add(intValue(20), intValue(22))!.readU64().toNumber()).toBe(42);
  });

  test("direct (multi-register) struct return", () => {
    const Loadable = metadataFor("fixture.LoadableStruct")!;
    const make = makeSwiftNativeFunction(fixtureExport("fixture.makeLoadableStruct"), Loadable, []);
    const r = make()!;
    for (let i = 0; i < 4; i++) {
      expect(r.add(i * 8).readU64().toNumber()).toBe(i + 1);
    }
  });

  test("indirect (x8) struct return", () => {
    const Big = metadataFor("fixture.BigStruct")!;
    const make = makeSwiftNativeFunction(fixtureExport("fixture.makeBigStruct"), Big, []);
    const r = make()!;
    for (let i = 0; i < 5; i++) {
      expect(r.add(i * 8).readU64().toNumber()).toBe(i + 1);
    }
  });

  test("direct (register-exploded) struct argument", () => {
    const Int = metadataFor("Swift.Int")!;
    const Loadable = metadataFor("fixture.LoadableStruct")!;
    const sum = makeSwiftNativeFunction(fixtureExport("fixture.sumLoadable"), Int, [Loadable]);
    const arg = Memory.alloc(Loadable.typeLayout.stride);
    for (let i = 0; i < 4; i++) {
      arg.add(i * 8).writeU64(i + 1);
    }
    expect(sum(arg)!.readU64().toNumber()).toBe(10);
  });

  test("indirect struct argument", () => {
    const Int = metadataFor("Swift.Int")!;
    const Big = metadataFor("fixture.BigStruct")!;
    const sum = makeSwiftNativeFunction(fixtureExport("fixture.sumBig"), Int, [Big]);
    const arg = Memory.alloc(Big.typeLayout.stride);
    for (let i = 0; i < 5; i++) {
      arg.add(i * 8).writeU64(i + 1);
    }
    expect(sum(arg)!.readU64().toNumber()).toBe(15);
  });

  test("decodes a non-POD (String) return value", () => {
    const String_ = metadataFor("Swift.String")!;
    const make = makeSwiftNativeFunction(fixtureExport("fixture.makeString"), String_, []);
    expect(readString(make()!)).toBe("New Cairo");
  });

  test("survives garbage collection between creation and call", () => {
    const Int = metadataFor("Swift.Int")!;
    const add = makeSwiftNativeFunction(fixtureExport("fixture.addInts"), Int, [Int, Int]);
    if (typeof gc === "function") {
      gc();
      gc();
    }
    expect(add(intValue(1), intValue(2))!.readU64().toNumber()).toBe(3);
  });

  test("successive results do not alias", () => {
    const Int = metadataFor("Swift.Int")!;
    const add = makeSwiftNativeFunction(fixtureExport("fixture.addInts"), Int, [Int, Int]);
    const r1 = add(intValue(1), intValue(2))!;
    const r2 = add(intValue(10), intValue(20))!;
    expect(r1.equals(r2)).toBe(false);
    expect(r1.readU64().toNumber()).toBe(3);
    expect(r2.readU64().toNumber()).toBe(30);
  });

  test("passes self in the context register and the callee mutates through it", () => {
    const Int = metadataFor("Swift.Int")!;
    const add = makeSwiftNativeFunction(fixtureExport("fixture.Accumulator.add("), null, [Int], {
      hasSelf: true,
    });
    const self = Memory.alloc(8);
    self.writeU64(0);
    expect(add(self, intValue(5))).toBe(null);
    expect(self.readU64().toNumber()).toBe(5);
    add(self, intValue(10));
    expect(self.readU64().toNumber()).toBe(15);
  });

  test("returns normally when a throwing function does not throw", () => {
    const Int = metadataFor("Swift.Int")!;
    const fn = makeSwiftNativeFunction(fixtureExport("fixture.mightThrow"), Int, [Int], {
      throws: true,
    });
    expect(fn(intValue(0))!.readU64().toNumber()).toBe(99);
  });

  test("surfaces a Swift error as SwiftError, decoding the value lazily", () => {
    const Int = metadataFor("Swift.Int")!;
    const fn = makeSwiftNativeFunction(fixtureExport("fixture.mightThrow"), Int, [Int], {
      throws: true,
    });
    let thrown: unknown;
    try {
      fn(intValue(1));
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof SwiftError).toBe(true);
    expect((thrown as SwiftError).error.isNull()).toBe(false);
    expect((thrown as SwiftError).value).toBe("boom");
  });

  test("passes and returns a Double in the floating-point registers", () => {
    const Double_ = metadataFor("Swift.Double")!;
    const fn = makeSwiftNativeFunction(fixtureExport("fixture.scaleDouble"), Double_, [Double_]);
    const arg = Memory.alloc(8);
    arg.writeDouble(21);
    expect(fn(arg)!.readDouble()).toBe(42);
  });

  test("passes and returns a Float in the floating-point registers", () => {
    const Float_ = metadataFor("Swift.Float")!;
    const fn = makeSwiftNativeFunction(fixtureExport("fixture.scaleFloat"), Float_, [Float_]);
    const arg = Memory.alloc(4);
    arg.writeFloat(21);
    expect(fn(arg)!.readFloat()).toBe(42);
  });

  test("mixes integer and floating-point argument registers", () => {
    const Int = metadataFor("Swift.Int")!;
    const Double_ = metadataFor("Swift.Double")!;
    const fn = makeSwiftNativeFunction(fixtureExport("fixture.combine"), Double_, [Int, Double_]);
    const d = Memory.alloc(8);
    d.writeDouble(40);
    expect(fn(intValue(2), d)!.readDouble()).toBe(42);
  });

  test("passes and returns a mixed Double/Int struct in FP and GP registers", () => {
    const Int = metadataFor("Swift.Int")!;
    const MixedPair = metadataFor("fixture.MixedPair")!;
    const fn = makeSwiftNativeFunction(fixtureExport("fixture.scaleMixedPair("), MixedPair, [MixedPair, Int]);
    const pair = Memory.alloc(MixedPair.typeLayout.stride);
    pair.writeDouble(1.5);
    pair.add(8).writeU64(2);
    const r = fn(pair, intValue(3))!;
    expect(r.readDouble()).toBe(4.5);
    expect(r.add(8).readU64().toNumber()).toBe(6);
  });

  test("passes a struct of more than four scalars indirectly", () => {
    const Float_ = metadataFor("Swift.Float")!;
    const Quad = metadataFor("fixture.FloatQuadTagged")!;
    const fn = makeSwiftNativeFunction(fixtureExport("fixture.sumFloatQuadTagged"), Float_, [Quad]);
    const quad = Memory.alloc(Quad.typeLayout.stride);
    [1, 2, 3, 4].forEach((v, i) => quad.add(i * 4).writeFloat(v));
    quad.add(16).writeU64(5);
    expect(fn(quad)!.readFloat()).toBe(15);
  });

  test("spills narrow scalars onto the caller's stack at their own widths", () => {
    const Int = metadataFor("Swift.Int")!;
    const Loadable = metadataFor("fixture.LoadableStruct")!;
    const Bool_ = metadataFor("Swift.Bool")!;
    const Tagged = metadataFor("fixture.TaggedInt")!;
    const Int32_ = metadataFor("Swift.Int32")!;
    const fn = makeSwiftNativeFunction(
      fixtureExport("fixture.spillInts("),
      Int,
      [Int, Int, Int, Int, Int, Int, Loadable, Bool_, Tagged, Int32_, Int]
    );
    const split = Memory.alloc(32);
    [7, 8, 9, 10].forEach((v, i) => split.add(i * 8).writeU64(v));
    const tagged = Memory.alloc(Tagged.typeLayout.stride);
    tagged.writeS8(11);
    tagged.add(8).writeU64(12);
    tagged.add(16).writeU8(1);
    const r = fn(
      intValue(1), intValue(2), intValue(3), intValue(4), intValue(5), intValue(6),
      split, Memory.alloc(1).writeU8(1), tagged, Memory.alloc(4).writeS32(-13), intValue(14)
    )!;
    expect(r.readS64().toNumber()).toBe(25);
  });

  test("passes a single-case enum as its payload", () => {
    const Int = metadataFor("Swift.Int")!;
    const Bool_ = metadataFor("Swift.Bool")!;
    const Wrapped = metadataFor("fixture.WrappedTagged")!;
    const Meters = metadataFor("fixture.Meters")!;
    const ints = Array.from({ length: 8 }, () => Int);
    const fn = makeSwiftNativeFunction(fixtureExport("fixture.spillWrapped("), Int, [
      ...ints, Bool_, Wrapped, Meters, Int,
    ]);
    const wrapped = Memory.alloc(Wrapped.typeLayout.stride);
    wrapped.writeS8(9);
    wrapped.add(8).writeU64(10);
    wrapped.add(16).writeU8(1);
    const r = fn(
      ...[1, 2, 3, 4, 5, 6, 7, 8].map(intValue),
      Memory.alloc(1).writeU8(1), wrapped, Memory.alloc(8).writeDouble(11.5), intValue(12)
    )!;
    expect(r.readS64().toNumber()).toBe(44);
  });

  test("passes an Int128 in a register pair or a 16-byte-aligned stack slot", (ctx) => {
    if (Process.arch !== "arm64") ctx.skip("x86-64 compilers disagree on where an Int128 past the registers goes");
    const Padded = metadataFor("fixture.PaddedInt128");
    if (Padded === null) ctx.skip("fixture compiled without Int128 (Swift < 6.0)");
    const Int = metadataFor("Swift.Int")!;
    const Bool_ = metadataFor("Swift.Bool")!;
    const Int128_ = metadataFor("Swift.Int128")!;
    const int128 = (high: number, low: number): NativePointer => {
      const p = Memory.alloc(16);
      p.writeU64(low);
      p.add(8).writeU64(high);
      return p;
    };
    const fn = makeSwiftNativeFunction(fixtureExport("fixture.spillInt128("), Int, [
      Padded!, Int, Int, Int, Int, Int128_, Bool_, Int128_, Int,
    ]);
    const padded = Memory.alloc(Padded!.typeLayout.stride);
    padded.writeU64(1);
    padded.add(16).writeU64(3);
    padded.add(24).writeU64(2);
    const r = fn(
      padded, intValue(4), intValue(5), intValue(6), intValue(7), int128(8, 9),
      Memory.alloc(1).writeU8(1), int128(10, 11), intValue(12)
    )!;
    expect(r.readS64().toNumber()).toBe(40);
  });

  test("passes and returns an Int128 framed by integers in registers", (ctx) => {
    const Framed = metadataFor("fixture.FramedInt128");
    if (Framed === null) ctx.skip("fixture compiled without Int128 (Swift < 6.0)");
    const fn = makeSwiftNativeFunction(fixtureExport("fixture.flipFramedInt128("), Framed!, [Framed!]);
    const framed = Memory.alloc(Framed!.typeLayout.stride);
    framed.writeU64(1);
    framed.add(16).writeU64(3);
    framed.add(24).writeU64(2);
    framed.add(32).writeU64(4);
    const r = fn(framed)!;
    expect([0, 16, 24, 32].map((off) => r.add(off).readU64().toNumber())).toEqual([4, 4, 2, 1]);
  });

  test("drives a generic function directly with supplied type metadata", () => {
    const Int = metadataFor("Swift.Int")!;
    const id = makeSwiftNativeFunction(
      fixtureExport("fixture.genericIdentity"),
      { genericParam: 0 },
      [{ genericParam: 0 }],
      { typeArguments: [Int] }
    );
    expect(id(intValue(7))!.readU64().toNumber()).toBe(7);
  });

  test("a generic value argument is passed indirectly regardless of concrete size", () => {
    const Loadable = metadataFor("fixture.LoadableStruct")!;
    const id = makeSwiftNativeFunction(
      fixtureExport("fixture.genericIdentity"),
      { genericParam: 0 },
      [{ genericParam: 0 }],
      { typeArguments: [Loadable] }
    );
    const arg = Memory.alloc(Loadable.typeLayout.stride);
    for (let i = 0; i < 4; i++) {
      arg.add(i * 8).writeU64(i + 5);
    }
    const r = id(arg)!;
    for (let i = 0; i < 4; i++) {
      expect(r.add(i * 8).readU64().toNumber()).toBe(i + 5);
    }
  });

  test("appends one metadata argument per generic parameter", () => {
    const Int = metadataFor("Swift.Int")!;
    const first = makeSwiftNativeFunction(
      fixtureExport("fixture.genericFirst"),
      { genericParam: 0 },
      [{ genericParam: 0 }, { genericParam: 1 }],
      { typeArguments: [Int, Int] }
    );
    expect(first(intValue(11), intValue(22))!.readU64().toNumber()).toBe(11);
  });

  test("appends a witness table so a constrained requirement dispatches", () => {
    const Int = metadataFor("Swift.Int")!;
    const witnessTable = conformsToProtocol(Int, findProtocol("fixture.Scalable")!)!;
    const scale = makeSwiftNativeFunction(
      fixtureExport("fixture.scaleGeneric"),
      Int,
      [{ genericParam: 0 }, Int],
      { typeArguments: [Int], witnessTables: [witnessTable] }
    );
    expect(scale(intValue(6), intValue(7))!.readU64().toNumber()).toBe(42);
  });
});

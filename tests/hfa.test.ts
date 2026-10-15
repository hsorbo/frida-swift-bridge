import { test, expect, describe } from "@frida/injest/agent";
import { fixtureExport } from "./fixtures/load.js";

import { readValue, type SwiftValue, type CallResult, metadataFor } from "../src/abi.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";

import { Swift } from "../src/index.js";
function doubles(metadata: ReturnType<typeof metadataFor>, values: number[]): NativePointer {
  const p = Memory.alloc(metadata!.typeLayout.stride);
  values.forEach((v, i) => p.add(i * 8).writeDouble(v));
  return p;
}

function floats(metadata: ReturnType<typeof metadataFor>, values: number[]): NativePointer {
  const p = Memory.alloc(metadata!.typeLayout.stride);
  values.forEach((v, i) => p.add(i * 4).writeFloat(v));
  return p;
}

describe("homogeneous float aggregates (HFA)", () => {
  test("returns a 2-double HFA in d0/d1", () => {
    const DoublePair = metadataFor("fixture.DoublePair")!;
    const make = makeSwiftNativeFunction(fixtureExport("fixture.makeDoublePair"), DoublePair, []);
    expect(readValue(DoublePair, make()!)).toEqual({ x: 1.5, y: 2.5 });
  });

  test("passes a 2-double HFA argument via d0/d1", () => {
    const Double_ = metadataFor("Swift.Double")!;
    const DoublePair = metadataFor("fixture.DoublePair")!;
    const sum = makeSwiftNativeFunction(fixtureExport("fixture.sumDoublePair"), Double_, [DoublePair]);
    expect(sum(doubles(DoublePair, [1.5, 2.5]))!.readDouble()).toBe(4);
  });

  test("returns and passes a 4-double HFA across d0–d3", () => {
    const Double_ = metadataFor("Swift.Double")!;
    const DoubleQuad = metadataFor("fixture.DoubleQuad")!;
    const make = makeSwiftNativeFunction(fixtureExport("fixture.makeDoubleQuad"), DoubleQuad, []);
    expect(readValue(DoubleQuad, make()!)).toEqual({ a: 1, b: 2, c: 3, d: 4 });
    const sum = makeSwiftNativeFunction(fixtureExport("fixture.sumDoubleQuad"), Double_, [DoubleQuad]);
    expect(sum(doubles(DoubleQuad, [1, 2, 3, 4]))!.readDouble()).toBe(10);
  });

  test("returns and passes a 2-float HFA via s0/s1", () => {
    const Float_ = metadataFor("Swift.Float")!;
    const FloatPair = metadataFor("fixture.FloatPair")!;
    const make = makeSwiftNativeFunction(fixtureExport("fixture.makeFloatPair"), FloatPair, []);
    expect(readValue(FloatPair, make()!)).toEqual({ u: 1.25, v: 3.75 });
    const sum = makeSwiftNativeFunction(fixtureExport("fixture.sumFloatPair"), Float_, [FloatPair]);
    expect(sum(floats(FloatPair, [1.25, 3.75]))!.readFloat()).toBe(5);
  });

  test("hook decodes an HFA argument and return", () => {
    const Double_ = metadataFor("Swift.Double")!;
    const DoublePair = metadataFor("fixture.DoublePair")!;
    const addr = fixtureExport("fixture.sumDoublePair");
    let seenArgs: SwiftValue[] | null = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args;
      },
    });
    makeSwiftNativeFunction(addr, Double_, [DoublePair])(doubles(DoublePair, [1.5, 2.5]));
    listener.detach();
    expect(seenArgs).toEqual([{ x: 1.5, y: 2.5 }]);

    const mkAddr = fixtureExport("fixture.makeDoublePair");
    let seenRet: CallResult = null;
    const l2 = Swift.Interceptor.attach(mkAddr, {
      onLeave(ret) {
        seenRet = ret;
      },
    });
    makeSwiftNativeFunction(mkAddr, DoublePair, [])();
    l2.detach();
    expect(seenRet).toEqual({ x: 1.5, y: 2.5 });
  });
});

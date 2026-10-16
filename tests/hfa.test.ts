import { test, expect, describe } from "@frida/injest/agent";
import { fixtureExport } from "./fixtures/load.js";

import { Swift, type SwiftStruct, type SwiftValue, type SwiftValueObject, type CallResult } from "../src/index.js";

function doubles(type: SwiftStruct, values: number[]): SwiftValueObject {
  const p = Memory.alloc(type.$type.layout.stride);
  values.forEach((v, i) => p.add(i * 8).writeDouble(v));
  return type.$borrow(p);
}

function floats(type: SwiftStruct, values: number[]): SwiftValueObject {
  const p = Memory.alloc(type.$type.layout.stride);
  values.forEach((v, i) => p.add(i * 4).writeFloat(v));
  return type.$borrow(p);
}

describe("homogeneous float aggregates (HFA)", () => {
  test("returns a 2-double HFA in d0/d1", () => {
    const DoublePair = Swift.struct("fixture.DoublePair")!;
    const make = Swift.NativeFunction(fixtureExport("fixture.makeDoublePair"), DoublePair, []);
    expect(make()).toEqual({ x: 1.5, y: 2.5 });
  });

  test("passes a 2-double HFA argument via d0/d1", () => {
    const Double_ = Swift.struct("Swift.Double")!;
    const DoublePair = Swift.struct("fixture.DoublePair")!;
    const sum = Swift.NativeFunction(fixtureExport("fixture.sumDoublePair"), Double_, [DoublePair]);
    expect(sum(doubles(DoublePair, [1.5, 2.5]))).toBe(4);
  });

  test("returns and passes a 4-double HFA across d0–d3", () => {
    const Double_ = Swift.struct("Swift.Double")!;
    const DoubleQuad = Swift.struct("fixture.DoubleQuad")!;
    const make = Swift.NativeFunction(fixtureExport("fixture.makeDoubleQuad"), DoubleQuad, []);
    expect(make()).toEqual({ a: 1, b: 2, c: 3, d: 4 });
    const sum = Swift.NativeFunction(fixtureExport("fixture.sumDoubleQuad"), Double_, [DoubleQuad]);
    expect(sum(doubles(DoubleQuad, [1, 2, 3, 4]))).toBe(10);
  });

  test("returns and passes a 2-float HFA via s0/s1", () => {
    const Float_ = Swift.struct("Swift.Float")!;
    const FloatPair = Swift.struct("fixture.FloatPair")!;
    const make = Swift.NativeFunction(fixtureExport("fixture.makeFloatPair"), FloatPair, []);
    expect(make()).toEqual({ u: 1.25, v: 3.75 });
    const sum = Swift.NativeFunction(fixtureExport("fixture.sumFloatPair"), Float_, [FloatPair]);
    expect(sum(floats(FloatPair, [1.25, 3.75]))).toBe(5);
  });

  test("hook decodes an HFA argument and return", () => {
    const Double_ = Swift.struct("Swift.Double")!;
    const DoublePair = Swift.struct("fixture.DoublePair")!;
    const addr = fixtureExport("fixture.sumDoublePair");
    let seenArgs: SwiftValue[] | null = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args;
      },
    });
    Swift.NativeFunction(addr, Double_, [DoublePair])(doubles(DoublePair, [1.5, 2.5]));
    listener.detach();
    expect(seenArgs).toEqual([{ x: 1.5, y: 2.5 }]);

    const mkAddr = fixtureExport("fixture.makeDoublePair");
    let seenRet: CallResult = null;
    const l2 = Swift.Interceptor.attach(mkAddr, {
      onLeave(ret) {
        seenRet = ret;
      },
    });
    Swift.NativeFunction(mkAddr, DoublePair, [])();
    l2.detach();
    expect(seenRet).toEqual({ x: 1.5, y: 2.5 });
  });
});

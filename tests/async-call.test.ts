import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift } from "./swift.js";
import { loadFixture } from "./fixtures/load.js";

import { AsyncFunctionPointer, driveAsyncCall, callAsync } from "../src/abi.js";

const STORE_DOUBLE_NOW_AFP = "$s7fixture14storeDoubleNowyyAA8AsyncBoxC_SitYaFTu";
const STORE_DOUBLE_ASYNC_AFP = "$s7fixture16storeDoubleAsyncyyAA0D3BoxC_SitYaFTu";
const COMPUTE_ASYNC_AFP = "$s7fixture12computeAsyncyS2iYaFTu";
const MAKE_CALC = "$s7fixture13makeAsyncCalcyAA0cD0CSiF";
const ADD_ASYNC_AFP = "$s7fixture9AsyncCalcC03addB0yS2iYaFTu";
const DIVIDE_ASYNC_AFP = "$s7fixture11divideAsyncyS2i_SitYaKFTu";
const MAKE_PAIR_ASYNC_AFP = "$s7fixture13makePairAsyncyAA0dC0VSi_SitYaFTu";
const COMPUTE_DOUBLE_ASYNC_AFP = "$s7fixture18computeDoubleAsyncyS2dYaFTu";
const MAKE_QUAD_ASYNC_AFP = "$s7fixture13makeQuadAsyncyAA0dC0VSiYaFTu";
const MAKE_BOX = "$s7fixture12makeAsyncBoxAA0cD0CyF";
const READ_BOX = "$s7fixture12readAsyncBoxySiAA0cD0CF";

function afp(module: Module, symbol: string): AsyncFunctionPointer {
  return new AsyncFunctionPointer(module.getExportByName(symbol).strip());
}

describe("async call", () => {
  test("calls an async function with bound args (non-suspending)", () => {
    requireSwift();
    const module = loadFixture();
    const makeBox = new NativeFunction(module.getExportByName(MAKE_BOX), "pointer", []);
    const readBox = new NativeFunction(module.getExportByName(READ_BOX), "long", ["pointer"]);
    const box = makeBox() as unknown as NativePointer;
    driveAsyncCall(afp(module, STORE_DOUBLE_NOW_AFP), [box, ptr(21)]);
    expect(Number(readBox(box))).toBe(42);
  });

  test("calls an async function that suspends at Task.yield", () => {
    requireSwift();
    const module = loadFixture();
    const makeBox = new NativeFunction(module.getExportByName(MAKE_BOX), "pointer", []);
    const readBox = new NativeFunction(module.getExportByName(READ_BOX), "long", ["pointer"]);
    const box = makeBox() as unknown as NativePointer;
    driveAsyncCall(afp(module, STORE_DOUBLE_ASYNC_AFP), [box, ptr(21)]);
    expect(Number(readBox(box))).toBe(42);
  });

  test("captures a scalar return value: computeAsync(21) async -> Int", () => {
    requireSwift();
    const module = loadFixture();
    const result = driveAsyncCall(afp(module, COMPUTE_ASYNC_AFP), [ptr(21)]);
    expect(Number(result.readS64())).toBe(42);
  });

  test("captures a two-register struct return: makePairAsync(3, 4) ⇒ (3, 4)", () => {
    requireSwift();
    const module = loadFixture();
    const result = driveAsyncCall(afp(module, MAKE_PAIR_ASYNC_AFP), [ptr(3), ptr(4)], { result: { kind: "gp", words: 2 } });
    expect(Number(result.readS64())).toBe(3);
    expect(Number(result.add(8).readS64())).toBe(4);
  });

  test("captures a floating-point result: computeDoubleAsync(21.0) async -> Double", () => {
    requireSwift();
    const module = loadFixture();
    const x = Memory.alloc(8).writeDouble(21);
    const result = driveAsyncCall(afp(module, COMPUTE_DOUBLE_ASYNC_AFP), [], {
      floatArgs: [{ bytes: x, cls: "double", index: 0 }],
      result: { kind: "float", cls: "double", count: 1 },
    });
    expect(result.readDouble()).toBe(42);
  });

  test("returns a large struct through an @out buffer: makeQuadAsync(10) async -> AsyncQuad", () => {
    requireSwift();
    const module = loadFixture();
    const result = driveAsyncCall(afp(module, MAKE_QUAD_ASYNC_AFP), [ptr(10)], { result: { kind: "indirect", stride: 40 } });
    for (let i = 0; i < 5; i++) {
      expect(Number(result.add(i * 8).readS64())).toBe(10 + i);
    }
  });

  test("invokes an async instance method with self: calc(100).addAsync(5) ⇒ 105", () => {
    requireSwift();
    const module = loadFixture();
    const makeCalc = new NativeFunction(module.getExportByName(MAKE_CALC), "pointer", ["long"]);
    const calc = makeCalc(100) as unknown as NativePointer;
    const result = driveAsyncCall(afp(module, ADD_ASYNC_AFP), [ptr(5)], { receiver: calc });
    expect(Number(result.readS64())).toBe(105);
  });

  test("returns the value of a throwing function that does not throw", () => {
    requireSwift();
    const module = loadFixture();
    const result = driveAsyncCall(afp(module, DIVIDE_ASYNC_AFP), [ptr(10), ptr(2)], { throws: true });
    expect(Number(result.readS64())).toBe(5);
  });

  test("raises SwiftError when the function throws", () => {
    requireSwift();
    const module = loadFixture();
    expect(() => driveAsyncCall(afp(module, DIVIDE_ASYNC_AFP), [ptr(10), ptr(0)], { throws: true })).toThrow();
  });

  test("callAsync resolves without blocking the JS thread", async () => {
    requireSwift();
    const module = loadFixture();
    const result = await callAsync(afp(module, COMPUTE_ASYNC_AFP), [ptr(21)]);
    expect(Number(result.readS64())).toBe(42);
  });

  test("drives many tasks without leaking or crashing on the freed creation reference", () => {
    requireSwift();
    const module = loadFixture();
    const compute = afp(module, COMPUTE_ASYNC_AFP);
    for (let i = 0; i < 256; i++) {
      expect(Number(driveAsyncCall(compute, [ptr(i)]).readS64())).toBe(i * 2);
    }
  });
});

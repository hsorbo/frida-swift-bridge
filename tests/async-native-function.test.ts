import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, SwiftError, ClassType } from "../src/index.js";
import { metadataFor, typeOf, ValueInstance } from "../src/abi.js";

const COMPUTE_ASYNC = "$s7fixture12computeAsyncyS2iYaF";
const DIVIDE_ASYNC = "$s7fixture11divideAsyncyS2i_SitYaKF";
const COMPUTE_DOUBLE_ASYNC = "$s7fixture18computeDoubleAsyncyS2dYaF";
const MAKE_PAIR_ASYNC = "$s7fixture13makePairAsyncyAA0dC0VSi_SitYaF";
const MAKE_TUPLE_ASYNC = "$s7fixture14makeTupleAsyncySi_SStSi_SitYaF";
const SCALE_MIXED_PAIR_ASYNC = "$s7fixture19scaleMixedPairAsyncyAA0cD0VAD_SitYaF";
const SUM_PADDED_INT128_ASYNC = "$s7fixture20sumPaddedInt128AsyncySiAA0cD0V_SitYaF";
const FLIP_FRAMED_INT128_ASYNC = "$s7fixture21flipFramedInt128AsyncyAA0cD0VADYaF";
const WEIGH_INTS_ASYNC = "$s7fixture14weighIntsAsyncyS2i_S7is5Int32VSitYaF";
const ADD_ASYNC = "$s7fixture9AsyncCalcC03addB0yS2iYaF";
const ADD_INTS_SYNC = "$s7fixture7addIntsyS2i_SitF";
const GENERIC_HOLDER_SCALED_STORED_ASYNC = "$s7fixture13GenericHolderC17scaledStoredAsync2byS2i_tYaF";

describe("Swift.asyncFunction", () => {
  let module: Module;
  beforeEach(() => {
    module = loadFixture();
  });

  test("awaits a free async function: computeAsync(21) ⇒ 42", async () => {
    const computeAsync = Swift.asyncFunction(module, COMPUTE_ASYNC);
    expect(await computeAsync.call(21)).toEqual(int64(42));
  });

  test("resolves an async throwing function that does not throw: divideAsync(84, 2) ⇒ 42", async () => {
    const divideAsync = Swift.asyncFunction(module, DIVIDE_ASYNC);
    expect(await divideAsync.call(84, 2)).toEqual(int64(42));
  });

  test("rejects with SwiftError when the async throwing function throws", async () => {
    const divideAsync = Swift.asyncFunction(module, DIVIDE_ASYNC);
    await expect(divideAsync.call(1, 0)).rejects.toThrow(SwiftError);
  });

  test("passes and returns a Double: computeDoubleAsync(21.0) ⇒ 42", async () => {
    const computeDoubleAsync = Swift.asyncFunction(module, COMPUTE_DOUBLE_ASYNC);
    expect(await computeDoubleAsync.call(21)).toBe(42);
  });

  test("decodes a struct return: makePairAsync(3, 4) ⇒ { a: 3, b: 4 }", async () => {
    const makePairAsync = Swift.asyncFunction(module, MAKE_PAIR_ASYNC);
    expect(await makePairAsync.call(3, 4)).toEqual({ a: int64(3), b: int64(4) });
  });

  test("passes and returns a mixed Double/Int struct in FP and GP registers", async () => {
    const scaleMixedPairAsync = Swift.asyncFunction(module, SCALE_MIXED_PAIR_ASYNC);
    expect(await scaleMixedPairAsync.call({ d: 1.5, i: 2 }, 3)).toEqual({ d: 4.5, i: int64(6) });
  });

  test("passes arguments past the registers on the stack: weighIntsAsync(1...8, 9, 1) ⇒ 1987654321", async () => {
    const weighIntsAsync = Swift.asyncFunction(module, WEIGH_INTS_ASYNC);
    expect(await weighIntsAsync.call(1, 2, 3, 4, 5, 6, 7, 8, 9, 1)).toEqual(int64(1987654321));
    expect(await weighIntsAsync.call(1, 2, 3, 4, 5, 6, 7, 8, 9, 1)).toEqual(int64(1987654321));
  });

  test("passes an Int128 in a register pair, skipping the padding word", async (ctx) => {
    const Padded = metadataFor("fixture.PaddedInt128");
    if (Padded === null) ctx.skip("fixture compiled without Int128 (Swift < 6.0)");
    const padded = Memory.alloc(Padded!.typeLayout.stride);
    padded.writeU64(1);
    padded.add(16).writeU64(3);
    padded.add(24).writeU64(2);
    const sumPaddedInt128Async = Swift.asyncFunction(module, SUM_PADDED_INT128_ASYNC);
    expect(await sumPaddedInt128Async.call(ValueInstance.borrow(Padded!, padded), 4)).toEqual(int64(4231));
  });

  test("returns an Int128 framed by integers in four registers", async (ctx) => {
    const Framed = metadataFor("fixture.FramedInt128");
    if (Framed === null) ctx.skip("fixture compiled without Int128 (Swift < 6.0)");
    const framed = Memory.alloc(Framed!.typeLayout.stride);
    framed.writeU64(1);
    framed.add(16).writeU64(3);
    framed.add(24).writeU64(2);
    framed.add(32).writeU64(4);
    const flipFramedInt128Async = Swift.asyncFunction(module, FLIP_FRAMED_INT128_ASYNC);
    expect(await flipFramedInt128Async.call(ValueInstance.borrow(Framed!, framed))).toEqual({
      head: int64(4),
      wide: { _value: null },
      tail: int64(1),
    });
  });

  test("derives and decodes a tuple return: makeTupleAsync(3, 4) ⇒ [7, \"sum\"]", async () => {
    const makeTupleAsync = Swift.asyncFunction(module, MAKE_TUPLE_ASYNC);
    expect(await makeTupleAsync.call(3, 4)).toEqual([int64(7), "sum"]);
  });

  test("threads caller-annotated argument and return types, no cast at the call site", async () => {
    const makeTupleAsync = Swift.asyncFunction<[Int64, string], [number, number]>(module, MAKE_TUPLE_ASYNC);
    const [sum, label] = await makeTupleAsync.call(3, 4); // .call is (a: number, b: number) => Promise<[Int64, string]>
    expect(sum).toEqual(int64(7));
    expect(label).toBe("sum");
  });

  test("binds a class receiver for an instance method: calc(100).addAsync(5) ⇒ 105", async () => {
    const calc = (typeOf(metadataFor("fixture.AsyncCalc")!) as ClassType).init(100);
    const addAsync = Swift.asyncFunction(module, ADD_ASYNC).bind(calc);
    expect(await addAsync(5)).toEqual(int64(105));
  });

  test("calling an instance method without binding a receiver throws", () => {
    const addAsync = Swift.asyncFunction(module, ADD_ASYNC);
    expect(() => addAsync.call(5)).toThrow(/instance method/);
  });

  test("binding a receiver on a free function throws", () => {
    const computeAsync = Swift.asyncFunction(module, COMPUTE_ASYNC);
    expect(() => computeAsync.bind(ptr(1))).toThrow(/no receiver/);
  });

  test("rejects a non-async symbol", () => {
    expect(() => Swift.asyncFunction(module, ADD_INTS_SYNC)).toThrow(/not async/);
  });

  test("rejects a method of a generic type", () => {
    expect(() => Swift.asyncFunction(module, GENERIC_HOLDER_SCALED_STORED_ASYNC)).toThrow(
      /scaledStoredAsync\(by:\) is a member of generic type fixture\.GenericHolder/
    );
  });

  test("validates argument count", () => {
    const computeAsync = Swift.asyncFunction(module, COMPUTE_ASYNC);
    expect(() => computeAsync.call(1, 2)).toThrow(/argument/);
  });
});

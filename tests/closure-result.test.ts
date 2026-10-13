import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { Swift, SwiftClosureValue } from "../src/index.js";
import { ClassInstance, makeSwiftNativeFunction, metadataFor, typeOf } from "../src/abi.js";

const MAKE_ADDER = "$s7fixture9makeAdderyS2icSiF";
const MAKE_LABELER = "$s7fixture11makeLabelerySSSicSSF";
const MAKE_LIMITER = "$s7fixture11makeLimiteryS2iKcSiF";
const MAKE_SCALER = "$s7fixture10makeScaleryxxcxSjRzlF";
const MAKE_CONSTANT_SEVEN = "$s7fixture17makeConstantSevenSiycyF";
const MAKE_CURRIED_SUM = "$s7fixture14makeCurriedSumyS2icSicSiF";
const INVOKE_MAPPING = "$s7fixture13invokeMappingyS2i_S2iXEtF";

describe("closure results", () => {
  let module: Module;
  beforeEach(() => {
    module = loadFixture();
  });

  test("a returned (Int) -> Int closure is called with its context as self", () => {
    const add2 = Swift.function(module, MAKE_ADDER).call(2) as SwiftClosureValue;
    expect(add2(40)).toEqual(int64(42));
    expect(add2.function.isNull()).toBe(false);
    expect(add2.context.isNull()).toBe(false);
  });

  test("marshals a String result and propagates a thrown error", () => {
    const label = Swift.function(module, MAKE_LABELER).call("n=") as SwiftClosureValue;
    expect(label(7)).toBe("n=7");
    const limit = Swift.function(module, MAKE_LIMITER).call(10) as SwiftClosureValue;
    expect(limit(3)).toEqual(int64(6));
    expect(() => limit(11)).toThrow(/threw/);
  });

  test("a closure returned from a generic function takes and returns its type parameter by address", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const Double = typeOf(metadataFor("Swift.Double")!);
    const triple = Swift.function(module, MAKE_SCALER, { typeArguments: [Int] }).call(3) as SwiftClosureValue;
    expect(triple(5)).toEqual(int64(15));
    const halve = Swift.function(module, MAKE_SCALER, { typeArguments: [Double] }).call(0.5) as SwiftClosureValue;
    expect(halve(7)).toBe(3.5);
  });

  test("a returned closure is passed back where a function-typed parameter is expected", async () => {
    const add2 = Swift.function(module, MAKE_ADDER).call(2) as SwiftClosureValue;
    expect(Swift.function(module, INVOKE_MAPPING).call(40, add2)).toEqual(int64(42));
    const calc = Swift.class("fixture.AsyncCalc")!.init(100)!;
    expect(await calc.mapAsync(7, add2)).toEqual(int64(109));
    expect(add2(1)).toEqual(int64(3));
  });

  test("a closure returning a closure is called in turn", () => {
    const sum = Swift.function(module, MAKE_CURRIED_SUM).call(1) as SwiftClosureValue;
    const sum1 = sum(2) as SwiftClosureValue;
    expect(sum1(3)).toEqual(int64(6));
  });

  test("a method's closure result is reached by bare name, by $method and with empty type arguments", () => {
    const stepper = Swift.class("fixture.Stepper")!.init()!;
    const next = stepper.incrementer() as SwiftClosureValue;
    expect(next()).toEqual(int64(1));
    expect(next()).toEqual(int64(2));
    const bound = stepper.$method("incrementer");
    expect(bound.signature.returnType).toBe(null);
    expect((bound.call() as SwiftClosureValue)()).toEqual(int64(3));
    expect((stepper.$method("incrementer", { typeArguments: [] }).call() as SwiftClosureValue)()).toEqual(int64(4));
  });

  test("$dispose releases the context holding the captured object and a disposed closure refuses calls", () => {
    const stepper = Swift.class("fixture.Stepper")!.init()!;
    const view = new ClassInstance(stepper.$handle);
    const before = view.retainCount;
    const next = stepper.incrementer() as SwiftClosureValue;
    expect(view.retainCount).toBe(before + 1);
    next.$dispose();
    expect(view.retainCount).toBe(before);
    next.$dispose();
    expect(() => next()).toThrow(/disposed/);
  });

  test("using disposes a closure at block scope; a captureless closure has no context", () => {
    const stepper = Swift.class("fixture.Stepper")!.init()!;
    const view = new ClassInstance(stepper.$handle);
    const before = view.retainCount;
    {
      using next = stepper.incrementer() as SwiftClosureValue;
      expect(next()).toEqual(int64(1));
      expect(view.retainCount).toBe(before + 1);
    }
    expect(view.retainCount).toBe(before);
    const seven = Swift.function(module, MAKE_CONSTANT_SEVEN).call() as SwiftClosureValue;
    expect(seven.context.isNull()).toBe(true);
    expect(seven()).toEqual(int64(7));
    seven.$dispose();
  });

  test("makeSwiftNativeFunction hands back the closure's two words", () => {
    const Int = metadataFor("Swift.Int")!;
    const makeAdder = makeSwiftNativeFunction(fixtureExport("makeAdder"), { closure: true }, [Int]);
    const n = Memory.alloc(8);
    n.writeU64(5);
    const words = makeAdder(n)!;
    expect(words.readPointer().isNull()).toBe(false);
    const context = words.add(Process.pointerSize).readPointer();
    expect(context.isNull()).toBe(false);
    Swift.api.swift_release(context);
  });
});

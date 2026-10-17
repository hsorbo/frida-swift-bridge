import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { Swift, SwiftClosureValue, SwiftValueObject, SwiftField } from "../src/index.js";

const MAKE_ADDER = "$s7fixture9makeAdderyS2icSiF";
const MAKE_SCALER = "$s7fixture10makeScaleryxxcxSjRzlF";
const MAKE_CONSTANT_SEVEN = "$s7fixture17makeConstantSevenSiycyF";
const MAKE_HANDLER = "$s7fixture11makeHandleryAA0C0VSiF";
const INVOKE_MAPPING = "$s7fixture13invokeMappingyS2i_S2iXEtF";
const INVOKE_MAPPING_WITH_OFFSET = "$s7fixture23invokeMappingWithOffsetyS2i_SitF";
const INVOKE_ESCAPING = "$s7fixture14invokeEscapingyS2i_S2ictF";
const INVOKE_ESCAPING_WITH_OFFSET = "$s7fixture24invokeEscapingWithOffsetyS2i_SitF";

function fixtureContext(name: string): NativePointer {
  return new NativeFunction(fixtureExport(name), "pointer", [])() as NativePointer;
}

function capturingContext(x: number): NativePointer {
  new NativeFunction(fixtureExport("storeCapturing"), "void", ["int64"])(x);
  return fixtureContext("capturingContext");
}

describe("closure captures", () => {
  let module: Module;
  beforeEach(() => {
    module = loadFixture();
  });

  test("a returned closure exposes its captures as field views, which write through", () => {
    const add2 = Swift.function(module, MAKE_ADDER).call(2) as SwiftClosureValue;
    expect(add2.$owned).toBe(true);
    const [n] = add2.$captures();
    expect(n.type.name).toBe("Swift.Int");
    expect(n.read()).toEqual(int64(2));
    n.write(40);
    expect(add2(2)).toEqual(int64(42));
  });

  test("a disposed closure refuses its captures, and a field view taken earlier dangles with it", () => {
    const add2 = Swift.function(module, MAKE_ADDER).call(2) as SwiftClosureValue;
    const [n] = add2.$captures();
    add2.$dispose();
    expect(() => add2.$captures()).toThrow(/disposed/);
    expect(() => n.read()).toThrow(/disposed/);
  });

  test("a closure made in a generic function types its capture by the substituted parameter", () => {
    const Double = Swift.type("Swift.Double")!;
    const halve = Swift.function(module, MAKE_SCALER, { typeArguments: [Double] }).call(0.5) as SwiftClosureValue;
    const captures = halve.$captures();
    expect(captures.map((c) => c.type.name)).toEqual(["Swift.Double"]);
    expect(captures[0].read()).toBe(0.5);
  });

  test("a captured object reads as its reference", () => {
    new NativeFunction(fixtureExport("storeMixedCapturing"), "void", ["int64", "int64", "int64"])(1, 5, 9);
    const [flag, n, object] = Swift.borrowClosure(fixtureContext("mixedCapturingContext")).$captures();
    expect([flag.read(), n.read()]).toEqual([true, int64(5)]);
    expect(object.type.name).toBe("fixture.Base");
    expect(Swift.borrowObject(object.read() as NativePointer).kind).toEqual(int64(9));
  });

  test("an escaping closure argument inside a Swift.Interceptor hook reads its captures", () => {
    let seen: { owned: boolean; captures: unknown[] } | null = null;
    const listener = Swift.Interceptor.attach(Swift.function(module, INVOKE_ESCAPING), {
      onEnter(args) {
        const body = args[1] as SwiftClosureValue;
        seen = { owned: body.$owned, captures: body.$captures().map((c) => c.read()) };
      },
    });
    try {
      expect(Swift.function(module, INVOKE_ESCAPING_WITH_OFFSET).call(40, 2)).toEqual(int64(42));
    } finally {
      listener.detach();
    }
    expect(seen).toEqual({ owned: false, captures: [int64(2)] });
  });

  test("a non-escaping closure argument's context lives in the caller's frame, so its captures are refused", () => {
    let refused: Error | null = null;
    const listener = Swift.Interceptor.attach(Swift.function(module, INVOKE_MAPPING), {
      onEnter(args) {
        try {
          (args[1] as SwiftClosureValue).$captures();
        } catch (e) {
          refused = e as Error;
        }
      },
    });
    try {
      expect(Swift.function(module, INVOKE_MAPPING_WITH_OFFSET).call(40, 2)).toEqual(int64(42));
    } finally {
      listener.detach();
    }
    expect(refused!.message).toMatch(/non-escaping/);
  });

  test("a closure stored in a struct field reads as a borrowed view, and serializes as its two words", () => {
    const handler = Swift.function(module, MAKE_HANDLER).call(5) as SwiftValueObject;
    const action = handler.$field("action").read() as SwiftClosureValue;
    expect(action.$owned).toBe(false);
    expect(action.function.isNull()).toBe(false);
    expect(action.$captures().map((c) => c.read())).toEqual([int64(5)]);
    expect(() => action()).toThrow(/signature/);
    expect(Object.keys(JSON.parse(JSON.stringify(handler.$fields)).action)).toEqual(["function", "context"]);
  });

  test("Swift.borrowClosure views a bare context pointer or a closure's two words", () => {
    const context = capturingContext(7);
    const view = Swift.borrowClosure(context);
    expect(view.$owned).toBe(false);
    expect(view.function.isNull()).toBe(true);
    expect(view.context.equals(context)).toBe(true);
    expect(view.$captures().map((c) => c.read())).toEqual([int64(7), "-fixture"]);
    const words = Swift.borrowClosure({ function: ptr(1), context });
    expect(words.$captures().map((c) => c.type.name)).toEqual(["Swift.Int", "Swift.String"]);
  });

  test("writing a capture through its field view changes what the closure computes", () => {
    const invokeCapturing = new NativeFunction(fixtureExport("invokeCapturing"), "int64", ["int64"]);
    const context = capturingContext(7);
    const [n, suffix] = Swift.borrowClosure(context).$captures();
    n.write(100);
    suffix.write("hi");
    expect(invokeCapturing(5).toNumber()).toBe(107);
    const longSuffix = "a string well past the small-string inline capacity of fifteen bytes";
    suffix.write(longSuffix);
    expect(invokeCapturing(5).toNumber()).toBe(100 + 5 + longSuffix.length);
  });

  test("a class-typed capture is not writable through its view", () => {
    new NativeFunction(fixtureExport("storeMixedCapturing"), "void", ["int64", "int64", "int64"])(1, 5, 9);
    const context = fixtureContext("mixedCapturingContext");
    const [, , object] = Swift.borrowClosure(context).$captures();
    const before = object.read() as NativePointer;
    expect(() => object.write(ptr(0))).toThrow();
    expect((object.read() as NativePointer).equals(before)).toBe(true);
  });

  test("a captured metatype reads as its type", () => {
    new NativeFunction(fixtureExport("triggerMetatypeCapturing"), "void", [])();
    const context = fixtureContext("genericCapturingContext");
    const [type]: SwiftField[] = Swift.borrowClosure(context).$captures();
    expect(type.type.name).toBe("Swift.Bool.Type");
    expect(type.read()).toBe(Swift.reflect("Swift.Bool"));
  });

  test("a closure without captures has none", () => {
    const seven = Swift.function(module, MAKE_CONSTANT_SEVEN).call() as SwiftClosureValue;
    expect(seven.$captures()).toEqual([]);
  });

  test("a closure capturing only an object has the object as its context and as its sole capture", () => {
    const stepper = Swift.class("fixture.Stepper")!.init()!;
    using next = stepper.incrementer() as SwiftClosureValue;
    expect(next.context.equals(stepper.$handle)).toBe(true);
    const [self, ...rest]: SwiftField[] = next.$captures();
    expect(rest).toEqual([]);
    expect(self.type.name).toBe("fixture.Stepper");
    expect((self.read() as NativePointer).equals(stepper.$handle)).toBe(true);
    expect(() => self.write(ptr(0))).toThrow();
  });
});

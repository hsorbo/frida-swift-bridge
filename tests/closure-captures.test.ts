import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { Swift, SwiftClosureValue, SwiftValueObject, SwiftField } from "../src/index.js";
import { unwrapReabstractionThunk } from "../src/abi/closure-capture.js";

const OFFSETOF_HEAP_OFFSET_TO_FIRST_CAPTURE = 0x8;

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

function retainCount(context: NativePointer): number {
  return Number(Swift.api.swift_retainCount(context));
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

  test("a captured resilient struct, whose box records no fixed offset, lies after the heap header", () => {
    new NativeFunction(fixtureExport("storeResilientCapturing"), "void", ["int64", "int64"])(3, 4);
    const context = fixtureContext("resilientCapturingContext");
    const box = unwrapReabstractionThunk(context) ?? context;
    expect(box.readPointer().strip().readU32(OFFSETOF_HEAP_OFFSET_TO_FIRST_CAPTURE)).toBe(0);
    const [p] = Swift.borrowClosure(context).$captures();
    expect(p.type.name).toBe("resilient.ResilientPoint");
    expect(p.handle.sub(box).toInt32()).toBe(2 * Process.pointerSize);
    expect(p.read()).toEqual({ x: int64(3), y: int64(4) });
  });

  test("a closure inside a captured struct reads as a closure view, in a concrete and a generic struct", () => {
    new NativeFunction(fixtureExport("storeHandlerCapturing"), "void", ["int64"])(5);
    const [h] = Swift.borrowClosure(fixtureContext("handlerCapturingContext")).$captures();
    const { action, label } = h.read() as { action: SwiftClosureValue; label: string };
    expect(label).toBe("handler");
    expect(action.$captures().map((c) => c.read())).toEqual([int64(5)]);

    new NativeFunction(fixtureExport("triggerEmitterCapturing"), "void", ["int64"])(6);
    const [e] = Swift.borrowClosure(fixtureContext("emitterCapturingContext")).$captures();
    expect(e.type.name).toBe("fixture.Emitter<Swift.Int>");
    const { emit, tag } = e.read() as { emit: SwiftClosureValue; tag: Int64 };
    expect(tag).toEqual(int64(6));
    expect(emit.$captures().map((c) => c.read())).toEqual([int64(6)]);
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

  test("a non-escaping closure argument refuses $retained, since retaining cannot outlive the caller's frame", () => {
    let refused: Error | null = null;
    const listener = Swift.Interceptor.attach(Swift.function(module, INVOKE_MAPPING), {
      onEnter(args) {
        try {
          (args[1] as SwiftClosureValue).$retained();
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

  test("$retained keeps a borrowed closure's context alive until disposed, without making it callable", () => {
    const context = capturingContext(7);
    const before = retainCount(context);
    const kept = Swift.borrowClosure(context).$retained();
    expect(kept.$owned).toBe(true);
    expect(retainCount(context)).toBe(before + 1);
    expect(kept.$captures().map((c) => c.read())).toEqual([int64(7), "-fixture"]);
    expect(() => kept()).toThrow(/cannot be called/);
    kept.$dispose();
    kept.$dispose();
    expect(retainCount(context)).toBe(before);
    expect(() => kept.$captures()).toThrow(/disposed/);
  });

  test("$retained on a returned closure is a second owned, callable closure over the same context", () => {
    const add2 = Swift.function(module, MAKE_ADDER).call(2) as SwiftClosureValue;
    const before = retainCount(add2.context);
    const kept = add2.$retained();
    expect(retainCount(add2.context)).toBe(before + 1);
    add2.$dispose();
    expect(retainCount(add2.context)).toBe(before);
    expect(kept(40)).toEqual(int64(42));
    kept.$dispose();
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

  test("a captured closure reads as a borrowed closure view whose own captures read in turn", () => {
    new NativeFunction(fixtureExport("storeClosureCapturing"), "void", ["int64"])(3);
    const [twice, add, n] = Swift.borrowClosure(fixtureContext("genericCapturingContext")).$captures();
    expect([twice.type.name, add.type.name, n.type.name]).toEqual(["@convention(c) () -> ()", "() -> ()", "Swift.Int"]);
    const [addend] = (add.read() as SwiftClosureValue).$captures();
    expect(addend.read()).toEqual(int64(3));
    expect(twice.read() instanceof NativePointer).toBe(true);
    expect(n.read()).toEqual(int64(3));
  });

  test("a closure whose sole capture is a closure reads it as a closure view", () => {
    new NativeFunction(fixtureExport("storeSoleClosureCapturing"), "void", ["int64"])(4);
    const [add, ...rest] = Swift.borrowClosure(fixtureContext("genericCapturingContext")).$captures();
    expect(rest).toEqual([]);
    expect((add.read() as SwiftClosureValue).$captures().map((c) => c.read())).toEqual([int64(4)]);
  });

  test("a closure captured in a generic function lays out alongside the parameter-typed capture", () => {
    new NativeFunction(fixtureExport("triggerGenericClosureCapturing"), "void", [])();
    const [make, value] = Swift.borrowClosure(fixtureContext("genericCapturingContext")).$captures();
    expect((make.read() as SwiftClosureValue).$captures().map((c) => c.read())).toEqual([int64(6)]);
    expect(value.read()).toEqual(int64(6));
  });

  test("a closure held in an Optional or a tuple reads as a closure view", () => {
    new NativeFunction(fixtureExport("storeNestedClosureCapturing"), "void", ["int64"])(5);
    const [scale, pair] = Swift.borrowClosure(fixtureContext("genericCapturingContext")).$captures();
    expect((scale.read() as SwiftClosureValue).$captures().map((c) => c.read())).toEqual([int64(5)]);
    const [n, add] = pair.read() as [Int64, SwiftClosureValue];
    expect(n).toEqual(int64(5));
    expect(add.$captures().map((c) => c.read())).toEqual([int64(5)]);
  });

  test("an optional closure captured in a generic function lays out alongside the parameter-typed capture", () => {
    new NativeFunction(fixtureExport("triggerGenericOptionalClosureCapturing"), "void", [])();
    const [make, value] = Swift.borrowClosure(fixtureContext("genericCapturingContext")).$captures();
    expect((make.read() as SwiftClosureValue).$captures().map((c) => c.read())).toEqual([int64(8)]);
    expect(value.read()).toEqual(int64(8));
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

  test("a weak capture reads as its referent while it lives and nil after; an unowned one as its reference; neither is writable", () => {
    const stepper = Swift.class("fixture.Stepper")!.init()!;
    const weak = stepper.weakIncrementer() as SwiftClosureValue;
    {
      using unowned = stepper.unownedIncrementer() as SwiftClosureValue;
      const [unownedSelf] = unowned.$captures();
      expect(unownedSelf.type.name).toBe("fixture.Stepper");
      expect((unownedSelf.read() as NativePointer).equals(stepper.$handle)).toBe(true);
      expect(() => unownedSelf.write(stepper.$handle)).toThrow(/unowned/);
    }
    const [weakSelf] = weak.$captures();
    expect(weakSelf.type.name).toBe("Swift.Optional<fixture.Stepper>");
    expect(weakSelf.read()).toEqual(stepper.$handle);
    expect(() => weakSelf.write(null)).toThrow(/weak/);
    stepper.$dispose();
    expect(weakSelf.read()).toBeNull();
    expect(weak()).toEqual(int64(-1));
  });
});

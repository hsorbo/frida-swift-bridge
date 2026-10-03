import { test, expect, describe } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { Swift, SwiftError, type SwiftClassObject, type CallResult, type SwiftValue } from "../src/index.js";
import { SwiftInterceptor } from "../src/runtime/interceptor.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";
import { metadataFor } from "../src/abi.js";

const THROWS_TYPED = "$s7fixture11throwsTypedyS2iAA0C7FailureOYKF";
const THROWS_CODED = "$s7fixture11throwsCodedySdSiAA0C7FailureVYKF";
const THROWS_WIDE = "$s7fixture10throwsWideyS2iAA0C7FailureVYKF";
const THROWS_RATIO = "$s7fixture11throwsRatioyySiAA0C7FailureVYKF";
const THROWS_CLASS = "$s7fixture11throwsClassyS2iAA0C7FailureCYKF";
const THROWS_BIG_RESULT = "$s7fixture15throwsBigResultyAA0C6StructVSiAA12TypedFailureOYKF";
const THROWS_CODED_ASYNC = "$s7fixture16throwsCodedAsyncyS2iYaAA0C7FailureVYKF";
const THROWS_WIDE_ASYNC = "$s7fixture15throwsWideAsyncyS2iYaAA0C7FailureVYKF";

function thrownBy(call: () => unknown): SwiftError {
  try {
    call();
  } catch (e) {
    expect(e instanceof SwiftError).toBe(true);
    return e as SwiftError;
  }
  throw new Error("did not throw");
}

async function rejectedWith(promise: Promise<unknown>): Promise<SwiftError> {
  try {
    await promise;
  } catch (e) {
    expect(e instanceof SwiftError).toBe(true);
    return e as SwiftError;
  }
  throw new Error("did not reject");
}

function intValue(v: number): NativePointer {
  return Memory.alloc(8).writeS64(v);
}

describe("typed throws", () => {
  test("a loadable error rides the result registers beside a float result", () => {
    const fn = Swift.function(loadFixture(), THROWS_CODED);
    expect(fn.call(0)).toBe(2.5);
    expect(thrownBy(() => fn.call(3)).value).toEqual({ code: int64(3), flag: false });
    expect(thrownBy(() => fn.call(9)).value).toEqual({ code: int64(9), flag: true });
  });

  test("a payload-less enum error decodes as its case", () => {
    const fn = Swift.function(loadFixture(), THROWS_TYPED);
    expect(fn.call(3)).toEqual(int64(30));
    expect(thrownBy(() => fn.call(1)).value).toBe("bad");
    expect(thrownBy(() => fn.call(2)).value).toBe("worse");
  });

  test("an error too wide for the registers comes back through the caller's buffer", () => {
    const fn = Swift.function(loadFixture(), THROWS_WIDE);
    expect(fn.call(0)).toEqual(int64(7));
    expect(thrownBy(() => fn.call(4)).value).toEqual({ a: int64(4), b: int64(5), c: int64(6), d: int64(7), e: int64(8) });
  });

  test("a floating-point error and an indirect result both take the buffer", () => {
    const ratio = Swift.function(loadFixture(), THROWS_RATIO);
    expect(ratio.call(0)).toBe(null);
    expect(thrownBy(() => ratio.call(3)).value).toEqual({ ratio: 1.5 });
    const big = Swift.function(loadFixture(), THROWS_BIG_RESULT);
    expect(big.call(0)).toEqual({ a: int64(1), b: int64(2), c: int64(3), d: int64(4), e: int64(5) });
    expect(thrownBy(() => big.call(1)).value).toBe("bad");
  });

  test("a class error is adopted as an object", () => {
    const fn = Swift.function(loadFixture(), THROWS_CLASS);
    expect(fn.call(0)).toEqual(int64(3));
    const error = thrownBy(() => fn.call(5));
    const failure = error.value as SwiftClassObject;
    expect(failure.$kind).toBe("object");
    expect(failure.id).toEqual(int64(5));
    expect(error.value).toBe(failure);
  });

  test("a method's typed error reaches its facade call", () => {
    loadFixture();
    const thrower = Swift.type("fixture.TypedThrower")!.init(10) as SwiftClassObject;
    expect(thrower.scaled(0)).toEqual(int64(20));
    expect(thrownBy(() => thrower.scaled(2)).value).toEqual({ code: int64(12), flag: false });
    expect(thrownBy(() => thrower.$method("scaled").call(2)).message).toBe("Swift function threw fixture.CodedFailure");
  });

  test("Swift.NativeFunction reads the thrown type off the symbol", () => {
    const Int = metadataFor("Swift.Int")!;
    const Double = metadataFor("Swift.Double")!;
    const fn = Swift.NativeFunction(fixtureExport("fixture.throwsCoded"), Swift.type("Swift.Double")!, [Swift.type("Swift.Int")!], { throws: true });
    expect(fn(0)).toBe(2.5);
    expect(thrownBy(() => fn(7)).value).toEqual({ code: int64(7), flag: true });
    const raw = makeSwiftNativeFunction(fixtureExport("fixture.throwsCoded"), Double, [Int], { errorType: metadataFor("fixture.CodedFailure")! });
    expect(thrownBy(() => raw(intValue(2))).value).toEqual({ code: int64(2), flag: false });
  });

  test("an async typed error rides the resume registers or the buffer", async () => {
    const coded = Swift.asyncFunction(loadFixture(), THROWS_CODED_ASYNC);
    expect(await coded.call(0)).toEqual(int64(1));
    expect((await rejectedWith(coded.call(6))).value).toEqual({ code: int64(6), flag: true });
    const wide = Swift.asyncFunction(loadFixture(), THROWS_WIDE_ASYNC);
    expect(await wide.call(0)).toEqual(int64(8));
    expect((await rejectedWith(wide.call(2))).value).toEqual({ a: int64(2), b: int64(3), c: int64(4), d: int64(5), e: int64(6) });
    const thrower = Swift.type("fixture.TypedThrower")!.init(5) as SwiftClassObject;
    expect(await thrower.scaledAsync(0)).toEqual(int64(15));
    expect((await rejectedWith(thrower.scaledAsync(1) as Promise<CallResult>)).value).toEqual({ code: int64(6), flag: true });
  });

  test("a hook decodes a typed error from the registers and from the buffer", () => {
    const Int = metadataFor("Swift.Int")!;
    const seen: { ret: CallResult; error: CallResult | undefined }[] = [];
    const listeners = [fixtureExport("fixture.throwsCoded"), fixtureExport("fixture.throwsWide")].map((target) =>
      SwiftInterceptor.attach(target, {
        onLeave(ret, error) {
          seen.push({ ret, error });
        },
      })
    );
    try {
      const driveCoded = makeSwiftNativeFunction(fixtureExport("fixture.driveThrowsCoded"), Int, [Int]);
      const driveWide = makeSwiftNativeFunction(fixtureExport("fixture.driveThrowsWide"), Int, [Int]);
      expect(driveCoded(intValue(0))!.readS64()).toEqual(int64(2));
      expect(driveCoded(intValue(8))!.readS64()).toEqual(int64(-8));
      expect(driveWide(intValue(0))!.readS64()).toEqual(int64(7));
      expect(driveWide(intValue(3))!.readS64()).toEqual(int64(-7));
    } finally {
      listeners.forEach((l) => l.detach());
    }
    expect(seen).toEqual([
      { ret: 2.5, error: undefined },
      { ret: null, error: { code: int64(8), flag: true } },
      { ret: int64(7), error: undefined },
      { ret: null, error: { a: int64(3), b: int64(4), c: int64(5), d: int64(6), e: int64(7) } },
    ]);
  });

  test("an async hook decodes a typed error on completion", async () => {
    const seen: { ret: CallResult; error: CallResult | undefined }[] = [];
    const module = loadFixture();
    const listeners = [THROWS_CODED_ASYNC, THROWS_WIDE_ASYNC].map((name) =>
      SwiftInterceptor.attachAsync(module.getExportByName(`${name}Tu`), {
        onComplete(ret, error) {
          seen.push({ ret, error });
        },
      })
    );
    try {
      const coded = Swift.asyncFunction(module, THROWS_CODED_ASYNC);
      const wide = Swift.asyncFunction(module, THROWS_WIDE_ASYNC);
      await coded.call(0);
      await rejectedWith(coded.call(7));
      await wide.call(0);
      await rejectedWith(wide.call(1));
    } finally {
      listeners.forEach((l) => l.detach());
    }
    expect(seen).toEqual([
      { ret: int64(1), error: undefined },
      { ret: null, error: { code: int64(7), flag: true } },
      { ret: int64(8), error: undefined },
      { ret: null, error: { a: int64(1), b: int64(2), c: int64(3), d: int64(4), e: int64(5) } },
    ]);
  });
});

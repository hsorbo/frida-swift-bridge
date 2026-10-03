import { test, expect, describe } from "@frida/injest/agent";
import { requireDarwin, requireSwift } from "./swift.js";
import { loadFixture } from "./fixtures/load.js";

import { AsyncFunctionPointer, driveAsyncCall, metadataFor, typeOf, ValueInstance, type ClassType } from "../src/abi.js";
import { lookUpObjCClass } from "../src/runtime/objc.js";

import { Swift, type SwiftObject } from "../src/index.js";

declare function gc(): void;
const COMPUTE_ASYNC = "$s7fixture12computeAsyncyS2iYaF";
const DRIVE = "$s7fixture17driveComputeAsyncyS2iF";
const MAKE_QUAD_ASYNC = "$s7fixture13makeQuadAsyncyAA0dC0VSiYaF";
const MAKE_QUAD_ASYNC_AFP = MAKE_QUAD_ASYNC + "Tu";
const DIVIDE_ASYNC = "$s7fixture11divideAsyncyS2i_SitYaKF";
const DIVIDE_ASYNC_AFP = DIVIDE_ASYNC + "Tu";
const SPILL_INTS_ASYNC = "$s7fixture14spillIntsAsyncyS2i_S7is5Int32VSitYaF";
const DRIVE_SPILL_INTS_ASYNC = "$s7fixture19driveSpillIntsAsyncSiyF";
const CALC_ECHO_ASYNC = "$s7fixture9AsyncCalcC04echoB0yxxYalF";
const MAKE_LINK = "$s7fixture8makeLinkyAA0C0VSSF";
const RESOLVE_LINK_ASYNC = "$s7fixture16resolveLinkAsyncyAA0C0V_AA4HostCtADYaF";
const PAIR_LINK_ASYNC = "$s7fixture13pairLinkAsyncyAA0C0V_So8NSObjectCtAD_AFtYaF";
const FLIP_FRAMED_INT128_ASYNC = "$s7fixture21flipFramedInt128AsyncyAA0cD0VADYaF";

function driver(module: Module): (x: number) => number {
  const fn = new NativeFunction(module.getExportByName(DRIVE), "long", ["long"]);
  return (x) => Number(fn(x));
}

// onFirstSuspend fires as the suspending thread returns, which can be after another thread has
// resumed and completed the call; awaiting releases the JS lock so that callback can run.
function signal(): { fire: () => void; fired: Promise<void> } {
  let fire!: () => void;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fire, fired };
}

function newNSObject(): NativePointer {
  const libobjc = Process.getModuleByName("libobjc.A.dylib");
  const msgSend = new NativeFunction(libobjc.getExportByName("objc_msgSend"), "pointer", ["pointer", "pointer"]);
  const selRegisterName = new NativeFunction(libobjc.getExportByName("sel_registerName"), "pointer", ["pointer"]);
  return msgSend(lookUpObjCClass("NSObject")!, selRegisterName(Memory.allocUtf8String("new"))) as NativePointer;
}

function afp(module: Module, symbol: string): AsyncFunctionPointer {
  return new AsyncFunctionPointer(module.getExportByName(symbol).strip());
}

describe("async interceptor", () => {
  test("onEnter fires with the args and the async context pointer", () => {
    requireSwift();
    const module = loadFixture();
    const drive = driver(module);

    let arg: unknown;
    let context: NativePointer | undefined;
    const listener = Swift.Interceptor.attachAsync(module.getExportByName(COMPUTE_ASYNC), {
      onEnter(args, ctx) {
        arg = args[0];
        context = ctx;
      },
    });
    try {
      expect(drive(21)).toBe(42);
      expect(arg).toEqual(int64(21));
      expect(context).toBeDefined();
      expect(context!.isNull()).toBe(false);
    } finally {
      listener.detach();
    }
  });

  test("onEnter reads arguments spilled past the registers from the caller's stack", () => {
    requireSwift();
    const module = loadFixture();
    const drive = new NativeFunction(module.getExportByName(DRIVE_SPILL_INTS_ASYNC), "long", []);

    let args: unknown;
    const listener = Swift.Interceptor.attachAsync(module.getExportByName(SPILL_INTS_ASYNC), {
      onEnter(a) {
        args = a;
      },
    });
    try {
      expect(Number(drive())).toBe(2);
      expect(args).toEqual([
        int64(1), int64(2), int64(3), int64(4), int64(5), int64(6), int64(7), int64(8),
        -9,
        int64(10),
      ]);
    } finally {
      listener.detach();
    }
  });

  test("onFirstSuspend fires when the function suspends", async () => {
    requireSwift();
    const module = loadFixture();
    const drive = driver(module);

    let entered = false;
    const suspended = signal();
    const listener = Swift.Interceptor.attachAsync(module.getExportByName(COMPUTE_ASYNC), {
      onEnter() {
        entered = true;
      },
      onFirstSuspend() {
        suspended.fire();
      },
    });
    try {
      expect(drive(5)).toBe(10);
      expect(entered).toBe(true);
      await suspended.fired;
    } finally {
      listener.detach();
    }
  });

  test("onComplete fires with the return value once the awaited function resolves", () => {
    requireSwift();
    const module = loadFixture();
    const drive = driver(module);

    let result: unknown;
    const listener = Swift.Interceptor.attachAsync(module.getExportByName(COMPUTE_ASYNC), {
      onComplete(retval) {
        result = retval;
      },
    });
    try {
      expect(drive(21)).toBe(42);
      expect(result).toEqual(int64(42));
    } finally {
      listener.detach();
    }
  });

  test("onEnter, onFirstSuspend and onComplete all fire in order", async () => {
    requireSwift();
    const module = loadFixture();
    const drive = driver(module);

    const seen: string[] = [];
    let result: unknown;
    const suspended = signal();
    const listener = Swift.Interceptor.attachAsync(module.getExportByName(COMPUTE_ASYNC), {
      onEnter() {
        seen.push("enter");
      },
      onFirstSuspend() {
        seen.push("suspend");
        suspended.fire();
      },
      onComplete(retval) {
        seen.push("complete");
        result = retval;
      },
    });
    try {
      expect(drive(9)).toBe(18);
      await suspended.fired;
      // onFirstSuspend fires on the suspending worker, onComplete on the resuming worker; their
      // order across those threads is a race, so only enter-first is guaranteed.
      expect(seen[0]).toBe("enter");
      expect(seen).toContain("suspend");
      expect(seen).toContain("complete");
      expect(result).toEqual(int64(18));
    } finally {
      listener.detach();
    }
  });

  test("onComplete captures a large @out struct result: makeQuadAsync(10)", () => {
    requireSwift();
    const module = loadFixture();

    let quad: { a: number; e: number } | undefined;
    const listener = Swift.Interceptor.attachAsync(module.getExportByName(MAKE_QUAD_ASYNC), {
      onComplete(retval) {
        quad = retval as { a: number; e: number };
      },
    });
    try {
      driveAsyncCall(afp(module, MAKE_QUAD_ASYNC_AFP), [ptr(10)], { result: { kind: "indirect", stride: 40 } });
      expect(quad).toBeDefined();
      expect(quad!.a).toEqual(int64(10));
      expect(quad!.e).toEqual(int64(14));
    } finally {
      listener.detach();
    }
  });

  test("onComplete decodes an Int128 framed by integers from the resume's argument registers", async (ctx) => {
    requireSwift();
    const module = loadFixture();
    const Framed = metadataFor("fixture.FramedInt128");
    if (Framed === null) ctx.skip("fixture compiled without Int128 (Swift < 6.0)");
    const framed = Memory.alloc(Framed!.typeLayout.stride);
    framed.writeU64(1);
    framed.add(16).writeU64(3);
    framed.add(24).writeU64(2);
    framed.add(32).writeU64(4);

    let result: unknown;
    const listener = Swift.Interceptor.attachAsync(module.getExportByName(FLIP_FRAMED_INT128_ASYNC), {
      onComplete(retval) {
        result = retval;
      },
    });
    try {
      const flipFramedInt128Async = Swift.function(module, FLIP_FRAMED_INT128_ASYNC);
      await flipFramedInt128Async.call(ValueInstance.borrow(Framed!, framed));
      expect(result).toEqual({ head: int64(4), wide: (2n << 64n) | 4n, tail: int64(1) });
    } finally {
      listener.detach();
    }
  });

  test("onComplete surfaces a thrown error", () => {
    requireSwift();
    const module = loadFixture();

    let value: unknown = "unset";
    let error: unknown;
    const listener = Swift.Interceptor.attachAsync(module.getExportByName(DIVIDE_ASYNC), {
      onComplete(retval, err) {
        value = retval;
        error = err;
      },
    });
    try {
      expect(() =>
        driveAsyncCall(afp(module, DIVIDE_ASYNC_AFP), [ptr(10), ptr(0)], { throws: true })
      ).toThrow();
      expect(value).toBe(null);
      expect(error).toBeDefined();
    } finally {
      listener.detach();
    }
  });

  test("a throwing onComplete does not divert the native resume", () => {
    requireSwift();
    const module = loadFixture();
    const drive = driver(module);

    let fired = false;
    const listener = Swift.Interceptor.attachAsync(module.getExportByName(COMPUTE_ASYNC), {
      onComplete() {
        fired = true;
        throw new Error("boom from onComplete");
      },
    });
    try {
      expect(drive(21)).toBe(42);
      expect(fired).toBe(true);
    } finally {
      listener.detach();
    }
  });

  test("onComplete this.context carries the Swift completion registers", () => {
    requireSwift();
    const module = loadFixture();
    const drive = driver(module);

    let result: NativePointer | undefined;
    let asyncContext: NativePointer | undefined;
    const listener = Swift.Interceptor.attachAsync(module.getExportByName(COMPUTE_ASYNC), {
      onComplete() {
        const cc = this.context as unknown as Record<string, NativePointer>;
        result = Process.arch === "arm64" ? cc.x0 : cc.rax;
        asyncContext = Process.arch === "arm64" ? cc.x22 : cc.r14;
      },
    });
    try {
      expect(drive(21)).toBe(42);
      expect(result!.toUInt32()).toBe(42);
      expect(asyncContext).toBeDefined();
      expect(asyncContext!.isNull()).toBe(false);
    } finally {
      listener.detach();
    }
  });

  test("this.typeArguments is set in onEnter and captured for onComplete", async () => {
    requireSwift();
    const module = loadFixture();
    const calc = (typeOf(metadataFor("fixture.AsyncCalc")!) as ClassType).facade.init(100);
    const echo = calc.$method("echoAsync", { typeArguments: [typeOf(metadataFor("Swift.String")!)] });
    const seen: { onEnter?: string[]; onComplete?: string[] } = {};
    const completed = signal();
    const listener = Swift.Interceptor.attachAsync(module.getExportByName(CALC_ECHO_ASYNC), {
      onEnter() {
        seen.onEnter = this.typeArguments;
      },
    });
    const completionOnly = Swift.Interceptor.attachAsync(module.getExportByName(CALC_ECHO_ASYNC), {
      onComplete() {
        seen.onComplete = this.typeArguments;
        completed.fire();
      },
    });
    try {
      expect(await echo.call("hi")).toBe("hi");
      await completed.fired;
      expect(seen).toEqual({ onEnter: ["Swift.String"], onComplete: ["Swift.String"] });
    } finally {
      listener.detach();
      completionOnly.detach();
    }
  });

  test("onComplete destructures a tuple return, its elements live past a gc", async () => {
    requireSwift();
    const module = loadFixture();
    const link = Swift.function(module, MAKE_LINK).call("frida.re") as SwiftObject;
    const seen: { enter?: string; link?: string; host?: string } = {};
    const completed = signal();
    const listener = Swift.Interceptor.attachAsync(module.getExportByName(RESOLVE_LINK_ASYNC), {
      onEnter(args) {
        seen.enter = (args[0] as SwiftObject).address as string;
      },
      onComplete(retval) {
        const [resolved, host] = retval as SwiftObject[];
        gc();
        seen.link = resolved.address as string;
        seen.host = host.address as string;
        completed.fire();
      },
    });
    try {
      const [, host] = (await Swift.function(module, RESOLVE_LINK_ASYNC).call(link)) as SwiftObject[];
      expect(host.address).toBe("frida.re/resolved");
      await completed.fired;
      expect(seen).toEqual({ enter: "frida.re", link: "frida.re", host: "frida.re/resolved" });
    } finally {
      listener.detach();
    }
  });

  test("onComplete hands back an ObjC class tuple element as a raw pointer", async (ctx) => {
    requireDarwin(ctx);
    const module = loadFixture();
    const link = Swift.function(module, MAKE_LINK).call("frida.re") as SwiftObject;
    const object = newNSObject();
    let element: unknown;
    const completed = signal();
    const listener = Swift.Interceptor.attachAsync(module.getExportByName(PAIR_LINK_ASYNC), {
      onComplete(retval) {
        element = (retval as unknown[])[1];
        completed.fire();
      },
    });
    try {
      await Swift.function(module, PAIR_LINK_ASYNC).call(link, object);
      await completed.fired;
      expect(element instanceof NativePointer).toBe(true);
      expect((element as NativePointer).equals(object)).toBe(true);
    } finally {
      listener.detach();
    }
  });
});

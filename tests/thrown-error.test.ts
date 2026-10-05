import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { ClassInstance, metadataFor } from "../src/abi.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";
import { SwiftError } from "../src/runtime/thrown-error.js";
import { SwiftClosure } from "../src/runtime/closure.js";
import { closureDiscriminator, closureHashString, INDIRECT } from "../src/runtime/closure-discriminator.js";

declare function gc(): void;

function intArg(n: number): NativePointer {
  return Memory.alloc(Process.pointerSize).writeS64(n);
}

describe("thrown error box ownership", () => {
  beforeEach(() => {
    loadFixture();
  });

  test("a real thrown error box carries a live, releasable payload", () => {
    const Int = metadataFor("Swift.Int")!;
    const mightThrow = makeSwiftNativeFunction(fixtureExport("fixture.mightThrow"), Int, [Int], {
      throws: true,
    });
    let thrown: SwiftError | null = null;
    try {
      mightThrow(intArg(1));
    } catch (e) {
      thrown = e as SwiftError;
    }
    expect(thrown).not.toBe(null);
    expect(new ClassInstance(thrown!.error).retainCount).toBeGreaterThan(0);
    for (let i = 1; i <= 200; i++) {
      try {
        mightThrow(intArg(i));
      } catch {
        /* dropped: its box is released when the SwiftError is collected */
      }
    }
    gc();
    gc();
    expect(new ClassInstance(thrown!.error).retainCount).toBeGreaterThan(0);
  });

  test("a script-injected closure box is never released", () => {
    const Int = metadataFor("Swift.Int")!;
    const data = Memory.alloc(2);
    data.writeByteArray([0x01, 0x02]);
    const errorObj = Memory.alloc(Process.pointerSize).writePointer(ptr(0xabc));

    const discriminator = closureDiscriminator(closureHashString(["$sSW"], [INDIRECT]));
    const closure = SwiftClosure.overBytes(() => errorObj, discriminator, { throws: true, indirectResult: true });
    const invoke = makeSwiftNativeFunction(fixtureExport("invokeGeneric"), null, [Int, Int, { closure: true }], {
      typeArguments: [Int],
      throws: true,
    });
    const baseArg = Memory.alloc(8).writePointer(data);
    const countArg = Memory.alloc(8).writeU64(2);

    let thrown: SwiftError | null = null;
    try {
      invoke(baseArg, countArg, closure.value());
    } catch (e) {
      thrown = e as SwiftError;
    }
    expect(thrown!.error.equals(errorObj)).toBe(true);
    thrown = null;
    gc();
    gc();
    expect(errorObj.readPointer().equals(ptr(0xabc))).toBe(true);
  });
});

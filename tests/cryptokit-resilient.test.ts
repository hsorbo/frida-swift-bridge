import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift, requireDarwin } from "./swift.js";

import { isResilientValueType, metadataFor } from "../src/abi.js";

import { Swift } from "../src/index.js";

function loadCryptoKit(): void {
  requireSwift();
  if (Process.findModuleByName("CryptoKit") === null) {
    try {
      Module.load("/System/Library/Frameworks/CryptoKit.framework/CryptoKit");
    } catch (e) {
      throw new Error(`could not load CryptoKit: ${e}`);
    }
  }
}

describe("resilience in Apple frameworks", () => {
  test("CryptoKit's resilient types are detected from its exports", (ctx) => {
    requireDarwin(ctx);
    loadCryptoKit();

    expect(isResilientValueType(metadataFor("CryptoKit.SymmetricKeySize")!)).toBe(true);
    expect(isResilientValueType(metadataFor("CryptoKit.SymmetricKey")!)).toBe(true);
    expect(isResilientValueType(metadataFor("CryptoKit.HPKE.KDF")!)).toBe(true);
    expect(isResilientValueType(metadataFor("Swift.Int")!)).toBe(false);
  });

  test("a resilient initializer takes and returns its values indirectly", (ctx) => {
    requireDarwin(ctx);
    loadCryptoKit();

    const size = Swift.struct("CryptoKit.SymmetricKeySize")!.init({ bitCount: 256 })!;
    const key = Swift.struct("CryptoKit.SymmetricKey")!.init({ size })!;
    expect(key.bitCount).toEqual(int64(256));
  });

  test("a @frozen struct marked frozen keeps the direct ABI", (ctx) => {
    requireDarwin(ctx);
    for (const name of ["Foundation.Data", "Foundation.Data.InlineData", "Foundation.Data.InlineSlice", "Foundation.Data.LargeSlice"]) {
      Swift.markFrozen(name);
    }

    expect(isResilientValueType(metadataFor("Foundation.Data")!)).toBe(false);
    const data = Swift.struct("Foundation.Data")!.init({ count: 4 })!;
    expect(data.count).toEqual(int64(4));
  });
});

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

  test("a @frozen SDK struct keeps the direct ABI without being marked frozen", (ctx) => {
    requireDarwin(ctx);

    expect(isResilientValueType(metadataFor("Foundation.Data")!)).toBe(false);
    const data = Swift.struct("Foundation.Data")!.init({ count: 4 })!;
    expect(data.count).toEqual(int64(4));
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

  test("a static of a generic framework type resolves by name without its type arguments", (ctx) => {
    requireDarwin(ctx);
    loadCryptoKit();

    const deriveKey = Swift.struct("CryptoKit.HKDF")!.$typeMethod("deriveKey(inputKeyMaterial:outputByteCount:)");
    const exported = Process.getModuleByName("CryptoKit").getExportByName(
      "$s9CryptoKit4HKDFV9deriveKey05inputE8Material15outputByteCountAA09SymmetricE0VAH_SitFZ"
    );
    expect(deriveKey.address.equals(exported.strip())).toBe(true);
  });

  test("a generic framework initializer resolves by its labels", (ctx) => {
    requireDarwin(ctx);
    loadCryptoKit();

    const init = Swift.struct("CryptoKit.SymmetricKey")!.$initializer("init(data:)");
    const exported = Process.getModuleByName("CryptoKit").getExportByName(
      "$s9CryptoKit12SymmetricKeyV4dataACx_tc10Foundation15ContiguousBytesRzlufC"
    );
    expect(init.address.equals(exported.strip())).toBe(true);
  });

  test("a generic framework instance method resolves without an instance", (ctx) => {
    requireDarwin(ctx);
    loadCryptoKit();

    const withUnsafeBytes = Swift.struct("CryptoKit.SymmetricKey")!.$type.instanceMethod("withUnsafeBytes");
    const exported = Process.getModuleByName("CryptoKit").getExportByName(
      "$s9CryptoKit12SymmetricKeyV15withUnsafeBytesyxxSWKXEKlF"
    );
    expect(withUnsafeBytes.address.equals(exported.strip())).toBe(true);
  });
});

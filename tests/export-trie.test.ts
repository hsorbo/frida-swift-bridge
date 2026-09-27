import { test, expect, describe } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";
import { loadSwiftCore } from "./swift.js";

import { exportsByPrefix } from "../src/runtime/export-trie.js";

function isReexport(module: Module, address: NativePointer): boolean {
  const owner = Process.findModuleByAddress(address);
  return owner !== null && !owner.base.equals(module.base);
}

function ownExportsWithPrefix(module: Module, prefix: string): string[] {
  return module
    .enumerateExports()
    .filter((e) => e.name.startsWith(prefix) && !isReexport(module, e.address))
    .map((e) => `${e.name}@${e.address}`)
    .sort();
}

describe("exportsByPrefix", () => {
  test("yields the module's own exports under each prefix, as enumerateExports names and signs them", () => {
    const fixture = loadFixture();
    const swiftCore = loadSwiftCore();
    for (const [module, prefixes] of [[fixture, ["$s7fixture7LabeledP", "$s7fixture"]], [swiftCore, ["$sSi", "$sSS"]]] as const) {
      const found = exportsByPrefix(module, [...prefixes]);
      prefixes.forEach((prefix, i) => {
        const expected = ownExportsWithPrefix(module, prefix);
        expect(expected.length).toBeGreaterThan(0);
        expect(found[i].map((e) => `${e.name}@${e.address}`).sort()).toEqual(expected);
      });
    }
  });

  test("a prefix nothing carries yields nothing", () => {
    expect(exportsByPrefix(loadFixture(), ["$s11NoSuchThing"])).toEqual([[]]);
  });
});

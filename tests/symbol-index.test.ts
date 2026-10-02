import { test, expect, describe } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";
import { loadSwiftCore } from "./swift.js";

import { swiftExportsOfTokens } from "../src/runtime/symbol-index.js";

function ownFunctionExportsWithPrefix(module: Module, prefix: string): string[] {
  return module
    .enumerateExports()
    .filter((e) => e.name.startsWith(prefix) && e.type === "function")
    .filter((e) => Process.findModuleByAddress(e.address.strip())?.base.equals(module.base) === true)
    .map((e) => `${e.name}@${e.address}`)
    .sort();
}

describe("swiftExportsOfTokens", () => {
  test("yields the module's own function exports under each token, as enumerateExports names and signs them", () => {
    const fixture = loadFixture();
    const swiftCore = loadSwiftCore();
    for (const [module, tokens] of [[fixture, ["7fixture7LabeledP", "7fixture"]], [swiftCore, ["Si", "SS"]]] as const) {
      const found = swiftExportsOfTokens(module, [...tokens]);
      tokens.forEach((token, i) => {
        const expected = ownFunctionExportsWithPrefix(module, `$s${token}`);
        expect(expected.length).toBeGreaterThan(0);
        expect(found[i].map((e) => `${e.name}@${e.address}`).sort()).toEqual(expected);
      });
    }
  });

  test("a token nothing carries yields nothing", () => {
    expect(swiftExportsOfTokens(loadFixture(), ["11NoSuchThing"])).toEqual([[]]);
  });

  test("keeps a re-exported symbol only under its defining module", () => {
    loadSwiftCore();
    for (const module of Process.enumerateModules()) {
      for (const e of swiftExportsOfTokens(module, ["Si"])[0]) {
        expect(Process.findModuleByAddress(e.address.strip())?.path).toBe(module.path);
      }
    }
  });
});

import { test, expect, describe } from "@frida/injest/agent";
import { loadConformance, loadNoMetadata, FIXTURE_MODULE, CONFORMANCE_MODULE } from "./fixtures/load.js";

import { swiftMatches } from "../src/runtime/swift-resolver.js";
import { fallbackSwiftMatches } from "../src/runtime/swift-resolver-fallback.js";

const addresses = (matches: ApiResolverMatch[]) => new Set(matches.map((m) => m.address.toString()));

function nativeOrSkip(query: string): ApiResolverMatch[] | null {
  try {
    return swiftMatches(query);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("unsupported Swift runtime")) {
      return null;
    }
    throw e;
  }
}

describe("the JS fallback for the Swift resolver", () => {
  const queries = () => {
    loadNoMetadata();
    const fixture = Process.getModuleByName(FIXTURE_MODULE);
    const conformance = loadConformance();
    return [
      `types:${fixture.path}!*`,
      "types:*!fixture.*",
      "types:*!fixture.Robot",
      "types:*!*.Robot",
      "types:*!(extension in fixture):*",
      "types:*!fixture.Outer.*",
      "types:*!(extension in *):Swift.Optional*.*",
      `protocols:${conformance.path}!*`,
      "protocols:*!fixture.*",
      "protocols:*!*.Flyable",
      "conformances:fixture.Robot!*",
      "conformances:*!conformance.Flyable",
      "conformances:*!fixture.Container",
    ];
  };

  test("answers every query the bridge issues with the same descriptors as the native resolver", () => {
    for (const query of queries()) {
      const native = nativeOrSkip(query);
      if (native === null) {
        return;
      }
      const fallback = fallbackSwiftMatches(query);
      expect(fallback.length).toBeGreaterThan(0);
      expect(addresses(fallback)).toEqual(addresses(native));
    }
  });

  test("spells a type declared in an extension of another module's type like the resolver", () => {
    queries();
    const fixture = Process.getModuleByName(FIXTURE_MODULE);
    const names = fallbackSwiftMatches("types:*!(extension in fixture):*").map((m) => m.name);
    expect(names).toContain(`${fixture.path}!(extension in fixture):Swift.Optional.ExtensionProbe`);
    expect(fallbackSwiftMatches("types:*!fixture.Outer.FromExt").length).toBe(1);
  });
});

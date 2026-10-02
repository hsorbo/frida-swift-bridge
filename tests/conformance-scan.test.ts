import { test, expect, describe } from "@frida/injest/agent";
import { loadSwiftCore } from "./swift.js";
import { loadFixture } from "./fixtures/load.js";

import { findType } from "../src/reflection/registry.js";
import { enumerateSwiftModules } from "../src/reflection/registry.js";
import { getSwiftSection } from "../src/image/sections.js";
import { enumerateProtocolConformances, findProtocol } from "../src/abi/protocol-conformance.js";
import { conformanceScanner } from "../src/abi/conformance-scan.js";

describe("native conformance scan", () => {
  test("agrees with the record-by-record walk in every loaded Swift module", () => {
    loadSwiftCore();
    loadFixture();
    const scanner = conformanceScanner()!;
    expect(scanner).not.toBeNull();
    const intType = findType("Swift.Int")!.handle;
    const describer = findType("fixture.DefaultDescriber")!.handle;
    const hashable = findProtocol("Swift.Hashable")!.handle;
    const labeled = findProtocol("fixture.Labeled")!.handle;
    let seen = 0;
    for (const module of enumerateSwiftModules()) {
      const section = getSwiftSection(module, "__swift5_proto");
      if (section === null) {
        continue;
      }
      const expected = [...enumerateProtocolConformances(module)]
        .filter((c) => c.typeDescriptor !== null && c.protocol !== null)
        .map((c) => `${c.typeDescriptor}:${c.protocol!.handle}`)
        .sort();
      const scanned = scanner.pairsOf(section).map((p) => `${p.type}:${p.protocol}`).sort();
      expect(scanned).toEqual(expected);
      seen += expected.filter((pair) => [intType, describer, hashable, labeled].some((h) => pair.includes(h.toString()))).length;
    }
    expect(seen).toBeGreaterThan(0);
  });
});

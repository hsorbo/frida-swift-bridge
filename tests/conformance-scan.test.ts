import { test, expect, describe } from "@frida/injest/agent";
import { loadSwiftCore } from "./swift.js";
import { loadFixture } from "./fixtures/load.js";

import { findType } from "../src/reflection/registry.js";
import { enumerateSwiftModules } from "../src/reflection/registry.js";
import { getSwiftSection } from "../src/image/sections.js";
import { enumerateProtocolConformances, findProtocol } from "../src/abi/protocol-conformance.js";
import { conformanceScanner } from "../src/abi/conformance-scan.js";

function sorted(pointers: NativePointer[]): string[] {
  return pointers.map((p) => p.toString()).sort();
}

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
      const conformances = [...enumerateProtocolConformances(module)];
      for (const type of [intType, describer]) {
        const expected = conformances
          .filter((c) => c.typeDescriptor?.equals(type) && c.protocol !== null)
          .map((c) => c.protocol!.handle);
        expect(sorted(scanner.protocolsOf(section, type))).toEqual(sorted(expected));
        seen += expected.length;
      }
      for (const protocol of [hashable, labeled]) {
        const expected = conformances
          .filter((c) => c.protocol?.handle.equals(protocol) && c.typeDescriptor !== null)
          .map((c) => c.typeDescriptor!);
        expect(sorted(scanner.typesOf(section, protocol))).toEqual(sorted(expected));
        seen += expected.length;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

import { test, expect, describe } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms, FIXTURESYMS_MODULE } from "./fixtures/load.js";

import { findType } from "../src/reflection/registry.js";
import { findProtocol } from "../src/abi/protocol-conformance.js";

// Sorts before every file that loads fixturesyms, keeping the bare name unique at first lookup.
describe("bare-name invalidation", () => {
  test("a later-loaded image makes a previously unique bare name ambiguous", () => {
    loadFixture();
    // Hard precondition: this file must keep sorting before every file that loads fixturesyms.
    expect(Process.findModuleByName(FIXTURESYMS_MODULE)).toBeNull();
    expect(findType("LoadableStruct")!.fullTypeName).toBe("fixture.LoadableStruct");
    expect(findProtocol("Greeter")!.fullTypeName).toBe("fixture.Greeter");
    loadFixtureSyms();
    expect(() => findType("LoadableStruct")).toThrow(/ambiguous/);
    expect(() => findProtocol("Greeter")).toThrow(/ambiguous/);
  });
});

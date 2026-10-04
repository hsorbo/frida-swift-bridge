import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, FIXTURE_MODULE, FIXTURESYMS_MODULE } from "./fixtures/load.js";
import { requireDarwin } from "./swift.js";

import { Swift, SwiftStruct, SwiftEnum } from "../src/index.js";
import { resolveType } from "../src/runtime/symbolication.js";

describe("C types imported under the __C module", () => {
  beforeEach(() => { loadFixture(); });

  test("enumerateTypes yields them and their facades list members", () => {
    const names = new Set(Array.from(Swift.enumerateTypes("__C.CFixture*"), (t) => t.$type.name));
    expect([...names].sort()).toEqual(["__C.CFixtureFlags", "__C.CFixtureMode", "__C.CFixturePoint"]);
    for (const type of Swift.enumerateTypes("__C.CFixture*")) {
      expect(() => Object.keys(type)).not.toThrow();
      expect(() => type.$type.properties()).not.toThrow();
    }
    const CFixturePoint = Swift.type("__C.CFixturePoint")!;
    expect(CFixturePoint.$type.instanceMethods()).toContain("sum()");
    // fixturesyms is the same source, so whichever image is scanned first declares the extension.
    const origin = CFixturePoint.$type.instanceMethod("sum()").origin;
    expect([FIXTURE_MODULE, FIXTURESYMS_MODULE]).toContain(origin.module);
    expect({ ...origin, module: FIXTURE_MODULE }).toEqual({ kind: "extension", type: "__C.CFixturePoint", module: FIXTURE_MODULE });
  });

  test("Swift.type resolves a C struct, a C enum and a C option set by qualified name", () => {
    const CFixturePoint = Swift.type("__C.CFixturePoint") as SwiftStruct;
    expect(CFixturePoint instanceof SwiftStruct).toBe(true);
    expect(CFixturePoint.$type.moduleName).toBe("__C");
    expect(CFixturePoint.$type.fields.map((f) => f.name)).toEqual(["x", "y"]);
    expect(Swift.type("__C.CFixtureMode") instanceof SwiftEnum).toBe(true);
    expect(Swift.type("__C.CFixtureFlags") instanceof SwiftStruct).toBe(true);
    expect(Swift.type("__C.NoSuchType")).toBeNull();
  });

  test("resolveType reaches the descriptor of a C type", () => {
    expect(resolveType("__C.CFixturePoint")).not.toBeNull();
    expect(resolveType("__C.CFixtureMode")).not.toBeNull();
    expect(resolveType("__C.NoSuchType")).toBeNull();
  });

  // A CF type has a class descriptor but foreign-class metadata, so it has no ObjC superclass chain
  // to walk.
  test("a foreign class lists its members without an ObjC superclass walk", (ctx) => {
    requireDarwin(ctx);
    const CGColor = Swift.type("__C.CGColor")!;
    expect(CGColor.$type.kind).toBe("class");
    expect(() => CGColor.$type.properties()).not.toThrow();
    expect(() => CGColor.$type.instanceMethods()).not.toThrow();
    expect("noSuchMember" in CGColor).toBe(false);
  });
});

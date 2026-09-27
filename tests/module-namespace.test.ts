import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, ClassType, StructType } from "../src/index.js";
import type { StableProtocol } from "../src/runtime/protocol.js";

describe("Swift.modules", () => {
  beforeEach(() => { loadFixture(); });

  test("touching the namespace scans nothing", () => {
    const enumerateModules = Process.enumerateModules;
    let scans = 0;
    Process.enumerateModules = () => {
      scans++;
      return enumerateModules.call(Process);
    };
    try {
      const modules = Swift.modules;
      expect(String(modules)).toBe("Swift.modules");
    } finally {
      Process.enumerateModules = enumerateModules;
    }
    expect(scans).toBe(0);
  });

  test("resolves a module by its Swift module name", () => {
    expect("fixture" in Swift.modules).toBeTruthy();
    expect(Swift.modules.fixture).not.toBeUndefined();
    expect(Swift.modules.Swift).not.toBeUndefined();
  });

  test("an unknown module reads as undefined", () => {
    expect(Swift.modules.noSuchModuleQX).toBeUndefined();
    expect("noSuchModuleQX" in Swift.modules).toBeFalsy();
  });

  test("lists the loaded Swift modules", () => {
    const names = Object.keys(Swift.modules);
    expect(names).toContain("fixture");
    expect(names).toContain("Swift");
  });

  test("resolves a type in the module by its bare name", () => {
    const robot = Swift.modules.fixture.Robot as ClassType;
    expect(robot instanceof ClassType).toBeTruthy();
    expect(robot.name).toBe("fixture.Robot");
    expect((Swift.modules.Swift.Int as StructType).name).toBe("Swift.Int");
  });

  test("resolves a protocol in the module by its bare name", () => {
    expect((Swift.modules.fixture.Greeter as StableProtocol).fullName).toBe("fixture.Greeter");
  });

  test("an unknown member reads as undefined", () => {
    expect(Swift.modules.fixture.NoSuchTypeQX).toBeUndefined();
    expect("NoSuchTypeQX" in Swift.modules.fixture).toBeFalsy();
    expect("Robot" in Swift.modules.fixture).toBeTruthy();
  });

  test("lists the module's top-level types and protocols only", () => {
    const names = Object.keys(Swift.modules.fixture);
    expect(names).toContain("Robot");
    expect(names).toContain("Outer");
    expect(names).toContain("Greeter");
    expect(names).not.toContain("Inner");
    expect(names).not.toContain("Int");
  });

  test("serializes to the names it lists, without descending into members", () => {
    const modules = JSON.parse(JSON.stringify(Swift.modules));
    expect(Array.isArray(modules)).toBeTruthy();
    expect(modules).toContain("fixture");
    const fixture = JSON.parse(JSON.stringify(Swift.modules.fixture));
    expect(Array.isArray(fixture)).toBeTruthy();
    expect(fixture).toContain("Robot");
  });
});

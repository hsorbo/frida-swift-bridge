import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift, SWIFTCORE_MODULE } from "./swift.js";
import {
  loadResilient,
  RESILIENT_MODULE,
  loadFixture,
  FIXTURE_MODULE,
  loadFixtureSyms,
} from "./fixtures/load.js";

import { Swift, SwiftType, ClassType, StructType, EnumType } from "../src/index.js";
import { metadataOf, descriptorOf } from "../src/abi.js";
import {
  enumerateSwiftModules,
  enumerateTypes,
  findType,
  swiftTypes,
} from "../src/reflection/registry.js";
import { ContextDescriptorKind } from "../src/abi/context-descriptor.js";

describe("registry", () => {
  test("discovers libswiftCore as a Swift-bearing module", () => {
    requireSwift();
    const names = new Set([...enumerateSwiftModules()].map((m) => m.name));
    expect(names.has(SWIFTCORE_MODULE)).toBeTruthy();
  });

  test("discovers a module loaded at runtime", () => {
    loadResilient();
    const names = new Set([...enumerateSwiftModules()].map((m) => m.name));
    expect(names.has(RESILIENT_MODULE)).toBeTruthy();
    expect(findType("resilient.ResilientPoint")).not.toBeNull();
  });

  test("enumerated types are all type-kind descriptors", () => {
    requireSwift();
    const lib = Process.getModuleByName(SWIFTCORE_MODULE);
    let count = 0;
    for (const descriptor of enumerateTypes(lib)) {
      expect(descriptor.isType).toBeTruthy();
      count++;
    }
    expect(count).toBeGreaterThan(0);
  });

  test("finds a type by qualified name", () => {
    requireSwift();
    const int = findType("Swift.Int");
    expect(int).not.toBeNull();
    expect(int!.kind).toBe(ContextDescriptorKind.Struct);
    expect(int!.fullTypeName).toBe("Swift.Int");
  });

  test("finds a type by a uniquely-resolving simple name", () => {
    loadResilient();
    const point = findType("ResilientPoint");
    expect(point).not.toBeNull();
    expect(point!.fullTypeName).toBe("resilient.ResilientPoint");
  });

  test("returns null for an unknown type", () => {
    requireSwift();
    expect(findType("Swift.NoSuchTypeQX")).toBeNull();
  });

  test("rejects an ambiguous bare name but resolves each qualified form", () => {
    loadFixture();
    loadFixtureSyms();
    expect(() => findType("LoadableStruct")).toThrow(/ambiguous/);
    expect(findType("fixture.LoadableStruct")!.fullTypeName).toBe("fixture.LoadableStruct");
    expect(findType("fixturesyms.LoadableStruct")!.fullTypeName).toBe(
      "fixturesyms.LoadableStruct"
    );
  });

  test("resolves an extension-nested type under its extended type's demangled name", () => {
    loadFixture();
    const qualified = findType("Swift.Optional.ExtensionProbe");
    expect(qualified).not.toBeNull();
    expect(qualified!.fullTypeName).toBe("Swift.Optional.ExtensionProbe");
    expect(findType("ExtensionProbe")!.fullTypeName).toBe("Swift.Optional.ExtensionProbe");
  });

  test("repeated lookups are cached to the same descriptor", () => {
    requireSwift();
    const first = findType("Swift.Int")!;
    const second = findType("Swift.Int")!;
    expect(first.handle.equals(second.handle)).toBeTruthy();
  });

  test("Swift.type resolves a stdlib type", () => {
    requireSwift();
    expect(Swift.type("Swift.String")).not.toBeNull();
  });

  test("Swift.images() yields Swift-bearing modules", () => {
    requireSwift();
    const names = new Set([...Swift.images()].map((m) => m.name));
    expect(names.has(SWIFTCORE_MODULE)).toBeTruthy();
  });

  test("Swift.enumerateTypes(module) yields lazy type wrappers", () => {
    requireSwift();
    const lib = Process.getModuleByName(SWIFTCORE_MODULE);
    let count = 0;
    for (const type of Swift.enumerateTypes(lib)) {
      expect(type instanceof SwiftType).toBeTruthy();
      expect(descriptorOf(type).isType).toBeTruthy();
      count++;
    }
    expect(count).toBeGreaterThan(0);
  });

  test("Swift.enumerateTypes() reflects modules loaded after first enumeration", () => {
    requireSwift();
    [...Swift.images()];
    loadResilient();
    const names = new Set([...Swift.images()].map((m) => m.name));
    expect(names.has(RESILIENT_MODULE)).toBeTruthy();
    const types = new Set([...Swift.enumerateTypes()].map((t) => t.name));
    expect(types.has("resilient.ResilientPoint")).toBeTruthy();
  });

  test("Swift.enumerateTypes(module) is memoized to a stable parse", () => {
    requireSwift();
    const lib = Process.getModuleByName(SWIFTCORE_MODULE);
    const find = (name: string) =>
      [...Swift.enumerateTypes(lib)].find((t) => t.name === name) ?? null;
    const first = find("Swift.Int");
    const second = find("Swift.Int");
    expect(first).not.toBeNull();
    expect(descriptorOf(first!).handle.equals(descriptorOf(second!).handle)).toBeTruthy();
  });

  test("interleaved partial enumerations share one scan", () => {
    requireSwift();
    const lib = Process.getModuleByName(SWIFTCORE_MODULE);
    const a = swiftTypes(lib);
    const b = swiftTypes(lib);
    expect(a.next().value!.handle.equals(b.next().value!.handle)).toBeTruthy();
    expect(a.next().value!.handle.equals(b.next().value!.handle)).toBeTruthy();
  });

  test("Swift.type finds a wrapper by name", () => {
    requireSwift();
    const t = Swift.type("Swift.Int");
    expect(t instanceof StructType).toBeTruthy();
    expect(t!.name).toBe("Swift.Int");
    expect(Swift.type("Swift.NoSuchTypeQX")).toBeNull();
  });

  test("Swift.enumerateClasses/Structs/Enums yield matching wrapper kinds", () => {
    loadFixture();
    const fixture = Process.getModuleByName(FIXTURE_MODULE);
    const classes = [...Swift.enumerateClasses(fixture)];
    const structs = [...Swift.enumerateStructs(fixture)];
    const enums = [...Swift.enumerateEnums(fixture)];
    expect(classes.length).toBeGreaterThan(0);
    expect(structs.length).toBeGreaterThan(0);
    expect(enums.length).toBeGreaterThan(0);
    expect(classes.every((t) => t instanceof ClassType)).toBeTruthy();
    expect(structs.every((t) => t instanceof StructType)).toBeTruthy();
    expect(enums.every((t) => t instanceof EnumType)).toBeTruthy();
  });

  test("enumeration names generic types without realizing metadata", () => {
    loadFixture();
    const fixture = Process.getModuleByName(FIXTURE_MODULE);
    const box = [...Swift.enumerateStructs(fixture)].find((t) => t.name === "fixture.ConstrainedBox")!;
    expect(box.toJSON().kind).toBe("struct");
    expect(() => metadataOf(box)).toThrow();
  });
});

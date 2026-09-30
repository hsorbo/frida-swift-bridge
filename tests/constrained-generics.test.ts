import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift, requireDarwin } from "./swift.js";
import { loadFixture } from "./fixtures/load.js";

import { findType } from "../src/reflection/registry.js";
import { MetadataKind, instantiateGenericMetadata } from "../src/abi/metadata.js";
import { buildGenericMetadata, genericRequirements } from "../src/abi/generic-instantiation.js";
import { findProtocol, conformsToProtocol } from "../src/abi/protocol-conformance.js";

import { metadataFor } from "../src/abi.js";
import { typeName } from "../src/runtime/type-name.js";
describe("constrained generic auto-assembly", () => {
  test("Dictionary<String,Int> instantiates without supplying a witness table", () => {
    requireSwift();
    const dictionary = metadataFor("Swift.Dictionary", [
      metadataFor("Swift.String")!,
      metadataFor("Swift.Int")!,
    ]);
    expect(dictionary).not.toBeNull();
    expect(dictionary!.kind).toBe(MetadataKind.Struct);
    expect(dictionary!.description.handle.equals(findType("Swift.Dictionary")!.handle)).toBeTruthy();
  });

  test("Set<Int> resolves its Hashable requirement", () => {
    requireSwift();
    const set = metadataFor("Swift.Set", [metadataFor("Swift.Int")!]);
    expect(set).not.toBeNull();
    expect(set!.kind).toBe(MetadataKind.Struct);
  });

  test("auto-assembly matches a hand-built key-argument vector", () => {
    requireSwift();
    const string = metadataFor("Swift.String")!;
    const int = metadataFor("Swift.Int")!;
    const manual = instantiateGenericMetadata(findType("Swift.Dictionary")!, [
      string.handle,
      int.handle,
      conformsToProtocol(string, findProtocol("Swift.Hashable")!)!,
    ]);
    const auto = buildGenericMetadata(findType("Swift.Dictionary")!, [string, int]);
    expect(auto.handle.equals(manual.handle)).toBeTruthy();
  });

  test("unconstrained generics still work through the same path", () => {
    requireSwift();
    const arrayInt = metadataFor("Swift.Array", [metadataFor("Swift.Int")!]);
    expect(arrayInt!.kind).toBe(MetadataKind.Struct);
  });

  test("an Objective-C protocol requirement takes no witness table", (ctx) => {
    requireDarwin(ctx);
    loadFixture();
    const [requirement] = genericRequirements(findType("fixture.ObjCProtocolBox")!);
    expect(requirement.isObjCProtocol).toBe(true);
    expect(requirement.hasKeyArgument).toBe(false);

    const box = metadataFor("fixture.ObjCProtocolBox", [metadataFor("fixture.ObjCConformer")!]);
    expect(typeName(box!)).toBe("fixture.ObjCProtocolBox<fixture.ObjCConformer>");
  });

  test("an Objective-C protocol requirement rejects a non-conforming type", (ctx) => {
    requireDarwin(ctx);
    loadFixture();
    expect(() => metadataFor("fixture.ObjCProtocolBox", [metadataFor("Swift.Int")!])).toThrow(/Objective-C protocol/);
  });

  test("a superclass requirement accepts the class and its subclasses only", () => {
    loadFixture();
    expect(typeName(metadataFor("fixture.BaseBox", [metadataFor("fixture.Base")!])!)).toBe("fixture.BaseBox<fixture.Base>");
    expect(typeName(metadataFor("fixture.BaseBox", [metadataFor("fixture.Derived")!])!)).toBe("fixture.BaseBox<fixture.Derived>");
    expect(() => metadataFor("fixture.BaseBox", [metadataFor("fixture.Pup")!])).toThrow(/superclass/);
    expect(() => metadataFor("fixture.BaseBox", [metadataFor("Swift.Int")!])).toThrow(/superclass/);
  });

  test("an AnyObject requirement rejects value types", () => {
    loadFixture();
    expect(typeName(metadataFor("fixture.ObjectBox", [metadataFor("fixture.Pup")!])!)).toBe("fixture.ObjectBox<fixture.Pup>");
    expect(() => metadataFor("fixture.ObjectBox", [metadataFor("Swift.Int")!])).toThrow(/class constraint/);
  });

  test("a same-type requirement on an associated type is checked", () => {
    loadFixture();
    const int = metadataFor("Swift.Int")!;
    const ints = metadataFor("Swift.Array", [int])!;
    expect(typeName(metadataFor("fixture.IntElements", [ints])!)).toBe("fixture.IntElements<Swift.Array<Swift.Int>>");
    const strings = metadataFor("Swift.Array", [metadataFor("Swift.String")!])!;
    expect(() => metadataFor("fixture.IntElements", [strings])).toThrow(/same-type/);
  });
});

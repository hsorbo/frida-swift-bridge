import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift } from "./swift.js";

import { Swift } from "../src/index.js";
import { findType } from "../src/reflection/registry.js";
import { getGenericMetadata, MetadataKind } from "../src/abi/metadata.js";

import { metadataFor, typeOf } from "../src/abi.js";
describe("generic metadata", () => {
  test("instantiates Array<Int> through the generic accessor", () => {
    requireSwift();
    const int = metadataFor("Swift.Int")!;
    const arrayInt = metadataFor("Swift.Array", [int])!;
    expect(arrayInt.kind).toBe(MetadataKind.Struct);
    expect(typeOf(arrayInt).layout.size).toBe(Process.pointerSize);
  });

  test("instantiates Optional<Int> as a value type", () => {
    requireSwift();
    const int = metadataFor("Swift.Int")!;
    const optionalInt = metadataFor("Swift.Optional", [int])!;
    expect(optionalInt.kind).toBe(MetadataKind.Optional);
  });

  test("distinct type arguments yield distinct, cached metadata", () => {
    requireSwift();
    const int = metadataFor("Swift.Int")!;
    const string = metadataFor("Swift.String")!;
    const arrayInt = metadataFor("Swift.Array", [int])!;
    const arrayIntAgain = metadataFor("Swift.Array", [int])!;
    const arrayString = metadataFor("Swift.Array", [string])!;
    expect(arrayInt.handle.equals(arrayIntAgain.handle)).toBeTruthy();
    expect(arrayInt.handle.equals(arrayString.handle)).toBeFalsy();
  });

  test("nests generic instantiations (Array<Array<Int>>)", () => {
    requireSwift();
    const int = metadataFor("Swift.Int")!;
    const arrayInt = metadataFor("Swift.Array", [int])!;
    const nested = metadataFor("Swift.Array", [arrayInt])!;
    expect(nested.kind).toBe(MetadataKind.Struct);
    expect(nested.handle.equals(arrayInt.handle)).toBeFalsy();
  });

  test("rejects a wrong number of type arguments", () => {
    requireSwift();
    const array = findType("Swift.Array")!;
    expect(() => getGenericMetadata(array, [])).toThrow();
  });

  test("rejects generics with conformance requirements", () => {
    requireSwift();
    const int = metadataFor("Swift.Int")!;
    const string = metadataFor("Swift.String")!;
    const dictionary = findType("Swift.Dictionary")!;
    expect(() => getGenericMetadata(dictionary, [string, int])).toThrow();
  });
});

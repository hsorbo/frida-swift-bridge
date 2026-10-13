import { test, expect, describe } from "@frida/injest/agent";
import { loadSwiftCore } from "./swift.js";
import { loadFixture, loadFixtureSyms } from "./fixtures/load.js";

import { Swift } from "../src/index.js";
import { findType } from "../src/reflection/registry.js";
import { MetadataKind, instantiateGenericMetadata } from "../src/abi/metadata.js";
import { ContextDescriptorKind } from "../src/abi/context-descriptor.js";
import {
  enumerateProtocolConformances,
  findProtocol,
  conformsToProtocol,
  conformancesOf,
  witnessTableOf,
} from "../src/abi/protocol-conformance.js";

import { metadataFor } from "../src/abi.js";
describe("protocol conformances", () => {
  test("enumerates conformances whose protocol resolves", () => {
    const lib = loadSwiftCore();
    let count = 0;
    let named = 0;
    for (const conformance of enumerateProtocolConformances(lib)) {
      count++;
      const protocol = conformance.protocol;
      if (protocol !== null && protocol.kind === ContextDescriptorKind.Protocol) {
        named++;
      }
    }
    expect(count).toBeGreaterThan(0);
    expect(named).toBeGreaterThan(0);
  });

  test("finds a stdlib protocol descriptor by name", () => {
    loadSwiftCore();
    const hashable = findProtocol("Swift.Hashable");
    expect(hashable).not.toBeNull();
    expect(hashable!.kind).toBe(ContextDescriptorKind.Protocol);
  });

  test("returns a witness table when a type conforms", () => {
    loadSwiftCore();
    const witnessTable = conformsToProtocol(
      metadataFor("Swift.Int")!,
      findProtocol("Swift.Hashable")!
    );
    expect(witnessTable).not.toBeNull();
  });

  test("returns null when a type does not conform", () => {
    loadSwiftCore();
    const sequence = findProtocol("Swift.Sequence");
    expect(sequence).not.toBeNull();
    expect(conformsToProtocol(metadataFor("Swift.Int")!, sequence!)).toBeNull();
  });

  test("an unconditional conformance's table is the pattern its record carries", () => {
    loadFixture();
    const politeGreeter = metadataFor("fixture.PoliteGreeter")!;
    const conformance = conformancesOf(findType("fixture.PoliteGreeter")!.handle).find((c) => c.protocol.fullTypeName === "fixture.Greeter")!;
    expect(conformance.record.hasGenericWitnessTable).toBe(false);
    expect(witnessTableOf(conformance, politeGreeter)!.equals(conformance.record.witnessTablePattern!)).toBe(true);
    expect(witnessTableOf(conformance, politeGreeter)!.equals(conformsToProtocol(politeGreeter, conformance.protocol)!)).toBe(true);
  });

  test("a conditional conformance's table is the runtime's instantiation for the type", () => {
    loadFixture();
    const conformance = conformancesOf(findType("fixture.Pair")!.handle).find((c) => c.protocol.fullTypeName === "fixture.Greeter")!;
    expect(conformance.record.hasGenericWitnessTable).toBe(true);
    const pairOfGreeters = metadataFor("fixture.Pair", [metadataFor("fixture.PoliteGreeter")!])!;
    expect(witnessTableOf(conformance, pairOfGreeters)!.equals(conformsToProtocol(pairOfGreeters, conformance.protocol)!)).toBe(true);
    expect(witnessTableOf(conformance, metadataFor("fixture.Pair", [metadataFor("Swift.Int")!])!)).toBeNull();
  });

  test("instantiates a constrained generic with a witness-table key argument", () => {
    loadSwiftCore();
    const string = metadataFor("Swift.String")!;
    const int = metadataFor("Swift.Int")!;
    const keyHashableWitness = conformsToProtocol(string, findProtocol("Swift.Hashable")!)!;

    const dictionary = instantiateGenericMetadata(findType("Swift.Dictionary")!, [
      string.handle,
      int.handle,
      keyHashableWitness,
    ]);
    expect(dictionary.kind).toBe(MetadataKind.Struct);
    expect(dictionary.description.handle.equals(findType("Swift.Dictionary")!.handle)).toBeTruthy();
  });
});

describe("findProtocol", () => {
  test("resolves a protocol nested in a type by its full name", (ctx) => {
    loadFixture();
    const declared = [...Swift.enumerateProtocols()].some((p) => p.fullName === "fixture.Outer.Marker");
    if (!declared) ctx.skip("fixture compiled without nested protocols (Swift < 5.10)");
    expect(findProtocol("fixture.Outer.Marker")!.fullTypeName).toBe("fixture.Outer.Marker");
  });

  test("resolves a unique bare name", () => {
    loadSwiftCore();
    expect(findProtocol("Hashable")!.fullTypeName).toBe("Swift.Hashable");
  });

  test("rejects a bare name two modules share but resolves each qualified form", () => {
    loadFixture();
    loadFixtureSyms();
    expect(() => findProtocol("Greeter")).toThrow(`: fixture.Greeter, fixturesyms.Greeter; qualify it with a module`);
    expect(findProtocol("fixture.Greeter")!.fullTypeName).toBe("fixture.Greeter");
    expect(findProtocol("fixturesyms.Greeter")!.fullTypeName).toBe("fixturesyms.Greeter");
  });
});

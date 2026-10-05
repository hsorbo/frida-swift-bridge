import { test, expect, describe } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms, fixtureExport, existentialMetadata } from "./fixtures/load.js";
import { requireSymbolTable } from "./swift.js";

import { Metadata, Protocol, projectExistentialValue, readProtocolRequirements, bindWitnessMethodAt, metadataFor, ValueInstance } from "../src/abi.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";

import { Swift } from "../src/index.js";
function ptrValue(p: NativePointer): NativePointer {
  const cell = Memory.alloc(Process.pointerSize);
  cell.writePointer(p);
  return cell;
}

function store(mod: Module, fn: string, metadata: Metadata): NativePointer {
  const RawPointer = metadataFor("Swift.UnsafeMutableRawPointer")!;
  const container = Memory.alloc(metadata.typeLayout.stride);
  makeSwiftNativeFunction(fixtureExport(fn, mod), null, [RawPointer])(ptrValue(container));
  return container;
}

describe("witness-table method invocation", () => {
  test("calls a value-existential requirement by name (opaque, PoliteGreeter : Greeter)", (ctx) => {
    requireSymbolTable(ctx);
    const mod = loadFixtureSyms();
    const Greeter = existentialMetadata("fixturesyms.greeterType", mod);
    const container = store(mod, "fixturesyms.storeGreeter", Greeter);
    const { type, value } = projectExistentialValue(Greeter, container);

    const greeter = Protocol.find("fixturesyms.Greeter")!;
    const table = greeter.conformanceFor(type)!;
    expect(table.method(value, "greet").call()).toBe("Hello, Ada");
  });

  test("reads a class-existential requirement by name (Widget : Named)", (ctx) => {
    requireSymbolTable(ctx);
    const mod = loadFixtureSyms();
    const Named = existentialMetadata("fixturesyms.namedType", mod);
    const container = store(mod, "fixturesyms.storeNamed", Named);
    const { type, value } = projectExistentialValue(Named, container);

    const named = Protocol.find("fixturesyms.Named")!;
    const table = named.conformanceFor(type)!;
    expect(table.get(value, "label")).toBe("Bee");
  });

  test("dispatches one concrete value through two unrelated protocols (Person : Greeter, Aged)", (ctx) => {
    requireSymbolTable(ctx);
    const mod = loadFixtureSyms();
    const GreeterAged = existentialMetadata("fixturesyms.greeterAgedType", mod);
    const make = makeSwiftNativeFunction(fixtureExport("fixturesyms.makeGreeterAged", mod), GreeterAged, []);
    const container = make()!;
    const { type, value } = projectExistentialValue(GreeterAged, container);

    const greeter = Protocol.find("fixturesyms.Greeter")!;
    const aged = Protocol.find("fixturesyms.Aged")!;
    expect(greeter.conformanceFor(type)!.method(value, "greet").call()).toBe("Hi, Cy");
    expect(aged.conformanceFor(type)!.get(value, "age")).toEqual(int64(9));
  });

  test("calls a default implementation from a protocol extension (DefaultDescriber : Labeled)", () => {
    loadFixtureSyms();
    const type = metadataFor("fixturesyms.DefaultDescriber")!;
    const value = ValueInstance.fromJS(type, { displayName: "Ada" }).handle;

    const table = Protocol.find("fixturesyms.Labeled")!.conformanceFor(type)!;
    expect(table.method(value, "describe").call()).toBe("<Ada>");
  });

  test("reads a default getter from a protocol extension (DefaultDescriber : Labeled)", () => {
    loadFixtureSyms();
    const type = metadataFor("fixturesyms.DefaultDescriber")!;
    const value = ValueInstance.fromJS(type, { displayName: "Ada" }).handle;

    const table = Protocol.find("fixturesyms.Labeled")!.conformanceFor(type)!;
    expect(table.get(value, "badge")).toBe("[Ada]");
  });

  test("calls a protocol-extension method that is not a requirement, from a stripped conformance", () => {
    loadFixture();
    const type = metadataFor("fixture.DefaultDescriber")!;
    const value = ValueInstance.fromJS(type, { displayName: "Ada" }).handle;

    const table = Protocol.find("fixture.Labeled")!.conformanceFor(type)!;
    expect(table.method(value, "shout").call()).toBe("ADA");
  });

  test("reads a protocol-extension property that is not a requirement, from a stripped conformance", () => {
    loadFixture();
    const type = metadataFor("fixture.DefaultDescriber")!;
    const value = ValueInstance.fromJS(type, { displayName: "Ada" }).handle;

    const table = Protocol.find("fixture.Labeled")!.conformanceFor(type)!;
    expect(table.get(value, "initial")).toBe("A");
  });

  test("a requirement reached through its default's name still dispatches to the override", () => {
    loadFixture();
    const labeled = Protocol.find("fixture.Labeled")!;
    const describe = (typeName: string) => {
      const type = metadataFor(typeName)!;
      const value = ValueInstance.fromJS(type, { displayName: "Ada" }).handle;
      return labeled.conformanceFor(type)!.method(value, "describe").call();
    };
    expect(describe("fixture.DefaultDescriber")).toBe("<Ada>");
    expect(describe("fixture.CustomDescriber")).toBe("custom:Ada");
  });

  test("unknown requirement name throws", () => {
    const mod = loadFixtureSyms();
    const Greeter = existentialMetadata("fixturesyms.greeterType", mod);
    const container = store(mod, "fixturesyms.storeGreeter", Greeter);
    const { type, value } = projectExistentialValue(Greeter, container);

    const greeter = Protocol.find("fixturesyms.Greeter")!;
    const table = greeter.conformanceFor(type)!;
    expect(() => table.method(value, "bogus")).toThrow(/no requirement/);
  });

  // No name recovery needed, so this works against fixture's stripped conformance.
  test("bindWitnessMethodAt invokes a requirement slot with a manually-supplied signature", () => {
    const mod = loadFixture();
    const Greeter = existentialMetadata("fixture.greeterType", mod);
    const container = store(mod, "fixture.storeGreeter", Greeter);
    const { type, value } = projectExistentialValue(Greeter, container);

    const greeter = Protocol.find("fixture.Greeter")!;
    const table = greeter.conformanceFor(type)!;
    const witnessIndex = readProtocolRequirements(greeter.descriptor)[0].witnessIndex;
    const String_ = metadataFor("Swift.String")!;
    const bound = bindWitnessMethodAt(table, witnessIndex, value, { argTypes: [], returnType: String_ });
    expect(bound.call()).toBe("Hello, Ada");
  });

  test("a stripped conformance's witness thunk is unrecoverable, so name-based dispatch throws", () => {
    const mod = loadFixture();
    const Greeter = existentialMetadata("fixture.greeterType", mod);
    const container = store(mod, "fixture.storeGreeter", Greeter);
    const { type, value } = projectExistentialValue(Greeter, container);

    const greeter = Protocol.find("fixture.Greeter")!;
    const table = greeter.conformanceFor(type)!;
    expect(() => table.method(value, "greet")).toThrow(/no requirement/);
  });
});

import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms } from "./fixtures/load.js";
import { requireSymbolTable } from "./swift.js";

import { Protocol, ProtocolConformance, BoundMethod, ProtocolRequirementKind, readProtocolRequirements, readAssociatedTypeNames, ValueInstance, metadataFor, typeName } from "../src/abi.js";

import { Swift, ClassType, SwiftObject } from "../src/index.js";
import { typeOf } from "../src/abi.js";
describe("associated type / associated conformance resolution", () => {
  beforeEach(() => { loadFixture(); });

  test("readAssociatedTypeNames lists only associated-type requirements, in order", () => {
    const container = Protocol.find("fixture.Container")!;
    expect(readAssociatedTypeNames(container.descriptor)).toEqual(["Item"]);
  });

  test("resolves a plain associated type by name (Container.Item on IntBox)", () => {
    const container = Protocol.find("fixture.Container")!;
    const intBox = metadataFor("fixture.IntBox")!;
    const table = container.conformanceFor(intBox)!;
    expect(typeName(table.associatedType("Item"))).toBe("Swift.Int");
  });

  test("dispatches a named getter whose type is an associated type (Container.item on IntBox)", (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const container = Protocol.find("fixturesyms.Container")!;
    const intBox = metadataFor("fixturesyms.IntBox")!;
    const table = container.conformanceFor(intBox)!;
    const value = ValueInstance.fromJS(intBox, { item: 5 });
    expect(table.get(value.handle, "item")).toEqual(int64(5));
  });

  test("a stripped conformance's witness thunk is unrecoverable, so the named getter throws", () => {
    const container = Protocol.find("fixture.Container")!;
    const intBox = metadataFor("fixture.IntBox")!;
    const table = container.conformanceFor(intBox)!;
    const value = ValueInstance.fromJS(intBox, { item: 5 });
    expect(() => table.get(value.handle, "item")).toThrow(/no getter/);
  });

  test("unknown associated type name throws", () => {
    const container = Protocol.find("fixture.Container")!;
    const intBox = metadataFor("fixture.IntBox")!;
    const table = container.conformanceFor(intBox)!;
    expect(() => table.associatedType("Bogus")).toThrow(/no associated type/);
  });

  test("resolves an associated conformance and dispatches through the nested witness table (ConstrainedContainer.Item: Scalable on ScalableBox)", (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const constrained = Protocol.find("fixturesyms.ConstrainedContainer")!;
    const scalableBox = metadataFor("fixturesyms.ScalableBox")!;
    const table = constrained.conformanceFor(scalableBox)!;

    const itemType = table.associatedType("Item");
    expect(typeName(itemType)).toBe("fixturesyms.WideScalar");

    const requirement = readProtocolRequirements(constrained.descriptor).find(
      (r) => r.kind === ProtocolRequirementKind.AssociatedConformanceAccessFunction
    )!;
    const nested = table.associatedConformance(itemType, requirement);

    const scalable = Protocol.find("fixturesyms.Scalable")!;
    expect(
      new ProtocolConformance(nested.conformanceDescriptor).protocol!.handle.equals(
        scalable.descriptor.handle
      )
    ).toBe(true);

    const item = ValueInstance.fromJS(itemType, { a: 2, b: 3, c: 5, d: 7, e: 11 });
    // (2+3+5+7+11) * 3 = 84
    expect(nested.method(item.handle, "scaled").call(3)).toEqual(int64(84));
  });

  test("a setter of a generic struct over Item takes it indirectly even when the instantiation is loadable", (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const source = metadataFor("fixturesyms.IntSource")!;
    const table = Protocol.find("fixturesyms.ItemSource")!.conformanceFor(source)!;
    const value = ValueInstance.fromJS(source, { value: 5 });
    table.set(value.handle, "tagged", { inner: 4, tag: 3 });
    expect((value.read() as { value: number }).value).toEqual(int64(12));
  });

  test("an Item? setter takes it indirectly", (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const source = metadataFor("fixturesyms.IntSource")!;
    const table = Protocol.find("fixturesyms.ItemSource")!.conformanceFor(source)!;
    const value = ValueInstance.fromJS(source, { value: 5 });
    table.set(value.handle, "maybe", { some: 9 });
    expect((value.read() as { value: number }).value).toEqual(int64(9));
  });

  test("an [Item] getter returns directly", (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const source = metadataFor("fixturesyms.IntSource")!;
    const table = Protocol.find("fixturesyms.ItemSource")!.conformanceFor(source)!;
    const value = ValueInstance.fromJS(source, { value: 5 });
    expect((table.get(value.handle, "items") as SwiftObject).$container!()).toEqual([int64(5), int64(5)]);
  });

  test("a requirement passes and returns Self indirectly for a loadable conformer", (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const source = metadataFor("fixturesyms.IntSource")!;
    const table = Protocol.find("fixturesyms.ItemSource")!.conformanceFor(source)!;
    const value = ValueInstance.fromJS(source, { value: 5 });
    expect(table.method(value.handle, "merged").call({ value: 7 })).toEqual({ value: int64(12) });
  });

  test("a requirement passes and returns an associated type indirectly for a loadable conformer", (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const source = metadataFor("fixturesyms.IntSource")!;
    const table = Protocol.find("fixturesyms.ItemSource")!.conformanceFor(source)!;
    const value = ValueInstance.fromJS(source, { value: 5 });
    expect(table.method(value.handle, "shifted").call(4)).toEqual(int64(9));
  });

  test("an async requirement passes and returns an associated type indirectly for a loadable conformer", async (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const source = metadataFor("fixturesyms.IntSource")!;
    const table = Protocol.find("fixturesyms.ItemSource")!.conformanceFor(source)!;
    const value = ValueInstance.fromJS(source, { value: 5 });
    expect(await (table.method(value.handle, "shiftedLater") as BoundMethod).call(4)).toEqual(int64(9));
  });

  test("Self and a class-constrained associated type return directly in a class-constrained protocol", (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const token = (typeOf(metadataFor("fixturesyms.Token")!) as ClassType).facade.init(3) as SwiftObject;
    const pack = (typeOf(metadataFor("fixturesyms.TokenPack")!) as ClassType).facade.init(token) as SwiftObject;
    const table = Protocol.find("fixturesyms.Pack")!.conformanceFor(metadataFor("fixturesyms.TokenPack")!)!;
    expect((table.get(pack.$handle, "leader") as SwiftObject).$handle.equals(pack.$handle)).toBe(true);
    expect((table.get(pack.$handle, "pet") as SwiftObject).$handle.equals(token.$handle)).toBe(true);
  });
});

import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { requireSwift, requireSymbolTable } from "./swift.js";
import { fixtureExport, loadFixture, loadFixtureSyms, existentialMetadata } from "./fixtures/load.js";
import {
  readKeyPathBuffer,
  resolveKeyPathNames,
  hashKeyPathArguments,
  keyPathArgumentsEqual,
} from "../src/abi/keypath.js";
import type { StoredKeyPathComponent, ComputedKeyPathComponent } from "../src/abi/keypath.js";
import { typeName } from "../src/runtime/type-name.js";
import { Swift } from "../src/index.js";

import { metadataFor } from "../src/abi.js";
import { MetadataKind } from "../src/abi/metadata.js";
function keyPath(accessor: string, mod: Module = loadFixture()): NativePointer {
  return new NativeFunction(fixtureExport(accessor, mod), "pointer", [])() as NativePointer;
}

describe("readKeyPathBuffer", () => {
  beforeEach(() => {
    requireSwift();
    loadFixture();
  });

  test("reads a single stored-struct component with an inline offset", () => {
    const buffer = readKeyPathBuffer(keyPath("keyPathPointX"));
    expect(buffer.trivial).toBe(true);
    // isSingleComponent is a Swift 6.2+ runtime optimization flag, unset before it; components.length is the real measure.
    expect(buffer.hasReferencePrefix).toBe(false);
    expect(buffer.components.length).toBe(1);

    const component = buffer.components[0] as StoredKeyPathComponent;
    expect(component.kind).toBe("struct");
    expect(component.offset).toBe(0);
    expect(component.mutable).toBe(true);
    expect(component.nextType).toBeNull();
  });

  test("reads a get-only computed component", () => {
    const buffer = readKeyPathBuffer(keyPath("keyPathPointDoubled"));
    expect(buffer.components.length).toBe(1);

    const component = buffer.components[0] as ComputedKeyPathComponent;
    expect(component.kind).toBe("computed");
    expect(component.settable).toBe(false);
    expect(component.mutating).toBe(false);
    expect(component.idKind).toBe("pointer");
    expect(component.idResolution).toBe("resolved");
    expect(component.getter.isNull()).toBe(false);
    expect(component.setter).toBeNull();
    expect(component.arguments).toBeNull();
  });

  test("reads a settable, mutating computed component with a setter", () => {
    const component = readKeyPathBuffer(keyPath("keyPathRectScaled"))
      .components[0] as ComputedKeyPathComponent;
    expect(component.kind).toBe("computed");
    expect(component.settable).toBe(true);
    expect(component.mutating).toBe(true);
    expect(component.getter.isNull()).toBe(false);
    expect(component.setter).not.toBeNull();
    expect(component.setter!.isNull()).toBe(false);
    expect(component.getter.equals(component.setter!)).toBe(false);
  });

  test("decodes a subscript keypath's computed-argument buffer and witnesses", () => {
    const component = readKeyPathBuffer(keyPath("keyPathArrayIndex2"))
      .components[0] as ComputedKeyPathComponent;
    expect(component.kind).toBe("computed");

    const args = component.arguments;
    expect(args).not.toBeNull();
    expect(args!.size).toBeGreaterThan(0);
    expect(args!.data.isNull()).toBe(false);
    expect(args!.witnesses.copy.isNull()).toBe(false);
    expect(args!.witnesses.equals.isNull()).toBe(false);
    expect(args!.witnesses.hash.isNull()).toBe(false);
  });

  test("identifies subscript-argument buffers through the equals and hash witnesses", () => {
    const two = readKeyPathBuffer(keyPath("keyPathArrayIndex2"))
      .components[0] as ComputedKeyPathComponent;
    const twoAgain = readKeyPathBuffer(keyPath("keyPathArrayIndex2Again"))
      .components[0] as ComputedKeyPathComponent;
    const five = readKeyPathBuffer(keyPath("keyPathArrayIndex5"))
      .components[0] as ComputedKeyPathComponent;

    expect(keyPathArgumentsEqual(two.arguments!, twoAgain.arguments!)).toBe(true);
    expect(keyPathArgumentsEqual(two.arguments!, five.arguments!)).toBe(false);

    expect(hashKeyPathArguments(two.arguments!).equals(hashKeyPathArguments(twoAgain.arguments!))).toBe(true);
    expect(hashKeyPathArguments(two.arguments!).equals(hashKeyPathArguments(five.arguments!))).toBe(false);
  });

  test("reads a stored-class component with the field byte offset", () => {
    const component = readKeyPathBuffer(keyPath("keyPathGadgetValue"))
      .components[0] as StoredKeyPathComponent;
    expect(component.kind).toBe("class");
    expect(component.offset).toBe(Process.pointerSize * 2);
    expect(component.mutable).toBe(true);
  });

  test("walks a two-component path across the inter-component type pointer", () => {
    const buffer = readKeyPathBuffer(keyPath("keyPathLineEndX"));
    expect(buffer.isSingleComponent).toBe(false);
    expect(buffer.components.length).toBe(2);

    const first = buffer.components[0] as StoredKeyPathComponent;
    expect(first.kind).toBe("struct");
    expect(first.offset).toBe(Process.pointerSize);
    expect(first.nextType).not.toBeNull();
    expect(typeName(first.nextType!)).toBe("fixture.Point");

    const second = buffer.components[1] as StoredKeyPathComponent;
    expect(second.kind).toBe("struct");
    expect(second.offset).toBe(0);
    expect(second.nextType).toBeNull();
  });
});

describe("resolveKeyPathNames", () => {
  beforeEach(() => {
    requireSwift();
    loadFixture();
  });

  test("names a stored struct component by byte offset", () => {
    const buffer = readKeyPathBuffer(keyPath("keyPathPointX"));
    const names = resolveKeyPathNames(buffer.components, metadataFor("fixture.Point")!);
    expect(names).toEqual(["x"]);
  });

  test("names a stored class component by byte offset", () => {
    const buffer = readKeyPathBuffer(keyPath("keyPathGadgetValue"));
    const names = resolveKeyPathNames(buffer.components, metadataFor("fixture.Gadget")!);
    expect(names).toEqual(["value"]);
  });

  test("names every step of a multi-component path across the inter-component type", () => {
    const buffer = readKeyPathBuffer(keyPath("keyPathLineEndX"));
    const names = resolveKeyPathNames(buffer.components, metadataFor("fixture.Line")!);
    expect(names).toEqual(["end", "x"]);
  });

  test("leaves a plain-getter computed component unnamed", () => {
    const doubled = readKeyPathBuffer(keyPath("keyPathPointDoubled"));
    expect(resolveKeyPathNames(doubled.components, metadataFor("fixture.Point")!)).toEqual([null]);

    const scaled = readKeyPathBuffer(keyPath("keyPathRectScaled"));
    expect(resolveKeyPathNames(scaled.components, metadataFor("fixture.Rect")!)).toEqual([null]);
  });

  test("names a reabstracted stored property via its storedPropertyIndex id", () => {
    const root = metadataFor("fixture.Handler")!;

    const action = readKeyPathBuffer(keyPath("keyPathHandlerAction"));
    expect((action.components[0] as ComputedKeyPathComponent).idKind).toBe("storedPropertyIndex");
    expect(resolveKeyPathNames(action.components, root)).toEqual(["action"]);

    const label = readKeyPathBuffer(keyPath("keyPathHandlerLabel"));
    expect((label.components[0] as StoredKeyPathComponent).kind).toBe("struct");
    expect(resolveKeyPathNames(label.components, root)).toEqual(["label"]);
  });

  test("names a reabstracted stored property on a class via its storedPropertyIndex id", () => {
    const onEvent = readKeyPathBuffer(keyPath("keyPathSinkOnEvent"));
    expect((onEvent.components[0] as ComputedKeyPathComponent).idKind).toBe("storedPropertyIndex");
    expect(resolveKeyPathNames(onEvent.components, metadataFor("fixture.Sink")!)).toEqual([
      "onEvent",
    ]);
  });
});

// The requirement name comes from a conformance's witness-thunk symbol, so vtableOffset naming
// needs the unstripped fixturesyms module.
describe("resolveKeyPathNames › protocol requirements", () => {
  beforeEach(() => {
    requireSwift();
    loadFixtureSyms();
  });

  test("names a get/set protocol property past the leading method via its vtableOffset id", (ctx) => {
    requireSymbolTable(ctx);
    const mod = loadFixtureSyms();
    const speed = readKeyPathBuffer(keyPath("fixturesyms.keyPathVehicleSpeed", mod));
    expect((speed.components[0] as ComputedKeyPathComponent).idKind).toBe("vtableOffset");
    const root = existentialMetadata("fixturesyms.vehicleType", mod);
    expect(resolveKeyPathNames(speed.components, root)).toEqual(["speed"]);
  });

  test("names a get-only protocol property whose id steps over the interposed setter", (ctx) => {
    requireSymbolTable(ctx);
    const mod = loadFixtureSyms();
    const wheels = readKeyPathBuffer(keyPath("fixturesyms.keyPathVehicleWheels", mod));
    const root = existentialMetadata("fixturesyms.vehicleType", mod);
    expect(resolveKeyPathNames(wheels.components, root)).toEqual(["wheels"]);
  });

  test("names a property on a class-constrained protocol existential", (ctx) => {
    requireSymbolTable(ctx);
    const mod = loadFixtureSyms();
    const label = readKeyPathBuffer(keyPath("fixturesyms.keyPathNamedLabel", mod));
    const root = existentialMetadata("fixturesyms.namedType", mod);
    expect(resolveKeyPathNames(label.components, root)).toEqual(["label"]);
  });

  test("names a property on a parameterized-protocol existential root (any Holder<Int>)", (ctx) => {
    requireSymbolTable(ctx);
    const mod = loadFixtureSyms();
    const tag = readKeyPathBuffer(keyPath("fixturesyms.keyPathHolderTag", mod));
    expect((tag.components[0] as ComputedKeyPathComponent).idKind).toBe("vtableOffset");
    const root = existentialMetadata("fixturesyms.holderIntType", mod);
    expect(root.kind).toBe(MetadataKind.ExtendedExistential);
    expect(resolveKeyPathNames(tag.components, root)).toEqual(["tag"]);
  });

  test("leaves the requirement unnamed when the root is a multi-protocol composition", () => {
    const mod = loadFixtureSyms();
    const speed = readKeyPathBuffer(keyPath("fixturesyms.keyPathVehicleSpeed", mod));
    const composition = existentialMetadata("fixturesyms.greeterAgedType", mod);
    expect(resolveKeyPathNames(speed.components, composition)).toEqual([null]);
  });

  test("leaves the requirement unnamed when the conformance witness thunks are stripped", () => {
    const speed = readKeyPathBuffer(keyPath("fixture.keyPathVehicleSpeed"));
    const root = existentialMetadata("fixture.vehicleType");
    expect(resolveKeyPathNames(speed.components, root)).toEqual([null]);
  });
});

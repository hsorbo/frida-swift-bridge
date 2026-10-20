import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, FIXTURE_MODULE } from "./fixtures/load.js";

import { ClassType, ClassInstance, ClassMetadata, Metadata, MethodDescriptorKind, readVTable, readVTableChain, findType, metadataFor, typeOf, metadataOf } from "../src/abi.js";
import { resolveMethod } from "../src/runtime/method.js";

import { Swift, SwiftClass } from "../src/index.js";
function dispatcherType(): SwiftClass {
  return (typeOf(metadataFor("fixture.Dispatcher")!) as ClassType).facade;
}

function Int(): Metadata {
  return metadataFor("Swift.Int")!;
}

function instanceMethods(type: ClassType) {
  return readVTableChain(new ClassMetadata(metadataOf(type).handle)).filter(
    (e) => e.kind === MethodDescriptorKind.Method && e.isInstance
  );
}

describe("vtable route", () => {
  beforeEach(() => { loadFixture(); });

  test("enumerates instance-method slots, including the non-exported one", () => {
    expect(instanceMethods(dispatcherType().$type).length).toBe(2);
  });

  test("the non-exported method is invisible to the symbol route", () => {
    const mod = loadFixture();
    const exportsMethod = (name: string): boolean =>
      [...mod.enumerateExports()].some((e) => {
        const d = Swift.demangle(e.name);
        return d !== null && d.includes(`fixture.Dispatcher.${name}`);
      });
    expect(exportsMethod("pub")).toBe(true); // same matcher finds pub, so hidden's absence is real
    expect(exportsMethod("hidden")).toBe(false);
  });

  test("invokes each slot by offset, reaching the non-exported impl", () => {
    const type = dispatcherType();
    const obj = type.init()!;
    const inst = new ClassInstance(obj.$handle);
    const results = instanceMethods(type.$type)
      .map((e) => inst.vtableMethod(e.metadataOffset, { returnType: Int(), argTypes: [Int()] }).call(10) as number)
      .sort((a, b) => a - b);
    expect(results).toEqual([int64(11), int64(30)]); // pub(10)=11, hidden(10)=30
  });

  test("the exported slot's impl matches the symbol route", () => {
    const type = dispatcherType();
    const obj = type.init()!;
    const inst = new ClassInstance(obj.$handle);
    const pub = instanceMethods(type.$type).find(
      (e) => (inst.vtableMethod(e.metadataOffset, { returnType: Int(), argTypes: [Int()] }).call(10) as Int64).equals(11)
    )!;
    const viaSymbol = resolveMethod("fixture.Dispatcher", "pub", { static: false });
    expect(pub.declaredImpl.equals(viaSymbol.address)).toBe(true);
  });

  test("throws for a class whose vtable offset is not fixed", () => {
    expect(() => readVTable(findType("fixture.GenericHolder")!)).toThrow(/generic/);
  });
});

describe("unnamed vtable slots on the reflection", () => {
  beforeEach(() => { loadFixture(); });

  function hiddenSlot() {
    const type = dispatcherType().$type;
    const pub = resolveMethod("fixture.Dispatcher", "pub", { static: false }).address;
    return instanceMethods(type).find((e) => !e.declaredImpl.equals(pub))!;
  }

  test("lists the slot no symbol names beside the named methods, once each", () => {
    const type = dispatcherType().$type;
    expect(type.instanceMethods()).toEqual(["pub(_:)", `vtable#${hiddenSlot().metadataOffset}`]);
    expect(type.typeMethods()).toEqual([]);
  });

  test("finds the slot as a member without a signature", () => {
    const slot = hiddenSlot();
    const member = dispatcherType().$type.instanceMethod(`vtable#${slot.metadataOffset}`);
    expect(member.address.equals(slot.declaredImpl)).toBe(true);
    expect(member.selector).toBe(`vtable#${slot.metadataOffset}`);
    expect(member.signature).toBeNull();
    expect(member.origin).toEqual({ kind: "own", type: "fixture.Dispatcher", module: FIXTURE_MODULE });
    expect(() => member.bind(dispatcherType().init()!)).toThrow(/no symbol/);
  });

  test("a slot is not a type method, and a struct has none", () => {
    const slot = hiddenSlot();
    expect(() => dispatcherType().$type.instanceMethod("vtable#1")).toThrow(/no instance method vtable#1/);
    expect(() => dispatcherType().$type.typeMethod(`vtable#${slot.metadataOffset}`)).toThrow(/no type method/);
    expect(() => Swift.struct("fixture.Point")!.$type.instanceMethod("vtable#0")).toThrow(/no instance method/);
  });

  test("an inherited slot a subclass overrides under a symbol is named, not listed as a slot", () => {
    const sub = Swift.class("fixture.SubSpeaker")!.$type;
    const base = Swift.class("fixture.BaseSpeaker")!.$type;
    for (const selectors of [sub.instanceMethods(), base.instanceMethods(), sub.instanceMethods({ inherited: false })]) {
      expect(selectors.filter((s) => s === "speak()")).toHaveLength(1);
      expect(selectors.some((s) => s.startsWith("vtable#"))).toBe(false);
    }
  });

  test("an async method a symbol names is not listed again as a slot: its vtable word is the async function pointer", () => {
    expect(Swift.class("fixture.Ticker")!.$type.instanceMethods().some((s) => s.startsWith("vtable#"))).toBe(false);
  });

  test("a generic class named without its arguments lists no slots", () => {
    expect(Swift.class("fixture.GenericHolder")!.$type.instanceMethods().some((s) => s.startsWith("vtable#"))).toBe(false);
  });
});

import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

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
    const obj = type.init();
    const inst = new ClassInstance(obj.$handle);
    const results = instanceMethods(type.$type)
      .map((e) => inst.vtableMethod(e.metadataOffset, { returnType: Int(), argTypes: [Int()] }).call(10) as number)
      .sort((a, b) => a - b);
    expect(results).toEqual([int64(11), int64(30)]); // pub(10)=11, hidden(10)=30
  });

  test("the exported slot's impl matches the symbol route", () => {
    const type = dispatcherType();
    const obj = type.init();
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

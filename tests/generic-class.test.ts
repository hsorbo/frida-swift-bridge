import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift } from "./swift.js";

import { Swift } from "../src/index.js";
import { MetadataKind } from "../src/abi/metadata.js";
import { ClassMetadata } from "../src/abi/class-metadata.js";

import { metadataFor, ClassInstance } from "../src/abi.js";
import { loadFixture, fixtureExport } from "./fixtures/load.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";

function intArg(n: number): NativePointer {
  return Memory.alloc(8).writeS64(n);
}
describe("generic class instantiation", () => {
  test("instantiates a generic class metadata via its access function", () => {
    requireSwift();
    const int = metadataFor("Swift.Int")!;
    const storageInt = metadataFor("Swift._ContiguousArrayStorage", [int]);
    if (storageInt === null) {
      throw new Error("Swift._ContiguousArrayStorage not present");
    }
    expect(storageInt.kind).toBe(MetadataKind.Class);

    const cm = new ClassMetadata(storageInt.handle);
    expect(cm.isTypeMetadata).toBeTruthy();
    expect(cm.instanceSize).toBeGreaterThan(16);
    expect(cm.description.name).toBe("_ContiguousArrayStorage");

    const storageString = metadataFor("Swift._ContiguousArrayStorage", [
      metadataFor("Swift.String")!,
    ])!;
    expect(storageInt.handle.equals(storageString.handle)).toBeFalsy();
  });
});

describe("generic class fields", () => {
  test("a field typed by a generic param resolves against the instance's type arguments", () => {
    loadFixture();
    const Int = metadataFor("Swift.Int")!;
    const holderInt = metadataFor("fixture.GenericHolder", [Int])!;
    const make = makeSwiftNativeFunction(fixtureExport("fixture.makeHolder("), holderInt, [Int]);
    const holder = new ClassInstance(make(intArg(5))!.readPointer());
    expect(holder.field("value").read()).toEqual(int64(5));
    expect(holder.read()).toEqual({ value: int64(5) });
  });

  test("a subclass of a specialized generic class resolves the inherited field", () => {
    loadFixture();
    const Int = metadataFor("Swift.Int")!;
    const make = makeSwiftNativeFunction(fixtureExport("fixture.makeLabeledHolder"), metadataFor("fixture.LabeledHolder")!, [Int]);
    const holder = new ClassInstance(make(intArg(7))!.readPointer());
    expect(holder.read()).toEqual({ value: int64(7), label: "L" });
  });
});

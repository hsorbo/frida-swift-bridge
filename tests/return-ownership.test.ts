import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { SwiftObject, ClassInstance, ClassType, StructType, Metadata, metadataFor as metadataForRaw, typeOf } from "../src/abi.js";
import { embedsManagedReference } from "../src/abi/instance.js";

function metadataFor(name: string, args?: Metadata[]): Metadata {
  return metadataForRaw(name, args)!;
}

describe("value return embedding a class ref", () => {
  beforeEach(() => { loadFixture(); });

  test("embedsManagedReference distinguishes a borrowed ref from a deep-copied field", () => {
    expect(embedsManagedReference(metadataFor("fixture.Token"))).toBe(true);
    expect(embedsManagedReference(metadataFor("fixture.Wrapper"))).toBe(true);
    expect(embedsManagedReference(metadataFor("fixture.LoadableStruct"))).toBe(false);
    expect(embedsManagedReference(metadataFor("fixture.PoliteGreeter"))).toBe(false);
    // Array/Set/Dictionary: a Builtin.BridgeObject (Opaque) backing, not a class ref.
    const Int = metadataFor("Swift.Int");
    expect(embedsManagedReference(metadataFor("Swift.Array", [Int])!)).toBe(true);
    expect(embedsManagedReference(metadataFor("Swift.Set", [Int])!)).toBe(true);
    expect(embedsManagedReference(metadataFor("Swift.Dictionary", [Int, Int])!)).toBe(true);
  });

  test("a returned aggregate owns its embedded class ref and releases it on dispose", () => {
    const token = (typeOf(metadataFor("fixture.Token")) as ClassType).facade.init(7);
    const view = new ClassInstance(token.$handle);
    const before = view.retainCount;

    const wrapper = (typeOf(metadataFor("fixture.Wrapper")) as StructType).facade.$call("make", token) as SwiftObject;
    expect(wrapper.$kind).toBe("value");

    const owned = wrapper;
    expect(owned.$owned).toBe(true);
    expect(view.retainCount).toBe(before + 1); // the returned +1 is held, not dangling

    const embedded = owned.$field("token").read() as NativePointer;
    expect(embedded.equals(token.$handle)).toBe(true);
    expect(view.retainCount).toBe(before + 1); // reading the field is borrowing, not retaining

    owned.$dispose();
    expect(view.retainCount).toBe(before); // disposing the aggregate releases the embedded ref
  });
});

describe("bridge-object container return", () => {
  beforeEach(() => { loadFixture(); });

  test("a returned Array is adopted as an owned ValueInstance, not decoded lossily", () => {
    const arr = (typeOf(metadataFor("fixture.Bag")) as StructType).facade.$call("ints") as SwiftObject;
    expect(arr.$kind).toBe("value");

    const owned = arr;
    expect(owned.$owned).toBe(true);

    // +1 buffer survived a premature destroy: it sums back through a [Int] param.
    const box = (typeOf(metadataFor("fixture.Box")) as ClassType).facade;
    expect(box.init().$method("sumInts").call(owned)).toEqual(int64(60));

    owned.$dispose();
  });
});

describe("opaque existential return", () => {
  beforeEach(() => { loadFixture(); });

  test("a class payload stays boxed and alive until the facade is disposed", () => {
    const greeter = (typeOf(metadataFor("fixture.LoudGreeter")) as ClassType).facade.init("Ada");
    const view = new ClassInstance(greeter.$handle);
    const before = view.retainCount;

    const boxed = (typeOf(metadataFor("fixture.GreeterBox")) as StructType).facade.$call("wrap", greeter) as SwiftObject;
    expect(boxed.$kind).toBe("value");
    expect(boxed.$owned).toBe(true);
    expect(view.retainCount).toBe(before + 1);

    boxed.$dispose();
    expect(view.retainCount).toBe(before);
  });

  test("a value payload still reads out as a plain value", () => {
    const person = (typeOf(metadataFor("fixture.GreeterBox")) as StructType).facade.$call("wrapPerson", "Cy", 9);
    expect(person).toEqual({ name: "Cy", age: int64(9) });
  });
});

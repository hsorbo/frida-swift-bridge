import { test, expect, describe } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { ClassInstance, metadataFor, typeName, metadataOf } from "../src/abi.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";

import { Swift, ClassType } from "../src/index.js";
import { requireDarwin } from "./swift.js";
function intArg(n: number): NativePointer {
  const cell = Memory.alloc(Process.pointerSize);
  cell.writeS64(n);
  return cell;
}

function makeCounter(n: number): ClassInstance {
  loadFixture();
  const Int = metadataFor("Swift.Int")!;
  const Counter = metadataFor("fixture.Counter")!;
  const make = makeSwiftNativeFunction(fixtureExport("fixture.makeCounter"), Counter, [Int]);
  return new ClassInstance(make(intArg(n))!.readPointer());
}

describe("ClassInstance", () => {
  test("reads and writes a class stored property", () => {
    const counter = makeCounter(5);
    expect(counter.field("count").read()).toEqual(int64(5));
    counter.field("count").write(15);
    expect(counter.field("count").read()).toEqual(int64(15));
    expect(counter.read()).toEqual({ count: int64(15) });
  });

  test("retain/release adjust the strong reference count", () => {
    const counter = makeCounter(1);
    const before = counter.retainCount;
    counter.retain();
    expect(counter.retainCount).toBe(before + 1);
    counter.release();
    expect(counter.retainCount).toBe(before);
  });

  test("reports a solely-held instance as uniquely referenced", () => {
    const counter = makeCounter(1);
    expect(counter.isUniquelyReferenced).toBe(true);
    counter.retain();
    expect(counter.isUniquelyReferenced).toBe(false);
    counter.release();
    expect(counter.isUniquelyReferenced).toBe(true);
  });

  test("exposes the instance's class metadata", () => {
    const counter = makeCounter(1);
    expect(counter.metadata.isTypeMetadata).toBe(true);
  });

  test("type exposes the instance's SwiftType for symmetric reflection", () => {
    const counter = makeCounter(1);
    expect(counter.type.name).toBe("fixture.Counter");
    expect(typeName(metadataOf(counter.type))).toBe("fixture.Counter");
  });

  test("kind tags the wrapper as an object instance", () => {
    const counter = makeCounter(1);
    expect(counter.kind).toBe("object");
  });

  test("reads a stored property of a Swift subclass of an ObjC class and retains it through ObjC", (ctx) => {
    requireDarwin(ctx);
    loadFixture();
    const starling = (Swift.type("fixture.Starling") as ClassType).init();
    const object = new ClassInstance(starling.$handle);
    expect(object.metadata.isTypeMetadata).toBe(true);
    expect(object.field("pitch").read()).toEqual(int64(5));
    expect(object.isUniquelyReferenced).toBe(true);
    object.retain();
    expect(object.isUniquelyReferenced).toBe(false);
    object.release();
    expect(object.field("pitch").read()).toEqual(int64(5));
    starling.$dispose();
  });
});

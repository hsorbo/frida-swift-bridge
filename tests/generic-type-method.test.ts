import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { ValueInstance, Metadata, ClassInstance, metadataFor } from "../src/abi.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";

import { Swift } from "../src/index.js";
function constrainedBox(typeArg: Metadata, value: { [k: string]: number } | number): ValueInstance {
  return ValueInstance.fromJS(metadataFor("fixture.ConstrainedBox", [typeArg])!, { value });
}

function holder(n: number): ClassInstance {
  const mod = loadFixture();
  const Int = metadataFor("Swift.Int")!;
  const Holder = metadataFor("fixture.GenericHolder", [Int])!;
  const fn = [...mod.enumerateExports()].find((e) => Swift.demangle(e.name)?.includes("fixture.makeHolder("))!;
  const cell = Memory.alloc(Process.pointerSize);
  cell.writeS64(n);
  return new ClassInstance(makeSwiftNativeFunction(fn.address, Holder, [Int])(cell)!.readPointer());
}

describe("methods on a generic value type", () => {
  beforeEach(() => { loadFixture(); });

  test("small receiver: Self metadata trails, the callee derives the (T: Scalable) witness from it", () => {
    const Int = metadataFor("Swift.Int")!;
    // 3.scaled(by: 7) = 21, dispatched through the witness the callee reads off Self metadata.
    expect(constrainedBox(Int, 3).method("scaledStored").call(7)).toEqual(int64(21));
  });

  test("large receiver: self in x20, Self metadata still the lone trailing arg", () => {
    const Wide = metadataFor("fixture.WideScalar")!;
    // (1+2+3+4+5).scaled(by: 7) = 105.
    expect(constrainedBox(Wide, { a: 1, b: 2, c: 3, d: 4, e: 5 }).method("scaledStored").call(7)).toEqual(int64(105));
  });

  test("a return of the type parameter T decodes via Self metadata's type argument", () => {
    const Int = metadataFor("Swift.Int")!;
    expect(constrainedBox(Int, 9).method("stored").call()).toEqual(int64(9));
  });

  test("return-type-only overloads are listed with their return types and picked by returnType", () => {
    const box = constrainedBox(metadataFor("Swift.Int")!, 9);
    expect(() => box.method("pick")).toThrow(/pick\(\) \(\) -> A\b/);
    expect(() => box.method("pick")).toThrow(/pick\(\) \(\) -> Swift\.Int\b/);
    expect(box.method("pick", { returnType: "A" }).call()).toEqual(int64(9));
    expect(box.method("pick", { returnType: "Swift.Int" }).call()).toEqual(int64(-1));
  });
});

describe("methods on a generic value type with a fixed layout in its generic context", () => {
  beforeEach(() => { loadFixture(); });

  function phantomScaled(raw: number): ValueInstance {
    return ValueInstance.fromJS(metadataFor("fixture.PhantomScaled", [metadataFor("Swift.Int")!])!, { raw });
  }

  test("a borrowing self is a direct trailing arg, followed by T's metadata and Scalable witness", () => {
    // 10 + 3.scaled(by: 7) = 31.
    expect(phantomScaled(10).method("scaled", { self: "borrowing" }).call(3, 7)).toEqual(int64(31));
  });

  test("a mutating self is inout in x20 with Self metadata trailing", () => {
    const value = phantomScaled(10);
    value.method("bump", { self: "mutating" }).call(3);
    expect(value.field("raw").read()).toEqual(int64(13));
  });

  test("async: a borrowing self is a direct trailing arg, followed by T's metadata and Scalable witness", async () => {
    expect(await phantomScaled(10).method("scaledAsync", { self: "borrowing" }).call(3, 7)).toEqual(int64(31));
  });

  test("the self convention is inferred without the self option", () => {
    const value = phantomScaled(10);
    expect(value.method("scaled").call(3, 7)).toEqual(int64(31));
    value.method("bump").call(3);
    expect(value.field("raw").read()).toEqual(int64(13));
  });
});

describe("methods on a generic class", () => {
  test("self in x20, Self metadata + (T: Scalable) witness recovered from the object isa", () => {
    // 3.scaled(by: 7) = 21, with no trailing type args.
    expect(holder(3).method("scaledStored").call(7)).toEqual(int64(21));
  });

  test("a return of the type parameter T decodes via the concrete type argument", () => {
    expect(holder(9).method("stored").call()).toEqual(int64(9));
  });

  test("an async method drives via the AFP: scaledStoredAsync(by: 7) ⇒ 21", async () => {
    expect(await holder(3).method("scaledStoredAsync").call(7)).toEqual(int64(21));
  });

  test("an async return of the type parameter T decodes via the concrete argument", async () => {
    expect(await holder(9).method("storedAsync").call()).toEqual(int64(9));
  });
});

describe("async methods on a generic value type", () => {
  beforeEach(() => { loadFixture(); });

  test("small receiver: Self metadata trails, the async callee derives the witness from it", async () => {
    const Int = metadataFor("Swift.Int")!;
    expect(await constrainedBox(Int, 3).method("scaledStoredAsync").call(7)).toEqual(int64(21));
  });

  test("large receiver: self indirect, Self metadata the lone trailing arg", async () => {
    const Wide = metadataFor("fixture.WideScalar")!;
    expect(await constrainedBox(Wide, { a: 1, b: 2, c: 3, d: 4, e: 5 }).method("scaledStoredAsync").call(7)).toEqual(int64(105));
  });

  test("an async return of the type parameter T decodes via Self metadata's type argument", async () => {
    const Int = metadataFor("Swift.Int")!;
    expect(await constrainedBox(Int, 9).method("storedAsync").call()).toEqual(int64(9));
  });
});

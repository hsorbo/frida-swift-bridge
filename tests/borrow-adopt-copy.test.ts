import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { ClassInstance, writeValue, metadataOf } from "../src/abi.js";

import { Swift, SwiftClass, SwiftStruct } from "../src/index.js";
function loadable(): SwiftStruct {
  return Swift.type("fixture.LoadableStruct") as SwiftStruct;
}

describe("typed value construction", () => {
  beforeEach(() => { loadFixture(); });

  test("$new builds an owned value", () => {
    const v = loadable().$new({ a: 1, b: 2, c: 3, d: 4 });
    expect(v.$kind).toBe("value");
    expect(v.$owned).toBe(true);
    expect(v.$fields).toEqual({ a: int64(1), b: int64(2), c: int64(3), d: int64(4) });
    v.$dispose();
  });

  test("borrow wraps existing storage without owning it", () => {
    const t = loadable();
    const src = t.$new({ a: 5, b: 6, c: 7, d: 8 });
    const view = t.$borrow(src.$handle);
    expect(view.$owned).toBe(false);
    expect(view.$fields).toEqual({ a: int64(5), b: int64(6), c: int64(7), d: int64(8) });
    src.$dispose();
  });

  test("copy takes an independent +1 that outlives its source", () => {
    const t = loadable();
    const src = t.$new({ a: 1, b: 1, c: 1, d: 1 });
    const dup = t.$copy(src.$handle);
    expect(dup.$owned).toBe(true);
    src.$dispose();
    expect(dup.$fields).toEqual({ a: int64(1), b: int64(1), c: int64(1), d: int64(1) });
    dup.$dispose();
  });

  test("adopt takes ownership of prepared storage and disposes it", () => {
    const t = loadable();
    const md = metadataOf(t);
    const storage = Memory.alloc(md.typeLayout.stride);
    writeValue(md, storage, { a: 9, b: 8, c: 7, d: 6 });
    const owned = t.$adopt(storage);
    expect(owned.$owned).toBe(true);
    expect(owned.$handle.equals(storage)).toBe(true);
    expect(owned.$fields).toEqual({ a: int64(9), b: int64(8), c: int64(7), d: int64(6) });
    owned.$dispose();
    expect(() => owned.$fields).toThrow();
  });
});

describe("class object wrapping", () => {
  beforeEach(() => { loadFixture(); });

  test("borrowObject wraps a handle without taking ownership", () => {
    const token = (Swift.type("fixture.Token") as SwiftClass).init(7);
    const view = new ClassInstance(token.$handle);
    const before = view.retainCount;

    const borrowed = Swift.borrowObject(token.$handle);
    expect(borrowed.$owned).toBe(false);
    expect(borrowed.$handle.equals(token.$handle)).toBe(true);
    expect(view.retainCount).toBe(before);
  });

  test("adoptObject takes a +1 and releases it on dispose", () => {
    const token = (Swift.type("fixture.Token") as SwiftClass).init(7);
    const view = new ClassInstance(token.$handle);
    const before = view.retainCount;

    view.retain();
    expect(view.retainCount).toBe(before + 1);

    const adopted = Swift.adoptObject(token.$handle);
    expect(adopted.$owned).toBe(true);
    adopted.$dispose();
    expect(view.retainCount).toBe(before);
  });
});

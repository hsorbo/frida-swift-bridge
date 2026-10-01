import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms } from "./fixtures/load.js";
import { requireLinux } from "./swift.js";

import { Swift, StructType, SwiftStruct } from "../src/index.js";

import { metadataFor, typeOf } from "../src/abi.js";
function structType(name: string): SwiftStruct {
  return (typeOf(metadataFor(name)!) as StructType).facade;
}

// Value-type init resolution depends on the symbol table (method.ts:282): a
// struct's memberwise init is omitted from the export trie, so the bridge
// recovers it from .symtab. fixturesyms is the unstripped twin of fixture, so
// here the symbols are present and init resolves + marshals correctly.
describe("value-type initializers (with symtab)", () => {
  beforeEach(() => { loadFixtureSyms(); });

  test("init on a small loadable struct returns an owned ValueInstance", () => {
    const v = structType("fixturesyms.Point").init(5)!;
    expect(v.$owned).toBe(true);
    expect(v.$fields).toEqual({ x: int64(5) });
    v.$dispose();
  });

  test("init marshals a String arg and adopts a non-POD return", () => {
    const v = structType("fixturesyms.Person").init("Ada", 36)!;
    expect(v.$fields).toEqual({ name: "Ada", age: int64(36) });
    v.$dispose();
  });

  test("init adopts a large struct returned indirectly", () => {
    const v = structType("fixturesyms.BigStruct").init(1, 2, 3, 4, 5)!;
    expect(v.$fields).toEqual({ a: int64(1), b: int64(2), c: int64(3), d: int64(4), e: int64(5) });
    v.$dispose();
  });

  test("a bound initializer is reusable across calls", () => {
    const make = structType("fixturesyms.Point").$initializer();
    expect(make.call(1)!.$fields).toEqual({ x: int64(1) });
    expect(make.call(2)!.$fields).toEqual({ x: int64(2) });
  });

  test("throws on an argument-count mismatch", () => {
    expect(() => structType("fixturesyms.Person").init("Ada")).toThrow();
  });

  test("init selects an overload by its argument count", () => {
    const t = structType("fixturesyms.Ranged");
    expect(t.init(5)!.$fields).toEqual({ lo: int64(5), hi: int64(5) });
    expect(t.init(3, 9)!.$fields).toEqual({ lo: int64(3), hi: int64(9) });
  });

  test("init selects an overload from a { label: value } object by its keys", () => {
    const t = structType("fixturesyms.Ranged");
    expect(t.init({ lo: 5 })!.$fields).toEqual({ lo: int64(5), hi: int64(5) });
    expect(t.init({ lo: 3, hi: 9 })!.$fields).toEqual({ lo: int64(3), hi: int64(9) });
  });
});

// The same memberwise inits are unresolvable once the binary is stripped: on ELF
// they are local symbols, deleted with .symtab. Type metadata is still found
// (section discovery is symbol-independent), so the type resolves but its init
// does not. Linux-only: on Mach-O these inits are external and survive stripping.
describe("value-type initializers (without symtab)", () => {
  beforeEach(() => { loadFixture(); });

  test("a stripped binary cannot resolve a struct's memberwise init", (ctx) => {
    requireLinux(ctx);
    for (const name of ["fixture.Point", "fixture.Person", "fixture.BigStruct"]) {
      expect(() => structType(name).$initializer()).toThrow(/no method init/);
    }
  });
});

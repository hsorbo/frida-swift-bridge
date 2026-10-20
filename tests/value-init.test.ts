import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms } from "./fixtures/load.js";
import { requireLinux, requireSymbolTable } from "./swift.js";

import { Swift, SwiftStruct } from "../src/index.js";

const MAKE_ZERO_SIZED = "$s7fixture13makeZeroSizedAA0cD0VyF";
const MAKE_SOLE_CASE = "$s7fixture12makeSoleCaseyAA0cD0OSiF";
const TRIGGER_GENERIC_CLOSURE_CAPTURING = "$s7fixture30triggerGenericClosureCapturingyyF";

function structType(name: string): SwiftStruct {
  return Swift.struct(name)!;
}

// Value-type init resolution depends on the symbol table (method.ts:282): a
// struct's memberwise init is omitted from the export trie, so the bridge
// recovers it from .symtab. fixturesyms is the unstripped twin of fixture, so
// here the symbols are present and init resolves + marshals correctly.
describe("value-type initializers (with symtab)", () => {
  beforeEach(() => { loadFixtureSyms(); });

  test("init on a small loadable struct returns an owned ValueInstance", (ctx) => {
    requireSymbolTable(ctx);
    const v = structType("fixturesyms.Point").init(5)!;
    expect(v.$owned).toBe(true);
    expect(v.$fields).toEqual({ x: int64(5) });
    v.$dispose();
  });

  test("init marshals a String arg and adopts a non-POD return", (ctx) => {
    requireSymbolTable(ctx);
    const v = structType("fixturesyms.Person").init("Ada", 36)!;
    expect(v.$fields).toEqual({ name: "Ada", age: int64(36) });
    v.$dispose();
  });

  test("init adopts a large struct returned indirectly", (ctx) => {
    requireSymbolTable(ctx);
    const v = structType("fixturesyms.BigStruct").init(1, 2, 3, 4, 5)!;
    expect(v.$fields).toEqual({ a: int64(1), b: int64(2), c: int64(3), d: int64(4), e: int64(5) });
    v.$dispose();
  });

  test("a bound initializer is reusable across calls", (ctx) => {
    requireSymbolTable(ctx);
    const make = structType("fixturesyms.Point").$initializer();
    expect(make.call(1)!.$fields).toEqual({ x: int64(1) });
    expect(make.call(2)!.$fields).toEqual({ x: int64(2) });
  });

  test("throws on an argument-count mismatch", () => {
    expect(() => structType("fixturesyms.Person").init("Ada")!).toThrow();
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

describe("zero-sized values", () => {
  beforeEach(() => { loadFixture(); });

  test("init of a zero-sized struct returns an owned value facade", () => {
    const v = structType("fixture.ZeroSized").init()!;
    expect(v.$owned).toBe(true);
    expect(v.$type.name).toBe("fixture.ZeroSized");
    expect(v.$fields).toEqual({});
    v.$dispose();
  });

  test("a failable init of a zero-sized struct tells its value from nil", () => {
    const make = structType("fixture.ZeroSized").$initializer("init(_:)");
    expect(make.call(true)!.$fields).toEqual({});
    expect(make.call(false)).toBeNull();
  });

  test("a zero-sized result decodes as its value, not as Void", () => {
    expect(Swift.function(loadFixture(), MAKE_ZERO_SIZED).call()).toEqual({});
    expect(Swift.function(loadFixture(), MAKE_SOLE_CASE).call(1)).toBe("only");
    expect(Swift.function(loadFixture(), TRIGGER_GENERIC_CLOSURE_CAPTURING).call()).toBeNull();
  });

  test("a hook observes a zero-sized result as its value", () => {
    let seen: unknown = undefined;
    const listener = Swift.Interceptor.attach(loadFixture().getExportByName(MAKE_SOLE_CASE), {
      onLeave(ret) { seen = ret; },
    });
    try {
      Swift.function(loadFixture(), MAKE_SOLE_CASE).call(1);
    } finally {
      listener.detach();
    }
    expect(seen).toBe("only");
  });
});

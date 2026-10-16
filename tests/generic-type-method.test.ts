import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { fixtureExport, loadFixture } from "./fixtures/load.js";

import { Swift, SwiftClassObject, SwiftValueObject } from "../src/index.js";

function constrainedBox(typeArg: string, value: { [k: string]: number } | number): SwiftValueObject {
  return Swift.struct(`fixture.ConstrainedBox<${typeArg}>`)!.$new({ value });
}

function holder(n: number): SwiftClassObject {
  const mod = loadFixture();
  const fn = [...mod.enumerateExports()].find((e) => Swift.demangle(e.name)?.includes("fixture.makeHolder("))!;
  const Holder = Swift.class("fixture.GenericHolder<Swift.Int>")!;
  return Swift.NativeFunction(fn.address, Holder, [Swift.type("Swift.Int")!])(n) as SwiftClassObject;
}

describe("methods on a generic value type", () => {
  beforeEach(() => { loadFixture(); });

  test("small receiver: Self metadata trails, the callee derives the (T: Scalable) witness from it", () => {
    // 3.scaled(by: 7) = 21, dispatched through the witness the callee reads off Self metadata.
    expect(constrainedBox("Swift.Int", 3).$method("scaledStored").call(7)).toEqual(int64(21));
  });

  test("large receiver: self in x20, Self metadata still the lone trailing arg", () => {
    // (1+2+3+4+5).scaled(by: 7) = 105.
    expect(constrainedBox("fixture.WideScalar", { a: 1, b: 2, c: 3, d: 4, e: 5 }).$method("scaledStored").call(7)).toEqual(int64(105));
  });

  test("a return of the type parameter T decodes via Self metadata's type argument", () => {
    expect(constrainedBox("Swift.Int", 9).$method("stored").call()).toEqual(int64(9));
  });

  test("return-type-only overloads are listed with their return types and picked by returnType", () => {
    const box = constrainedBox("Swift.Int", 9);
    expect(() => box.$method("pick")).toThrow(/pick\(\) \(\) -> A\b/);
    expect(() => box.$method("pick")).toThrow(/pick\(\) \(\) -> Swift\.Int\b/);
    expect(box.$method("pick", { returnType: "A" }).call()).toEqual(int64(9));
    expect(box.$method("pick", { returnType: "Swift.Int" }).call()).toEqual(int64(-1));
  });
});

describe("methods on a generic value type with a fixed layout in its generic context", () => {
  beforeEach(() => { loadFixture(); });

  function phantomScaled(raw: number): SwiftValueObject {
    return Swift.struct("fixture.PhantomScaled<Swift.Int>")!.$new({ raw });
  }

  test("a borrowing self is a direct trailing arg, followed by T's metadata and Scalable witness", () => {
    // 10 + 3.scaled(by: 7) = 31.
    expect(phantomScaled(10).$method("scaled", { self: "borrowing" }).call(3, 7)).toEqual(int64(31));
  });

  test("a mutating self is inout in x20 with Self metadata trailing", () => {
    const value = phantomScaled(10);
    value.$method("bump", { self: "mutating" }).call(3);
    expect(value.$field("raw").read()).toEqual(int64(13));
  });

  test("async: a borrowing self is a direct trailing arg, followed by T's metadata and Scalable witness", async () => {
    expect(await phantomScaled(10).$method("scaledAsync", { self: "borrowing" }).call(3, 7)).toEqual(int64(31));
  });

  test("the self convention is inferred without the self option", () => {
    const value = phantomScaled(10);
    expect(value.$method("scaled").call(3, 7)).toEqual(int64(31));
    value.$method("bump").call(3);
    expect(value.$field("raw").read()).toEqual(int64(13));
  });
});

describe("methods on a generic class", () => {
  test("self in x20, Self metadata + (T: Scalable) witness recovered from the object isa", () => {
    // 3.scaled(by: 7) = 21, with no trailing type args.
    expect(holder(3).$method("scaledStored").call(7)).toEqual(int64(21));
  });

  test("a return of the type parameter T decodes via the concrete type argument", () => {
    expect(holder(9).$method("stored").call()).toEqual(int64(9));
  });

  test("an async method drives via the AFP: scaledStoredAsync(by: 7) ⇒ 21", async () => {
    expect(await holder(3).$method("scaledStoredAsync").call(7)).toEqual(int64(21));
  });

  test("an async return of the type parameter T decodes via the concrete argument", async () => {
    expect(await holder(9).$method("storedAsync").call()).toEqual(int64(9));
  });
});

describe("async methods on a generic value type", () => {
  beforeEach(() => { loadFixture(); });

  test("small receiver: Self metadata trails, the async callee derives the witness from it", async () => {
    expect(await constrainedBox("Swift.Int", 3).$method("scaledStoredAsync").call(7)).toEqual(int64(21));
  });

  test("large receiver: self indirect, Self metadata the lone trailing arg", async () => {
    expect(await constrainedBox("fixture.WideScalar", { a: 1, b: 2, c: 3, d: 4, e: 5 }).$method("scaledStoredAsync").call(7)).toEqual(int64(105));
  });

  test("an async return of the type parameter T decodes via Self metadata's type argument", async () => {
    expect(await constrainedBox("Swift.Int", 9).$method("storedAsync").call()).toEqual(int64(9));
  });
});

describe("members of a constrained extension of a generic type", () => {
  beforeEach(() => { loadFixture(); });

  test("a specialization meeting the clause lists the member and passes the clause's witness table", () => {
    const Pair = Swift.struct("fixture.Pair<fixture.PoliteGreeter>")!;
    expect(Pair.$type.instanceMethods()).toContain("bothGreet()");
    const pair = Pair.$new({ first: { name: "Ada" }, second: { name: "Bob" } });
    expect(pair.$method("bothGreet").call()).toBe("Hello, Ada / Hello, Bob");
  });

  test("a same-type clause is met by the matching specialization only", () => {
    const ints = Swift.struct("fixture.Pair<Swift.Int>")!;
    expect(ints.$type.instanceMethods()).toContain("sum()");
    expect(ints.$type.instanceMethods()).not.toContain("bothGreet()");
    expect(ints.$new({ first: 20, second: 22 }).$method("sum").call()).toEqual(int64(42));
    expect(Swift.struct("fixture.Pair<fixture.PoliteGreeter>")!.$type.instanceMethods()).not.toContain("sum()");
  });

  test("a generic type named without its arguments lists no conditional member", () => {
    const methods = Swift.struct("fixture.Pair")!.$type.instanceMethods();
    expect(methods).not.toContain("bothGreet()");
    expect(methods).not.toContain("sum()");
  });

  test("a class recovers its own arguments from the isa and takes the clause's witness table alone", () => {
    const Cell = Swift.class("fixture.Cell<fixture.PoliteGreeter>")!;
    expect(Cell.$type.instanceMethods()).toContain("cellGreet()");
    const fn = [...loadFixture().enumerateExports()].find((e) => Swift.demangle(e.name)?.includes("fixture.makeGreeterCell("))!;
    const cell = Swift.NativeFunction(fn.address, Cell, [Swift.type("Swift.String")!])("Bob") as SwiftClassObject;
    expect(cell.$method("cellGreet").call()).toBe("Hello, Bob");
  });

  test("a fixed-layout value passes the clause's tables with its own, in signature order", () => {
    const Scaled = Swift.struct("fixture.PhantomScaled<fixture.ScaledGreeter>")!;
    const scaled = Scaled.$new({ raw: 10 });
    const scalar = Swift.struct("fixture.ScaledGreeter")!.$new({ base: 3 });
    expect(Scaled.$type.instanceMethods()).toContain("greetScaled(_:by:)");
    expect(scaled.$method("greetScaled").call(scalar, 7)).toBe("scalar 3 31");
  });
});

describe("members of a generic type named without its type arguments", () => {
  beforeEach(() => { loadFixture(); });

  // The implementation, not a dispatch thunk or method descriptor that also mentions the selector.
  function implementation(prefix: string): NativePointer {
    const e = [...loadFixture().enumerateExports()].find((x) => Swift.demangle(x.name)?.startsWith(prefix) === true);
    if (e === undefined) {
      throw new Error(`no export ${prefix}`);
    }
    return e.address.strip();
  }

  test("a static of a generic struct resolves to its shared code, hookable but not callable", () => {
    const label = Swift.struct("fixture.Keyed")!.$typeMethod("label");
    expect(label.address.equals(implementation("static fixture.Keyed.label("))).toBe(true);
    expect(() => label.call(1)).toThrow(/fixture\.Keyed\.label\(_:\) needs fixture\.Keyed's type arguments/);
  });

  test("a class func of a generic class resolves the same way", () => {
    const label = Swift.class("fixture.KeyedHolder")!.$typeMethod("label");
    expect(label.address.equals(implementation("static fixture.KeyedHolder.label("))).toBe(true);
    expect(() => label.call(1)).toThrow(/fixture\.KeyedHolder\.label\(_:\) needs fixture\.KeyedHolder's type arguments/);
  });

  test("a hook on that address sees each call's type arguments", () => {
    const seen: string[][] = [];
    const listener = Swift.Interceptor.attach(Swift.struct("fixture.Keyed")!.$typeMethod("label").address, {
      onEnter(args) {
        seen.push([...this.typeArguments!, String(args[0])]);
      },
    });
    try {
      Swift.NativeFunction(fixtureExport("fixture.driveKeyed"), Swift.type("Swift.Int")!, [])();
    } finally {
      listener.detach();
    }
    expect(seen).toEqual([["Swift.String", "11"]]);
  });
});

describe("generic members found through their type", () => {
  beforeEach(() => { loadFixture(); });

  test("$initializer finds a generic initializer by its labels, hookable but not callable", () => {
    const init = Swift.struct("fixture.Sized")!.$initializer("init(of:)");
    expect(Swift.symbolicate(init.address)?.demangled.startsWith("fixture.Sized.init<")).toBe(true);
    expect(() => init.call([1])).toThrow(/fixture\.Sized\.init\(of:\) is generic/);
  });

  test("$initializer still binds and calls a plain initializer", () => {
    const sized = Swift.struct("fixture.Sized")!.$initializer("init(count:)").call(3) as { $fields: unknown };
    expect(sized.$fields).toEqual({ count: int64(3) });
  });

  test("a hook on a generic initializer sees the call's type arguments", () => {
    const seen: string[][] = [];
    const listener = Swift.Interceptor.attach(Swift.struct("fixture.Sized")!.$initializer("init(of:)").address, {
      onEnter() {
        seen.push(this.typeArguments!);
      },
    });
    try {
      Swift.NativeFunction(fixtureExport("fixture.driveSized"), Swift.type("Swift.Int")!, [])();
    } finally {
      listener.detach();
    }
    expect(seen).toEqual([["Swift.Array<Swift.Int>"]]);
  });
});

describe("a generic type named with its type arguments", () => {
  beforeEach(() => { loadFixture(); });

  test("Swift.type resolves the specialization to one reflection, the one its metadata yields", () => {
    const KeyedInt = Swift.type("fixture.Keyed<Swift.Int>")!;
    expect(KeyedInt.$type.name).toBe("fixture.Keyed<Swift.Int>");
    expect(KeyedInt).toBe(Swift.struct("fixture.Keyed<Swift.Int>"));
    expect(Swift.struct("fixture.Keyed")!.$type.specializations()).toContain(KeyedInt);
    expect(KeyedInt).not.toBe(Swift.type("fixture.Keyed"));
    expect(Swift.type("fixture.Keyed<Swift.String>")).not.toBe(KeyedInt);
    expect(Swift.type("fixture.Keyed<fixture.NoSuchTypeQX>")).toBeNull();
    expect(Swift.type("fixture.NoSuchTypeQX<Swift.Int>")).toBeNull();
    expect(() => Swift.class("fixture.Keyed<Swift.Int>")).toThrow("'fixture.Keyed<Swift.Int>' is struct, not class");
  });

  test("a static of a generic struct is called with the type's arguments trailing", () => {
    const KeyedInt = Swift.struct("fixture.Keyed<Swift.Int>")!;
    expect(KeyedInt.label(11)).toEqual(int64(11));
    expect(KeyedInt.echo(21)).toEqual(int64(21));
    expect(KeyedInt.$typeMethod("echo(_:)").call(22)).toEqual(int64(22));
    expect(Swift.struct("fixture.Keyed<Swift.String>")!.echo("a")).toBe("a");
  });

  test("the type's witness tables trail its arguments", () => {
    expect(Swift.struct("fixture.ConstrainedBox<Swift.Int>")!.scale(3, 7)).toEqual(int64(21));
    const wide = Swift.type("fixture.WideScalar")!.$new({ a: 1, b: 2, c: 3, d: 4, e: 5 });
    expect(Swift.struct("fixture.ConstrainedBox<fixture.WideScalar>")!.scale(wide, 7)).toEqual(int64(105));
  });

  test("a class func of a generic class takes the specialization's metadata as self", () => {
    const HolderInt = Swift.class("fixture.KeyedHolder<Swift.Int>")!;
    expect(HolderInt.label(12)).toEqual(int64(12));
    const made = HolderInt.make(5);
    expect(made.$type).toBe(HolderInt.$type);
    expect(made.$fields).toEqual({ value: int64(5) });
    expect(Swift.class("fixture.KeyedHolder<Swift.String>")!.make("e").$fields).toEqual({ value: "e" });
  });

  test("a struct's initializer builds the specialization in place", () => {
    const KeyedInt = Swift.struct("fixture.Keyed<Swift.Int>")!;
    const keyed = KeyedInt.init(5)!;
    expect(keyed.$type).toBe(KeyedInt.$type);
    expect(keyed.$fields).toEqual({ value: int64(5) });
    expect(keyed.get()).toEqual(int64(5));
    expect(KeyedInt.$initializer("init(_:)").call(6)!.$fields).toEqual({ value: int64(6) });
    expect(Swift.struct("fixture.Keyed<Swift.String>")!.init("c")!.get()).toBe("c");
  });

  test("a class's initializer allocates through the specialization's metadata", () => {
    const HolderInt = Swift.class("fixture.KeyedHolder<Swift.Int>")!;
    const holder = HolderInt.init(7);
    expect(holder.$type).toBe(HolderInt.$type);
    expect(holder.$fields).toEqual({ value: int64(7) });
    expect(Swift.class("fixture.KeyedHolder<Swift.String>")!.init("e").$fields).toEqual({ value: "e" });
  });

  test("a method-level generic static stays hookable but not callable, at the shared address", () => {
    const KeyedInt = Swift.struct("fixture.Keyed<Swift.Int>")!;
    const first = KeyedInt.$typeMethod("first");
    expect(first.address.equals(Swift.struct("fixture.Keyed")!.$typeMethod("first").address)).toBe(true);
    expect(() => first.call(1, 2)).toThrow(/fixture\.Keyed<Swift\.Int>\.first\(_:_:\) is generic/);
    expect(KeyedInt.$typeMethod("label").address.equals(Swift.struct("fixture.Keyed")!.$typeMethod("label").address)).toBe(true);
  });
});

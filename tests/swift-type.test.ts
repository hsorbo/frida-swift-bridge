import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { StructType, EnumType, ClassType, ClassMetadata, ClassInstance, TupleType, MetatypeType, FunctionType, Metadata, MetadataKind, SwiftError, resolveTypeByMangledName, typeFromDescriptor, findType, asSwiftObject, metadataFor, typeOf, metadataOf } from "../src/abi.js";

import { Swift } from "../src/index.js";
function mangledType(mangled: string): Metadata {
  return resolveTypeByMangledName({
    address: Memory.allocUtf8String(mangled),
    length: mangled.length,
  })!;
}

function syntheticMetadata(kind: MetadataKind, ...words: NativePointer[]): Metadata {
  const handle = Memory.alloc((1 + words.length) * Process.pointerSize);
  handle.writeU32(kind);
  words.forEach((w, i) => handle.add((i + 1) * Process.pointerSize).writePointer(w));
  return new Metadata(handle);
}

describe("type wrappers", () => {
  beforeEach(() => { loadFixture(); });

  test("StructType.new builds a value and lists fields", () => {
    const t = typeOf(metadataFor("fixture.LoadableStruct")!) as StructType;
    expect(t.name).toBe("fixture.LoadableStruct");
    expect(t.fields.map((f) => f.name)).toEqual(["a", "b", "c", "d"]);
    expect(t.fields.every((f) => !f.isVar)).toBe(true);
    const v = t.new({ a: 1, b: 2, c: 3, d: 4 });
    expect(v.$fields).toEqual({ a: int64(1), b: int64(2), c: int64(3), d: int64(4) });
    v.$dispose();
  });

  test("EnumType.case builds payload and empty cases", () => {
    const t = typeOf(metadataFor("fixture.Pick")!) as EnumType;
    expect(t.cases.map((c) => c.name).sort()).toEqual(["empty", "value"]);
    const payload = t.case("value", 7);
    expect(payload.$fields).toEqual({ value: int64(7) });
    payload.$dispose();
    const empty = t.case("empty");
    expect(empty.$fields).toBe("empty");
    empty.$dispose();
  });

  test("ClassType.init runs the real initializer", () => {
    const t = typeOf(metadataFor("fixture.Counter")!) as ClassType;
    const obj = t.init(9);
    expect(obj.$field("count").read()).toEqual(int64(9));
    expect(obj.$fields).toEqual({ count: int64(9) });
  });

  test("ClassType.init surfaces a throwing initializer's error as SwiftError", () => {
    const t = typeOf(metadataFor("fixture.ThrowingGadget")!) as ClassType;
    expect(t.init(7).$fields).toEqual({ id: int64(7) });
    let thrown: unknown = null;
    try {
      t.init(-1);
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof SwiftError).toBe(true);
    expect((thrown as SwiftError).value).toBe("boom");
  });

  test("ClassType.init throws on a failable initializer's nil instead of adopting NULL", () => {
    const t = typeOf(metadataFor("fixture.FailableGadget")!) as ClassType;
    expect(t.init(7).$fields).toEqual({ id: int64(7) });
    expect(() => t.init(-1)).toThrow(/returned nil/);
  });

  test("ClassType.initializer selects a same-arity overload by labels", () => {
    const t = typeOf(metadataFor("fixture.Vec2")!) as ClassType;
    expect(() => t.init(1, 2)).toThrow(/ambiguous/);
    expect(t.initializer({ labels: ["x", "y"] }).call(1, 2).$fields).toEqual({ a: int64(1), b: int64(2) });
    expect(t.initializer({ labels: ["angle", "radius"] }).call(1, 2).$fields).toEqual({ a: int64(2), b: int64(6) });
  });

  test("ClassType.init selects a labeled overload from a { label: value } object", () => {
    const t = typeOf(metadataFor("fixture.Vec2")!) as ClassType;
    expect(t.init({ x: 1, y: 2 }).$fields).toEqual({ a: int64(1), b: int64(2) });
    expect(t.init({ angle: 1, radius: 2 }).$fields).toEqual({ a: int64(2), b: int64(6) });
    // keys matching no initializer fall back to positional: the lone object counts as one argument
    expect(() => t.init({ foo: 1, bar: 2 })).toThrow(/got 1/);
  });

  test("swift_allocObject returns raw storage we can write", () => {
    const t = typeOf(metadataFor("fixture.Counter")!) as ClassType;
    const cls = new ClassMetadata(metadataOf(t).handle);
    const obj = asSwiftObject(
      ClassInstance.adopt(
        Swift.api.swift_allocObject(cls.handle, cls.instanceSize, cls.instanceAlignment - 1)
      )
    );
    expect(obj.$handle.isNull()).toBe(false);
    expect(obj.$owned).toBe(true);
    obj.$field("count").write(3);
    expect(obj.$field("count").read()).toEqual(int64(3));
  });

  test("typeOf dispatches by metadata kind", () => {
    expect(typeOf(metadataFor("Swift.Int")!) instanceof StructType).toBe(true);
    expect(typeOf(metadataFor("fixture.Pick")!) instanceof EnumType).toBe(true);
    expect(typeOf(metadataFor("fixture.Counter")!) instanceof ClassType).toBe(true);
  });

  test("typeOf wraps a tuple with element reflection", () => {
    const t = typeOf(mangledType("Si_Sit")); // (Int, Int)
    expect(t instanceof TupleType).toBe(true);
    const tuple = t as TupleType;
    expect(tuple.elements.length).toBe(2);
    expect(tuple.elements.every((e) => e.type instanceof StructType)).toBe(true);
    expect(tuple.name).toContain("Int");
  });

  test("typeOf wraps a metatype exposing its instance type", () => {
    const intMeta = metadataFor("Swift.Int")!;
    const t = typeOf(syntheticMetadata(MetadataKind.Metatype, intMeta.handle));
    expect(t instanceof MetatypeType).toBe(true);
    expect((t as MetatypeType).instanceType.name).toBe("Swift.Int");
  });

  test("typeOf wraps a function type exposing its signature", () => {
    const intMeta = metadataFor("Swift.Int")!;
    const t = typeOf(syntheticMetadata(MetadataKind.Function, ptr(0), intMeta.handle));
    expect(t instanceof FunctionType).toBe(true);
    const sig = (t as FunctionType).signature;
    expect(sig.parameters.length).toBe(0);
    expect(sig.throws).toBe(false);
    expect(sig.result instanceof StructType).toBe(true);
  });

  test("methods() static option splits instance from static keys", () => {
    const t = typeOf(metadataFor("fixture.Accumulator")!) as StructType;
    expect(t.methods().sort()).toEqual(["add(_:)", "addEight(_:_:_:_:_:_:_:_:)", "depositAsync(_:)", "describe(_:)", "drain(into:)", "peek(_:)", "peekAsync(_:)"]);
    expect(t.methods({ static: true }).sort()).toEqual(["doubled(_:)", "sumStaticAsync(_:_:)", "summing(_:_:)", "zero()"]);
    expect(t.fields).toEqual([{ name: "total", type: t.fields[0].type, isVar: true }]);
  });

  test("type methods mirror the keys an instance's type exposes", () => {
    const t = typeOf(metadataFor("fixture.Cat")!) as ClassType;
    expect(t.methods().sort()).toEqual(t.init().$type.methods().sort());
    expect(t.methods({ static: true })).toEqual([]);
  });

  test("Swift.class/struct/enum resolve their kind, throw on mismatch, null when absent", () => {
    expect(Swift.class("fixture.Counter") instanceof ClassType).toBe(true);
    expect(Swift.struct("fixture.LoadableStruct") instanceof StructType).toBe(true);
    expect(Swift.enum("fixture.Pick") instanceof EnumType).toBe(true);
    expect(() => Swift.class("fixture.LoadableStruct")).toThrow(/is struct, not class/);
    expect(() => Swift.struct("fixture.Pick")).toThrow(/is enum, not struct/);
    expect(() => Swift.enum("fixture.Counter")).toThrow(/is class, not enum/);
    expect(Swift.class("fixture.NoSuchType")).toBeNull();
    expect(Swift.struct("fixture.NoSuchType")).toBeNull();
    expect(Swift.enum("fixture.NoSuchType")).toBeNull();
  });

  test("typeFromDescriptor dispatches by descriptor kind", () => {
    expect(typeFromDescriptor(findType("fixture.LoadableStruct")!) instanceof StructType).toBe(true);
    expect(typeFromDescriptor(findType("fixture.Pick")!) instanceof EnumType).toBe(true);
    expect(typeFromDescriptor(findType("fixture.Counter")!) instanceof ClassType).toBe(true);
  });

  test("descriptor-backed wrapper reflects without realizing metadata", () => {
    const t = typeFromDescriptor(findType("fixture.ConstrainedBox")!);
    expect(t.name).toBe("fixture.ConstrainedBox");
    expect(t.toJSON().kind).toBe("struct");
    expect(t.moduleName).not.toBe(null);
    expect(() => metadataOf(t)).toThrow();
  });

  test("descriptor-backed wrapper realizes metadata on demand", () => {
    const t = typeFromDescriptor(findType("fixture.LoadableStruct")!) as StructType;
    expect(t.fields.map((f) => f.name)).toEqual(["a", "b", "c", "d"]);
    const v = t.new({ a: 1, b: 2, c: 3, d: 4 });
    expect(v.$fields).toEqual({ a: int64(1), b: int64(2), c: int64(3), d: int64(4) });
    v.$dispose();
    const c = typeFromDescriptor(findType("fixture.Counter")!) as ClassType;
    expect(c.init(9).$fields).toEqual({ count: int64(9) });
  });

  test("a nested type is named and resolved under its full path", () => {
    const desc = findType("fixture.Outer.Inner");
    expect(desc).not.toBeNull();
    const inner = typeFromDescriptor(desc!) as StructType;
    expect(inner.name).toBe("fixture.Outer.Inner");
    const v = inner.new({ value: 21 });
    expect(v.$method("doubled", { self: "borrowing" }).call()).toEqual(int64(42));
  });

  test("a type nested in an extension keeps its extended parent in the full path", () => {
    const desc = findType("fixture.Outer.FromExt");
    expect(desc).not.toBeNull();
    const fromExt = typeFromDescriptor(desc!) as StructType;
    expect(fromExt.name).toBe("fixture.Outer.FromExt");
    expect(fromExt.moduleName).toBe("fixture");
    const v = fromExt.new({ mark: 7 });
    expect(v.$method("tripled", { self: "borrowing" }).call()).toEqual(int64(21));
  });
});

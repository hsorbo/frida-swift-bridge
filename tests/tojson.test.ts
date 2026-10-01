import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { StructType, ClassType, Metadata, MetadataKind, ValueInstance, Protocol, resolveTypeByMangledName, metadataFor, typeOf } from "../src/abi.js";

import { Swift } from "../src/index.js";
function json(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

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

describe("toJSON", () => {
  beforeEach(() => { loadFixture(); });

  test("a nominal type serializes to identity only, never its structure", () => {
    for (const [name, kind] of [
      ["fixture.LoadableStruct", "struct"],
      ["fixture.Counter", "class"],
      ["fixture.Pick", "enum"],
    ] as const) {
      const t = typeOf(metadataFor(name)!);
      expect(json(t)).toEqual({ kind, name, module: "fixture" });
      expect(t.moduleName).toBe("fixture");
    }
  });

  test("a tuple type has no module and no elements in its JSON", () => {
    const t = typeOf(mangledType("Si_Sit"));
    expect(json(t)).toEqual({ kind: "tuple", name: t.name, module: null });
  });

  test("kind maps across metatype and function types", () => {
    const intMeta = metadataFor("Swift.Int")!;
    expect(json(typeOf(syntheticMetadata(MetadataKind.Metatype, intMeta.handle))).kind).toBe(
      "metatype"
    );
    expect(
      json(typeOf(syntheticMetadata(MetadataKind.Function, ptr(0), intMeta.handle))).kind
    ).toBe("function");
  });

  test("a value instance serializes its decoded value", () => {
    const Loadable = metadataFor("fixture.LoadableStruct")!;
    const v = ValueInstance.fromJS(Loadable, { a: 1, b: 2, c: 3, d: 4 });
    expect(json(v)).toEqual({
      kind: "value",
      type: "fixture.LoadableStruct",
      value: { a: "1", b: "2", c: "3", d: "4" },
    });
    v.dispose();
    expect(json(v)).toEqual({ kind: "value", type: "fixture.LoadableStruct", disposed: true });
  });

  test("a class instance serializes to kind/type/handle without a field dump", () => {
    const counter = (typeOf(metadataFor("fixture.Counter")!) as ClassType).facade.init(5);
    const j = json(counter);
    expect(Object.keys(j).sort()).toEqual(["handle", "kind", "type"]);
    expect(j.kind).toBe("object");
    expect(j.type).toBe("fixture.Counter");
    expect(j.handle.startsWith("0x")).toBe(true);
  });

  test("the SwiftObject facade delegates JSON.stringify to the wrapped instance", () => {
    const t = (typeOf(metadataFor("fixture.LoadableStruct")!) as StructType).facade;
    const obj = t.$new({ a: 1, b: 2, c: 3, d: 4 });
    expect(json(obj)).toEqual({
      kind: "value",
      type: "fixture.LoadableStruct",
      value: { a: "1", b: "2", c: "3", d: "4" },
    });
  });

  test("a protocol serializes its cheap shape", () => {
    const greeter = Protocol.find("fixture.Greeter")!;
    expect(json(greeter)).toEqual({
      kind: "protocol",
      name: "Greeter",
      isClassOnly: false,
      numRequirements: greeter.numRequirements,
    });
  });
});

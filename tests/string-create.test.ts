import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, StructType } from "../src/index.js";
import { createString, writeString } from "../src/abi/string.js";
import { readString } from "../src/abi/string.js";

import { metadataFor, typeOf } from "../src/abi.js";
// createString hands back a +1 String; read its text and settle the +1 (or it leaks __StringStorage).
function takeText(buf: NativePointer): string | null {
  const text = readString(buf);
  metadataFor("Swift.String")!.valueWitnesses.destroy(buf);
  return text;
}

describe("createString / writeString", () => {
  beforeEach(() => { loadFixture(); });

  test("round-trips a small (inline) string", () => {
    expect(takeText(createString("short"))).toBe("short");
  });

  test("round-trips a large (heap) string", () => {
    const text = "this string is definitely longer than fifteen bytes";
    expect(takeText(createString(text))).toBe(text);
  });

  test("round-trips empty and unicode strings", () => {
    expect(takeText(createString(""))).toBe("");
    expect(takeText(createString("café ☕ 日本語"))).toBe("café ☕ 日本語");
  });

  test("writeString moves a value into an existing buffer", () => {
    const buf = Memory.alloc(Process.pointerSize * 2);
    writeString(buf, "moved into place");
    expect(takeText(buf)).toBe("moved into place");
  });
});

describe("writeValue String support", () => {
  beforeEach(() => { loadFixture(); });

  test("ValueInstance.fromJS builds a String value", () => {
    const v = typeOf(metadataFor("Swift.String")!);
    const value = (v as StructType).$new("hello from JS");
    expect(value.$fields).toBe("hello from JS");
    value.$dispose();
  });

  test("constructs a struct with a String field", () => {
    const t = typeOf(metadataFor("fixture.PoliteGreeter")!) as StructType;
    const value = t.$new({ name: "Ada" });
    expect(value.$fields).toEqual({ name: "Ada" });
    value.$dispose();
  });
});

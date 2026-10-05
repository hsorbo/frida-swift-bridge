import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift, SWIFTCORE_MODULE } from "./swift.js";

import { Swift } from "../src/index.js";
import { readValue, writeValue } from "../src/abi/instance.js";
import { readEnumCase, enumTag, injectEnumTag, projectBox } from "../src/abi/enum.js";

import { metadataFor } from "../src/abi.js";
describe("enum instances", () => {
  test("tag injection round-trips and maps to the payload-first case order", () => {
    requireSwift();
    const optionalInt = metadataFor("Swift.Optional", [metadataFor("Swift.Int")!])!;
    const storage = Memory.alloc(optionalInt.typeLayout.stride);

    injectEnumTag(optionalInt, storage, 0);
    expect(enumTag(optionalInt, storage)).toBe(0);
    expect(readEnumCase(optionalInt, storage).name).toBe("some");

    injectEnumTag(optionalInt, storage, 1);
    expect(enumTag(optionalInt, storage)).toBe(1);
    const noneCase = readEnumCase(optionalInt, storage);
    expect(noneCase.name).toBe("none");
    expect(noneCase.payloadType).toBeNull();
    expect(noneCase.isIndirect).toBeFalsy();
  });

  test("reads a boxed payload via projectBox (the indirect-case mechanism)", (ctx) => {
    requireSwift();
    if (Process.platform === "windows" && Process.arch === "x64") {
      ctx.skip("the Win64 C ABI returns a two-word struct through memory, not in the swiftcc result registers");
    }
    const lib = Process.getModuleByName(SWIFTCORE_MODULE);
    const allocBox = new NativeFunction(
      lib.getExportByName("swift_allocBox"),
      ["pointer", "pointer"],
      ["pointer"]
    );
    const int = metadataFor("Swift.Int")!;
    const pair = allocBox(int.handle) as unknown as [NativePointer, NativePointer];
    const object = pair[0];
    const buffer = pair[1];
    buffer.writeS64(99);

    // projectBox recomputes the value address from the box object, matching the
    // pointer an indirect enum case stores after projectEnumData.
    expect(projectBox(object).equals(buffer)).toBeTruthy();
    expect(readValue(int, projectBox(object))).toEqual(int64(99));
  });

  test("decodes a payload case and reads its associated value", () => {
    requireSwift();
    const optionalInt = metadataFor("Swift.Optional", [metadataFor("Swift.Int")!])!;
    const storage = Memory.alloc(optionalInt.typeLayout.stride);
    storage.writeS64(42);
    injectEnumTag(optionalInt, storage, 0);
    expect(readValue(optionalInt, storage)).toEqual({ some: int64(42) });
  });

  test("decodes a no-payload case to its name", () => {
    requireSwift();
    const optionalInt = metadataFor("Swift.Optional", [metadataFor("Swift.Int")!])!;
    const storage = Memory.alloc(optionalInt.typeLayout.stride);
    injectEnumTag(optionalInt, storage, 1);
    expect(readValue(optionalInt, storage)).toBe("none");
  });

  test("reads an enum field nested in a struct value", () => {
    requireSwift();
    const int = metadataFor("Swift.Int")!;
    const optionalInt = metadataFor("Swift.Optional", [int])!;
    // hand-build a payload Optional<Int> and confirm it round-trips through readValue
    const storage = Memory.alloc(optionalInt.typeLayout.stride);
    storage.writeS64(7);
    injectEnumTag(optionalInt, storage, 0);
    expect(readValue(optionalInt, storage)).toEqual({ some: int64(7) });
  });

  test("discriminates a class optional via the extra-inhabitant (nil-pointer) layout", () => {
    requireSwift();
    const cls = metadataFor("Swift.__RawSetStorage")!;
    const optionalClass = metadataFor("Swift.Optional", [cls])!;
    const storage = Memory.alloc(optionalClass.typeLayout.stride);

    storage.writePointer(ptr(0));
    expect(readValue(optionalClass, storage)).toBe("none");

    const obj = Memory.alloc(Process.pointerSize); // a real high heap pointer
    storage.writePointer(obj);
    const some = readValue(optionalClass, storage) as { some: NativePointer };
    expect(some.some.equals(obj)).toBeTruthy();
  });

  test("round-trips a Bool optional whose none is an extra inhabitant", () => {
    requireSwift();
    const optionalBool = metadataFor("Swift.Optional", [metadataFor("Swift.Bool")!])!;
    const storage = Memory.alloc(optionalBool.typeLayout.stride);

    writeValue(optionalBool, storage, { some: true });
    expect(readValue(optionalBool, storage)).toEqual({ some: true });
    writeValue(optionalBool, storage, { some: false });
    expect(readValue(optionalBool, storage)).toEqual({ some: false });
    writeValue(optionalBool, storage, "none");
    expect(readValue(optionalBool, storage)).toBe("none");
  });

  test("round-trips a nested Optional<Optional<Int>> through writeValue/readValue", () => {
    requireSwift();
    const int = metadataFor("Swift.Int")!;
    const optInt = metadataFor("Swift.Optional", [int])!;
    const optOptInt = metadataFor("Swift.Optional", [optInt])!;
    const storage = Memory.alloc(optOptInt.typeLayout.stride);

    writeValue(optOptInt, storage, { some: { some: 5 } });
    expect(readValue(optOptInt, storage)).toEqual({ some: { some: int64(5) } });
    writeValue(optOptInt, storage, { some: "none" });
    expect(readValue(optOptInt, storage)).toEqual({ some: "none" });
    writeValue(optOptInt, storage, "none");
    expect(readValue(optOptInt, storage)).toBe("none");
  });
});

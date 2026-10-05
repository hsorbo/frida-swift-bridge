import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift, SWIFTCORE_MODULE } from "./swift.js";

import { Swift } from "../src/index.js";
import { readString } from "../src/abi/string.js";
import { readValue } from "../src/abi/instance.js";
import { makeTwoWordResultFunction } from "../src/runtime/swiftcc.js";

import { metadataFor } from "../src/abi.js";
// Build a small-string _StringObject (ASCII, <= 15 bytes) in 16 bytes.
function writeSmallString(p: NativePointer, s: string): void {
  p.writeU64(0);
  p.add(8).writeU64(0);
  for (let i = 0; i < s.length; i++) {
    p.add(i).writeU8(s.charCodeAt(i));
  }
  p.add(15).writeU8(0xe0 | s.length); // immortal | ascii | small | count
}

describe("readString", () => {
  test("decodes small (inline) strings", () => {
    requireSwift();
    const buf = Memory.alloc(16);

    writeSmallString(buf, "");
    expect(readString(buf)).toBe("");

    writeSmallString(buf, "hi");
    expect(readString(buf)).toBe("hi");

    writeSmallString(buf, "fifteen chars!!"); // exactly 15
    expect(readString(buf)).toBe("fifteen chars!!");
  });

  test("decodes a real native (large) string via _typeName", () => {
    requireSwift();
    const lib = Process.getModuleByName(SWIFTCORE_MODULE);
    let typeNameFn: NativePointer;
    try {
      typeNameFn = lib.getExportByName("$ss9_typeName_9qualifiedSSypXp_SbtF");
    } catch (e) {
      throw new Error("_typeName not exported under the expected mangling");
    }
    const fn = makeTwoWordResultFunction(typeNameFn, ["pointer", "size_t"], ["pointer", "bool"]);
    const dict = metadataFor("Swift.Dictionary", [
      metadataFor("Swift.String")!,
      metadataFor("Swift.Int")!,
    ])!;
    const ret = fn(dict.handle, 1);

    const storage = Memory.alloc(16);
    storage.writePointer(ret[0]);
    storage.add(8).writeU64(ret[1]);
    const name = readString(storage)!;
    expect(name.length).toBeGreaterThan(15); // proves it took the large path
    expect(name).toContain("Dictionary");
    expect(name).toContain("Swift.String");
  });

  test("readValue decodes String fields of a struct", () => {
    requireSwift();
    const rangeString = metadataFor("Swift.Range", [metadataFor("Swift.String")!])!;
    const buf = Memory.alloc(rangeString.typeLayout.stride);
    writeSmallString(buf, "a");
    writeSmallString(buf.add(16), "z");
    expect(readValue(rangeString, buf)).toEqual({ lowerBound: "a", upperBound: "z" });
  });
});

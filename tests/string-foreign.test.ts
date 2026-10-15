import { test, expect, describe } from "@frida/injest/agent";
import { requireDarwin, requireSwift } from "./swift.js";

import { Swift } from "../src/index.js";

const K_CF_STRING_ENCODING_UTF8 = 0x08000100;

// Create a heap (non-tagged) NSString/CFString. Returns null if CoreFoundation
// can't be loaded in the test process.
function makeCocoaString(text: string): NativePointer | null {
  let cf: Module;
  try {
    cf =
      Process.findModuleByName("CoreFoundation") ??
      Module.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  } catch (e) {
    return null;
  }
  const create = new NativeFunction(cf.getExportByName("CFStringCreateWithCString"), "pointer", [
    "pointer",
    "pointer",
    "uint32",
  ]);
  const s = create(ptr(0), Memory.allocUtf8String(text), K_CF_STRING_ENCODING_UTF8) as NativePointer;
  return s.isNull() ? null : s;
}

describe("String read (cocoa)", () => {
  test("decodes a cocoa-backed string through the ObjC runtime", (ctx) => {
    requireDarwin(ctx);
    requireSwift();
    // long + non-ASCII so it is a real heap string, not a tagged pointer
    const text = "héllo wörld with ünicode ✓ and enough length";
    const cocoa = makeCocoaString(text);
    if (cocoa === null) {
      throw new Error("CoreFoundation/NSString unavailable in the test process");
    }

    // The large-cocoa discriminator is bit 62: 0x50 = foreign (slow), 0x40 = fast cocoa.
    // Both must decode identically; 0x40 is the regression guard for the old
    // "fast cocoa misread as shared" bug.
    for (const discriminator of ["0x5000000000000000", "0x4000000000000000"]) {
      const storage = Memory.alloc(16);
      storage.writeU64(0); // count word; unused for the cocoa path
      storage.add(8).writePointer(cocoa.or(ptr(discriminator)));
      expect(Swift.struct("Swift.String")!.$borrow(storage).$fields).toBe(text);
    }
  });
});

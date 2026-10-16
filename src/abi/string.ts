import { objcUTF8String } from "../runtime/objc.js";
import { LIBSWIFT_CORE_NAME } from "../runtime/platform.js";
import { findType } from "../reflection/registry.js";
import { getMetadata } from "./metadata.js";
import { makeSwiftNativeFunction, SwiftNativeFunction } from "../runtime/calling-convention.js";

const DISCRIMINATOR_OFFSET = 15;
const IS_SMALL = 0x20;
const IS_COCOA = 0x40;
const SMALL_COUNT_MASK = 0x0f;

const TAIL_ALLOCATED_OFFSET = 7;
const IS_TAIL_ALLOCATED = 0x10;
const LARGE_ADDRESS_MASK = "0x0fffffffffffffff";
const NATIVE_BIAS = 32;
const SHARED_STORAGE_START = 24;

export function readString(address: NativePointer): string | null {
  const discriminator = address.readU8(DISCRIMINATOR_OFFSET);

  if ((discriminator & IS_SMALL) !== 0) {
    return address.readUtf8String(discriminator & SMALL_COUNT_MASK);
  }

  const largeAddress = address.readPointer(8).and(ptr(LARGE_ADDRESS_MASK));
  if ((discriminator & IS_COCOA) !== 0) {
    return objcUTF8String(largeAddress);
  }

  const count = address.readU32();
  const tailAllocated = (address.readU8(TAIL_ALLOCATED_OFFSET) & IS_TAIL_ALLOCATED) !== 0;
  const start = tailAllocated
    ? largeAddress.add(NATIVE_BIAS)
    : largeAddress.readPointer(SHARED_STORAGE_START);
  return start.readUtf8String(count);
}

const STRING_STRIDE = Process.pointerSize * 2;
const MAX_UTF8_BYTES_PER_UTF16_UNIT = 3;
const CSTRING_INIT = "$sSS7cStringSSSPys5UInt8VG_tcfC"; // Swift.String.init(cString:)

let cStringInit: { fn: SwiftNativeFunction; metatype: NativePointer } | null = null;

function stringInitializer(): { fn: SwiftNativeFunction; metatype: NativePointer } {
  if (cStringInit !== null) {
    return cStringInit;
  }
  const core = Process.findModuleByName(LIBSWIFT_CORE_NAME);
  if (core === null) {
    throw new Error(`${LIBSWIFT_CORE_NAME} is not loaded`);
  }
  const address = core.findExportByName(CSTRING_INIT) ?? core.findExportByName(`_${CSTRING_INIT}`);
  if (address === null) {
    throw new Error(`String initializer not found: ${CSTRING_INIT}`);
  }
  const stringType = findType("Swift.String");
  const pointerType = findType("Swift.UnsafeRawPointer");
  if (stringType === null || pointerType === null) {
    throw new Error("cannot resolve Swift.String / Swift.UnsafeRawPointer metadata");
  }
  const stringMetadata = getMetadata(stringType);
  const fn = makeSwiftNativeFunction(address, stringMetadata, [getMetadata(pointerType)], {
    hasSelf: true,
  });
  cStringInit = { fn, metatype: stringMetadata.handle };
  return cStringInit;
}

// Returns a +1 String; the caller must move it (writeString) or destroy it (String VWT) or it leaks.
export function createString(text: string): NativePointer {
  if (typeof text !== "string") {
    throw new Error(`createString: expected a string, got ${typeof text}`);
  }
  const { fn, metatype } = stringInitializer();
  const utf8 = Memory.alloc(text.length * MAX_UTF8_BYTES_PER_UTF16_UNIT + 1);
  utf8.writeUtf8String(text);
  const arg = Memory.alloc(Process.pointerSize);
  arg.writePointer(utf8);
  return fn(metatype, arg)!;
}

// String is bitwise-takable, so copying its bytes moves the +1 result into place.
export function writeString(dest: NativePointer, text: string): void {
  Memory.copy(dest, createString(text), STRING_STRIDE);
}

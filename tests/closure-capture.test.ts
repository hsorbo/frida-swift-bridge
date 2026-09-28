import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift } from "./swift.js";
import { arenaAlloc, arenaString, writeRelativeDirectPointer } from "./arena.js";

import { readObject } from "../src/abi/instance.js";
import { layoutCaptures, readCaptures, unwrapReabstractionThunk, writeCaptures } from "../src/abi/closure-capture.js";
import { captureDescriptorOf, offsetToFirstCapture } from "../src/abi/capture-descriptor.js";
import { resolveTypeByMangledName } from "../src/abi/field-descriptor.js";
import { Metadata, MetadataKind } from "../src/abi/metadata.js";
import { typeName } from "../src/runtime/type-name.js";
import { fixtureExport, loadFixture } from "./fixtures/load.js";

import { Swift } from "../src/index.js";
const HEAP_LOCAL_VARIABLE = 0x400;
const NOT_A_CLOSURE = 0x0;

// keeps helper-allocated buffers from being GC'd once their local variable goes out of scope.
const pinned: NativePointer[] = [];

function makeCaptureDescriptor(mangledNames: string[], numBindings = 0): NativePointer {
  const descriptor = arenaAlloc(0xc + mangledNames.length * 0x4);
  descriptor.writeU32(mangledNames.length);
  descriptor.add(0x4).writeU32(0);
  descriptor.add(0x8).writeU32(numBindings);
  mangledNames.forEach((name, i) => {
    const buf = arenaString(name);
    pinned.push(buf);
    writeRelativeDirectPointer(descriptor.add(0xc + i * 0x4), buf);
  });
  pinned.push(descriptor);
  return descriptor;
}

function makeHeapContext(captureDescriptor: NativePointer, offset: number): NativePointer {
  const metadata = Memory.alloc(0x18);
  metadata.writeU64(uint64(HEAP_LOCAL_VARIABLE));
  metadata.add(0x8).writeU32(offset);
  metadata.add(0x10).writePointer(captureDescriptor);

  const context = Memory.alloc(offset + 0x20);
  context.writePointer(metadata);
  pinned.push(metadata, context);
  return context;
}

describe("closure capture layout (synthetic)", () => {
  test("computes capture addresses via align-and-place, not concatenation", () => {
    requireSwift();
    const boolName = Memory.allocUtf8String("Sb");
    const intName = Memory.allocUtf8String("Si");
    expect(resolveTypeByMangledName({ address: boolName, length: 2 })).not.toBeNull();
    expect(resolveTypeByMangledName({ address: intName, length: 2 })).not.toBeNull();
    const context = makeHeapContext(makeCaptureDescriptor(["Sb", "Si"]), 0x10);
    const descriptor = captureDescriptorOf(context);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.numCaptureTypes).toBe(2);
    expect(offsetToFirstCapture(context)).toBe(0x10);

    const slots = layoutCaptures(context);
    expect(slots).not.toBeNull();
    expect(slots!.length).toBe(2);
    expect(slots![0].type.description.fullTypeName).toBe("Swift.Bool");
    expect(slots![1].type.description.fullTypeName).toBe("Swift.Int");
    expect(slots![0].address.equals(context.add(0x10))).toBeTruthy();
    expect(slots![1].address.sub(slots![0].address).toInt32()).toBe(8);
  });

  // IRGen places an empty capture at the running offset without aligning it (addEmptyElement).
  test("places an empty capture without aligning it, even when its alignment exceeds 1", (ctx) => {
    requireSwift();
    const accessor = loadFixture().findExportByName("$s7fixture12AlignedEmptyVMa");
    if (accessor === null) {
      ctx.skip("fixture compiled without ~Copyable (Swift < 5.9)");
    }
    const alignedEmpty = new Metadata(new NativeFunction(accessor!, "pointer", ["size_t"])(0) as NativePointer);
    expect(alignedEmpty.typeLayout.size).toBe(0);
    expect(alignedEmpty.typeLayout.alignment).toBe(16);

    // A noncopyable type is not found by its textual name, so name it by a symbolic reference.
    const typeDescriptor = alignedEmpty.description.handle;
    const descriptor = Memory.alloc(Process.pageSize, { near: typeDescriptor, maxDistance: 0x7fff0000 });
    pinned.push(descriptor);
    const boolName = descriptor.add(0x20);
    boolName.writeUtf8String("Sb");
    const alignedEmptyName = descriptor.add(0x28);
    alignedEmptyName.writeU8(0x01);
    writeRelativeDirectPointer(alignedEmptyName.add(1), typeDescriptor);
    alignedEmptyName.add(5).writeU8(0);
    descriptor.writeU32(3);
    [boolName, alignedEmptyName, boolName].forEach((name, i) => {
      writeRelativeDirectPointer(descriptor.add(0xc + i * 0x4), name);
    });
    const context = makeHeapContext(descriptor, 0x10);

    const slots = layoutCaptures(context)!;
    expect(slots.map(({ type }) => typeName(type))).toEqual(["Swift.Bool", "fixture.AlignedEmpty", "Swift.Bool"]);
    expect(slots.map(({ address }) => address.sub(context).toInt32())).toEqual([0x10, 0x11, 0x11]);
  });

  test("returns null for a generic-bound closure without attempting to resolve it", () => {
    const context = makeHeapContext(makeCaptureDescriptor(["Si"], 1), 0x10);
    expect(layoutCaptures(context)).toBeNull();
  });

  test("returns null when a capture's mangled name does not resolve", () => {
    requireSwift();
    const context = makeHeapContext(makeCaptureDescriptor(["ZZZ_not_a_real_type"]), 0x10);
    context.add(0x10).add(Process.pointerSize).writePointer(ptr(0));
    expect(layoutCaptures(context)).toBeNull();
  });

  test("returns an empty array for a closure with no captures", () => {
    const context = makeHeapContext(makeCaptureDescriptor([]), 0x10);
    expect(layoutCaptures(context)).toEqual([]);
  });

  // a bare class-reference capture has no CaptureDescriptor of its own; see layoutSoleClassCapture.
  test("finds a class reference held directly in place of a nested closure box", () => {
    const classMetadata = Memory.alloc(0x8);
    classMetadata.writeU64(uint64(MetadataKind.Class));
    const instance = Memory.alloc(Process.pointerSize);
    instance.writePointer(classMetadata);
    pinned.push(classMetadata, instance);

    const context = makeHeapContext(makeCaptureDescriptor(["garbage"]), 0x10);
    context.add(0x10).add(Process.pointerSize).writePointer(instance);

    const slots = layoutCaptures(context);
    expect(slots).not.toBeNull();
    expect(slots!.length).toBe(1);
    expect(slots![0].type.kind).toBe(MetadataKind.Class);
    expect(slots![0].address.readPointer().equals(instance)).toBeTruthy();
  });
});

describe("reabstraction-thunk unwrap (synthetic)", () => {
  test("finds the inner closure behind a one-capture, zero-binding wrapper", () => {
    const innerContext = makeHeapContext(makeCaptureDescriptor(["Si"]), 0x10);
    const outerContext = makeHeapContext(makeCaptureDescriptor(["garbage"]), 0x10);
    outerContext.add(0x10).add(Process.pointerSize).writePointer(innerContext);

    const inner = unwrapReabstractionThunk(outerContext);
    expect(inner).not.toBeNull();
    expect(inner!.equals(innerContext)).toBeTruthy();
  });

  test("returns null for a two-capture descriptor (not wrapper-shaped)", () => {
    const outerContext = makeHeapContext(
      makeCaptureDescriptor(["a", "b"]),
      0x10
    );
    expect(unwrapReabstractionThunk(outerContext)).toBeNull();
  });

  test("returns null when the sole capture's second word is not a closure context", () => {
    const notAClosureMetadata = Memory.alloc(0x8);
    notAClosureMetadata.writeU64(uint64(NOT_A_CLOSURE));
    const notAClosureContext = Memory.alloc(Process.pointerSize);
    notAClosureContext.writePointer(notAClosureMetadata);

    const outerContext = makeHeapContext(makeCaptureDescriptor(["garbage"]), 0x10);
    outerContext.add(0x10).add(Process.pointerSize).writePointer(notAClosureContext);

    expect(unwrapReabstractionThunk(outerContext)).toBeNull();
  });
});

describe("closure capture values (live runtime)", () => {
  test("readCaptures resolves through the reabstraction thunk automatically", () => {
    requireSwift();
    const storeCapturing = new NativeFunction(fixtureExport("storeCapturing"), "void", ["int64"]);
    const capturingContext = new NativeFunction(fixtureExport("capturingContext"), "pointer", []);

    storeCapturing(7);
    const context = capturingContext() as NativePointer;

    expect(readCaptures(context)).toEqual([int64(7), "-fixture"]);
  });

  test("decodes a captured struct", () => {
    requireSwift();
    const storeStructCapturing = new NativeFunction(fixtureExport("storeStructCapturing"), "void", [
      "int64",
      "int64",
      "int64",
      "int64",
    ]);
    const structCapturingContext = new NativeFunction(fixtureExport("structCapturingContext"), "pointer", []);

    storeStructCapturing(1, 2, 3, 4);
    const context = structCapturingContext() as NativePointer;

    expect(readCaptures(context)).toEqual([{ a: int64(1), b: int64(2), c: int64(3), d: int64(4) }]);
  });

  test("decodes a captured class reference", () => {
    requireSwift();
    const storeClassCapturing = new NativeFunction(fixtureExport("storeClassCapturing"), "void", ["int64"]);
    const classCapturingContext = new NativeFunction(fixtureExport("classCapturingContext"), "pointer", []);

    storeClassCapturing(42);
    const context = classCapturingContext() as NativePointer;

    const values = readCaptures(context);
    expect(values).not.toBeNull();
    expect(readObject(values![0] as NativePointer)).toEqual({ kind: int64(42) });
  });

  test("agrees on offsets and values for a mixed Bool/Int/class capture list", () => {
    requireSwift();
    const storeMixedCapturing = new NativeFunction(fixtureExport("storeMixedCapturing"), "void", [
      "int64",
      "int64",
      "int64",
    ]);
    const mixedCapturingContext = new NativeFunction(fixtureExport("mixedCapturingContext"), "pointer", []);

    storeMixedCapturing(1, 5, 9);
    const context = mixedCapturingContext() as NativePointer;

    const slots = layoutCaptures(context);
    expect(slots).not.toBeNull();
    expect(slots!.length).toBe(3);
    expect(slots![1].address.sub(slots![0].address).toInt32()).toBe(8);
    expect(slots![2].address.sub(slots![1].address).toInt32()).toBe(8);

    const values = readCaptures(context)!;
    expect(values[0]).toBe(true);
    expect(values[1]).toEqual(int64(5));
    expect(readObject(values[2] as NativePointer)).toEqual({ kind: int64(9) });
  });

  test("places small enums after a spare-bit-carrying capture without folding them into its bits", () => {
    requireSwift();
    const storeSpareBitsCapturing = new NativeFunction(fixtureExport("storeSpareBitsCapturing"), "void", [
      "int64",
      "int64",
    ]);
    const spareBitsCapturingContext = new NativeFunction(fixtureExport("spareBitsCapturingContext"), "pointer", []);

    storeSpareBitsCapturing(3, 7);
    const context = spareBitsCapturingContext() as NativePointer;

    const slots = layoutCaptures(context)!;
    expect(slots.map(({ type }) => typeName(type))).toEqual([
      "fixture.Base",
      "Swift.Optional<Swift.Bool>",
      "fixture.Tint",
      "fixture.OwnerSlot",
      "Swift.Optional<Swift.Int>",
      "Swift.Bool",
    ]);
    expect(slots.map(({ address }) => address.sub(slots[0].address).toInt32())).toEqual([0, 8, 9, 16, 24, 33]);

    const [owner, flag, tint, slot, count, last] = readCaptures(context)!;
    expect(readObject(owner as NativePointer)).toEqual({ kind: int64(3) });
    expect(flag).toEqual({ some: true });
    expect(tint).toBe("blue");
    expect((slot as { backup: NativePointer }).backup.equals(owner as NativePointer)).toBeTruthy();
    expect(count).toEqual({ some: int64(7) });
    expect(last).toBe(true);
  });

  test("returns null for a closure whose captures depend on a generic parameter", () => {
    requireSwift();
    const triggerGenericCapturing = new NativeFunction(fixtureExport("triggerGenericCapturing"), "void", []);
    const genericCapturingContext = new NativeFunction(fixtureExport("genericCapturingContext"), "pointer", []);

    triggerGenericCapturing();
    const context = genericCapturingContext() as NativePointer;

    expect(readCaptures(context)).toBeNull();
  });

  test("writeCaptures mutates a live closure, observable through a real Swift call", () => {
    requireSwift();
    const storeCapturing = new NativeFunction(fixtureExport("storeCapturing"), "void", ["int64"]);
    const capturingContext = new NativeFunction(fixtureExport("capturingContext"), "pointer", []);
    const invokeCapturing = new NativeFunction(fixtureExport("invokeCapturing"), "int64", ["int64"]);

    storeCapturing(7);
    const context = capturingContext() as NativePointer;

    writeCaptures(context, [100, "hi"]);

    expect(invokeCapturing(5).toNumber()).toBe(107);
  });

  test("writeCaptures throws on a value-count mismatch", () => {
    requireSwift();
    const storeCapturing = new NativeFunction(fixtureExport("storeCapturing"), "void", ["int64"]);
    const capturingContext = new NativeFunction(fixtureExport("capturingContext"), "pointer", []);

    storeCapturing(7);
    const context = capturingContext() as NativePointer;

    expect(() => writeCaptures(context, [1])).toThrow();
  });

  test("writeCaptures correctly assigns a heap-allocated (non-inline) String capture", () => {
    requireSwift();
    const storeCapturing = new NativeFunction(fixtureExport("storeCapturing"), "void", ["int64"]);
    const capturingContext = new NativeFunction(fixtureExport("capturingContext"), "pointer", []);
    const invokeCapturing = new NativeFunction(fixtureExport("invokeCapturing"), "int64", ["int64"]);

    storeCapturing(7);
    const context = capturingContext() as NativePointer;

    const longSuffix = "a string well past the small-string inline capacity of fifteen bytes";
    writeCaptures(context, [100, longSuffix]);
    expect(invokeCapturing(5).toNumber()).toBe(100 + 5 + longSuffix.length);

    const anotherLongSuffix = "and now overwritten with a second, differently-sized heap string";
    writeCaptures(context, [1, anotherLongSuffix]);
    expect(invokeCapturing(5).toNumber()).toBe(1 + 5 + anotherLongSuffix.length);
  });

  test("writeCaptures rejects a class-typed capture without mutating any slot", () => {
    requireSwift();
    const storeMixedCapturing = new NativeFunction(fixtureExport("storeMixedCapturing"), "void", [
      "int64",
      "int64",
      "int64",
    ]);
    const mixedCapturingContext = new NativeFunction(fixtureExport("mixedCapturingContext"), "pointer", []);

    storeMixedCapturing(1, 5, 9);
    const context = mixedCapturingContext() as NativePointer;
    const before = readCaptures(context)!;

    expect(() => writeCaptures(context, [false, 6, ptr(0)])).toThrow();

    const after = readCaptures(context)!;
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect((after[2] as NativePointer).equals(before[2] as NativePointer)).toBeTruthy();
  });
});

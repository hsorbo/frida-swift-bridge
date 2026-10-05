import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { requireSwift } from "./swift.js";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { ValueInstance, asSwiftObject, metadataFor, typeOf } from "../src/abi.js";
import { makeSwiftNativeFunction, indirect } from "../src/runtime/calling-convention.js";
import { SwiftError } from "../src/runtime/thrown-error.js";
import { getSwiftCoreApi } from "../src/runtime/api.js";
import { SwiftClosure, SwiftThrow } from "../src/runtime/closure.js";
import {
  closureDiscriminator,
  closureHashString,
  INDIRECT,
} from "../src/runtime/closure-discriminator.js";

import { Swift } from "../src/index.js";
describe("closure as a Swift argument", () => {
  beforeEach(requireSwift);
  test("marshals a closure as a 2-word arg and routes a buffer into its body", () => {
    const Int = metadataFor("Swift.Int")!;

    const data = [0x11, 0x22, 0x33, 0x44, 0x55];
    const buffer = Memory.alloc(data.length);
    buffer.writeByteArray(data);

    const discriminator = closureDiscriminator(closureHashString(["$sSW"], []));
    expect(discriminator).toBe(0xf220);

    let seen: number[] | null = null;
    const closure = SwiftClosure.overBytes((buf) => {
      seen = Array.from(new Uint8Array(buf.readBytes()));
    }, discriminator);

    const invoke = makeSwiftNativeFunction(fixtureExport("invokeWithBytes"), null, [
      Int,
      Int,
      { closure: true },
    ]);

    const baseArg = Memory.alloc(8);
    baseArg.writePointer(buffer);
    const countArg = Memory.alloc(8);
    countArg.writeU64(data.length);

    invoke(baseArg, countArg, closure.value());

    expect(seen).not.toBe(null);
    expect(seen!.length).toBe(data.length);
    for (let i = 0; i < data.length; i++) {
      expect(seen![i]).toBe(data[i]);
    }
  });

  test("drives a real generic rethrows function with the abstracted discriminator", () => {
    const Int = metadataFor("Swift.Int")!;

    const data = [0xde, 0xad, 0xbe, 0xef];
    const buffer = Memory.alloc(data.length);
    buffer.writeByteArray(data);

    const discriminator = closureDiscriminator(closureHashString(["$sSW"], [INDIRECT]));
    expect(discriminator).toBe(0x323);

    let seen: number[] | null = null;
    const closure = SwiftClosure.overBytes((buf) => {
      seen = Array.from(new Uint8Array(buf.readBytes()));
    }, discriminator, { indirectResult: true });

    const invoke = makeSwiftNativeFunction(
      fixtureExport("invokeGeneric"),
      null,
      [Int, Int, { closure: true }],
      { typeArguments: [Int], throws: true }
    );

    const baseArg = Memory.alloc(8);
    baseArg.writePointer(buffer);
    const countArg = Memory.alloc(8);
    countArg.writeU64(data.length);
    invoke(baseArg, countArg, closure.value());

    expect(seen).not.toBe(null);
    expect(seen!.length).toBe(data.length);
    for (let i = 0; i < data.length; i++) {
      expect(seen![i]).toBe(data[i]);
    }
  });
});

describe("closure result and error routing", () => {
  beforeEach(requireSwift);
  test("writes its result through x8 and Swift returns it", () => {
    const Int = metadataFor("Swift.Int")!;

    const data = [0xaa, 0xbb];
    const buffer = Memory.alloc(data.length);
    buffer.writeByteArray(data);

    const discriminator = closureDiscriminator(closureHashString(["$sSW"], [INDIRECT]));
    const closure = SwiftClosure.overBytes((buf, result) => {
      result.writeU64(0x1234 + buf.count);
    }, discriminator, { indirectResult: true });

    const invoke = makeSwiftNativeFunction(
      fixtureExport("invokeReturning"),
      indirect(Int),
      [Int, Int, { closure: true }],
      { typeArguments: [Int], throws: true }
    );

    const baseArg = Memory.alloc(8);
    baseArg.writePointer(buffer);
    const countArg = Memory.alloc(8);
    countArg.writeU64(data.length);

    const ret = invoke(baseArg, countArg, closure.value());
    expect(ret).not.toBe(null);
    expect(ret!.readU64().toNumber()).toBe(0x1234 + data.length);
  });

  test("sets x21 so a rethrows function propagates the closure's error", () => {
    const Int = metadataFor("Swift.Int")!;

    const data = [0x01, 0x02];
    const buffer = Memory.alloc(data.length);
    buffer.writeByteArray(data);

    const errorObj = Memory.alloc(Process.pointerSize);

    const discriminator = closureDiscriminator(closureHashString(["$sSW"], [INDIRECT]));
    const closure = SwiftClosure.overBytes(() => errorObj, discriminator, { throws: true, indirectResult: true });

    const invoke = makeSwiftNativeFunction(
      fixtureExport("invokeGeneric"),
      null,
      [Int, Int, { closure: true }],
      { typeArguments: [Int], throws: true }
    );

    const baseArg = Memory.alloc(8);
    baseArg.writePointer(buffer);
    const countArg = Memory.alloc(8);
    countArg.writeU64(data.length);

    let thrown: SwiftError | null = null;
    try {
      invoke(baseArg, countArg, closure.value());
    } catch (e) {
      thrown = e as SwiftError;
    }
    expect(thrown).not.toBe(null);
    expect(thrown!.error.equals(errorObj)).toBe(true);
  });
});

describe("escaping closure context", () => {
  beforeEach(requireSwift);
  // The synthesized context is a real heap object: only its destroy slot (M-16) is read on release,
  // and Swift runs destroy when the strong count reaches zero.
  test("a synthesized refcounted context runs destroy when released to zero", () => {
    const api = getSwiftCoreApi();

    const block = Memory.alloc(Process.pointerSize * 4);
    const metadata = block.add(Process.pointerSize * 3);
    let context = ptr(0);
    let destroyed = false;
    const destroy = new NativeCallback(
      () => {
        destroyed = true;
        api.swift_deallocObject(context, 16, 7);
      },
      "void",
      []
    );
    // arm64e authenticates the destroy slot: IA, HeapDestructor (0xbbbf), diversified on M-16.
    const arm64e = Process.platform === "darwin" && Process.arch === "arm64";
    const destroySlot = metadata.sub(16);
    destroySlot.writePointer(arm64e ? destroy.strip().sign("ia", destroySlot.blend(0xbbbf)) : destroy);
    metadata.writeU64(0x400);
    context = api.swift_allocObject(metadata, 16, 7) as NativePointer;

    expect(Number(api.swift_retainCount(context))).toBe(1);
    api.swift_retain(context);
    api.swift_release(context);
    expect(destroyed).toBe(false);
    api.swift_release(context);
    expect(destroyed).toBe(true);
  });

  test("an escaping () -> Void closure is retained, invoked after return, then released", () => {
    const api = getSwiftCoreApi();

    let fired = 0;
    const closure = SwiftClosure.overBytes(
      () => {
        fired++;
      },
      closureDiscriminator(closureHashString([], []))
    );
    const retainCount = (): number => Number(api.swift_retainCount(closure.context));

    const storeEscaping = makeSwiftNativeFunction(
      fixtureExport("storeEscaping"),
      null,
      [{ closure: true }]
    );
    const fireEscaping = makeSwiftNativeFunction(fixtureExport("fireEscaping"), null, []);
    const releaseEscaping = makeSwiftNativeFunction(
      fixtureExport("releaseEscaping"),
      null,
      []
    );

    expect(retainCount()).toBe(1);
    storeEscaping(closure.value());
    expect(retainCount()).toBe(2); // +0 guaranteed: Swift retained its own copy

    fireEscaping();
    fireEscaping();
    expect(fired).toBe(2); // invoked after storeEscaping returned -> escaped, resources still live

    releaseEscaping();
    expect(retainCount()).toBe(1); // Swift dropped its ref; our +1 still holds the context
  });
});

describe("closure through the $call facade", () => {
  beforeEach(() => { loadFixture(); });

  // A closure body may call the method that is running it; that call's trampoline must not be the one
  // mid-flight, whose save and result buffers it would overwrite.
  test("a closure body can call the same method again while it is in flight", () => {
    const ByteSource = metadataFor("fixture.ByteSource")!;
    const buffers: NativePointer[] = []; // rooted: a collected Memory.alloc is freed
    const sourceOf = (data: number[]) => {
      const buffer = Memory.alloc(data.length);
      buffer.writeByteArray(data);
      buffers.push(buffer);
      const self = Memory.alloc(ByteSource.valueWitnesses.stride);
      self.writePointer(buffer);
      self.add(Process.pointerSize).writeU64(data.length);
      return asSwiftObject(ValueInstance.borrow(ByteSource, self));
    };
    const outer = sourceOf([1, 2, 3]);
    const inner = sourceOf([7, 8]);
    const seen: number[][] = [];
    outer.$method("withBytes", { self: "borrowing", typeArguments: [] }).call(
      Swift.closure((buf) => {
        inner.$method("withBytes", { self: "borrowing", typeArguments: [] }).call(
          Swift.closure((innerBuf) => {
            seen.push(Array.from(new Uint8Array(innerBuf.readBytes())));
          })
        );
        seen.push(Array.from(new Uint8Array(buf.readBytes())));
      })
    );
    expect(seen).toEqual([[7, 8], [1, 2, 3]]);
    void buffers;
  });

  test("Swift.closure passed to a generic rethrows method receives the bytes", () => {
    const data = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06];
    const buffer = Memory.alloc(data.length);
    buffer.writeByteArray(data);

    const ByteSource = metadataFor("fixture.ByteSource")!;
    const self = Memory.alloc(ByteSource.valueWitnesses.stride);
    self.writePointer(buffer);
    self.add(Process.pointerSize).writeU64(data.length);
    const source = asSwiftObject(ValueInstance.borrow(ByteSource, self));

    let seen: number[] | null = null;
    source.$method("withBytes", { self: "borrowing", typeArguments: [] }).call(
      Swift.closure((buf) => {
        seen = Array.from(new Uint8Array(buf.readBytes()));
      })
    );

    expect(seen).not.toBe(null);
    expect(seen!.length).toBe(data.length);
    for (let i = 0; i < data.length; i++) {
      expect(seen![i]).toBe(data[i]);
    }
  });

  test("Swift.closure passed to a non-generic (buffer) -> Void method receives the bytes", () => {
    const data = [0x09, 0x08, 0x07];
    const buffer = Memory.alloc(data.length);
    buffer.writeByteArray(data);

    const ByteSource = metadataFor("fixture.ByteSource")!;
    const self = Memory.alloc(ByteSource.valueWitnesses.stride);
    self.writePointer(buffer);
    self.add(Process.pointerSize).writeU64(data.length);
    const source = asSwiftObject(ValueInstance.borrow(ByteSource, self));

    let seen: number[] | null = null;
    source.$method("eachByte", { self: "borrowing", typeArguments: [] }).call(
      Swift.closure((buf) => {
        seen = Array.from(new Uint8Array(buf.readBytes()));
      })
    );

    expect(seen).toEqual(data);
  });

  test("Swift.closure passed to a non-generic () -> Void method is invoked", () => {
    const ByteSource = metadataFor("fixture.ByteSource")!;
    const self = Memory.alloc(ByteSource.valueWitnesses.stride);
    self.writePointer(Memory.alloc(1));
    self.add(Process.pointerSize).writeU64(0);
    const source = asSwiftObject(ValueInstance.borrow(ByteSource, self));

    let called = false;
    source.$method("run", { self: "borrowing", typeArguments: [] }).call(
      Swift.closure(() => {
        called = true;
      })
    );

    expect(called).toBe(true);
  });
});

describe("loadable closures (register-passed params and result)", () => {
  beforeEach(requireSwift);
  test("marshals a (Int) -> Int closure: value in x0, result in x0", () => {
    const Int = metadataFor("Swift.Int")!;

    const discriminator = closureDiscriminator(closureHashString(["$sSi"], ["$sSi"]));
    expect(discriminator).toBe(0x489b);

    const closure = SwiftClosure.loadable((n) => Number(n) * 3, ["int64"], "int64", discriminator);
    const invoke = makeSwiftNativeFunction(fixtureExport("invokeMapping"), Int, [Int, { closure: true }]);

    const nArg = Memory.alloc(8);
    nArg.writeU64(7);
    const ret = invoke(nArg, closure.value());
    expect(ret!.readU64().toNumber()).toBe(21);
  });

  test("marshals a (Int, Int) -> Int closure across two arg registers", () => {
    const Int = metadataFor("Swift.Int")!;

    const discriminator = closureDiscriminator(closureHashString(["$sSi", "$sSi"], ["$sSi"]));
    expect(discriminator).toBe(0x97c8);

    const closure = SwiftClosure.loadable(
      (a, b) => Number(a) + Number(b),
      ["int64", "int64"],
      "int64",
      discriminator
    );
    const invoke = makeSwiftNativeFunction(fixtureExport("invokeCombine"), Int, [Int, Int, { closure: true }]);

    const aArg = Memory.alloc(8);
    aArg.writeU64(20);
    const bArg = Memory.alloc(8);
    bArg.writeU64(22);
    const ret = invoke(aArg, bArg, closure.value());
    expect(ret!.readU64().toNumber()).toBe(42);
  });

  test("marshals a (Double) -> Double closure through the v-registers", () => {
    const Double = metadataFor("Swift.Double")!;

    const discriminator = closureDiscriminator(closureHashString(["$sSd"], ["$sSd"]));
    expect(discriminator).toBe(0xe4d1);
    const closure = SwiftClosure.loadable((x) => Number(x) / 2, ["double"], "double", discriminator);
    const invoke = makeSwiftNativeFunction(fixtureExport("invokeScale"), Double, [Double, { closure: true }]);

    const xArg = Memory.alloc(8);
    xArg.writeDouble(7);
    expect(invoke(xArg, closure.value())!.readDouble()).toBe(3.5);
  });

  test("marshals a (Int) -> Bool closure: Swift reads the bool result", () => {
    const Int = metadataFor("Swift.Int")!;
    const Bool = metadataFor("Swift.Bool")!;

    const discriminator = closureDiscriminator(closureHashString(["$sSi"], ["$sSb"]));
    expect(discriminator).toBe(0xd26c);

    const closure = SwiftClosure.loadable((n) => Number(n) > 5, ["int64"], "bool", discriminator);
    const invoke = makeSwiftNativeFunction(fixtureExport("invokePredicate"), Bool, [Int, { closure: true }]);

    const yes = Memory.alloc(8);
    yes.writeU64(9);
    expect(invoke(yes, closure.value())!.readU8()).toBe(1);

    const no = Memory.alloc(8);
    no.writeU64(2);
    expect(invoke(no, closure.value())!.readU8()).toBe(0);
  });
});

describe("loadable closure through the $call facade", () => {
  beforeEach(() => { loadFixture(); });

  function byteSource(): ReturnType<typeof asSwiftObject> {
    const ByteSource = metadataFor("fixture.ByteSource")!;
    const self = Memory.alloc(ByteSource.valueWitnesses.stride);
    self.writePointer(Memory.alloc(1));
    self.add(Process.pointerSize).writeU64(0);
    return asSwiftObject(ValueInstance.borrow(ByteSource, self));
  }

  test("Swift.closure (Int) -> Int returns the mapped value", () => {
    const result = byteSource().$method("apply", { self: "borrowing", typeArguments: [] }).call(7, Swift.closure((n: number) => Number(n) * 6));
    expect(result).toEqual(int64(42));
  });

  test("Swift.closure (Int) -> Bool returns the predicate result", () => {
    const source = byteSource();
    expect(source.$method("check", { self: "borrowing", typeArguments: [] }).call(9, Swift.closure((n: number) => Number(n) > 5))).toBe(true);
    expect(source.$method("check", { self: "borrowing", typeArguments: [] }).call(2, Swift.closure((n: number) => Number(n) > 5))).toBe(false);
  });
});

describe("throwing loadable closures", () => {
  beforeEach(() => { loadFixture(); });

  test("a non-throwing body returns its result through a throws closure type", () => {
    const Int = metadataFor("Swift.Int")!;
    const Bool = metadataFor("Swift.Bool")!;

    // throws is ignored in the discriminator, so it matches the non-throwing (Int) -> Bool.
    const discriminator = closureDiscriminator(closureHashString(["$sSi"], ["$sSb"]));
    expect(discriminator).toBe(0xd26c);

    const closure = SwiftClosure.loadable((n) => Number(n) > 5, ["int64"], "bool", discriminator, {
      throws: true,
    });
    const invoke = makeSwiftNativeFunction(fixtureExport("invokeThrowing"), Bool, [Int, { closure: true }], {
      throws: true,
    });

    const yes = Memory.alloc(8);
    yes.writeU64(9);
    expect(invoke(yes, closure.value())!.readU8()).toBe(1);
    const no = Memory.alloc(8);
    no.writeU64(2);
    expect(invoke(no, closure.value())!.readU8()).toBe(0);
  });

  test("a SwiftThrow body sets x21 so the rethrows function propagates the error", () => {
    const Int = metadataFor("Swift.Int")!;
    const Bool = metadataFor("Swift.Bool")!;
    const errorObj = Memory.alloc(Process.pointerSize);

    const discriminator = closureDiscriminator(closureHashString(["$sSi"], ["$sSb"]));
    const closure = SwiftClosure.loadable(() => new SwiftThrow(errorObj), ["int64"], "bool", discriminator, {
      throws: true,
    });
    const invoke = makeSwiftNativeFunction(fixtureExport("invokeThrowing"), Bool, [Int, { closure: true }], {
      throws: true,
    });

    const nArg = Memory.alloc(8);
    nArg.writeU64(3);

    let thrown: SwiftError | null = null;
    try {
      invoke(nArg, closure.value());
    } catch (e) {
      thrown = e as SwiftError;
    }
    expect(thrown).not.toBe(null);
    expect(thrown!.error.equals(errorObj)).toBe(true);
  });

  test("Swift.closure passed to a throwing-closure method returns the predicate result", () => {
    const ByteSource = metadataFor("fixture.ByteSource")!;
    const self = Memory.alloc(ByteSource.valueWitnesses.stride);
    self.writePointer(Memory.alloc(1));
    self.add(Process.pointerSize).writeU64(0);
    const source = asSwiftObject(ValueInstance.borrow(ByteSource, self));

    expect(source.$method("tryCheck", { self: "borrowing", typeArguments: [] }).call(9, Swift.closure((n: number) => Number(n) > 5))).toBe(true);
    expect(source.$method("tryCheck", { self: "borrowing", typeArguments: [] }).call(2, Swift.closure((n: number) => Number(n) > 5))).toBe(false);
  });
});

describe("sized-int and pointer loadable closures", () => {
  beforeEach(() => { loadFixture(); });

  test("marshals a (Int32) -> Int32 closure", () => {
    const Int32 = metadataFor("Swift.Int32")!;

    const discriminator = closureDiscriminator(closureHashString(["$ss5Int32V"], ["$ss5Int32V"]));
    expect(discriminator).toBe(0x3fe6);

    const closure = SwiftClosure.loadable((n) => Number(n) + 100, ["int32"], "int32", discriminator);
    const invoke = makeSwiftNativeFunction(fixtureExport("invokeI32"), Int32, [Int32, { closure: true }]);

    const nArg = Memory.alloc(4);
    nArg.writeS32(5);
    expect(invoke(nArg, closure.value())!.readS32()).toBe(105);
  });

  test("marshals a (UnsafeRawPointer) -> UnsafeRawPointer closure", () => {
    const Raw = metadataFor("Swift.UnsafeRawPointer")!;

    const discriminator = closureDiscriminator(closureHashString(["$sSV"], ["$sSV"]));
    expect(discriminator).toBe(0x6528);

    const closure = SwiftClosure.loadable((p) => (p as NativePointer).add(8), ["pointer"], "pointer", discriminator);
    const invoke = makeSwiftNativeFunction(fixtureExport("invokeRawPtr"), Raw, [Raw, { closure: true }]);

    const base = Memory.alloc(16);
    const pArg = Memory.alloc(Process.pointerSize);
    pArg.writePointer(base);
    expect(invoke(pArg, closure.value())!.readPointer().equals(base.add(8))).toBe(true);
  });

  test("Swift.closure (Int32) -> Int32 through the facade", () => {
    const ByteSource = metadataFor("fixture.ByteSource")!;
    const self = Memory.alloc(ByteSource.valueWitnesses.stride);
    self.writePointer(Memory.alloc(1));
    self.add(Process.pointerSize).writeU64(0);
    const source = asSwiftObject(ValueInstance.borrow(ByteSource, self));

    expect(source.$method("mapI32", { self: "borrowing", typeArguments: [] }).call(5, Swift.closure((n: number) => Number(n) + 100))).toBe(105);
  });
});

describe("loadable param with an indirect result", () => {
  beforeEach(() => { loadFixture(); });

  test("marshals a (Int) -> R closure writing its result through x8", () => {
    const Int = metadataFor("Swift.Int")!;

    const discriminator = closureDiscriminator(closureHashString(["$sSi"], [INDIRECT]));
    expect(discriminator).toBe(0xe7b2);

    const closure = SwiftClosure.loadableProducing(
      (args, result) => {
        result.writeU64(Number(args[0]) * 4);
      },
      ["int64"],
      discriminator
    );
    const invoke = makeSwiftNativeFunction(
      fixtureExport("invokeProducing"),
      indirect(Int),
      [Int, { closure: true }],
      { typeArguments: [Int] }
    );

    const nArg = Memory.alloc(8);
    nArg.writeU64(8);
    expect(invoke(nArg, closure.value())!.readU64().toNumber()).toBe(32);
  });

  test("Swift.closure (Int) -> R through $method with an explicit type argument", () => {
    const Int = metadataFor("Swift.Int")!;

    const ByteSource = metadataFor("fixture.ByteSource")!;
    const self = Memory.alloc(ByteSource.valueWitnesses.stride);
    self.writePointer(Memory.alloc(1));
    self.add(Process.pointerSize).writeU64(0);
    const source = asSwiftObject(ValueInstance.borrow(ByteSource, self));

    const result = source
      .$method("produce", { typeArguments: [typeOf(Int)], self: "borrowing" })
      .call(6, Swift.closure((n: number) => Number(n) * 7));
    expect(result).toEqual(int64(42));
  });
});

describe("String loadable closures through the facade", () => {
  beforeEach(() => { loadFixture(); });

  function byteSource(): ReturnType<typeof asSwiftObject> {
    const ByteSource = metadataFor("fixture.ByteSource")!;
    const self = Memory.alloc(ByteSource.valueWitnesses.stride);
    self.writePointer(Memory.alloc(1));
    self.add(Process.pointerSize).writeU64(0);
    return asSwiftObject(ValueInstance.borrow(ByteSource, self));
  }

  test("(String) -> String round-trips a small inline string", () => {
    const result = byteSource().$method("mapStr", { self: "borrowing", typeArguments: [] }).call("frida", Swift.closure((s: string) => s.toUpperCase()));
    expect(result).toBe("FRIDA");
  });

  test("(String) -> String preserves all 16 bytes of a 12-char inline string", () => {
    // 9–15 char strings store content in the high word; pointer-typed words avoid double precision loss.
    const result = byteSource().$method("mapStr", { self: "borrowing", typeArguments: [] }).call("abcdefghijkl", Swift.closure((s: string) => s.split("").reverse().join("")));
    expect(result).toBe("lkjihgfedcba");
  });

  test("(String) -> String round-trips a heap-allocated string", () => {
    const long = "the quick brown fox jumps over the lazy dog";
    const result = byteSource().$method("mapStr", { self: "borrowing", typeArguments: [] }).call(long, Swift.closure((s: string) => s.toUpperCase()));
    expect(result).toBe(long.toUpperCase());
  });

  test("(String) -> Int passes the string and returns a scalar", () => {
    expect(byteSource().$method("strLen", { self: "borrowing", typeArguments: [] }).call("héllo", Swift.closure((s: string) => s.length))).toEqual(int64(5));
  });

  test("(Int) -> String returns a synthesized string", () => {
    expect(byteSource().$method("label", { self: "borrowing", typeArguments: [] }).call(7, Swift.closure((n: number) => `n=${n}`))).toBe("n=7");
  });
});

describe("closure discriminator", () => {
  test("reproduces Swift's per-signature discriminators", () => {
    expect(closureDiscriminator(closureHashString([], []))).toBe(0xf08);
    expect(closureDiscriminator(closureHashString(["$sSi"], ["$sSi"]))).toBe(0x489b);
    expect(closureDiscriminator(closureHashString(["$sSi", "$sSi"], ["$sSi"]))).toBe(0x97c8);
    expect(closureDiscriminator(closureHashString(["$sSi"], ["$sSb"]))).toBe(0xd26c);
    expect(closureDiscriminator(closureHashString(["$sSd"], ["$sSd"]))).toBe(0xe4d1);
    expect(closureDiscriminator(closureHashString(["$sSW"], []))).toBe(0xf220);
    expect(closureDiscriminator(closureHashString(["$sSW"], [INDIRECT]))).toBe(0x0323);
    expect(closureDiscriminator(closureHashString(["$sSi"], [INDIRECT]))).toBe(0xe7b2);
    expect(closureDiscriminator(closureHashString(["$ss5Int32V"], ["$ss5Int32V"]))).toBe(0x3fe6);
    expect(closureDiscriminator(closureHashString(["$sSV"], ["$sSV"]))).toBe(0x6528);
  });
});

import { test, expect, describe } from "@frida/injest/agent";
import { fixtureExport, loadFixture, loadFixtureSyms } from "./fixtures/load.js";

import { Swift, SwiftClass, SwiftStruct, isSwiftObject, type CallArg, type SwiftValue, type SwiftObject, type CallResult, type SwiftInvocationContext } from "../src/index.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";
import { requireSymbolTable , fieldsOf } from "./swift.js";

import { metadataFor, metadataOf, typeOf, type ClassType, ClassInstance, ClassMetadata, readVTableChain, asSwiftObject, ValueInstance } from "../src/abi.js";

const MAKE_LINK = "$s7fixture8makeLinkyAA0C0VSSF";
const LINK_ADDRESS = "$s7fixture11linkAddressySSAA4LinkVF";

function intValue(v: number): NativePointer {
  const p = Memory.alloc(8);
  p.writeU64(v);
  return p;
}

function structValue(metadata: ReturnType<typeof metadataFor>, fields: number[]): NativePointer {
  const p = Memory.alloc(metadata!.typeLayout.stride);
  fields.forEach((v, i) => p.add(i * 8).writeU64(v));
  return p;
}

describe("Swift.Interceptor.attach", () => {
  test("decodes scalar arguments and the scalar return", () => {
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.addInts");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(addr, Int, [Int, Int])(intValue(20), intValue(22));
    listener.detach();
    expect(seenArgs).toEqual([int64(20), int64(22)]);
    expect(seenRet).toEqual(int64(42));
  });

  test("attaches to a function only the symbol table names", (ctx) => {
    requireSymbolTable(ctx);
    const hidden = loadFixtureSyms()
      .enumerateSymbols()
      .find((s) => Swift.demangle(s.name)?.startsWith("fixturesyms.Dispatcher.hidden(") ?? false)!;
    const Int = metadataFor("Swift.Int")!;
    const Dispatcher = metadataFor("fixturesyms.Dispatcher")!;
    const slot = readVTableChain(new ClassMetadata(Dispatcher.handle)).find((e) => e.declaredImpl.equals(hidden.address))!;
    const obj = Swift.type("fixturesyms.Dispatcher")!.init()! as SwiftObject;
    const dispatcher = new ClassInstance(obj.$handle);
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(hidden.address, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    const result = dispatcher.vtableMethod(slot.metadataOffset, { returnType: Int, argTypes: [Int] }).call(10);
    listener.detach();
    expect(result).toEqual(int64(30));
    expect(seenArgs).toEqual([int64(10)]);
    expect(seenRet).toEqual(int64(30));
  });

  test("decodes a direct (register-exploded) struct argument", () => {
    const Int = metadataFor("Swift.Int")!;
    const Loadable = metadataFor("fixture.LoadableStruct")!;
    const addr = fixtureExport("fixture.sumLoadable");
    let seen: CallResult[] | null = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seen = fieldsOf(args) as CallResult[];
      },
    });
    makeSwiftNativeFunction(addr, Int, [Loadable])(structValue(Loadable, [1, 2, 3, 4]));
    listener.detach();
    expect(seen).toEqual([{ a: int64(1), b: int64(2), c: int64(3), d: int64(4) }]);
  });

  test("decodes an indirect struct argument", () => {
    const Int = metadataFor("Swift.Int")!;
    const Big = metadataFor("fixture.BigStruct")!;
    const addr = fixtureExport("fixture.sumBig");
    let seen: CallResult[] | null = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seen = fieldsOf(args) as CallResult[];
      },
    });
    makeSwiftNativeFunction(addr, Int, [Big])(structValue(Big, [1, 2, 3, 4, 5]));
    listener.detach();
    expect(seen).toEqual([{ a: int64(1), b: int64(2), c: int64(3), d: int64(4), e: int64(5) }]);
  });

  test("decodes an indirect (x8) struct return", () => {
    const Big = metadataFor("fixture.BigStruct")!;
    const addr = fixtureExport("fixture.makeBigStruct");
    let seen: CallResult = null;
    const listener = Swift.Interceptor.attach(addr, {
      onLeave(ret) {
        seen = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(addr, Big, [])();
    listener.detach();
    expect(seen).toEqual({ a: int64(1), b: int64(2), c: int64(3), d: int64(4), e: int64(5) });
  });

  test("decodes a direct (multi-register) struct return", () => {
    const Loadable = metadataFor("fixture.LoadableStruct")!;
    const addr = fixtureExport("fixture.makeLoadableStruct");
    let seen: CallResult = null;
    const listener = Swift.Interceptor.attach(addr, {
      onLeave(ret) {
        seen = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(addr, Loadable, [])();
    listener.detach();
    expect(seen).toEqual({ a: int64(1), b: int64(2), c: int64(3), d: int64(4) });
  });

  test("decodes a concrete Optional argument and return", () => {
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.unwrapOrZero");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(fixtureExport("fixture.makeUnwrapOrZero"), Int, [])();
    listener.detach();
    expect(seenArgs).toEqual([int64(5)]);
    expect(seenRet).toEqual(int64(5));
  });

  test("hooks a function taking and returning a concrete Array", () => {
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.sumIntArray");
    let seenArgs: SwiftValue[][] | null = null;
    let seenRet: SwiftValue[] | null = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args.map((a) => (a as SwiftObject).$container!() as SwiftValue[]);
      },
      onLeave(ret) {
        seenRet = (ret as SwiftObject).$container!() as SwiftValue[];
      },
    });
    makeSwiftNativeFunction(fixtureExport("fixture.makeSumIntArray"), Int, [])();
    listener.detach();
    expect(seenArgs).toEqual([[int64(1), int64(2), int64(3)]]);
    expect(seenRet).toEqual([int64(6)]);
  });

  test("decodes the Optional value of a hooked property getter and setter", () => {
    const Int = metadataFor("Swift.Int")!;
    let setterArgs: CallResult[] | null = null;
    let getterRet: CallResult = null;
    const setter = Swift.Interceptor.attach(fixtureExport("fixture.IntSource.maybe.setter"), {
      onEnter(args) {
        setterArgs = args;
      },
    });
    const getter = Swift.Interceptor.attach(fixtureExport("fixture.IntSource.maybe.getter"), {
      onLeave(ret) {
        getterRet = ret;
      },
    });
    makeSwiftNativeFunction(fixtureExport("fixture.roundTripIntSourceMaybe"), Int, [])();
    setter.detach();
    getter.detach();
    expect(setterArgs).toEqual([int64(7)]);
    expect(getterRet).toEqual(int64(7));
  });

  test("hooks a modify accessor: self on enter, the mutated value on resume", () => {
    const Int = metadataFor("Swift.Int")!;
    const selves: CallResult[] = [];
    let seenArgs: CallResult[] | null = null;
    let resumed: CallResult = null;
    const listener = Swift.Interceptor.attach(fixtureExport("fixture.Point.tracked.modify"), {
      onEnter(args) {
        seenArgs = args;
        selves.push(fieldsOf(this.self!)!);
      },
      onLeave(ret) {
        resumed = ret;
        selves.push(fieldsOf(this.self!)!);
      },
    });
    const result = makeSwiftNativeFunction(fixtureExport("fixture.bumpTracked"), Int, [])() as NativePointer;
    listener.detach();
    expect(result.readS64()).toEqual(int64(8));
    expect(seenArgs).toEqual([]);
    expect(resumed).toEqual(int64(8));
    expect(selves).toEqual([{ x: int64(5) }, { x: int64(8) }]);
  });

  test("hooks a modify accessor of a class property across its exclusivity access", () => {
    const Int = metadataFor("Swift.Int")!;
    let resumed: CallResult = null;
    let seenSelf: CallResult = null;
    const listener = Swift.Interceptor.attach(fixtureExport("fixture.Tally.count.modify"), {
      onLeave(ret) {
        resumed = ret;
        seenSelf = this.self!;
      },
    });
    const result = makeSwiftNativeFunction(fixtureExport("fixture.bumpTally"), Int, [])() as NativePointer;
    listener.detach();
    expect(result.readS64()).toEqual(int64(42));
    expect(resumed).toEqual(int64(42));
    expect((seenSelf as unknown as SwiftObject).count).toEqual(int64(42));
  });

  test("hooks read accessors: self on enter, the yielded value on leave", () => {
    const Int = metadataFor("Swift.Int")!;
    const selves: CallResult[] = [];
    const yields: Record<string, CallResult> = {};
    const listeners = ["scalar", "text", "payload", "block"].map((name) =>
      Swift.Interceptor.attach(fixtureExport(`fixture.Reading.${name}.read`), {
        onEnter(args) {
          expect(args).toEqual([]);
          selves.push(fieldsOf(this.self!)!);
        },
        onLeave(ret) {
          yields[name] = fieldsOf(ret)!;
        },
      })
    );
    const result = makeSwiftNativeFunction(fixtureExport("fixture.driveReading"), Int, [])() as NativePointer;
    listeners.forEach((l) => l.detach());
    expect(result.readS64()).toEqual(int64(56));
    const four = { a: int64(1), b: int64(2), c: int64(3), d: int64(4) };
    expect(yields).toEqual({
      scalar: int64(5),
      text: "a string long enough to live on the heap",
      payload: { value: int64(7) },
      block: four,
    });
    expect(selves).toHaveLength(4);
    expect(selves[0]).toEqual({ n: int64(5), label: "a string long enough to live on the heap", box: { value: int64(7) }, four });
  });

  test("recovers a generic scalar argument and return from the implicit metadata", () => {
    const Int = metadataFor("Swift.Int")!;
    const identity = fixtureExport("fixture.genericIdentity");
    const driver = fixtureExport("fixture.makeGenericInt");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(identity, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(driver, Int, [])();
    listener.detach();
    expect(seenArgs).toEqual([int64(7)]);
    expect(seenRet).toEqual(int64(7));
  });

  test("recovers a generic struct argument from the implicit metadata", () => {
    const Loadable = metadataFor("fixture.LoadableStruct")!;
    const identity = fixtureExport("fixture.genericIdentity");
    const driver = fixtureExport("fixture.makeGenericStruct");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(identity, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(driver, Loadable, [])();
    listener.detach();
    expect(seenArgs).toEqual([{ a: int64(5), b: int64(6), c: int64(7), d: int64(8) }]);
    expect(seenRet).toEqual({ a: int64(5), b: int64(6), c: int64(7), d: int64(8) });
  });

  test("recovers two generic params of different concrete types", () => {
    const Int = metadataFor("Swift.Int")!;
    const first = fixtureExport("fixture.genericFirst");
    const driver = fixtureExport("fixture.makeGenericPair");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(first, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(driver, Int, [])();
    listener.detach();
    expect(seenArgs).toEqual([int64(11), "ignored"]);
    expect(seenRet).toEqual(int64(11));
  });

  test("decodes an array over a generic param returned in a register, not through x8", () => {
    const Int = metadataFor("Swift.Int")!;
    const doubled = fixtureExport("fixture.genericDoubled");
    const driver = fixtureExport("fixture.makeGenericDoubled");
    let seenArg: SwiftValue[] | null = null;
    let seen: SwiftValue[] | null = null;
    const listener = Swift.Interceptor.attach(doubled, {
      onEnter(args) {
        seenArg = (args[0] as SwiftObject).$container!() as SwiftValue[];
      },
      onLeave(ret) {
        seen = (ret as SwiftObject).$container!() as SwiftValue[];
      },
    });
    makeSwiftNativeFunction(driver, Int, [])();
    listener.detach();
    expect(seenArg).toEqual([int64(3), int64(4)]);
    expect(seen).toEqual([int64(3), int64(4), int64(3), int64(4)]);
  });

  test("decodes a generic class argument and return from their registers", () => {
    const Int = metadataFor("Swift.Int")!;
    const identity = fixtureExport("fixture.genericCellIdentity");
    const driver = fixtureExport("fixture.makeGenericCell");
    let seenValue: SwiftValue = null;
    let cell: NativePointer | null = null;
    let returned: NativePointer | null = null;
    const listener = Swift.Interceptor.attach(identity, {
      onEnter(args) {
        cell = (args[0] as SwiftObject).$handle;
        seenValue = (args[0] as SwiftObject).$field("value").read();
      },
      onLeave(ret) {
        returned = (ret as SwiftObject).$handle;
      },
    });
    makeSwiftNativeFunction(driver, Int, [])();
    listener.detach();
    expect(seenValue).toEqual(int64(5));
    expect(String(returned)).toBe(String(cell));
  });

  test("decodes a generic function taking a metatype argument", () => {
    const Int = metadataFor("Swift.Int")!;
    const identity = fixtureExport("fixture.metatypeIdentity");
    const driver = fixtureExport("fixture.makeMetatypeInt");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(identity, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(driver, Int, [])();
    listener.detach();
    expect(seenArgs).toEqual([Swift.reflect("Swift.Int"), int64(5)]);
    expect(seenRet).toEqual(int64(5));
  });

  test("decodes a constrained generic arg, ignoring the trailing witness table", () => {
    const scaleGeneric = fixtureExport("fixture.scaleGeneric");
    const driver = fixtureExport("fixture.makeScaleGeneric");
    const Int = metadataFor("Swift.Int")!;
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(scaleGeneric, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(driver, Int, [])();
    listener.detach();
    expect(seenArgs).toEqual([int64(6), int64(7)]);
    expect(seenRet).toEqual(int64(42));
  });

  test("decodes a Double argument and return from the FP registers", () => {
    const Double_ = metadataFor("Swift.Double")!;
    const addr = fixtureExport("fixture.scaleDouble");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    const arg = Memory.alloc(8);
    arg.writeDouble(21);
    makeSwiftNativeFunction(addr, Double_, [Double_])(arg);
    listener.detach();
    expect(seenArgs).toEqual([21]);
    expect(seenRet).toBe(42);
  });

  test("decodes a mixed Double/Int struct from the FP and GP registers", () => {
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.scaleMixedPair(");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    const driven = makeSwiftNativeFunction(fixtureExport("fixture.driveScaleMixedPair"), Int, [])()!;
    listener.detach();
    expect(driven.readU64().toNumber()).toBe(51);
    expect(seenArgs).toEqual([{ d: 1.5, i: int64(2) }, int64(3)]);
    expect(seenRet).toEqual({ d: 4.5, i: int64(6) });
  });

  test("reads GP arguments spilled past the registers from the caller's stack", () => {
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.spillInts(");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(fixtureExport("fixture.driveSpillInts("), Int, [])();
    listener.detach();
    expect(seenArgs).toEqual([
      int64(1), int64(2), int64(3), int64(4), int64(5), int64(6),
      { a: int64(7), b: int64(8), c: int64(9), d: int64(10) },
      true,
      { tag: 11, value: int64(12), flag: true },
      -13,
      int64(14),
    ]);
    expect(seenRet).toEqual(int64(25));
  });

  test("reads FP arguments spilled past the registers from the caller's stack", () => {
    const Double_ = metadataFor("Swift.Double")!;
    const addr = fixtureExport("fixture.spillDoubles");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(fixtureExport("fixture.driveSpillDoubles"), Double_, [])();
    listener.detach();
    expect(seenArgs).toEqual([
      int64(1), int64(2), int64(3), int64(4), int64(5), int64(6), int64(7),
      0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5,
      { x: 7.5, y: 8.5 },
      9.25,
      10.75,
      "hi",
      11.5,
    ]);
    expect(seenRet).toBe(43.5);
  });

  test("reads an Int128 as one register pair or 16-byte-aligned stack slot", (ctx) => {
    if (Process.arch !== "arm64") ctx.skip("x86-64 compilers disagree on where an Int128 past the registers goes");
    loadFixture();
    if (metadataFor("fixture.PaddedInt128") === null) ctx.skip("fixture compiled without Int128 (Swift < 6.0)");
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.spillInt128(");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(fixtureExport("fixture.driveSpillInt128("), Int, [])();
    listener.detach();
    expect(seenArgs).toEqual([
      { head: int64(1), wide: (2n << 64n) | 3n },
      int64(4), int64(5), int64(6), int64(7),
      (8n << 64n) | 9n,
      true,
      (10n << 64n) | 11n,
      int64(12),
    ]);
    expect(seenRet).toEqual(int64(40));
  });

  test("decodes a single-case enum argument as its payload", () => {
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.spillWrapped(");
    let seenArgs: CallResult[] | null = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
    });
    const driven = makeSwiftNativeFunction(fixtureExport("fixture.driveSpillWrapped("), Int, [])()!;
    listener.detach();
    expect(driven.readS64().toNumber()).toBe(44);
    expect(seenArgs).toEqual([
      int64(1), int64(2), int64(3), int64(4), int64(5), int64(6), int64(7), int64(8),
      true,
      { tagged: { tag: 9, value: int64(10), flag: true } },
      { meters: 11.5 },
      int64(12),
    ]);
  });

  test("decodes a returned Int128 from its register pair, skipping the padding word", (ctx) => {
    loadFixture();
    if (metadataFor("fixture.FramedInt128") === null) ctx.skip("fixture compiled without Int128 (Swift < 6.0)");
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.flipFramedInt128(");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    const driven = makeSwiftNativeFunction(fixtureExport("fixture.driveFlipFramedInt128("), Int, [])()!;
    listener.detach();
    expect(driven.readS64().toNumber()).toBe(441);
    expect(seenArgs).toEqual([{ head: int64(1), wide: (2n << 64n) | 3n, tail: int64(4) }]);
    expect(seenRet).toEqual({ head: int64(4), wide: (2n << 64n) | 4n, tail: int64(1) });
  });

  test("surfaces a thrown error on leave instead of decoding a bogus return", () => {
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.mightThrow");
    const seen: { retval: CallResult; error?: CallResult }[] = [];
    const listener = Swift.Interceptor.attach(addr, {
      onLeave(retval, error) {
        seen.push({ retval, error });
      },
    });
    const call = makeSwiftNativeFunction(addr, Int, [Int], { throws: true });
    call(intValue(0));
    expect(() => call(intValue(1))).toThrow();
    listener.detach();
    expect(seen[0]).toEqual({ retval: int64(99), error: undefined });
    expect(seen[1]).toEqual({ retval: null, error: "boom" });
  });

  test("a function annotated with its call inputs is observed as decoded values", () => {
    const mightThrow = Swift.function<Int64, [number]>(loadFixture(), "$s7fixture10mightThrowyS2iKF");
    const seen: CallResult[] = [];
    const listener = Swift.Interceptor.attach(mightThrow, {
      onEnter(args) {
        seen.push(args[0]);
      },
      onLeave(retval, error) {
        seen.push(retval, error ?? "returned");
      },
    });
    try {
      mightThrow.call(0);
      expect(() => mightThrow.call(1)).toThrow();
    } finally {
      listener.detach();
    }
    expect(seen).toEqual([int64(0), int64(99), "returned", int64(1), null, "boom"]);
  });

  test("decodes a named-protocol existential argument, projecting the dynamic value", () => {
    const String_ = metadataFor("Swift.String")!;
    const Greeter = metadataOf(Swift.reflect("any fixture.Greeter")!);
    const g = makeSwiftNativeFunction(fixtureExport("fixture.makeGreeterExistential"), Greeter, [])()!;
    const addr = fixtureExport("fixture.greetExistential");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(addr, String_, [Greeter])(g);
    listener.detach();
    expect(seenArgs).toEqual([{ name: "Ada" }]);
    expect(seenRet).toBe("Hello, Ada");
  });

  test("decodes a protocol-composition existential argument, projecting the dynamic value", () => {
    const String_ = metadataFor("Swift.String")!;
    const GreeterAged = metadataOf(Swift.reflect("any fixture.Greeter & fixture.Aged")!);
    const v = makeSwiftNativeFunction(fixtureExport("fixture.makeGreeterAged"), GreeterAged, [])()!;
    const addr = fixtureExport("fixture.describeGreeterAged");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(addr, {
      onEnter(args) {
        seenArgs = fieldsOf(args) as CallResult[];
      },
      onLeave(ret) {
        seenRet = fieldsOf(ret)!;
      },
    });
    makeSwiftNativeFunction(addr, String_, [GreeterAged])(v);
    listener.detach();
    expect(seenArgs).toEqual([{ name: "Cy", age: int64(9) }]);
    expect(seenRet).toBe("Hi, Cy (9)");
  });

  test("hands back a class return as a live SwiftObject facade", () => {
    const Int = metadataFor("Swift.Int")!;
    const Counter = metadataFor("fixture.Counter")!;
    const addr = fixtureExport("fixture.makeCounter");
    let seen: CallResult = null;
    const listener = Swift.Interceptor.attach(addr, {
      onLeave(ret) {
        seen = ret;
      },
    });
    makeSwiftNativeFunction(addr, Counter, [Int])(intValue(7));
    listener.detach();
    const counter = seen as unknown as SwiftObject;
    expect(counter.$type.name).toBe("fixture.Counter");
    expect(counter.$get("count")).toEqual(int64(7));
  });

  // The borrowed value facade aliases the caller's result storage, so it is read inside onLeave; the field
  // probes prove it is the live aggregate, not a deep-copied snapshot.
  test("hands back a non-POD value return as a live, queryable value facade", () => {
    const Int = metadataFor("Swift.Int")!;
    const Token = metadataFor("fixture.Token")!;
    const Wrapper = metadataFor("fixture.Wrapper")!;
    const tokenBuf = makeSwiftNativeFunction(fixtureExport("fixture.makeToken"), Token, [Int])(intValue(7))!;
    const addr = fixtureExport("fixture.makeWrapper");
    let isValue = false;
    let a: SwiftValue = null;
    let tokenMatches = false;
    const listener = Swift.Interceptor.attach(addr, {
      onLeave(ret) {
        const wrapper = ret as SwiftObject;
        isValue = wrapper.$kind === "value";
        a = wrapper.$field("a").read();
        tokenMatches = (wrapper.$field("token").read() as NativePointer).equals(tokenBuf.readPointer());
      },
    });
    makeSwiftNativeFunction(addr, Wrapper, [Token])(tokenBuf);
    listener.detach();
    expect(isValue).toBe(true);
    expect(a).toEqual(int64(1));
    expect(tokenMatches).toBe(true);
  });

  test("hands back a struct holding a class existential as a live value facade", () => {
    const module = loadFixture();
    const link = Swift.function(module, MAKE_LINK).call("frida.re") as SwiftObject;
    let address: SwiftValue = null;
    const listener = Swift.Interceptor.attach(module.getExportByName(LINK_ADDRESS), {
      onEnter(args) {
        address = isSwiftObject(args[0]) ? args[0].address : null;
      },
    });
    try {
      expect(Swift.function(module, LINK_ADDRESS).call(link)).toBe("frida.re");
      expect(address).toBe("frida.re");
    } finally {
      listener.detach();
    }
  });
});

describe("Swift.Interceptor.attach on closure-taking methods", () => {
  test("decodes a closure argument to its function and context; the generic result's metadata follows it", () => {
    loadFixture();
    const ByteSource = metadataFor("fixture.ByteSource")!;
    const source = asSwiftObject(ValueInstance.borrow(ByteSource, Memory.alloc(ByteSource.valueWitnesses.stride)));
    const produce = source.$method("produce", { typeArguments: [Swift.type("Swift.Int")!], self: "borrowing" });
    let seen: { args: CallResult[]; count: unknown; typeArguments: string[] } | null = null;
    let left: CallResult = null;
    const listener = Swift.Interceptor.attach(produce.address, {
      onEnter(args) {
        seen = { args, count: ((this.self as SwiftObject).$fields as { count: unknown }).count, typeArguments: this.typeArguments! };
      },
      onLeave(retval) {
        left = retval;
      },
    });
    try {
      expect(produce.call(3, Swift.closure((n) => Number(n) * 6))).toEqual(int64(18));
    } finally {
      listener.detach();
    }
    const [n, closure] = seen!.args as [SwiftValue, { function: NativePointer; context: NativePointer }];
    expect(n).toEqual(int64(3));
    expect(closure.function.isNull()).toBe(false);
    expect(closure.context.isNull()).toBe(false);
    expect(seen!.count).toEqual(int64(0));
    expect(seen!.typeArguments).toEqual(["Swift.Int"]);
    expect(left).toEqual(int64(18));
  });
});

describe("Swift.Interceptor.attach on members of generic types", () => {
  function hookDuringDrive(symbol: string): { args: CallResult[]; ret: CallResult }[] {
    const calls: { args: CallResult[]; ret: CallResult }[] = [];
    let args: CallResult[] = [];
    const listener = Swift.Interceptor.attach(fixtureExport(symbol), {
      onEnter(a) {
        args = fieldsOf(a) as CallResult[];
      },
      onLeave(ret) {
        calls.push({ args, ret: fieldsOf(ret)! });
      },
    });
    makeSwiftNativeFunction(fixtureExport("fixture.driveKeyed"), metadataFor("Swift.Int")!, [])();
    listener.detach();
    return calls;
  }

  test("a static member of a generic struct receives the type's arguments explicitly", () => {
    expect(hookDuringDrive("static fixture.Keyed.echo(")).toEqual([{ args: ["a"], ret: "a" }]);
  });

  test("a generic static member of a generic struct receives the type's arguments before its own", () => {
    expect(hookDuringDrive("static fixture.Keyed.first<")).toEqual([{ args: [int64(7), "b"], ret: int64(7) }]);
  });

  test("an initializer of a generic struct has no self to carry the type's arguments", () => {
    expect(hookDuringDrive("fixture.Keyed.init(")).toEqual([{ args: ["c"], ret: { value: "c" } }]);
  });

  test("a method of an address-only generic struct recovers the type's arguments from its Self metadata", () => {
    expect(hookDuringDrive("fixture.Keyed.get(")).toEqual([{ args: [], ret: "c" }]);
    expect(hookDuringDrive("fixture.Keyed.paired<")).toEqual([{ args: [int64(8)], ret: "c" }]);
  });

  test("a generic class recovers the type's arguments from its isa or metatype", () => {
    expect(hookDuringDrive("fixture.KeyedHolder.paired<")).toEqual([{ args: [int64(9)], ret: int64(9) }]);
    const [make] = hookDuringDrive("fixture.KeyedHolder.make(");
    expect(make.args).toEqual(["e"]);
  });

  test("a class argument carries its type arguments, so they are not passed", () => {
    const [call] = hookDuringDrive("fixture.cellPaired<");
    expect(call.args[1]).toEqual(int64(10));
    expect(call.ret).toEqual(int64(10));
  });

  test("a borrowing method of a fixed-layout generic value reads self from the registers and the type's arguments after it", () => {
    loadFixture();
    const value = Swift.struct("fixture.PhantomScaled<Swift.Int>")!.$new({ raw: 10 });
    const scaled = value.$method("scaled");
    let seen: { args: CallResult[]; self: CallResult; typeArguments: string[] } | null = null;
    let left: CallResult = null;
    const listener = Swift.Interceptor.attach(scaled.address, {
      onEnter(args) {
        seen = { args, self: fieldsOf(this.self!)!, typeArguments: this.typeArguments! };
      },
      onLeave(retval) {
        left = retval;
      },
    });
    try {
      expect(scaled.call(3, 7)).toEqual(int64(31));
    } finally {
      listener.detach();
    }
    expect(seen).toEqual({ args: [int64(3), int64(7)], self: { raw: int64(10) }, typeArguments: ["Swift.Int"] });
    expect(left).toEqual(int64(31));
  });

  test("a mutating method of a fixed-layout generic value reads self through swiftself and its Self metadata", () => {
    loadFixture();
    const value = Swift.struct("fixture.PhantomScaled<Swift.Int>")!.$new({ raw: 10 });
    const bump = value.$method("bump");
    const seen: CallResult[] = [];
    const listener = Swift.Interceptor.attach(bump.address, {
      onEnter() {
        seen.push(fieldsOf(this.self!)!, this.typeArguments!);
      },
      onLeave() {
        seen.push(fieldsOf(this.self!)!);
      },
    });
    try {
      bump.call(3);
    } finally {
      listener.detach();
    }
    expect(seen).toEqual([{ raw: int64(10) }, ["Swift.Int"], { raw: int64(13) }]);
    expect(value.$fields).toEqual({ raw: int64(13) });
  });

  function typeArgumentsDuringDrive(symbol: string, callbacks: "onEnter" | "onLeave"): (string[] | undefined)[] {
    const seen: (string[] | undefined)[] = [];
    const record = function (this: SwiftInvocationContext): void {
      seen.push(this.typeArguments);
    };
    const listener = Swift.Interceptor.attach(fixtureExport(symbol), { [callbacks]: record });
    makeSwiftNativeFunction(fixtureExport("fixture.driveKeyed"), metadataFor("Swift.Int")!, [])();
    listener.detach();
    return seen;
  }

  test("this.typeArguments lists the type's arguments, then the method's own", () => {
    expect(typeArgumentsDuringDrive("static fixture.Keyed.first<", "onEnter")).toEqual([["Swift.String", "Swift.Int"]]);
    expect(typeArgumentsDuringDrive("fixture.Keyed.paired<", "onEnter")).toEqual([["Swift.String", "Swift.Int"]]);
    expect(typeArgumentsDuringDrive("fixture.KeyedHolder.paired<", "onEnter")).toEqual([["Swift.String", "Swift.Int"]]);
    expect(typeArgumentsDuringDrive("fixture.cellPaired<", "onEnter")).toEqual([["Swift.String", "Swift.Int"]]);
  });

  test("this.typeArguments is captured for a hook with only onLeave", () => {
    expect(typeArgumentsDuringDrive("static fixture.Keyed.echo(", "onLeave")).toEqual([["Swift.String"]]);
  });

  test("this.typeArguments is empty for a non-generic function", () => {
    const seen: (string[] | undefined)[] = [];
    const listener = Swift.Interceptor.attach(fixtureExport("fixture.addInts"), {
      onEnter() {
        seen.push(this.typeArguments);
      },
      onLeave() {
        seen.push(this.typeArguments);
      },
    });
    makeSwiftNativeFunction(fixtureExport("fixture.addInts"), metadataFor("Swift.Int")!, [metadataFor("Swift.Int")!, metadataFor("Swift.Int")!])(intValue(1), intValue(2));
    listener.detach();
    expect(seen).toEqual([[], []]);
  });
});

function hookDuring(
  target: Parameters<typeof Swift.Interceptor.attach>[0],
  call: () => unknown,
  context?: (invocation: SwiftInvocationContext) => void
): { args: CallResult[]; ret: CallResult; called: unknown } {
  let args: CallResult[] = [];
  let ret: CallResult = null;
  const listener = Swift.Interceptor.attach(target, {
    onEnter(a) {
      args = fieldsOf([...a]) as CallResult[];
      context?.(this);
    },
    onLeave(r) {
      ret = fieldsOf(r)!;
    },
  });
  let called: unknown;
  try {
    called = call();
  } finally {
    listener.detach();
  }
  return { args, ret, called };
}

describe("Swift.Interceptor.attach on tuples the signature spells", () => {
  test("reads a concrete tuple argument element by element, nested and wide ones too", () => {
    const module = loadFixture();
    const packedSum = Swift.function(module, "$s7fixture9packedSumySis4Int8V_ADt_tF");
    expect(hookDuring(packedSum, () => packedSum.call([1, 2]))).toEqual({ args: [[1, 2]], ret: int64(12), called: int64(12) });

    const nestedSum = fixtureExport("fixture.nestedSum");
    const nested = metadataOf(Swift.reflect("((Swift.Int8, Swift.Int8), Swift.Int8)")!);
    const triple = Memory.alloc(3).writeS8(1);
    triple.add(1).writeS8(2);
    triple.add(2).writeS8(3);
    const nestedCall = makeSwiftNativeFunction(nestedSum, metadataFor("Swift.Int")!, [nested]);
    expect(hookDuring(nestedSum, () => nestedCall(triple)!.readS64().toNumber())).toEqual({ args: [[[1, 2], 3]], ret: int64(123), called: 123 });

    const wideElementSum = fixtureExport("fixture.wideElementSum");
    const wide = metadataOf(Swift.reflect("(Swift.Int8, fixture.WideScalar)")!);
    const pair = Memory.alloc(wide.typeLayout.stride).writeS8(4);
    [1, 2, 3, 4, 5].forEach((v, i) => pair.add(8 + i * 8).writeS64(v));
    const wideCall = makeSwiftNativeFunction(wideElementSum, metadataFor("Swift.Int")!, [wide]);
    expect(hookDuring(wideElementSum, () => wideCall(pair)!.readS64().toNumber())).toEqual({
      args: [[4, { a: int64(1), b: int64(2), c: int64(3), d: int64(4), e: int64(5) }]],
      ret: int64(9),
      called: 9,
    });
  });

  function box(): SwiftObject {
    return (typeOf(metadataFor("fixture.Box")!) as ClassType).facade.init() as SwiftObject;
  }

  test("a concrete tuple argument keeps the arguments after it in place", () => {
    const packedPlus = box().$method("packedPlus", { typeArguments: [typeOf(metadataFor("Swift.Int")!)] });
    expect(hookDuring(packedPlus, () => packedPlus.call([1, 2], 5))).toEqual({ args: [[1, 2], int64(5)], ret: int64(20), called: int64(20) });
  });

  test("a generic method's tuples with a T element pass and return that element by address", () => {
    const pairFlipped = box().$method("pairFlipped", { typeArguments: [typeOf(metadataFor("Swift.String")!)] });
    expect(hookDuring(pairFlipped, () => pairFlipped.call(["hi", 4]))).toEqual({ args: [["hi", int64(4)]], ret: [int64(4), "hi"], called: [int64(4), "hi"] });
  });

  test("a tuple result of T elements only, or with a direct part too wide for the registers, comes back whole", () => {
    const String_ = typeOf(metadataFor("Swift.String")!);
    const twinned = box().$method("twinned", { typeArguments: [String_] });
    expect(hookDuring(twinned, () => twinned.call("hi"))).toEqual({ args: ["hi"], ret: ["hi", "hi"], called: ["hi", "hi"] });
    const spread = box().$method("spread", { typeArguments: [String_] });
    const spreadOut = ["hi", int64(1), int64(2), int64(3), int64(4), int64(5)];
    expect(hookDuring(spread, () => spread.call("hi", 1))).toEqual({ args: ["hi", int64(1)], ret: spreadOut, called: spreadOut });
  });

  test("an async hook reads tuple arguments per element and a tuple result's T element from its buffer", async () => {
    const module = loadFixture();
    const packedSumAsync = Swift.function(module, "$s7fixture14packedSumAsyncySis4Int8V_ADt_tYaF");
    const pairFlippedAsync = box().$method("pairFlippedAsync", { typeArguments: [typeOf(metadataFor("Swift.String")!)] });
    const seen: { args: CallResult[]; ret?: CallResult }[] = [];
    const completions: (() => void)[] = [];
    const completed = [0, 1].map((i) => new Promise<void>((resolve) => (completions[i] = resolve)));
    const listeners = [packedSumAsync, pairFlippedAsync].map((target, i) =>
      Swift.Interceptor.attachAsync(target, {
        onEnter(args) {
          seen[i] = { args: [...args] };
        },
        onComplete(ret) {
          seen[i].ret = ret;
          completions[i]();
        },
      })
    );
    try {
      expect(await packedSumAsync.call([3, 4])).toEqual(int64(34));
      expect(await pairFlippedAsync.call(["hi", 4])).toEqual([int64(4), "hi"]);
      await Promise.all(completed);
    } finally {
      listeners.forEach((l) => l.detach());
    }
    expect(seen).toEqual([
      { args: [[3, 4]], ret: int64(34) },
      { args: [["hi", int64(4)]], ret: [int64(4), "hi"] },
    ]);
  });
});

describe("Swift.Interceptor.attach on protocol-extension members", () => {
  function intSource(): SwiftObject {
    loadFixture();
    return (Swift.type("fixture.IntSource") as SwiftStruct).$new({ value: 5 }) as SwiftObject;
  }

  test("reads Self from swiftself and its associated types through its conformance", () => {
    const source = intSource();
    let seen: { self: CallResult; typeArguments: string[] } | null = null;
    const record = (invocation: SwiftInvocationContext): void => {
      seen = { self: fieldsOf(invocation.self!)!, typeArguments: invocation.typeArguments! };
    };
    expect(hookDuring(fixtureExport("fixture.ItemSource.echo"), () => source.echo(3), record)).toEqual({ args: [int64(3)], ret: int64(3), called: int64(3) });
    expect(seen).toEqual({ self: { value: int64(5) }, typeArguments: ["fixture.IntSource"] });
    const me = hookDuring(fixtureExport("fixture.ItemSource.me"), () => source.me());
    expect([me.args, me.ret]).toEqual([[], { value: int64(5) }]);
  });

  test("a facade's extension method hooks the implementation, tuples with an associated-type element per element", () => {
    const source = intSource();
    const cases: [string, CallArg[], SwiftValue[], unknown][] = [
      ["flipped", [[9, 4]], [[int64(9), int64(4)]], [int64(4), int64(9)]],
      ["unbracketed", [[1, 6, 2]], [[1, int64(6), 2]], [int64(6), int64(12)]],
      ["twice", [3], [int64(3)], [int64(3), int64(3)]],
      ["bracketed", [6], [int64(6)], [1, int64(6), 2]],
      ["paired", [8], [int64(8)], [int64(8), int64(7)]],
    ];
    for (const [name, callArgs, args, ret] of cases) {
      const method = source.$method(name);
      expect({ name, ...hookDuring(method, () => method.call(...callArgs)) }).toEqual({ name, args, ret, called: ret });
    }
  });

  test("an inout tuple with an associated-type element is the caller's storage", () => {
    const source = intSource();
    const pair = asSwiftObject(ValueInstance.fromJS(metadataOf(Swift.reflect("(Swift.Int, Swift.Int)")!), [1, 2]));
    const refill = source.$method("refill");
    let entered: unknown = null;
    const listener = Swift.Interceptor.attach(refill, {
      onEnter(args) {
        entered = [(args[0] as SwiftObject).$fields, args[1]];
      },
    });
    try {
      refill.call(pair, 9);
    } finally {
      listener.detach();
    }
    expect(entered).toEqual([[int64(1), int64(2)], int64(9)]);
    expect(pair.$fields).toEqual([int64(9), int64(3)]);
  });

  test("an associated type the where clause bounds to a class is passed and returned as a reference", () => {
    loadFixture();
    const nightjar = (Swift.type("fixture.Nightjar") as SwiftClass).init() as SwiftObject;
    const nightjarNest = (Swift.type("fixture.NightjarNest") as SwiftStruct).init(nightjar)! as SwiftObject;
    const rook = (Swift.type("fixture.Rook") as SwiftClass).init() as SwiftObject;
    const rookNest = (Swift.type("fixture.RookNest") as SwiftStruct).init(rook)! as SwiftObject;
    for (const [nest, name, egg] of [[nightjarNest, "objectEcho", nightjar], [nightjarNest, "nocturnalEcho", nightjar], [rookNest, "rookeryEcho", rook]] as const) {
      const method = nest.$method(name);
      const { args, ret } = hookDuring(method, () => method.call(egg));
      expect([name, (args[0] as SwiftObject).$handle.equals(egg.$handle), (ret as SwiftObject).$handle.equals(egg.$handle)]).toEqual([name, true, true]);
    }
  });

  test("a class conforming to a protocol that is not class-bound passes self by address; a class-bound one passes the object", () => {
    loadFixture();
    for (const [type, symbol, method] of [
      ["fixture.SubSpeaker", "fixture.Vocal.speakTwice", "speakTwice"],
      ["fixture.SubSquawker", "fixture.Squawker.squawkTwice", "squawkTwice"],
    ]) {
      const object = (Swift.type(type) as SwiftClass).init() as SwiftObject;
      let self: CallResult = null;
      const { ret } = hookDuring(fixtureExport(symbol), () => object.$call(method), (invocation) => {
        self = invocation.self!;
      });
      expect([method, ret, (self as unknown as SwiftObject).$handle.equals(object.$handle)]).toEqual([method, "subsub", true]);
    }
  });

  test("a getter typed by an associated type a base protocol declares", () => {
    loadFixture();
    const clutch = (Swift.type("fixture.IntClutch") as SwiftStruct).$new({ egg: 5 }) as SwiftObject;
    let self: CallResult = null;
    const { ret } = hookDuring(fixtureExport("fixture.Clutch.firstEgg.getter"), () => clutch.firstEgg, (invocation) => {
      self = fieldsOf(invocation.self!)!;
    });
    expect([ret, self]).toEqual([int64(5), { egg: int64(5) }]);
  });

  test("an async extension method's tuple result with an associated-type element", async (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const source = (Swift.type("fixturesyms.IntSource") as SwiftStruct).$new({ value: 5 }) as SwiftObject;
    const pairedLater = source.$method("pairedLater");
    let seen: { args?: CallResult[]; ret?: CallResult } = {};
    let completed!: () => void;
    const done = new Promise<void>((resolve) => (completed = resolve));
    const listener = Swift.Interceptor.attachAsync(pairedLater, {
      onEnter(args) {
        seen.args = [...args];
      },
      onComplete(ret) {
        seen.ret = ret;
        completed();
      },
    });
    try {
      expect(await pairedLater.call(9)).toEqual([int64(9), int64(7)]);
      await done;
    } finally {
      listener.detach();
    }
    expect(seen).toEqual({ args: [int64(9)], ret: [int64(9), int64(7)] });
  });
});

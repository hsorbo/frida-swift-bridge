import { test, expect, describe } from "@frida/injest/agent";
import { fixtureExport, existentialMetadata, loadFixture, loadFixtureSyms } from "./fixtures/load.js";

import { Swift, type SwiftValue, type SwiftObject, type CallResult } from "../src/index.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";
import { SwiftInterceptor, type SwiftInvocationContext } from "../src/runtime/interceptor.js";
import { requireFpRegisterHooks } from "./swift.js";

import { metadataFor, ClassInstance, ClassMetadata, readVTableChain, asSwiftObject } from "../src/abi.js";

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

describe("SwiftInterceptor.attach", () => {
  test("decodes scalar arguments and the scalar return", () => {
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.addInts");
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
      },
    });
    makeSwiftNativeFunction(addr, Int, [Int, Int])(intValue(20), intValue(22));
    listener.detach();
    expect(seenArgs).toEqual([int64(20), int64(22)]);
    expect(seenRet).toEqual(int64(42));
  });

  test("attaches to a function only the symbol table names", () => {
    const hidden = loadFixtureSyms()
      .enumerateSymbols()
      .find((s) => Swift.demangle(s.name)?.startsWith("fixturesyms.Dispatcher.hidden(") ?? false)!;
    const Int = metadataFor("Swift.Int")!;
    const Dispatcher = metadataFor("fixturesyms.Dispatcher")!;
    const slot = readVTableChain(new ClassMetadata(Dispatcher.handle)).find((e) => e.declaredImpl.equals(hidden.address))!;
    const obj = Swift.type("fixturesyms.Dispatcher")!.init() as SwiftObject;
    const dispatcher = new ClassInstance(obj.$handle);
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(hidden.address, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
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
    let seen: SwiftValue[] | null = null;
    const listener = SwiftInterceptor.attach(addr, {
      onEnter(args) {
        seen = args;
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
    let seen: SwiftValue[] | null = null;
    const listener = SwiftInterceptor.attach(addr, {
      onEnter(args) {
        seen = args;
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
    const listener = SwiftInterceptor.attach(addr, {
      onLeave(ret) {
        seen = ret;
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
    const listener = SwiftInterceptor.attach(addr, {
      onLeave(ret) {
        seen = ret;
      },
    });
    makeSwiftNativeFunction(addr, Loadable, [])();
    listener.detach();
    expect(seen).toEqual({ a: int64(1), b: int64(2), c: int64(3), d: int64(4) });
  });

  test("decodes a concrete Optional argument and return", () => {
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.unwrapOrZero");
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
      },
    });
    makeSwiftNativeFunction(fixtureExport("fixture.makeUnwrapOrZero"), Int, [])();
    listener.detach();
    expect(seenArgs).toEqual([{ some: int64(5) }]);
    expect(seenRet).toEqual({ some: int64(5) });
  });

  test("hooks a function taking and returning a concrete Array", () => {
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.sumIntArray");
    let seenArgs: SwiftValue[][] | null = null;
    let seenRet: SwiftValue[] | null = null;
    const listener = SwiftInterceptor.attach(addr, {
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
    let setterArgs: SwiftValue[] | null = null;
    let getterRet: CallResult = null;
    const setter = SwiftInterceptor.attach(fixtureExport("fixture.IntSource.maybe.setter"), {
      onEnter(args) {
        setterArgs = args;
      },
    });
    const getter = SwiftInterceptor.attach(fixtureExport("fixture.IntSource.maybe.getter"), {
      onLeave(ret) {
        getterRet = ret;
      },
    });
    makeSwiftNativeFunction(fixtureExport("fixture.roundTripIntSourceMaybe"), Int, [])();
    setter.detach();
    getter.detach();
    expect(setterArgs).toEqual([{ some: int64(7) }]);
    expect(getterRet).toEqual({ some: int64(7) });
  });

  test("recovers a generic scalar argument and return from the implicit metadata", () => {
    const Int = metadataFor("Swift.Int")!;
    const identity = fixtureExport("fixture.genericIdentity");
    const driver = fixtureExport("fixture.makeGenericInt");
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(identity, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
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
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(identity, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
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
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(first, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
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
    const listener = SwiftInterceptor.attach(doubled, {
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
    const listener = SwiftInterceptor.attach(identity, {
      onEnter(args) {
        cell = args[0] as NativePointer;
        seenValue = asSwiftObject(new ClassInstance(cell)).$field("value").read();
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
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(identity, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
      },
    });
    makeSwiftNativeFunction(driver, Int, [])();
    listener.detach();
    expect(seenArgs).toEqual(["Swift.Int", int64(5)]);
    expect(seenRet).toEqual(int64(5));
  });

  test("decodes a constrained generic arg, ignoring the trailing witness table", () => {
    const scaleGeneric = fixtureExport("fixture.scaleGeneric");
    const driver = fixtureExport("fixture.makeScaleGeneric");
    const Int = metadataFor("Swift.Int")!;
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(scaleGeneric, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
      },
    });
    makeSwiftNativeFunction(driver, Int, [])();
    listener.detach();
    expect(seenArgs).toEqual([int64(6), int64(7)]);
    expect(seenRet).toEqual(int64(42));
  });

  test("decodes a Double argument and return from the FP registers", (ctx) => {
    requireFpRegisterHooks(ctx);
    const Double_ = metadataFor("Swift.Double")!;
    const addr = fixtureExport("fixture.scaleDouble");
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
      },
    });
    const arg = Memory.alloc(8);
    arg.writeDouble(21);
    makeSwiftNativeFunction(addr, Double_, [Double_])(arg);
    listener.detach();
    expect(seenArgs).toEqual([21]);
    expect(seenRet).toBe(42);
  });

  test("decodes a mixed Double/Int struct from the FP and GP registers", (ctx) => {
    requireFpRegisterHooks(ctx);
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.scaleMixedPair(");
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
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
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
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

  test("reads FP arguments spilled past the registers from the caller's stack", (ctx) => {
    requireFpRegisterHooks(ctx);
    const Double_ = metadataFor("Swift.Double")!;
    const addr = fixtureExport("fixture.spillDoubles");
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
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
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
      },
    });
    makeSwiftNativeFunction(fixtureExport("fixture.driveSpillInt128("), Int, [])();
    listener.detach();
    expect(seenArgs).toEqual([
      { head: int64(1), wide: { _value: null } },
      int64(4), int64(5), int64(6), int64(7),
      { _value: null },
      true,
      { _value: null },
      int64(12),
    ]);
    expect(seenRet).toEqual(int64(40));
  });

  test("decodes a single-case enum argument as its payload", (ctx) => {
    requireFpRegisterHooks(ctx);
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.spillWrapped(");
    let seenArgs: SwiftValue[] | null = null;
    const listener = SwiftInterceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args;
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
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
      },
    });
    const driven = makeSwiftNativeFunction(fixtureExport("fixture.driveFlipFramedInt128("), Int, [])()!;
    listener.detach();
    expect(driven.readS64().toNumber()).toBe(441);
    expect(seenArgs).toEqual([{ head: int64(1), wide: { _value: null }, tail: int64(4) }]);
    expect(seenRet).toEqual({ head: int64(4), wide: { _value: null }, tail: int64(1) });
  });

  test("surfaces a thrown error on leave instead of decoding a bogus return", () => {
    const Int = metadataFor("Swift.Int")!;
    const addr = fixtureExport("fixture.mightThrow");
    const seen: { retval: CallResult; error?: SwiftValue }[] = [];
    const listener = SwiftInterceptor.attach(addr, {
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

  test("decodes a named-protocol existential argument, projecting the dynamic value", () => {
    const String_ = metadataFor("Swift.String")!;
    const Greeter = existentialMetadata("fixture.greeterType");
    const g = makeSwiftNativeFunction(fixtureExport("fixture.makeGreeterExistential"), Greeter, [])()!;
    const addr = fixtureExport("fixture.greetExistential");
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
      },
    });
    makeSwiftNativeFunction(addr, String_, [Greeter])(g);
    listener.detach();
    expect(seenArgs).toEqual([{ name: "Ada" }]);
    expect(seenRet).toBe("Hello, Ada");
  });

  test("decodes a protocol-composition existential argument, projecting the dynamic value", () => {
    const String_ = metadataFor("Swift.String")!;
    const GreeterAged = existentialMetadata("fixture.greeterAgedType");
    const v = makeSwiftNativeFunction(fixtureExport("fixture.makeGreeterAged"), GreeterAged, [])()!;
    const addr = fixtureExport("fixture.describeGreeterAged");
    let seenArgs: SwiftValue[] | null = null;
    let seenRet: CallResult = null;
    const listener = SwiftInterceptor.attach(addr, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
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
    const listener = SwiftInterceptor.attach(addr, {
      onLeave(ret) {
        seen = ret;
      },
    });
    makeSwiftNativeFunction(addr, Counter, [Int])(intValue(7));
    listener.detach();
    const counter = seen as unknown as SwiftObject;
    expect(counter.$className).toBe("fixture.Counter");
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
    const listener = SwiftInterceptor.attach(addr, {
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
    const listener = SwiftInterceptor.attach(module.getExportByName(LINK_ADDRESS), {
      onEnter(args) {
        address = (args[0] as SwiftObject).address;
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

describe("SwiftInterceptor.attach on members of generic types", () => {
  function hookDuringDrive(symbol: string): { args: SwiftValue[]; ret: CallResult }[] {
    const calls: { args: SwiftValue[]; ret: CallResult }[] = [];
    let args: SwiftValue[] = [];
    const listener = SwiftInterceptor.attach(fixtureExport(symbol), {
      onEnter(a) {
        args = a;
      },
      onLeave(ret) {
        calls.push({ args, ret });
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

  test("a borrowing method of a fixed-layout generic value hides its type arguments behind self", () => {
    const scaled = fixtureExport("fixture.PhantomScaled.scaled(");
    expect(() => SwiftInterceptor.attach(scaled, { onEnter() {} })).toThrow(/fixed-layout generic value passes self by value/);
    SwiftInterceptor.attach(scaled, { onLeave() {} }).detach();
  });

  function typeArgumentsDuringDrive(symbol: string, callbacks: "onEnter" | "onLeave"): (string[] | undefined)[] {
    const seen: (string[] | undefined)[] = [];
    const record = function (this: SwiftInvocationContext): void {
      seen.push(this.typeArguments);
    };
    const listener = SwiftInterceptor.attach(fixtureExport(symbol), { [callbacks]: record });
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
    const listener = SwiftInterceptor.attach(fixtureExport("fixture.addInts"), {
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

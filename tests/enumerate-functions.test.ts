import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms, FIXTURE_MODULE } from "./fixtures/load.js";
import { requireSymbolTable } from "./swift.js";

import { Protocol, ProtocolRequirementKind } from "../src/abi.js";
import { Swift, SwiftFunctionMatch, SwiftFunctionSlot } from "../src/index.js";

function slotsOf(filter: Module | string): SwiftFunctionSlot[] {
  return [...Swift.enumerateFunctions(filter, { slots: true })].filter((m): m is SwiftFunctionSlot => m.signature === null);
}

function facadeSlotAddress(typeName: string, selector: string): NativePointer {
  const type = Swift.type(typeName)!.$type;
  return (type.instanceMethods().includes(selector) ? type.instanceMethod(selector) : type.typeMethod(selector)).address;
}

describe("Swift.enumerateFunctions", () => {
  let module: Module;
  beforeEach(() => {
    module = loadFixture();
  });

  test("lists a module's functions and accessors with their kind, and drops what is not a function", () => {
    const matches = [...Swift.enumerateFunctions(module)];
    expect(matches.length).toBeGreaterThan(100);
    expect(matches.every((m) => m.module === FIXTURE_MODULE)).toBe(true);
    expect(matches.some((m) => m.name.startsWith("type metadata accessor") || m.name.endsWith("deinit"))).toBe(false);

    const addInts = matches.find((m) => m.name.startsWith("fixture.addInts("))!;
    expect(addInts.kind).toBe("function");
    expect(addInts.address.equals(module.getExportByName("$s7fixture7addIntsyS2i_SitF"))).toBe(true);
    expect(addInts.signature!.argTypeNames).toEqual(["Swift.Int", "Swift.Int"]);
    expect(addInts.signature!.returnTypeName).toBe("Swift.Int");

    const level = matches.find((m) => m.name === "fixture.Gauge.level.getter : Swift.Int")!;
    expect(level.kind).toBe("getter");
    expect(level.signature.argTypeNames).toEqual([]);
    expect(level.signature.returnTypeName).toBe("Swift.Int");
    const setLevel = matches.find((m) => m.name === "fixture.Gauge.level.setter : Swift.Int")!;
    expect(setLevel.signature.argTypeNames).toEqual(["Swift.Int"]);
    expect(setLevel.signature.returnTypeName).toBeNull();
  });

  test("a glob over the demangled name spans every module", () => {
    const matches = [...Swift.enumerateFunctions("fixture.Robot.greet(*")];
    expect(matches.map((m) => m.name)).toEqual(["fixture.Robot.greet(Swift.String) -> Swift.String"]);
  });

  test("a match hooks directly", () => {
    const [addInts] = Swift.enumerateFunctions("fixture.addInts(*") as Iterable<SwiftFunctionMatch>;
    let seen: unknown;
    const listener = Swift.Interceptor.attach(addInts, {
      onEnter(args) {
        seen = args;
      },
    });
    try {
      expect(Swift.function(module, "$s7fixture7addIntsyS2i_SitF").call(20, 22)).toEqual(int64(42));
      expect(seen).toEqual([int64(20), int64(22)]);
    } finally {
      listener.detach();
    }
  });

  test("an unstripped module lists its internal functions once and private declarations by their plain name", (ctx) => {
    requireSymbolTable(ctx);
    const matches = [...Swift.enumerateFunctions(loadFixtureSyms())];
    expect(matches.filter((m) => m.name === "fixturesyms.Dispatcher.hidden(Swift.Int) -> Swift.Int")).toHaveLength(1);
    const init = matches.find((m) => m.name === "fixturesyms.CodableCard.Hidden.init(n: Swift.Int) -> fixturesyms.CodableCard.Hidden")!;
    expect(init.signature.returnTypeName).toBe("fixturesyms.CodableCard.Hidden");
    expect(matches.some((m) => m.name === "fixturesyms.CodableCard.Hidden.doubled.getter : Swift.Int")).toBe(true);
  });
});

describe("Swift.enumerateFunctions with slots", () => {
  let module: Module;
  beforeEach(() => {
    module = loadFixture();
  });

  test("the default listing has no slots", () => {
    expect([...Swift.enumerateFunctions(module)].some((m) => m.signature === null || m.name.includes("#"))).toBe(false);
  });

  test("a stripped class's unnamed vtable methods are listed at the facade's slots, and a named one is not", () => {
    const slots = slotsOf(module).filter((m) => m.name.startsWith("fixture.SlotHost.vtable#"));
    const selectors = [...Swift.class("fixture.SlotHost")!.$type.instanceMethods(), ...Swift.class("fixture.SlotHost")!.$type.typeMethods()].filter((s) => s.startsWith("vtable#"));
    expect(slots.map((m) => m.name.substring("fixture.SlotHost.".length)).filter((s) => selectors.includes(s)).sort()).toEqual([...selectors].sort());
    for (const m of slots.filter((m) => selectors.some((s) => m.name.endsWith(`.${s}`)))) {
      expect(m.address.equals(facadeSlotAddress("fixture.SlotHost", m.name.substring("fixture.SlotHost.".length)))).toBe(true);
      expect(m.module).toBe(FIXTURE_MODULE);
      expect(m.kind).toBe("function");
    }
    const pub = Swift.class("fixture.Dispatcher")!.$type.instanceMethod("pub(_:)").address;
    expect(slotsOf(module).some((m) => m.address.equals(pub))).toBe(false);
  });

  test("an override is listed at the overridden method's slot with the subclass's implementation", () => {
    const [override] = slotsOf(module).filter((m) => m.name.startsWith("fixture.SlotSubHost.vtable#"));
    const selector = override.name.substring("fixture.SlotSubHost.".length);
    expect(override.address.equals(facadeSlotAddress("fixture.SlotSubHost", selector))).toBe(true);
    expect(override.address.equals(facadeSlotAddress("fixture.SlotHost", selector))).toBe(false);
  });

  test("a witness no symbol names is listed by type, protocol and index", () => {
    const requirement = Protocol.find("fixture.Vocal")!.requirementRecords.find((r) => r.kind === ProtocolRequirementKind.Method)!;
    const selector = `fixture.Vocal#${requirement.witnessIndex}`;
    const [witness] = slotsOf(module).filter((m) => m.name === `fixture.BaseSpeaker.${selector}`);
    expect(witness.address.equals(facadeSlotAddress("fixture.BaseSpeaker", selector))).toBe(true);
    expect(witness.kind).toBe("function");
  });

  test("a witness slot names its requirement from the protocol's method descriptor export, a vtable slot none", () => {
    const equals = Protocol.find("Swift.Equatable")!.requirementRecords.find((r) => r.kind === ProtocolRequirementKind.Method)!;
    const [witness] = slotsOf("fixture.GridPoint.*").filter((m) => m.name === `fixture.GridPoint.Swift.Equatable#${equals.witnessIndex}`);
    const stdlibExports = Process.platform !== "windows"; // the Windows stdlib exports no protocol method descriptors
    expect(witness.requirement).toBe(stdlibExports ? "Swift.Equatable.==(_:_:)" : null);
    const [description] = slotsOf("fixture.Trio.Swift.CustomStringConvertible#*");
    expect(description.kind).toBe("getter");
    expect(description.requirement).toBe(stdlibExports ? "Swift.CustomStringConvertible.description" : null);
    const [speak] = slotsOf(module).filter((m) => m.name.startsWith("fixture.BaseSpeaker.fixture.Vocal#"));
    expect(speak.requirement).toBeNull(); // only a library-evolution build exports a protocol's method descriptors
    const [override] = slotsOf(module).filter((m) => m.name.startsWith("fixture.SlotSubHost.vtable#"));
    expect(override.requirement).toBeNull();
  });

  test("a glob scopes slots by name across modules, leaving out a slot the listing names", () => {
    const slots = slotsOf("fixture.SlotSubHost.*");
    expect(slots).toHaveLength(1);
    expect(slots[0].module).toBe(FIXTURE_MODULE);
    expect(slotsOf("fixture.SlotSubHost.vtable#*").length).toBeGreaterThan(1);
  });
});

describe("Swift.findFunctionByAddress", () => {
  let module: Module;
  beforeEach(() => {
    module = loadFixture();
  });

  test("names the exported function an interior address lies in", (ctx) => {
    requireUnwindRanges(ctx);
    const [addInts] = Swift.enumerateFunctions("fixture.addInts(*") as Iterable<SwiftFunctionMatch>;
    const found = Swift.findFunctionByAddress(addInts.address.add(4))!;
    expect(found.name).toBe(addInts.name);
    expect(found.address.equals(addInts.address)).toBe(true);
    expect(found.signature).not.toBeNull();
  });

  test("names an unnamed slot's function by the slot", (ctx) => {
    requireUnwindRanges(ctx);
    const [override] = slotsOf(module).filter((m) => m.name.startsWith("fixture.SlotSubHost.vtable#"));
    const found = Swift.findFunctionByAddress(override.address.add(4))!;
    expect(found.name).toBe(override.name);
    expect(found.address.equals(override.address)).toBe(true);
    expect(found.signature).toBeNull();
    const [witness] = slotsOf("fixture.GridPoint.Swift.Equatable#*");
    expect((Swift.findFunctionByAddress(witness.address.add(4)) as SwiftFunctionSlot).requirement).toBe("Swift.Equatable.==(_:_:)");
  });

  test("is null outside any function", (ctx) => {
    requireUnwindRanges(ctx);
    expect(Swift.findFunctionByAddress(ptr(8))).toBeNull();
  });

  test("is refused on Windows", (ctx) => {
    if (Process.platform !== "windows") {
      ctx.skip("only Windows refuses");
    }
    expect(() => Swift.findFunctionByAddress(module.base)).toThrow(/not supported on Windows/);
  });
});

function requireUnwindRanges(ctx: { skip: (reason?: string) => void }): void {
  if (Process.platform === "windows") {
    ctx.skip("a leaf thunk has no unwind entry on PE");
  }
}

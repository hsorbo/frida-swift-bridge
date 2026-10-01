import { test, expect, describe } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms } from "./fixtures/load.js";
import { requireDarwin } from "./swift.js";

import { Swift } from "../src/index.js";
import {
  parseSwiftSignature,
  parseTypeExpr,
  symbolicate,
  resolveFunctionSignature,
  resolveType,
  resolveTypeExpr,
  type SwiftFunctionSignature,
  type SwiftAccessorSignature,
} from "../src/runtime/symbolication.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";

import { typeName, MetadataKind, enumerateTupleElements } from "../src/abi.js";
function fixtureSymbol(swiftName: string): { address: NativePointer; demangled: string } {
  const mod = loadFixture();
  for (const e of mod.enumerateExports()) {
    const demangled = Swift.demangle(e.name);
    if (demangled !== null && demangled.includes(swiftName)) {
      return { address: e.address, demangled };
    }
  }
  throw new Error(`fixture export not found: ${swiftName}`);
}

describe("parseSwiftSignature", () => {
  test("parses a free function with positional args", () => {
    const s = parseSwiftSignature("fixture.addInts(Swift.Int, Swift.Int) -> Swift.Int") as SwiftFunctionSignature;
    expect(s.kind).toBe("function");
    expect(s.context).toBe("fixture");
    expect(s.name).toBe("addInts");
    expect(s.throws).toBe(false);
    expect(s.argTypeNames).toEqual(["Swift.Int", "Swift.Int"]);
    expect(s.returnTypeName).toBe("Swift.Int");
  });

  test("drops a cross-module extension prefix and parses the member", () => {
    const s = parseSwiftSignature(
      "(extension in Foundation):__C.NSURLSession.data(from: Foundation.URL) async throws -> Foundation.Data"
    ) as SwiftFunctionSignature;
    expect(s.kind).toBe("function");
    expect(s.context).toBe("__C.NSURLSession");
    expect(s.name).toBe("data");
    expect(s.async).toBe(true);
    expect(s.argLabels).toEqual(["from"]);
  });

  test("parses a method with labeled args and a nominal return type", () => {
    const s = parseSwiftSignature(
      "fixture.Point.translated(dx: Swift.Int, dy: Swift.Int) -> fixture.Point"
    ) as SwiftFunctionSignature;
    expect(s.context).toBe("fixture.Point");
    expect(s.name).toBe("translated");
    expect(s.argTypeNames).toEqual(["Swift.Int", "Swift.Int"]);
    expect(s.returnTypeName).toBe("fixture.Point");
  });

  test("flags a throwing function", () => {
    const s = parseSwiftSignature("fixture.mightThrow(Swift.Int) throws -> Swift.Int") as SwiftFunctionSignature;
    expect(s.throws).toBe(true);
    expect(s.argTypeNames).toEqual(["Swift.Int"]);
    expect(s.returnTypeName).toBe("Swift.Int");
  });

  test("treats an empty arg list and a () return as no args / void", () => {
    const s = parseSwiftSignature("fixture.noArgs() -> ()") as SwiftFunctionSignature;
    expect(s.argTypeNames).toEqual([]);
    expect(s.returnTypeName).toBeNull();
  });

  test("does not split commas nested in generics or tuples", () => {
    const s = parseSwiftSignature(
      "m.f(Swift.Dictionary<Swift.Int, Swift.String>, (Swift.Int, Swift.Int)) -> Swift.Bool"
    ) as SwiftFunctionSignature;
    expect(s.argTypeNames).toEqual([
      "Swift.Dictionary<Swift.Int, Swift.String>",
      "(Swift.Int, Swift.Int)",
    ]);
  });

  test("splits the generic parameter clause off the function name", () => {
    const s = parseSwiftSignature("fixture.genericFirst<A, B>(A, B) -> A") as SwiftFunctionSignature;
    expect(s.name).toBe("genericFirst");
    expect(s.genericParams).toEqual(["A", "B"]);
    expect(s.argTypeNames).toEqual(["A", "B"]);
    expect(s.returnTypeName).toBe("A");
  });

  test("leaves a non-generic function with no generic params", () => {
    const s = parseSwiftSignature("fixture.addInts(Swift.Int, Swift.Int) -> Swift.Int") as SwiftFunctionSignature;
    expect(s.genericParams).toEqual([]);
    expect(s.simpleGenerics).toBe(true);
  });

  test("keeps a constrained generic simple and captures its where-clause requirement", () => {
    const s = parseSwiftSignature(
      "fixture.scaleGeneric<A where A: fixture.Scalable>(_: A, by: Swift.Int) -> Swift.Int"
    ) as SwiftFunctionSignature;
    expect(s.name).toBe("scaleGeneric");
    expect(s.genericParams).toEqual(["A"]);
    expect(s.simpleGenerics).toBe(true);
    expect(s.argTypeNames).toEqual(["A", "Swift.Int"]);
    expect(s.conformanceRequirements).toEqual([{ subject: "A", protocol: "fixture.Scalable" }]);
  });

  test("flags a same-type constraint as not simple", () => {
    const s = parseSwiftSignature("m.f<A, B where A == B>(A, B) -> A") as SwiftFunctionSignature;
    expect(s.genericParams).toEqual(["A", "B"]);
    expect(s.simpleGenerics).toBe(false);
  });

  test("flags a parameter pack as not simple", () => {
    const s = parseSwiftSignature("m.f<each A>(repeat each A) -> ()") as SwiftFunctionSignature;
    expect(s.simpleGenerics).toBe(false);
  });

  test("keeps a function-typed (closure) parameter intact past its arrow", () => {
    const s = parseSwiftSignature(
      "fixture.ByteSource.withBytes<A>(_: (Swift.UnsafeRawBufferPointer) throws -> A) rethrows -> A"
    ) as SwiftFunctionSignature;
    expect(s.name).toBe("withBytes");
    expect(s.genericParams).toEqual(["A"]);
    expect(s.argTypeNames).toEqual(["(Swift.UnsafeRawBufferPointer) throws -> A"]);
    expect(s.returnTypeName).toBe("A");
  });

  test("treats rethrows as throwing", () => {
    const s = parseSwiftSignature(
      "fixture.ByteSource.withBytes<A>(_: (Swift.UnsafeRawBufferPointer) throws -> A) rethrows -> A"
    ) as SwiftFunctionSignature;
    expect(s.throws).toBe(true);
  });

  test("parses a property accessor", () => {
    const s = parseSwiftSignature("fixture.Point.doubled.getter : Swift.Int") as SwiftAccessorSignature;
    expect(s.kind).toBe("getter");
    expect(s.context).toBe("fixture.Point");
    expect(s.member).toBe("doubled");
    expect(s.typeName).toBe("Swift.Int");
  });
});

describe("parseTypeExpr function types", () => {
  test("splits a closure type into params and result", () => {
    const throwing = parseTypeExpr("(Swift.UnsafeRawBufferPointer) throws -> A")!;
    expect(throwing.kind).toBe("function");
    if (throwing.kind !== "function") return;
    expect(throwing.params.map((p) => p.type.text)).toEqual(["Swift.UnsafeRawBufferPointer"]);
    expect(throwing.result.text).toBe("A");
    expect(throwing.throws).toBe(true);
    const plain = parseTypeExpr("(Swift.Int) -> Swift.Bool")!;
    expect(plain.kind === "function" && !plain.throws && plain.result.text === "Swift.Bool").toBe(true);
  });

  test("reads a non-function type as something else", () => {
    expect(parseTypeExpr("Swift.Int")!.kind).toBe("nominal");
    expect(parseTypeExpr("(Swift.Int, Swift.Int)")!.kind).toBe("tuple");
  });
});

describe("symbolicate", () => {
  test("recovers the mangled and demangled name of a function address", () => {
    const { address } = fixtureSymbol("fixture.addInts");
    const sym = symbolicate(address)!;
    expect(sym.name.includes("addInts")).toBe(true);
    expect(sym.demangled.startsWith("fixture.addInts(")).toBe(true);
  });

  test("falls back to the symbol table for a function the module does not export", () => {
    const mod = loadFixtureSyms();
    const hidden = mod.enumerateSymbols().find((s) => Swift.demangle(s.name)?.startsWith("fixturesyms.Dispatcher.hidden(") ?? false)!;
    expect(mod.enumerateExports().some((e) => e.name === hidden.name)).toBe(false);
    const sym = symbolicate(hidden.address)!;
    expect(sym.name).toBe(hidden.name);
    expect(sym.demangled).toBe("fixturesyms.Dispatcher.hidden(Swift.Int) -> Swift.Int");
  });

  test("returns null for an address with no owning module", () => {
    expect(symbolicate(ptr(1))).toBeNull();
  });
});

describe("resolveFunctionSignature", () => {
  test("resolves arg and return type names to metadata", () => {
    const { demangled } = fixtureSymbol("fixture.combine");
    const resolved = resolveFunctionSignature(parseSwiftSignature(demangled) as SwiftFunctionSignature)!;
    expect(resolved.throws).toBe(false);
    expect(typeName(resolved.argTypes[0])).toBe("Swift.Int");
    expect(typeName(resolved.argTypes[1])).toBe("Swift.Double");
    expect(typeName(resolved.returnType!)).toBe("Swift.Double");
  });

  test("drives makeSwiftNativeFunction straight from a symbol", () => {
    const { address, demangled } = fixtureSymbol("fixture.addInts");
    const { argTypes, returnType } = resolveFunctionSignature(
      parseSwiftSignature(demangled) as SwiftFunctionSignature
    )!;
    const add = makeSwiftNativeFunction(address, returnType, argTypes);
    const a = Memory.alloc(8);
    a.writeU64(20);
    const b = Memory.alloc(8);
    b.writeU64(22);
    expect(add(a, b)!.readU64().toNumber()).toBe(42);
  });

  test("resolves a property accessor's member type", () => {
    const { demangled } = fixtureSymbol("fixture.Point.doubled.getter");
    const sig = parseSwiftSignature(demangled) as SwiftAccessorSignature;
    expect(sig.kind).toBe("getter");
    expect(typeName(resolveType(sig.typeName)!)).toBe("Swift.Int");
  });
});

describe("resolveTypeExpr tuples", () => {
  test("builds tuple metadata from a `(A, B)` spelling", () => {
    const tuple = resolveTypeExpr("(Swift.Int, Swift.String)", () => null)!;
    expect(tuple.kind).toBe(MetadataKind.Tuple);
    const elements = [...enumerateTupleElements(tuple)];
    expect(elements.map((e) => typeName(e.type))).toEqual(["Swift.Int", "Swift.String"]);
  });

  test("treats `()` as Void and a parenthesized single type as that type", () => {
    expect(typeName(resolveTypeExpr("()", () => null)!)).toBe("()");
    expect(typeName(resolveTypeExpr("(Swift.Int)", () => null)!)).toBe("Swift.Int");
  });

  test("resolves a nested tuple inside an optional", () => {
    const optional = resolveTypeExpr("(Swift.Int, Swift.Int)?", () => null)!;
    expect(optional.kind).toBe(MetadataKind.Optional);
  });
});

describe("resolveType ObjC classes", () => {
  test("resolves an imported __C class to its metadata", (ctx) => {
    requireDarwin(ctx);
    const metadata = resolveType("__C.NSObject");
    expect(metadata).not.toBeNull();
    expect(
      metadata!.kind === MetadataKind.ObjCClassWrapper || metadata!.kind === MetadataKind.Class
    ).toBeTruthy();
  });

  test("resolves an imported __C protocol to an existential", (ctx) => {
    requireDarwin(ctx);
    if (Process.findModuleByName("Foundation") === null) {
      Module.load("/System/Library/Frameworks/Foundation.framework/Foundation");
    }
    const metadata = resolveType("__C.NSCopying");
    expect(metadata).not.toBeNull();
    expect(metadata!.kind).toBe(MetadataKind.Existential);
  });
});

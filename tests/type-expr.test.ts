import { test, expect, describe } from "@frida/injest/agent";

import { parseTypeExpr, parseSwiftSignature, type SwiftFunctionSignature, type SwiftAccessorSignature } from "../src/runtime/type-expr.js";

function fn(demangled: string): SwiftFunctionSignature {
  const parsed = parseSwiftSignature(demangled);
  if (parsed === null || parsed.kind !== "function") {
    throw new Error(`not a function signature: ${demangled}`);
  }
  return parsed;
}

describe("parseTypeExpr", () => {
  test("reads a nominal type with nested generic arguments", () => {
    const t = parseTypeExpr("Swift.Dictionary<Swift.String, Swift.Array<Swift.Int>>")!;
    expect(t.kind).toBe("nominal");
    if (t.kind !== "nominal") return;
    expect(t.name).toBe("Swift.Dictionary");
    expect(t.args.map((a) => a.text)).toEqual(["Swift.String", "Swift.Array<Swift.Int>"]);
    expect(t.text).toBe("Swift.Dictionary<Swift.String, Swift.Array<Swift.Int>>");
  });

  test("keeps the arguments of each level of a nested generic type", () => {
    const t = parseTypeExpr("Mod.Outer<A>.Inner<B>")!;
    expect(t.kind).toBe("nominal");
    if (t.kind !== "nominal") return;
    expect(t.name).toBe("Mod.Outer.Inner");
    expect(t.args.map((a) => a.text)).toEqual(["A", "B"]);
  });

  test("desugars array and dictionary spellings while keeping the text", () => {
    const array = parseTypeExpr("[Swift.Int]")!;
    expect(array.kind === "nominal" && array.name === "Swift.Array" && array.args[0].text === "Swift.Int").toBe(true);
    expect(array.text).toBe("[Swift.Int]");
    const dict = parseTypeExpr("[Swift.String: A]")!;
    expect(dict.kind === "nominal" && dict.name === "Swift.Dictionary" && dict.args[1].kind === "param").toBe(true);
  });

  test("reads every optional spelling as one kind", () => {
    for (const spelling of ["A?", "Swift.Optional<A>"]) {
      const t = parseTypeExpr(spelling)!;
      expect(t.kind).toBe("optional");
      if (t.kind !== "optional") return;
      expect(t.wrapped.kind).toBe("param");
      expect(t.implicitlyUnwrapped).toBe(false);
      expect(t.text).toBe(spelling);
    }
    const iuo = parseTypeExpr("Swift.Int!")!;
    expect(iuo.kind === "optional" && iuo.implicitlyUnwrapped).toBe(true);
  });

  test("tells a generic parameter and its associated type from a nominal type", () => {
    expect(parseTypeExpr("A")!.kind).toBe("param");
    expect(parseTypeExpr("B1")!.kind).toBe("param");
    const member = parseTypeExpr("A.Element")!;
    expect(member.kind === "member" && member.base.kind === "param" && member.name === "Element").toBe(true);
    expect(parseTypeExpr("Swift.Int")!.kind).toBe("nominal");
  });

  test("reads tuples and metatypes", () => {
    const tuple = parseTypeExpr("(x: Swift.Int, Swift.String)")!;
    expect(tuple.kind).toBe("tuple");
    if (tuple.kind !== "tuple") return;
    expect(tuple.elements.map((e) => e.label)).toEqual(["x", null]);
    expect(parseTypeExpr("()")!.kind).toBe("tuple");
    expect(parseTypeExpr("(Swift.Int)")!.kind).toBe("nominal");
    const meta = parseTypeExpr("Swift.Int.Type")!;
    expect(meta.kind === "metatype" && meta.instance.text === "Swift.Int" && !meta.existential).toBe(true);
    expect(parseTypeExpr("Mod.TypeAlias")!.kind).toBe("nominal");
  });

  test("reads function types with effects, conventions and attributes", () => {
    const t = parseTypeExpr("@Sendable (inout Swift.Int, A) async throws -> Swift.Bool")!;
    expect(t.kind).toBe("function");
    if (t.kind !== "function") return;
    expect(t.attributes).toEqual(["@Sendable"]);
    expect(t.params.map((p) => p.convention)).toEqual(["inout", "borrowed"]);
    expect(t.params.map((p) => p.type.text)).toEqual(["Swift.Int", "A"]);
    expect(t.async && t.throws).toBe(true);
    expect(t.result.text).toBe("Swift.Bool");
    const c = parseTypeExpr("@convention(c) () -> ()")!;
    expect(c.kind === "function" && c.attributes[0] === "@convention(c)").toBe(true);
    const typed = parseTypeExpr("(A) throws(Mod.Failure) -> A")!;
    expect(typed.kind === "function" && typed.throws).toBe(true);
  });

  test("reads existentials, opaque types, variadics and packs", () => {
    const any = parseTypeExpr("any Swift.Hashable & Swift.Sendable")!;
    expect(any.kind === "existential" && any.members.map((m) => m.text).join("|")).toBe("Swift.Hashable|Swift.Sendable");
    expect(parseTypeExpr("Swift.Equatable & Swift.Hashable")!.kind).toBe("existential");
    const some = parseTypeExpr("some Swift.Sequence")!;
    expect(some.kind === "opaque" && some.constraint?.text === "Swift.Sequence").toBe(true);
    const bare = parseTypeExpr("some")!;
    expect(bare.kind === "opaque" && bare.constraint === null).toBe(true);
    const parameterized = parseTypeExpr("any fixture.Holder<Self.fixture.Holder.Item == Swift.Int>")!;
    if (parameterized.kind !== "existential" || parameterized.members[0].kind !== "nominal") throw new Error(parameterized.text);
    const arg = parameterized.members[0].args[0];
    expect(arg.kind === "sameType" && arg.subject.text === "Self.fixture.Holder.Item" && arg.type.text === "Swift.Int").toBe(true);
    const variadic = parseTypeExpr("Swift.Int...")!;
    expect(variadic.kind === "variadic" && variadic.element.text === "Swift.Int").toBe(true);
    expect(parseTypeExpr("repeat each A")!.kind).toBe("pack");
  });

  test("rejects text that is not one type", () => {
    expect(parseTypeExpr("Swift.Int, Swift.Int")).toBeNull();
    expect(parseTypeExpr("Swift.Int.foo(Swift.Int) -> ()")).toBeNull();
  });
});

describe("parseSwiftSignature", () => {
  test("reads operator functions", () => {
    const lt = fn("static Swift.Int.< infix(Swift.Int, Swift.Int) -> Swift.Bool");
    expect(lt.context).toBe("static Swift.Int");
    expect(lt.name).toBe("<");
    expect(lt.selector).toBe("<(_:_:)");
    expect(lt.argTypeNames).toEqual(["Swift.Int", "Swift.Int"]);
    const range = fn("static Swift.Comparable...< infix(A, A) -> Swift.Range<A>");
    expect(range.name).toBe("..<");
    expect(range.returnTypeName).toBe("Swift.Range<A>");
    const neg = fn("static Swift.Int.- prefix(Swift.Int) -> Swift.Int");
    expect(neg.name).toBe("-");
  });

  test("keeps labels, conventions and the typed params side by side", () => {
    const s = fn("fixture.Robot.absorb(_: __owned fixture.Robot, into: inout Swift.Int) -> Swift.String");
    expect(s.argLabels).toEqual([null, "into"]);
    expect(s.argTypeNames).toEqual(["__owned fixture.Robot", "inout Swift.Int"]);
    expect(s.params.map((p) => p.convention)).toEqual(["owned", "inout"]);
    expect(s.params.map((p) => p.type.text)).toEqual(["fixture.Robot", "Swift.Int"]);
    expect(s.result!.text).toBe("Swift.String");
  });

  test("keeps the thrown type of a typed throws", () => {
    const typed = fn("fixture.throwsCoded(Swift.Int) throws(fixture.CodedFailure) -> Swift.Double");
    expect(typed.throws).toBe(true);
    expect(typed.thrownType!.text).toBe("fixture.CodedFailure");
    expect(typed.result!.text).toBe("Swift.Double");
    const asyncTyped = fn("fixture.TypedThrower.scaledAsync(Swift.Int) async throws(fixture.CodedFailure) -> Swift.Int");
    expect(asyncTyped.async && asyncTyped.throws && asyncTyped.thrownType!.text === "fixture.CodedFailure").toBe(true);
    expect(fn("fixture.mightThrow(Swift.Int) throws -> Swift.Int").thrownType).toBe(null);
  });

  test("separates a constrained extension's where clause from its context", () => {
    const s = fn("(extension in Mod):Swift.Sequence< where A: Swift.Equatable, A.Element: Swift.Hashable>.tally(A) -> Swift.Int");
    expect(s.context).toBe("Swift.Sequence");
    expect(s.contextConstraints).toEqual(["A: Swift.Equatable", "A.Element: Swift.Hashable"]);
    expect(s.name).toBe("tally");
    const plain = fn("fixture.Point.translated(dx: Swift.Int) -> fixture.Point");
    expect(plain.contextConstraints).toEqual([]);
  });

  test("a same-type constraint on an associated type keeps the signature simple", () => {
    const onMember = fn("Swift.String.append<A where A: Swift.Sequence, A.Element == Swift.Character>(contentsOf: A) -> ()");
    expect(onMember.simpleGenerics).toBe(true);
    expect(onMember.conformanceRequirements).toEqual([{ subject: "A", protocol: "Swift.Sequence" }]);
    expect(fn("m.f<A, B where A == B>(A, B) -> A").simpleGenerics).toBe(false);
    expect(fn("m.f<A where A == Swift.Int>(A) -> A").simpleGenerics).toBe(false);
  });

  test("keeps a function whose result is a bare opaque type or a parameterized existential", () => {
    expect(fn("fixture.makeOpaqueGreeter() -> some").returnTypeName).toBe("some");
    const holder = fn("fixture.makeHolderInt() -> any fixture.Holder<Self.fixture.Holder.Item == Swift.Int>");
    expect(holder.returnTypeName).toBe("any fixture.Holder<Self.fixture.Holder.Item == Swift.Int>");
    expect(holder.result?.kind).toBe("existential");
  });

  test("returns null for entity lines that are not a function or accessor", () => {
    expect(parseSwiftSignature("dispatch thunk of fixture.Robot.greet(Swift.String) -> Swift.String")).toBeNull();
    expect(parseSwiftSignature("type metadata accessor for fixture.Robot")).toBeNull();
    expect(parseSwiftSignature("closure #1 (Swift.Int) -> Swift.Int in fixture.twice(Swift.Int) -> Swift.Int")).toBeNull();
    expect(parseSwiftSignature("fixture.addInts")).toBeNull();
  });

  test("parses an accessor into a typed member type", () => {
    const s = parseSwiftSignature("static fixture.Point.origin.getter : fixture.Point?") as SwiftAccessorSignature;
    expect(s.kind).toBe("getter");
    expect(s.context).toBe("static fixture.Point");
    expect(s.member).toBe("origin");
    expect(s.typeName).toBe("fixture.Point?");
    expect(s.type.kind).toBe("optional");
  });
});

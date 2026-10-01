import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, ClassType, StructType, SwiftObject, SwiftClass, SwiftStruct } from "../src/index.js";
import {
  resolveMethod,
  enumerateMethods,
  enumerateProperties,
} from "../src/runtime/method.js";
import { parseSwiftSignature, type SwiftFunctionSignature } from "../src/runtime/symbolication.js";

import { ClassInstance, metadataFor, typeOf, typeName } from "../src/abi.js";
function robotType(): SwiftClass {
  return (typeOf(metadataFor("fixture.Robot")!) as ClassType).facade;
}

describe("parser labels", () => {
  test("captures argument labels and a canonical selector", () => {
    const s = parseSwiftSignature(
      "fixture.Robot.rename(to: Swift.String) -> ()"
    ) as SwiftFunctionSignature;
    expect(s.argLabels).toEqual(["to"]);
    expect(s.selector).toBe("rename(to:)");
  });

  test("renders unlabelled args as _ in the selector", () => {
    const s = parseSwiftSignature("fixture.addInts(Swift.Int, Swift.Int) -> Swift.Int") as SwiftFunctionSignature;
    expect(s.argLabels).toEqual([null, null]);
    expect(s.selector).toBe("addInts(_:_:)");
  });

  test("a no-arg function selects to name()", () => {
    const s = parseSwiftSignature("fixture.makeString() -> Swift.String") as SwiftFunctionSignature;
    expect(s.selector).toBe("makeString()");
  });
});

describe("resolveMethod", () => {
  beforeEach(() => { loadFixture(); });

  test("resolves an instance method to address + typed signature", () => {
    const m = resolveMethod("fixture.Robot", "greet", { static: false });
    expect(m.address.isNull()).toBe(false);
    expect(m.isStatic).toBe(false);
    expect(m.selector).toBe("greet(_:)");
    expect(typeName(m.argTypes[0])).toBe("Swift.String");
    expect(typeName(m.returnType!)).toBe("Swift.String");
  });

  test("records a consuming parameter's convention", () => {
    expect(resolveMethod("fixture.Robot", "absorb").argConventions).toEqual(["owned"]);
  });

  test("distinguishes a static method", () => {
    const m = resolveMethod("fixture.Robot", "make", { static: true });
    expect(m.isStatic).toBe(true);
    expect(typeName(m.returnType!)).toBe("fixture.Robot");
  });

  test("throws on an ambiguous overload, resolves by arity", () => {
    expect(() => resolveMethod("fixture.Robot", "at")).toThrow();
    expect(resolveMethod("fixture.Robot", "at", { arity: 1 }).argTypes.length).toBe(1);
    expect(resolveMethod("fixture.Robot", "at", { arity: 2 }).argTypes.length).toBe(2);
  });

  test("disambiguates a same-arity overload by labels", () => {
    expect(() => resolveMethod("fixture.Robot", "move")).toThrow();
    expect(() => resolveMethod("fixture.Robot", "move", { arity: 1 })).toThrow();
    expect(resolveMethod("fixture.Robot", "move", { labels: ["to"] }).selector).toBe("move(to:)");
    expect(resolveMethod("fixture.Robot", "move", { labels: ["by"] }).selector).toBe("move(by:)");
  });

  test("disambiguates a same-arity, same-label overload by argTypes", () => {
    expect(() => resolveMethod("fixture.Robot", "tagged")).toThrow();
    expect(() => resolveMethod("fixture.Robot", "tagged", { labels: [null] })).toThrow();
    const i = resolveMethod("fixture.Robot", "tagged", { argTypes: ["Swift.Int"] });
    expect(typeName(i.argTypes[0])).toBe("Swift.Int");
    const s = resolveMethod("fixture.Robot", "tagged", { argTypes: ["Swift.String"] });
    expect(typeName(s.argTypes[0])).toBe("Swift.String");
  });

  test("disambiguates a return-type-only overload by returnType, null selecting Void", () => {
    const ambiguous = () => resolveMethod("fixture.Robot", "pick");
    expect(ambiguous).toThrow(/pick\(\) \(\) -> Swift\.Int\b/);
    expect(ambiguous).toThrow(/pick\(\) \(\) -> Swift\.String\b/);
    expect(ambiguous).toThrow(/pick\(\) \(\) -> \(\).*\{ returnType \}/);
    expect(typeName(resolveMethod("fixture.Robot", "pick", { returnType: "Swift.Int" }).returnType!)).toBe("Swift.Int");
    expect(typeName(resolveMethod("fixture.Robot", "pick", { returnType: "Swift.String" }).returnType!)).toBe("Swift.String");
    expect(resolveMethod("fixture.Robot", "pick", { returnType: null }).returnType).toBeNull();
  });
});

describe("enumerateMethods", () => {
  beforeEach(() => { loadFixture(); });

  test("lists methods with kind/isStatic/arity", () => {
    const methods = enumerateMethods("fixture.Robot");
    const rename = methods.find((m) => m.selector === "rename(to:)")!;
    expect(rename.isStatic).toBe(false);
    expect(rename.argLabels).toEqual(["to"]);
    expect(rename.returnTypeName).toBeNull();
    expect(methods.some((m) => m.name === "make" && m.isStatic)).toBe(true);
    expect(methods.filter((m) => m.name === "at").length).toBe(2);
  });

  test("strips the operator fixity keyword; a generic return is labeled via genericParams", () => {
    const methods = enumerateMethods("fixture.Selectors");
    const eq = methods.find((m) => m.name === "==")!;
    expect(eq.selector).toBe("==(_:_:)");
    expect(eq.isStatic).toBe(true);
    expect(eq.returnTypeName).toBe("Swift.Bool");
    expect(eq.genericParams).toEqual([]);
    const echo = methods.find((m) => m.name === "echo")!;
    expect(echo.returnTypeName).toBe("A");
    expect(echo.genericParams).toEqual(["A"]);
  });
});

describe("enumerateProperties", () => {
  beforeEach(() => { loadFixture(); });

  test("merges get/set into one writable entry per property", () => {
    const props = enumerateProperties("fixture.Point");
    const doubled = props.find((p) => p.name === "doubled")!;
    expect(doubled.typeName).toBe("Swift.Int");
    expect(doubled.isStatic).toBe(false);
    expect(doubled.writable).toBe(false);
    expect(props.find((p) => p.name === "x")!.writable).toBe(true);
    expect(props.filter((p) => p.name === "x").length).toBe(1);
  });

  test("writable tracks an exported setter, which a modify-backed property still has", () => {
    const props = enumerateProperties("fixture.Point");
    // get + _modify: the compiler synthesizes a setter, so $set can resolve it.
    expect(props.find((p) => p.name === "tracked")!.writable).toBe(true);
    // get only, no modify: no setter to resolve.
    expect(props.find((p) => p.name === "doubled")!.writable).toBe(false);
  });

  test("is exposed on the type wrapper as .properties", () => {
    const point = typeOf(metadataFor("fixture.Point")!) as StructType;
    expect(point.properties.map((p) => p.name).sort()).toEqual(["doubled", "tracked", "x"]);
  });

  test("lists class properties with their types", () => {
    const props = enumerateProperties("fixture.Robot");
    const badge = props.find((p) => p.name === "badge")!;
    expect(badge.typeName).toBe("Swift.String");
    expect(badge.writable).toBe(true);
  });
});

describe("ClassInstance method invocation", () => {
  beforeEach(() => { loadFixture(); });

  test("calls an instance method with a String arg and return", () => {
    const obj = robotType().init("R2");
    expect(obj.$call("greet", "Alice")).toBe("Hello Alice, I am R2");
  });

  test("calls a void method that mutates state", () => {
    const obj = robotType().init("old");
    expect(obj.$field("name").read()).toBe("old");
    obj.$call("rename", "new");
    expect(obj.$field("name").read()).toBe("new");
  });

  test("passes a class-typed argument", () => {
    const a = robotType().init("Ada");
    const b = robotType().init("Bee");
    expect(a.$call("merged", b)).toBe("Ada+Bee");
  });

  test("rejects a class argument whose type is not the declared class", () => {
    const a = robotType().init("Ada");
    const token = (typeOf(metadataFor("fixture.Token")!) as ClassType).facade.init(1);
    expect(() => a.$call("merged", token)).toThrow(/expected fixture\.Robot/);
  });

  test("adopts a class-existential return, keeping the reference alive past the call", () => {
    const named = robotType().init("R2").$call("alias") as SwiftObject;
    expect(named.$kind).toBe("object");
    // Adopted from the container's +1 class ref, not released by the container destroy.
    expect(named.$get("label")).toBe("R2");
    const view = new ClassInstance(named.$handle);
    view.retain();
    const before = view.retainCount;
    named.$dispose();
    expect(view.retainCount).toBe(before - 1);
    view.release();
  });

  test("reuses a resolved method across calls", () => {
    const obj = robotType().init("R2");
    const greet = obj.$method("greet");
    expect(greet.call("X")).toBe("Hello X, I am R2");
    expect(greet.call("Y")).toBe("Hello Y, I am R2");
  });

  test("disambiguates an overload by arity", () => {
    const obj = robotType().init("R2");
    expect(obj.$method("at", { arity: 1 }).call(5)).toEqual(int64(5));
    expect(obj.$method("at", { arity: 2 }).call(5, 6)).toEqual(int64(11));
  });

  test("disambiguates a same-arity overload by labels", () => {
    const obj = robotType().init("R2");
    expect(obj.$method("move", { labels: ["to"] }).call(5)).toEqual(int64(5));
    expect(obj.$method("move", { labels: ["by"] }).call(5)).toEqual(int64(50));
  });

  test("disambiguates a same-arity, same-label overload by argTypes", () => {
    const obj = robotType().init("R2");
    expect(obj.$method("tagged", { argTypes: ["Swift.Int"] }).call(7)).toBe("int:7");
    expect(obj.$method("tagged", { argTypes: ["Swift.String"] }).call("hi")).toBe("str:hi");
  });

  test("disambiguates a return-type-only overload by returnType", () => {
    const obj = robotType().init("R2");
    expect(obj.$method("pick", { returnType: "Swift.Int" }).call()).toEqual(int64(7));
    expect(obj.$method("pick", { returnType: "Swift.String" }).call()).toBe("seven");
    obj.$method("pick", { returnType: null }).call();
    expect(obj.$field("name").read()).toBe("picked");
  });
});

describe("ClassInstance computed property", () => {
  beforeEach(() => { loadFixture(); });

  test("invokes a getter", () => {
    const obj = robotType().init("R2");
    expect(obj.$get("badge")).toBe("[R2]");
  });

  test("invokes a setter, observable via getter and stored field", () => {
    const obj = robotType().init("R2");
    obj.$set("badge", "D2");
    expect(obj.$field("name").read()).toBe("D2");
    expect(obj.$get("badge")).toBe("[D2]");
  });

  test("throws for an unknown property", () => {
    const obj = robotType().init("R2");
    expect(() => obj.$get("nope")).toThrow();
  });

  test("gets and sets a property inherited from a superclass", () => {
    const pup = (typeOf(metadataFor("fixture.Pup")!) as ClassType).facade.init("Rex", 4);
    expect(pup.$get("legs")).toEqual(int64(4));
    pup.$set("legs", 3);
    expect(pup.$get("legs")).toEqual(int64(3));
  });
});

describe("ClassType static invocation", () => {
  beforeEach(() => { loadFixture(); });

  test("calls a static factory and wraps the class return", () => {
    const made = robotType().$call("make", "Forged") as SwiftObject;
    expect(made.$owned).toBe(true);
    expect(made.$field("name").read()).toBe("Forged");
  });

  test("an inherited class func sees the subclass as its dynamic Self", () => {
    expect((typeOf(metadataFor("fixture.RabbitBurrow")!) as ClassType).facade.$call("occupant")).toBe("RabbitBurrow");
  });
});

describe("static properties", () => {
  beforeEach(() => { loadFixture(); });

  test("a value type reads its computed, stored and let static properties", () => {
    const duckling = Swift.type("fixture.Duckling") as SwiftStruct;
    expect(duckling.$get("species")).toBe("duck");
    expect(duckling.$get("flockSize")).toEqual(int64(12));
    expect(duckling.$get("motto")).toBe("quack");
  });

  test("a class reads its static property with the metatype as self", () => {
    expect((Swift.type("fixture.Owlet") as SwiftClass).$get("species")).toBe("owl");
  });

  test("an instance property is not a static one", () => {
    expect(() => (Swift.type("fixture.Duckling") as SwiftStruct).$get("weight")).toThrow(/no static getter for weight/);
  });
});

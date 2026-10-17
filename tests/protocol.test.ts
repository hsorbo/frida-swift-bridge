import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms, fixtureExport, compiledType } from "./fixtures/load.js";
import { requireSymbolTable } from "./swift.js";

import { MetadataKind, ClassType, NominalType, Protocol, ProtocolComposition, ProtocolRequirementKind, WitnessTable, readString, readValue, makeSwiftNativeFunction, metadataFor, typeOf } from "../src/abi.js";

import { Swift } from "../src/index.js";
describe("Protocol", () => {
  beforeEach(() => { loadFixture(); });

  test("resolves a value-witness protocol and reports its shape", () => {
    const greeter = Protocol.find("fixture.Greeter")!;
    expect(greeter).not.toBeNull();
    expect(greeter.name).toBe("Greeter");
    expect(greeter.moduleName).toBe("fixture");
    expect(greeter.fullName).toBe("fixture.Greeter");
    expect(greeter.numRequirements).toBeGreaterThan(0);
    expect(greeter.isClassOnly).toBe(false);
  });

  test("reports an AnyObject protocol as class-only", () => {
    expect(Protocol.find("fixture.Named")!.isClassOnly).toBe(true);
  });

  test("returns null for an unknown protocol", () => {
    expect(Protocol.find("fixture.NoSuchProtocolQX")).toBeNull();
  });

  test("requirements lists Greeter's single method requirement", () => {
    const greeter = Protocol.find("fixture.Greeter")!;
    expect(greeter.requirements.length).toBe(greeter.numRequirements);
    expect(greeter.requirements[0].kind).toBe(ProtocolRequirementKind.Method);
    expect(greeter.requirements[0].isInstance).toBe(true);
  });

  test("conformanceFor yields a witness table for a conformer and null otherwise", () => {
    const scalable = Protocol.find("fixture.Scalable")!;
    const Int = metadataFor("Swift.Int")!;
    const Bool = metadataFor("Swift.Bool")!;
    expect(scalable.conformanceFor(Int) instanceof WitnessTable).toBe(true);
    expect(scalable.conformanceFor(Bool)).toBeNull();
  });

  test("Swift.Protocol exposes the class on the facade", () => {
    expect(Swift.Protocol.find("fixture.Greeter")).not.toBeNull();
  });
});

describe("Swift.enumerateProtocols", () => {
  beforeEach(() => { loadFixture(); });

  test("enumerates protocols across loaded modules, including the fixture's", () => {
    const names = [...Swift.enumerateProtocols()].map((p) => p.fullName);
    expect(names).toContain("fixture.Greeter");
    expect(names).toContain("fixture.Scalable");
  });

  test("each yielded entry is a usable Protocol", () => {
    const greeter = [...Swift.enumerateProtocols()].find((p) => p.fullName === "fixture.Greeter")!;
    expect(greeter.requirements.length).toBeGreaterThan(0);
  });

  test("a glob filter matches qualified protocol names", () => {
    const greeters = [...Swift.enumerateProtocols("*.Greeter")].map((p) => p.fullName);
    expect(greeters).toContain("fixture.Greeter");
    expect(greeters.every((name) => name.endsWith(".Greeter"))).toBeTruthy();
    const scoped = [...Swift.enumerateProtocols("fixture.*")].map((p) => p.fullName);
    expect(scoped).toContain("fixture.Scalable");
    expect(scoped.every((name) => name.startsWith("fixture."))).toBeTruthy();
  });
});

describe("Protocol.conformingTypes", () => {
  beforeEach(() => { loadFixture(); });

  test("is the inverse of protocols(): Scalable includes its retroactive Swift.Int conformance", () => {
    const scalable = Protocol.find("fixture.Scalable")!;
    const names = scalable.conformingTypes().map((t) => t.name);
    expect(names).toContain("Swift.Int");
  });

  test("Greeter's conforming types include Person", () => {
    const greeter = Protocol.find("fixture.Greeter")!;
    const names = greeter.conformingTypes().map((t) => t.name);
    expect(names).toContain("fixture.Person");
  });
});

describe("Protocol.namedRequirements", () => {
  beforeEach(() => { loadFixture(); });

  test("names Greeter.greet, skipping the unresolvable generic Pair<T> conformance", (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const greeter = Protocol.find("fixturesyms.Greeter")!;
    const named = greeter.namedRequirements();
    expect(named.map((r) => r.name)).toContain("greet");
  });

  test("names Scalable's one requirement via whichever concrete conformer resolves first", (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const scalable = Protocol.find("fixturesyms.Scalable")!;
    const named = scalable.namedRequirements();
    expect(named).toHaveLength(1);
    expect(named[0].name).toBe("scaled");
  });

  test("a recovered name's requirement matches one from the raw requirements list", (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const greeter = Protocol.find("fixturesyms.Greeter")!;
    const named = greeter.namedRequirements().find((r) => r.name === "greet")!;
    expect(greeter.requirements.map((r) => r.witnessIndex)).toContain(named.requirement.witnessIndex);
  });

  test("a stripped conformance's witness thunk is unrecoverable, so its requirement lists unnamed", () => {
    const greeter = Protocol.find("fixture.Greeter")!;
    const [greet, ...rest] = greeter.namedRequirements();
    expect(rest).toEqual([]);
    expect(greet.name).toBeNull();
    expect(greet.signature).toBeNull();
    expect(greet.requirement.kind).toBe(ProtocolRequirementKind.Method);
  });
});

describe("protocols()", () => {
  beforeEach(() => { loadFixture(); });

  test("a type reports its declared conformances as a name->Protocol map", () => {
    const person = typeOf(metadataFor("fixture.Person")!) as NominalType;
    const protocols = person.protocols();
    expect(Object.keys(protocols).sort()).toEqual(["fixture.Aged", "fixture.Greeter"]);
    expect(protocols["fixture.Greeter"] instanceof Protocol).toBe(true);
    expect(protocols["fixture.Greeter"].fullName).toBe("fixture.Greeter");
  });

  test("includes a retroactive conformance declared in another module", () => {
    const int = typeOf(metadataFor("Swift.Int")!) as NominalType;
    expect(Object.keys(int.protocols())).toContain("fixture.Scalable");
  });

  test("is reachable through the object facade's $type", () => {
    const widget = (typeOf(metadataFor("fixture.Widget")!) as ClassType).facade.init("w");
    expect(Object.keys(widget.$type.protocols())).toContain("fixture.Named");
  });
});

describe("conformsTo", () => {
  beforeEach(() => { loadFixture(); });

  test("answers true for a conformer and false for a non-conformer, given a name or a Protocol", () => {
    const person = Swift.type("fixture.Person")!.$type;
    expect(person.conformsTo("fixture.Greeter")).toBe(true);
    expect(person.conformsTo(Swift.Protocol.find("fixture.Greeter")!)).toBe(true);
    expect(person.conformsTo("fixture.Named")).toBe(false);
  });

  test("a conditional conformance holds per specialization", () => {
    expect(Swift.struct("fixture.Pair<fixture.PoliteGreeter>")!.$type.conformsTo("fixture.Greeter")).toBe(true);
    expect(Swift.struct("fixture.Pair<Swift.Int>")!.$type.conformsTo("fixture.Greeter")).toBe(false);
  });

  test("a subclass conforms through its superclass although its own protocols() omit the protocol", () => {
    const sub = Swift.class("fixture.SubSpeaker")!.$type;
    expect(Object.keys(sub.protocols())).not.toContain("fixture.Vocal");
    expect(sub.conformsTo("fixture.Vocal")).toBe(true);
  });

  test("throws for an unknown protocol and for a generic type named without its arguments", () => {
    expect(() => Swift.type("fixture.Person")!.$type.conformsTo("fixture.NoSuchProtocolQX")).toThrow("unknown protocol: fixture.NoSuchProtocolQX");
    expect(() => Swift.struct("fixture.Pair")!.$type.conformsTo("fixture.Greeter")).toThrow("requires type arguments");
  });
});

describe("ProtocolComposition", () => {
  beforeEach(() => { loadFixture(); });

  test("single-protocol metadata equals the compiler's existential metadata", () => {
    const greeter = ProtocolComposition.fromSignature("fixture.Greeter");
    expect(greeter.numProtocols).toBe(1);
    expect(greeter.isClassOnly).toBe(false);
    expect(greeter.metadata.kind).toBe(MetadataKind.Existential);
    expect(compiledType("fixture.greeterType")).toBe(typeOf(greeter.metadata));
  });

  test("multi-protocol composition matches `any Greeter & Aged`", () => {
    const ga = ProtocolComposition.fromSignature("fixture.Greeter & fixture.Aged");
    expect(ga.numProtocols).toBe(2);
    expect(ga.isClassOnly).toBe(false);
    expect(compiledType("fixture.greeterAgedType")).toBe(typeOf(ga.metadata));
  });

  test("a class-only member makes the whole composition class-only", () => {
    const named = ProtocolComposition.fromSignature("fixture.Named");
    expect(named.isClassOnly).toBe(true);
    expect(compiledType("fixture.namedType")).toBe(typeOf(named.metadata));
  });

  test("rejects an unknown protocol in the signature", () => {
    expect(() => ProtocolComposition.fromSignature("fixture.NoSuchProtocolQX")).toThrow();
  });
});

describe("makeSwiftNativeFunction with existential metadata", () => {
  test("a ProtocolComposition drives an existential return then argument", () => {
    const String_ = metadataFor("Swift.String")!;
    const Greeter = ProtocolComposition.fromSignature("fixture.Greeter");
    const make = makeSwiftNativeFunction(fixtureExport("fixture.makeGreeterExistential"), Greeter.metadata, []);
    const g = make()!;
    expect(readValue(Greeter.metadata, g)).toEqual({ name: "Ada" });
    const greet = makeSwiftNativeFunction(fixtureExport("fixture.greetExistential"), String_, [Greeter.metadata]);
    expect(readString(greet(g)!)).toBe("Hello, Ada");
  });

  test("a bare Protocol lowers to its single-protocol existential metadata", () => {
    const String_ = metadataFor("Swift.String")!;
    const greeter = new ProtocolComposition(Protocol.find("fixture.Greeter")!).metadata;
    const make = makeSwiftNativeFunction(fixtureExport("fixture.makeGreeterExistential"), greeter, []);
    const greet = makeSwiftNativeFunction(fixtureExport("fixture.greetExistential"), String_, [greeter]);
    expect(readString(greet(make()!)!)).toBe("Hello, Ada");
  });

  test("a composition existential round-trips through describeGreeterAged", () => {
    const String_ = metadataFor("Swift.String")!;
    const ga = ProtocolComposition.fromSignature("fixture.Greeter & fixture.Aged");
    const make = makeSwiftNativeFunction(fixtureExport("fixture.makeGreeterAged"), ga.metadata, []);
    const describe = makeSwiftNativeFunction(fixtureExport("fixture.describeGreeterAged"), String_, [ga.metadata]);
    expect(readString(describe(make()!)!)).toBe("Hi, Cy (9)");
  });
});

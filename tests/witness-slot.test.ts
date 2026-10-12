import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadConformance, FIXTURE_MODULE } from "./fixtures/load.js";

import { Protocol, ProtocolRequirementKind, StructType, metadataFor, typeOf } from "../src/abi.js";
import { symbolicate } from "../src/runtime/symbolication.js";

import { Swift } from "../src/index.js";

function methodSlot(protocolName: string): string {
  const requirement = Protocol.find(protocolName)!.requirements.find((r) => r.kind === ProtocolRequirementKind.Method)!;
  return `${protocolName}#${requirement.witnessIndex}`;
}

describe("unnamed witness slots on the reflection", () => {
  beforeEach(() => { loadFixture(); });

  test("a stripped conformance's method witness is listed by protocol and index, beside the named method", () => {
    const listed = Swift.class("fixture.BaseSpeaker")!.$type.instanceMethods();
    expect(listed.filter((s) => s === "speak()")).toHaveLength(1);
    expect(listed.filter((s) => s === methodSlot("fixture.Vocal"))).toHaveLength(1);
  });

  test("the slot member is the witness thunk, with no signature", () => {
    const selector = methodSlot("fixture.Vocal");
    const member = Swift.class("fixture.BaseSpeaker")!.$type.instanceMethod(selector);
    const table = Protocol.find("fixture.Vocal")!.conformanceFor(metadataFor("fixture.BaseSpeaker")!)!;
    expect(member.address.equals(table.requirement(Number(selector.split("#")[1])))).toBe(true);
    expect(member.selector).toBe(selector);
    expect(member.signature).toBeNull();
    expect(member.origin).toEqual({ kind: "own", type: "fixture.BaseSpeaker", module: FIXTURE_MODULE });
  });

  test("a struct's witnesses are listed, a static requirement among the type methods", () => {
    expect(Swift.struct("fixture.Car")!.$type.instanceMethods()).toContain(methodSlot("fixture.Vehicle"));
    const point = Swift.struct("fixture.GridPoint")!.$type;
    const equals = methodSlot("Swift.Equatable");
    expect(point.typeMethods()).toContain(equals);
    expect(point.instanceMethods()).not.toContain(equals);
    expect(() => point.instanceMethod(equals)).toThrow(/no instance method/);
  });

  test("a conformance another module declares is listed deep, and only while its witness has no symbol", () => {
    loadConformance();
    const robot = Swift.class("fixture.Robot")!.$type;
    const selector = methodSlot("conformance.Flyable");
    expect(robot.instanceMethods().some((s) => s.startsWith("conformance.Flyable#"))).toBe(false);
    const table = Protocol.find("conformance.Flyable")!.conformanceFor(metadataFor("fixture.Robot")!)!;
    const named = symbolicate(table.requirement(Number(selector.split("#")[1]))) !== null;
    expect(robot.instanceMethods({ deep: true }).includes(selector)).toBe(!named);
    if (named) {
      expect(() => robot.instanceMethod(selector)).toThrow(/no instance method/);
    } else {
      expect(robot.instanceMethod(selector).origin.kind).toBe("extension");
    }
  });

  test("a stdlib type's shallow listing stays within its own module; the stripped extension's slot is deep", () => {
    const int = Swift.struct("Swift.Int")!.$type;
    const selector = methodSlot("fixture.Scalable");
    expect(int.instanceMethods()).not.toContain(selector);
    expect(int.instanceMethods({ deep: true })).toContain(selector);
    expect(int.instanceMethod(selector).origin).toEqual({ kind: "extension", type: "Swift.Int", module: FIXTURE_MODULE });
  });

  test("a generic specialization lists its conformances' slots under its specialized name", () => {
    const greeterPair = typeOf(metadataFor("fixture.Pair", [metadataFor("fixture.PoliteGreeter")!])!) as StructType;
    const selector = methodSlot("fixture.Greeter");
    expect(greeterPair.instanceMethods()).toContain(selector);
    expect(greeterPair.instanceMethod(selector).origin).toEqual({ kind: "own", type: greeterPair.name, module: FIXTURE_MODULE });
    expect(greeterPair.name).toBe("fixture.Pair<fixture.PoliteGreeter>");
  });

  test("a type that does not conform lists no slot for the protocol", () => {
    expect(() => Swift.struct("fixture.Car")!.$type.instanceMethod(methodSlot("fixture.Vocal"))).toThrow(/no instance method/);
  });
});

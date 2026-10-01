import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import {
  loadFixture,
  loadNoMetadata,
  loadConformance,
  FIXTURE_MODULE,
  NOMETADATA_MODULE,
  CONFORMANCE_MODULE,
} from "./fixtures/load.js";

import { Swift, ClassType, StructType } from "../src/index.js";
import { resolveMethod } from "../src/runtime/method.js";

describe("a bound method's origin", () => {
  beforeEach(() => {
    loadFixture();
    loadNoMetadata();
  });

  test("a method the type declares is its own", () => {
    const robot = (Swift.type("fixture.Robot") as ClassType).init("R2");
    expect(robot.$method("greet").origin).toEqual({ kind: "own", type: "fixture.Robot", module: FIXTURE_MODULE });
  });

  test("a method added from another module is an extension in that module", () => {
    const robot = (Swift.type("fixture.Robot") as ClassType).init("R2");
    expect(robot.$method("fly").origin).toEqual({ kind: "extension", type: "fixture.Robot", module: NOMETADATA_MODULE });
  });

  test("a protocol-extension member names the protocol and the module declaring it", () => {
    const describer = (Swift.type("fixture.DefaultDescriber") as StructType).$new({ displayName: "Ada" });
    expect(describer.$method("shout").origin).toEqual({
      kind: "protocolExtension",
      protocol: "fixture.Labeled",
      module: FIXTURE_MODULE,
    });
    expect(describer.$method("whisper").origin).toEqual({
      kind: "protocolExtension",
      protocol: "fixture.Labeled",
      module: NOMETADATA_MODULE,
    });
  });

  test("a type's own method wins over a same-named protocol extension from another module", () => {
    const custom = (Swift.type("fixture.CustomDescriber") as StructType).$new({ displayName: "Ada" });
    expect(custom.tag()).toBe("own tag");
    expect(custom.$method("tag").origin.kind).toBe("own");

    const plain = (Swift.type("fixture.DefaultDescriber") as StructType).$new({ displayName: "Ada" });
    expect(plain.tag()).toBe("default tag");
    expect(plain.$method("tag").origin.kind).toBe("protocolExtension");
  });

  test("a static method is its type's own", () => {
    const robot = Swift.type("fixture.Robot") as ClassType;
    expect(robot.$typeMethod("make").origin).toEqual({ kind: "own", type: "fixture.Robot", module: FIXTURE_MODULE });
  });
});

describe("two modules extending a type with the same method", () => {
  test("the ambiguity error names both modules", () => {
    loadFixture();
    loadNoMetadata();
    loadConformance();
    const ambiguous = () => resolveMethod("fixture.Robot", "hover");
    expect(ambiguous).toThrow(new RegExp(`hover\\(\\) \\(\\) -> Swift\\.String in ${NOMETADATA_MODULE.replace(".", "\\.")}`));
    expect(ambiguous).toThrow(new RegExp(`in ${CONFORMANCE_MODULE.replace(".", "\\.")}`));
  });
});

import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadNoMetadata, loadConformance, NOMETADATA_MODULE, CONFORMANCE_MODULE } from "./fixtures/load.js";

import { Swift, ClassType, StructType } from "../src/index.js";
import { enumerateMethods, enumerateProperties, resolveMethod } from "../src/runtime/method.js";
import { Protocol, ValueInstance, metadataFor, typeOf } from "../src/abi.js";
import { enumerateSwiftModules, enumerateTypes } from "../src/reflection/registry.js";

// Runs before anything in this process loads the extending module, so it must come first.
describe("a module loaded after the search has already run", () => {
  test("its members are missing until it loads, then resolve without a flush", () => {
    loadFixture();
    const Robot = Swift.type("fixture.Robot") as ClassType;
    const robot = Robot.init("R2");
    expect(() => resolveMethod("fixture.Robot", "fly")).toThrow();
    expect(enumerateMethods("fixture.Robot").some((m) => m.name === "fly")).toBeFalsy();
    expect(robot.fly).toBeUndefined();
    expect("fly" in robot).toBe(false);
    expect(Robot.factoryName).toBeUndefined();
    expect("factoryName" in Robot).toBe(false);
    expect(() => Robot.$initializer({ labels: ["badge"] })).toThrow();

    loadNoMetadata();

    expect(resolveMethod("fixture.Robot", "fly").selector).toBe("fly()");
    expect(Robot.init("R2").fly()).toBe("fly R2");
    expect(robot.fly()).toBe("fly R2");
    expect("fly" in robot).toBe(true);
    expect(robot.$call("fly")).toBe("fly R2");
    expect(Swift.type("fixture.Robot")).toBe(Robot);
    expect(Robot.factoryName()).toBe("factory");
    expect("factoryName" in Robot).toBe(true);
    expect(Robot.$call("factoryName")).toBe("factory");
    expect(Robot.$initializer({ labels: ["badge"] }).call("7").name).toBe("R-7");
    expect(Robot.init({ badge: "7" }).name).toBe("R-7");
  });

  test("its conformances are missing until it loads, then reported without a flush", () => {
    const robot = Swift.type("fixture.Robot") as ClassType;
    const container = Protocol.find("fixture.Container")!;
    const containerNames = () => container.namedRequirements().map((r) => r.name);
    expect(Object.keys(robot.$protocols())).not.toContain("conformance.Flyable");
    expect(containerNames()).not.toContain("item");

    loadConformance();

    expect(Object.keys(robot.$protocols())).toContain("conformance.Flyable");
    expect(containerNames()).toContain("item");
  });
});

describe("a type extended from another module", () => {
  beforeEach(() => { loadNoMetadata(); });

  test("member discovery reaches them", () => {
    expect(enumerateMethods("fixture.Robot").some((m) => m.name === "fly")).toBeTruthy();
    expect(enumerateProperties("fixture.Robot").some((p) => p.name === "wingspan")).toBeTruthy();
    expect((Swift.type("fixture.Robot") as ClassType).$instanceMethods()).toContain("fly()");
  });

  test("a generic type's extension members are found and callable", () => {
    expect(enumerateMethods("fixture.Pair").some((m) => m.name === "labelled")).toBeTruthy();
    const pairOfInt = typeOf(metadataFor("fixture.Pair", [metadataFor("Swift.Int")!])!) as StructType;
    expect(pairOfInt.$new({ first: 1, second: 2 }).labelled()).toBe("pair");
  });

  test("an initializer added to a class is selected by its labels", () => {
    const robot = (Swift.type("fixture.Robot") as ClassType).init({ badge: "7" });
    expect(robot.name).toBe("R-7");
  });

  test("an initializer added to a value type is selected by its labels", () => {
    const ranged = (Swift.type("fixture.Ranged") as StructType).init({ span: 5 })!;
    expect(Number(ranged.lo)).toBe(0);
    expect(Number(ranged.hi)).toBe(5);
  });

  test("they are callable and readable through the facade", () => {
    const robot = (Swift.type("fixture.Robot") as ClassType).init("R2");
    expect(robot.fly()).toBe("fly R2");
    expect(Number(robot.wingspan)).toBe(2);
  });

  test("a name whose words the symbol substitutes is still reached through the facade", () => {
    const robot = (Swift.type("fixture.Robot") as ClassType).init("R2");
    expect(robot.flyRobot()).toBe("fly robot R2");
    expect(Number(robot.robotWingspan)).toBe(4);
  });

  test("a misspelled name suggests a member another module declares", () => {
    const robot = (Swift.type("fixture.Robot") as ClassType).init("R2");
    expect(() => robot.$call("flyy")).toThrow("no method flyy on fixture.Robot (did you mean fly?)");
  });

  test("a name no module declares reads as undefined through the facade", () => {
    const robot = (Swift.type("fixture.Robot") as ClassType).init("R2");
    expect(robot.flyAway).toBeUndefined();
  });
});

describe("a protocol extended from another module", () => {
  beforeEach(() => { loadNoMetadata(); });

  test("its extension methods are callable through a conformance", () => {
    const type = metadataFor("fixture.DefaultDescriber")!;
    const value = ValueInstance.fromJS(type, { displayName: "Ada" }).handle;
    const table = Protocol.find("fixture.Labeled")!.conformanceFor(type)!;
    expect(table.method(value, "whisper").call()).toBe("ada");
  });

  test("its extension methods are listed and callable on the conforming type", () => {
    const type = Swift.type("fixture.DefaultDescriber") as StructType;
    expect(type.$instanceMethods()).toContain("whisper()");
    expect(type.$new({ displayName: "Ada" }).whisper()).toBe("ada");
  });

  test("a misspelled name suggests an extension method of a conformed protocol", () => {
    const describer = (Swift.type("fixture.DefaultDescriber") as StructType).$new({ displayName: "Ada" });
    expect(() => describer.$call("whispr")).toThrow("no method whispr on fixture.DefaultDescriber (did you mean whisper?)");
  });

  test("an extension method whose words the symbol substitutes is reached through the facade", () => {
    const type = Swift.type("fixture.DefaultDescriber") as StructType;
    expect(type.$new({ displayName: "Ada" }).whisperLabeled()).toBe("labeled ada");
  });
});

describe("a stdlib protocol extended from another module", () => {
  beforeEach(() => { loadNoMetadata(); });

  const trio = () => (Swift.type("fixture.Trio") as StructType).$new({ a: 1, b: 2, c: 3 });

  test("an extension of a protocol the stdlib mangles as a substitution is callable", () => {
    expect(Number(trio().tally())).toBe(3);
  });

  test("an extension of an inherited protocol reaches a type conforming only to the refinement", () => {
    expect(trio().$method("tally").origin).toEqual({
      kind: "protocolExtension",
      protocol: "Swift.Sequence",
      module: NOMETADATA_MODULE,
    });
  });

  test("an extension property of a stdlib protocol is readable", () => {
    expect(Number(trio().middleOffset)).toBe(1);
  });

  test("an extension of a stdlib protocol spelled out in full is callable", () => {
    expect(trio().quoted()).toBe('"trio"');
  });

  test("they are listed on the conforming type", () => {
    const type = Swift.type("fixture.Trio") as StructType;
    expect(type.$instanceMethods()).toContain("tally()");
    expect(type.$instanceMethods()).toContain("quoted()");
    expect(type.$properties.some((p) => p.name === "middleOffset")).toBeTruthy();
  });
});

describe("a module of extensions alone", () => {
  beforeEach(() => { loadNoMetadata(); });

  test("carries no Swift metadata, so only the symbol route reaches it", () => {
    const nometadata = Process.getModuleByName(NOMETADATA_MODULE);
    expect([...enumerateSwiftModules()].some((m) => m.path === nometadata.path)).toBeFalsy();
  });
});

describe("a module that declares conformances but no types", () => {
  beforeEach(() => { loadConformance(); });

  test("it is scanned although it has no type descriptors", () => {
    const conformance = Process.getModuleByName(CONFORMANCE_MODULE);
    expect([...enumerateTypes(conformance)].length).toBe(0);
    expect([...enumerateSwiftModules()].some((m) => m.path === conformance.path)).toBeTruthy();
  });

  test("the protocol it declares resolves by name", () => {
    expect(Swift.Protocol.find("conformance.Flyable")!.fullName).toBe("conformance.Flyable");
  });

  test("the type it extends reports the conformance", () => {
    const protocols = (Swift.type("fixture.Robot") as ClassType).$protocols();
    expect(Object.keys(protocols)).toContain("conformance.Flyable");
  });

  test("the protocol reports the type it was conformed to", () => {
    const flyable = Swift.Protocol.find("conformance.Flyable")!;
    expect(flyable.conformingTypes().map((t) => t.$name)).toContain("fixture.Robot");
  });

  test("its conformer names an async requirement, so a stripped conformer's async extension method resolves", async () => {
    const ruler = (Swift.type("fixture.Ruler") as StructType).$new({ n: 7 });
    expect(await ruler.measureTwice()).toEqual(int64(14));
  });
});

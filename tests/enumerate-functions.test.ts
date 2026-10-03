import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, FIXTURE_MODULE } from "./fixtures/load.js";

import { Swift, SwiftFunctionMatch } from "../src/index.js";

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
});

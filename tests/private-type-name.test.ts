import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms } from "./fixtures/load.js";

import { findType } from "../src/reflection/registry.js";
import { Swift } from "../src/index.js";

describe("private nested type names", () => {
  beforeEach(() => { loadFixture(); });

  test("keep the enclosing type across the anonymous context", () => {
    expect(findType("fixture.CodableCard.CodingKeys")!.fullTypeName).toBe("fixture.CodableCard.CodingKeys");
    expect(Swift.type("fixture.CodableCard.Hidden")!.$type.name).toBe("fixture.CodableCard.Hidden");
  });

  test("are not reachable as top-level module members", () => {
    expect(findType("fixture.Hidden")).toBeNull();
  });

  test("resolve their methods by the same name", () => {
    loadFixtureSyms();
    const hidden = Swift.struct("fixturesyms.CodableCard.Hidden")!;
    expect(hidden.init({ n: 7 })!.$fields).toEqual({ n: int64(7) });
  });
});

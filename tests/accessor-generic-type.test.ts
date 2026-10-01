import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { StructType } from "../src/index.js";
import { metadataFor, typeOf } from "../src/abi.js";

function halver(n: number) {
  return (typeOf(metadataFor("fixture.Halver")!) as StructType).facade.$new({ n });
}

describe("accessor whose type is generic", () => {
  beforeEach(() => { loadFixture(); });

  // Halver.half is `Int?`; resolving that accessor type needs the desugaring resolver, not a bare
  // nominal-name lookup.
  test("reads an Optional-typed computed property", () => {
    expect(halver(10).$get("half")).toEqual(int64(5));
    expect(halver(7).$get("half")).toBeNull();
  });
});

import { test, expect, describe } from "@frida/injest/agent";
import { requireDarwin } from "./swift.js";
import { compiledType } from "./fixtures/load.js";

import { MetadataKind } from "../src/abi/metadata.js";
import { ForeignClassType, descriptorOf, metadataOf } from "../src/runtime/swift-type.js";

describe("ForeignClass metadata", () => {
  test("routes a CF type to a ForeignClassType instead of a bare SwiftType", (ctx) => {
    requireDarwin(ctx);

    const type = compiledType("fixture.foreignClassType");
    expect(metadataOf(type).kind).toBe(MetadataKind.ForeignClass);
    expect(type instanceof ForeignClassType).toBe(true);
    expect(type.name).toContain("CGColor");
    expect(descriptorOf(type as ForeignClassType).handle.isNull()).toBe(false);
    expect(type.toJSON().kind).toBe("foreign-class");
  });
});

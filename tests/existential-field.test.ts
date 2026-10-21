import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { fixtureExport, loadFixture } from "./fixtures/load.js";

import { Swift, type SwiftValueObject } from "../src/index.js";
import { StructType } from "../src/abi.js";

describe("an existential stored field", () => {
  beforeEach(() => {
    loadFixture();
  });

  function payload(maker: string, n: number): SwiftValueObject {
    return Swift.NativeFunction(fixtureExport(maker), Swift.struct("fixture.Payload")!, [Swift.type("Swift.Int")!])(n) as SwiftValueObject;
  }

  test("$field views the dynamic value with its type, inline or boxed, while $fields reads it as data", () => {
    const holder = payload("fixture.makeArrayPayload", 3);
    const array = holder.$field("value");
    expect(array.type.name).toBe("Swift.Array<Swift.Int>");
    expect((array.type as StructType).facade.$copy(array.handle).count as unknown).toEqual(int64(2));
    expect(Object.keys(holder.$fields as object)).toEqual(["value"]);

    const big = payload("fixture.makeBigPayload", 7).$field("value");
    expect(big.type.name).toBe("fixture.BigStruct");
    expect(big.read()).toEqual({ a: int64(7), b: int64(2), c: int64(3), d: int64(4), e: int64(5) });
  });
});

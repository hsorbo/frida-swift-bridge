import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { ClassType, ValueInstance, asSwiftObject, metadataFor, typeOf } from "../src/abi.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";

import { Swift } from "../src/index.js";
function box() {
  return (typeOf(metadataFor("fixture.Box")!) as ClassType).facade.init();
}

describe("compound generic-using exprs in generic methods", () => {
  beforeEach(() => { loadFixture(); });

  test("T? argument and return pass indirectly (Optional payload is address-only)", () => {
    const Int = metadataFor("Swift.Int")!;
    const roundOpt = box().$method("roundOpt", { typeArguments: [typeOf(Int)] });
    // The `.some`/`"none"` spelling is the argument representation; a decoded Optional return unwraps.
    expect(roundOpt.call({ some: 9 })).toEqual(int64(9));
    expect(roundOpt.call("none")).toBeNull();
  });

  test("T? round-trips a non-POD payload through the indirect path", () => {
    const Str = metadataFor("Swift.String")!;
    expect(box().$method("roundOpt", { typeArguments: [typeOf(Str)] }).call({ some: "hi" })).toBe("hi");
  });

  test("[T] is a fixed-layout Array passed/returned directly", () => {
    const Int = metadataFor("Swift.Int")!;
    const ArrInt = metadataFor("Swift.Array", [Int])!;

    // [T]-return planning binds and calls through GenericBoundMethod.
    const hi = box().$method("tripled", { typeArguments: [typeOf(Int)] }).call(7);
    expect(hi !== null && typeof hi === "object").toBe(true);

    // ABI proof, decode-free: tripled<Int>(7) returns [7,7,7] direct, firstGeneric<Int> reads xs[0].
    const tripled = makeSwiftNativeFunction(
      fixtureExport("fixture.Box.tripled"),
      ArrInt,
      [{ genericParam: 0 }],
      { hasSelf: true, typeArguments: [Int] }
    );
    const firstGeneric = makeSwiftNativeFunction(
      fixtureExport("fixture.firstGeneric"),
      { genericParam: 0 },
      [ArrInt],
      { typeArguments: [Int] }
    );
    const seven = Memory.alloc(8);
    seven.writeS64(7);
    const arrPtr = tripled(box().$handle, seven)!;
    expect(firstGeneric(arrPtr)!.readS64().toNumber()).toBe(7);

    // The Array is opaque to the JS writers; as a ValueInstance it byte-copies through a high-level .call() arg.
    const arr = ValueInstance.fromCopy(ArrInt, arrPtr);
    expect(box().$method("sumInts").call(asSwiftObject(arr))).toEqual(int64(21));
  });
});

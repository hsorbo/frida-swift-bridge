import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { Swift, SwiftClass, SwiftStruct, type SwiftObject, type SwiftValue, type SwiftValueObject } from "../src/index.js";
import { SwiftInterceptor } from "../src/runtime/interceptor.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";
import { metadataFor } from "../src/abi.js";

const SUM_VARIADIC = "$s7fixture11sumVariadicyS2id_tF";
const JOIN_VARIADIC = "$s7fixture12joinVariadic_9separatorS2Sd_SStF";

describe("variadic parameters", () => {
  beforeEach(() => { loadFixture(); });

  test("a JS array marshals to the Array a variadic parameter lowers to", () => {
    const module = loadFixture();
    expect(Swift.function(module, SUM_VARIADIC).call([1, 2, 3])).toEqual(int64(6));
    expect(Swift.function(module, SUM_VARIADIC).call([])).toEqual(int64(0));
    expect(Swift.function(module, JOIN_VARIADIC).call(["a", "bb", "a string long enough to live on the heap"], "-")).toBe("a-bb-a string long enough to live on the heap");
  });

  test("a method lists and takes its variadic parameter", () => {
    const robot = (Swift.type("fixture.Robot") as SwiftClass).init("R2");
    expect(robot.$type.instanceMethod("greetAll").selector).toBe("greetAll(_:)");
    expect(robot.greetAll(["X", "Y"])).toBe("Hello X, I am R2; Hello Y, I am R2");
  });

  test("a generic variadic parameter is the Array of the type argument", () => {
    const box = (Swift.type("fixture.Box") as SwiftClass).init();
    expect(box.$method("lastOf", { typeArguments: [Swift.type("Swift.Int")!] }).call([4, 5, 6])).toEqual(int64(6));
    expect(box.$method("lastOf", { typeArguments: [Swift.type("Swift.String")!] }).call(["x", "y"])).toBe("y");
  });

  test("a plain Array parameter and $new take a JS array too", () => {
    const box = (Swift.type("fixture.Box") as SwiftClass).init();
    expect(box.sumInts([10, 20, 30])).toEqual(int64(60));
    const ints = (Swift.type("Swift.Array<Swift.Int>") as SwiftStruct).$new([7, 8]) as SwiftValueObject;
    expect(ints.$container()).toEqual([int64(7), int64(8)]);
    expect(() => (Swift.type("Swift.Array<Swift.Int>") as SwiftStruct).$new([1, "two"])).toThrow();
  });

  test("a hook decodes a variadic argument as an Array facade", () => {
    const Int = metadataFor("Swift.Int")!;
    let seen: SwiftValue | null = null;
    const listener = SwiftInterceptor.attach(fixtureExport("fixture.sumVariadic"), {
      onEnter(args) {
        seen = (args[0] as SwiftObject).$container!(); // the literal dies with the call
      },
    });
    try {
      expect(makeSwiftNativeFunction(fixtureExport("fixture.driveSumVariadic"), Int, [])()!.readS64()).toEqual(int64(6));
    } finally {
      listener.detach();
    }
    expect(seen).toEqual([int64(1), int64(2), int64(3)]);
  });
});

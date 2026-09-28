import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { ValueInstance, metadataFor } from "../src/abi.js";

import { Swift } from "../src/index.js";
function box(typeName: string, fields: { [k: string]: number }): ValueInstance {
  return ValueInstance.fromJS(metadataFor(typeName)!, fields);
}

describe("generic methods on value receivers", () => {
  beforeEach(() => { loadFixture(); });

  test("small loadable receiver: generic arg/return with self as a trailing exploded arg", () => {
    const Int = metadataFor("Swift.Int")!;
    expect(box("fixture.SmallGenericBox", { base: 5 }).method("echo", { typeArguments: [Int], mutating: false }).call(7)).toEqual(int64(7));
  });

  test("small loadable receiver: a generic method still requires the mutating flag", () => {
    const Int = metadataFor("Swift.Int")!;
    expect(() => box("fixture.SmallGenericBox", { base: 5 }).method("echo", { typeArguments: [Int] })).toThrow('$method("echo", { mutating: false }).call(...)');
  });

  test("small receiver: a String generic argument routes through the value self", () => {
    const Str = metadataFor("Swift.String")!;
    expect(box("fixture.SmallGenericBox", { base: 1 }).method("echo", { typeArguments: [Str], mutating: false }).call("hi")).toBe("hi");
  });

  test("small receiver: self + generic arg + witness combine (trailing-self ordering)", () => {
    const Int = metadataFor("Swift.Int")!;
    // base 10 + 3.scaled(by: 7) = 31; a wrong self/metadata order corrupts base or the witness call.
    expect(box("fixture.SmallGenericBox", { base: 10 }).method("scaledBy", { typeArguments: [Int], mutating: false }).call(3, 7)).toEqual(int64(31));
  });

  test("large receiver: self passed indirectly in x20 alongside trailing metadata", () => {
    const Int = metadataFor("Swift.Int")!;
    // a..e sum 15 + 3.scaled(by: 7) = 36.
    expect(
      box("fixture.BigGenericBox", { a: 1, b: 2, c: 3, d: 4, e: 5 }).method("scaledBy", { typeArguments: [Int] }).call(3, 7)
    ).toEqual(int64(36));
  });
});

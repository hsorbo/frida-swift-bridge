import { test, expect, describe } from "@frida/injest/agent";
import { fixtureExport, compiledType } from "./fixtures/load.js";

import { readValue, readString, metadataFor, metadataOf } from "../src/abi.js";
import { shouldPassIndirectly } from "../src/runtime/calling-convention.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";

import { Swift } from "../src/index.js";
function intArg(n: number): NativePointer {
  const cell = Memory.alloc(Process.pointerSize);
  cell.writeS64(n);
  return cell;
}

describe("existential by-value calling convention", () => {
  test("returns then accepts Any by value (opaque, address-only → indirect)", () => {
    const Int = metadataFor("Swift.Int")!;
    const Any_ = metadataOf(Swift.reflect("Any")!);
    const box = makeSwiftNativeFunction(fixtureExport("fixture.boxAnyInt"), Any_, [Int]);
    const any = box(intArg(42))!;
    expect(readValue(Any_, any)).toEqual(int64(42));
    const unbox = makeSwiftNativeFunction(fixtureExport("fixture.unboxAnyInt"), Int, [Any_]);
    expect(unbox(any)!.readS64().toNumber()).toBe(42);
  });

  test("returns then accepts a protocol existential by value (indirect, witness-table container)", () => {
    const String_ = metadataFor("Swift.String")!;
    const Greeter = metadataOf(Swift.reflect("any fixture.Greeter")!);
    const make = makeSwiftNativeFunction(fixtureExport("fixture.makeGreeterExistential"), Greeter, []);
    const g = make()!;
    expect(readValue(Greeter, g)).toEqual({ name: "Ada" });
    const greet = makeSwiftNativeFunction(fixtureExport("fixture.greetExistential"), String_, [Greeter]);
    expect(readString(greet(g)!)).toBe("Hello, Ada");
  });

  test("returns a parameterized-protocol existential by value (extended, opaque → indirect)", () => {
    const Holder = metadataOf(compiledType("fixture.holderIntType"));
    expect(shouldPassIndirectly(Holder)).toBe(true);
    const make = makeSwiftNativeFunction(fixtureExport("fixture.makeHolderInt"), Holder, []);
    expect(readValue(Holder, make()!)).toEqual({ item: int64(42) });
  });
});

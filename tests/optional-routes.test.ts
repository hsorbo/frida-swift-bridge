import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { fixtureExport, loadFixture } from "./fixtures/load.js";

import { Swift, type CallArg, type CallResult } from "../src/index.js";

const Int = Swift.reflect("Swift.Int")!;
const OptionalInt = Swift.reflect("Swift.Optional<Swift.Int>")!;
const NestedOptionalInt = Swift.reflect("Swift.Optional<Swift.Optional<Swift.Int>>")!;

function unwrapOrZero() {
  return Swift.NativeFunction(fixtureExport("fixture.unwrapOrZero"), OptionalInt, [OptionalInt]);
}

function echoNestedOptional() {
  return Swift.NativeFunction(fixtureExport("fixture.echoNestedOptional"), NestedOptionalInt, [NestedOptionalInt]);
}

describe("Optional representation across routes", () => {
  beforeEach(() => { loadFixture(); });

  test("a call returns the payload or null and takes either back", () => {
    const echo = unwrapOrZero();
    expect(echo(7)).toEqual(int64(7));
    expect(echo(null)).toEqual(int64(0));
    expect(echo(echo(7) as CallArg)).toEqual(int64(7));
    const OptionalString = Swift.reflect("Swift.Optional<Swift.String>")!;
    const text = Swift.NativeFunction(fixtureExport("fixture.echoOptionalText"), OptionalString, [OptionalString]);
    expect(text("none")).toBe("none");
    expect(text(null)).toBeNull();
  });

  test("a nested Optional keeps .none and .some(.none) apart", () => {
    const echo = echoNestedOptional();
    expect(echo(null)).toBeNull();
    expect(echo({ some: null })).toEqual({ some: null });
    expect(echo({ some: 5 })).toEqual({ some: int64(5) });
    expect(() => echo(5)).toThrow(/null or \{ some: value \}/);
  });

  test("a hook observes the shape a call returns", () => {
    const single: CallResult[] = [];
    const nested: CallResult[] = [];
    const a = Swift.Interceptor.attach(fixtureExport("fixture.unwrapOrZero"), {
      onEnter(args) { single.push(args[0]); },
      onLeave(ret) { single.push(ret); },
    });
    const b = Swift.Interceptor.attach(fixtureExport("fixture.echoNestedOptional"), {
      onEnter(args) { nested.push(args[0]); },
      onLeave(ret) { nested.push(ret); },
    });
    try {
      Swift.NativeFunction(fixtureExport("fixture.makeUnwrapOrZero"), Int, [])();
      Swift.NativeFunction(fixtureExport("fixture.makeEchoNestedOptional"), Int, [])();
      echoNestedOptional()(null);
    } finally {
      a.detach();
      b.detach();
    }
    expect(single).toEqual([int64(5), int64(5)]);
    expect(nested).toEqual([{ some: null }, { some: null }, null, null]);
  });

  test("fields read and write Optionals the same way", () => {
    const Fields = Swift.struct("fixture.OptionalFields")!;
    using value = Fields.$new({ single: 7, nested: { some: null } });
    expect(value.$fields).toEqual({ single: int64(7), nested: { some: null } });
    expect(value.single).toEqual(int64(7));
    value.$set("single", null);
    value.$set("nested", { some: 3 });
    expect(value.$fields).toEqual({ single: null, nested: { some: int64(3) } });
    expect(value.$field("nested").read()).toEqual({ some: int64(3) });
    value.$field("nested").write(null);
    expect(value.nested).toBeNull();
  });
});

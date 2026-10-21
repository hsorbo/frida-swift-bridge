import { test, expect, describe } from "@frida/injest/agent";
import { fixtureExport, loadFixture } from "./fixtures/load.js";
import { fieldsOf } from "./swift.js";

import { metadataFor } from "../src/abi.js";
import { Swift, SwiftError, type CallResult, type SwiftClassObject, type SwiftValueObject } from "../src/index.js";

function thrownBy(call: () => unknown): SwiftError {
  try {
    call();
  } catch (e) {
    if (!(e instanceof SwiftError)) throw e;
    return e;
  }
  throw new Error("did not throw");
}

function requireTypedThrows(ctx: { skip: (reason?: string) => never }): void {
  loadFixture();
  if (metadataFor("fixture.CodedFailure") === null) ctx.skip("fixture compiled without typed throws (Swift < 6.0)");
}

function thrower(name: string, result: string) {
  return Swift.NativeFunction(fixtureExport(`fixture.${name}`), Swift.type(result)!, [Swift.type("Swift.Int")!], { throws: true });
}

describe("a thrown nominal error", () => {
  test("is the same owned facade through throws and throws(E)", (ctx) => {
    requireTypedThrows(ctx);
    const untyped = thrownBy(() => thrower("throwsCodedUntyped", "Swift.Double")(7)).value as SwiftValueObject;
    const typed = thrownBy(() => thrower("throwsCoded", "Swift.Double")(7)).value as SwiftValueObject;
    for (const failure of [untyped, typed]) {
      expect([failure.$kind, failure.$owned, failure.$type.name]).toEqual(["value", true, "fixture.CodedFailure"]);
      expect(failure.$fields).toEqual({ code: int64(7), flag: true });
      expect(failure.code).toEqual(int64(7));
    }
  });

  test("is decoded once per error", (ctx) => {
    requireTypedThrows(ctx);
    const error = thrownBy(() => thrower("throwsCodedUntyped", "Swift.Double")(2));
    expect(error.value).toBe(error.value);
  });

  test("a class error is an object through throws as through throws(E)", (ctx) => {
    requireTypedThrows(ctx);
    const failure = thrownBy(() => thrower("throwsClassUntyped", "Swift.Int")(5)).value as SwiftClassObject;
    expect([failure.$kind, failure.$owned]).toEqual(["object", true]);
    expect(failure.id).toEqual(int64(5));
  });

  test("a hook observes an untyped error as a borrowed facade", (ctx) => {
    requireTypedThrows(ctx);
    const seen: { fields: CallResult | undefined; owned: boolean | undefined }[] = [];
    const listener = Swift.Interceptor.attach(fixtureExport("fixture.throwsCodedUntyped"), {
      onLeave(_, error) {
        seen.push({ fields: fieldsOf(error), owned: (error as SwiftValueObject | undefined)?.$owned });
      },
    });
    try {
      thrownBy(() => thrower("throwsCodedUntyped", "Swift.Double")(8));
    } finally {
      listener.detach();
    }
    expect(seen).toEqual([{ fields: { code: int64(8), flag: true }, owned: false }]);
  });
});

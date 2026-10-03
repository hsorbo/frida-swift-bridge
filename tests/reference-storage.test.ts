import { test, expect, describe } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, type SwiftClassObject, type SwiftValueObject } from "../src/index.js";

function makeToken(id: number): SwiftClassObject {
  loadFixture();
  return Swift.type("fixture.Token")!.init(id) as SwiftClassObject;
}

describe("reference storage fields", () => {
  test("a weak field reads as the referent while it lives and as none once it is gone", () => {
    const token = makeToken(7);
    const handle = token.$handle;
    const watcher = Swift.type("fixture.Watcher")!.init(token) as SwiftClassObject;
    watcher.delegate = token;
    const live = watcher.$fields as { delegate: { some: NativePointer }; owner: NativePointer; unsafeOwner: NativePointer };
    expect(live.delegate.some.equals(handle)).toBe(true);
    expect(live.owner.equals(handle)).toBe(true);
    expect(live.unsafeOwner.equals(handle)).toBe(true);
    expect(live).toEqual({ delegate: { some: handle }, owner: handle, unsafeOwner: handle, tag: int64(1) });

    token.$dispose();
    expect((watcher.$fields as { delegate: unknown }).delegate).toBe("none");
  });

  test("a weak field has no borrowed view; a plain field keeps one", () => {
    const token = makeToken(8);
    const watcher = Swift.type("fixture.Watcher")!.init(token) as SwiftClassObject;
    expect(() => watcher.$field("delegate")).toThrow(/weak storage/);
    expect(watcher.$field("tag").read()).toEqual(int64(1));
  });

  test("a struct's weak field reads through the same load", () => {
    const token = makeToken(9);
    const slot = Swift.type("fixture.WeakSlot")!.init(token, 3) as SwiftValueObject;
    expect(slot.$fields).toEqual({ ref: { some: token.$handle }, n: int64(3) });
    token.$dispose();
    expect(slot.$fields).toEqual({ ref: "none", n: int64(3) });
  });
});

import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { Swift, SwiftClass } from "../src/index.js";
import { ClassType, ClassInstance, SwiftObject, metadataFor, typeOf } from "../src/abi.js";

function robotType(): SwiftClass {
  return (typeOf(metadataFor("fixture.Robot")!) as ClassType).facade;
}

// Large (heap) String: __StringStorage pointer at +8, low 60 bits.
const LARGE_ADDRESS_MASK = ptr("0x0fffffffffffffff");
function stringStorage(inlineString: NativePointer): ClassInstance {
  return new ClassInstance(inlineString.add(8).readPointer().and(LARGE_ADDRESS_MASK));
}

describe("ownership", () => {
  beforeEach(() => { loadFixture(); });

  test("$dispose drops the strong count once; double dispose is a no-op", () => {
    const owned = robotType().init("R2");
    expect(owned.$owned).toBe(true);
    const view = new ClassInstance(owned.$handle);
    view.retain(); // outlive the dispose so view can observe the drop
    const before = view.retainCount;
    owned.$dispose();
    expect(view.retainCount).toBe(before - 1);
    owned.$dispose();
    expect(view.retainCount).toBe(before - 1);
    view.release();
  });

  test("a class return is owned; disposing a borrowed wrapper does not release", () => {
    const made = robotType().$call("make", "Forged") as SwiftObject;
    expect(made.$owned).toBe(true);
    const view = new ClassInstance(made.$handle);
    expect(view.owned).toBe(false);
    view.retain();
    const before = view.retainCount;
    view.dispose(); // borrowed → no-op
    expect(view.retainCount).toBe(before);
    made.$dispose(); // owned → release once
    expect(view.retainCount).toBe(before - 1);
    view.release();
  });

  // No GC-release test: bindWeak finalizers fire on a later pass, not synchronously with gc().

  test("a String getter return destroys its +1 temp, leaking no __StringStorage ref", () => {
    const r = robotType().init("a deliberately long, heap-allocated robot name");
    const storage = stringStorage(r.$field("name").handle);
    const before = storage.retainCount;
    for (let i = 0; i < 20; i++) {
      expect(typeof r.$get("name")).toBe("string");
    }
    expect(storage.retainCount).toBe(before);
  });

  // rename retains the +0/guaranteed arg into the field; a leaked temp would leave rc 2, not 1.
  test("a regular method's String arg +1 temp is destroyed, not leaked alongside the stored field", () => {
    const r = robotType().init("short");
    r.$call("rename", "a deliberately long, heap-allocated robot name");
    const storage = stringStorage(r.$field("name").handle);
    expect(storage.retainCount).toBe(1);
  });

  test("a field write releases the previous value instead of leaking it", () => {
    const r = robotType().init("short");
    r.$field("name").write("the first deliberately long, heap-allocated name");
    const old = stringStorage(r.$field("name").handle);
    old.retain();
    const before = old.retainCount;
    r.$field("name").write("the second deliberately long, heap-allocated name");
    expect(old.retainCount).toBe(before - 1);
    old.release();
  });

  test("a class argument to a method is borrowed: retain count unchanged across the call", () => {
    const r = robotType().init("A");
    const other = robotType().init("B");
    const view = new ClassInstance(other.$handle);
    const before = view.retainCount;
    expect(r.$call("merged", other)).toBe("A+B");
    expect(view.retainCount).toBe(before);
  });

  test("a marshalled free function borrows its class argument; only the callee's stored ref remains", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const Token = typeOf(metadataFor("fixture.Token")!);
    const Wrapper = typeOf(metadataFor("fixture.Wrapper")!);
    const makeToken = Swift.NativeFunction(fixtureExport("fixture.makeToken"), Token, [Int]);
    const makeWrapper = Swift.NativeFunction(fixtureExport("fixture.makeWrapper"), Wrapper, [Token]);
    const token = makeToken(7) as SwiftObject;
    const view = new ClassInstance(token.$handle);
    const before = view.retainCount;
    const wrapper = makeWrapper(token) as SwiftObject;
    expect(view.retainCount).toBe(before + 1);
    wrapper.$dispose();
    expect(view.retainCount).toBe(before);
  });

  test("a marshalled free function's String arg temp is destroyed; only the stored field ref remains", () => {
    const Robot = typeOf(metadataFor("fixture.Robot")!);
    const String_ = typeOf(metadataFor("Swift.String")!);
    const rename = Swift.NativeFunction(fixtureExport("fixture.renameRobot"), null, [Robot, String_]);
    const r = robotType().init("short");
    const view = new ClassInstance(r.$handle);
    const before = view.retainCount;
    rename(r, "a deliberately long, heap-allocated robot name");
    expect(view.retainCount).toBe(before);
    const storage = stringStorage(r.$field("name").handle);
    expect(storage.retainCount).toBe(1);
  });
});

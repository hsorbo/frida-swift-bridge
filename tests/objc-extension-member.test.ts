import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadNoMetadata, NOMETADATA_MODULE } from "./fixtures/load.js";
import { requireDarwin } from "./swift.js";

import { Swift, SwiftObjCClass } from "../src/index.js";
import { findMethod } from "../src/runtime/method.js";

const NSOBJECT_SWIFT_TAG = "$sSo8NSObjectC10nometadataE8swiftTagSiyF";
const NSOBJECT_SWIFT_BANNER = "$sSo8NSObjectC10nometadataE11swiftBannerSSyFZ";

describe("Swift extension members of an imported ObjC class", () => {
  let nometadata: Module;
  beforeEach(() => {
    if (Process.platform === "darwin") {
      nometadata = loadNoMetadata();
    }
  });

  test("Swift.type names the class as the demangler does, by its __C. name or its bare name", (ctx) => {
    requireDarwin(ctx);
    const NSObject = Swift.type("__C.NSObject")!;
    expect(NSObject instanceof SwiftObjCClass).toBe(true);
    expect(NSObject.$type.name).toBe("__C.NSObject");
    expect(NSObject.$type.kind).toBe("objc-class");
    expect(NSObject.$type.moduleName).toBe("__C");
    expect(Swift.type("NSObject")).toBe(NSObject);
    expect(Swift.type("__C.NoSuchClass")).toBeNull();
    expect(() => Swift.class("__C.NSObject")).toThrow("'__C.NSObject' is objc-class, not class");
  });

  test("finds an instance method declared in another module's extension, with its origin", (ctx) => {
    requireDarwin(ctx);
    const member = Swift.type("__C.NSObject")!.$type.instanceMethod("swiftTag()");
    expect(member.address.equals(nometadata.getExportByName(NSOBJECT_SWIFT_TAG).strip())).toBe(true);
    expect(member.origin).toEqual({ kind: "extension", type: "__C.NSObject", module: NOMETADATA_MODULE });
    expect(member.selector).toBe("swiftTag()");
    expect(member.signature.returnTypeName).toBe("Swift.Int");
    expect(() => Swift.type("__C.NSObject")!.$type.instanceMethod("swiftTag")).toThrow("ambiguous method swiftTag");
    expect(() => Swift.type("__C.NSObject")!.$type.instanceMethod("noSuchMember")).toThrow("no instance method noSuchMember on __C.NSObject");
    expect(() => findMethod("__C.NoSuchClass", "swiftTag")).toThrow("unknown type: __C.NoSuchClass");
  });

  test("lists the extension members without asking for a deep sweep", (ctx) => {
    requireDarwin(ctx);
    const type = Swift.type("__C.NSObject")!.$type;
    expect(type.instanceMethods()).toContain("swiftTag()");
    expect(type.instanceMethods()).toContain("swiftTag(scaled:)");
    expect(type.typeMethods()).toContain("swiftBanner()");
    expect(type.properties().map((p) => p.name)).toContain("swiftVersion");
  });

  test("calls a type method and reads a static property with the ObjC class as self", (ctx) => {
    requireDarwin(ctx);
    const NSObject = Swift.type("__C.NSObject")!;
    expect(NSObject.$typeMethod("swiftBanner()").address.equals(nometadata.getExportByName(NSOBJECT_SWIFT_BANNER).strip())).toBe(true);
    expect(NSObject.$typeMethod("swiftBanner()").call()).toBe("banner");
    expect(NSObject.swiftBanner()).toBe("banner");
    expect(NSObject.$get("swiftVersion")).toEqual(int64(3));
    expect(NSObject.swiftVersion).toEqual(int64(3));
    expect("swiftBanner" in NSObject).toBe(true);
    expect(() => NSObject.init()).toThrow("__C.NSObject is an Objective-C class");
  });

  test("Swift.function resolves the qualified selector", (ctx) => {
    requireDarwin(ctx);
    const banner = Swift.function("__C.NSObject.swiftBanner()");
    expect(banner.isStatic).toBe(true);
    expect(banner.origin.module).toBe(NOMETADATA_MODULE);
    expect(banner.call()).toBe("banner");
    expect(Swift.function("__C.NSObject.swiftTag(scaled:)").address.isNull()).toBe(false);
  });

  test("a subclass finds the extension members of its ObjC superclass", (ctx) => {
    requireDarwin(ctx);
    const Protocol = Swift.type("__C.Protocol")!;
    expect(Protocol.$type.name).toBe("__C.Protocol");
    expect(Protocol.$typeMethod("swiftBanner()").origin).toEqual({ kind: "extension", type: "__C.NSObject", module: NOMETADATA_MODULE });
    expect(Protocol.swiftBanner()).toBe("banner");
    expect(Protocol.$type.typeMethods()).toContain("swiftBanner()");
  });

  test("a Swift class rooted in an ObjC class finds the extension members of its ObjC superclasses", (ctx) => {
    requireDarwin(ctx);
    const Starling = Swift.class("fixture.Starling")!;
    expect(Starling.$typeMethod("swiftBanner()").origin).toEqual({ kind: "extension", type: "__C.NSObject", module: NOMETADATA_MODULE });
    expect(Starling.$type.instanceMethods()).toContain("swiftTag()");
    expect(Starling.$type.typeMethods()).toContain("swiftBanner()");
    expect(Starling.swiftBanner()).toBe("banner");
    expect(Starling.swiftVersion).toEqual(int64(3));
    const starling = Starling.init();
    expect(starling.swiftTag()).toEqual(int64(7));
    expect(starling.swiftTag(3)).toEqual(int64(21));
    expect(starling.chirp()).toBe("whistle");
  });

  test("a found member hooks like any other", (ctx) => {
    requireDarwin(ctx);
    const NSObject = Swift.type("__C.NSObject")!;
    const seen: string[] = [];
    const listener = Swift.Interceptor.attach(NSObject.$type.typeMethod("swiftBanner()"), {
      onLeave(retval) {
        seen.push(String(retval));
      },
    });
    try {
      expect(NSObject.swiftBanner()).toBe("banner");
    } finally {
      listener.detach();
    }
    expect(seen).toEqual(["banner"]);
  });
});

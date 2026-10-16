import { test, expect, describe } from "@frida/injest/agent";
import { requireDarwin, loadSwiftCore } from "./swift.js";

import { Swift, ObjCClassWrapperType } from "../src/index.js";

function objcClassWrapperMetadata(className: string): { wrapper: NativePointer; objcClass: NativePointer } {
  const lookUpClass = new NativeFunction(
    Process.getModuleByName("libobjc.A.dylib").getExportByName("objc_lookUpClass"),
    "pointer",
    ["pointer"]
  );
  const objcClass = lookUpClass(Memory.allocUtf8String(className));
  const getObjCClassMetadata = new NativeFunction(
    loadSwiftCore().getExportByName("swift_getObjCClassMetadata"),
    "pointer",
    ["pointer"]
  );
  return { wrapper: getObjCClassMetadata(objcClass), objcClass };
}

describe("ObjCClassWrapper metadata", () => {
  test("routes to the ObjC class instead of a bare SwiftType", (ctx) => {
    requireDarwin(ctx);

    const { wrapper, objcClass } = objcClassWrapperMetadata("NSObject");
    const type = Swift.reflect(wrapper);
    expect(type instanceof ObjCClassWrapperType).toBe(true);
    expect((type as ObjCClassWrapperType).objcClass.toString()).toBe(objcClass.toString());
    expect(type.name).toContain("NSObject");
    expect(type.toJSON().kind).toBe("objc-class");
  });
});

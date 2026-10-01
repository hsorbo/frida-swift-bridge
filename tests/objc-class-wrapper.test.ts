import { test, expect, describe } from "@frida/injest/agent";
import { requireDarwin, loadSwiftCore } from "./swift.js";

import { Metadata, MetadataKind } from "../src/abi/metadata.js";
import { typeOf, ObjCClassWrapperType } from "../src/runtime/swift-type.js";
import { lookUpObjCClass } from "../src/runtime/objc.js";

function objcClassWrapperMetadata(className: string): { wrapper: NativePointer; objcClass: NativePointer } {
  const objcClass = lookUpObjCClass(className)!;
  const getObjCClassMetadata = new NativeFunction(
    loadSwiftCore().getExportByName("swift_getObjCClassMetadata"),
    "pointer",
    ["pointer"]
  );
  return { wrapper: getObjCClassMetadata(objcClass) as NativePointer, objcClass };
}

describe("ObjCClassWrapper metadata", () => {
  test("routes to the ObjC class instead of a bare SwiftType", (ctx) => {
    requireDarwin(ctx);

    const { wrapper, objcClass } = objcClassWrapperMetadata("NSObject");
    const metadata = new Metadata(wrapper);
    expect(metadata.kind).toBe(MetadataKind.ObjCClassWrapper);

    const type = typeOf(metadata);
    expect(type instanceof ObjCClassWrapperType).toBe(true);
    expect((type as ObjCClassWrapperType).objcClass.toString()).toBe(objcClass.toString());
    expect(type.name).toContain("NSObject");
    expect(type.toJSON().kind).toBe("objc-class");
  });
});

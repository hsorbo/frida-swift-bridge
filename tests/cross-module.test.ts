import { test, expect, describe } from "@frida/injest/agent";
import {
  requireSwift,
  ONONE_SUPPORT_MODULE,
  loadOnoneSupport,
} from "./swift.js";

import {
  enumerateSwiftModules,
  enumerateTypes,
} from "../src/reflection/registry.js";

function requireOnoneSupport(): void {
  requireSwift();
  loadOnoneSupport();
}

describe("cross-module descriptor walk", () => {
  test("every type descriptor is aligned and resolves its module name", () => {
    requireOnoneSupport();

    let types = 0;
    let named = 0;
    for (const module of enumerateSwiftModules()) {
      for (const descriptor of enumerateTypes(module)) {
        types++;
        expect(descriptor.handle.and(0x3).isNull()).toBeTruthy();
        if (descriptor.moduleName !== null) {
          named++;
        }
      }
    }

    expect(types).toBeGreaterThan(Process.platform === "darwin" ? 1000 : 500);
    expect(named).toBe(types);
  });

  test("resolves indirect type-descriptor records to named types", (ctx) => {
    requireOnoneSupport();
    if (Process.platform === "windows") {
      ctx.skip("the Windows Onone-support library declares no types");
    }

    const onone = Process.getModuleByName(ONONE_SUPPORT_MODULE);
    let withName = 0;
    for (const descriptor of enumerateTypes(onone)) {
      if (descriptor.name !== null && descriptor.name.length > 0) {
        withName++;
      }
    }
    expect(withName).toBeGreaterThan(0);
  });
});

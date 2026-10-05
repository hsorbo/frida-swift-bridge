import { test, expect, describe } from "@frida/injest/agent";

import { Swift } from "../src/index.js";
import { SWIFTCORE_MODULE } from "./swift.js";

// No requireSwift() here: available must not load the runtime, so this file never does either.
describe("Swift.available", () => {
  test("is side-effect-free: reading it does not load libswiftCore", () => {
    const loaded = (): boolean => Process.findModuleByName(SWIFTCORE_MODULE) !== null;
    const before = loaded();
    void Swift.available;
    void Swift.available;
    expect(loaded()).toBe(before);
  });

  test("agrees with plain runtime presence on a supported host", () => {
    const hostSupported =
      (Process.arch === "arm64" || Process.arch === "x64") &&
      (Process.platform === "darwin" || Process.platform === "linux" || (Process.platform === "windows" && Process.arch === "arm64"));
    expect(Swift.available).toBe(hostSupported && Process.findModuleByName(SWIFTCORE_MODULE) !== null);
  });
});

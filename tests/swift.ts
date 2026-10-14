import { Swift } from "../src/index.js";
import { runtimeLibraryName } from "../src/runtime/platform.js";

const LIBSWIFT_CORE_NAME = runtimeLibraryName("swiftCore");

export const SWIFTCORE_MODULE = LIBSWIFT_CORE_NAME;
export const NON_SWIFT_MODULE =
  Process.platform === "darwin" ? "libsystem_kernel.dylib" : Process.platform === "windows" ? "kernel32.dll" : "libc.so.6";

export const ONONE_SUPPORT_MODULE = runtimeLibraryName("swiftSwiftOnoneSupport");

export function requireDarwin(ctx: { skip: (reason?: string) => never }): void {
  if (Process.platform !== "darwin") {
    ctx.skip("Darwin-only");
  }
}

export function requireLinux(ctx: { skip: (reason?: string) => never }): void {
  if (Process.platform !== "linux") {
    ctx.skip("Linux-only");
  }
}

export function requireSwiftHost(): void {
  const ok =
    (Process.arch === "arm64" || Process.arch === "x64") &&
    (Process.platform === "darwin" || Process.platform === "linux" || Process.platform === "windows");
  if (!ok) {
    throw new Error(`needs arm64/x64 Darwin, Linux or Windows, got ${Process.arch}/${Process.platform}`);
  }
}

// Swift.available no longer loads; the plain-C test host needs Swift.api to.
export function requireSwift(): void {
  void Swift.api;
}

export function loadSwiftCore(): Module {
  requireSwift();
  return Process.getModuleByName(LIBSWIFT_CORE_NAME);
}

// Onone-support sits beside libswiftCore; derive its dir from the loaded core, not a fixed path.
export function loadOnoneSupport(): Module {
  const existing = Process.findModuleByName(ONONE_SUPPORT_MODULE);
  if (existing !== null) {
    return existing;
  }
  const core = loadSwiftCore();
  const dir = core.path.slice(0, core.path.search(/[\\/][^\\/]*$/));
  Module.load(`${dir}/${ONONE_SUPPORT_MODULE}`);
  return Process.getModuleByName(ONONE_SUPPORT_MODULE);
}

// A PE image carries no symbol table: Frida's symbols for it are its exports, so what the symbol
// route alone recovers (witness thunks, value-type inits, requirement names) stays hidden.
export function requireSymbolTable(ctx: { skip: (reason?: string) => void }): void {
  if (Process.platform === "windows") {
    ctx.skip("PE images carry no symbol table");
  }
}

// The Windows runtime libraries are built without library evolution.
export function requireResilientStdlib(ctx: { skip: (reason?: string) => void }): void {
  if (Process.platform === "windows") {
    ctx.skip("stdlib built without library evolution");
  }
}

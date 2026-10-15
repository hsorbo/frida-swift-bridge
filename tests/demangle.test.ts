import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift, requireSwiftHost } from "./swift.js";

import { Swift, isSwiftSymbol, demangle } from "../src/index.js";

describe("demangle", () => {
  test("Swift is available once libswiftCore loads", () => {
    requireSwift();
    expect(Swift.available).toBeTruthy();
  });

  test("recognizes Swift symbol prefixes", () => {
    expect(isSwiftSymbol("$sSi")).toBeTruthy();
    expect(isSwiftSymbol("_$s4test1xyz")).toBeTruthy();
    expect(isSwiftSymbol("open")).toBeFalsy();
    expect(isSwiftSymbol("")).toBeFalsy();
  });

  test("demangles a known stdlib symbol", () => {
    requireSwiftHost();
    const result = demangle("$sSiMn");
    expect(result).toBeDefined();
    expect(result).toContain("Int");
  });

  test("matches the allocating call for a name that outgrows the output buffer", () => {
    requireSwift();
    const depth = 400;
    const mangled = "$s" + "Say".repeat(depth) + "Si" + "G".repeat(depth);
    const allocated = Swift.api
      .swift_demangle(Memory.allocUtf8String(mangled), mangled.length, ptr(0), ptr(0), 0)
      .readUtf8String()!;
    expect(allocated.length).toBeGreaterThan(4096);
    expect(demangle(mangled)).toBe(allocated);
  });

  test("returns null for non-Swift names", () => {
    requireSwiftHost();
    expect(demangle("open")).toBeNull();
  });

  test("is cached / idempotent", () => {
    requireSwiftHost();
    expect(demangle("$sSiMn")).toBe(demangle("$sSiMn"));
  });
});

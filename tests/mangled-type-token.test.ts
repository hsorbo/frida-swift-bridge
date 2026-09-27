import { test, expect, describe } from "@frida/injest/agent";

import { ContextDescriptor, ContextDescriptorKind } from "../src/abi/context-descriptor.js";
import { buildMangledTypeToken } from "../src/runtime/method.js";
import { arenaAlloc, arenaString, writeRelativeDirectPointer } from "./arena.js";

describe("mangled type token", () => {
  test("bails without throwing on a protocol nested in an extension with a symbolic-reference mangling", () => {
    const module = arenaAlloc(0xc);
    module.writeU32(ContextDescriptorKind.Module);
    module.add(0x4).writeS32(0);
    writeRelativeDirectPointer(module.add(0x8), arenaString("M"));

    const mangled = arenaAlloc(0x8);
    mangled.writeByteArray([0x01, 0x20, 0x9d, 0xff, 0xff, 0x00]);

    const extension = arenaAlloc(0xc);
    extension.writeU32(ContextDescriptorKind.Extension);
    writeRelativeDirectPointer(extension.add(0x4), module);
    writeRelativeDirectPointer(extension.add(0x8), mangled);

    const protocol = arenaAlloc(0xc);
    protocol.writeU32(ContextDescriptorKind.Protocol);
    writeRelativeDirectPointer(protocol.add(0x4), extension);
    writeRelativeDirectPointer(protocol.add(0x8), arenaString("Nested"));

    expect(buildMangledTypeToken(new ContextDescriptor(protocol))).toBeNull();
  });
});

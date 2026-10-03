import { test, expect, describe } from "@frida/injest/agent";

import { probeSelfOwnership } from "../src/runtime/value-convention.js";

// Capstone attaches no register detail to these arm64 encodings, so the probe derives it from
// their operands.
const SMOV_X8_V0_B0 = 0x4e012c08;
const FMOV_H0_W8 = 0x1ee70100;
const STR_H0_X20 = 0x7d000280;
const RET = 0xd65f03c0;

function code(words: number[]): NativePointer {
  const page = Memory.alloc(Process.pageSize);
  words.forEach((w, i) => page.add(i * 4).writeU32(w));
  return page;
}

describe("register-use probe on arm64 moves without Capstone register detail", () => {
  test("a lane extract reads its vector register", (ctx) => {
    if (Process.arch !== "arm64") ctx.skip("arm64-only");
    const method = code([SMOV_X8_V0_B0, RET]);
    expect(probeSelfOwnership(method, { gp: [0, 0], fp: [0, 1] })).toBe("borrowing");
  });

  test("a half-precision move writes its vector register before a later read", (ctx) => {
    if (Process.arch !== "arm64") ctx.skip("arm64-only");
    const method = code([FMOV_H0_W8, STR_H0_X20, RET]);
    expect(probeSelfOwnership(method, { gp: [0, 0], fp: [0, 1] })).toBe("mutating");
  });
});

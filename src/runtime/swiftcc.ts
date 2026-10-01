// The Swift calling convention's register assignments, spelled as a CpuContext and the code
// writers name them: swiftself, swifterror, the indirect result and the async context, and the
// argument and result sequences.

export type FloatClass = "double" | "float";

const ARCH = Process.arch;

export const GP_ARG_REGISTERS = ARCH === "arm64" ? 8 : 6;
export const FP_ARG_REGISTERS = 8;
export const GP_RESULT_REGISTERS = 4;
export const FP_RESULT_REGISTERS = 4;

export interface SwiftccRegisters {
  self: string;
  error: string;
  indirectResult: string;
  asyncContext: string;
  gpArgs: string[];
  gpResults: string[];
  fpArg(cls: FloatClass, index: number): string;
}

function numbered(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

export const SWIFTCC: SwiftccRegisters =
  ARCH === "arm64"
    ? {
        self: "x20",
        error: "x21",
        indirectResult: "x8",
        asyncContext: "x22",
        gpArgs: numbered("x", GP_ARG_REGISTERS),
        gpResults: numbered("x", GP_RESULT_REGISTERS),
        fpArg: (cls, index) => `${cls === "double" ? "d" : "s"}${index}`,
      }
    : {
        self: "r13",
        error: "r12",
        indirectResult: "rax",
        asyncContext: "r14",
        gpArgs: ["rdi", "rsi", "rdx", "rcx", "r8", "r9"],
        gpResults: ["rax", "rdx", "rcx", "r8"],
        fpArg: (_cls, index) => `xmm${index}`,
      };

export type SseBase = "r10" | "r11" | "rsp";

// ModRM encodings for the bases the trampolines use: an extended register needs REX.B, rsp a SIB.
const SSE_BASE: Record<SseBase, { rex: number | null; rm: number; sib: number | null }> = {
  r10: { rex: 0x41, rm: 2, sib: null },
  r11: { rex: 0x41, rm: 3, sib: null },
  rsp: { rex: null, rm: 4, sib: 0x24 },
};

// movsd/movss between xmm<index> and [base + off]; X86Writer has no SSE move with a memory operand.
export function putSseScalarMove(
  writer: X86Writer,
  direction: "load" | "store",
  cls: FloatClass,
  index: number,
  base: SseBase,
  off: number
): void {
  const { rex, rm, sib } = SSE_BASE[base];
  const bytes = [cls === "double" ? 0xf2 : 0xf3];
  if (rex !== null) {
    bytes.push(rex);
  }
  bytes.push(0x0f, direction === "load" ? 0x10 : 0x11, 0x40 | (index << 3) | rm);
  if (sib !== null) {
    bytes.push(sib);
  }
  bytes.push(off & 0xff);
  writer.putBytes(bytes);
}

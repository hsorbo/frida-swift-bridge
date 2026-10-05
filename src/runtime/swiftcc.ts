// The Swift calling convention's register assignments, spelled as a CpuContext and the code
// writers name them: swiftself, swifterror, the indirect result and the async context, and the
// argument and result sequences.

export type FloatClass = "double" | "float";

const ARCH = Process.arch;

const WIN64 = ARCH === "x64" && Process.platform === "windows";

export const GP_ARG_REGISTERS = ARCH === "arm64" ? 8 : WIN64 ? 4 : 6;
export const FP_ARG_REGISTERS = WIN64 ? 4 : 8;
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
  // Win64 numbers argument slots across both register files: an argument takes the next slot, in
  // the GP or the XMM register of that index, while results still fill each file on its own.
  sharesArgumentSlots: boolean;
  // Win64 passes the indirect result pointer as the first argument instead of in a register of its own.
  indirectResultIsArgument: boolean;
  // Bytes the caller leaves above the return address for the callee: Win64's home area of four words.
  homeAreaSize: number;
  // The Win64 C ABI, which NativeFunction and NativeCallback speak, passes and returns a two-word
  // struct through a pointer, where swiftcc uses two registers.
  cPassesPairsByPointer: boolean;
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
        sharesArgumentSlots: false,
        indirectResultIsArgument: false,
        homeAreaSize: 0,
        cPassesPairsByPointer: false,
      }
    : {
        self: "r13",
        error: "r12",
        indirectResult: WIN64 ? "rcx" : "rax",
        asyncContext: "r14",
        gpArgs: WIN64 ? ["rcx", "rdx", "r8", "r9"] : ["rdi", "rsi", "rdx", "rcx", "r8", "r9"],
        gpResults: ["rax", "rdx", "rcx", "r8"],
        fpArg: (_cls, index) => `xmm${index}`,
        sharesArgumentSlots: WIN64,
        indirectResultIsArgument: WIN64,
        homeAreaSize: WIN64 ? 32 : 0,
        cPassesPairsByPointer: WIN64,
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

export type TwoWordResult<T0, T1> = [T0, T1];
type WordType = "pointer" | "size_t";
type Word<T extends WordType> = T extends "pointer" ? NativePointer : UInt64;

// swiftcc returns a two-word struct in rax:rdx on both x86-64 ABIs; where the C ABI instead takes
// it through a hidden pointer, the call goes through a thunk that stores the registers. The thunk
// forwards register arguments only.
export function makeTwoWordResultFunction<T0 extends WordType, T1 extends WordType, A extends NativeFunctionArgumentType[]>(
  address: NativePointer,
  resultTypes: [T0, T1],
  argTypes: A
): (...args: NativeFunctionArgumentValue[]) => TwoWordResult<Word<T0>, Word<T1>> {
  if (!SWIFTCC.cPassesPairsByPointer) {
    return new NativeFunction(address, resultTypes, argTypes) as unknown as (...args: NativeFunctionArgumentValue[]) => TwoWordResult<Word<T0>, Word<T1>>;
  }
  if (argTypes.length > GP_ARG_REGISTERS) {
    throw new Error("a two-word result thunk forwards register arguments only");
  }
  const result = Memory.alloc(16);
  const code = Memory.alloc(Process.pageSize);
  Memory.patchCode(code, 0x40, (slot) => {
    const w = new X86Writer(slot, { pc: code });
    w.putSubRegImm("rsp", SWIFTCC.homeAreaSize + 8); // the callee's home area, keeping rsp 16-aligned
    w.putMovRegAddress("r11", address);
    w.putCallReg("r11");
    w.putMovRegAddress("r11", result);
    w.putMovRegPtrReg("r11", "rax");
    w.putMovRegOffsetPtrReg("r11", 8, "rdx");
    w.putAddRegImm("rsp", SWIFTCC.homeAreaSize + 8);
    w.putRet();
    w.flush();
  });
  // The closure holds the page and buffer, which Frida frees once their NativePointers are collected.
  const resources = { code, result, thunk: new NativeFunction(code, "void", argTypes) as unknown as (...args: NativeFunctionArgumentValue[]) => void };
  const read = (at: NativePointer, type: WordType): NativePointer | UInt64 => (type === "pointer" ? at.readPointer() : at.readU64());
  return (...args) => {
    resources.thunk(...args);
    return [read(resources.result, resultTypes[0]), read(resources.result.add(8), resultTypes[1])] as TwoWordResult<Word<T0>, Word<T1>>;
  };
}

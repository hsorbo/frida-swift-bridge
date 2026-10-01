import { AsyncFunctionPointer } from "../abi/async-function-pointer.js";
import { AsyncTask } from "../abi/async-task.js";
import { SwiftError } from "./thrown-error.js";
import { LIBSWIFT_CORE_NAME, SWIFT_HOST_SUPPORTED } from "./platform.js";
import { ARM64E_ABI, signCode } from "../basic/pac.js";
import type { LoweredScalar, RegisterLocation } from "./calling-convention.js";
import { FloatClass, SWIFTCC, GP_ARG_REGISTERS, GP_RESULT_REGISTERS, FP_RESULT_REGISTERS, putSseScalarMove } from "./swiftcc.js";

export type { FloatClass };

const OFFSETOF_PARENT = 0;
const OFFSETOF_RESUME_PARENT = Process.pointerSize;

const ARCH = Process.arch;

const ASYNC_CONTEXT_RESUME = 0xd707;

// The continuation is entered as ResumeParent(context, results...), so results ride the argument
// registers, not the sync-return registers; error rides swiftself (x20 / r13), context is x22 / r14.
const ARG_REGS_ARM64 = SWIFTCC.gpArgs as Arm64Register[];
const ARG_REGS_X64 = SWIFTCC.gpArgs as X86Register[];
const GP_RESULT_REGS_ARM64 = ARG_REGS_ARM64.slice(0, GP_RESULT_REGISTERS);
const GP_RESULT_REGS_X64 = ARG_REGS_X64.slice(0, GP_RESULT_REGISTERS);
const NUM_ARG_REGS = GP_ARG_REGISTERS;
const NUM_GP_RESULT_REGS = GP_RESULT_REGISTERS;
const NUM_FP_RESULT_REGS = FP_RESULT_REGISTERS;
const MAX_FLOAT_REGS = 8;

const COPY_TASK_LOCALS = 1 << 10;
const ENQUEUE_JOB = 1 << 12;
const OPERATION_CONTEXT_SIZE = 512;
const TRAMPOLINE_SIZE = 0x100;
const MAX_STACK_WORD_CODE_SIZE = 24;
const DEFAULT_TIMEOUT_MS = 1000;
const DISPATCH_TIME_FOREVER = uint64("0xffffffffffffffff");
const POLL_INTERVAL_MS = 5;

export interface PlacedResultScalar {
  scalar: LoweredScalar;
  location: RegisterLocation;
}

// "scalars" is a direct result lowered per scalar, each read from the result register it was placed in.
export type AsyncResultShape =
  | { kind: "gp"; words: number }
  | { kind: "float"; cls: FloatClass; count: number }
  | { kind: "scalars"; placed: PlacedResultScalar[]; stride: number }
  | { kind: "indirect"; stride: number };

export interface AsyncFloatArg {
  bytes: NativePointer;
  cls: FloatClass;
}

export interface SerialExecutorRef {
  identity: NativePointer;
  implementation: NativePointer;
}

export interface AsyncCallOptions {
  receiver?: NativePointer;
  throws?: boolean;
  floatArgs?: AsyncFloatArg[];
  stackArgs?: NativePointer[]; // the stack argument area as words, from offset 0
  result?: AsyncResultShape;
  timeoutMs?: number; // 0 waits forever
  onActor?: SerialExecutorRef;
}

const CONCURRENCY_MODULE = Process.platform === "darwin" ? "libswift_Concurrency.dylib" : "libswift_Concurrency.so";
const DISPATCH_MODULE = Process.platform === "darwin" ? "libdispatch.dylib" : "libdispatch.so";

// find/getExportByName crash on libswift_Concurrency under Frida 17/Linux; cache enumerateExports instead.
const moduleExportTables = new Map<string, Map<string, NativePointer>>();
function moduleExport(moduleName: string, symbol: string): NativePointer {
  let exports = moduleExportTables.get(moduleName);
  if (exports === undefined) {
    exports = new Map();
    for (const e of Process.getModuleByName(moduleName).enumerateExports()) {
      exports.set(e.name, e.address);
    }
    moduleExportTables.set(moduleName, exports);
  }
  const p = exports.get(symbol);
  if (p === undefined) {
    throw new Error(`${moduleName}: no export ${symbol}`);
  }
  return p;
}

function concExport(name: string): NativePointer {
  return moduleExport(CONCURRENCY_MODULE, name);
}

// swift_task_getCurrent is SWIFT_CC(swift) with no formal args, so plain C ABI reaches it.
let getCurrentTask: (() => NativePointer) | null = null;
export function currentAsyncTask(): AsyncTask | null {
  if (!SWIFT_HOST_SUPPORTED) {
    throw new Error(`async introspection needs an arm64 Swift host, got ${Process.arch}/${Process.platform}`);
  }
  if (getCurrentTask === null) {
    getCurrentTask = new NativeFunction(concExport("swift_task_getCurrent"), "pointer", []) as unknown as () => NativePointer;
  }
  const task = getCurrentTask();
  return task.isNull() ? null : new AsyncTask(task);
}

function fpReg(cls: FloatClass, i: number): Arm64Register {
  return SWIFTCC.fpArg(cls, i) as Arm64Register;
}

function fpStride(cls: FloatClass): number {
  return cls === "double" ? 8 : 4;
}

function alignTo(n: number, alignment: number): number {
  return Math.ceil(n / alignment) * alignment;
}

function resultRegisterSlot({ register, index }: RegisterLocation): number {
  return (register === "gp" ? index : NUM_GP_RESULT_REGS + index) * 8;
}

function resultBufferSize(shape: AsyncResultShape): number {
  switch (shape.kind) {
    case "gp":
      return shape.words * Process.pointerSize;
    case "float":
      return Math.max(shape.count * fpStride(shape.cls), Process.pointerSize);
    case "scalars":
      return (NUM_GP_RESULT_REGS + NUM_FP_RESULT_REGS) * 8;
    case "indirect":
      return shape.stride;
  }
}

const TASK_OPTION_INITIAL_SERIAL_EXECUTOR = 0;

// InitialSerialExecutorTaskOptionRecord: [Flags(kind), Parent, Identity, Impl] — 4 words per TaskOptions.h.
function buildActorTaskOption(executor: SerialExecutorRef): NativePointer {
  const record = Memory.alloc(4 * Process.pointerSize);
  record.writePointer(ptr(TASK_OPTION_INITIAL_SERIAL_EXECUTOR));
  record.add(1 * Process.pointerSize).writePointer(NULL);
  record.add(2 * Process.pointerSize).writePointer(executor.identity);
  record.add(3 * Process.pointerSize).writePointer(executor.implementation);
  return record;
}

// Held for the task's lifetime so Frida keeps the trampoline pages and result buffers alive.
interface SynthesizedCall {
  shape: AsyncResultShape;
  operation: NativePointer;
  continuation: NativePointer;
  result: NativePointer;
  error: NativePointer;
  done: NativePointer;
  option: NativePointer | null;
}

// Two swiftasync trampolines (PAC stripped): `operation` allocates foo's frame, wires Parent/
// ResumeParent, loads args + self, and tail-calls foo; `continuation` captures the result/error, frees
// the frame, sets `done`, and returns through ourCtx.ResumeParent.
function synthesizeAsyncCall(afp: AsyncFunctionPointer, args: NativePointer[], options: AsyncCallOptions, signalSemaphore: NativePointer | null): SynthesizedCall {
  const shape: AsyncResultShape = options.result ?? { kind: "gp", words: 1 };
  const floatArgs = options.floatArgs ?? [];
  const gpBase = shape.kind === "indirect" ? 1 : 0;
  if (gpBase + args.length > NUM_ARG_REGS) {
    throw new Error("too many register arguments");
  }
  if (floatArgs.length > MAX_FLOAT_REGS) {
    throw new Error("too many floating-point arguments");
  }
  if (shape.kind === "gp" && (shape.words < 1 || shape.words > NUM_GP_RESULT_REGS)) {
    throw new Error("direct GP results wider than 4 words are not supported");
  }
  const swift_task_alloc = concExport("swift_task_alloc").strip();
  const swift_task_dealloc = concExport("swift_task_dealloc").strip();
  const dispatch_semaphore_signal = signalSemaphore !== null ? moduleExport(DISPATCH_MODULE, "dispatch_semaphore_signal").strip() : null;
  const result = Memory.alloc(resultBufferSize(shape));
  const error = Memory.alloc(Process.pointerSize).writePointer(NULL);
  const done = Memory.alloc(Process.pointerSize);

  const continuationCtx: ContinuationCtx = {
    shape,
    throws: options.throws === true,
    result,
    error,
    done,
    swift_task_dealloc,
    dispatch_semaphore_signal,
    signalSemaphore,
  };
  const continuation = Memory.alloc(Process.pageSize);
  Memory.patchCode(continuation, TRAMPOLINE_SIZE, (slot) => {
    if (ARCH === "arm64") {
      writeArm64Continuation(slot, continuation, continuationCtx);
    } else {
      writeX64Continuation(slot, continuation, continuationCtx);
    }
  });

  const stackArgs = options.stackArgs ?? [];
  const operationSize = TRAMPOLINE_SIZE + stackArgs.length * MAX_STACK_WORD_CODE_SIZE;
  if (operationSize > Process.pageSize) {
    throw new Error("too many stack arguments");
  }
  const operationCtx: OperationCtx = {
    afp,
    args,
    floatArgs,
    stackArgs,
    shape,
    gpBase,
    result,
    receiver: options.receiver,
    swift_task_alloc,
    continuation,
  };
  const operation = Memory.alloc(Process.pageSize);
  Memory.patchCode(operation, operationSize, (slot) => {
    if (ARCH === "arm64") {
      writeArm64Operation(slot, operation, operationCtx);
    } else {
      writeX64Operation(slot, operation, operationCtx);
    }
  });

  const option = options.onActor !== undefined ? buildActorTaskOption(options.onActor) : null;

  return { shape, operation, continuation, result, error, done, option };
}

interface ContinuationCtx {
  shape: AsyncResultShape;
  throws: boolean;
  result: NativePointer;
  error: NativePointer;
  done: NativePointer;
  swift_task_dealloc: NativePointer;
  dispatch_semaphore_signal: NativePointer | null;
  signalSemaphore: NativePointer | null;
}

interface OperationCtx {
  afp: AsyncFunctionPointer;
  args: NativePointer[];
  floatArgs: AsyncFloatArg[];
  stackArgs: NativePointer[];
  shape: AsyncResultShape;
  gpBase: number;
  result: NativePointer;
  receiver: NativePointer | undefined;
  swift_task_alloc: NativePointer;
  continuation: NativePointer;
}

function writeArm64Continuation(slot: NativePointer, pc: NativePointer, c: ContinuationCtx): void {
  const w = new Arm64Writer(slot, { pc });
  if (c.shape.kind === "gp") {
    w.putLdrRegAddress("x14", c.result);
    for (let i = 0; i < c.shape.words; i++) {
      w.putStrRegRegOffset(GP_RESULT_REGS_ARM64[i], "x14", i * Process.pointerSize);
    }
  } else if (c.shape.kind === "float") {
    w.putLdrRegAddress("x14", c.result);
    for (let i = 0; i < c.shape.count; i++) {
      w.putStrRegRegOffset(fpReg(c.shape.cls, i), "x14", i * fpStride(c.shape.cls));
    }
  } else if (c.shape.kind === "scalars") {
    w.putLdrRegAddress("x14", c.result);
    for (let i = 0; i < NUM_GP_RESULT_REGS; i++) {
      w.putStrRegRegOffset(GP_RESULT_REGS_ARM64[i], "x14", resultRegisterSlot({ register: "gp", index: i }));
    }
    for (let i = 0; i < NUM_FP_RESULT_REGS; i++) {
      w.putStrRegRegOffset(fpReg("double", i), "x14", resultRegisterSlot({ register: "fp", index: i }));
    }
  }
  if (c.throws) {
    w.putLdrRegAddress("x14", c.error);
    w.putStrRegRegOffset("x20", "x14", 0);
  }
  w.putPushRegReg("x29", "x30");
  w.putLdrRegRegOffset("x8", "x22", OFFSETOF_PARENT);
  w.putPushRegReg("x8", "x9"); // swift_task_dealloc clobbers x22
  w.putMovRegReg("x0", "x22");
  w.putLdrRegAddress("x14", c.swift_task_dealloc);
  w.putBlrRegNoAuth("x14");
  w.putLdrRegRegOffset("x22", "sp", 0);
  w.putPopRegReg("x8", "x9");
  w.putPopRegReg("x29", "x30");
  w.putLdrRegU64("x9", 1);
  w.putLdrRegAddress("x14", c.done);
  w.putStrRegRegOffset("x9", "x14", 0);
  if (c.dispatch_semaphore_signal !== null) {
    w.putPushRegReg("x22", "x30"); // preserve the async context across the call so ResumeParent survives
    w.putLdrRegAddress("x0", c.signalSemaphore!);
    w.putLdrRegAddress("x14", c.dispatch_semaphore_signal);
    w.putBlrRegNoAuth("x14");
    w.putPopRegReg("x22", "x30");
  }
  w.putLdrRegRegOffset("x1", "x22", OFFSETOF_RESUME_PARENT);
  if (ARM64E_ABI) w.putXpaciReg("x1");
  w.putBrRegNoAuth("x1");
  w.flush();
}

function writeArm64Operation(slot: NativePointer, pc: NativePointer, o: OperationCtx): void {
  const w = new Arm64Writer(slot, { pc });
  w.putPushRegReg("x29", "x30");
  w.putPushRegReg("x22", "x8"); // swift_task_alloc clobbers x22
  w.putLdrRegAddress("x0", ptr(o.afp.expectedContextSize));
  w.putLdrRegAddress("x14", o.swift_task_alloc);
  w.putBlrRegNoAuth("x14");
  w.putMovRegReg("x9", "x0");
  w.putLdrRegRegOffset("x8", "sp", 0);
  w.putStrRegRegOffset("x8", "x9", OFFSETOF_PARENT);
  w.putLdrRegAddress("x10", o.continuation);
  if (ARM64E_ABI) {
    w.putAddRegRegImm("x11", "x9", OFFSETOF_RESUME_PARENT);
    w.putMovkRegImm("x11", ASYNC_CONTEXT_RESUME, 48);
    w.putPaciaRegReg("x10", "x11");
  }
  w.putStrRegRegOffset("x10", "x9", OFFSETOF_RESUME_PARENT);
  w.putPopRegReg("x22", "x8");
  w.putPopRegReg("x29", "x30");
  if (o.shape.kind === "indirect") {
    w.putLdrRegAddress("x0", o.result); // @out rides x0, not x8 as in sync swiftcc
  }
  o.args.forEach((a, i) => w.putLdrRegAddress(ARG_REGS_ARM64[o.gpBase + i], a));
  o.floatArgs.forEach((fa, i) => {
    w.putLdrRegAddress("x14", fa.bytes);
    w.putLdrRegRegOffset(fpReg(fa.cls, i), "x14", 0);
  });
  if (o.receiver !== undefined) {
    w.putLdrRegAddress("x20", o.receiver);
  }
  if (o.stackArgs.length > 0) {
    w.putSubRegRegImm("sp", "sp", alignTo(o.stackArgs.length * 8, 16));
    o.stackArgs.forEach((word, i) => {
      w.putLdrRegAddress("x15", word);
      w.putStrRegRegOffset("x15", "sp", i * 8);
    });
  }
  w.putMovRegReg("x22", "x9");
  w.putLdrRegAddress("x14", o.afp.code);
  w.putBrRegNoAuth("x14");
  w.flush();
}

function writeX64Continuation(slot: NativePointer, pc: NativePointer, c: ContinuationCtx): void {
  const w = new X86Writer(slot, { pc });
  w.putPushReg("r15"); // callee-saved: carries the parent context across the call, and 16-aligns rsp
  if (c.shape.kind === "gp") {
    w.putMovRegAddress("r10", c.result);
    for (let i = 0; i < c.shape.words; i++) {
      w.putMovRegOffsetPtrReg("r10", i * Process.pointerSize, GP_RESULT_REGS_X64[i]);
    }
  } else if (c.shape.kind === "float") {
    w.putMovRegAddress("r10", c.result);
    for (let i = 0; i < c.shape.count; i++) {
      putSseScalarMove(w, "store", c.shape.cls, i, "r10", i * fpStride(c.shape.cls));
    }
  } else if (c.shape.kind === "scalars") {
    w.putMovRegAddress("r10", c.result);
    for (let i = 0; i < NUM_GP_RESULT_REGS; i++) {
      w.putMovRegOffsetPtrReg("r10", resultRegisterSlot({ register: "gp", index: i }), GP_RESULT_REGS_X64[i]);
    }
    for (let i = 0; i < NUM_FP_RESULT_REGS; i++) {
      putSseScalarMove(w, "store", "double", i, "r10", resultRegisterSlot({ register: "fp", index: i }));
    }
  }
  if (c.throws) {
    w.putMovRegAddress("r10", c.error);
    w.putMovRegPtrReg("r10", "r13"); // error rides swiftself (r13), mirroring arm64 x20
  }
  w.putMovRegRegOffsetPtr("r15", "r14", OFFSETOF_PARENT);
  w.putMovRegReg("rdi", "r14");
  w.putMovRegAddress("r11", c.swift_task_dealloc);
  w.putCallReg("r11");
  w.putMovRegReg("r14", "r15");
  w.putMovRegAddress("r11", c.done);
  w.putMovRegU64("r10", 1);
  w.putMovRegPtrReg("r11", "r10");
  if (c.dispatch_semaphore_signal !== null) {
    w.putMovRegAddress("rdi", c.signalSemaphore!);
    w.putMovRegAddress("r11", c.dispatch_semaphore_signal);
    w.putCallReg("r11");
  }
  w.putPopReg("r15");
  w.putMovRegRegOffsetPtr("r11", "r14", OFFSETOF_RESUME_PARENT);
  w.putJmpReg("r11");
  w.flush();
}

function writeX64Operation(slot: NativePointer, pc: NativePointer, o: OperationCtx): void {
  const w = new X86Writer(slot, { pc });
  w.putPushReg("r15"); // callee-saved: holds the task context across swift_task_alloc, and 16-aligns rsp
  w.putMovRegReg("r15", "r14");
  w.putMovRegAddress("rdi", ptr(o.afp.expectedContextSize));
  w.putMovRegAddress("r11", o.swift_task_alloc);
  w.putCallReg("r11");
  w.putMovRegOffsetPtrReg("rax", OFFSETOF_PARENT, "r15");
  w.putMovRegAddress("r10", o.continuation);
  w.putMovRegOffsetPtrReg("rax", OFFSETOF_RESUME_PARENT, "r10");
  w.putMovRegReg("r14", "rax");
  if (o.shape.kind === "indirect") {
    w.putMovRegAddress(ARG_REGS_X64[0], o.result); // @out rides arg0, not rax as in sync swiftcc
  }
  o.args.forEach((a, i) => w.putMovRegAddress(ARG_REGS_X64[o.gpBase + i], a));
  o.floatArgs.forEach((fa, i) => {
    w.putMovRegAddress("r11", fa.bytes);
    putSseScalarMove(w, "load", fa.cls, i, "r11", 0);
  });
  if (o.receiver !== undefined) {
    w.putMovRegAddress("r13", o.receiver); // swiftself
  }
  w.putPopReg("r15");
  if (o.stackArgs.length > 0) {
    // swifttailcc pops alignTo(K + 8, 16) - 8 bytes of stack args, 8 even with none, so the return
    // address moves down by the difference and the args sit above it.
    const drop = alignTo(o.stackArgs.length * 8 + 8, 16) - 16;
    w.putMovRegRegOffsetPtr("r10", "rsp", 0);
    if (drop > 0) {
      w.putSubRegImm("rsp", drop);
    }
    w.putMovRegOffsetPtrReg("rsp", 0, "r10");
    o.stackArgs.forEach((word, i) => {
      w.putMovRegAddress("r10", word);
      w.putMovRegOffsetPtrReg("rsp", 8 + i * 8, "r10");
    });
  }
  w.putMovRegAddress("r11", o.afp.code);
  w.putJmpReg("r11");
  w.flush();
}

type CreateTask = (
  flags: number,
  options: NativePointer,
  resultType: NativePointer,
  operation: NativePointer,
  closureContext: NativePointer,
  contextSize: number
) => NativePointer[];

interface DriveApi {
  create: CreateTask;
  release: (task: NativePointer) => void;
  semaphoreCreate: (value: number) => NativePointer;
  semaphoreWait: (semaphore: NativePointer, timeout: UInt64) => number;
  time: (base: UInt64, delta: Int64) => UInt64;
}
let driveApi: DriveApi | null = null;
function getDriveApi(): DriveApi {
  if (driveApi !== null) {
    return driveApi;
  }
  if (!SWIFT_HOST_SUPPORTED) {
    throw new Error(`async calls need an arm64 Swift host, got ${Process.arch}/${Process.platform}`);
  }
  const g = (name: string) => moduleExport(DISPATCH_MODULE, name);
  driveApi = {
    create: new NativeFunction(concExport("swift_task_create_common"), ["pointer", "pointer"], [
      "size_t", "pointer", "pointer", "pointer", "pointer", "size_t",
    ]) as unknown as CreateTask,
    release: new NativeFunction(moduleExport(LIBSWIFT_CORE_NAME, "swift_release"), "void", ["pointer"]),
    semaphoreCreate: new NativeFunction(g("dispatch_semaphore_create"), "pointer", ["long"]),
    semaphoreWait: new NativeFunction(g("dispatch_semaphore_wait"), "long", ["pointer", "uint64"]),
    time: new NativeFunction(g("dispatch_time"), "uint64", ["uint64", "int64"]),
  };
  return driveApi;
}

const abandoned = new Set<SynthesizedCall>();

function reapAbandoned(): void {
  for (const call of abandoned) {
    if (call.done.readU8() !== 0) {
      abandoned.delete(call);
    }
  }
}

// The continuation runs a few more instructions (frame dealloc + resume-parent branch) after it sets
// `done` and wakes us, so its page must not be freed the instant the call resolves — Frida recycling
// it under the still-running worker branches through rewritten code and segfaults. Root recent calls
// so a page outlives its worker by many generations.
const RETAINED_CALLS = 128;
const retained: SynthesizedCall[] = [];

function startCall(afp: AsyncFunctionPointer, args: NativePointer[], options: AsyncCallOptions, signalSemaphore: NativePointer | null): SynthesizedCall {
  const api = getDriveApi();
  reapAbandoned();
  const call = synthesizeAsyncCall(afp, args, options, signalSemaphore);
  retained.push(call);
  if (retained.length > RETAINED_CALLS) {
    retained.shift();
  }
  const task = api.create(ENQUEUE_JOB | COPY_TASK_LOCALS, call.option ?? NULL, NULL, signCode(call.operation), NULL, OPERATION_CONTEXT_SIZE)[0];
  if (task.isNull()) {
    throw new Error("swift_task_create_common failed");
  }
  api.release(task); // swift_task_create returns +1; enqueue holds its own ref, so drop ours (detached task)
  return call;
}

// The continuation trampoline signals this on completion; a timed-out wait restores its own count, so
// each call consumes exactly one signal and the single semaphore stays balanced across calls.
let waitSemaphore: NativePointer | null = null;
function getWaitSemaphore(api: DriveApi): NativePointer {
  if (waitSemaphore === null) {
    waitSemaphore = api.semaphoreCreate(0);
  }
  return waitSemaphore;
}

function takeResult(call: SynthesizedCall): NativePointer {
  const thrown = call.error.readPointer();
  if (!thrown.isNull()) {
    throw new SwiftError(thrown, true);
  }
  const { shape } = call;
  if (shape.kind !== "scalars") {
    return call.result;
  }
  const value = Memory.alloc(shape.stride);
  for (const { scalar, location } of shape.placed) {
    Memory.copy(value.add(scalar.offset), call.result.add(resultRegisterSlot(location)), scalar.size);
  }
  return value;
}

// Block on a dispatch semaphore (not a plain sleep) so libdispatch keeps servicing the executor; the
// continuation signals it, so a completed task wakes us the moment it finishes.
export function driveAsyncCall(afp: AsyncFunctionPointer, args: NativePointer[], options: AsyncCallOptions = {}): NativePointer {
  const api = getDriveApi();
  const semaphore = getWaitSemaphore(api);
  const call = startCall(afp, args, options, semaphore);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = timeoutMs === 0 ? DISPATCH_TIME_FOREVER : api.time(uint64(0), int64(timeoutMs * 1_000_000));
  while (call.done.readU8() === 0) {
    const timedOut = Number(api.semaphoreWait(semaphore, deadline)) !== 0;
    if (call.done.readU8() !== 0) break;
    if (timedOut) {
      abandoned.add(call); // root it: a late task may still run these trampolines
      throw new Error("async call did not complete");
    }
    // a stray signal from a late abandoned task on the shared semaphore woke us early; keep waiting
  }
  return takeResult(call);
}

export function callAsync(afp: AsyncFunctionPointer, args: NativePointer[], options: AsyncCallOptions = {}): Promise<NativePointer> {
  return new Promise((resolve, reject) => {
    let call: SynthesizedCall;
    try {
      call = startCall(afp, args, options, null);
    } catch (e) {
      reject(e);
      return;
    }
    const poll = (): void => {
      if (call.done.readU8() === 0) {
        setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }
      try {
        resolve(takeResult(call));
      } catch (e) {
        reject(e);
      }
    };
    poll();
  });
}

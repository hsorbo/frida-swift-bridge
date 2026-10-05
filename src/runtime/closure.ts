import { getSwiftCoreApi } from "./api.js";
import { markScriptOwnedErrorBox } from "./thrown-error.js";
import { ARM64E_ABI } from "../basic/pac.js";
import { GP_ARG_REGISTERS, SWIFTCC } from "./swiftcc.js";

const ARCH = Process.arch;

const CLOSURE_KEY: PointerAuthenticationKey = "ia";

// HeapObject header: [metadata, refCounts]. swift_allocObject installs strong count 1.
const HEAP_HEADER_SIZE = Process.pointerSize * 2;
const HEAP_ALIGN_MASK = Process.pointerSize - 1;
const HEAP_DESTRUCTOR_DISCRIMINATOR = 0xbbbf;

type AnyNativeCallback = NativeCallback<NativeCallbackReturnType, NativeCallbackArgumentType[]>;

export interface UnsafeRawBufferPointer {
  readonly base: NativePointer;
  readonly count: number;
  readBytes(): ArrayBuffer;
}

// result is the @out buffer (x8); returning a pointer throws it as a Swift error.
export type ClosureBody = (buffer: UnsafeRawBufferPointer, result: NativePointer) => NativePointer | void;

// Returned by a body to throw: the error becomes swifterror (x21). A class, so it can't be mistaken
// for a NativePointer result.
export class SwiftThrow {
  constructor(readonly error: NativePointer) {}
}

// Loadable closure: params arrive in registers (Frida marshals them to JS), result returns in x0/d0.
export type LoadableValue = number | boolean | NativePointer | Int64 | UInt64;
export type LoadableClosureBody = (...args: LoadableValue[]) => LoadableValue | SwiftThrow | void;

export type LoadableIndirectBody = (args: LoadableValue[], result: NativePointer) => SwiftThrow | void;

export type AnyClosureBody = (...args: any[]) => any;

// Unsigned closure request: signing needs the call-site discriminator, known only at marshal time.
export class ClosureSpec {
  constructor(readonly body: AnyClosureBody) {}
}

export function closure(body: AnyClosureBody): ClosureSpec {
  return new ClosureSpec(body);
}

interface ClosureResources {
  callback: AnyNativeCallback;
  code: NativePointer;
  slots: NativePointer;
  // populated by allocContext; held only to keep the context metadata + destroy callback alive
  metadata?: NativePointer;
  destroy?: AnyNativeCallback;
}

// Pins each closure's resources from creation until Swift's final release fires its destroy.
// Frida frees a NativeCallback / Memory.alloc when its NativePointer is unreferenced; the raw
// pointers baked into the trampoline page and context metadata do not count as references.
const liveResources = new Set<ClosureResources>();

function routeThrownError(errorSlot: NativePointer, box: NativePointer): void {
  if (!box.isNull()) {
    markScriptOwnedErrorBox(box);
  }
  errorSlot.writePointer(box);
}

export class SwiftClosure {
  readonly fnPointer: NativePointer;
  // Heap-object context Swift retains/releases like any closure capture (passed in x20 on invoke,
  // ignored by our trampoline). Owned at +1; released when this wrapper is collected.
  readonly context: NativePointer;

  private constructor(resources: ClosureResources, discriminator: number) {
    this.fnPointer = ARM64E_ABI ? resources.code.strip().sign(CLOSURE_KEY, discriminator) : resources.code;
    this.context = allocContext(resources);
    liveResources.add(resources);
    const release = getSwiftCoreApi().swift_release;
    const context = this.context;
    Script.bindWeak(this, () => {
      release(context);
    });
  }

  value(): NativePointer {
    const buffer = Memory.alloc(Process.pointerSize * 2);
    buffer.writePointer(this.fnPointer);
    buffer.add(Process.pointerSize).writePointer(this.context);
    return buffer;
  }

  static overBytes(fn: ClosureBody, discriminator: number, options: { throws?: boolean; indirectResult?: boolean } = {}): SwiftClosure {
    const slots = Memory.alloc(Process.pointerSize * 2);
    const resultSlot = slots;
    const errorSlot = slots.add(Process.pointerSize);
    const indirectResult = options.indirectResult === true;
    const callback = new NativeCallback(
      // UnsafeRawBufferPointer arrives as (base, end), not (base, count)
      ((...raw: NativePointer[]) => {
        const [result, [base, end]] = takeIndirectResult(raw, resultSlot, indirectResult);
        const count = end.sub(base).toUInt32();
        const error = fn(
          {
            base,
            count,
            readBytes: () => base.readByteArray(count) ?? new ArrayBuffer(0),
          },
          result
        );
        routeThrownError(errorSlot, error ?? ptr(0));
      }) as never,
      "void",
      indirectResultParams(["pointer", "pointer"], indirectResult)
    );
    const code = Memory.alloc(Process.pageSize);
    writeClosureTrampoline(code, {
      target: callback as NativePointer,
      resultSlot: stashedResultSlot(resultSlot),
      errorSlot,
      routesError: options.throws === true,
      twoWordResultBuffer: null,
    });
    return new SwiftClosure({ callback, code, slots }, discriminator);
  }

  // Loadable params and a loadable/Void result match the C ABI a NativeCallback already speaks
  // (swiftself in x20 and swifterror in x21 are the only swiftcc extras, both irrelevant to a
  // non-throwing direct-result closure), so the signed callback itself is the closure function.
  // Throwing needs the trampoline: only asm can set x21. So does a two-word result where the C ABI
  // returns it through a pointer, which the trampoline supplies.
  static loadable(
    body: LoadableClosureBody,
    paramTypes: NativeCallbackArgumentType[],
    resultType: NativeCallbackReturnType,
    discriminator: number,
    options: { throws?: boolean } = {}
  ): SwiftClosure {
    const params = pairedParams(paramTypes);
    const run = (...raw: LoadableValue[]): LoadableValue | SwiftThrow | void => body(...params.regroup(raw));
    const twoWordResult = SWIFTCC.cPassesPairsByPointer && Array.isArray(resultType);
    if (options.throws !== true && !twoWordResult) {
      const callback = new NativeCallback(
        ((...raw: LoadableValue[]) => coerceResult(run(...raw))) as never,
        resultType,
        params.types
      ) as AnyNativeCallback;
      return new SwiftClosure({ callback, code: callback as unknown as NativePointer, slots: ptr(0) }, discriminator);
    }
    if (twoWordResult && params.types.length > GP_ARG_REGISTERS) {
      throw new Error("a closure returning two words takes at most four words of parameters here");
    }

    const slots = Memory.alloc(Process.pointerSize * 3);
    const errorSlot = slots;
    const callback = new NativeCallback(
      ((...raw: LoadableValue[]): LoadableValue => {
        const r = run(...raw);
        routeThrownError(errorSlot, r instanceof SwiftThrow ? r.error : ptr(0));
        return r instanceof SwiftThrow ? 0 : coerceResult(r);
      }) as never,
      resultType,
      params.types
    ) as AnyNativeCallback;
    const code = Memory.alloc(Process.pageSize);
    writeClosureTrampoline(code, {
      target: callback as NativePointer,
      resultSlot: null,
      errorSlot,
      routesError: options.throws === true,
      twoWordResultBuffer: twoWordResult ? slots.add(Process.pointerSize) : null,
    });
    return new SwiftClosure({ callback, code, slots }, discriminator);
  }

  // Like loadable, but the result is written through x8 (stashed by the trampoline), as in overBytes.
  static loadableProducing(
    body: LoadableIndirectBody,
    paramTypes: NativeCallbackArgumentType[],
    discriminator: number,
    options: { throws?: boolean } = {}
  ): SwiftClosure {
    const slots = Memory.alloc(Process.pointerSize * 2);
    const resultSlot = slots;
    const errorSlot = slots.add(Process.pointerSize);
    const params = pairedParams(paramTypes);
    const callback = new NativeCallback(
      ((...raw: LoadableValue[]) => {
        const [result, args] = takeIndirectResult(raw, resultSlot, true);
        const r = body(params.regroup(args), result);
        routeThrownError(errorSlot, r instanceof SwiftThrow ? r.error : ptr(0));
      }) as never,
      "void",
      indirectResultParams(params.types, true)
    ) as AnyNativeCallback;
    const code = Memory.alloc(Process.pageSize);
    writeClosureTrampoline(code, {
      target: callback as NativePointer,
      resultSlot: stashedResultSlot(resultSlot),
      errorSlot,
      routesError: options.throws === true,
      twoWordResultBuffer: null,
    });
    return new SwiftClosure({ callback, code, slots }, discriminator);
  }
}

// Where the indirect result's pointer is an argument the callback takes it there; elsewhere it rides
// a register the trampoline stashes in the result slot.
function indirectResultParams(paramTypes: NativeCallbackArgumentType[], indirectResult: boolean): NativeCallbackArgumentType[] {
  return SWIFTCC.indirectResultIsArgument && indirectResult ? ["pointer", ...paramTypes] : paramTypes;
}

function takeIndirectResult<T>(args: T[], resultSlot: NativePointer, indirectResult: boolean): [NativePointer, T[]] {
  return SWIFTCC.indirectResultIsArgument && indirectResult ? [args[0] as NativePointer, args.slice(1)] : [resultSlot.readPointer(), args];
}

function stashedResultSlot(resultSlot: NativePointer): NativePointer | null {
  return SWIFTCC.indirectResultIsArgument ? null : resultSlot;
}

// swiftcc passes a two-word parameter as two words; where the C ABI would take it by reference, the
// callback takes the words apart and the body gets them paired again.
function pairedParams(paramTypes: NativeCallbackArgumentType[]): {
  types: NativeCallbackArgumentType[];
  regroup: (raw: LoadableValue[]) => LoadableValue[];
} {
  if (!SWIFTCC.cPassesPairsByPointer || paramTypes.every((t) => !Array.isArray(t))) {
    return { types: paramTypes, regroup: (raw) => raw };
  }
  const types = paramTypes.flatMap((t) => (Array.isArray(t) ? (t as NativeCallbackArgumentType[]) : [t]));
  const regroup = (raw: LoadableValue[]): LoadableValue[] => {
    let at = 0;
    return paramTypes.map((t) => {
      if (!Array.isArray(t)) {
        return raw[at++];
      }
      const words = raw.slice(at, at + t.length);
      at += t.length;
      return words as unknown as LoadableValue;
    });
  };
  return { types, regroup };
}

function coerceResult(r: LoadableValue | SwiftThrow | void): LoadableValue {
  return typeof r === "boolean" ? (r ? 1 : 0) : (r as LoadableValue) ?? 0;
}

// Builds the refcounted context. FullMetadata<HeapMetadata> lays the heap-metadata header at
// negative offsets: [layoutString @M-24][destroy @M-16][vwt @M-8][kind @M]. Only `destroy` is read
// on the release path (kind/vwt/layoutString are not), so the synthesized metadata sets just it.
function allocContext(resources: ClosureResources): NativePointer {
  const api = getSwiftCoreApi();
  const block = Memory.alloc(Process.pointerSize * 4);
  const metadata = block.add(Process.pointerSize * 3);
  metadata.writeU64(0x400); // HeapLocalVariable kind, defensive; never consulted on retain/release.
  resources.metadata = block;

  let context = ptr(0);
  const destroy = new NativeCallback(
    () => {
      liveResources.delete(resources);
      api.swift_deallocObject(context, HEAP_HEADER_SIZE, HEAP_ALIGN_MASK);
    },
    "void",
    []
  );
  resources.destroy = destroy;
  // arm64e libswiftCore authenticates the heap destroy slot: key IA, discriminator 0xbbbf
  // (HeapDestructor), address-diversified on the slot at metadata-16.
  const destroySlot = metadata.sub(Process.pointerSize * 2);
  destroySlot.writePointer(
    ARM64E_ABI ? destroy.strip().sign("ia", destroySlot.blend(HEAP_DESTRUCTOR_DISCRIMINATOR)) : destroy
  );

  context = api.swift_allocObject(metadata, HEAP_HEADER_SIZE, HEAP_ALIGN_MASK) as NativePointer;
  return context;
}

interface ClosureTrampolineConfig {
  target: NativePointer;
  resultSlot: NativePointer | null; // null ⇒ no x8 stash (result rides in registers)
  errorSlot: NativePointer;
  routesError: boolean;
  twoWordResultBuffer: NativePointer | null; // the callback's hidden result pointer, where the C ABI takes one
}

// Stash the @out result register (x8 / rax) for the callback, then route its error to swifterror
// (x21 / r12) only when the closure throws. Loadable args/results pass through untouched.
function writeClosureTrampoline(code: NativePointer, cfg: ClosureTrampolineConfig): void {
  if (ARCH === "arm64") {
    writeArm64ClosureTrampoline(code, cfg);
  } else {
    writeX64ClosureTrampoline(code, cfg);
  }
}

function writeArm64ClosureTrampoline(code: NativePointer, cfg: ClosureTrampolineConfig): void {
  Memory.patchCode(code, 0x80, (slot) => {
    const writer = new Arm64Writer(slot, { pc: code });

    writer.putPushRegReg("x29", "x30");

    if (cfg.resultSlot !== null) {
      writer.putLdrRegAddress("x15", cfg.resultSlot);
      writer.putStrRegRegOffset("x8", "x15", 0);
    }

    writer.putLdrRegAddress("x14", cfg.target);
    writer.putBlrReg("x14");

    if (cfg.routesError) {
      writer.putLdrRegAddress("x15", cfg.errorSlot);
      writer.putLdrRegRegOffset("x21", "x15", 0);
    }

    writer.putPopRegReg("x29", "x30");
    writer.putRet();

    writer.flush();
  });
}

function writeX64ClosureTrampoline(code: NativePointer, cfg: ClosureTrampolineConfig): void {
  Memory.patchCode(code, 0x80, (slot) => {
    const writer = new X86Writer(slot, { pc: code });

    // 16-align rsp across the call; the callee's home area, where there is one, goes below the pad
    const pad = 8 + SWIFTCC.homeAreaSize;
    writer.putSubRegImm("rsp", pad);

    if (cfg.resultSlot !== null) {
      writer.putMovRegAddress("r11", cfg.resultSlot);
      writer.putMovRegPtrReg("r11", "rax");
    }
    if (cfg.twoWordResultBuffer !== null) {
      // The hidden result pointer goes first, moving the register arguments up one; the last
      // lands in the stack slot the pad leaves above the callee's home area.
      writer.putMovRegOffsetPtrReg("rsp", SWIFTCC.homeAreaSize, "r9");
      writer.putMovRegReg("r9", "r8");
      writer.putMovRegReg("r8", "rdx");
      writer.putMovRegReg("rdx", "rcx");
      writer.putMovRegAddress("rcx", cfg.twoWordResultBuffer);
    }

    writer.putMovRegAddress("r11", cfg.target);
    writer.putCallReg("r11");

    if (cfg.twoWordResultBuffer !== null) {
      writer.putMovRegAddress("r11", cfg.twoWordResultBuffer);
      writer.putMovRegRegPtr("rax", "r11");
      writer.putMovRegRegOffsetPtr("rdx", "r11", 8);
    }
    if (cfg.routesError) {
      writer.putMovRegAddress("r11", cfg.errorSlot);
      writer.putMovRegRegPtr("r12", "r11"); // r12 = swifterror
    }

    writer.putAddRegImm("rsp", pad);
    writer.putRet();

    writer.flush();
  });
}

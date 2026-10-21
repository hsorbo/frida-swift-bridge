import { CaptureSlot, layoutCaptures } from "../abi/closure-capture.js";
import { readField } from "../abi/instance.js";
import { ValueInstance } from "../abi/value.js";
import { typeOf } from "./swift-type.js";
import type { SwiftField } from "./object-facade.js";
import type { CallArg, CallResult, SwiftClosureValue, RawInstance } from "./method.js";
import { getSwiftCoreApi } from "./api.js";
import { isOnCurrentThreadStack } from "./thread-stack.js";
import { closureCallBySignature } from "./method.js";

export type ClosureLifetime = Pick<RawInstance, "checkLive">;
type ClosureCall = (...args: CallArg[]) => CallResult;

// A signature spells escaping and non-escaping function types alike; a non-escaping context is
// allocated in its caller's frame, so one on the current thread's stack is non-escaping.
export function captureFields(closure: SwiftClosureValue, lifetime: ClosureLifetime | null): SwiftField[] {
  if (closure.context.isNull()) {
    return [];
  }
  if (isOnCurrentThreadStack(closure.context)) {
    throw new Error(
      `closure ${closure.function} is non-escaping: its context lives in the caller's frame and carries no capture descriptor to lay the captures out by`
    );
  }
  const slots = layoutCaptures(closure.context);
  if (slots === null) {
    throw new Error(
      `the captures of closure ${closure.function} cannot be laid out: its context carries no capture descriptor, or a capture's type does not resolve`
    );
  }
  return slots.map((slot) =>
    slot.storage === null ? ValueInstance.borrow(slot.type, slot.address, lifetime) : referenceStorageField(slot, lifetime)
  );
}

function referenceStorageField(slot: CaptureSlot, lifetime: ClosureLifetime | null): SwiftField {
  return {
    handle: slot.address,
    type: typeOf(slot.type),
    read() {
      lifetime?.checkLive();
      return readField(slot);
    },
    write() {
      throw new Error(`a ${slot.storage} capture is not writable through its view`);
    },
  };
}

// Shared by every closure view, so a borrowed one costs its two words and nothing per bridge member.
export const closurePrototype: object = Object.create(Function.prototype, {
  $captures: {
    value(this: SwiftClosureValue): SwiftField[] {
      return captureFields(this, null);
    },
  },
  $dispose: { value(): void {} },
  [Symbol.dispose]: { value(): void {} },
  toJSON: {
    value(this: SwiftClosureValue): { function: NativePointer; context: NativePointer } {
      return { function: this.function, context: this.context };
    },
  },
});

export function borrowedClosure(fn: NativePointer, context: NativePointer, call: ClosureCall | null = null): SwiftClosureValue {
  const view = (...args: CallArg[]): CallResult => {
    if (call === null) {
      throw new Error("a borrowed closure cannot be called: no signature is known for it; $as(signature) supplies one");
    }
    return call(...args);
  };
  Object.setPrototypeOf(view, closurePrototype);
  return Object.defineProperties(view, {
    function: { value: fn },
    context: { value: context },
    $owned: { value: false },
    $retained: { value: () => retainedClosure(fn, context, call, `at ${fn}`) },
    $as: { value: (signature: string) => borrowedClosure(fn, context, callBySignature(fn, context, signature)) },
  }) as unknown as SwiftClosureValue;
}

function callBySignature(fn: NativePointer, context: NativePointer, signature: string): ClosureCall {
  if (fn.isNull()) {
    throw new Error("a closure viewed by its context alone has no function to call");
  }
  return closureCallBySignature(fn.strip(), context, signature);
}

export function retainedClosure(fn: NativePointer, context: NativePointer, call: ClosureCall | null, label: string): SwiftClosureValue {
  if (!context.isNull()) {
    if (isOnCurrentThreadStack(context)) {
      throw new Error(
        `closure ${label} is non-escaping: its context lives in the caller's frame, which retaining cannot keep alive past the call`
      );
    }
    getSwiftCoreApi().swift_retain(context);
  }
  return ownedClosure(fn, context, call, label);
}

// Owns one reference to the context, released on dispose or collection. A closure with no known
// signature (a retained borrowed one) owns its context without being callable.
export function ownedClosure(fn: NativePointer, context: NativePointer, call: ClosureCall | null, label: string): SwiftClosureValue {
  const state = { disposed: false };
  const releaseContext = (): void => {
    state.disposed = true;
    if (!context.isNull()) {
      getSwiftCoreApi().swift_release(context);
    }
  };
  const checkLive = (): void => {
    if (state.disposed) {
      throw new Error(`closure ${label} has been disposed`);
    }
  };
  const closure = ((...args: CallArg[]): CallResult => {
    checkLive();
    if (call === null) {
      throw new Error("a retained borrowed closure cannot be called: no signature is known for it; $as(signature) supplies one");
    }
    return call(...args);
  }) as SwiftClosureValue;
  Object.setPrototypeOf(closure, closurePrototype);
  const weakId = Script.bindWeak(closure, () => {
    if (!state.disposed) {
      releaseContext();
    }
  });
  const dispose = (): void => {
    if (!state.disposed) {
      state.disposed = true;
      Script.unbindWeak(weakId);
      releaseContext();
    }
  };
  return Object.defineProperties(closure, {
    function: { value: fn },
    context: { value: context },
    $owned: { value: true },
    $captures: {
      value: (): SwiftField[] => {
        checkLive();
        return captureFields(closure, { checkLive });
      },
    },
    $retained: {
      value: (): SwiftClosureValue => {
        checkLive();
        return retainedClosure(fn, context, call, label);
      },
    },
    $as: {
      value: (signature: string): SwiftClosureValue => {
        checkLive();
        return retainedClosure(fn, context, callBySignature(fn, context, signature), label);
      },
    },
    $dispose: { value: dispose },
    [Symbol.dispose]: { value: dispose },
  });
}

import { CaptureSlot, layoutCaptures } from "../abi/closure-capture.js";
import { readField } from "../abi/instance.js";
import { ValueInstance } from "../abi/value.js";
import { typeOf } from "./swift-type.js";
import type { SwiftField } from "./object-facade.js";
import type { SwiftClosureValue, RawInstance } from "./method.js";
import { isOnCurrentThreadStack } from "./thread-stack.js";

export type ClosureLifetime = Pick<RawInstance, "checkLive">;

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

export function borrowedClosure(fn: NativePointer, context: NativePointer): SwiftClosureValue {
  const view = (): never => {
    throw new Error("a borrowed closure cannot be called: no signature is known for it");
  };
  Object.setPrototypeOf(view, closurePrototype);
  return Object.defineProperties(view, {
    function: { value: fn },
    context: { value: context },
    $owned: { value: false },
  }) as unknown as SwiftClosureValue;
}

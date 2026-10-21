import { OpaqueExistential, projectErrorExistential } from "../abi/existential.js";
import { ClassInstance } from "../abi/heap-object.js";
import { embedsManagedReference, isFacadeValueType, readValue } from "../abi/instance.js";
import { Metadata, MetadataKind } from "../abi/metadata.js";
import { ValueInstance } from "../abi/value.js";
import { getSwiftCoreApi } from "./api.js";
import { CallResult, decodeReturn } from "./method.js";
import { asSwiftObject } from "./object-facade.js";
import { typeName } from "./type-name.js";

export function projectThrownError(errorBox: NativePointer): OpaqueExistential {
  const container = Memory.alloc(Process.pointerSize).writePointer(errorBox);
  return projectErrorExistential(container);
}

// The box's value as a call result decodes one: a nominal value is copied out into a facade of its
// own, a class reference retained into an object, so neither depends on the box's lifetime.
export function decodeThrownError(errorBox: NativePointer): CallResult {
  const { type, value } = projectThrownError(errorBox);
  if (type.kind === MetadataKind.Class) {
    return asSwiftObject(ClassInstance.adopt(getSwiftCoreApi().swift_unknownObjectRetain(value.readPointer())));
  }
  if (isFacadeValueType(type) || embedsManagedReference(type)) {
    const own = Memory.alloc(Math.max(type.typeLayout.stride, 1));
    type.valueWitnesses.initializeWithCopy(own, value);
    return asSwiftObject(ValueInstance.adopt(type, own));
  }
  return readValue(type, value);
}

// Never released here: a script-injected box (SwiftThrow) may not be a real error box.
const scriptOwnedBoxes = new Set<string>();

export function markScriptOwnedErrorBox(box: NativePointer): void {
  scriptOwnedBoxes.add(box.toString());
}

interface TypedErrorValue {
  type: Metadata;
  decoded: CallResult | undefined;
  weakId: WeakRefId | null;
}

// Sync and async throws surface the same way: the raw error existential, decoded lazily so a raw
// box that is not a valid existential (as raw closure paths hand back) never forces a decode. A
// typed throw (throws(E)) has no box: `error` is the thrown value's own storage, decoded by E.
export class SwiftError extends Error {
  private typed: TypedErrorValue | null = null;
  private decoded: CallResult | undefined;

  constructor(readonly error: NativePointer, owned = false) {
    super(`Swift function threw (error at ${error})`);
    this.name = "SwiftError";
    if (owned && !scriptOwnedBoxes.delete(error.toString())) {
      const release = getSwiftCoreApi().swift_errorRelease;
      Script.bindWeak(this, () => {
        release(error);
      });
    }
  }

  // value is the +1 thrown value, destroyed with the error unless it is decoded, which consumes it.
  static typed(type: Metadata, value: NativePointer): SwiftError {
    const error = new SwiftError(value);
    error.message = `Swift function threw ${typeName(type)}`;
    const typed: TypedErrorValue = { type, decoded: undefined, weakId: null };
    if (!type.valueWitnesses.isPOD) {
      typed.weakId = Script.bindWeak(error, () => {
        if (typed.decoded === undefined) {
          type.valueWitnesses.destroy(value);
        }
      });
    }
    error.typed = typed;
    return error;
  }

  get value(): CallResult {
    const typed = this.typed;
    if (typed === null) {
      this.decoded ??= decodeThrownError(this.error);
      return this.decoded;
    }
    if (typed.decoded === undefined) {
      typed.decoded = decodeReturn(typed.type, this.error);
      if (typed.weakId !== null) {
        Script.unbindWeak(typed.weakId); // runs the callback now, which the decode has disarmed
        typed.weakId = null;
      }
    }
    return typed.decoded;
  }
}

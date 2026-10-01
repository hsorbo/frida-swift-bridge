import { Metadata, MetadataKind } from "./metadata.js";
import { readValue, writeValue, enumerateInstanceFields, swiftValueEquals, SwiftValue } from "./instance.js";
import { decodeBridgedContainer } from "./container.js";
import {
  BoundMethod,
  bindValueMethod,
  rootAsyncReceiver,
  bindGenericValueMethod,
  bindGenericTypeValueMethod,
  getProperty,
  setProperty,
  RawValueMethodResolveOptions,
  CallResult,
  CallArg,
  RawInstance,
} from "../runtime/method.js";
import { SwiftType, typeOf } from "../runtime/swift-type.js";
import { typeName } from "../runtime/type-name.js";

// qjs and v8 (Frida 17) ship no Symbol.dispose; polyfill so `using` resolves the key below.
const symbolCtor = Symbol as { dispose?: symbol };
symbolCtor.dispose ??= Symbol.for("Symbol.dispose");

interface OwnedState {
  disposed: boolean;
}

export class ValueInstance implements RawInstance {
  private weakId: WeakRefId | null = null;

  private constructor(
    readonly metadata: Metadata,
    readonly handle: NativePointer,
    private readonly state: OwnedState | null,
    private readonly parent: RawInstance | null
  ) {
    if (state !== null) {
      const vwt = metadata.valueWitnesses;
      const addr = handle;
      this.weakId = Script.bindWeak(this, () => {
        if (!state.disposed) {
          state.disposed = true;
          vwt.destroy(addr);
        }
      });
    }
  }

  static borrow(metadata: Metadata, handle: NativePointer, parent: RawInstance | null = null): ValueInstance {
    return new ValueInstance(metadata, handle, null, parent);
  }

  static fromJS(metadata: Metadata, value: SwiftValue): ValueInstance {
    const storage = Memory.alloc(metadata.typeLayout.stride);
    writeValue(metadata, storage, value);
    return new ValueInstance(metadata, storage, { disposed: false }, null);
  }

  static fromCopy(metadata: Metadata, src: NativePointer): ValueInstance {
    const storage = Memory.alloc(metadata.typeLayout.stride);
    metadata.valueWitnesses.initializeWithCopy(storage, src);
    return new ValueInstance(metadata, storage, { disposed: false }, null);
  }

  static adopt(metadata: Metadata, handle: NativePointer): ValueInstance {
    return new ValueInstance(metadata, handle, { disposed: false }, null);
  }

  get owned(): boolean {
    return this.state !== null;
  }

  get kind(): "value" {
    return "value";
  }

  get type(): SwiftType {
    return typeOf(this.metadata);
  }

  get(name: string): CallResult {
    this.checkLive();
    return getProperty(this.handle, typeName(this.metadata), name);
  }

  set(name: string, value: CallArg): void {
    this.checkLive();
    setProperty(this.handle, typeName(this.metadata), name, value);
  }

  read(): SwiftValue {
    this.checkLive();
    return readValue(this.metadata, this.handle);
  }

  write(value: SwiftValue): void {
    this.checkLive();
    const vwt = this.metadata.valueWitnesses;
    if (vwt.isPOD) {
      writeValue(this.metadata, this.handle, value);
      return;
    }
    // Assignment, not initialization: take the fresh value over the old one so it is released.
    const scratch = Memory.alloc(this.metadata.typeLayout.stride);
    writeValue(this.metadata, scratch, value);
    vwt.assignWithTake(this.handle, scratch);
  }

  container(): SwiftValue {
    this.checkLive();
    const decoded = decodeBridgedContainer(this.metadata, this.handle);
    if (decoded === null) {
      throw new Error("ValueInstance is not a bridged Array/Set/Dictionary");
    }
    return decoded.value;
  }

  field(name: string): ValueInstance {
    this.checkLive();
    if (this.metadata.kind !== MetadataKind.Struct) {
      throw new Error("ValueInstance.field is supported on struct values only");
    }
    for (const f of enumerateInstanceFields(this.metadata, this.handle)) {
      if (f.name === name) {
        if (f.type === null) {
          throw new Error(`ValueInstance.field: unresolved type for field ${name}`);
        }
        return ValueInstance.borrow(f.type, f.address, this);
      }
    }
    throw new Error(`ValueInstance.field: no field ${name}`);
  }

  method(name: string, options: RawValueMethodResolveOptions = {}): BoundMethod {
    this.checkLive();
    if (options.typeArguments !== undefined) {
      return rootAsyncReceiver(bindGenericValueMethod(this.metadata, this.handle, name, options), this);
    }
    if (this.metadata.description.isGeneric) {
      return rootAsyncReceiver(bindGenericTypeValueMethod(this.metadata, this.handle, name, options), this);
    }
    return rootAsyncReceiver(bindValueMethod(this.metadata, this.handle, name, options), this);
  }

  call(name: string, ...args: CallArg[]): CallResult | Promise<CallResult> {
    return this.method(name).call(...args);
  }

  equals(other: ValueInstance): boolean {
    this.checkLive();
    other.checkLive();
    if (!this.metadata.handle.equals(other.metadata.handle)) {
      return false;
    }
    if (this.handle.equals(other.handle)) {
      return true;
    }
    const a = readValue(this.metadata, this.handle);
    const b = readValue(other.metadata, other.handle);
    if (a === null || b === null) {
      return false;
    }
    return swiftValueEquals(a, b);
  }

  toJSON(): { kind: "value"; type: string; value?: SwiftValue; disposed?: true } {
    const type = typeName(this.metadata);
    if (this.state !== null && this.state.disposed) {
      return { kind: "value", type, disposed: true };
    }
    return { kind: "value", type, value: this.read() };
  }

  copy(): ValueInstance {
    this.checkLive();
    return ValueInstance.fromCopy(this.metadata, this.handle);
  }

  // Init uninitialized dest with a +1 copy; lets an opaque value cross a call boundary the JS writers can't.
  copyInto(dest: NativePointer): void {
    this.checkLive();
    this.metadata.valueWitnesses.initializeWithCopy(dest, this.handle);
  }

  dispose(): void {
    if (this.state === null || this.state.disposed) {
      return;
    }
    this.state.disposed = true;
    if (this.weakId !== null) {
      Script.unbindWeak(this.weakId);
      this.weakId = null;
    }
    this.metadata.valueWitnesses.destroy(this.handle);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  checkLive(): void {
    if (this.state !== null && this.state.disposed) {
      throw new Error("ValueInstance has been disposed");
    }
    this.parent?.checkLive(); // a borrowed field dangles once the instance owning its storage is disposed
  }
}

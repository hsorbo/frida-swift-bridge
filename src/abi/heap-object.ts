import { Metadata } from "./metadata.js";
import { ClassMetadata, classMetadataOf, dynamicTypeOf } from "./class-metadata.js";
import { isActor, isDefaultActor, readVTableChain, VTableEntry } from "./class-descriptor.js";
import { enumerateClassInstanceFields, readObject, SwiftValue } from "./instance.js";
import { ValueInstance } from "./value.js";
import { getSwiftCoreApi } from "../runtime/api.js";
import { objcRetainCount } from "../runtime/objc.js";
import { SwiftType, typeOf } from "../runtime/swift-type.js";
import { typeName } from "../runtime/type-name.js";
import {
  BoundMethod,
  bindResolved,
  ResolvedMethod,
  findMethod,
  bindConformanceMethod,
  actorSerialExecutor,
  bindGenericMethod,
  rootAsyncReceiver,
  bindGenericTypeClassMethod,
  RawMethodResolveOptions,
  getProperty,
  setProperty,
  CallResult,
  CallArg,
  RawInstance,
} from "../runtime/method.js";

// Also polyfilled in value.ts, but the method↔heap-object cycle can define this class first.
const symbolCtor = Symbol as { dispose?: symbol };
symbolCtor.dispose ??= Symbol.for("Symbol.dispose");

interface OwnedState {
  disposed: boolean;
}

export interface VTableInvokeSignature {
  returnType: Metadata | null;
  argTypes: Metadata[];
  throws?: boolean;
}

export class ClassInstance implements RawInstance {
  private state: OwnedState | null = null;
  private weakId: WeakRefId | null = null;

  constructor(readonly handle: NativePointer) {}

  static adopt(handle: NativePointer): ClassInstance {
    const object = new ClassInstance(handle);
    const state: OwnedState = { disposed: false };
    object.state = state;
    const release = getSwiftCoreApi().swift_unknownObjectRelease;
    object.weakId = Script.bindWeak(object, () => {
      if (!state.disposed) {
        state.disposed = true;
        release(handle);
      }
    });
    return object;
  }

  get owned(): boolean {
    return this.state !== null;
  }

  get metadata(): ClassMetadata {
    this.checkLive();
    return classMetadataOf(this.handle);
  }

  get dynamicType(): Metadata {
    this.checkLive();
    return dynamicTypeOf(this.handle);
  }

  get kind(): "object" {
    return "object";
  }

  get type(): SwiftType {
    return typeOf(this.dynamicType);
  }

  equals(other: ClassInstance | NativePointer): boolean {
    return this.handle.equals(other instanceof NativePointer ? other : other.handle);
  }

  toJSON(): { kind: "object"; type?: string; handle: string; disposed?: true } {
    if (this.state !== null && this.state.disposed) {
      return { kind: "object", handle: this.handle.toString(), disposed: true };
    }
    return { kind: "object", type: typeName(this.dynamicType), handle: this.handle.toString() };
  }

  get retainCount(): number {
    if (!classMetadataOf(this.handle).usesSwiftRefcounting) {
      return objcRetainCount(this.handle);
    }
    return Number(getSwiftCoreApi().swift_retainCount(this.handle));
  }

  get isUniquelyReferenced(): boolean {
    return Boolean(getSwiftCoreApi().swift_isUniquelyReferenced_nonNull(this.handle));
  }

  // On an owned object use dispose(), not release(): raw release plus GC release double-frees.
  retain(): this {
    getSwiftCoreApi().swift_unknownObjectRetain(this.handle);
    return this;
  }

  release(): void {
    getSwiftCoreApi().swift_unknownObjectRelease(this.handle);
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
    getSwiftCoreApi().swift_unknownObjectRelease(this.handle);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  field(name: string): ValueInstance {
    this.checkLive();
    for (const f of enumerateClassInstanceFields(this.handle)) {
      if (f.name === name) {
        if (f.type === null) {
          throw new Error(`ClassInstance.field: unresolved type for field ${name}`);
        }
        if (f.storage === "weak") {
          throw new Error(`ClassInstance.field: ${name} is weak storage, not a ${typeName(f.type)}; read it through read() or its getter`);
        }
        return ValueInstance.borrow(f.type, f.address, this);
      }
    }
    throw new Error(`ClassInstance.field: no field ${name}`);
  }

  read(): { [field: string]: SwiftValue } {
    this.checkLive();
    return readObject(this.handle);
  }

  method(name: string, options: RawMethodResolveOptions = {}): BoundMethod {
    if (options.typeArguments !== undefined) {
      return rootAsyncReceiver(bindGenericMethod(this.typeName, name, this.handle, { ...options, static: false }), this);
    }
    if (this.metadata.description.isGeneric) {
      return rootAsyncReceiver(bindGenericTypeClassMethod(this.dynamicType, this.handle, name, options), this);
    }
    const resolved = findMethod(this.typeName, name, { ...options, static: false });
    if (resolved === null) {
      return rootAsyncReceiver(bindConformanceMethod(this.typeName, this.handle, name, options), this);
    }
    let executor = null;
    if (resolved.async === true && isActor(this.metadata.description)) {
      executor = actorSerialExecutor(this.dynamicType, this.handle)
        ?? (isDefaultActor(this.metadata.description) ? { identity: this.handle, implementation: NULL } : null);
    }
    return rootAsyncReceiver(bindResolved(resolved, this.handle, { executor }), this);
  }

  get vtable(): VTableEntry[] {
    return readVTableChain(this.metadata);
  }

  vtableMethod(metadataOffset: number, signature: VTableInvokeSignature): BoundMethod {
    const entry = this.vtable.find((e) => e.metadataOffset === metadataOffset);
    if (entry === undefined) {
      throw new Error(`vtableMethod: no vtable slot at metadata offset ${metadataOffset}`);
    }
    const liveImpl = this.metadata.handle.add(metadataOffset * Process.pointerSize).readPointer().strip();
    const resolved: ResolvedMethod = {
      address: liveImpl,
      argTypes: signature.argTypes,
      returnType: signature.returnType,
      throws: signature.throws ?? false,
      isStatic: !entry.isInstance,
      selector: `#${metadataOffset}`,
    };
    return bindResolved(resolved, this.handle);
  }

  call(name: string, ...args: CallArg[]): CallResult | Promise<CallResult> {
    return this.method(name).call(...args);
  }

  get(name: string): CallResult {
    return getProperty(this.handle, this.typeName, name);
  }

  set(name: string, value: CallArg): void {
    setProperty(this.handle, this.typeName, name, value);
  }

  private get typeName(): string {
    const name = this.metadata.description.fullTypeName;
    if (name === null) {
      throw new Error("ClassInstance: class has no type name");
    }
    return name;
  }

  checkLive(): void {
    if (this.state !== null && this.state.disposed) {
      throw new Error("ClassInstance has been disposed");
    }
  }
}

import { ContextDescriptor } from "./context-descriptor.js";
import { Metadata, MetadataKind, getMetadata } from "./metadata.js";
import { Field, enumerateFields } from "./field-descriptor.js";
import { getSwiftCoreApi } from "../runtime/api.js";
import { hasResilientSuperclass } from "./class-descriptor.js";
import { getClassMetadataBounds } from "./class-metadata-bounds.js";

// Darwin class metadata carries ObjC-interop fields (cacheData[2] + data)
// between `superclass` and `flags`; non-ObjC platforms omit them, shifting
// every later field down by three words.
const OBJC_INTEROP_PREFIX = Process.platform === "darwin" ? 0x18 : 0;

const OFFSETOF_SUPERCLASS = 0x8;
const OFFSETOF_DATA = 0x20; // Darwin only (isSwift bit)
const OFFSETOF_FLAGS = 0x10 + OBJC_INTEROP_PREFIX;
const OFFSETOF_INSTANCE_SIZE = 0x18 + OBJC_INTEROP_PREFIX;
const OFFSETOF_INSTANCE_ALIGN_MASK = 0x1c + OBJC_INTEROP_PREFIX;
const OFFSETOF_DESCRIPTION = 0x28 + OBJC_INTEROP_PREFIX;

export const ROOT_CLASS_METADATA_SIZE = OFFSETOF_DESCRIPTION + 2 * Process.pointerSize;

const SWIFT_CLASS_IS_SWIFT_MASK = 2; // Darwin (ObjC interop)
const CLASS_FLAGS_USES_SWIFT_REFCOUNTING = 0x2;

const DESC_OFFSETOF_FIELD_OFFSET_VECTOR_OFFSET = 0x28;

export class ClassMetadata {
  constructor(readonly handle: NativePointer) {}

  get isTypeMetadata(): boolean {
    if (Process.platform !== "darwin") {
      return true; // no ObjC/foreign classes: any Class-kind metadata is Swift-native
    }
    return (this.handle.add(OFFSETOF_DATA).readU8() & SWIFT_CLASS_IS_SWIFT_MASK) !== 0;
  }

  get usesSwiftRefcounting(): boolean {
    if (Process.platform !== "darwin") {
      return true;
    }
    return this.isTypeMetadata && (this.handle.add(OFFSETOF_FLAGS).readU32() & CLASS_FLAGS_USES_SWIFT_REFCOUNTING) !== 0;
  }

  get superclass(): ClassMetadata | null {
    const superclass = this.handle.add(OFFSETOF_SUPERCLASS).readPointer().strip();
    return superclass.isNull() ? null : new ClassMetadata(superclass);
  }

  get instanceSize(): number {
    this.requireTypeMetadata();
    return this.handle.add(OFFSETOF_INSTANCE_SIZE).readU32();
  }

  get instanceAlignment(): number {
    this.requireTypeMetadata();
    return this.handle.add(OFFSETOF_INSTANCE_ALIGN_MASK).readU16() + 1;
  }

  get description(): ContextDescriptor {
    this.requireTypeMetadata();
    return new ContextDescriptor(this.handle.add(OFFSETOF_DESCRIPTION).readPointer().strip());
  }

  get genericArguments(): NativePointer {
    return this.handle.add(getClassMetadataBounds(this.description).immediateMembersOffset);
  }

  fieldOffset(index: number): number {
    const descriptor = this.description;
    let vectorOffset = descriptor.handle.add(DESC_OFFSETOF_FIELD_OFFSET_VECTOR_OFFSET).readU32();
    if (hasResilientSuperclass(descriptor)) {
      vectorOffset += getClassMetadataBounds(descriptor).immediateMembersOffset / Process.pointerSize;
    }
    return this.handle.add((vectorOffset + index) * Process.pointerSize).readU64().toNumber();
  }

  private requireTypeMetadata(): void {
    if (!this.isTypeMetadata) {
      throw new Error("not Swift class metadata (Objective-C or foreign class)");
    }
  }
}

export function getClassMetadata(descriptor: ContextDescriptor): ClassMetadata {
  const metadata = getMetadata(descriptor);
  if (metadata.kind !== MetadataKind.Class) {
    throw new Error("descriptor is not a class");
  }
  return new ClassMetadata(metadata.handle);
}

export function classMetadataOf(object: NativePointer): ClassMetadata {
  const type = dynamicTypeOf(object);
  if (type.kind === MetadataKind.ObjCClassWrapper) {
    return new ClassMetadata(type.handle.add(Process.pointerSize).readPointer().strip());
  }
  return new ClassMetadata(type.handle);
}

// A tagged pointer has no isa, and an instance of a Swift subclass of an ObjC class can carry a nonpointer isa.
export function dynamicTypeOf(object: NativePointer): Metadata {
  return new Metadata(getSwiftCoreApi().swift_getObjectType(object));
}

export interface FieldWithOffset {
  field: Field;
  offset: number;
}

export function* enumerateClassFields(metadata: ClassMetadata): Generator<FieldWithOffset> {
  let index = 0;
  for (const field of enumerateFields(metadata.description)) {
    yield { field, offset: metadata.fieldOffset(index) };
    index++;
  }
}

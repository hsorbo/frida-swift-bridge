import { getSwiftCoreApi } from "../runtime/api.js";
import { signCode } from "../basic/pac.js";

const OFFSETOF_INITIALIZE_BUFFER_WITH_COPY_OF_BUFFER = 0x00;
const OFFSETOF_DESTROY = 0x08;
const OFFSETOF_INITIALIZE_WITH_COPY = 0x10;
const OFFSETOF_ASSIGN_WITH_COPY = 0x18;
const OFFSETOF_INITIALIZE_WITH_TAKE = 0x20;
const OFFSETOF_ASSIGN_WITH_TAKE = 0x28;
const OFFSETOF_GET_ENUM_TAG_SINGLE_PAYLOAD = 0x30;
const OFFSETOF_STORE_ENUM_TAG_SINGLE_PAYLOAD = 0x38;
const OFFSETOF_SIZE = 0x40;
const OFFSETOF_STRIDE = 0x48;
const OFFSETOF_FLAGS = 0x50;
const OFFSETOF_EXTRA_INHABITANT_COUNT = 0x54;

const ALIGNMENT_MASK = 0xff;
const IS_NON_POD = 0x10000;
const IS_NON_INLINE = 0x20000;
const IS_NON_BITWISE_TAKABLE = 0x100000;
const IS_INCOMPLETE = 0x400000;
const IS_NON_COPYABLE = 0x800000;

export const NUM_WORDS_VALUE_BUFFER = 3;

export function allocateValueBuffer(): NativePointer {
  return Memory.alloc(NUM_WORDS_VALUE_BUFFER * Process.pointerSize);
}

export class ValueWitnessTable {
  constructor(private readonly table: NativePointer, private readonly type: NativePointer) {}

  get size(): number {
    return this.table.add(OFFSETOF_SIZE).readU64().toNumber();
  }

  get stride(): number {
    return this.table.add(OFFSETOF_STRIDE).readU64().toNumber();
  }

  get flags(): number {
    return this.table.add(OFFSETOF_FLAGS).readU32();
  }

  get extraInhabitantCount(): number {
    return this.table.add(OFFSETOF_EXTRA_INHABITANT_COUNT).readU32();
  }

  get alignmentMask(): number {
    return this.flags & ALIGNMENT_MASK;
  }

  get alignment(): number {
    return this.alignmentMask + 1;
  }

  get isPOD(): boolean {
    return (this.flags & IS_NON_POD) === 0;
  }

  get isInlineStorage(): boolean {
    return (this.flags & IS_NON_INLINE) === 0;
  }

  get isBitwiseTakable(): boolean {
    return (this.flags & IS_NON_BITWISE_TAKABLE) === 0;
  }

  get isCopyable(): boolean {
    return (this.flags & IS_NON_COPYABLE) === 0;
  }

  get isIncomplete(): boolean {
    return (this.flags & IS_INCOMPLETE) !== 0;
  }

  initializeWithCopy(dest: NativePointer, src: NativePointer): NativePointer {
    this.requireCopyable();
    return this.call3(OFFSETOF_INITIALIZE_WITH_COPY, dest, src);
  }

  initializeWithTake(dest: NativePointer, src: NativePointer): NativePointer {
    return this.call3(OFFSETOF_INITIALIZE_WITH_TAKE, dest, src);
  }

  assignWithCopy(dest: NativePointer, src: NativePointer): NativePointer {
    this.requireCopyable();
    return this.call3(OFFSETOF_ASSIGN_WITH_COPY, dest, src);
  }

  assignWithTake(dest: NativePointer, src: NativePointer): NativePointer {
    return this.call3(OFFSETOF_ASSIGN_WITH_TAKE, dest, src);
  }

  initializeBufferWithCopyOfBuffer(dest: NativePointer, src: NativePointer): NativePointer {
    this.requireCopyable();
    return this.call3(OFFSETOF_INITIALIZE_BUFFER_WITH_COPY_OF_BUFFER, dest, src);
  }

  getEnumTagSinglePayload(enumAddress: NativePointer, emptyCases: number): number {
    const fn = new NativeFunction(
      signCode(this.table.add(OFFSETOF_GET_ENUM_TAG_SINGLE_PAYLOAD).readPointer()),
      "uint",
      ["pointer", "uint", "pointer"]
    );
    return fn(enumAddress, emptyCases, this.type) as number;
  }

  storeEnumTagSinglePayload(enumAddress: NativePointer, whichCase: number, emptyCases: number): void {
    const fn = new NativeFunction(
      signCode(this.table.add(OFFSETOF_STORE_ENUM_TAG_SINGLE_PAYLOAD).readPointer()),
      "void",
      ["pointer", "uint", "uint", "pointer"]
    );
    fn(enumAddress, whichCase, emptyCases, this.type);
  }

  destroy(value: NativePointer): void {
    const fn = new NativeFunction(signCode(this.table.add(OFFSETOF_DESTROY).readPointer()), "void", [
      "pointer",
      "pointer",
    ]);
    fn(value, this.type);
  }

  projectBuffer(buffer: NativePointer): NativePointer {
    return this.isInlineStorage
      ? buffer
      : getSwiftCoreApi().swift_projectBox(buffer.readPointer());
  }

  private requireCopyable(): void {
    if (!this.isCopyable) {
      throw new Error("cannot copy a value of a noncopyable (~Copyable) type");
    }
  }

  private call3(offset: number, dest: NativePointer, src: NativePointer): NativePointer {
    const fn = new NativeFunction(signCode(this.table.add(offset).readPointer()), "pointer", [
      "pointer",
      "pointer",
      "pointer",
    ]);
    return fn(dest, src, this.type) as NativePointer;
  }
}

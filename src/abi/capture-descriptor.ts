import {
  MangledName,
  resolveTypeByMangledName,
  resolveTypeByMangledNameInEnvironment,
  symbolicMangledNameLength,
} from "./field-descriptor.js";
import { Metadata, MetadataKind } from "./metadata.js";
import { RelativeDirectPointer } from "../basic/relative-pointer.js";

// TargetHeapLocalVariableMetadata: Kind, OffsetToFirstCapture, CaptureDescription.
const OFFSETOF_HEAP_OFFSET_TO_FIRST_CAPTURE = 0x8;
const OFFSETOF_HEAP_CAPTURE_DESCRIPTION = 0x10;

const OFFSETOF_CD_NUM_CAPTURE_TYPES = 0x0;
const OFFSETOF_CD_NUM_METADATA_SOURCES = 0x4;
const OFFSETOF_CD_NUM_BINDINGS = 0x8;
const OFFSETOF_CD_RECORDS = 0xc;

const SIZEOF_CAPTURE_TYPE_RECORD = 0x4;
const SIZEOF_METADATA_SOURCE_RECORD = 0x8;

const GENERIC_PARAM_DESCRIPTOR_KEY_TYPE = 0x80;

// GENERIC-PARAM-INDEX: 'x' is depth 0 index 0, 'q' INDEX is depth 0 index + 1, 'qd' INDEX INDEX is depth + 1 index.
const MANGLED_INDEX = String.raw`(_|\d+_)`;
const GENERIC_PARAM = new RegExp(`^(?:x|q(?:d${MANGLED_INDEX})?${MANGLED_INDEX})$`);
const CLOSURE_BINDING_SOURCE = /^B(\d+)$/;

export class CaptureTypeRecord {
  constructor(readonly handle: NativePointer) {}

  get mangledTypeName(): MangledName | null {
    const ptr = RelativeDirectPointer.resolve(this.handle);
    return ptr === null ? null : { address: ptr, length: symbolicMangledNameLength(ptr) };
  }
}

export class MetadataSourceRecord {
  constructor(readonly handle: NativePointer) {}

  get mangledTypeName(): MangledName | null {
    const ptr = RelativeDirectPointer.resolve(this.handle);
    return ptr === null ? null : { address: ptr, length: symbolicMangledNameLength(ptr) };
  }

  get mangledMetadataSource(): MangledName | null {
    const ptr = RelativeDirectPointer.resolve(this.handle.add(0x4));
    return ptr === null ? null : { address: ptr, length: symbolicMangledNameLength(ptr) };
  }
}

export class CaptureDescriptor {
  constructor(readonly handle: NativePointer) {}

  get numCaptureTypes(): number {
    return this.handle.add(OFFSETOF_CD_NUM_CAPTURE_TYPES).readU32();
  }

  get numMetadataSources(): number {
    return this.handle.add(OFFSETOF_CD_NUM_METADATA_SOURCES).readU32();
  }

  get numBindings(): number {
    return this.handle.add(OFFSETOF_CD_NUM_BINDINGS).readU32();
  }

  get captureTypes(): CaptureTypeRecord[] {
    const base = this.handle.add(OFFSETOF_CD_RECORDS);
    return Array.from({ length: this.numCaptureTypes }, (_, i) =>
      new CaptureTypeRecord(base.add(i * SIZEOF_CAPTURE_TYPE_RECORD))
    );
  }

  get metadataSources(): MetadataSourceRecord[] {
    const base = this.handle
      .add(OFFSETOF_CD_RECORDS)
      .add(this.numCaptureTypes * SIZEOF_CAPTURE_TYPE_RECORD);
    return Array.from({ length: this.numMetadataSources }, (_, i) =>
      new MetadataSourceRecord(base.add(i * SIZEOF_METADATA_SOURCE_RECORD))
    );
  }
}

export function captureDescriptorOf(context: NativePointer): CaptureDescriptor | null {
  if (context.isNull()) {
    return null;
  }
  const metadata = context.readPointer().strip();
  const kind = new Metadata(metadata).kind;
  if (kind !== MetadataKind.HeapLocalVariable) {
    return null;
  }
  const description = metadata.add(OFFSETOF_HEAP_CAPTURE_DESCRIPTION).readPointer();
  return description.isNull() ? null : new CaptureDescriptor(description);
}

// bindings, if any, start at this offset and the captures follow them.
export function offsetToFirstCapture(context: NativePointer): number {
  const metadata = context.readPointer().strip();
  return metadata.add(OFFSETOF_HEAP_OFFSET_TO_FIRST_CAPTURE).readU32();
}

export function resolveCaptureType(record: CaptureTypeRecord): Metadata | null {
  const mangled = record.mangledTypeName;
  return mangled === null ? null : resolveTypeByMangledName(mangled);
}

interface BoundGenericParam {
  depth: number;
  index: number;
  metadata: NativePointer;
}

function mangledText(name: MangledName): string {
  return String.fromCharCode(...new Uint8Array(name.address.readByteArray(name.length)!));
}

function mangledIndex(text: string): number {
  return text === "_" ? 0 : parseInt(text, 10) + 1;
}

function parseGenericParam(name: MangledName | null): { depth: number; index: number } | null {
  const match = name === null ? null : GENERIC_PARAM.exec(mangledText(name));
  if (match === null) {
    return null;
  }
  if (match[2] === undefined) {
    return { depth: 0, index: 0 };
  }
  return match[1] === undefined
    ? { depth: 0, index: mangledIndex(match[2]) + 1 }
    : { depth: mangledIndex(match[1]) + 1, index: mangledIndex(match[2]) };
}

function parseClosureBindingSlot(source: MangledName | null): number | null {
  const match = source === null ? null : CLOSURE_BINDING_SOURCE.exec(mangledText(source));
  return match === null ? null : parseInt(match[1], 10);
}

// TargetGenericEnvironment: flags holding the level count, the cumulative parameter count per level,
// one key type parameter descriptor per parameter, no requirements.
function makeGenericEnvironment(params: BoundGenericParam[]): {
  environment: NativePointer;
  genericArguments: NativePointer;
} {
  const countPerLevel: number[] = [];
  for (const { depth, index } of params) {
    while (countPerLevel.length <= depth) {
      countPerLevel.push(0);
    }
    countPerLevel[depth] = Math.max(countPerLevel[depth], index + 1);
  }
  const levels = countPerLevel.length;
  const cumulative = countPerLevel.map((count, level) =>
    countPerLevel.slice(0, level + 1).reduce((sum, c) => sum + c, 0)
  );
  const total = cumulative[levels - 1];

  const environment = Memory.alloc(4 + 2 * levels + total);
  environment.writeU32(levels);
  cumulative.forEach((count, level) => environment.add(4 + 2 * level).writeU16(count));
  const descriptors = environment.add(4 + 2 * levels);
  for (let i = 0; i < total; i++) {
    descriptors.add(i).writeU8(GENERIC_PARAM_DESCRIPTOR_KEY_TYPE);
  }

  const genericArguments = Memory.alloc(total * Process.pointerSize);
  for (let i = 0; i < total; i++) {
    genericArguments.add(i * Process.pointerSize).writePointer(NULL);
  }
  for (const { depth, index, metadata } of params) {
    const flatIndex = (depth === 0 ? 0 : cumulative[depth - 1]) + index;
    genericArguments.add(flatIndex * Process.pointerSize).writePointer(metadata);
  }
  return { environment, genericArguments };
}

// A closure made in a generic function spells its capture types with that function's generic
// parameters; each metadata source names the binding slot after the heap object header holding one.
export function captureTypeResolverFromBindings(
  context: NativePointer,
  descriptor: CaptureDescriptor
): ((record: CaptureTypeRecord) => Metadata | null) | null {
  const bindings = context.add(2 * Process.pointerSize);
  const params: BoundGenericParam[] = [];
  for (const source of descriptor.metadataSources) {
    const param = parseGenericParam(source.mangledTypeName);
    const slot = parseClosureBindingSlot(source.mangledMetadataSource);
    if (param === null || slot === null) {
      return null;
    }
    params.push({ ...param, metadata: bindings.add(slot * Process.pointerSize).readPointer() });
  }
  if (params.length === 0) {
    return null;
  }
  const { environment, genericArguments } = makeGenericEnvironment(params);
  return (record) => {
    const mangled = record.mangledTypeName;
    return mangled === null ? null : resolveTypeByMangledNameInEnvironment(mangled, environment, genericArguments);
  };
}

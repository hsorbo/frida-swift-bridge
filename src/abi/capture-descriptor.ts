import {
  MangledName,
  ReferenceStorage,
  referenceStorageOf,
  resolveTypeByMangledName,
  resolveTypeByMangledNameInEnvironment,
  symbolicMangledNameLength,
} from "./field-descriptor.js";
import { Metadata, MetadataKind } from "./metadata.js";
import { ClassMetadata, classMetadataOf } from "./class-metadata.js";
import { ContextDescriptorKind, symbolicallyReferencedDescriptor } from "./context-descriptor.js";
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
// METADATA-SOURCE: 'B' slot (binding), 'R' capture (isa of a class instance), 'M' capture (a metatype),
// 'G' index source '_' (generic argument of another source's metadata).
const METADATA_SOURCE_HEAD = /^([BRMG])(\d+)/;

export class CaptureTypeRecord {
  constructor(readonly handle: NativePointer) {}

  get mangledTypeName(): MangledName | null {
    const ptr = RelativeDirectPointer.resolve(this.handle);
    return ptr === null ? null : { address: ptr, length: symbolicMangledNameLength(ptr) };
  }

  get referenceStorage(): ReferenceStorage | null {
    const ptr = RelativeDirectPointer.resolve(this.handle);
    return ptr === null ? null : referenceStorageOf(ptr);
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
    return this.handle.readU32(OFFSETOF_CD_NUM_CAPTURE_TYPES);
  }

  get numMetadataSources(): number {
    return this.handle.readU32(OFFSETOF_CD_NUM_METADATA_SOURCES);
  }

  get numBindings(): number {
    return this.handle.readU32(OFFSETOF_CD_NUM_BINDINGS);
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
  const description = metadata.readPointer(OFFSETOF_HEAP_CAPTURE_DESCRIPTION);
  return description.isNull() ? null : new CaptureDescriptor(description);
}

// bindings, if any, start at this offset and the captures follow them.
export function offsetToFirstCapture(context: NativePointer): number {
  const metadata = context.readPointer().strip();
  return metadata.readU32(OFFSETOF_HEAP_OFFSET_TO_FIRST_CAPTURE);
}

export function resolveCaptureType(record: CaptureTypeRecord): Metadata | null {
  const mangled = record.mangledTypeName;
  return mangled === null ? null : resolveTypeByMangledName(mangled);
}

interface GenericParam {
  depth: number;
  index: number;
}

interface CaptureRoot {
  kind: "referenceCapture" | "metadataCapture";
  capture: number;
}

type MetadataSource =
  | { kind: "binding"; slot: number }
  | CaptureRoot
  | { kind: "genericArgument"; index: number; base: MetadataSource };

function mangledText(name: MangledName): string {
  return String.fromCharCode(...new Uint8Array(name.address.readByteArray(name.length)!));
}

function mangledIndex(text: string): number {
  return text === "_" ? 0 : parseInt(text, 10) + 1;
}

function parseGenericParam(name: MangledName | null): GenericParam | null {
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

function parseMetadataSource(text: string, at: number): [MetadataSource, number] | null {
  const match = METADATA_SOURCE_HEAD.exec(text.slice(at));
  if (match === null) {
    return null;
  }
  const operand = parseInt(match[2], 10);
  const next = at + match[0].length;
  switch (match[1]) {
    case "B":
      return [{ kind: "binding", slot: operand }, next];
    case "R":
      return [{ kind: "referenceCapture", capture: operand }, next];
    case "M":
      return [{ kind: "metadataCapture", capture: operand }, next];
    default: {
      const base = parseMetadataSource(text, next);
      if (base === null || text[base[1]] !== "_") {
        return null;
      }
      return [{ kind: "genericArgument", index: operand, base: base[0] }, base[1] + 1];
    }
  }
}

function parseWholeMetadataSource(name: MangledName | null): MetadataSource | null {
  if (name === null) {
    return null;
  }
  const text = mangledText(name);
  const parsed = parseMetadataSource(text, 0);
  return parsed === null || parsed[1] !== text.length ? null : parsed[0];
}

function captureRoot(source: MetadataSource): CaptureRoot | null {
  switch (source.kind) {
    case "binding":
      return null;
    case "genericArgument":
      return captureRoot(source.base);
    default:
      return source;
  }
}

function withCaptureShift(source: MetadataSource, shift: number): MetadataSource {
  switch (source.kind) {
    case "binding":
      return source;
    case "genericArgument":
      return { ...source, base: withCaptureShift(source.base, shift) };
    default:
      return { ...source, capture: source.capture - shift };
  }
}

function isClassReference(record: CaptureTypeRecord): boolean {
  const mangled = record.mangledTypeName;
  if (mangled === null || !mangledText(mangled).endsWith("G")) {
    return false;
  }
  const descriptor = symbolicallyReferencedDescriptor(mangled.address);
  return descriptor !== null && descriptor.kind === ContextDescriptorKind.Class;
}

function isMetatype(record: CaptureTypeRecord): boolean {
  const mangled = record.mangledTypeName;
  return mangled !== null && /m$|XM[To]$/.test(mangledText(mangled));
}

export function isReferenceSizedCaptureType(record: CaptureTypeRecord): boolean {
  return isClassReference(record) || isMetatype(record);
}

// A capture source indexes the callee's parameters, which put the closure's explicit parameters
// before the captures; the descriptor does not record their count, so take the smallest one under
// which every source lands on a capture of its shape.
function explicitParameterCount(sources: MetadataSource[], records: CaptureTypeRecord[]): number | null {
  const roots = sources.map(captureRoot).filter((root): root is CaptureRoot => root !== null);
  if (roots.length === 0) {
    return 0;
  }
  const indices = roots.map((root) => root.capture);
  const lowest = Math.max(0, Math.max(...indices) - records.length + 1);
  for (let count = lowest; count <= Math.min(...indices); count++) {
    const fits = roots.every((root) =>
      (root.kind === "referenceCapture" ? isClassReference : isMetatype)(records[root.capture - count])
    );
    if (fits) {
      return count;
    }
  }
  return null;
}

// TargetGenericEnvironment: flags holding the level count, the cumulative parameter count per level,
// one key type parameter descriptor per parameter, no requirements. The arguments start out null.
function makeGenericEnvironment(params: GenericParam[]): {
  environment: NativePointer;
  genericArguments: NativePointer;
  flatIndexOf: (param: GenericParam) => number;
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
  cumulative.forEach((count, level) => environment.writeU16(count, 4 + 2 * level));
  const descriptors = environment.add(4 + 2 * levels);
  for (let i = 0; i < total; i++) {
    descriptors.writeU8(GENERIC_PARAM_DESCRIPTOR_KEY_TYPE, i);
  }

  const genericArguments = Memory.alloc(total * Process.pointerSize);
  for (let i = 0; i < total; i++) {
    genericArguments.writePointer(NULL, i * Process.pointerSize);
  }
  const flatIndexOf = ({ depth, index }: GenericParam) => (depth === 0 ? 0 : cumulative[depth - 1]) + index;
  return { environment, genericArguments, flatIndexOf };
}

function genericArgumentsOf(handle: NativePointer): NativePointer {
  const metadata = new Metadata(handle);
  return metadata.kind === MetadataKind.Class ? new ClassMetadata(handle).genericArguments : metadata.genericArguments;
}

// null until the capture a source reads from has been placed.
function readMetadataSource(
  context: NativePointer,
  source: MetadataSource,
  captureAddresses: NativePointer[]
): NativePointer | null {
  switch (source.kind) {
    case "binding":
      return context.readPointer((2 + source.slot) * Process.pointerSize);
    case "referenceCapture":
      return source.capture < captureAddresses.length
        ? classMetadataOf(captureAddresses[source.capture].readPointer()).handle
        : null;
    case "metadataCapture":
      return source.capture < captureAddresses.length ? captureAddresses[source.capture].readPointer() : null;
    case "genericArgument": {
      const base = readMetadataSource(context, source.base, captureAddresses);
      if (base === null) {
        return null;
      }
      return genericArgumentsOf(base).readPointer(source.index * Process.pointerSize);
    }
  }
}

// The generic parameters a closure's capture types are spelled with, filled in from the metadata
// sources as the captures they read from get placed.
export class CaptureGenericArguments {
  private constructor(
    private readonly context: NativePointer,
    private pending: { param: GenericParam; source: MetadataSource }[],
    private readonly environment: NativePointer,
    private readonly genericArguments: NativePointer,
    private readonly flatIndexOf: (param: GenericParam) => number
  ) {}

  static of(context: NativePointer, descriptor: CaptureDescriptor): CaptureGenericArguments | null {
    const entries: { param: GenericParam; source: MetadataSource }[] = [];
    for (const record of descriptor.metadataSources) {
      const param = parseGenericParam(record.mangledTypeName);
      const source = parseWholeMetadataSource(record.mangledMetadataSource);
      if (param === null || source === null) {
        return null;
      }
      entries.push({ param, source });
    }
    if (entries.length === 0) {
      return null;
    }
    const shift = explicitParameterCount(
      entries.map(({ source }) => source),
      descriptor.captureTypes
    );
    if (shift === null) {
      return null;
    }
    const { environment, genericArguments, flatIndexOf } = makeGenericEnvironment(
      entries.map(({ param }) => param)
    );
    const pending = entries.map(({ param, source }) => ({ param, source: withCaptureShift(source, shift) }));
    return new CaptureGenericArguments(context, pending, environment, genericArguments, flatIndexOf);
  }

  derive(captureAddresses: NativePointer[]): void {
    this.pending = this.pending.filter(({ param, source }) => {
      const metadata = readMetadataSource(this.context, source, captureAddresses);
      if (metadata === null) {
        return true;
      }
      this.genericArguments.writePointer(metadata, this.flatIndexOf(param) * Process.pointerSize);
      return false;
    });
  }

  resolve(record: CaptureTypeRecord): Metadata | null {
    const mangled = record.mangledTypeName;
    return mangled === null
      ? null
      : resolveTypeByMangledNameInEnvironment(mangled, this.environment, this.genericArguments);
  }
}

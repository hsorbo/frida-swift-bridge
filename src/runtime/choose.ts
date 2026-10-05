import { ClassMetadata, OFFSETOF_SUPERCLASS, OFFSETOF_DESCRIPTION } from "../abi/class-metadata.js";
import { canonicalPrespecializedMetadata } from "../abi/class-descriptor.js";
import { genericCacheEntries } from "../abi/generic-instantiation.js";
import { Metadata, MetadataKind } from "../abi/metadata.js";
import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { LIBSWIFT_CORE_NAME } from "./platform.js";
import { asSwiftObject, SwiftClassObject } from "./object-facade.js";
import { SwiftClass } from "./type-facade.js";
import { ClassType, descriptorOf, isUnboundGeneric, metadataOf } from "./swift-type.js";

export interface ChooseOptions {
  /** Also match instances of subclasses. Defaults to true. */
  subclasses?: boolean;
}

// Strips PAC and nonpointer-isa bits, so an isa or metadata word compares as the plain address. The
// nonpointer layout differs per platform and ABI, so libobjc's exported mask is the authority.
const ISA_MASK =
  Process.platform === "darwin"
    ? Module.getGlobalExportByName("objc_debug_isa_class_mask").readPointer()
    : ptr("0x00007ffffffffff8");

export function choose(cls: SwiftClass, options: ChooseOptions = {}): SwiftClassObject[] {
  if (!(cls?.$type instanceof ClassType)) {
    throw new Error("Swift.choose takes a class facade, e.g. Swift.class('Module.Name')");
  }
  const subclasses = options.subclasses ?? true;
  const unbound = isUnboundGeneric(cls.$type);
  const writable = Process.enumerateRanges("rw-");
  const heap = writable.filter((range) => !isImageRange(range));
  const imageData = writable.filter(isImageRange);

  let classes = unbound
    ? classMetadataReferencing(writable, [descriptorOf(cls.$type).handle], OFFSETOF_DESCRIPTION)
    : [new ClassMetadata(metadataOf(cls.$type).handle)];
  const instances: NativePointer[] = [];
  while (classes.length > 0) {
    const instanceSizes = new Map(classes.map((c) => [c.handle.and(ISA_MASK).toString(), c.instanceSize]));
    const isas = classes.map((c) => c.handle);
    const found: ClassMetadata[] = [];
    for (const { address, value } of findWordsEqualTo(heap, isas)) {
      if (isInstanceBlock(address, instanceSizes.get(value.and(ISA_MASK).toString())!)) {
        instances.push(address);
      } else if (subclasses) {
        const subclass = classMetadataAt(address.sub(OFFSETOF_SUPERCLASS));
        if (subclass !== null) {
          found.push(subclass);
        }
      }
    }
    if (subclasses) {
      found.push(...classMetadataReferencing(imageData, isas, OFFSETOF_SUPERCLASS));
    }
    classes = found;
  }
  return instances.map((handle) => asSwiftObject(handle));
}

// Windows never names a range's backing file; a module's own ranges are its image data.
function isImageRange(range: RangeDetails): boolean {
  return range.file !== undefined || (Process.platform === "windows" && Process.findModuleByAddress(range.base) !== null);
}

// Darwin asks the allocator. Linux has no size query that is safe on an arbitrary pointer, so the glibc
// chunk header before the block and a native refcount word that reads as live (side table, or unowned >= 1
// and not deiniting) stand in. The Windows heap's queries fault on a pointer it does not own, so there the
// refcount word alone decides, read to its full shape.
function isInstanceBlock(address: NativePointer, instanceSize: number): boolean {
  if (Process.platform === "darwin") {
    return mallocSize(address) >= instanceSize;
  }
  if (!address.and(0xf).isNull()) {
    return false;
  }
  try {
    if (Process.platform === "windows") {
      return hasNativeRefcountShape(address);
    }
    const chunkSize = address.sub(8).readU32() & ~7;
    const chunkSizeHigh = address.sub(4).readU32();
    return chunkSizeHigh === 0 && (chunkSize & 8) === 0 && chunkSize >= instanceSize + 8 && hasLiveRefcount(address);
  } catch {
    return false;
  }
}

// Inline refcounts of a live native object: PureSwiftDealloc set, a modest unowned count, not deiniting;
// or a side table. A pointer or a length stored after a class pointer rarely reads that way.
function hasNativeRefcountShape(address: NativePointer): boolean {
  const refCountsLow = address.add(8).readU32();
  const refCountsHigh = address.add(12).readU32();
  if ((refCountsHigh & 0x80000000) !== 0) {
    return true;
  }
  const unowned = refCountsLow >>> 1;
  return (refCountsLow & 1) === 1 && unowned !== 0 && unowned < 0x10000 && (refCountsHigh & 1) === 0;
}

function hasLiveRefcount(address: NativePointer): boolean {
  const refCountsLow = address.add(8).readU32();
  const refCountsHigh = address.add(12).readU32();
  return (refCountsHigh & 0x80000000) !== 0 || ((refCountsLow & 0xfffffffe) !== 0 && (refCountsHigh & 1) === 0);
}

// Every metadata built so far for a generic declaration: the compiler's specializations listed on
// the descriptor, and the runtime's generic metadata cache, through which every metadata it hands
// out for the type passes, read-only records adopted from other images included. A descriptor
// without a cache of its own, or a cache entry laid out unlike the runtime's, falls back to a scan
// of writable memory for metadata naming the descriptor at its fixed word.
export function specializedMetadataOf(descriptor: ContextDescriptor): Metadata[] {
  const seen = new Set<string>();
  const found: Metadata[] = [];
  const add = (candidate: NativePointer) => {
    if (!seen.has(candidate.toString())) {
      seen.add(candidate.toString());
      found.push(new Metadata(candidate));
    }
  };
  canonicalPrespecializedMetadata(descriptor).forEach(add);
  const cached = genericCacheEntries(descriptor)?.map((entry) => cacheEntryMetadata(descriptor, entry));
  if (cached !== undefined && cached.every((candidate) => candidate !== null)) {
    cached.forEach((candidate) => add(candidate!));
    return found;
  }
  const wordOffset = descriptor.kind === ContextDescriptorKind.Class ? OFFSETOF_DESCRIPTION : Process.pointerSize;
  for (const { address } of findWordsEqualTo(Process.enumerateRanges("rw-"), [descriptor.handle])) {
    const candidate = metadataNaming(descriptor, address.sub(wordOffset));
    if (candidate !== null) {
      add(candidate);
    }
  }
  return found;
}

// The entry's Value word follows its tracking state, signature layout and hash, and precedes its key
// arguments, so the first word reading as the type's own metadata is the value.
const CACHE_ENTRY_HEADER_WORDS = 8;

function cacheEntryMetadata(descriptor: ContextDescriptor, entry: NativePointer): NativePointer | null {
  for (let i = 0; i < CACHE_ENTRY_HEADER_WORDS; i++) {
    const candidate = metadataNaming(descriptor, entry.add(i * Process.pointerSize).readPointer());
    if (candidate !== null) {
      return candidate;
    }
  }
  return null;
}

function metadataNaming(descriptor: ContextDescriptor, candidate: NativePointer): NativePointer | null {
  const isClass = descriptor.kind === ContextDescriptorKind.Class;
  if ((isClass ? classMetadataAt(candidate) : valueMetadataAt(candidate)) === null) {
    return null;
  }
  const wordOffset = isClass ? OFFSETOF_DESCRIPTION : Process.pointerSize;
  return candidate.add(wordOffset).readPointer().strip().equals(descriptor.handle) ? candidate : null;
}

function valueMetadataAt(address: NativePointer): Metadata | null {
  try {
    const metadata = new Metadata(address);
    const kind = metadata.kind;
    return kind === MetadataKind.Struct || kind === MetadataKind.Enum || kind === MetadataKind.Optional ? metadata : null;
  } catch {
    return null;
  }
}

function classMetadataReferencing(ranges: RangeDetails[], targets: NativePointer[], wordOffset: number): ClassMetadata[] {
  const found: ClassMetadata[] = [];
  for (const { address } of findWordsEqualTo(ranges, targets)) {
    const metadata = classMetadataAt(address.sub(wordOffset));
    if (metadata !== null) {
      found.push(metadata);
    }
  }
  return found;
}

// findPointers costs per value, so many values (a generic class's specializations) go through one scan
// for their 1 MB regions, which the metadata allocator keeps few, and an exact filter of the hits.
const MANY_VALUES = 16;
const REGION_MASK = ISA_MASK.and(ptr("0xfffffffffff00000"));

function findWordsEqualTo(ranges: RangeDetails[], values: NativePointer[]): MemoryPointerMatch[] {
  if (values.length <= MANY_VALUES) {
    return Memory.findPointers(ranges, values, { mask: ISA_MASK });
  }
  const exact = new Set(values.map((value) => value.and(ISA_MASK).toString()));
  const regions = [...new Set(values.map((value) => value.and(REGION_MASK).toString()))].map((region) => ptr(region));
  return Memory.findPointers(ranges, regions, { mask: REGION_MASK }).filter((hit) =>
    exact.has(hit.value.and(ISA_MASK).toString())
  );
}

function classMetadataAt(address: NativePointer): ClassMetadata | null {
  try {
    const witnesses = new Metadata(address).valueWitnessTable;
    if (!classValueWitnessTables().some((table) => table.equals(witnesses))) {
      return null;
    }
    const metadata = new ClassMetadata(address);
    return metadata.isTypeMetadata && metadata.description.kind === ContextDescriptorKind.Class ? metadata : null;
  } catch {
    return null;
  }
}

let cachedClassValueWitnessTables: NativePointer[] | null = null;

// Class metadata carries the native-object witnesses, or the unknown-object ones when it refcounts through ObjC.
function classValueWitnessTables(): NativePointer[] {
  if (cachedClassValueWitnessTables === null) {
    const core = Process.getModuleByName(LIBSWIFT_CORE_NAME);
    cachedClassValueWitnessTables = ["$sBoWV", "$sBOWV", "$syXlWV"]
      .map((name) => core.findExportByName(name))
      .filter((table): table is NativePointer => table !== null);
  }
  return cachedClassValueWitnessTables;
}

let cachedMallocSize: ((block: NativePointer) => number) | null = null;

function mallocSize(block: NativePointer): number {
  if (cachedMallocSize === null) {
    const fn = new NativeFunction(
      Module.getGlobalExportByName(Process.platform === "darwin" ? "malloc_size" : "malloc_usable_size"),
      "size_t",
      ["pointer"]
    );
    cachedMallocSize = (b) => Number(fn(b));
  }
  return cachedMallocSize(block);
}

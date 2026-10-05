import { getMachOApi, getEnumerateMetadataSections } from "../runtime/api.js";
import { RelativeDirectPointer } from "../basic/relative-pointer.js";

const SWIFT_SEGMENT = "__TEXT";

const TYPE_REFERENCE_KIND_MASK = 0x3;
const DIRECT_TYPE_DESCRIPTOR = 0x0;
const INDIRECT_TYPE_DESCRIPTOR = 0x1;

export interface SwiftSection {
  address: NativePointer;
  size: number;
}

// Offset of each MetadataSectionRange within the runtime's MetadataSections
// struct: version, baseAddress, unused0, unused1 (4 words), then 16-byte ranges.
const BASE_ADDRESS_OFFSET = Process.pointerSize;
const RANGE_OFFSETS: Record<string, number> = {
  __swift5_protos: 4 * Process.pointerSize,
  __swift5_proto: 6 * Process.pointerSize,
  __swift5_types: 8 * Process.pointerSize,
  __swift5_acfuncs: 28 * Process.pointerSize,
};

function metadataSectionsFor(module: Module): NativePointer | null {
  let found: NativePointer | null = null;
  const body = new NativeCallback(
    (sections: NativePointer, _context: NativePointer): number => {
      if (sections.add(BASE_ADDRESS_OFFSET).readPointer().equals(module.base)) {
        found = sections;
        return 0;
      }
      return 1;
    },
    "bool",
    ["pointer", "pointer"]
  );
  getEnumerateMetadataSections()(body, NULL);
  return found;
}

function getRegisteredSwiftSection(module: Module, name: string): SwiftSection | null {
  const offset = RANGE_OFFSETS[name];
  if (offset === undefined) {
    return null;
  }
  const sections = metadataSectionsFor(module);
  if (sections === null) {
    return null;
  }
  const range = sections.add(offset);
  const size = range.add(Process.pointerSize).readU64().toNumber();
  return size === 0 ? null : { address: range.readPointer(), size };
}

// Sections the ELF and COFF runtimes leave out of MetadataSections; read by image section name.
const IMAGE_SECTION_NAMES: Record<string, string> = {
  __swift5_types2: Process.platform === "windows" ? ".sw5tym2" : "swift5_type_metadata_2",
};

function getImageSectionByName(module: Module, name: string): SwiftSection | null {
  const imageName = IMAGE_SECTION_NAMES[name];
  if (imageName === undefined) {
    return null;
  }
  for (const section of module.enumerateSections()) {
    if (section.name === imageName) {
      return section.size === 0 ? null : { address: section.address, size: section.size };
    }
  }
  return null;
}

export function getSwiftSection(module: Module, name: string): SwiftSection | null {
  if (Process.platform !== "darwin") {
    return getRegisteredSwiftSection(module, name) ?? getImageSectionByName(module, name);
  }

  const segNamePtr = Memory.allocUtf8String(SWIFT_SEGMENT);
  const sectNamePtr = Memory.allocUtf8String(name);
  const sizeOut = Memory.alloc(Process.pointerSize);

  const address = getMachOApi().getsectiondata(module.base, segNamePtr, sectNamePtr, sizeOut);
  const size = sizeOut.readU32();

  return size === 0 ? null : { address, size };
}

// Noncopyable types live in __swift5_types2, hidden from pre-SE-0390 runtimes.
export function* enumerateTypeContextDescriptors(module: Module): Generator<NativePointer> {
  yield* enumerateTypeRecords(module, "__swift5_types");
  yield* enumerateTypeRecords(module, "__swift5_types2");
}

function* enumerateTypeRecords(module: Module, sectionName: string): Generator<NativePointer> {
  const section = getSwiftSection(module, sectionName);
  if (section === null) {
    return;
  }

  const count = section.size / RelativeDirectPointer.sizeOf;
  for (let i = 0; i < count; i++) {
    const record = section.address.add(i * RelativeDirectPointer.sizeOf);
    const descriptor = resolveTypeMetadataRecord(record);
    if (descriptor !== null) {
      yield descriptor;
    }
  }
}

function resolveTypeMetadataRecord(record: NativePointer): NativePointer | null {
  const raw = record.readS32();
  const offset = raw & ~TYPE_REFERENCE_KIND_MASK;
  if (offset === 0) {
    return null;
  }
  const direct = record.add(offset);
  switch (raw & TYPE_REFERENCE_KIND_MASK) {
    case DIRECT_TYPE_DESCRIPTOR:
      return direct;
    case INDIRECT_TYPE_DESCRIPTOR:
      return direct.readPointer().strip();
    default:
      return null;
  }
}

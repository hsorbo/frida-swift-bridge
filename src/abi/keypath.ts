import { Metadata, MetadataKind } from "./metadata.js";
import { ClassMetadata, classMetadataOf, enumerateClassFields } from "./class-metadata.js";
import { enumerateFields } from "./field-descriptor.js";
import { existentialProtocols } from "./existential.js";
import { readProtocolRequirements } from "./protocol-descriptor.js";
import { namedProtocolRequirements } from "../runtime/method.js";
import { signCode } from "../basic/pac.js";

const BUFFER_SIZE_MASK = 0x00ffffff;
const BUFFER_TRIVIAL_FLAG = 0x80000000;
const BUFFER_HAS_REFERENCE_PREFIX_FLAG = 0x40000000;
const BUFFER_IS_SINGLE_COMPONENT_FLAG = 0x20000000;

const DISCRIMINATOR_MASK = 0x7f000000;
const DISCRIMINATOR_SHIFT = 24;

const STRUCT_TAG = 1;
const COMPUTED_TAG = 2;
const CLASS_TAG = 3;
const OPTIONAL_TAG = 4;

const STORED_OFFSET_PAYLOAD_MASK = 0x007fffff;
const MAXIMUM_OFFSET_PAYLOAD = 0x007ffffc;
const OUT_OF_LINE_OFFSET_PAYLOAD = 0x007fffff;
const STORED_MUTABLE_FLAG = 0x00800000;

const OPTIONAL_CHAIN_PAYLOAD = 0;
const OPTIONAL_WRAP_PAYLOAD = 1;

const END_OF_REFERENCE_PREFIX_FLAG = 0x80000000;

const COMPUTED_MUTATING_FLAG = 0x00800000;
const COMPUTED_SETTABLE_FLAG = 0x00400000;
const COMPUTED_ID_BY_STORED_PROPERTY_FLAG = 0x00200000;
const COMPUTED_ID_BY_VTABLE_OFFSET_FLAG = 0x00100000;
const COMPUTED_HAS_ARGUMENTS_FLAG = 0x00080000;
const COMPUTED_INSTANTIATED_FROM_EXTERNAL_WITH_ARGUMENTS_FLAG = 0x00000010;
const COMPUTED_ID_RESOLUTION_MASK = 0x0000000f;

const STRUCT_DESC_FIELD_OFFSET_VECTOR_OFFSET = 0x18;

const HEADER_WORD_SIZE = Process.pointerSize;
const POINTER_ALIGNMENT_SKEW = Process.pointerSize - 4;
const ARGUMENT_SIZE_MASK = uint64("0x3fffffffffffffff");
const ARGUMENT_PADDING_MASK = uint64("0x4000000000000000");

export type KeyPathComponent =
  | StoredKeyPathComponent
  | OptionalKeyPathComponent
  | ComputedKeyPathComponent;

interface KeyPathComponentBase {
  endOfReferencePrefix: boolean;
  nextType: Metadata | null;
}

export interface StoredKeyPathComponent extends KeyPathComponentBase {
  kind: "struct" | "class";
  offset: number | null;
  mutable: boolean;
}

export interface OptionalKeyPathComponent extends KeyPathComponentBase {
  kind: "optionalChain" | "optionalWrap" | "optionalForce";
}

export interface KeyPathComputedArgumentWitnesses {
  destroy: NativePointer | null;
  copy: NativePointer;
  equals: NativePointer;
  hash: NativePointer;
}

export interface KeyPathComputedArguments {
  size: number;
  data: NativePointer;
  witnesses: KeyPathComputedArgumentWitnesses;
}

export interface ComputedKeyPathComponent extends KeyPathComponentBase {
  kind: "computed";
  settable: boolean;
  mutating: boolean;
  idKind: "pointer" | "storedPropertyIndex" | "vtableOffset";
  idResolution: "resolved" | "resolvedAbsolute" | "indirectPointer" | "functionCall";
  id: NativePointer;
  getter: NativePointer;
  setter: NativePointer | null;
  arguments: KeyPathComputedArguments | null;
}

export interface KeyPathBuffer {
  trivial: boolean;
  hasReferencePrefix: boolean;
  isSingleComponent: boolean;
  components: KeyPathComponent[];
}

function alignUp(value: number, alignment: number): number {
  return (value + alignment - 1) & ~(alignment - 1);
}

export function readKeyPathBuffer(handle: NativePointer): KeyPathBuffer {
  const bufferBase = handle.add(alignUp(classMetadataOf(handle).instanceSize, 4));
  const header = bufferBase.readU32();
  const dataStart = bufferBase.add(HEADER_WORD_SIZE);
  const end = dataStart.add(header & BUFFER_SIZE_MASK);

  const components: KeyPathComponent[] = [];
  let pos = dataStart;
  while (pos.compare(end) < 0) {
    const componentHeader = pos.readU32();
    const body = pos.add(4);
    pos = body.add(bodySize(componentHeader, body));

    let nextType: Metadata | null = null;
    if (pos.compare(end) < 0) {
      pos = pos.add(Process.pointerSize - 1).and(ptr(Process.pointerSize - 1).not());
      nextType = new Metadata(pos.readPointer().strip());
      pos = pos.add(Process.pointerSize);
    }

    components.push(decodeComponent(componentHeader, body, nextType));
  }

  return {
    trivial: (header & BUFFER_TRIVIAL_FLAG) !== 0,
    hasReferencePrefix: (header & BUFFER_HAS_REFERENCE_PREFIX_FLAG) !== 0,
    isSingleComponent: (header & BUFFER_IS_SINGLE_COMPONENT_FLAG) !== 0,
    components,
  };
}

function discriminator(header: number): number {
  return (header & DISCRIMINATOR_MASK) >>> DISCRIMINATOR_SHIFT;
}

function bodySize(header: number, body: NativePointer): number {
  switch (discriminator(header)) {
    case STRUCT_TAG:
    case CLASS_TAG:
      return (header & STORED_OFFSET_PAYLOAD_MASK) === OUT_OF_LINE_OFFSET_PAYLOAD ? 4 : 0;
    case OPTIONAL_TAG:
      return 0;
    case COMPUTED_TAG: {
      const settable = (header & COMPUTED_SETTABLE_FLAG) !== 0;
      let total = POINTER_ALIGNMENT_SKEW + Process.pointerSize * (settable ? 3 : 2);
      if ((header & COMPUTED_HAS_ARGUMENTS_FLAG) !== 0) {
        total += Process.pointerSize * 2 + computedArgumentSize(body.add(total));
        if ((header & COMPUTED_INSTANTIATED_FROM_EXTERNAL_WITH_ARGUMENTS_FLAG) !== 0) {
          total += Process.pointerSize;
        }
      }
      return total;
    }
    default:
      throw new Error(`unexpected key path component discriminator ${discriminator(header)}`);
  }
}

function readArgumentSizeWord(argumentHeader: NativePointer): { argumentSize: number; padding: number } {
  const raw = argumentHeader.readU64();
  return {
    argumentSize: raw.and(ARGUMENT_SIZE_MASK).toNumber(),
    padding: raw.and(ARGUMENT_PADDING_MASK).equals(0) ? 0 : Process.pointerSize,
  };
}

function computedArgumentSize(argumentHeader: NativePointer): number {
  const { argumentSize, padding } = readArgumentSizeWord(argumentHeader);
  return argumentSize + padding;
}

function decodeComputedArguments(argumentHeader: NativePointer, external: boolean): KeyPathComputedArguments {
  const { argumentSize, padding } = readArgumentSizeWord(argumentHeader);
  const witnessTable = argumentHeader.add(Process.pointerSize).readPointer().strip();
  const data = argumentHeader.add(Process.pointerSize * (external ? 3 : 2)).add(padding);
  const destroy = witnessTable.readPointer().strip();
  return {
    size: argumentSize,
    data,
    witnesses: {
      destroy: destroy.isNull() ? null : destroy,
      copy: witnessTable.add(Process.pointerSize).readPointer().strip(),
      equals: witnessTable.add(Process.pointerSize * 2).readPointer().strip(),
      hash: witnessTable.add(Process.pointerSize * 3).readPointer().strip(),
    },
  };
}

export function hashKeyPathArguments(args: KeyPathComputedArguments): Int64 {
  const hash = new NativeFunction(signCode(args.witnesses.hash), "int64", ["pointer", "int64"]) as unknown as (
    data: NativePointer,
    size: number
  ) => Int64;
  return hash(args.data, args.size);
}

export function keyPathArgumentsEqual(a: KeyPathComputedArguments, b: KeyPathComputedArguments): boolean {
  if (a.size !== b.size) {
    return false;
  }
  const equals = new NativeFunction(signCode(a.witnesses.equals), "bool", ["pointer", "pointer", "int64"]) as unknown as (
    x: NativePointer,
    y: NativePointer,
    size: number
  ) => number;
  return !!equals(a.data, b.data, a.size);
}

function decodeComponent(
  header: number,
  body: NativePointer,
  nextType: Metadata | null
): KeyPathComponent {
  const endOfReferencePrefix = (header & END_OF_REFERENCE_PREFIX_FLAG) !== 0;
  const kind = discriminator(header);

  if (kind === STRUCT_TAG || kind === CLASS_TAG) {
    const payload = header & STORED_OFFSET_PAYLOAD_MASK;
    const offset =
      payload <= MAXIMUM_OFFSET_PAYLOAD
        ? payload
        : payload === OUT_OF_LINE_OFFSET_PAYLOAD
          ? body.readU32()
          : null;
    return {
      kind: kind === STRUCT_TAG ? "struct" : "class",
      offset,
      mutable: (header & STORED_MUTABLE_FLAG) !== 0,
      endOfReferencePrefix,
      nextType,
    };
  }

  if (kind === OPTIONAL_TAG) {
    const payload = header & STORED_OFFSET_PAYLOAD_MASK;
    return {
      kind:
        payload === OPTIONAL_CHAIN_PAYLOAD
          ? "optionalChain"
          : payload === OPTIONAL_WRAP_PAYLOAD
            ? "optionalWrap"
            : "optionalForce",
      endOfReferencePrefix,
      nextType,
    };
  }

  const settable = (header & COMPUTED_SETTABLE_FLAG) !== 0;
  const idField = body.add(POINTER_ALIGNMENT_SKEW);
  const getterField = idField.add(Process.pointerSize);
  const setterField = getterField.add(Process.pointerSize);
  const hasArguments = (header & COMPUTED_HAS_ARGUMENTS_FLAG) !== 0;
  const external = (header & COMPUTED_INSTANTIATED_FROM_EXTERNAL_WITH_ARGUMENTS_FLAG) !== 0;
  const argumentHeader = (settable ? setterField : getterField).add(Process.pointerSize);

  return {
    kind: "computed",
    settable,
    mutating: (header & COMPUTED_MUTATING_FLAG) !== 0,
    idKind:
      (header & COMPUTED_ID_BY_STORED_PROPERTY_FLAG) !== 0
        ? "storedPropertyIndex"
        : (header & COMPUTED_ID_BY_VTABLE_OFFSET_FLAG) !== 0
          ? "vtableOffset"
          : "pointer",
    idResolution: idResolution(header),
    id: idField.readPointer(),
    getter: getterField.readPointer().strip(),
    setter: settable ? setterField.readPointer().strip() : null,
    arguments: hasArguments ? decodeComputedArguments(argumentHeader, external) : null,
    endOfReferencePrefix,
    nextType,
  };
}

function idResolution(header: number): ComputedKeyPathComponent["idResolution"] {
  switch (header & COMPUTED_ID_RESOLUTION_MASK) {
    case 0x0:
      return "resolved";
    case 0x3:
      return "resolvedAbsolute";
    case 0x2:
      return "indirectPointer";
    default:
      return "functionCall";
  }
}

// Names each component with the property it steps through, given the keypath's root type. A
// `pointer`-id computed component (plain getter) stays null — its property descriptor address
// carries no name recoverable from the root type alone.
export function resolveKeyPathNames(
  components: KeyPathComponent[],
  root: Metadata
): (string | null)[] {
  const names: (string | null)[] = [];
  let container: Metadata | null = root;
  for (const component of components) {
    names.push(container === null ? null : nameForComponent(component, container));
    container = component.nextType;
  }
  return names;
}

function nameForComponent(component: KeyPathComponent, container: Metadata): string | null {
  switch (component.kind) {
    case "struct":
    case "class":
      return component.offset === null ? null : fieldNameByOffset(container, component.offset);
    case "computed":
      if (component.idKind === "storedPropertyIndex") {
        return fieldNameByIndex(container, component.id.toUInt32());
      }
      if (component.idKind === "vtableOffset") {
        return protocolRequirementName(container, component.id);
      }
      return null;
    default:
      return null;
  }
}

function protocolRequirementName(container: Metadata, id: NativePointer): string | null {
  if (container.kind !== MetadataKind.Existential && container.kind !== MetadataKind.ExtendedExistential) {
    return null;
  }
  const protocols = existentialProtocols(container);
  if (protocols.length !== 1) {
    return null; // a composition can't say which protocol the index belongs to
  }
  const protocol = protocols[0];
  const entryIndex = -id.toInt32(); // IRGen stores the witness-table entry index negated
  const requirements = readProtocolRequirements(protocol);
  if (entryIndex < 0 || entryIndex >= requirements.length) {
    return null;
  }
  const witnessIndex = requirements[entryIndex].witnessIndex;
  const named = namedProtocolRequirements(protocol).find(
    (n) => n.requirement.witnessIndex === witnessIndex
  );
  return named?.name ?? null;
}

function fieldNameByOffset(container: Metadata, offset: number): string | null {
  if (container.kind === MetadataKind.Class) {
    let cls: ClassMetadata | null = new ClassMetadata(container.handle);
    while (cls !== null && cls.isTypeMetadata) {
      for (const { field, offset: fieldOffset } of enumerateClassFields(cls)) {
        if (fieldOffset === offset) {
          return field.name;
        }
      }
      cls = cls.superclass;
    }
    return null;
  }

  const descriptor = container.description;
  const vectorOffset = descriptor.handle.add(STRUCT_DESC_FIELD_OFFSET_VECTOR_OFFSET).readU32();
  if (vectorOffset === 0) {
    return null;
  }
  const offsets = container.handle.add(vectorOffset * Process.pointerSize);
  let index = 0;
  for (const field of enumerateFields(descriptor)) {
    if (offsets.add(index * 4).readU32() === offset) {
      return field.name;
    }
    index++;
  }
  return null;
}

function fieldNameByIndex(container: Metadata, index: number): string | null {
  const names =
    container.kind === MetadataKind.Class
      ? classFieldNames(new ClassMetadata(container.handle))
      : [...enumerateFields(container.description)].map((f) => f.name);
  return index < names.length ? names[index] : null;
}

// Root-first, matching IRGen's getClassFieldIndex, which counts stored properties from the Swift
// native root down through the subclasses.
function classFieldNames(metadata: ClassMetadata): string[] {
  const perClass: string[][] = [];
  let cls: ClassMetadata | null = metadata;
  while (cls !== null && cls.isTypeMetadata) {
    perClass.push([...enumerateFields(cls.description)].map((f) => f.name));
    cls = cls.superclass;
  }
  return perClass.reverse().flat();
}

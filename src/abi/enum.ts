import { Metadata } from "./metadata.js";
import { Field, enumerateFields, fieldTypeIn } from "./field-descriptor.js";
import { getSwiftCoreApi } from "../runtime/api.js";
import { signCode } from "../basic/pac.js";

const VWT_OFFSETOF_GET_ENUM_TAG = 0x58;
const VWT_OFFSETOF_DESTRUCTIVE_PROJECT_ENUM_DATA = 0x60;
const VWT_OFFSETOF_DESTRUCTIVE_INJECT_ENUM_TAG = 0x68;

export interface EnumCase {
  name: string;
  tag: number;
  payloadType: Metadata | null;
  isIndirect: boolean;
}

interface SinglePayload {
  payload: Metadata;
  emptyCases: number;
}

// Discriminated via the payload's always-present single-payload witnesses, not the
// enum-only getEnumTag which the Optional<class> VWT drops when it borrows the payload's.
function singlePayload(metadata: Metadata, cases: Field[]): SinglePayload | null {
  if (cases.length < 2) {
    return null;
  }
  let payloadField: Field | null = null;
  for (const field of cases) {
    if (field.mangledTypeName === null) {
      continue;
    }
    if (field.isIndirectCase || payloadField !== null) {
      return null;
    }
    payloadField = field;
  }
  if (payloadField === null) {
    return null;
  }
  const payload = fieldTypeIn(metadata, payloadField);
  return payload === null ? null : { payload, emptyCases: cases.length - 1 };
}

export function projectBox(box: NativePointer): NativePointer {
  return getSwiftCoreApi().swift_projectBox(box);
}

export function enumTag(metadata: Metadata, address: NativePointer): number {
  const fn = new NativeFunction(
    signCode(metadata.valueWitnessTable.readPointer(VWT_OFFSETOF_GET_ENUM_TAG)),
    "uint",
    ["pointer", "pointer"]
  );
  return fn(address, metadata.handle) as number;
}

export function readEnumCase(metadata: Metadata, address: NativePointer): EnumCase {
  const cases = [...enumerateFields(metadata.description)];
  const sp = singlePayload(metadata, cases);
  const tag =
    sp !== null
      ? sp.payload.valueWitnesses.getEnumTagSinglePayload(address, sp.emptyCases)
      : enumTag(metadata, address);
  const field = cases[tag];
  if (field === undefined) {
    throw new Error(`enum tag ${tag} out of range (${cases.length} cases)`);
  }
  return {
    name: field.name,
    tag,
    payloadType: field.mangledTypeName !== null ? fieldTypeIn(metadata, field) : null,
    isIndirect: field.isIndirectCase,
  };
}

export function projectEnumData(metadata: Metadata, address: NativePointer): void {
  const fn = new NativeFunction(
    signCode(metadata.valueWitnessTable.readPointer(VWT_OFFSETOF_DESTRUCTIVE_PROJECT_ENUM_DATA)),
    "void",
    ["pointer", "pointer"]
  );
  fn(address, metadata.handle);
}

export function injectEnumTag(metadata: Metadata, address: NativePointer, tag: number): void {
  const fn = new NativeFunction(
    signCode(metadata.valueWitnessTable.readPointer(VWT_OFFSETOF_DESTRUCTIVE_INJECT_ENUM_TAG)),
    "void",
    ["pointer", "uint", "pointer"]
  );
  fn(address, tag, metadata.handle);
}

export function setEnumTag(metadata: Metadata, address: NativePointer, tag: number): void {
  const cases = [...enumerateFields(metadata.description)];
  const sp = singlePayload(metadata, cases);
  if (sp !== null) {
    sp.payload.valueWitnesses.storeEnumTagSinglePayload(address, tag, sp.emptyCases);
  } else {
    injectEnumTag(metadata, address, tag);
  }
}

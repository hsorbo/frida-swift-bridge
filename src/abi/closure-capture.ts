import {
  CaptureGenericArguments,
  CaptureTypeRecord,
  captureDescriptorOf,
  isReferenceSizedCaptureType,
  offsetToFirstCapture,
  resolveCaptureType,
} from "./capture-descriptor.js";
import { Metadata, MetadataKind } from "./metadata.js";
import { classMetadataOf } from "./class-metadata.js";
import { readValue, writeValue, SwiftValue } from "./instance.js";

export interface CaptureSlot {
  type: Metadata;
  address: NativePointer;
}

// null: no closure, a generic parameter no metadata source supplies, or an unresolved capture type.
export function layoutCaptures(context: NativePointer): CaptureSlot[] | null {
  const direct = layoutCapturesAt(context);
  if (direct !== null) {
    return direct;
  }
  const inner = unwrapReabstractionThunk(context);
  if (inner !== null) {
    return layoutCapturesAt(inner);
  }
  return layoutSoleClassCapture(context);
}

// escaping closures wrap in a reabstraction thunk with an unresolvable mangled name; detection is structural.
export function unwrapReabstractionThunk(context: NativePointer): NativePointer | null {
  const descriptor = captureDescriptorOf(context);
  if (descriptor === null || descriptor.numBindings !== 0 || descriptor.numCaptureTypes !== 1) {
    return null;
  }
  try {
    const inner = context.add(offsetToFirstCapture(context)).add(Process.pointerSize).readPointer();
    return captureDescriptorOf(inner) !== null ? inner : null;
  } catch {
    return null;
  }
}

// sole unresolved capture holding an indirect class reference at its second word.
function layoutSoleClassCapture(context: NativePointer): CaptureSlot[] | null {
  const descriptor = captureDescriptorOf(context);
  if (descriptor === null || descriptor.numBindings !== 0 || descriptor.numCaptureTypes !== 1) {
    return null;
  }
  const address = context.add(offsetToFirstCapture(context)).add(Process.pointerSize);
  try {
    const type = new Metadata(classMetadataOf(address.readPointer()).handle);
    return type.kind === MetadataKind.Class ? [{ type, address }] : null;
  } catch {
    return null;
  }
}

// A class reference or metatype capture is placed before its type resolves, since the generic
// parameters that type needs may come from the capture itself.
function layoutCapturesAt(context: NativePointer): CaptureSlot[] | null {
  const descriptor = captureDescriptorOf(context);
  if (descriptor === null) {
    return null;
  }
  const generic = descriptor.numBindings > 0 || descriptor.numMetadataSources > 0;
  const generics = generic ? CaptureGenericArguments.of(context, descriptor) : null;
  if (generic && generics === null) {
    return null;
  }
  const resolve = (record: CaptureTypeRecord) =>
    generics === null ? resolveCaptureType(record) : generics.resolve(record);

  const records = descriptor.captureTypes;
  let offset = offsetToFirstCapture(context) + descriptor.numBindings * Process.pointerSize;
  const addresses: NativePointer[] = [];
  const types: (Metadata | null)[] = [];
  for (const record of records) {
    generics?.derive(addresses);
    const type = resolve(record);
    if (type === null && !(generics !== null && isReferenceSizedCaptureType(record))) {
      return null;
    }
    const { size, alignment } =
      type === null ? { size: Process.pointerSize, alignment: Process.pointerSize } : type.typeLayout;
    if (size !== 0) {
      offset = (offset + alignment - 1) & ~(alignment - 1);
    }
    addresses.push(context.add(offset));
    types.push(type);
    offset += size;
  }
  generics?.derive(addresses);

  const slots: CaptureSlot[] = [];
  for (let i = 0; i < records.length; i++) {
    const type = types[i] ?? resolve(records[i]);
    if (type === null) {
      return null;
    }
    slots.push({ type, address: addresses[i] });
  }
  return slots;
}

export function readCaptures(context: NativePointer): SwiftValue[] | null {
  const slots = layoutCaptures(context);
  return slots === null ? null : slots.map(({ type, address }) => readValue(type, address));
}

export function writeCaptures(context: NativePointer, values: SwiftValue[]): void {
  const slots = layoutCaptures(context);
  if (slots === null) {
    throw new Error("writeCaptures: capture layout is not resolvable for this context");
  }
  if (values.length !== slots.length) {
    throw new Error(`writeCaptures: expected ${slots.length} value(s), got ${values.length}`);
  }
  if (slots.some(({ type }) => type.kind === MetadataKind.Class)) {
    throw new Error("writeCaptures: writing a class-typed capture is not supported");
  }
  slots.forEach(({ type, address }, i) => {
    const scratch = Memory.alloc(type.typeLayout.stride);
    writeValue(type, scratch, values[i]);
    type.valueWitnesses.assignWithTake(address, scratch);
  });
}

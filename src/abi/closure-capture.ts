import { captureDescriptorOf, offsetToFirstCapture, resolveCaptureType } from "./capture-descriptor.js";
import { Metadata, MetadataKind } from "./metadata.js";
import { classMetadataOf } from "./class-metadata.js";
import { readValue, writeValue, SwiftValue } from "./instance.js";

export interface CaptureSlot {
  type: Metadata;
  address: NativePointer;
}

// null: no closure, generic-bound, or an unresolved capture type.
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

function layoutCapturesAt(context: NativePointer): CaptureSlot[] | null {
  const descriptor = captureDescriptorOf(context);
  if (descriptor === null || descriptor.numBindings > 0) {
    return null;
  }

  let offset = offsetToFirstCapture(context);
  const slots: CaptureSlot[] = [];
  for (const record of descriptor.captureTypes) {
    const type = resolveCaptureType(record);
    if (type === null) {
      return null;
    }
    const { size, alignment } = type.typeLayout;
    if (size !== 0) {
      offset = (offset + alignment - 1) & ~(alignment - 1);
    }
    slots.push({ type, address: context.add(offset) });
    offset += size;
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

import {
  CaptureGenericArguments,
  CaptureTypeRecord,
  captureDescriptorOf,
  isReferenceSizedCaptureType,
  isThickFunctionCaptureType,
  offsetToFirstCapture,
  resolveCaptureType,
  resolveLoweredFunctionCapture,
} from "./capture-descriptor.js";
import { Metadata, MetadataKind, TypeLayout } from "./metadata.js";
import { classMetadataOf } from "./class-metadata.js";
import { readField, SwiftValue } from "./instance.js";
import { ReferenceStorage } from "./field-descriptor.js";

export interface CaptureSlot {
  type: Metadata;
  address: NativePointer;
  storage: ReferenceStorage | null;
}

// null: no closure, a generic parameter no metadata source supplies, or an unresolved capture type.
export function layoutCaptures(context: NativePointer): CaptureSlot[] | null {
  if (!isReabstractionThunk(context)) {
    return layoutCapturesAt(context) ?? layoutObjectAsContext(context);
  }
  const inner = unwrapReabstractionThunk(context);
  return inner !== null ? layoutCapturesAt(inner) : layoutSoleClassCapture(context);
}

// A thunk's context holds only the closure it wraps, as does a closure whose sole capture is a
// closure; the context alone does not tell them apart, so both read as the inner closure's captures.
function isReabstractionThunk(context: NativePointer): boolean {
  const descriptor = captureDescriptorOf(context);
  return (
    descriptor !== null &&
    descriptor.numBindings === 0 &&
    descriptor.numCaptureTypes === 1 &&
    isThickFunctionCaptureType(descriptor.captureTypes[0])
  );
}

export function unwrapReabstractionThunk(context: NativePointer): NativePointer | null {
  if (!isReabstractionThunk(context)) {
    return null;
  }
  try {
    const inner = context.readPointer(offsetToFirstCapture(context) + Process.pointerSize);
    return captureDescriptorOf(inner) !== null ? inner : null;
  } catch {
    return null;
  }
}

// the wrapped closure's context is an indirect class reference rather than a closure box.
function layoutSoleClassCapture(context: NativePointer): CaptureSlot[] | null {
  const address = context.add(offsetToFirstCapture(context)).add(Process.pointerSize);
  try {
    const type = new Metadata(classMetadataOf(address.readPointer()).handle);
    return type.kind === MetadataKind.Class ? [{ type, address, storage: null }] : null;
  } catch {
    return null;
  }
}

// a sole Swift-refcounted capture is passed as the context itself, with no box around it.
function layoutObjectAsContext(context: NativePointer): CaptureSlot[] | null {
  const type = new Metadata(context.readPointer().strip());
  if (type.kind !== MetadataKind.Class) {
    return null;
  }
  return [{ type, address: Memory.alloc(Process.pointerSize).writePointer(context), storage: null }];
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
    resolveLoweredFunctionCapture(record) ??
    (generics === null ? resolveCaptureType(record) : generics.resolve(record));

  const records = descriptor.captureTypes;
  let offset = offsetToFirstCapture(context) + descriptor.numBindings * Process.pointerSize;
  const addresses: NativePointer[] = [];
  const types: (Metadata | null)[] = [];
  const layouts: TypeLayout[] = [];
  for (const record of records) {
    generics?.derive(addresses);
    const type = resolve(record);
    const layout = type !== null ? type.typeLayout : generics === null ? null : placeholderLayout(generics, record);
    if (layout === null) {
      return null;
    }
    const { size, alignment } = layout;
    if (size !== 0) {
      offset = (offset + alignment - 1) & ~(alignment - 1);
    }
    addresses.push(context.add(offset));
    types.push(type);
    layouts.push(layout);
    offset += size;
  }
  generics?.derive(addresses);

  const slots: CaptureSlot[] = [];
  for (let i = 0; i < records.length; i++) {
    const type = types[i] ?? resolve(records[i]);
    if (type === null || (types[i] === null && !sameLayout(type.typeLayout, layouts[i]))) {
      return null;
    }
    slots.push({ type, address: addresses[i], storage: records[i].referenceStorage });
  }
  return slots;
}

function placeholderLayout(generics: CaptureGenericArguments, record: CaptureTypeRecord): TypeLayout | null {
  if (isReferenceSizedCaptureType(record)) {
    return { size: Process.pointerSize, stride: Process.pointerSize, alignment: Process.pointerSize };
  }
  return generics.resolveWithPlaceholders(record)?.typeLayout ?? null;
}

function sameLayout(a: TypeLayout, b: TypeLayout): boolean {
  return a.size === b.size && a.alignment === b.alignment;
}

export function readCaptures(context: NativePointer): SwiftValue[] | null {
  const slots = layoutCaptures(context);
  return slots === null ? null : slots.map(readField);
}

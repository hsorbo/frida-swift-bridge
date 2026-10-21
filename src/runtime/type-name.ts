import { Metadata, MetadataKind } from "../abi/metadata.js";
import { fixedArrayCount, fixedArrayElementType } from "../abi/fixed-array.js";
import { borrowReferentType } from "../abi/borrow.js";
import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { getSwiftCoreApi } from "./api.js";

// swift_getTypeName spells a private type's anonymous parent as "(unknown context at $<address>)";
// the bridge names the type without it, as its descriptor's full name does.
export const RUNTIME_ANONYMOUS_CONTEXT = /\(unknown context at \$[0-9a-f]+\)\./g;

// The runtime has no demangling for these two kinds; spell them as its demangler would.
export function typeName(metadata: Metadata, qualified = true): string {
  if (metadata.kind === MetadataKind.FixedArray) {
    return `Builtin.FixedArray<${fixedArrayCount(metadata)}, ${typeName(fixedArrayElementType(metadata), qualified)}>`;
  }
  if (metadata.kind === MetadataKind.Borrow) {
    return `Builtin.Borrow<${typeName(borrowReferentType(metadata), qualified)}>`;
  }
  const [data, length] = getSwiftCoreApi().swift_getTypeName(
    metadata.handle,
    qualified ? 1 : 0
  );
  return (data.readUtf8String(Number(length)) ?? "").replace(RUNTIME_ANONYMOUS_CONTEXT, "");
}

export function mangledTypeName(metadata: Metadata): string | null {
  const [data, length] = getSwiftCoreApi().swift_getMangledTypeName(metadata.handle);
  return data.isNull() ? null : data.readUtf8String(Number(length));
}

const MANGLED_KIND_CHARS: { [kind: number]: string } = {
  [ContextDescriptorKind.Class]: "C",
  [ContextDescriptorKind.Struct]: "V",
  [ContextDescriptorKind.Enum]: "O",
  [ContextDescriptorKind.Protocol]: "P",
};

export function buildMangledTypeToken(descriptor: ContextDescriptor): string | null {
  let token = "";
  for (let context: ContextDescriptor | null = descriptor; context !== null; context = context.parent) {
    const isModule = context.kind === ContextDescriptorKind.Module;
    const kindChar = MANGLED_KIND_CHARS[context.kind];
    if (!isModule && kindChar === undefined) {
      return null;
    }
    const name = context.name;
    if (name === null) {
      return null;
    }
    if (isModule) {
      return `${name.length}${name}${token}`;
    }
    token = `${name.length}${name}${kindChar}${token}`;
  }
  return null;
}

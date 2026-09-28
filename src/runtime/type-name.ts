import { Metadata } from "../abi/metadata.js";
import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { getSwiftCoreApi } from "./api.js";

export function typeName(metadata: Metadata, qualified = true): string {
  const [data, length] = getSwiftCoreApi().swift_getTypeName(
    metadata.handle,
    qualified ? 1 : 0
  );
  return data.readUtf8String(Number(length)) ?? "";
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

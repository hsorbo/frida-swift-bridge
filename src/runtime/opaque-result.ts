import { Metadata } from "../abi/metadata.js";
import { ContextDescriptor } from "../abi/context-descriptor.js";
import { resolveTypeByMangledName } from "../abi/field-descriptor.js";
import { underlyingTypeArgumentMangledName } from "../abi/opaque-type-descriptor.js";
import { findType } from "../reflection/registry.js";
import { demangle } from "./demangle.js";

// An opaque result is one concrete type per declaration, recorded in the declaration's opaque type
// descriptor, `<entity>QOMQ`; an accessor's entity is its property or subscript. Only a non-generic
// context is resolved, since the underlying type may name generic arguments the caller doesn't have.
export function opaqueResultType(module: Module, symbol: string, context: string): Metadata {
  const spelled = (): string => demangle(symbol) ?? symbol;
  const owner = findType(context.replace(/^(static|class) /, ""));
  if (owner?.isGeneric || (owner === null && context.includes("."))) {
    throw new Error(`unsupported opaque result in a generic context: ${spelled()}`);
  }
  const name = `${symbol.replace(/([vi])[grM]$/, "$1p")}QOMQ`;
  const address = module.findExportByName(name) ?? module.findSymbolByName(name);
  if (address === null) {
    throw new Error(`no opaque type descriptor for ${spelled()}`);
  }
  const descriptor = new ContextDescriptor(address);
  const metadata = resolveTypeByMangledName(underlyingTypeArgumentMangledName(descriptor, 0), descriptor);
  if (metadata === null) {
    throw new Error(`could not resolve the opaque result of ${spelled()}`);
  }
  return metadata;
}

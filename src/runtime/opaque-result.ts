import { Metadata, genericHeaderOffset, readGenericContextHeader } from "../abi/metadata.js";
import { ContextDescriptor } from "../abi/context-descriptor.js";
import { resolveTypeByMangledName } from "../abi/field-descriptor.js";
import { genericKeyArguments } from "../abi/generic-instantiation.js";
import { underlyingTypeArgumentMangledName } from "../abi/opaque-type-descriptor.js";
import { demangle } from "./demangle.js";

export interface OpaqueResult {
  generic: boolean; // the underlying type depends on the type arguments of the call
  underlying: (typeArguments: Metadata[]) => Metadata;
}

function genericParamCount(descriptor: ContextDescriptor): number {
  return descriptor.isGeneric ? readGenericContextHeader(descriptor.handle.add(genericHeaderOffset(descriptor))).numParams : 0;
}

// An opaque result is one concrete type per declaration, recorded in the declaration's opaque type
// descriptor, `<entity>QOMQ`; an accessor's entity is its property or subscript. The descriptor's
// generic parameters are the naming context's, then the opaque type's own, and the underlying type
// names only the former, so it resolves in that context with the context's key arguments, built from
// the type arguments of the call. A declaration with generic parameters of its own is refused.
export function opaqueResult(module: Module, symbol: string): OpaqueResult {
  const spelled = (): string => demangle(symbol) ?? symbol;
  const name = `${symbol.replace(/([vi])[grM]$/, "$1p")}QOMQ`;
  const address = module.findExportByName(name) ?? module.findSymbolByName(name);
  if (address === null) {
    throw new Error(`no opaque type descriptor for ${spelled()}`);
  }
  const descriptor = new ContextDescriptor(address);
  const underlyingName = underlyingTypeArgumentMangledName(descriptor, 0);
  const outer = genericParamCount(descriptor) - 1;
  if (outer <= 0) {
    const metadata = resolveTypeByMangledName(underlyingName, descriptor);
    if (metadata === null) {
      throw new Error(`could not resolve the opaque result of ${spelled()}`);
    }
    return { generic: false, underlying: () => metadata };
  }
  const context = descriptor.parent;
  if (context === null || genericParamCount(context) !== outer) {
    throw new Error(`unsupported opaque result of a declaration with generic parameters of its own: ${spelled()}`);
  }
  const resolved = new Map<string, Metadata>();
  return {
    generic: true,
    underlying: (typeArguments) => {
      const key = typeArguments.map((t) => t.handle).join(",");
      let metadata = resolved.get(key);
      if (metadata === undefined) {
        const found = resolveTypeByMangledName(underlyingName, context, genericKeyArguments(context, typeArguments.slice(0, outer)).vector);
        if (found === null) {
          throw new Error(`could not resolve the opaque result of ${spelled()}`);
        }
        resolved.set(key, (metadata = found));
      }
      return metadata;
    },
  };
}

// A call names no type arguments for a generic context, so only a non-generic one resolves.
export function opaqueResultType(module: Module, symbol: string): Metadata {
  const result = opaqueResult(module, symbol);
  if (result.generic) {
    throw new Error(`unsupported opaque result in a generic context: ${demangle(symbol) ?? symbol}`);
  }
  return result.underlying([]);
}

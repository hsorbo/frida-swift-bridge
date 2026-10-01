import { demangle } from "./demangle.js";
import { findType } from "../reflection/registry.js";
import { findProtocol } from "../abi/protocol-conformance.js";
import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { getMetadata, Metadata } from "../abi/metadata.js";
import { buildGenericMetadata } from "../abi/generic-instantiation.js";
import { getExistentialTypeMetadata } from "../abi/existential.js";
import { resolveTypeByMangledName } from "../abi/field-descriptor.js";
import { getUnlabelledTupleTypeMetadata } from "../abi/tuple.js";
import { TypeExpr, parseTypeExpr, SwiftFunctionSignature } from "./type-expr.js";

export {
  TypeExpr,
  TypeExprParam,
  ParamConvention,
  GenericRequirement,
  SwiftFunctionSignature,
  SwiftAccessorSignature,
  ParsedSwiftSignature,
  parseTypeExpr,
  parseSwiftSignature,
  childTypes,
  mentionsParam,
} from "./type-expr.js";

export interface SwiftSymbol {
  address: NativePointer;
  name: string;
  demangled: string;
}

export interface ResolvedFunctionSignature {
  throws: boolean;
  argTypes: Metadata[];
  returnType: Metadata | null;
}

const exportsByModule = new Map<string, Map<string, string>>();
const symbolsByModule = new Map<string, Map<string, string>>();

function exportedFunctionNames(module: Module): Map<string, string> {
  let names = exportsByModule.get(module.path);
  if (names === undefined) {
    names = new Map<string, string>();
    for (const e of module.enumerateExports()) {
      if (e.type === "function") {
        names.set(e.address.strip().toString(), e.name);
      }
    }
    exportsByModule.set(module.path, names);
  }
  return names;
}

function symbolNames(module: Module): Map<string, string> {
  let names = symbolsByModule.get(module.path);
  if (names === undefined) {
    names = new Map<string, string>();
    for (const s of module.enumerateSymbols()) {
      names.set(s.address.strip().toString(), s.name);
    }
    symbolsByModule.set(module.path, names);
  }
  return names;
}

// Exports first; the symbol table only when they miss, for code a main executable or a private
// linkage (witness thunks) keeps out of the export trie.
export function symbolicate(address: NativePointer): SwiftSymbol | null {
  address = address.strip();
  const module = Process.findModuleByAddress(address);
  if (module === null) {
    return null;
  }

  const key = address.toString();
  const name = exportedFunctionNames(module).get(key) ?? symbolNames(module).get(key);
  if (name === undefined) {
    return null;
  }
  const demangled = demangle(name);
  if (demangled === null) {
    return null;
  }
  return { address, name, demangled };
}

export function resolveFunctionSignature(
  signature: SwiftFunctionSignature
): ResolvedFunctionSignature | null {
  const argTypes: Metadata[] = [];
  for (const name of signature.argTypeNames) {
    const metadata = resolveType(name);
    if (metadata === null) {
      return null;
    }
    argTypes.push(metadata);
  }

  let returnType: Metadata | null = null;
  if (signature.returnTypeName !== null) {
    returnType = resolveType(signature.returnTypeName);
    if (returnType === null) {
      return null;
    }
  }

  return { throws: signature.throws, argTypes, returnType };
}

export function resolveType(name: string): Metadata | null {
  if (name.startsWith("__C.")) {
    return resolveObjCType(name);
  }
  const descriptor = findType(name);
  if (descriptor !== null) {
    try {
      return getMetadata(descriptor);
    } catch {
      return null;
    }
  }
  return resolveProtocolExistential(name);
}

// A __C type has no Swift descriptor; resolve it through its `So<len><name>C` (class) or
// `So<len><name>_p` (protocol existential) mangling.
function resolveObjCType(name: string): Metadata | null {
  const ident = name.slice("__C.".length);
  if (!/^[A-Za-z_]\w*$/.test(ident)) {
    return null;
  }
  const prefix = `So${ident.length}${ident}`;
  return resolveMangled(`${prefix}C`) ?? resolveMangled(`${prefix}_p`);
}

function resolveMangled(mangled: string): Metadata | null {
  return resolveTypeByMangledName({ address: Memory.allocUtf8String(mangled), length: mangled.length });
}

function resolveProtocolExistential(name: string): Metadata | null {
  const parsed = parseTypeExpr(name);
  const members = parsed === null ? [] : parsed.kind === "existential" ? parsed.members : [parsed];
  return members.length === 0 ? null : existentialOf(members);
}

function existentialOf(members: TypeExpr[]): Metadata | null {
  const protocols: ContextDescriptor[] = [];
  for (const member of members) {
    const protocol = member.kind === "nominal" && member.args.length === 0 ? findProtocol(member.name) : null;
    if (protocol === null) {
      return null;
    }
    protocols.push(protocol);
  }
  return getExistentialTypeMetadata(protocols);
}

export function metadataFor(name: string, typeArguments: Metadata[] = []): Metadata | null {
  if (name === "Swift.Void" || name === "()") {
    return voidMetadata();
  }
  const descriptor = findType(name);
  if (descriptor === null) {
    return null;
  }
  return typeArguments.length > 0
    ? buildGenericMetadata(descriptor, typeArguments)
    : getMetadata(descriptor);
}

let voidMetadataCache: Metadata | null = null;

// The empty tuple ("yt"); not a nominal type, so findType can't reach it.
export function voidMetadata(): Metadata {
  if (voidMetadataCache === null) {
    const mangled = Memory.allocUtf8String("yt");
    const metadata = resolveTypeByMangledName({ address: mangled, length: 2 });
    if (metadata === null) {
      throw new Error("cannot resolve Swift.Void metadata");
    }
    voidMetadataCache = metadata;
  }
  return voidMetadataCache;
}

function instantiate(name: string, args: (Metadata | null)[]): Metadata | null {
  const descriptor = findType(name);
  if (descriptor === null || args.some((a) => a === null)) {
    return null;
  }
  try {
    return buildGenericMetadata(descriptor, args as Metadata[]);
  } catch {
    return null;
  }
}

export type ResolveParam = (name: string) => Metadata | null;

// Metadata for a type spelling: generic parameters and their associated types go through
// resolveParam, every other leaf through findType. Function, metatype, opaque and pack types have
// no metadata the bridge builds.
export function resolveParsedType(type: TypeExpr, resolveParam: ResolveParam): Metadata | null {
  switch (type.kind) {
    case "nominal":
      return type.args.length > 0
        ? instantiate(type.name, type.args.map((a) => resolveParsedType(a, resolveParam)))
        : resolveParam(type.text) ?? resolveType(type.name);
    case "param":
    case "member":
      return resolveParam(type.text);
    case "optional":
      return instantiate("Swift.Optional", [resolveParsedType(type.wrapped, resolveParam)]);
    case "tuple": {
      if (type.elements.length === 0) {
        return voidMetadata();
      }
      const elements: Metadata[] = [];
      for (const element of type.elements) {
        const metadata = resolveParsedType(element.type, resolveParam);
        if (metadata === null) {
          return null;
        }
        elements.push(metadata);
      }
      return getUnlabelledTupleTypeMetadata(elements);
    }
    case "existential":
      return existentialOf(type.members);
    default:
      return null;
  }
}

export function resolveTypeExpr(expr: string, resolveParam: ResolveParam): Metadata | null {
  const parsed = parseTypeExpr(expr);
  return parsed === null ? null : resolveParsedType(parsed, resolveParam);
}

export type ParamLayout = "opaque" | "reference";

export const REFERENCE_CONTAINERS = new Set(["Swift.Array", "Swift.Dictionary", "Swift.Set"]);

// Whether a type is address-only where its params are opaque, as in a protocol witness thunk or an
// unspecialized generic: an opaque param is, and so is a value type storing one inline. A tuple
// mentioning one is lowered per element, which a single verdict can't express.
export function hasOpaqueLayout(type: TypeExpr, paramLayout: (name: string) => ParamLayout | null): boolean {
  if (type.kind !== "tuple") {
    return embedsOpaqueParam(type, paramLayout);
  }
  if (type.elements.some((e) => embedsOpaqueParam(e.type, paramLayout))) {
    throw new Error(`unsupported tuple with an opaque element: ${type.text}`);
  }
  return false;
}

function embedsOpaqueParam(type: TypeExpr, paramLayout: (name: string) => ParamLayout | null): boolean {
  switch (type.kind) {
    case "param":
    case "member":
      return paramLayout(type.text) === "opaque";
    case "optional":
      return embedsOpaqueParam(type.wrapped, paramLayout);
    case "tuple":
      return type.elements.some((e) => embedsOpaqueParam(e.type, paramLayout));
    case "nominal":
      if (type.args.length === 0) {
        return paramLayout(type.text) === "opaque";
      }
      if (REFERENCE_CONTAINERS.has(type.name) || findType(type.name)?.kind === ContextDescriptorKind.Class) {
        return false;
      }
      return type.args.some((a) => embedsOpaqueParam(a, paramLayout));
    default:
      return false;
  }
}

// Array/Dictionary/Set, a class, or an Optional of one: one register whatever the generic arguments.
export function isSingleReference(type: TypeExpr): boolean {
  if (type.kind === "optional") {
    return isSingleReference(type.wrapped);
  }
  return type.kind === "nominal" && (REFERENCE_CONTAINERS.has(type.name) || findType(type.name)?.kind === ContextDescriptorKind.Class);
}

import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { getSwiftSection } from "../image/sections.js";
import { moduleKey } from "../runtime/symbol-index.js";
import { swiftMatches } from "../runtime/swift-resolver.js";

const SWIFT_SECTIONS = ["__swift5_types", "__swift5_proto", "__swift5_protos", "__swift5_types2"];

const hasSwiftSections = new Map<string, boolean>();

export function* enumerateSwiftModules(): Generator<Module> {
  for (const module of Process.enumerateModules()) {
    const key = moduleKey(module);
    let present = hasSwiftSections.get(key);
    if (present === undefined) {
      present = SWIFT_SECTIONS.some((name) => getSwiftSection(module, name) !== null);
      hasSwiftSections.set(key, present);
    }
    if (present) {
      yield module;
    }
  }
}

function* typeDescriptors(query: string): Generator<ContextDescriptor> {
  for (const match of swiftMatches(query)) {
    const descriptor = new ContextDescriptor(match.address);
    if (descriptor.isType) {
      yield descriptor;
    }
  }
}

export function* enumerateTypes(module: Module): Generator<ContextDescriptor> {
  yield* typeDescriptors(`types:${module.path}!*`);
}

export function* swiftImages(): Generator<Module> {
  yield* enumerateSwiftModules();
}

// A type declared in the module's extension of another module's type is spelled
// `(extension in M):Outer.Name` by the resolver and listed under M like any other declaration.
export function* typesNamedUnder(moduleName: string): Generator<ContextDescriptor> {
  yield* typeDescriptors(`types:*!${moduleName}.*`);
  yield* typeDescriptors(`types:*!(extension in ${moduleName}):*`);
}

export function* swiftTypes(module?: Module): Generator<ContextDescriptor> {
  yield* module === undefined ? typeDescriptors("types:*!*") : enumerateTypes(module);
}

function* typesByKind(kind: ContextDescriptorKind, module?: Module): Generator<ContextDescriptor> {
  for (const descriptor of swiftTypes(module)) {
    if (descriptor.kind === kind) {
      yield descriptor;
    }
  }
}

export function* swiftClasses(module?: Module): Generator<ContextDescriptor> {
  yield* typesByKind(ContextDescriptorKind.Class, module);
}

export function* swiftStructs(module?: Module): Generator<ContextDescriptor> {
  yield* typesByKind(ContextDescriptorKind.Struct, module);
}

export function* swiftEnums(module?: Module): Generator<ContextDescriptor> {
  yield* typesByKind(ContextDescriptorKind.Enum, module);
}

// Hits only: a qualified name's descriptor never changes, while a miss can be answered by a module
// loaded later.
const resolved = new Map<string, ContextDescriptor>();

export function findType(name: string): ContextDescriptor | null {
  const hit = resolved.get(name);
  if (hit !== undefined) {
    return hit;
  }
  const dot = name.lastIndexOf(".");
  if (dot === -1) {
    return findUniqueType(name);
  }
  // The resolver spells a type declared in another module's extension as the demangler does,
  // `(extension in M):Outer<A>.Name`, so a name the exact spelling misses is retried by its last
  // component and settled by the bridge's own spelling.
  for (const query of [`types:*!${name}`, `types:*!*.${name.slice(dot + 1)}`]) {
    for (const descriptor of typeDescriptors(query)) {
      if (descriptor.fullTypeName === name) {
        resolved.set(name, descriptor);
        return descriptor;
      }
    }
  }
  return null;
}

// A bare name is accepted only when it resolves uniquely across loaded images. Distinct descriptors
// that share a qualified name denote the same type (dyld cache aliases), not ambiguity. Never
// cached: a later-loaded image can make it ambiguous.
function findUniqueType(simpleName: string): ContextDescriptor | null {
  let match: ContextDescriptor | null = null;
  const candidateNames = new Set<string>();
  for (const descriptor of typeDescriptors(`types:*!*.${simpleName}`)) {
    const fullName = descriptor.fullTypeName;
    if (fullName === null || descriptor.name !== simpleName) {
      continue;
    }
    match = descriptor;
    candidateNames.add(fullName);
  }
  if (candidateNames.size > 1) {
    throw new Error(`ambiguous type name "${simpleName}": ${[...candidateNames].sort().join(", ")}; qualify it with a module`);
  }
  return match;
}

import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import {
  getSwiftSection,
  enumerateTypeContextDescriptors,
} from "../image/sections.js";
import { moduleKey } from "../runtime/symbol-index.js";

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

export function* enumerateTypes(module: Module): Generator<ContextDescriptor> {
  for (const handle of enumerateTypeContextDescriptors(module)) {
    const descriptor = new ContextDescriptor(handle);
    if (descriptor.isType) {
      yield descriptor;
    }
  }
}

interface TypeScan {
  parsed: ContextDescriptor[];
  remaining: Generator<ContextDescriptor> | null;
}

// Stale after dlclose, but Swift dylibs are effectively never unloaded.
const typeScansByModulePath = new Map<string, TypeScan>();

function* typesOf(module: Module): Generator<ContextDescriptor> {
  let scan = typeScansByModulePath.get(module.path);
  if (scan === undefined) {
    scan = { parsed: [], remaining: enumerateTypes(module) };
    typeScansByModulePath.set(module.path, scan);
  }
  for (let i = 0; ; i++) {
    if (i < scan.parsed.length) {
      yield scan.parsed[i];
      continue;
    }
    if (scan.remaining === null) {
      return;
    }
    const next = scan.remaining.next();
    if (next.done) {
      scan.remaining = null;
      return;
    }
    scan.parsed.push(next.value);
    yield next.value;
  }
}

export function* swiftImages(): Generator<Module> {
  yield* enumerateSwiftModules();
}

export function* swiftTypes(module?: Module): Generator<ContextDescriptor> {
  if (module !== undefined) {
    yield* typesOf(module);
    return;
  }
  for (const m of enumerateSwiftModules()) {
    yield* typesOf(m);
  }
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

const resolved = new Map<string, ContextDescriptor>();

export function findType(name: string): ContextDescriptor | null {
  const hit = resolved.get(name);
  if (hit !== undefined) {
    return hit;
  }

  const dot = name.lastIndexOf(".");
  const simpleName = dot === -1 ? name : name.slice(dot + 1);
  const qualified = dot === -1 ? null : name;

  // A qualified name resolves to the first full-path match. A bare name is accepted only when it
  // resolves uniquely across loaded images, so it must scan every image before committing. Distinct
  // descriptors that share a qualified name denote the same type (dyld cache aliases), not ambiguity.
  let match: ContextDescriptor | null = null;
  const candidateNames = new Set<string>();
  for (const module of enumerateSwiftModules()) {
    for (const descriptor of typesOf(module)) {
      if (descriptor.name !== simpleName) {
        continue;
      }
      if (qualified !== null) {
        if (descriptor.fullTypeName !== qualified) {
          continue;
        }
        resolved.set(name, descriptor);
        return descriptor;
      }
      const fullName = descriptor.fullTypeName;
      if (fullName === null) {
        continue;
      }
      match = descriptor;
      candidateNames.add(fullName);
    }
  }
  if (candidateNames.size > 1) {
    throw new Error(`ambiguous type name "${name}": ${[...candidateNames].sort().join(", ")}; qualify it with a module`);
  }

  // Never cached: a later-loaded image can make a bare name ambiguous.
  return match;
}

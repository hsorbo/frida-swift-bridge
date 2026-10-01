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
  firstModuleName?: string | null;
  index: TypeIndex | null;
}

// Built once an image's parse is complete: its types by simple name, and the first component of every
// full name in it (an image normally holds one module, but a type nested in an extension of another
// module's type is named under that module).
interface TypeIndex {
  byName: Map<string, ContextDescriptor[]>;
  moduleNames: Set<string>;
}

// Stale after dlclose, but Swift dylibs are effectively never unloaded.
const typeScansByModulePath = new Map<string, TypeScan>();

function scanOf(module: Module): TypeScan {
  let scan = typeScansByModulePath.get(module.path);
  if (scan === undefined) {
    scan = { parsed: [], remaining: enumerateTypes(module), index: null };
    typeScansByModulePath.set(module.path, scan);
  }
  return scan;
}

function* typesOf(module: Module): Generator<ContextDescriptor> {
  const scan = scanOf(module);
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

// The module its first type belongs to: one descriptor read, enough to tell which image a
// qualified name most likely lives in without parsing the rest.
function firstModuleNameOf(module: Module): string | null {
  const scan = scanOf(module);
  if (scan.firstModuleName === undefined) {
    const first = typesOf(module).next();
    scan.firstModuleName = first.done ? null : first.value.moduleName;
  }
  return scan.firstModuleName;
}

function indexOf(module: Module): TypeIndex {
  const scan = scanOf(module);
  if (scan.index === null) {
    for (const _ of typesOf(module)) {
      // complete the parse
    }
    const byName = new Map<string, ContextDescriptor[]>();
    const moduleNames = new Set<string>();
    for (const descriptor of scan.parsed) {
      const name = descriptor.name;
      if (name === null) {
        continue;
      }
      const list = byName.get(name);
      if (list === undefined) {
        byName.set(name, [descriptor]);
      } else {
        list.push(descriptor);
      }
      const fullName = descriptor.fullTypeName;
      if (fullName !== null) {
        moduleNames.add(fullName.slice(0, fullName.indexOf(".")));
      }
    }
    scan.index = { byName, moduleNames };
  }
  return scan.index;
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
  if (dot === -1) {
    return findUniqueType(name);
  }
  const simpleName = name.slice(dot + 1);
  const moduleName = name.slice(0, name.indexOf("."));
  const images = [...enumerateSwiftModules()];
  // The images whose first type names the module are indexed first; only if none holds the type is
  // every other image parsed, which also settles later misses without another walk.
  const likely = images.filter((m) => firstModuleNameOf(m) === moduleName);
  const others = images.filter((m) => firstModuleNameOf(m) !== moduleName);
  for (const module of [...likely, ...others]) {
    const index = indexOf(module);
    if (!index.moduleNames.has(moduleName)) {
      continue;
    }
    const descriptor = (index.byName.get(simpleName) ?? []).find((d) => d.fullTypeName === name);
    if (descriptor !== undefined) {
      resolved.set(name, descriptor);
      return descriptor;
    }
  }
  return null;
}

// A bare name is accepted only when it resolves uniquely across loaded images, so every image is
// indexed before committing. Distinct descriptors that share a qualified name denote the same type
// (dyld cache aliases), not ambiguity. Never cached: a later-loaded image can make it ambiguous.
function findUniqueType(simpleName: string): ContextDescriptor | null {
  let match: ContextDescriptor | null = null;
  const candidateNames = new Set<string>();
  for (const module of enumerateSwiftModules()) {
    for (const descriptor of indexOf(module).byName.get(simpleName) ?? []) {
      const fullName = descriptor.fullTypeName;
      if (fullName === null) {
        continue;
      }
      match = descriptor;
      candidateNames.add(fullName);
    }
  }
  if (candidateNames.size > 1) {
    throw new Error(`ambiguous type name "${simpleName}": ${[...candidateNames].sort().join(", ")}; qualify it with a module`);
  }
  return match;
}

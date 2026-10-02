import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { enumerateProtocolConformances, enumerateProtocols } from "../abi/protocol-conformance.js";
import { enumerateTypeContextDescriptors } from "../image/sections.js";
import { enumerateSwiftModules } from "../reflection/registry.js";
import { moduleKey } from "./symbol-index.js";

// Answers the resolver queries the bridge issues from the metadata sections in JS, for a Frida whose
// Swift resolver does not know the running platform's runtime (Linux before frida-gum#1157).

interface NamedEntry {
  name: string;
  address: NativePointer;
}

interface ConformanceEntry {
  typeName: string;
  protocolName: string;
  address: NativePointer;
}

interface ModuleEntries {
  types: NamedEntry[];
  protocols: NamedEntry[];
  conformances: ConformanceEntry[];
}

// Stale after dlclose, but Swift dylibs are effectively never unloaded.
const entriesByModule = new Map<string, ModuleEntries>();

export function fallbackSwiftMatches(query: string): ApiResolverMatch[] {
  const colon = query.indexOf(":");
  const bang = query.indexOf("!");
  if (colon === -1 || bang === -1) {
    throw new Error(`invalid Swift resolver query: ${query}`);
  }
  const kind = query.slice(0, colon);
  if (kind !== "types" && kind !== "protocols" && kind !== "conformances") {
    throw new Error(`unsupported Swift resolver query: ${query}`);
  }
  const scope = globToRegExp(query.slice(colon + 1, bang));
  const name = globToRegExp(query.slice(bang + 1));
  const matches: ApiResolverMatch[] = [];
  for (const module of enumerateSwiftModules()) {
    const entries = entriesOf(module);
    if (kind === "conformances") {
      for (const c of entries.conformances) {
        if (scope.test(c.typeName) && name.test(c.protocolName)) {
          matches.push({ name: `${c.typeName}!${c.protocolName}`, address: c.address });
        }
      }
      continue;
    }
    if (!scope.test(module.name) && !scope.test(module.path)) {
      continue;
    }
    for (const entry of entries[kind]) {
      if (name.test(entry.name)) {
        matches.push({ name: `${module.path}!${entry.name}`, address: entry.address });
      }
    }
  }
  return matches;
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`);
}

function entriesOf(module: Module): ModuleEntries {
  const key = moduleKey(module);
  let entries = entriesByModule.get(key);
  if (entries === undefined) {
    entries = { types: [], protocols: [], conformances: [] };
    for (const handle of enumerateTypeContextDescriptors(module)) {
      const descriptor = new ContextDescriptor(handle);
      const name = descriptor.isType ? typeName(descriptor) : null;
      if (name !== null) {
        entries.types.push({ name, address: handle });
      }
    }
    for (const protocol of enumerateProtocols(module)) {
      const name = protocol.fullTypeName;
      if (name !== null) {
        entries.protocols.push({ name, address: protocol.handle });
      }
    }
    for (const conformance of enumerateProtocolConformances(module)) {
      const type = conformance.typeDescriptor;
      entries.conformances.push({
        typeName: (type === null ? null : new ContextDescriptor(type).fullTypeName) ?? "",
        protocolName: conformance.protocol?.fullTypeName ?? "",
        address: conformance.handle,
      });
    }
    entriesByModule.set(key, entries);
  }
  return entries;
}

// The resolver spells a type declared in an extension of another module's type `(extension in M):...`.
function typeName(descriptor: ContextDescriptor): string | null {
  const name = descriptor.fullTypeName;
  const moduleName = descriptor.moduleName;
  if (name === null || moduleName === null || name.startsWith(`${moduleName}.`)) {
    return name;
  }
  for (let context = descriptor.parent; context !== null; context = context.parent) {
    if (context.kind === ContextDescriptorKind.Extension) {
      return `(extension in ${moduleName}):${name}`;
    }
  }
  return name;
}

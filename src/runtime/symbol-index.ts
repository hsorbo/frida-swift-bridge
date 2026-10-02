import { isSwiftSymbol } from "./demangle.js";

export interface PrefixedExport {
  name: string;
  address: NativePointer;
}

interface ModuleIndex {
  initializers: PrefixedExport[] | null;
  enumTags: PrefixedExport[] | null;
  exportsByToken: Map<string, PrefixedExport[]>;
}

// Keyed on path and base: a loaded module's symbols can't change, and a reloaded one is a new key.
// Nothing is read until a module is first queried.
const indexes = new Map<string, ModuleIndex>();

export function moduleKey(module: Module): string {
  return `${module.path}@${module.base}`;
}

function indexOf(module: Module): ModuleIndex {
  const key = moduleKey(module);
  let index = indexes.get(key);
  if (index === undefined) {
    index = { initializers: null, enumTags: null, exportsByToken: new Map() };
    indexes.set(key, index);
  }
  return index;
}

const NONE: PrefixedExport[] = [];

// Keyed by the type's mangled token, which the callers' own caches hand out as one shared string.
export function swiftExportsOfTokens(module: Module, tokens: string[]): PrefixedExport[][] {
  const memo = indexOf(module).exportsByToken;
  const pending = tokens.filter((t) => !memo.has(t));
  if (pending.length > 0) {
    queryExportsOfTokens(pending);
  }
  return tokens.map((t) => memo.get(t) ?? NONE);
}

// One query per token answers for every module loaded now; a module loaded later has a fresh key and
// asks again. The resolver reports a re-export under the re-exporting module too, at its real address.
function queryExportsOfTokens(tokens: string[]): void {
  const resolver = new ApiResolver("module");
  const modules = Process.enumerateModules();
  for (const token of tokens) {
    const byPath = new Map<string, PrefixedExport[]>();
    for (const match of resolver.enumerateMatches(`exports:*!$s${token}*`)) {
      const split = match.name.lastIndexOf("!");
      const path = match.name.substring(0, split);
      let found = byPath.get(path);
      if (found === undefined) {
        found = [];
        byPath.set(path, found);
      }
      found.push({ name: match.name.substring(split + 1), address: match.address });
    }
    for (const module of modules) {
      const own = (byPath.get(module.path) ?? NONE).filter((e) => containsAddress(module, e.address));
      indexOf(module).exportsByToken.set(token, own.length === 0 ? NONE : own);
    }
  }
}

function containsAddress(module: Module, address: NativePointer): boolean {
  const raw = address.strip();
  return raw.compare(module.base) >= 0 && raw.compare(module.base.add(module.size)) < 0;
}

function hasPrefix(name: string, prefix: string): boolean {
  return name.startsWith(prefix) || (name.charCodeAt(0) === 0x5f && name.startsWith(prefix, 1));
}

export function hasSwiftSymbolWithPrefix(module: Module, prefix: string): boolean {
  return module.enumerateSymbols().some((s) => hasPrefix(s.name, prefix));
}

// The export trie omits a value type's initializers in a non-library-evolution build, and they are
// all the member scan takes from the symbol table: entries mangled as an allocating (fC) or
// initializing (fc) constructor. Keeping only those costs kilobytes where the table costs megabytes.
function isInitializerSymbol(name: string): boolean {
  return isSwiftSymbol(name) && (name.endsWith("fC") || name.endsWith("fc"));
}

export function initializerSymbols(module: Module): PrefixedExport[] {
  const index = indexOf(module);
  if (index.initializers === null) {
    index.initializers = [];
    for (const s of module.enumerateSymbols()) {
      if (!s.address.isNull() && isInitializerSymbol(s.name)) {
        index.initializers.push({ name: s.name, address: s.address });
      }
    }
  }
  return index.initializers;
}

export function initializerSymbolsWithPrefix(module: Module, prefix: string): PrefixedExport[] {
  return initializerSymbols(module).filter((s) => hasPrefix(s.name, prefix));
}

// A resilient enum's case tag indices (WC) are data exports in __TEXT,__const, which an exports
// query leaves out, so they come from the full export list instead.
export function enumTagExportsWithPrefix(module: Module, prefix: string): PrefixedExport[] {
  const index = indexOf(module);
  if (index.enumTags === null) {
    index.enumTags = module
      .enumerateExports()
      .filter((e) => e.name.endsWith("WC"))
      .map((e) => ({ name: e.name, address: e.address }));
  }
  return index.enumTags.filter((s) => s.name.startsWith(prefix));
}

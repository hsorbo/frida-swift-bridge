import { isSwiftSymbol } from "./demangle.js";
import { exportsByPrefix, PrefixedExport } from "./export-trie.js";

interface ModuleIndex {
  initializers: PrefixedExport[] | null;
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
    index = { initializers: null, exportsByToken: new Map() };
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
    exportsByPrefix(module, pending.map((t) => `$s${t}`)).forEach((found, i) => memo.set(pending[i], found.length === 0 ? NONE : found));
  }
  return tokens.map((t) => memo.get(t)!);
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

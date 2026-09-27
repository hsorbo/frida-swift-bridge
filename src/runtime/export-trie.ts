export interface PrefixedExport {
  name: string;
  address: NativePointer;
}

const LC_SEGMENT_64 = 0x19;
const LC_DYLD_INFO = 0x22;
const LC_DYLD_INFO_ONLY = 0x80000022;
const LC_DYLD_EXPORTS_TRIE = 0x80000033;
const S_ATTR_INSTRUCTIONS = 0x80000400;
const EXPORT_SYMBOL_FLAGS_KIND_ABSOLUTE = 0x02;
const EXPORT_SYMBOL_FLAGS_KIND_MASK = 0x03;
const EXPORT_SYMBOL_FLAGS_REEXPORT = 0x08;

export function exportsByPrefix(module: Module, prefixes: string[]): PrefixedExport[][] {
  return Process.platform === "darwin"
    ? walkExportTrie(module, prefixes.map((p) => `_${p}`))
    : scanExports(module, prefixes);
}

function scanExports(module: Module, prefixes: string[]): PrefixedExport[][] {
  const found = prefixes.map((): PrefixedExport[] => []);
  for (const e of module.enumerateExports()) {
    prefixes.forEach((prefix, i) => {
      if (e.name.startsWith(prefix)) {
        found[i].push({ name: e.name, address: e.address });
      }
    });
  }
  return found;
}

interface MachOImage {
  trie: Uint8Array | null;
  codeRanges: { start: NativePointer; end: NativePointer }[];
}

const machOImages = new Map<string, MachOImage>();

function machOImageOf(module: Module): MachOImage {
  const key = `${module.path}@${module.base}`;
  let image = machOImages.get(key);
  if (image === undefined) {
    image = readMachOImage(module.base);
    machOImages.set(key, image);
  }
  return image;
}

function readMachOImage(base: NativePointer): MachOImage {
  const segments: { name: string; vmaddr: UInt64; fileoff: UInt64 }[] = [];
  const sections: { addr: UInt64; size: UInt64 }[] = [];
  let trieOffset = 0;
  let trieSize = 0;
  let command = base.add(32);
  for (let i = 0, n = base.add(16).readU32(); i !== n; i++) {
    const cmd = command.readU32();
    if (cmd === LC_SEGMENT_64) {
      segments.push({
        name: command.add(8).readCString()!,
        vmaddr: command.add(24).readU64(),
        fileoff: command.add(40).readU64(),
      });
      let section = command.add(72);
      for (let j = 0, m = command.add(64).readU32(); j !== m; j++, section = section.add(80)) {
        if ((section.add(64).readU32() & S_ATTR_INSTRUCTIONS) !== 0) {
          sections.push({ addr: section.add(32).readU64(), size: section.add(40).readU64() });
        }
      }
    } else if (cmd === LC_DYLD_EXPORTS_TRIE) {
      trieOffset = command.add(8).readU32();
      trieSize = command.add(12).readU32();
    } else if (cmd === LC_DYLD_INFO || cmd === LC_DYLD_INFO_ONLY) {
      trieOffset = command.add(40).readU32();
      trieSize = command.add(44).readU32();
    }
    command = command.add(command.add(4).readU32());
  }
  const text = segments.find((s) => s.name === "__TEXT")!;
  const at = (vmaddr: UInt64): NativePointer => base.add(vmaddr.sub(text.vmaddr));
  const codeRanges = sections.map((s) => ({ start: at(s.addr), end: at(s.addr.add(s.size)) }));
  const linkedit = segments.find((s) => s.name === "__LINKEDIT");
  if (trieSize === 0 || linkedit === undefined) {
    return { trie: null, codeRanges };
  }
  const trieStart = at(linkedit.vmaddr).sub(linkedit.fileoff).add(trieOffset);
  return { trie: new Uint8Array(ArrayBuffer.wrap(trieStart, trieSize)), codeRanges };
}

// Re-exports are skipped: the defining module yields the same symbol.
function walkExportTrie(module: Module, prefixes: string[]): PrefixedExport[][] {
  const found = prefixes.map((): PrefixedExport[] => []);
  const { trie, codeRanges } = machOImageOf(module);
  if (trie === null) {
    return found;
  }
  let pos = 0;
  const uleb = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = trie[pos++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while ((byte & 0x80) !== 0);
    return result;
  };
  const reachesPrefix = (name: string): boolean =>
    prefixes.some((p) => (name.length < p.length ? p.startsWith(name) : name.startsWith(p)));
  const isCode = (address: NativePointer): boolean =>
    codeRanges.some((r) => address.compare(r.start) >= 0 && address.compare(r.end) < 0);
  const visit = (node: number, name: string): void => {
    pos = node;
    const terminalSize = uleb();
    const childrenStart = pos + terminalSize;
    if (terminalSize !== 0) {
      const flags = uleb();
      if ((flags & EXPORT_SYMBOL_FLAGS_REEXPORT) === 0) {
        const offset = uleb();
        const absolute = (flags & EXPORT_SYMBOL_FLAGS_KIND_MASK) === EXPORT_SYMBOL_FLAGS_KIND_ABSOLUTE;
        const raw = absolute ? ptr(offset) : module.base.add(offset);
        const address = isCode(raw) ? raw.sign() : raw;
        prefixes.forEach((prefix, i) => {
          if (name.startsWith(prefix)) {
            found[i].push({ name: name.substring(1), address });
          }
        });
      }
    }
    pos = childrenStart;
    if (pos >= trie.length) {
      return;
    }
    const children: [string, number][] = [];
    for (let n = trie[pos++]; n !== 0; n--) {
      let edge = "";
      while (trie[pos] !== 0) {
        edge += String.fromCharCode(trie[pos++]);
      }
      pos++;
      children.push([name + edge, uleb()]);
    }
    for (const [childName, childNode] of children) {
      if (reachesPrefix(childName)) {
        visit(childNode, childName);
      }
    }
  };
  visit(0, "");
  return found;
}

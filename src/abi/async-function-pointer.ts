import { RelativeDirectPointer } from "../basic/relative-pointer.js";

const OFFSETOF_FUNCTION = 0x0;
const OFFSETOF_EXPECTED_CONTEXT_SIZE = 0x4;

// A `…Tu` symbol addresses this record, not code (ABI/Executor.h).
export class AsyncFunctionPointer {
  readonly handle: NativePointer;

  constructor(handle: NativePointer) {
    this.handle = handle.strip();
  }

  get code(): NativePointer {
    return RelativeDirectPointer.resolve(this.handle.add(OFFSETOF_FUNCTION))!;
  }

  get expectedContextSize(): number {
    return this.handle.readU32(OFFSETOF_EXPECTED_CONTEXT_SIZE);
  }
}

export function isAsyncFunctionPointerSymbol(mangled: string): boolean {
  return /^_?\$[sS]/.test(mangled) && mangled.endsWith("Tu");
}

const recordsByModule = new Map<string, Map<string, NativePointer>>();

// The entry's async function pointer is its sibling `…Tu` record: exported, or via a cached symbol scan.
export function findAsyncFunctionPointer(module: Module, entryMangled: string): AsyncFunctionPointer | null {
  const name = entryMangled + "Tu";
  const exported = module.findExportByName(name);
  if (exported !== null) {
    return new AsyncFunctionPointer(exported);
  }
  let records = recordsByModule.get(module.path);
  if (records === undefined) {
    records = new Map();
    for (const s of module.enumerateSymbols()) {
      if (!s.address.isNull() && s.name.endsWith("Tu")) {
        records.set(s.name, s.address);
      }
    }
    recordsByModule.set(module.path, records);
  }
  const local = records.get(name);
  return local === undefined ? null : new AsyncFunctionPointer(local);
}

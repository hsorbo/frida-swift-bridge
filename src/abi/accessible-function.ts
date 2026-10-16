import { RelativeDirectPointer } from "../basic/relative-pointer.js";
import { AsyncFunctionPointer } from "./async-function-pointer.js";
import { demangle } from "../runtime/demangle.js";
import { getSwiftSection } from "../image/sections.js";
import { enumerateSwiftModules } from "../reflection/registry.js";

const RECORD_SIZE = 20;
const OFFSETOF_NAME = 0x0;
const OFFSETOF_GENERIC_ENVIRONMENT = 0x4;
const OFFSETOF_FUNCTION = 0xc;
const OFFSETOF_FLAGS = 0x10;

const FLAG_DISTRIBUTED = 0x1;

export class AccessibleFunctionRecord {
  constructor(readonly handle: NativePointer) {}

  get name(): string {
    return RelativeDirectPointer.resolve(this.handle.add(OFFSETOF_NAME))!.readUtf8String()!;
  }

  get demangledName(): string | null {
    return demangle(this.name);
  }

  get genericEnvironment(): NativePointer | null {
    return RelativeDirectPointer.resolve(this.handle.add(OFFSETOF_GENERIC_ENVIRONMENT));
  }

  // An async function pointer record, not code, for async/distributed thunks.
  get functionPointer(): NativePointer {
    return RelativeDirectPointer.resolve(this.handle.add(OFFSETOF_FUNCTION))!;
  }

  get asyncFunctionPointer(): AsyncFunctionPointer {
    return new AsyncFunctionPointer(this.functionPointer);
  }

  get isDistributed(): boolean {
    return (this.handle.readU32(OFFSETOF_FLAGS) & FLAG_DISTRIBUTED) !== 0;
  }
}

export function* enumerateAccessibleFunctions(module: Module): Generator<AccessibleFunctionRecord> {
  const section = getSwiftSection(module, "__swift5_acfuncs");
  if (section === null) {
    return;
  }
  const count = section.size / RECORD_SIZE;
  for (let i = 0; i < count; i++) {
    yield new AccessibleFunctionRecord(section.address.add(i * RECORD_SIZE));
  }
}

const resolved = new Map<string, AccessibleFunctionRecord>();

export function findAccessibleFunction(name: string): AccessibleFunctionRecord | null {
  const hit = resolved.get(name);
  if (hit !== undefined) {
    return hit;
  }
  for (const module of enumerateSwiftModules()) {
    for (const record of enumerateAccessibleFunctions(module)) {
      if (record.name === name || record.demangledName === name) {
        resolved.set(name, record);
        return record;
      }
    }
  }
  return null;
}

import {
  RelativeDirectPointer,
  RelativeIndirectablePointer,
} from "../basic/relative-pointer.js";
import { extendedTypeName } from "./extension-context-descriptor.js";

export enum ContextDescriptorKind {
  Module = 0,
  Extension = 1,
  Anonymous = 2,
  Protocol = 3,
  OpaqueType = 4,
  Class = 16,
  Struct = 17,
  Enum = 18,
}

const OFFSETOF_FLAGS = 0x0;
const OFFSETOF_PARENT = 0x4;
const OFFSETOF_NAME = 0x8;
const OFFSETOF_ACCESS_FUNCTION = 0xc;
const OFFSETOF_FIELDS = 0x10;

// An Extension descriptor stores the extended type as a mangled name where OFFSETOF_NAME sits.
const OFFSETOF_EXTENDED_CONTEXT = 0x8;
const SYMBOLIC_REF_DIRECT = 0x01;
const SYMBOLIC_REF_INDIRECT = 0x02;

const KIND_MASK = 0x1f;
const FLAG_IS_GENERIC = 0x80;

export class ContextDescriptor {
  constructor(readonly handle: NativePointer) {}

  get flags(): number {
    return this.handle.add(OFFSETOF_FLAGS).readU32();
  }

  get kind(): ContextDescriptorKind {
    return this.flags & KIND_MASK;
  }

  get isGeneric(): boolean {
    return (this.flags & FLAG_IS_GENERIC) !== 0;
  }

  get isType(): boolean {
    const kind = this.kind;
    return (
      kind === ContextDescriptorKind.Class ||
      kind === ContextDescriptorKind.Struct ||
      kind === ContextDescriptorKind.Enum
    );
  }

  get parent(): ContextDescriptor | null {
    const ptr = RelativeIndirectablePointer.resolve(
      this.handle.add(OFFSETOF_PARENT)
    );
    return ptr === null ? null : new ContextDescriptor(ptr);
  }

  get name(): string | null {
    const ptr = RelativeDirectPointer.resolve(this.handle.add(OFFSETOF_NAME));
    return ptr === null ? null : ptr.readUtf8String();
  }

  get accessFunction(): NativePointer | null {
    return RelativeDirectPointer.resolve(
      this.handle.add(OFFSETOF_ACCESS_FUNCTION)
    );
  }

  get fields(): NativePointer | null {
    return RelativeDirectPointer.resolve(this.handle.add(OFFSETOF_FIELDS));
  }

  get moduleName(): string | null {
    let ctx: ContextDescriptor | null = this;
    while (ctx !== null && ctx.kind !== ContextDescriptorKind.Module) {
      ctx = ctx.parent;
    }
    return ctx === null ? null : ctx.name;
  }

  // The nominal type extended by an Extension descriptor, when named by a direct
  // symbolic reference to its descriptor (the common non-generic case).
  get extendedTypeDescriptor(): ContextDescriptor | null {
    if (this.kind !== ContextDescriptorKind.Extension) {
      return null;
    }
    const mangled = RelativeDirectPointer.resolve(this.handle.add(OFFSETOF_EXTENDED_CONTEXT));
    if (mangled === null) {
      return null;
    }
    const kind = mangled.readU8();
    const relative = mangled.add(1);
    if (kind === SYMBOLIC_REF_DIRECT) {
      return new ContextDescriptor(relative.add(relative.readS32()));
    }
    if (kind === SYMBOLIC_REF_INDIRECT) {
      const target = relative.add(relative.readS32()).readPointer().strip();
      return target.isNull() ? null : new ContextDescriptor(target);
    }
    return null;
  }

  private memoizedFullTypeName: string | null | undefined;

  get fullTypeName(): string | null {
    if (this.memoizedFullTypeName === undefined) {
      this.memoizedFullTypeName = this.computeFullTypeName();
    }
    return this.memoizedFullTypeName;
  }

  private computeFullTypeName(): string | null {
    const name = this.name;
    if (name === null) {
      return null;
    }
    const components = [name];
    let ctx: ContextDescriptor | null = this.parent;
    while (ctx !== null) {
      const kind = ctx.kind;
      if (kind === ContextDescriptorKind.Class || kind === ContextDescriptorKind.Struct || kind === ContextDescriptorKind.Enum) {
        const parentName = ctx.name;
        if (parentName === null) {
          break;
        }
        components.unshift(parentName);
        ctx = ctx.parent;
        continue;
      }
      if (kind === ContextDescriptorKind.Extension) {
        const extended = extendedTypeName(ctx);
        return extended === null ? null : `${extended}.${components.join(".")}`;
      }
      if (kind === ContextDescriptorKind.Anonymous) {
        ctx = ctx.parent;
        continue;
      }
      break;
    }
    const module = ctx?.kind === ContextDescriptorKind.Module ? ctx.name : this.moduleName;
    return module === null ? components.join(".") : `${module}.${components.join(".")}`;
  }
}

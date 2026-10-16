import { ARM64E_ABI } from "../basic/pac.js";

const OFFSETOF_PARENT = 0x0;
const OFFSETOF_RESUME_PARENT = Process.pointerSize;

const ASYNC_CONTEXT_RESUME = 0xd707;

export class AsyncContext {
  constructor(readonly handle: NativePointer) {}

  get parent(): AsyncContext | null {
    const p = this.handle.readPointer(OFFSETOF_PARENT).strip();
    return p.isNull() ? null : new AsyncContext(p);
  }

  get resumeParent(): NativePointer {
    return this.handle.readPointer(OFFSETOF_RESUME_PARENT).strip();
  }

  setResumeParent(fn: NativePointer): void {
    const slot = this.handle.add(OFFSETOF_RESUME_PARENT);
    slot.writePointer(ARM64E_ABI ? fn.sign("ia", slot.blend(ASYNC_CONTEXT_RESUME)) : fn);
  }

  *ancestors(): Generator<AsyncContext> {
    let ctx = this.parent;
    while (ctx !== null) {
      yield ctx;
      ctx = ctx.parent;
    }
  }
}

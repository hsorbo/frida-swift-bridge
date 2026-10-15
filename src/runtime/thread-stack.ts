interface StackBounds {
  base: NativePointer;
  size: number;
}

let cachedCurrentThreadStack: (() => StackBounds) | null = null;

function bindCurrentThreadStack(): () => StackBounds {
  switch (Process.platform) {
    case "darwin": {
      const pthreadSelf = new NativeFunction(Module.getGlobalExportByName("pthread_self"), "pointer", []);
      const stackAddr = new NativeFunction(Module.getGlobalExportByName("pthread_get_stackaddr_np"), "pointer", ["pointer"]);
      const stackSize = new NativeFunction(Module.getGlobalExportByName("pthread_get_stacksize_np"), "size_t", ["pointer"]);
      return () => {
        const thread = pthreadSelf();
        const size = Number(stackSize(thread));
        return { base: stackAddr(thread).sub(size), size };
      };
    }
    case "windows": {
      const limits = new NativeFunction(Module.getGlobalExportByName("GetCurrentThreadStackLimits"), "void", ["pointer", "pointer"]);
      return () => {
        const out = Memory.alloc(Process.pointerSize * 2);
        limits(out, out.add(Process.pointerSize));
        const base = out.readPointer();
        return { base, size: out.add(Process.pointerSize).readPointer().sub(base).toUInt32() };
      };
    }
    default: {
      const pthreadSelf = new NativeFunction(Module.getGlobalExportByName("pthread_self"), "pointer", []);
      const getAttr = new NativeFunction(Module.getGlobalExportByName("pthread_getattr_np"), "int", ["pointer", "pointer"]);
      const getStack = new NativeFunction(Module.getGlobalExportByName("pthread_attr_getstack"), "int", ["pointer", "pointer", "pointer"]);
      const destroyAttr = new NativeFunction(Module.getGlobalExportByName("pthread_attr_destroy"), "int", ["pointer"]);
      const PTHREAD_ATTR_T_MAX_SIZE = 128;
      return () => {
        const attr = Memory.alloc(PTHREAD_ATTR_T_MAX_SIZE);
        const out = Memory.alloc(Process.pointerSize * 2);
        if (getAttr(pthreadSelf(), attr) !== 0) {
          throw new Error("pthread_getattr_np failed for the current thread");
        }
        getStack(attr, out, out.add(Process.pointerSize));
        destroyAttr(attr);
        return { base: out.readPointer(), size: Number(out.add(Process.pointerSize).readPointer()) };
      };
    }
  }
}

export function isOnCurrentThreadStack(address: NativePointer): boolean {
  cachedCurrentThreadStack ??= bindCurrentThreadStack();
  const { base, size } = cachedCurrentThreadStack();
  return address.compare(base) >= 0 && address.compare(base.add(size)) < 0;
}

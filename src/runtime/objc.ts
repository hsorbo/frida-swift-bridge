let cachedMsgSend: NativeFunction<NativePointer, [NativePointerValue, NativePointerValue]> | null = null;
let cachedUTF8StringSelector: NativePointer | null = null;
let cachedLookUpClass: NativeFunction<NativePointer, [NativePointerValue]> | null = null;

function getMsgSend(): NativeFunction<NativePointer, [NativePointerValue, NativePointerValue]> {
  if (cachedMsgSend === null) {
    const libobjc = Process.getModuleByName("libobjc.A.dylib");
    cachedMsgSend = new NativeFunction(libobjc.getExportByName("objc_msgSend"), "pointer", [
      "pointer",
      "pointer",
    ]);
  }
  return cachedMsgSend;
}

function getUTF8StringSelector(): NativePointer {
  if (cachedUTF8StringSelector === null) {
    const libobjc = Process.getModuleByName("libobjc.A.dylib");
    const selRegisterName = new NativeFunction(
      libobjc.getExportByName("sel_registerName"),
      "pointer",
      ["pointer"]
    );
    cachedUTF8StringSelector = selRegisterName(Memory.allocUtf8String("UTF8String")) as NativePointer;
  }
  return cachedUTF8StringSelector;
}

export function objcUTF8String(object: NativePointer): string | null {
  return getMsgSend()(object, getUTF8StringSelector()).readUtf8String();
}

function getLookUpClass(): NativeFunction<NativePointer, [NativePointerValue]> {
  if (cachedLookUpClass === null) {
    const libobjc = Process.getModuleByName("libobjc.A.dylib");
    cachedLookUpClass = new NativeFunction(libobjc.getExportByName("objc_lookUpClass"), "pointer", [
      "pointer",
    ]);
  }
  return cachedLookUpClass;
}

export function lookUpObjCClass(name: string): NativePointer | null {
  const cls = getLookUpClass()(Memory.allocUtf8String(name));
  return cls.isNull() ? null : cls;
}

let cachedGetProtocol: NativeFunction<NativePointer, [NativePointerValue]> | null = null;

export function lookUpObjCProtocol(name: string): NativePointer | null {
  if (cachedGetProtocol === null) {
    const libobjc = Process.findModuleByName("libobjc.A.dylib");
    if (libobjc === null) {
      return null;
    }
    cachedGetProtocol = new NativeFunction(libobjc.getExportByName("objc_getProtocol"), "pointer", ["pointer"]);
  }
  const protocol = cachedGetProtocol(Memory.allocUtf8String(name));
  return protocol.isNull() ? null : protocol;
}

let cachedRetainCountSend: NativeFunction<UInt64, [NativePointerValue, NativePointerValue]> | null = null;
let cachedRetainCountSelector: NativePointer | null = null;

export function objcRetainCount(object: NativePointer): number {
  if (cachedRetainCountSend === null) {
    const libobjc = Process.getModuleByName("libobjc.A.dylib");
    cachedRetainCountSend = new NativeFunction(libobjc.getExportByName("objc_msgSend"), "size_t", [
      "pointer",
      "pointer",
    ]);
    const selRegisterName = new NativeFunction(
      libobjc.getExportByName("sel_registerName"),
      "pointer",
      ["pointer"]
    );
    cachedRetainCountSelector = selRegisterName(Memory.allocUtf8String("retainCount")) as NativePointer;
  }
  return Number(cachedRetainCountSend(object, cachedRetainCountSelector!));
}

let cachedClassGetSuperclass: NativeFunction<NativePointer, [NativePointerValue]> | null = null;
let cachedClassGetName: NativeFunction<NativePointer, [NativePointerValue]> | null = null;

export function objcSuperclass(cls: NativePointer): NativePointer | null {
  if (cachedClassGetSuperclass === null) {
    const libobjc = Process.getModuleByName("libobjc.A.dylib");
    cachedClassGetSuperclass = new NativeFunction(libobjc.getExportByName("class_getSuperclass"), "pointer", [
      "pointer",
    ]);
  }
  const superclass = cachedClassGetSuperclass(cls);
  return superclass.isNull() ? null : superclass;
}

export function objcClassName(cls: NativePointer): string {
  if (cachedClassGetName === null) {
    const libobjc = Process.getModuleByName("libobjc.A.dylib");
    cachedClassGetName = new NativeFunction(libobjc.getExportByName("class_getName"), "pointer", ["pointer"]);
  }
  return cachedClassGetName(cls).readUtf8String()!;
}

const CPU_SUBTYPE_ARM64E = 2;

// Only an arm64e process signs pointers and may execute pac instructions; an arm64 process on
// Darwin calls through bare blr, and on pre-A12 silicon pacia is an undefined instruction.
function isArm64eProcess(): boolean {
  if (Process.platform !== "darwin" || Process.arch !== "arm64") {
    return false;
  }
  const cpusubtype = Process.mainModule.base.add(8).readU32();
  return (cpusubtype & 0xff) === CPU_SUBTYPE_ARM64E;
}

export const ARM64E_ABI = isArm64eProcess();

export function signCode(code: NativePointer): NativePointer {
  return ARM64E_ABI ? code.strip().sign("ia", ptr(0)) : code;
}

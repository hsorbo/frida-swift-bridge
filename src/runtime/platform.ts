export const SWIFT_HOST_SUPPORTED =
  (Process.arch === "arm64" || Process.arch === "x64") &&
  (Process.platform === "darwin" || Process.platform === "linux" || Process.platform === "windows");

export function runtimeLibraryName(stem: string): string {
  switch (Process.platform) {
    case "darwin":
      return `lib${stem}.dylib`;
    case "windows":
      return `${stem}.dll`;
    default:
      return `lib${stem}.so`;
  }
}

export const LIBSWIFT_CORE_NAME = runtimeLibraryName("swiftCore");

export function ensureSwiftHost(): void {
  if (!SWIFT_HOST_SUPPORTED) {
    throw new Error(`unsupported Swift host: ${Process.arch}/${Process.platform}`);
  }
}

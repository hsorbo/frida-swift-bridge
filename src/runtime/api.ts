import { ensureSwiftHost, LIBSWIFT_CORE_NAME } from "./platform.js";
import { makeTwoWordResultFunction, TwoWordResult } from "./swiftcc.js";

const LIBSWIFT_CORE_CANDIDATES =
  Process.platform === "darwin"
    ? ["libswiftCore.dylib", "/usr/lib/swift/libswiftCore.dylib"]
    : Process.platform === "windows"
      ? ["swiftCore.dll"]
      : ["libswiftCore.so", "/usr/lib/swift/linux/libswiftCore.so"];

function loadLibswiftCore(): Module {
  const existing = Process.findModuleByName(LIBSWIFT_CORE_NAME);
  if (existing !== null) {
    return existing;
  }

  let lastError: Error | null = null;
  for (const candidate of LIBSWIFT_CORE_CANDIDATES) {
    try {
      return Module.load(candidate);
    } catch (e) {
      lastError = e as Error;
    }
  }
  throw lastError ?? new Error(`${LIBSWIFT_CORE_NAME} not found`);
}

export interface SwiftCoreApi {
  swift_demangle: NativeFunction<
    NativePointer,
    [NativePointerValue, number | UInt64, NativePointerValue, NativePointerValue, number]
  >;
  swift_getTypeByMangledNameInContext: NativeFunction<
    NativePointer,
    [NativePointerValue, number | UInt64, NativePointerValue, NativePointerValue]
  >;
  swift_conformsToProtocol: NativeFunction<
    NativePointer,
    [NativePointerValue, NativePointerValue]
  >;
  swift_projectBox: NativeFunction<NativePointer, [NativePointerValue]>;
  swift_getErrorValue: NativeFunction<
    void,
    [NativePointerValue, NativePointerValue, NativePointerValue]
  >;
  swift_getTypeName: (type: NativePointerValue, qualified: number) => TwoWordResult<NativePointer, UInt64>;
  swift_getMangledTypeName: (type: NativePointerValue) => TwoWordResult<NativePointer, UInt64>;
  swift_allocObject: NativeFunction<
    NativePointer,
    [NativePointerValue, number | UInt64, number | UInt64]
  >;
  swift_allocBox: NativeFunction<NativePointer, [NativePointerValue]>;
  swift_deallocObject: NativeFunction<
    void,
    [NativePointerValue, number | UInt64, number | UInt64]
  >;
  swift_retain: NativeFunction<NativePointer, [NativePointerValue]>;
  swift_release: NativeFunction<void, [NativePointerValue]>;
  swift_errorRelease: NativeFunction<void, [NativePointerValue]>;
  swift_retainCount: NativeFunction<UInt64, [NativePointerValue]>;
  swift_deallocClassInstance: NativeFunction<
    void,
    [NativePointerValue, number | UInt64, number | UInt64]
  >;
  swift_isUniquelyReferenced_native: NativeFunction<number, [NativePointerValue]>;
  swift_unknownObjectRetain: NativeFunction<NativePointer, [NativePointerValue]>;
  swift_unknownObjectRelease: NativeFunction<void, [NativePointerValue]>;
  swift_weakLoadStrong: NativeFunction<NativePointer, [NativePointerValue]>;
  swift_isUniquelyReferenced_nonNull: NativeFunction<number, [NativePointerValue]>;
  swift_getObjectType: NativeFunction<NativePointer, [NativePointerValue]>;
  swift_getExistentialTypeMetadata: NativeFunction<
    NativePointer,
    [number, NativePointerValue, number | UInt64, NativePointerValue]
  >;
  swift_getTupleTypeMetadata: NativeFunction<
    NativePointer,
    [number | UInt64, number | UInt64, NativePointerValue, NativePointerValue, NativePointerValue]
  >;
  swift_getAssociatedTypeWitness: NativeFunction<
    NativePointer,
    [number | UInt64, NativePointerValue, NativePointerValue, NativePointerValue, NativePointerValue]
  >;
  swift_getAssociatedConformanceWitness: NativeFunction<
    NativePointer,
    [NativePointerValue, NativePointerValue, NativePointerValue, NativePointerValue, NativePointerValue]
  >;
  swift_dynamicCastMetatype: NativeFunction<NativePointer, [NativePointerValue, NativePointerValue]>;
  swift_dynamicCastTypeToObjCProtocolConditional: NativeFunction<
    NativePointer,
    [NativePointerValue, number | UInt64, NativePointerValue]
  > | null;
}

let cachedSwiftCore: SwiftCoreApi | null = null;

export function getSwiftCoreApi(): SwiftCoreApi {
  ensureSwiftHost();
  if (cachedSwiftCore !== null) {
    return cachedSwiftCore;
  }

  const lib = loadLibswiftCore();
  lib.ensureInitialized();

  cachedSwiftCore = {
    swift_demangle: new NativeFunction(lib.getExportByName("swift_demangle"), "pointer", [
      "pointer",
      "size_t",
      "pointer",
      "pointer",
      "int32",
    ]),
    swift_getTypeByMangledNameInContext: new NativeFunction(
      lib.getExportByName("swift_getTypeByMangledNameInContext"),
      "pointer",
      ["pointer", "size_t", "pointer", "pointer"]
    ),
    swift_conformsToProtocol: new NativeFunction(
      lib.getExportByName("swift_conformsToProtocol"),
      "pointer",
      ["pointer", "pointer"]
    ),
    swift_projectBox: new NativeFunction(
      lib.getExportByName("swift_projectBox"),
      "pointer",
      ["pointer"]
    ),
    swift_getErrorValue: new NativeFunction(
      lib.getExportByName("swift_getErrorValue"),
      "void",
      ["pointer", "pointer", "pointer"]
    ),
    swift_getTypeName: makeTwoWordResultFunction(
      lib.getExportByName("swift_getTypeName"),
      ["pointer", "size_t"],
      ["pointer", "bool"]
    ),
    swift_getMangledTypeName: makeTwoWordResultFunction(
      lib.getExportByName("swift_getMangledTypeName"),
      ["pointer", "size_t"],
      ["pointer"]
    ),
    swift_allocObject: new NativeFunction(
      lib.getExportByName("swift_allocObject"),
      "pointer",
      ["pointer", "size_t", "size_t"]
    ),
    swift_allocBox: new NativeFunction(
      lib.getExportByName("swift_allocBox"),
      "pointer",
      ["pointer"]
    ),
    swift_deallocObject: new NativeFunction(
      lib.getExportByName("swift_deallocObject"),
      "void",
      ["pointer", "size_t", "size_t"]
    ),
    swift_retain: new NativeFunction(lib.getExportByName("swift_retain"), "pointer", [
      "pointer",
    ]),
    swift_release: new NativeFunction(lib.getExportByName("swift_release"), "void", [
      "pointer",
    ]),
    swift_errorRelease: new NativeFunction(lib.getExportByName("swift_errorRelease"), "void", [
      "pointer",
    ]),
    swift_retainCount: new NativeFunction(
      lib.getExportByName("swift_retainCount"),
      "size_t",
      ["pointer"]
    ),
    swift_deallocClassInstance: new NativeFunction(
      lib.getExportByName("swift_deallocClassInstance"),
      "void",
      ["pointer", "size_t", "size_t"]
    ),
    swift_isUniquelyReferenced_native: new NativeFunction(
      lib.getExportByName("swift_isUniquelyReferenced_native"),
      "bool",
      ["pointer"]
    ),
    swift_unknownObjectRetain: new NativeFunction(
      lib.getExportByName(Process.platform === "darwin" ? "swift_unknownObjectRetain" : "swift_retain"),
      "pointer",
      ["pointer"]
    ),
    swift_unknownObjectRelease: new NativeFunction(
      lib.getExportByName(Process.platform === "darwin" ? "swift_unknownObjectRelease" : "swift_release"),
      "void",
      ["pointer"]
    ),
    swift_weakLoadStrong: new NativeFunction(
      lib.getExportByName(Process.platform === "darwin" ? "swift_unknownObjectWeakLoadStrong" : "swift_weakLoadStrong"),
      "pointer",
      ["pointer"]
    ),
    swift_isUniquelyReferenced_nonNull: new NativeFunction(
      lib.getExportByName("swift_isUniquelyReferenced_nonNull"),
      "bool",
      ["pointer"]
    ),
    swift_getObjectType: new NativeFunction(
      lib.getExportByName("swift_getObjectType"),
      "pointer",
      ["pointer"]
    ),
    swift_getExistentialTypeMetadata: new NativeFunction(
      lib.getExportByName("swift_getExistentialTypeMetadata"),
      "pointer",
      ["uint8", "pointer", "size_t", "pointer"]
    ),
    swift_getTupleTypeMetadata: new NativeFunction(
      lib.getExportByName("swift_getTupleTypeMetadata"),
      "pointer",
      ["size_t", "size_t", "pointer", "pointer", "pointer"]
    ),
    swift_getAssociatedTypeWitness: new NativeFunction(
      lib.getExportByName("swift_getAssociatedTypeWitness"),
      "pointer",
      ["size_t", "pointer", "pointer", "pointer", "pointer"]
    ),
    swift_getAssociatedConformanceWitness: new NativeFunction(
      lib.getExportByName("swift_getAssociatedConformanceWitness"),
      "pointer",
      ["pointer", "pointer", "pointer", "pointer", "pointer"]
    ),
    swift_dynamicCastMetatype: new NativeFunction(
      lib.getExportByName("swift_dynamicCastMetatype"),
      "pointer",
      ["pointer", "pointer"]
    ),
    swift_dynamicCastTypeToObjCProtocolConditional:
      Process.platform === "darwin"
        ? new NativeFunction(lib.getExportByName("swift_dynamicCastTypeToObjCProtocolConditional"), "pointer", [
            "pointer",
            "size_t",
            "pointer",
          ])
        : null,
  };
  return cachedSwiftCore;
}

type EnumerateMetadataSections = NativeFunction<
  void,
  [NativePointerValue, NativePointerValue]
>;

let cachedEnumerateSections: EnumerateMetadataSections | null = null;

export function getEnumerateMetadataSections(): EnumerateMetadataSections {
  ensureSwiftHost();
  if (cachedEnumerateSections !== null) {
    return cachedEnumerateSections;
  }
  const lib = loadLibswiftCore();
  cachedEnumerateSections = new NativeFunction(
    lib.getExportByName("swift_enumerateAllMetadataSections"),
    "void",
    ["pointer", "pointer"]
  );
  return cachedEnumerateSections;
}

export interface MachOApi {
  getsectiondata: NativeFunction<
    NativePointer,
    [NativePointerValue, NativePointerValue, NativePointerValue, NativePointerValue]
  >;
}

let cachedMachO: MachOApi | null = null;

export function getMachOApi(): MachOApi {
  ensureSwiftHost();
  if (cachedMachO !== null) {
    return cachedMachO;
  }

  const lib = Process.getModuleByName("libmacho.dylib");
  lib.ensureInitialized();

  cachedMachO = {
    getsectiondata: new NativeFunction(lib.getExportByName("getsectiondata"), "pointer", [
      "pointer",
      "pointer",
      "pointer",
      "pointer",
    ]),
  };
  return cachedMachO;
}

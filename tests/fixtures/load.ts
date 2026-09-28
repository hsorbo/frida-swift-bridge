import { toByteArray } from "base64-js";
import { requireSwift } from "../swift.js";
import { FIXTURE_DYLIB, RESILIENT_DYLIB, FIXTURESYMS_DYLIB, NOMETADATA_DYLIB, CONFORMANCE_DYLIB, OPTIMIZED_DYLIB } from "./paths.js";
import { FIXTURE_B64, RESILIENT_B64, FIXTURESYMS_B64, NOMETADATA_B64, CONFORMANCE_B64, OPTIMIZED_B64 } from "./bytes.js";
import { Metadata, makeSwiftNativeFunction, metadataFor } from "../../src/abi.js";
import { Swift } from "../../src/index.js";
const EXT = Process.platform === "darwin" ? "dylib" : "so";
export const FIXTURE_MODULE = `fixture.${EXT}`;
export const RESILIENT_MODULE = `resilient.${EXT}`;
export const FIXTURESYMS_MODULE = `fixturesyms.${EXT}`;
export const NOMETADATA_MODULE = `nometadata.${EXT}`;
export const CONFORMANCE_MODULE = `conformance.${EXT}`;
export const OPTIMIZED_MODULE = `optimized.${EXT}`;

function materialize(name: string, base64: string): string {
  const path = `${Process.getTmpDir()}/${name}`;
  File.writeAllBytes(path, toByteArray(base64).buffer as ArrayBuffer);
  return path;
}

function loadModule(path: string, name: string, base64: string): Module {
  requireSwift();
  const existing = Process.findModuleByName(name);
  if (existing !== null) {
    return existing;
  }
  Module.load(base64.length > 0 ? materialize(name, base64) : path);
  return Process.getModuleByName(name);
}

export function loadFixture(): Module {
  loadResilient();
  return loadModule(FIXTURE_DYLIB, FIXTURE_MODULE, FIXTURE_B64);
}

export function loadResilient(): Module {
  return loadModule(RESILIENT_DYLIB, RESILIENT_MODULE, RESILIENT_B64);
}

// fixture.swift compiled under a second module name, left unstripped: same types
// as fixture but with the value-type init symbols retained in .symtab.
export function loadFixtureSyms(): Module {
  loadResilient();
  return loadModule(FIXTURESYMS_DYLIB, FIXTURESYMS_MODULE, FIXTURESYMS_B64);
}

export function loadNoMetadata(): Module {
  loadFixture();
  return loadModule(NOMETADATA_DYLIB, NOMETADATA_MODULE, NOMETADATA_B64);
}

export function loadConformance(): Module {
  loadFixture();
  return loadModule(CONFORMANCE_DYLIB, CONFORMANCE_MODULE, CONFORMANCE_B64);
}

export function loadOptimized(): Module {
  return loadModule(OPTIMIZED_DYLIB, OPTIMIZED_MODULE, OPTIMIZED_B64);
}

export function fixtureExport(swiftName: string, mod: Module = loadFixture()): NativePointer {
  for (const e of mod.enumerateExports()) {
    const demangled = Swift.demangle(e.name);
    if (demangled !== null && demangled.includes(swiftName)) {
      return e.address;
    }
  }
  throw new Error(`fixture export not found: ${swiftName}`);
}

export function existentialMetadata(accessor: string, mod?: Module): Metadata {
  const RawPointer = metadataFor("Swift.UnsafeRawPointer")!;
  const get = makeSwiftNativeFunction(fixtureExport(accessor, mod), RawPointer, []);
  return new Metadata(get()!.readPointer());
}

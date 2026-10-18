import { counter } from "@frida/injest/agent";
import { Swift } from "../src/index.js";
import { loadFixture } from "../tests/fixtures/load.js";

// Evaluated once however many bench files import it. The primitives a listing or lookup must
// not multiply: each is a whole-module or whole-process read. The Swift runtime entry points
// are the bridge's own, so they show how much metadata work a call does.
loadFixture();
const swift = Swift.api;
counter("symbolTables", Module.prototype, "enumerateSymbols");
counter("exportTables", Module.prototype, "enumerateExports");
counter("resolverQueries", ApiResolver.prototype, "enumerateMatches");
counter("moduleLists", Process, "enumerateModules");
counter("pointerScans", Memory, "findPointers");
counter("conformsToProtocol", swift.swift_conformsToProtocol);
counter("demangle", swift.swift_demangle);
counter("typeByMangledName", swift.swift_getTypeByMangledNameInContext);
counter("functionRanges", Process, "findFunctionRange");
counter(
  "swiftSections",
  Process.platform === "darwin"
    ? Process.getModuleByName("libmacho.dylib").getExportByName("getsectiondata")
    : Process.findModuleByAddress(swift.swift_conformsToProtocol)!.getExportByName("swift_enumerateAllMetadataSections"),
);

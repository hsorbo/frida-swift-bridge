import { bench, describe } from "@frida/injest/agent";
import { Swift, SwiftFunctionSlot } from "../src/index.js";
import { FIXTURE_MODULE } from "../tests/fixtures/load.js";
import "./counters.js";

const fixture = Process.getModuleByName(FIXTURE_MODULE);
const swiftCore = Process.findModuleByAddress(Swift.api.swift_conformsToProtocol)!;

function firstSlot(filter: Module | string): SwiftFunctionSlot {
  for (const m of Swift.enumerateFunctions(filter, { slots: true })) {
    if (m.signature === null) {
      return m;
    }
  }
  throw new Error(`no slot in ${filter}`);
}

describe("function listing", () => {
  bench("enumerateFunctions over a module", ({ measure }) => {
    measure(() => [...Swift.enumerateFunctions(fixture)]);
  });

  bench("enumerateFunctions with slots over a module", ({ measure }) => {
    measure(() => [...Swift.enumerateFunctions(fixture, { slots: true })]);
  });

  bench(
    "enumerateFunctions over swiftCore",
    ({ measure }) => {
      measure(() => [...Swift.enumerateFunctions(swiftCore)]);
    },
    { warmup: 1, iterations: 3 },
  );

  bench(
    "enumerateFunctions with slots over swiftCore",
    ({ measure }) => {
      measure(() => [...Swift.enumerateFunctions(swiftCore, { slots: true })]);
    },
    { warmup: 1, iterations: 3 },
  );

  bench(
    "enumerateFunctions with slots by a type glob",
    ({ measure }) => {
      measure(() => [...Swift.enumerateFunctions("fixture.SlotSubHost.*", { slots: true })]);
    },
    { warmup: 1, iterations: 3 },
  );
});

describe("function lookup", ({ skip }) => {
  if (Process.platform === "windows") {
    skip("findFunctionByAddress is refused on Windows");
  }

  bench("findFunctionByAddress inside an exported function", ({ measure }) => {
    const addInts = fixture.getExportByName("$s7fixture7addIntsyS2i_SitF");
    measure(() => Swift.findFunctionByAddress(addInts.add(4)));
  });

  bench("findFunctionByAddress inside an unnamed slot", ({ measure }) => {
    const slot = firstSlot("fixture.SlotSubHost.*");
    measure(() => Swift.findFunctionByAddress(slot.address.add(4)));
  });

  bench(
    "findFunctionByAddress of a swiftCore witness",
    ({ measure }) => {
      const witness = firstSlot(swiftCore);
      measure(() => Swift.findFunctionByAddress(witness.address));
    },
    { warmup: 1, iterations: 5 },
  );
});

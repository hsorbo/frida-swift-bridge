import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { ClassType, AsyncFunctionPointer, driveAsyncCall, metadataFor, typeOf } from "../src/abi.js";

const GA_FREE_ASYNC_AFP = "$s7fixture11gaFreeAsyncyS2iYaFTu";

function gaHolder(v: number) {
  return (typeOf(metadataFor("fixture.GAHolder")!) as ClassType).facade.init(v);
}

function wholeGAHolder(v: number) {
  return (typeOf(metadataFor("fixture.WholeGAHolder")!) as ClassType).facade.init(v);
}

// A generic global actor's executor is its default-actor singleton, drained by the cooperative pool;
// the async body hops there itself, so these need no InitialSerialExecutor and don't touch the main queue.
describe("generic global-actor async calling", () => {
  beforeEach(() => {
    loadFixture();
  });

  test("drives a @globalActor-isolated free function: gaFreeAsync(41) ⇒ 42", () => {
    const afp = new AsyncFunctionPointer(loadFixture().getExportByName(GA_FREE_ASYNC_AFP).strip());
    expect(Number(driveAsyncCall(afp, [ptr(41)]).readS64())).toBe(42);
  });

  test("a @globalActor-isolated method on a plain class is neither actor nor default actor", () => {
    const t = typeOf(metadataFor("fixture.GAHolder")!) as ClassType;
    expect(t.isActor).toBe(false);
    expect(t.isDefaultActor).toBe(false);
  });

  test("drives a @globalActor-isolated method on a plain class: gaMethodAsync(1) ⇒ 11", async () => {
    expect(await gaHolder(10).gaMethodAsync(1)).toEqual(int64(11));
  });

  test("a @globalActor-isolated method mutates instance state across calls", async () => {
    const h = gaHolder(10);
    expect(await h.gaMethodAsync(1)).toEqual(int64(11));
    expect(await h.gaMethodAsync(2)).toEqual(int64(13));
  });

  test("drives a method on a whole-type @globalActor-isolated class: bumpAsync(1) ⇒ 11", async () => {
    expect(await wholeGAHolder(10).bumpAsync(1)).toEqual(int64(11));
  });

  test("serializes concurrent calls on a global actor: 20 × gaMethodAsync(1)", async () => {
    const h = gaHolder(0);
    const results = await Promise.all(Array.from({ length: 20 }, () => h.gaMethodAsync(1)));
    expect(new Set(results)).toEqual(new Set(Array.from({ length: 20 }, (_, i) => int64(i + 1))));
  });
});

// Known limitation: @MainActor hops to the main dispatch queue, which only the target's main thread can
// drain. The facade uses the non-blocking callAsync, so this resolves in a live app whose main thread pumps
// its runloop — but not in the headless test host (main thread never enters a runloop), so it is skipped.
// Un-skip on a device / live-app run. Blocking driveAsyncCall can never support @MainActor.
describe("@MainActor async calling (needs a pumping main runloop)", () => {
  beforeEach(() => {
    loadFixture();
  });

  test.skip("resolves a @MainActor method via the facade: mainMethodAsync(1) ⇒ 11", async () => {
    const h = (typeOf(metadataFor("fixture.MainHolder")!) as ClassType).facade.init(10);
    expect(await h.mainMethodAsync(1)).toEqual(int64(11));
  });
});

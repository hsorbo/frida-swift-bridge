import { test, expect, describe } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms, fixtureExport, existentialMetadata } from "./fixtures/load.js";
import { requireSwift } from "./swift.js";

import { Metadata, Protocol, projectExistentialValue, BoundAsyncMethod, metadataFor } from "../src/abi.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";

import { Swift } from "../src/index.js";
function ptrValue(p: NativePointer): NativePointer {
  const cell = Memory.alloc(Process.pointerSize);
  cell.writePointer(p);
  return cell;
}

function store(mod: Module, fn: string, metadata: Metadata): NativePointer {
  const RawPointer = metadataFor("Swift.UnsafeMutableRawPointer")!;
  const container = Memory.alloc(metadata.typeLayout.stride);
  makeSwiftNativeFunction(fixtureExport(fn, mod), null, [RawPointer])(ptrValue(container));
  return container;
}

describe("async witness-table method invocation", () => {
  test("awaits an async protocol requirement by name (TripleScaler : AsyncScaler)", async () => {
    requireSwift();
    const mod = loadFixtureSyms();
    const AsyncScaler = existentialMetadata("fixturesyms.asyncScalerType", mod);
    const container = store(mod, "fixturesyms.storeAsyncScaler", AsyncScaler);
    const { type, value } = projectExistentialValue(AsyncScaler, container);

    const proto = Protocol.find("fixturesyms.AsyncScaler")!;
    const table = proto.conformanceFor(type)!;
    const bound = table.method(value, "scaled");
    expect(bound instanceof BoundAsyncMethod).toBe(true);
    expect(await (bound as BoundAsyncMethod).call(7)).toEqual(int64(21));
  });

  test("awaits a default implementation from a protocol extension (TripleScaler : AsyncScaler)", async () => {
    requireSwift();
    const mod = loadFixtureSyms();
    const AsyncScaler = existentialMetadata("fixturesyms.asyncScalerType", mod);
    const container = store(mod, "fixturesyms.storeAsyncScaler", AsyncScaler);
    const { type, value } = projectExistentialValue(AsyncScaler, container);

    const table = Protocol.find("fixturesyms.AsyncScaler")!.conformanceFor(type)!;
    const bound = table.method(value, "scaledTwice") as BoundAsyncMethod;
    expect(await bound.call(2)).toEqual(int64(18));
  });

  test("an async default on a stripped conformance is refused rather than guessed (TripleScaler : AsyncScaler)", () => {
    const mod = loadFixture();
    const AsyncScaler = existentialMetadata("fixture.asyncScalerType", mod);
    const container = store(mod, "fixture.storeAsyncScaler", AsyncScaler);
    const { type, value } = projectExistentialValue(AsyncScaler, container);

    const table = Protocol.find("fixture.AsyncScaler")!.conformanceFor(type)!;
    expect(() => table.method(value, "scaledTwice")).toThrow(/cannot tell/);
  });
});

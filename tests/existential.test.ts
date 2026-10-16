import { test, expect, describe } from "@frida/injest/agent";
import { fixtureExport } from "./fixtures/load.js";

import { Metadata, readValue, readObject, existentialRepresentation, metadataFor, metadataOf } from "../src/abi.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";

import { Swift } from "../src/index.js";
function ptrValue(p: NativePointer): NativePointer {
  const cell = Memory.alloc(Process.pointerSize);
  cell.writePointer(p);
  return cell;
}

function store(fn: string, metadata: Metadata): NativePointer {
  const RawPointer = metadataFor("Swift.UnsafeMutableRawPointer")!;
  const container = Memory.alloc(metadata.typeLayout.stride);
  makeSwiftNativeFunction(fixtureExport(fn), null, [RawPointer])(ptrValue(container));
  return container;
}

describe("readValue existential", () => {
  test("decodes an inline value type from an Any container", () => {
    const Any_ = metadataOf(Swift.reflect("Any")!);
    expect(existentialRepresentation(Any_)).toBe("opaque");
    expect(readValue(Any_, store("fixture.storeAnyInt", Any_))).toEqual(int64(42));
  });

  test("decodes an out-of-line (boxed) value type from an Any container", () => {
    const Any_ = metadataOf(Swift.reflect("Any")!);
    expect(readValue(Any_, store("fixture.storeAnyBig", Any_))).toEqual({
      a: int64(1),
      b: int64(2),
      c: int64(3),
      d: int64(4),
      e: int64(5),
    });
  });

  test("decodes a value type behind a protocol existential", () => {
    const Greeter = metadataOf(Swift.reflect("any fixture.Greeter")!);
    expect(existentialRepresentation(Greeter)).toBe("opaque");
    expect(readValue(Greeter, store("fixture.storeGreeter", Greeter))).toEqual({
      name: "Ada",
    });
  });

  test("decodes a class reference from a class-constrained existential", () => {
    const Named = metadataOf(Swift.reflect("any fixture.Named")!);
    expect(existentialRepresentation(Named)).toBe("class");
    const ref = readValue(Named, store("fixture.storeNamed", Named)) as NativePointer;
    expect(ref.isNull()).toBe(false);
    expect(readObject(ref)).toEqual({ label: "Bee" });
  });

  test("decodes the boxed value behind an Error existential", () => {
    const Error_ = metadataOf(Swift.reflect("any Swift.Error")!);
    expect(existentialRepresentation(Error_)).toBe("error");
    expect(readValue(Error_, store("fixture.storeError", Error_))).toEqual({ code: int64(7) });
  });
});

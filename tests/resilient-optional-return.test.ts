import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadResilient } from "./fixtures/load.js";

import { Swift, SwiftStruct } from "../src/index.js";
import { metadataFor, typeOf } from "../src/abi.js";

// resilient.ResilientHolder wraps a class ref (like Foundation.URL wraps NSURL): resilient ABI
// (returned @out) yet non-POD. Optional<ResilientHolder> must inherit that address-only ABI and be
// decoded/destroyed through its payload, not the Optional wrapper.
function optionalHolder() {
  return typeOf(metadataFor("Swift.Optional", [metadataFor("resilient.ResilientHolder")!])!);
}

function fn(mod: Module, mangled: string, ret: unknown, args: unknown[]) {
  return Swift.NativeFunction(mod.getExportByName(mangled), ret as never, args as never[]);
}

describe("Optional<resilient struct wrapping a class ref> return", () => {
  let mod: Module;
  beforeEach(() => {
    mod = loadResilient();
  });

  test(".some unwraps to a facade whose class ref survives decode and destroy", () => {
    const make = fn(mod, "$s9resilient10makeHolderyAA09ResilientC0VSgSiF", optionalHolder(), [Swift.type("Swift.Int")!]);
    const holder = make(7) as any;
    expect(holder).not.toBeNull();
    expect(holder.$type.name).toBe("resilient.ResilientHolder");

    const tokenId = fn(mod, "$s9resilient13holderTokenIdySiAA15ResilientHolderVF", Swift.type("Swift.Int")!, [Swift.type("resilient.ResilientHolder")!]);
    expect(tokenId(holder)).toEqual(int64(7));
    holder.$dispose();
  });

  test(".none decodes to null", () => {
    const make = fn(mod, "$s9resilient10makeHolderyAA09ResilientC0VSgSiF", optionalHolder(), [Swift.type("Swift.Int")!]);
    expect(make(-1)).toBeNull();
  });

  test("a failable initializer returns a facade or null", () => {
    const holder = Swift.type("resilient.ResilientHolder") as SwiftStruct;
    expect(holder.$initializer({ labels: ["id"] }).call(9)).not.toBeNull();
    expect(holder.$initializer({ labels: ["id"] }).call(-1)).toBeNull();
  });
});

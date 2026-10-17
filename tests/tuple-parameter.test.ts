import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms } from "./fixtures/load.js";
import { requireSymbolTable } from "./swift.js";

import { Swift, SwiftClass, SwiftStruct } from "../src/index.js";
import { ClassType, metadataFor, typeOf } from "../src/abi.js";

const PACKED_SUM = "$s7fixture9packedSumySis4Int8V_ADt_tF";
const PACKED_SUM_ASYNC = "$s7fixture14packedSumAsyncySis4Int8V_ADt_tYaF";

describe("a tuple parameter the signature spells is passed element by element", () => {
  let module: Module;
  beforeEach(() => { module = loadFixture(); });

  test("sub-word elements each keep a register in a free function, sync and async", async () => {
    expect(Swift.function(module, PACKED_SUM).call([1, 2])).toEqual(int64(12));
    expect(await Swift.function(module, PACKED_SUM_ASYNC).call([3, 4])).toEqual(int64(34));
  });

  test("a generic method lowers a concrete tuple beside its type parameter", () => {
    const Int = metadataFor("Swift.Int")!;
    const box = (typeOf(metadataFor("fixture.Box")!) as ClassType).facade.init();
    expect(box.$method("packedPlus", { typeArguments: [typeOf(Int)] }).call([1, 2], 5)).toEqual(int64(20));
  });

  test("a protocol-extension method takes a concrete tuple per element", () => {
    const source = (Swift.type("fixture.IntSource") as SwiftStruct).$new({ value: 5 });
    expect(source.packed([1, 2])).toEqual(int64(12));
  });

  test("an async protocol-extension method takes a concrete tuple per element", async (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const source = (Swift.type("fixturesyms.IntSource") as SwiftStruct).$new({ value: 5 });
    expect(await source.packedLater([3, 4])).toEqual(int64(34));
  });

  test("a setter takes its tuple new value per element", () => {
    const box = (Swift.type("fixture.PackedBox") as SwiftClass).init();
    box.$set("packed", [1, 2]);
    expect(box.$field("v").read()).toEqual(int64(12));
    expect(box.$get("packed")).toEqual([1, 2]);
  });
});

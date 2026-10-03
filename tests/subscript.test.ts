import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { Swift, SwiftClass, SwiftStruct, type SwiftValueObject, type SwiftClassObject, type CallResult, type SwiftValue } from "../src/index.js";
import { SwiftInterceptor } from "../src/runtime/interceptor.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";
import { metadataFor } from "../src/abi.js";

function grid(): SwiftValueObject {
  return (Swift.type("fixture.Grid") as SwiftStruct).init([1, 2, 3, 4]) as SwiftValueObject;
}

describe("subscripts", () => {
  beforeEach(() => { loadFixture(); });

  test("$subscript calls the getter named by its selector or labels, $setSubscript the setter", () => {
    const g = grid();
    expect(g.$subscript(1, "subscript(_:)")).toEqual(int64(2));
    expect(g.$subscript(1, { labels: [null] })).toEqual(int64(2));
    expect(g.$subscript(1, 0, "subscript(row:column:)")).toEqual(int64(3));
    expect(g.$subscript(2, { labels: ["tracked"] })).toEqual(int64(3));
    g.$setSubscript(9, 1, "subscript(_:)");
    expect(g.$subscript(1, "subscript(_:)")).toEqual(int64(9));
    expect(() => g.$subscript(1)).toThrow(/ambiguous/);
    expect(() => g.$subscript(1, "greet(_:)")).toThrow(/not a subscript selector/);
  });

  test("a generic subscript takes its type arguments, a static one lives on the type", () => {
    const Int = Swift.type("Swift.Int")!;
    expect(grid().$subscript(3, { labels: ["scaled"], typeArguments: [Int] })).toEqual(int64(3));
    expect((Swift.type("fixture.Grid") as SwiftStruct).$subscript(1, { labels: ["unit"] })).toEqual(int64(100));
  });

  test("a class subscript reads and writes through the object", () => {
    const board = (Swift.type("fixture.Board") as SwiftClass).init(["a", "b"]) as SwiftClassObject;
    expect(board.$subscript(1)).toBe("b");
    board.$setSubscript("a string long enough to live on the heap", 0);
    expect(board.$subscript(0)).toBe("a string long enough to live on the heap");
    expect(board.$type.instanceMethods()).not.toContain("subscript(_:)");
    expect(board.$type.properties.map((p) => p.name)).toEqual(["cells"]);
  });

  test("reflection finds a subscript accessor by selector and accessor kind", () => {
    const Grid = Swift.type("fixture.Grid") as SwiftStruct;
    const rowColumn = Grid.$type.subscript("subscript(row:column:)");
    expect(rowColumn.selector).toBe("subscript(row:column:)");
    expect(rowColumn.signature.labels).toEqual(["row", "column"]);
    expect(rowColumn.signature.returnTypeName).toBe("Swift.Int");
    const setter = Grid.$type.subscript("subscript(_:)", { accessor: "setter" });
    expect(setter.address.equals(fixtureExport("fixture.Grid.subscript.setter : (Swift.Int)"))).toBe(true);
    expect(Grid.$type.typeSubscript({ labels: ["unit"] }).signature.argTypeNames).toEqual(["Swift.Int"]);
    expect(Grid.$type.subscript({ labels: ["scaled"] }).isGeneric).toBe(true);
  });

  test("hooks on a getter, a setter and a modify see the indices, the stored element and the yield", () => {
    const Grid = Swift.type("fixture.Grid") as SwiftStruct;
    const seen: { kind: string; args: SwiftValue[]; ret: CallResult }[] = [];
    const record = (kind: string) => ({
      onEnter(args: SwiftValue[]) { seen.push({ kind, args, ret: null }); },
      onLeave(ret: CallResult) { seen[seen.length - 1].ret = ret; },
    });
    const listeners = [
      SwiftInterceptor.attach(Grid.$type.subscript("subscript(row:column:)"), record("row:column")),
      SwiftInterceptor.attach(Grid.$type.subscript("subscript(_:)", { accessor: "setter" }), record("set")),
      SwiftInterceptor.attach(loadFixture().getExportByName("$s7fixture4GridV7trackedS2i_tciM"), record("modify")),
      SwiftInterceptor.attach(Grid.$type.typeSubscript({ labels: ["unit"] }), record("unit")),
    ];
    try {
      expect(makeSwiftNativeFunction(fixtureExport("fixture.driveGrid"), metadataFor("Swift.Int")!, [])()!.readS64()).toEqual(int64(116));
    } finally {
      listeners.forEach((l) => l.detach());
    }
    expect(seen).toEqual([
      { kind: "set", args: [int64(9), int64(1)], ret: null },
      { kind: "modify", args: [int64(2)], ret: int64(4) },
      { kind: "row:column", args: [int64(1), int64(0)], ret: int64(4) },
      { kind: "unit", args: [int64(1)], ret: int64(100) },
    ]);
  });
});

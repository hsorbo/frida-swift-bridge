import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { Swift, SwiftClass, SwiftStruct, type SwiftValueObject, type SwiftClassObject, type CallResult } from "../src/index.js";

function grid(): SwiftValueObject {
  return (Swift.type("fixture.Grid") as SwiftStruct).init([1, 2, 3, 4])! as SwiftValueObject;
}

describe("subscripts", () => {
  beforeEach(() => { loadFixture(); });

  test("$subscript binds the subscript named by its selector or labels; get reads it and set writes it", () => {
    const g = grid();
    expect(g.$subscript("subscript(_:)").get(1)).toEqual(int64(2));
    expect(g.$subscript({ labels: [null] }).get(1)).toEqual(int64(2));
    expect(g.$subscript("subscript(row:column:)").get(1, 0)).toEqual(int64(3));
    expect(g.$subscript({ labels: ["tracked"] }).get(2)).toEqual(int64(3));
    const cell = g.$subscript("subscript(_:)");
    cell.set(1, 9);
    expect(cell.get(1)).toEqual(int64(9));
    expect(() => g.$subscript().get(1)).toThrow(/ambiguous/);
    expect(() => g.$subscript("greet(_:)")).toThrow(/not a subscript selector/);
    expect(() => cell.set()).toThrow(/indices and then the element/);
  });

  test("an index is never mistaken for a selector or lookup options", () => {
    const g = grid();
    expect(g.$subscript({ labels: ["key"] }).get("subscript(_:)")).toEqual(int64(13));
    expect(g.$subscript("subscript(key:)").get("none")).toEqual(int64(4));
    expect(g.$subscript({ labels: ["at"] }).get({ x: 1 })).toEqual(int64(2));
    using p = (Swift.type("fixture.Point") as SwiftStruct).$new({ x: 3 });
    expect(g.$subscript("subscript(at:)").get(p)).toEqual(int64(4));
    expect(g.$subscript({ labels: [null], deep: false }).get(0)).toEqual(int64(1));
  });

  test("a generic subscript takes its type arguments, a static one lives on the type", () => {
    const Int = Swift.type("Swift.Int")!;
    expect(grid().$subscript({ labels: ["scaled"], typeArguments: [Int] }).get(3)).toEqual(int64(3));
    expect((Swift.type("fixture.Grid") as SwiftStruct).$subscript({ labels: ["unit"] }).get(1)).toEqual(int64(100));
  });

  test("a class subscript reads and writes through the object and refuses a disposed one", () => {
    const board = (Swift.type("fixture.Board") as SwiftClass).init(["a", "b"])! as SwiftClassObject;
    const cell = board.$subscript();
    expect(cell.get(1)).toBe("b");
    cell.set(0, "a string long enough to live on the heap");
    expect(cell.get(0)).toBe("a string long enough to live on the heap");
    expect(board.$type.instanceMethods()).not.toContain("subscript(_:)");
    expect(board.$type.properties().map((p) => p.name)).toEqual(["cells"]);
    board.$dispose();
    expect(() => cell.get(0)).toThrow(/disposed/);
  });

  test("reflection finds a subscript accessor by selector and accessor kind", () => {
    const Grid = Swift.type("fixture.Grid") as SwiftStruct;
    const rowColumn = Grid.$type.subscript("subscript(row:column:)");
    expect(rowColumn.selector).toBe("subscript(row:column:)");
    expect(rowColumn.signature!.labels).toEqual(["row", "column"]);
    expect(rowColumn.signature!.returnTypeName).toBe("Swift.Int");
    const setter = Grid.$type.subscript("subscript(_:)", { accessor: "setter" });
    expect(setter.address.equals(fixtureExport("fixture.Grid.subscript.setter : (Swift.Int)").strip())).toBe(true);
    expect(Grid.$type.typeSubscript({ labels: ["unit"] }).signature!.argTypeNames).toEqual(["Swift.Int"]);
    expect(Grid.$type.subscript({ labels: ["scaled"] }).isGeneric).toBe(true);
  });

  test("hooks on a getter, a setter, a modify and a read see the indices, the stored element and the yield", () => {
    const Grid = Swift.type("fixture.Grid") as SwiftStruct;
    const seen: { kind: string; args: CallResult[]; ret: CallResult }[] = [];
    const record = (kind: string) => ({
      onEnter(args: CallResult[]) { seen.push({ kind, args, ret: null }); },
      onLeave(ret: CallResult) { seen[seen.length - 1].ret = ret; },
    });
    const listeners = [
      Swift.Interceptor.attach(Grid.$type.subscript("subscript(row:column:)"), record("row:column")),
      Swift.Interceptor.attach(Grid.$type.subscript("subscript(_:)", { accessor: "setter" }), record("set")),
      Swift.Interceptor.attach(loadFixture().getExportByName("$s7fixture4GridV7trackedS2i_tciM"), record("modify")),
      Swift.Interceptor.attach(Grid.$type.typeSubscript({ labels: ["unit"] }), record("unit")),
      Swift.Interceptor.attach(fixtureExport("fixture.Grid.subscript.read : (read: Swift.Int)"), record("read")),
      Swift.Interceptor.attach(fixtureExport("fixture.Grid.subscript.read : <A>(echo: A)"), record("echo")),
    ];
    try {
      expect(Swift.NativeFunction(fixtureExport("fixture.driveGrid"), Swift.type("Swift.Int")!, [])()).toEqual(int64(125));
    } finally {
      listeners.forEach((l) => l.detach());
    }
    expect(seen).toEqual([
      { kind: "set", args: [int64(9), int64(1)], ret: null },
      { kind: "modify", args: [int64(2)], ret: int64(4) },
      { kind: "row:column", args: [int64(1), int64(0)], ret: int64(4) },
      { kind: "unit", args: [int64(1)], ret: int64(100) },
      { kind: "read", args: [int64(3)], ret: int64(4) },
      { kind: "echo", args: [int64(5)], ret: int64(5) },
    ]);
  });
});

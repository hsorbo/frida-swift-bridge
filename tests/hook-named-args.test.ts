import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, SwiftClass, SwiftStruct, type SwiftClassObject, type SwiftValueObject, type SwiftHookArgs, type HookableTarget } from "../src/index.js";

function robot(): SwiftClassObject {
  return (Swift.type("fixture.Robot") as SwiftClass).init("R2") as SwiftClassObject;
}

function hookArgs(target: HookableTarget, run: () => void): SwiftHookArgs {
  const seen: SwiftHookArgs[] = [];
  const listener = Swift.Interceptor.attach(target, { onEnter(args) { seen.push(args); } });
  try {
    run();
  } finally {
    listener.detach();
  }
  expect(seen.length).toBe(1);
  return seen[0];
}

describe("a hook's arguments by label", () => {
  beforeEach(() => { loadFixture(); });

  test("a labeled parameter is reachable by its label beside its position", () => {
    const move = robot().$method("move", { labels: ["to"] });
    const args = hookArgs(move, () => { expect(move.call(3)).toEqual(int64(3)); });
    expect(args.to).toEqual(int64(3));
    expect(args[0]).toEqual(int64(3));
    expect(Object.keys(args)).toEqual(["0"]);
    expect(args).toEqual([int64(3)]);
  });

  test("an unlabeled parameter has no name, its internal one being absent from the symbol", () => {
    const r = robot();
    const args = hookArgs(r.greet, () => { expect(r.greet("X")).toBe("Hello X, I am R2"); });
    expect(args).toEqual(["X"]);
    expect("who" in args).toBe(false);
  });

  test("a subscript setter keeps the stored value first and names the indices", () => {
    const Grid = Swift.type("fixture.Grid") as SwiftStruct;
    const g = Grid.init([1, 2, 3, 4]) as SwiftValueObject;
    const args = hookArgs(Grid.$type.subscript("subscript(row:column:)", { accessor: "setter" }), () => {
      g.$setSubscript(7, 1, 0, "subscript(row:column:)");
    });
    expect(args).toEqual([int64(7), int64(1), int64(0)]);
    expect(args.row).toEqual(int64(1));
    expect(args.column).toEqual(int64(0));
    expect(g.$subscript(1, 0, "subscript(row:column:)")).toEqual(int64(7));
  });

  test("a label an Array already owns stays positional", () => {
    const board = (Swift.type("fixture.Board") as SwiftClass).init(["a", "b"]) as SwiftClassObject;
    const args = hookArgs(board.padded, () => { expect(board.padded(5)).toEqual(int64(7)); });
    expect(args.length).toBe(1);
    expect(args[0]).toEqual(int64(5));
  });

  test("an async hook names its entry arguments the same way", async () => {
    const advance = Swift.class("fixture.Ticker")!.init().$method("advance", { labels: ["by"] });
    const seen: SwiftHookArgs[] = [];
    const listener = Swift.Interceptor.attachAsync(advance, { onEnter(args) { seen.push(args); } });
    try {
      expect(await advance.call(5)).toEqual(int64(5));
    } finally {
      listener.detach();
    }
    expect(seen.length).toBe(1);
    expect(seen[0].by).toEqual(int64(5));
    expect(seen[0]).toEqual([int64(5)]);
  });
});

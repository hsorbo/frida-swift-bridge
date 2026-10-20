import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { Swift, type SwiftClass, type SwiftClassObject, type SwiftStruct, type SwiftValueObject } from "../src/index.js";
import { enumerateTupleElements, getUnlabelledTupleTypeMetadata, metadataFor } from "../src/abi.js";
import { decodeReturn } from "../src/runtime/method.js";

declare function gc(): void;

const MAKE_LOADABLE_STRUCT = "$s7fixture18makeLoadableStructAA0cD0VyF";
const SUM_LOADABLE = "$s7fixture11sumLoadableySiAA0C6StructVF";

// A struct or enum crosses as a facade on every route, whatever its layout; the stdlib scalars
// and String stay plain.
describe("value representation", () => {
  let module: Module;
  beforeEach(() => {
    module = loadFixture();
  });

  test("a call returns a struct without managed references as an owned facade", () => {
    const made = Swift.function(module, MAKE_LOADABLE_STRUCT).call() as SwiftValueObject;
    expect([made.$kind, made.$owned, made.$type.name]).toEqual(["value", true, "fixture.LoadableStruct"]);
    expect(made.$fields).toEqual({ a: int64(1), b: int64(2), c: int64(3), d: int64(4) });
    expect(Swift.function(module, SUM_LOADABLE).call(made)).toEqual(int64(10));
  });

  test("a struct-typed property reads as a facade with the type's members", () => {
    const line = (Swift.struct("fixture.Line") as SwiftStruct).$new({ start: { x: 3 }, end: { x: 9 } });
    const start = line.start as SwiftValueObject;
    expect([start.$kind, start.$owned, start.$type.name]).toEqual(["value", true, "fixture.Point"]);
    expect(start.doubled).toEqual(int64(6));
    expect(start.$fields).toEqual({ x: int64(3) });
    expect(line.$fields).toEqual({ start: { x: int64(3) }, end: { x: int64(9) } });
  });

  test("an enum result is a facade whose $fields is its case, and passes back as an argument", () => {
    const boundary = Swift.enum("fixture.StdlibBoundary")!;
    const rule = boundary.$call("roundingDown") as SwiftValueObject;
    expect([rule.$kind, rule.$type.name, rule.$fields]).toEqual(["value", "Swift.FloatingPointRoundingRule", "down"]);
    expect(boundary.$call("isRoundingUp", rule)).toBe(false);
  });

  test("a hook observes struct and class arguments as borrowed facades over the caller's storage", () => {
    const sum = Swift.function(module, SUM_LOADABLE);
    const robot = (Swift.class("fixture.Robot") as SwiftClass).init("A")!;
    const other = (Swift.class("fixture.Robot") as SwiftClass).init("B")!;
    const seen: unknown[] = [];
    const listeners = [
      Swift.Interceptor.attach(sum, {
        onEnter(args) {
          const arg = args[0] as SwiftValueObject;
          seen.push([arg.$kind, arg.$owned, arg.$type.name, arg.$fields]);
        },
      }),
      Swift.Interceptor.attach(robot.merged, {
        onEnter(args) {
          const arg = args[0] as SwiftClassObject;
          seen.push([arg.$kind, arg.$owned, arg.$handle.equals(other.$handle), arg.name]);
        },
      }),
    ];
    try {
      expect(sum.call({ a: 1, b: 2, c: 3, d: 4 })).toEqual(int64(10));
      expect(robot.merged(other)).toBe("A+B");
    } finally {
      listeners.forEach((l) => l.detach());
    }
    expect(seen).toEqual([
      ["value", false, "fixture.LoadableStruct", { a: int64(1), b: int64(2), c: int64(3), d: int64(4) }],
      ["object", false, true, "B"],
    ]);
  });

  test("a POD struct element of a returned tuple owns storage of its own once the tuple's buffer is gone", () => {
    const Point = metadataFor("fixture.Point")!;
    const tuple = getUnlabelledTupleTypeMetadata([Point, metadataFor("Swift.Int")!]);
    const [, int] = [...enumerateTupleElements(tuple)];
    // A page-sized allocation is unmapped when dropped, so an element still pointing into it faults.
    let buffer: NativePointer | null = Memory.alloc(Process.pageSize);
    buffer.writeS64(5);
    buffer.add(int.offset).writeS64(7);
    const [point, seven] = decodeReturn(tuple, buffer) as [SwiftValueObject, Int64];
    buffer = null;
    gc();
    gc();
    expect(seven).toEqual(int64(7));
    expect(point.$fields).toEqual({ x: int64(5) });
    expect(point.doubled).toEqual(int64(10));
  });

  test("scalars and String stay plain", () => {
    const robot = (Swift.class("fixture.Robot") as SwiftClass).init("R2")!;
    expect(robot.greet("you")).toBe("Hello you, I am R2");
    expect(robot.at(3)).toEqual(int64(3));
  });
});

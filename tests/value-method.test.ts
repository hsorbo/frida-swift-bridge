import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadNoMetadata } from "./fixtures/load.js";

import { ClassInstance, ValueInstance, asSwiftObject, metadataFor, typeOf } from "../src/abi.js";
import { Swift, ClassType, StructType, SwiftObject } from "../src/index.js";

function value(typeName: string, fields: { [k: string]: number }): ValueInstance {
  return ValueInstance.fromJS(metadataFor(typeName)!, fields);
}

describe("ValueInstance method invocation", () => {
  beforeEach(() => { loadFixture(); });

  test("non-mutating method on a small loadable struct (self as trailing arg)", () => {
    expect(value("fixture.Accumulator", { total: 5 }).method("peek", { self: "borrowing" }).call(10)).toEqual(int64(15));
  });

  test("mutating method writes back through the inout self pointer", () => {
    const v = value("fixture.Accumulator", { total: 5 });
    v.method("add", { self: "mutating" }).call(3);
    expect((v.read() as { total: number }).total).toEqual(int64(8));
  });

  test("String arg and return marshal across a trailing-self call", () => {
    expect(value("fixture.Accumulator", { total: 7 }).method("describe", { self: "borrowing" }).call("T")).toBe("T: 7");
  });

  test("multi-word loadable self rides in successive registers after the args", () => {
    expect(value("fixture.LoadableStruct", { a: 1, b: 2, c: 3, d: 4 }).method("dot", { self: "borrowing" }).call(2)).toEqual(int64(20));
  });

  test("large struct passes self indirectly in x20", () => {
    expect(value("fixture.BigStruct", { a: 1, b: 2, c: 3, d: 4, e: 5 }).call("total")).toEqual(int64(15));
  });

  test("a non-mutating method on a small loadable receiver needs no self option", () => {
    expect(value("fixture.Accumulator", { total: 5 }).method("peek").call(10)).toEqual(int64(15));
  });

  test("a mutating method on a small loadable receiver needs no self option", () => {
    const v = value("fixture.Accumulator", { total: 5 });
    v.method("add").call(3);
    expect((v.read() as { total: number }).total).toEqual(int64(8));
  });

  test("a trailing self split across the last registers and the stack", () => {
    const v = value("fixture.LoadableStruct", { a: 1, b: 2, c: 3, d: 4 });
    expect(v.method("weighted").call(1, 2, 3, 4, 5, 6)).toEqual(int64(214321));
  });

  test("a mutating method whose args fill every register", () => {
    const v = value("fixture.Accumulator", { total: 5 });
    v.method("addEight").call(1, 2, 3, 4, 5, 6, 7, 8);
    expect((v.read() as { total: number }).total).toEqual(int64(41));
  });

  test("a mutating method on a borrowed field writes into the parent", () => {
    const ledger = ValueInstance.fromJS(metadataFor("fixture.Ledger")!, { entry: { total: 5 }, id: 1 });
    ledger.field("entry").method("add").call(3);
    expect((ledger.read() as { entry: { total: number } }).entry.total).toEqual(int64(8));
  });

  test("a bound value method is reusable across calls", () => {
    const peek = value("fixture.Accumulator", { total: 100 }).method("peek", { self: "borrowing" });
    expect(peek.call(1)).toEqual(int64(101));
    expect(peek.call(2)).toEqual(int64(102));
  });
});

describe("facade method routing on a small loadable value", () => {
  beforeEach(() => { loadFixture(); });

  function accumulator(total: number) {
    return asSwiftObject(ValueInstance.fromJS(metadataFor("fixture.Accumulator")!, { total }));
  }

  test("string $call invokes a non-mutating method", () => {
    expect(accumulator(5).$call("peek", 10)).toEqual(int64(15));
  });

  test("property-style invocation of a non-mutating method", () => {
    expect(accumulator(5).peek(10)).toEqual(int64(15));
  });

  test("property-style invocation of a mutating method writes back", () => {
    const acc = accumulator(5);
    acc.add(3);
    expect((acc.$fields as { total: number }).total).toEqual(int64(8));
  });

  test('$method({ self: "borrowing" }) invokes a non-mutating method', () => {
    expect(accumulator(5).$method("peek", { self: "borrowing" }).call(10)).toEqual(int64(15));
  });

  test('$method({ self: "mutating" }) writes back through self', () => {
    const acc = accumulator(5);
    acc.$method("add", { self: "mutating" }).call(3);
    expect((acc.$fields as { total: number }).total).toEqual(int64(8));
  });

  test("a bound value method from the facade is reusable", () => {
    const peek = accumulator(100).$method("peek", { self: "borrowing" });
    expect(peek.call(1)).toEqual(int64(101));
  });
});

const PACK_TOKEN_CRATE = "$s7fixture14packTokenCrateyAA0cD0VySiGAA0C0C_SitF";

describe("consuming methods on value types", () => {
  beforeEach(() => { loadFixture(); });

  function token(id: number): { facade: SwiftObject; view: ClassInstance } {
    const facade = (typeOf(metadataFor("fixture.Token")!) as ClassType).init(id);
    return { facade, view: new ClassInstance(facade.$handle) };
  }

  test("a consuming method on a small loadable struct leaves the caller's self intact", (ctx) => {
    if (loadFixture().findExportByName("$s7fixture8TokenBoxV4takeSiyF") === null) ctx.skip("fixture compiled without consuming methods (Swift < 5.9)");
    const { facade, view } = token(7);
    const box = (typeOf(metadataFor("fixture.TokenBox")!) as StructType)
      .$initializer({ labels: [null, "tag"] })
      .call(facade, 5) as SwiftObject;
    const before = view.retainCount;
    const take = box.$method("take", { self: "consuming" });
    expect(take.call()).toEqual(int64(7));
    expect(take.call()).toEqual(int64(7));
    expect(view.retainCount).toBe(before);
  });

  test("a consuming method on a large struct leaves the caller's self intact", (ctx) => {
    if (loadFixture().findExportByName("$s7fixture7WrapperV4takeSiyF") === null) ctx.skip("fixture compiled without consuming methods (Swift < 5.9)");
    const { facade, view } = token(9);
    const wrapper = (typeOf(metadataFor("fixture.Wrapper")!) as StructType).$call("make", facade) as SwiftObject;
    const before = view.retainCount;
    const take = wrapper.$method("take", { self: "consuming" });
    expect(take.call()).toEqual(int64(9));
    expect(take.call()).toEqual(int64(9));
    expect(view.retainCount).toBe(before);
  });

  test("a consuming generic method on a small loadable struct leaves the caller's self intact", (ctx) => {
    if (loadFixture().findExportByName("$s7fixture8TokenBoxV10takeTaggedySixlF") === null) ctx.skip("fixture compiled without consuming methods (Swift < 5.9)");
    const { facade, view } = token(11);
    const box = (typeOf(metadataFor("fixture.TokenBox")!) as StructType)
      .$initializer({ labels: [null, "tag"] })
      .call(facade, 5) as SwiftObject;
    const before = view.retainCount;
    const take = box.$method("takeTagged", { typeArguments: [Swift.type("Swift.Int")!], self: "consuming" });
    expect(take.call(1)).toEqual(int64(11));
    expect(take.call(2)).toEqual(int64(11));
    expect(view.retainCount).toBe(before);
  });

  test("a consuming async method on a small loadable struct leaves the caller's self intact", async (ctx) => {
    if (loadFixture().findExportByName("$s7fixture8TokenBoxV9takeAsyncSiyYaF") === null) ctx.skip("fixture compiled without consuming methods (Swift < 5.9)");
    const { facade, view } = token(13);
    const box = (typeOf(metadataFor("fixture.TokenBox")!) as StructType)
      .$initializer({ labels: [null, "tag"] })
      .call(facade, 5) as SwiftObject;
    const before = view.retainCount;
    const take = box.$method("takeAsync", { self: "consuming" });
    expect(await take.call()).toEqual(int64(13));
    expect(await take.call()).toEqual(int64(13));
    expect(view.retainCount).toBe(before);
  });

  test("consuming methods on a generic struct leave the caller's self intact", async (ctx) => {
    if (loadFixture().findExportByName(PACK_TOKEN_CRATE) === null) ctx.skip("fixture compiled without consuming methods (Swift < 5.9)");
    const { facade, view } = token(17);
    const crate = Swift.function(loadFixture(), PACK_TOKEN_CRATE).call(facade, 3) as SwiftObject;
    const before = view.retainCount;
    const take = crate.$method("take", { self: "consuming" });
    expect(take.call()).toEqual(int64(17));
    expect(take.call()).toEqual(int64(17));
    const takeAsync = crate.$method("takeAsync", { self: "consuming" });
    expect(await takeAsync.call()).toEqual(int64(17));
    expect(await takeAsync.call()).toEqual(int64(17));
    expect(view.retainCount).toBe(before);
  });
});

describe("stdlib methods on small loadable values", () => {
  test("Swift.Int.signum() needs no self option", () => {
    expect(Swift.struct("Swift.Int")!.$new(-5).signum()).toEqual(int64(-1));
  });
});

describe("extension methods on Swift.String from another module", () => {
  beforeEach(() => { loadNoMetadata(); });

  test("a non-mutating one returns without touching self", () => {
    const s = Swift.struct("Swift.String")!.$new("kake");
    expect(s.shouted()).toBe("KAKE!");
    expect(s.shouted()).toBe("KAKE!");
  });

  test("a mutating one writes back through self", () => {
    const s = ValueInstance.fromJS(metadataFor("Swift.String")!, "kake");
    s.method("exclaim").call();
    s.method("exclaim").call();
    expect(s.read()).toBe("kake!!");
  });
});

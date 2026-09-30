import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { Swift, SwiftObject, SwiftError, ClassType } from "../src/index.js";

import { ClassInstance, metadataFor, typeOf } from "../src/abi.js";
describe("Swift.NativeFunction (marshalled)", () => {
  beforeEach(() => { loadFixture(); });

  test("marshals JS ints through an add, returning a JS number", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const add = Swift.NativeFunction(fixtureExport("fixture.addInts"), Int, [Int, Int]);
    expect(add(20, 22)).toEqual(int64(42));
  });

  test("marshals a JS object into a struct argument", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const Loadable = typeOf(metadataFor("fixture.LoadableStruct")!);
    const sum = Swift.NativeFunction(fixtureExport("fixture.sumLoadable"), Int, [Loadable]);
    expect(sum({ a: 1, b: 2, c: 3, d: 4 })).toEqual(int64(10));
  });

  test("adopts a class return as a Swift object facade", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const Token = typeOf(metadataFor("fixture.Token")!);
    const make = Swift.NativeFunction(fixtureExport("fixture.makeToken"), Token, [Int]);
    const token = make(7) as SwiftObject;
    expect(token.$kind).toBe("object");
    expect(token.$field("id").read()).toEqual(int64(7));
  });

  test("borrows a String argument, leaving an owned caller value intact", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const String_ = typeOf(metadataFor("Swift.String")!);
    const makeStr = Swift.NativeFunction(fixtureExport("fixture.makeString"), String_, []);
    const len = Swift.NativeFunction(fixtureExport("fixture.stringLength"), Int, [String_]);
    expect(len("hello")).toEqual(int64(5));
    const s = makeStr() as string;
    expect(len(s)).toEqual(int64(9));
    // Borrowed, not consumed: the caller's String survives and stays callable.
    expect(len(s)).toEqual(int64(9));
  });

  test("passes a class instance argument, borrowing the caller's object", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const Token = typeOf(metadataFor("fixture.Token")!);
    const Wrapper = typeOf(metadataFor("fixture.Wrapper")!);
    const makeToken = Swift.NativeFunction(fixtureExport("fixture.makeToken"), Token, [Int]);
    const makeWrapper = Swift.NativeFunction(fixtureExport("fixture.makeWrapper"), Wrapper, [Token]);
    const token = makeToken(7) as SwiftObject;
    const wrapper = makeWrapper(token) as SwiftObject;
    expect(wrapper.$field("a").read()).toEqual(int64(1));
    // The class argument was borrowed, so the caller's token is still usable.
    expect(token.$field("id").read()).toEqual(int64(7));
  });

  test("accepts a subclass but rejects an unrelated class and a raw pointer", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const Animal = typeOf(metadataFor("fixture.Animal")!) as ClassType;
    const describe = Swift.NativeFunction(fixtureExport("fixture.describeAnimal"), Int, [Animal]);
    const cat = (typeOf(metadataFor("fixture.Cat")!) as ClassType).init();
    expect(describe(cat)).toEqual(int64(4));
    const robot = (typeOf(metadataFor("fixture.Robot")!) as ClassType).init("R2");
    expect(() => describe(robot)).toThrow(/expected fixture\.Animal/);
    expect(() => describe(cat.$handle)).toThrow(/raw pointer is only accepted via \/abi/);
  });

  test("surfaces a thrown error and returns the value otherwise", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const fn = Swift.NativeFunction(fixtureExport("fixture.mightThrow"), Int, [Int], {
      throws: true,
    });
    expect(fn(0)).toEqual(int64(99));
    let thrown: unknown;
    try {
      fn(1);
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof SwiftError).toBe(true);
  });

  test("rejects an argument-count mismatch instead of marshalling a bad call", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const add = Swift.NativeFunction(fixtureExport("fixture.addInts"), Int, [Int, Int]);
    expect(() => add(1)).toThrow(/2 argument/);
    expect(() => add(1, 2, 3)).toThrow(/2 argument/);
  });

  test("destroys the initialized prefix when a later argument fails to marshal", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const Token = typeOf(metadataFor("fixture.Token")!);
    const Wrapper = typeOf(metadataFor("fixture.Wrapper")!);
    const makeToken = Swift.NativeFunction(fixtureExport("fixture.makeToken"), Token, [Int]);
    const makeWrapper = Swift.NativeFunction(fixtureExport("fixture.makeWrapper"), Wrapper, [Token]);
    // Never invoked: the second argument fails to marshal first.
    const bogus = Swift.NativeFunction(fixtureExport("fixture.makeWrapper"), null, [Wrapper, Int]);
    const token = makeToken(7) as SwiftObject;
    const wrapper = makeWrapper(token) as SwiftObject;
    const view = new ClassInstance(token.$handle);
    const before = view.retainCount;
    // The Wrapper temp retains the token before the Int argument is rejected...
    expect(() => bogus(wrapper, "not an int" as unknown as number)).toThrow();
    // ...and the cleanup path destroyed it, releasing that retain.
    expect(view.retainCount).toBe(before);
  });

  test("rejects a class instance where a value type is expected", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const String_ = typeOf(metadataFor("Swift.String")!);
    const Token = typeOf(metadataFor("fixture.Token")!);
    const makeToken = Swift.NativeFunction(fixtureExport("fixture.makeToken"), Token, [Int]);
    const len = Swift.NativeFunction(fixtureExport("fixture.stringLength"), Int, [String_]);
    const token = makeToken(7) as SwiftObject;
    expect(() => len(token as never)).toThrow(/expected Swift.String/);
  });
});

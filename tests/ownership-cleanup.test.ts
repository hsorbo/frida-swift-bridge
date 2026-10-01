import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms, fixtureExport } from "./fixtures/load.js";

import { Swift, ClassType, StructType, SwiftObject, SwiftClass } from "../src/index.js";
import { BoundAsyncMethod, GenericBoundAsyncMethod, ClassInstance, metadataFor, typeOf } from "../src/abi.js";

// A Wrapper is non-POD (it embeds a Token class ref), so marshalling it +1s the embedded token. If a
// later argument fails to marshal, the copied Wrapper temp must be destroyed, releasing that token.
function wrapperOverToken(module: string): { wrapper: SwiftObject; view: ClassInstance } {
  const mod = module === "fixture" ? loadFixture() : loadFixtureSyms();
  const Int = typeOf(metadataFor("Swift.Int")!);
  const Token = typeOf(metadataFor(`${module}.Token`)!);
  const Wrapper = typeOf(metadataFor(`${module}.Wrapper`)!);
  const makeToken = Swift.NativeFunction(fixtureExport(`${module}.makeToken`, mod), Token, [Int]);
  const makeWrapper = Swift.NativeFunction(fixtureExport(`${module}.makeWrapper`, mod), Wrapper, [Token]);
  const token = makeToken(7) as SwiftObject;
  const wrapper = makeWrapper(token) as SwiftObject;
  return { wrapper, view: new ClassInstance(token.$handle) };
}

function boxType(): SwiftClass {
  return (typeOf(metadataFor("fixture.Box")!) as ClassType).facade;
}

describe("marshalling-failure cleanup across call paths", () => {
  beforeEach(() => { loadFixture(); });

  test("sync generic: a failed later arg does not leak the non-POD prefix temp", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const { wrapper, view } = wrapperOverToken("fixture");
    const mix = boxType().init().$method("mix", { typeArguments: [Int] });
    const before = view.retainCount;
    expect(() => mix.call(wrapper, "bad" as never)).toThrow();
    expect(view.retainCount).toBe(before);
  });

  test("plain async: a failed later arg does not leak the non-POD prefix temp", () => {
    const { wrapper, view } = wrapperOverToken("fixture");
    const combine = boxType().init().$method("combineAsync") as BoundAsyncMethod;
    const before = view.retainCount;
    expect(() => combine.call(wrapper, "bad" as never)).toThrow();
    expect(view.retainCount).toBe(before);
  });

  test("generic async: a failed later arg does not leak the non-POD prefix temp", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const { wrapper, view } = wrapperOverToken("fixture");
    const mix = boxType().init().$method("mixAsync", { typeArguments: [Int] }) as GenericBoundAsyncMethod;
    const before = view.retainCount;
    expect(() => mix.call(wrapper, "bad" as never)).toThrow();
    expect(view.retainCount).toBe(before);
  });
});

// Value initializers resolve only through the symbol table, so use the unstripped fixturesyms twin.
describe("value-initializer ownership", () => {
  beforeEach(() => { loadFixtureSyms(); });

  test("a failed later arg does not leak the non-POD prefix temp", () => {
    const { wrapper, view } = wrapperOverToken("fixturesyms");
    const Keeper = (typeOf(metadataFor("fixturesyms.Keeper")!) as StructType).facade;
    const init = Keeper.$initializer({ labels: [null, "tag"] });
    const before = view.retainCount;
    expect(() => init.call(wrapper, "bad" as never)).toThrow();
    expect(view.retainCount).toBe(before);
  });

  test("a consumed class argument is retained, so the caller's object survives the init", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    const Token = typeOf(metadataFor("fixturesyms.Token")!);
    const makeToken = Swift.NativeFunction(fixtureExport("fixturesyms.makeToken", loadFixtureSyms()), Token, [Int]);
    const token = makeToken(7) as SwiftObject;
    const view = new ClassInstance(token.$handle);
    const before = view.retainCount;
    const box = (typeOf(metadataFor("fixturesyms.TokenBox")!) as StructType).facade
      .$initializer({ labels: [null, "tag"] })
      .call(token, 5) as SwiftObject;
    // The box owns its own +1 on the token; the caller's reference is untouched.
    expect(view.retainCount).toBe(before + 1);
    expect(token.$field("id").read()).toEqual(int64(7));
    box.$dispose();
    expect(view.retainCount).toBe(before);
    expect(token.$field("id").read()).toEqual(int64(7));
  });
});

describe("class-boundary ownership (init and property setter)", () => {
  beforeEach(() => { loadFixture(); });

  function kennelType(): SwiftClass {
    return (typeOf(metadataFor("fixture.Kennel")!) as ClassType).facade;
  }
  function token(id: number): { facade: SwiftObject; view: ClassInstance } {
    const facade = (typeOf(metadataFor("fixture.Token")!) as ClassType).facade.init(id);
    return { facade, view: new ClassInstance(facade.$handle) };
  }

  test("class init gives the callee its own +1 on a class argument", () => {
    const { wrapper } = wrapperOverToken("fixture");
    const occupant = token(1);
    const before = occupant.view.retainCount;
    const kennel = kennelType().init(wrapper, occupant.facade);
    expect(occupant.view.retainCount).toBe(before + 1);
    expect(kennel.occupant.id).toEqual(int64(1));
  });

  test("class init failure destroys the non-POD prefix temp", () => {
    const { wrapper, view } = wrapperOverToken("fixture");
    const before = view.retainCount;
    expect(() => kennelType().init(wrapper, "bad" as never)).toThrow();
    expect(view.retainCount).toBe(before);
  });

  test("a class-valued setter consumes its own +1, not the caller's reference", () => {
    const { wrapper } = wrapperOverToken("fixture");
    const first = token(1);
    const kennel = kennelType().init(wrapper, first.facade);
    const next = token(2);
    const beforeNext = next.view.retainCount;
    const beforeFirst = first.view.retainCount;
    kennel.$set("occupant", next.facade);
    expect(next.view.retainCount).toBe(beforeNext + 1);
    expect(beforeFirst - first.view.retainCount).toBe(1);
    expect(next.facade.id).toEqual(int64(2));
  });
});

import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadFixtureSyms, loadOptimized } from "./fixtures/load.js";
import { requireDarwin, requireSymbolTable } from "./swift.js";

import { Swift, SwiftObject, SwiftClass, SwiftStruct } from "../src/index.js";
import { ValueInstance, asSwiftObject, metadataOf } from "../src/abi.js";

describe("protocol-extension members on a conforming type", () => {
  beforeEach(() => { loadFixture(); });

  test("a value type lists and calls its protocol's default and extension method", () => {
    const type = Swift.type("fixture.DefaultDescriber") as SwiftStruct;
    expect(type.$type.instanceMethods({ deep: true })).toContain("describe()");
    expect(type.$type.instanceMethods({ deep: true })).toContain("shout()");

    const describer = type.$new({ displayName: "Ada" });
    expect(describer.describe()).toBe("<Ada>");
    expect(describer.shout()).toBe("ADA");
  });

  test("a value type reads its protocol's extension property", () => {
    const type = Swift.type("fixture.DefaultDescriber") as SwiftStruct;
    expect(type.$type.properties({ deep: true }).map((p) => p.name)).toContain("initial");
    expect(type.$new({ displayName: "Ada" }).initial).toBe("A");
  });

  test("the type's own implementation shadows the protocol's default", () => {
    const type = Swift.type("fixture.CustomDescriber") as SwiftStruct;
    expect(type.$type.instanceMethods({ deep: true }).filter((m) => m === "describe()").length).toBe(1);
    expect(type.$new({ displayName: "Ada" }).$method("describe", { self: "borrowing" }).call()).toBe("custom:Ada");
  });

  test("a class reaches an extension method of a protocol that is not class-bound", () => {
    const speaker = (Swift.type("fixture.SubSpeaker") as SwiftClass).init()!;
    expect(speaker.speakTwice()).toBe("subsub");
  });

  test("a class reaches an extension method of a class-bound protocol", () => {
    const squawker = (Swift.type("fixture.SubSquawker") as SwiftClass).init()!;
    expect(squawker.squawkTwice()).toBe("subsub");
  });

  test("an overloaded extension method is picked by call arity", () => {
    const n = (Swift.type("fixture.NarrowScalar") as SwiftStruct).$new({ n: 11 });
    expect(n.scaledTwice()).toEqual(int64(22));
  });

  test("an overloaded extension method is picked by { labels }", () => {
    const n = (Swift.type("fixture.NarrowScalar") as SwiftStruct).$new({ n: 11 });
    expect(n.$method("scaledTwice", { labels: [null] }).call(3)).toEqual(int64(66));
    expect(n.$method("scaledTwice", { labels: ["by"] }).call(3)).toEqual(int64(67));
  });

  test("an extension method resolves when the requirement's witness thunk inlines the implementation", () => {
    loadFixtureSyms();
    const w = (Swift.type("fixturesyms.WideScalar") as SwiftStruct).$new({ a: 1, b: 2, c: 3, d: 4, e: 5 });
    expect(w.scaledTwice()).toEqual(int64(30));
  });

  test("an async extension method resolves by naming the conformance's async witness thunks", async (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const ruler = (Swift.type("fixturesyms.Ruler") as SwiftStruct).$new({ n: 7 });
    expect(await ruler.measureTwice()).toEqual(int64(14));
  });

  test("an extension method differing from a requirement only in return type is not called through its witness", () => {
    const c = (Swift.type("fixture.IntChooser") as SwiftStruct).$new({ n: 4 });
    expect(c.$method("choose", { returnType: "Swift.String", self: "borrowing" }).call()).toBe("ext");
    expect(c.$method("choose", { returnType: "Swift.Int", self: "borrowing" }).call()).toEqual(int64(4));
  });

  test("an extension method resolves on a stripped binary by naming the requirement from another conformance's witness", () => {
    const w = (Swift.type("fixture.WideScalar") as SwiftStruct).$new({ a: 1, b: 2, c: 3, d: 4, e: 5 });
    expect(w.scaledTwice()).toEqual(int64(30));
  });

  test("a requirement named only by another conformance's default calls the stripped conformance's own witness", () => {
    const r = (Swift.type("fixture.HiddenRanked") as SwiftStruct).$new({ n: 7 });
    expect(r.rank()).toEqual(int64(7));
  });

  test("another conformance's optimized thunk calling some other function first does not name the requirement", () => {
    loadOptimized();
    const t = (Swift.type("optimized.HiddenTagged") as SwiftStruct).$new({ n: 7 });
    expect(() => t.tag()).toThrow(
      /cannot tell whether tag\(\) is a requirement of optimized\.Tagged: no symbol names its instance method slot optimized\.Tagged#\d+; a slot is called with \$method\(slot, signature\)/
    );
  });

  test("the slot an undecided requirement names calls the conformance's own witness with a signature", () => {
    loadOptimized();
    const t = (Swift.type("optimized.HiddenTagged") as SwiftStruct).$new({ n: 7 });
    let message = "";
    try {
      t.tag();
    } catch (e) {
      message = (e as Error).message;
    }
    const slot = /optimized\.Tagged#\d+/.exec(message)![0];
    expect(t.$method(slot, "() -> Swift.Int").call()).toEqual(int64(7));
  });

  test("an extension method returns Self and passes an associated type indirectly for a loadable conformer", () => {
    const source = (Swift.type("fixture.IntSource") as SwiftStruct).$new({ value: 5 });
    expect(source.me().value).toEqual(int64(5));
    expect(source.echo(9)).toEqual(int64(9));
  });

  test("an extension method returning a tuple with an associated-type element gets that element by address", () => {
    const source = (Swift.type("fixture.IntSource") as SwiftStruct).$new({ value: 5 });
    expect(source.paired(9)).toEqual([int64(9), int64(7)]);
    expect(source.twice(4)).toEqual([int64(4), int64(4)]);
    expect(source.bracketed(6)).toEqual([1, int64(6), 2]);
  });

  test("an extension method taking a tuple with an associated-type element passes that element by address", () => {
    const source = (Swift.type("fixture.IntSource") as SwiftStruct).$new({ value: 5 });
    expect(source.flipped([9, 4])).toEqual([int64(4), int64(9)]);
    expect(source.unbracketed([1, 6, 2])).toEqual([int64(6), int64(12)]);
  });

  test("an inout tuple with an associated-type element is passed whole by address", () => {
    const source = (Swift.type("fixture.IntSource") as SwiftStruct).$new({ value: 5 });
    const pair = asSwiftObject(ValueInstance.fromJS(metadataOf(Swift.reflect("(Swift.Int, Swift.Int)")!), [1, 2]));
    source.refill(pair, 9);
    expect(pair.$fields).toEqual([int64(9), int64(3)]);
  });

  test("an async extension method returning a tuple with an associated-type element gets that element through a buffer", async (ctx) => {
    requireSymbolTable(ctx);
    loadFixtureSyms();
    const source = (Swift.type("fixturesyms.IntSource") as SwiftStruct).$new({ value: 5 });
    expect(await source.pairedLater(9)).toEqual([int64(9), int64(7)]);
    expect(await source.twiceLater(4)).toEqual([int64(4), int64(4)]);
    expect(await source.bracketedLater(6)).toEqual([1, int64(6), 2]);
  });

  test("an extension method still ambiguous after filtering lists its overloads", () => {
    const n = (Swift.type("fixture.NarrowScalar") as SwiftStruct).$new({ n: 11 });
    expect(() => n.scaledTwice(3)).toThrow(
      /ambiguous extension method scaledTwice on fixture\.Scalable: .*scaledTwice\(_:\).*\{ arity \}, \{ labels \}/
    );
  });
});

describe("constrained protocol-extension members", () => {
  beforeEach(() => { loadFixture(); });

  test("a superclass-constrained extension method is listed and callable on a subclass that conforms", () => {
    const type = Swift.type("fixture.PerchedBird") as SwiftClass;
    expect(type.$type.instanceMethods({ deep: true })).toContain("perchedChirp()");
    expect(type.init({ call: "tweet" })!.perchedChirp()).toBe("perched tweet");
  });

  test("a protocol-constrained extension method passes the extra witness table in canonical order", () => {
    const type = Swift.type("fixture.BandedBird") as SwiftStruct;
    expect(type.$type.instanceMethods({ deep: true })).toContain("bandedChirp()");
    expect(type.$new({ band: 7 }).bandedChirp()).toBe("7:peep");
  });

  test("a protocol-constrained extension property is listed and readable", () => {
    const type = Swift.type("fixture.BandedBird") as SwiftStruct;
    expect(type.$type.properties({ deep: true }).map((p) => p.name)).toContain("bandLabel");
    expect(type.$new({ band: 7 }).bandLabel).toBe("#7");
  });

  test("a constraint to a refining protocol passes its witness table in place of Self's own", () => {
    const type = Swift.type("fixture.Lark") as SwiftStruct;
    expect(type.$type.instanceMethods({ deep: true })).toContain("song()");
    expect(type.$new({ pitch: 1 }).song()).toBe("lala");
  });

  test("an associated-type-constrained extension method is listed and callable", () => {
    const type = Swift.type("fixture.IntNest") as SwiftStruct;
    expect(type.$type.instanceMethods({ deep: true })).toContain("eggCount()");
    expect(type.$new({ egg: 21 }).eggCount()).toEqual(int64(42));
  });

  test("a constraint on an associated type declared by a base protocol is checked", () => {
    const type = Swift.type("fixture.IntClutch") as SwiftStruct;
    expect(type.$type.instanceMethods({ deep: true })).toContain("clutchCount()");
    expect(type.$new({ egg: 5 }).clutchCount()).toEqual(int64(15));
    expect((Swift.type("fixture.WordClutch") as SwiftStruct).$type.instanceMethods({ deep: true })).not.toContain("clutchCount()");
  });

  test("an accessor typed by an associated type declared by a base protocol resolves", () => {
    expect((Swift.type("fixture.IntClutch") as SwiftStruct).$new({ egg: 5 }).firstEgg).toEqual(int64(5));
    expect((Swift.type("fixture.WordClutch") as SwiftStruct).$new({ egg: "wren" }).firstEgg).toBe("wren");
  });

  test("an associated type made class-bound by the where clause passes and returns directly", () => {
    const nightjar = (Swift.type("fixture.Nightjar") as SwiftClass).init()! as SwiftObject;
    const nightjarNest = (Swift.type("fixture.NightjarNest") as SwiftStruct).init(nightjar)!;
    expect((nightjarNest.nocturnalEcho(nightjar) as SwiftObject).$handle.equals(nightjar.$handle)).toBe(true);
    expect((nightjarNest.nocturnalEgg as SwiftObject).$handle.equals(nightjar.$handle)).toBe(true);
    expect((nightjarNest.objectEcho(nightjar) as SwiftObject).$handle.equals(nightjar.$handle)).toBe(true);
    const rook = (Swift.type("fixture.Rook") as SwiftClass).init()! as SwiftObject;
    const rookNest = (Swift.type("fixture.RookNest") as SwiftStruct).init(rook)!;
    expect((rookNest.rookeryEcho(rook) as SwiftObject).$handle.equals(rook.$handle)).toBe(true);
  });

  test("a superclass constraint that implies the conformance passes no witness table", () => {
    const type = Swift.type("fixture.Rook") as SwiftClass;
    expect(type.$type.instanceMethods({ deep: true })).toContain("rookeryChirp()");
    expect(type.init()!.rookeryChirp()).toBe("rookery caw");
  });

  test("a class-bound protocol constraint passes self as a plain reference", () => {
    const type = Swift.type("fixture.Nightjar") as SwiftClass;
    expect(type.$type.instanceMethods({ deep: true })).toContain("nightChirp()");
    expect(type.init()!.nightChirp()).toBe("night churr");
  });

  test("a generic superclass constraint is met by a subclass of that specialization", () => {
    const type = Swift.type("fixture.HenCoop") as SwiftClass;
    expect(type.$type.instanceMethods({ deep: true })).toContain("coopChirp()");
    expect(type.init()!.coopChirp()).toBe("coop cluck");
  });

  test("an ObjC superclass constraint is met by a Swift subclass", (ctx) => {
    requireDarwin(ctx);
    const type = Swift.type("fixture.Starling") as SwiftClass;
    expect(type.$type.instanceMethods({ deep: true })).toContain("objcChirp()");
    expect(type.init()!.objcChirp()).toBe("objc whistle");
  });

  test("a protocol nested in a type comes after top-level ones in the witness tables", (ctx) => {
    const type = Swift.type("fixture.Kestrel") as SwiftStruct;
    if (type === null) ctx.skip("fixture compiled without nested protocols (Swift < 5.10)");
    expect(type.$type.instanceMethods({ deep: true })).toContain("totalHeight()");
    expect(type.$new({ perch: 4 }).totalHeight()).toEqual(int64(43));
  });

  test("a same-type constraint on an associated type is met by that type only", () => {
    const type = Swift.type("fixture.IntNest") as SwiftStruct;
    expect(type.$type.instanceMethods({ deep: true })).toContain("eggPlusOne()");
    expect(type.$new({ egg: 41 }).eggPlusOne()).toEqual(int64(42));
    expect((Swift.type("fixture.WordNest") as SwiftStruct).$type.instanceMethods({ deep: true })).not.toContain("eggPlusOne()");
  });

  test("a same-type constraint on an associated type reached through a where-clause conformance is checked", () => {
    const type = Swift.type("fixture.Ring") as SwiftStruct;
    expect(type.$type.instanceMethods({ deep: true })).toContain("rawChirp()");
    expect(type.$new({ rawValue: 7 }).rawChirp()).toBe("7 ring");
    expect((Swift.type("fixture.Lark") as SwiftStruct).$type.instanceMethods({ deep: true })).not.toContain("rawChirp()");
  });

  test("a marker protocol constraint is taken as met and passes no witness table", () => {
    const type = Swift.type("fixture.WordNest") as SwiftStruct;
    expect(type.$type.instanceMethods({ deep: true })).toContain("sendableEgg()");
    expect(type.$new({ egg: "wren" }).sendableEgg()).toBe("wren");
  });

  test("a constraint on a nested associated type is checked through the intermediate conformance", () => {
    const ints = Swift.type("fixture.IntHatchery") as SwiftStruct;
    expect(ints.$type.instanceMethods({ deep: true })).toContain("hatchCount()");
    expect(ints.$type.instanceMethods({ deep: true })).not.toContain("hatchWord()");
    expect(ints.init(5)!.hatchCount()).toEqual(int64(20));
    const words = Swift.type("fixture.WordHatchery") as SwiftStruct;
    expect(words.$type.instanceMethods({ deep: true })).toContain("hatchWord()");
    expect(words.$type.instanceMethods({ deep: true })).not.toContain("hatchCount()");
    expect(words.init("wren")!.hatchWord()).toBe("wren!");
  });

  test("an @objc protocol constraint is met by a conforming class, which passes self as a reference", (ctx) => {
    requireDarwin(ctx);
    const type = Swift.type("fixture.Bat") as SwiftClass;
    expect(type.$type.instanceMethods({ deep: true })).toContain("wingedChirp()");
    expect(type.init()!.wingedChirp()).toBe("winged 2 squeak");
    expect((Swift.type("fixture.Starling") as SwiftClass).$type.instanceMethods({ deep: true })).not.toContain("wingedChirp()");
  });

  test("a member of a constrained extension shadows the same member of a less constrained one", () => {
    const banded = (Swift.type("fixture.BandedBird") as SwiftStruct).$new({ band: 7 });
    expect(banded.greeting()).toBe("banded hello peep");
    expect(banded.tag).toBe("banded");
    const free = (Swift.type("fixture.FreeBird") as SwiftStruct).$new({ wingspan: 3 });
    expect(free.greeting()).toBe("hello caw");
    expect(free.tag).toBe("plain");
  });

  test("a conforming type that misses the constraint has none of the constrained members", () => {
    const bird = Swift.type("fixture.FreeBird") as SwiftStruct;
    for (const selector of ["perchedChirp()", "bandedChirp()", "song()", "rookeryChirp()", "nightChirp()", "coopChirp()"]) {
      expect(bird.$type.instanceMethods({ deep: true })).not.toContain(selector);
    }
    expect((Swift.type("fixture.PerchedBird") as SwiftClass).$type.instanceMethods({ deep: true })).not.toContain("rookeryChirp()");
    expect(bird.$type.properties({ deep: true }).map((p) => p.name)).not.toContain("bandLabel");
    const free = bird.$new({ wingspan: 3 });
    expect(free.bandedChirp).toBeUndefined();
    expect(() => free.$call("bandedChirp")).toThrow(/no method bandedChirp/);

    const nest = Swift.type("fixture.WordNest") as SwiftStruct;
    for (const selector of ["eggCount()", "nocturnalEcho(_:)", "objectEcho(_:)", "rookeryEcho(_:)"]) {
      expect(nest.$type.instanceMethods({ deep: true })).not.toContain(selector);
    }
    expect(() => nest.$new({ egg: "x" }).$call("eggCount")).toThrow(/no method eggCount/);
  });
});

describe("static protocol-extension members", () => {
  beforeEach(() => { loadFixture(); });

  test("a value type lists and calls a static extension method", () => {
    const type = Swift.type("fixture.Duckling") as SwiftStruct;
    expect(type.$type.typeMethods({ deep: true })).toContain("hatch(count:)");
    expect(type.$type.instanceMethods({ deep: true })).not.toContain("hatch(count:)");
    expect(type.$call("hatch", 3)).toBe("3 duck (Duckling)");
  });

  test("a class lists and calls a static extension method", () => {
    const type = Swift.type("fixture.Owlet") as SwiftClass;
    expect(type.$type.typeMethods({ deep: true })).toContain("hatch(count:)");
    expect(type.$call("hatch", 2)).toBe("2 owl (Owlet)");
  });

  test("a static extension property is listed as static", () => {
    const type = Swift.type("fixture.Duckling") as SwiftStruct;
    expect(type.$type.properties({ deep: true }).find((p) => p.name === "nursery")).toEqual({
      name: "nursery",
      typeName: "Swift.String",
      isStatic: true,
      writable: false,
    });
  });

  test("a static extension property reads through the type", () => {
    expect((Swift.type("fixture.Duckling") as SwiftStruct).$get("nursery")).toBe("duck nursery");
    expect((Swift.type("fixture.Owlet") as SwiftClass).$get("nursery")).toBe("owl nursery");
  });

  test("an instance does not reach a static extension method", () => {
    const duckling = (Swift.type("fixture.Duckling") as SwiftStruct).$new({ weight: 1 });
    expect(duckling.hatch).toBeUndefined();
    expect(() => duckling.$call("hatch", 1)).toThrow(/no method hatch/);
  });
});

import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport, compiledType } from "./fixtures/load.js";

import { Swift, TupleType, EnumType, StructType, MetatypeType, SwiftType } from "../src/index.js";
import { fieldsOf } from "./swift.js";

const GENERIC_IDENTITY = "$s7fixture15genericIdentityyxxlF";

describe("Swift.reflect", () => {
  beforeEach(() => { loadFixture(); });

  test("names a tuple, an existential, a composition, an optional and an array", () => {
    const pair = Swift.reflect("(Swift.Int, Swift.String)")!;
    expect(pair instanceof TupleType).toBe(true);
    expect(pair.kind).toBe("tuple");
    expect(pair.name).toBe("(Swift.Int, Swift.String)");
    expect((pair as TupleType).elements.map((e) => e.type.name)).toEqual(["Swift.Int", "Swift.String"]);

    const greeter = Swift.reflect("any fixture.Greeter")!;
    expect(greeter.kind).toBe("existential");
    expect(greeter.name).toBe("fixture.Greeter");

    const greeterAged = Swift.reflect("any fixture.Greeter & fixture.Aged")!;
    expect(greeterAged.kind).toBe("existential");
    expect(greeterAged.name).toBe("fixture.Aged & fixture.Greeter");

    const optional = Swift.reflect("Swift.Int?")!;
    expect(optional instanceof EnumType).toBe(true);
    expect(optional.name).toBe("Swift.Optional<Swift.Int>");

    const array = Swift.reflect("[Swift.Int]")!;
    expect(array instanceof StructType).toBe(true);
    expect(array.name).toBe("Swift.Array<Swift.Int>");

    const any = Swift.reflect("Any")!;
    expect(any.kind).toBe("existential");
    expect(any.name).toBe("Any");
  });

  test("a structural type belongs to no module, in moduleName as in toJSON", () => {
    for (const structural of [Swift.reflect("(Swift.Int, Swift.String)")!, Swift.reflect("any fixture.Greeter")!, Swift.reflect("Any")!]) {
      expect(structural.moduleName).toBeNull();
      expect(structural.toJSON().module).toBeNull();
    }
    const optional = Swift.reflect("Swift.Int?")!;
    expect(optional.moduleName).toBe("Swift");
    expect(optional.toJSON().module).toBe("Swift");
  });

  test("a nominal name meets Swift.type's reflection and a protocol name its existential", () => {
    expect(Swift.reflect("fixture.Robot")).toBe(Swift.type("fixture.Robot")!.$type);
    expect(Swift.reflect("fixture.Keyed")).toBe(Swift.type("fixture.Keyed")!.$type);
    expect(Swift.reflect("fixture.Keyed<Swift.Int>")).toBe(Swift.type("fixture.Keyed<Swift.Int>")!.$type);
    expect(Swift.reflect("fixture.Greeter")).toBe(Swift.reflect("any fixture.Greeter"));
    expect(Swift.reflect("Swift.Optional<Swift.Int>")).toBe(Swift.reflect("Swift.Int?"));
    expect(Swift.reflect("fixture.Aged & fixture.Greeter")).toBe(Swift.reflect("any fixture.Greeter & fixture.Aged"));
  });

  test("builds the metadata the compiler's (any Greeter).self and Any.self are", () => {
    expect(Swift.reflect("any fixture.Greeter")).toBe(compiledType("fixture.greeterType"));
    expect(Swift.reflect("Any")).toBe(compiledType("fixture.anyType"));
  });

  test("an unknown, function or metatype spelling is null", () => {
    expect(Swift.reflect("fixture.NoSuchTypeQX")).toBeNull();
    expect(Swift.reflect("(Swift.Int, fixture.NoSuchTypeQX)")).toBeNull();
    expect(Swift.reflect("any fixture.NoSuchProtocolQX")).toBeNull();
    expect(Swift.reflect("(Swift.Int) -> Swift.Int")).toBeNull();
    expect(Swift.reflect("Swift.Int.Type")).toBeNull();
    expect(Swift.reflect("")).toBeNull();
  });

  test("Swift.NativeFunction takes the reflection as a parameter and as a return type", () => {
    const greetCounted = Swift.NativeFunction(
      fixtureExport("fixture.greetCounted"),
      Swift.reflect("(Swift.String, Swift.Int)")!,
      [Swift.reflect("any fixture.Greeter")!]
    );
    expect(greetCounted(Swift.struct("fixture.PoliteGreeter")!.$new({ name: "Ada" }))).toEqual(["Hello, Ada", int64(10)]);
  });

  test("typeArguments takes the reflection", () => {
    const module = loadFixture();
    const greeter: SwiftType = Swift.reflect("any fixture.Greeter")!;
    const ada = Swift.struct("fixture.PoliteGreeter")!.$new({ name: "Ada" });
    expect(fieldsOf(Swift.function(module, GENERIC_IDENTITY, { typeArguments: [greeter] }).call(ada))).toEqual({ name: "Ada" });
    expect(Swift.function(module, GENERIC_IDENTITY, { typeArguments: [Swift.reflect("Swift.Int?")!] }).call(null)).toBeNull();
  });
});

describe("Swift.reflect(metadata)", () => {
  beforeEach(() => { loadFixture(); });

  test("a raw hook's T.Type argument and type-argument register are the type Swift.type returns", () => {
    const seen: NativePointer[] = [];
    const listener = Interceptor.attach(fixtureExport("fixture.storeMetatypeCapturing"), {
      onEnter(args) {
        seen.push(args[0], args[1]);
      },
    });
    new NativeFunction(fixtureExport("fixture.triggerMetatypeCapturing"), "void", [])();
    listener.detach();
    const [metatypeArgument, typeArgument] = seen;
    const Bool = Swift.type("Swift.Bool")!.$type;
    expect(Swift.reflect(typeArgument)).toBe(Bool);
    expect(Swift.reflect(metatypeArgument)).toBe(Bool);
  });

  test("a metatype a fixture accessor returns is the structural reflection of its kind", () => {
    expect(compiledType("fixture.holderIntType").kind).toBe("existential");
    const greeterMetatype = compiledType("fixture.greeterMetatypeType");
    expect(greeterMetatype instanceof MetatypeType).toBe(true);
    expect((greeterMetatype as MetatypeType).instanceType).toBe(Swift.reflect("any fixture.Greeter"));
  });

  test("a metatype-typed field reads as reflection", () => {
    const tagged = Swift.class("fixture.TypeTagged")!.init()!;
    const Robot = Swift.type("fixture.Robot")!.$type;
    expect(tagged.$fields).toEqual({ tag: int64(1), any: Swift.reflect("Swift.String"), robot: Robot });
    expect(tagged.$field("robot").read()).toBe(Robot);
    expect(tagged.$field("any").read()).toBe(Swift.type("Swift.String")!.$type);
  });
});

import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, fixtureExport } from "./fixtures/load.js";

import { Swift, TupleType, EnumType, StructType, SwiftType } from "../src/index.js";

import { metadataOf } from "../src/abi.js";
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

  test("a nominal name meets Swift.type's reflection and a protocol name its existential", () => {
    expect(Swift.reflect("fixture.Robot")).toBe(Swift.type("fixture.Robot")!.$type);
    expect(Swift.reflect("fixture.Keyed")).toBe(Swift.type("fixture.Keyed")!.$type);
    expect(Swift.reflect("fixture.Keyed<Swift.Int>")).toBe(Swift.type("fixture.Keyed<Swift.Int>")!.$type);
    expect(Swift.reflect("fixture.Greeter")).toBe(Swift.reflect("any fixture.Greeter"));
    expect(Swift.reflect("Swift.Optional<Swift.Int>")).toBe(Swift.reflect("Swift.Int?"));
    expect(Swift.reflect("fixture.Aged & fixture.Greeter")).toBe(Swift.reflect("any fixture.Greeter & fixture.Aged"));
  });

  test("builds the metadata the compiler's (any Greeter).self and Any.self are", () => {
    const RawPointer = Swift.type("Swift.UnsafeRawPointer")!;
    const compiled = (accessor: string) => Swift.NativeFunction(fixtureExport(accessor), RawPointer, [])() as NativePointer;
    expect(metadataOf(Swift.reflect("any fixture.Greeter")!).handle.equals(compiled("fixture.greeterType"))).toBe(true);
    expect(metadataOf(Swift.reflect("Any")!).handle.equals(compiled("fixture.anyType"))).toBe(true);
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
    expect(Swift.function(module, GENERIC_IDENTITY, { typeArguments: [greeter] }).call(ada)).toEqual({ name: "Ada" });
    expect(Swift.function(module, GENERIC_IDENTITY, { typeArguments: [Swift.reflect("Swift.Int?")!] }).call(null)).toBeNull();
  });
});

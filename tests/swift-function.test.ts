import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadResilient } from "./fixtures/load.js";
import { SWIFTCORE_MODULE } from "./swift.js";

import { Swift, SwiftError, ClassType, SwiftObject, SwiftStruct, SwiftType } from "../src/index.js";
import { metadataFor, typeOf } from "../src/abi.js";

const ADD_INTS = "$s7fixture7addIntsyS2i_SitF";
const STRING_LENGTH = "$s7fixture12stringLengthySiSSF";
const REPEAT_STRING = "$s7fixture12repeatStringySiSS_SitF";
const SUM_LOADABLE = "$s7fixture11sumLoadableySiAA0C6StructVF";
const MAKE_LOADABLE_STRUCT = "$s7fixture18makeLoadableStructAA0cD0VyF";
const MIGHT_THROW = "$s7fixture10mightThrowyS2iKF";
const GENERIC_IDENTITY = "$s7fixture15genericIdentityyxxlF";
const GENERIC_FIRST = "$s7fixture12genericFirstyxx_q_tr0_lF";
const SCALE_GENERIC = "$s7fixture12scaleGeneric_2bySix_SitAA8ScalableRzlF";
const ECHO_GENERIC_ASYNC = "$s7fixture16echoGenericAsyncyxxYalF";
const ACCUMULATOR_PEEK = "$s7fixture11AccumulatorV4peekyS2iF";
const ACCUMULATOR_PEEK_ASYNC = "$s7fixture11AccumulatorV9peekAsyncyS2iYaF";
const ACCUMULATOR_DEPOSIT_ASYNC = "$s7fixture11AccumulatorV12depositAsyncyySiYaF";
const SMALL_GENERIC_BOX_ECHO = "$s7fixture15SmallGenericBoxV4echoyxxlF";
const SMALL_GENERIC_BOX_SCALED_BY_ASYNC = "$s7fixture15SmallGenericBoxV13scaledByAsyncySix_SitYaAA8ScalableRzlF";
const ROBOT_METADATA_ACCESSOR = "$s7fixture5RobotCMa";
const ROBOT_GREET = "$s7fixture5RobotC5greetyS2SF";
const COMPUTE_ASYNC = "$s7fixture12computeAsyncyS2iYaF";
const ROBOT_ALLOCATING_INIT = "$s7fixture5RobotC4nameACSS_tcfC";
const BURROW_OCCUPANT = "$s7fixture6BurrowC8occupantSSyFZ";
const GENERIC_HOLDER_SCALED_STORED = "$s7fixture13GenericHolderC12scaledStored2byS2i_tF";
const CONSTRAINED_BOX_SCALED_STORED = "$s7fixture14ConstrainedBoxV12scaledStored2byS2i_tF";
const RESILIENT_BASE_GREETING_DISPATCH_THUNK = "$s9resilient13ResilientBaseC8greetingSSyFTj";

describe("Swift.function", () => {
  let module: Module;
  let Int: SwiftType;
  let Str: SwiftType;
  beforeEach(() => {
    module = loadFixture();
    Int = typeOf(metadataFor("Swift.Int")!);
    Str = typeOf(metadataFor("Swift.String")!);
  });

  test("calls a free function with Int arguments: addInts(20, 22) ⇒ 42", () => {
    const addInts = Swift.function(module, ADD_INTS);
    expect(addInts.call(20, 22)).toEqual(int64(42));
  });

  test("passes String arguments: stringLength(\"frida\") ⇒ 5, repeatString(\"ab\", 3) ⇒ 6", () => {
    expect(Swift.function(module, STRING_LENGTH).call("frida")).toEqual(int64(5));
    expect(Swift.function(module, REPEAT_STRING).call("ab", 3)).toEqual(int64(6));
  });

  test("marshals a struct argument and decodes a struct return", () => {
    expect(Swift.function(module, SUM_LOADABLE).call({ a: 1, b: 2, c: 3, d: 4 })).toEqual(int64(10));
    expect(Swift.function(module, MAKE_LOADABLE_STRUCT).call()).toEqual({
      a: int64(1),
      b: int64(2),
      c: int64(3),
      d: int64(4),
    });
  });

  test("derives throws from the signature: mightThrow(0) ⇒ 99, mightThrow(1) throws SwiftError", () => {
    const mightThrow = Swift.function(module, MIGHT_THROW);
    expect(mightThrow.call(0)).toEqual(int64(99));
    expect(() => mightThrow.call(1)).toThrow(SwiftError);
  });

  test("returns a Promise for an async symbol: computeAsync(21) ⇒ 42", async () => {
    const computeAsync = Swift.function<Promise<Int64>, [number]>(module, COMPUTE_ASYNC);
    expect(await computeAsync.call(21)).toEqual(int64(42));
  });

  test("binds a class receiver for a sync instance method: Robot(\"R2\").greet(\"X\")", () => {
    const robot = (typeOf(metadataFor("fixture.Robot")!) as ClassType).facade.init("R2");
    const greet = Swift.function(module, ROBOT_GREET).bind(robot);
    expect(greet("X")).toBe("Hello X, I am R2");
  });

  test("passes the class metadata as self to a class func: Burrow.occupant() reads Self", () => {
    expect(Swift.function(module, BURROW_OCCUPANT).call()).toBe("Burrow");
  });

  test("calling an instance method without binding a receiver throws", () => {
    expect(() => Swift.function(module, ROBOT_GREET).call("X")).toThrow(/instance method/);
  });

  test("validates argument count", () => {
    expect(() => Swift.function(module, ADD_INTS).call(1)).toThrow(/2 argument/);
  });

  test("calls a generic free function with { typeArguments }: genericIdentity<Int>(21) ⇒ 21", () => {
    expect(Swift.function(module, GENERIC_IDENTITY, { typeArguments: [Int] }).call(21)).toEqual(int64(21));
    expect(Swift.function(module, GENERIC_IDENTITY, { typeArguments: [Str] }).call("hi")).toBe("hi");
    expect(Swift.function(module, GENERIC_FIRST, { typeArguments: [Int, Str] }).call(7, "x")).toEqual(int64(7));
  });

  test("passes the witness table of a constrained generic: scaleGeneric<Int>(3, by: 7) ⇒ 21", () => {
    expect(Swift.function(module, SCALE_GENERIC, { typeArguments: [Int] }).call(3, 7)).toEqual(int64(21));
  });

  test("a generic symbol without its type arguments throws", () => {
    expect(() => Swift.function(module, GENERIC_IDENTITY)).toThrow(/genericIdentity\(_:\); supply it via \{ typeArguments \}/);
    expect(() => Swift.function(module, GENERIC_FIRST, { typeArguments: [Int] })).toThrow(/needs 2 type argument/);
  });

  test("drives a generic async free function: echoGenericAsync<Int>(21) ⇒ 21", async () => {
    expect(await Swift.asyncFunction(module, ECHO_GENERIC_ASYNC, { typeArguments: [Int] }).call(21)).toEqual(int64(21));
    expect(await Swift.function(module, ECHO_GENERIC_ASYNC, { typeArguments: [Str] }).call("hi")).toBe("hi");
  });

  test("binds a value receiver: Accumulator(total: 10).peek(5) ⇒ 15, peekAsync(5) ⇒ 15", async () => {
    const acc = (Swift.type("fixture.Accumulator") as SwiftStruct).$new({ total: 10 });
    expect(Swift.function(module, ACCUMULATOR_PEEK).bind(acc)(5)).toEqual(int64(15));
    expect(await Swift.asyncFunction(module, ACCUMULATOR_PEEK_ASYNC).bind(acc)(5)).toEqual(int64(15));
  });

  test("binds a mutating async value method with { self: \"mutating\" }: depositAsync(5) adds to total", async () => {
    const acc = (Swift.type("fixture.Accumulator") as SwiftStruct).$new({ total: 10 });
    await Swift.asyncFunction(module, ACCUMULATOR_DEPOSIT_ASYNC, { self: "mutating" }).bind(acc)(5);
    expect(acc.total).toEqual(int64(15));
  });

  test("binds a value receiver for a generic method: SmallGenericBox.echo<Int>(7) ⇒ 7, scaledByAsync<Int>(3, 7) ⇒ 31", async () => {
    const box = (Swift.type("fixture.SmallGenericBox") as SwiftStruct).$new({ base: 10 });
    expect(Swift.function(module, SMALL_GENERIC_BOX_ECHO, { typeArguments: [Int] }).bind(box)(7)).toEqual(int64(7));
    const scaledBy = Swift.asyncFunction(module, SMALL_GENERIC_BOX_SCALED_BY_ASYNC, { typeArguments: [Int], self: "borrowing" });
    expect(await scaledBy.bind(box)(3, 7)).toEqual(int64(31));
  });

  test("rejects a method of a generic type", () => {
    expect(() => Swift.function(module, GENERIC_HOLDER_SCALED_STORED)).toThrow(
      /scaledStored\(by:\) is a member of generic type fixture\.GenericHolder/
    );
    expect(() => Swift.function(module, CONSTRAINED_BOX_SCALED_STORED)).toThrow(
      /scaledStored\(by:\) is a member of generic type fixture\.ConstrainedBox/
    );
  });

  test("rejects a symbol whose context is not a type: a dispatch thunk", () => {
    expect(() => Swift.function(loadResilient(), RESILIENT_BASE_GREETING_DISPATCH_THUNK)).toThrow(
      /cannot parse a function signature from dispatch thunk of resilient\.ResilientBase\.greeting/
    );
  });

  test("rejects an initializer, which consumes its arguments", () => {
    expect(() => Swift.function(module, ROBOT_ALLOCATING_INIT)).toThrow(/__allocating_init\(name:\) is an initializer/);
  });

  test("rejects a symbol that is not a function signature", () => {
    expect(() => Swift.function(module, ROBOT_METADATA_ACCESSOR)).toThrow(
      /cannot parse a function signature from type metadata accessor for fixture\.Robot/
    );
    expect(() => Swift.function(module, "not_a_swift_symbol")).toThrow(/not a Swift symbol/);
  });

  test("rejects a symbol the module does not define", () => {
    const swiftCore = Process.getModuleByName(SWIFTCORE_MODULE);
    expect(() => Swift.function(swiftCore, ADD_INTS)).toThrow(/no symbol \$s7fixture7addIntsyS2i_SitF in/);
  });
});

describe("Swift.function from a qualified selector", () => {
  beforeEach(() => {
    loadFixture();
  });

  function robot(name: string) {
    return (typeOf(metadataFor("fixture.Robot")!) as ClassType).facade.init(name);
  }

  test("an instance method takes self first: Robot.move(to:)(robot, 5) ⇒ 5, move(by:) ⇒ 50", () => {
    const r2 = robot("R2");
    expect(Swift.function("fixture.Robot.move(to:)").call(r2, 5)).toEqual(int64(5));
    expect(Swift.function("fixture.Robot.move(by:)").call(r2, 5)).toEqual(int64(50));
  });

  test("a type method is called directly: Robot.make(name:)(\"R2\").name ⇒ R2", () => {
    const made = Swift.function("fixture.Robot.make(name:)");
    expect(made.isStatic).toBe(true);
    expect((made.call("R2") as SwiftObject).name).toBe("R2");
  });

  test("resolves the same address as the type's member lookup", () => {
    const type = Swift.class("fixture.Robot")!.$type;
    expect(Swift.function("fixture.Robot.move(to:)").address.equals(type.instanceMethod("move(to:)").address)).toBe(true);
    expect(Swift.function("fixture.Robot.make(name:)").address.equals(type.typeMethod("make(name:)").address)).toBe(true);
  });

  test("a specialization's type arguments select the metadata a static is called with", () => {
    const scale = Swift.function("fixture.ConstrainedBox<Swift.Int>.scale(_:by:)");
    expect(scale.isStatic).toBe(true);
    expect(scale.address.equals(Swift.function("fixture.ConstrainedBox.scale(_:by:)").address)).toBe(true);
    expect(scale.call(3, 7)).toEqual(int64(21));
    expect(Swift.function("fixture.Keyed<Swift.String>.echo(_:)").call("a")).toBe("a");
  });

  test("a selector shared by a type and an instance member needs { static }", () => {
    expect(() => Swift.function("fixture.Dial.scaled(_:)")).toThrow(/pick one with \{ static: true \}/);
    expect(Swift.function("fixture.Dial.scaled(_:)", { static: true }).call(2)).toEqual(int64(200));
    const dial = Swift.struct("fixture.Dial")!.init({ value: 7 });
    expect(Swift.function("fixture.Dial.scaled(_:)", { static: false }).call(dial, 3)).toEqual(int64(21));
  });

  test("a bare name resolves when it has one overload and reports ambiguity otherwise", () => {
    expect(Swift.function("fixture.Robot.greet").call(robot("R2"), "X")).toBe("Hello X, I am R2");
    expect(() => Swift.function("fixture.Robot.pick")).toThrow(/ambiguous method pick/);
  });

  test("calling an instance method without self throws", () => {
    const move = Swift.function("fixture.Robot.move(to:)");
    expect(() => move.call()).toThrow(/instance method; pass self/);
    expect(() => move.call(5)).toThrow(/instance method; pass self/);
  });

  test("an async member returns a Promise from either entry point", async () => {
    const calc = Swift.class("fixture.AsyncCalc")!.init(100);
    expect(await Swift.function("fixture.AsyncCalc.addAsync(_:)").call(calc, 5)).toEqual(int64(105));
    expect(await Swift.asyncFunction("fixture.AsyncCalc.addAsync(_:)").call(calc, 6)).toEqual(int64(106));
    expect(() => Swift.asyncFunction("fixture.Robot.move(to:)")).toThrow("not async; use Swift.function");
  });

  test("rejects an unknown type, an unknown member and an unqualified selector", () => {
    expect(() => Swift.function("fixture.Nobody.move(to:)")).toThrow(/unknown type: fixture\.Nobody/);
    expect(() => Swift.function("fixture.Robot.teleport(to:)")).toThrow(/no member teleport\(to:\) on fixture\.Robot/);
    expect(() => Swift.function("addInts(_:_:)")).toThrow(/not a qualified selector/);
  });
});

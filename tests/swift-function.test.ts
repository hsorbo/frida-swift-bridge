import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture, loadResilient } from "./fixtures/load.js";
import { SWIFTCORE_MODULE } from "./swift.js";

import { Swift, SwiftError, ClassType } from "../src/index.js";
import { metadataFor, typeOf } from "../src/abi.js";

const ADD_INTS = "$s7fixture7addIntsyS2i_SitF";
const STRING_LENGTH = "$s7fixture12stringLengthySiSSF";
const REPEAT_STRING = "$s7fixture12repeatStringySiSS_SitF";
const SUM_LOADABLE = "$s7fixture11sumLoadableySiAA0C6StructVF";
const MAKE_LOADABLE_STRUCT = "$s7fixture18makeLoadableStructAA0cD0VyF";
const MIGHT_THROW = "$s7fixture10mightThrowyS2iKF";
const GENERIC_IDENTITY = "$s7fixture15genericIdentityyxxlF";
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
  beforeEach(() => {
    module = loadFixture();
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

  test("rejects a generic symbol", () => {
    expect(() => Swift.function(module, GENERIC_IDENTITY)).toThrow(/genericIdentity\(_:\) is generic/);
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
      /greeting\(\): cannot resolve receiver type dispatch thunk of resilient\.ResilientBase/
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

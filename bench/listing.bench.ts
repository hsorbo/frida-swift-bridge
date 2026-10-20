import { bench, describe } from "@frida/injest/agent";
import { Swift, SwiftClass } from "../src/index.js";
import { FIXTURE_MODULE } from "../tests/fixtures/load.js";
import "./counters.js";

const MAKE_LOADABLE_STRUCT = "$s7fixture18makeLoadableStructAA0cD0VyF";
const SUM_LOADABLE = "$s7fixture11sumLoadableySiAA0C6StructVF";

describe("lookup", () => {
  bench("Swift.type by qualified name", ({ measure }) => {
    measure(() => Swift.type("fixture.Robot"));
  });

  bench("instanceMethod by name", ({ measure }) => {
    const Robot = Swift.class("fixture.Robot")!.$type;
    measure(() => Robot.instanceMethod("greet"));
  });

  bench("class init", ({ measure }) => {
    const Robot = Swift.class("fixture.Robot")!;
    measure(() => Robot.init("R2")!);
  });

  bench("object method call", ({ measure }) => {
    const robot = Swift.class("fixture.Robot")!.init("R2")!;
    measure(() => robot.greet("Alice"));
  });

  bench("Array element through a subscript bound once", ({ measure }) => {
    const ints = Swift.struct("Swift.Array<Swift.Int>")!.$new([1, 2, 3]);
    const element = ints.$subscript({ argTypes: ["Swift.Int"] });
    measure(() => element.get(1));
  });

  bench("Array element through a subscript bound per read", ({ measure }) => {
    const ints = Swift.struct("Swift.Array<Swift.Int>")!.$new([1, 2, 3]);
    measure(() => ints.$subscript({ argTypes: ["Swift.Int"] }).get(1));
  });

  bench("free function call returning a struct", ({ measure }) => {
    const make = Swift.function(Process.getModuleByName(FIXTURE_MODULE), MAKE_LOADABLE_STRUCT);
    measure(() => make.call());
  });

  bench("hooked call with a struct argument", async ({ measure }) => {
    const sum = Swift.function(Process.getModuleByName(FIXTURE_MODULE), SUM_LOADABLE);
    const arg = Swift.struct("fixture.LoadableStruct")!.$new({ a: 1, b: 2, c: 3, d: 4 });
    const listener = Swift.Interceptor.attach(sum, { onEnter(args) { void args[0]; } });
    try {
      await measure(() => sum.call(arg));
    } finally {
      listener.detach();
    }
  });

  bench("Swift.Interceptor attach and detach on a facade method", ({ measure }) => {
    const robot = Swift.class("fixture.Robot")!.init("R2")!;
    measure(() => Swift.Interceptor.attach(robot.greet, { onEnter() {} }).detach());
  });

  bench("Swift.demangle of an exported symbol", ({ measure }) => {
    const name = Process.getModuleByName(FIXTURE_MODULE)
      .enumerateExports()
      .find((e) => e.name.startsWith("$s"))!.name;
    measure(() => Swift.demangle(name));
  });
});

describe("listing", () => {
  bench("instanceMethods on a stripped class", ({ measure }) => {
    const Dispatcher = Swift.class("fixture.Dispatcher")!.$type;
    measure(() => Dispatcher.instanceMethods());
  });

  bench("instanceMethods on a struct", ({ measure }) => {
    const Accumulator = Swift.struct("fixture.Accumulator")!.$type;
    measure(() => Accumulator.instanceMethods());
  });

  bench("members on a struct", ({ measure }) => {
    const Accumulator = Swift.struct("fixture.Accumulator")!.$type;
    measure(() => Accumulator.members());
  });

  bench("instanceMethods on Swift.Int, shallow", ({ measure }) => {
    const Int = Swift.struct("Swift.Int")!.$type;
    measure(() => Int.instanceMethods());
  });

  bench(
    "instanceMethods on Swift.Int, deep",
    ({ measure }) => {
      const Int = Swift.struct("Swift.Int")!.$type;
      measure(() => Int.instanceMethods({ deep: true }));
    },
    { warmup: 1, iterations: 3 },
  );

  bench("properties on a class", ({ measure }) => {
    const Robot = Swift.class("fixture.Robot")!.$type;
    measure(() => Robot.properties());
  });

  bench("Object.keys on a type facade", ({ measure }) => {
    const Robot = Swift.class("fixture.Robot") as SwiftClass;
    measure(() => Object.keys(Robot));
  });

  bench("Object.keys on an object facade", ({ measure }) => {
    const robot = Swift.class("fixture.Robot")!.init("R2")!;
    measure(() => Object.keys(robot));
  });
});

import { bench, describe } from "@frida/injest/agent";
import { Swift, SwiftClass } from "../src/index.js";
import { FIXTURE_MODULE } from "../tests/fixtures/load.js";
import "./counters.js";

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
    measure(() => Robot.init("R2"));
  });

  bench("object method call", ({ measure }) => {
    const robot = Swift.class("fixture.Robot")!.init("R2");
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

  bench("Swift.Interceptor attach and detach on a facade method", ({ measure }) => {
    const robot = Swift.class("fixture.Robot")!.init("R2");
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
    const robot = Swift.class("fixture.Robot")!.init("R2");
    measure(() => Object.keys(robot));
  });
});

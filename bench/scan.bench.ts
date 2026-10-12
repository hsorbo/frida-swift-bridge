import { bench, describe } from "@frida/injest/agent";
import { Swift } from "../src/index.js";
import { FIXTURE_MODULE } from "../tests/fixtures/load.js";
import "./counters.js";

describe("scan", () => {
  bench(
    "Swift.choose over a class with live instances",
    ({ measure }) => {
      const Cat = Swift.class("fixture.Cat")!;
      const alive = [Cat.init(), Cat.init()];
      measure(() => Swift.choose(Cat));
      alive.length = 0;
    },
    { warmup: 1, iterations: 5 },
  );

  bench(
    "specializations of a generic struct",
    ({ measure }) => {
      const Keyed = Swift.struct("fixture.Keyed")!.$type;
      measure(() => Keyed.specializations());
    },
    { warmup: 1, iterations: 5 },
  );

  bench("enumerateFunctions with a selector glob", ({ measure }) => {
    measure(() => [...Swift.enumerateFunctions("fixture.Robot.greet(*")]);
  });

  bench("enumerateTypes over one module", ({ measure }) => {
    const fixture = Process.getModuleByName(FIXTURE_MODULE);
    measure(() => [...Swift.enumerateTypes(fixture)]);
  });

  bench("protocols of a type", ({ measure }) => {
    const Robot = Swift.class("fixture.Robot")!.$type;
    measure(() => Robot.protocols());
  });
});

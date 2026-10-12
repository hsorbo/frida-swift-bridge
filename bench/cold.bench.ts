import { bench } from "@frida/injest/agent";
import { Swift } from "../src/index.js";
import "./counters.js";

// Each of these runs once in a fresh process: the cost of the first touch, which a warm
// iteration never sees.
bench.isolated(
  "first Swift.type lookup in a fresh process",
  ({ measure }) => {
    measure(() => Swift.type("fixture.Robot"));
  },
  { warmup: 0, iterations: 1 },
);

bench.isolated(
  "first instanceMethods on a stripped class in a fresh process",
  ({ measure }) => {
    const Dispatcher = Swift.class("fixture.Dispatcher")!.$type;
    measure(() => Dispatcher.instanceMethods());
  },
  { warmup: 0, iterations: 1 },
);

bench.isolated(
  "first instanceMethods on Swift.Int in a fresh process",
  ({ measure }) => {
    const Int = Swift.struct("Swift.Int")!.$type;
    measure(() => Int.instanceMethods());
  },
  { warmup: 0, iterations: 1 },
);

import { test, expect, describe } from "@frida/injest/agent";
import { fixtureExport } from "./fixtures/load.js";

import { Swift, type CallResult } from "../src/index.js";

describe("hook decodes generic uses", () => {
  test("resolves A? arg and return per-invocation from the recovered param", () => {
    const roundOptional = fixtureExport("fixture.roundOptional");
    const trigger = fixtureExport("fixture.triggerRoundOptional");
    let seenArgs: CallResult[] | null = null;
    let seenRet: CallResult = null;
    const listener = Swift.Interceptor.attach(roundOptional, {
      onEnter(args) {
        seenArgs = args;
      },
      onLeave(ret) {
        seenRet = ret;
      },
    });
    Swift.NativeFunction(trigger, Swift.type("Swift.Int")!, [])();
    listener.detach();
    expect(seenArgs).toEqual([int64(9)]);
    expect(seenRet).toEqual(int64(9));
  });
});

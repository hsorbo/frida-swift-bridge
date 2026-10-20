// Regression capture for the async onComplete completion-drop bug.
import { test, describe } from "@frida/injest/agent";
import { requireSwift } from "./swift.js";
import { loadFixture } from "./fixtures/load.js";
import { AsyncFunctionPointer, driveAsyncCall } from "../src/abi.js";

import { Swift } from "../src/index.js";
const DIVIDE_ASYNC = "$s7fixture11divideAsyncyS2i_SitYaKF";
const DIVIDE_ASYNC_AFP = DIVIDE_ASYNC + "Tu";

function afp(module: Module, symbol: string): AsyncFunctionPointer {
  return new AsyncFunctionPointer(module.getExportByName(symbol).strip());
}

// A stress run of the completion hook in a process of its own: a dropped completion is a race the
// shared process would make harder to blame.
describe("async onComplete completion drop (regression capture)", () => {
  test.isolated("onComplete fires for every async completion (no dropped hooks)", () => {
    requireSwift();
    const module = loadFixture();
    const target = module.getExportByName(DIVIDE_ASYNC);
    const CALLS = 10000;

    for (let i = 0; i < CALLS; i++) {
      let fired = false;
      const listener = Swift.Interceptor.attachAsync(target, {
        onComplete() {
          fired = true;
        },
      });
      try {
        try {
          driveAsyncCall(afp(module, DIVIDE_ASYNC_AFP), [ptr(10), ptr(0)], { throws: true });
        } catch {
          // divideAsync(_, 0) throws; the throw itself is expected and not what we assert.
        }
      } finally {
        listener.detach();
      }
      if (!fired) {
        throw new Error(`onComplete was dropped on call ${i} of ${CALLS} (cross-core hook race)`);
      }
    }
  }, { timeout: 120000 });
});

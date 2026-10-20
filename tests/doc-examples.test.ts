import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";
import { DOC_EXAMPLES } from "./fixtures/doc-examples.js";

import { Swift } from "../src/index.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;

// A statement's trailing comment is its expected value when it reads as a JS literal, a thrown
// error when it starts with "throws", prose otherwise.
function expectedValue(comment: string): { value: unknown } | null {
  try {
    return { value: new Function("int64", `return (${comment});`)(int64) };
  } catch {
    return null;
  }
}

function harness(code: string): { body: string; expected: unknown[] } {
  const expected: unknown[] = [];
  const body = code
    .replace(/\bMyApp\b/g, "fixture")
    .split("\n")
    .map((raw) => {
      const line = raw.trim();
      if (line === "" || line.startsWith("//") || line.startsWith("import ")) {
        return "";
      }
      const m = /^(.*;)\s*\/\/\s*(.*)$/.exec(line);
      if (m === null) {
        return line;
      }
      const [, statement, comment] = m;
      if (/^(const|let|var)\b/.test(statement)) {
        return statement;
      }
      if (comment.startsWith("throws")) {
        return `expect(() => { ${statement} }).toThrow();`;
      }
      const value = expectedValue(comment);
      if (value === null) {
        return statement;
      }
      expected.push(value.value);
      return `expect(await (${statement.slice(0, -1)})).toEqual(expected[${expected.length - 1}]);`;
    })
    .join("\n");
  return { body, expected };
}

describe("api.md runnable examples", () => {
  beforeEach(() => {
    loadFixture();
  });

  // The runner lists tests by their literal names, so the examples share one and report by line.
  test("every example marked runnable runs as written, with MyApp read as fixture", async () => {
    expect(DOC_EXAMPLES.length).toBeGreaterThan(0);
    const failures: string[] = [];
    let checks = 0;
    for (const { line, code } of DOC_EXAMPLES) {
      const { body, expected } = harness(code);
      checks += expected.length;
      try {
        await new AsyncFunction("Swift", "expect", "expected", "int64", body)(Swift, expect, expected, int64);
      } catch (e) {
        failures.push(`api.md:${line}: ${String(e)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(checks).toBeGreaterThan(10);
  });
});

// The reference's runnable examples, the ```js blocks a `<!-- runnable -->` line precedes, as a
// test input: tests/doc-examples.test.ts runs them against the fixture with MyApp read as fixture.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const lines = readFileSync(`${root}/api.md`, "utf8").split("\n");
const examples = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() !== "<!-- runnable -->") continue;
  if (lines[i + 1] !== "```js") throw new Error(`api.md:${i + 1}: runnable marker without a js block after it`);
  let end = i + 2;
  while (lines[end] !== "```") end++;
  examples.push({ line: i + 2, code: lines.slice(i + 2, end).join("\n") });
  i = end;
}
const body = examples.map((e) => `  { line: ${e.line}, code: ${JSON.stringify(e.code)} },`).join("\n");
writeFileSync(`${root}/tests/fixtures/doc-examples.ts`, `export const DOC_EXAMPLES: { line: number; code: string }[] = [\n${body}\n];\n`);
console.log(`${examples.length} runnable examples from api.md`);

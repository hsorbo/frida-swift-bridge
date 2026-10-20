// What `npm pack` would publish, checked against the sources: every file is the built form of a
// current source module or one of the documents, and the manifest agrees with the license file.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function sourceModules(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceModules(path));
    } else if (entry.endsWith(".ts")) {
      out.push(relative(join(root, "src"), path).replace(/\.ts$/, ""));
    }
  }
  return out;
}

const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }));
const published = new Set(pack.files.map((f) => f.path));
const expected = new Set(["LICENSE", "README.md", "api.md", "package.json"]);
for (const module of sourceModules(join(root, "src"))) {
  for (const suffix of [".js", ".js.map", ".d.ts", ".d.ts.map"]) {
    expected.add(`dist/${module}${suffix}`);
  }
}

const problems = [];
for (const file of published) {
  if (!expected.has(file)) problems.push(`published but not built from a current source: ${file}`);
}
for (const file of expected) {
  if (!published.has(file)) problems.push(`missing from the package: ${file}`);
}

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const licenseHeader = readFileSync(join(root, "LICENSE"), "utf8").split("\n")[0].trim();
if (!licenseHeader.startsWith(manifest.license)) {
  problems.push(`package.json says ${manifest.license}, LICENSE says ${licenseHeader}`);
}
if (manifest.dependencies !== undefined && Object.keys(manifest.dependencies).length > 0) {
  problems.push(`runtime dependencies declared although the bridge imports nothing at runtime: ${Object.keys(manifest.dependencies).join(", ")}`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`${published.size} files, ${pack.size} bytes packed: contents match the sources`);

// Every environment variable the service reads must be named in the README.
// Summaries rot while module headers stay true (org README sweep, 2026-09-11);
// this holds the configuration section to the code.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("every process.env.NAME read by the service is in the README", () => {
  const readme = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
  const names = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
  }
  assert.ok(names.size >= 10, `expected env reads, found ${names.size}`);
  const missing = [...names].sort().filter((n) => !readme.includes("`" + n + "`"));
  assert.deepEqual(missing, [], `env vars absent from README: ${missing.join(", ")}`);
});

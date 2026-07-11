#!/usr/bin/env node
/**
 * Smoke tests for the vendored gilramir/gren-format binary and for
 * end-to-end pretty output from elm-to-gren.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../..");
const formatApp = path.join(root, "tools/gren-format/app");
const ugly = path.join(root, "tools/gren-format/testdata/Ugly.gren");

assert.ok(fs.existsSync(formatApp), "tools/gren-format/app must be vendored");

// 1) Formatter pretty-prints a deliberately ugly module.
const shown = spawnSync(process.execPath, [formatApp, `--show=${ugly}`], {
  encoding: "utf8",
  cwd: root,
});
assert.equal(shown.status, 0, shown.stderr || shown.stdout);
const pretty = shown.stdout;
assert.match(pretty, /add : Int -> Int -> Int/u);
assert.match(pretty, /add a b =\n    a \+ b/u);
assert.doesNotMatch(pretty, /add:Int->Int->Int/u);

// 2) Full port produces formatted source (exposing list multi-line).
const out = path.join(root, ".test-cache/format-e2e");
const cache = path.join(root, ".test-cache/ecosystem/cache");
fs.rmSync(out, { recursive: true, force: true });
const ported = spawnSync(
  process.execPath,
  [
    path.join(root, "bin/elm-to-gren.cjs"),
    "stil4m/structured-writer@1.0.3",
    "--out",
    out,
    "--cache",
    cache,
  ],
  { encoding: "utf8", cwd: root, maxBuffer: 20 * 1024 * 1024 },
);
assert.equal(ported.status, 0, ported.stderr || ported.stdout);
const source = fs.readFileSync(
  path.join(out, "src/StructuredWriter.gren"),
  "utf8",
);
assert.match(
  source,
  /module StructuredWriter exposing\n    \( Writer/u,
  "expected formatted multi-line exposing list",
);
// Mechanical emit used to leave "Array.pushFirst (x ) ( y)"; formatter tightens spaces.
assert.doesNotMatch(source, /\(x \)/u);

console.log("format tests passed");

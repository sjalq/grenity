#!/usr/bin/env node
/**
 * Law: test/ecosystem/registry-snapshot.json is a SCRIPTED, refreshable capture
 * of the FULL Elm package registry (package.elm-lang.org/search.json).
 *
 * Regeneration is an explicit act — never hand-edit the snapshot; rerun this
 * script. We store EVERY package (name + latest version only; summaries dropped
 * to keep the file lean) and let consumers filter platform packages themselves.
 *
 *   node test/ecosystem/fetch-snapshot.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const SOURCE = "https://package.elm-lang.org/search.json";
const OUT = path.join(__dirname, "registry-snapshot.json");
const SCHEMA_VERSION = 1;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: 60000,
        headers: { "user-agent": "elm-to-gren-registry-snapshot" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(new Error(`invalid JSON from ${url}: ${e.message}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
  });
}

function latestVersion(pkg) {
  if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  if (Array.isArray(pkg.versions) && pkg.versions.length) {
    return pkg.versions[pkg.versions.length - 1];
  }
  return null;
}

async function main() {
  console.log(`fetching ${SOURCE} ...`);
  const raw = await fetchJson(SOURCE);
  if (!Array.isArray(raw)) {
    throw new Error("search.json is not a JSON array");
  }

  const packages = raw
    .map((p) => ({ name: p.name, version: latestVersion(p) }))
    .filter((p) => p.name && p.version)
    // Stable order (by name) so refreshes produce minimal diffs.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    packageCount: packages.length,
    note:
      "FULL Elm registry (includes elm/* platform packages). Consumers filter " +
      "platform packages. name + latest version only; summaries dropped.",
    packages,
  };

  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(
    `wrote ${path.relative(process.cwd(), OUT)} — ${packages.length} packages`,
  );
}

main().catch((e) => {
  console.error(`fetch-snapshot failed: ${e.message}`);
  process.exit(1);
});

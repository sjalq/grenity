#!/usr/bin/env node
/**
 * Ledger ingestion of behavior verdicts.
 *
 * Reads behavior-log.jsonl (last-wins per name@version at a given commit) and
 * maps each verdict into ledger.json updates:
 *   - tested            -> behavior: "tested", evidence: BEHAVIOR PASS line
 *   - no-tests          -> behavior: "compile-only", reason: "no portable test modules"
 *   - test-failures     -> behavior: "test-failures", evidence: detail (state unchanged)
 *   - tests-unportable / tests-broken-upstream / browser-only
 *                       -> behavior: "compile-only", reason: status, evidence: detail
 *   - port-failed / harness-error -> SKIP (not durable evidence)
 *
 * For packages already in ledger.json: update behavior/reason/evidence/commit/date only.
 * For packages NOT in ledger: add entry with state "PASS".
 * Never delete or downgrade existing entries.
 *
 * Flags:
 *   --commit <hash>     Required. Only ingest log entries stamped with this commit.
 *   --dry-run           Print summary without writing.
 *
 * Usage:
 *   node test/ecosystem/ingest-behavior.cjs --commit <hash> [--dry-run]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BEHAVIOR_LOG = path.join(__dirname, "behavior-log.jsonl");
const LEDGER_PATH = path.join(__dirname, "ledger.json");

// --- arg parsing ---------------------------------------------------------------

const args = process.argv.slice(2);
let commit = null;
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--commit" && i + 1 < args.length) {
    commit = args[i + 1];
    i++;
  } else if (args[i] === "--dry-run") {
    dryRun = true;
  }
}

if (!commit) {
  console.error("Error: --commit <hash> is required");
  process.exit(1);
}

// --- read ledger and behavior log -----------------------------------------------

let ledger = { entries: [] };
if (fs.existsSync(LEDGER_PATH)) {
  const content = fs.readFileSync(LEDGER_PATH, "utf8");
  try {
    ledger = JSON.parse(content);
  } catch (e) {
    console.error(`Error parsing ledger.json: ${e.message}`);
    process.exit(1);
  }
}

if (!Array.isArray(ledger.entries)) {
  ledger.entries = [];
}

// Read behavior log and filter to the given commit, keeping only the last entry
// per name@version (later timestamps override earlier ones).
const logByPackage = new Map();
let lineNum = 0;

if (fs.existsSync(BEHAVIOR_LOG)) {
  const lines = fs.readFileSync(BEHAVIOR_LOG, "utf8").split("\n");
  for (const line of lines) {
    lineNum++;
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      console.warn(`Warning: skipping malformed line ${lineNum}: ${e.message}`);
      continue;
    }
    if (entry.commit !== commit) continue;

    const key = `${entry.name}@${entry.version}`;
    const existing = logByPackage.get(key);
    if (!existing || new Date(entry.date) > new Date(existing.date)) {
      logByPackage.set(key, entry);
    }
  }
}

// --- ingest and update ledger ---------------------------------------------------

let updated = 0;
let added = 0;
let skipped = 0;
const updates = [];

for (const [key, verdict] of logByPackage) {
  const { name, version, status, detail } = verdict;

  // Determine if this verdict should be skipped or how it maps to ledger fields.
  let behavior, reason, evidence;

  if (status === "port-failed" || status === "harness-error") {
    skipped++;
    continue;
  }

  if (status === "tested") {
    behavior = "tested";
    evidence = detail;
  } else if (status === "no-tests") {
    behavior = "compile-only";
    reason = "no portable test modules";
  } else if (status === "test-failures") {
    behavior = "test-failures";
    evidence = detail;
  } else if (
    status === "tests-unportable" ||
    status === "tests-broken-upstream" ||
    status === "browser-only"
  ) {
    behavior = "compile-only";
    reason = status;
    evidence = detail;
  } else {
    skipped++;
    continue;
  }

  // Find or create ledger entry.
  let ledgerEntry = ledger.entries.find((e) => e.name === name && e.version === version);
  const isNewEntry = !ledgerEntry;

  if (isNewEntry) {
    ledgerEntry = {
      name,
      version,
      state: "PASS",
      behavior,
      commit: verdict.commit,
      date: verdict.date,
    };
    if (reason) ledgerEntry.reason = reason;
    if (evidence) ledgerEntry.evidence = evidence;
    ledger.entries.push(ledgerEntry);
    added++;
    updates.push({ name, version, action: "added", behavior, reason, evidence });
  } else {
    // Update only behavior/reason/evidence/commit/date fields.
    ledgerEntry.behavior = behavior;
    ledgerEntry.commit = verdict.commit;
    ledgerEntry.date = verdict.date;

    if (reason) {
      ledgerEntry.reason = reason;
    } else {
      delete ledgerEntry.reason;
    }

    if (evidence) {
      ledgerEntry.evidence = evidence;
    } else {
      delete ledgerEntry.evidence;
    }

    updated++;
    updates.push({ name, version, action: "updated", behavior, reason, evidence });
  }
}

// --- write and report -----------------------------------------------------------

if (!dryRun && (updated > 0 || added > 0)) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

console.log(`Behavior ingestion (commit: ${commit})`);
console.log(`  Updated: ${updated}`);
console.log(`  Added:   ${added}`);
console.log(`  Skipped: ${skipped}`);

if (dryRun) {
  console.log(`\nDry-run mode: no changes written.`);
}

if (updates.length > 0 && (dryRun || updates.length <= 10)) {
  console.log("\nChanges:");
  for (const u of updates.slice(0, 10)) {
    const action = u.action === "added" ? "+ " : "~ ";
    console.log(
      `  ${action}${u.name}@${u.version}: behavior=${u.behavior}${u.reason ? ` reason=${u.reason}` : ""}`,
    );
  }
  if (updates.length > 10) {
    console.log(`  ... and ${updates.length - 10} more`);
  }
}

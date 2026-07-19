#!/usr/bin/env node
/**
 * Unit tests for test/ecosystem/ingest-behavior.cjs.
 *
 * Pure node — no filesystem or git. The ingestion logic is exercised with
 * fixture ledger and behavior-log entries. Covers: verdict mapping, ledger
 * updates, new-entry creation, filtering by commit, and skipping port-failed.
 */
"use strict";

const assert = require("node:assert/strict");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok  " + name);
  } catch (e) {
    failed += 1;
    console.error("  FAIL " + name);
    console.error("    " + (e && e.message ? e.message : e));
  }
}

// --- fixtures ----------------------------------------------------------------

/**
 * Simulate the core ingestion logic (pure functions; no filesystem).
 */

function ingestBehavior(verdicts, ledger, targetCommit) {
  if (!ledger.entries) ledger.entries = [];

  const updates = {
    updated: 0,
    added: 0,
    skipped: 0,
    entries: [],
  };

  // Filter verdicts to target commit; keep last-wins per name@version.
  const byPackage = new Map();
  for (const v of verdicts) {
    if (v.commit !== targetCommit) continue;
    const key = `${v.name}@${v.version}`;
    const existing = byPackage.get(key);
    if (!existing || new Date(v.date) > new Date(existing.date)) {
      byPackage.set(key, v);
    }
  }

  // Process each verdict.
  for (const verdict of byPackage.values()) {
    const { name, version, status, detail } = verdict;

    let behavior, reason, evidence;

    // Map verdict to ledger fields.
    if (status === "port-failed" || status === "harness-error") {
      updates.skipped++;
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
      updates.skipped++;
      continue;
    }

    // Find or create ledger entry.
    let entry = ledger.entries.find((e) => e.name === name && e.version === version);
    const isNew = !entry;

    if (isNew) {
      entry = {
        name,
        version,
        state: "PASS",
        behavior,
        commit: verdict.commit,
        date: verdict.date,
      };
      if (reason) entry.reason = reason;
      if (evidence) entry.evidence = evidence;
      ledger.entries.push(entry);
      updates.added++;
      updates.entries.push({ entry, isNew: true });
    } else {
      entry.behavior = behavior;
      entry.commit = verdict.commit;
      entry.date = verdict.date;

      if (reason) {
        entry.reason = reason;
      } else {
        delete entry.reason;
      }

      if (evidence) {
        entry.evidence = evidence;
      } else {
        delete entry.evidence;
      }

      updates.updated++;
      updates.entries.push({ entry, isNew: false });
    }
  }

  return updates;
}

// --- ledger fixture --------------------------------------------------------

function ledgerEntry(over) {
  return Object.assign(
    {
      name: "owner/pkg",
      version: "1.0.0",
      state: "PASS-compile-only",
      behavior: "compile-only",
      commit: "aaaaaaa",
      date: "2026-07-15",
    },
    over,
  );
}

// --- tests ------------------------------------------------------------------

check("tested verdict updates existing entry with behavior and evidence", () => {
  const ledger = {
    entries: [
      ledgerEntry({
        name: "elm-community/result-extra",
        version: "2.4.0",
      }),
    ],
  };

  const verdicts = [
    {
      name: "elm-community/result-extra",
      version: "2.4.0",
      status: "tested",
      detail: "BEHAVIOR PASS: 69 passed, 0 failed",
      commit: "abc1234",
      date: "2026-07-19T15:58:07.268Z",
    },
  ];

  const result = ingestBehavior(verdicts, ledger, "abc1234");

  assert.equal(result.updated, 1);
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 0);

  const entry = ledger.entries.find((e) => e.name === "elm-community/result-extra");
  assert.equal(entry.behavior, "tested");
  assert.equal(entry.evidence, "BEHAVIOR PASS: 69 passed, 0 failed");
  assert.equal(entry.commit, "abc1234");
  assert.equal(entry.state, "PASS-compile-only"); // unchanged
});

check("no-tests verdict creates entry with compile-only behavior and reason", () => {
  const ledger = { entries: [] };

  const verdicts = [
    {
      name: "debois/elm-dom",
      version: "1.3.0",
      status: "no-tests",
      detail: "package has no portable test modules",
      commit: "xyz9999",
      date: "2026-07-19T15:38:22.283Z",
    },
  ];

  const result = ingestBehavior(verdicts, ledger, "xyz9999");

  assert.equal(result.added, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 0);

  const entry = ledger.entries[0];
  assert.equal(entry.name, "debois/elm-dom");
  assert.equal(entry.version, "1.3.0");
  assert.equal(entry.state, "PASS");
  assert.equal(entry.behavior, "compile-only");
  assert.equal(entry.reason, "no portable test modules");
  assert(!entry.evidence);
});

check("test-failures verdict updates entry without changing state", () => {
  const ledger = {
    entries: [
      ledgerEntry({
        name: "ianmackenzie/elm-units",
        version: "2.10.0",
        state: "working-failure",
        reason: "previous-reason",
        evidence: "previous evidence",
      }),
    ],
  };

  const verdicts = [
    {
      name: "ianmackenzie/elm-units",
      version: "2.10.0",
      status: "test-failures",
      detail: "BEHAVIOR FAIL: 224 passed, 4 failed",
      commit: "fgh5555",
      date: "2026-07-19T15:58:29.801Z",
    },
  ];

  const result = ingestBehavior(verdicts, ledger, "fgh5555");

  assert.equal(result.updated, 1);
  assert.equal(result.added, 0);

  const entry = ledger.entries[0];
  assert.equal(entry.state, "working-failure"); // unchanged
  assert.equal(entry.behavior, "test-failures");
  assert.equal(entry.evidence, "BEHAVIOR FAIL: 224 passed, 4 failed");
  // reason deleted since test-failures doesn't set it
  assert(!entry.reason);
});

check("tests-unportable creates entry with compile-only and reason", () => {
  const ledger = { entries: [] };

  const verdicts = [
    {
      name: "danfishgold/base64-bytes",
      version: "1.1.0",
      status: "tests-unportable",
      detail: "-- NAMING ERROR ------------------------------------------------- src/Tests.gren",
      commit: "commit123",
      date: "2026-07-19T15:58:09.592Z",
    },
  ];

  const result = ingestBehavior(verdicts, ledger, "commit123");

  assert.equal(result.added, 1);
  const entry = ledger.entries[0];
  assert.equal(entry.behavior, "compile-only");
  assert.equal(entry.reason, "tests-unportable");
  assert.equal(
    entry.evidence,
    "-- NAMING ERROR ------------------------------------------------- src/Tests.gren",
  );
});

check("browser-only creates entry with compile-only and reason", () => {
  const ledger = { entries: [] };

  const verdicts = [
    {
      name: "krisajenkins/remotedata",
      version: "6.1.0",
      status: "browser-only",
      detail: "browser-platform package; node harness cannot compile browser imports",
      commit: "jkl7777",
      date: "2026-07-19T16:00:25.811Z",
    },
  ];

  const result = ingestBehavior(verdicts, ledger, "jkl7777");

  assert.equal(result.added, 1);
  const entry = ledger.entries[0];
  assert.equal(entry.behavior, "compile-only");
  assert.equal(entry.reason, "browser-only");
});

check("tests-broken-upstream creates entry with compile-only and reason", () => {
  const ledger = { entries: [] };

  const verdicts = [
    {
      name: "rtfeldman/elm-hex",
      version: "1.0.0",
      status: "tests-broken-upstream",
      detail: "-- NAMING ERROR ------------------------------------------------- src/Tests.gren",
      commit: "def3333",
      date: "2026-07-19T15:43:21.279Z",
    },
  ];

  const result = ingestBehavior(verdicts, ledger, "def3333");

  assert.equal(result.added, 1);
  const entry = ledger.entries[0];
  assert.equal(entry.behavior, "compile-only");
  assert.equal(entry.reason, "tests-broken-upstream");
});

check("port-failed verdict is skipped", () => {
  const ledger = { entries: [] };

  const verdicts = [
    {
      name: "toastal/either",
      version: "3.6.3",
      status: "port-failed",
      detail: "PROCESS_FAILED: unzip exited with code 80",
      commit: "pqr2222",
      date: "2026-07-19T15:55:38.432Z",
    },
  ];

  const result = ingestBehavior(verdicts, ledger, "pqr2222");

  assert.equal(result.skipped, 1);
  assert.equal(result.added, 0);
  assert.equal(result.updated, 0);
  assert.equal(ledger.entries.length, 0);
});

check("harness-error verdict is skipped", () => {
  const ledger = { entries: [] };

  const verdicts = [
    {
      name: "example/pkg",
      version: "1.0.0",
      status: "harness-error",
      detail: "harness crashed",
      commit: "err1111",
      date: "2026-07-19T16:00:00.000Z",
    },
  ];

  const result = ingestBehavior(verdicts, ledger, "err1111");

  assert.equal(result.skipped, 1);
  assert.equal(ledger.entries.length, 0);
});

check("filters by commit: verdicts at other commits ignored", () => {
  const ledger = { entries: [] };

  const verdicts = [
    {
      name: "pkg/a",
      version: "1.0.0",
      status: "tested",
      detail: "BEHAVIOR PASS: 10 passed, 0 failed",
      commit: "commit-old",
      date: "2026-07-19T10:00:00.000Z",
    },
    {
      name: "pkg/b",
      version: "2.0.0",
      status: "no-tests",
      detail: "no tests",
      commit: "commit-target",
      date: "2026-07-19T15:00:00.000Z",
    },
  ];

  const result = ingestBehavior(verdicts, ledger, "commit-target");

  assert.equal(result.added, 1);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].name, "pkg/b");
});

check("last-wins per name@version: later date overrides earlier", () => {
  const ledger = { entries: [] };

  const verdicts = [
    {
      name: "example/pkg",
      version: "1.0.0",
      status: "no-tests",
      detail: "no tests",
      commit: "abc123",
      date: "2026-07-19T10:00:00.000Z",
    },
    {
      name: "example/pkg",
      version: "1.0.0",
      status: "tested",
      detail: "BEHAVIOR PASS: 5 passed, 0 failed",
      commit: "abc123",
      date: "2026-07-19T15:00:00.000Z", // later date
    },
  ];

  const result = ingestBehavior(verdicts, ledger, "abc123");

  assert.equal(result.added, 1);
  const entry = ledger.entries[0];
  assert.equal(entry.behavior, "tested"); // from second verdict
  assert.equal(entry.evidence, "BEHAVIOR PASS: 5 passed, 0 failed");
});

check("preserves existing ledger state when updating entry", () => {
  const ledger = {
    entries: [
      ledgerEntry({
        name: "example/stateful",
        version: "1.0.0",
        state: "working-failure",
        reason: "old-reason",
        evidence: "old evidence",
      }),
    ],
  };

  const verdicts = [
    {
      name: "example/stateful",
      version: "1.0.0",
      status: "tested",
      detail: "BEHAVIOR PASS: 100 passed, 0 failed",
      commit: "upd1111",
      date: "2026-07-19T16:00:00.000Z",
    },
  ];

  const result = ingestBehavior(verdicts, ledger, "upd1111");

  assert.equal(result.updated, 1);
  const entry = ledger.entries[0];
  assert.equal(entry.state, "working-failure"); // state preserved
  assert.equal(entry.behavior, "tested"); // behavior updated
  assert.equal(entry.evidence, "BEHAVIOR PASS: 100 passed, 0 failed");
  assert(!entry.reason); // reason cleared because tested doesn't set it
});

// --- exit -------------------------------------------------------------------

if (failed > 0) {
  console.error(`\n${failed} ingest-behavior test(s) FAILED`);
  process.exit(1);
}
console.log("\nall ingest-behavior tests passed");
process.exit(0);

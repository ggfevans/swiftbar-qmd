import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderMenu } from "../lib/menu.ts";
import type {
  CollectionState,
  Config,
  CurrentState,
  IndexStatus,
  LogFileInfo,
  TierReason,
} from "../lib/types.ts";

// ─── Helpers ───────────────────────────────────────────────────
//
// Mirrors the helper style in menu_in_flight_test.ts: minimal, fixed
// inputs so the tests assert on exact strings without flakiness from
// wall-clock drift.

function makeConfig(): Config {
  return {
    qmd: {
      index_path: "/tmp/swiftbar-qmd-menu-test/index.sqlite",
      daemon_url: "http://localhost:8181",
    },
    rollup: {
      freshness: { amber_hours: 24, red_days: 7 },
      coverage: { amber_percent: 95, red_percent: 50 },
      error_window: { red_hours: 1, amber_hours: 24 },
    },
    notifications: {
      on_daemon_crash: true,
      on_op_failure: true,
      on_path_unreachable: true,
      on_job_completion: false,
      on_threshold_breach: false,
    },
    ui: {
      collection_meta: "freshness",
      hide_obsidian_when_absent: true,
    },
    logs: {
      directory: "/tmp/swiftbar-qmd-menu-test/logs",
      retain_per_action: 10,
    },
  };
}

function makeCollection(name: string): CollectionState {
  return {
    name,
    path: `/tmp/${name}`,
    qmdUri: `qmd://${name}/`,
    pattern: "**/*.md",
    reachable: true,
    docCount: 42,
    coveragePercent: 100,
    lastModified: new Date("2026-05-17T11:55:00.000Z"),
    hasObsidian: false,
  };
}

function makeStatus(): IndexStatus {
  return {
    totalDocs: 42,
    totalCollections: 1,
    dbSizeBytes: 1024,
    modelCacheBytes: 2048,
  };
}

const POLLED_AT = new Date("2026-05-17T12:00:00.000Z");

const GREEN_TIER: TierReason = { tier: "green", drivers: [] };

function makeState(recentLogs: LogFileInfo[]): CurrentState {
  return {
    collections: [makeCollection("gVault")],
    status: makeStatus(),
    daemon: {
      status: "running",
      pid: 4321,
      uptimeSeconds: 600,
      endpoint: "http://localhost:8181",
    },
    inFlightJobs: [],
    recentFailures: [],
    recentLogs,
    polledAt: POLLED_AT,
  };
}

// ─── "Show last output" rendering (SPEC §10.2) ────────────────

Deno.test("renderMenu: no recentLogs → no 'Show last output' row", () => {
  const out = renderMenu(makeState([]), GREEN_TIER, makeConfig());

  // The row glyph + label uniquely identifies the entry; assert it's
  // absent so a future regression that always emits the row (with an
  // empty path) is caught here.
  assertEquals(out.includes("Show last output"), false);
});

Deno.test("renderMenu: one recentLog → 'Show last output' row points at its path", () => {
  const log: LogFileInfo = {
    action: "update-all",
    path: "/tmp/swiftbar-qmd-menu-test/logs/update-all-20260517T120000.log",
    createdAt: new Date("2026-05-17T12:00:00.000Z"),
    sizeBytes: 256,
  };
  const out = renderMenu(makeState([log]), GREEN_TIER, makeConfig());

  // The row must appear with the SPEC §10.2 glyph + label.
  assertStringIncludes(out, "📄 Show last output");

  // And must point `open -t` at exactly the path we passed in.
  const lines = out.split("\n");
  const row = lines.find((l) => l.includes("📄 Show last output"));
  if (!row) {
    throw new Error(`expected 'Show last output' row in output:\n${out}`);
  }
  assertStringIncludes(row, `bash="open"`);
  assertStringIncludes(row, `param1="-t"`);
  assertStringIncludes(row, `param2="${log.path}"`);
  assertStringIncludes(row, `terminal=false`);
});

Deno.test("renderMenu: multiple recentLogs → row points at the FIRST (newest) entry", () => {
  // lib/state.ts sorts logs newest-first before populating
  // CurrentState.recentLogs; this test asserts renderMenu honours
  // that contract rather than re-sorting or picking another index.
  const newest: LogFileInfo = {
    action: "update-all",
    path: "/tmp/logs/update-all-20260517T120000.log",
    createdAt: new Date("2026-05-17T12:00:00.000Z"),
    sizeBytes: 256,
  };
  const older: LogFileInfo = {
    action: "embed-all",
    path: "/tmp/logs/embed-all-20260516T120000.log",
    createdAt: new Date("2026-05-16T12:00:00.000Z"),
    sizeBytes: 128,
  };
  const out = renderMenu(makeState([newest, older]), GREEN_TIER, makeConfig());

  const lines = out.split("\n");
  const row = lines.find((l) => l.includes("📄 Show last output"));
  if (!row) {
    throw new Error(`expected 'Show last output' row in output:\n${out}`);
  }
  assertStringIncludes(row, `param2="${newest.path}"`);
  // And explicitly NOT the older log's path.
  assertEquals(row.includes(older.path), false);
});

Deno.test("renderMenu: 'Show last output' sits in the utility footer (after 'Show qmd status in Terminal')", () => {
  // Ordering is mandated by SPEC §10.2: Copy URL → Show qmd status →
  // Show last output → '---' → Preferences/About. We assert the
  // relative ordering of the two adjacent rows so a future refactor
  // can't accidentally re-sort them.
  const log: LogFileInfo = {
    action: "update-all",
    path: "/tmp/logs/update-all-20260517T120000.log",
    createdAt: new Date("2026-05-17T12:00:00.000Z"),
    sizeBytes: 256,
  };
  const out = renderMenu(makeState([log]), GREEN_TIER, makeConfig());

  const statusIdx = out.indexOf("Show qmd status in Terminal");
  const lastOutputIdx = out.indexOf("📄 Show last output");

  if (statusIdx < 0) {
    throw new Error(`expected 'Show qmd status in Terminal' in:\n${out}`);
  }
  if (lastOutputIdx < 0) {
    throw new Error(`expected '📄 Show last output' in:\n${out}`);
  }
  if (lastOutputIdx <= statusIdx) {
    throw new Error(
      `expected 'Show last output' to appear AFTER 'Show qmd status' (status=${statusIdx}, lastOutput=${lastOutputIdx})`,
    );
  }
});

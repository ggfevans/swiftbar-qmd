import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { getPluginPath, renderMenu } from "../lib/menu.ts";
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
      index_path: "/tmp/qmd-swiftbar-menu-test/index.sqlite",
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
      directory: "/tmp/qmd-swiftbar-menu-test/logs",
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
    path: "/tmp/qmd-swiftbar-menu-test/logs/update-all-20260517T120000.log",
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

// ─── Error-state degradation (SPEC §10.4, §16.2) ──────────────

Deno.test("renderMenu: no error context → no '⚠ Status read failed' header", () => {
  const out = renderMenu(makeState([]), GREEN_TIER, makeConfig());

  assertEquals(out.includes("Status read failed"), false);
  assertEquals(out.includes("Show last error"), false);
});

Deno.test("renderMenu: errorContext.consecutiveFailures > 0 → degradation header at top + 'Show last error' footer", () => {
  // The header sits BEFORE the Status section so a glance at the menu
  // surfaces the degraded read. SPEC §10.4 puts it at the very top.
  const lastGoodAt = new Date("2026-05-17T11:55:00.000Z");
  const out = renderMenu(
    makeState([]),
    GREEN_TIER,
    makeConfig(),
    { lastGoodAt, consecutiveFailures: 1 },
  );

  assertStringIncludes(out, "Status read failed");
  // The relative-time copy uses lib/time.ts → "5 minutes ago" for a 5
  // minute gap. The exact phrasing is asserted to lock the SPEC §10.4
  // mockup ("using last poll (Nm ago)").
  assertStringIncludes(out, "using last poll");
  // The header MUST appear before the Status section.
  const headerIdx = out.indexOf("Status read failed");
  const statusIdx = out.indexOf("Status |");
  if (headerIdx < 0 || statusIdx < 0 || headerIdx > statusIdx) {
    throw new Error(
      `expected degradation header before Status section (header=${headerIdx}, status=${statusIdx})\n${out}`,
    );
  }

  // And the "Show last error" footer row must be present.
  assertStringIncludes(out, "Show last error");
  const row = out.split("\n").find((l) => l.includes("Show last error"));
  if (!row) throw new Error("expected 'Show last error' row");
  assertStringIncludes(row, `bash="open"`);
  assertStringIncludes(row, `param1="-t"`);
  assertStringIncludes(row, `error.log`);
});

Deno.test("renderMenu: errorContext.consecutiveFailures = 0 → no degradation rows", () => {
  // A clean poll right after recovery (counter reset to 0) should
  // render without the degradation header even if errorContext is
  // passed.
  const out = renderMenu(
    makeState([]),
    GREEN_TIER,
    makeConfig(),
    { lastGoodAt: null, consecutiveFailures: 0 },
  );

  assertEquals(out.includes("Status read failed"), false);
  assertEquals(out.includes("Show last error"), false);
});

Deno.test("renderMenu: status.error set (no errorContext) → degradation header rendered", () => {
  // Defensive fallback: even if the caller forgot to pass errorContext,
  // a populated status.error indicates a read failure and the header
  // should still appear. SPEC §10.4: "state.collections is empty and
  // state.status.error is set" — we lean on status.error alone here.
  const state: CurrentState = {
    ...makeState([]),
    collections: [],
    status: { ...makeStatus(), error: "sdk timeout" },
  };
  const out = renderMenu(state, GREEN_TIER, makeConfig());

  assertStringIncludes(out, "Status read failed");
});

// ─── getPluginPath (SPEC §11.1) ───────────────────────────────

Deno.test("getPluginPath: returns a decoded POSIX path (no percent escapes)", () => {
  // Regression for the `.pathname` bug: when SwiftBar's default install
  // location (`~/Library/Application Support/SwiftBar/Plugins`) is
  // expressed as a `file://` URL, the space becomes `%20`. SwiftBar
  // executes the `bash=` directive verbatim so the path MUST be
  // pre-decoded before we hand it back.
  const out = getPluginPath();

  // The path SwiftBar receives must not contain percent-escapes.
  assertEquals(out.includes("%20"), false, "decoded path must not contain %20");
  assertEquals(out.includes("%2F"), false, "decoded path must not contain %2F");
});

Deno.test("getPluginPath: matches fromFileUrl(Deno.mainModule) — handles space-containing paths", () => {
  // Belt-and-braces: verify the helper agrees with the canonical
  // decoder. Equivalently, this asserts a `file://`-URL with a space
  // in it round-trips through the helper as a real space.
  const expected = fromFileUrl(Deno.mainModule);
  assertEquals(getPluginPath(), expected);

  // Spot-check the decoder itself with a URL containing %20 — this is
  // the exact scenario A4 is fixing.
  const decoded = fromFileUrl(
    "file:///Users/x/Library/Application%20Support/SwiftBar/Plugins/qmd.30s.ts",
  );
  assertEquals(
    decoded,
    "/Users/x/Library/Application Support/SwiftBar/Plugins/qmd.30s.ts",
  );
});

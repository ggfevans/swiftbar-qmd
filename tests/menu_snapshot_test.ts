// Snapshot tests for the 10 menu states in SPEC §19.2.
//
// Each test builds a deterministic fixture (FIXED_POLLED_AT anchors all
// timestamps) and asserts the rendered output against a committed
// `.snap` file in tests/fixtures/snapshots/.
//
// Determinism caveats:
//   1. `getPluginPath()` returns `Deno.mainModule` which varies by test
//      runner location. The serializer below replaces it with a stable
//      sentinel before snapshot comparison.
//   2. `cacheDir()` reads $HOME so the error.log path floats with the
//      user. The serializer also masks it.
//   3. All timestamps come from FIXED_POLLED_AT so relativeTime /
//      compactDuration produce identical strings each run.
//
// Regenerating snapshots (after an intentional menu change):
//   deno test --allow-read --allow-env --allow-write=/tmp \
//     tests/menu_snapshot_test.ts -- --update

import { createAssertSnapshot } from "@std/testing/snapshot";
import { getPluginPath, renderFirstRunMenu, renderMenu } from "../lib/menu.ts";
import { computeTierWithReason } from "../lib/rollup.ts";
import { cacheDir } from "../lib/persistence.ts";
import { CONFIG_PATH } from "../lib/config.ts";
import {
  buildConfig,
  buildDriftingState,
  buildHealthyState,
  buildInFlightState,
  buildRedState,
  FIXED_POLLED_AT,
} from "./fixtures/builders.ts";

// ─── Serializer ───────────────────────────────────────────────

/**
 * Normalize host-specific paths so snapshots are stable across:
 *   • test runner invocations (Deno.mainModule changes location)
 *   • CI vs developer machines ($HOME, cwd)
 *
 * Replacements are anchored on the exact runtime values; if either
 * helper ever returns the literal sentinel string a false positive is
 * theoretically possible but vanishingly unlikely on a real filesystem.
 */
function normalizePaths(out: string): string {
  const pluginPath = getPluginPath();
  const errorLogPath = `${cacheDir()}/error.log`;
  return out
    .replaceAll(pluginPath, "<PLUGIN_PATH>")
    .replaceAll(errorLogPath, "<CACHE_DIR>/error.log")
    .replaceAll(CONFIG_PATH, "<CONFIG_PATH>");
}

const assertSnapshot = createAssertSnapshot<string>({
  dir: "fixtures/snapshots",
  serializer: normalizePaths,
});

// ─── 1. Healthy state (SPEC §19.2 §1) ─────────────────────────

Deno.test("snapshot: 1 — healthy state (all green, 4 collections)", async (t) => {
  const state = buildHealthyState();
  const config = buildConfig();
  const tier = computeTierWithReason(state, config);
  const menu = renderMenu(state, tier, config);
  await assertSnapshot(t, menu);
});

// ─── 2. Drifting state (Rackula past 24h) ─────────────────────

Deno.test("snapshot: 2 — drifting state (Rackula past 24h freshness)", async (t) => {
  const state = buildDriftingState();
  const config = buildConfig();
  const tier = computeTierWithReason(state, config);
  const menu = renderMenu(state, tier, config);
  await assertSnapshot(t, menu);
});

// ─── 3. Red state (daemon stopped) ────────────────────────────

Deno.test("snapshot: 3 — red state (daemon stopped)", async (t) => {
  const state = buildRedState();
  const config = buildConfig();
  const tier = computeTierWithReason(state, config);
  const menu = renderMenu(state, tier, config);
  await assertSnapshot(t, menu);
});

// ─── 4. In-flight state (update-all running) ──────────────────

Deno.test("snapshot: 4 — in-flight state (update-all 1m elapsed)", async (t) => {
  const state = buildInFlightState();
  const config = buildConfig();
  const tier = computeTierWithReason(state, config);
  const menu = renderMenu(state, tier, config);
  await assertSnapshot(t, menu);
});

// ─── 5. First-run: no-qmd ─────────────────────────────────────

Deno.test("snapshot: 5 — first-run: no-qmd", async (t) => {
  const menu = renderFirstRunMenu("no-qmd", buildConfig());
  await assertSnapshot(t, menu);
});

// ─── 6. First-run: no-collections ─────────────────────────────

Deno.test("snapshot: 6 — first-run: no-collections", async (t) => {
  const menu = renderFirstRunMenu("no-collections", buildConfig());
  await assertSnapshot(t, menu);
});

// ─── 7. First-run: empty-index ────────────────────────────────

Deno.test("snapshot: 7 — first-run: empty-index", async (t) => {
  const menu = renderFirstRunMenu("empty-index", buildConfig());
  await assertSnapshot(t, menu);
});

// ─── 8. Error state (read failure with last-poll fallback) ────

Deno.test("snapshot: 8 — error state (consecutiveReadFailures: 1, prev snapshot)", async (t) => {
  // Synthesize the state the snapshot-aware degrader would hand the
  // renderer when a read failed once: collections empty, status carries
  // the SDK error, and recentFailures / inFlightJobs are also empty.
  const state = buildHealthyState();
  state.collections = [];
  state.status = {
    totalDocs: 0,
    totalCollections: 0,
    dbSizeBytes: 0,
    modelCacheBytes: 0,
    error: "sdk timeout reading status",
  };
  state.recentFailures = [];
  state.inFlightJobs = [];

  const config = buildConfig();
  const tier = computeTierWithReason(state, config);
  // The prev snapshot's pollTimestamp would be ~5 minutes before this
  // poll's polledAt in normal operation; mirror that so the relative
  // time copy reads "5 minutes ago".
  const lastGoodAt = new Date(FIXED_POLLED_AT.getTime() - 5 * 60 * 1000);
  const menu = renderMenu(state, tier, config, {
    lastGoodAt,
    consecutiveFailures: 1,
  });
  await assertSnapshot(t, menu);
});

// ─── 9. Config-error state (⚠ Config error header) ────────────

Deno.test("snapshot: 9 — config-error state (⚠ Config error header)", async (t) => {
  // Config-error rendering is wired through ErrorContext.configErrors
  // (see lib/menu.ts — extended for this test plan). The renderer
  // emits the "⚠ Config error — see logs" header above the Status
  // section regardless of read-failure state.
  const state = buildHealthyState();
  const config = buildConfig();
  const tier = computeTierWithReason(state, config);
  const menu = renderMenu(state, tier, config, {
    lastGoodAt: null,
    consecutiveFailures: 0,
    configErrors: [
      "rollup.coverage.amber_percent: must be a number in [0, 100]; falling back to default",
    ],
  });
  await assertSnapshot(t, menu);
});

// ─── 10. Per-collection submenu (Rackula, hasObsidian: true) ──

Deno.test("snapshot: 10 — per-collection submenu (Rackula, hasObsidian: true)", async (t) => {
  // The submenu is rendered inline by renderMenu — there's no separate
  // entry point. To exercise the Obsidian row we flip Rackula's
  // hasObsidian flag and render the full menu; the snapshot captures
  // the entire output (the submenu lines for Rackula now include the
  // "📓 Open in Obsidian" row).
  const state = buildHealthyState();
  const rackula = state.collections.find((c) => c.name === "Rackula");
  if (!rackula) {
    throw new Error("expected Rackula in baseline state");
  }
  rackula.hasObsidian = true;

  const config = buildConfig();
  const tier = computeTierWithReason(state, config);
  const menu = renderMenu(state, tier, config);
  await assertSnapshot(t, menu);
});

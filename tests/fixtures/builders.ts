// Fixture builders for snapshot tests (SPEC §19.2).
//
// Each helper returns a deeply-independent value (no shared object
// references with other fixtures) so individual tests can mutate the
// returned state without bleeding into siblings.
//
// All timestamps are anchored to FIXED_POLLED_AT so renders are
// deterministic: relativeTime / compactDuration produce identical
// strings across runs regardless of wall clock.

import type {
  CollectionState,
  Config,
  CurrentState,
  JobInfo,
} from "../../lib/types.ts";
import { DEFAULT_CONFIG } from "../../lib/config.ts";

// ─── Anchored time ────────────────────────────────────────────

/**
 * Fixed reference time for all snapshot fixtures. Chosen to match the
 * project's currentDate so any "today" copy reads naturally; the value
 * itself is arbitrary — what matters is that every fixture re-anchors
 * its timestamps off this constant.
 */
export const FIXED_POLLED_AT = new Date("2026-05-17T12:00:00.000Z");

// ─── Config ────────────────────────────────────────────────────

/**
 * Build a Config with all defaults, optionally overridden. The spread
 * is shallow; for nested overrides (e.g. `ui.hide_obsidian_when_absent`)
 * the caller should pass the entire nested object:
 *
 *   buildConfig({ ui: { ...DEFAULT_CONFIG.ui, hide_obsidian_when_absent: false } })
 */
export function buildConfig(overrides?: Partial<Config>): Config {
  // structuredClone gives us a deep copy of the defaults so the caller
  // can mutate nested fields on the returned object without poisoning
  // DEFAULT_CONFIG for later tests.
  const base = structuredClone(DEFAULT_CONFIG);
  return { ...base, ...overrides };
}

// ─── Healthy reference state (SPEC §19.2 §1) ──────────────────

/**
 * Build the reference healthy state matching the SPEC's mockup setup:
 * 4 collections (gVault, jobinator9000, obsidian-reference, Rackula),
 * daemon running ~6 hours, all collections healthy and freshly updated
 * within the amber freshness window.
 *
 * Each call returns a freshly constructed object so mutating helpers
 * (buildDriftingState, buildInFlightState) don't share state with the
 * baseline.
 */
export function buildHealthyState(): CurrentState {
  // Clone the anchored timestamp so each fixture is genuinely
  // independent. `FIXED_POLLED_AT` is a mutable Date instance — if any
  // future test ever mutated `state.polledAt` (`.setTime(...)`,
  // `.setHours(...)`, etc) the change would leak into sibling
  // fixtures. The header comment claims "deeply-independent" so make
  // it true. See PR #1 finding A11.
  const polledAt = new Date(FIXED_POLLED_AT.getTime());
  const collections: CollectionState[] = [
    {
      name: "gVault",
      path: "/Users/g/notes/gVault",
      qmdUri: "qmd://gVault/",
      pattern: "**/*.md",
      reachable: true,
      docCount: 2057,
      coveragePercent: 100,
      lastModified: new Date(polledAt.getTime() - 18 * 60 * 60 * 1000),
      hasObsidian: true,
    },
    {
      name: "jobinator9000",
      path: "/Users/g/projects/jobinator9000",
      qmdUri: "qmd://jobinator9000/",
      pattern: "**/*.md",
      reachable: true,
      docCount: 129,
      coveragePercent: 100,
      lastModified: new Date(polledAt.getTime() - 1 * 60 * 60 * 1000),
      hasObsidian: false,
    },
    {
      name: "obsidian-reference",
      path: "/Users/g/notes/obsidian-reference",
      qmdUri: "qmd://obsidian-reference/",
      pattern: "**/*.md",
      reachable: true,
      docCount: 1596,
      coveragePercent: 100,
      lastModified: new Date(polledAt.getTime() - 52 * 60 * 1000),
      hasObsidian: true,
    },
    {
      name: "Rackula",
      path: "/Users/g/notes/rackula",
      qmdUri: "qmd://Rackula/",
      pattern: "**/*.md",
      reachable: true,
      docCount: 391,
      coveragePercent: 100,
      lastModified: new Date(polledAt.getTime() - 12 * 60 * 1000),
      hasObsidian: false,
    },
  ];

  return {
    collections,
    status: {
      totalDocs: 2057 + 129 + 1596 + 391, // 4173
      totalCollections: 4,
      dbSizeBytes: 4 * 1024 * 1024, // 4 MB
      modelCacheBytes: 2.5 * 1024 * 1024 * 1024, // 2.5 GB
    },
    daemon: {
      status: "running",
      pid: 4218,
      uptimeSeconds: 6 * 60 * 60 + 4 * 60, // 6h 4m
      endpoint: "http://localhost:8181",
    },
    inFlightJobs: [],
    recentFailures: [],
    recentLogs: [],
    polledAt,
  };
}

// ─── Variants ─────────────────────────────────────────────────

/**
 * Healthy baseline with one collection (Rackula) past the 24h amber
 * freshness threshold. Used to exercise the per-collection amber path
 * without touching daemon or coverage drivers.
 */
export function buildDriftingState(): CurrentState {
  const state = buildHealthyState();
  const rackula = state.collections.find((c) => c.name === "Rackula");
  if (!rackula) {
    throw new Error("buildDriftingState: Rackula missing from baseline");
  }
  rackula.lastModified = new Date(
    state.polledAt.getTime() - 25 * 60 * 60 * 1000,
  );
  return state;
}

/**
 * Healthy baseline with daemon stopped. Drives the menu to red and
 * swaps the "Stop MCP daemon" row for "Start MCP daemon".
 */
export function buildRedState(): CurrentState {
  const state = buildHealthyState();
  state.daemon = {
    status: "stopped",
    endpoint: "http://localhost:8181",
  };
  return state;
}

/**
 * Healthy baseline with one in-flight update-all job started 1 minute
 * before polledAt. Drives an amber tier via in-flight detection and
 * rewrites the matching action row to "Running:" with disabled=true.
 */
export function buildInFlightState(): CurrentState {
  const state = buildHealthyState();
  const startedAt = new Date(state.polledAt.getTime() - 60 * 1000);
  const job: JobInfo = {
    action: "update-all",
    pid: 9999,
    startedAt,
    command: ["qmd", "update"],
    logPath: "/tmp/swiftbar-qmd-snapshot/update-all.log",
  };
  state.inFlightJobs = [job];
  return state;
}

import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderMenu } from "../lib/menu.ts";
import type {
  CollectionState,
  Config,
  CurrentState,
  IndexStatus,
  JobInfo,
  TierReason,
} from "../lib/types.ts";

// ─── Helpers ───────────────────────────────────────────────────

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

// polledAt is fixed; jobs are dated relative to it so duration assertions
// don't rely on wall-clock timing.
const POLLED_AT = new Date("2026-05-17T12:00:00.000Z");

function makeState(jobs: JobInfo[]): CurrentState {
  return {
    collections: [makeCollection("gVault")],
    status: makeStatus(),
    daemon: {
      status: "running",
      pid: 4321,
      uptimeSeconds: 600,
      endpoint: "http://localhost:8181",
    },
    inFlightJobs: jobs,
    recentFailures: [],
    recentLogs: [],
    polledAt: POLLED_AT,
  };
}

// In-flight jobs trigger amber via rollup (SPEC §9.1); the menu renderer
// doesn't recompute this, so the test feeds it the right TierReason
// directly. This mirrors how main() composes the two modules in
// production (computeTierWithReason → renderMenu).
const AMBER_TIER: TierReason = {
  tier: "amber",
  drivers: ["Update job in flight"],
};

// ─── Tests ─────────────────────────────────────────────────────

Deno.test("renderMenu: in-flight global action — Status row + disabled action row", () => {
  const startedAt = new Date(POLLED_AT.getTime() - 2 * 60 * 1000); // 2m ago
  const job: JobInfo = {
    action: "update-all",
    pid: 42,
    startedAt,
    command: ["qmd", "update"],
    logPath: "/tmp/log.log",
  };
  const out = renderMenu(makeState([job]), AMBER_TIER, makeConfig());

  // Status section gains a "⟳ Running: <label> for <duration>" row.
  assertStringIncludes(out, "⟳ Running: Update for 2m");

  // Global actions: the update-all row is rewritten with disabled=true
  // and shows the "Running: …" copy with elapsed duration. The verb
  // form follows SPEC §10.3 mockup ("Running: update…"), derived from
  // the shared `actionLabel` lookup lowercased.
  const lines = out.split("\n");
  const updateAllRow = lines.find((l) =>
    l.includes('param2="update-all"') && l.includes("Running:")
  );
  if (!updateAllRow) {
    throw new Error(
      `Expected a disabled update-all row in output:\n${out}`,
    );
  }
  assertStringIncludes(updateAllRow, "Running: update… (2m)");
  assertStringIncludes(updateAllRow, "disabled=true");
});

Deno.test("renderMenu: in-flight per-collection action — submenu row disabled", () => {
  const startedAt = new Date(POLLED_AT.getTime() - 5 * 60 * 1000); // 5m ago
  const job: JobInfo = {
    action: "embed-collection",
    collection: "gVault",
    pid: 99,
    startedAt,
    command: ["qmd", "embed", "-c", "gVault"],
    logPath: "/tmp/embed.log",
  };
  const out = renderMenu(makeState([job]), AMBER_TIER, makeConfig());

  // Status row appears with the action label and the 5m elapsed time.
  assertStringIncludes(out, "⟳ Running: Embed for 5m");

  // Submenu's embed-collection row is rewritten and disabled.
  const lines = out.split("\n");
  const submenuRow = lines.find((l) =>
    l.includes('param2="embed-collection"') &&
    l.includes('param4="gVault"') &&
    l.includes("Running:")
  );
  if (!submenuRow) {
    throw new Error(
      `Expected a disabled embed-collection submenu row in output:\n${out}`,
    );
  }
  // embed-collection maps to label "Embed" → verb form "embed".
  assertStringIncludes(submenuRow, "Running: embed… (5m)");
  assertStringIncludes(submenuRow, "disabled=true");
});

Deno.test("renderMenu: no in-flight jobs → no ⟳ Running rows, no disabled action rows", () => {
  const out = renderMenu(makeState([]), {
    tier: "green",
    drivers: [],
  }, makeConfig());

  // No Status "⟳ Running" rows when nothing is in flight.
  const hasRunningRow = out.includes("⟳ Running:");
  assertEquals(hasRunningRow, false);

  // No disabled global action rows.
  const lines = out.split("\n");
  const disabledRow = lines.find((l) => l.includes("disabled=true"));
  assertEquals(disabledRow, undefined);
});

Deno.test("renderMenu: multiple in-flight jobs render one Status row each", () => {
  const startedAtA = new Date(POLLED_AT.getTime() - 1 * 60 * 1000);
  const startedAtB = new Date(POLLED_AT.getTime() - 3 * 60 * 1000);
  const jobs: JobInfo[] = [
    {
      action: "update-all",
      pid: 11,
      startedAt: startedAtA,
      command: ["qmd", "update"],
      logPath: "/tmp/a.log",
    },
    {
      action: "embed-collection",
      collection: "gVault",
      pid: 22,
      startedAt: startedAtB,
      command: ["qmd", "embed", "-c", "gVault"],
      logPath: "/tmp/b.log",
    },
  ];
  const out = renderMenu(makeState(jobs), {
    tier: "amber",
    drivers: ["Update job in flight", "Embed job in flight"],
  }, makeConfig());

  // One Status row per job.
  const runningRows = out.split("\n").filter((l) => l.includes("⟳ Running:"));
  assertEquals(runningRows.length, 2);
  assertStringIncludes(out, "⟳ Running: Update for 1m");
  assertStringIncludes(out, "⟳ Running: Embed for 3m");

  // Both action rows are disabled.
  const lines = out.split("\n");
  const updateRow = lines.find((l) =>
    l.includes('param2="update-all"') && l.includes("disabled=true")
  );
  const embedRow = lines.find((l) =>
    l.includes('param2="embed-collection"') &&
    l.includes('param4="gVault"') &&
    l.includes("disabled=true")
  );
  if (!updateRow) {
    throw new Error("Expected update-all to be disabled");
  }
  if (!embedRow) {
    throw new Error("Expected embed-collection:gVault to be disabled");
  }
});

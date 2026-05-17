import { assert, assertEquals } from "@std/assert";
import { computeTier, computeTierWithReason } from "../lib/rollup.ts";
import { DEFAULT_CONFIG } from "../lib/config.ts";
import type {
  CollectionState,
  Config,
  CurrentState,
  DaemonState,
  FailureRecord,
  IndexStatus,
  JobInfo,
} from "../lib/types.ts";

// ─── Fixtures ──────────────────────────────────────────────────

const POLLED_AT = new Date("2026-05-17T12:00:00Z");
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

function buildCollection(
  overrides: Partial<CollectionState> = {},
): CollectionState {
  return {
    name: "gvault",
    path: "/Users/test/notes/gvault",
    qmdUri: "qmd://gvault/",
    pattern: "**/*.md",
    reachable: true,
    docCount: 100,
    coveragePercent: 100,
    lastModified: new Date(POLLED_AT.getTime() - ONE_HOUR_MS),
    hasObsidian: true,
    ...overrides,
  };
}

function buildDaemon(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    status: "running",
    pid: 1234,
    uptimeSeconds: 3600,
    endpoint: "http://localhost:8181",
    ...overrides,
  };
}

function buildStatus(overrides: Partial<IndexStatus> = {}): IndexStatus {
  return {
    totalDocs: 100,
    totalCollections: 2,
    dbSizeBytes: 1024,
    modelCacheBytes: 2048,
    ...overrides,
  };
}

interface StateOverrides {
  collections?: CollectionState[];
  status?: IndexStatus;
  daemon?: DaemonState;
  inFlightJobs?: JobInfo[];
  recentFailures?: FailureRecord[];
  polledAt?: Date;
}

function buildState(overrides: StateOverrides = {}): CurrentState {
  const defaultCollections: CollectionState[] = [
    buildCollection({ name: "gvault" }),
    buildCollection({
      name: "rackula",
      path: "/Users/test/code/rackula",
      qmdUri: "qmd://rackula/",
    }),
  ];
  return {
    collections: overrides.collections ?? defaultCollections,
    status: overrides.status ?? buildStatus(),
    daemon: overrides.daemon ?? buildDaemon(),
    inFlightJobs: overrides.inFlightJobs ?? [],
    recentFailures: overrides.recentFailures ?? [],
    polledAt: overrides.polledAt ?? POLLED_AT,
  };
}

function buildConfig(): Config {
  return structuredClone(DEFAULT_CONFIG);
}

function buildJob(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    action: "update-all",
    pid: 9999,
    startedAt: new Date(POLLED_AT.getTime() - 5_000),
    command: ["qmd", "update"],
    logPath: "/tmp/job.log",
    ...overrides,
  };
}

function buildFailure(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    action: "update-all",
    failedAt: new Date(POLLED_AT.getTime() - 30 * 60 * 1000), // 30m ago
    exitCode: 1,
    logPath: "/tmp/fail.log",
    ...overrides,
  };
}

// ─── computeTier ───────────────────────────────────────────────

Deno.test("computeTier: empty state → grey", () => {
  const state = buildState({
    collections: [],
    status: buildStatus({ totalCollections: 0, totalDocs: 0 }),
  });
  assertEquals(computeTier(state, buildConfig()), "grey");
});

Deno.test("computeTier: all green baseline", () => {
  assertEquals(computeTier(buildState(), buildConfig()), "green");
});

Deno.test(
  "computeTier: single collection past amber freshness → amber",
  () => {
    const config = buildConfig();
    const stale = new Date(
      POLLED_AT.getTime() -
        (config.rollup.freshness.amber_hours + 1) * ONE_HOUR_MS,
    );
    const state = buildState({
      collections: [
        buildCollection({ name: "gvault", lastModified: stale }),
      ],
    });
    assertEquals(computeTier(state, config), "amber");
  },
);

Deno.test(
  "computeTier: single collection past red freshness → red",
  () => {
    const config = buildConfig();
    const ancient = new Date(
      POLLED_AT.getTime() -
        (config.rollup.freshness.red_days + 1) * ONE_DAY_MS,
    );
    const state = buildState({
      collections: [
        buildCollection({ name: "gvault", lastModified: ancient }),
      ],
    });
    assertEquals(computeTier(state, config), "red");
  },
);

Deno.test(
  "computeTier: single collection below amber coverage → amber",
  () => {
    const config = buildConfig();
    const state = buildState({
      collections: [
        buildCollection({
          name: "gvault",
          coveragePercent: config.rollup.coverage.amber_percent - 1,
        }),
      ],
    });
    assertEquals(computeTier(state, config), "amber");
  },
);

Deno.test(
  "computeTier: single collection below red coverage → red",
  () => {
    const config = buildConfig();
    const state = buildState({
      collections: [
        buildCollection({
          name: "gvault",
          coveragePercent: config.rollup.coverage.red_percent - 1,
        }),
      ],
    });
    assertEquals(computeTier(state, config), "red");
  },
);

Deno.test("computeTier: daemon stopped → red", () => {
  const state = buildState({
    daemon: buildDaemon({ status: "stopped", pid: undefined }),
  });
  assertEquals(computeTier(state, buildConfig()), "red");
});

Deno.test("computeTier: daemon unresponsive → red", () => {
  const state = buildState({
    daemon: buildDaemon({ status: "unresponsive" }),
  });
  assertEquals(computeTier(state, buildConfig()), "red");
});

Deno.test("computeTier: collection unreachable → red", () => {
  const state = buildState({
    collections: [
      buildCollection({
        name: "rackula",
        path: "/Users/test/code/rackula",
        reachable: false,
      }),
    ],
  });
  assertEquals(computeTier(state, buildConfig()), "red");
});

Deno.test(
  "computeTier: recent failure within red_hours → red",
  () => {
    const config = buildConfig();
    const within = new Date(
      POLLED_AT.getTime() -
        (config.rollup.error_window.red_hours / 2) * ONE_HOUR_MS,
    );
    const state = buildState({
      recentFailures: [buildFailure({ failedAt: within })],
    });
    assertEquals(computeTier(state, config), "red");
  },
);

Deno.test(
  "computeTier: recent failure within amber_hours but outside red → amber",
  () => {
    const config = buildConfig();
    // red_hours=1, amber_hours=24. 12h ago is amber but not red.
    const within = new Date(POLLED_AT.getTime() - 12 * ONE_HOUR_MS);
    const state = buildState({
      recentFailures: [buildFailure({ failedAt: within })],
    });
    assertEquals(computeTier(state, config), "amber");
  },
);

Deno.test(
  "computeTier: in-flight job overrides green → amber",
  () => {
    const state = buildState({
      inFlightJobs: [buildJob()],
    });
    assertEquals(computeTier(state, buildConfig()), "amber");
  },
);

Deno.test(
  "computeTier: precedence — red beats amber",
  () => {
    // Stale freshness (would be amber) AND daemon stopped (red).
    const config = buildConfig();
    const stale = new Date(
      POLLED_AT.getTime() -
        (config.rollup.freshness.amber_hours + 1) * ONE_HOUR_MS,
    );
    const state = buildState({
      daemon: buildDaemon({ status: "stopped", pid: undefined }),
      collections: [
        buildCollection({ name: "gvault", lastModified: stale }),
      ],
    });
    assertEquals(computeTier(state, config), "red");
  },
);

Deno.test(
  "computeTier: precedence — amber beats green",
  () => {
    // In-flight job (amber) with otherwise healthy state.
    const state = buildState({
      inFlightJobs: [buildJob()],
    });
    assertEquals(computeTier(state, buildConfig()), "amber");
  },
);

Deno.test(
  "computeTier: collections present but lastModified null → no freshness trigger",
  () => {
    // null lastModified is "no signal" — should not push to amber/red.
    const state = buildState({
      collections: [
        buildCollection({ name: "gvault", lastModified: null }),
      ],
    });
    assertEquals(computeTier(state, buildConfig()), "green");
  },
);

Deno.test(
  "computeTier: collections empty but totalCollections > 0 → not grey",
  () => {
    // Edge: collections list empty but status reports collections. Per
    // the grey check (`!collections.length && !totalCollections`), this
    // is NOT grey — it's a degraded read. Falls through to other checks.
    const state = buildState({
      collections: [],
      status: buildStatus({ totalCollections: 2 }),
    });
    // No collections to trigger reachability/coverage/freshness checks
    // and daemon is running; no failures; no in-flight. Result: green.
    assertEquals(computeTier(state, buildConfig()), "green");
  },
);

// ─── computeTierWithReason: drivers ───────────────────────────

Deno.test(
  "computeTierWithReason: empty state → grey with no-collections driver",
  () => {
    const state = buildState({
      collections: [],
      status: buildStatus({ totalCollections: 0, totalDocs: 0 }),
    });
    const result = computeTierWithReason(state, buildConfig());
    assertEquals(result.tier, "grey");
    assertEquals(result.drivers, ["No collections configured"]);
  },
);

Deno.test(
  "computeTierWithReason: healthy state → green with empty drivers",
  () => {
    const result = computeTierWithReason(buildState(), buildConfig());
    assertEquals(result.tier, "green");
    assertEquals(result.drivers, []);
  },
);

Deno.test(
  "computeTierWithReason: daemon stopped surfaces 'Daemon stopped'",
  () => {
    const state = buildState({
      daemon: buildDaemon({ status: "stopped", pid: undefined }),
    });
    const result = computeTierWithReason(state, buildConfig());
    assertEquals(result.tier, "red");
    assert(result.drivers.includes("Daemon stopped"));
  },
);

Deno.test(
  "computeTierWithReason: daemon unresponsive surfaces 'Daemon unresponsive'",
  () => {
    const state = buildState({
      daemon: buildDaemon({ status: "unresponsive" }),
    });
    const result = computeTierWithReason(state, buildConfig());
    assertEquals(result.tier, "red");
    assert(result.drivers.includes("Daemon unresponsive"));
  },
);

Deno.test(
  "computeTierWithReason: unreachable path includes name and path",
  () => {
    const state = buildState({
      collections: [
        buildCollection({
          name: "rackula",
          path: "/Users/test/code/rackula",
          reachable: false,
        }),
      ],
    });
    const result = computeTierWithReason(state, buildConfig());
    assertEquals(result.tier, "red");
    assert(
      result.drivers.some((d) =>
        d.includes("rackula") && d.includes("/Users/test/code/rackula") &&
        d.toLowerCase().includes("unreachable")
      ),
      `expected unreachable driver, got: ${JSON.stringify(result.drivers)}`,
    );
  },
);

Deno.test(
  "computeTierWithReason: in-flight update job → 'Update job in flight'",
  () => {
    const state = buildState({
      inFlightJobs: [buildJob({ action: "update-all" })],
    });
    const result = computeTierWithReason(state, buildConfig());
    assertEquals(result.tier, "amber");
    assert(result.drivers.includes("Update job in flight"));
  },
);

Deno.test(
  "computeTierWithReason: in-flight embed job → 'Embed job in flight'",
  () => {
    const state = buildState({
      inFlightJobs: [buildJob({ action: "embed-all" })],
    });
    const result = computeTierWithReason(state, buildConfig());
    assertEquals(result.tier, "amber");
    assert(result.drivers.includes("Embed job in flight"));
  },
);

Deno.test(
  "computeTierWithReason: coverage driver includes name and percent",
  () => {
    const state = buildState({
      collections: [
        buildCollection({ name: "gvault", coveragePercent: 87 }),
      ],
    });
    const result = computeTierWithReason(state, buildConfig());
    assertEquals(result.tier, "amber");
    assert(
      result.drivers.some((d) =>
        d.includes("gvault") && d.includes("87") && d.includes("95")
      ),
      `expected coverage driver, got: ${JSON.stringify(result.drivers)}`,
    );
  },
);

Deno.test(
  "computeTierWithReason: freshness amber driver includes duration",
  () => {
    const config = buildConfig();
    const stale = new Date(
      POLLED_AT.getTime() -
        (config.rollup.freshness.amber_hours + 1) * ONE_HOUR_MS,
    );
    const state = buildState({
      collections: [
        buildCollection({ name: "rackula", lastModified: stale }),
      ],
    });
    const result = computeTierWithReason(state, config);
    assertEquals(result.tier, "amber");
    assert(
      result.drivers.some((d) =>
        d.includes("rackula") && d.includes("ago") && d.includes("24h")
      ),
      `expected freshness amber driver, got: ${JSON.stringify(result.drivers)}`,
    );
  },
);

Deno.test(
  "computeTierWithReason: freshness red driver uses days threshold",
  () => {
    const config = buildConfig();
    const ancient = new Date(
      POLLED_AT.getTime() -
        (config.rollup.freshness.red_days + 1) * ONE_DAY_MS,
    );
    const state = buildState({
      collections: [
        buildCollection({ name: "gvault", lastModified: ancient }),
      ],
    });
    const result = computeTierWithReason(state, config);
    assertEquals(result.tier, "red");
    assert(
      result.drivers.some((d) =>
        d.includes("gvault") && d.includes("ago") && d.includes("7d")
      ),
      `expected freshness red driver, got: ${JSON.stringify(result.drivers)}`,
    );
  },
);

Deno.test(
  "computeTierWithReason: recent failure driver includes action and ago",
  () => {
    const config = buildConfig();
    // 30m ago — under red_hours=1, so should fire red.
    const state = buildState({
      recentFailures: [
        buildFailure({
          action: "update-all",
          failedAt: new Date(POLLED_AT.getTime() - 30 * 60 * 1000),
        }),
      ],
    });
    const result = computeTierWithReason(state, config);
    assertEquals(result.tier, "red");
    assert(
      result.drivers.some((d) =>
        d.includes("update-all") && d.includes("30m") && d.includes("ago")
      ),
      `expected failure driver, got: ${JSON.stringify(result.drivers)}`,
    );
  },
);

Deno.test(
  "computeTierWithReason: accumulates EVERY triggering condition",
  () => {
    // Daemon stopped (red) + unreachable collection (red) + low coverage
    // (amber) + in-flight job (amber). Result tier=red, drivers ≥ 4.
    const config = buildConfig();
    const state = buildState({
      daemon: buildDaemon({ status: "stopped", pid: undefined }),
      collections: [
        buildCollection({
          name: "gvault",
          coveragePercent: 80, // below amber 95
        }),
        buildCollection({
          name: "rackula",
          path: "/Users/test/code/rackula",
          reachable: false,
        }),
      ],
      inFlightJobs: [buildJob({ action: "update-all" })],
    });
    const result = computeTierWithReason(state, config);
    assertEquals(result.tier, "red");
    assert(result.drivers.includes("Daemon stopped"));
    assert(
      result.drivers.some((d) =>
        d.includes("rackula") && d.includes("unreachable")
      ),
    );
    assert(
      result.drivers.some((d) => d.includes("gvault") && d.includes("80")),
    );
    assert(result.drivers.includes("Update job in flight"));
    assert(result.drivers.length >= 4);
  },
);

Deno.test(
  "computeTierWithReason: failures outside both windows do not fire",
  () => {
    const config = buildConfig();
    // 48h ago — outside amber_hours=24.
    const state = buildState({
      recentFailures: [
        buildFailure({
          failedAt: new Date(POLLED_AT.getTime() - 48 * ONE_HOUR_MS),
        }),
      ],
    });
    const result = computeTierWithReason(state, config);
    assertEquals(result.tier, "green");
    assertEquals(result.drivers, []);
  },
);

Deno.test(
  "computeTierWithReason: null lastModified is skipped (no freshness driver)",
  () => {
    const state = buildState({
      collections: [
        buildCollection({ name: "gvault", lastModified: null }),
      ],
    });
    const result = computeTierWithReason(state, buildConfig());
    assertEquals(result.tier, "green");
    assertEquals(result.drivers, []);
  },
);

Deno.test(
  "computeTierWithReason: all-null lastModified across collections → no-op freshness",
  () => {
    const state = buildState({
      collections: [
        buildCollection({ name: "gvault", lastModified: null }),
        buildCollection({ name: "rackula", lastModified: null }),
      ],
    });
    const result = computeTierWithReason(state, buildConfig());
    assertEquals(result.tier, "green");
    assertEquals(result.drivers, []);
  },
);

Deno.test(
  "computeTierWithReason: daemon job in flight uses 'Daemon' label",
  () => {
    const state = buildState({
      inFlightJobs: [buildJob({ action: "restart-daemon" })],
    });
    const result = computeTierWithReason(state, buildConfig());
    assertEquals(result.tier, "amber");
    assert(result.drivers.includes("Daemon job in flight"));
  },
);

Deno.test(
  "computeTierWithReason: cleanup job in flight uses 'Cleanup' label",
  () => {
    const state = buildState({
      inFlightJobs: [buildJob({ action: "cleanup" })],
    });
    const result = computeTierWithReason(state, buildConfig());
    assertEquals(result.tier, "amber");
    assert(result.drivers.includes("Cleanup job in flight"));
  },
);

Deno.test(
  "computeTierWithReason: recheck job uses 'Recheck' label",
  () => {
    const state = buildState({
      inFlightJobs: [buildJob({ action: "recheck" })],
    });
    const result = computeTierWithReason(state, buildConfig());
    assertEquals(result.tier, "amber");
    assert(result.drivers.includes("Recheck job in flight"));
  },
);

Deno.test(
  "computeTierWithReason: amber-window-only failure surfaces driver",
  () => {
    // 12h ago: outside red_hours=1, inside amber_hours=24.
    const config = buildConfig();
    const state = buildState({
      recentFailures: [
        buildFailure({
          action: "embed-all",
          failedAt: new Date(POLLED_AT.getTime() - 12 * ONE_HOUR_MS),
        }),
      ],
    });
    const result = computeTierWithReason(state, config);
    assertEquals(result.tier, "amber");
    assert(
      result.drivers.some((d) =>
        d.includes("embed-all") && d.includes("12h") && d.includes("ago")
      ),
      `expected amber failure driver, got: ${JSON.stringify(result.drivers)}`,
    );
  },
);

Deno.test(
  "computeTierWithReason: red-coverage driver uses red threshold in text",
  () => {
    const config = buildConfig();
    const state = buildState({
      collections: [
        buildCollection({
          name: "gvault",
          coveragePercent: config.rollup.coverage.red_percent - 5,
        }),
      ],
    });
    const result = computeTierWithReason(state, config);
    assertEquals(result.tier, "red");
    assert(
      result.drivers.some((d) =>
        d.includes("gvault") &&
        d.includes(`${config.rollup.coverage.red_percent}%`) &&
        d.includes(`${config.rollup.coverage.red_percent - 5}%`)
      ),
      `expected red coverage driver, got: ${JSON.stringify(result.drivers)}`,
    );
  },
);

Deno.test(
  "computeTierWithReason: multiple failures in window picks most recent for driver",
  () => {
    const config = buildConfig();
    // Two failures in red window; driver should reflect the most recent.
    const state = buildState({
      recentFailures: [
        buildFailure({
          action: "update-all",
          failedAt: new Date(POLLED_AT.getTime() - 50 * 60 * 1000), // 50m
        }),
        buildFailure({
          action: "embed-all",
          failedAt: new Date(POLLED_AT.getTime() - 10 * 60 * 1000), // 10m
        }),
      ],
    });
    const result = computeTierWithReason(state, config);
    assertEquals(result.tier, "red");
    // Most-recent driver should mention embed-all (newer).
    assert(
      result.drivers.some((d) =>
        d.includes("embed-all") && d.includes("10m") && d.includes("ago")
      ),
      `expected most-recent driver, got: ${JSON.stringify(result.drivers)}`,
    );
  },
);

Deno.test(
  "computeTierWithReason: duplicate in-flight jobs dedupe by label",
  () => {
    // Two update jobs should produce a single "Update job in flight"
    // driver (label dedup).
    const state = buildState({
      inFlightJobs: [
        buildJob({ action: "update-all", pid: 1 }),
        buildJob({ action: "update-collection", pid: 2 }),
      ],
    });
    const result = computeTierWithReason(state, buildConfig());
    assertEquals(result.tier, "amber");
    const updateDrivers = result.drivers.filter((d) =>
      d === "Update job in flight"
    );
    assertEquals(updateDrivers.length, 1);
  },
);

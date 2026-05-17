import { assertEquals, assertNotEquals } from "@std/assert";
import { readCurrentState } from "../lib/state.ts";
import type {
  CollectionState,
  Config,
  DaemonState,
  FailureRecord,
  IndexStatus,
  JobInfo,
} from "../lib/types.ts";
import type { StateSources } from "../lib/state.ts";

// ─── Helpers ───────────────────────────────────────────────────

function makeConfig(): Config {
  return {
    qmd: {
      index_path: "/tmp/swiftbar-qmd-state-test/index.sqlite",
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
      directory: "/tmp/swiftbar-qmd-state-test/logs",
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
    docCount: 10,
    coveragePercent: 100,
    lastModified: new Date("2026-05-01T00:00:00.000Z"),
    hasObsidian: false,
  };
}

function makeStatus(): IndexStatus {
  return {
    totalDocs: 100,
    totalCollections: 2,
    dbSizeBytes: 1024,
    modelCacheBytes: 2048,
  };
}

function makeDaemon(): DaemonState {
  return {
    status: "running",
    pid: 12345,
    uptimeSeconds: 3600,
    endpoint: "http://localhost:8181",
  };
}

function makeJob(): JobInfo {
  return {
    action: "update-all",
    pid: 9999,
    startedAt: new Date("2026-05-17T12:00:00.000Z"),
    command: ["qmd", "update"],
    logPath: "/tmp/log.log",
  };
}

function makeFailure(): FailureRecord {
  return {
    action: "embed-all",
    failedAt: new Date("2026-05-17T11:00:00.000Z"),
    exitCode: 1,
    logPath: "/tmp/embed-fail.log",
  };
}

function makeSources(
  overrides: Partial<StateSources> = {},
): StateSources {
  return {
    readCollections: () => Promise.resolve([makeCollection("default")]),
    readIndexStatus: () => Promise.resolve(makeStatus()),
    probeDaemon: () => Promise.resolve(makeDaemon()),
    readJobPidFiles: () => Promise.resolve([makeJob()]),
    readRecentFailures: () => Promise.resolve([makeFailure()]),
    ...overrides,
  };
}

// ─── Happy path ────────────────────────────────────────────────

Deno.test("readCurrentState: happy path → assembles all five sources", async () => {
  const before = Date.now();
  const result = await readCurrentState(makeConfig(), makeSources());
  const after = Date.now();

  assertEquals(result.collections.length, 1);
  assertEquals(result.collections[0].name, "default");
  assertEquals(result.status.totalDocs, 100);
  assertEquals(result.daemon.status, "running");
  assertEquals(result.inFlightJobs.length, 1);
  assertEquals(result.inFlightJobs[0].action, "update-all");
  assertEquals(result.recentFailures.length, 1);
  assertEquals(result.recentFailures[0].action, "embed-all");

  // polledAt should be a recent Date.
  const polledMs = result.polledAt.getTime();
  if (polledMs < before || polledMs > after) {
    throw new Error(
      `polledAt (${polledMs}) outside expected window [${before}, ${after}]`,
    );
  }
});

// ─── Subroutine failure tolerance ─────────────────────────────

Deno.test("readCurrentState: readCollections throws → collections=[], other fields populated", async () => {
  const result = await readCurrentState(
    makeConfig(),
    makeSources({
      readCollections: () => Promise.reject(new Error("sdk-boom")),
    }),
  );

  assertEquals(result.collections, []);
  assertEquals(result.status.totalDocs, 100);
  assertEquals(result.daemon.status, "running");
  assertEquals(result.inFlightJobs.length, 1);
  assertEquals(result.recentFailures.length, 1);
});

Deno.test("readCurrentState: readIndexStatus throws → status has error, other fields populated", async () => {
  const result = await readCurrentState(
    makeConfig(),
    makeSources({
      readIndexStatus: () => Promise.reject(new Error("status-boom")),
    }),
  );

  // Status fallback shape: zeros + error string.
  assertEquals(result.status.totalDocs, 0);
  assertEquals(result.status.totalCollections, 0);
  assertEquals(result.status.dbSizeBytes, 0);
  assertEquals(result.status.modelCacheBytes, 0);
  assertNotEquals(result.status.error, undefined);

  assertEquals(result.collections.length, 1);
  assertEquals(result.daemon.status, "running");
});

Deno.test("readCurrentState: probeDaemon throws → daemon.status='stopped' with error", async () => {
  const result = await readCurrentState(
    makeConfig(),
    makeSources({
      probeDaemon: () => Promise.reject(new Error("daemon-boom")),
    }),
  );

  assertEquals(result.daemon.status, "stopped");
  assertNotEquals(result.daemon.error, undefined);
  assertEquals(result.daemon.endpoint, "http://localhost:8181");

  assertEquals(result.collections.length, 1);
  assertEquals(result.status.totalDocs, 100);
});

Deno.test("readCurrentState: readJobPidFiles throws → inFlightJobs=[], other fields populated", async () => {
  const result = await readCurrentState(
    makeConfig(),
    makeSources({
      readJobPidFiles: () => Promise.reject(new Error("jobs-boom")),
    }),
  );

  assertEquals(result.inFlightJobs, []);
  assertEquals(result.collections.length, 1);
  assertEquals(result.recentFailures.length, 1);
});

Deno.test("readCurrentState: readRecentFailures throws → recentFailures=[], other fields populated", async () => {
  const result = await readCurrentState(
    makeConfig(),
    makeSources({
      readRecentFailures: () => Promise.reject(new Error("failures-boom")),
    }),
  );

  assertEquals(result.recentFailures, []);
  assertEquals(result.collections.length, 1);
  assertEquals(result.inFlightJobs.length, 1);
});

// ─── Catastrophic: all five throw ─────────────────────────────

Deno.test("readCurrentState: all five sources throw → returns defensible default, does NOT throw", async () => {
  const result = await readCurrentState(
    makeConfig(),
    makeSources({
      readCollections: () => Promise.reject(new Error("a")),
      readIndexStatus: () => Promise.reject(new Error("b")),
      probeDaemon: () => Promise.reject(new Error("c")),
      readJobPidFiles: () => Promise.reject(new Error("d")),
      readRecentFailures: () => Promise.reject(new Error("e")),
    }),
  );

  // Each field has its fallback shape; readCurrentState itself returned
  // without throwing.
  assertEquals(result.collections, []);
  assertEquals(result.status.totalDocs, 0);
  assertNotEquals(result.status.error, undefined);
  assertEquals(result.daemon.status, "stopped");
  assertNotEquals(result.daemon.error, undefined);
  assertEquals(result.inFlightJobs, []);
  assertEquals(result.recentFailures, []);
});

// ─── Partial DI: undefined sources fall back to production ────

Deno.test("readCurrentState: empty sources object falls back to production probes", async () => {
  // With no sources injected and qmd absent from /tmp, production
  // probes will fail or return empty results — but readCurrentState
  // must still resolve to a CurrentState (never throw).
  const result = await readCurrentState(makeConfig(), {});

  // Shape assertions only: production probes will likely set fallback
  // values, but the contract is non-throw + well-shaped output.
  assertEquals(Array.isArray(result.collections), true);
  assertEquals(typeof result.status.totalDocs, "number");
  assertEquals(typeof result.daemon.status, "string");
  assertEquals(Array.isArray(result.inFlightJobs), true);
  assertEquals(Array.isArray(result.recentFailures), true);
  assertEquals(result.polledAt instanceof Date, true);
});

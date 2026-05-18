import { assertEquals, assertNotEquals } from "@std/assert";
import {
  readCurrentState,
  readCurrentStateWithSnapshot,
} from "../lib/state.ts";
import type {
  ActionId,
  CollectionState,
  Config,
  DaemonState,
  FailureRecord,
  IndexStatus,
  JobInfo,
  PollSnapshot,
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
    // Default to an empty log listing; tests that exercise recentLogs
    // override this with deterministic LogFileInfo entries.
    readLogs: () => Promise.resolve([]),
    // The mocked job in `makeJob()` has pid=9999 (unlikely to be live).
    // Tests that don't override `isProcessAlive` need it to claim alive
    // so the completion loop doesn't try to clean up a fictional job
    // and disturb the assertions in older happy-path tests.
    isProcessAlive: (_pid: number) => true,
    readExitCodeFromLog: (_path: string) => Promise.resolve(0),
    appendFailure: (_f) => Promise.resolve(),
    deleteJobPidFile: (_action, _collection) => Promise.resolve(),
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

// ─── Completion detection (SPEC §13.4, §13.5) ─────────────────

Deno.test("readCurrentState: dead PID with non-zero exit → appendFailure + delete + removed from inFlightJobs", async () => {
  const job: JobInfo = {
    action: "update-all" as ActionId,
    pid: 99999,
    startedAt: new Date("2026-05-17T11:50:00.000Z"),
    command: ["qmd", "update"],
    logPath: "/tmp/log.log",
  };

  const appendCalls: FailureRecord[] = [];
  const deleteCalls: Array<{ action: ActionId; collection?: string }> = [];

  const result = await readCurrentState(
    makeConfig(),
    makeSources({
      readJobPidFiles: () => Promise.resolve([job]),
      isProcessAlive: (_pid: number) => false,
      readExitCodeFromLog: (_path: string) => Promise.resolve(1),
      appendFailure: (f: FailureRecord) => {
        appendCalls.push(f);
        return Promise.resolve();
      },
      deleteJobPidFile: (action: ActionId, collection?: string) => {
        deleteCalls.push({ action, collection });
        return Promise.resolve();
      },
    }),
  );

  assertEquals(result.inFlightJobs, []);
  assertEquals(appendCalls.length, 1);
  assertEquals(appendCalls[0].action, "update-all");
  assertEquals(appendCalls[0].exitCode, 1);
  assertEquals(appendCalls[0].logPath, "/tmp/log.log");
  assertEquals(deleteCalls.length, 1);
  assertEquals(deleteCalls[0].action, "update-all");
});

Deno.test("readCurrentState: dead PID with exit 0 → delete + removed but NO appendFailure", async () => {
  const job: JobInfo = {
    action: "embed-collection" as ActionId,
    collection: "gVault",
    pid: 88888,
    startedAt: new Date("2026-05-17T11:50:00.000Z"),
    command: ["qmd", "embed", "-c", "gVault"],
    logPath: "/tmp/embed.log",
  };

  const appendCalls: FailureRecord[] = [];
  const deleteCalls: Array<{ action: ActionId; collection?: string }> = [];

  const result = await readCurrentState(
    makeConfig(),
    makeSources({
      readJobPidFiles: () => Promise.resolve([job]),
      isProcessAlive: (_pid: number) => false,
      readExitCodeFromLog: (_path: string) => Promise.resolve(0),
      appendFailure: (f: FailureRecord) => {
        appendCalls.push(f);
        return Promise.resolve();
      },
      deleteJobPidFile: (action: ActionId, collection?: string) => {
        deleteCalls.push({ action, collection });
        return Promise.resolve();
      },
    }),
  );

  assertEquals(result.inFlightJobs, []);
  assertEquals(appendCalls.length, 0);
  assertEquals(deleteCalls.length, 1);
  assertEquals(deleteCalls[0].action, "embed-collection");
  assertEquals(deleteCalls[0].collection, "gVault");
});

Deno.test("readCurrentState: alive PID → job stays in inFlightJobs, no cleanup", async () => {
  const job: JobInfo = {
    action: "update-all" as ActionId,
    pid: 77777,
    startedAt: new Date("2026-05-17T11:50:00.000Z"),
    command: ["qmd", "update"],
    logPath: "/tmp/log.log",
  };

  const appendCalls: FailureRecord[] = [];
  const deleteCalls: Array<{ action: ActionId; collection?: string }> = [];

  const result = await readCurrentState(
    makeConfig(),
    makeSources({
      readJobPidFiles: () => Promise.resolve([job]),
      isProcessAlive: (_pid: number) => true,
      readExitCodeFromLog: () => {
        throw new Error(
          "readExitCodeFromLog should not be called for live jobs",
        );
      },
      appendFailure: (f: FailureRecord) => {
        appendCalls.push(f);
        return Promise.resolve();
      },
      deleteJobPidFile: (action: ActionId, collection?: string) => {
        deleteCalls.push({ action, collection });
        return Promise.resolve();
      },
    }),
  );

  assertEquals(result.inFlightJobs.length, 1);
  assertEquals(result.inFlightJobs[0].action, "update-all");
  assertEquals(appendCalls.length, 0);
  assertEquals(deleteCalls.length, 0);
});

Deno.test("readCurrentState: dead PID with missing EXIT_CODE → exitCode -1 → appendFailure called", async () => {
  // SPEC §13.4: if no EXIT_CODE marker found, abnormal termination ⇒ -1.
  const job: JobInfo = {
    action: "update-all" as ActionId,
    pid: 66666,
    startedAt: new Date("2026-05-17T11:50:00.000Z"),
    command: ["qmd", "update"],
    logPath: "/tmp/missing.log",
  };

  const appendCalls: FailureRecord[] = [];

  const result = await readCurrentState(
    makeConfig(),
    makeSources({
      readJobPidFiles: () => Promise.resolve([job]),
      isProcessAlive: (_pid: number) => false,
      readExitCodeFromLog: (_path: string) => Promise.resolve(-1),
      appendFailure: (f: FailureRecord) => {
        appendCalls.push(f);
        return Promise.resolve();
      },
      deleteJobPidFile: () => Promise.resolve(),
    }),
  );

  assertEquals(result.inFlightJobs, []);
  assertEquals(appendCalls.length, 1);
  assertEquals(appendCalls[0].exitCode, -1);
});

Deno.test("readCurrentState: mixed alive/dead jobs are partitioned correctly", async () => {
  const liveJob: JobInfo = {
    action: "update-all" as ActionId,
    pid: 1111,
    startedAt: new Date("2026-05-17T11:50:00.000Z"),
    command: ["qmd", "update"],
    logPath: "/tmp/live.log",
  };
  const deadJob: JobInfo = {
    action: "embed-all" as ActionId,
    pid: 2222,
    startedAt: new Date("2026-05-17T11:55:00.000Z"),
    command: ["qmd", "embed"],
    logPath: "/tmp/dead.log",
  };

  const appendCalls: FailureRecord[] = [];
  const deleteCalls: Array<{ action: ActionId; collection?: string }> = [];

  const result = await readCurrentState(
    makeConfig(),
    makeSources({
      readJobPidFiles: () => Promise.resolve([liveJob, deadJob]),
      isProcessAlive: (pid: number) => pid === 1111,
      readExitCodeFromLog: (path: string) => {
        if (path === "/tmp/dead.log") return Promise.resolve(2);
        throw new Error(`unexpected log path: ${path}`);
      },
      appendFailure: (f: FailureRecord) => {
        appendCalls.push(f);
        return Promise.resolve();
      },
      deleteJobPidFile: (action: ActionId, collection?: string) => {
        deleteCalls.push({ action, collection });
        return Promise.resolve();
      },
    }),
  );

  assertEquals(result.inFlightJobs.length, 1);
  assertEquals(result.inFlightJobs[0].action, "update-all");
  assertEquals(appendCalls.length, 1);
  assertEquals(appendCalls[0].action, "embed-all");
  assertEquals(appendCalls[0].exitCode, 2);
  assertEquals(deleteCalls.length, 1);
  assertEquals(deleteCalls[0].action, "embed-all");
});

// ─── readCurrentStateWithSnapshot (SPEC §16.2) ────────────────
//
// The snapshot-aware wrapper tracks consecutive read failures across
// polls and synthesizes a "last good" CurrentState from the previous
// snapshot when the current read failed. The forced-red escalation at
// 3 failures is the caller's responsibility (qmd.30s.ts) — these tests
// only verify the counter climbs / resets correctly.

function makePrevSnapshot(
  consecutiveReadFailures: number,
  collections?: CollectionState[],
): PollSnapshot {
  return {
    pollTimestamp: "2026-05-17T11:00:00.000Z",
    daemon: {
      status: "running",
      pid: 1234,
      uptimeSeconds: 3600,
      endpoint: "http://localhost:8181",
    },
    collections: collections ?? [makeCollection("default")],
    recentOpFailures: [],
    inFlightJobs: [],
    computedTier: "green",
    tierDrivers: [],
    recentlyNotified: {},
    consecutiveReadFailures,
  };
}

Deno.test("readCurrentStateWithSnapshot: prev=null + readCollections throws → counter=1, degraded", async () => {
  const result = await readCurrentStateWithSnapshot(
    makeConfig(),
    null,
    makeSources({
      readCollections: () => Promise.reject(new Error("sdk-boom")),
      readIndexStatus: () => Promise.reject(new Error("status-boom")),
    }),
  );

  assertEquals(result.consecutiveReadFailures, 1);
  assertEquals(result.degraded, true);
  // With no prev to synthesize from, we keep the partial current state.
  assertEquals(result.state.collections, []);
});

Deno.test("readCurrentStateWithSnapshot: prev=1 + read fails → counter=2, degraded with prev state", async () => {
  const prev = makePrevSnapshot(1, [makeCollection("gVault")]);
  const result = await readCurrentStateWithSnapshot(
    makeConfig(),
    prev,
    makeSources({
      readCollections: () => Promise.reject(new Error("sdk-boom")),
      readIndexStatus: () => Promise.reject(new Error("status-boom")),
    }),
  );

  assertEquals(result.consecutiveReadFailures, 2);
  assertEquals(result.degraded, true);
  // Synthesized last-good state pulls collections from prev.
  assertEquals(result.state.collections.length, 1);
  assertEquals(result.state.collections[0].name, "gVault");
  // status.error should be set so the menu renders the degradation header.
  assertNotEquals(result.state.status.error, undefined);
});

Deno.test("readCurrentStateWithSnapshot: prev=2 + read fails → counter=3 (caller forces red)", async () => {
  const prev = makePrevSnapshot(2);
  const result = await readCurrentStateWithSnapshot(
    makeConfig(),
    prev,
    makeSources({
      readCollections: () => Promise.reject(new Error("a")),
      readIndexStatus: () => Promise.reject(new Error("b")),
      probeDaemon: () => Promise.reject(new Error("c")),
    }),
  );

  assertEquals(result.consecutiveReadFailures, 3);
  assertEquals(result.degraded, true);
});

Deno.test("readCurrentStateWithSnapshot: prev=3 + success → counter resets to 0, not degraded", async () => {
  const prev = makePrevSnapshot(3);
  const result = await readCurrentStateWithSnapshot(
    makeConfig(),
    prev,
    makeSources(),
  );

  assertEquals(result.consecutiveReadFailures, 0);
  assertEquals(result.degraded, false);
  assertEquals(result.state.collections.length, 1);
  assertEquals(result.state.collections[0].name, "default");
});

Deno.test("readCurrentStateWithSnapshot: synthesized state preserves prev daemon + inFlightJobs", async () => {
  const liveJob: JobInfo = {
    action: "update-all" as ActionId,
    pid: 4242,
    startedAt: new Date("2026-05-17T11:50:00.000Z"),
    command: ["qmd", "update"],
    logPath: "/tmp/inflight.log",
  };
  const prev: PollSnapshot = {
    pollTimestamp: "2026-05-17T11:00:00.000Z",
    daemon: {
      status: "running",
      pid: 9876,
      uptimeSeconds: 7200,
      endpoint: "http://localhost:8181",
    },
    collections: [makeCollection("alpha")],
    recentOpFailures: [makeFailure()],
    inFlightJobs: [liveJob],
    computedTier: "amber",
    tierDrivers: ["something"],
    recentlyNotified: {},
    consecutiveReadFailures: 0,
  };

  const result = await readCurrentStateWithSnapshot(
    makeConfig(),
    prev,
    makeSources({
      readCollections: () => Promise.reject(new Error("read-fail")),
      readIndexStatus: () => Promise.reject(new Error("status-fail")),
    }),
  );

  assertEquals(result.degraded, true);
  assertEquals(result.consecutiveReadFailures, 1);
  // Synthesized state pulls daemon, inFlightJobs, recentFailures from prev.
  assertEquals(result.state.daemon.status, "running");
  assertEquals(result.state.daemon.pid, 9876);
  assertEquals(result.state.inFlightJobs.length, 1);
  assertEquals(result.state.inFlightJobs[0].pid, 4242);
  assertEquals(result.state.recentFailures.length, 1);
});

Deno.test("readCurrentStateWithSnapshot: collections with per-row error increments counter", async () => {
  // Per SPEC §16.1 sdk:open and per-row errors all increment the
  // consecutive-failures counter. A populated-but-erroring collection
  // is treated as a failed read.
  const erroringCollection: CollectionState = {
    ...makeCollection("default"),
    error: "stat failed",
  };

  const result = await readCurrentStateWithSnapshot(
    makeConfig(),
    makePrevSnapshot(0),
    makeSources({
      readCollections: () => Promise.resolve([erroringCollection]),
    }),
  );

  assertEquals(result.consecutiveReadFailures, 1);
  assertEquals(result.degraded, true);
});

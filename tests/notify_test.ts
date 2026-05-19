import { assertEquals } from "@std/assert";
import {
  buildSnapshot,
  diffStates,
  emitNotifications,
  type NotifyDeps,
} from "../lib/notify.ts";
import type {
  CollectionState,
  Config,
  CurrentState,
  DaemonState,
  FailureRecord,
  IndexStatus,
  JobInfo,
  PollSnapshot,
  TierReason,
} from "../lib/types.ts";

// ─── Fixture builders ──────────────────────────────────────────

function makeConfig(overrides: Partial<Config["notifications"]> = {}): Config {
  return {
    qmd: {
      index_path: "/tmp/index.sqlite",
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
      ...overrides,
    },
    ui: {
      collection_meta: "freshness",
      hide_obsidian_when_absent: true,
    },
    logs: {
      directory: "/tmp/logs",
      retain_per_action: 10,
    },
  };
}

function makeDaemon(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    status: "running",
    pid: 4321,
    uptimeSeconds: 3600,
    endpoint: "http://localhost:8181",
    ...overrides,
  };
}

function makeCollection(
  name: string,
  overrides: Partial<CollectionState> = {},
): CollectionState {
  return {
    name,
    path: `/tmp/${name}`,
    qmdUri: `qmd://${name}/`,
    pattern: "**/*.md",
    reachable: true,
    docCount: 100,
    coveragePercent: 100,
    lastModified: new Date("2026-05-17T00:00:00.000Z"),
    hasObsidian: false,
    ...overrides,
  };
}

function makeStatus(): IndexStatus {
  return {
    totalDocs: 100,
    totalCollections: 1,
    dbSizeBytes: 1024,
    modelCacheBytes: 2048,
  };
}

function makeJob(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    action: "update-all",
    pid: 9999,
    startedAt: new Date("2026-05-17T12:00:00.000Z"),
    command: ["qmd", "update"],
    logPath: "/tmp/logs/update-all-20260517T120000.log",
    ...overrides,
  };
}

function makeFailure(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    action: "update-all",
    failedAt: new Date("2026-05-17T12:05:00.000Z"),
    exitCode: 1,
    logPath: "/tmp/logs/update-all-20260517T120000.log",
    ...overrides,
  };
}

function makeCurrent(overrides: Partial<CurrentState> = {}): CurrentState {
  return {
    collections: [makeCollection("Rackula")],
    status: makeStatus(),
    daemon: makeDaemon(),
    inFlightJobs: [],
    recentFailures: [],
    recentLogs: [],
    polledAt: new Date("2026-05-17T12:34:56.000Z"),
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<PollSnapshot> = {}): PollSnapshot {
  return {
    pollTimestamp: "2026-05-17T12:34:00.000Z",
    daemon: makeDaemon(),
    collections: [makeCollection("Rackula")],
    recentOpFailures: [],
    inFlightJobs: [],
    computedTier: "green",
    tierDrivers: [],
    recentlyNotified: {},
    consecutiveReadFailures: 0,
    ...overrides,
  };
}

function makeTier(): TierReason {
  return { tier: "green", drivers: [] };
}

// ─── Recorder for emitNotifications ────────────────────────────

type FireCall = { title: string; subtitle: string; body: string };

function makeRecorder() {
  const calls: FireCall[] = [];
  const deps: NotifyDeps = {
    fireNotification: (title, subtitle, body) => {
      calls.push({ title, subtitle, body });
      return Promise.resolve();
    },
    now: () => new Date("2026-05-17T12:34:56.000Z"),
  };
  return { calls, deps };
}

// ─── diffStates: no prev snapshot ──────────────────────────────

Deno.test("diffStates: no prev snapshot returns []", () => {
  const events = diffStates(null, makeCurrent());
  assertEquals(events, []);
});

// ─── diffStates: identical prev/current ────────────────────────

Deno.test("diffStates: identical prev/current returns []", () => {
  const prev = makeSnapshot();
  const current = makeCurrent();
  const events = diffStates(prev, current);
  assertEquals(events, []);
});

// ─── diffStates: daemon-crash ──────────────────────────────────

Deno.test("diffStates: daemon running -> stopped emits daemon-crash", () => {
  const prev = makeSnapshot({
    daemon: makeDaemon({ status: "running", uptimeSeconds: 21840 }),
  });
  const current = makeCurrent({
    daemon: makeDaemon({ status: "stopped" }),
  });
  const events = diffStates(prev, current);
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "daemon-crash");
  if (events[0].kind === "daemon-crash") {
    assertEquals(events[0].previousUptime, 21840);
  }
});

Deno.test("diffStates: daemon running -> unresponsive emits daemon-crash", () => {
  const prev = makeSnapshot({
    daemon: makeDaemon({ status: "running", uptimeSeconds: 100 }),
  });
  const current = makeCurrent({
    daemon: makeDaemon({ status: "unresponsive" }),
  });
  const events = diffStates(prev, current);
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "daemon-crash");
});

Deno.test("diffStates: daemon stopped -> stopped does NOT re-emit", () => {
  const prev = makeSnapshot({
    daemon: makeDaemon({ status: "stopped" }),
  });
  const current = makeCurrent({
    daemon: makeDaemon({ status: "stopped" }),
  });
  const events = diffStates(prev, current);
  assertEquals(events, []);
});

// ─── diffStates: path-unreachable ──────────────────────────────

Deno.test("diffStates: collection reachable -> unreachable emits path-unreachable", () => {
  const prev = makeSnapshot({
    collections: [makeCollection("Rackula", { reachable: true })],
  });
  const current = makeCurrent({
    collections: [
      makeCollection("Rackula", { reachable: false, path: "/tmp/Rackula" }),
    ],
  });
  const events = diffStates(prev, current);
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "path-unreachable");
  if (events[0].kind === "path-unreachable") {
    assertEquals(events[0].collection, "Rackula");
    assertEquals(events[0].path, "/tmp/Rackula");
  }
});

Deno.test("diffStates: collection already unreachable does NOT re-emit", () => {
  const prev = makeSnapshot({
    collections: [makeCollection("Rackula", { reachable: false })],
  });
  const current = makeCurrent({
    collections: [makeCollection("Rackula", { reachable: false })],
  });
  const events = diffStates(prev, current);
  assertEquals(events, []);
});

// ─── diffStates: op-failure ────────────────────────────────────

Deno.test("diffStates: in-flight job -> exited nonzero emits op-failure", () => {
  const job = makeJob({ action: "update-all" });
  const failure = makeFailure({
    action: "update-all",
    exitCode: 1,
    logPath: job.logPath,
  });
  const prev = makeSnapshot({ inFlightJobs: [job] });
  const current = makeCurrent({
    inFlightJobs: [],
    recentFailures: [failure],
  });
  const events = diffStates(prev, current);
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "op-failure");
  if (events[0].kind === "op-failure") {
    assertEquals(events[0].action, "update-all");
    assertEquals(events[0].exitCode, 1);
    assertEquals(events[0].logPath, job.logPath);
  }
});

Deno.test("diffStates: op-failure with collection carries collection through", () => {
  const job = makeJob({
    action: "embed-collection",
    collection: "Rackula",
    logPath: "/tmp/logs/embed-collection:Rackula-20260517T120000.log",
  });
  const failure = makeFailure({
    action: "embed-collection",
    collection: "Rackula",
    exitCode: 2,
    logPath: job.logPath,
  });
  const prev = makeSnapshot({ inFlightJobs: [job] });
  const current = makeCurrent({
    inFlightJobs: [],
    recentFailures: [failure],
  });
  const events = diffStates(prev, current);
  assertEquals(events.length, 1);
  if (events[0].kind === "op-failure") {
    assertEquals(events[0].action, "embed-collection");
    assertEquals(events[0].collection, "Rackula");
    assertEquals(events[0].exitCode, 2);
  }
});

Deno.test("diffStates: op-failure does NOT emit if failure was already in prev", () => {
  const job = makeJob({ action: "update-all" });
  const failure = makeFailure({
    action: "update-all",
    exitCode: 1,
    logPath: job.logPath,
  });
  // The prev snapshot already carried the failure (we notified last poll).
  const prev = makeSnapshot({
    inFlightJobs: [],
    recentOpFailures: [failure],
  });
  const current = makeCurrent({
    inFlightJobs: [],
    recentFailures: [failure],
  });
  const events = diffStates(prev, current);
  assertEquals(events, []);
});

// ─── diffStates: job-complete ──────────────────────────────────

Deno.test("diffStates: in-flight -> gone with no failure emits job-complete", () => {
  const job = makeJob({
    action: "embed-all",
    startedAt: new Date("2026-05-17T12:00:00.000Z"),
  });
  const prev = makeSnapshot({ inFlightJobs: [job] });
  const current = makeCurrent({
    inFlightJobs: [],
    recentFailures: [],
    polledAt: new Date("2026-05-17T12:05:00.000Z"),
  });
  const events = diffStates(prev, current);
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "job-complete");
  if (events[0].kind === "job-complete") {
    assertEquals(events[0].action, "embed-all");
    assertEquals(events[0].durationMs, 5 * 60 * 1000);
  }
});

Deno.test("diffStates: still in-flight does NOT emit job-complete", () => {
  const job = makeJob();
  const prev = makeSnapshot({ inFlightJobs: [job] });
  const current = makeCurrent({ inFlightJobs: [job] });
  const events = diffStates(prev, current);
  assertEquals(events, []);
});

// ─── diffStates: threshold-breach ──────────────────────────────

Deno.test("diffStates: coverage above amber -> below amber emits threshold-breach", () => {
  const prev = makeSnapshot({
    collections: [makeCollection("Rackula", { coveragePercent: 100 })],
  });
  const current = makeCurrent({
    collections: [makeCollection("Rackula", { coveragePercent: 80 })],
  });
  const config = makeConfig({ on_threshold_breach: true });
  const events = diffStates(prev, current, config);
  const thresholdEvents = events.filter((e) => e.kind === "threshold-breach");
  assertEquals(thresholdEvents.length, 1);
  if (thresholdEvents[0].kind === "threshold-breach") {
    assertEquals(thresholdEvents[0].metric, "coverage");
    assertEquals(thresholdEvents[0].collection, "Rackula");
  }
});

Deno.test("diffStates: freshness within amber -> past amber emits threshold-breach", () => {
  // amber_hours = 24. prev lastModified 1 hour ago, current 25 hours ago.
  const polledAt = new Date("2026-05-17T12:00:00.000Z");
  const prevPolledAt = new Date("2026-05-17T11:30:00.000Z");
  const oneHourAgo = new Date(prevPolledAt.getTime() - 60 * 60 * 1000);
  const twentyFiveHoursAgo = new Date(polledAt.getTime() - 25 * 60 * 60 * 1000);
  const prev = makeSnapshot({
    pollTimestamp: prevPolledAt.toISOString(),
    collections: [makeCollection("Rackula", { lastModified: oneHourAgo })],
  });
  const current = makeCurrent({
    polledAt,
    collections: [
      makeCollection("Rackula", { lastModified: twentyFiveHoursAgo }),
    ],
  });
  const events = diffStates(prev, current, makeConfig());
  const thresholdEvents = events.filter((e) => e.kind === "threshold-breach");
  assertEquals(thresholdEvents.length, 1);
  if (thresholdEvents[0].kind === "threshold-breach") {
    assertEquals(thresholdEvents[0].metric, "freshness");
    assertEquals(thresholdEvents[0].collection, "Rackula");
  }
});

// ─── emitNotifications: opt-out filtering ──────────────────────

Deno.test("emitNotifications: in-flight -> exited zero with on_job_completion=false fires NO notification", async () => {
  const rec = makeRecorder();
  const config = makeConfig({ on_job_completion: false });
  const snapshot = makeSnapshot();
  const events = [
    {
      kind: "job-complete" as const,
      action: "embed-all" as const,
      durationMs: 5 * 60 * 1000,
    },
  ];
  await emitNotifications(events, snapshot, config, rec.deps);
  assertEquals(rec.calls.length, 0);
});

Deno.test("emitNotifications: in-flight -> exited zero with on_job_completion=true fires notification", async () => {
  const rec = makeRecorder();
  const config = makeConfig({ on_job_completion: true });
  const snapshot = makeSnapshot();
  const events = [
    {
      kind: "job-complete" as const,
      action: "embed-all" as const,
      durationMs: 5 * 60 * 1000,
    },
  ];
  await emitNotifications(events, snapshot, config, rec.deps);
  assertEquals(rec.calls.length, 1);
  assertEquals(rec.calls[0].title, "qmd embed completed");
  assertEquals(rec.calls[0].subtitle, "all collections");
  assertEquals(rec.calls[0].body, "5m elapsed.");
});

Deno.test("emitNotifications: daemon-crash disabled -> no fire", async () => {
  const rec = makeRecorder();
  const config = makeConfig({ on_daemon_crash: false });
  const snapshot = makeSnapshot();
  const events = [
    { kind: "daemon-crash" as const, previousUptime: 21840 },
  ];
  await emitNotifications(events, snapshot, config, rec.deps);
  assertEquals(rec.calls.length, 0);
});

// ─── emitNotifications: dedupe ─────────────────────────────────

Deno.test("emitNotifications: same dedupe key within 5 min is suppressed", async () => {
  const rec = makeRecorder();
  const config = makeConfig();
  // Mark daemon-crash as already-fired 2 minutes ago.
  const snapshot = makeSnapshot({
    recentlyNotified: {
      "daemon-crash": "2026-05-17T12:32:56.000Z",
    },
  });
  const events = [
    { kind: "daemon-crash" as const, previousUptime: 21840 },
  ];
  await emitNotifications(events, snapshot, config, rec.deps);
  assertEquals(rec.calls.length, 0);
});

Deno.test("emitNotifications: same dedupe key after 5 min fires again", async () => {
  const rec = makeRecorder();
  const config = makeConfig();
  // Mark daemon-crash as fired 6 minutes ago.
  const snapshot = makeSnapshot({
    recentlyNotified: {
      "daemon-crash": "2026-05-17T12:28:56.000Z",
    },
  });
  const events = [
    { kind: "daemon-crash" as const, previousUptime: 21840 },
  ];
  await emitNotifications(events, snapshot, config, rec.deps);
  assertEquals(rec.calls.length, 1);
});

Deno.test("emitNotifications: snapshot.recentlyNotified is updated with fired key", async () => {
  const rec = makeRecorder();
  const config = makeConfig();
  const snapshot = makeSnapshot();
  const events = [
    { kind: "daemon-crash" as const, previousUptime: 21840 },
  ];
  await emitNotifications(events, snapshot, config, rec.deps);
  assertEquals(
    snapshot.recentlyNotified["daemon-crash"],
    "2026-05-17T12:34:56.000Z",
  );
});

Deno.test("emitNotifications: prunes recentlyNotified entries older than 5 min", async () => {
  const rec = makeRecorder();
  const config = makeConfig();
  const snapshot = makeSnapshot({
    recentlyNotified: {
      "old-entry": "2026-05-17T12:00:00.000Z", // 34 min old
      "recent-entry": "2026-05-17T12:33:00.000Z", // < 5 min
    },
  });
  await emitNotifications([], snapshot, config, rec.deps);
  assertEquals(snapshot.recentlyNotified["old-entry"], undefined);
  assertEquals(
    snapshot.recentlyNotified["recent-entry"],
    "2026-05-17T12:33:00.000Z",
  );
});

// ─── emitNotifications: rate limiting ──────────────────────────

Deno.test("emitNotifications: 5 events with cap 3 fires 3 + 1 'more' fallback", async () => {
  const rec = makeRecorder();
  const config = makeConfig({
    on_daemon_crash: true,
    on_op_failure: true,
    on_path_unreachable: true,
  });
  const snapshot = makeSnapshot();
  const events = [
    { kind: "daemon-crash" as const, previousUptime: 100 },
    {
      kind: "path-unreachable" as const,
      collection: "A",
      path: "/tmp/A",
    },
    {
      kind: "path-unreachable" as const,
      collection: "B",
      path: "/tmp/B",
    },
    {
      kind: "path-unreachable" as const,
      collection: "C",
      path: "/tmp/C",
    },
    {
      kind: "path-unreachable" as const,
      collection: "D",
      path: "/tmp/D",
    },
  ];
  await emitNotifications(events, snapshot, config, rec.deps);
  // 3 real notifications + 1 "more" fallback = 4 calls total.
  assertEquals(rec.calls.length, 4);
  const fallback = rec.calls[3];
  assertEquals(fallback.title, "qmd-swiftbar");
  assertEquals(fallback.subtitle, "(2 additional events suppressed)");
  assertEquals(fallback.body, "+ 2 more — see menu");

  // Suppressed events still get recorded in recentlyNotified so they
  // don't fire on the next poll.
  assertEquals(
    snapshot.recentlyNotified["path-unreachable:C"],
    "2026-05-17T12:34:56.000Z",
  );
  assertEquals(
    snapshot.recentlyNotified["path-unreachable:D"],
    "2026-05-17T12:34:56.000Z",
  );
});

// ─── Copy: verify per-event title/subtitle/body ────────────────

Deno.test("emitNotifications: daemon-crash copy matches SPEC §14.3", async () => {
  const rec = makeRecorder();
  const config = makeConfig();
  const snapshot = makeSnapshot();
  const events = [
    { kind: "daemon-crash" as const, previousUptime: 21840 }, // 6h 4m
  ];
  await emitNotifications(events, snapshot, config, rec.deps);
  assertEquals(rec.calls.length, 1);
  assertEquals(rec.calls[0].title, "qmd daemon stopped");
  assertEquals(rec.calls[0].subtitle, "After 6h 4m uptime");
  assertEquals(rec.calls[0].body, "Click the menubar icon to restart.");
});

Deno.test("emitNotifications: op-failure copy maps action verb", async () => {
  const rec = makeRecorder();
  const config = makeConfig();
  const snapshot = makeSnapshot();
  const events = [
    {
      kind: "op-failure" as const,
      action: "embed-collection" as const,
      collection: "Rackula",
      exitCode: 2,
      logPath: "/tmp/log",
    },
  ];
  await emitNotifications(events, snapshot, config, rec.deps);
  assertEquals(rec.calls.length, 1);
  assertEquals(rec.calls[0].title, "qmd embed failed");
  assertEquals(rec.calls[0].subtitle, "Rackula");
  assertEquals(
    rec.calls[0].body,
    'Exit code 2. Click "Show last output" for details.',
  );
});

Deno.test("emitNotifications: path-unreachable copy", async () => {
  const rec = makeRecorder();
  const config = makeConfig();
  const snapshot = makeSnapshot();
  const events = [
    {
      kind: "path-unreachable" as const,
      collection: "Rackula",
      path: "/tmp/Rackula",
    },
  ];
  await emitNotifications(events, snapshot, config, rec.deps);
  assertEquals(rec.calls.length, 1);
  assertEquals(rec.calls[0].title, "Collection path missing");
  assertEquals(rec.calls[0].subtitle, "Rackula");
  assertEquals(
    rec.calls[0].body,
    "The path /tmp/Rackula is no longer readable.",
  );
});

Deno.test("emitNotifications: threshold-breach coverage copy", async () => {
  const rec = makeRecorder();
  const config = makeConfig({ on_threshold_breach: true });
  const snapshot = makeSnapshot({
    collections: [makeCollection("Rackula", { coveragePercent: 80 })],
  });
  const events = [
    {
      kind: "threshold-breach" as const,
      metric: "coverage" as const,
      collection: "Rackula",
    },
  ];
  await emitNotifications(events, snapshot, config, rec.deps);
  assertEquals(rec.calls.length, 1);
  assertEquals(rec.calls[0].title, "Embedding coverage low");
  assertEquals(rec.calls[0].subtitle, "Rackula");
  assertEquals(rec.calls[0].body, "At 80% coverage.");
});

// ─── buildSnapshot helper ──────────────────────────────────────

Deno.test("buildSnapshot: composes PollSnapshot from CurrentState + TierReason", () => {
  const state = makeCurrent({
    inFlightJobs: [makeJob()],
    recentFailures: [makeFailure()],
  });
  const tier: TierReason = { tier: "amber", drivers: ["Update job in flight"] };
  const snap = buildSnapshot(state, tier, null);
  assertEquals(snap.pollTimestamp, state.polledAt.toISOString());
  assertEquals(snap.daemon, state.daemon);
  assertEquals(snap.collections, state.collections);
  assertEquals(snap.recentOpFailures, state.recentFailures);
  assertEquals(snap.inFlightJobs, state.inFlightJobs);
  assertEquals(snap.computedTier, "amber");
  assertEquals(snap.tierDrivers, ["Update job in flight"]);
  assertEquals(snap.recentlyNotified, {});
  assertEquals(snap.consecutiveReadFailures, 0);
});

Deno.test("buildSnapshot: carries prev.recentlyNotified through", () => {
  const state = makeCurrent();
  const tier = makeTier();
  const prev = makeSnapshot({
    recentlyNotified: { "daemon-crash": "2026-05-17T12:00:00.000Z" },
    consecutiveReadFailures: 2,
  });
  const snap = buildSnapshot(state, tier, prev);
  assertEquals(
    snap.recentlyNotified["daemon-crash"],
    "2026-05-17T12:00:00.000Z",
  );
  assertEquals(snap.consecutiveReadFailures, 2);
});

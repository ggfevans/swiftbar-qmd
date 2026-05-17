import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import type {
  ActionId,
  CollectionState,
  DaemonState,
  FailureRecord,
  JobInfo,
  PollSnapshot,
} from "../lib/types.ts";
import {
  appendFailure,
  deleteJobPidFile,
  logsDirContents,
  pruneFailuresOlderThan,
  pruneLogs,
  readJobPidFiles,
  readRecentFailures,
  readSnapshot,
  writeJobPidFile,
  writeSnapshot,
} from "../lib/persistence.ts";

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Run a test body with a fresh CACHE_DIR override. The env var is set
 * before the body runs and cleared afterwards so subsequent tests see
 * their own per-temp-dir setting (not leaked state).
 */
async function withCacheDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "swiftbar-qmd-persistence-",
  });
  const prev = Deno.env.get("SWIFTBAR_QMD_CACHE_DIR");
  Deno.env.set("SWIFTBAR_QMD_CACHE_DIR", dir);
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) {
      Deno.env.delete("SWIFTBAR_QMD_CACHE_DIR");
    } else {
      Deno.env.set("SWIFTBAR_QMD_CACHE_DIR", prev);
    }
    await Deno.remove(dir, { recursive: true });
  }
}

function makeDaemon(): DaemonState {
  return {
    status: "running",
    pid: 4321,
    uptimeSeconds: 600,
    endpoint: "http://localhost:8181",
  };
}

function makeCollection(
  name: string,
  lastModified: Date | null,
): CollectionState {
  return {
    name,
    path: `/tmp/${name}`,
    qmdUri: `qmd://${name}/`,
    pattern: "**/*.md",
    reachable: true,
    docCount: 10,
    coveragePercent: 100,
    lastModified,
    hasObsidian: false,
  };
}

function makeSnapshot(): PollSnapshot {
  return {
    pollTimestamp: "2026-05-17T12:34:56.789Z",
    daemon: makeDaemon(),
    collections: [
      makeCollection("Rackula", new Date("2026-05-16T12:00:00.000Z")),
    ],
    recentOpFailures: [{
      action: "update-all" as ActionId,
      failedAt: new Date("2026-05-17T10:30:00.000Z"),
      exitCode: 1,
      logPath: "/tmp/log",
    }],
    computedTier: "amber",
    tierDrivers: ["Rackula last updated 1d ago (>24h)"],
    recentlyNotified: {
      "daemon-crash": "2026-05-17T08:00:00.000Z",
    },
    consecutiveReadFailures: 0,
  };
}

function makeJob(action: ActionId, collection?: string): JobInfo {
  return {
    action,
    collection,
    pid: 12345,
    startedAt: new Date("2026-05-17T12:30:00.000Z"),
    command: ["qmd", "update"],
    logPath: "/tmp/log",
  };
}

function makeFailure(failedAt: Date): FailureRecord {
  return {
    action: "update-all" as ActionId,
    failedAt,
    exitCode: 1,
    logPath: `/tmp/log-${failedAt.getTime()}`,
  };
}

// ─── Tests ─────────────────────────────────────────────────────

Deno.test("writeSnapshot then readSnapshot round-trips (Date fields preserved)", async () => {
  await withCacheDir(async () => {
    const snap = makeSnapshot();
    await writeSnapshot(snap);
    const got = await readSnapshot();
    assertNotEquals(got, null);
    if (!got) return;

    assertEquals(got.pollTimestamp, snap.pollTimestamp);
    assertEquals(got.daemon.status, "running");
    assertEquals(got.daemon.pid, 4321);
    assertEquals(got.computedTier, "amber");
    assertEquals(got.consecutiveReadFailures, 0);

    // Date hydration on nested fields
    assertEquals(got.collections.length, 1);
    const lm = got.collections[0].lastModified;
    assertEquals(lm instanceof Date, true);
    assertEquals(lm?.toISOString(), "2026-05-16T12:00:00.000Z");

    assertEquals(got.recentOpFailures.length, 1);
    const fa = got.recentOpFailures[0].failedAt;
    assertEquals(fa instanceof Date, true);
    assertEquals(fa.toISOString(), "2026-05-17T10:30:00.000Z");

    assertEquals(
      got.recentlyNotified["daemon-crash"],
      "2026-05-17T08:00:00.000Z",
    );
  });
});

Deno.test("readSnapshot on missing file returns null", async () => {
  await withCacheDir(async () => {
    const got = await readSnapshot();
    assertEquals(got, null);
  });
});

Deno.test("writeJobPidFile then readJobPidFiles returns the entry", async () => {
  await withCacheDir(async (dir) => {
    const job = makeJob("update-all" as ActionId);
    await writeJobPidFile("update-all" as ActionId, job);

    const got = await readJobPidFiles();
    assertEquals(got.length, 1);
    assertEquals(got[0].action, "update-all");
    assertEquals(got[0].collection, undefined);
    assertEquals(got[0].pid, 12345);
    assertEquals(got[0].startedAt instanceof Date, true);
    assertEquals(got[0].startedAt.toISOString(), "2026-05-17T12:30:00.000Z");
    assertEquals(got[0].command, ["qmd", "update"]);
    assertEquals(got[0].logPath, "/tmp/log");

    // Verify the file is at the expected path
    const expected = join(dir, "jobs", "update-all.pid");
    const stat = await Deno.stat(expected);
    assertEquals(stat.isFile, true);
  });
});

Deno.test("deleteJobPidFile removes it", async () => {
  await withCacheDir(async () => {
    const job = makeJob("update-all" as ActionId);
    await writeJobPidFile("update-all" as ActionId, job);
    assertEquals((await readJobPidFiles()).length, 1);

    await deleteJobPidFile("update-all" as ActionId);
    assertEquals((await readJobPidFiles()).length, 0);

    // Deleting a non-existent file is a no-op (no throw)
    await deleteJobPidFile("update-all" as ActionId);
  });
});

Deno.test("writeJobPidFile per-collection uses <action>:<collection>.pid", async () => {
  await withCacheDir(async (dir) => {
    const job = makeJob("embed-collection" as ActionId, "gVault");
    await writeJobPidFile("embed-collection" as ActionId, job);

    const expected = join(dir, "jobs", "embed-collection:gVault.pid");
    const stat = await Deno.stat(expected);
    assertEquals(stat.isFile, true);

    const got = await readJobPidFiles();
    assertEquals(got.length, 1);
    assertEquals(got[0].collection, "gVault");

    // deleteJobPidFile with collection arg targets the right file
    await deleteJobPidFile("embed-collection" as ActionId, "gVault");
    assertEquals((await readJobPidFiles()).length, 0);
  });
});

Deno.test("appendFailure twice then readRecentFailures returns both, newest first", async () => {
  await withCacheDir(async () => {
    const older = makeFailure(new Date("2026-05-17T10:00:00.000Z"));
    const newer = makeFailure(new Date("2026-05-17T12:00:00.000Z"));

    await appendFailure(older);
    await appendFailure(newer);

    const got = await readRecentFailures();
    assertEquals(got.length, 2);
    assertEquals(got[0].failedAt.toISOString(), newer.failedAt.toISOString());
    assertEquals(got[1].failedAt.toISOString(), older.failedAt.toISOString());
  });
});

Deno.test("appendFailure 60 times then readRecentFailures returns 50 (newest)", async () => {
  await withCacheDir(async () => {
    // Append 60 failures with monotonically increasing timestamps so we
    // can confirm which 50 survived (the most-recent 50).
    const base = Date.now();
    for (let i = 0; i < 60; i++) {
      const f = makeFailure(new Date(base + i * 1000));
      await appendFailure(f);
    }

    const got = await readRecentFailures();
    assertEquals(got.length, 50);
    // The newest entry should be i=59.
    assertEquals(got[0].failedAt.getTime(), base + 59 * 1000);
    // The 50th-newest should be i=10 (we kept indices 59…10).
    assertEquals(got[49].failedAt.getTime(), base + 10 * 1000);
  });
});

Deno.test("pruneFailuresOlderThan(1) with mixed-age entries keeps only those within 1 hour", async () => {
  await withCacheDir(async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;

    const recent = makeFailure(new Date(now - 10 * 60 * 1000)); // 10 min ago
    const justInside = makeFailure(new Date(now - 30 * 60 * 1000)); // 30 min ago
    const oldOne = makeFailure(new Date(now - 2 * HOUR)); // 2h ago
    const ancient = makeFailure(new Date(now - 5 * HOUR)); // 5h ago

    // Append in order — newest will be appended last, so it ends up first.
    await appendFailure(ancient);
    await appendFailure(oldOne);
    await appendFailure(justInside);
    await appendFailure(recent);

    assertEquals((await readRecentFailures()).length, 4);

    await pruneFailuresOlderThan(1);

    const got = await readRecentFailures();
    assertEquals(got.length, 2);
    // Newest first
    assertEquals(got[0].failedAt.getTime(), recent.failedAt.getTime());
    assertEquals(got[1].failedAt.getTime(), justInside.failedAt.getTime());
  });
});

Deno.test("pruneLogs(2) with 5 logs for one action keeps the 2 newest", async () => {
  await withCacheDir(async (dir) => {
    const logsPath = join(dir, "logs");
    await Deno.mkdir(logsPath, { recursive: true });

    // Create 5 log files with distinct mtimes for the same action.
    const stamps = [
      "20260513T100000",
      "20260514T100000",
      "20260515T100000",
      "20260516T100000",
      "20260517T100000",
    ];
    const filenames: string[] = [];
    for (let i = 0; i < stamps.length; i++) {
      const name = `update-all-${stamps[i]}.log`;
      const full = join(logsPath, name);
      await Deno.writeTextFile(full, `log #${i}\n`);
      // Older index → older mtime. Use atime/mtime equal to a deterministic
      // ISO date so the sort is unambiguous.
      const mtime = new Date(`2026-05-${13 + i}T10:00:00.000Z`);
      await Deno.utime(full, mtime, mtime);
      filenames.push(name);
    }

    // Before prune: 5 logs.
    let listing = await logsDirContents();
    assertEquals(listing.length, 5);

    await pruneLogs(2);

    listing = await logsDirContents();
    assertEquals(listing.length, 2);

    // The two newest are i=3 and i=4 (May 16 + May 17).
    const surviving = new Set(listing.map((e) => e.path));
    assertEquals(surviving.has(join(logsPath, filenames[4])), true);
    assertEquals(surviving.has(join(logsPath, filenames[3])), true);
    assertEquals(surviving.has(join(logsPath, filenames[2])), false);
  });
});

// ─── Bonus coverage ────────────────────────────────────────────

Deno.test("logsDirContents groups action+collection separately", async () => {
  await withCacheDir(async (dir) => {
    const logsPath = join(dir, "logs");
    await Deno.mkdir(logsPath, { recursive: true });

    // Two log files for `update-all` (plain) and one for
    // `embed-collection:gVault` (per-collection) — pruneLogs(1) should
    // keep one per group, leaving 2 files total.
    const a1 = join(logsPath, "update-all-20260516T100000.log");
    const a2 = join(logsPath, "update-all-20260517T100000.log");
    const b1 = join(logsPath, "embed-collection:gVault-20260517T100000.log");

    for (
      const [p, dateStr] of [
        [a1, "2026-05-16T10:00:00.000Z"],
        [a2, "2026-05-17T10:00:00.000Z"],
        [b1, "2026-05-17T10:00:00.000Z"],
      ] as const
    ) {
      await Deno.writeTextFile(p, "x");
      const t = new Date(dateStr);
      await Deno.utime(p, t, t);
    }

    let listing = await logsDirContents();
    assertEquals(listing.length, 3);

    await pruneLogs(1);

    listing = await logsDirContents();
    assertEquals(listing.length, 2); // one per group
    const paths = new Set(listing.map((e) => e.path));
    assertEquals(paths.has(a1), false); // pruned
    assertEquals(paths.has(a2), true);
    assertEquals(paths.has(b1), true);
  });
});

Deno.test("readJobPidFiles on missing dir returns empty array", async () => {
  await withCacheDir(async () => {
    const got = await readJobPidFiles();
    assertEquals(got, []);
  });
});

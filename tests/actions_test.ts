import { assertEquals, assertNotEquals } from "@std/assert";
import { runAction } from "../lib/actions.ts";
import type { ActionDeps } from "../lib/actions.ts";
import type { ActionId, JobInfo } from "../lib/types.ts";

// ─── Recorder mocks ────────────────────────────────────────────

/**
 * Capture every dep call so a test can assert what the action runner
 * touched (and what it didn't). Each field starts as an empty array
 * or default value; the helper below builds an `ActionDeps` that
 * appends to these recorders.
 */
type Recorder = {
  readJobPidFileCalls: Array<{ action: ActionId; collection?: string }>;
  writeJobPidFileCalls: Array<{ action: ActionId; info: JobInfo }>;
  spawnDetachedCalls: Array<{ commandString: string; logPath: string }>;
  isProcessAliveCalls: number[];
  touchSentinelCalls: string[];
  showContextDialogCalls: Array<{ collection: string; output: string }>;
  runQmdContextListCalls: string[];
  exitCalls: number[];
};

function makeRecorder(): Recorder {
  return {
    readJobPidFileCalls: [],
    writeJobPidFileCalls: [],
    spawnDetachedCalls: [],
    isProcessAliveCalls: [],
    touchSentinelCalls: [],
    showContextDialogCalls: [],
    runQmdContextListCalls: [],
    exitCalls: [],
  };
}

/**
 * Build a fully mocked `ActionDeps` whose calls feed into the
 * recorder. Individual fields can be overridden per-test to change
 * the response (e.g. `readJobPidFile` returning a live PID).
 */
function makeDeps(
  rec: Recorder,
  overrides: Partial<ActionDeps> = {},
): ActionDeps {
  return {
    readJobPidFile: overrides.readJobPidFile ?? ((action, collection) => {
      rec.readJobPidFileCalls.push({ action, collection });
      return Promise.resolve(null);
    }),
    writeJobPidFile: overrides.writeJobPidFile ?? ((action, info) => {
      rec.writeJobPidFileCalls.push({ action, info });
      return Promise.resolve();
    }),
    spawnDetached: overrides.spawnDetached ?? ((commandString, logPath) => {
      rec.spawnDetachedCalls.push({ commandString, logPath });
      return Promise.resolve(42);
    }),
    isProcessAlive: overrides.isProcessAlive ?? ((pid) => {
      rec.isProcessAliveCalls.push(pid);
      return false;
    }),
    touchSentinel: overrides.touchSentinel ?? ((name) => {
      rec.touchSentinelCalls.push(name);
      return Promise.resolve();
    }),
    showContextDialog: overrides.showContextDialog ??
      ((collection, output) => {
        rec.showContextDialogCalls.push({ collection, output });
        return Promise.resolve();
      }),
    runQmdContextList: overrides.runQmdContextList ?? ((collection) => {
      rec.runQmdContextListCalls.push(collection);
      return Promise.resolve("mocked qmd context output");
    }),
    exit: overrides.exit ?? ((code) => {
      rec.exitCalls.push(code);
    }),
  };
}

// ─── Command mapping tests ─────────────────────────────────────

Deno.test("runAction: update-all maps to 'qmd update'", async () => {
  const rec = makeRecorder();
  await runAction("update-all", {}, makeDeps(rec));

  assertEquals(rec.spawnDetachedCalls.length, 1);
  assertEquals(rec.spawnDetachedCalls[0].commandString, "qmd update");

  // PID file is written with the correct shape.
  assertEquals(rec.writeJobPidFileCalls.length, 1);
  const written = rec.writeJobPidFileCalls[0];
  assertEquals(written.action, "update-all");
  assertEquals(written.info.action, "update-all");
  assertEquals(written.info.command, ["qmd", "update"]);
  assertEquals(written.info.pid, 42);
  assertEquals(written.info.collection, undefined);
  assertNotEquals(written.info.logPath, "");
});

Deno.test("runAction: embed-all maps to 'qmd embed'", async () => {
  const rec = makeRecorder();
  await runAction("embed-all", {}, makeDeps(rec));

  assertEquals(rec.spawnDetachedCalls.length, 1);
  assertEquals(rec.spawnDetachedCalls[0].commandString, "qmd embed");
  assertEquals(rec.writeJobPidFileCalls[0].info.command, ["qmd", "embed"]);
});

Deno.test("runAction: update-collection injects the collection name correctly", async () => {
  const rec = makeRecorder();
  await runAction(
    "update-collection",
    { collection: "gVault" },
    makeDeps(rec),
  );

  assertEquals(rec.spawnDetachedCalls.length, 1);
  // The chained command must reference the collection name.
  assertEquals(
    rec.spawnDetachedCalls[0].commandString,
    "qmd update && qmd embed -c gVault",
  );

  // PID file keys on action + collection.
  const written = rec.writeJobPidFileCalls[0];
  assertEquals(written.action, "update-collection");
  assertEquals(written.info.collection, "gVault");
  assertEquals(written.info.command, [
    "qmd",
    "update",
    "&&",
    "qmd",
    "embed",
    "-c",
    "gVault",
  ]);
});

Deno.test("runAction: embed-collection passes -c flag", async () => {
  const rec = makeRecorder();
  await runAction(
    "embed-collection",
    { collection: "Rackula" },
    makeDeps(rec),
  );

  assertEquals(
    rec.spawnDetachedCalls[0].commandString,
    "qmd embed -c Rackula",
  );
  assertEquals(rec.writeJobPidFileCalls[0].info.command, [
    "qmd",
    "embed",
    "-c",
    "Rackula",
  ]);
});

Deno.test("runAction: force-reembed-collection passes -c and -f flags", async () => {
  const rec = makeRecorder();
  await runAction(
    "force-reembed-collection",
    { collection: "gVault" },
    makeDeps(rec),
  );

  assertEquals(
    rec.spawnDetachedCalls[0].commandString,
    "qmd embed -c gVault -f",
  );
});

Deno.test("runAction: restart-daemon chains stop && start", async () => {
  const rec = makeRecorder();
  await runAction("restart-daemon", {}, makeDeps(rec));

  assertEquals(
    rec.spawnDetachedCalls[0].commandString,
    "qmd mcp stop && qmd mcp --http --daemon",
  );
});

Deno.test("runAction: stop-daemon maps to 'qmd mcp stop'", async () => {
  const rec = makeRecorder();
  await runAction("stop-daemon", {}, makeDeps(rec));

  assertEquals(rec.spawnDetachedCalls[0].commandString, "qmd mcp stop");
});

Deno.test("runAction: start-daemon maps to 'qmd mcp --http --daemon'", async () => {
  const rec = makeRecorder();
  await runAction("start-daemon", {}, makeDeps(rec));

  assertEquals(
    rec.spawnDetachedCalls[0].commandString,
    "qmd mcp --http --daemon",
  );
});

Deno.test("runAction: cleanup maps to 'qmd cleanup'", async () => {
  const rec = makeRecorder();
  await runAction("cleanup", {}, makeDeps(rec));

  assertEquals(rec.spawnDetachedCalls[0].commandString, "qmd cleanup");
});

// ─── Locking tests ─────────────────────────────────────────────

Deno.test("runAction: locking — existing alive PID file → no spawn, no write", async () => {
  const rec = makeRecorder();
  const existing: JobInfo = {
    action: "update-all",
    pid: 1234,
    startedAt: new Date(),
    command: ["qmd", "update"],
    logPath: "/tmp/old.log",
  };
  const deps = makeDeps(rec, {
    readJobPidFile: (action, collection) => {
      rec.readJobPidFileCalls.push({ action, collection });
      return Promise.resolve(existing);
    },
    isProcessAlive: (pid) => {
      rec.isProcessAliveCalls.push(pid);
      return true; // PID is alive → locked
    },
  });

  await runAction("update-all", {}, deps);

  // We must have checked the lockfile and process alive.
  assertEquals(rec.readJobPidFileCalls.length, 1);
  assertEquals(rec.readJobPidFileCalls[0].action, "update-all");
  assertEquals(rec.isProcessAliveCalls, [1234]);

  // We must NOT have spawned or written a new PID file.
  assertEquals(rec.spawnDetachedCalls.length, 0);
  assertEquals(rec.writeJobPidFileCalls.length, 0);

  // The runner exited (silently). The injected `exit` is recorded.
  assertEquals(rec.exitCalls, [0]);
});

Deno.test("runAction: locking — existing dead PID file → spawn proceeds", async () => {
  const rec = makeRecorder();
  const stale: JobInfo = {
    action: "update-all",
    pid: 9999,
    startedAt: new Date(Date.now() - 86_400_000),
    command: ["qmd", "update"],
    logPath: "/tmp/old.log",
  };
  const deps = makeDeps(rec, {
    readJobPidFile: () => Promise.resolve(stale),
    isProcessAlive: (pid) => {
      rec.isProcessAliveCalls.push(pid);
      return false; // dead → not locked
    },
  });

  await runAction("update-all", {}, deps);

  // Liveness check happened on the stale PID.
  assertEquals(rec.isProcessAliveCalls, [9999]);

  // Spawn proceeded — and overwrote the PID file with the new pid.
  assertEquals(rec.spawnDetachedCalls.length, 1);
  assertEquals(rec.writeJobPidFileCalls.length, 1);
  assertEquals(rec.writeJobPidFileCalls[0].info.pid, 42);

  // No silent exit.
  assertEquals(rec.exitCalls, []);
});

Deno.test("runAction: locking key uses action:collection for per-collection actions", async () => {
  const rec = makeRecorder();
  await runAction(
    "embed-collection",
    { collection: "gVault" },
    makeDeps(rec),
  );

  // The lock-check was scoped to the collection.
  assertEquals(rec.readJobPidFileCalls.length, 1);
  assertEquals(rec.readJobPidFileCalls[0].action, "embed-collection");
  assertEquals(rec.readJobPidFileCalls[0].collection, "gVault");
});

// ─── Recheck (sentinel) ────────────────────────────────────────

Deno.test("runAction: recheck writes the 'recheck' sentinel and does not spawn", async () => {
  const rec = makeRecorder();
  await runAction("recheck", {}, makeDeps(rec));

  assertEquals(rec.touchSentinelCalls, ["recheck"]);
  assertEquals(rec.spawnDetachedCalls.length, 0);
  assertEquals(rec.writeJobPidFileCalls.length, 0);
  assertEquals(rec.readJobPidFileCalls.length, 0);
});

// ─── Show-context (synchronous) ────────────────────────────────

Deno.test("runAction: show-context is synchronous (runs qmd, shows dialog, writes no PID)", async () => {
  const rec = makeRecorder();
  await runAction(
    "show-context",
    { collection: "gVault" },
    makeDeps(rec),
  );

  // We ran the context list once and showed the dialog once.
  assertEquals(rec.runQmdContextListCalls, ["gVault"]);
  assertEquals(rec.showContextDialogCalls.length, 1);
  assertEquals(rec.showContextDialogCalls[0].collection, "gVault");
  assertEquals(
    rec.showContextDialogCalls[0].output,
    "mocked qmd context output",
  );

  // No PID file, no spawn, no lockfile check.
  assertEquals(rec.spawnDetachedCalls.length, 0);
  assertEquals(rec.writeJobPidFileCalls.length, 0);
  assertEquals(rec.readJobPidFileCalls.length, 0);
});

// ─── Invalid input handling ────────────────────────────────────

Deno.test("runAction: per-collection action with missing collection → no spawn", async () => {
  const rec = makeRecorder();
  await runAction("embed-collection", {}, makeDeps(rec));

  assertEquals(rec.spawnDetachedCalls.length, 0);
  assertEquals(rec.writeJobPidFileCalls.length, 0);
});

Deno.test("runAction: per-collection action with unsafe collection name → no spawn", async () => {
  const rec = makeRecorder();
  await runAction(
    "embed-collection",
    { collection: "evil; rm -rf /" },
    makeDeps(rec),
  );

  assertEquals(rec.spawnDetachedCalls.length, 0);
  assertEquals(rec.writeJobPidFileCalls.length, 0);
});

// ─── Log path naming ───────────────────────────────────────────

Deno.test("runAction: log path includes the action id and a timestamp", async () => {
  const rec = makeRecorder();
  await runAction("update-all", {}, makeDeps(rec));

  const { logPath } = rec.spawnDetachedCalls[0];
  // The path is built from CACHE_DIR/logs/; the basename starts with the
  // actionId and ends with .log. We don't assert the exact timestamp to
  // keep the test deterministic.
  if (!logPath.includes("/logs/update-all-")) {
    throw new Error(`expected '/logs/update-all-' in logPath: ${logPath}`);
  }
  if (!logPath.endsWith(".log")) {
    throw new Error(`expected '.log' suffix: ${logPath}`);
  }
});

Deno.test("runAction: per-collection log path includes collection suffix", async () => {
  const rec = makeRecorder();
  await runAction(
    "embed-collection",
    { collection: "gVault" },
    makeDeps(rec),
  );

  const { logPath } = rec.spawnDetachedCalls[0];
  if (!logPath.includes("/logs/embed-collection:gVault-")) {
    throw new Error(
      `expected '/logs/embed-collection:gVault-' in logPath: ${logPath}`,
    );
  }
});

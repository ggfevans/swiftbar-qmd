import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  buildConfirmDialogScript,
  parseConfirmDialogOutput,
  runAction,
} from "../lib/actions.ts";
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
  tryAcquireLockCalls: Array<{ action: ActionId; collection?: string }>;
  deleteJobPidFileCalls: Array<{ action: ActionId; collection?: string }>;
  spawnDetachedCalls: Array<{ commandString: string; logPath: string }>;
  isProcessAliveCalls: number[];
  touchSentinelCalls: string[];
  showContextDialogCalls: Array<{ collection: string; output: string }>;
  runQmdContextListCalls: string[];
  confirmDialogCalls: Array<{ message: string; proceedLabel: string }>;
  exitCalls: number[];
};

function makeRecorder(): Recorder {
  return {
    readJobPidFileCalls: [],
    writeJobPidFileCalls: [],
    tryAcquireLockCalls: [],
    deleteJobPidFileCalls: [],
    spawnDetachedCalls: [],
    isProcessAliveCalls: [],
    touchSentinelCalls: [],
    showContextDialogCalls: [],
    runQmdContextListCalls: [],
    confirmDialogCalls: [],
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
    // Default: lock acquired (no competing process).
    tryAcquireLock: overrides.tryAcquireLock ?? ((action, collection) => {
      rec.tryAcquireLockCalls.push({ action, collection });
      return Promise.resolve(true);
    }),
    deleteJobPidFile: overrides.deleteJobPidFile ?? ((action, collection) => {
      rec.deleteJobPidFileCalls.push({ action, collection });
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
    // Default to "proceed" so existing happy-path tests for cleanup /
    // force-reembed continue to spawn. Tests that need to exercise the
    // Cancel branch override this with `() => Promise.resolve(false)`.
    confirmDialog: overrides.confirmDialog ?? ((message, proceedLabel) => {
      rec.confirmDialogCalls.push({ message, proceedLabel });
      return Promise.resolve(true);
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

  // PID file is written twice: placeholder (pid=-1) then real PID.
  assertEquals(rec.writeJobPidFileCalls.length, 2);
  assertEquals(rec.writeJobPidFileCalls[0].info.pid, -1); // placeholder
  const written = rec.writeJobPidFileCalls[1];
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
  assertEquals(rec.writeJobPidFileCalls[1].info.command, ["qmd", "embed"]);
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

  // PID file keys on action + collection (second write = real PID).
  const written = rec.writeJobPidFileCalls[1];
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

// ─── Locking tests (D8: atomic O_EXCL) ──────────────────────

Deno.test("runAction: lock acquired → spawn proceeds with placeholder PID", async () => {
  const rec = makeRecorder();
  await runAction("update-all", {}, makeDeps(rec));

  // Lock was attempted.
  assertEquals(rec.tryAcquireLockCalls.length, 1);
  assertEquals(rec.tryAcquireLockCalls[0].action, "update-all");

  // Spawn proceeded.
  assertEquals(rec.spawnDetachedCalls.length, 1);

  // Two PID file writes: placeholder (pid=-1) then real PID (pid=42).
  assertEquals(rec.writeJobPidFileCalls.length, 2);
  assertEquals(rec.writeJobPidFileCalls[0].info.pid, -1);
  assertEquals(rec.writeJobPidFileCalls[1].info.pid, 42);

  // No PID file deletion on success path.
  assertEquals(rec.deleteJobPidFileCalls.length, 0);

  // No silent exit.
  assertEquals(rec.exitCalls, []);
});

Deno.test("runAction: lock held → no spawn, no write, silent exit", async () => {
  const rec = makeRecorder();
  const deps = makeDeps(rec, {
    // Lock already held by another process.
    tryAcquireLock: (action, collection) => {
      rec.tryAcquireLockCalls.push({ action, collection });
      return Promise.resolve(false);
    },
  });

  await runAction("update-all", {}, deps);

  // Lock was attempted.
  assertEquals(rec.tryAcquireLockCalls.length, 1);

  // No spawn, no PID file writes.
  assertEquals(rec.spawnDetachedCalls.length, 0);
  assertEquals(rec.writeJobPidFileCalls.length, 0);

  // Silent exit.
  assertEquals(rec.exitCalls, [0]);
});

Deno.test("runAction: lock key uses action:collection for per-collection actions", async () => {
  const rec = makeRecorder();
  await runAction(
    "embed-collection",
    { collection: "gVault" },
    makeDeps(rec),
  );

  // The lock was scoped to the collection.
  assertEquals(rec.tryAcquireLockCalls.length, 1);
  assertEquals(rec.tryAcquireLockCalls[0].action, "embed-collection");
  assertEquals(rec.tryAcquireLockCalls[0].collection, "gVault");
});

Deno.test("runAction: spawn failure → lock released (PID file deleted)", async () => {
  const rec = makeRecorder();
  const deps = makeDeps(rec, {
    spawnDetached: () => {
      rec.spawnDetachedCalls.push({ commandString: "", logPath: "" });
      return Promise.reject(new Error("spawn failed"));
    },
  });

  await runAction("update-all", {}, deps);

  // Lock was acquired.
  assertEquals(rec.tryAcquireLockCalls.length, 1);

  // Placeholder PID was written.
  assertEquals(rec.writeJobPidFileCalls.length, 1);
  assertEquals(rec.writeJobPidFileCalls[0].info.pid, -1);

  // Spawn failed.
  assertEquals(rec.spawnDetachedCalls.length, 1);

  // Lock was released (PID file deleted).
  assertEquals(rec.deleteJobPidFileCalls.length, 1);
  assertEquals(rec.deleteJobPidFileCalls[0].action, "update-all");
});

Deno.test("runAction: placeholder write failure → lock released, no spawn", async () => {
  // If writeJobPidFile (placeholder) throws, the runner should release
  // the lock and abort the spawn — not proceed to spawning a background
  // process with no PID tracking.
  const rec = makeRecorder();
  const deps = makeDeps(rec, {
    writeJobPidFile: (action, info) => {
      rec.writeJobPidFileCalls.push({ action, info });
      return Promise.reject(new Error("disk-full"));
    },
  });

  await runAction("update-all", {}, deps);

  // Lock was acquired.
  assertEquals(rec.tryAcquireLockCalls.length, 1);

  // Placeholder write was attempted (and failed).
  assertEquals(rec.writeJobPidFileCalls.length, 1);

  // Lock was released (PID file deleted).
  assertEquals(rec.deleteJobPidFileCalls.length, 1);

  // No spawn attempted.
  assertEquals(rec.spawnDetachedCalls.length, 0);

  // No exit call — the runner just returns after releasing the lock.
  assertEquals(rec.exitCalls.length, 0);
});

// ─── Recheck (sentinel) ────────────────────────────────────────

Deno.test("runAction: recheck writes the 'recheck' sentinel and does not spawn", async () => {
  const rec = makeRecorder();
  await runAction("recheck", {}, makeDeps(rec));

  assertEquals(rec.touchSentinelCalls, ["recheck"]);
  assertEquals(rec.spawnDetachedCalls.length, 0);
  assertEquals(rec.writeJobPidFileCalls.length, 0);
  assertEquals(rec.tryAcquireLockCalls.length, 0);
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
  assertEquals(rec.tryAcquireLockCalls.length, 0);
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

// ─── Confirmation dialogs (SPEC §11.2) ─────────────────────────

Deno.test("runAction: force-reembed-collection → confirmDialog cancelled → no spawn", async () => {
  const rec = makeRecorder();
  await runAction(
    "force-reembed-collection",
    { collection: "gVault" },
    makeDeps(rec, {
      confirmDialog: (message, proceedLabel) => {
        rec.confirmDialogCalls.push({ message, proceedLabel });
        return Promise.resolve(false);
      },
    }),
  );

  // Dialog was asked, with the SPEC §11.2 message and proceed label.
  assertEquals(rec.confirmDialogCalls.length, 1);
  assertEquals(
    rec.confirmDialogCalls[0].message,
    "Force re-embed all chunks in gVault? This will take several minutes.",
  );
  assertEquals(rec.confirmDialogCalls[0].proceedLabel, "Re-embed");

  // We MUST NOT have spawned or written a PID file.
  assertEquals(rec.spawnDetachedCalls.length, 0);
  assertEquals(rec.writeJobPidFileCalls.length, 0);
  // The lock check is gated behind the confirm, so it must not have run.
  assertEquals(rec.tryAcquireLockCalls.length, 0);
  // No process exit either — the runner returns silently.
  assertEquals(rec.exitCalls, []);
});

Deno.test("runAction: force-reembed-collection → confirmDialog accepted → spawn proceeds", async () => {
  const rec = makeRecorder();
  await runAction(
    "force-reembed-collection",
    { collection: "gVault" },
    makeDeps(rec, {
      confirmDialog: (message, proceedLabel) => {
        rec.confirmDialogCalls.push({ message, proceedLabel });
        return Promise.resolve(true);
      },
    }),
  );

  assertEquals(rec.confirmDialogCalls.length, 1);
  // Spawn happens, command shape matches §13 mapping for force re-embed.
  assertEquals(rec.spawnDetachedCalls.length, 1);
  assertEquals(
    rec.spawnDetachedCalls[0].commandString,
    "qmd embed -c gVault -f",
  );
  assertEquals(rec.writeJobPidFileCalls.length, 2);
});

Deno.test("runAction: cleanup → confirmDialog cancelled → no spawn", async () => {
  const rec = makeRecorder();
  await runAction(
    "cleanup",
    {},
    makeDeps(rec, {
      confirmDialog: (message, proceedLabel) => {
        rec.confirmDialogCalls.push({ message, proceedLabel });
        return Promise.resolve(false);
      },
    }),
  );

  assertEquals(rec.confirmDialogCalls.length, 1);
  assertEquals(
    rec.confirmDialogCalls[0].message,
    "Clean up orphaned data from the qmd cache? This is generally safe but cannot be undone.",
  );
  assertEquals(rec.confirmDialogCalls[0].proceedLabel, "Clean up");

  assertEquals(rec.spawnDetachedCalls.length, 0);
  assertEquals(rec.writeJobPidFileCalls.length, 0);
  assertEquals(rec.tryAcquireLockCalls.length, 0);
  assertEquals(rec.exitCalls, []);
});

Deno.test("runAction: cleanup → confirmDialog accepted → spawn proceeds", async () => {
  const rec = makeRecorder();
  await runAction(
    "cleanup",
    {},
    makeDeps(rec, {
      confirmDialog: (message, proceedLabel) => {
        rec.confirmDialogCalls.push({ message, proceedLabel });
        return Promise.resolve(true);
      },
    }),
  );

  assertEquals(rec.confirmDialogCalls.length, 1);
  assertEquals(rec.spawnDetachedCalls.length, 1);
  assertEquals(rec.spawnDetachedCalls[0].commandString, "qmd cleanup");
  assertEquals(rec.writeJobPidFileCalls.length, 2);
});

Deno.test("runAction: non-destructive actions do not invoke confirmDialog", async () => {
  // Sanity check: actions outside the gated set (update-all, embed-all,
  // restart-daemon, etc.) must NEVER trigger a confirm prompt. The test
  // overrides confirmDialog with a "deny" stub — if any of these called
  // through, the spawn would be suppressed and the assertion would fail.
  const nonDestructive: Array<{ id: ActionId; args: Record<string, string> }> =
    [
      { id: "update-all", args: {} },
      { id: "embed-all", args: {} },
      { id: "update-collection", args: { collection: "gVault" } },
      { id: "embed-collection", args: { collection: "gVault" } },
      { id: "restart-daemon", args: {} },
      { id: "stop-daemon", args: {} },
      { id: "start-daemon", args: {} },
    ];

  for (const { id, args } of nonDestructive) {
    const rec = makeRecorder();
    await runAction(
      id,
      args,
      makeDeps(rec, {
        // If anything calls confirmDialog here it's a bug.
        confirmDialog: (message, proceedLabel) => {
          rec.confirmDialogCalls.push({ message, proceedLabel });
          return Promise.resolve(false);
        },
      }),
    );

    assertEquals(rec.confirmDialogCalls.length, 0, `${id} must not confirm`);
    assertEquals(rec.spawnDetachedCalls.length, 1, `${id} must spawn`);
  }
});

// ─── Confirm dialog timeout (SPEC §11.2, PR #1 A7) ────────────

Deno.test("buildConfirmDialogScript: includes 60s timeout (PR #1 A7)", () => {
  // Regression: pre-A7 the script had no `giving up after` clause, so
  // the dialog blocked indefinitely. SwiftBar's plugin process stays
  // alive for the duration — zombie processes piled up whenever the
  // user walked away. SPEC §11.2 documents the 60s timeout.
  const script = buildConfirmDialogScript(
    "Force re-embed?",
    "Re-embed",
  );

  // Critical: the `giving up after 60` clause must be present.
  assertStringIncludes(script, "giving up after 60");
  // Sanity-check the rest of the dialog shape stays correct so a
  // future refactor doesn't drop the timeout when it tidies the
  // string assembly.
  assertStringIncludes(script, `display dialog "Force re-embed?"`);
  assertStringIncludes(script, `with title "swiftbar-qmd"`);
  assertStringIncludes(script, `buttons {"Cancel", "Re-embed"}`);
  assertStringIncludes(script, `default button "Cancel"`);
  assertStringIncludes(script, `with icon caution`);
});

Deno.test("parseConfirmDialogOutput: button-returned proceed → true", () => {
  assertEquals(
    parseConfirmDialogOutput("button returned:Re-embed\n", "Re-embed"),
    true,
  );
});

Deno.test("parseConfirmDialogOutput: button-returned Cancel → false", () => {
  assertEquals(
    parseConfirmDialogOutput("button returned:Cancel\n", "Re-embed"),
    false,
  );
});

Deno.test("parseConfirmDialogOutput: gave up:true → false (PR #1 A7)", () => {
  // The 60s timeout path. AppleScript emits `gave up:true` instead of
  // (or alongside) a button-returned line. We MUST treat that as
  // Cancel — never proceed on timeout, destructive actions stay safe.
  assertEquals(
    parseConfirmDialogOutput("gave up:true\n", "Re-embed"),
    false,
  );
});

Deno.test(
  "parseConfirmDialogOutput: gave up:true wins even if button-returned present",
  () => {
    // Defence-in-depth: if AppleScript emits both (e.g. a future macOS
    // version changes the format), the timeout still wins.
    assertEquals(
      parseConfirmDialogOutput(
        "button returned:Re-embed, gave up:true\n",
        "Re-embed",
      ),
      false,
    );
  },
);

Deno.test("parseConfirmDialogOutput: empty/unknown stdout → false", () => {
  assertEquals(parseConfirmDialogOutput("", "Re-embed"), false);
  assertEquals(
    parseConfirmDialogOutput("something weird\n", "Re-embed"),
    false,
  );
});

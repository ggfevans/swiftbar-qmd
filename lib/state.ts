import type {
  ActionId,
  CollectionState,
  Config,
  CurrentState,
  DaemonState,
  FailureRecord,
  IndexStatus,
  JobInfo,
} from "./types.ts";
import { withTimeout } from "./time.ts";
import {
  appendFailure as productionAppendFailure,
  deleteJobPidFile as productionDeleteJobPidFile,
  readJobPidFiles as productionReadJobPidFiles,
  readRecentFailures as productionReadRecentFailures,
} from "./persistence.ts";
import { isProcessAlive as productionIsProcessAlive } from "./actions.ts";
import { logError } from "./log.ts";

// ─── Source contract ───────────────────────────────────────────

/**
 * Injection seam for readCurrentState. Each source is wrapped in its
 * own error boundary by readCurrentState, so source implementations
 * are free to throw on failure. The DI shape mirrors lib/detect.ts's
 * `Probes` pattern.
 *
 * SDK reads (`readCollections`, `readIndexStatus`) carry an internal
 * 2-second timeout. `probeDaemon` carries a 5-second timeout. The two
 * filesystem readers from `lib/persistence.ts` are not timed — they
 * already swallow missing-file errors.
 *
 * The completion-detection sources (`isProcessAlive`,
 * `readExitCodeFromLog`, `appendFailure`, `deleteJobPidFile`) are
 * invoked per in-flight job after `readJobPidFiles` returns. See
 * SPEC §13.4–§13.5: dead PIDs are demoted out of the in-flight set,
 * their log is scanned for `EXIT_CODE=N`, and non-zero outcomes are
 * appended to recent-failures.
 */
export type StateSources = {
  readCollections: (config: Config) => Promise<CollectionState[]>;
  readIndexStatus: (config: Config) => Promise<IndexStatus>;
  probeDaemon: (config: Config) => Promise<DaemonState>;
  readJobPidFiles: () => Promise<JobInfo[]>;
  readRecentFailures: () => Promise<FailureRecord[]>;
  isProcessAlive: (pid: number) => boolean;
  readExitCodeFromLog: (logPath: string) => Promise<number>;
  appendFailure: (failure: FailureRecord) => Promise<void>;
  deleteJobPidFile: (action: ActionId, collection?: string) => Promise<void>;
};

// ─── Timeouts ──────────────────────────────────────────────────

const SDK_TIMEOUT_MS = 2_000;
const DAEMON_TIMEOUT_MS = 5_000;

// ─── Production: SDK readers ───────────────────────────────────

/**
 * Open the qmd store and list collections, mapping the SDK row shape
 * to `CollectionState`. Performs the per-row filesystem stats
 * (`reachable`, `hasObsidian`) and derives `coveragePercent` from the
 * SDK's per-collection counts.
 *
 * Wrapped in a 2s timeout by the caller's error boundary; on timeout
 * or any other failure, returns `[]`.
 */
async function productionReadCollections(
  config: Config,
): Promise<CollectionState[]> {
  // Use a bare specifier (mapped to npm:@tobilu/qmd via deno.json
  // imports). Inline `npm:` specifiers trip the deno lint
  // "no-import-prefix" rule — see lib/detect.ts for the same trick.
  const mod = await import("@tobilu/qmd");
  const store = await withTimeout(
    mod.createStore({ dbPath: config.qmd.index_path }),
    SDK_TIMEOUT_MS,
    "readCollections.createStore",
  );
  try {
    const raw = await withTimeout(
      store.listCollections(),
      SDK_TIMEOUT_MS,
      "readCollections.listCollections",
    );
    const out: CollectionState[] = [];
    for (const row of raw as Array<Record<string, unknown>>) {
      const name = String(row.name ?? "");
      const path = String(row.pwd ?? "");
      const pattern = String(row.glob_pattern ?? "");
      const docCount = Number(row.doc_count ?? 0);
      const activeCount = Number(row.active_count ?? 0);
      const lastModRaw = row.last_modified;
      const lastModified = typeof lastModRaw === "string"
        ? new Date(lastModRaw)
        : lastModRaw instanceof Date
        ? lastModRaw
        : null;

      const reachable = await statExists(path);
      const hasObsidian = reachable
        ? await statExists(`${path}/.obsidian`)
        : false;

      // Per SPEC §8.2: coverage from per-collection counts. The SDK's
      // global getStatus() doesn't expose per-collection embed counts,
      // so we use active_count / doc_count as the realistic fallback.
      // 100% when there are no docs (no division by zero).
      const coveragePercent = docCount === 0
        ? 100
        : Math.max(0, Math.min(100, (activeCount / docCount) * 100));

      out.push({
        name,
        path,
        qmdUri: `qmd://${name}/`,
        pattern,
        reachable,
        docCount,
        coveragePercent,
        lastModified,
        hasObsidian,
      });
    }
    return out;
  } finally {
    try {
      await store.close();
    } catch {
      // Swallow close-time errors; we already have the data we need.
    }
  }
}

/**
 * Open the qmd store and read its global status summary. Wrapped in a
 * 2s timeout; on timeout or failure, the caller's error boundary
 * substitutes a zero-filled IndexStatus.
 */
async function productionReadIndexStatus(
  config: Config,
): Promise<IndexStatus> {
  const mod = await import("@tobilu/qmd");
  const store = await withTimeout(
    mod.createStore({ dbPath: config.qmd.index_path }),
    SDK_TIMEOUT_MS,
    "readIndexStatus.createStore",
  );
  try {
    const raw = await withTimeout(
      store.getStatus(),
      SDK_TIMEOUT_MS,
      "readIndexStatus.getStatus",
    );
    const r = raw as Record<string, unknown>;
    return {
      totalDocs: Number(r.totalDocs ?? 0),
      totalCollections: Number(r.totalCollections ?? 0),
      dbSizeBytes: Number(r.dbSizeBytes ?? 0),
      modelCacheBytes: Number(r.modelCacheBytes ?? 0),
    };
  } finally {
    try {
      await store.close();
    } catch {
      // Swallow — see comment in productionReadCollections.
    }
  }
}

// ─── Production: HTTP probe ────────────────────────────────────

/**
 * Probe `<daemon_url>/health` with a 5s timeout (SPEC §3.2/§8). Maps
 * outcomes to the three DaemonState statuses:
 *
 *   - 200 OK              → 'running' (parses optional pid/uptime)
 *   - timeout             → 'unresponsive'
 *   - 5xx                 → 'unresponsive'
 *   - connection refused  → 'stopped'
 *   - any other failure   → 'stopped'
 *
 * Always consumes the response body so Deno's connection pool doesn't
 * leak (the test-leak detector enforces this).
 */
async function productionProbeDaemon(config: Config): Promise<DaemonState> {
  const endpoint = config.qmd.daemon_url;
  const url = `${endpoint.replace(/\/$/, "")}/health`;

  let resp: Response;
  try {
    resp = await withTimeout(fetch(url), DAEMON_TIMEOUT_MS, "probeDaemon");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Timeouts from withTimeout carry the literal phrase 'Timed out'.
    if (/timed out/i.test(msg)) {
      return {
        status: "unresponsive",
        endpoint,
        error: msg,
      };
    }
    // Network/connection errors (refused, DNS, TLS) collapse to
    // 'stopped' — the daemon isn't there to answer.
    return {
      status: "stopped",
      endpoint,
      error: msg,
    };
  }

  // Always consume the body to release the connection.
  let bodyText = "";
  try {
    bodyText = await resp.text();
  } catch {
    // Body read failed; treat as empty so we still surface the status.
  }

  if (resp.status >= 500) {
    return {
      status: "unresponsive",
      endpoint,
      error: `HTTP ${resp.status}`,
    };
  }
  if (!resp.ok) {
    // 4xx is unusual for /health but shouldn't be reported as 'running'.
    return {
      status: "stopped",
      endpoint,
      error: `HTTP ${resp.status}`,
    };
  }

  // 200 OK — try to extract pid/uptime if the daemon provides them.
  let parsed: Record<string, unknown> = {};
  try {
    parsed = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    // Non-JSON 200 still means 'running' — just no extra fields.
    parsed = {};
  }
  const pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
  const uptimeSeconds = typeof parsed.uptime === "number"
    ? parsed.uptime
    : typeof parsed.uptimeSeconds === "number"
    ? parsed.uptimeSeconds
    : undefined;

  return {
    status: "running",
    endpoint,
    pid,
    uptimeSeconds,
  };
}

// ─── Helpers ───────────────────────────────────────────────────

async function statExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the trailing ~256 bytes of `logPath` and look for an
 * `EXIT_CODE=N` marker (SPEC §13.4, §15.4). The shell wrapper in
 * `lib/actions.ts` appends this line on every action; finding it
 * proves the process exited normally and tells us the outcome.
 *
 * Returns:
 *   - the parsed exit code when the marker is found
 *   - `-1` when the marker is absent (treat as abnormal termination,
 *     e.g. `kill -9` or a crash before the wrapper could append)
 *   - `-1` when the file is missing or unreadable for any reason
 */
async function productionReadExitCodeFromLog(logPath: string): Promise<number> {
  try {
    const file = await Deno.open(logPath, { read: true });
    try {
      const stat = await file.stat();
      const start = Math.max(0, Number(stat.size) - 256);
      if (start > 0) {
        await file.seek(start, Deno.SeekMode.Start);
      }
      const buf = new Uint8Array(256);
      const n = (await file.read(buf)) ?? 0;
      const tail = new TextDecoder().decode(buf.subarray(0, n));
      const m = /EXIT_CODE=(-?\d+)\s*$/m.exec(tail);
      if (!m) return -1;
      const code = parseInt(m[1], 10);
      return Number.isFinite(code) ? code : -1;
    } finally {
      file.close();
    }
  } catch {
    // Missing file / read error: treat as abnormal termination per
    // SPEC §13.4 (no EXIT_CODE ⇒ assume kill -9 etc.).
    return -1;
  }
}

// ─── Fallbacks ─────────────────────────────────────────────────

function fallbackStatus(message: string): IndexStatus {
  return {
    totalDocs: 0,
    totalCollections: 0,
    dbSizeBytes: 0,
    modelCacheBytes: 0,
    error: message,
  };
}

function fallbackDaemon(config: Config, message: string): DaemonState {
  return {
    status: "stopped",
    endpoint: config.qmd.daemon_url,
    error: message,
  };
}

// ─── Default sources ───────────────────────────────────────────

const PRODUCTION_SOURCES: StateSources = {
  readCollections: productionReadCollections,
  readIndexStatus: productionReadIndexStatus,
  probeDaemon: productionProbeDaemon,
  readJobPidFiles: productionReadJobPidFiles,
  readRecentFailures: productionReadRecentFailures,
  isProcessAlive: productionIsProcessAlive,
  readExitCodeFromLog: productionReadExitCodeFromLog,
  appendFailure: productionAppendFailure,
  deleteJobPidFile: productionDeleteJobPidFile,
};

// ─── Public API ────────────────────────────────────────────────

/**
 * Read the current operational state by composing five independent
 * sources (SPEC §3.2, §5.2, §8). Each source is wrapped in its own
 * try/catch so a single failure can't take down the whole poll;
 * `readCurrentState` itself MUST NOT throw.
 *
 * Pass `sources` to inject test doubles. Any omitted fields fall back
 * to the production implementations.
 */
export async function readCurrentState(
  config: Config,
  sources: Partial<StateSources> = {},
): Promise<CurrentState> {
  const s: StateSources = {
    readCollections: sources.readCollections ??
      PRODUCTION_SOURCES.readCollections,
    readIndexStatus: sources.readIndexStatus ??
      PRODUCTION_SOURCES.readIndexStatus,
    probeDaemon: sources.probeDaemon ?? PRODUCTION_SOURCES.probeDaemon,
    readJobPidFiles: sources.readJobPidFiles ??
      PRODUCTION_SOURCES.readJobPidFiles,
    readRecentFailures: sources.readRecentFailures ??
      PRODUCTION_SOURCES.readRecentFailures,
    isProcessAlive: sources.isProcessAlive ??
      PRODUCTION_SOURCES.isProcessAlive,
    readExitCodeFromLog: sources.readExitCodeFromLog ??
      PRODUCTION_SOURCES.readExitCodeFromLog,
    appendFailure: sources.appendFailure ?? PRODUCTION_SOURCES.appendFailure,
    deleteJobPidFile: sources.deleteJobPidFile ??
      PRODUCTION_SOURCES.deleteJobPidFile,
  };

  // Each subroutine gets its own error boundary. We deliberately use
  // Promise.allSettled-style sequential awaits here (rather than
  // Promise.all) so a single rejection can't accidentally short-circuit
  // the others if upstream code ever rewires this.
  //
  // The five subroutines are run in parallel for poll-time speed (the
  // SDK reads typically dominate); failures are isolated per-branch.
  const [
    collectionsResult,
    statusResult,
    daemonResult,
    jobsResult,
    failuresResult,
  ] = await Promise.allSettled([
    s.readCollections(config),
    s.readIndexStatus(config),
    s.probeDaemon(config),
    s.readJobPidFiles(),
    s.readRecentFailures(),
  ]);

  let collections: CollectionState[];
  if (collectionsResult.status === "fulfilled") {
    collections = collectionsResult.value;
  } else {
    collections = [];
    await logError(
      "state",
      "readCollections failed",
      collectionsResult.reason instanceof Error
        ? collectionsResult.reason
        : new Error(String(collectionsResult.reason)),
    );
  }

  let status: IndexStatus;
  if (statusResult.status === "fulfilled") {
    status = statusResult.value;
  } else {
    const msg = statusResult.reason instanceof Error
      ? statusResult.reason.message
      : String(statusResult.reason);
    status = fallbackStatus(msg);
    await logError(
      "state",
      "readIndexStatus failed",
      statusResult.reason instanceof Error
        ? statusResult.reason
        : new Error(msg),
    );
  }

  let daemon: DaemonState;
  if (daemonResult.status === "fulfilled") {
    daemon = daemonResult.value;
  } else {
    const msg = daemonResult.reason instanceof Error
      ? daemonResult.reason.message
      : String(daemonResult.reason);
    daemon = fallbackDaemon(config, msg);
    await logError(
      "state",
      "probeDaemon failed",
      daemonResult.reason instanceof Error
        ? daemonResult.reason
        : new Error(msg),
    );
  }

  let rawJobs: JobInfo[];
  if (jobsResult.status === "fulfilled") {
    rawJobs = jobsResult.value;
  } else {
    rawJobs = [];
    await logError(
      "state",
      "readJobPidFiles failed",
      jobsResult.reason instanceof Error
        ? jobsResult.reason
        : new Error(String(jobsResult.reason)),
    );
  }

  // ── Completion detection (SPEC §13.4 / §13.5) ───────────────
  //
  // For each PID file we just loaded, check whether the underlying
  // process is still alive. Live jobs stay in inFlightJobs. Dead
  // jobs are demoted: read the log tail for `EXIT_CODE=N`, append a
  // FailureRecord when the code is non-zero, then delete the PID
  // file so the next poll doesn't see a stale entry.
  //
  // Failures inside this loop are isolated per-job: one job's
  // appendFailure throwing must not stop us from cleaning up the
  // next job's PID file. The loop itself swallows everything to
  // honour readCurrentState's never-throw contract.
  const inFlightJobs: JobInfo[] = [];
  for (const job of rawJobs) {
    let alive = false;
    try {
      alive = s.isProcessAlive(job.pid);
    } catch (err) {
      await logError(
        "state",
        `isProcessAlive failed for pid=${job.pid}`,
        err instanceof Error ? err : new Error(String(err)),
      );
      // If we can't tell, assume alive — better to under-clean than to
      // wrongly record a phantom failure on a job that's still running.
      alive = true;
    }
    if (alive) {
      inFlightJobs.push(job);
      continue;
    }
    // Dead: read exit code, record failure if non-zero, delete PID.
    let exitCode = -1;
    try {
      exitCode = await s.readExitCodeFromLog(job.logPath);
    } catch (err) {
      await logError(
        "state",
        `readExitCodeFromLog failed for ${job.logPath}`,
        err instanceof Error ? err : new Error(String(err)),
      );
      exitCode = -1;
    }
    if (exitCode !== 0) {
      try {
        await s.appendFailure({
          action: job.action,
          collection: job.collection,
          failedAt: new Date(),
          exitCode,
          logPath: job.logPath,
        });
      } catch (err) {
        await logError(
          "state",
          `appendFailure failed for ${job.action}${
            job.collection ? `:${job.collection}` : ""
          }`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
    try {
      await s.deleteJobPidFile(job.action, job.collection);
    } catch (err) {
      await logError(
        "state",
        `deleteJobPidFile failed for ${job.action}${
          job.collection ? `:${job.collection}` : ""
        }`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  let recentFailures: FailureRecord[];
  if (failuresResult.status === "fulfilled") {
    recentFailures = failuresResult.value;
  } else {
    recentFailures = [];
    await logError(
      "state",
      "readRecentFailures failed",
      failuresResult.reason instanceof Error
        ? failuresResult.reason
        : new Error(String(failuresResult.reason)),
    );
  }

  return {
    collections,
    status,
    daemon,
    inFlightJobs,
    recentFailures,
    polledAt: new Date(),
  };
}

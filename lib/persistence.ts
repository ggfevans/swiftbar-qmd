import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type {
  ActionId,
  CollectionState,
  DaemonState,
  FailureRecord,
  JobInfo,
  LogFileInfo,
  PollSnapshot,
  Tier,
} from "./types.ts";
import { logError } from "./log.ts";

// ─── Paths ─────────────────────────────────────────────────────

/**
 * Cache directory root for swiftbar-qmd state. Defaults to
 * `~/.cache/swiftbar-qmd`. Tests can override by setting
 * `SWIFTBAR_QMD_CACHE_DIR` before invoking persistence functions.
 *
 * The env var is read on every call (not at module load) so tests
 * can mutate the environment without re-importing the module.
 */
export function cacheDir(): string {
  const override = Deno.env.get("SWIFTBAR_QMD_CACHE_DIR");
  if (override && override.length > 0) return override;
  const home = Deno.env.get("HOME") ?? "";
  return `${home}/.cache/swiftbar-qmd`;
}

/**
 * Convenience getter for callers that prefer a fixed reference.
 * Always delegates to cacheDir() to ensure consistent env var handling.
 */
export function CACHE_DIR(): string {
  return cacheDir();
}

function snapshotPath(): string {
  return join(cacheDir(), "last-poll.json");
}

function snapshotTmpPath(): string {
  return join(cacheDir(), "last-poll.json.tmp");
}

function jobsDir(): string {
  return join(cacheDir(), "jobs");
}

/**
 * Default logs directory: `${cacheDir()}/logs`.
 *
 * Callers (`runAction` in lib/actions.ts, the poll loop in qmd.30s.ts)
 * that want to honour `config.logs.directory` should resolve the
 * configured path themselves and pass it explicitly to the log-
 * directory APIs below — `cacheDir() + /logs` is only the fallback
 * when no override is supplied. See PR #1 D5.
 */
function logsDir(): string {
  return join(cacheDir(), "logs");
}

/**
 * Resolve a logs directory: prefer the explicit `override` when
 * non-empty; otherwise fall back to `${cacheDir()}/logs`. Exported
 * so callers can derive the directory the same way the persistence
 * APIs do, and so tests can assert the fallback behaviour.
 */
export function resolveLogsDir(override?: string | null): string {
  if (override && override.length > 0) return override;
  return logsDir();
}

function sentinelsDir(): string {
  return join(cacheDir(), "sentinels");
}

function failuresPath(): string {
  return join(cacheDir(), "recent-failures.json");
}

// ─── Filename helpers ──────────────────────────────────────────

/**
 * Compose the pid filename for a job. Per-collection jobs include
 * the collection name (colon-separated). Plain actions use just the
 * action id.
 */
function jobFileName(action: ActionId, collection?: string | null): string {
  if (collection && collection.length > 0) {
    return `${action}:${collection}.pid`;
  }
  return `${action}.pid`;
}

/**
 * Parse a log filename of the form
 *   <action>-<timestamp>.log
 *   <action>:<collection>-<timestamp>.log
 *
 * Where `<timestamp>` is the dash-free ISO form produced by
 * `buildLogPath()`, e.g. `20260517T120000000Z`.
 *
 * Returns the action+collection group key (everything before the
 * final timestamp segment) or null if the name doesn't match.
 *
 * The previous implementation used `stem.lastIndexOf("-")`, which
 * silently landed inside the action id (`update-all`, `embed-
 * collection`) when the timestamp itself had no dashes, and worse,
 * landed inside a dashed ISO timestamp like `2026-05-17T...`. Now
 * we anchor on a strict "digits-T-digits-Z" suffix so the boundary
 * is unambiguous regardless of how many dashes the action id has.
 *
 * See PR #1 finding A3.
 */
const LOG_TIMESTAMP_SUFFIX = /-(\d+T\d+Z?)$/;

function parseLogFileName(
  name: string,
): { group: string; action: ActionId } | null {
  if (!name.endsWith(".log")) return null;
  const stem = name.slice(0, -".log".length);

  // Strip the trailing `-<digits>T<digits>Z?` timestamp segment, then
  // everything before it is the action[:collection] group.
  const m = stem.match(LOG_TIMESTAMP_SUFFIX);
  if (!m) return null;
  const group = stem.slice(0, m.index);
  if (group.length === 0) return null;

  const action = group.includes(":")
    ? group.slice(0, group.indexOf(":"))
    : group;

  // The known ActionId universe — coarse check so we don't return
  // garbage groups when the directory contains stray files.
  const KNOWN_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>([
    "update-all",
    "embed-all",
    "update-collection",
    "embed-collection",
    "force-reembed-collection",
    "restart-daemon",
    "stop-daemon",
    "start-daemon",
    "cleanup",
    "recheck",
  ]);
  if (!KNOWN_ACTIONS.has(action as ActionId)) return null;

  return { group, action: action as ActionId };
}

// ─── Atomic I/O helpers ────────────────────────────────────────

async function ensureCacheDir(): Promise<void> {
  await ensureDir(cacheDir());
}

async function ensureJobsDir(): Promise<void> {
  await ensureDir(jobsDir());
}

async function ensureLogsDir(dir: string = logsDir()): Promise<void> {
  await ensureDir(dir);
}

async function ensureSentinelsDir(): Promise<void> {
  await ensureDir(sentinelsDir());
}

/** True if the error indicates a missing file/directory. */
function isNotFound(err: unknown): boolean {
  return err instanceof Deno.errors.NotFound;
}

// ─── Snapshot ──────────────────────────────────────────────────

/**
 * Hydrate a parsed snapshot. PollSnapshot.pollTimestamp is declared
 * as `string` in our types (SPEC §15.1 stores it as ISO). Nested
 * `DaemonState`/`CollectionState`/`FailureRecord` have no Date
 * fields in our schema (lastModified can be null/string). To stay
 * faithful to the on-disk format, we deserialise as-is and leave
 * date-like fields as strings for downstream consumers that
 * compute relative timestamps from them.
 *
 * However, `CollectionState.lastModified` is typed as `Date | null`
 * (lib/types.ts). For consistency with the in-memory model we
 * hydrate that single field explicitly.
 */
function hydrateSnapshot(raw: unknown): PollSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  // Required fields — fail soft (return null) on shape mismatch.
  if (typeof obj.pollTimestamp !== "string") return null;
  if (!obj.daemon || typeof obj.daemon !== "object") return null;
  if (!Array.isArray(obj.collections)) return null;
  if (!Array.isArray(obj.recentOpFailures)) return null;
  if (typeof obj.computedTier !== "string") return null;
  if (!Array.isArray(obj.tierDrivers)) return null;
  if (
    !obj.recentlyNotified ||
    typeof obj.recentlyNotified !== "object" ||
    Array.isArray(obj.recentlyNotified)
  ) {
    return null;
  }
  if (typeof obj.consecutiveReadFailures !== "number") return null;

  const collections = (obj.collections as Array<Record<string, unknown>>).map(
    (c): CollectionState => {
      const lastModRaw = c.lastModified;
      const lastModified = typeof lastModRaw === "string"
        ? new Date(lastModRaw)
        : null;
      return {
        name: String(c.name ?? ""),
        path: String(c.path ?? ""),
        qmdUri: String(c.qmdUri ?? ""),
        pattern: String(c.pattern ?? ""),
        reachable: Boolean(c.reachable),
        docCount: Number(c.docCount ?? 0),
        coveragePercent: Number(c.coveragePercent ?? 0),
        lastModified,
        hasObsidian: Boolean(c.hasObsidian),
        error: typeof c.error === "string" ? c.error : undefined,
      };
    },
  );

  const recentOpFailures =
    (obj.recentOpFailures as Array<Record<string, unknown>>).map(
      (f): FailureRecord => ({
        action: String(f.action ?? "") as ActionId,
        collection: typeof f.collection === "string" ? f.collection : undefined,
        failedAt: typeof f.failedAt === "string"
          ? new Date(f.failedAt)
          : new Date(0),
        exitCode: Number(f.exitCode ?? 0),
        logPath: String(f.logPath ?? ""),
      }),
    );

  const daemon = obj.daemon as Record<string, unknown>;
  const daemonState: DaemonState = {
    status: (daemon.status === "running" ||
        daemon.status === "stopped" ||
        daemon.status === "unresponsive")
      ? daemon.status
      : "stopped",
    pid: typeof daemon.pid === "number" ? daemon.pid : undefined,
    uptimeSeconds: typeof daemon.uptimeSeconds === "number"
      ? daemon.uptimeSeconds
      : undefined,
    endpoint: String(daemon.endpoint ?? ""),
    error: typeof daemon.error === "string" ? daemon.error : undefined,
  };

  const recentlyNotified: Record<string, string> = {};
  for (
    const [k, v] of Object.entries(
      obj.recentlyNotified as Record<string, unknown>,
    )
  ) {
    if (typeof v === "string") recentlyNotified[k] = v;
  }

  // In-flight jobs were added in step 14 (PollSnapshot.inFlightJobs).
  // Older snapshots written before this field existed simply lack it;
  // treat as an empty array so the first post-upgrade poll behaves as
  // if nothing was in flight (the next poll will populate the field).
  const inFlightJobs: JobInfo[] = [];
  if (Array.isArray(obj.inFlightJobs)) {
    for (const raw of obj.inFlightJobs as Array<Record<string, unknown>>) {
      if (
        typeof raw.action !== "string" ||
        typeof raw.pid !== "number" ||
        typeof raw.startedAt !== "string" ||
        !Array.isArray(raw.command) ||
        typeof raw.logPath !== "string"
      ) {
        continue;
      }
      inFlightJobs.push({
        action: raw.action as ActionId,
        collection: typeof raw.collection === "string"
          ? raw.collection
          : undefined,
        pid: raw.pid,
        startedAt: new Date(raw.startedAt),
        command: (raw.command as unknown[]).map((s) => String(s)),
        logPath: raw.logPath,
      });
    }
  }

  const snapshot: PollSnapshot = {
    pollTimestamp: obj.pollTimestamp,
    daemon: daemonState,
    collections,
    recentOpFailures,
    inFlightJobs,
    computedTier: obj.computedTier as Tier,
    tierDrivers: (obj.tierDrivers as unknown[]).map((s) => String(s)),
    recentlyNotified,
    consecutiveReadFailures: obj.consecutiveReadFailures,
  };

  return snapshot;
}

/**
 * Read the most recent poll snapshot from `last-poll.json`. Returns
 * `null` if the file is missing or unreadable; never throws.
 */
export async function readSnapshot(): Promise<PollSnapshot | null> {
  await ensureCacheDir();
  let text: string;
  try {
    text = await Deno.readTextFile(snapshotPath());
  } catch (err) {
    if (isNotFound(err)) return null;
    await logError(
      "persistence",
      `readSnapshot: read failed`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    await logError(
      "persistence",
      `readSnapshot: JSON parse failed`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return null;
  }

  return hydrateSnapshot(parsed);
}

/**
 * Write a snapshot atomically. Writes to `last-poll.json.tmp`, then
 * renames into place. Date fields serialise via `JSON.stringify`'s
 * default (ISO strings).
 */
export async function writeSnapshot(snapshot: PollSnapshot): Promise<void> {
  await ensureCacheDir();
  const json = JSON.stringify(snapshot, null, 2);
  await Deno.writeTextFile(snapshotTmpPath(), json);
  await Deno.rename(snapshotTmpPath(), snapshotPath());
}

// ─── Job PID files ─────────────────────────────────────────────

/** Read all in-flight job pid files. Missing dir → empty array. */
export async function readJobPidFiles(): Promise<JobInfo[]> {
  await ensureJobsDir();
  const dir = jobsDir();
  const out: JobInfo[] = [];

  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const e of Deno.readDir(dir)) entries.push(e);
  } catch (err) {
    if (isNotFound(err)) return out;
    await logError(
      "persistence",
      `readJobPidFiles: readDir failed`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return out;
  }

  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".pid")) continue;
    const full = join(dir, entry.name);
    let text: string;
    try {
      text = await Deno.readTextFile(full);
    } catch (err) {
      if (isNotFound(err)) continue;
      await logError(
        "persistence",
        `readJobPidFiles: read failed for ${entry.name}`,
        err instanceof Error ? err : new Error(String(err)),
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const raw = parsed as Record<string, unknown>;
    if (
      typeof raw.action !== "string" ||
      typeof raw.pid !== "number" ||
      typeof raw.startedAt !== "string" ||
      !Array.isArray(raw.command) ||
      typeof raw.logPath !== "string"
    ) {
      continue;
    }
    out.push({
      action: raw.action as ActionId,
      collection: typeof raw.collection === "string"
        ? raw.collection
        : undefined,
      pid: raw.pid,
      startedAt: new Date(raw.startedAt),
      command: (raw.command as unknown[]).map((s) => String(s)),
      logPath: raw.logPath,
    });
  }

  return out;
}

/**
 * Read a single pid file by action (+ optional collection). Returns
 * `null` when the file is missing or unparseable. Used by the action
 * runner's locking check (SPEC §13.3) — we need a per-key fetch, not
 * the directory scan that `readJobPidFiles` performs.
 */
export async function readJobPidFile(
  action: ActionId,
  collection?: string,
): Promise<JobInfo | null> {
  await ensureJobsDir();
  const path = join(jobsDir(), jobFileName(action, collection));
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    await logError(
      "persistence",
      `readJobPidFile: read failed for ${path}`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  if (
    typeof raw.action !== "string" ||
    typeof raw.pid !== "number" ||
    typeof raw.startedAt !== "string" ||
    !Array.isArray(raw.command) ||
    typeof raw.logPath !== "string"
  ) {
    return null;
  }
  return {
    action: raw.action as ActionId,
    collection: typeof raw.collection === "string" ? raw.collection : undefined,
    pid: raw.pid,
    startedAt: new Date(raw.startedAt),
    command: (raw.command as unknown[]).map((s) => String(s)),
    logPath: raw.logPath,
  };
}

/**
 * Write a pid file for an in-flight job. Per SPEC §15.3, `collection`
 * is serialised as `null` (not omitted) when absent. The filename is
 * `<action>.pid` or `<action>:<collection>.pid`.
 */
export async function writeJobPidFile(
  action: ActionId,
  info: JobInfo,
): Promise<void> {
  await ensureJobsDir();
  const payload = {
    action,
    collection: info.collection ?? null,
    pid: info.pid,
    startedAt: info.startedAt.toISOString(),
    command: info.command,
    logPath: info.logPath,
  };
  const path = join(jobsDir(), jobFileName(action, info.collection));
  await Deno.writeTextFile(path, JSON.stringify(payload, null, 2));
}

/**
 * Delete the pid file for a job. Optional `collection` selects the
 * per-collection variant. Missing file is not an error.
 *
 * Note: SPEC §5.2 lists the signature as `(action: ActionId)`. We
 * extend with an optional `collection` argument because per-collection
 * jobs have distinct filenames; without it, the caller has no way to
 * target the right file. The extension is backward-compatible.
 */
export async function deleteJobPidFile(
  action: ActionId,
  collection?: string,
): Promise<void> {
  await ensureJobsDir();
  const path = join(jobsDir(), jobFileName(action, collection));
  try {
    await Deno.remove(path);
  } catch (err) {
    if (isNotFound(err)) return;
    await logError(
      "persistence",
      `deleteJobPidFile: remove failed for ${path}`,
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

// ─── Recent failures ───────────────────────────────────────────

const MAX_FAILURES = 50;

async function readFailuresRaw(): Promise<FailureRecord[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(failuresPath());
  } catch (err) {
    if (isNotFound(err)) return [];
    await logError(
      "persistence",
      `readRecentFailures: read failed`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    await logError(
      "persistence",
      `readRecentFailures: JSON parse failed`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: FailureRecord[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (
      typeof r.action !== "string" ||
      typeof r.failedAt !== "string" ||
      typeof r.exitCode !== "number" ||
      typeof r.logPath !== "string"
    ) continue;
    out.push({
      action: r.action as ActionId,
      collection: typeof r.collection === "string" ? r.collection : undefined,
      failedAt: new Date(r.failedAt),
      exitCode: r.exitCode,
      logPath: r.logPath,
    });
  }
  return out;
}

/** Read recent failures, newest-first, capped at 50. */
export async function readRecentFailures(): Promise<FailureRecord[]> {
  await ensureCacheDir();
  return await readFailuresRaw();
}

/**
 * Prepend a failure to the recent-failures list, then truncate to
 * the most recent 50 entries. Newest first.
 */
export async function appendFailure(failure: FailureRecord): Promise<void> {
  await ensureCacheDir();
  const current = await readFailuresRaw();
  current.unshift(failure);
  const trimmed = current.slice(0, MAX_FAILURES);
  const json = JSON.stringify(
    trimmed.map((f) => ({
      action: f.action,
      collection: f.collection ?? null,
      failedAt: f.failedAt.toISOString(),
      exitCode: f.exitCode,
      logPath: f.logPath,
    })),
    null,
    2,
  );
  await Deno.writeTextFile(failuresPath(), json);
}

/**
 * Drop failure entries older than `hours` from the persisted list.
 * Writes the truncated array back to disk.
 */
export async function pruneFailuresOlderThan(hours: number): Promise<void> {
  await ensureCacheDir();
  const current = await readFailuresRaw();
  const cutoffMs = Date.now() - hours * 60 * 60 * 1000;
  const kept = current.filter((f) => f.failedAt.getTime() >= cutoffMs);

  if (kept.length === current.length) return; // nothing to do

  const json = JSON.stringify(
    kept.map((f) => ({
      action: f.action,
      collection: f.collection ?? null,
      failedAt: f.failedAt.toISOString(),
      exitCode: f.exitCode,
      logPath: f.logPath,
    })),
    null,
    2,
  );
  await Deno.writeTextFile(failuresPath(), json);
}

// ─── Logs directory ────────────────────────────────────────────

/**
 * List log files in `logs/` with parsed action prefix and stat info.
 * Files that don't match the `<action>[:collection]-<ts>.log` pattern
 * are skipped. Missing dir → empty array.
 *
 * `logsDirOverride` lets callers honour `config.logs.directory` (PR
 * #1 D5). Falls back to `${cacheDir()}/logs` when null/empty.
 */
export async function logsDirContents(
  logsDirOverride?: string | null,
): Promise<LogFileInfo[]> {
  const dir = resolveLogsDir(logsDirOverride);
  await ensureLogsDir(dir);
  const out: LogFileInfo[] = [];

  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const e of Deno.readDir(dir)) entries.push(e);
  } catch (err) {
    if (isNotFound(err)) return out;
    await logError(
      "persistence",
      `logsDirContents: readDir failed`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return out;
  }

  for (const entry of entries) {
    if (!entry.isFile) continue;
    const parsed = parseLogFileName(entry.name);
    if (!parsed) continue;
    const full = join(dir, entry.name);
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(full);
    } catch {
      continue;
    }
    out.push({
      action: parsed.action,
      path: full,
      createdAt: stat.mtime ?? new Date(0),
      sizeBytes: stat.size,
    });
  }

  return out;
}

/**
 * For each action[:collection] group in `logs/`, keep only the most
 * recent `retainPerAction` files (by mtime) and delete the rest.
 * `retainPerAction <= 0` deletes everything matching a known action.
 *
 * `logsDirOverride` lets callers honour `config.logs.directory` (PR
 * #1 D5). Falls back to `${cacheDir()}/logs` when null/empty.
 */
export async function pruneLogs(
  retainPerAction: number,
  logsDirOverride?: string | null,
): Promise<void> {
  const dir = resolveLogsDir(logsDirOverride);
  await ensureLogsDir(dir);

  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const e of Deno.readDir(dir)) entries.push(e);
  } catch (err) {
    if (isNotFound(err)) return;
    await logError(
      "persistence",
      `pruneLogs: readDir failed`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return;
  }

  type Entry = { name: string; full: string; group: string; mtimeMs: number };
  const grouped = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const parsed = parseLogFileName(entry.name);
    if (!parsed) continue;
    const full = join(dir, entry.name);
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(full);
    } catch {
      continue;
    }
    const mtimeMs = stat.mtime ? stat.mtime.getTime() : 0;
    const arr = grouped.get(parsed.group) ?? [];
    arr.push({ name: entry.name, full, group: parsed.group, mtimeMs });
    grouped.set(parsed.group, arr);
  }

  for (const [, arr] of grouped) {
    arr.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toDelete = retainPerAction > 0 ? arr.slice(retainPerAction) : arr;
    for (const e of toDelete) {
      try {
        await Deno.remove(e.full);
      } catch (err) {
        if (isNotFound(err)) continue;
        await logError(
          "persistence",
          `pruneLogs: remove failed for ${e.full}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
  }
}

// ─── Sentinels ─────────────────────────────────────────────────

/**
 * Ensure every subdirectory under CACHE_DIR exists. Called by main()
 * once per invocation so future writes (sentinels, jobs, logs) succeed
 * without per-call mkdir overhead.
 *
 * Sentinels themselves are managed by Prompt 14 (recheck action); we
 * just create the directory.
 */
export async function ensureCacheTree(): Promise<void> {
  await ensureCacheDir();
  await ensureJobsDir();
  await ensureLogsDir();
  await ensureSentinelsDir();
}

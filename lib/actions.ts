import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { ActionId, JobInfo } from "./types.ts";
import {
  cacheDir,
  readJobPidFile as productionReadJobPidFile,
  writeJobPidFile as productionWriteJobPidFile,
} from "./persistence.ts";
import { logError, logInfo } from "./log.ts";

// ─── Validation ────────────────────────────────────────────────

/**
 * Allowed shape for collection names that are interpolated into shell
 * commands. Mirrors `SAFE_COLLECTION_NAME` in lib/menu.ts. Defined
 * here too so the runner can defend itself without importing the
 * rendering module.
 */
const SAFE_COLLECTION_NAME = /^[A-Za-z0-9_.-]+$/;

/** Per-collection actions require a `collection` arg. */
const PER_COLLECTION_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>([
  "update-collection",
  "embed-collection",
  "force-reembed-collection",
  "show-context",
]);

// ─── DI seam ───────────────────────────────────────────────────

/**
 * Injection seam for `runAction`. Mirrors the DI patterns used in
 * `lib/state.ts` / `lib/detect.ts`: every external effect is a
 * dependency so tests can mock without touching the filesystem,
 * spawning processes, or invoking osascript.
 */
export type ActionDeps = {
  readJobPidFile: (
    action: ActionId,
    collection?: string,
  ) => Promise<JobInfo | null>;
  writeJobPidFile: (action: ActionId, info: JobInfo) => Promise<void>;
  /** Spawn the command detached, returning the background PID. */
  spawnDetached: (commandString: string, logPath: string) => Promise<number>;
  /** True if the PID is still alive. SIGCONT probe in production. */
  isProcessAlive: (pid: number) => boolean;
  /** Touch a sentinel file under `${CACHE_DIR}/sentinels/`. */
  touchSentinel: (name: string) => Promise<void>;
  /** Capture the output of `qmd context list -c <name>`. */
  runQmdContextList: (collection: string) => Promise<string>;
  /** Display the qmd-context output via osascript. Blocks until OK. */
  showContextDialog: (collection: string, output: string) => Promise<void>;
  /** Exit the runner cleanly. Tests record the call instead of exiting. */
  exit: (code: number) => void;
};

// ─── Production deps ───────────────────────────────────────────

/**
 * Spawn `commandString` detached via the SPEC §13.2 wrapper. stdout
 * yields the background PID (the trailing `echo $!`). Stderr is
 * discarded — anything written to stderr inside the wrapped command
 * is captured in the log file via `2>&1`.
 */
async function productionSpawnDetached(
  commandString: string,
  logPath: string,
): Promise<number> {
  await ensureDir(join(cacheDir(), "logs"));
  const shell =
    `( ${commandString}; echo "EXIT_CODE=$?" >> "${logPath}" ) >> "${logPath}" 2>&1 &\necho $!`;
  const proc = new Deno.Command("bash", {
    args: ["-c", shell],
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await proc.output();
  const pid = parseInt(new TextDecoder().decode(stdout).trim(), 10);
  return pid;
}

/**
 * SIGCONT probe per SPEC §13.5. SIGCONT is harmless to a running
 * process (continues it if stopped, no-op otherwise). `Deno.kill`
 * throws `NotFound` / `PermissionDenied` for dead/foreign PIDs.
 */
function productionIsProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

/**
 * Write/touch a sentinel file under `${CACHE_DIR}/sentinels/`. The
 * value is the current ISO timestamp so consumers can see how stale
 * the request is; the file's existence is the trigger.
 */
async function productionTouchSentinel(name: string): Promise<void> {
  const dir = join(cacheDir(), "sentinels");
  await ensureDir(dir);
  await Deno.writeTextFile(join(dir, name), new Date().toISOString());
}

/**
 * Run `qmd context list -c <name>` synchronously and return stdout.
 * Errors are logged and an empty string is returned so the dialog
 * still opens with a "no context" message rather than the runner
 * crashing.
 */
async function productionRunQmdContextList(
  collection: string,
): Promise<string> {
  try {
    const proc = new Deno.Command("qmd", {
      args: ["context", "list", "-c", collection],
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout, stderr, code } = await proc.output();
    if (code !== 0) {
      const errText = new TextDecoder().decode(stderr).trim();
      await logError(
        "actions",
        `runQmdContextList: qmd exited ${code} for "${collection}": ${errText}`,
      );
    }
    return new TextDecoder().decode(stdout);
  } catch (err) {
    await logError(
      "actions",
      `runQmdContextList: failed to spawn qmd for "${collection}"`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return "";
  }
}

/** AppleScript-escape a string for embedding inside double quotes. */
function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Show the qmd-context output via `osascript -e 'display dialog ...'`.
 * Long outputs are truncated to ~10 KB to keep the dialog tractable
 * (osascript has a hard limit on argument length).
 */
async function productionShowContextDialog(
  collection: string,
  output: string,
): Promise<void> {
  const MAX = 10_000;
  const body = output.length > MAX
    ? output.slice(0, MAX) + "\n…(truncated)"
    : output;
  const safeBody = escapeForAppleScript(body || "(no context available)");
  const safeTitle = escapeForAppleScript(`qmd context — ${collection}`);
  const script =
    `display dialog "${safeBody}" with title "${safeTitle}" buttons {"OK"} default button "OK"`;

  try {
    const proc = new Deno.Command("osascript", {
      args: ["-e", script],
      stdout: "null",
      stderr: "null",
    });
    await proc.output();
  } catch (err) {
    await logError(
      "actions",
      `showContextDialog: osascript failed for "${collection}"`,
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

const PRODUCTION_DEPS: ActionDeps = {
  readJobPidFile: productionReadJobPidFile,
  writeJobPidFile: productionWriteJobPidFile,
  spawnDetached: productionSpawnDetached,
  isProcessAlive: productionIsProcessAlive,
  touchSentinel: productionTouchSentinel,
  runQmdContextList: productionRunQmdContextList,
  showContextDialog: productionShowContextDialog,
  exit: (code) => Deno.exit(code),
};

// ─── Command construction ──────────────────────────────────────

type CommandSpec = {
  /** argv-shaped command, recorded into the PID file's `command` field. */
  argv: string[];
  /** Flattened shell string passed to `bash -c`. */
  shell: string;
};

/**
 * Build the SPEC §5.2 command for an action. Returns `null` for
 * actions that don't spawn (recheck, show-context) or when the args
 * fail validation.
 *
 * The shell string is constructed only from SPEC-fixed argv plus an
 * already-validated collection name; no other user input is
 * interpolated. The argv form is what we persist into the PID file.
 */
function buildCommand(
  id: ActionId,
  collection: string | undefined,
): CommandSpec | null {
  switch (id) {
    case "update-all":
      return { argv: ["qmd", "update"], shell: "qmd update" };
    case "embed-all":
      return { argv: ["qmd", "embed"], shell: "qmd embed" };
    case "update-collection": {
      if (!collection) return null;
      return {
        argv: ["qmd", "update", "&&", "qmd", "embed", "-c", collection],
        shell: `qmd update && qmd embed -c ${collection}`,
      };
    }
    case "embed-collection": {
      if (!collection) return null;
      return {
        argv: ["qmd", "embed", "-c", collection],
        shell: `qmd embed -c ${collection}`,
      };
    }
    case "force-reembed-collection": {
      if (!collection) return null;
      return {
        argv: ["qmd", "embed", "-c", collection, "-f"],
        shell: `qmd embed -c ${collection} -f`,
      };
    }
    case "restart-daemon":
      return {
        argv: ["qmd", "mcp", "stop", "&&", "qmd", "mcp", "--http", "--daemon"],
        shell: "qmd mcp stop && qmd mcp --http --daemon",
      };
    case "stop-daemon":
      return { argv: ["qmd", "mcp", "stop"], shell: "qmd mcp stop" };
    case "start-daemon":
      return {
        argv: ["qmd", "mcp", "--http", "--daemon"],
        shell: "qmd mcp --http --daemon",
      };
    case "cleanup":
      return { argv: ["qmd", "cleanup"], shell: "qmd cleanup" };
    case "recheck":
    case "show-context":
      return null;
  }
}

/** Generate the log filename for this run. SPEC §15.3 timestamp form. */
function buildLogPath(
  id: ActionId,
  collection: string | undefined,
  now: Date,
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "");
  const key = collection ? `${id}:${collection}` : id;
  return join(cacheDir(), "logs", `${key}-${stamp}.log`);
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Execute the action identified by `id`. Per-collection actions
 * require `args.collection`. The runner:
 *
 *   1. Validates args (collection name shape, presence).
 *   2. Acquires the per-action (or per-action:collection) lock.
 *   3. Spawns the qmd command detached, writes a PID file.
 *
 * Recheck and show-context bypass spawn entirely:
 *   - recheck: touches `${CACHE_DIR}/sentinels/recheck` and returns.
 *   - show-context: runs `qmd context list -c <name>` synchronously
 *     and shows the output in an osascript dialog.
 *
 * Confirmation dialogs for `force-reembed-collection` and `cleanup`
 * (deferred to step 13: confirmation dialogs) are NOT implemented
 * here; the runner spawns those actions immediately. The menu layer
 * will gate them with a dialog in step 13.
 *
 * Completion detection (PID liveness, log-tail EXIT_CODE parsing,
 * failure notifications) (deferred to step 12: action completion +
 * in-flight UI) lives in the poll cycle, not the runner.
 *
 * Never throws. On invalid args or spawn failure, logs and returns.
 */
export async function runAction(
  id: ActionId,
  args: Record<string, string>,
  deps?: Partial<ActionDeps>,
): Promise<void> {
  const d: ActionDeps = {
    readJobPidFile: deps?.readJobPidFile ?? PRODUCTION_DEPS.readJobPidFile,
    writeJobPidFile: deps?.writeJobPidFile ?? PRODUCTION_DEPS.writeJobPidFile,
    spawnDetached: deps?.spawnDetached ?? PRODUCTION_DEPS.spawnDetached,
    isProcessAlive: deps?.isProcessAlive ?? PRODUCTION_DEPS.isProcessAlive,
    touchSentinel: deps?.touchSentinel ?? PRODUCTION_DEPS.touchSentinel,
    runQmdContextList: deps?.runQmdContextList ??
      PRODUCTION_DEPS.runQmdContextList,
    showContextDialog: deps?.showContextDialog ??
      PRODUCTION_DEPS.showContextDialog,
    exit: deps?.exit ?? PRODUCTION_DEPS.exit,
  };

  const collection = args.collection;

  // ── Recheck: write a sentinel and return. ─────────────────
  if (id === "recheck") {
    try {
      await d.touchSentinel("recheck");
    } catch (err) {
      await logError(
        "actions",
        "recheck: failed to touch sentinel",
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    return;
  }

  // ── Show-context: synchronous; no PID tracking. ───────────
  if (id === "show-context") {
    if (!collection || !SAFE_COLLECTION_NAME.test(collection)) {
      await logError(
        "actions",
        `show-context: missing or invalid collection (got "${
          collection ?? ""
        }")`,
      );
      return;
    }
    try {
      const output = await d.runQmdContextList(collection);
      await d.showContextDialog(collection, output);
    } catch (err) {
      await logError(
        "actions",
        `show-context: failed for "${collection}"`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    return;
  }

  // ── Per-collection arg validation. ────────────────────────
  if (PER_COLLECTION_ACTIONS.has(id)) {
    if (!collection) {
      await logError(
        "actions",
        `${id}: missing required "collection" arg`,
      );
      return;
    }
    if (!SAFE_COLLECTION_NAME.test(collection)) {
      await logError(
        "actions",
        `${id}: collection "${collection}" contains unsafe characters; refusing to spawn`,
      );
      return;
    }
  }

  // ── Build the command spec. ───────────────────────────────
  const spec = buildCommand(id, collection);
  if (!spec) {
    await logError(
      "actions",
      `${id}: unable to build command (collection=${collection ?? "—"})`,
    );
    return;
  }

  // ── Locking (SPEC §13.3). ─────────────────────────────────
  const existing = await d.readJobPidFile(id, collection);
  if (existing && d.isProcessAlive(existing.pid)) {
    await logInfo(
      "actions",
      `${id}${
        collection ? `:${collection}` : ""
      }: already running (pid=${existing.pid}); skipping spawn`,
    );
    d.exit(0);
    return;
  }
  // Stale PID handling (write/log on completion) is (deferred to
  // step 12: action completion + in-flight UI). For now, a dead PID
  // file simply gets overwritten by the spawn below.

  // ── Spawn detached and persist the PID. ───────────────────
  const startedAt = new Date();
  const logPath = buildLogPath(id, collection, startedAt);

  let pid: number;
  try {
    pid = await d.spawnDetached(spec.shell, logPath);
  } catch (err) {
    await logError(
      "actions",
      `${id}: spawn failed`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return;
  }

  if (!Number.isFinite(pid) || pid <= 0) {
    await logError(
      "actions",
      `${id}: spawn returned invalid pid (${pid})`,
    );
    return;
  }

  try {
    await d.writeJobPidFile(id, {
      action: id,
      collection,
      pid,
      startedAt,
      command: spec.argv,
      logPath,
    });
  } catch (err) {
    await logError(
      "actions",
      `${id}: writeJobPidFile failed`,
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

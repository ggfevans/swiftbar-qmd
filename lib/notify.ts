import type {
  ActionId,
  CollectionState,
  Config,
  CurrentState,
  JobInfo,
  NotificationEvent,
  PollSnapshot,
  TierReason,
} from "./types.ts";
import { compactDuration, relativeTime } from "./time.ts";
import { escapeForAppleScript } from "./actions.ts";
import { logError } from "./log.ts";

// ─── DI seam ───────────────────────────────────────────────────

/**
 * Injection seam for `emitNotifications`. The two production effects
 * we mock in tests are the osascript invocation and the "now" clock —
 * both make tests deterministic without touching the real system.
 */
export type NotifyDeps = {
  /** Fire a single notification via osascript. Never throws. */
  fireNotification: (
    title: string,
    subtitle: string,
    body: string,
  ) => Promise<void>;
  /** Current time (override in tests for deterministic dedupe timestamps). */
  now: () => Date;
};

// ─── Constants ─────────────────────────────────────────────────

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const NOTIFICATIONS_PER_POLL = 3;

// ─── Production deps ───────────────────────────────────────────

/**
 * Fire a single notification via `osascript`. Per SPEC §14.2. Both
 * stdout and stderr are discarded; failures are logged but never
 * propagate so a broken osascript invocation can't crash the poll.
 */
async function productionFireNotification(
  title: string,
  subtitle: string,
  body: string,
): Promise<void> {
  const script = `display notification "${
    escapeForAppleScript(body)
  }" with title "${escapeForAppleScript(title)}" subtitle "${
    escapeForAppleScript(subtitle)
  }"`;
  try {
    const proc = new Deno.Command("osascript", {
      args: ["-e", script],
      stdout: "null",
      stderr: "null",
    });
    await proc.output();
  } catch (err) {
    await logError(
      "notify",
      `fireNotification: osascript failed for "${title}"`,
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

const PRODUCTION_DEPS: NotifyDeps = {
  fireNotification: productionFireNotification,
  now: () => new Date(),
};

// ─── Action -> verb mapping ────────────────────────────────────

/**
 * Map an ActionId to the verb used in op-failure / job-complete copy.
 * "qmd <verb> failed" / "qmd <verb> completed". Mapping is per SPEC §14.3
 * notes; kept inline so callers don't need to import actionLabel from
 * lib/rollup.ts (which targets the status-driver labels — different
 * grammar).
 */
function actionVerb(action: ActionId): string {
  switch (action) {
    case "update-all":
    case "update-collection":
      return "update";
    case "embed-all":
    case "embed-collection":
    case "force-reembed-collection":
      return "embed";
    case "restart-daemon":
    case "start-daemon":
    case "stop-daemon":
      return "daemon";
    case "cleanup":
      return "cleanup";
    case "recheck":
      return "recheck";
    case "show-context":
      return "context";
  }
}

// ─── Dedupe keys (SPEC §14.1) ──────────────────────────────────

/**
 * Compute the dedupe key for an event. SPEC §14.1 specifies logPath as
 * part of the op-failure / job-complete keys. The NotificationEvent
 * type for job-complete doesn't carry logPath — `durationMs` substitutes
 * (each invocation produces a distinct duration, so two concurrent
 * runs of the same action would still get distinct keys provided their
 * runtimes differ).
 */
function dedupeKey(event: NotificationEvent): string {
  switch (event.kind) {
    case "daemon-crash":
      return "daemon-crash";
    case "op-failure":
      return `op-failure:${event.action}:${
        event.collection ?? "*"
      }:${event.logPath}`;
    case "path-unreachable":
      return `path-unreachable:${event.collection}`;
    case "job-complete":
      return `job-complete:${event.action}:${
        event.collection ?? "*"
      }:${event.durationMs}`;
    case "threshold-breach":
      return `threshold-breach:${event.metric}:${event.collection ?? "*"}`;
  }
}

// ─── Copy (SPEC §14.3) ─────────────────────────────────────────

type Copy = { title: string; subtitle: string; body: string };

/**
 * Render the title/subtitle/body for a single notification event per
 * SPEC §14.3. `snapshot.collections` is consulted for threshold-breach
 * bodies (we need coverage % / lastModified relative time for the
 * collection being flagged).
 *
 * Subtitle defaults to "all collections" when the event has no
 * collection field, mirroring the SPEC's `<collection or "all
 * collections">` placeholder.
 */
function renderEvent(
  event: NotificationEvent,
  snapshot: PollSnapshot,
  now: Date,
): Copy {
  switch (event.kind) {
    case "daemon-crash":
      return {
        title: "qmd daemon stopped",
        subtitle: `After ${
          compactDuration(event.previousUptime * 1000)
        } uptime`,
        body: "Click the menubar icon to restart.",
      };
    case "op-failure":
      return {
        title: `qmd ${actionVerb(event.action)} failed`,
        subtitle: event.collection ?? "all collections",
        body:
          `Exit code ${event.exitCode}. Click "Show last output" for details.`,
      };
    case "path-unreachable":
      return {
        title: "Collection path missing",
        subtitle: event.collection,
        body: `The path ${event.path} is no longer readable.`,
      };
    case "job-complete":
      return {
        title: `qmd ${actionVerb(event.action)} completed`,
        subtitle: event.collection ?? "all collections",
        body: `${compactDuration(event.durationMs)} elapsed.`,
      };
    case "threshold-breach": {
      if (event.metric === "coverage") {
        const c = snapshot.collections.find((x) => x.name === event.collection);
        const pct = c ? Math.round(c.coveragePercent) : 0;
        return {
          title: "Embedding coverage low",
          subtitle: event.collection ?? "(all)",
          body: `At ${pct}% coverage.`,
        };
      }
      // freshness
      const c = snapshot.collections.find((x) => x.name === event.collection);
      const rel = c?.lastModified
        ? relativeTime(c.lastModified, now)
        : "unknown";
      return {
        title: "Index freshness warning",
        subtitle: event.collection ?? "(all)",
        body: `Last updated ${rel}.`,
      };
    }
  }
}

// ─── Config gating ─────────────────────────────────────────────

function isEnabled(event: NotificationEvent, config: Config): boolean {
  switch (event.kind) {
    case "daemon-crash":
      return config.notifications.on_daemon_crash;
    case "op-failure":
      return config.notifications.on_op_failure;
    case "path-unreachable":
      return config.notifications.on_path_unreachable;
    case "job-complete":
      return config.notifications.on_job_completion;
    case "threshold-breach":
      return config.notifications.on_threshold_breach;
  }
}

// ─── diffStates (SPEC §8.3) ────────────────────────────────────

/**
 * Match an in-flight job from `prev` against a `current` failure / job
 * entry by `(action, collection, logPath)`. logPath is unique per
 * invocation (timestamped) so this is the most discriminating key
 * available.
 */
function jobKey(
  action: ActionId,
  collection: string | undefined,
  logPath: string,
): string {
  return `${action}:${collection ?? "*"}:${logPath}`;
}

/**
 * Diff two state snapshots to produce notification events per SPEC §8.3.
 *
 * - `prev` null → []. The first poll after install has no baseline to
 *   diff against; everything looks new, so suppressing avoids spamming
 *   notifications on startup.
 * - Each transition fires at most once. The same condition observed
 *   again on the next poll yields no event (because the prev snapshot
 *   now reflects the new state).
 *
 * Note: `config` is required for threshold-breach detection (we need
 * the amber thresholds to compute "was within / now past"). Optional
 * for callers that don't care — defaults are conservative.
 */
export function diffStates(
  prev: PollSnapshot | null,
  current: CurrentState,
  config?: Config,
): NotificationEvent[] {
  if (!prev) return [];

  const events: NotificationEvent[] = [];

  // ── daemon-crash ───────────────────────────────────────────
  if (
    prev.daemon.status === "running" &&
    current.daemon.status !== "running"
  ) {
    events.push({
      kind: "daemon-crash",
      previousUptime: prev.daemon.uptimeSeconds ?? 0,
    });
  }

  // ── path-unreachable ───────────────────────────────────────
  const prevByName = new Map<string, CollectionState>();
  for (const c of prev.collections) prevByName.set(c.name, c);
  for (const c of current.collections) {
    const before = prevByName.get(c.name);
    if (before && before.reachable && !c.reachable) {
      events.push({
        kind: "path-unreachable",
        collection: c.name,
        path: c.path,
      });
    }
  }

  // ── op-failure / job-complete ──────────────────────────────
  //
  // A job that was in prev.inFlightJobs but is no longer in
  // current.inFlightJobs has just exited. If a matching failure exists
  // in current.recentFailures (matched on logPath), that's an
  // op-failure; otherwise it's a job-complete.
  //
  // We dedupe against prev.recentOpFailures so a failure carried
  // through multiple polls doesn't re-emit.
  const currentInFlight = new Set<string>();
  for (const j of current.inFlightJobs) {
    currentInFlight.add(jobKey(j.action, j.collection, j.logPath));
  }
  const currentFailuresByLogPath = new Map<
    string,
    typeof current.recentFailures[number]
  >();
  for (const f of current.recentFailures) {
    currentFailuresByLogPath.set(f.logPath, f);
  }
  const prevFailureLogPaths = new Set<string>();
  for (const f of prev.recentOpFailures) {
    prevFailureLogPaths.add(f.logPath);
  }

  for (const j of prev.inFlightJobs) {
    const key = jobKey(j.action, j.collection, j.logPath);
    if (currentInFlight.has(key)) continue; // still running
    const failure = currentFailuresByLogPath.get(j.logPath);
    if (failure) {
      // op-failure — but only if this failure is genuinely new.
      if (prevFailureLogPaths.has(failure.logPath)) continue;
      events.push({
        kind: "op-failure",
        action: failure.action,
        collection: failure.collection,
        exitCode: failure.exitCode,
        logPath: failure.logPath,
      });
    } else {
      // job-complete (success). Duration = current.polledAt − job.startedAt.
      const durationMs = Math.max(
        0,
        current.polledAt.getTime() - j.startedAt.getTime(),
      );
      events.push({
        kind: "job-complete",
        action: j.action,
        collection: j.collection,
        durationMs,
      });
    }
  }

  // ── threshold-breach ───────────────────────────────────────
  if (config) {
    for (const c of current.collections) {
      const before = prevByName.get(c.name);
      if (!before) continue;

      // coverage: prev >= amber AND current < amber
      const amberCov = config.rollup.coverage.amber_percent;
      if (
        before.coveragePercent >= amberCov &&
        c.coveragePercent < amberCov
      ) {
        events.push({
          kind: "threshold-breach",
          metric: "coverage",
          collection: c.name,
        });
      }

      // freshness: prev within amber AND current past amber.
      // "within amber" = ageMs <= amberThreshold; "past amber" = >
      // amberThreshold. Ages are computed against each snapshot's own
      // polled timestamp.
      const amberMs = config.rollup.freshness.amber_hours * 60 * 60 * 1000;
      if (before.lastModified && c.lastModified) {
        const prevAge = new Date(prev.pollTimestamp).getTime() -
          before.lastModified.getTime();
        const curAge = current.polledAt.getTime() - c.lastModified.getTime();
        if (prevAge <= amberMs && curAge > amberMs) {
          events.push({
            kind: "threshold-breach",
            metric: "freshness",
            collection: c.name,
          });
        }
      }
    }
  }

  return events;
}

// ─── emitNotifications ─────────────────────────────────────────

/**
 * Fire notifications for `events`, gated by `config.notifications.*`
 * and the per-key 5-minute dedupe window stored in
 * `snapshot.recentlyNotified`. Mutates `snapshot.recentlyNotified` so
 * the caller (poll loop) can persist the updated dedupe registry on
 * the next `writeSnapshot`.
 *
 * Rate limit (SPEC §14.4): if more than 3 events would fire after
 * dedupe, only the first 3 fire and a single "+ N more" fallback is
 * appended. The suppressed events still get recorded in
 * `recentlyNotified` so they don't re-fire on the next poll.
 *
 * Dedupe pruning: every call removes entries from `recentlyNotified`
 * whose timestamps are older than the 5-minute window, keeping the
 * registry bounded.
 *
 * Never throws — osascript failures are swallowed inside fireNotification.
 */
export async function emitNotifications(
  events: NotificationEvent[],
  snapshot: PollSnapshot,
  config: Config,
  deps?: Partial<NotifyDeps>,
): Promise<void> {
  const d: NotifyDeps = {
    fireNotification: deps?.fireNotification ??
      PRODUCTION_DEPS.fireNotification,
    now: deps?.now ?? PRODUCTION_DEPS.now,
  };

  const now = d.now();
  const cutoffMs = now.getTime() - DEDUPE_WINDOW_MS;

  // Filter by config opt-in.
  const optedIn = events.filter((e) => isEnabled(e, config));

  // Filter by dedupe window.
  const deduped = optedIn.filter((e) => {
    const key = dedupeKey(e);
    const last = snapshot.recentlyNotified[key];
    if (!last) return true;
    return new Date(last).getTime() <= cutoffMs;
  });

  // Rate limit.
  const toFire = deduped.slice(0, NOTIFICATIONS_PER_POLL);
  const overflow = deduped.slice(NOTIFICATIONS_PER_POLL);

  for (const event of toFire) {
    const copy = renderEvent(event, snapshot, now);
    await d.fireNotification(copy.title, copy.subtitle, copy.body);
    snapshot.recentlyNotified[dedupeKey(event)] = now.toISOString();
  }

  if (overflow.length > 0) {
    await d.fireNotification(
      "swiftbar-qmd",
      `(${overflow.length} additional events suppressed)`,
      `+ ${overflow.length} more — see menu`,
    );
    for (const event of overflow) {
      snapshot.recentlyNotified[dedupeKey(event)] = now.toISOString();
    }
  }

  // Prune entries older than the dedupe window so the registry stays
  // bounded. (SPEC §14.1: "Entries older than 5 minutes are pruned.")
  for (const [key, ts] of Object.entries(snapshot.recentlyNotified)) {
    if (new Date(ts).getTime() < cutoffMs) {
      delete snapshot.recentlyNotified[key];
    }
  }
}

// ─── buildSnapshot ─────────────────────────────────────────────

/**
 * Compose a `PollSnapshot` from this poll's `CurrentState` + computed
 * tier + previous snapshot (for fields that carry over). The result is
 * what `writeSnapshot` will persist to `last-poll.json`.
 *
 * `recentlyNotified` is carried from `prev` so dedupe state survives
 * across polls — `emitNotifications` will mutate it in place before
 * the caller writes the snapshot to disk.
 */
export function buildSnapshot(
  state: CurrentState,
  tier: TierReason,
  prev: PollSnapshot | null,
): PollSnapshot {
  return {
    pollTimestamp: state.polledAt.toISOString(),
    daemon: state.daemon,
    collections: state.collections,
    recentOpFailures: state.recentFailures,
    inFlightJobs: state.inFlightJobs,
    computedTier: tier.tier,
    tierDrivers: tier.drivers,
    recentlyNotified: { ...(prev?.recentlyNotified ?? {}) },
    consecutiveReadFailures: prev?.consecutiveReadFailures ?? 0,
  };
}

// Re-export for callers that just want the type.
export type { JobInfo, NotificationEvent };

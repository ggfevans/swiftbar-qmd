import type {
  ActionId,
  CollectionState,
  Config,
  CurrentState,
  FailureRecord,
  JobInfo,
  Tier,
  TierReason,
} from "./types.ts";
import { compactDuration } from "./time.ts";

// ─── Constants ─────────────────────────────────────────────────

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// ─── Internal helpers ──────────────────────────────────────────

/**
 * Milliseconds since the OLDEST `lastModified` across reachable
 * collections, relative to `polledAt`. Returns `null` if there are no
 * collections with a non-null `lastModified` (treat as "no signal").
 */
function oldestLastModifiedAgeMs(
  collections: CollectionState[],
  polledAt: Date,
): { ageMs: number; collection: CollectionState } | null {
  const polledMs = polledAt.getTime();
  let result: { ageMs: number; collection: CollectionState } | null = null;
  for (const c of collections) {
    if (!c.lastModified) continue;
    const ageMs = polledMs - c.lastModified.getTime();
    if (result === null || ageMs > result.ageMs) {
      result = { ageMs, collection: c };
    }
  }
  return result;
}

/** True iff any failure in `failures` occurred within `hours` of `polledAt`. */
function anyFailureWithin(
  failures: FailureRecord[],
  hours: number,
  polledAt: Date,
): FailureRecord | null {
  const cutoff = polledAt.getTime() - hours * MS_PER_HOUR;
  let mostRecent: FailureRecord | null = null;
  for (const f of failures) {
    if (f.failedAt.getTime() >= cutoff) {
      if (
        mostRecent === null ||
        f.failedAt.getTime() > mostRecent.failedAt.getTime()
      ) {
        mostRecent = f;
      }
    }
  }
  return mostRecent;
}

/**
 * Map an internal ActionId to the human label used in "X job in flight".
 *
 * Exported so the menu renderer can reuse the same label mapping in
 * the in-flight "⟳ Running: <label>…" rows (SPEC §10.3). Keeping the
 * lookup in one place ensures Status drivers and menu copy stay in
 * sync if action ids ever change.
 */
export function actionLabel(action: ActionId): string {
  switch (action) {
    case "update-all":
    case "update-collection":
      return "Update";
    case "embed-all":
    case "embed-collection":
    case "force-reembed-collection":
      return "Embed";
    case "restart-daemon":
    case "start-daemon":
    case "stop-daemon":
      return "Daemon";
    case "cleanup":
      return "Cleanup";
    case "recheck":
      return "Recheck";
    case "show-context":
      return "Context";
  }
}

// ─── Severity ordering ────────────────────────────────────────

const TIER_ORDER: Record<Tier, number> = {
  green: 0,
  amber: 1,
  grey: 2,
  red: 3,
};

function maxTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

// ─── computeTier ───────────────────────────────────────────────

/**
 * Compute the overall health tier for the menubar icon. Implements
 * SPEC §9.1 precedence verbatim: special grey state first, then RED
 * checks, then AMBER checks, default GREEN.
 *
 * Pure function — no I/O, no async, no Date.now(). Current time is
 * supplied by `state.polledAt`.
 */
export function computeTier(state: CurrentState, config: Config): Tier {
  // Special grey state: legitimately empty index (no collections
  // configured AND the SDK confirmed the index has none). Gated on
  // `!status.error` because when the index read failed,
  // `totalCollections` is 0 from the fallback — without this gate a
  // poll that completely failed to read the index would render as the
  // cosmetic "you have no collections" tier instead of an error tier
  // and the user wouldn't see the failure. See PR #1 finding A8.
  if (
    !state.collections.length &&
    !state.status.totalCollections &&
    !state.status.error
  ) {
    return "grey";
  }

  // RED tier checks
  if (state.daemon.status !== "running") return "red";
  if (state.collections.some((c) => !c.reachable)) return "red";
  if (
    anyFailureWithin(
      state.recentFailures,
      config.rollup.error_window.red_hours,
      state.polledAt,
    )
  ) {
    return "red";
  }
  if (
    state.collections.some((c) =>
      c.coveragePercent < config.rollup.coverage.red_percent
    )
  ) {
    return "red";
  }
  const oldest = oldestLastModifiedAgeMs(state.collections, state.polledAt);
  if (oldest && oldest.ageMs > config.rollup.freshness.red_days * MS_PER_DAY) {
    return "red";
  }

  // AMBER tier checks
  if (state.inFlightJobs.length > 0) return "amber";
  if (
    state.collections.some((c) =>
      c.coveragePercent < config.rollup.coverage.amber_percent
    )
  ) {
    return "amber";
  }
  if (
    oldest && oldest.ageMs > config.rollup.freshness.amber_hours * MS_PER_HOUR
  ) {
    return "amber";
  }
  if (
    anyFailureWithin(
      state.recentFailures,
      config.rollup.error_window.amber_hours,
      state.polledAt,
    )
  ) {
    return "amber";
  }

  // GREEN: everything passed.
  return "green";
}

// ─── computeTierWithReason ─────────────────────────────────────

/**
 * Like `computeTier` but accumulates a human-readable list of every
 * triggering condition. The final tier is the highest-severity tier
 * across all evaluated conditions (red > grey > amber > green); the
 * drivers list contains messages from every condition that fired,
 * regardless of tier. See SPEC §9.2.
 *
 * Pure function. Format strings here are surfaced in the menu's
 * "Status" section.
 */
export function computeTierWithReason(
  state: CurrentState,
  config: Config,
): TierReason {
  // Special grey state — legitimately no collections at all. Gated
  // on `!status.error` so a failed index read doesn't masquerade as
  // the cosmetic "no collections" tier. See PR #1 finding A8.
  if (
    !state.collections.length &&
    !state.status.totalCollections &&
    !state.status.error
  ) {
    return { tier: "grey", drivers: ["No collections configured"] };
  }

  const drivers: string[] = [];
  let tier: Tier = "green";

  // ── Daemon ─────────────────────────────────────────────────
  if (state.daemon.status === "stopped") {
    drivers.push("Daemon stopped");
    tier = maxTier(tier, "red");
  } else if (state.daemon.status === "unresponsive") {
    drivers.push("Daemon unresponsive");
    tier = maxTier(tier, "red");
  }

  // ── Unreachable collections (red) ─────────────────────────
  for (const c of state.collections) {
    if (!c.reachable) {
      drivers.push(`Collection ${c.name} path unreachable: ${c.path}`);
      tier = maxTier(tier, "red");
    }
  }

  // ── Recent failures (red window, then amber window) ───────
  const redFailure = anyFailureWithin(
    state.recentFailures,
    config.rollup.error_window.red_hours,
    state.polledAt,
  );
  if (redFailure) {
    const ago = compactDuration(
      state.polledAt.getTime() - redFailure.failedAt.getTime(),
    );
    drivers.push(`Recent failure: ${redFailure.action} ${ago} ago`);
    tier = maxTier(tier, "red");
  } else {
    const amberFailure = anyFailureWithin(
      state.recentFailures,
      config.rollup.error_window.amber_hours,
      state.polledAt,
    );
    if (amberFailure) {
      const ago = compactDuration(
        state.polledAt.getTime() - amberFailure.failedAt.getTime(),
      );
      drivers.push(`Recent failure: ${amberFailure.action} ${ago} ago`);
      tier = maxTier(tier, "amber");
    }
  }

  // ── Coverage (per-collection, red then amber) ─────────────
  for (const c of state.collections) {
    if (c.coveragePercent < config.rollup.coverage.red_percent) {
      drivers.push(
        `${c.name} below ${config.rollup.coverage.red_percent}% coverage (${c.coveragePercent}%)`,
      );
      tier = maxTier(tier, "red");
    } else if (c.coveragePercent < config.rollup.coverage.amber_percent) {
      drivers.push(
        `${c.name} below ${config.rollup.coverage.amber_percent}% coverage (${c.coveragePercent}%)`,
      );
      tier = maxTier(tier, "amber");
    }
  }

  // ── Freshness (oldest lastModified across collections) ────
  const oldest = oldestLastModifiedAgeMs(state.collections, state.polledAt);
  if (oldest) {
    const redThresholdMs = config.rollup.freshness.red_days * MS_PER_DAY;
    const amberThresholdMs = config.rollup.freshness.amber_hours * MS_PER_HOUR;
    const ago = compactDuration(oldest.ageMs);
    if (oldest.ageMs > redThresholdMs) {
      drivers.push(
        `${oldest.collection.name} last updated ${ago} ago (>${config.rollup.freshness.red_days}d)`,
      );
      tier = maxTier(tier, "red");
    } else if (oldest.ageMs > amberThresholdMs) {
      drivers.push(
        `${oldest.collection.name} last updated ${ago} ago (>${config.rollup.freshness.amber_hours}h)`,
      );
      tier = maxTier(tier, "amber");
    }
  }

  // ── In-flight jobs (amber) ────────────────────────────────
  // Deduplicate by label so two "update-all" jobs don't add two drivers.
  const seenJobLabels = new Set<string>();
  for (const job of state.inFlightJobs as JobInfo[]) {
    const label = actionLabel(job.action);
    if (seenJobLabels.has(label)) continue;
    seenJobLabels.add(label);
    drivers.push(`${label} job in flight`);
    tier = maxTier(tier, "amber");
  }

  return { tier, drivers };
}

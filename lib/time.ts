// ─── Constants ─────────────────────────────────────────────────

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;

// ─── compactDuration ───────────────────────────────────────────

/**
 * Render a duration in compact form for menu metadata. See SPEC §5.2.
 *
 * Buckets:
 *   < 60s  → "Ns"
 *   < 60m  → "Nm"
 *   < 24h  → "Nh" or "Nh Mm" (minutes dropped when 0)
 *   < 7d   → "Nd" or "Nd Hh" (hours dropped when 0)
 *   ≥ 7d   → "Nw" or "Nw Dd" (days dropped when 0)
 *
 * Negative durations clamp to 0 → "0s".
 */
export function compactDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";

  if (ms < MS_PER_MINUTE) {
    const s = Math.floor(ms / MS_PER_SECOND);
    return `${s}s`;
  }

  if (ms < MS_PER_HOUR) {
    const m = Math.floor(ms / MS_PER_MINUTE);
    return `${m}m`;
  }

  if (ms < MS_PER_DAY) {
    const h = Math.floor(ms / MS_PER_HOUR);
    const m = Math.floor((ms - h * MS_PER_HOUR) / MS_PER_MINUTE);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  if (ms < MS_PER_WEEK) {
    const d = Math.floor(ms / MS_PER_DAY);
    const h = Math.floor((ms - d * MS_PER_DAY) / MS_PER_HOUR);
    return h === 0 ? `${d}d` : `${d}d ${h}h`;
  }

  const w = Math.floor(ms / MS_PER_WEEK);
  const d = Math.floor((ms - w * MS_PER_WEEK) / MS_PER_DAY);
  return d === 0 ? `${w}w` : `${w}w ${d}d`;
}

// ─── relativeTime ──────────────────────────────────────────────

/**
 * Render `date` relative to `now` (defaults to current time). See SPEC §5.2.
 *
 * Buckets:
 *   < 60s  → "just now"
 *   < 60m  → "N minute(s) ago"
 *   < 24h  → "N hour(s) ago"
 *   < 48h  → "yesterday"
 *   < 7d   → "N days ago"
 *   < 14d  → "1 week ago"
 *   ≥ 14d  → "N weeks ago"
 *
 * Future dates collapse to "just now".
 */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MS_PER_MINUTE) return "just now";

  if (elapsed < MS_PER_HOUR) {
    const m = Math.floor(elapsed / MS_PER_MINUTE);
    return m === 1 ? "1 minute ago" : `${m} minutes ago`;
  }

  if (elapsed < MS_PER_DAY) {
    const h = Math.floor(elapsed / MS_PER_HOUR);
    return h === 1 ? "1 hour ago" : `${h} hours ago`;
  }

  if (elapsed < 2 * MS_PER_DAY) return "yesterday";

  if (elapsed < MS_PER_WEEK) {
    const d = Math.floor(elapsed / MS_PER_DAY);
    return `${d} days ago`;
  }

  if (elapsed < 2 * MS_PER_WEEK) return "1 week ago";

  const w = Math.floor(elapsed / MS_PER_WEEK);
  return `${w} weeks ago`;
}

// ─── withTimeout ───────────────────────────────────────────────

/**
 * Resolve `p` within `ms` milliseconds. Rejects with a timeout Error
 * otherwise. The pending timer is cleared once `p` settles so it
 * doesn't leak (Deno's test leak detector enforces this).
 *
 * SPEC §5.2 — used by detect/state/daemon probes to bound external work.
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label?: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const suffix = label ? ` (${label})` : "";
      reject(new Error(`Timed out after ${ms}ms${suffix}`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { compactDuration, relativeTime, withTimeout } from "../lib/time.ts";

// ─── compactDuration ───────────────────────────────────────────

Deno.test("compactDuration: zero → '0s'", () => {
  assertEquals(compactDuration(0), "0s");
});

Deno.test("compactDuration: negative → '0s'", () => {
  assertEquals(compactDuration(-100), "0s");
  assertEquals(compactDuration(-1_000_000), "0s");
});

Deno.test("compactDuration: sub-second still shows seconds", () => {
  // 500ms → 0s (truncated). Acceptable per SPEC; we floor seconds.
  assertEquals(compactDuration(500), "0s");
});

Deno.test("compactDuration: < 60s → 'Ns'", () => {
  assertEquals(compactDuration(1_000), "1s");
  assertEquals(compactDuration(30_000), "30s");
  assertEquals(compactDuration(59_000), "59s");
});

Deno.test("compactDuration: 60s exactly → '1m' (next bucket)", () => {
  assertEquals(compactDuration(60_000), "1m");
});

Deno.test("compactDuration: < 60m → 'Nm'", () => {
  assertEquals(compactDuration(5 * 60_000), "5m");
  assertEquals(compactDuration(59 * 60_000), "59m");
});

Deno.test("compactDuration: 1h exact → '1h' (drops zero minutes)", () => {
  assertEquals(compactDuration(60 * 60_000), "1h");
});

Deno.test("compactDuration: 1h 30m → '1h 30m'", () => {
  assertEquals(compactDuration(90 * 60_000), "1h 30m");
});

Deno.test("compactDuration: 2h exact → '2h'", () => {
  assertEquals(compactDuration(2 * 60 * 60_000), "2h");
});

Deno.test("compactDuration: 23h 59m → '23h 59m'", () => {
  const ms = 23 * 60 * 60_000 + 59 * 60_000;
  assertEquals(compactDuration(ms), "23h 59m");
});

Deno.test("compactDuration: 24h exact → '1d' (drops zero hours)", () => {
  assertEquals(compactDuration(24 * 60 * 60_000), "1d");
});

Deno.test("compactDuration: 1d 1h → '1d 1h'", () => {
  const ms = 25 * 60 * 60_000;
  assertEquals(compactDuration(ms), "1d 1h");
});

Deno.test("compactDuration: 6d 23h → '6d 23h'", () => {
  const ms = 6 * 24 * 60 * 60_000 + 23 * 60 * 60_000;
  assertEquals(compactDuration(ms), "6d 23h");
});

Deno.test("compactDuration: 7d exact → '1w' (drops zero days)", () => {
  assertEquals(compactDuration(7 * 24 * 60 * 60_000), "1w");
});

Deno.test("compactDuration: 1w 2d → '1w 2d'", () => {
  const ms = 9 * 24 * 60 * 60_000;
  assertEquals(compactDuration(ms), "1w 2d");
});

Deno.test("compactDuration: 3w 0d → '3w'", () => {
  assertEquals(compactDuration(21 * 24 * 60 * 60_000), "3w");
});

// ─── relativeTime ──────────────────────────────────────────────

Deno.test("relativeTime: future date → 'just now'", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const future = new Date("2026-01-01T13:00:00Z");
  assertEquals(relativeTime(future, now), "just now");
});

Deno.test("relativeTime: < 60s elapsed → 'just now'", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const past = new Date("2026-01-01T11:59:30Z"); // 30s ago
  assertEquals(relativeTime(past, now), "just now");
});

Deno.test("relativeTime: just under 60s → 'just now'", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const past = new Date("2026-01-01T11:59:01Z"); // 59s ago
  assertEquals(relativeTime(past, now), "just now");
});

Deno.test("relativeTime: 60s exactly → '1 minute ago'", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const past = new Date("2026-01-01T11:59:00Z");
  assertEquals(relativeTime(past, now), "1 minute ago");
});

Deno.test("relativeTime: 5 minutes ago", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const past = new Date("2026-01-01T11:55:00Z");
  assertEquals(relativeTime(past, now), "5 minutes ago");
});

Deno.test("relativeTime: 1 hour ago (singular)", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const past = new Date("2026-01-01T11:00:00Z");
  assertEquals(relativeTime(past, now), "1 hour ago");
});

Deno.test("relativeTime: 5 hours ago", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const past = new Date("2026-01-01T07:00:00Z");
  assertEquals(relativeTime(past, now), "5 hours ago");
});

Deno.test("relativeTime: 23h59m ago → '23 hours ago'", () => {
  const now = new Date("2026-01-02T12:00:00Z");
  const past = new Date("2026-01-01T12:01:00Z"); // 23h 59m ago
  assertEquals(relativeTime(past, now), "23 hours ago");
});

Deno.test("relativeTime: 24h exactly → 'yesterday'", () => {
  const now = new Date("2026-01-02T12:00:00Z");
  const past = new Date("2026-01-01T12:00:00Z");
  assertEquals(relativeTime(past, now), "yesterday");
});

Deno.test("relativeTime: 36h ago → 'yesterday' (< 48h)", () => {
  const now = new Date("2026-01-03T00:00:00Z");
  const past = new Date("2026-01-01T12:00:00Z"); // 36h ago
  assertEquals(relativeTime(past, now), "yesterday");
});

Deno.test("relativeTime: 48h exactly → '2 days ago'", () => {
  const now = new Date("2026-01-03T12:00:00Z");
  const past = new Date("2026-01-01T12:00:00Z");
  assertEquals(relativeTime(past, now), "2 days ago");
});

Deno.test("relativeTime: 3 days ago", () => {
  const now = new Date("2026-01-04T12:00:00Z");
  const past = new Date("2026-01-01T12:00:00Z");
  assertEquals(relativeTime(past, now), "3 days ago");
});

Deno.test("relativeTime: 7 days exactly → '1 week ago'", () => {
  const now = new Date("2026-01-08T12:00:00Z");
  const past = new Date("2026-01-01T12:00:00Z");
  assertEquals(relativeTime(past, now), "1 week ago");
});

Deno.test("relativeTime: 13 days ago → '1 week ago'", () => {
  const now = new Date("2026-01-14T12:00:00Z");
  const past = new Date("2026-01-01T12:00:00Z");
  assertEquals(relativeTime(past, now), "1 week ago");
});

Deno.test("relativeTime: 14 days exactly → '2 weeks ago'", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  const past = new Date("2026-01-01T12:00:00Z");
  assertEquals(relativeTime(past, now), "2 weeks ago");
});

Deno.test("relativeTime: 30 days ago → '4 weeks ago'", () => {
  const now = new Date("2026-01-31T12:00:00Z");
  const past = new Date("2026-01-01T12:00:00Z");
  assertEquals(relativeTime(past, now), "4 weeks ago");
});

Deno.test("relativeTime: defaults `now` to current time", () => {
  // Just ensure it doesn't throw and returns a string.
  // Use a date one minute in the past relative to call time.
  const past = new Date(Date.now() - 5 * 60_000);
  const out = relativeTime(past);
  assertStringIncludes(out, "minute");
});

Deno.test("relativeTime: invalid `date` → '—' fallback (PR #1 A9)", () => {
  // Regression: pre-A9, an Invalid Date's getTime() returned NaN, all
  // the `<` bucket comparisons short-circuited to false, and execution
  // fell through to the final `${w} weeks ago` template — rendering
  // "NaN weeks ago" in the dropdown. The em-dash placeholder is the
  // SPEC-standard "no signal" indicator (see lib/menu.ts).
  const now = new Date("2026-05-17T12:00:00Z");
  const invalid = new Date("not a date");
  assertEquals(relativeTime(invalid, now), "—");
});

Deno.test("relativeTime: invalid `now` → '—' fallback (PR #1 A9)", () => {
  // Belt-and-braces: the `now` param defaults to `new Date()` so this
  // is mainly a defensive guard. If a caller passes a corrupt clock
  // we still degrade gracefully rather than emitting NaN copy.
  const past = new Date("2026-05-17T12:00:00Z");
  const invalidNow = new Date("not a date");
  assertEquals(relativeTime(past, invalidNow), "—");
});

// ─── withTimeout ───────────────────────────────────────────────

Deno.test("withTimeout: resolves before timeout passes value through", async () => {
  const value = await withTimeout(Promise.resolve(42), 100);
  assertEquals(value, 42);
});

Deno.test("withTimeout: rejects with timeout error past deadline", async () => {
  const err = await assertRejects(
    () => withTimeout(new Promise(() => {}), 25),
    Error,
  );
  assertStringIncludes(err.message, "Timed out after 25ms");
});

Deno.test("withTimeout: includes label in rejection message", async () => {
  const err = await assertRejects(
    () => withTimeout(new Promise(() => {}), 25, "probe"),
    Error,
  );
  assertStringIncludes(err.message, "Timed out after 25ms (probe)");
});

Deno.test("withTimeout: propagates inner rejection", async () => {
  const err = await assertRejects(
    () => withTimeout(Promise.reject(new Error("boom")), 1000),
    Error,
    "boom",
  );
  assertEquals(err.message, "boom");
});

Deno.test("withTimeout: timer is cleared on resolve (no leak)", async () => {
  // If the timer weren't cleared, this would still fire and Deno's leak
  // detector would flag it. The assertion is implicit — the test must
  // complete without leak errors.
  const value = await withTimeout(Promise.resolve("ok"), 60_000);
  assertEquals(value, "ok");
});

Deno.test("withTimeout: timer is cleared on reject (no leak)", async () => {
  await assertRejects(
    () => withTimeout(Promise.reject(new Error("fast")), 60_000),
    Error,
    "fast",
  );
});

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { logError, logInfo } from "../lib/log.ts";

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Run a test body with a fresh CACHE_DIR override. Mirrors the helper
 * in `persistence_test.ts` so log-write tests pick up the same
 * SWIFTBAR_QMD_CACHE_DIR resolution path that production uses.
 */
async function withCacheDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "swiftbar-qmd-log-",
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

// ─── Tests ─────────────────────────────────────────────────────

Deno.test("logError honours SWIFTBAR_QMD_CACHE_DIR (PR #1 A6)", async () => {
  // Regression: lib/log.ts previously hardcoded
  // `${HOME}/.cache/swiftbar-qmd/error.log` at module load. Every
  // other module routes through `cacheDir()` which honours the env
  // override, so under override `logError` wrote to one tree while
  // the UI's "Show last error" row opened a different tree.
  await withCacheDir(async (dir) => {
    await logError("test", "hello", new Error("boom"));

    const logFile = join(dir, "error.log");
    const stat = await Deno.stat(logFile);
    assertEquals(stat.isFile, true);

    const contents = await Deno.readTextFile(logFile);
    assertStringIncludes(contents, "[error] test: hello");
    assertStringIncludes(contents, "boom"); // error stack/message
  });
});

Deno.test("logInfo honours SWIFTBAR_QMD_CACHE_DIR (PR #1 A6)", async () => {
  await withCacheDir(async (dir) => {
    await logInfo("test", "info-message");

    const logFile = join(dir, "error.log");
    const contents = await Deno.readTextFile(logFile);
    assertStringIncludes(contents, "[info] test: info-message");
  });
});

Deno.test("logError appends across calls (PR #1 A6)", async () => {
  // Belt-and-braces: confirm the path is recomputed per write rather
  // than captured once at module load — otherwise a fresh test run
  // inside the same Deno process would write to the previous dir.
  await withCacheDir(async (dir) => {
    await logError("test", "first");
    await logError("test", "second");

    const logFile = join(dir, "error.log");
    const contents = await Deno.readTextFile(logFile);
    assertStringIncludes(contents, "first");
    assertStringIncludes(contents, "second");
  });
});

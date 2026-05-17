// ─── Paths ─────────────────────────────────────────────────────

const HOME = Deno.env.get("HOME") ?? "";
const CACHE_DIR = `${HOME}/.cache/swiftbar-qmd`;
const LOG_PATH = `${CACHE_DIR}/error.log`;
const LOG_BACKUP_PATH = `${LOG_PATH}.1`;

// ─── Rotation ──────────────────────────────────────────────────

const MAX_LOG_BYTES = 1024 * 1024; // 1 MB

/**
 * If `error.log` is over 1 MB, rename it to `error.log.1`
 * (overwriting any existing backup). The next write will start a
 * fresh file. Errors are swallowed — rotation is best-effort.
 */
async function rotateIfNeeded(): Promise<void> {
  try {
    const stat = await Deno.stat(LOG_PATH);
    if (!stat.isFile) return;
    if (stat.size <= MAX_LOG_BYTES) return;
    await Deno.rename(LOG_PATH, LOG_BACKUP_PATH);
  } catch {
    // File missing or stat/rename failed — nothing to rotate.
  }
}

// ─── Write ─────────────────────────────────────────────────────

type Level = "info" | "error";

function formatLine(
  level: Level,
  category: string,
  message: string,
  error?: Error,
): string {
  const ts = new Date().toISOString();
  let line = `${ts} [${level}] ${category}: ${message}\n`;
  if (error?.stack) {
    line += `${error.stack}\n`;
  }
  return line;
}

/**
 * Append a single log line. Never throws — on any failure we swallow
 * silently because there is nowhere meaningful to report a logging
 * failure (writing to console would surface in SwiftBar's plugin
 * console and pollute legitimate output).
 */
async function writeLine(
  level: Level,
  category: string,
  message: string,
  error?: Error,
): Promise<void> {
  try {
    await Deno.mkdir(CACHE_DIR, { recursive: true });
    await rotateIfNeeded();
    const line = formatLine(level, category, message, error);
    await Deno.writeTextFile(LOG_PATH, line, { append: true });
  } catch {
    // Swallow: logging failures must never propagate.
  }
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Log an error event. See SPEC §18.1.
 *
 * @param category short tag (e.g. "config", "detect", "main")
 * @param message  human-readable summary
 * @param error    optional Error; stack is appended on its own lines
 */
export async function logError(
  category: string,
  message: string,
  error?: Error,
): Promise<void> {
  await writeLine("error", category, message, error);
}

/**
 * Log an info event. See SPEC §18.1.
 *
 * @param category short tag (e.g. "config", "detect", "main")
 * @param message  human-readable summary
 */
export async function logInfo(
  category: string,
  message: string,
): Promise<void> {
  await writeLine("info", category, message);
}

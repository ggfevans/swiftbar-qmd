import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { ensureDir } from "@std/fs";
import { dirname, fromFileUrl, resolve } from "@std/path";
import type { Config } from "./types.ts";

// ─── Paths ─────────────────────────────────────────────────────

/** Canonical user config path. */
export const CONFIG_PATH: string = (() => {
  const home = Deno.env.get("HOME") ?? "";
  return `${home}/.config/qmd-swiftbar/config.yml`;
})();

/**
 * Example config shipped with the plugin (next to the script).
 *
 * `fromFileUrl` decodes percent escapes so the seed copy works when
 * the plugin lives under a path containing spaces (e.g. the default
 * SwiftBar install location `~/Library/Application Support/SwiftBar/
 * Plugins`).
 */
export const EXAMPLE_CONFIG_PATH: string = fromFileUrl(
  new URL("../config.example.yml", import.meta.url),
);

// ─── Defaults ──────────────────────────────────────────────────

/** Default config used when no file present and example unavailable. */
export const DEFAULT_CONFIG: Config = {
  qmd: {
    index_path: expandTilde("~/.cache/qmd/index.sqlite"),
    daemon_url: "http://localhost:8181",
  },
  rollup: {
    freshness: { amber_hours: 24, red_days: 7 },
    coverage: { amber_percent: 95, red_percent: 50 },
    error_window: { red_hours: 1, amber_hours: 24 },
  },
  notifications: {
    on_daemon_crash: true,
    on_op_failure: true,
    on_path_unreachable: true,
    on_job_completion: false,
    on_threshold_breach: false,
  },
  ui: {
    collection_meta: "freshness",
    hide_obsidian_when_absent: true,
  },
  logs: {
    directory: expandTilde("~/.cache/qmd-swiftbar/logs"),
    retain_per_action: 10,
  },
};

// ─── Helpers ───────────────────────────────────────────────────

function expandTilde(p: string): string {
  if (typeof p !== "string") return p;
  if (p === "~") return Deno.env.get("HOME") ?? p;
  if (p.startsWith("~/")) {
    const home = Deno.env.get("HOME");
    if (!home) return p;
    return `${home}/${p.slice(2)}`;
  }
  return p;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isBoolean(x: unknown): x is boolean {
  return typeof x === "boolean";
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

function isHttpUrl(x: unknown): x is string {
  if (typeof x !== "string") return false;
  try {
    const u = new URL(x);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ─── Validation ────────────────────────────────────────────────

/** Validate a parsed object against the schema. Returns sanitised config + error list. */
export function validateConfig(
  raw: unknown,
): { config: Config; errors: string[] } {
  const errors: string[] = [];

  // Start from defaults, override field-by-field.
  const cfg: Config = structuredClone(DEFAULT_CONFIG);

  if (!isObject(raw)) {
    if (raw !== undefined && raw !== null) {
      errors.push("config: root must be a mapping; falling back to defaults");
    }
    return { config: cfg, errors };
  }

  // ── qmd ────────────────────────────────────────────────────
  if (isObject(raw.qmd)) {
    const q = raw.qmd;

    if ("index_path" in q) {
      if (isNonEmptyString(q.index_path)) {
        cfg.qmd.index_path = expandTilde(q.index_path);
      } else {
        errors.push(
          "qmd.index_path: must be a non-empty string; falling back to default",
        );
      }
    }

    if ("daemon_url" in q) {
      if (isHttpUrl(q.daemon_url)) {
        cfg.qmd.daemon_url = q.daemon_url;
      } else {
        errors.push(
          "qmd.daemon_url: must be a valid http(s) URL; falling back to default",
        );
      }
    }
  }

  // ── rollup ─────────────────────────────────────────────────
  if (isObject(raw.rollup)) {
    const r = raw.rollup;

    // freshness
    if (isObject(r.freshness)) {
      const f = r.freshness;

      if ("amber_hours" in f) {
        const v = f.amber_hours;
        if (isFiniteNumber(v) && v > 0 && v <= 8760) {
          cfg.rollup.freshness.amber_hours = v;
        } else {
          errors.push(
            "rollup.freshness.amber_hours: must be a number in (0, 8760]; falling back to default",
          );
        }
      }

      if ("red_days" in f) {
        const v = f.red_days;
        const minDays = cfg.rollup.freshness.amber_hours / 24;
        if (isFiniteNumber(v) && v > minDays && v <= 365) {
          cfg.rollup.freshness.red_days = v;
        } else {
          errors.push(
            `rollup.freshness.red_days: must be a number in (${minDays}, 365]; falling back to default`,
          );
        }
      }
    }

    // coverage
    if (isObject(r.coverage)) {
      const c = r.coverage;

      if ("amber_percent" in c) {
        const v = c.amber_percent;
        if (isFiniteNumber(v) && v >= 0 && v <= 100) {
          cfg.rollup.coverage.amber_percent = v;
        } else {
          errors.push(
            "rollup.coverage.amber_percent: must be a number in [0, 100]; falling back to default",
          );
        }
      }

      if ("red_percent" in c) {
        const v = c.red_percent;
        const maxRed = cfg.rollup.coverage.amber_percent;
        if (isFiniteNumber(v) && v >= 0 && v <= maxRed) {
          cfg.rollup.coverage.red_percent = v;
        } else {
          errors.push(
            `rollup.coverage.red_percent: must be a number in [0, ${maxRed}]; falling back to default`,
          );
        }
      }
    }

    // error_window
    if (isObject(r.error_window)) {
      const e = r.error_window;

      if ("red_hours" in e) {
        const v = e.red_hours;
        if (isFiniteNumber(v) && v > 0 && v <= 168) {
          cfg.rollup.error_window.red_hours = v;
        } else {
          errors.push(
            "rollup.error_window.red_hours: must be a number in (0, 168]; falling back to default",
          );
        }
      }

      if ("amber_hours" in e) {
        const v = e.amber_hours;
        const minAmber = cfg.rollup.error_window.red_hours;
        if (isFiniteNumber(v) && v > minAmber && v <= 720) {
          cfg.rollup.error_window.amber_hours = v;
        } else {
          errors.push(
            `rollup.error_window.amber_hours: must be a number in (${minAmber}, 720]; falling back to default`,
          );
        }
      }
    }
  }

  // ── notifications ──────────────────────────────────────────
  if (isObject(raw.notifications)) {
    const n = raw.notifications;
    const boolKeys: Array<keyof Config["notifications"]> = [
      "on_daemon_crash",
      "on_op_failure",
      "on_path_unreachable",
      "on_job_completion",
      "on_threshold_breach",
    ];
    for (const key of boolKeys) {
      if (key in n) {
        const v = n[key];
        if (isBoolean(v)) {
          cfg.notifications[key] = v;
        } else {
          errors.push(
            `notifications.${key}: must be a boolean (true/false); falling back to default`,
          );
        }
      }
    }
  }

  // ── ui ─────────────────────────────────────────────────────
  if (isObject(raw.ui)) {
    const u = raw.ui;

    if ("collection_meta" in u) {
      const v = u.collection_meta;
      if (v === "freshness" || v === "coverage" || v === "both") {
        cfg.ui.collection_meta = v;
      } else {
        errors.push(
          "ui.collection_meta: must be 'freshness' | 'coverage' | 'both'; falling back to default",
        );
      }
    }

    if ("hide_obsidian_when_absent" in u) {
      const v = u.hide_obsidian_when_absent;
      if (isBoolean(v)) {
        cfg.ui.hide_obsidian_when_absent = v;
      } else {
        errors.push(
          "ui.hide_obsidian_when_absent: must be a boolean; falling back to default",
        );
      }
    }
  }

  // ── logs ───────────────────────────────────────────────────
  if (isObject(raw.logs)) {
    const l = raw.logs;

    if ("directory" in l) {
      if (isNonEmptyString(l.directory)) {
        const expanded = expandTilde(l.directory);
        // Constrain logs.directory to paths under the cache or config
        // directories — these are the only paths the Deno allow-write
        // permission grants. Paths outside these roots would cause
        // PermissionDenied at runtime and, if interpolated into the bash
        // -c spawn wrapper, could break shell argument boundaries.
        //
        // Normalize/resolve the candidate and all allowed roots to prevent
        // traversal segments like "../" from bypassing the subtree check.
        const normalized = resolve(expanded);
        const allowedRoots = [
          resolve(expandTilde("~/.cache/qmd-swiftbar")),
          resolve(expandTilde("~/.config/qmd-swiftbar")),
        ];
        const isAllowed = allowedRoots.some(
          (root) => normalized === root || normalized.startsWith(root + "/"),
        );
        if (isAllowed) {
          cfg.logs.directory = normalized;
        } else {
          errors.push(
            `logs.directory: must be under ${
              allowedRoots.join(" or ")
            }; falling back to default`,
          );
        }
      } else {
        errors.push(
          "logs.directory: must be a non-empty string; falling back to default",
        );
      }
    }

    if ("retain_per_action" in l) {
      const v = l.retain_per_action;
      if (isFiniteNumber(v) && v >= 0 && v <= 1000) {
        cfg.logs.retain_per_action = v;
      } else {
        errors.push(
          "logs.retain_per_action: must be a number in [0, 1000]; falling back to default",
        );
      }
    }
  }

  return { config: cfg, errors };
}

// ─── Loaders ───────────────────────────────────────────────────

/** Internal: loadConfig with overridable paths (used by tests and production wrapper). */
export async function loadConfigFrom(
  opts: { configPath: string; examplePath: string },
): Promise<{ config: Config; errors: string[] }> {
  const { configPath, examplePath } = opts;
  const errors: string[] = [];

  // 1. Seed config file on first run.
  let needsSeed = false;
  try {
    await Deno.stat(configPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      needsSeed = true;
    } else {
      errors.push(
        `config: cannot stat ${configPath}: ${stringifyError(err)}`,
      );
      return { config: structuredClone(DEFAULT_CONFIG), errors };
    }
  }

  if (needsSeed) {
    try {
      await ensureDir(dirname(configPath));
    } catch (err) {
      errors.push(
        `config: cannot create directory ${dirname(configPath)}: ${
          stringifyError(err)
        }`,
      );
      return { config: structuredClone(DEFAULT_CONFIG), errors };
    }

    let copiedFromExample = false;
    try {
      await Deno.copyFile(examplePath, configPath);
      copiedFromExample = true;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        errors.push(
          `config: cannot copy example to ${configPath}: ${
            stringifyError(err)
          }`,
        );
        return { config: structuredClone(DEFAULT_CONFIG), errors };
      }
      // Example missing — fall through to writing defaults.
    }

    if (!copiedFromExample) {
      try {
        const yaml = stringifyYaml(DEFAULT_CONFIG as unknown as object);
        await Deno.writeTextFile(configPath, yaml);
      } catch (err) {
        errors.push(
          `config: cannot write default config to ${configPath}: ${
            stringifyError(err)
          }`,
        );
        return { config: structuredClone(DEFAULT_CONFIG), errors };
      }
    }
  }

  // 2. Read.
  let text: string;
  try {
    text = await Deno.readTextFile(configPath);
  } catch (err) {
    errors.push(
      `config: cannot read ${configPath}: ${stringifyError(err)}`,
    );
    return { config: structuredClone(DEFAULT_CONFIG), errors };
  }

  // 3. Parse.
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    errors.push(
      `config: YAML parse failed for ${configPath}: ${stringifyError(err)}`,
    );
    return { config: structuredClone(DEFAULT_CONFIG), errors };
  }

  // 4. Validate.
  const { config, errors: validationErrors } = validateConfig(parsed);
  return { config, errors: [...errors, ...validationErrors] };
}

/** Load and validate config; create from example on first run; fall back to defaults on parse failure. */
export async function loadConfig(): Promise<
  { config: Config; errors: string[] }
> {
  return await loadConfigFrom({
    configPath: CONFIG_PATH,
    examplePath: EXAMPLE_CONFIG_PATH,
  });
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

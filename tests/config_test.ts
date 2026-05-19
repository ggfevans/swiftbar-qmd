import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import { join } from "@std/path";
import {
  DEFAULT_CONFIG,
  EXAMPLE_CONFIG_PATH,
  loadConfigFrom,
  validateConfig,
} from "../lib/config.ts";

// ─── Helpers ───────────────────────────────────────────────────

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  // Force base under /tmp so the test suite stays within --allow-write=/tmp.
  const dir = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "swiftbar-qmd-test-",
  });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ─── Tests ─────────────────────────────────────────────────────

Deno.test("loadConfigFrom: copies example when CONFIG_PATH missing", async () => {
  await withTempDir(async (dir) => {
    const examplePath = join(dir, "config.example.yml");
    const configPath = join(dir, "sub", "config.yml");

    await Deno.writeTextFile(examplePath, stringifyYaml(DEFAULT_CONFIG));

    const { config, errors } = await loadConfigFrom({
      configPath,
      examplePath,
    });

    assertEquals(errors, []);
    assertEquals(config, DEFAULT_CONFIG);
    // The config file should now exist (copied from example)
    const stat = await Deno.stat(configPath);
    assertEquals(stat.isFile, true);
  });
});

Deno.test("loadConfigFrom: writes DEFAULT_CONFIG yaml when example also missing", async () => {
  await withTempDir(async (dir) => {
    const examplePath = join(dir, "does-not-exist.yml");
    const configPath = join(dir, "sub", "config.yml");

    const { config, errors } = await loadConfigFrom({
      configPath,
      examplePath,
    });

    assertEquals(errors, []);
    assertEquals(config, DEFAULT_CONFIG);
    const stat = await Deno.stat(configPath);
    assertEquals(stat.isFile, true);
  });
});

Deno.test("loadConfigFrom: valid YAML round-trips identically (example matches DEFAULT_CONFIG)", async () => {
  await withTempDir(async (dir) => {
    const examplePath = join(dir, "config.example.yml");
    const configPath = join(dir, "config.yml");

    // Read the repo's actual config.example.yml content
    const repoExample = await Deno.readTextFile(
      new URL("../config.example.yml", import.meta.url),
    );
    await Deno.writeTextFile(examplePath, repoExample);
    await Deno.writeTextFile(configPath, repoExample);

    const { config, errors } = await loadConfigFrom({
      configPath,
      examplePath,
    });

    assertEquals(errors, []);
    assertEquals(config, DEFAULT_CONFIG);
  });
});

Deno.test("validateConfig: coverage.amber_percent = -5 falls back to 95", () => {
  const raw = {
    rollup: { coverage: { amber_percent: -5, red_percent: 50 } },
  };
  const { config, errors } = validateConfig(raw);
  assertEquals(config.rollup.coverage.amber_percent, 95);
  assertEquals(errors.length > 0, true);
  const joined = errors.join("\n");
  assertStringIncludes(joined, "amber_percent");
});

Deno.test("validateConfig: coverage.red_percent = 200 falls back to 50", () => {
  const raw = {
    rollup: { coverage: { amber_percent: 95, red_percent: 200 } },
  };
  const { config, errors } = validateConfig(raw);
  assertEquals(config.rollup.coverage.red_percent, 50);
  assertEquals(errors.length > 0, true);
  const joined = errors.join("\n");
  assertStringIncludes(joined, "red_percent");
});

Deno.test("validateConfig: freshness.red_days = 0.5 falls back to 7", () => {
  // amber_hours/24 = 1, so red_days must be > 1
  const raw = {
    rollup: { freshness: { amber_hours: 24, red_days: 0.5 } },
  };
  const { config, errors } = validateConfig(raw);
  assertEquals(config.rollup.freshness.red_days, 7);
  assertEquals(errors.length > 0, true);
  const joined = errors.join("\n");
  assertStringIncludes(joined, "red_days");
});

Deno.test("validateConfig: notifications.on_op_failure = 'true' (string) falls back to true", () => {
  const raw = {
    notifications: { on_op_failure: "true" },
  };
  const { config, errors } = validateConfig(raw);
  assertEquals(config.notifications.on_op_failure, true);
  assertEquals(errors.length > 0, true);
  const joined = errors.join("\n");
  assertStringIncludes(joined, "on_op_failure");
});

Deno.test("validateConfig: ui.collection_meta = 'invalid' falls back to 'freshness'", () => {
  const raw = {
    ui: { collection_meta: "invalid" },
  };
  const { config, errors } = validateConfig(raw);
  assertEquals(config.ui.collection_meta, "freshness");
  assertEquals(errors.length > 0, true);
  const joined = errors.join("\n");
  assertStringIncludes(joined, "collection_meta");
});

Deno.test("validateConfig: missing keys default cleanly (empty object)", () => {
  const { config, errors } = validateConfig({});
  assertEquals(config, DEFAULT_CONFIG);
  assertEquals(errors, []);
});

Deno.test("validateConfig: extra unknown keys ignored, no errors", () => {
  const raw = {
    qmd: { index_path: "~/.cache/qmd/index.sqlite", whatever: 123 },
    rollup: { something_new: true },
    new_section: { foo: "bar" },
  };
  const { config, errors } = validateConfig(raw);
  assertEquals(errors, []);
  assertEquals(config, DEFAULT_CONFIG);
});

// ─── Bonus coverage: cross-key invariants ──────────────────────

Deno.test("validateConfig: error_window.amber_hours <= red_hours falls back to default", () => {
  const raw = {
    rollup: { error_window: { red_hours: 5, amber_hours: 2 } },
  };
  const { config, errors } = validateConfig(raw);
  // red_hours=5 is valid (0 < 5 ≤ 168), but amber_hours=2 is < red_hours, so amber falls back
  assertEquals(config.rollup.error_window.red_hours, 5);
  assertEquals(config.rollup.error_window.amber_hours, 24);
  assertEquals(errors.length > 0, true);
});

Deno.test("validateConfig: ~ expansion in qmd.index_path", () => {
  const raw = { qmd: { index_path: "~/somewhere/index.sqlite" } };
  const { config, errors } = validateConfig(raw);
  assertEquals(errors, []);
  const home = Deno.env.get("HOME");
  assertExists(home);
  assertEquals(config.qmd.index_path, `${home}/somewhere/index.sqlite`);
});

Deno.test("validateConfig: invalid daemon_url falls back to default", () => {
  const raw = { qmd: { daemon_url: "not-a-url" } };
  const { config, errors } = validateConfig(raw);
  assertEquals(config.qmd.daemon_url, DEFAULT_CONFIG.qmd.daemon_url);
  assertEquals(errors.length > 0, true);
});

Deno.test("loadConfigFrom: malformed YAML returns DEFAULT_CONFIG with errors", async () => {
  await withTempDir(async (dir) => {
    const examplePath = join(dir, "config.example.yml");
    const configPath = join(dir, "config.yml");

    // Malformed YAML
    await Deno.writeTextFile(configPath, "qmd:\n  index_path: [unterminated");
    await Deno.writeTextFile(examplePath, stringifyYaml(DEFAULT_CONFIG));

    const { config, errors } = await loadConfigFrom({
      configPath,
      examplePath,
    });
    assertEquals(config, DEFAULT_CONFIG);
    assertEquals(errors.length > 0, true);
  });
});

// ─── EXAMPLE_CONFIG_PATH decoding (PR #1: A5) ─────────────────

Deno.test("EXAMPLE_CONFIG_PATH: returns a decoded POSIX path (no percent escapes)", () => {
  // Regression: with `.pathname`, the SwiftBar default install location
  // (`~/Library/Application Support/SwiftBar/Plugins`) produces a path
  // with `%20` literals. Deno.copyFile then fails with NotFound and the
  // seed-from-example path silently degrades to writing serialized
  // defaults. `fromFileUrl` keeps the path round-trippable to disk ops.
  assertEquals(
    EXAMPLE_CONFIG_PATH.includes("%20"),
    false,
    "decoded path must not contain %20",
  );
  assertEquals(
    EXAMPLE_CONFIG_PATH.includes("%2F"),
    false,
    "decoded path must not contain %2F",
  );
  // And the file referenced by the path must actually exist — proves
  // the decoded path is what `Deno.copyFile` would consume.
  const stat = Deno.statSync(EXAMPLE_CONFIG_PATH);
  assertEquals(stat.isFile, true);
});

// ─── logs.directory validation (security: constrain to allowed roots) ──

Deno.test("validateConfig: logs.directory under cache root is accepted", () => {
  const home = Deno.env.get("HOME") ?? "/tmp/testhome";
  const raw = {
    logs: { directory: `${home}/.cache/swiftbar-qmd/logs` },
  };
  const { config, errors } = validateConfig(raw);
  assertEquals(errors, []);
  assertEquals(
    config.logs.directory,
    `${home}/.cache/swiftbar-qmd/logs`,
  );
});

Deno.test("validateConfig: logs.directory under config root is accepted", () => {
  const home = Deno.env.get("HOME") ?? "/tmp/testhome";
  const raw = {
    logs: { directory: `${home}/.config/swiftbar-qmd/logs` },
  };
  const { config, errors } = validateConfig(raw);
  assertEquals(errors, []);
  assertEquals(
    config.logs.directory,
    `${home}/.config/swiftbar-qmd/logs`,
  );
});

Deno.test("validateConfig: logs.directory outside allowed roots falls back to default", () => {
  const raw = {
    logs: { directory: "/tmp/outside-allowed-path" },
  };
  const { config, errors } = validateConfig(raw);
  // Falls back to the default (~/.cache/swiftbar-qmd/logs).
  assertEquals(config.logs.directory, DEFAULT_CONFIG.logs.directory);
  assertEquals(errors.length > 0, true);
  const joined = errors.join("\n");
  assertStringIncludes(joined, "logs.directory");
});

Deno.test("validateConfig: logs.directory with tilde under cache root is accepted", () => {
  const raw = {
    logs: { directory: "~/.cache/swiftbar-qmd/logs" },
  };
  const { config, errors } = validateConfig(raw);
  assertEquals(errors, []);
  const home = Deno.env.get("HOME") ?? "/tmp/testhome";
  assertEquals(config.logs.directory, `${home}/.cache/swiftbar-qmd/logs`);
});

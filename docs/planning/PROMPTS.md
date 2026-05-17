# swiftbar-qmd — Implementation blueprint and code-gen prompts

This document drives implementation. It contains:

1. A **high-level blueprint** of the major phases.
2. **First-pass chunking** — the natural decomposition by milestone.
3. **Right-sizing iteration** — review and re-chunk until each step is implementable in a single focused session, independently testable, and ends with the new code wired into the running plugin.
4. **Final chunk list** — 17 steps, in order.
5. **Code-gen prompts** — one prompt per step, each building on the previous, ending with integration, no orphaned code.

The canonical specification is [`SPEC.md`](SPEC.md); these prompts cite it heavily rather than re-stating requirements. The decision history is in [`DECISIONS.md`](DECISIONS.md); the background research is in [`RESEARCH.md`](RESEARCH.md).

---

## 1. High-level blueprint

The plugin breaks into seven logical layers, building bottom-up:

1. **Foundation** — Deno project, types, SwiftBar shebang, CI. No behaviour yet.
2. **Inputs** — config loading, first-run detection. Plugin can tell whether qmd is installed and configured.
3. **Utilities** — time formatting, logging, persistence helpers. Used by everything above.
4. **State** — read qmd's current state via SDK + HTTP + filesystem into a typed shape.
5. **Logic** — pure rollup computation: state → tier (green/amber/red/grey).
6. **Output** — menu rendering for healthy state, first-run states, submenus, error states, in-flight states.
7. **Interaction** — action execution (spawn, PID-track, complete), notifications, confirmation dialogs.
8. **Resilience** — defensive read wrapping, top-level error fence.
9. **Verification** — snapshot tests covering every menu state.
10. **Distribution** — install script and polished README.

Each layer is testable in isolation before being wired into the layer above. The plugin is shippable after layer 6 (you'd have a read-only operational view); actions in layer 7 make it interactive; layers 8–10 make it production-ready.

---

## 2. First-pass chunking

The spec's milestones (`SPEC.md` §22) give a starting point. Mapping them directly to chunks:

| # | Chunk | Notes |
|---|-------|-------|
| 1 | Scaffolding | deno.json + entry stub + types + CI |
| 2 | Config & detection | loader + validator + first-run states + first-run menus |
| 3 | State reading | SDK wrapper + daemon probe + persistence + time utils |
| 4 | Rollup & healthy menu | computeTier + healthy menu rendering |
| 5 | Per-collection submenus | submenu rendering + non-action submenu items |
| 6 | Action execution | spawner + locking + completion detection + dialogs |
| 7 | Notifications | diff + emit + dedupe |
| 8 | Snapshot tests + polish | all 10 menu states + README |
| 9 | Release | tag, GH Release, install.sh |

That's 9 milestones. Most of them — especially 2, 3, and 6 — bundle too much into one session and would mean writing a large amount of code before the first integration point. We need finer granularity.

---

## 3. Right-sizing iteration

Reviewing each chunk for whether it's too big, too small, or too tangled:

- **Chunk 1 (Scaffolding)**: right-sized. Single session, ends with plugin loading in SwiftBar.
- **Chunk 2 (Config & detection)**: too big. Config loading and first-run detection are independent surfaces with their own tests; bundling them means writing ~400 lines before the first wire-up. Split into: config loader → first-run detection → first-run menu rendering.
- **Chunk 3 (State reading)**: too big. State has multiple data sources (SDK, daemon probe, FS scans) and depends on utilities (time formatting, persistence) that don't exist yet. Split into: time + logging → persistence → state reader.
- **Chunk 4 (Rollup & healthy menu)**: right-sized. Rollup is a small pure function; healthy menu rendering is the first time we render real data. Could split if either grew, but currently fine as one.
- **Chunk 5 (Per-collection submenus)**: right-sized. Self-contained extension of menu rendering plus the non-action submenu items.
- **Chunk 6 (Action execution)**: way too big. Bundles spawning, PID tracking, completion detection, confirmation dialogs, and in-flight UI. Split into: action runner + argv branching → completion detection + in-flight UI → confirmation dialogs + remaining actions + "Show last output".
- **Chunk 7 (Notifications)**: right-sized. Diff + emit + dedupe are tightly coupled and only useful together.
- **Chunk 8 (Snapshot tests + polish)**: split. Snapshot tests are a distinct effort from README polishing and install script writing.
- **Chunk 9 (Release)**: out of scope for code-gen; this is a manual step.

Also missing from the original chunking:
- **Error handling layer** — defensive read wrapping and top-level fence. Currently distributed across multiple chunks in the spec; better as one focused step after notifications.

### Second iteration

After splitting, the chunk list looks like:

1. Scaffolding + types
2. Config loader
3. First-run detection
4. First-run menu rendering
5. Time helpers + logging
6. Persistence layer
7. State reader
8. Rollup logic
9. Healthy menu rendering
10. Per-collection submenus
11. Action runner — spawn + argv branching
12. Action completion + in-flight UI
13. Confirmation dialogs + remaining actions + "Show last output"
14. Notifications
15. Error handling (defensive reads + top-level fence)
16. Snapshot tests
17. Install script + README polish

17 chunks. Let me sanity-check each against three criteria:

- **Small enough to ship safely:** each chunk produces ≤ ~300 lines of new code (rough heuristic), each with its own tests.
- **Big enough to be worth a session:** every chunk delivers a user-visible or test-visible improvement.
- **Ends with wiring:** the new code is invoked from `qmd.30s.ts` by the end of the step. No orphans.

Going through each:

| # | Lines (est.) | User-visible change | Wired? |
|---|-------------|--------------------|--------|
| 1 | ~150 | Plugin loads, shows hardcoded green icon | ✓ |
| 2 | ~150 + 80 test | Config loads (not yet observable) | ✓ — `main()` calls loadConfig |
| 3 | ~120 + 60 test | Detect runs (not yet observable) | ✓ — `main()` calls detect |
| 4 | ~120 | First-run menus visible | ✓ |
| 5 | ~120 + 60 test | Used in step 6+ | Deferred wiring, OK |
| 6 | ~180 | Used in step 7+ | Deferred wiring, OK |
| 7 | ~200 | State reads run (not yet observable in menu) | ✓ — `main()` calls readCurrentState |
| 8 | ~150 + 200 test | Tier computed (visible: icon colour changes) | ✓ |
| 9 | ~250 | Full healthy menu rendered | ✓ |
| 10 | ~150 | Submenus open with working static actions | ✓ |
| 11 | ~200 | Clicking "Run update" actually runs qmd | ✓ |
| 12 | ~150 | Menu shows "Running…" and detects completion | ✓ |
| 13 | ~150 | All remaining actions work + "Show last output" | ✓ |
| 14 | ~200 + 80 test | Failure notifications fire | ✓ |
| 15 | ~100 | Defensive reads + emergency menu | ✓ |
| 16 | ~50 + 300 test | All 10 snapshot tests | N/A — pure tests |
| 17 | ~200 | install.sh + README polish | N/A — out-of-code |

The only two chunks that defer their wiring are 5 (time + log utilities) and 6 (persistence) — both are pure utility layers that get consumed by chunks 7 and 11 respectively. This is acceptable because they have their own unit tests and the wiring happens within one chunk's distance.

Every other chunk integrates by end of step. No long-lived orphans.

The chunk list is right-sized.

---

## 4. Final chunk list

The 17 steps, with a one-line rationale each:

1. **Scaffolding + types** — gets a green icon in the menubar; everything downstream needs the structure.
2. **Config loader** — every later module needs a `Config` object.
3. **First-run detection** — every later poll needs to short-circuit when qmd isn't usable.
4. **First-run menu rendering** — visible payoff for steps 2–3.
5. **Time helpers + logging** — pure utilities used by state, notifications, persistence.
6. **Persistence layer** — needed before state reads can write snapshots.
7. **State reader** — first real data flowing into the plugin.
8. **Rollup logic** — pure logic over the state shape from step 7.
9. **Healthy menu rendering** — visible payoff for steps 5–8.
10. **Per-collection submenus** — extends menu rendering for the per-collection action surface.
11. **Action runner — spawn + argv branching** — clicking a menu item finally does something.
12. **Action completion + in-flight UI** — closes the action lifecycle loop.
13. **Confirmation dialogs + remaining actions + Show last output** — every menu item works.
14. **Notifications** — failure transitions reach the user.
15. **Error handling (defensive + fence)** — production hardening.
16. **Snapshot tests** — verification.
17. **Install script + README polish** — distribution.

---

## 5. Code-generation prompts

Each prompt is self-contained enough to hand to a coding LLM with access to the repo. Every prompt:

- States what's already in the repo (so the LLM doesn't rebuild things).
- Cites the canonical spec sections.
- Names the exact files to create or modify.
- Names the exact exports/functions/types.
- Specifies tests with concrete cases.
- Ends with a wiring step into the existing structure.
- States the acceptance condition for the step to be considered done.

Prompts are designed to be applied in order. Earlier prompts produce code that later prompts depend on. **Do not skip ahead.**

---

### Prompt 1 — Scaffolding + types

Context: the repo currently contains only `LICENSE` and `docs/planning/*.md`. There is no code yet. This step creates the project skeleton so the plugin loads in SwiftBar showing a placeholder icon.

```text
You are implementing swiftbar-qmd, a SwiftBar plugin for monitoring qmd state.
The canonical spec is docs/planning/SPEC.md; the decision rationale is in docs/planning/DECISIONS.md.

Repo state before this step: only LICENSE and docs/planning/*.md exist.

Step 1 of 17 — Scaffolding + types.

Create the following files:

1. deno.json
   - Tasks: "test" (deno test --allow-read --allow-env --allow-net=localhost --allow-write=/tmp),
            "fmt" (deno fmt), "lint" (deno lint), "check" (deno check qmd.30s.ts lib/**/*.ts tests/**/*.ts).
   - Imports map for jsr:@std/yaml, jsr:@std/path, jsr:@std/fs, jsr:@std/testing, npm:@tobilu/qmd.
   - Use specifier versions documented in SPEC.md §4.3.
   - Format and lint config set to default Deno (no overrides).

2. qmd.30s.ts at the repo root.
   - Exact shebang from SPEC.md §4.2.
   - SwiftBar metadata header per SPEC.md §4 (title, version v0.1.0, author Gareth Evans, GitHub ggfevans, desc, dependencies, abouturl).
   - main() function that prints exactly:
       "🟢"
       "---"
       "swiftbar-qmd v0.1.0 | size=12 color=#8a8a8e shell="
       "Show planning docs | bash=\"open\" param1=\"https://github.com/ggfevans/swiftbar-qmd\" terminal=false"
     then exits 0. Use console.log lines.
   - Top-level: await main().

3. lib/types.ts containing every type from SPEC.md §6 verbatim:
   Config, CurrentState, CollectionState, IndexStatus, DaemonState, FirstRunState,
   Tier, TierReason, JobInfo, FailureRecord, ActionId, PollSnapshot,
   NotificationEvent, LogFileInfo.
   Pure type-only module; no runtime code. Export everything.

4. config.example.yml at the repo root.
   The full YAML config tree from SPEC.md §7.2, including the inline comments. This file ships verbatim and is also copied to ~/.config/swiftbar-qmd/config.yml on first run.

5. .github/workflows/ci.yml
   Verbatim from SPEC.md §20.

6. README.md (scaffold only).
   - One-line description.
   - "Status: in development" note.
   - Sections (empty stubs OK for now): Install, Configure, Usage, Development.
   - Link to docs/planning/SPEC.md.

7. CHANGELOG.md
   "# Changelog\n\n## [Unreleased]\n\n### Added\n- Project scaffolding (v0.1.0 placeholder)\n"

8. .gitignore
   Standard Deno gitignore: deno.lock kept (per spec), but ignore /node_modules, /.deno_cache, *.log.

9. tests/.gitkeep
   Placeholder so the tests directory exists.

Make qmd.30s.ts executable (chmod +x). After this step, dropping qmd.30s.ts into ~/Library/Application Support/SwiftBar/Plugins/ and restarting SwiftBar should display "🟢" in the menubar with a two-item dropdown.

Run: deno fmt && deno lint && deno check qmd.30s.ts lib/**/*.ts
All three must succeed.

Acceptance: file tree matches SPEC.md §5.1; deno commands all pass; qmd.30s.ts is executable; no test failures (there are no tests yet).

Do not add code that won't be reached from main() or imported from a future module specified in SPEC.md §5.2.
```

---

### Prompt 2 — Config loader

Context: scaffolding is in place. We now need every later module to be able to load configuration.

```text
Step 2 of 17 — Config loader.

Repo state: after step 1. Types in lib/types.ts; config.example.yml at root.

Create lib/config.ts implementing the contract in SPEC.md §5.2 (config.ts section):

  export const CONFIG_PATH: string;
  export const EXAMPLE_CONFIG_PATH: string;
  export const DEFAULT_CONFIG: Config;
  export async function loadConfig(): Promise<{ config: Config; errors: string[] }>;
  export function validateConfig(raw: unknown): { config: Config; errors: string[] };

Requirements:

- DEFAULT_CONFIG must match SPEC.md §7.2 exactly (after YAML parsing).
- CONFIG_PATH = ~/.config/swiftbar-qmd/config.yml with ~ expanded via Deno.env.get('HOME').
- EXAMPLE_CONFIG_PATH = config.example.yml resolved relative to the script.
- loadConfig:
    1. If CONFIG_PATH doesn't exist, copy EXAMPLE_CONFIG_PATH there (creating ~/.config/swiftbar-qmd/ if needed). If the example also doesn't exist, write DEFAULT_CONFIG serialised to YAML.
    2. Read the file.
    3. Parse with jsr:@std/yaml.
    4. Validate via validateConfig.
    5. Return { config, errors }.
    6. Never throw — every error path returns DEFAULT_CONFIG plus a populated errors array.
- validateConfig applies every rule in SPEC.md §7.2's validation table. Each violation produces a string in errors and falls back to the default value for that key. Unknown keys are ignored silently (forward compatibility).

Tests in tests/config_test.ts using jsr:@std/testing/asserts:

  - default config loaded when CONFIG_PATH missing (use /tmp/swiftbar-qmd-test/ to avoid touching user home)
  - valid YAML round-trips identically
  - rollup.coverage.amber_percent = -5 → falls back to 95, errors contains the violation string
  - rollup.coverage.red_percent = 200 → falls back to 50
  - rollup.freshness.red_days = 0.5 (< amber_hours/24) → falls back to 7
  - notifications.on_op_failure = "true" (string) → falls back to true, error noted
  - ui.collection_meta = "invalid" → falls back to 'freshness'
  - missing keys default cleanly
  - extra unknown keys ignored, no errors

To avoid touching user paths in tests, take CONFIG_PATH and EXAMPLE_CONFIG_PATH as overridable parameters (e.g. via internal helper or env var); the production CONFIG_PATH constant stays as a default.

Wiring: at the top of main() in qmd.30s.ts, call await loadConfig() and store the result in a local variable. Discard the result for now (still print the hardcoded menu). Imports from lib/config.ts must resolve and the type check must pass.

Run: deno test --allow-read --allow-env --allow-write=/tmp tests/config_test.ts — all tests pass.
Run: deno check qmd.30s.ts lib/**/*.ts tests/**/*.ts — passes.

Acceptance: loadConfig returns valid Config in every test case; main() invokes it without changing visible behaviour.
```

---

### Prompt 3 — First-run detection

Context: config now loads. Next we need to decide which top-level state we're in (qmd installed? has collections? has docs?).

```text
Step 3 of 17 — First-run detection.

Repo state: after step 2. lib/config.ts works.

Create lib/detect.ts implementing SPEC.md §5.2 detect.ts section:

  export async function detectFirstRunState(config: Config): Promise<FirstRunState>;

Implementation requirements (SPEC.md §12 + §5.2):

1. Check qmd binary on $PATH using Deno.Command('which', { args: ['qmd'] }). Return 'no-qmd' if absent.
2. Try await import('npm:@tobilu/qmd'). If it throws (caught), return 'no-qmd'.
3. Deno.stat(config.qmd.index_path) — if not found, return 'no-collections'.
4. createStore({ dbPath: config.qmd.index_path }).listCollections() — if empty array, return 'no-collections'. Close the store afterwards.
5. If at least one collection has doc_count > 0, return 'ok'. Otherwise 'empty-index'.

Constraints:

- Per-check timeout of 100ms using a withTimeout helper inline (we'll factor it out in step 5). Total budget: 500ms.
- Failures cascade to the most recoverable state per the order above.
- Never throw out of detectFirstRunState; on unexpected errors, log to stderr and return 'no-qmd'.

Tests in tests/detect_test.ts:

Because real qmd detection touches the user's machine, use dependency injection: refactor detectFirstRunState to accept an optional second argument with mocked check functions:

  type Probes = {
    hasQmdBinary: () => Promise<boolean>;
    canImportSdk: () => Promise<boolean>;
    indexExists: (path: string) => Promise<boolean>;
    listCollections: (path: string) => Promise<Array<{ name: string; doc_count: number }>>;
  };
  export async function detectFirstRunState(config: Config, probes?: Probes): Promise<FirstRunState>;

When probes is omitted, use the production implementations. When provided, use the mocks. This is how detect_test.ts gets coverage without a real qmd install.

Test cases (all using mocked probes):
- All conditions met → 'ok'
- hasQmdBinary false → 'no-qmd'
- canImportSdk false → 'no-qmd'
- indexExists false → 'no-collections'
- listCollections returns [] → 'no-collections'
- listCollections returns one entry with doc_count: 0 → 'empty-index'
- listCollections returns mixed (some with 0, some with > 0) → 'ok'

Wiring: in main() after loadConfig, call detectFirstRunState(config). Store the result. Still print the hardcoded menu. The next step will switch on the result.

Run: deno test --allow-read --allow-env --allow-write=/tmp tests/ — all tests still pass.
Run: deno check.

Acceptance: detectFirstRunState returns the right value for each mocked scenario; main() invokes it without changing visible behaviour.
```

---

### Prompt 4 — First-run menu rendering

Context: we know the first-run state but always render the same menu. Now we render different menus per state.

```text
Step 4 of 17 — First-run menu rendering.

Repo state: after step 3. detect.ts is in place.

Create lib/menu.ts with one export so far:

  export function renderFirstRunMenu(firstRun: Exclude<FirstRunState, 'ok'>, config: Config): string;

Render the three first-run menus exactly per SPEC.md §12.1, §12.2, §12.3.

Requirements:

- Output is a single string ending with a newline; lines joined by '\n'.
- Use template literals; no formatting library.
- For 'no-qmd' and 'no-collections' the icon is the grey hollow Q glyph from SPEC.md §9.3. Pre-compute the base64 of the SVG and embed it as a const at the top of menu.ts.
- For 'empty-index' the icon is amber-filled (use the filled Q SVG with color=#ec9b2c).
- The plugin path used in 'Re-check now' bash directives must be Deno.mainModule (URL-converted to filesystem path).
- Use the config.qmd.index_path / config paths where the spec says to.

Add a simple helper that returns the absolute path of the running script (Deno.mainModule URL → path), exported as getPluginPath() for reuse later.

Tests: not added in this step. Snapshot tests for first-run menus come in step 16.

Wiring: in main(), branch on detectFirstRunState's result:

  if (firstRun !== 'ok') {
    console.log(renderFirstRunMenu(firstRun, config));
    Deno.exit(0);
  }

Below that branch, keep the hardcoded green-icon output for now (step 9 replaces it).

Verify by uninstalling qmd or temporarily moving it out of $PATH: the menu should switch to 'no-qmd' shape. Restoring qmd should bring back the hardcoded healthy placeholder.

Run: deno fmt && deno lint && deno check && deno test — all pass.

Acceptance: dropping the plugin into SwiftBar shows the right first-run menu for each of the three unhealthy states; falls through to the placeholder when state is 'ok'.
```

---

### Prompt 5 — Time helpers + logging

Context: we need shared utilities before building the state reader. Time formatting appears in menus and notifications; logging is needed for error reporting.

```text
Step 5 of 17 — Time helpers + logging.

Repo state: after step 4.

Create lib/time.ts with the contract from SPEC.md §5.2:

  export function compactDuration(ms: number): string;
  export function relativeTime(date: Date, now?: Date): string;
  export function withTimeout<T>(p: Promise<T>, ms: number, label?: string): Promise<T>;

Implementation requirements:

- compactDuration:
    < 60s        → "30s"
    < 60m        → "5m"
    < 24h        → "1h 30m" (drop the minutes if exactly on the hour: "2h")
    < 7d         → "1d 1h" (drop hours if zero)
    >= 7d        → "1w 2d"
  Negative durations → "0s".
- relativeTime:
    < 60s        → "just now"
    < 60m        → "5 minutes ago" / "1 minute ago"
    < 24h        → "5 hours ago" / "1 hour ago"
    < 48h        → "yesterday"
    < 7d         → "3 days ago"
    < 14d        → "1 week ago"
    >= 14d       → "{N} weeks ago"
  Future dates → "just now" (treat as zero).
- withTimeout:
    Returns Promise.race of [p, timeout-rejection].
    Reject with new Error(`Timed out after ${ms}ms${label ? ` (${label})` : ''}`).

Tests in tests/time_test.ts covering each branch above. At least 20 cases.

Create lib/log.ts with the contract from SPEC.md §5.2:

  export async function logError(category: string, message: string, error?: Error): Promise<void>;
  export async function logInfo(category: string, message: string): Promise<void>;

Implementation requirements:

- Log file path: ${CACHE_DIR}/error.log where CACHE_DIR = ~/.cache/swiftbar-qmd.
- Format: `${new Date().toISOString()} [${level}] ${category}: ${message}` plus '\n${error.stack}\n' if error present.
- Rotate: before write, if file size > 1 MB, rename to error.log.1 (overwriting any existing .1), then write to a fresh error.log.
- Ensure CACHE_DIR exists (Deno.mkdir with recursive).
- Never throw. On write failure, swallow silently — there is nowhere to log a logging failure.

No tests for lib/log.ts in this step (it's used in steps 6–14; we'll cover it via integration there).

Wiring: nothing yet — these utilities are consumed by steps 6, 7, and 11+. This is the only step in the whole sequence that defers wiring beyond one step, and only because the utilities have no current caller and adding fake calls would be worse than the brief deferral.

Run: deno fmt && deno lint && deno check && deno test tests/time_test.ts — all pass.

Acceptance: time tests all green; lib/log.ts compiles; main() unchanged.
```

---

### Prompt 6 — Persistence layer

Context: time + log utilities exist. Now build the persistence layer that snapshot, jobs, and failure tracking will use.

```text
Step 6 of 17 — Persistence layer.

Repo state: after step 5. lib/time.ts and lib/log.ts available.

Create lib/persistence.ts implementing the full contract from SPEC.md §5.2 persistence section:

  export const CACHE_DIR: string;

  export async function readSnapshot(): Promise<PollSnapshot | null>;
  export async function writeSnapshot(snapshot: PollSnapshot): Promise<void>;

  export async function readJobPidFiles(): Promise<JobInfo[]>;
  export async function writeJobPidFile(action: ActionId, info: JobInfo): Promise<void>;
  export async function deleteJobPidFile(action: ActionId): Promise<void>;

  export async function readRecentFailures(): Promise<FailureRecord[]>;
  export async function appendFailure(failure: FailureRecord): Promise<void>;
  export async function pruneFailuresOlderThan(hours: number): Promise<void>;

  export async function logsDirContents(): Promise<LogFileInfo[]>;
  export async function pruneLogs(retainPerAction: number): Promise<void>;

Requirements:

- CACHE_DIR = ~/.cache/swiftbar-qmd (expand ~ from Deno.env.get('HOME')).
- Subdirs: jobs/, logs/, sentinels/. Ensure on every call that touches them.
- File schemas match SPEC.md §15 exactly:
    last-poll.json     — see §15.1 (PollSnapshot serialised)
    jobs/<action>.pid  — see §15.3 (JobInfo serialised; null collection becomes JSON null)
    recent-failures.json — array of FailureRecord, newest first, capped at 50.
- For per-collection jobs, the lockfile name is `<action>:<collection>.pid` (URL-safe; colon is fine on macOS).
- writeSnapshot uses atomic rename: write to last-poll.json.tmp, then Deno.rename.
- All Date fields serialise as ISO strings, deserialise via new Date(str).
- "File does not exist" is never an error: readers return null or empty array. Use try/catch on Deno.stat / Deno.readTextFile.
- appendFailure prepends to the array, then truncates to 50.
- pruneFailuresOlderThan reads, filters out entries whose failedAt is older than `hours`, writes back.
- pruneLogs lists logs/ grouped by action prefix, sorts by mtime desc, deletes anything past index `retainPerAction-1`.

Tests in tests/persistence_test.ts:

Use a temporary CACHE_DIR via an internal setCacheDir helper or environment variable override (SWIFTBAR_QMD_CACHE_DIR). In production, default to ~/.cache/swiftbar-qmd; in tests, override to a per-test temp directory.

Test cases:
- writeSnapshot then readSnapshot round-trips (Date fields preserved)
- readSnapshot on missing file returns null
- writeJobPidFile then readJobPidFiles returns the entry
- deleteJobPidFile removes it
- appendFailure twice then readRecentFailures returns both, newest first
- appendFailure 60 times then readRecentFailures returns 50 (newest)
- pruneFailuresOlderThan(1) with mixed-age entries keeps only those within 1 hour
- pruneLogs(2) with 5 logs for one action keeps the 2 newest

Wiring: in main(), after the loadConfig + detectFirstRunState block but still before the hardcoded output, call await readSnapshot() and discard. This proves the module loads and the cache dir gets created on first run.

Run: deno fmt && deno lint && deno check && deno test — all pass.

Acceptance: persistence_test.ts green; main() ensures CACHE_DIR exists on first invocation; visible behaviour unchanged.
```

---

### Prompt 7 — State reader

Context: utilities and persistence exist. Now build the actual state reader that pulls from qmd via SDK + HTTP + filesystem.

```text
Step 7 of 17 — State reader.

Repo state: after step 6.

Create lib/state.ts implementing SPEC.md §5.2 state.ts section:

  export async function readCurrentState(config: Config): Promise<CurrentState>;

Composition per SPEC.md §3.2 and §8:

  const collections = await readCollections(config);     // SDK call, withTimeout 2000ms
  const status      = await readIndexStatus(config);     // SDK call, withTimeout 2000ms
  const daemon      = await probeDaemon(config);         // HTTP, withTimeout 5000ms
  const inFlightJobs    = await readJobPidFiles();       // from lib/persistence
  const recentFailures  = await readRecentFailures();    // from lib/persistence
  return { collections, status, daemon, inFlightJobs, recentFailures, polledAt: new Date() };

Subroutines:

- readCollections:
    1. const { createStore } = await import('npm:@tobilu/qmd');
    2. const store = await createStore({ dbPath: config.qmd.index_path });
    3. const raw = await store.listCollections();
    4. For each entry, compute CollectionState fields:
       - name, path (= raw.pwd), qmdUri (`qmd://${name}/`), pattern (= raw.glob_pattern), docCount, lastModified.
       - reachable: await Deno.stat(path) succeeds.
       - hasObsidian: await Deno.stat(`${path}/.obsidian`) succeeds.
       - coveragePercent: derived from status.embedded_chunks / status.total_chunks * 100 (per collection if available; else 100 if docCount === 0; else compute from raw.active_count / raw.doc_count * 100).
    5. await store.close().
    6. On any error: return [] with the error logged.

- readIndexStatus: similar pattern, returns IndexStatus or { totalDocs: 0, totalCollections: 0, dbSizeBytes: 0, modelCacheBytes: 0, error: 'message' }.

- probeDaemon:
    1. Try `fetch(`${config.qmd.daemon_url}/health`)` wrapped in withTimeout(5000).
    2. On 200: parse response (uptime + pid if available), return DaemonState with status: 'running'.
    3. On connection refused / NetworkError: status: 'stopped'.
    4. On timeout: status: 'unresponsive'.
    5. On 5xx: status: 'unresponsive' with error noted.

Robustness:

- Wrap each subroutine in try/catch; never let readCurrentState throw.
- Use lib/time withTimeout for SDK and HTTP calls.
- On SDK import failure (already excluded by detectFirstRunState, but defensively): collections = [], status with error.

Tests in tests/state_test.ts: skip integration tests with real qmd. Instead, factor out the four data-source functions to be injectable via an optional second arg to readCurrentState (same dependency-injection pattern as detect.ts). Test that readCurrentState assembles results correctly and survives any single subroutine throwing.

Wiring: in main(), after the first-run branch and the readSnapshot() call from step 6, call:

  const state = await readCurrentState(config);

Store it; still render the hardcoded placeholder menu. Step 8 will use `state` to compute the tier; step 9 will render it.

Run: deno fmt && deno lint && deno check && deno test — all pass.

Acceptance: state_test.ts green; main() calls readCurrentState and survives a real qmd install returning real data (manual smoke test).
```

---

### Prompt 8 — Rollup logic

Context: real state flows into the plugin. Now compute the tier.

```text
Step 8 of 17 — Rollup logic.

Repo state: after step 7.

Create lib/rollup.ts implementing SPEC.md §5.2 rollup.ts section:

  export function computeTier(state: CurrentState, config: Config): Tier;
  export function computeTierWithReason(state: CurrentState, config: Config): TierReason;

Implementation must match SPEC.md §9.1 exactly. Pure function — no I/O, no async, no Date.now() (current time comes from state.polledAt).

For computeTierWithReason, accumulate every triggering condition as a human-readable string into TierReason.drivers (not just the first), per SPEC.md §9.2. Example messages:

  "Daemon stopped"
  "Daemon unresponsive"
  "Collection Rackula path unreachable: /Users/.../rackula"
  "Recent failure: update-all 30m ago"
  "gVault below 95% coverage (87%)"
  "Rackula last updated 1d ago (>24h)"
  "Update job in flight"

Tier still computed by the precedence in §9.1; drivers list is supplementary.

Tests in tests/rollup_test.ts — exhaustive table-driven, at least the cases enumerated in SPEC.md §19.1 "rollup_test.ts":

  - Empty state → grey
  - All green
  - Single collection past amber freshness → amber
  - Single collection past red freshness → red
  - Single collection below amber coverage → amber
  - Single collection below red coverage → red
  - Daemon stopped → red
  - Daemon unresponsive → red
  - Collection unreachable → red
  - Recent failure within red_hours → red
  - Recent failure within amber_hours → amber
  - In-flight job → amber (overrides green)
  - Precedence: red beats amber beats green when both present
  - drivers list contains every triggering condition

Use a helper buildState({...overrides}) in the test file that constructs a healthy baseline CurrentState and applies overrides per test case.

Wiring: in main(), after readCurrentState, compute:

  const tier = computeTierWithReason(state, config);

Pass `tier.tier` into the icon line of the hardcoded menu by mapping:
  green → "🟢", amber → "🟡", red → "🔴", grey → "⚪"

This is a visible smoke test: icon colour now reflects real qmd state, even though the rest of the menu is still placeholder.

Run: deno fmt && deno lint && deno check && deno test — all pass; coverage on rollup.ts at 100% branches.

Acceptance: rollup_test.ts exhaustive; icon colour in menubar visibly reflects qmd state (e.g. stop the daemon, see red).
```

---

### Prompt 9 — Healthy menu rendering

Context: tier is computed. Now render the real menu in place of the placeholder.

```text
Step 9 of 17 — Healthy menu rendering.

Repo state: after step 8.

Extend lib/menu.ts with:

  export function renderMenu(state: CurrentState, tier: TierReason, config: Config): string;

Implementation per SPEC.md §10 and Appendix A:

- First line is the menubar item. Use the filled Q SVG (base64) with color set to the tier's hex:
    green  #2fa84f
    amber  #ec9b2c
    red    #d8453f
    grey   uses the hollow SVG, no color override
  Format:
    `| image=<base64> templateImage=true color=<hex> tooltip="<summary>"`
  Tooltip is the first driver string, or "All clear" if none.
- Then "---".
- Status section (header "Status | size=10 color=#8a8a8e shell="):
    "● Daemon running | color=#2fa84f size=12 shell= length=44 trim=false"
    appended right-aligned uptime via compactDuration(state.daemon.uptimeSeconds*1000)
    OR "● Daemon stopped" / "● Daemon unresponsive" with red color
    Second row: collection-drift auto-summary
       count = number of collections whose tier is amber-or-worse
       text = "All collections healthy" | "1 collection drifting" | `${N} collections drifting`
    Third row: "Last update    <relative>" using the most recent lastModified across collections.
- "---"
- Collections section: header "Collections (N) | size=10 color=#8a8a8e shell="
  One row per collection:
    "● <name>           <docCount> · <freshness>"
    (use compactDuration for freshness; freshness defaults to '?' if lastModified is null)
    Color per collection (compute per-collection tier with helper from rollup.ts).
  Submenus and the ▸ indicator come in step 10 — for now render flat rows.
- "---"
- Global actions section: header "Global actions | size=10 color=#8a8a8e shell="
    "↻ Update all collections | bash=\"${pluginPath}\" param1=\"--action\" param2=\"update-all\" terminal=false refresh=true shortcut=CmdOrCtrl+U"
    "⚡ Embed all (new only) | … shortcut=CmdOrCtrl+E"
    "⟳ Restart MCP daemon | …"
    "■ Stop MCP daemon | …" (only when daemon.status === 'running')
    "▶ Start MCP daemon | …" (only when daemon.status !== 'running')
    "🧹 Cleanup orphaned data… | …"
- "---"
    "⧉ Copy MCP endpoint URL | bash=\"…\" param1=\"<endpoint>\" terminal=false" (use macOS pbcopy)
    "›_ Show qmd status in Terminal | bash=\"qmd\" param1=\"status\" terminal=true"
- "---"
    "⚙ Preferences… | bash=\"open\" param1=\"-t\" param2=\"<config-path>\" terminal=false shortcut=CmdOrCtrl+Comma"
    "ⓘ About swiftbar-qmd | bash=\"open\" param1=\"https://github.com/ggfevans/swiftbar-qmd\" terminal=false"

Actions in this step DO NOT NEED to actually do anything yet; the bash directives are wired to the plugin's own path, which will route to runAction in step 11. Until then, clicking an action will re-invoke the plugin with --action <id>, which currently falls through to the poll path; that's fine.

Also extend menu.ts with a per-collection-tier helper used by the Collections section:

  function collectionTier(c: CollectionState, config: Config): Tier;

Reusing rollup logic on a single-collection slice of state.

Tests in this step: not yet; snapshot tests are step 16.

Wiring: replace the hardcoded placeholder output in main() with:

  console.log(renderMenu(state, tier, config));

Run: deno fmt && deno lint && deno check && deno test — all pass.

Acceptance: dropping the plugin into SwiftBar with a real qmd install shows the full healthy menu structure with live data. Submenus are absent (step 10), action clicks invoke the plugin recursively but don't do anything (step 11).
```

---

### Prompt 10 — Per-collection submenus

Context: top-level menu shows real data. Now add per-collection submenus with the non-action items working.

```text
Step 10 of 17 — Per-collection submenus.

Repo state: after step 9.

Extend lib/menu.ts:

For each collection row in renderMenu, append a submenu block per SPEC.md §11. SwiftBar submenu syntax: two-space-indented lines below the parent row become submenu items in older SwiftBar, OR a `submenu=true` block in v2. Use two-space indentation (more portable) and add a "▸" suffix to the parent row's text.

Submenu structure per SPEC.md §11:

  Header (collection name) | size=10 color=#8a8a8e shell=
  "<N> docs · qmd://<name>/" | shell=
  "Pattern              <pattern>" | shell=
  "Last updated         <relative>" with optional " ⚠" suffix if amber-or-worse
  ---
  Update this collection   | bash=<plugin> --action update-collection --collection <name> refresh=true
  Embed (new chunks only)  | bash=<plugin> --action embed-collection --collection <name> refresh=true
  Force re-embed all       | bash=<plugin> --action force-reembed-collection --collection <name> refresh=true
  ---
  Reveal in Finder        | bash="open" param1=<path> terminal=false
  Open in Obsidian        | bash="open" param1="obsidian://open?vault=<name>" terminal=false   [ONLY IF hasObsidian]
  Copy collection name    | bash="bash" param1="-c" param2="printf %s '<name>' | pbcopy" terminal=false
  View context…           | bash=<plugin> --action show-context --collection <name>

Notes:

- show-context is NOT in the spec's ActionId enum; it's implemented as a small osascript inline. Add it to ActionId in lib/types.ts and wire a no-op handler in step 11.
- Reveal in Finder and Open in Obsidian and Copy collection name are direct shell-outs that don't go through the action runner — they execute synchronously when clicked.
- If config.ui.hide_obsidian_when_absent is true AND !hasObsidian, omit the Open in Obsidian line.
- Escape collection names for shell context: validate names against /^[A-Za-z0-9_.-]+$/ in renderMenu; reject (omit submenu actions for) names that contain shell metacharacters. Log a one-line warning when this happens.

Tests: defer to step 16.

Wiring: renderMenu now produces the full menu including submenus. No other changes to main().

Run: deno fmt && deno lint && deno check && deno test — all pass.

Acceptance: hovering a collection row in the live SwiftBar UI opens its submenu; Reveal in Finder opens the path; Copy collection name puts the name in the clipboard. Action items that haven't been wired (Update / Embed / Force re-embed / View context) re-invoke the plugin but currently no-op.
```

---

### Prompt 11 — Action runner — spawn + argv branching

Context: clicked actions currently re-invoke the plugin with `--action` but fall through to the poll path. Now route them to a real action runner that spawns qmd CLI commands in the background.

```text
Step 11 of 17 — Action runner: spawn + argv branching.

Repo state: after step 10.

Create lib/actions.ts implementing SPEC.md §5.2 actions.ts section and §13:

  export async function runAction(id: ActionId, args: Record<string, string>): Promise<void>;

Action mapping per SPEC.md §5.2 actions.ts table:

  update-all                  → ['qmd', 'update']
  embed-all                   → ['qmd', 'embed']
  update-collection           → bash -c 'qmd update && qmd embed -c <name>'
  embed-collection            → ['qmd', 'embed', '-c', <name>]
  force-reembed-collection    → ['qmd', 'embed', '-c', <name>, '-f']   (CONFIRM FIRST — handled step 13)
  restart-daemon              → bash -c 'qmd mcp stop && qmd mcp --http --daemon'
  stop-daemon                 → ['qmd', 'mcp', 'stop']
  start-daemon                → ['qmd', 'mcp', '--http', '--daemon']
  cleanup                     → ['qmd', 'cleanup']                       (CONFIRM FIRST — handled step 13)
  recheck                     → touch ~/.cache/swiftbar-qmd/sentinels/recheck (no qmd invocation)
  show-context                → osascript with display dialog of qmd context output (synchronous, no PID tracking)

Background spawn pattern per SPEC.md §13.2:

  const shellSnippet = `( ${commandString}; echo "EXIT_CODE=$?" >> "${logPath}" ) >> "${logPath}" 2>&1 &
echo $!`;
  const proc = new Deno.Command('bash', { args: ['-c', shellSnippet], stdout: 'piped', stderr: 'null' });
  const { stdout } = await proc.output();
  const pid = parseInt(new TextDecoder().decode(stdout).trim(), 10);
  await writeJobPidFile(actionId, { action, collection, pid, startedAt: new Date(), command, logPath });

Locking per SPEC.md §13.3:

  Before spawning:
    const existing = await readJobPidFile(actionId);
    if (existing && isProcessAlive(existing.pid)) { Deno.exit(0); }
  Use a key of `${actionId}` for global actions and `${actionId}:${collection}` for per-collection.

Process-alive check: use Deno.kill(pid, 'SIGCONT') wrapped in try/catch; if it throws, the process is dead.

Recheck action: don't spawn anything; just write/touch the sentinel file then exit. The poll cycle picks up the sentinel in step 15 (we'll handle the sentinel-driven force-render there).

Show-context action: synchronously invoke `qmd context list -c <name>` (read its stdout) then display via:
  osascript -e 'display dialog "<output>" with title "qmd context — <name>" buttons {"OK"} default button "OK"'
Exit when dismissed. No PID file.

Log path naming: ${CACHE_DIR}/logs/${actionId}-${ISO without colons}.log

In qmd.30s.ts main(), branch on argv:

  if (Deno.args[0] === '--action') {
    const actionId = Deno.args[1] as ActionId;
    const argsMap: Record<string, string> = {};
    for (let i = 2; i < Deno.args.length; i += 2) {
      if (Deno.args[i].startsWith('--')) {
        argsMap[Deno.args[i].slice(2)] = Deno.args[i + 1];
      }
    }
    await runAction(actionId, argsMap);
    Deno.exit(0);
  }
  // existing poll path follows

Confirmation dialogs for force-reembed-collection and cleanup are deferred to step 13.

Tests in tests/actions_test.ts:

Mock the command-spawn and PID-file functions via dependency injection or a swappable module. Test:
  - update-all maps to ['qmd', 'update']
  - update-collection injects the collection name correctly
  - locking: if PID file exists and process is alive, no spawn happens, exit 0
  - locking: if PID file exists but PID is dead, spawn proceeds (stale-PID detection covered in step 12)
  - recheck writes the sentinel file
  - show-context is synchronous (no PID file written)

Wiring: argv branching in qmd.30s.ts as above. Now clicking "Update all collections" actually invokes `qmd update`.

Run: deno fmt && deno lint && deno check && deno test — all pass.
Manual smoke: click "Update all" from the menubar; verify a PID file appears in ~/.cache/swiftbar-qmd/jobs/ and a log file in ~/.cache/swiftbar-qmd/logs/.

Acceptance: every non-confirm action (per the mapping table above) runs end-to-end when clicked, leaving a PID file and a log file.
```

---

### Prompt 12 — Action completion + in-flight UI

Context: actions run, but the menu doesn't reflect that. Close the lifecycle: detect completion, surface "Running…" rows, fire failure markers.

```text
Step 12 of 17 — Action completion + in-flight UI.

Repo state: after step 11.

Extend lib/state.ts: after reading inFlightJobs via readJobPidFiles, iterate and for each:

  - Check process aliveness via Deno.kill(pid, 'SIGCONT') in try/catch.
  - If alive: leave the JobInfo in state.inFlightJobs.
  - If dead:
      - Read the last 256 bytes of the log file; search for /EXIT_CODE=(-?\d+)$/m.
      - If no EXIT_CODE found: exitCode = -1 (abnormal termination).
      - If exitCode !== 0: await appendFailure({ action, collection, failedAt: new Date(), exitCode, logPath }).
      - await deleteJobPidFile(...).
      - REMOVE the entry from state.inFlightJobs (the job is no longer in flight).

  Job-complete success notifications are NOT fired here — that comes in step 14.

Extend lib/menu.ts:

- Add a "⟳ Running: <action> for <Nm>" row in the Status section when state.inFlightJobs is non-empty. Use compactDuration(now - startedAt) for elapsed. One row per in-flight job.
- For each in-flight job, find the corresponding action row in Global actions (or per-collection submenu) and rewrite:
    - Text: "Running: <action>… (<Nm>)"
    - Append `disabled=true` to the directive line.
- The icon goes amber automatically via rollup logic (in-flight jobs trigger amber per SPEC.md §9.1).

Also: at the END of the poll cycle (after writeSnapshot), call pruneFailuresOlderThan(config.rollup.error_window.amber_hours) and pruneLogs(config.logs.retain_per_action). This is the cleanup pass.

Tests:

Add a test in tests/state_test.ts: mock readJobPidFiles to return one entry with a fake PID; mock isProcessAlive to return false; verify state.inFlightJobs is empty after readCurrentState, and appendFailure was called (or wasn't, depending on exit code).

Add a test in tests/menu_in_flight_test.ts (small): construct CurrentState with one in-flight job, verify renderMenu output contains "Running: update… (\d+m)" and the row is `disabled=true`.

Wiring: state.ts already feeds menu.ts via main(); no new main() changes needed. The cleanup pass is added at the end of the poll branch.

Run: deno fmt && deno lint && deno check && deno test — all pass.
Manual smoke: click "Update all"; within 30s, menu should show "Running: update… (Nm)" in Status; when qmd finishes, menu returns to normal.

Acceptance: the full action lifecycle is visible in the menu; failures appear in recent-failures.json (and thus trigger red icon per rollup).
```

---

### Prompt 13 — Confirmation dialogs + remaining actions + Show last output

Context: most actions work. Add the destructive-action confirmation dialogs, complete the start/stop daemon mutual exclusion, wire the recheck sentinel, and add the "Show last output" menu item.

```text
Step 13 of 17 — Confirmation dialogs + remaining actions + Show last output.

Repo state: after step 12.

Confirmation dialogs in lib/actions.ts:

For actionId 'force-reembed-collection' and 'cleanup', BEFORE spawning the qmd command, run an osascript confirmation dialog:

  const script = `display dialog "<message>" with title "swiftbar-qmd" buttons {"Cancel", "<proceed-label>"} default button "Cancel" with icon caution`;
  const result = await new Deno.Command('osascript', { args: ['-e', script] }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  if (!stdout.includes('button returned:<proceed-label>')) {
    Deno.exit(0);  // user cancelled
  }

Messages:
  force-reembed-collection: "Force re-embed all chunks in <name>? This will take several minutes."
    proceed-label: "Re-embed"
  cleanup: "Clean up orphaned data from the qmd cache? This is generally safe but cannot be undone."
    proceed-label: "Clean up"

Dialogs may time out (osascript exits non-zero after a default of 60s); treat any non-Re-embed/Clean-up result as cancel.

Recheck sentinel in poll path (qmd.30s.ts):

At the very top of the poll path (before readCurrentState), check for the sentinel:

  const sentinel = `${CACHE_DIR}/sentinels/recheck`;
  if (await Deno.stat(sentinel).then(() => true).catch(() => false)) {
    await Deno.remove(sentinel);
    // proceed with poll as usual; the sentinel's mere existence forces a fresh render
  }

The sentinel is mostly cosmetic since every poll re-renders anyway, but it gives "Re-check now" an instant-feedback effect when used from first-run menus.

Show last output in lib/menu.ts:

In the bottom section of the global actions (after "Show qmd status in Terminal"), add:

  IF logsDirContents() returns at least one log:
    "📄 Show last output | bash=\"open\" param1=\"-t\" param2=\"<most-recent-log-path>\" terminal=false"

This requires renderMenu to take the log listing as part of state (extend CurrentState? or pass separately?). Add a recentLogs field to CurrentState in lib/types.ts and populate it in lib/state.ts via logsDirContents(). Only the path of the most-recent log is needed by renderMenu, but storing the full list keeps the door open for "Recent jobs ▸" in v1.1.

Start/Stop daemon mutual exclusion (already correctly conditional on daemon.status from step 9; double-check no extras leaked through).

Tests:

Add to tests/menu_test.ts (new):
- renderMenu with no recentLogs omits "Show last output"
- renderMenu with one recentLog includes "Show last output" pointing at it

Tests for the confirmation dialog: gate the osascript invocation behind an injectable confirm function for testability; verify confirm-returns-false → no spawn.

Wiring: all of the above. The poll path now starts with the sentinel check; the action runner gates destructive actions on confirm; menu.ts adds "Show last output" conditionally.

Run: deno fmt && deno lint && deno check && deno test — all pass.
Manual smoke: click Force re-embed on a collection — should see a confirmation dialog; click Cancel — nothing happens; click Re-embed — qmd command runs.

Acceptance: every menu item in §10 and §11 functions correctly end-to-end.
```

---

### Prompt 14 — Notifications

Context: every menu item works. Now add the failure-class notifications so the user learns about transitions without opening the menu.

```text
Step 14 of 17 — Notifications.

Repo state: after step 13.

Create lib/notify.ts implementing SPEC.md §5.2 notify.ts section, §14, §8.3:

  export function diffStates(prev: PollSnapshot | null, current: CurrentState): NotificationEvent[];
  export async function emitNotifications(events: NotificationEvent[], snapshot: PollSnapshot, config: Config): Promise<void>;

diffStates rules:

- prev null → return [].
- For each transition class in §8.3, emit at most one event per transition. Use:
    daemon-crash:        prev.daemon.status === 'running' && current.daemon.status !== 'running'
    path-unreachable:    prev collection reachable && current same-name collection unreachable
    op-failure:          prev.inFlightJobs included action X for collection Y, current doesn't, AND a new entry exists in current.recentFailures matching X/Y
    job-complete (opt):  same prev/current as op-failure but the new entry is NOT in recentFailures (i.e. exitCode === 0)
    threshold-breach (opt):
       coverage:  prev coverage >= amber AND current coverage < amber
       freshness: prev freshness within amber AND current freshness past amber

emitNotifications:

- Filter by config.notifications.<kind>; drop events the user has opted out of.
- Apply dedupe: build dedupe key per §14.1; if snapshot.recentlyNotified[key] is within 5 minutes, drop event.
- Cap at 3 notifications per poll. If more remain after dedupe, fire 3 and append a single "+ N more — see menu" notification with title "swiftbar-qmd" subtitle "(N additional events suppressed)".
- For each fired notification:
    - osascript invocation per SPEC.md §14.2 (escape backslashes and quotes).
    - Update snapshot.recentlyNotified[key] = new Date().toISOString().
- After emission, prune any recentlyNotified entries older than 5 minutes.

Copy: implement the table in SPEC.md §14.3 verbatim.

Tests in tests/notify_test.ts: per SPEC.md §19.1 "notify_test.ts" cases:

  - No prev snapshot → no events
  - Identical prev/current → no events
  - Daemon running → stopped: daemon-crash event
  - Collection reachable → unreachable: path-unreachable event
  - In-flight → exited nonzero: op-failure event
  - In-flight → exited zero with on_job_completion: false: no event
  - In-flight → exited zero with on_job_completion: true: event
  - 5 events at once with cap 3: 3 fired + 1 "more" fallback
  - Dedupe: same event key within 5 min: suppressed

Mock the osascript spawner in tests via dependency injection.

Wiring: in main() poll path, after computing tier but before writeSnapshot:

  const prevSnapshot = await readSnapshot();  // already done in step 6; reuse
  const events = diffStates(prevSnapshot, state);
  const newSnapshot: PollSnapshot = buildSnapshot(state, tier, prevSnapshot);  // helper to assemble
  await emitNotifications(events, newSnapshot, config);
  await writeSnapshot(newSnapshot);

buildSnapshot helper composes the PollSnapshot per SPEC.md §15.1 from CurrentState + TierReason + prev snapshot's recentlyNotified.

Run: deno fmt && deno lint && deno check && deno test — all pass.
Manual smoke: stop the daemon externally — within 30s a "qmd daemon stopped" notification should appear.

Acceptance: notify_test.ts green; manual daemon-stop test produces a notification within 30s; repeated polls don't re-notify (dedupe).
```

---

### Prompt 15 — Error handling (defensive reads + top-level fence)

Context: the happy path works. Now add the resilience layer.

```text
Step 15 of 17 — Error handling: defensive reads + top-level fence.

Repo state: after step 14.

Defensive reads in lib/state.ts:

- readCurrentState already wraps individual reads in try/catch. Now track consecutive failures:
    - If any of (collections, status, daemon) sets an error field, increment a counter.
    - If the counter reaches 3 (across consecutive polls — read from prev snapshot, write to new snapshot), force the rendered tier to red.
- Add a top-level wrapper readCurrentStateWithSnapshot that takes prev snapshot, calls readCurrentState, and:
    - If readCurrentState succeeded with at least collections AND status populated (no errors): newSnapshot.consecutiveReadFailures = 0.
    - Else: newSnapshot.consecutiveReadFailures = (prev?.consecutiveReadFailures ?? 0) + 1.
- When consecutiveReadFailures > 0, the renderMenu input should reflect the prev snapshot rather than the empty current state. Add a synthesizeLastGoodState(prev, current) helper that returns CurrentState built from prev's collections/daemon/etc with polledAt set to current's polledAt.

Menu degradation in lib/menu.ts:

- When state.status.error is set OR collections is empty due to error, add a header row at the very top of the dropdown (before "Status"):
    "⚠ Status read failed — using last poll (<relative>) | size=10 color=#d8453f shell="
- Add a row in the bottom section near "Show last output":
    "Show last error | bash=\"open\" param1=\"-t\" param2=\"<error-log-path>\" terminal=false"
  Always render this row when consecutiveReadFailures > 0.

Force red on three consecutive failures:

In main() poll path, after computing tier:

  if (newSnapshot.consecutiveReadFailures >= 3) {
    tier.tier = 'red';
    tier.drivers.unshift('Status reads failed 3 polls in a row');
  }

Top-level fence in qmd.30s.ts:

Wrap main()'s body in try/catch per SPEC.md §16.3:

  try {
    await main();
  } catch (e) {
    await logError('main', 'unhandled', e instanceof Error ? e : new Error(String(e)));
    console.log('⚠');
    console.log('---');
    console.log(`Unhandled error: ${e?.message ?? e} | shell=`);
    console.log(`Show error log | bash="open" param1="-t" param2="${ERROR_LOG_PATH}" terminal=false`);
    Deno.exit(0);  // exit 0 so SwiftBar doesn't think the plugin crashed
  }

Tests:

- Extend tests/state_test.ts: mock readCollections to throw 3 times in sequence; verify consecutiveReadFailures climbs to 3 and tier is forced to red.
- Extend tests/menu_test.ts: render with status.error set; verify the "Status read failed" header is present.
- New test tests/main_test.ts (optional but recommended): import main as a function, mock its dependencies to throw, capture stdout, verify the emergency menu is printed.

Run: deno fmt && deno lint && deno check && deno test — all pass.
Manual smoke: chmod 000 on ~/.cache/qmd/index.sqlite (then chmod 644 to restore); the plugin should render the "Status read failed" header within 30s rather than crashing.

Acceptance: every error path documented in SPEC.md §16.1 has a tested handler; the plugin never crashes — worst case, it renders the emergency menu.
```

---

### Prompt 16 — Snapshot tests

Context: every behaviour shipped. Lock the rendering surface so future changes can't silently break the menu.

```text
Step 16 of 17 — Snapshot tests.

Repo state: after step 15.

Create tests/menu_snapshot_test.ts using jsr:@std/testing/snapshot:

For each of the 10 menu states from SPEC.md §19.2, build a fixture CurrentState + TierReason + Config, render via renderMenu (or renderFirstRunMenu), and assert against a snapshot file:

  1. Healthy state — all green, 4 collections (gVault, jobinator9000, obsidian-reference, Rackula matching reference setup)
  2. Drifting state — Rackula past 24h freshness (amber)
  3. Red state — daemon stopped
  4. In-flight state — update-all in flight (1m elapsed)
  5. First-run: no-qmd
  6. First-run: no-collections
  7. First-run: empty-index
  8. Error state — collections empty due to error, consecutiveReadFailures: 1, prev snapshot available
  9. Config-error state — render with a config errors array; verify "⚠ Config error" header
  10. Per-collection submenu (open) for Rackula — verify all submenu items present including Last updated row and Open in Obsidian (hasObsidian: true)

Fixtures live in tests/fixtures/snapshots/ as auto-generated .snap files.

Add a tests/fixtures/builders.ts module with helpers:

  buildConfig(overrides?): Config
  buildHealthyState(): CurrentState
  buildDriftingState(): CurrentState
  buildRedState(): CurrentState
  buildInFlightState(): CurrentState

These let new snapshot tests be added by combining helpers with light overrides.

When intentionally changing menu output, regenerate snapshots with:
  deno test --allow-read --allow-env --allow-write tests/menu_snapshot_test.ts -- --update

Document this in tests/README.md (create if missing).

Also extend the CI workflow to run snapshot tests explicitly:

  - name: Snapshot tests
    run: deno test --allow-read --allow-env --allow-write=/tmp tests/menu_snapshot_test.ts

Tests in this step DO NOT wire into qmd.30s.ts — they're verification only.

Run: deno fmt && deno lint && deno check && deno test — all pass. On first run, snapshot files are created; on subsequent runs, they're compared.

Acceptance: all 10 snapshot tests have committed .snap files; running deno test green; intentionally tweaking menu output causes a snapshot diff that's easy to review.
```

---

### Prompt 17 — Install script + README polish

Context: the plugin works and is well-tested. Make it installable.

```text
Step 17 of 17 — Install script + README polish.

Repo state: after step 16. All code complete; CI green.

Create install.sh at the repo root per SPEC.md §21.2 verbatim:

  - Preflight: deno present, SwiftBar present.
  - Download qmd.30s.ts and config.example.yml from raw.githubusercontent.com.
  - chmod +x the plugin.
  - Seed ~/.config/swiftbar-qmd/config.yml from example if not present.
  - Print "restart SwiftBar" hint.
  - Accept a positional REF arg defaulting to "main" so users can install a specific tag.

chmod +x install.sh.

Rewrite README.md as a real user-facing readme. Sections:

  # swiftbar-qmd
  
  > One-line description: "Ambient operational visibility for qmd in your macOS menubar."
  
  ## What it does
  
  Brief paragraph from SPEC.md §1.
  
  Screenshot placeholder (use ![](docs/screenshot.png) — actual screenshot can come later).
  
  ## Install
  
  Three sections matching SPEC.md §21:
  
  ### Manual install
  (commands from §21.1)
  
  ### Curl installer
  curl -fsSL https://raw.githubusercontent.com/ggfevans/swiftbar-qmd/main/install.sh | bash
  
  ### SwiftBar "Install from URL"
  (instructions + raw GitHub URL)
  
  ## Configure
  
  Brief note that config lives at ~/.config/swiftbar-qmd/config.yml; clicking Preferences… opens it in your default editor. Link to SPEC.md §7.2 for the full schema.
  
  ## What the icon colours mean
  
  Mini table from SPEC.md §9.1: Green / Amber / Red / Grey + one-line meaning.
  
  ## Requirements
  
  - macOS (Apple Silicon or Intel)
  - SwiftBar 2.x
  - Deno 2.x
  - qmd v2.x configured with at least one collection
  
  ## Development
  
  - deno task test / fmt / lint / check
  - Project layout in docs/planning/SPEC.md §5
  - Architectural decisions in docs/planning/DECISIONS.md
  - Implementation plan in docs/planning/PROMPTS.md
  
  ## Troubleshooting
  
  Three short sections:
  - Icon never appears → check SwiftBar can see executable, restart SwiftBar
  - Icon stays grey → check qmd is in $PATH and ~/.cache/qmd/index.sqlite exists
  - Notifications not appearing → check System Settings → Notifications → SwiftBar is enabled
  
  ## License
  
  MIT (link to LICENSE)

Update CHANGELOG.md with the v1.0.0 entry summarising everything implemented across steps 1–17.

Update qmd.30s.ts metadata to set version v1.0.0.

Update CI workflow to include a step that runs install.sh in a dry-run mode (or skip if it would touch the user's home; just verify install.sh has correct syntax via `bash -n install.sh`).

Acceptance:
- install.sh works end-to-end on a clean Mac (manual test required, not CI).
- README renders correctly on GitHub.
- Tagging v1.0.0 produces a GitHub Release with qmd.30s.ts and install.sh as attachments.

This is the final step. After this:
- Tag v1.0.0.
- Run the manual QA checklist from SPEC.md §19.3.
- Verify acceptance criteria from SPEC.md §23.
```

---

## 6. Notes for the implementer

A few things that aren't in any single prompt but worth keeping in mind:

- **Dependency injection over heavy mocking.** Several prompts ask you to make functions accept optional dependency parameters (probes for detect.ts, command-spawn for actions.ts, osascript-runner for notify.ts). This is preferred over module-level mocking because it keeps tests fast and obvious. The production code path uses defaults; tests inject fakes.

- **deno fmt and deno lint at the end of every step.** This isn't optional — CI will reject anything that fails them, and reformatting after the fact creates noisy diffs. Run them as you go.

- **deno check across all .ts files.** Type errors that pass `deno run` can still trip up `deno check`. Run `deno check qmd.30s.ts lib/**/*.ts tests/**/*.ts` after every step.

- **No `as any` escapes.** If the types don't fit, the spec is wrong — fix the type definition in lib/types.ts and update SPEC.md §6 accordingly. The point of having a fully-typed spec is to catch mismatches at design time, not at runtime.

- **Don't ship debugging console.error calls.** SwiftBar surfaces stderr in its plugin console; intentional warnings are fine, leftover debugging is noise. Use lib/log.ts instead.

- **Test temporary files.** Many steps require tests that write files. Use Deno.makeTempDir() and an internal helper to set CACHE_DIR for the duration of the test; never let tests write to the real ~/.cache/swiftbar-qmd.

- **Commit per step.** Each of the 17 prompts is a natural commit boundary. Commit messages should reference the step number and the spec section being implemented (e.g. "step 7: state reader (SPEC §5.2, §8)").

---

*Authoring done 2026-05-17. If any prompt becomes a poor fit after the spec evolves, update both SPEC.md and this document in the same change so they stay in sync.*

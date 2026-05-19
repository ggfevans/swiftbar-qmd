# qmd-swiftbar: Implementation checklist

Working checklist tracking implementation from empty repo through v1.0.0 release. Each step maps to a prompt in [`docs/planning/PROMPTS.md`](docs/planning/PROMPTS.md) and a section in [`docs/planning/SPEC.md`](docs/planning/SPEC.md).

Conventions:
- `[ ]` open, `[x]` done, `[-]` skipped (with reason in margin).
- After every step: run `deno fmt && deno lint && deno check && deno test`, commit with a message that references the step number and spec section.

---

## Preflight

Things to verify before writing any code.

- [ ] Deno 2.x installed (`deno --version` reports ≥ 2.0.0)
- [ ] SwiftBar installed at `/Applications/SwiftBar.app`
- [ ] qmd installed and at least one collection configured (`qmd collection list` shows entries)
- [ ] `~/.cache/qmd/index.sqlite` exists and is readable
- [ ] Spec read end-to-end (at least skim §§1–10)
- [ ] Decision log read end-to-end (it's the shortest doc)
- [ ] Local working clone of `ggfevans/qmd-swiftbar` on a feature branch (not `main`)
- [ ] Editor / IDE set up with Deno LSP enabled

---

## Step 1 — Scaffolding + types

Prompt 1 in `PROMPTS.md` · Spec §4, §5, §6

- [ ] `deno.json` written with all four tasks (test/fmt/lint/check)
- [ ] Import map declares `npm:@tobilu/qmd`, `jsr:@std/yaml`, `jsr:@std/path`, `jsr:@std/fs`, `jsr:@std/testing` at versions from SPEC §4.3
- [ ] `qmd.30s.ts` created at repo root with the exact shebang from SPEC §4.2
- [ ] SwiftBar metadata header present (title/version v0.1.0/author/desc/dependencies/abouturl)
- [ ] `main()` prints the four-line placeholder output and exits 0
- [ ] `chmod +x qmd.30s.ts` applied
- [ ] `lib/types.ts` contains every type from SPEC §6 (verbatim)
- [ ] `config.example.yml` at root with the full annotated YAML from SPEC §7.2
- [ ] `.github/workflows/ci.yml` written verbatim from SPEC §20
- [ ] `README.md` scaffold (one-liner + Install/Configure/Usage/Development stub sections)
- [ ] `CHANGELOG.md` initialised with `## [Unreleased]` + v0.1.0 entry
- [ ] `.gitignore` covers `*.log`, Deno caches; **keeps** `deno.lock`
- [ ] `tests/.gitkeep` added so the directory exists in git
- [ ] `deno fmt && deno lint && deno check` all pass
- [ ] Manual smoke: drop `qmd.30s.ts` into `~/Library/Application Support/SwiftBar/Plugins/`, restart SwiftBar, see placeholder icon
- [ ] Committed: `step 1: scaffolding + types (SPEC §4–§6)`

---

## Step 2 — Config loader

Prompt 2 · Spec §5.2, §7

- [ ] `lib/config.ts` exports `CONFIG_PATH`, `EXAMPLE_CONFIG_PATH`, `DEFAULT_CONFIG`, `loadConfig`, `validateConfig`
- [ ] `DEFAULT_CONFIG` matches the YAML in SPEC §7.2 after parse
- [ ] `loadConfig` auto-creates the config file from the example on first run
- [ ] `loadConfig` writes serialised defaults if the example is also missing
- [ ] `loadConfig` never throws — returns `{ config: DEFAULT_CONFIG, errors: [...] }` on every error path
- [ ] `validateConfig` applies every rule in SPEC §7.2's validation table
- [ ] `validateConfig` falls back to defaults per key on violations, accumulating errors
- [ ] `validateConfig` ignores unknown keys (forward compat)
- [ ] `tests/config_test.ts` covers: missing file, valid round-trip, type violations, range violations, malformed YAML, unknown keys
- [ ] Tests use overridable `CONFIG_PATH` (env var or helper) — never touch user home
- [ ] `main()` now calls `await loadConfig()` and discards (no behaviour change yet)
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 2: config loader (SPEC §5.2, §7)`

---

## Step 3 — First-run detection

Prompt 3 · Spec §5.2, §12

- [ ] `lib/detect.ts` exports `detectFirstRunState(config: Config, probes?: Probes): Promise<FirstRunState>`
- [ ] Check 1: `qmd` binary in `$PATH` via `Deno.Command('which', ...)`
- [ ] Check 2: SDK import via `await import('npm:@tobilu/qmd')` in try/catch
- [ ] Check 3: `Deno.stat(config.qmd.index_path)`
- [ ] Check 4: `createStore().listCollections()` non-empty
- [ ] Check 5: at least one collection with `doc_count > 0`
- [ ] Per-check timeout of 100ms; total detect budget 500ms
- [ ] Failures cascade to most-recoverable state (per SPEC §12)
- [ ] Never throws; logs to stderr on unexpected errors
- [ ] `Probes` interface defined for dependency injection
- [ ] `tests/detect_test.ts` covers all 7 cases from SPEC §19.1
- [ ] `main()` calls `detectFirstRunState(config)` after `loadConfig`; result stored, not used yet
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 3: first-run detection (SPEC §5.2, §12)`

---

## Step 4 — First-run menu rendering

Prompt 4 · Spec §9.3, §12

- [ ] `lib/menu.ts` created with `renderFirstRunMenu(firstRun, config): string`
- [ ] Pre-computed base64 of the filled Q SVG embedded as a const
- [ ] Pre-computed base64 of the hollow Q SVG embedded as a const
- [ ] `getPluginPath()` helper added (converts `Deno.mainModule` URL → filesystem path)
- [ ] `no-qmd` menu renders per SPEC §12.1 (grey icon, install link, re-check)
- [ ] `no-collections` menu renders per SPEC §12.2
- [ ] `empty-index` menu renders per SPEC §12.3 (amber icon, promoted "Run update")
- [ ] `main()` branches on detect result: if not `ok`, print first-run menu and exit
- [ ] Below the branch: keep the hardcoded placeholder (replaced in step 9)
- [ ] Manual smoke: move qmd out of `$PATH` → menu shows `no-qmd`; restore → menu returns to placeholder
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 4: first-run menu rendering (SPEC §9.3, §12)`

---

## Step 5 — Time helpers + logging

Prompt 5 · Spec §5.2

- [ ] `lib/time.ts` exports `compactDuration`, `relativeTime`, `withTimeout`
- [ ] `compactDuration` handles every range: seconds → minutes → hours → days → weeks
- [ ] `compactDuration` drops trailing zero units ("2h" not "2h 0m")
- [ ] `compactDuration` treats negatives as zero
- [ ] `relativeTime` handles "just now", minutes, hours, "yesterday", days, weeks
- [ ] `relativeTime` treats future dates as "just now"
- [ ] `withTimeout` returns `Promise.race` with timeout error including label
- [ ] `tests/time_test.ts` covers ≥ 20 cases across both formatters and `withTimeout`
- [ ] `lib/log.ts` exports `logError` and `logInfo`
- [ ] Log file at `${CACHE_DIR}/error.log`
- [ ] Format: `<ISO> [<level>] <category>: <message>` + optional stack
- [ ] Rotation at 1 MB → `error.log.1` (overwrite existing)
- [ ] `Deno.mkdir` ensures `CACHE_DIR` exists
- [ ] Never throws on write failure
- [ ] No wiring this step (utilities consumed in 6, 7, 11+)
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 5: time + log utilities (SPEC §5.2)`

---

## Step 6 — Persistence layer

Prompt 6 · Spec §5.2, §15

- [ ] `lib/persistence.ts` exports `CACHE_DIR` and all 10 functions from SPEC §5.2
- [ ] `CACHE_DIR` = `~/.cache/qmd-swiftbar`; subdirs `jobs/`, `logs/`, `sentinels/` ensured
- [ ] `readSnapshot` / `writeSnapshot` round-trip with atomic rename (write `.tmp`, then `Deno.rename`)
- [ ] Snapshot serialises Dates as ISO; deserialises back to Date
- [ ] `readJobPidFiles` returns empty array when no PID files exist
- [ ] `writeJobPidFile` uses key `<actionId>` or `<actionId>:<collection>`
- [ ] `appendFailure` prepends + truncates to 50 entries
- [ ] `pruneFailuresOlderThan(hours)` filters and writes back
- [ ] `logsDirContents` lists logs/ with mtime + size
- [ ] `pruneLogs(retainPerAction)` deletes oldest beyond N per action
- [ ] All readers handle "file does not exist" as null/empty (no throw)
- [ ] Tests use overridable `CACHE_DIR` (env var `QMD_SWIFTBAR_CACHE_DIR`)
- [ ] `tests/persistence_test.ts` covers all 8 cases from prompt 6
- [ ] `main()` now calls `await readSnapshot()` after `loadConfig` (discarded; proves the module loads)
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 6: persistence layer (SPEC §5.2, §15)`

---

## Step 7 — State reader

Prompt 7 · Spec §3.2, §5.2, §8

- [ ] `lib/state.ts` exports `readCurrentState(config: Config): Promise<CurrentState>`
- [ ] `readCollections` opens SDK store, lists, derives `CollectionState`, closes store
- [ ] `CollectionState.reachable` derived from `Deno.stat(path)`
- [ ] `CollectionState.hasObsidian` derived from `Deno.stat(path + '/.obsidian')`
- [ ] `CollectionState.coveragePercent` computed (100 if zero docs to avoid div/zero)
- [ ] `readIndexStatus` returns `IndexStatus` or sets `error` field
- [ ] `probeDaemon` hits `/health` with 5s timeout (`withTimeout`)
- [ ] Daemon states: 'running' on 200, 'stopped' on connection refused, 'unresponsive' on timeout/5xx
- [ ] Every subroutine wrapped in try/catch; `readCurrentState` never throws
- [ ] Dependency injection: optional second arg lets tests swap data sources
- [ ] `tests/state_test.ts` covers assembly correctness + each subroutine failing in isolation
- [ ] `main()` calls `await readCurrentState(config)` after the first-run branch; result stored, not yet rendered
- [ ] Manual smoke: log the state object briefly during development; remove before commit
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 7: state reader (SPEC §5.2, §8)`

---

## Step 8 — Rollup logic

Prompt 8 · Spec §5.2, §9

- [ ] `lib/rollup.ts` exports `computeTier` and `computeTierWithReason`
- [ ] Precedence order in `computeTier` matches SPEC §9.1 exactly
- [ ] Pure functions: no I/O, no async, no `Date.now()` (use `state.polledAt`)
- [ ] Grey early-exit for empty state
- [ ] Red checks: daemon, reachable, recent failures (red window), red coverage, red freshness
- [ ] Amber checks: in-flight, amber coverage, amber freshness, recent failures (amber window)
- [ ] `computeTierWithReason` accumulates every triggering condition into `drivers`
- [ ] Driver strings are human-readable (per SPEC §9.2 examples)
- [ ] `tests/rollup_test.ts` includes every case from SPEC §19.1 "rollup_test.ts" (≥ 30 cases)
- [ ] `buildState({overrides})` helper used to keep tests concise
- [ ] Coverage on `rollup.ts`: 100% branches
- [ ] `main()` computes `tier = computeTierWithReason(state, config)` after `readCurrentState`
- [ ] Hardcoded placeholder icon now uses tier-mapped emoji (🟢/🟡/🔴/⚪) — visible smoke test
- [ ] Manual smoke: `qmd mcp stop` → icon goes red within 30s
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 8: rollup logic (SPEC §5.2, §9)`

---

## Step 9 — Healthy menu rendering

Prompt 9 · Spec §10, Appendix A

- [ ] `lib/menu.ts` exports `renderMenu(state, tier, config): string`
- [ ] Icon line uses filled Q SVG + tier hex (green #2fa84f, amber #ec9b2c, red #d8453f) or hollow SVG for grey
- [ ] Tooltip = first driver, or "All clear" when no drivers
- [ ] Status section: header + 3 rows (daemon state, drift summary, last update)
- [ ] Drift summary is plural-aware ("1 collection drifting" vs "3 collections drifting" vs "All collections healthy")
- [ ] "Last update" uses most-recent `lastModified` across collections via `compactDuration`
- [ ] Collections section: per-collection rows with coloured dot + `<count> · <freshness>`
- [ ] Per-collection-tier helper `collectionTier(c, config): Tier` added
- [ ] Global actions section: Update all, Embed all, Restart daemon, Start OR Stop daemon (mutually exclusive), Cleanup
- [ ] Bottom: Copy MCP endpoint, Show qmd status in Terminal
- [ ] Final section: Preferences (cmd-comma), About
- [ ] Action bash directives invoke plugin's own path with `--action` arg + collection arg where applicable
- [ ] Keyboard shortcuts: `CmdOrCtrl+U` for update-all, `CmdOrCtrl+E` for embed-all, `CmdOrCtrl+,` for preferences
- [ ] `main()` replaces placeholder output with `console.log(renderMenu(state, tier, config))`
- [ ] Manual smoke: full menu visible with live data; clicks invoke plugin (no-op for now)
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 9: healthy menu rendering (SPEC §10)`

---

## Step 10 — Per-collection submenus

Prompt 10 · Spec §11

- [ ] Each collection row in `renderMenu` followed by indented submenu block
- [ ] Parent row gets "▸" suffix
- [ ] Submenu header (collection name) at top
- [ ] Submenu info rows: `<N> docs · qmd://<name>/`, `Pattern <pattern>`, `Last updated <relative>` (+ "⚠" if amber-or-worse)
- [ ] Submenu actions: Update this collection, Embed (new chunks only), Force re-embed all
- [ ] Submenu utilities: Reveal in Finder, Open in Obsidian (conditional), Copy collection name, View context
- [ ] Open in Obsidian hidden when `hasObsidian: false` AND `config.ui.hide_obsidian_when_absent: true`
- [ ] Reveal in Finder uses `open <path>` (direct shell-out, not through action runner)
- [ ] Copy collection name uses `printf %s '<name>' | pbcopy`
- [ ] Collection name validated against `/^[A-Za-z0-9_.-]+$/`; submenu actions omitted with logged warning if invalid
- [ ] `show-context` added to `ActionId` enum in `lib/types.ts` (handler implemented in step 11)
- [ ] Manual smoke: hover Rackula row → submenu opens to the left; Reveal in Finder works; Copy name works
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 10: per-collection submenus (SPEC §11)`

---

## Step 11 — Action runner — spawn + argv branching

Prompt 11 · Spec §5.2, §13

- [ ] `lib/actions.ts` exports `runAction(id, args)`
- [ ] Command mapping table implemented for all 10 action IDs + `show-context`
- [ ] Background spawn pattern uses shell wrapper to append `EXIT_CODE=$?` to log file
- [ ] `bash -c '...; echo "EXIT_CODE=$?" >> log' &` writes PID to stdout for capture
- [ ] PID file written via `writeJobPidFile`
- [ ] Per-action locking via PID file: existing alive PID → exit silently
- [ ] Per-collection actions key by `<actionId>:<collection>`
- [ ] `isProcessAlive(pid)` uses `Deno.kill(pid, 'SIGCONT')` in try/catch
- [ ] `recheck` action touches sentinel file, no qmd invocation
- [ ] `show-context` runs `qmd context list -c <name>` synchronously, displays via osascript dialog
- [ ] Log file naming: `<actionId>-<ISO-no-colons>.log`
- [ ] `qmd.30s.ts` `main()` branches on `--action` argv → calls `runAction`, exits
- [ ] Argv parser handles `--collection <name>` and other flags
- [ ] `tests/actions_test.ts` mocks command-spawn + PID-file ops; covers mapping, locking, sentinel, show-context
- [ ] Manual smoke: click "Update all collections" → PID file appears in `~/.cache/qmd-swiftbar/jobs/`, log file populates
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 11: action runner + argv (SPEC §5.2, §13)`

---

## Step 12 — Action completion + in-flight UI

Prompt 12 · Spec §13.4, §13.5, §15.4

- [ ] `lib/state.ts` extended to check liveness of each `JobInfo` from `readJobPidFiles`
- [ ] Dead PIDs trigger log-tail read for `EXIT_CODE=<n>` marker
- [ ] No EXIT_CODE found → record exit code as -1 (abnormal)
- [ ] Non-zero exit → `appendFailure(...)`
- [ ] Dead PID's job removed from `state.inFlightJobs`; PID file deleted
- [ ] Success notifications NOT fired here (that's step 14)
- [ ] `lib/menu.ts` adds "⟳ Running: <action> for <Nm>" row in Status section per in-flight job
- [ ] In-flight action row (global or per-collection submenu) rewritten as "Running: …" + `disabled=true`
- [ ] Cleanup pass at end of poll: `pruneFailuresOlderThan(amber_hours)` + `pruneLogs(retain_per_action)`
- [ ] `tests/state_test.ts` extended: mock dead PID + non-zero EXIT_CODE → `appendFailure` called
- [ ] `tests/menu_in_flight_test.ts` (or extended menu_test.ts): in-flight state renders "Running" row + disabled action
- [ ] Manual smoke: click "Update all", within 30s see "Running: update… (Nm)"; on completion, menu returns to normal
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 12: action completion + in-flight UI (SPEC §13.4–13.5)`

---

## Step 13 — Confirmation dialogs + remaining actions + Show last output

Prompt 13 · Spec §11.2, §13

- [ ] `force-reembed-collection` confirms via `osascript display dialog` before spawning
- [ ] `cleanup` confirms via `osascript display dialog` before spawning
- [ ] Dialog buttons: `Cancel` (default) + action-specific proceed label
- [ ] Cancel / timeout → no spawn, exit 0
- [ ] `osascript` invocation injectable via parameter for testability
- [ ] Sentinel check at top of poll path: read `recheck` sentinel, delete if present
- [ ] `lib/types.ts` `CurrentState` gains `recentLogs: LogFileInfo[]`
- [ ] `lib/state.ts` populates `recentLogs` via `logsDirContents()`
- [ ] `lib/menu.ts` adds "📄 Show last output" row when `recentLogs` non-empty (opens most recent log in default editor)
- [ ] Start/Stop daemon mutual exclusion verified (no regression from step 9)
- [ ] `tests/menu_test.ts` covers: no logs → no "Show last output"; one log → row present with correct path
- [ ] `tests/actions_test.ts` covers: confirm returns false → no spawn
- [ ] Manual smoke: Force re-embed prompts; Cancel skips; Re-embed runs; Cleanup prompts similarly
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 13: confirmations + show-last-output (SPEC §11.2, §13)`

---

## Step 14 — Notifications

Prompt 14 · Spec §5.2, §8.3, §14

- [ ] `lib/notify.ts` exports `diffStates(prev, current): NotificationEvent[]` and `emitNotifications(events, snapshot, config): Promise<void>`
- [ ] `diffStates` returns `[]` when `prev` is null
- [ ] `daemon-crash` event: prev running → current not running
- [ ] `path-unreachable` event: prev reachable → current unreachable
- [ ] `op-failure` event: in-flight → exited + entry in `recentFailures`
- [ ] `job-complete` event: in-flight → exited clean (opt-in via config)
- [ ] `threshold-breach` events: coverage / freshness amber transitions (opt-in)
- [ ] `emitNotifications` filters by config flags
- [ ] Dedupe registry in `snapshot.recentlyNotified`; 5-minute window
- [ ] Dedupe keys per SPEC §14.1
- [ ] Rate limit: max 3 notifications per poll + 1 "+ N more" fallback
- [ ] osascript invocation per SPEC §14.2 (escape `\\` and `"`)
- [ ] Notification copy per SPEC §14.3 table
- [ ] osascript spawner injectable for testability
- [ ] `tests/notify_test.ts` covers all 9 cases from SPEC §19.1 "notify_test.ts"
- [ ] `main()` poll path: load prev snapshot, diff, build new snapshot, emit, write snapshot (in that order)
- [ ] `buildSnapshot(state, tier, prev)` helper assembles PollSnapshot per SPEC §15.1
- [ ] Manual smoke: `qmd mcp stop` → notification within 30s; re-poll shouldn't re-fire
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 14: notifications (SPEC §5.2, §14)`

---

## Step 15 — Error handling (defensive reads + top-level fence)

Prompt 15 · Spec §16

- [ ] `lib/state.ts` adds `readCurrentStateWithSnapshot(config, prev)` wrapper
- [ ] `consecutiveReadFailures` counter incremented on any error field set
- [ ] Counter reset to 0 on clean poll
- [ ] `synthesizeLastGoodState(prev, current)` returns CurrentState from prev with `polledAt` updated
- [ ] `lib/menu.ts` adds "⚠ Status read failed — using last poll (<relative>)" header row when error
- [ ] `lib/menu.ts` adds "Show last error" row in bottom section when `consecutiveReadFailures > 0`
- [ ] `main()` forces `tier.tier = 'red'` and pushes driver string when failures ≥ 3
- [ ] Top-level try/catch in `qmd.30s.ts` per SPEC §16.3
- [ ] Emergency menu rendered on uncaught throw (always exit 0 so SwiftBar doesn't crash-loop)
- [ ] Error logged via `logError('main', 'unhandled', e)` before emergency menu
- [ ] `tests/state_test.ts` extended: 3 consecutive failures → tier forced red
- [ ] `tests/menu_test.ts` extended: error state renders the "Status read failed" header
- [ ] Optional: `tests/main_test.ts` capturing stdout on injected throw, verifying emergency menu
- [ ] Manual smoke: `chmod 000 ~/.cache/qmd/index.sqlite` → menu shows error header within 30s, doesn't crash; `chmod 644` to restore
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 15: error handling (SPEC §16)`

---

## Step 16 — Snapshot tests

Prompt 16 · Spec §19.2

- [ ] `tests/menu_snapshot_test.ts` created using `jsr:@std/testing/snapshot`
- [ ] Snapshot 1: healthy state (4 collections, all green)
- [ ] Snapshot 2: drifting (Rackula past 24h freshness)
- [ ] Snapshot 3: red state (daemon stopped)
- [ ] Snapshot 4: in-flight (update-all running 1m)
- [ ] Snapshot 5: first-run `no-qmd`
- [ ] Snapshot 6: first-run `no-collections`
- [ ] Snapshot 7: first-run `empty-index`
- [ ] Snapshot 8: error state (consecutiveReadFailures=1, prev snapshot available)
- [ ] Snapshot 9: config-error (errors array populated)
- [ ] Snapshot 10: per-collection submenu (open) for Rackula
- [ ] `tests/fixtures/builders.ts` provides `buildConfig`, `buildHealthyState`, `buildDriftingState`, `buildRedState`, `buildInFlightState`
- [ ] All `.snap` files committed
- [ ] CI workflow runs snapshot tests explicitly
- [ ] `tests/README.md` (or section in main README) documents `deno test -- --update` for regeneration
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 16: snapshot tests (SPEC §19.2)`

---

## Step 17 — Install script + README polish

Prompt 17 · Spec §21

- [ ] `install.sh` written per SPEC §21.2 verbatim
- [ ] `install.sh` preflight: `deno` present, SwiftBar present
- [ ] `install.sh` downloads `qmd.30s.ts` + `config.example.yml` from GitHub raw
- [ ] `install.sh` chmods +x the plugin
- [ ] `install.sh` seeds config from example only if config doesn't exist
- [ ] `install.sh` accepts positional `REF` arg defaulting to `main`
- [ ] `chmod +x install.sh` applied
- [ ] CI step added: `bash -n install.sh` (syntax check)
- [ ] `README.md` rewritten with all sections from prompt 17
- [ ] Install section covers all three paths (manual, curl, SwiftBar URL)
- [ ] Configure section links to SPEC §7.2
- [ ] Icon-colour-meaning mini table included
- [ ] Requirements section lists macOS, SwiftBar 2.x, Deno 2.x, qmd v2.x
- [ ] Development section links to planning docs
- [ ] Troubleshooting section covers the three top failure modes
- [ ] License section links to `LICENSE`
- [ ] `CHANGELOG.md` updated with v1.0.0 entry covering all steps
- [ ] `qmd.30s.ts` SwiftBar metadata version bumped to `v1.0.0`
- [ ] `deno fmt && deno lint && deno check && deno test` all pass
- [ ] Committed: `step 17: install + README polish (SPEC §21)`

---

## Pre-release verification

Before tagging v1.0.0.

### Code quality
- [ ] All 17 steps committed individually with spec section references
- [ ] CI green on `main`
- [ ] Test coverage: rollup ≥ 100% branches, other I/O modules ≥ 80% lines
- [ ] No `as any` escape hatches in source
- [ ] No leftover debugging `console.error` calls
- [ ] No TODO comments without an associated GitHub issue link

### Manual QA (SPEC §19.3)
- [ ] **QA 1** — Fresh install: delete `~/.config/qmd-swiftbar/` and `~/.cache/qmd-swiftbar/`, drop plugin file, restart SwiftBar. Icon appears in ≤ 30s; first-run menu shows correct state.
- [ ] **QA 2** — With qmd configured and indexed: normal menu appears, all collections listed with correct meta.
- [ ] **QA 3** — Click "Update all collections": PID file appears, menu shows "Running…" within 30s, icon goes yellow, completion within expected time, log populated.
- [ ] **QA 4** — `qmd mcp stop` from terminal: notification fires within 30s, icon goes red, "Start MCP daemon" appears in menu.
- [ ] **QA 5** — Hover collection row: submenu opens to the **left** (since icon is right-aligned). Reveal in Finder opens the path.
- [ ] **QA 6** — `echo "garbage" > ~/.config/qmd-swiftbar/config.yml`: menu still renders, `⚠ Config error` header shown, `error.log` has parse error.
- [ ] **QA 7** — Edit `freshness.amber_hours` to `1`: within 30s, any collection with freshness > 1h goes amber and icon updates.
- [ ] **QA 8** — `mv` a collection's source directory: path-unreachable notification fires, icon red, collection row shows error.
- [ ] **QA 9** — Click "Open in Obsidian" on an Obsidian-vault collection: Obsidian opens with the vault.
- [ ] **QA 10** — Confirm "Open in Obsidian" is hidden for a non-vault collection.

### Acceptance criteria (SPEC §23)
- [ ] Criterion 1: Fresh install icon appears within 30s
- [ ] Criterion 2: Icon colour tracks rollup logic; verified by snapshot tests
- [ ] Criterion 3: Every menu item from §10–§11 works or has `TODO(deferred)` comment with issue link
- [ ] Criterion 4: Per-collection submenus open on hover; all listed actions present
- [ ] Criterion 5: `Run update` background lifecycle works end-to-end
- [ ] Criterion 6: External daemon kill triggers notification + red icon within 30s
- [ ] Criterion 7: Config edit takes effect in ≤ 30s without restart
- [ ] Criterion 8: All three install paths documented; curl installer smoke-tested
- [ ] Criterion 9: CI green: `deno fmt --check`, `deno lint`, `deno check`, `deno test`
- [ ] Criterion 10: All four first-run states render correctly (manually verified)
- [ ] Criterion 11: Performance budgets met (Apple Silicon, ~5k docs across 4 collections)
- [ ] Criterion 12: CHANGELOG covers everything between v0.1.0 → v1.0.0

---

## Release v1.0.0

- [ ] Final commit on `main` is the step 17 commit
- [ ] `CHANGELOG.md` `## [Unreleased]` heading replaced with `## [v1.0.0] — YYYY-MM-DD`
- [ ] Git tag created: `git tag -a v1.0.0 -m "v1.0.0 — first stable release"`
- [ ] Tag pushed: `git push origin v1.0.0`
- [ ] GitHub Release drafted from the tag
- [ ] Release notes summarise highlights + link to CHANGELOG
- [ ] Release attachments: `qmd.30s.ts`, `install.sh`, `config.example.yml`
- [ ] README install URLs updated to point at `v1.0.0` tag (not `main`)
- [ ] Smoke-test the released install path: in a clean macOS VM / fresh user account, run the curl installer against the v1.0.0 tag
- [ ] Publish announcement (optional): qmd discussion, personal blog, X

---

## Post-release

- [ ] Open issues for v1.1 candidates from SPEC §24:
    - [ ] Recent activity feed in dropdown
    - [ ] Multi-index support
- [ ] Open issues for v1.2 candidates:
    - [ ] Spinner overlay on icon during jobs
    - [ ] Rich notifications with action buttons (Swift companion)
- [ ] Open backlog items:
    - [ ] Web-form Preferences UI
    - [ ] Homebrew tap
    - [ ] Add collection from menubar (folder picker)
- [ ] Set up Issue templates if planning to accept contributions
- [ ] Add CONTRIBUTING.md (optional; not required for personal-use project)
- [ ] Watch the qmd repo for SDK changes that might affect `lib/state.ts`
- [ ] Watch SwiftBar releases for plugin-format changes
- [ ] First user-feedback review at ~2 weeks post-release

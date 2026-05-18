# SwiftBar-QMD v1.0.0 — Autonomous Implementation Session Report

- Generated: 2026-05-17T08:56:18Z
- Branch: `feat/v1.0.0-implementation`
- Orchestrator plan:
  `/Users/gvns/.claude/plans/using-superpowers-gh-dev-you-have-rippling-glacier.md`

## Environment

- Deno: `deno 2.7.14 (stable, release, aarch64-apple-darwin)` — v8
  14.7.173.20-rusty, TypeScript 5.9.2
- SwiftBar: present at `/Applications/SwiftBar.app`
- qmd: `qmd 2.1.0 (6f293daa9f)`
- Git: clean working tree at start, branched off `main`

## Prompts completed

- Step 1 — Scaffolding + types: commit `6081c88` (+ follow-up `ec582bc` scoping `deno fmt`/`lint` to project sources only; the default `fmt` was reformatting the locked planning docs and the user's `.github/dependabot.yml`).
- Step 2 — Config loader: commit `fcc6639` (14 tests, all passing; added `@std/assert@^1` because `@std/testing/asserts` moved upstream).
- Step 3 — First-run detection: commit `b04d9b6` (9 detect tests + 14 config tests = 23 passing; inline `withTimeout` to be lifted in Prompt 5; bare `@tobilu/qmd` specifier instead of inline `npm:` because deno lint rejects the latter).
- Step 4 — First-run menu rendering: commit `453357e` (base64 SVG icons embedded; `getPluginPath()` helper; `main()` now branches on first-run state. **Observation worth confirming before release**: on this machine, `await import('@tobilu/qmd')` inside the detect cascade exceeds the SPEC-mandated 100 ms timeout even when qmd is installed, so first-run detection falls through to `no-qmd`. May be a cold-import artifact; worth measuring warm-cache behaviour during pre-release QA — if it persists, the SPEC §5.2 budget needs lifting or the SDK probe needs caching.).
- Step 5 — Time helpers + logging: commit `a208f2e` (`lib/time.ts` with `compactDuration` / `relativeTime` / `withTimeout`, 39 tests; `lib/log.ts` with never-throw rotation; the inline `withTimeout` in `lib/detect.ts` was lifted to `lib/time.ts` and the import-site updated. Tests total: **62 / 62**.). Follow-up `b57f1d9` extended `fmt.exclude` to cover `README.md` and `AGENTS.md` (the user committed `17950bc create README.md` between steps and is iterating on both files; without the exclude, `deno fmt` was triggering subagents to do defensive `git checkout --`).
- Step 6 — Persistence layer: commit `02221b0` (`lib/persistence.ts` with `CACHE_DIR`, `cacheDir()` env-aware helper, snapshot/jobs/failures/logs functions; atomic writes via `.tmp` + rename; Date round-trip via field-list hydration; 11 tests. Tests total: **73 / 73**. Wired `readSnapshot()` into `main()` so `~/.cache/swiftbar-qmd/` gets created on first poll.) Two small deviations: `deleteJobPidFile(action, collection?)` extended with optional collection arg (SPEC §5.2 omits it, but per-collection lockfiles need it); `CACHE_DIR` is paired with a `cacheDir()` function so tests can override via `SWIFTBAR_QMD_CACHE_DIR`. **Branch-routing recovery**: this commit was originally landed on the user's parallel branch `docs/ai-disclosure-and-agents` because the working dir's active branch had been switched to it while I was working. I fast-forwarded `feat/v1.0.0-implementation` onto `02221b0` so the implementation branch contains the commit. `docs/ai-disclosure-and-agents` also still points at `02221b0` (i.e. both branches share the commit); if you want that branch to contain only docs work, `git branch -f docs/ai-disclosure-and-agents b57f1d9` will rewind it cleanly.
- Step 7 — State reader: commit `53da3e0` (`lib/state.ts` with `readCurrentState(config, sources?)`; composes five data sources via `Promise.allSettled` for parallelism with full error isolation — `readCollections` (SDK, 2 s timeout), `readIndexStatus` (SDK, 2 s), `probeDaemon` (HTTP `/health`, 5 s), `readJobPidFiles` and `readRecentFailures` from `lib/persistence.ts`. Never throws; each source's failure populates its specific fallback. 8 tests using DI mocks. Tests total: **81 / 81**.) Subagent properly verified branch before committing.
- Step 8 — Rollup logic: commit `4b29b61` (`lib/rollup.ts` with `computeTier` + `computeTierWithReason`; pure functions, no I/O / no async / no `Date.now()`. §9.1 precedence implemented exactly; `computeTierWithReason` accumulates every triggering driver (not just the first). 38 table-driven tests with a `buildState` helper; **100% branch + 100% function + 100% line coverage** on `lib/rollup.ts`. `qmd.30s.ts`'s icon emoji now reflects the real tier — `🟢 / 🟡 / 🔴 / ⚪` — so dropping the plugin into SwiftBar with qmd running, daemon stopped, or no collections produces visibly different colours. Tests total: **119 / 119**.).
- Step 9 — Healthy menu rendering: commit `7b2e94d` (`lib/menu.ts` extended with `renderMenu(state, tier, config)`, internal `collectionTier`, padding helpers, and tier-hex constants; the previous hardcoded placeholder in `qmd.30s.ts` is replaced with the full §10.2 menu output — icon-line + Status / Collections / Global actions / footer / Preferences sections. Per-collection rows are still flat (submenu syntax lands in Prompt 10); action rows already re-invoke the plugin via `--action <id>` so action wiring (Prompt 11) drops in cleanly. No tests this step per the prompt (snapshot tests are Prompt 16). Tests still: **119 / 119**.).
- Step 10 — Per-collection submenus: commit `1922493` (`lib/menu.ts` extended with `renderCollectionSubmenu`; parent rows now end in `▸` and drop `shell=` so SwiftBar treats them as submenu anchors. SwiftBar 2.0.1 detected on this machine and confirmed to honour two-space-indent submenu syntax. `lib/types.ts` gains `"show-context"` ActionId; `lib/rollup.ts`'s exhaustive switch is updated to keep the type surface honest. `Open in Obsidian` is conditional on `hasObsidian || !config.ui.hide_obsidian_when_absent`. Collection names are validated against `/^[A-Za-z0-9_.-]+$/`; unsafe names get a stderr warning and have action rows suppressed but the parent row + info block still render. Tests unchanged at **119 / 119**.).
- Step 11 — Action runner: commit `b113b95` (`lib/actions.ts` with `runAction(id, args, deps?)` + full `ActionDeps` DI surface; production `spawnDetached` wraps the SPEC §13.2 shell snippet, `isProcessAlive` uses SIGCONT, `touchSentinel` for recheck, `runQmdContextList` + `showContextDialog` for show-context. `--action` argv branch wired into `main()`. `lib/persistence.ts` gained a `readJobPidFile(action, collection?)` helper. Shebang's `--allow-run` extended with `bash` (required by §13.2's `bash -c` wrapper — unavoidable SPEC deviation). 18 new tests, total **137 / 137**.).
- Step 12 — Action completion + in-flight UI: commit `1949044` (`lib/state.ts` extended with `isProcessAlive`/`readExitCodeFromLog`/`appendFailure`/`deleteJobPidFile` DI fields and the completion-detection loop — dead PID → read 256-byte log tail for `EXIT_CODE=…`, append failure on non-zero, delete PID file. `lib/menu.ts` gained `⟳ Running:` rows in Status section + rewrites the matching Global/Submenu action row to "Running: <verb>… (<Nm>) … disabled=true". `actionLabel` exported from `lib/rollup.ts`; `isProcessAlive` exported from `lib/actions.ts` so state reader shares the same SIGCONT probe. Cleanup pass (`pruneFailuresOlderThan` + `pruneLogs`) added at end of `main()`'s poll branch. 9 new tests across `state_test.ts` + new `menu_in_flight_test.ts`. Tests total: **146 / 146**.).
- Step 13 — Confirmations + sentinel + Show last output: commit `e92ebaf` (`ActionDeps` gained `confirmDialog`; `productionConfirmDialog` invokes osascript `display dialog` with Cancel-default for `force-reembed-collection` ("Force re-embed all chunks in <name>?") and `cleanup` ("Clean up orphaned data from the qmd cache?"). `escapeForAppleScript` extracted and exported from `lib/actions.ts`. `CurrentState` gained `recentLogs: LogFileInfo[]` (newest-first via explicit sort in `lib/state.ts`); `renderUtilityFooter` conditionally emits `📄 Show last output | bash="open" param1="-t" param2="<path>"` after "Show qmd status in Terminal". Sentinel check at top of poll path removes `~/.cache/swiftbar-qmd/sentinels/recheck` if present. 9 new tests. Tests total: **155 / 155**.).
- Step 14 — Notifications: commit `45cfea0` (`lib/notify.ts` with `diffStates(prev, current, config?)`, `buildSnapshot(state, tier, prev)`, `emitNotifications(events, snapshot, config, deps?)`. SPEC §14.3 copy table implemented verbatim; SPEC §14.1 dedupe keys; rate-limit cap of 3 with a "+ N more" overflow notification; 5-minute dedupe TTL; opt-in/opt-out filtering per `config.notifications.<kind>`. `PollSnapshot` gained `inFlightJobs: JobInfo[]` so `diffStates` can detect job completion (back-compat: hydrator treats missing field as `[]`). `qmd.30s.ts` poll path now: readSnapshot → readCurrentState → computeTier → diffStates → buildSnapshot → emitNotifications → writeSnapshot → renderMenu → cleanup. 28 new tests. Tests total: **183 / 183**.).
- Step 15 — Error handling fence: commit `c8e4376` (`lib/state.ts` exports `readCurrentStateWithSnapshot(config, prev, sources?)` returning `{ state, consecutiveReadFailures, degraded }`, plus `synthesizeLastGoodState(prev, current)` to fall back to the last-good snapshot when the current read failed. `lib/menu.ts` `renderMenu` gained an optional 4th `errorContext` param; emits `⚠ Status read failed — using last poll (<relative>)` header and `⚠ Show last error` footer when degraded. `qmd.30s.ts` forces `tier='red'` and prepends a "Status reads failed 3 polls in a row" driver when `consecutiveReadFailures >= 3`. Top-level try/catch fence wraps `main()` with an emergency menu (`⚠ / Unhandled error: <msg> / Show error log`) and `Deno.exit(0)` so SwiftBar never sees a crashed plugin. 10 new tests. Tests total: **193 / 193**.).
- Step 16 — Snapshot tests: commit `ed793ef` (10 snapshot tests covering all SPEC §19.2 menu states — healthy / drifting / red / in-flight / no-qmd / no-collections / empty-index / error / config-error / submenu. `tests/fixtures/builders.ts` factory module with `buildHealthyState`, `buildDriftingState`, `buildRedState`, `buildInFlightState`. `createAssertSnapshot` with normalising serializer masks the per-machine plugin path and cache-dir paths so snapshots are stable across CI/developer machines. Snapshots at exact SPEC path `tests/fixtures/snapshots/`. `lib/menu.ts` `ErrorContext` gained `configErrors?: string[]` so the renderer can emit `⚠ Config error — see logs` (wiring of `loadConfig().errors` → `errorContext` left for the polish pass). `tests/README.md` documents regeneration. CI workflow gained an explicit Snapshot tests step. Tests total: **203 / 203**.).
- Step 17 — Install script + README polish + v1.0.0 release prep: commit `5a2b2c6` (`install.sh` at repo root per SPEC §21.2 verbatim — preflight checks for deno + SwiftBar, downloads `qmd.30s.ts` + `config.example.yml` from raw GitHub at a positional REF arg, seeds `~/.config/swiftbar-qmd/config.yml`, executable bit set, syntax-checked via `bash -n`. README merged: user-written sections (title, mockup, "Why this exists", AI disclosure, "For implementers", License) preserved verbatim; prompt-required sections added (one-liner blockquote, "What it does" from SPEC §1, three Install sub-sections, Configure, "What the icon colours mean" table, Requirements, Development, Troubleshooting). CHANGELOG `[Unreleased]` placeholder replaced with `[1.0.0] — 2026-05-17` entry summarising all 17 steps. `qmd.30s.ts` `<swiftbar.version>` bumped `v0.1.0 → v1.0.0`. `loadConfig().errors` now wired through to `errorContext.configErrors` so config validation errors surface as `⚠ Config error — see logs` in the menu. CI workflow gained `install.sh syntax check` step (`bash -n install.sh`). Tests still: **203 / 203**.).

## Pre-release verification (Phase 2)

### Quality gate (Phase 2.1) — all green

| Check | Result |
|-------|--------|
| `deno fmt --check` | 28 files clean |
| `deno lint` | 24 files clean |
| `deno check qmd.30s.ts lib/**/*.ts tests/**/*.ts` | clean |
| `deno test --allow-read --allow-env --allow-write=/tmp --allow-net --allow-run tests/` | **203 / 203 passing** |
| Coverage (overall) | **81.7 % line / 79.6 % branch / 73.7 % function** |
| Coverage on `lib/rollup.ts` (pure module) | **100 % line / branch / function** (per SPEC §19.1 target) |
| Coverage on `lib/time.ts` (pure module) | **100 % branch / 98.1 % line** |
| `grep -rn "as any"` in lib / qmd.30s.ts | none |
| `grep -rn "console.error"` in lib / qmd.30s.ts | 2 SPEC-permitted instances — `lib/detect.ts:169` (defensive outer catch per §18.1) and `lib/menu.ts:410` (unsafe-collection-name warning per Prompt 10) |
| `grep -rn "TODO"` (un-issue-tagged) in lib / qmd.30s.ts | none |
| Shebang permissions audit | matches SPEC §4.2 + the `bash` extension flagged in Step 11; all five `--allow-*` flags present |
| `bash -n install.sh` | clean |
| `test -x install.sh` | OK |

### Autonomous-feasible manual QA (Phase 2.2)

| Scenario | Result |
|----------|--------|
| Snapshot suite — all 10 menu states stable across two consecutive runs | OK (10 / 10) |
| First-run state harness (no-qmd / no-collections / empty-index) | OK (9 / 9 detect tests) |
| Malformed-config recovery (YAML parse error + range violations → DEFAULT_CONFIG + errors[]) | OK (14 / 14 config tests, including `loadConfigFrom: malformed YAML returns DEFAULT_CONFIG with errors`) |
| Shebang allow-flags match SPEC §4.2 verbatim (+ `bash`) | verified |

### Deferred — require user GUI / live qmd

- Fresh-install end-to-end via `install.sh` on a clean macOS profile.
- Live 30 s SwiftBar refresh visible in menubar (load plugin, watch icon update over a few cycles).
- Daemon-kill recovery (stop `qmd mcp` externally → verify red icon + `daemon-crash` notification within 30 s).
- Real Obsidian "Open in Obsidian" handler (requires Obsidian installed + a collection with `.obsidian/` at its root).
- Confirmation dialogs for `force-reembed-collection` and `cleanup` (requires user click).
- Sentinel-driven "Re-check now" round trip (click → instant re-render).
- v1.0.0 tag, GitHub Release authoring with `qmd.30s.ts` + `install.sh` as attachments — explicitly user-gated.

## Decisions made autonomously

Logged so you can review and reverse any if needed:

1. **Worked on a feature branch in the existing clone** (no git-worktree isolation) per your reply during planning — branch name `feat/v1.0.0-implementation`.
2. **Extended `deno.json` `fmt.exclude`** twice — first for `docs/` + `.github/` (`ec582bc`), then for `README.md` + `AGENTS.md` + `session-report.md` + `blockers.md` (`b57f1d9`). Reason: default `deno fmt` was reflowing your locked planning docs and your in-progress `README.md`/`AGENTS.md`, which was forcing subagents into defensive `git checkout` patterns that occasionally swept away orchestrator tracking edits.
3. **Stopped editing `docs/planning/todo.md`** mid-session after a subagent reverted my checkbox ticks and you (or your editor's linter) confirmed the revert was intentional. Used `session-report.md` + git log as the only progress trackers for the remaining prompts.
4. **Branch-routing recovery for Step 6.** That commit (`02221b0`) originally landed on `docs/ai-disclosure-and-agents` because the working dir's active branch had been switched. I fast-forwarded `feat/v1.0.0-implementation` onto it; left `docs/ai-disclosure-and-agents` pointing at the same SHA. You can rewind it with `git branch -f docs/ai-disclosure-and-agents b57f1d9` if you want clean separation.
5. **Did not push any commits to `origin`.** The branch is **14 commits ahead of `origin/feat/v1.0.0-implementation`** at session end (steps 1.1, 2, 3, 4, 5, 5.1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17 → that's 18 commits since `17950bc create README.md` which was the last user push). `git push -u origin feat/v1.0.0-implementation` whenever ready.
6. **Did not tag `v1.0.0`.** Tag + GitHub Release authoring is explicitly user-gated.
7. **Added `bash` to the shebang's `--allow-run`** (Step 11). SPEC §4.2 lists `qmd,open,osascript,kill`; the §13.2 spawn pattern requires `bash -c`. Documented in commit message.
8. **`@std/assert@^1`** added to `deno.json` imports (Step 2) — `@std/testing` v1.x no longer re-exports the `asserts` sub-path the prompt referenced.
9. **`docs/ai-disclosure-and-agents`** branch was created by you mid-session, plus an `AGENTS.md` file and `docs/mockup.svg`. I left both untouched throughout the run.
10. **`PollSnapshot` gained `inFlightJobs`** (Step 14) so `diffStates` can detect `job-complete`/`op-failure` transitions. Persistence hydrator treats the missing field as `[]` for backward-compat with snapshots written before this version.
11. **`renderMenu` gained an optional `errorContext` 4th param** (Step 15) — keeps the renderer signature backward-compatible while threading through `consecutiveReadFailures`, `lastGoodAt`, and (added in Step 16) `configErrors`.
12. **Snapshot files live at `tests/fixtures/snapshots/`** (matches SPEC §19.2 path) via a custom `createAssertSnapshot({ dir, serializer })` factory; the serializer normalises per-machine paths so the snapshots are reproducible on CI.

## Observations worth confirming before release

- **Cold SDK import vs. 100 ms detect timeout.** On the smoke test in Step 4 with qmd installed and on `$PATH`, `await import("@tobilu/qmd")` inside the detect cascade still exceeded the SPEC-mandated 100 ms timeout, so first-run detection produced `no-qmd`. Once the Deno cache is warm this should be sub-100 ms, but it's worth re-measuring with the v1.0.0 plugin loaded into a real SwiftBar install. If warm imports also miss the budget, SPEC §5.2 needs lifting (200 ms?) or the SDK probe needs caching of "I already loaded this".
- **2.5 GB qmd model cache.** Prompt 7's `readIndexStatus` populates `modelCacheBytes`. The menu doesn't currently show this; if you want it visible, drop a row into the Status section.

## Blockers

None. Every stop condition was avoided: all 17 prompts completed, no build failure outlasted a single retry, no ambiguity needed a human decision.

## Manual QA / Release steps remaining for user

### Manual QA (cannot be automated)

1. `bash install.sh` against `feat/v1.0.0-implementation` (or pinned tag once published) on a clean macOS profile — verify the plugin lands in `~/Library/Application Support/SwiftBar/Plugins/` and the example config is seeded.
2. Restart SwiftBar; confirm the icon appears within 30 s and reflects the real tier of your qmd install.
3. Click each Global action and confirm it spawns a `qmd …` child + writes a PID file under `~/.cache/swiftbar-qmd/jobs/` + log file under `~/.cache/swiftbar-qmd/logs/`. Confirm the action row rewrites to `Running: <verb>… (<Nm>) … disabled=true` while in flight.
4. Hover a collection row — verify the submenu shows info rows (`<N> docs · qmd://...`, `Pattern`, `Last updated [⚠]`) and action rows. Click `Reveal in Finder`; verify the folder opens. Click `Copy collection name`; verify the clipboard.
5. Click `Force re-embed all` and `🧹 Cleanup orphaned data…`; verify osascript confirmation dialogs appear and `Cancel` short-circuits without spawning.
6. Stop the qmd MCP daemon externally (e.g. `qmd mcp stop`) and wait one poll cycle — verify the icon turns red AND a `qmd daemon stopped` notification fires. Restart the daemon, wait another poll, confirm the icon recovers.
7. Edit `~/.config/swiftbar-qmd/config.yml` to introduce a deliberate range violation (e.g. `coverage.amber_percent: 999`); verify the menu shows the `⚠ Config error — see logs` header and `Show last error` footer.
8. (If you have an Obsidian vault) verify `Open in Obsidian` opens it; (if you have a collection without `.obsidian/`) verify the row is hidden when `hide_obsidian_when_absent: true`.

### Release (v1.0.0) — explicitly user-gated

1. `git push -u origin feat/v1.0.0-implementation` and open a PR against `main` if you want CI to verify the macOS-runner snapshot tests before merging.
2. Merge to `main`.
3. `git tag -a v1.0.0 -m "swiftbar-qmd v1.0.0"` on the merged commit.
4. `git push origin v1.0.0`.
5. Draft the GitHub Release; attach `qmd.30s.ts` and `install.sh` as release artifacts (the curl installer's `REF=v1.0.0` form will then resolve against the tag).
6. Update README's install commands to substitute the literal `v1.0.0` for `main` once tagged.
7. Smoke-test one install path on a clean profile to confirm the published artifacts work end-to-end.

### Branch-cleanup choices

- `docs/ai-disclosure-and-agents` currently points at `02221b0` (step 6). To make it a pure docs branch with no implementation commits, run `git branch -f docs/ai-disclosure-and-agents b57f1d9`. Otherwise it's a harmless duplicate.

### Things deliberately deferred / out of scope

- Web-based preferences UI (v1.x candidate per `DECISIONS.md` §D11).
- Activity feed and multi-index support (v1.1 candidates per §D8 + §D9).
- Homebrew tap (v1.x per §D15).
- Spinner overlay on the menubar icon (§D2 alternative).
- Per-machine cold-SDK-import budget revisit (see "Observations" above).

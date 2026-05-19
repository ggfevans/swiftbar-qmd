# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/) and
this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-05-17

First public release. Implements the full v1 specification documented in
[`docs/planning/SPEC.md`](docs/planning/SPEC.md).

### Added

- Initial SwiftBar plugin (`qmd.30s.ts`) providing ambient operational
  visibility for qmd in the macOS menubar.
- 30-second poll cycle reading the qmd SDK, the HTTP daemon `/health` endpoint,
  and persisted job state.
- Aggregate health rollup icon with four tiers: green / amber / red / hollow
  grey (first-run).
- Dropdown menu organised into Status, Collections, Global actions, and
  Preferences sections (SPEC §10).
- Per-collection submenus with Update, Embed, Force re-embed, Reveal in Finder,
  Copy stats, View context, and Open in Obsidian actions (SPEC §11).
- Background action runner with PID tracking, per-action locking, and per-action
  log files (SPEC §13).
- Action completion detection via log-tail `EXIT_CODE` parsing (SPEC §13.4).
- Failure-class notifications (`daemon-crash`, `op-failure`, `path-unreachable`)
  with 5-minute dedupe and a rate-limit cap (SPEC §14).
- Opt-in `job-complete` and `threshold-breach` notifications.
- First-run detection with three contextual menu states (`no-qmd`,
  `no-collections`, `empty-index`) (SPEC §12).
- YAML configuration at `~/.config/qmd-swiftbar/config.yml` with range
  validation, per-poll hot-reload, and a documented `config.example.yml` (SPEC
  §7).
- Defensive read path with last-good snapshot fallback and forced-red after
  three consecutive failures (SPEC §16.2).
- Top-level error fence with an emergency menu when the plugin itself throws
  (SPEC §16.3).
- Three install paths: manual `curl`, scripted `install.sh`, and SwiftBar
  "Install from URL" (SPEC §21).
- Comprehensive test suite: 203 tests across 11 files including 10-state
  snapshot coverage of the §10 menu (SPEC §19.2).
- CI workflow running format check, lint, type check, full test suite, snapshot
  tests, executable-bit check, and `install.sh` syntax check.

# swiftbar-qmd — v1 Developer Specification

**Repository:** `ggfevans/swiftbar-qmd`
**License:** MIT
**Runtime:** Deno 2.x
**Target platform:** macOS (Apple Silicon and Intel) via [SwiftBar](https://github.com/swiftbar/SwiftBar)
**Upstream dependency:** [tobi/qmd](https://github.com/tobi/qmd) v2.x
**Spec revision:** 2026-05-17 (locked for v1.0.0 implementation)

This document is the canonical implementation reference. A developer should be able to read it end-to-end and start writing code without further architectural questions. Where opinions had to be made, they're recorded in [`DECISIONS.md`](DECISIONS.md); where background research informed a pick, it's in [`RESEARCH.md`](RESEARCH.md).

---

## Table of contents

1. [Summary](#1-summary)
2. [User and goals](#2-user-and-goals)
3. [Architecture overview](#3-architecture-overview)
4. [Runtime, permissions, and dependencies](#4-runtime-permissions-and-dependencies)
5. [Repository layout and module contracts](#5-repository-layout-and-module-contracts)
6. [Type definitions](#6-type-definitions)
7. [Configuration](#7-configuration)
8. [State model](#8-state-model)
9. [Icon rollup logic](#9-icon-rollup-logic)
10. [Dropdown menu rendering](#10-dropdown-menu-rendering)
11. [Per-collection submenu](#11-per-collection-submenu)
12. [First-run states](#12-first-run-states)
13. [Action execution](#13-action-execution)
14. [Notifications](#14-notifications)
15. [State persistence](#15-state-persistence)
16. [Error handling](#16-error-handling)
17. [Performance budgets](#17-performance-budgets)
18. [Logging](#18-logging)
19. [Testing plan](#19-testing-plan)
20. [CI configuration](#20-ci-configuration)
21. [Distribution](#21-distribution)
22. [Implementation milestones](#22-implementation-milestones)
23. [Acceptance criteria for v1.0.0](#23-acceptance-criteria-for-v100)
24. [Out of scope (deferred)](#24-out-of-scope-deferred)
25. [Glossary](#25-glossary)
26. [Appendix A — SwiftBar output format reference](#appendix-a--swiftbar-output-format-reference)
27. [Appendix B — qmd SDK surface used](#appendix-b--qmd-sdk-surface-used)
28. [Appendix C — Decision log summary](#appendix-c--decision-log-summary)

---

## 1. Summary

swiftbar-qmd is a SwiftBar plugin that surfaces operational visibility into a running qmd installation through the macOS menubar. It answers two questions the user has on an ongoing basis: *what is qmd doing right now*, and *what state are my collections in*. It also provides one-click access to common maintenance actions (`qmd update`, `qmd embed`, MCP daemon control) so those operations do not require a context switch to the terminal.

The plugin is ADHD-first in design: a single ambient signal (the menubar icon's colour) answers "do I need to click?" at a glance, the dropdown menu is organised by signal type for fast scanning, and notifications are reserved exclusively for failures so the tool does not accumulate notification debt.

It is explicitly **not** a search interface — searching is qmd's CLI / MCP / SDK job, and a separate TUI ([lazyqmd](https://github.com/AlexZeitler/lazyqmd)) already covers that surface. swiftbar-qmd is purely an operational dashboard.

---

## 2. User and goals

The primary user is a technically literate qmd power user who:

- Indexes multiple collections (typically 2–6) of markdown documents — most commonly Obsidian vaults, project documentation, and personal notes.
- Wants to know *without thinking* whether their search index is healthy, fresh, and reachable.
- Has no current menubar surface for any of this information; the only ways to check qmd state are running `qmd status` in a terminal or hitting the HTTP daemon's `/health` endpoint manually.
- Routinely runs `qmd update` and `qmd embed` as background maintenance, and wants to do so from anywhere on screen without opening a terminal window.

### 2.1 Reference user setup

The spec assumes (without enforcing) a setup like the one described by the project owner during scoping:

- Four collections of varying size (100 to 2,000+ docs), all `**/*.md` patterns, mostly Obsidian vaults at the source.
- A single shared qmd index at `~/.cache/qmd/index.sqlite`.
- The MCP daemon usually running via `qmd mcp --http --daemon` for downstream consumers (Claude Code, lazyqmd).
- Daily journalling + intermittent batch indexing as the typical maintenance cadence.

### 2.2 Anti-goals

The plugin will *not*:

- Perform any search itself (no query input, no results display).
- Edit qmd collections or context entries (only invoke qmd CLI commands that do).
- Replace lazyqmd or any other qmd UI.
- Implement features that require modifying qmd itself (e.g. structured event logs, push notifications from the daemon).
- Support Windows or Linux. SwiftBar is macOS-only; alternative menubar hosts are not in scope.

---

## 3. Architecture overview

### 3.1 Component diagram

```
┌────────────────────────────────────────────────────────────────┐
│  macOS menubar                                                  │
│                                  [Q▾]  [wifi] [bat] [12:34]     │
│                                   │                              │
│                                   ▼                              │
│                              ┌─────────────┐                     │
│                              │  Dropdown   │                     │
│                              │  (NSMenu)   │                     │
│                              └─────────────┘                     │
└────────────────────────────────────────────────────────────────┘
        ▲                            │
        │ stdout                     │ click invokes script
        │ (menu rendering)           │ with action arg
        │                            ▼
   ┌────┴───────────────────────────────────────────┐
   │  qmd.30s.ts  (Deno, fork-per-poll)             │
   │                                                 │
   │  ┌────────────┐  ┌──────────────┐  ┌─────────┐ │
   │  │ State read │  │ Action runner│  │ First-  │ │
   │  │  via SDK   │  │  via CLI     │  │ run det.│ │
   │  └─────┬──────┘  └──────┬───────┘  └────┬────┘ │
   │        │                │                │      │
   │  ┌─────▼───────┐  ┌─────▼──────┐  ┌──────▼───┐ │
   │  │  Rollup     │  │  Notify    │  │  Menu    │ │
   │  │  (pure fn)  │  │  (osascript)│ │  render  │ │
   │  └─────────────┘  └────────────┘  └──────────┘ │
   └────────┬────────────┬────────────┬──────────────┘
            │            │            │
            ▼            ▼            ▼
       qmd SDK     qmd CLI     osascript

       Filesystem touchpoints:
       - ~/.cache/qmd/index.sqlite        (read)
       - ~/.cache/qmd/mcp.pid              (read)
       - ~/.config/swiftbar-qmd/config.yml (read)
       - ~/.cache/swiftbar-qmd/            (read + write)
```

### 3.2 Process lifecycle (poll cycle)

Each invocation of `qmd.30s.ts` is a fresh, short-lived Deno process. The lifecycle is:

```
SwiftBar spawns qmd.30s.ts (no args = poll mode)
│
├─ Parse argv: mode = 'poll' | 'action'
│
├─ Load and validate config from ~/.config/swiftbar-qmd/config.yml
│  (write defaults file if missing; reject invalid types with safe fallback)
│
├─ Run first-run detection (lib/detect.ts)
│  ├─ qmd binary present in $PATH?
│  ├─ SDK importable?
│  ├─ Index DB exists and opens?
│  └─ At least one collection has docs?
│  → returns: 'ok' | 'no-qmd' | 'no-collections' | 'empty-index'
│
├─ If state != 'ok' → render first-run menu, write skeleton snapshot, exit 0
│
├─ Read current state (lib/state.ts)
│  ├─ SDK: store.listCollections() — per-collection metadata
│  ├─ SDK: store.getStatus() — index health + counts
│  ├─ HTTP: GET /health → daemon liveness (5s timeout)
│  ├─ FS: scan ~/.cache/swiftbar-qmd/jobs/ for in-flight PIDs
│  └─ FS: scan ~/.cache/swiftbar-qmd/recent-failures.json
│  → returns: CurrentState
│
├─ Compute rollup tier (lib/rollup.ts)
│  → returns: 'green' | 'amber' | 'red' | 'grey'
│
├─ Diff against last snapshot (lib/notify.ts)
│  ├─ Load ~/.cache/swiftbar-qmd/last-poll.json
│  ├─ Identify transitions worth notifying
│  └─ Fire notifications via osascript (one per transition)
│
├─ Render menu output to stdout (lib/menu.ts)
│  └─ SwiftBar format: first line = icon spec, then '---', then rows
│
├─ Write new snapshot to ~/.cache/swiftbar-qmd/last-poll.json
│
└─ Exit 0
```

If `qmd.30s.ts` is invoked with `--action <action-id>` (from a clicked menu item), it takes a different path documented in §13.

### 3.3 Sequence — action invocation

```
User clicks "Run update"
│
├─ SwiftBar invokes: qmd.30s.ts --action update-all
│
├─ Action runner (lib/actions.ts):
│  ├─ Verify no PID file exists for this action; if it does, exit silently
│  ├─ Compose command: ['qmd', 'update']
│  ├─ Open log file: ~/.cache/swiftbar-qmd/logs/update-all-<ts>.log
│  ├─ Spawn child detached, stdout+stderr → log file
│  ├─ Write PID file: ~/.cache/swiftbar-qmd/jobs/update-all.pid
│  │  with JSON: { pid: 12345, started_at: ISO, command: [...] }
│  └─ Exit 0 immediately (do NOT wait for child)
│
└─ Next 30s poll picks up the PID file, renders "Running: update… (Nm)"

Child process runs to completion:
│
├─ Writes output to log file (qmd's normal stdout)
├─ Exits with code N
└─ macOS does not notify us; we must detect on next poll

Next poll cycle:
│
├─ FS scan finds PID file
├─ Check if PID is alive (kill -0)
│  ├─ If alive: render "Running… (elapsed)" in menu, icon stays yellow
│  └─ If dead:
│     ├─ Read log file tail for EXIT_CODE marker
│     ├─ If exit_code != 0:
│     │  ├─ Record failure in recent-failures.json
│     │  ├─ Fire osascript notification
│     │  └─ Icon red on this poll
│     ├─ If exit_code == 0:
│     │  ├─ If on_job_completion enabled: fire success notification
│     │  └─ Icon recomputed from current state
│     └─ Delete PID file
```

The child process does not know about swiftbar-qmd; we infer completion entirely from the PID disappearing. To get the exit code without polling stdout, the action runner wraps the child invocation in a small shell snippet:

```bash
( qmd update > log 2>&1; echo "EXIT_CODE=$?" >> log ) &
```

The trailing `EXIT_CODE=N` line is the source of truth for outcome.

---

## 4. Runtime, permissions, and dependencies

### 4.1 Runtime

**Deno 2.x** (latest stable patch). Specifically targeting Deno ≥ 2.0.0; tested against the latest in CI.

Why Deno over Bun or Node: see [`DECISIONS.md`](DECISIONS.md) §10 and the Bun-rewrite findings in [`RESEARCH.md`](RESEARCH.md). The TL;DR — Bun's Zig→Rust core rewrite landed three days before this spec was written, with 13,000 `unsafe` blocks and modified tests; a runtime mid-transition is not a sound bet for a stability-sensitive plugin. Deno's trajectory has been steady since Deno 2; the cost of being a canary for `npm:@tobilu/qmd` via Deno is bounded because we use only read-only SDK methods.

### 4.2 Permission flags

The plugin runs with an explicit allow-list, declared in the shebang. These also act as inline documentation of what the script can touch:

```bash
#!/usr/bin/env -S deno run \
  --allow-net=localhost:8181 \
  --allow-read=$HOME/.cache/qmd,$HOME/.config/swiftbar-qmd,$HOME/.cache/swiftbar-qmd \
  --allow-write=$HOME/.cache/swiftbar-qmd,$HOME/.config/swiftbar-qmd \
  --allow-run=qmd,open,osascript,kill \
  --allow-env=HOME,PATH,EDITOR
```

The `--allow-net` is narrowed to the daemon endpoint. `--allow-write` to `~/.config/swiftbar-qmd` is needed only to seed the example config on first run. `--allow-run` is constrained to the four executables we shell out to.

### 4.3 Dependencies

Locked in `deno.json`:

| Specifier | Purpose | Notes |
|-----------|---------|-------|
| `npm:@tobilu/qmd@^2.1.0` | qmd SDK for reads | Only `createStore`, `listCollections`, `getStatus` used. Avoid `embed`/`search`/`query` paths (they load models). |
| `jsr:@std/yaml@^1` | Config file parsing | First-party Deno YAML. |
| `jsr:@std/path@^1` | Filesystem path manipulation | Cross-platform path joining. |
| `jsr:@std/fs@^1` | Filesystem helpers | `ensureDir`, `exists`. |
| `jsr:@std/testing@^1` | Snapshot + assertion testing | `assertSnapshot` for menu output. |
| `npm:zod@^3` | Config schema validation | Optional — hand-rolled validation is acceptable if Zod feels heavy. |

No other npm or jsr dependencies in v1. Adding one requires a decision log entry.

### 4.4 Required system tools

The plugin invokes these via `--allow-run`:

| Tool | Why | Detection |
|------|-----|-----------|
| `qmd` | All maintenance actions | `Deno.Command('which', { args: ['qmd'] })` in detect.ts |
| `open` | Open log files, README URLs | macOS built-in |
| `osascript` | Fire notifications, optional dialogs | macOS built-in |
| `kill -0 <pid>` | Stale PID detection | Use `Deno.kill` instead — same semantic, no subprocess |

---

## 5. Repository layout and module contracts

### 5.1 Tree

```
swiftbar-qmd/
├── qmd.30s.ts              # SwiftBar entry point (interval encoded in filename)
├── lib/
│   ├── types.ts            # All TypeScript types
│   ├── config.ts           # YAML loader, schema, defaults
│   ├── detect.ts           # First-run state detection
│   ├── state.ts            # SDK wrapper: read collections, daemon, freshness
│   ├── rollup.ts           # Pure: threshold logic → tier colour
│   ├── menu.ts             # SwiftBar-format menu output renderer
│   ├── actions.ts          # CLI action spawner, PID file management
│   ├── notify.ts           # State diff + osascript notification
│   ├── persistence.ts      # last-poll.json, error.log, job PID files, recent-failures.json
│   ├── time.ts             # Freshness formatting ("18h ago"), durations, withTimeout
│   └── log.ts              # Internal plugin logger → error.log
├── tests/
│   ├── rollup_test.ts
│   ├── config_test.ts
│   ├── notify_test.ts
│   ├── menu_snapshot_test.ts
│   ├── detect_test.ts
│   ├── time_test.ts
│   └── fixtures/
│       ├── status_healthy.json
│       ├── status_drifting.json
│       ├── status_empty.json
│       └── snapshots/menu_*.snap   # Auto-generated snapshot files
├── deno.json
├── deno.lock                       # Committed
├── config.example.yml
├── install.sh
├── LICENSE
├── README.md
├── CHANGELOG.md
└── .github/
    └── workflows/
        └── ci.yml
```

### 5.2 Module contracts

Each module exposes a small, well-typed surface. Implementations may use whatever internals they like, but the exported shape is locked.

#### `lib/types.ts`

Pure type-only module. Re-exports every type used across the codebase. See §6 for definitions.

#### `lib/config.ts`

```typescript
export const CONFIG_PATH = `${Deno.env.get('HOME')}/.config/swiftbar-qmd/config.yml`;
export const EXAMPLE_CONFIG_PATH = new URL('../config.example.yml', import.meta.url).pathname;

/** Load and validate config; create from example on first run; fall back to defaults on parse failure. */
export async function loadConfig(): Promise<{ config: Config; errors: string[] }>;

/** Default config used when no file present and example unavailable. */
export const DEFAULT_CONFIG: Config;

/** Validate a parsed object against the schema. Returns sanitised config + error list. */
export function validateConfig(raw: unknown): { config: Config; errors: string[] };
```

`loadConfig` never throws. If the file is unreadable or malformed, it returns `DEFAULT_CONFIG` plus a non-empty `errors` array; the caller renders an error header in the menu.

#### `lib/detect.ts`

```typescript
export async function detectFirstRunState(config: Config): Promise<FirstRunState>;
// FirstRunState = 'ok' | 'no-qmd' | 'no-collections' | 'empty-index'
```

Checks performed, in order:

1. `Deno.Command('which', { args: ['qmd'] })` returns success → continue, else `'no-qmd'`.
2. `await import('npm:@tobilu/qmd')` succeeds → continue, else `'no-qmd'`.
3. `Deno.stat(config.qmd.index_path)` succeeds → continue, else `'no-collections'`.
4. `createStore({ dbPath })` + `listCollections()` returns non-empty → continue, else `'no-collections'`.
5. At least one collection has `doc_count > 0` → return `'ok'`, else `'empty-index'`.

Total budget for detection: 500ms. Each check has its own 100ms timeout; failures cascade to the most recoverable state.

#### `lib/state.ts`

```typescript
export async function readCurrentState(config: Config): Promise<CurrentState>;
```

Composes:

```typescript
// Pseudo-code
const collections = await withTimeout(store.listCollections(), 2000);
const status      = await withTimeout(store.getStatus(), 2000);
const daemon      = await probeDaemon(config.qmd.daemon_url); // 5s timeout
const inFlightJobs    = await readJobPidFiles();              // FS scan
const recentFailures  = await readRecentFailures();           // FS read

return { collections, status, daemon, inFlightJobs, recentFailures, polledAt: new Date() };
```

If any individual read fails, populate the corresponding field with `{ error: string }` and continue — never throw out of `readCurrentState`. The caller renders best-effort.

#### `lib/rollup.ts`

```typescript
export function computeTier(state: CurrentState, config: Config): Tier;
// Tier = 'green' | 'amber' | 'red' | 'grey'

export interface TierReason {
  tier: Tier;
  drivers: string[];  // Human-readable, one per triggering condition
}

export function computeTierWithReason(state: CurrentState, config: Config): TierReason;
```

Pure function. No I/O, no async. Tested exhaustively in `rollup_test.ts`.

#### `lib/menu.ts`

```typescript
export function renderMenu(state: CurrentState, tier: TierReason, config: Config): string;
// Returns the full SwiftBar-format stdout string.

export function renderFirstRunMenu(firstRun: FirstRunState, config: Config): string;
```

Output format documented in [Appendix A](#appendix-a--swiftbar-output-format-reference).

#### `lib/actions.ts`

```typescript
export type ActionId =
  | 'update-all'
  | 'embed-all'
  | 'update-collection'
  | 'embed-collection'
  | 'force-reembed-collection'
  | 'restart-daemon'
  | 'stop-daemon'
  | 'start-daemon'
  | 'cleanup'
  | 'recheck';

export async function runAction(id: ActionId, args: Record<string, string>): Promise<void>;
// args is action-specific: e.g. { collection: 'gVault' } for per-collection actions.
```

Action runner protocol:

1. Validate `args` for the action's required shape.
2. Acquire the action's lockfile (`~/.cache/swiftbar-qmd/jobs/<action-id>.pid`); if present and PID alive, exit silently.
3. Construct command (mapping below).
4. Spawn child detached with output → log file.
5. Write PID file with metadata.
6. Exit 0 immediately.

Command mapping:

| ActionId | Command | Notes |
|----------|---------|-------|
| `update-all` | `qmd update` | |
| `embed-all` | `qmd embed` | New chunks only |
| `update-collection` | `qmd update` then `qmd embed -c <name>` | qmd's `update` doesn't take `-c`; chained with `&&` |
| `embed-collection` | `qmd embed -c <name>` | |
| `force-reembed-collection` | `qmd embed -c <name> -f` | Confirms via osascript dialog first |
| `restart-daemon` | `qmd mcp stop && qmd mcp --http --daemon` | Chained |
| `stop-daemon` | `qmd mcp stop` | |
| `start-daemon` | `qmd mcp --http --daemon` | |
| `cleanup` | `qmd cleanup` | Confirms via osascript dialog first |
| `recheck` | (no command) | Touches a sentinel file that the next poll detects to force-render |

#### `lib/notify.ts`

```typescript
export function diffStates(prev: PollSnapshot | null, current: CurrentState): NotificationEvent[];

export async function emitNotifications(events: NotificationEvent[], config: Config): Promise<void>;

export type NotificationEvent =
  | { kind: 'daemon-crash'; previousUptime: number }
  | { kind: 'op-failure'; action: ActionId; collection?: string; exitCode: number; logPath: string }
  | { kind: 'path-unreachable'; collection: string; path: string }
  | { kind: 'job-complete'; action: ActionId; collection?: string; durationMs: number } // opt-in
  | { kind: 'threshold-breach'; metric: 'freshness' | 'coverage'; collection?: string }; // opt-in
```

Each `emitNotifications` call invokes one `osascript` per event, capped to 3 simultaneous notifications per poll cycle to avoid spam.

#### `lib/persistence.ts`

```typescript
export const CACHE_DIR = `${Deno.env.get('HOME')}/.cache/swiftbar-qmd`;

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
```

All functions handle "file does not exist" as a non-error (return null / empty).

#### `lib/time.ts`

```typescript
/** "18h", "1d", "52m", "3w" — for compact menu metadata */
export function compactDuration(ms: number): string;

/** "18 hours ago", "yesterday", "52 minutes ago" — for notifications */
export function relativeTime(date: Date, now?: Date): string;

/** Wrap a promise in a timeout; reject with TimeoutError if not resolved in time. */
export function withTimeout<T>(p: Promise<T>, ms: number, label?: string): Promise<T>;
```

#### `lib/log.ts`

```typescript
export function logError(category: string, message: string, error?: Error): Promise<void>;
export function logInfo(category: string, message: string): Promise<void>;
```

Writes to `~/.cache/swiftbar-qmd/error.log` (both info and error). Rotates at 1 MB.

---

## 6. Type definitions

These types live in `lib/types.ts` and are imported throughout. They form the contract for inter-module data passing.

```typescript
// ─── Configuration ─────────────────────────────────────────────

export interface Config {
  qmd: {
    index_path: string;
    daemon_url: string;
  };
  rollup: {
    freshness: { amber_hours: number; red_days: number };
    coverage:  { amber_percent: number; red_percent: number };
    error_window: { red_hours: number; amber_hours: number };
  };
  notifications: {
    on_daemon_crash: boolean;
    on_op_failure: boolean;
    on_path_unreachable: boolean;
    on_job_completion: boolean;   // opt-in
    on_threshold_breach: boolean; // opt-in
  };
  ui: {
    collection_meta: 'freshness' | 'coverage' | 'both';
    hide_obsidian_when_absent: boolean;
  };
  logs: {
    directory: string;
    retain_per_action: number;
  };
}

// ─── State ─────────────────────────────────────────────────────

export interface CurrentState {
  collections: CollectionState[];
  status: IndexStatus;
  daemon: DaemonState;
  inFlightJobs: JobInfo[];
  recentFailures: FailureRecord[];
  polledAt: Date;
}

export interface CollectionState {
  name: string;
  path: string;             // host filesystem path
  qmdUri: string;           // qmd://<name>/
  pattern: string;          // e.g. "**/*.md"
  reachable: boolean;       // path exists and is readable
  docCount: number;
  coveragePercent: number;  // 0–100; 100 if zero docs (no division by zero)
  lastModified: Date | null;
  hasObsidian: boolean;     // .obsidian/ folder present at root
  error?: string;           // if SDK couldn't read this collection
}

export interface IndexStatus {
  totalDocs: number;
  totalCollections: number;
  dbSizeBytes: number;
  modelCacheBytes: number;
  error?: string;
}

export interface DaemonState {
  status: 'running' | 'stopped' | 'unresponsive';
  pid?: number;
  uptimeSeconds?: number;
  endpoint: string;
  error?: string;
}

export type FirstRunState = 'ok' | 'no-qmd' | 'no-collections' | 'empty-index';

// ─── Rollup ────────────────────────────────────────────────────

export type Tier = 'green' | 'amber' | 'red' | 'grey';

export interface TierReason {
  tier: Tier;
  drivers: string[];
}

// ─── Jobs & failures ──────────────────────────────────────────

export interface JobInfo {
  action: ActionId;
  collection?: string;
  pid: number;
  startedAt: Date;
  command: string[];
  logPath: string;
}

export interface FailureRecord {
  action: ActionId;
  collection?: string;
  failedAt: Date;
  exitCode: number;
  logPath: string;
}

export type ActionId =
  | 'update-all' | 'embed-all'
  | 'update-collection' | 'embed-collection' | 'force-reembed-collection'
  | 'restart-daemon' | 'stop-daemon' | 'start-daemon'
  | 'cleanup' | 'recheck';

// ─── Snapshot (persisted) ─────────────────────────────────────

export interface PollSnapshot {
  pollTimestamp: string;     // ISO 8601
  daemon: DaemonState;
  collections: CollectionState[];
  recentOpFailures: FailureRecord[];
  computedTier: Tier;
  tierDrivers: string[];
  recentlyNotified: Record<string, string>; // dedupe key → ISO timestamp
  consecutiveReadFailures: number;
}

// ─── Notifications ─────────────────────────────────────────────

export type NotificationEvent =
  | { kind: 'daemon-crash'; previousUptime: number }
  | { kind: 'op-failure'; action: ActionId; collection?: string; exitCode: number; logPath: string }
  | { kind: 'path-unreachable'; collection: string; path: string }
  | { kind: 'job-complete'; action: ActionId; collection?: string; durationMs: number }
  | { kind: 'threshold-breach'; metric: 'freshness' | 'coverage'; collection?: string };

// ─── Logs ──────────────────────────────────────────────────────

export interface LogFileInfo {
  action: ActionId;
  path: string;
  createdAt: Date;
  sizeBytes: number;
}
```

---

## 7. Configuration

### 7.1 File location and bootstrap

Canonical path: `~/.config/swiftbar-qmd/config.yml`.

On first run, if the file is absent:

1. Create `~/.config/swiftbar-qmd/` if missing.
2. Copy `config.example.yml` from the install location (next to the script) to the canonical path.
3. If the example is also missing (e.g. plugin file moved without the example), serialise `DEFAULT_CONFIG` to YAML and write it.

This means the user always has a real file they can hand-edit, never just defaults baked into code.

### 7.2 Schema and defaults

```yaml
# swiftbar-qmd config — values shown are defaults
# Tuning these adjusts what triggers yellow/red on the menubar icon.

qmd:
  # Path to the qmd SQLite index. Default matches qmd's own location.
  index_path: ~/.cache/qmd/index.sqlite
  # MCP daemon endpoint. Used for /health probe only.
  daemon_url: http://localhost:8181

rollup:
  freshness:
    amber_hours: 24    # Yellow if last successful update > this
    red_days: 7        # Red if last successful update > this
  coverage:
    amber_percent: 95  # Yellow if any collection embedded below this
    red_percent: 50    # Red if any collection embedded below this
  error_window:
    red_hours: 1       # Red for this long after a maintenance op failure
    amber_hours: 24    # Yellow during the period from red_hours to amber_hours after a failure

notifications:
  on_daemon_crash: true
  on_op_failure: true
  on_path_unreachable: true
  # Opt-in (default false): success and threshold-breach notifications
  on_job_completion: false
  on_threshold_breach: false

ui:
  # Per-collection row meta format. Options: 'freshness' | 'coverage' | 'both'
  collection_meta: freshness
  # Hide "Open in Obsidian" submenu item for collections without .obsidian/
  hide_obsidian_when_absent: true

logs:
  # Where action stdout/stderr is captured
  directory: ~/.cache/swiftbar-qmd/logs
  # Max log files to retain per action type before rotation
  retain_per_action: 10
```

Validation rules:

| Key | Type | Range | On violation |
|-----|------|-------|--------------|
| `qmd.index_path` | string | non-empty, `~` expanded | Fall back to default |
| `qmd.daemon_url` | string | valid URL with `http(s)://` | Fall back to default |
| `rollup.freshness.amber_hours` | number | 0 < x ≤ 8760 | Fall back to default |
| `rollup.freshness.red_days` | number | freshness.amber_hours/24 < x ≤ 365 | Fall back to default |
| `rollup.coverage.amber_percent` | number | 0 ≤ x ≤ 100 | Fall back to default |
| `rollup.coverage.red_percent` | number | 0 ≤ x ≤ coverage.amber_percent | Fall back to default |
| `rollup.error_window.red_hours` | number | 0 < x ≤ 168 | Fall back to default |
| `rollup.error_window.amber_hours` | number | error_window.red_hours < x ≤ 720 | Fall back to default |
| All notification booleans | boolean | true/false | Fall back to default |
| `ui.collection_meta` | enum | 'freshness'\|'coverage'\|'both' | Fall back to default |
| `ui.hide_obsidian_when_absent` | boolean | true/false | Fall back to default |
| `logs.directory` | string | non-empty, `~` expanded | Fall back to default |
| `logs.retain_per_action` | number | 0 ≤ x ≤ 1000 | Fall back to default |

Any violation produces a string in the `errors` array returned by `validateConfig`, which causes the menu to render an `⚠ Config error — see logs` header item.

### 7.3 Hot reload

Config is re-read on every poll. No restart required after editing. The change takes effect on the next 30-second tick (or immediately if you click the menu icon).

---

## 8. State model

### 8.1 What's read each poll

Per §3.2, every poll constructs a `CurrentState` from four sources:

1. **SDK reads** — `listCollections()` and `getStatus()` from `npm:@tobilu/qmd`. These open a read-only handle to the sqlite index. The qmd MCP daemon's writer (if running) holds its own write handle; sqlite's WAL mode supports concurrent readers without contention.
2. **HTTP probe** — `GET <daemon_url>/health` with 5s timeout. Falls back to "stopped" on connection refused, "unresponsive" on timeout.
3. **PID file scan** — list `~/.cache/swiftbar-qmd/jobs/*.pid` and check each PID via `Deno.kill(pid, 'SIGCONT')`.
4. **Failures file** — read `~/.cache/swiftbar-qmd/recent-failures.json`.

### 8.2 Derived metadata

After reading, we compute:

- `CollectionState.hasObsidian` — `await Deno.stat(`${path}/.obsidian`)` succeeds.
- `CollectionState.reachable` — `await Deno.stat(path)` succeeds.
- `CollectionState.coveragePercent` — derived from `status.embedded_chunks / status.total_chunks * 100` per collection; 100 if `total_chunks === 0`.
- `CollectionState.lastModified` — taken from SDK if available; otherwise `Deno.stat(path).mtime` as fallback.

### 8.3 Transitions tracked

For notification purposes, `diffStates(prev, current)` produces events when:

| Transition | Event kind |
|-----------|-----------|
| Daemon running → stopped/unresponsive | `daemon-crash` |
| Collection reachable → unreachable | `path-unreachable` |
| Job in flight → exited with non-zero exit | `op-failure` |
| Job in flight → exited with zero (opt-in) | `job-complete` |
| Coverage above amber → below amber (opt-in) | `threshold-breach: coverage` |
| Freshness within amber → past amber (opt-in) | `threshold-breach: freshness` |

A transition fires *once*; the same condition observed again in the next poll does not re-notify.

---

## 9. Icon rollup logic

### 9.1 Precedence

Tier is computed by checking conditions in this exact order. The **first** matching tier wins:

```typescript
function computeTier(state: CurrentState, config: Config): Tier {
  // Special states first
  if (!state.collections.length && !state.status.totalCollections) {
    return 'grey'; // first-run / no collections
  }

  // RED tier checks
  if (state.daemon.status !== 'running') return 'red';
  if (state.collections.some(c => !c.reachable)) return 'red';
  if (anyFailureWithin(state.recentFailures, config.rollup.error_window.red_hours)) return 'red';
  if (state.collections.some(c => c.coveragePercent < config.rollup.coverage.red_percent)) return 'red';
  if (oldestUpdate(state.collections) > config.rollup.freshness.red_days * 24 * 3600 * 1000) return 'red';

  // AMBER tier checks
  if (state.inFlightJobs.length > 0) return 'amber';
  if (state.collections.some(c => c.coveragePercent < config.rollup.coverage.amber_percent)) return 'amber';
  if (oldestUpdate(state.collections) > config.rollup.freshness.amber_hours * 3600 * 1000) return 'amber';
  if (anyFailureWithin(state.recentFailures, config.rollup.error_window.amber_hours)) return 'amber';

  // GREEN: everything passed
  return 'green';
}
```

### 9.2 Drivers

`computeTierWithReason` runs the same logic but accumulates a list of human-readable strings describing *every* matching condition (not just the first), used to populate the "Status" section of the menu. Example:

```typescript
['Daemon stopped', 'Rackula last updated 1d ago (>24h)', 'jobinator9000 at 87% coverage (<95%)']
```

The Status section's "1 collection drifting" auto-summary counts collections that are amber-or-worse (per-collection rollup using the same function applied to a single-collection slice of state).

### 9.3 Icon glyph

A monochrome SVG template image, 18×18pt, base64-encoded. Use `image=<base64>` and `templateImage=true` in the first SwiftBar line so macOS handles light/dark mode automatically. For tier colours, override via `color=` on the first line.

The glyph: a circle (the loop of the Q) with a short diagonal tail extending bottom-right.

Sample SVG (to be embedded base64 in the script):

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14">
  <circle cx="6.2" cy="6.2" r="4.2" fill="currentColor"/>
  <circle cx="6.2" cy="6.2" r="1.6" fill="white"/>
  <line x1="8.6" y1="8.6" x2="11.2" y2="11.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>
```

For the hollow grey state, replace the inner shapes with a stroke-only outline:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14">
  <circle cx="6.2" cy="6.2" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/>
  <line x1="8.6" y1="8.6" x2="11.2" y2="11.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>
```

---

## 10. Dropdown menu rendering

### 10.1 SwiftBar output format

SwiftBar reads from stdout. The first non-empty line is the menubar item itself; everything after the first `---` separator is the dropdown menu. Each line is either a menu row or a separator (`---`). Modifiers are appended after a pipe character. Full directive reference in [Appendix A](#appendix-a--swiftbar-output-format-reference).

### 10.2 Top-level menu structure (healthy)

```
┌─────────────────────────────────────┐
│ [icon, tier-coloured, hover tooltip] │  ← menubar item line
└─────────────────────────────────────┘
            │ click
            ▼
┌─────────────────────────────────────┐
│ Status (section header)              │
│   ● Daemon running     6h 04m        │  ← coloured dot, right-aligned uptime
│   ○ 1 collection drifting            │  ← amber dot, auto-summary
│     Last update        12m ago       │
│ ───                                  │
│ Collections (N) (section header)     │
│   ● gVault          2,057 · 18h ▸    │  ← green dot, doc count · freshness
│   ● jobinator9000     129 · 1h  ▸    │
│   ● obsidian-reference 1,596 · 52m ▸ │
│   ○ Rackula           391 · 1d  ▸    │  ← amber dot, submenu indicator
│ ───                                  │
│ Global actions (section header)      │
│   ↻ Update all collections      ⌘U   │
│   ⚡ Embed all (new only)        ⌘E   │
│   ⟳ Restart MCP daemon               │
│   ■ Stop MCP daemon                  │  ← OR "▶ Start MCP daemon" exclusively
│   🧹 Cleanup orphaned data…          │
│ ───                                  │
│   ⧉ Copy MCP endpoint URL            │
│   ›_ Show qmd status in Terminal     │
│   📄 Show last output                │  ← shown only if log exists
│ ───                                  │
│   ⚙ Preferences…                ⌘,   │
│   ⓘ About swiftbar-qmd               │
└─────────────────────────────────────┘
```

Implementation notes:

- Section headers render as `<header text> | size=10 color=#8a8a8e shell=` (disabled, smaller, muted).
- The dots `●`/`○` are coloured Unicode characters; the colour comes from `color=#xxxxxx` on the line.
- Per-collection rows trigger their submenu via SwiftBar's nested item syntax (two-space indentation under the parent in older SwiftBar; `submenu=true` blocks in v2 — confirm against installed version).
- Keyboard shortcuts use SwiftBar's `shortcut=` directive.
- The dropdown opens directly beneath the menubar item. Because the menubar item is right-of-content (SwiftBar plugins sit left of system items), submenus fly out to the left automatically — this is native NSMenu behaviour and requires no special handling.

### 10.3 In-flight state rendering

When `state.inFlightJobs` contains entries, the menu mutates:

- **Status section** gains a row: `⟳ Running: <action> for <Nm>` (yellow dot).
- The **Global actions** action whose `ActionId` matches the in-flight job is rewritten:
  - Text: `Running: update… (Nm)`
  - `disabled=true` so it's not re-clickable.
- For per-collection in-flight, the **per-collection submenu** action row is similarly rewritten.

### 10.4 Error-state rendering (read failure)

If the current poll's `state.collections` is empty *and* `state.status.error` is set, the menu degrades to the last-known snapshot with these modifications:

- A header row at top: `⚠ Status read failed — using last poll (Nm ago)` (red colour, disabled).
- A footer row in Global actions: `Show last error | bash="open" param1="-t" param2=$HOME/.cache/swiftbar-qmd/error.log`.
- Icon stays at the tier the snapshot last computed; on third consecutive failure, escalate to red.

---

## 11. Per-collection submenu

Hover any collection row in the Collections section to open a submenu acting on that collection only. SwiftBar submenus are NSMenu submenus — they nest one level and inherit the parent's appearance.

```
─── <collection-name> (section header) ───
  N docs · qmd://<name>/                       (disabled, info row)
  Pattern              **/*.md                 (disabled, info row)
  Last updated         1d ago ⚠                (warning glyph if amber)
─── ──────────────────────────────────────
↻ Update this collection                       (action: update-collection)
⚡ Embed (new chunks only)                     (action: embed-collection)
⚡⚡ Force re-embed all                          (action: force-reembed-collection, confirms)
─── ──────────────────────────────────────
📁 Reveal in Finder                            (bash="open" param1=<path>)
📓 Open in Obsidian                            (bash="open" param1="obsidian://open?vault=<name>"; hidden if !hasObsidian)
⧉ Copy collection name                         (osascript: set the clipboard to "<name>")
ⓘ View context…                                (osascript display dialog showing qmd context output)
```

### 11.1 Deliberately omitted

- **Remove collection** — destructive; stays in CLI. Decided in spec, do not re-add without owner approval.
- **Edit collection settings** — qmd manages this via `qmd collection rename` etc.; not worth wrapping.

### 11.2 Confirmation dialogs

For `force-reembed-collection` and `cleanup`:

```bash
osascript -e 'display dialog "Force re-embed all chunks in <name>? This will take several minutes." \
  with title "swiftbar-qmd" buttons {"Cancel", "Re-embed"} default button "Cancel" with icon caution'
```

The action only proceeds if `button returned` is `"Re-embed"` (or equivalent). If the dialog returns `Cancel` or times out (60s), exit silently.

---

## 12. First-run states

Detection logic per §5.2 (`lib/detect.ts`). Menu shape per state:

### 12.1 `no-qmd` — qmd binary or SDK missing

```
| image=<grey-svg> templateImage=true tooltip="qmd not detected"
---
qmd not detected | size=10 color=#8a8a8e shell=
   Install qmd from github.com/tobi/qmd | bash="open" param1="https://github.com/tobi/qmd#installation" terminal=false
   Re-check now | bash="<plugin-path>" param1="--action" param2="recheck" terminal=false refresh=true
---
   Preferences… | bash="open" param1="-t" param2=$HOME/.config/swiftbar-qmd/config.yml terminal=false
   About swiftbar-qmd | bash="open" param1="https://github.com/ggfevans/swiftbar-qmd" terminal=false
```

### 12.2 `no-collections` — qmd installed but no collections registered

```
| image=<grey-svg> templateImage=true tooltip="No collections configured"
---
No collections configured | size=10 color=#8a8a8e shell=
   qmd is installed but you have no collections. | size=11 color=#6e6e72 shell=
   Open the qmd README… | bash="open" param1="https://github.com/tobi/qmd#collection-management" terminal=false
   Run 'qmd collection add' in a terminal to start. | size=11 color=#6e6e72 shell=
   Re-check now | …
---
   Preferences… | …
   About swiftbar-qmd | …
```

### 12.3 `empty-index` — collections registered, zero docs in any of them

```
| image=<amber-svg> color=#ec9b2c templateImage=true tooltip="Index has no documents"
---
Index has no documents | size=10 color=#412402 shell=
   Collections are registered but nothing's been indexed yet.
---
↻ Run update | bash="<plugin-path>" param1="--action" param2="update-all" terminal=false refresh=true
---
   …(normal menu structure follows)…
```

### 12.4 `ok` — full normal menu (§10.2)

---

## 13. Action execution

### 13.1 Invocation

SwiftBar invokes the plugin script with action arguments when a user clicks a menu item. The plugin's `main()` branches on argv:

```typescript
if (Deno.args[0] === '--action') {
  const actionId = Deno.args[1] as ActionId;
  const args = parseActionArgs(Deno.args.slice(2));
  await runAction(actionId, args);
  Deno.exit(0);
} else {
  await pollAndRender();
}
```

### 13.2 Background spawn pattern

The action runner spawns the qmd CLI command detached, so the plugin process can exit immediately and SwiftBar can close the menu. The shell snippet:

```bash
( <cmd>; echo "EXIT_CODE=$?" >> <log> ) >> <log> 2>&1 &
echo $!  # Print the background process's PID
```

In Deno:

```typescript
const cmd = new Deno.Command('bash', {
  args: ['-c', shellSnippet],
  stdout: 'piped',
  stderr: 'null',
});
const { stdout } = await cmd.output();
const pid = parseInt(new TextDecoder().decode(stdout).trim(), 10);

await writeJobPidFile(actionId, {
  action: actionId,
  collection: args.collection,
  pid,
  startedAt: new Date(),
  command: [/* ... */],
  logPath,
});
```

### 13.3 Locking — preventing double-runs

Before spawning, `runAction` checks for an existing PID file for the same `actionId`:

```typescript
const existing = await readJobPidFile(actionId);
if (existing && isProcessAlive(existing.pid)) {
  // Silently exit — the action is already running
  Deno.exit(0);
}
```

This is per-action locking. Two different actions (`update-all` and `embed-all`) can run concurrently; the same action cannot.

Per-collection actions key on `<actionId>:<collection>` for the lockfile name, so `embed-collection:gVault` and `embed-collection:Rackula` can run in parallel.

### 13.4 Detecting completion

The poll cycle (not the action runner) detects completion. For each PID file:

```typescript
const isAlive = await checkPid(pid);
if (isAlive) {
  // Render "Running: <action> (Nm)" in menu
} else {
  // Process exited. Read log file's tail to find EXIT_CODE marker.
  const exitCode = await readExitCode(logPath);
  if (exitCode === 0) {
    if (config.notifications.on_job_completion) {
      events.push({ kind: 'job-complete', ... });
    }
  } else {
    await appendFailure({ action, collection, exitCode, failedAt: new Date(), logPath });
    if (config.notifications.on_op_failure) {
      events.push({ kind: 'op-failure', ... });
    }
  }
  await deleteJobPidFile(actionId);
}
```

`readExitCode` reads the last 256 bytes of the log file and searches for `/EXIT_CODE=(\d+)$/m`. If no marker is found and the process is dead, we assume abnormal termination (kill -9 etc.) and record exit code `-1`.

### 13.5 Stale PID handling

If the plugin crashed or the user rebooted while an action was running, PID files can be orphaned. Detection: a PID file exists, but the PID is not alive. Treatment: same as the completion path — read log for EXIT_CODE, record as failure if not found, delete PID file.

---

## 14. Notifications

### 14.1 Triggering

Notifications fire from the poll cycle, *not* from the action runner. The flow:

```
poll cycle: read state → compute tier → diff against snapshot → emit notifications
                                          │
                                          └─ for each event:
                                             ├─ check config.notifications.<kind> is true
                                             ├─ check we haven't notified for this exact event in last 5 min (dedupe)
                                             └─ osascript fire
```

Dedupe key for notifications:

- `daemon-crash`: just the kind (one notification per crash transition).
- `op-failure`: `${action}:${collection ?? '*'}:${logPath}` (logPath includes timestamp).
- `path-unreachable`: `${collection}`.
- `job-complete`: `${action}:${collection ?? '*'}:${logPath}`.
- `threshold-breach`: `${metric}:${collection ?? '*'}`.

The dedupe registry lives in the snapshot file under `recentlyNotified: { key: ISO_TIMESTAMP }`. Entries older than 5 minutes are pruned.

### 14.2 osascript invocation

```typescript
async function fireNotification(title: string, subtitle: string, body: string): Promise<void> {
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `display notification "${escape(body)}" with title "${escape(title)}" subtitle "${escape(subtitle)}"`;
  const cmd = new Deno.Command('osascript', { args: ['-e', script] });
  await cmd.output();
}
```

### 14.3 Notification copy

| Event | Title | Subtitle | Body |
|-------|-------|----------|------|
| `daemon-crash` | qmd daemon stopped | After 6h 04m uptime | Click the menubar icon to restart. |
| `op-failure` | qmd update failed | <collection or "all collections"> | Exit code N. Click "Show last output" for details. |
| `path-unreachable` | Collection path missing | <collection> | The path <path> is no longer readable. |
| `job-complete` | qmd embed completed | <collection or "all collections"> | <N>m elapsed. |
| `threshold-breach` (freshness) | Index freshness warning | <collection> | Last updated <relative>. |
| `threshold-breach` (coverage) | Embedding coverage low | <collection> | At <N>% coverage. |

### 14.4 Rate limiting

Maximum 3 notifications per poll cycle. If more events are pending, render the first three normally and append a single fallback: "+ N more — see menu". The remaining events are still added to `recentlyNotified` so they won't re-fire later.

---

## 15. State persistence

All persistent state lives under `~/.cache/swiftbar-qmd/`. Directory layout:

```
~/.cache/swiftbar-qmd/
├── last-poll.json           # Snapshot of most recent poll (~5 KB)
├── recent-failures.json     # Rolling log of recent maintenance op failures (~2 KB)
├── error.log                # Internal plugin errors (rotates at 1 MB)
├── jobs/
│   ├── update-all.pid       # JSON metadata for in-flight actions
│   ├── embed-collection:gVault.pid
│   └── …
├── logs/
│   ├── update-all-20260517T123456.log
│   ├── embed-collection:gVault-20260517T101200.log
│   └── …
└── sentinels/
    └── recheck              # touched by --action recheck; deleted after read
```

### 15.1 `last-poll.json`

```json
{
  "pollTimestamp": "2026-05-17T12:34:56.789Z",
  "daemon": {
    "status": "running",
    "pid": 4218,
    "uptimeSeconds": 21840,
    "endpoint": "http://localhost:8181"
  },
  "collections": [
    {
      "name": "Rackula",
      "path": "/Users/g/notes/rackula",
      "qmdUri": "qmd://Rackula/",
      "pattern": "**/*.md",
      "reachable": true,
      "docCount": 391,
      "coveragePercent": 100,
      "lastModified": "2026-05-16T12:00:00.000Z",
      "hasObsidian": true
    }
  ],
  "recentOpFailures": [
    {
      "action": "update-all",
      "failedAt": "2026-05-17T10:30:00.000Z",
      "exitCode": 1,
      "logPath": "/Users/g/.cache/swiftbar-qmd/logs/update-all-20260517T103000.log"
    }
  ],
  "computedTier": "amber",
  "tierDrivers": ["Rackula last updated 1d ago (>24h)"],
  "recentlyNotified": {
    "daemon-crash": "2026-05-17T08:00:00.000Z"
  },
  "consecutiveReadFailures": 0
}
```

Written atomically: write to `last-poll.json.tmp`, then rename.

### 15.2 `recent-failures.json`

Array of `FailureRecord`, sorted newest-first, capped at 50 entries. Entries older than `rollup.error_window.amber_hours` are pruned on read.

### 15.3 PID file format

```json
{
  "action": "update-all",
  "collection": null,
  "pid": 12345,
  "startedAt": "2026-05-17T12:30:00.000Z",
  "command": ["qmd", "update"],
  "logPath": "/Users/g/.cache/swiftbar-qmd/logs/update-all-20260517T123000.log"
}
```

### 15.4 Log file format

Log files are raw qmd stdout+stderr (no plugin-imposed structure) with a trailing footer added by the shell wrapper:

```
…(qmd output)…
…(qmd output)…
EXIT_CODE=0
```

### 15.5 `error.log`

Plain-text log with one event per line:

```
2026-05-17T12:34:56Z [error]   config:validate: rollup.coverage.amber_percent out of range (got -5, using default 95)
2026-05-17T12:34:57Z [info]    poll: completed in 187ms
2026-05-17T13:00:00Z [error]   sdk:read: timed out after 5000ms
```

Rotated at 1 MB: `mv error.log error.log.1; touch error.log`. Only one backup retained.

---

## 16. Error handling

### 16.1 Error taxonomy

| Category | Cause | Where handled | User-visible effect |
|----------|-------|---------------|--------------------|
| `config:missing` | First run, no config file | `lib/config.ts` | Auto-create from example; no error shown |
| `config:invalid` | Type/range violation | `lib/config.ts` | `⚠ Config error` header; fall back to defaults |
| `config:parse` | Malformed YAML | `lib/config.ts` | `⚠ Config error` header; use defaults; log full error |
| `sdk:import` | npm:@tobilu/qmd unavailable | `lib/detect.ts` | First-run state `no-qmd` |
| `sdk:open` | sqlite open failed | `lib/state.ts` | Set `status.error`; render last-good if available |
| `sdk:read-timeout` | Slow SDK call | `lib/state.ts` | Set partial state with `error` field; render best-effort |
| `daemon:refused` | TCP refused on `/health` | `lib/state.ts` | `daemon.status = 'stopped'` |
| `daemon:timeout` | HTTP timeout | `lib/state.ts` | `daemon.status = 'unresponsive'` |
| `path:missing` | Collection's `pwd` doesn't exist | `lib/state.ts` | `collection.reachable = false` |
| `action:duplicate` | Action lockfile exists | `lib/actions.ts` | Silent exit |
| `action:spawn` | Failed to spawn child | `lib/actions.ts` | Fire failure notification, write to error.log |
| `action:exit-nonzero` | Child exited non-zero | Detected in poll | Fire `op-failure` notification |
| `action:stale-pid` | PID file refers to dead process | Detected in poll | Treat as completion, infer outcome from log |
| `notify:osascript` | osascript invocation failed | `lib/notify.ts` | Log to error.log; don't escalate |
| `persistence:write` | Couldn't write snapshot/PID/log | `lib/persistence.ts` | Log to error.log; skip operation |
| `persistence:read` | Couldn't read existing file | `lib/persistence.ts` | Treat as missing (null/[]) |

### 16.2 Strategies by code path

**Read path (status polls) — defensive.** Every read wrapped in `withTimeout(p, 5000)`. On any failure or timeout:

1. Render the menu from `last-poll.json` (last successful state).
2. Add a header `⚠ Status read failed — using last poll (Nm ago)` (red, disabled).
3. Add a footer `Show last error` opening `error.log` in default editor.
4. If three consecutive polls fail (tracked in `last-poll.json.consecutiveReadFailures`), force icon to red regardless of last-known tier.
5. Append failure with stack trace to `error.log`.

**Action path (clicked actions) — fail-loud.**

1. Failure notification fires immediately per §14.
2. Next poll renders icon red (via `error_window.red_hours` trigger).
3. Action's log file is the source of truth; `Show last output` exposes it in one click.
4. No automatic retry.

**Notification path — silent best-effort.** If osascript fails (rare), log to `error.log` and continue. We never fail the poll because of notification failures.

### 16.3 Top-level error fence

`main()` in `qmd.30s.ts` is wrapped:

```typescript
try {
  await main();
} catch (e) {
  await logError('main', 'unhandled', e);
  // Render an emergency menu so SwiftBar doesn't show a blank icon
  console.log('⚠');
  console.log('---');
  console.log(`Unhandled error: ${e.message}`);
  console.log(`Show error log | bash="open" param1="-t" param2=${ERROR_LOG_PATH}`);
  Deno.exit(0); // exit 0 so SwiftBar doesn't think the script crashed
}
```

### 16.4 Edge cases checklist

The implementer should explicitly handle:

1. **Concurrent polls** — SwiftBar may re-invoke the script if the previous one is slow. Acquire a poll lock (`~/.cache/swiftbar-qmd/poll.lock`) for the duration of a poll; if locked, exit silently.
2. **Clock skew** — `lastModified` from the SDK may be in the future relative to the local clock. Treat negative durations as zero.
3. **System sleep / wake** — `polledAt` gaps of > 60s should not produce spurious "drifting" rollups; check elapsed wall-clock time and skip transition detection if the gap exceeds 2x poll interval.
4. **Locale / time zones** — render all times in the user's local TZ; persist as UTC ISO strings.
5. **SDK version mismatch** — wrap SDK imports in `try { await import(...) }` so a version bump that breaks the API doesn't permanently brick the plugin; log the import error and fall back to first-run `no-qmd` state.
6. **Filesystem permissions** — `~/.cache` may be read-only in sandboxed contexts; log and surface a clear menu error rather than crashing.
7. **Very long collection names** — truncate to 32 chars in menu with `…` suffix; hover tooltip shows full name.
8. **Unicode in collection names or paths** — pass through; macOS handles NFC/NFD via the filesystem.
9. **Daemon endpoint not localhost** — config may point at remote daemon; trust user config but emit warning if not `localhost` or `127.0.0.1` (could be a misconfig).

---

## 17. Performance budgets

| Operation | Budget | Notes |
|-----------|--------|-------|
| Total poll cycle | < 1000ms p99 | Cold-start dominated; warm cache should be ~200ms |
| Config load + validate | < 50ms | YAML parse + zod validate |
| SDK read (listCollections + getStatus) | < 500ms | sqlite reads against ~10MB DB |
| Daemon /health probe | < 100ms (5s timeout) | Sub-10ms expected on a running daemon |
| PID file scan | < 20ms | At most ~10 files |
| Menu render | < 50ms | String concat, no I/O |
| Snapshot write | < 30ms | ~5 KB atomic write |
| Notification fire | < 100ms per event | osascript spawn overhead |

If any single operation exceeds its timeout, treat as a failure and proceed with degraded state (see §16.2).

Memory budget: < 50 MB resident at any point. The SDK's model code is the risk; using only `listCollections`/`getStatus` should keep us under this.

---

## 18. Logging

### 18.1 Plugin logging (`error.log`)

Categories: `config`, `detect`, `sdk`, `daemon`, `state`, `rollup`, `menu`, `actions`, `notify`, `persistence`, `main`.

Levels: `info`, `error`. No `debug` in production; use `console.error` for one-off debugging during development (it appears in SwiftBar's plugin console).

Format: `<ISO timestamp> [<level>] <category>: <message>` plus optional stack trace block.

Rotation: when `error.log` exceeds 1 MB, rename to `error.log.1` (overwriting any existing `.1`) and start fresh. Only one backup retained.

### 18.2 Action logs

One log file per action invocation at `~/.cache/swiftbar-qmd/logs/<action>-<ISO timestamp>.log`. Contents are raw qmd stdout+stderr plus the trailing `EXIT_CODE=N` line.

Retention: `config.logs.retain_per_action` (default 10) most-recent logs per action ID. Older logs are deleted on the poll cycle that detects them.

### 18.3 What never gets logged

- Document contents from qmd's index.
- Config file contents (paths only).
- PIDs of unrelated system processes.

---

## 19. Testing plan

### 19.1 Unit tests

**`tests/rollup_test.ts`** — Exhaustive table-driven tests for `computeTier` and `computeTierWithReason`. Required cases:

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
- Precedence: red beats amber beats green when both conditions present
- `drivers` list contains every triggering condition, not just the first

Target: 30+ test cases. Coverage target: 100% branches in rollup.ts.

**`tests/config_test.ts`** — Schema validation:

- Default config loaded when file missing
- Valid config round-trips (load → save → load = identity)
- Invalid types fall back to defaults with error string
- Range violations fall back with error string
- Malformed YAML returns defaults + `config:parse` error
- Missing keys default cleanly
- Extra unknown keys ignored (forward compatibility)

**`tests/notify_test.ts`** — State diff and notification gating:

- No prev snapshot → no events fired
- Identical prev/current → no events
- Daemon running → stopped: `daemon-crash` event
- Collection reachable → unreachable: `path-unreachable` event
- In-flight → exited nonzero: `op-failure` event
- In-flight → exited zero with `on_job_completion: false`: no event
- In-flight → exited zero with `on_job_completion: true`: event
- Rate limit: more than 3 events → first 3 fire, "+ N more" emitted
- Dedupe: same event key fired again within 5 min → suppressed

**`tests/detect_test.ts`** — First-run detection:

- All conditions met → 'ok'
- qmd binary missing → 'no-qmd'
- SDK import throws → 'no-qmd'
- Index file missing → 'no-collections'
- Empty collection list → 'no-collections'
- Collections present but all empty → 'empty-index'
- Mix: some empty, some with docs → 'ok'

**`tests/time_test.ts`** — Duration formatting:

- 30 seconds → "30s"
- 5 minutes → "5m"
- 90 minutes → "1h 30m"
- 25 hours → "1d 1h"
- 8 days → "1w 1d"
- Relative: "just now", "5 minutes ago", "yesterday", "3 days ago"

### 19.2 Snapshot tests

**`tests/menu_snapshot_test.ts`** — One snapshot per menu state:

1. Healthy state (all green, 4 collections)
2. Drifting state (one collection amber due to freshness)
3. Red state (daemon stopped)
4. In-flight state (update running)
5. First-run: no-qmd
6. First-run: no-collections
7. First-run: empty-index
8. Error state: read timeout, last-poll fallback
9. Config-error state
10. Per-collection submenu (open, with all submenu items)

Each snapshot is a `.snap` file in `tests/fixtures/snapshots/`. Reviewed on every PR. The test simply asserts `renderMenu(state, tier, config) === fixtureString`.

When intentionally changing output, regenerate snapshots with `deno test -- --update-snapshots`.

### 19.3 Manual QA checklist

Run before tagging v1.0.0. Documented in `README.md`:

1. Fresh install (delete `~/.config/swiftbar-qmd/`, delete `~/.cache/swiftbar-qmd/`, drop plugin file in SwiftBar folder, restart SwiftBar). Verify: icon appears within 30s, first-run menu shows correct state.
2. With qmd configured and indexed: verify normal menu appears, all collections listed with correct meta.
3. Click "Update all collections". Verify: PID file appears, menu shows "Running…" within 30s, icon goes yellow, completion within expected time, log file populated.
4. Kill the qmd daemon externally (`qmd mcp stop` from terminal). Verify: notification fires within 30s, icon goes red, "Start MCP daemon" appears in menu.
5. Hover a collection row, verify submenu opens to the left (since icon is right-aligned). Click "Reveal in Finder", verify path opens.
6. Corrupt config file (`echo "garbage" > ~/.config/swiftbar-qmd/config.yml`). Verify: menu still renders, `⚠ Config error` header shown, error.log has parse error.
7. Edit `freshness.amber_hours` to 1 (1 hour). Verify: within 30s, any collection with freshness > 1h goes amber and icon updates.
8. Remove a collection's source directory (`mv` it). Verify: path-unreachable notification fires, icon red, collection row shows error.
9. Click "Open in Obsidian" on an Obsidian-vault collection. Verify: Obsidian opens with the vault.
10. Confirm "Open in Obsidian" is hidden for a non-vault collection.

### 19.4 Coverage targets

- Pure functions (rollup, time, config validation): 100% branches.
- I/O modules (state, persistence, actions, notify): 80%+ lines via mocking.
- Snapshot tests: 10 states minimum (per §19.2).

---

## 20. CI configuration

`.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - uses: denoland/setup-deno@v1
        with:
          deno-version: v2.x

      - name: Format check
        run: deno fmt --check

      - name: Lint
        run: deno lint

      - name: Type check
        run: deno check qmd.30s.ts lib/**/*.ts tests/**/*.ts

      - name: Tests
        run: deno test --allow-read --allow-env --allow-net=localhost --allow-write=/tmp

      - name: Verify shebang exec bit
        run: test -x qmd.30s.ts
```

macOS runner is required because:

- Some path resolution differs from Linux (`~` expansion, `Application Support` paths).
- `osascript` and `open` are macOS-only; tests that touch them need to be skip-guarded on other platforms.

If we ever need Linux for cheaper CI minutes, gate the osascript-touching tests with `Deno.build.os === 'darwin'`.

---

## 21. Distribution

Three install paths, all sharing the same GitHub-hosted `.ts` artifact.

### 21.1 Path A — Manual

`README.md` documents:

```bash
mkdir -p ~/Library/Application\ Support/SwiftBar/Plugins
curl -L https://raw.githubusercontent.com/ggfevans/swiftbar-qmd/v1.0.0/qmd.30s.ts \
  -o ~/Library/Application\ Support/SwiftBar/Plugins/qmd.30s.ts
chmod +x ~/Library/Application\ Support/SwiftBar/Plugins/qmd.30s.ts
# Restart SwiftBar; the icon appears within 30 seconds.
```

### 21.2 Path B — Curl installer

`install.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="ggfevans/swiftbar-qmd"
# Default to the latest tagged release so curl-pipe-bash installs are
# reproducible. Pass any ref (tag, branch, SHA) as the first arg to
# override — e.g. `bash -s main` to track tip-of-tree.
REF="${1:-v1.0.0}"
PLUGIN_DIR="$HOME/Library/Application Support/SwiftBar/Plugins"
CONFIG_DIR="$HOME/.config/swiftbar-qmd"

# Preflight
command -v deno >/dev/null || { echo "ERROR: deno not found. Install from https://deno.com/"; exit 1; }

# SwiftBar can live in /Applications/, ~/Applications/, or any other
# location LaunchServices knows about (Setapp, manual install). Use
# `open -Ra` for the broadest detection — it returns 0 iff
# LaunchServices can resolve the app, regardless of install path.
if ! open -Ra "SwiftBar" >/dev/null 2>&1; then
  echo "ERROR: SwiftBar not installed. Install from https://swiftbar.app/"
  exit 1
fi

mkdir -p "$PLUGIN_DIR" "$CONFIG_DIR"

# Resolve the ref to a SHA once so the two-file download is atomic.
# Without this, the ref ($REF) could move (e.g. a push to `main`)
# between the two curls, producing a mixed install. Tags are normally
# immutable so this is a no-op for the default v1.0.0 install — but
# the cost is one HTTPS call and the guarantee is worth it. Falls
# back to the ref directly if `git ls-remote` isn't available (rare).
SHA="$REF"
if command -v git >/dev/null 2>&1; then
  RESOLVED=$(
    git ls-remote "https://github.com/$REPO" \
      "refs/heads/$REF" "refs/tags/$REF" "refs/tags/$REF^{}" 2>/dev/null |
      awk '{print $1; exit}' || true
  )
  if [ -n "${RESOLVED:-}" ]; then
    SHA="$RESOLVED"
  fi
fi

# Curl flags: timeouts + retries make first-run UX feel grown-up on
# flaky connections. `--retry-all-errors` opts into retrying on
# transient HTTP failures, not just TCP setup.
CURL_OPTS=(
  --fail
  --silent
  --show-error
  --location
  --retry 3
  --retry-all-errors
  --connect-timeout 10
  --max-time 60
)

# Download script and example config — pinned to $SHA for atomicity.
curl "${CURL_OPTS[@]}" "https://raw.githubusercontent.com/$REPO/$SHA/qmd.30s.ts" \
  -o "$PLUGIN_DIR/qmd.30s.ts"
curl "${CURL_OPTS[@]}" "https://raw.githubusercontent.com/$REPO/$SHA/config.example.yml" \
  -o "$CONFIG_DIR/config.example.yml"

chmod +x "$PLUGIN_DIR/qmd.30s.ts"

if [ ! -f "$CONFIG_DIR/config.yml" ]; then
  cp "$CONFIG_DIR/config.example.yml" "$CONFIG_DIR/config.yml"
  echo "Default config written to $CONFIG_DIR/config.yml"
fi

echo "Installed (ref=$REF, sha=${SHA:0:12}). Restart SwiftBar (Cmd-Q in the SwiftBar menu, then relaunch) to load the plugin."
```

Notes on the design choices (per PR #1 review D1–D4):

- **Pinned default ref (`v1.0.0`).** The canonical one-liner lands users on the most recently tagged release rather than the moving `main` branch, so a `curl | bash` today and a `curl | bash` next month install bit-identical code. Users who want tip-of-tree pass `bash -s main` explicitly.
- **`open -Ra SwiftBar` preflight.** Replaces the original `test -d /Applications/SwiftBar.app` so users with SwiftBar in `~/Applications/`, Setapp, or any other LaunchServices-known location aren't rejected.
- **Ref → SHA pre-resolution.** A `git ls-remote` round trip resolves the ref to an immutable SHA before either curl runs, so the two files always come from the same commit. The pinned-tag default makes this a no-op in the common case, but it's essential when callers pass `bash -s main`.
- **Curl timeouts + retries.** `--retry 3 --retry-all-errors --connect-timeout 10 --max-time 60` keeps a flaky network from leaving install in a half-complete state.

One-liner usage:

```bash
curl -fsSL https://raw.githubusercontent.com/ggfevans/swiftbar-qmd/v1.0.0/install.sh | bash
```

### 21.3 Path D — SwiftBar "Install from URL"

`README.md` provides the raw GitHub URL and instructs the user to paste it into SwiftBar → Preferences → Plugins → Install from URL. SwiftBar handles download and placement. The user still has to ensure Deno is on `$PATH`.

### 21.4 Versioning

Semantic versioning. Releases on GitHub Releases with binaries (just the `.ts` file and `install.sh`):

- **v0.1.0** — First working build: icon renders, rollup logic works, basic dropdown. No notifications, no per-collection submenus. CLI actions wired but unstyled.
- **v0.5.0** — Full menu structure including submenus. Action execution and PID tracking. Log file UX. First-run detection.
- **v0.9.0** — Notifications. All snapshot tests passing. README complete.
- **v1.0.0** — All three install paths verified. CI green. Spec fully implemented. Manual QA checklist passes.

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/).

---

## 22. Implementation milestones

A suggested ordering for the developer. Each milestone is a vertical slice — something works end-to-end after each one.

### M1 — Scaffolding (~2 hours)

- `deno.json` with tasks (`test`, `fmt`, `lint`, `check`).
- `qmd.30s.ts` with shebang, SwiftBar metadata, and a stub that prints a hardcoded green icon + "hello" dropdown row.
- `lib/types.ts` with all types from §6.
- `config.example.yml` (the §7.2 default).
- `.github/workflows/ci.yml`.
- README scaffold with install instructions.

**Acceptance:** plugin loads in SwiftBar and shows a green Q icon with a single hardcoded row.

### M2 — Config & detection (~3 hours)

- `lib/config.ts` with loader, validator, defaults.
- `lib/detect.ts` with all four first-run state checks.
- `lib/menu.ts` with first-run menu renderers.
- Wire `main()` to load config, detect state, render first-run menus.
- `tests/config_test.ts`, `tests/detect_test.ts`.

**Acceptance:** with qmd uninstalled, plugin shows correct `no-qmd` menu; after installing qmd, shows `no-collections`; after adding a collection but not indexing, shows `empty-index`.

### M3 — State reading (~4 hours)

- `lib/state.ts` with SDK wrapper, daemon probe, FS scans.
- `lib/time.ts` with duration helpers.
- `lib/persistence.ts` for last-poll.json and PID file IO.
- `lib/log.ts`.

**Acceptance:** in `--debug` mode (or via test), `readCurrentState` returns a complete state object from a real qmd install.

### M4 — Rollup & healthy menu (~3 hours)

- `lib/rollup.ts` with `computeTier` and drivers.
- `tests/rollup_test.ts` exhaustive.
- `lib/menu.ts` extended with healthy-state rendering (top-level only, no submenus yet).
- Wire into `main()`.

**Acceptance:** plugin shows correct tier icon and dropdown for healthy/drifting/red states.

### M5 — Per-collection submenus (~2 hours)

- `lib/menu.ts` extended with submenu rendering.
- "Reveal in Finder", "Copy collection name" wired (no qmd interaction).

**Acceptance:** hovering a collection row opens a submenu; clicking "Reveal in Finder" opens that path.

### M6 — Action execution (~5 hours)

- `lib/actions.ts` with spawner, locking, command mapping.
- Argv branching in `qmd.30s.ts` for `--action`.
- Update, embed, restart-daemon actions wired (both top-level and per-collection).
- Stale PID detection in poll cycle.
- "Show last output" menu item.
- "Force re-embed" and "Cleanup" confirmation dialogs.

**Acceptance:** click "Run update", watch menu show "Running…", log file populates, completes successfully, menu returns to normal.

### M7 — Notifications (~3 hours)

- `lib/notify.ts` with diff and emit.
- Dedupe registry in snapshot.
- Failure notifications for daemon crash, op failure, path unreachable.
- Opt-in: job completion, threshold breach.

**Acceptance:** kill daemon externally → notification within 30s. Run failing action → notification with correct text.

### M8 — Snapshot tests + polish (~3 hours)

- `tests/menu_snapshot_test.ts` for all 10 states.
- Manual QA pass.
- README finalised with screenshots.
- `install.sh` written and tested.

**Acceptance:** all CI passes; manual QA checklist 10/10 green.

### M9 — Release (~1 hour)

- Tag v1.0.0.
- Cut GitHub Release with `.ts` and `install.sh` attached.
- Update README install URLs to point at the tag.

Total estimate: **~26 hours** of focused implementation work. Realistic calendar time depends on the developer's familiarity with Deno, SwiftBar, and qmd's SDK.

---

## 23. Acceptance criteria for v1.0.0

All of the following must be true to tag v1.0.0:

1. Fresh install on a Mac with qmd already configured: icon appears in menubar within 30 seconds of dropping the file into SwiftBar's plugins folder.
2. Icon colour correctly tracks the rollup logic across every threshold defined in §9, verified by snapshot tests.
3. Every menu item described in §10 and §11 either works as specified or is explicitly omitted with an in-code `TODO(deferred)` comment naming the v1.1 issue.
4. Per-collection submenus open on hover and expose all listed actions.
5. Clicking `Run update` (top-level or per-collection) spawns the CLI in the background, the menu reflects "Running…" within one poll cycle, and the icon returns to its computed state when the job finishes.
6. Killing the daemon externally causes a notification within 30 seconds and the icon turns red on the next poll.
7. Editing `config.yml` to change `rollup.freshness.amber_hours` takes effect within 30 seconds without restarting SwiftBar.
8. All three install paths in §21 are documented in README and at least one (curl installer) has been smoke-tested end-to-end.
9. CI is green on macOS-latest: `deno fmt --check`, `deno lint`, `deno check`, `deno test` all pass.
10. The four first-run states render correct menu shapes; verified manually.
11. Performance budgets in §17 are met on a reference machine (Apple Silicon, qmd with ~5k docs across 4 collections).
12. `CHANGELOG.md` describes everything implemented between v0.1.0 and v1.0.0.

---

## 24. Out of scope (deferred)

These were considered and explicitly deferred to later versions:

| Feature | Deferred to | Reason |
|---------|-------------|--------|
| Recent activity feed in dropdown | v1.1 candidate | Adds another data source; tightens v1 scope |
| Multi-index support (multiple `--index`) | v1.1 candidate | Architectural complexity; uncommon setup |
| Spinner overlay on icon during jobs | v1.2 candidate | Visual polish; in-flight state already conveyed by amber + menu |
| Web-form Preferences UI | v1.x | Polish; YAML covers the use case |
| Homebrew tap | v1.x | Tap maintenance overhead; not justified before user demand |
| Rich notifications with action buttons | v2.x | Requires Swift companion; large scope |
| Add collection from menubar (folder picker) | v1.x | Rare action; requires native dialog wrapping |
| Remove collection from menubar | Never | Destructive op stays in CLI by owner decision |
| Linux/Windows port | Never | SwiftBar is macOS-only by design |

---

## 25. Glossary

| Term | Meaning |
|------|---------|
| **SwiftBar** | macOS menubar app that runs scripts on intervals and renders their stdout as menus. https://swiftbar.app/ |
| **qmd** | Local on-device search engine for markdown by Tobias Lütke. https://github.com/tobi/qmd |
| **Rollup** | The aggregate tier (green/amber/red/grey) computed from multiple signals. |
| **Tier** | A single rollup result. |
| **Collection** | A qmd-registered directory of markdown documents indexed together. |
| **Coverage** | Per-collection: percentage of chunks that have vector embeddings. |
| **Freshness** | How recently a collection was last re-indexed (`qmd update`). |
| **In-flight** | A backgrounded action whose PID is still alive. |
| **Snapshot** | The persisted poll result used for transition detection. |
| **Driver** | A human-readable string describing one condition that contributed to a tier rollup. |

---

## Appendix A — SwiftBar output format reference

SwiftBar plugins emit a specific stdout format. The full reference is at https://github.com/swiftbar/SwiftBar but the directives used in this plugin are:

### Menubar item line (first non-empty line)

```
| image=<base64> templateImage=true color=<hex> tooltip=<string>
```

- `image=` — base64-encoded SVG/PNG for the icon
- `templateImage=true` — let macOS handle light/dark tinting
- `color=` — overrides the template colour
- `tooltip=` — hover tooltip text

### Menu separator

```
---
```

A line containing exactly three hyphens.

### Section header (disabled, styled row)

```
Status | size=10 color=#8a8a8e shell=
```

- Renders as smaller, muted text
- `shell=` (empty) makes it non-clickable

### Action row

```
Update all collections | bash="<plugin-path>" param1="--action" param2="update-all" terminal=false refresh=true shortcut=CmdOrCtrl+U
```

- `bash=` — executable to invoke (use the plugin's own path for re-invocation with `--action`)
- `param1=`, `param2=`, … — arguments
- `terminal=false` — don't open a Terminal window
- `refresh=true` — re-render the menu immediately after the click
- `shortcut=` — keyboard shortcut

### Submenu row

```
gVault | color=#2fa84f
  Update this collection | bash="<plugin-path>" param1="--action" param2="update-collection" param3="--collection" param4="gVault" terminal=false refresh=true
  Embed (new chunks only) | …
```

Two-space indentation under the parent indicates submenu items. Some SwiftBar versions use a different syntax — verify against the installed version and adjust.

### Disabled row (info only)

```
Daemon running | size=12 color=#1d1d1f shell=
```

`shell=` (empty) makes it non-clickable.

### Conditional rows

Some menu items only appear under certain conditions:

- **Show last output** — only when `~/.cache/swiftbar-qmd/logs/` has at least one file
- **Open in Obsidian** — only when `<collection-path>/.obsidian/` exists
- **Start MCP daemon** vs **Stop MCP daemon** — mutually exclusive based on `daemon.status`

Conditional rendering is handled in `lib/menu.ts`; the menu output omits the line entirely rather than rendering a disabled placeholder.

---

## Appendix B — qmd SDK surface used

From [`npm:@tobilu/qmd`](https://www.npmjs.com/package/@tobilu/qmd):

### Imports

```typescript
import { createStore, type QMDStore, type IndexStatus } from 'npm:@tobilu/qmd';
```

### Methods called

```typescript
// Open the index DB read-only.
const store: QMDStore = await createStore({ dbPath: config.qmd.index_path });

// List all configured collections with per-collection metadata.
const collections = await store.listCollections();
// Returns: Array<{ name, pwd, glob_pattern, doc_count, active_count, last_modified, includeByDefault }>

// Index health summary.
const status: IndexStatus = await store.getStatus();
// Returns: { totalDocs, totalCollections, dbSizeBytes, modelCacheBytes, ... }

// Always close the store before exiting.
await store.close();
```

### Methods intentionally NOT used

- `search()`, `searchLex()`, `searchVector()`, `query()` — would load reranker/embedding models, blowing the memory budget.
- `update()`, `embed()` — we delegate to the CLI to leverage qmd's own progress reporting and avoid model loading in our process.
- `addCollection()`, `removeCollection()`, `renameCollection()`, `addContext()`, etc. — qmd lifecycle operations belong in the CLI.

If any of the read methods change shape in a future qmd version, the SDK wrapper in `lib/state.ts` is the only place that needs adapting.

---

## Appendix C — Decision log summary

Decisions taken during scoping conversation; full rationale in [`DECISIONS.md`](DECISIONS.md).

| # | Decision | Choice |
|---|----------|--------|
| 1 | Core purpose | Operational visibility |
| 2 | Icon style | Aggregate health rollup (4 states) |
| 3 | Dropdown structure | Signal-organised top + per-collection submenus |
| 4 | Action set | Recommended set minus "Remove collection" |
| 5 | Threshold defaults | 24h freshness amber, 7d red ▪ 95% coverage amber, 50% red ▪ 1h error window |
| 6 | Refresh cadence | 30 seconds |
| 7 | Notification triggers | Failures only by default |
| 8 | Activity feed | Deferred to v1.1 |
| 9 | Multi-index | Single shared index only at v1 |
| 10 | Runtime | Deno (with Bun rewrite risk explicitly weighed) |
| 11 | Configuration | YAML + open-in-editor |
| 12 | Transport | SDK for reads, CLI for actions |
| 13 | Action UX | Background + PID-tracked + log file + "Show last output" |
| 14 | First-run | Layered detection with contextual menu |
| 15 | Distribution | Manual + curl installer + SwiftBar URL install |
| 16 | License | MIT |

---

*End of specification. For history of how these decisions were reached, see [`DECISIONS.md`](DECISIONS.md). For background research, see [`RESEARCH.md`](RESEARCH.md). For navigation of all planning docs, see [`README.md`](README.md).*

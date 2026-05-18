// ─── Configuration ─────────────────────────────────────────────

export interface Config {
  qmd: {
    index_path: string;
    daemon_url: string;
  };
  rollup: {
    freshness: { amber_hours: number; red_days: number };
    coverage: { amber_percent: number; red_percent: number };
    error_window: { red_hours: number; amber_hours: number };
  };
  notifications: {
    on_daemon_crash: boolean;
    on_op_failure: boolean;
    on_path_unreachable: boolean;
    on_job_completion: boolean; // opt-in
    on_threshold_breach: boolean; // opt-in
  };
  ui: {
    collection_meta: "freshness" | "coverage" | "both";
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
  /**
   * Log files in `${CACHE_DIR}/logs/`, newest first by mtime. Used by
   * the menu renderer for the "📄 Show last output" row (SPEC §10.2)
   * and reserved for the v1.1 "Recent jobs ▸" submenu — storing the
   * full list now avoids a schema migration when that lands.
   */
  recentLogs: LogFileInfo[];
  polledAt: Date;
}

export interface CollectionState {
  name: string;
  path: string; // host filesystem path
  qmdUri: string; // qmd://<name>/
  pattern: string; // e.g. "**/*.md"
  reachable: boolean; // path exists and is readable
  docCount: number;
  coveragePercent: number; // 0–100; 100 if zero docs (no division by zero)
  lastModified: Date | null;
  hasObsidian: boolean; // .obsidian/ folder present at root
  error?: string; // if SDK couldn't read this collection
}

export interface IndexStatus {
  totalDocs: number;
  totalCollections: number;
  dbSizeBytes: number;
  modelCacheBytes: number;
  error?: string;
}

export interface DaemonState {
  status: "running" | "stopped" | "unresponsive";
  pid?: number;
  uptimeSeconds?: number;
  endpoint: string;
  error?: string;
}

export type FirstRunState = "ok" | "no-qmd" | "no-collections" | "empty-index";

// ─── Rollup ────────────────────────────────────────────────────

export type Tier = "green" | "amber" | "red" | "grey";

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
  | "update-all"
  | "embed-all"
  | "update-collection"
  | "embed-collection"
  | "force-reembed-collection"
  | "restart-daemon"
  | "stop-daemon"
  | "start-daemon"
  | "cleanup"
  | "recheck"
  | "show-context";

// ─── Snapshot (persisted) ─────────────────────────────────────

export interface PollSnapshot {
  pollTimestamp: string; // ISO 8601
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
  | { kind: "daemon-crash"; previousUptime: number }
  | {
    kind: "op-failure";
    action: ActionId;
    collection?: string;
    exitCode: number;
    logPath: string;
  }
  | { kind: "path-unreachable"; collection: string; path: string }
  | {
    kind: "job-complete";
    action: ActionId;
    collection?: string;
    durationMs: number;
  }
  | {
    kind: "threshold-breach";
    metric: "freshness" | "coverage";
    collection?: string;
  };

// ─── Logs ──────────────────────────────────────────────────────

export interface LogFileInfo {
  action: ActionId;
  path: string;
  createdAt: Date;
  sizeBytes: number;
}

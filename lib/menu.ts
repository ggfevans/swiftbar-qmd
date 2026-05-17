import type {
  CollectionState,
  Config,
  CurrentState,
  FirstRunState,
  Tier,
  TierReason,
} from "./types.ts";
import { compactDuration, relativeTime } from "./time.ts";
import { computeTier } from "./rollup.ts";

// ─── Icon glyphs (SPEC §9.3) ──────────────────────────────────
//
// Pre-computed base64 of the monochrome 14×14 SVG templates. Embedding
// the encoded bytes as constants avoids re-encoding on every poll.
//
// Source SVGs:
//
//   Filled:
//   <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14">
//     <circle cx="6.2" cy="6.2" r="4.2" fill="currentColor"/>
//     <circle cx="6.2" cy="6.2" r="1.6" fill="white"/>
//     <line x1="8.6" y1="8.6" x2="11.2" y2="11.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
//   </svg>
//
//   Hollow:
//   <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14">
//     <circle cx="6.2" cy="6.2" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/>
//     <line x1="8.6" y1="8.6" x2="11.2" y2="11.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
//   </svg>

const FILLED_GLYPH_B64 =
  "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNCAxNCIgd2lkdGg9IjE0IiBoZWlnaHQ9IjE0Ij48Y2lyY2xlIGN4PSI2LjIiIGN5PSI2LjIiIHI9IjQuMiIgZmlsbD0iY3VycmVudENvbG9yIi8+PGNpcmNsZSBjeD0iNi4yIiBjeT0iNi4yIiByPSIxLjYiIGZpbGw9IndoaXRlIi8+PGxpbmUgeDE9IjguNiIgeTE9IjguNiIgeDI9IjExLjIiIHkyPSIxMS4yIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg==";

const HOLLOW_GLYPH_B64 =
  "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNCAxNCIgd2lkdGg9IjE0IiBoZWlnaHQ9IjE0Ij48Y2lyY2xlIGN4PSI2LjIiIGN5PSI2LjIiIHI9IjQuMiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMS40Ii8+PGxpbmUgeDE9IjguNiIgeTE9IjguNiIgeDI9IjExLjIiIHkyPSIxMS4yIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg==";

// ─── Plugin path helper ────────────────────────────────────────

/**
 * Absolute filesystem path of the running script. Used inside menu
 * directives like `bash="<plugin-path>" param1="--action" param2="…"`
 * so SwiftBar can re-invoke the plugin with action arguments.
 *
 * Deno.mainModule is a `file://` URL; converting via the URL API gives
 * us a properly decoded POSIX path.
 */
export function getPluginPath(): string {
  return new URL(Deno.mainModule).pathname;
}

// ─── First-run menu rendering (SPEC §12) ──────────────────────

/**
 * Render one of the three first-run menus. The 'ok' state has its own
 * full healthy menu (SPEC §10) and is not handled here.
 *
 * The output is a single string with lines joined by '\n', terminated
 * by a trailing newline so console.log doesn't double-space.
 */
export function renderFirstRunMenu(
  firstRun: Exclude<FirstRunState, "ok">,
  config: Config,
): string {
  const pluginPath = getPluginPath();
  switch (firstRun) {
    case "no-qmd":
      return renderNoQmd(pluginPath);
    case "no-collections":
      return renderNoCollections(pluginPath);
    case "empty-index":
      return renderEmptyIndex(pluginPath, config);
  }
}

// ─── Per-state renderers (internal) ───────────────────────────

function renderNoQmd(pluginPath: string): string {
  const lines = [
    `| image=${HOLLOW_GLYPH_B64} templateImage=true tooltip="qmd not detected"`,
    "---",
    "qmd not detected | size=10 color=#8a8a8e shell=",
    `   Install qmd from github.com/tobi/qmd | bash="open" param1="https://github.com/tobi/qmd#installation" terminal=false`,
    `   Re-check now | bash="${pluginPath}" param1="--action" param2="recheck" terminal=false refresh=true`,
    "---",
    `   Preferences… | bash="open" param1="-t" param2=$HOME/.config/swiftbar-qmd/config.yml terminal=false`,
    `   About swiftbar-qmd | bash="open" param1="https://github.com/ggfevans/swiftbar-qmd" terminal=false`,
  ];
  return lines.join("\n") + "\n";
}

function renderNoCollections(pluginPath: string): string {
  const lines = [
    `| image=${HOLLOW_GLYPH_B64} templateImage=true tooltip="No collections configured"`,
    "---",
    "No collections configured | size=10 color=#8a8a8e shell=",
    "   qmd is installed but you have no collections. | size=11 color=#6e6e72 shell=",
    `   Open the qmd README… | bash="open" param1="https://github.com/tobi/qmd#collection-management" terminal=false`,
    "   Run 'qmd collection add' in a terminal to start. | size=11 color=#6e6e72 shell=",
    `   Re-check now | bash="${pluginPath}" param1="--action" param2="recheck" terminal=false refresh=true`,
    "---",
    `   Preferences… | bash="open" param1="-t" param2=$HOME/.config/swiftbar-qmd/config.yml terminal=false`,
    `   About swiftbar-qmd | bash="open" param1="https://github.com/ggfevans/swiftbar-qmd" terminal=false`,
  ];
  return lines.join("\n") + "\n";
}

function renderEmptyIndex(pluginPath: string, _config: Config): string {
  // The §12.3 mockup ends with "…(normal menu structure follows)…" — the
  // §10 healthy menu. For step 4 we render just the Preferences / About
  // footer; the full §10 structure lands in step 9 once the renderers
  // for collections, daemon, jobs, etc. are in place.
  // (deferred to step 9: expand the empty-index trailer into the §10
  // healthy menu structure)
  const lines = [
    `| image=${FILLED_GLYPH_B64} color=#ec9b2c templateImage=true tooltip="Index has no documents"`,
    "---",
    "Index has no documents | size=10 color=#412402 shell=",
    "   Collections are registered but nothing's been indexed yet.",
    "---",
    `↻ Run update | bash="${pluginPath}" param1="--action" param2="update-all" terminal=false refresh=true`,
    "---",
    `   Preferences… | bash="open" param1="-t" param2=$HOME/.config/swiftbar-qmd/config.yml terminal=false`,
    `   About swiftbar-qmd | bash="open" param1="https://github.com/ggfevans/swiftbar-qmd" terminal=false`,
  ];
  return lines.join("\n") + "\n";
}

// ─── Healthy menu rendering (SPEC §10) ────────────────────────

// Tier → dot/text colours (SPEC §10.2). The greys are used both for
// the hollow-Q glyph (no `color=` override) and for muted section
// headers / info rows; the explicit hex constant exists so callers
// don't reinvent it.
const TIER_HEX: Record<Tier, string> = {
  green: "#2fa84f",
  amber: "#ec9b2c",
  red: "#d8453f",
  grey: "#8a8a8e",
};

const MUTED_HEX = "#8a8a8e";

// Daemon row uses SwiftBar `length=44` + `trim=false` to right-align
// the uptime against the left-aligned status text. Manual padding
// inside the same string is what produces the visible alignment when
// SwiftBar honours `trim=false`.
const DAEMON_ROW_LENGTH = 44;

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

/**
 * Per-collection tier rollup. Reuses `computeTier` on a state slice
 * that contains only this collection; everything else is set to a
 * "healthy" baseline so the slice's tier reflects this collection's
 * own coverage / freshness / reachability — not the daemon, in-flight
 * jobs, or failures (those are accounted for at the global tier).
 *
 * The slice's `polledAt` mirrors the parent state's so freshness
 * thresholds line up with the rest of the rendering.
 */
function collectionTier(
  c: CollectionState,
  config: Config,
  polledAt: Date,
): Tier {
  const slice: CurrentState = {
    collections: [c],
    status: {
      totalDocs: c.docCount,
      totalCollections: 1,
      dbSizeBytes: 0,
      modelCacheBytes: 0,
    },
    daemon: {
      status: "running",
      endpoint: "",
      uptimeSeconds: 0,
    },
    inFlightJobs: [],
    recentFailures: [],
    polledAt,
  };
  return computeTier(slice, config);
}

/**
 * Pad `left` and `right` so the combined string is exactly `width`
 * characters wide, with at least one space between them. If the two
 * sides already exceed `width`, fall back to a single space separator
 * (truncation is left to SwiftBar via `trim=false` / `length=`).
 */
function padBetween(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - left.length - right.length);
  return `${left}${" ".repeat(gap)}${right}`;
}

/** Renders the menubar item line (first line of output). */
function renderIconLine(tier: Tier, drivers: string[]): string {
  const tooltip = drivers.length > 0 ? drivers[0] : "All clear";
  const safeTooltip = tooltip.replace(/"/g, "'");
  if (tier === "grey") {
    return `| image=${HOLLOW_GLYPH_B64} templateImage=true tooltip="${safeTooltip}"`;
  }
  const color = TIER_HEX[tier];
  return `| image=${FILLED_GLYPH_B64} templateImage=true color=${color} tooltip="${safeTooltip}"`;
}

/** Renders the Status section (header + daemon + drift summary + last update). */
function renderStatusSection(state: CurrentState, config: Config): string[] {
  const lines: string[] = [];
  lines.push(`Status | size=10 color=${MUTED_HEX} shell=`);

  // Daemon row.
  const d = state.daemon;
  if (d.status === "running") {
    const left = "● Daemon running";
    const right = compactDuration((d.uptimeSeconds ?? 0) * 1000);
    const padded = padBetween(left, right, DAEMON_ROW_LENGTH);
    lines.push(
      `${padded} | color=${TIER_HEX.green} size=12 shell= length=${DAEMON_ROW_LENGTH} trim=false`,
    );
  } else if (d.status === "stopped") {
    lines.push(
      `● Daemon stopped | color=${TIER_HEX.red} size=12 shell=`,
    );
  } else {
    lines.push(
      `● Daemon unresponsive | color=${TIER_HEX.red} size=12 shell=`,
    );
  }

  // Drift summary (count collections whose tier is amber-or-worse).
  const driftingCount =
    state.collections.filter((c) =>
      collectionTier(c, config, state.polledAt) !== "green"
    ).length;
  const summary = driftingCount === 0
    ? "All collections healthy"
    : driftingCount === 1
    ? "1 collection drifting"
    : `${driftingCount} collections drifting`;
  const driftColor = driftingCount === 0 ? TIER_HEX.green : TIER_HEX.amber;
  const driftDot = driftingCount === 0 ? "●" : "○";
  lines.push(`${driftDot} ${summary} | color=${driftColor} shell=`);

  // "Last update" row uses the most recent lastModified across collections.
  let newest: Date | null = null;
  for (const c of state.collections) {
    if (c.lastModified && (!newest || c.lastModified > newest)) {
      newest = c.lastModified;
    }
  }
  const relative = newest ? relativeTime(newest, state.polledAt) : "—";
  lines.push(
    `${
      padBetween("    Last update", relative, DAEMON_ROW_LENGTH)
    } | color=${MUTED_HEX} shell= length=${DAEMON_ROW_LENGTH} trim=false`,
  );

  return lines;
}

/** Renders the Collections section as flat rows (one per collection). */
function renderCollectionsSection(
  state: CurrentState,
  config: Config,
): string[] {
  const lines: string[] = [];
  lines.push(
    `Collections (${state.collections.length}) | size=10 color=${MUTED_HEX} shell=`,
  );

  // (deferred to step 10: per-collection submenus + ▸ indicator)
  for (const c of state.collections) {
    const tier = collectionTier(c, config, state.polledAt);
    const color = TIER_HEX[tier];
    const docCount = NUMBER_FORMAT.format(c.docCount);
    const freshness = c.lastModified
      ? compactDuration(state.polledAt.getTime() - c.lastModified.getTime())
      : "?";
    const left = `● ${c.name}`;
    const right = `${docCount} · ${freshness}`;
    const padded = padBetween(left, right, DAEMON_ROW_LENGTH);
    lines.push(
      `${padded} | color=${color} shell= length=${DAEMON_ROW_LENGTH} trim=false`,
    );
  }

  return lines;
}

/** Renders the Global actions section, including the daemon-state-conditional row. */
function renderGlobalActionsSection(
  state: CurrentState,
  pluginPath: string,
): string[] {
  const lines: string[] = [];
  lines.push(`Global actions | size=10 color=${MUTED_HEX} shell=`);

  const action = (
    label: string,
    actionId: string,
    extras: string[] = [],
  ): string => {
    const parts = [
      `bash="${pluginPath}"`,
      `param1="--action"`,
      `param2="${actionId}"`,
      "terminal=false",
      "refresh=true",
      ...extras,
    ];
    return `${label} | ${parts.join(" ")}`;
  };

  lines.push(action(
    "↻ Update all collections",
    "update-all",
    ["shortcut=CmdOrCtrl+U"],
  ));
  lines.push(action(
    "⚡ Embed all (new only)",
    "embed-all",
    ["shortcut=CmdOrCtrl+E"],
  ));
  lines.push(action("⟳ Restart MCP daemon", "restart-daemon"));

  // Stop / Start row is exclusive (SPEC §10.2).
  if (state.daemon.status === "running") {
    lines.push(action("■ Stop MCP daemon", "stop-daemon"));
  } else {
    lines.push(action("▶ Start MCP daemon", "start-daemon"));
  }

  lines.push(action("🧹 Cleanup orphaned data…", "cleanup"));

  return lines;
}

/** Renders the Copy URL / Show status footer block. */
function renderUtilityFooter(endpoint: string): string[] {
  // `bash -c "echo -n '<endpoint>' | pbcopy"` keeps the endpoint as a
  // single shell argument so SwiftBar's param-splitting doesn't mangle
  // it. Single-quotes around the endpoint guard against rare URL
  // characters; if the endpoint itself ever contained a single quote
  // we'd need to escape it, but daemon URLs in this plugin never do.
  const safeEndpoint = endpoint.replace(/'/g, "'\\''");
  return [
    `⧉ Copy MCP endpoint URL | bash="bash" param1="-c" param2="echo -n '${safeEndpoint}' | pbcopy" terminal=false`,
    `›_ Show qmd status in Terminal | bash="qmd" param1="status" terminal=true`,
  ];
}

/** Renders the Preferences / About footer block (matches first-run menus). */
function renderPreferencesFooter(): string[] {
  return [
    `⚙ Preferences… | bash="open" param1="-t" param2=$HOME/.config/swiftbar-qmd/config.yml terminal=false shortcut=CmdOrCtrl+Comma`,
    `ⓘ About swiftbar-qmd | bash="open" param1="https://github.com/ggfevans/swiftbar-qmd" terminal=false`,
  ];
}

/**
 * Render the full healthy menu (SPEC §10.2). The result is a single
 * string of newline-joined SwiftBar lines with a trailing newline. The
 * caller is expected to `console.log` it as-is.
 *
 * In-flight job rendering (SPEC §10.3) and error-state fallback
 * (SPEC §10.4) are layered on top of this base in later prompts:
 *   - (deferred to step 10: per-collection submenus + ▸ indicators)
 *   - (deferred to step 12: in-flight job rewriting in Status / Actions)
 *   - (deferred to step 15: error-state fallback header / footer)
 */
export function renderMenu(
  state: CurrentState,
  tier: TierReason,
  config: Config,
): string {
  const pluginPath = getPluginPath();
  const lines: string[] = [];

  lines.push(renderIconLine(tier.tier, tier.drivers));
  lines.push("---");

  lines.push(...renderStatusSection(state, config));
  lines.push("---");

  lines.push(...renderCollectionsSection(state, config));
  lines.push("---");

  lines.push(...renderGlobalActionsSection(state, pluginPath));
  lines.push("---");

  lines.push(...renderUtilityFooter(state.daemon.endpoint));
  lines.push("---");

  lines.push(...renderPreferencesFooter());

  return lines.join("\n") + "\n";
}

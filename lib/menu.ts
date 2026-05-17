import type { Config, FirstRunState } from "./types.ts";

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

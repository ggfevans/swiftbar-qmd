#!/usr/bin/env -S deno run --allow-net=localhost:8181 --allow-read=$HOME/.cache/qmd,$HOME/.config/swiftbar-qmd,$HOME/.cache/swiftbar-qmd --allow-write=$HOME/.cache/swiftbar-qmd,$HOME/.config/swiftbar-qmd --allow-run=qmd,open,osascript,kill --allow-env=HOME,PATH,EDITOR

// <swiftbar.title>swiftbar-qmd</swiftbar.title>
// <swiftbar.version>v0.1.0</swiftbar.version>
// <swiftbar.author>Gareth Evans</swiftbar.author>
// <swiftbar.author.github>ggfevans</swiftbar.author.github>
// <swiftbar.desc>Surface qmd operational state (collections, daemon, jobs) in the macOS menubar.</swiftbar.desc>
// <swiftbar.dependencies>deno,qmd</swiftbar.dependencies>
// <swiftbar.abouturl>https://github.com/ggfevans/swiftbar-qmd</swiftbar.abouturl>

import { loadConfig } from "./lib/config.ts";
import { detectFirstRunState } from "./lib/detect.ts";
import { renderFirstRunMenu } from "./lib/menu.ts";
import { ensureCacheTree, readSnapshot } from "./lib/persistence.ts";
import { readCurrentState } from "./lib/state.ts";
import { computeTierWithReason } from "./lib/rollup.ts";
import type { Tier } from "./lib/types.ts";

const TIER_EMOJI: Record<Tier, string> = {
  green: "🟢",
  amber: "🟡",
  red: "🔴",
  grey: "⚪",
};

async function main(): Promise<void> {
  const { config } = await loadConfig();
  const firstRun = await detectFirstRunState(config);
  if (firstRun !== "ok") {
    console.log(renderFirstRunMenu(firstRun, config));
    Deno.exit(0);
  }
  // Persistence layer (step 6). Ensures cache dir tree exists and
  // loads the last snapshot for the upcoming rollup step.
  await ensureCacheTree();
  const _lastSnapshot = await readSnapshot();
  void _lastSnapshot;

  // State reader (step 7). Composes SDK, HTTP, and FS sources into a
  // single CurrentState.
  const state = await readCurrentState(config);

  // Rollup (step 8). Compute the tier from current state; the icon
  // line below now reflects real qmd health.
  const tier = computeTierWithReason(state, config);

  // (deferred to step 9: replace the rest of this hardcoded placeholder
  // with the full §10 healthy menu once render helpers exist)
  console.log(TIER_EMOJI[tier.tier]);
  console.log("---");
  console.log("swiftbar-qmd v0.1.0 | size=12 color=#8a8a8e shell=");
  console.log(
    'Show planning docs | bash="open" param1="https://github.com/ggfevans/swiftbar-qmd" terminal=false',
  );
  Deno.exit(0);
}

await main();

#!/usr/bin/env -S deno run --allow-net=localhost:8181 --allow-read=$HOME/.cache/qmd,$HOME/.config/swiftbar-qmd,$HOME/.cache/swiftbar-qmd --allow-write=$HOME/.cache/swiftbar-qmd,$HOME/.config/swiftbar-qmd --allow-run=qmd,open,osascript,kill,bash --allow-env=HOME,PATH,EDITOR

// <swiftbar.title>swiftbar-qmd</swiftbar.title>
// <swiftbar.version>v0.1.0</swiftbar.version>
// <swiftbar.author>Gareth Evans</swiftbar.author>
// <swiftbar.author.github>ggfevans</swiftbar.author.github>
// <swiftbar.desc>Surface qmd operational state (collections, daemon, jobs) in the macOS menubar.</swiftbar.desc>
// <swiftbar.dependencies>deno,qmd</swiftbar.dependencies>
// <swiftbar.abouturl>https://github.com/ggfevans/swiftbar-qmd</swiftbar.abouturl>

import { runAction } from "./lib/actions.ts";
import { loadConfig } from "./lib/config.ts";
import { detectFirstRunState } from "./lib/detect.ts";
import { renderFirstRunMenu, renderMenu } from "./lib/menu.ts";
import { ensureCacheTree, readSnapshot } from "./lib/persistence.ts";
import { readCurrentState } from "./lib/state.ts";
import { computeTierWithReason } from "./lib/rollup.ts";
import type { ActionId } from "./lib/types.ts";

async function main(): Promise<void> {
  // Action invocation path (SPEC §13.1). When SwiftBar re-invokes the
  // plugin with `--action <id> [--flag value ...]`, route to the
  // action runner and exit; the poll/render path below is skipped.
  if (Deno.args[0] === "--action") {
    const actionId = Deno.args[1] as ActionId;
    const argsMap: Record<string, string> = {};
    for (let i = 2; i < Deno.args.length; i += 2) {
      const flag = Deno.args[i];
      if (flag?.startsWith("--")) {
        argsMap[flag.slice(2)] = Deno.args[i + 1] ?? "";
      }
    }
    await runAction(actionId, argsMap);
    Deno.exit(0);
  }

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

  // Rollup (step 8). Compute the tier from current state.
  const tier = computeTierWithReason(state, config);

  // Render the §10 healthy menu (step 9). In-flight rewriting,
  // per-collection submenus, and error-state fallback layer on top
  // of this in steps 10 / 12 / 15.
  console.log(renderMenu(state, tier, config));
  Deno.exit(0);
}

await main();

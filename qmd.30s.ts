#!/usr/bin/env -S deno run --allow-net=localhost:8181 --allow-read=$HOME/.cache/qmd,$HOME/.config/swiftbar-qmd,$HOME/.cache/swiftbar-qmd --allow-write=$HOME/.cache/swiftbar-qmd,$HOME/.config/swiftbar-qmd --allow-run=qmd,open,osascript,kill --allow-env=HOME,PATH,EDITOR

// <swiftbar.title>swiftbar-qmd</swiftbar.title>
// <swiftbar.version>v0.1.0</swiftbar.version>
// <swiftbar.author>Gareth Evans</swiftbar.author>
// <swiftbar.author.github>ggfevans</swiftbar.author.github>
// <swiftbar.desc>Surface qmd operational state (collections, daemon, jobs) in the macOS menubar.</swiftbar.desc>
// <swiftbar.dependencies>deno,qmd</swiftbar.dependencies>
// <swiftbar.abouturl>https://github.com/ggfevans/swiftbar-qmd</swiftbar.abouturl>

import { loadConfig } from "./lib/config.ts";

async function main(): Promise<void> {
  const _loaded = await loadConfig();
  console.log("🟢");
  console.log("---");
  console.log("swiftbar-qmd v0.1.0 | size=12 color=#8a8a8e shell=");
  console.log(
    'Show planning docs | bash="open" param1="https://github.com/ggfevans/swiftbar-qmd" terminal=false',
  );
  Deno.exit(0);
}

await main();

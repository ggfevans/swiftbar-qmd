# qmd-swiftbar — Decision log

This document records the 16 architectural decisions taken during the v1 scoping conversation, with the alternatives considered and the rationale for each choice. Use it when you need to understand *why* something is the way it is in [`SPEC.md`](SPEC.md), or when reconsidering a decision because requirements have shifted.

Decisions are numbered in the order they were taken. Each entry follows the same shape: **Decision** → **Chosen** → **Alternatives considered** → **Why this one** → **Implications**.

---

## D1 — Core purpose

**Chosen:** Operational visibility — *what is qmd doing right now, and what state are my collections in?*

**Alternatives considered:**

- *Stale-index anxiety* — passive glanceable confidence that everything's up to date; icon does the whole job, clicks are rare.
- *Avoid terminal switches* — action launcher; status is secondary, one-click maintenance is the point.
- *Full control panel* — all of the above; closer to Docker Desktop's menubar than a SwiftBar plugin.

**Why this one:** Operational visibility is broader than passive status (we need real-time visibility into running jobs, daemon state, recent failures) but narrower than a full Docker-style control panel (we don't need a dashboard window, settings UI, or installer). It maps cleanly onto a SwiftBar dropdown menu with a section-organised layout.

**Implications:** Drives the design of both the icon (must communicate health) AND the dropdown (must answer "what's running, what just failed"). Justifies notifications for failures. Rules out a passive-only design where the menu has no useful click target.

---

## D2 — Icon style

**Chosen:** Aggregate health rollup (green / amber / red / hollow grey).

**Alternatives considered:**

- *Daemon up/down only* — binary glyph: filled when daemon runs, struck-through when it doesn't.
- *Activity-focused* — plain glyph when idle, animated spinner overlay when a job is running.
- *Compact data badge* — glyph plus short text readout in the menubar (e.g. "Q 87%").
- *Rollup + spinner overlay* — same as chosen but adds a spinner ring during in-flight jobs to distinguish busy-amber from drifting-amber.

**Why this one:** The rollup is the only option that directly answers the ADHD-relevant question "*do I need to click?*" without forcing the user to open the menu first. It absorbs activity signals naturally (in-flight = amber) without requiring a separate visual channel. Daemon-only is too coarse; data badges consume too much menubar real estate; the spinner overlay is a nice future addition but adds complexity for v1.

**Implications:** Forces a clear precedence among signals (codified in [`SPEC.md`](SPEC.md) §9). Requires snapshot-based transition detection so the icon can change colour at poll boundaries. Decision was made after a visual mockup comparing all four candidates side-by-side.

---

## D3 — Dropdown structure

**Chosen:** Signal-organised top level + per-collection submenus (a hybrid).

**Alternatives considered:**

- *Signal-organised only* — flat sections: Status / Collections / Recent activity / Global actions / Preferences.
- *Collection-organised* — each collection is a submenu containing its own status and per-collection actions.
- *Hybrid (chosen)* — signal-organised top level, but the Collections section uses per-collection submenus for per-collection actions.
- *Minimal flat* — single flat list with traffic-light per collection row, global actions at bottom, no submenus.

**Why this one:** Signal organisation at the top makes scanning fast and ADHD-friendly — every type of information has a known location. Per-collection submenus put per-collection actions exactly where they're already focused, instead of forcing a "which collection?" picker after clicking a top-level action. The flat alternative was tempting for v1 simplicity but loses the ability to act on a single collection without affecting others.

**Implications:** Forces submenu support in `lib/menu.ts`. Adds a layer to test (snapshot tests must cover both top-level and submenu states). Decision was made after a visual mockup comparing all four candidates.

---

## D4 — Action set

**Chosen:** Recommended action set, but **drop "Remove collection"**.

**Alternatives considered:**

- *Adopt as proposed* — top-level + per-collection actions including a confirmation-gated "Remove collection".
- *Same set + "Add collection…"* — add a folder-picker action so collections can be registered from the menubar.
- *Same set, drop "Remove collection"* — chosen.
- *Trim aggressively* — only Update, Embed, Reveal in Finder, Restart daemon, Preferences.

**Why this one:** Destructive operations stay in the CLI by design. Even with a confirmation dialog, a "Remove collection" item in the menubar is a foot-gun for ADHD-typical mis-clicks; the CLI's `qmd collection remove <name>` is the right surface. "Add collection" was deferred because it requires a native folder picker and the use case is genuinely rare. Aggressive trimming was rejected because losing per-collection actions undermines the per-collection submenu rationale.

**Implications:** The per-collection submenu has no destructive items. The CLI remains the source of truth for collection lifecycle. Decision was made after a visual mockup of the full action set.

---

## D5 — Threshold defaults

**Chosen:** Ship with defaults — 24h freshness (amber), 7d freshness (red), 95% coverage (amber), 50% coverage (red), 1h error window (red), 24h error window (amber).

**Alternatives considered:**

- *Defaults as shown* — chosen.
- *Tighter freshness* — 6h amber, 48h red, suiting multi-times-per-day capture.
- *Looser freshness* — 72h amber, 14d red, for users who index in bursts.
- *Tighter coverage* — 100% green, anything below = amber.

**Why this one:** The defaults match a daily-journal cadence (which the project owner uses). Tighter would produce more amber noise; looser would let drift hide. All thresholds are exposed in Preferences so users with different cadences can tune. Zero-tolerance coverage was rejected because adding a single new doc immediately triggers amber — which is technically correct but irritating during active writing.

**Implications:** Every threshold is a config knob ([`SPEC.md`](SPEC.md) §7.2). The defaults appear in `lib/config.ts` `DEFAULT_CONFIG`. Decision was made on the assumption of daily-journal usage; users with different cadences will edit the config.

---

## D6 — Refresh cadence

**Chosen:** 30 seconds.

**Alternatives considered:**

- *15 seconds* — feels live; daemon stops, icon goes red almost immediately.
- *30 seconds* — chosen.
- *60 seconds* — quieter; better for battery, up-to-a-minute lag between state change and icon update.
- *Adaptive (10s when daemon up, 2min when idle/asleep)* — tightest signal when it matters, quietest when it doesn't.

**Why this one:** 30s is SwiftBar's typical default and a sane balance between staleness and resource use. State changes reach the icon within 30s, which is fast enough for "did my job finish?" type questions without being so frequent that battery becomes a concern. Adaptive was tempting but adds state-tracking code that wasn't worth the complexity for v1.

**Implications:** Encoded in the plugin filename (`qmd.30s.ts`). All notification latency floors at 30s. The poll cycle's performance budget is sized for 30s ([`SPEC.md`](SPEC.md) §17). Decision deliberately left adaptive cadence as a v1.x possibility.

---

## D7 — Notification triggers

**Chosen:** Failures only by default (daemon crash, op failure, collection path unreachable). Job completion and threshold breaches are opt-in via Preferences.

**Alternatives considered:**

- *Failures only* — chosen.
- *Failures + long-job completion* — adds success notifications when embed/update finishes.
- *Failures + threshold breaches* — adds notifications when freshness or coverage crosses amber.
- *Silent by default* — no notifications at all; opt-in via Preferences for anyone who wants them.

**Why this one:** ADHD-first design: the bar for "this is worth interrupting" must be high or the user mutes the app within a week. Failures are the only events with clear actionability — something broke, you should know. Job completion and threshold breaches are useful to some users (and easy to opt into) but default-on would create notification debt. Silent-by-default was rejected because daemon crashes at 3pm shouldn't wait for the user to glance at the menubar at 4.

**Implications:** Three notification kinds are default-on in `DEFAULT_CONFIG.notifications`; two are default-off. Notification logic must implement transition detection (not re-fire on every poll). Dedupe registry needed to suppress repeats within 5 minutes.

---

## D8 — Activity feed scope

**Chosen:** Skip the activity feed entirely at v1.

**Alternatives considered:**

- *Menubar-initiated only* — log every action triggered from the menubar to a small file; activity feed reads last 5–10 entries.
- *Menubar + status deltas* — also infer external activity by diffing `qmd status` snapshots between polls.
- *Skip activity feed at v1* — chosen.
- *Menubar-initiated + opt-in log tailing* — same as menubar-initiated plus tail a qmd log file if we start qmd via a wrapper.

**Why this one:** Tightest possible MVP scope. The "did that overnight job run?" question is partially answered by the menubar-initiated action's log file (accessible via "Show last output"), which we still ship. A full activity feed adds another data source, another snapshot comparison, and another menu section to design — all deferrable. Status-delta detection in particular is fragile to qmd's JSON shape changes and would be the riskiest of the alternatives to ship in v1.

**Implications:** Dropped the "Recent activity" section from the dropdown structure decided in D3. "Show last output" remains in Global actions. Activity feed is the most likely candidate for v1.1.

---

## D9 — Multi-index support

**Chosen:** Single shared index only at v1.

**Alternatives considered:**

- *Single shared index only* — chosen.
- *One icon per index* — install the plugin file multiple times with different filenames and per-instance config.
- *One icon, aggregated rollup* — single icon shows worst-case across all configured indices.
- *One icon with active-index picker* — submenu lists every configured index; switching changes what the rest of the menu shows.

**Why this one:** The project owner uses a single shared `~/.cache/qmd/index.sqlite` with multiple collections inside. Most qmd users follow the same pattern. Building multi-index support adds non-trivial state aggregation logic and changes the rollup math (worst-case across indices? per-index rollups?). All of that can be added in v1.1 if real users ask for it. For users who genuinely run multiple indices today, the workaround (install plugin multiple times with different `qmd-<name>.30s.ts` filenames and env-var config overrides) is documented in [`SPEC.md`](SPEC.md) §24.

**Implications:** `Config.qmd.index_path` is a single string, not an array. The Collections section displays all collections from one index, with no grouping. Multi-index is the second-most-likely v1.1 candidate after the activity feed.

---

## D10 — Runtime (with rewrite risk explicitly weighed)

**Chosen:** Deno 2.x.

**Alternatives considered:**

- *Bun + qmd SDK* — initially recommended for ecosystem alignment (qmd is Bun-first).
- *Deno + qmd SDK via npm:* — chosen.
- *Node.js + qmd SDK* — most conservative, slowest cold start, heaviest install.
- *Bash + jq* — most idiomatic SwiftBar; loses typed SDK access.
- *Bun pinned to 1.3.14* — last Zig version of Bun; abandoned runtime track.

**Why this one:** The decision was *reconsidered mid-conversation* after the project owner flagged the Bun Zig→Rust core rewrite. Verification confirmed the rewrite landed on May 14, 2026 — three days before this spec was finalised — with 13,000 `unsafe` blocks, modified tests, and unverified failure modes (full details in [`RESEARCH.md`](RESEARCH.md)). That timing makes Bun *the worst possible runtime to start a new project on right now*: not because the long-term outcome is bad, but because the next 3–6 months are a shakedown period where downstream consumers will be debugging the runtime, not just their plugin. Deno's trajectory has been steady since Deno 2; the cost of using `npm:@tobilu/qmd` from Deno is bounded because we use only read-only SDK methods (no native-module-heavy `embed`/`search` paths). Node was a viable conservative fallback but loses Deno's permission model.

**Implications:** Shebang declares `--allow-net`, `--allow-read`, `--allow-write`, `--allow-run`, `--allow-env` with specific scopes — these double as inline docs of what the plugin touches. All SDK calls limited to `createStore`, `listCollections`, `getStatus`. Native module risk is real but contained. Decision should be revisited if Bun stabilises post-rewrite *and* qmd starts publishing Bun-first SDK shapes that don't translate cleanly to Deno.

---

## D11 — Configuration mechanism

**Chosen:** YAML file at `~/.config/qmd-swiftbar/config.yml`, validated on load, opened via "Preferences…" menu item (`open -t`).

**Alternatives considered:**

- *YAML + open-in-editor* — chosen.
- *JSON config* — same pattern, trivial Deno parsing, no comments.
- *SwiftBar built-in plugin preferences* — inline metadata directives; zero extra files; limited to flat primitives.
- *Local web Preferences page* — Deno serves an HTML form on click; most polished, most code.

**Why this one:** Matches qmd's own config style (`example-index.yml`), which means users already familiar with qmd's conventions don't need to learn a new format. YAML supports comments inline, which matter when half the keys are thresholds the user needs to remember what they do. SwiftBar's built-in preferences UI is appealing for zero-friction install but doesn't support nested or list-shaped config; it's strictly worse the moment you want per-collection overrides. A web preferences page would be more polished but adds an ephemeral HTTP server and an HTML form to maintain — overkill for v1.

**Implications:** Dependency on `jsr:@std/yaml`. Config validation logic in `lib/config.ts`. Hot reload (re-read every poll) is trivial because there's no UI state. Decision deliberately leaves a web preferences UI as a v1.x option if users want richer editing.

---

## D12 — Transport (reads vs actions)

**Chosen:** SDK for reads, CLI for actions.

**Alternatives considered:**

- *SDK reads + CLI actions* — chosen.
- *HTTP MCP daemon required* — poll `/health` and use HTTP MCP `status` tool; fastest steady-state cost; hard daemon dependency.
- *CLI only* — shell out to `qmd <cmd>` for everything including status; simplest mental model, highest poll cost.
- *Daemon preferred, CLI fallback* — try HTTP first, fall back to CLI when daemon down.

**Why this one:** Reads and writes want different choices. Reading status is cheap and sqlite-safe via direct SDK access — multiple processes can have read handles concurrently without contention. Actions (update, embed, daemon control) genuinely belong to qmd's own lifecycle and should go through the CLI to leverage its progress reporting, model loading, and chunking. Requiring the HTTP daemon would make the plugin nearly inert when the daemon is stopped (which is exactly when you most want to know about it). CLI-only is simplest but eats 100–300ms per poll for process startup, noticeable on battery.

**Implications:** The plugin works regardless of daemon state. Daemon is observable and controllable but never required. Native-module risk is contained because we never load qmd's ML models in the plugin process. The daemon `/health` probe is one signal among several; it doesn't gate anything.

---

## D13 — Action execution UX

**Chosen:** Background spawn + PID tracking + log file + single "Show last output" menu item.

**Alternatives considered:**

- *Single 'Show last output' menu item* — chosen.
- *'Recent jobs ▸' submenu* — lists last 5 jobs with timestamps and outcome glyph; partly recovers the activity-feed affordance dropped in D8.
- *Both* — top-level "Show last output" plus the submenu for history.
- *No log surface in the menu* — logs live on disk only; users find them via the README.

**Why this one:** Consistent with D8's "no activity feed at v1" call. One item gets you to the most recent log in one click; older logs accumulate on disk for terminal access if needed. Re-adding a "Recent jobs" submenu would partially recover what we just deferred. "No log surface" went too far — failure debugging without a one-click path to the log is friction we don't need.

**Implications:** Background spawn pattern documented in [`SPEC.md`](SPEC.md) §13. PID file directory at `~/.cache/qmd-swiftbar/jobs/`. Log directory with retention controlled by `config.logs.retain_per_action`. "Recent jobs" submenu is a likely v1.1 add if user demand surfaces.

---

## D14 — First-run / setup behaviour

**Chosen:** Layered detection with contextual menu — three distinct first-run states (qmd missing / no collections / empty index), each with a tailored menu and a "Re-check now" action.

**Alternatives considered:**

- *Layered detection, contextual menu* — chosen.
- *Single 'needs setup' state* — any unhealthy condition collapses to one generic menu.
- *Setup wizard (HTML pop-up)* — Deno-served local wizard walking through install + first collection.
- *README-only* — grey icon + one "View setup guide" item.

**Why this one:** Pinpoint guidance beats generic. Telling a user "qmd isn't installed" vs "you have no collections yet" vs "your index is empty, click here to update" is three completely different next-steps; collapsing them all to "needs setup" is a regression. A setup wizard would be more polished but commits us to maintaining HTML + form handling for a flow that's mostly text. README-only is the lightest possible but assumes more user diligence than we should assume.

**Implications:** `lib/detect.ts` runs four checks per poll; results cached for the poll duration. The "Re-check now" action exists specifically to avoid the 30s wait after the user fixes something. Each first-run state has its own snapshot test in `tests/menu_snapshot_test.ts`.

---

## D15 — Distribution

**Chosen:** Manual install (README) + curl installer (`install.sh`) + SwiftBar's built-in "Install from URL" feature. Skip Homebrew tap at v1.

**Alternatives considered:**

- *A only (manual GitHub install)* — smallest scope, no extra scripts.
- *A + B (manual + curl installer)* — chosen first; user later expanded to include D.
- *A + C (manual + Homebrew tap)* — most polished but commits to tap maintenance.
- *A + B + C (all three)* — most user choice, most maintenance.
- *A + B + D (manual + installer + SwiftBar URL)* — chosen — three install paths, all sharing the same GitHub-hosted `.ts` artifact.

**Why this one:** All three chosen paths share the same artifact (the `.ts` file in GitHub), so there's no extra infrastructure beyond the install script and a README section per path. Manual covers cautious users; curl installer covers casual; SwiftBar's URL install covers users who never touch their terminal. Homebrew tap was skipped because a tap repo and formula need maintenance on every release and we don't have evidence of demand yet.

**Implications:** `install.sh` is a v1.0.0 deliverable. README has three install sections. Each release tag needs the URLs updated in README. Homebrew tap is a v1.x add-on if user requests come in.

---

## D16 — License

**Chosen:** MIT.

**Alternatives considered:**

- *MIT* — chosen. Matches qmd's license.
- *Apache 2.0* — explicit patent grant, marginally more boilerplate.
- *GPL-3.0* — copyleft; forks must stay open-source.
- *BSD-2-Clause* — near-identical to MIT with different wording.

**Why this one:** Matches qmd's own license, lowering the cognitive overhead for anyone forking either project. MIT is dominant in the Deno and Node ecosystems; corporate users encounter the fewest legal questions when adopting MIT-licensed code. GPL was rejected for adoption friction; Apache was rejected for marginal benefit at the cost of more boilerplate; BSD has no clear differentiator over MIT.

**Implications:** `LICENSE` file in repo root (already added by project owner). Source headers don't need legal preambles. Forks and embedding are encouraged.

---

## Cross-cutting principles

A few principles came up repeatedly during scoping and inform multiple decisions:

1. **ADHD-first design.** The icon must answer "do I need to click?" without forcing a click. Notifications must be reserved for actionable failures. Menu shape must be scannable.
2. **Tight v1 scope.** Several appealing features (activity feed, multi-index, web preferences, spinner overlay) were deferred to keep v1 shippable. This is recorded in [`SPEC.md`](SPEC.md) §24.
3. **Ecosystem alignment over polish where they conflict.** YAML over JSON because qmd uses YAML; MIT over Apache because qmd uses MIT; SwiftBar conventions over custom UI patterns.
4. **Reads ≠ writes.** Status is read concurrently from sqlite via the SDK; lifecycle operations go through the CLI. This separation simplifies error handling and avoids reimplementing qmd's pipelines.
5. **Failure should be loud; success should be quiet.** Default notification triggers, error-window logic, and the rollup tiers all reinforce this.

---

*See also: [`SPEC.md`](SPEC.md) for the implementation reference, [`RESEARCH.md`](RESEARCH.md) for the background that informed runtime and distribution choices.*

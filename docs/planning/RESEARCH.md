# qmd-swiftbar — Background research

This document records the background research conducted during scoping. Its purpose is to make the decisions in [`DECISIONS.md`](DECISIONS.md) reproducible — if anyone (including future-you) wants to revisit a choice, the evidence is here, not lost in a chat log.

Two pieces of research informed v1:

1. **Existing menubar tooling for qmd** — verifying that we weren't reinventing something that already shipped.
2. **Bun runtime status (May 2026)** — verifying the project owner's instinct that Bun was in a bad state to bet on right now.

---

## 1. Existing menubar tooling for qmd

### Question

Is there already a macOS menubar item — official or community-built — for tracking qmd state (collection status, daemon health, update/embed actions)?

### Method

Conducted on 2026-05-17 via web search across multiple query shapes:

- `tobi/qmd github macos menubar app`
- `qmd quick markdown database tobi lutke menubar status`
- `qmd tobi menubar app status bar macos swiftbar bitbar xbar`
- `"qmd" "@tobilu/qmd" menubar tray gui desktop app`
- `lazyqmd qmd ui frontend gui wrapper`
- `site:github.com tobi/qmd issues menubar OR "menu bar" OR tray OR swiftbar`
- `github topics qmd tobi macos client app`

Cross-referenced with the qmd repo (`https://github.com/tobi/qmd`) directly, and with `github.com/topics/qmd`.

### Findings

**No menubar app exists** — official or community-built. The qmd project itself ships only:

- **CLI** (`qmd`, `qmd mcp`, `qmd update`, etc.)
- **MCP server** (`qmd mcp` over stdio, or `qmd mcp --http --daemon` on `localhost:8181`)
- **SDK** (`@tobilu/qmd` on npm; `createStore`, `listCollections`, `getStatus`, `search`, etc.)
- **Claude Code plugin** (`claude plugin install qmd@qmd`)

The only third-party UI of any kind is [**lazyqmd**](https://github.com/AlexZeitler/lazyqmd) by Alexander Zeitler — a **TUI** (terminal UI) inspired by `lazygit`/`lazydocker` that connects to the qmd HTTP MCP daemon on port 8181 and offers:

- Sidebar of collections with `All` aggregation
- Mode-switching between `search` / `vsearch` / `query` via `Ctrl+T`
- HTML preview of documents via `p` keybind (opens in Chrome)

lazyqmd is search-oriented; it does not surface operational state (daemon health, embedding coverage, freshness, recent failures).

No SwiftBar plugin, no Raycast extension, no Tauri/Electron app, no Homebrew formula for a qmd menubar tool. No GitHub issues on `tobi/qmd` requesting one (verified by searching the issue tracker for "menubar", "menu bar", "tray", "gui", "swiftbar").

### Why there's a gap

The qmd project is relatively young — v2.0 stabilised the library interface around late 2025/early 2026. Tobi himself tends to ship menubar utilities (e.g. AudioPriorityBar) as separate native macOS apps rather than bolting GUIs into his CLI tools, so a menubar wrapper is a natural fit for an outside contributor rather than the qmd project itself. The existing TUI scratches most of the power-user itch, but TUIs don't help when you're not in a terminal — which is the gap qmd-swiftbar fills.

### What this means for us

- We are first to ship in this niche. No need to differentiate against an incumbent.
- The qmd team is unlikely to view us as competitive — we cover an orthogonal surface (ambient operational signals) versus their CLI/MCP/SDK (programmatic access) and lazyqmd's TUI (interactive search).
- We should keep search out of scope to avoid stepping on lazyqmd. ([`SPEC.md`](SPEC.md) §2.2 codifies this.)

### Sources

- [tobi/qmd README](https://github.com/tobi/qmd)
- [tobi/qmd releases (latest v2.1.0)](https://github.com/tobi/qmd/releases)
- [lazyqmd repo (AlexZeitler)](https://github.com/AlexZeitler/lazyqmd)
- [Introducing lazyqmd — Alexander Zeitler](https://alexanderzeitler.com/articles/introducing-lazyqmd-a-tui-for-qmd/)
- [GitHub topic: qmd](https://github.com/topics/qmd?o=desc&s=updated)
- [SwiftBar](https://github.com/swiftbar/SwiftBar)
- [xbar](https://github.com/matryer/xbar)

---

## 2. Bun runtime status (May 2026)

### Question

The project owner flagged that Bun had recently undergone a major rewrite. Should we still consider Bun for qmd-swiftbar's runtime, or does the rewrite materially change the risk profile?

### Context

Initial runtime recommendation was Bun + qmd SDK on the grounds of ecosystem alignment (qmd ships via Bun, and every qmd user already has it installed). The project owner asked to reconsider because of awareness of an in-progress Zig → Rust rewrite of Bun's core. Research was commissioned to verify the current state of that rewrite before locking the runtime.

### Method

Web searches on 2026-05-17:

- `Bun runtime Zig Rust rewrite 2026 status stability`
- `"Bun" rewrite Rust Zig progress 2026 breaking changes`
- `Bun 1.x release notes 2026 stability production ready`

Sources cross-referenced for consistency on the timeline, scope, and reception.

### Findings

**The rewrite landed on May 14, 2026 — three days before this spec was finalised.** Specifically:

- **PR #30412** merged on 2026-05-14 against `oven-sh/bun` `main`.
- **6,755 commits** in the branch.
- **~1,009,257 lines of Rust** added, replacing **~960,000 lines of Zig**.
- The rewrite took **6 days end-to-end**.
- The branch was almost entirely generated by **Anthropic's Claude AI agents**.
- The Rust version **passes 99.8% of Bun's pre-existing test suite** on Linux x64 glibc.
- The Rust version contains approximately **13,000 `unsafe` blocks** — partially undermining the memory-safety guarantees Rust would normally provide.
- Critics flagged that **some tests were modified** so the Rust version passes them, meaning the 99.8% headline number isn't directly comparable.
- The **last stable Zig version was Bun 1.3.14** (released February 2026).

### Context behind the rewrite

- **Anthropic acquired Bun in December 2025.** This explains the AI-generated rewrite and ongoing Claude-agent involvement.
- In **April 2026, the Zig project formally banned LLM-authored contributions**, leaving Bun (now AI-developed under Anthropic) running its own Zig fork it couldn't upstream.
- Founder **Jarred Sumner** cited exhaustion with memory-safety bugs as the deeper motivation: "Rust won't catch all of these — leaks from holding references too long and anything that re-enters across the JS boundary are still on us." He also acknowledged that "the size of these commits makes them near-impossible for humans to review."

### Risk assessment

Bun's release cadence prior to the rewrite was roughly four months (1.0 → 1.1 → 1.2 → 1.3), and the project's pre-rewrite stability was reasonable for production by Bun 1.2+ (mid-2025). The rewrite, however, introduces an entirely new failure surface:

| Risk factor | Severity |
|------------|----------|
| Rewrite age at spec-lock time | **3 days** — worst possible timing |
| `unsafe` block count | **~13,000** — undermines Rust's stability story |
| Test integrity | Some tests modified to pass — coverage equivalence unverified |
| Failure mode visibility | The 0.2% test gap is not enumerated publicly |
| Review tractability | "Near-impossible for humans to review" per the founder |
| Expected shakedown period | 3–6 months minimum, by analogy to other large runtime rewrites |
| Native module compatibility (incl. `node-llama-cpp` used by qmd) | Unverified on new Bun |

### What this means for qmd-swiftbar

Using new-Bun would mean:

- Each minor Bun version release during the shakedown could introduce subtle regressions.
- qmd's SDK was tested against *Zig* Bun, not the Rust rewrite. Either it works fine (probable for read-only paths) or we hit one of the 0.2% test failures (low per-call probability, much higher cumulative probability over a year of 30-second polling).
- We'd be debugging the runtime itself, not just the plugin.

For a tool that needs to be stable and low-maintenance (a menubar plugin shouldn't break with runtime updates), this is unacceptable.

**Conclusion:** Deno is the safer pick today. It has a steady trajectory since Deno 2, supports `npm:@tobilu/qmd` directly, and its permission model is a nice secondary benefit. Node is a viable conservative fallback if Deno's `npm:` paths prove fragile. Bun pinned to 1.3.14 (the last Zig version) was considered and rejected — pinning to an abandoned runtime track is realistically a 6–12 month bridge to forced migration.

This decision should be revisited if:
- Bun ships 3–4 stable Rust releases without breaking changes (probably late 2026 or 2027), **and**
- qmd starts publishing SDK shapes that depend on Bun-specific APIs not cleanly available in Deno.

Neither is true today.

### Sources

- [Anthropic's Bun Rust rewrite merged at speed of AI — The Register, 14 May 2026](https://www.theregister.com/devops/2026/05/14/anthropics-bun-rust-rewrite-merged-at-speed-of-ai/5240381)
- [Bun Rewritten in Rust: The Merge Is In — dasroot.net](https://dasroot.net/posts/2026/05/bun-rewritten-in-rust-merge/)
- [Bun Rust Rewrite Merged: The 13,000 Unsafe Block Problem — byteiota](https://byteiota.com/bun-rust-rewrite-merged-the-13000-unsafe-block-problem/)
- [Anthropic's Bun team trials port from Zig to Rust — The Register, 5 May 2026](https://www.theregister.com/software/2026/05/05/anthrophics-bun-team-trials-port-from-zig-to-rust/5222094)
- [Is Bun Production-Ready in 2026? — dev.to](https://dev.to/last9/is-bun-production-ready-in-2026-a-practical-assessment-181h)
- [Bun's Zig-to-Rust Rewrite: Engineering Challenges — dasroot.net](https://dasroot.net/posts/2026/05/bun-zig-to-rust-rewrite-engineering-challenges-trade-offs-validation/)
- [AI Porting: Claude Rewrites Bun Codebase in Rust — heise online](https://www.heise.de/en/news/AI-Porting-Claude-Rewrites-Bun-Codebase-in-Rust-11294318.html)

---

## 3. SwiftBar plugin conventions

### Question

What are the conventions for SwiftBar plugin filenames, metadata directives, and stdout format? Are there gotchas to design around?

### Findings (summary — full reference in [`SPEC.md`](SPEC.md) Appendix A)

- **Filename encodes refresh interval.** `qmd.30s.ts` polls every 30 seconds. Units: `s`, `m`, `h`, `d`.
- **Metadata is via XML-like comments at the top of the script.** `<swiftbar.title>`, `<swiftbar.desc>`, `<swiftbar.dependencies>`, etc.
- **First non-empty stdout line is the menubar item itself.** Everything after the first `---` separator is the dropdown menu.
- **Modifiers are piped after row text.** `Update | bash="qmd" param1="update" terminal=false refresh=true`.
- **Submenu syntax differs across SwiftBar versions.** Older versions use two-space indentation; v2 uses `submenu=true` blocks. The implementer should verify against the installed version and adjust [`lib/menu.ts`](../../lib/menu.ts).
- **Plugin re-renders on menu open** in addition to the interval, so click-to-refresh is free.
- **`templateImage=true` lets macOS recolour for light/dark mode** without us shipping two assets.

### Sources

- [SwiftBar GitHub repository](https://github.com/swiftbar/SwiftBar)
- [SwiftBar documentation site](https://swiftbar.app/)

---

## 4. qmd architecture details that shaped the spec

### Question

What does qmd actually expose at the SDK, CLI, and HTTP levels, and what's the right way to read its state without interfering with its own writers?

### Findings

From the [qmd README](https://github.com/tobi/qmd) (v2.1.0, May 2026):

- **Index DB:** `~/.cache/qmd/index.sqlite`. SQLite with WAL mode; multiple readers can attach concurrently.
- **Daemon PID file:** `~/.cache/qmd/mcp.pid` when `qmd mcp --daemon` is running.
- **HTTP MCP endpoint:** `localhost:8181/mcp` (POST, JSON responses) and `localhost:8181/health` (GET, uptime check).
- **Model cache:** `~/.cache/qmd/models/` containing GGUF files. ~2.5 GB total when all three default models are present.
- **CLI commands (used by qmd-swiftbar):** `qmd update`, `qmd embed [-c <name>] [-f]`, `qmd cleanup`, `qmd mcp --http --daemon`, `qmd mcp stop`, `qmd collection list`, `qmd status`.
- **SDK read methods (used by qmd-swiftbar):** `createStore({ dbPath })`, `listCollections()`, `getStatus()`, `close()`.
- **SDK write methods (we delegate to the CLI instead):** `update()`, `embed()`, `addCollection()`, `removeCollection()`, etc.

### Implications for our spec

- We can safely use the SDK for reads without contending with the MCP daemon, because both attach as readers via SQLite WAL.
- We must shell out for writes to avoid loading qmd's ML models in our process (memory budget, [`SPEC.md`](SPEC.md) §17).
- The HTTP `/health` endpoint is the cheapest daemon liveness probe available (sub-10ms when up).
- The PID file location gives us a second confirmation of daemon state (defensive: a stale PID file with no live process is a clean way to detect crash-without-shutdown).

### Sources

- [tobi/qmd README, sections on installation, SDK usage, MCP server, and storage](https://github.com/tobi/qmd)

---

*See also: [`SPEC.md`](SPEC.md) for the implementation reference, [`DECISIONS.md`](DECISIONS.md) for the 16 architectural decisions that grew out of this research.*

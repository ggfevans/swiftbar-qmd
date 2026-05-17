# swiftbar-qmd

A [SwiftBar](https://github.com/swiftbar/SwiftBar) plugin that puts
[qmd](https://github.com/tobi/qmd) state in your macOS menubar: collection
health, MCP daemon status, embedding coverage, and one-click maintenance.

![swiftbar-qmd menubar mockup](docs/mockup.svg)

## Why this exists

[qmd](https://github.com/tobi/qmd) is a fast, local-first search engine for
markdown notes and knowledge bases. It ships a CLI, an MCP server, and an SDK,
all excellent. What it doesn't ship is any menubar surface, so the only ways to
check whether your index is healthy, whether collections are fresh, or whether
the daemon is running are `qmd status` in a terminal or hitting `/health` by
hand.

swiftbar-qmd fills that gap. A coloured icon (green, amber, red, or hollow grey)
summarises index health at a glance. The dropdown lists every collection with
freshness and coverage. Update, embed, and daemon controls are one click away,
so routine maintenance stops requiring a terminal.

Search isn't part of the design. That's
[lazyqmd](https://github.com/AlexZeitler/lazyqmd)'s job.

## Status

In development. The v1.0.0 spec is locked; implementation is in progress against
the prompts in [`docs/planning/PROMPTS.md`](docs/planning/PROMPTS.md). Install
instructions land with the v1.0.0 release.

## Built with Claude

The spec, planning docs, and code in this repo are drafted with
[Claude](https://claude.com) (Anthropic's AI assistant). Every change is
human-reviewed before it lands in the repo, and the human is accountable for
what ships.

## For implementers

- [`docs/planning/SPEC.md`](docs/planning/SPEC.md), the canonical v1
  specification.
- [`docs/planning/DECISIONS.md`](docs/planning/DECISIONS.md), rationale for the
  16 architectural choices.
- [`docs/planning/RESEARCH.md`](docs/planning/RESEARCH.md), background research
  that informed the design.
- [`docs/planning/PROMPTS.md`](docs/planning/PROMPTS.md), 17-step implementation
  plan with code-gen prompts.
- [`todo.md`](todo.md), the working checklist.

## Requirements at v1.0.0

macOS, [SwiftBar](https://swiftbar.app/) 2.x, [Deno](https://deno.com/) 2.x, and
a working [qmd](https://github.com/tobi/qmd) v2.x install with at least one
collection.

## License

MIT. See [`LICENSE`](LICENSE).

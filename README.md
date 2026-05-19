# qmd-swiftbar

[![CI][ci-badge]][ci] [![Security][sec-badge]][sec] [![Release][rel-badge]][rel] [![License][lic-badge]][lic] [![Deno][deno-badge]][deno]

A [SwiftBar](https://github.com/swiftbar/SwiftBar) plugin that surfaces [qmd](https://github.com/tobi/qmd) state in your macOS menubar: collection health, daemon status, and one-click maintenance actions.

[ci-badge]: https://img.shields.io/github/actions/workflow/status/ggfevans/qmd-swiftbar/build.yml?branch=main&label=build
[ci]: https://github.com/ggfevans/qmd-swiftbar/actions/workflows/build.yml
[sec-badge]: https://img.shields.io/github/actions/workflow/status/ggfevans/qmd-swiftbar/trivy.yml?branch=main&label=security
[sec]: https://github.com/ggfevans/qmd-swiftbar/actions/workflows/trivy.yml
[rel-badge]: https://img.shields.io/github/v/release/ggfevans/qmd-swiftbar?label=latest
[rel]: https://github.com/ggfevans/qmd-swiftbar/releases
[lic-badge]: https://img.shields.io/github/license/ggfevans/qmd-swiftbar
[lic]: https://github.com/ggfevans/qmd-swiftbar/blob/main/LICENSE
[deno-badge]: https://img.shields.io/badge/deno-2.x-blue?logo=deno
[deno]: https://deno.com/

## Install

Requires macOS (Apple Silicon or Intel) and [SwiftBar 2.x](https://swiftbar.app/). A running [qmd](https://github.com/tobi/qmd) installation is needed for the plugin to report status.

### Binary install (recommended)

No Deno runtime required. The installer downloads the compiled binary for your architecture, verifies its SHA256 checksum, and installs the `qmd.30s.sh` wrapper (also checksum-verified) as the SwiftBar entry point.

```bash
curl -fsSL https://raw.githubusercontent.com/ggfevans/qmd-swiftbar/main/install.sh | bash
```

Pin to a specific release:

```bash
curl -fsSL https://raw.githubusercontent.com/ggfevans/qmd-swiftbar/main/install.sh | bash -s v1.0.0
```

After install, restart SwiftBar (Cmd-Q in the SwiftBar menu, then relaunch).

Installed files:

```text
~/Library/Application Support/SwiftBar/Plugins/
  qmd.30s.sh       SwiftBar entry point (metadata + delegation)
  qmd-swiftbar      compiled binary (the real plugin)
```

### Source install (requires Deno 2.x)

```bash
mkdir -p ~/Library/Application\ Support/SwiftBar/Plugins
curl -L https://raw.githubusercontent.com/ggfevans/qmd-swiftbar/main/qmd.30s.ts \
  -o ~/Library/Application\ Support/SwiftBar/Plugins/qmd.30s.ts
chmod +x ~/Library/Application\ Support/SwiftBar/Plugins/qmd.30s.ts
```

Or use SwiftBar Preferences, Plugins, **Install from URL**:

```text
https://raw.githubusercontent.com/ggfevans/qmd-swiftbar/main/qmd.30s.ts
```

Both require [Deno 2.x](https://deno.com/) on `$PATH`.

## Configure

Configuration lives at `~/.config/qmd-swiftbar/config.yml`. Click **Preferences...** in the dropdown to open it in your editor. Changes take effect on the next 30-second poll. See [`config.example.yml`](config.example.yml) for all options.

## Icon colours

| Icon  | Meaning                                                                      |
| ----- | ---------------------------------------------------------------------------- |
| Green | All collections fresh, daemon running, no recent failures.                    |
| Amber | In-flight job, coverage drifting, freshness expiring, or recent op failure.  |
| Red   | Daemon stopped, collection unreachable, coverage broken, or fresh failure.   |
| Grey  | No collections configured. The plugin is healthy; qmd is empty.              |

## Troubleshooting

**Icon never appears.** Confirm `qmd.30s.sh` (binary install) or `qmd.30s.ts` (source install) is in `~/Library/Application Support/SwiftBar/Plugins/`, is executable (`chmod +x`), and that SwiftBar's plugin folder points there. Restart SwiftBar.

**Icon stays grey.** Run `qmd update` against at least one collection, then wait for the next poll.

**Notifications not appearing.** Open System Settings, Notifications, and confirm SwiftBar is allowed to deliver notifications. Failure notifications are on by default; success and threshold notifications are opt-in (see `config.example.yml`).

## AI disclosure

This project is **ai-generated**: the spec, planning docs, and code are drafted by [Claude](https://claude.com) (Anthropic's AI assistant, currently Claude Sonnet 4.6 and Opus 4.6) and reviewed by Gareth Evans before they land in the repo. Gareth is accountable for what ships. Conventions for AI agents working on this repo are documented in [`AGENTS.md`](AGENTS.md).

The "ai-generated" label follows the disclosure spectrum proposed by [dweekly/ai-content-disclosure](https://github.com/dweekly/ai-content-disclosure) and the OCaml community's [voluntary AI disclosure proposal](https://anil.recoil.org/notes/opam-ai-disclosure): `none` / `ai-assisted` / `ai-generated` / `autonomous` / `mixed`. AI-assisted commits carry an `Assisted-by:` trailer.

## License

MIT. See [`LICENSE`](LICENSE).
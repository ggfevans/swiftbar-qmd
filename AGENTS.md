# AGENTS.md

Conventions, commands, and constraints for AI coding agents working on this
repo. Human contributors should read this too, but it's written first for
agents.

This file follows the emerging [AGENTS.md](https://agentsmd.org/) convention.
For project context, start with [`README.md`](README.md). For the AI disclosure
that governs how this repo is built, see the README's "AI disclosure" section.

---

## What this repo is

A [SwiftBar](https://github.com/swiftbar/SwiftBar) plugin for the macOS menubar
that surfaces [qmd](https://github.com/tobi/qmd) state and exposes its routine
maintenance commands. Written in TypeScript, runs under Deno 2.x.

The full v1 specification is in
[`docs/planning/SPEC.md`](docs/planning/SPEC.md). It is the canonical source of
truth for what should be built. If you find a discrepancy between this file and
the spec, the spec wins; update this file.

---

## Where to start

If you're picking up work on this repo, read in this order:

1. [`README.md`](README.md) for one-paragraph context.
2. [`docs/planning/SPEC.md`](docs/planning/SPEC.md) §§1–3 for purpose and
   architecture.
3. [`docs/planning/DECISIONS.md`](docs/planning/DECISIONS.md) for the 16
   architectural choices and why each one was made.
4. [`docs/planning/PROMPTS.md`](docs/planning/PROMPTS.md) for the 17-step
   implementation plan. Each step is a self-contained code-generation prompt.
5. [`todo.md`](todo.md) for the working checklist. Find the first unchecked
   step; that's where to pick up.

Do not skip ahead in PROMPTS.md. Each step depends on the previous step's
artefacts being in place.

---

## Commands

All commands run from the repo root.

```bash
deno task fmt       # Format check + write
deno task lint      # Lint
deno task check     # Type check qmd.30s.ts, lib/**/*.ts, tests/**/*.ts
deno task test      # Run all tests
```

CI runs all four on every PR (see `.github/workflows/ci.yml`). All four must
pass before committing.

After every step in PROMPTS.md, run all four commands. If any fail, fix the
failure before committing.

---

## Conventions

### Code style

- TypeScript with `strict: true` (configured in `deno.json`).
- 2-space indentation, single quotes, semicolons. `deno fmt` enforces this.
- No `any` and no `as any` escape hatches. If the types don't fit, fix the type
  definition in `lib/types.ts` and update `SPEC.md` §6 in the same commit.
- One module per file in `lib/`. Each module exports a small, named surface; see
  `SPEC.md` §5.2 for the locked contracts.
- Pure functions where possible. `lib/rollup.ts` and `lib/time.ts` are entirely
  pure; keep them that way.
- No top-level side effects in `lib/` modules. Side effects live in `qmd.30s.ts`
  (the entry point) or in functions explicitly called from there.

### Testing

- Tests live in `tests/`.
- Snapshot tests use `jsr:@std/testing/snapshot`. Regenerate with
  `deno test -- --update` after intentional menu changes.
- Pure-function modules (rollup, time, config validation) target 100% branch
  coverage.
- I/O modules (state, persistence, actions, notify) target ≥80% line coverage
  via dependency injection rather than module-level mocking.
- Never let tests touch user paths. Override `CACHE_DIR` and `CONFIG_PATH` via
  env var or function argument to point at `Deno.makeTempDir()` for the test's
  lifetime.

### Writing style for docs and comments

- Sentence case for headings.
- No em dashes (use commas, periods, or parentheses instead).
- No LLM-trope vocabulary: `ambient`, `deliberately`, `purely`, `seamless`,
  `leverage`, `robust`, `delve`, `context switch`, `tapestry`, `journey`,
  `at the end of the day`.
- Canadian / British spelling: colour, organise, behaviour, optimised.
- Prefer prose over bullet points unless the content is a discrete enumeration.
- Cite spec sections rather than re-stating their content.

### Git

- One commit per step from `PROMPTS.md`. Commit message format:
  `step N: <short description> (SPEC §X)`
- AI-assisted commits carry an `Assisted-by:` trailer naming the model and the
  human reviewer:
  ```
  Assisted-by: Claude (Sonnet 4.6)
  Reviewed-by: Gareth Evans <gareth.gwilym.frederick.evans@gmail.com>
  ```
- Never force-push to `main`. Work on a feature branch and merge via PR (or
  fast-forward locally if working solo).
- `deno.lock` is committed.

---

## Project structure

```
swiftbar-qmd/
├── qmd.30s.ts              # SwiftBar entry point (interval encoded in filename)
├── lib/                    # Internal modules; see SPEC §5.2 for contracts
├── tests/                  # Unit + snapshot tests
├── deno.json               # Tasks, import map, lint/fmt config
├── deno.lock               # Committed
├── config.example.yml      # Annotated example config; seeded to ~/.config/swiftbar-qmd/config.yml on first run
├── install.sh              # Curl-installer script
├── docs/
│   ├── mockup.svg          # Visual mockup used in README
│   └── planning/           # Spec, decisions, research, prompts
├── README.md
├── CHANGELOG.md
├── todo.md
└── AGENTS.md               # This file
```

`lib/` module responsibilities are documented in `SPEC.md` §5.2. Read that
before adding or restructuring modules.

---

## Constraints

Things to avoid, in rough order of severity:

1. **Do not load qmd's ML models in the plugin process.** Use the SDK only for
   `createStore`, `listCollections`, `getStatus`, and `close`. Never call
   `embed`, `search`, `query`, or anything that pulls in `node-llama-cpp`.
   Delegate those to the `qmd` CLI via `lib/actions.ts`. Reason: memory budget
   is 50 MB resident; model loading would blow it instantly.
2. **Do not introduce new runtime dependencies** beyond those listed in
   `SPEC.md` §4.3 without a `DECISIONS.md` entry justifying the addition.
3. **Do not bypass the action runner for write operations.** All `qmd update`,
   `qmd embed`, `qmd mcp` etc. go through `lib/actions.ts` with PID tracking and
   log capture. Direct shell-outs are reserved for `open`, `pbcopy`,
   `osascript`, and process-liveness checks.
4. **Do not add "Remove collection" or other destructive operations to the
   menu.** This is a locked decision (see `DECISIONS.md` D4). Destructive ops
   live in the CLI.
5. **Do not make the plugin require the MCP daemon.** Reads use the SDK directly
   so the plugin works whether or not the daemon is running (see `DECISIONS.md`
   D12).
6. **Do not write to `~/.cache/qmd/`.** That's qmd's territory. Our writes go to
   `~/.cache/swiftbar-qmd/` exclusively.
7. **Do not let the poll cycle throw.** Wrap every read in `withTimeout` and
   try/catch; fall back to the last good snapshot. The plugin should never show
   a blank icon or a crash dialog.
8. **Do not exceed performance budgets.** Total poll cycle < 1000ms p99
   (`SPEC.md` §17). If a new feature pushes you near the budget, profile and
   adjust.
9. **Do not commit debugging `console.error` calls.** Use `lib/log.ts`.

---

## Per-step workflow

For each numbered step in `PROMPTS.md`:

1. Re-read the step's prompt and the spec sections it cites.
2. Check `todo.md` for the step's checklist; mentally tick the prerequisites.
3. Implement the new code, including tests.
4. Run `deno task fmt && deno task lint && deno task check && deno task test`.
5. Manually verify the step's acceptance condition (smoke-test in SwiftBar if
   the step adds visible behaviour).
6. Tick the relevant items in `todo.md`.
7. Commit with the step number and spec reference in the message, plus the
   `Assisted-by:` / `Reviewed-by:` trailers.

If you encounter a problem the spec doesn't cover, write down the question in
`docs/planning/DECISIONS.md` as a new pending decision rather than guessing. The
reviewer will resolve it.

---

## What to do when stuck

- If the spec is ambiguous: read the relevant `DECISIONS.md` entry for context.
- If the spec contradicts itself: spec is wrong somewhere. Pause, propose a fix,
  get human review.
- If a test is hard to write: the production code's structure is probably wrong.
  Refactor for testability (inject the dependency, narrow the function) before
  writing the test.
- If `deno check` is unhappy and the natural fix is `as any`: the types are
  wrong. Fix `lib/types.ts` and update `SPEC.md` §6.
- If a step in `PROMPTS.md` no longer makes sense because earlier code took a
  different path: stop. Reconcile the prompts with reality and update both
  `PROMPTS.md` and `SPEC.md` before continuing.

---

## Disclosure

How this repo is built is documented in the README's "AI disclosure" section.
The short version: drafts come from Claude, a human reviews and commits, the
human is accountable. If you're an agent working on this repo, you are part of
the drafting layer, not the accountability layer.

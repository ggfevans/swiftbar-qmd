# Planning docs

Design and decision artifacts for swiftbar-qmd. The implementation lives at the repo root; everything in this folder explains *why* and *what should be built*.

| Document | Purpose | Audience |
|----------|---------|----------|
| [`SPEC.md`](SPEC.md) | The locked v1 specification. Canonical implementation reference. | Developer starting work |
| [`DECISIONS.md`](DECISIONS.md) | Per-decision rationale for the 16 architectural choices, with alternatives considered. | Anyone reconsidering a choice |
| [`RESEARCH.md`](RESEARCH.md) | Background research that informed the design — existing tooling survey, Bun rewrite findings, SwiftBar conventions, qmd architecture. | Anyone validating an assumption |
| [`PROMPTS.md`](PROMPTS.md) | 17-step implementation blueprint with one code-gen prompt per step. Each prompt builds on the previous and ends with wiring. | Coding LLM, or anyone doing the implementation |

## Reading order

If you're starting fresh:

1. Skim **`SPEC.md`** §1–§3 for context (purpose, user, architecture overview).
2. Read **`DECISIONS.md`** end-to-end. It's the shortest doc and answers "why is the spec the way it is."
3. Use **`SPEC.md`** §4 onwards as a reference while implementing.
4. Dip into **`RESEARCH.md`** only when you want to validate a specific assumption or revisit a choice.

If you're picking up implementation work mid-flight:

1. **`SPEC.md`** §22 (Implementation milestones) — which slice you're on.
2. **`SPEC.md`** §5 (Module contracts) — what you're building.
3. **`SPEC.md`** §6 (Type definitions) — what shapes you're passing around.

## Status

Spec locked **2026-05-17** for v1.0.0 implementation. Subsequent changes should:

- Append a new decision to `DECISIONS.md` with rationale, rather than mutating existing entries.
- Update `SPEC.md` in place, bumping the **Spec revision** line at the top.
- Append a new section to `RESEARCH.md` if the change is informed by new research.

The `LICENSE` and one-time setup live at the repo root, not here.

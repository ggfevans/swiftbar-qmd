# Tests

Deno tests for swiftbar-qmd. Layout mirrors `lib/`: each `lib/<x>.ts` has a
paired `tests/<x>_test.ts`.

## Running

```sh
# All tests, default permissions.
deno test --allow-read --allow-env --allow-net=localhost --allow-write=/tmp

# Single file.
deno test --allow-read --allow-env tests/menu_snapshot_test.ts
```

The `deno task test` shortcut in `deno.json` wraps the full command.

## Snapshot tests (SPEC §19.2)

`tests/menu_snapshot_test.ts` exercises ten menu states from SPEC §19.2:

1. Healthy state (4 collections, all green)
2. Drifting state (Rackula past 24h freshness)
3. Red state (daemon stopped)
4. In-flight state (`update-all` running 1m)
5. First-run: `no-qmd`
6. First-run: `no-collections`
7. First-run: `empty-index`
8. Error state (`consecutiveReadFailures: 1`, prev snapshot fallback)
9. Config-error state (`⚠ Config error` header)
10. Per-collection submenu (Rackula with `hasObsidian: true`)

Snapshots live in `tests/fixtures/snapshots/menu_snapshot_test.ts.snap`. Fixture
builders (`buildHealthyState`, `buildDriftingState`, `buildRedState`,
`buildInFlightState`, `buildConfig`) live in `tests/fixtures/builders.ts`.

### Regenerating snapshots

When a menu change is intentional, regenerate the committed `.snap`:

```sh
deno test --allow-read --allow-env --allow-write=/tmp \
  tests/menu_snapshot_test.ts -- --update
```

Review the diff in `tests/fixtures/snapshots/menu_snapshot_test.ts.snap` before
committing — the diff IS the menu-output change-control record.

### Determinism

The renderer pulls a few values from the host (plugin path, cache dir) that
would otherwise float between runs. `tests/menu_snapshot_test.ts` normalizes
these through `createAssertSnapshot`'s `serializer` option:

- `Deno.mainModule` → `<PLUGIN_PATH>`
- `$HOME/.cache/swiftbar-qmd/error.log` → `<CACHE_DIR>/error.log`

All timestamps in fixtures are anchored to `FIXED_POLLED_AT`
(`2026-05-17T12:00:00.000Z`), so `compactDuration` / `relativeTime` produce
identical strings each run.

### Editor / linter note

`.snap` files are auto-generated. Don't reformat them by hand — your editor's
Prettier / `deno fmt` integration should be configured to skip them
(`fmt.exclude` already covers `docs/` and `.github/`; if you add a
snapshot-specific exclusion later, point it at `tests/fixtures/snapshots/`).

## Fixture builders

`tests/fixtures/builders.ts` exports helpers so new menu-state tests can be
assembled by combining a base state with light overrides:

```ts
import { buildConfig, buildHealthyState } from "./fixtures/builders.ts";

const state = buildHealthyState();
state.collections[0].coveragePercent = 80; // amber per default config
const config = buildConfig();
```

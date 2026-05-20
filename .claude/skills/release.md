---
name: release
description: "Cut a release for qmd-swiftbar: bump versions, update changelog and SECURITY.md, commit, tag, and push."
---

# Release Skill

Automates the release workflow for the qmd-swiftbar project (Deno/SwiftBar).

## Arguments

`$ARGUMENTS` (required): One of `patch`, `minor`, `major`, or an explicit version like `1.1.0`.

## Version Locations

This project has **no** `extension.toml` or `Cargo.toml`. The version string appears in SwiftBar/xbar metadata comments in three locations that must be kept in sync:

| File | Line | Pattern |
|------|------|---------|
| `qmd.30s.ts` | 4 | `// <swiftbar.version>v1.0.0</swiftbar.version>` |
| `qmd.30s.sh` | 5 | `# <bitbar.version>v1.0.0</bitbar.version>` |
| `qmd.30s.sh` | 11 | `# <swiftbar.version>v1.0.0</swiftbar.version>` |

All three must be updated atomically. The version prefix `v` is part of the metadata value but NOT part of the semantic version for comparison purposes (e.g., `v1.0.0` stores version `1.0.0`).

## Pre-flight Checks

Run these checks in order. If any fails, stop and report the problem clearly.

### 1. Verify on main branch

```bash
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "ERROR: Not on main branch (on $CURRENT_BRANCH). Switch to main first."
  exit 1
fi
```

### 2. Verify clean working tree

```bash
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree is dirty. Commit or stash changes before releasing."
  git status --short
  exit 1
fi
```

### 3. Pull latest from origin

```bash
git pull origin main
```

If the pull fails or produces conflicts, stop and ask the user to resolve.

### 4. Verify version strings are in sync

```bash
TS_VER=$(sed -n '4p' qmd.30s.ts | sed -n 's/.*<swiftbar.version>v\([^<]*\)<\/swiftbar.version>.*/\1/p')
SH_BITBAR_VER=$(sed -n '5p' qmd.30s.sh | sed -n 's/.*<bitbar.version>v\([^<]*\)<\/bitbar.version>.*/\1/p')
SH_SWIFTBAR_VER=$(sed -n '11p' qmd.30s.sh | sed -n 's/.*<swiftbar.version>v\([^<]*\)<\/swiftbar.version>.*/\1/p')

if [ "$TS_VER" != "$SH_BITBAR_VER" ] || [ "$TS_VER" != "$SH_SWIFTBAR_VER" ]; then
  echo "ERROR: Version strings are out of sync!"
  echo "  qmd.30s.ts (swiftbar): $TS_VER"
  echo "  qmd.30s.sh (bitbar):   $SH_BITBAR_VER"
  echo "  qmd.30s.sh (swiftbar): $SH_SWIFTBAR_VER"
  echo "Fix the mismatch before releasing."
  exit 1
fi
CURRENT_VERSION="$TS_VER"
echo "Current version: $CURRENT_VERSION (all three locations in sync)"
```

### 5. Compute the target version

Parse `$ARGUMENTS` to determine the new version:

- If `patch`: increment the patch component (1.0.0 -> 1.0.1)
- If `minor`: increment the minor component, reset patch (1.0.0 -> 1.1.0)
- If `major`: increment the major component, reset minor and patch (1.0.0 -> 2.0.0)
- If an explicit version string (e.g., `1.1.0`): use it directly (without `v` prefix)
- Otherwise: report error and stop

```bash
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case "$ARGUMENTS" in
  patch) NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
  minor) NEW_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
  major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
  *)
    # Validate explicit version format
    if echo "$ARGUMENTS" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
      NEW_VERSION="$ARGUMENTS"
    else
      echo "ERROR: Invalid version argument: $ARGUMENTS"
      echo "Expected: patch, minor, major, or explicit version (e.g. 1.2.0)"
      exit 1
    fi
    ;;
esac
echo "Version: ${CURRENT_VERSION} -> ${NEW_VERSION}"
```

### 6. Verify the tag does not already exist

```bash
if git rev-parse "v${NEW_VERSION}" >/dev/null 2>&1; then
  echo "ERROR: Tag v${NEW_VERSION} already exists."
  echo "Existing tags:"
  git tag -l 'v*' | sort -V
  exit 1
fi
```

### 7. Verify there are changes since the last tag (or since repo start if no tags)

```bash
LAST_TAG=$(git tag -l 'v*' | sort -V | tail -1)
if [ -n "$LAST_TAG" ]; then
  CHANGE_COUNT=$(git log "${LAST_TAG}..HEAD" --oneline | wc -l | tr -d ' ')
  if [ "$CHANGE_COUNT" -eq 0 ]; then
    echo "ERROR: No commits since $LAST_TAG. Nothing to release."
    exit 1
  fi
else
  echo "No previous tags found. This will be the first release."
fi
```

## Version Bump

Update all three version locations atomically:

```bash
# Bump qmd.30s.ts (line 4)
sed -i '' "4s|<swiftbar.version>v[^<]*</swiftbar.version>|<swiftbar.version>v${NEW_VERSION}</swiftbar.version>|" qmd.30s.ts

# Bump qmd.30s.sh (line 5 — bitbar)
sed -i '' "5s|<bitbar.version>v[^<]*</bitbar.version>|<bitbar.version>v${NEW_VERSION}</bitbar.version>|" qmd.30s.sh

# Bump qmd.30s.sh (line 11 — swiftbar)
sed -i '' "11s|<swiftbar.version>v[^<]*</swiftbar.version>|<swiftbar.version>v${NEW_VERSION}</swiftbar.version>|" qmd.30s.sh
```

After bumping, re-run the sync verification to confirm all three match the new version.

## CHANGELOG.md Update

Insert a new versioned section into `CHANGELOG.md`.

### First release (converting `[Unreleased]`)

If there is a `## [Unreleased]` section, rename it to the target version with today's date:

```markdown
## [X.Y.Z] - YYYY-MM-DD
```

Keep all the existing content under that heading. Remove the `[Unreleased]` header entirely and replace it with the dated version header. Also add a fresh empty `[Unreleased]` section above it:

```markdown
## [Unreleased]

## [X.Y.Z] - YYYY-MM-DD
```

### Subsequent releases

Gather changes from git log since the last tag:

```bash
git log "${LAST_TAG}..HEAD" --oneline --no-decorate
```

Categorise commits into `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security` following [Keep a Changelog](https://keepachangelog.com/). Use `feat:` as Added, `fix:` as Fixed, etc.

Insert the new section between the `## [Unreleased]` header and the previous release header:

```markdown
## [Unreleased]

## [X.Y.Z] - YYYY-MM-DD

### Added
- ...

### Fixed
- ...
```

### Verify changelog entry exists

After editing, verify the target version has a section:

```bash
if ! grep -q "^## \[${NEW_VERSION}\]" CHANGELOG.md; then
  echo "ERROR: CHANGELOG.md does not have a section for [${NEW_VERSION}]."
  exit 1
fi
```

## SECURITY.md

### If SECURITY.md does not exist

Create it with the following content:

```markdown
# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| X.Y.Z   | :white_check_mark: |
| < X.Y.Z | :x:                |

## Reporting a Vulnerability

Please report security vulnerabilities privately via [GitHub Security Advisories](https://github.com/ggfevans/qmd-swiftbar/security/advisories/new).

Do not file a public issue for security vulnerabilities.
```

Replace `X.Y.Z` with the release version. The `< X.Y.Z` row marks all older versions as unsupported.

### If SECURITY.md already exists

Update the supported versions table:
- Add a new row for the release version with `:white_check_mark:`
- Change the previous version's row to `:x:` (only the most recent release is supported)
- Keep the `< X.Y.Z` row at the bottom

## Git Operations

### Stage all changes

```bash
git add qmd.30s.ts qmd.30s.sh CHANGELOG.md SECURITY.md
```

### Commit

```bash
git commit -m "release: v${NEW_VERSION}

Bump version to v${NEW_VERSION} in qmd.30s.ts and qmd.30s.sh.
Update CHANGELOG.md and SECURITY.md for release."
```

### Create tag

```bash
git tag -a "v${NEW_VERSION}" -m "v${NEW_VERSION}"
```

### Push branch and tag

```bash
git push origin main
git push origin "v${NEW_VERSION}"
```

If the push fails (network error, rejected non-fast-forward, etc.):
- Do NOT retry automatically.
- Report the error to the user.
- Suggest `git pull --rebase origin main` then retry the push.
- The tag push and branch push are separate — if the tag push fails after a successful branch push, only retry `git push origin "v${NEW_VERSION}"`.

## Post-release Monitoring

After the push completes, provide the user with links and optional monitoring:

```bash
echo ""
echo "Release v${NEW_VERSION} pushed successfully."
echo ""
echo "GitHub Actions:"
echo "  - Build: https://github.com/ggfevans/qmd-swiftbar/actions/workflows/build.yml"
echo "  - CI: https://github.com/ggfevans/qmd-swiftbar/actions/workflows/ci.yml"
echo "  - Release: https://github.com/ggfevans/qmd-swiftbar/actions/workflows/release.yml"
echo ""
echo "All workflows: https://github.com/ggfevans/qmd-swiftbar/actions"
echo ""
```

If the user wants to watch the CI run:

```bash
# List recent workflow runs (build and release workflows are triggered by the tag push)
gh run list --workflow=build.yml --limit 3
gh run list --workflow=ci.yml --limit 3
# Then optionally:
# gh run watch <RUN_ID>
```

## Error Handling Summary

| Error | Condition | Action |
|-------|-----------|--------|
| Wrong branch | Not on `main` | Report and stop |
| Dirty working tree | Uncommitted changes | Report and stop |
| Pull conflict | `git pull` fails | Report and stop |
| Version mismatch | Three version strings differ | Report mismatch details and stop |
| Tag exists | `vX.Y.Z` already tagged | Report existing tag and stop |
| No changes | No commits since last tag | Report and stop |
| Missing changelog entry | No `## [X.Y.Z]` in CHANGELOG.md | Report and stop |
| Push failure | `git push` fails | Report error, suggest recovery steps |

## What This Skill Does NOT Do

- Bump `extension.toml` or `Cargo.toml` (they do not exist in this project)
- Run `cargo generate-lockfile` (this is a Deno project)
- Modify `install.sh` (it pulls `latest` by default)
- Trigger CI directly (tag push triggers `build.yml`, `ci.yml`, and `release.yml` automatically)

## Permissions

This skill requires permission to run:
- `git status`, `git rev-parse`, `git tag`, `git log`, `git add`, `git commit`, `git push`
- `sed` (for version bumping)
- `gh run list`, `gh run watch` (for CI monitoring)
- File reads and writes to `qmd.30s.ts`, `qmd.30s.sh`, `CHANGELOG.md`, `SECURITY.md`

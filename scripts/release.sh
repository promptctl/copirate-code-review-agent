#!/usr/bin/env bash
# Publish a release from the current main commit.
#
# This is the single source of the release ritual. [LAW:single-enforcer]
# It is a PUBLISHER, not a bumper: it edits nothing and commits nothing. The
# version bump (package.json + rebuilt dist) lands earlier as a normal PR to
# main; this script tags that merged commit and publishes it. [LAW:decomposition]
#
# Version is read from package.json — the one source of truth. [LAW:one-source-of-truth]
# Run it on a clean, up-to-date main:
#     git checkout main && git pull && ./scripts/release.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

die() { echo "ERROR: $*" >&2; exit 1; }

# --- Preconditions: each fails loudly with a specific cause. [LAW:no-silent-failure] ---
command -v gh   >/dev/null 2>&1 || die "GitHub CLI 'gh' is not installed (https://cli.github.com)."
command -v node >/dev/null 2>&1 || die "node is not installed."
gh auth status  >/dev/null 2>&1 || die "gh is not authenticated. Run: gh auth login"

BRANCH="$(git branch --show-current)"
[ "$BRANCH" = "main" ] || die "release only from main (you are on '$BRANCH')."

git diff --quiet && git diff --cached --quiet \
  || die "working tree is not clean. Release only from an untouched main."

git fetch --quiet origin main
[ "$(git rev-parse @)" = "$(git rev-parse origin/main)" ] \
  || die "local main is not in sync with origin/main. Pull/push so they match, then retry."

[ -d node_modules ] || die "node_modules missing. Run: npm install"

VERSION="$(node -p "require('./package.json').version")"
[ -n "$VERSION" ] || die "could not read version from package.json."
MAJOR_TAG="v${VERSION%%.*}"   # 1.4.2 -> v1   (moving major tag) [LAW:dataflow-not-control-flow]

# Immutable tags never move: refuse to re-release an existing version.
git rev-parse -q --verify "refs/tags/${VERSION}" >/dev/null 2>&1 \
  && die "tag ${VERSION} already exists locally. Bump package.json to a new version first."
git ls-remote --exit-code --tags origin "refs/tags/${VERSION}" >/dev/null 2>&1 \
  && die "tag ${VERSION} already exists on origin. Bump package.json to a new version first."

# The release gate: the committed dist MUST match a fresh build of src.
# Otherwise the Actions runner (which executes dist/index.js directly) ships
# stale code. Rebuild, diff, and restore the tree either way. [LAW:no-silent-failure]
echo "→ verifying dist matches source (npm run build)…"
npm run build >/dev/null || die "build failed (see the error above)."
if ! git diff --quiet -- dist; then
  git checkout -- dist
  die "dist is out of date with src. Rebuild and commit dist via a PR before releasing."
fi
git checkout -- dist  # discard mtime-only changes; tree returns to clean

REL_SHA="$(git rev-parse --short HEAD)"
echo "✓ releasing ${VERSION} @ ${REL_SHA} (will re-point ${MAJOR_TAG})"

# --- Effects, all at the boundary, in one straight sequence. [LAW:effects-at-boundaries] ---
git tag -a "$VERSION" -m "Release $VERSION"           # immutable, annotated
git tag -f "$MAJOR_TAG" "$VERSION^{}"                 # moving major -> same commit
git push origin "refs/tags/$VERSION"
git push -f origin "refs/tags/$MAJOR_TAG"
gh release create "$VERSION" --verify-tag --title "$VERSION" --generate-notes --latest

echo "✓ released — consumers on @${MAJOR_TAG} now get ${VERSION}"
gh release view "$VERSION" --json url -q .url

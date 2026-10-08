#!/usr/bin/env bash
# STOP (2026-07-09): Repo locked until 6 Nov 2026 (after the HSC). No work here without tangible study gain. See STOP-UNTIL-NOV-6.md. Go do past papers.
#
# deploy.sh — build a clean dist/ and deploy the unified app to Cloudflare Pages.
#
# Ships the app shell + per-episode markdown/quiz + the manifest. Audio is NOT shipped
# (it streams from R2 via each subject's audioBaseUrl). Run from the repo root.
#
#   ./deploy.sh                                   # deploy to $PAGES_PROJECT (default below)
#   PAGES_PROJECT=hsc-podcast-unified ./deploy.sh
#
# Prereqs: wrangler (logged in), rsync, git, npm (for the speechwarp dependency).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PAGES_PROJECT="${PAGES_PROJECT:-hsc-podcast-unified}"
DIST="${DIST:-dist}"
BUILD="$(git rev-parse --short HEAD 2>/dev/null || date +%s)"

echo "==> Assembling $DIST/ (build $BUILD)"
rm -rf "$DIST"; mkdir -p "$DIST"

# App shell.
cp index.html generator.html paper-export.js app.js auth.js gate.js plotmap.js modules.js style.css speed-engine.js app.webmanifest _headers "$DIST/"
# Service worker — stamp the build version so each deploy gets a fresh APP_SHELL cache.
sed "s/__BUILD__/$BUILD/" service-worker.js > "$DIST/service-worker.js"
# Build info the app reads to show the running version (Settings → About → Build, tap for
# the commit message). JSON so the commit subject's quotes/newlines escape cleanly.
BUILD_MSG="$(git log -1 --pretty=%s 2>/dev/null || echo '')"
BUILD_DATE="$(git log -1 --pretty=%cI 2>/dev/null || date -u +%FT%TZ)"
python3 -c 'import json,sys; json.dump({"build":sys.argv[1],"message":sys.argv[2],"date":sys.argv[3]}, sys.stdout)' \
  "$BUILD" "$BUILD_MSG" "$BUILD_DATE" > "$DIST/build.json"
# Manifest + vendored libs + icons.
cp manifest.json "$DIST/"
cp -r vendor "$DIST/"
cp -r icons "$DIST/"
# speechwarp (the speed engine) is an npm dependency, not checked in: ship its built files
# from node_modules. speed-engine.js loads vendor/speechwarp/speechwarp-processor.js.
[ -d node_modules/speechwarp ] || npm install
mkdir -p "$DIST/vendor/speechwarp"
cp node_modules/speechwarp/dist/*.js node_modules/speechwarp/licenses/LICENSE \
  node_modules/speechwarp/licenses/NOTICE "$DIST/vendor/speechwarp/"

# Per-episode text the app fetches at runtime (script/supplementary/quiz only). Skip
# underscore dirs (the _template-subject scaffold) and never ship audio or voices.json.
rsync -a --prune-empty-dirs \
  --exclude='_*' \
  --exclude='resources' \
  --include='*/' \
  --include='script.md' --include='supplementary.md' --include='quiz.json' \
  --include='questions.json' --include='subject.json' --include='papers-index.json' \
  --include='paper-subjects.json' \
  --include='*.png' --include='*.jpg' --include='*.jpeg' --include='*.webp' --include='*.svg' \
  --include='paper.pdf' --include='mg.pdf' \
  --include='scenes.json' --include='quotes.json' --include='cards.json' --include='*.apkg' \
  --exclude='*' \
  content/ "$DIST/content/"

# Safety net: if a content folder was encrypted, the plaintext must not ship beside it.
while IFS= read -r g; do
  d="$(dirname "$g")"
  for f in scenes.json quotes.json quiz.json; do
    if [ -f "$d/$f" ] && [ -f "$d/$f.enc" ]; then
      echo "ERROR: $d/$f shipped in plaintext next to its .enc — aborting." >&2; exit 1
    fi
  done
done < <(find "$DIST" -name gate.json 2>/dev/null)

# Safety net: every local <script src> / <link href> in index.html must actually be in
# dist/. Adding a file to index.html but forgetting the cp line above ships an app that
# 404s into the SPA fallback and fails at runtime with no build error. (Hit with modules.js.)
missing=0
while IFS= read -r asset; do
  if [ ! -f "$DIST/$asset" ]; then echo "ERROR: $asset referenced by index.html but not in $DIST" >&2; missing=1; fi
done < <(grep -oE '(src|href)="[A-Za-z0-9_.-]+\.(js|css)"' index.html | sed -E 's/.*="([^"]+)"/\1/' | sort -u)
[ "$missing" = "1" ] && { echo "ERROR: aborting deploy — missing app shell files." >&2; exit 1; }

# Safety net: no audio in the Pages bundle.
if find "$DIST" \( -name '*.m4a' -o -name '*.wav' \) | grep -q .; then
  echo "ERROR: audio found in $DIST — aborting (audio belongs in R2)." >&2; exit 1
fi

echo "==> dist: $(du -sh "$DIST" | cut -f1), $(find "$DIST" -type f | wc -l | tr -d ' ') files"
echo "==> Deploying to Pages project: $PAGES_PROJECT"
DEPLOY_ARGS=(--project-name "$PAGES_PROJECT" --commit-dirty=true)
# PAGES_BRANCH=main forces a production deploy even from a feature git branch.
[ -n "${PAGES_BRANCH:-}" ] && DEPLOY_ARGS+=(--branch "$PAGES_BRANCH")
wrangler pages deploy "$DIST" "${DEPLOY_ARGS[@]}"
echo "==> Done."

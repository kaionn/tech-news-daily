#!/usr/bin/env bash
# Called only under the reusable deploy job's site-deploy concurrency lock.
set -euo pipefail
# Empty/unset preserves production Pages until a separately approved cutover.
TARGET=${SITE_DEPLOY_TARGET:-pages}
case "$TARGET" in
  pages|workers) ;;
  *) echo "::error::SITE_DEPLOY_TARGET must be pages or workers"; exit 1 ;;
esac
git fetch origin main
SHA=$(git rev-parse origin/main)
CLEAN=$(mktemp -d)
trap 'rm -rf "$CLEAN"' EXIT
# Never deploy caller HEAD: an older generator may finish after a newer push.
mkdir "$CLEAN/snapshot"
git archive "$SHA" | tar -x -C "$CLEAN/snapshot"
echo "Deploying latest main snapshot: $SHA"
# A non-fast-forward main rewrite is outside this contract; do not use force pushes.
if [ "$TARGET" = pages ]; then
  npx --yes wrangler@4 pages deploy "$CLEAN/snapshot" --project-name=tech-news-daily --branch=main --commit-hash="$SHA"
else
  # Run config and staging code from the same newest snapshot, not the caller HEAD.
  node "$CLEAN/snapshot/scripts/stage-static-assets.mjs" "$CLEAN/snapshot" "$CLEAN/public"
  cp "$CLEAN/snapshot/wrangler.jsonc" "$CLEAN/wrangler.jsonc"
  npx --yes wrangler@4 deploy --config "$CLEAN/wrangler.jsonc" --message "main $SHA"
fi

#!/usr/bin/env bash
# Called only under the reusable deploy job's site-deploy concurrency lock.
set -euo pipefail
git fetch origin main
SHA=$(git rev-parse origin/main)
CLEAN=$(mktemp -d)
trap 'rm -rf "$CLEAN"' EXIT
# Never deploy caller HEAD: an older generator may finish after a newer push.
git archive "$SHA" | tar -x -C "$CLEAN"
echo "Deploying latest main snapshot: $SHA"
# A non-fast-forward main rewrite is outside this contract; do not use force pushes.
npx --yes wrangler@4 pages deploy "$CLEAN" --project-name=tech-news-daily --branch=main --commit-hash="$SHA"

#!/usr/bin/env bash
# Generation is serialized by weekly-ai-trends; main may still advance elsewhere.
set -euo pipefail
git fetch origin main
# Refuse a same-day race before staging. Do not overwrite/rebase its JSON.
if git cat-file -e "origin/main:data/ai-trends/${ISSUE}.json" 2>/dev/null; then
  git show "origin/main:data/ai-trends/${ISSUE}.json" | cmp - "data/ai-trends/${ISSUE}.json" || {
    echo "::error::Target JSON changed on main; keep main and retry render-only"
    exit 1
  }
fi
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add "data/ai-trends/${ISSUE}.json" ai-trends.html ai-trends/
if ! git diff --cached --quiet; then
  git commit -m "${ISSUE} の AI プロダクト動向"
  git rebase origin/main
  git push origin HEAD:main
fi
# Even a clean tree must deploy when valid JSON exists but public site is stale.
echo "deploy=true" >> "$GITHUB_OUTPUT"

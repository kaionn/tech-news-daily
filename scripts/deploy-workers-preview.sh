#!/usr/bin/env bash
# Manual-only preview: never consult or change the production host variable.
set -euo pipefail
if [ "${GITHUB_REF:-}" != refs/heads/main ]; then
  echo '::error::Workers preview deployment requires main'
  exit 1
fi
git fetch origin main
SHA=$(git rev-parse origin/main)
CLEAN=$(mktemp -d)
trap 'rm -rf "$CLEAN"' EXIT
mkdir "$CLEAN/snapshot"
git archive "$SHA" | tar -x -C "$CLEAN/snapshot"
node "$CLEAN/snapshot/scripts/stage-static-assets.mjs" "$CLEAN/snapshot" "$CLEAN/public"
node --input-type=module - "$CLEAN" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const base = process.argv[2];
const config = JSON.parse(readFileSync(path.join(base, 'snapshot/wrangler.jsonc'), 'utf8'));
const allowed = new Set(['$schema', 'name', 'compatibility_date', 'workers_dev', 'preview_urls', 'assets']);
const assets = { directory: './public', html_handling: 'auto-trailing-slash', not_found_handling: 'none' };
if (Object.keys(config).some(key => !allowed.has(key)) || config.name !== 'tech-news-daily-site' ||
    config.workers_dev !== false || config.preview_urls !== false ||
    JSON.stringify(config.assets) !== JSON.stringify(assets)) {
  throw Error('Preview requires the reviewed assets-only production configuration');
}
config.name = 'tech-news-daily-site-preview';
config.workers_dev = true;
writeFileSync(path.join(base, 'wrangler.jsonc'), JSON.stringify(config, null, 2) + '\n');
NODE
echo "Deploying preview from latest main snapshot: $SHA"
npx --yes wrangler@4.148.0 deploy --config "$CLEAN/wrangler.jsonc" --message "preview main $SHA"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve('.');
const script = path.join(root, 'scripts/deploy-workers-preview.sh');
const run = (cmd, args, cwd, env = {}) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
function write(base, name, text) {
  const file = path.join(base, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text);
}
test('preview refuses a non-main caller before git or uploader', () => {
  const r = run('bash', [script], tmpdir(), { GITHUB_REF: 'refs/heads/other' });
  assert.notEqual(r.status, 0); assert.match(r.stdout, /requires main/);
  assert.ok(!r.stderr.includes('not a git repository'));
});
test('preview is manual main-only, with existing secrets and its own bounded lock', () => {
  const text = readFileSync('.github/workflows/deploy-workers-preview.yml', 'utf8');
  assert.match(text, /on:\n  workflow_dispatch:\n/);
  assert.doesNotMatch(text, /schedule:|push:|pull_request:|inputs:|SITE_DEPLOY_TARGET/);
  assert.match(text, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(text, /contents: read/); assert.doesNotMatch(text, /contents: write|id-token:/);
  assert.match(text, /timeout-minutes: 10/); assert.match(text, /group: workers-preview-deploy/);
  assert.match(text, /cancel-in-progress: false/);
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) assert.ok(text.includes(`secrets.${name}`));
  assert.match(text, /run: bash scripts\/deploy-workers-preview.sh/);
});
test('old caller uploads newest public snapshot only to preview; upload failure never falls back', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'workers-preview-ci-'));
  const git = (cwd, ...args) => { const r = run('git', args, cwd); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  try {
    const producer = path.join(dir, 'producer'), old = path.join(dir, 'old'), bare = path.join(dir, 'remote.git');
    const bin = path.join(dir, 'bin'), capture = path.join(dir, 'capture');
    for (const p of [producer, bin, capture]) mkdirSync(p);
    git(dir, 'init', '--bare', bare); git(producer, 'init', '-b', 'main');
    git(producer, 'config', 'user.name', 'Test'); git(producer, 'config', 'user.email', 'test@example.invalid');
    git(producer, 'config', 'commit.gpgsign', 'false');
    for (const name of ['index.html', 'trends.html', 'ai-trends.html', 'style.css', 'feed.xml', 'favicon-32.png', 'favicon.png', 'apple-touch-icon.png']) write(producer, name, 'old');
    for (const name of ['archive/index.html', 'ai-trends/2026-10-10.html', 'data/plugins/trends.json']) write(producer, name, name);
    for (const name of ['wrangler.jsonc', 'scripts/stage-static-assets.mjs']) {
      mkdirSync(path.dirname(path.join(producer, name)), { recursive: true }); cpSync(path.join(root, name), path.join(producer, name));
    }
    write(producer, '.private/internal.json', 'never public');
    git(producer, 'add', '.'); git(producer, 'commit', '-m', 'old'); git(producer, 'remote', 'add', 'origin', bare);
    git(producer, 'push', '-u', 'origin', 'main'); git(dir, 'clone', '--branch', 'main', bare, old);
    write(producer, 'index.html', 'new digest'); git(producer, 'add', 'index.html'); git(producer, 'commit', '-m', 'new'); git(producer, 'push');
    const sha = git(producer, 'rev-parse', 'HEAD');
    writeFileSync(path.join(bin, 'npx'), `#!/bin/sh
set -eu
printf '%s\\n' "$@" > "$CAPTURE/args"
cp "$5" "$CAPTURE/config.json"
cp -R "$(dirname "$5")/public" "$CAPTURE/public"
exit "\${UPLOAD_EXIT:-0}"
`, { mode: 0o755 });
    const env = { GITHUB_REF: 'refs/heads/main', PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, CAPTURE: capture, SITE_DEPLOY_TARGET: 'workers' };
    let r = run('bash', [script], old, env); assert.equal(r.status, 0, r.stderr);
    const config = JSON.parse(readFileSync(path.join(capture, 'config.json'), 'utf8'));
    assert.equal(config.name, 'tech-news-daily-site-preview'); assert.equal(config.workers_dev, true); assert.equal(config.preview_urls, false);
    assert.equal(readFileSync(path.join(capture, 'public/index.html'), 'utf8'), 'new digest');
    assert.equal(existsSync(path.join(capture, 'public/.private')), false); assert.equal(existsSync(path.join(capture, 'public/scripts')), false);
    assert.match(readFileSync(path.join(capture, 'args'), 'utf8'), new RegExp(`preview main ${sha}`));
    assert.equal(readFileSync(path.join(capture, 'args'), 'utf8').split('\n')[1], 'wrangler@4.148.0');
    rmSync(path.join(capture, 'public'), { recursive: true });
    r = run('bash', [script], old, { ...env, UPLOAD_EXIT: '17' }); assert.equal(r.status, 17, r.stderr);
    assert.doesNotMatch(r.stdout, /pages deploy/);
    const normal = JSON.parse(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
    for (const extra of [{ routes: ['example.invalid/*'] }, { triggers: { crons: ['* * * * *'] } }, { main: 'index.mjs' }, { vars: { TEST: 'binding' } }, { assets: { directory: '.' } }]) {
      write(producer, 'wrangler.jsonc', JSON.stringify({ ...normal, ...extra }));
      git(producer, 'add', 'wrangler.jsonc'); git(producer, 'commit', '-m', 'unsafe config'); git(producer, 'push');
      rmSync(path.join(capture, 'args'), { force: true });
      r = run('bash', [script], old, env); assert.notEqual(r.status, 0); assert.match(r.stderr, /reviewed assets-only/);
      assert.equal(existsSync(path.join(capture, 'args')), false);
    }
  } finally { rmSync(dir, { recursive: true }); }
});

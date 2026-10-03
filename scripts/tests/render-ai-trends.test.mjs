import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'render-ai-trends.mjs');
const FIXTURES = path.join(HERE, 'fixtures', 'ai-trends');
const KEYS = ['2026-08-01', '2026-08-03', '2026-W30'];

const tmpDirs = [];
function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function run(dataDir, outDir) {
  return spawnSync(process.execPath, [SCRIPT, '--data-dir', dataDir, '--out-dir', outDir], { encoding: 'utf8' });
}

let out;
let result;
let latest;

before(() => {
  out = tmp('render-ai-trends-out-');
  result = run(FIXTURES, out);
  latest = readFileSync(path.join(out, 'ai-trends.html'), 'utf8');
});
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

test('fixture から ai-trends.html と全キーの号ページが生成され exit 0', () => {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(path.join(out, 'ai-trends.html')));
  for (const k of KEYS) assert.ok(existsSync(path.join(out, 'ai-trends', `${k}.html`)), k);
  assert.deepEqual(readdirSync(path.join(out, 'ai-trends')).sort(), KEYS.map((k) => `${k}.html`));
});

test('最新号 2026-08-03 が描画され、週キー 2026-W30 は日付キーより前に並ぶ', () => {
  assert.match(latest, /XSS .*タイトル/);
  assert.match(latest, /2026-08-03 発行/);
  // 過去号リストは新しい順: 2026-08-01 の次に 2026-W30
  const iDate = latest.indexOf('<span class="week">2026-08-01</span>');
  const iWeek = latest.indexOf('<span class="week">2026-W30</span>');
  assert.ok(iDate !== -1 && iWeek !== -1);
  assert.ok(iDate < iWeek);
});

test('<script> は生で出力されず escape される', () => {
  for (const html of [latest, readFileSync(path.join(out, 'ai-trends', '2026-08-03.html'), 'utf8')]) {
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
    assert.ok(html.includes('&lt;script&gt;alert(3)&lt;/script&gt;'));
  }
});

test('http:// の URL は href に出ず、https の example / quick_pick は残る', () => {
  assert.ok(!latest.includes('http://'));
  assert.ok(!latest.includes('insecure.example.com'));
  assert.ok(!latest.includes('Insecure pick'));
  assert.ok(!latest.includes('Insecure-product'));
  assert.ok(latest.includes('href="https://example.com/2026-08-03/example"'));
  assert.ok(latest.includes('href="https://example.com/2026-08-03/pick"'));
});

test('空の data dir では exit 0 で placeholder のみ生成される', () => {
  const data = tmp('render-ai-trends-empty-');
  const o = tmp('render-ai-trends-out-');
  const r = run(data, o);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(o), ['ai-trends.html']);
  assert.ok(!existsSync(path.join(o, 'ai-trends')));
  assert.match(readFileSync(path.join(o, 'ai-trends.html'), 'utf8'), /準備中/);
});

test('存在しない data dir の現挙動（実測固定）: exit 0・警告なし・placeholder のみ', () => {
  const missing = path.join(tmp('render-ai-trends-missing-'), 'does-not-exist');
  const o = tmp('render-ai-trends-out-');
  const r = run(missing, o);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, '[render-ai-trends] no issues found — wrote placeholder ai-trends.html\n');
  assert.deepEqual(readdirSync(o), ['ai-trends.html']);
  assert.match(readFileSync(path.join(o, 'ai-trends.html'), 'utf8'), /準備中/);
});

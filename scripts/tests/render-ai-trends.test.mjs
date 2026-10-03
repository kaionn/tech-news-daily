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

// ---- OGP / Twitter Card ----------------------------------------------------------

function metaLines(html) {
  return html.split('\n').filter((l) => /^<meta (property|name)="(?!viewport)/.test(l));
}
function metaContent(html, key) {
  const line = metaLines(html).find((l) => l.includes(`="${key}" `));
  assert.ok(line, `meta ${key} が無い`);
  const m = /^<meta (?:property|name)="[^"]+" content="([^"]*)">$/.exec(line);
  assert.ok(m, `meta ${key} の形式が不正: ${line}`);
  return m[1];
}
function unescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
const readIssuePage = (k) => readFileSync(path.join(out, 'ai-trends', `${k}.html`), 'utf8');

test('og:title は最新号タイトルの escape 済み表現を含み、<title> は変わらない', () => {
  const title = metaContent(latest, 'og:title');
  assert.equal(title, 'XSS &lt;script&gt;alert(1)&lt;/script&gt; &quot;引用&quot; タイトル | AI プロダクト動向');
  assert.ok(latest.includes('<title>AI プロダクト動向 | Tech News Daily</title>'));
  assert.equal(metaContent(latest, 'og:type'), 'article');
  assert.equal(metaContent(latest, 'og:site_name'), 'Tech News Daily');
  assert.equal(metaContent(latest, 'twitter:card'), 'summary');
});

test('og:url は最新ページと号ページで異なる（週キーはそのまま）', () => {
  assert.equal(metaContent(latest, 'og:url'), 'https://tech-news.kaion-lab.com/ai-trends.html');
  assert.equal(metaContent(readIssuePage('2026-08-03'), 'og:url'), 'https://tech-news.kaion-lab.com/ai-trends/2026-08-03.html');
  assert.equal(metaContent(readIssuePage('2026-W30'), 'og:url'), 'https://tech-news.kaion-lab.com/ai-trends/2026-W30.html');
});

test('og:description は 120 文字以下で、タグ除去・「…」切り詰め・description 同値', () => {
  const desc = unescape(metaContent(latest, 'og:description'));
  assert.ok(desc.length <= 120, `length=${desc.length}`);
  assert.ok(desc.endsWith('…'));
  assert.ok(desc.startsWith('2026-08-03 のリード文'));
  assert.ok(!desc.includes('<b>'));
  assert.equal(metaContent(latest, 'description'), metaContent(latest, 'og:description'));
  // 短い lede は切らずそのまま
  assert.equal(metaContent(readIssuePage('2026-08-01'), 'og:description'), '2026-08-01 のリード文');
});

test('og:image は https の絶対 URL', () => {
  for (const html of [latest, readIssuePage('2026-08-01')]) {
    assert.match(metaContent(html, 'og:image'), /^https:\/\/[^/]+\/apple-touch-icon\.png$/);
  }
});

test('メタタグの属性値は escape され、生の <script> も content の閉じ漏れも無い', () => {
  for (const html of [latest, readIssuePage('2026-08-03')]) {
    const lines = metaLines(html);
    assert.ok(lines.length >= 8);
    for (const l of lines) {
      assert.match(l, /^<meta (?:property|name)="[a-z:_]+" content="[^"<>]*">$/, l);
      assert.ok(!l.includes('<script>'));
    }
    assert.ok(lines.some((l) => l.includes('&lt;script&gt;alert(1)&lt;/script&gt;')));
    assert.ok(lines.some((l) => l.includes('&quot;引用&quot;')));
  }
});

test('placeholder ページにも最小の og:title / og:url が入る', () => {
  const o = tmp('render-ai-trends-out-');
  const r = run(tmp('render-ai-trends-empty-'), o);
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(path.join(o, 'ai-trends.html'), 'utf8');
  assert.equal(metaContent(html, 'og:title'), 'AI プロダクト動向 | Tech News Daily');
  assert.equal(metaContent(html, 'og:url'), 'https://tech-news.kaion-lab.com/ai-trends.html');
});

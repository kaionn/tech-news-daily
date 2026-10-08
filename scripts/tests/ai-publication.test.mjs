import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { newState, observe, resolveIssue, issueDate, scheduledIssue, validateIssue, verifyPages, checkPublication, fetchText, withState } from '../ai-publication.mjs';
import { generationMode } from '../ai-generation-guard.mjs';
const issue = '2026-10-06';
const raw = { issue, generated_at: '1999-01-01T00:00:00Z', theme: { title: 'Theme', sections: [{ heading: 'Pattern', body_html: '<p>Actual article body</p>', examples: [{ product: 'Example', approach: 'Uses a pattern', source_url: 'https://example.com/article' }] }] }, quick_picks: [] };
function html(date = issue, body = 'Actual article body') {
  return `<html><body><header><p class="date">${date} 発行（読了 1 分）</p></header><div class="theme-hero"><h2>Theme</h2></div><div class="section"><div class="section-title">Pattern</div><div class="theme-section"><p>${body}</p><div class="example"><div class="product">Example</div><div class="approach">Uses a pattern</div><a href="https://example.com/article">source</a></div></div></div><footer>footer</footer></body></html>`;
}
const now = s => new Date(`${issue}T${s}+09:00`);
function obs(s, time, published) { return observe(s, { issue, now: now(time), published }); }
const response = value => new Response(value, { status: 200 });

test('JST schedule boundaries, delayed runner and rerun use immutable creation date', () => {
  assert.equal(resolveIssue({ event: 'schedule', createdAt: '2026-10-05T22:00:00Z' }), issue);
  assert.equal(resolveIssue({ event: 'schedule', createdAt: '2026-10-06T03:00:00Z' }), issue);
  assert.equal(resolveIssue({ event: 'schedule', createdAt: '2026-10-06T22:00:00Z' }), issue);
  assert.equal(resolveIssue({ event: 'schedule', createdAt: '2026-10-05T21:59:59Z' }), '2026-10-03');
  assert.equal(resolveIssue({ event: 'workflow_dispatch', createdAt: '2026-10-07T01:00:00Z', requested: issue }), issue);
  assert.throws(() => resolveIssue({ event: 'workflow_dispatch', createdAt: '2026-10-05T00:00:00Z', requested: issue }), /future/);
  assert.throws(() => resolveIssue({ event: 'workflow_dispatch', createdAt: '2026-10-07T00:00:00Z' }));
  for (const bad of ['2026-02-31', '2026-10-07', '../secrets', '2026-10-06\n']) assert.throws(() => issueDate(bad));
  assert.equal(scheduledIssue(new Date('2026-12-31T23:00:00Z')), '2026-12-31');
});

test('10:30 deadline fails without any run evidence, not a second early; late recovery preserves failure', () => {
  let r = obs(newState(issue), '10:29:59', false);
  assert.equal(r.status, 'pending'); assert.equal(r.pending.length, 0);
  r = obs(r.state, '10:30:00', false);
  assert.equal(r.status, 'deadline_missed'); assert.equal(r.pending[0].id, `ai-trends:${issue}:failure`);
  r = obs(r.state, '11:01:00', false);
  assert.equal(r.state.events.length, 1);
  r = obs(r.state, '11:07:00', true);
  assert.equal(r.status, 'late_recovery'); assert.equal(r.state.events.length, 2);
  r = obs(r.state, '12:00:00', true);
  r = obs(r.state, '13:00:00', false);
  assert.equal(r.state.events.length, 2); // one failure and one recovery per issue
});

test('inclusive deadline, persisted on-time evidence, first late positive is unknown, not fabricated recovery', () => {
  const r = obs(newState(issue), '10:30:00', true);
  assert.equal(r.status, 'on_time');
  assert.equal(obs(r.state, '11:00:00', true).status, 'on_time');
  const late = obs(newState(issue), '11:07:00', true);
  assert.equal(late.status, 'published_deadline_unknown'); assert.equal(late.pending.length, 0);
  assert.throws(() => obs(r.state, '10:00:00', true), /backwards/);
  const other = newState('2026-10-08'); assert.throws(() => obs(other, '11:00:00', false), /state/);
});

test('old HTTP200, date in metadata only, empty/truncated content, mismatch all fail; generated_at never proves publication', () => {
  verifyPages(html(), html(), issue, raw);
  for (const bad of [html('2026-10-03'), html().replace('<p class="date">', '<p class="other">'), html(issue, ' '), html(issue, '<!--Body-->'), html(issue, '&nbsp;'), html(issue, '<script>text</script>'), html().replace('</html>', '')]) {
    assert.throws(() => verifyPages(bad, bad, issue));
  }
  assert.throws(() => verifyPages(html(), html(issue, 'Different article'), issue), /mismatch/);
  assert.throws(() => verifyPages(html(), html(), issue, { ...raw, theme: { ...raw.theme, title: 'Different title' } }), /title mismatch/);
  assert.throws(() => validateIssue({ ...raw, issue: '2026-10-08' }, issue));
});

test('actual bounded HTTP text is checked; unavailable site fails even with successful Actions/LLM metadata', async () => {
  const good = await checkPublication({ issue, fetcher: async () => response(html()) });
  assert.equal(good.published, true);
  for (const fetcher of [async () => response(html('2026-10-03')), async () => new Response('missing', { status: 404 }), async () => { throw Error('network timeout'); }]) {
    assert.equal((await checkPublication({ issue, fetcher })).published, false);
  }
  await assert.rejects(fetchText('https://example.com', async () => response('x'.repeat(2 * 1024 * 1024 + 1))), /2MiB/);
  await assert.rejects(checkPublication({ issue, site: 'http://localhost' }), /HTTPS/);
});

test('normal JSON generation is skipped/reused across late natural run; corrupt JSON is never overwritten', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-generation-'));
  try {
    await mkdir(path.join(root, 'data/ai-trends'), { recursive: true });
    const check = async () => ({ published: false });
    assert.equal(await generationMode({ issue, root, check }), 'generate');
    assert.equal(await generationMode({ issue, root, check: async () => ({ published: true }) }), 'skip');
    const file = path.join(root, `data/ai-trends/${issue}.json`);
    await writeFile(file, JSON.stringify(raw));
    assert.equal(await generationMode({ issue, root, check }), 'render');
    assert.equal(await generationMode({ issue, root, check: async ({expected}) => ({ published: expected.issue === issue }) }), 'skip');
    assert.equal(await readFile(file, 'utf8'), JSON.stringify(raw));
    await writeFile(file, '{broken');
    await assert.rejects(generationMode({ issue, root, check }), /must not be overwritten/);
    await assert.rejects(generationMode({ issue: '../secret', root, check }), /date/);
  } finally { await rm(root, { recursive: true }); }
});

test('durable outbox survives restart/send failure; ack is persisted, concurrent writers/invalid state fail closed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-monitor-'));
  const file = path.join(dir, 'state.json');
  try {
    let r = await withState(file, issue, async s => obs(s, '10:30:00', false));
    const id = r.pending[0].id;
    r = await withState(file, issue, async s => obs(s, '10:35:00', false));
    assert.equal(r.pending.length, 1); assert.equal(r.pending[0].id, id);
    await withState(file, issue, async state => { state.events[0].acked = true; return { state }; });
    r = await withState(file, issue, async s => obs(s, '11:07:00', true));
    assert.equal(r.pending.length, 1); assert.equal(r.pending[0].kind, 'recovery');
    await mkdir(`${file}.lock`);
    await assert.rejects(withState(file, issue, async s => obs(s, '11:08:00', true)), { code: 'EEXIST' });
    await rm(`${file}.lock`, { recursive: true });
    const saved = await readFile(file, 'utf8');
    await assert.rejects(withState(file, '2026-10-08', async state => ({ state })), /state/);
    assert.equal(await readFile(file, 'utf8'), saved);
    await writeFile(file, '{bad');
    await assert.rejects(withState(file, issue, async state => ({ state })));
    assert.equal(await readFile(file, 'utf8'), '{bad');
  } finally { await rm(dir, { recursive: true }); }
});

test('CLI refuses unknown args, bad dates, premature/unknown ack without making HTTP requests', () => {
  for (const args of [['check','--unknown','x'], ['check','--issue','2026-02-31'], ['ack','--issue',issue]]) {
    const r = spawnSync(process.execPath, ['scripts/ai-publication.mjs', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
  }
});


test('real renderer top and permalink satisfy body/date/JSON checks without layout changes', () => {
  const top = readFileSync('ai-trends.html', 'utf8');
  const article = readFileSync(`ai-trends/${issue}.html`, 'utf8');
  const expected = JSON.parse(readFileSync(`data/ai-trends/${issue}.json`, 'utf8'));
  assert.equal(verifyPages(top, article, issue, expected), true);
});


test('Cloudflare canonical redirects preserve origin/cache bypass; foreign redirects and loops fail', async () => {
  const urls = [];
  const fetcher = async url => {
    urls.push(String(url));
    return String(url).includes('.html') ? new Response('', { status: 308, headers: { location: new URL(url).pathname.replace('.html', '') } }) : response(html());
  };
  assert.equal((await checkPublication({ issue, fetcher })).published, true);
  assert.ok(urls.every(u => u.includes('publication_check=')));
  await assert.rejects(fetchText('https://example.com', async () => new Response('', { status: 302, headers: { location: 'https://other.example/' } })), /cross-origin/);
  await assert.rejects(fetchText('https://example.com', async () => new Response('', { status: 308, headers: { location: '/' } })), /too many/);
});


test('a recovered past issue remains verifiable through the newer top archive listing', async () => {
  const old = '2026-10-03';
  const top = readFileSync('ai-trends.html', 'utf8'), article = readFileSync(`ai-trends/${old}.html`, 'utf8');
  const expected = JSON.parse(readFileSync(`data/ai-trends/${old}.json`, 'utf8'));
  assert.equal(verifyPages(top, article, old, expected), true);
  assert.throws(() => verifyPages(top.replace(`ai-trends/${old}.html`, 'ai-trends/missing.html'), article, old, expected), /archive/);
  assert.throws(() => verifyPages(top.replace(expected.theme.title, 'mismatched title'), article, old, expected), /archive/);
  const failed = observe(newState(old), { issue: old, now: new Date(`${old}T10:30:00+09:00`), published: false }).state;
  const publication = await checkPublication({ issue: old, expected, fetcher: async url => response(String(url).includes(`/${old}.html`) ? article : top) });
  assert.equal(observe(failed, { issue: old, now: new Date('2026-10-06T11:07:00+09:00'), ...publication }).status, 'late_recovery');
});
test('bad timeline or outbox/state timestamp mismatch is rejected, never reported on time', () => {
  const bad = newState(issue); bad.onTimeAt = `${issue}T11:00:00+09:00`;
  assert.throws(() => obs(bad, '12:00:00', false), /timeline/);
  const failed = obs(newState(issue), '10:30:00', false).state;
  failed.events[0].observed_at = '2026-10-06T01:31:00.000Z';
  assert.throws(() => obs(failed, '12:00:00', false), /event/);
});


test('source-free JSON and URLs renderer/publication cannot agree on are not normal reusable issues', async () => {
  const empty = structuredClone(raw); empty.theme.sections.forEach(s => s.examples = []); empty.quick_picks = [];
  assert.throws(() => validateIssue(empty, issue), /source/);
  for (const bad of ['https://example.com/a b','HTTPS://example.com/article','https://example.com/"bad','https://example.com/<bad>','https://user:pass@example.com/article',' https://example.com/article']) {
    const changed = structuredClone(raw); changed.theme.sections[0].examples[0].source_url = bad;
    assert.throws(() => validateIssue(changed,issue), /example/);
  }
  const root = await mkdtemp(path.join(os.tmpdir(),'ai-source-free-'));
  try {
    await mkdir(path.join(root,'data/ai-trends'),{recursive:true});
    await writeFile(path.join(root,`data/ai-trends/${issue}.json`), JSON.stringify(empty));
    await assert.rejects(generationMode({issue,root,check:async()=>({published:false})}), /must not be overwritten.*source/);
  } finally { await rm(root,{recursive:true}); }
  const quickOnly = structuredClone(empty); quickOnly.quick_picks = [{title:'Primary',url:'https://example.com/article'}];
  assert.equal(validateIssue(quickOnly,issue),quickOnly);
});

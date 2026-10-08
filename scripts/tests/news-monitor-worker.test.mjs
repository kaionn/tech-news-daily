import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPublication, newState, observe } from '../ai-publication-core.mjs';
import { runTick, currentIssue, minuteWindow, shouldTick, TARGET, LIMITS } from '../../workers/news-monitor/monitor.mjs';

const issue = '2026-10-08';
const env = { SLACK_TEAM_ID: TARGET.team, SLACK_CHANNEL_ID: TARGET.channel, SLACK_BOT_TOKEN: 'synthetic-test-value' };
const at = time => new Date(`${issue}T${time}+09:00`);
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
class Store {
  constructor(entries = []) { this.data = new Map(structuredClone(entries)); }
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  restart() { return new Store([...this.data]); }
}
function harness(store = new Store(), options = {}) {
  const posts = []; const calls = []; let publication = false;
  const fetcher = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).includes('/auth.test')) return json({ ok: true, bot_id: 'TESTBOT', team_id: options.team ?? TARGET.team });
    if (String(url).includes('/conversations.info')) return json({ ok: true, channel: { id: TARGET.channel, name: options.name ?? TARGET.name, is_archived: false, is_member: options.member ?? true } });
    if (String(url).includes('/chat.postMessage')) {
      const post = JSON.parse(init.body); posts.push(post);
      if (options.throwPost) throw Error('lost response');
      return options.postResponse?.() ?? json({ ok: true, channel: TARGET.channel, ts: '1.123' });
    }
    throw Error('unexpected HTTP');
  };
  return { store, posts, calls, publish(value = true) { publication = value; },
    async tick(now, extra = {}) { return runTick({ storage: store, env, scheduledTime: +now, now, clock: () => now,
      fetcher, check: async () => ({ published: publication }), ...extra }); } };
}
const failed = (i, date) => observe(newState(i), { issue: i, now: new Date(`${date}T10:30:00+09:00`), published: false }).state;

test('schedule covers JST due days and inclusive 10:30; off-window failures get five-minute ticks', () => {
  assert.equal(currentIssue(at('06:59:59')), null);
  assert.equal(currentIssue(at('07:00:00')), issue);
  assert.equal(currentIssue(new Date('2026-10-09T08:00:00+09:00')), null);
  assert.equal(minuteWindow(at('10:30:00')), true);
  assert.equal(minuteWindow(at('10:30:01')), false);
  assert.equal(shouldTick(+at('07:01:00')), true);
  assert.equal(shouldTick(+at('11:01:00')), false);
  assert.equal(shouldTick(+at('11:05:00')), true);
});
test('normal on-time publication is silent and stale/duplicate tick cannot generate failure', async () => {
  const h = harness(); h.publish();
  assert.equal((await h.tick(at('10:29:00'))).status, 'on_time');
  h.publish(false);
  assert.equal((await h.tick(at('10:30:00'))).status, 'idle');
  assert.equal((await h.tick(at('10:29:00'))).status, 'duplicate');
  assert.equal(h.calls.length, 0); assert.equal(h.posts.length, 0);
});
test('deadline failure and delayed recovery each post once with preserved state across restart', async () => {
  const h = harness(); await h.tick(at('10:29:00'));
  assert.equal(h.posts.length, 0);
  assert.equal((await h.tick(at('10:30:00'))).status, 'deadline_missed');
  assert.equal(h.posts.length, 1); assert.match(h.posts[0].text, /公開期限超過/);
  await h.tick(at('10:30:00')); await h.tick(at('10:35:00')); assert.equal(h.posts.length, 1);
  const r = harness(h.store.restart()); r.publish();
  assert.equal((await r.tick(at('11:05:00'))).status, 'late_recovery');
  assert.equal(r.posts.filter(p => p.text.includes('期限超過後の公開復旧')).length, 1);
  await r.tick(at('11:10:00'));
  const state = await r.store.get(`issue:${issue}`);
  assert.equal(state.events.length, 2); assert.ok(state.events.every(e => e.acked));
  assert.ok(state.failedAt); assert.ok(state.recoveredAt);
});
test('first positive after deadline reports monitoring uncertainty, never fabricated issue failure/recovery', async () => {
  const h = harness(); h.publish();
  assert.equal((await h.tick(at('11:00:00'))).status, 'published_deadline_unknown');
  await h.tick(at('11:05:00'));
  assert.equal(h.posts.length, 1); assert.match(h.posts[0].text, /deadline_observation_unknown/);
  assert.equal((await h.store.get(`issue:${issue}`)).events.length, 0);
});
test('wrong configured/workspace/channel target or missing bot prevents all posts', async () => {
  for (const options of [{ team: 'OTHER' }, { name: 'another-channel' }, { member: false }]) {
    const h = harness(new Store(), options); await h.tick(at('10:30:00')); assert.equal(h.posts.length, 0);
  }
  for (const config of [{ ...env, SLACK_TEAM_ID: 'OTHER' }, { ...env, SLACK_CHANNEL_ID: 'OTHER' }, { ...env, SLACK_BOT_TOKEN: '' }]) {
    const h = harness(); await h.tick(at('10:30:00'), { env: config }); assert.equal(h.calls.length, 0);
  }
});
test('lost Slack response suppresses resend across restart and holds recovery behind unknown failure', async () => {
  const h = harness(new Store(), { throwPost: true }); await h.tick(at('10:30:00'));
  assert.equal((await h.store.get(`delivery:ai-trends:${issue}:failure`)).status, 'unknown');
  const r = harness(h.store.restart()); r.publish();
  await r.tick(at('10:35:00')); await r.tick(at('10:40:00'));
  assert.equal(r.posts.length, 0);
  assert.equal((await r.store.get(`issue:${issue}`)).events.length, 2);
  assert.equal((await r.store.get(`issue:${issue}`)).events[0].acked, false);
});
test('crash after remote acceptance but before sent-state persist leaves attempt durable and suppresses resend', async () => {
  const store = new Store(); const put = store.put.bind(store);
  store.put = async (key, value) => {
    if (key === `delivery:ai-trends:${issue}:failure` && value.status === 'sent') throw Error('simulated persistence interruption');
    return put(key, value);
  };
  const h = harness(store); await h.tick(at('10:30:00'));
  assert.equal((await store.get(`delivery:ai-trends:${issue}:failure`)).status, 'attempting');
  const r = harness(store.restart()); await r.tick(at('10:35:00'));
  assert.equal(r.posts.filter(p => p.text.includes('公開期限超過')).length, 0);
});
test('malformed, oversized, wrong-channel and server-error Slack responses are not acknowledged or resent', async () => {
  for (const postResponse of [() => new Response('not-json'), () => new Response('x'.repeat(16385)),
    () => json({ ok: true, channel: 'OTHER', ts: '1' }), () => new Response('error', { status: 500 }),
    () => json({ ok: false, error: 'not_in_channel' })]) {
    const h = harness(new Store(), { postResponse }); await h.tick(at('10:30:00'));
    const r = harness(h.store.restart()); await r.tick(at('10:35:00'));
    assert.equal((await r.store.get(`issue:${issue}`)).events[0].acked, false);
    assert.equal(r.posts.filter(p => p.text.includes('公開期限超過')).length, 0);
  }
});
test('UTC daily observation/tick/send caps stop safely without erasing state or upgrading plan', async () => {
  for (const dimension of ['observations', 'ticks', 'sends']) {
    const h = harness(); await h.tick(at('07:00:00'));
    const m = await h.store.get('meta'); m.daily[dimension] = LIMITS[dimension]; await h.store.put('meta', m);
    let checks = 0;
    const result = await h.tick(at('07:01:00'), { check: async () => { checks++; return { published: false }; } });
    assert.ok(['daily_budget_exhausted', 'tick_budget_exhausted'].includes(result.status));
    assert.equal(checks, 0); assert.ok(await h.store.get(`issue:${issue}`));
  }
});
test('retention cap halts, corrupt metadata/state and backwards clocks fail closed', async () => {
  const h = harness(); await h.tick(at('07:00:00'));
  let m = await h.store.get('meta'); m.active = []; m.issueCount = LIMITS.issues;
  await h.store.put('meta', m); h.store.data.delete(`issue:${issue}`);
  assert.equal((await h.tick(at('07:01:00'))).status, 'halted');
  m = await h.store.get('meta'); m.version = 999; await h.store.put('meta', m);
  await assert.rejects(h.tick(at('07:02:00')), /metadata/);
  const b = harness(); await b.tick(at('07:00:00'));
  await assert.rejects(b.tick(at('06:59:00'), { scheduledTime: +at('07:01:00') }), /backwards/);
  await b.store.put(`issue:${issue}`, { version: 999 }); await assert.rejects(b.tick(at('07:01:00')), /state/);
});
test('failed issue remains active across new issue/date, then receives delayed recovery observation', async () => {
  const h = harness(); await h.tick(at('10:30:00'));
  const saturday = new Date('2026-10-10T07:00:00+09:00'); await h.tick(saturday);
  assert.deepEqual((await h.store.get('meta')).active, [issue, '2026-10-10']);
  h.publish(); let checked;
  await h.tick(new Date('2026-10-10T11:00:00+09:00'), { check: async ({ issue }) => { checked = issue; return { published: true }; } });
  assert.equal(checked, issue); assert.ok((await h.store.get(`issue:${issue}`)).recoveredAt);
});
test('real HTML core works without Buffer and retains old-HTTP200/mismatched-body red probes', async () => {
  const top = readFileSync(new URL('../../ai-trends.html', import.meta.url), 'utf8');
  const article = readFileSync(new URL(`../../ai-trends/${issue}.html`, import.meta.url), 'utf8');
  for (const [body, expected] of [[article, true], [article.replace('発行（', 'invalid（'), false], [article.replace('<h2>', '<h2>mismatch'), false]]) {
    const result = await checkPublication({ issue, fetcher: async url => new Response(String(url).includes(`${issue}.html`) ? body : top) });
    assert.equal(result.published, expected);
  }
});
test('SQLite migration, single binding and no public routes/Worker logs billing are explicit', () => {
  const config = JSON.parse(readFileSync(new URL('../../workers/news-monitor/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.migrations[0].new_sqlite_classes, ['NewsMonitor']);
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  assert.deepEqual(config.triggers.crons, ['* * * * *']);
  assert.equal(config.observability.enabled, false);
});

test('same-day config or credential identity change must be revalidated before recovery post', async () => {
  const h = harness(); await h.tick(at('10:30:00')); h.publish();
  await h.tick(at('10:35:00'), { env: { ...env, SLACK_TEAM_ID: 'OTHER' } });
  assert.equal(h.posts.length, 1);
  const r = harness(h.store.restart(), { team: 'OTHER' }); r.publish(); await r.tick(at('10:40:00'));
  assert.equal(r.posts.length, 0); assert.equal((await r.store.get(`issue:${issue}`)).events[1].acked, false);
});
test('sent delivery with missing time/timestamp is corrupt and cannot acknowledge issue event', async () => {
  const h = harness(); await h.tick(at('10:30:00')); h.publish();
  await h.store.put(`delivery:ai-trends:${issue}:recovery`, { id: `ai-trends:${issue}:recovery`, status: 'sent' });
  await h.tick(at('10:35:00'));
  assert.equal((await h.store.get(`issue:${issue}`)).events[1].acked, false);
  assert.equal(h.posts.filter(p => p.text.includes('期限超過後の公開復旧')).length, 0);
});
test('unconfirmed health state survives UTC date rollover even without a Slack credential', async () => {
  const h = harness();
  for (const t of ['2026-10-08T23:45:00Z', '2026-10-08T23:55:00Z', '2026-10-09T00:00:00Z']) await h.tick(new Date(t), { env: {} });
  assert.ok((await h.store.get('meta')).health.tick_late_or_gap.firstAt);
  assert.equal((await h.store.get('meta')).health.tick_late_or_gap.notifiedDay, '2026-10-08');
  assert.equal(h.posts.length, 0);
});

test('Slack timeout preserves unknown attempt and suppresses automatic retry', async () => {
  const h = harness(); let timedOut = 0;
  const fetcher = async (url, init) => {
    if (!String(url).includes('chat.postMessage')) return String(url).includes('auth.test')
      ? json({ ok: true, bot_id: 'TESTBOT', team_id: TARGET.team })
      : json({ ok: true, channel: { id: TARGET.channel, name: TARGET.name, is_archived: false, is_member: true } });
    return new Promise((resolve, reject) => {
      const guard = setTimeout(() => reject(Error('test guard: abort missing')), 3000);
      init.signal.addEventListener('abort', () => { clearTimeout(guard); timedOut++; reject(init.signal.reason); }, { once: true });
    });
  };
  await h.tick(at('10:30:00'), { fetcher });
  assert.ok(timedOut >= 1);
  assert.equal((await h.store.get(`delivery:ai-trends:${issue}:failure`)).status, 'unknown');
  const r = harness(h.store.restart()); await r.tick(at('10:35:00'));
  assert.equal(r.posts.filter(p => p.text.includes('公開期限超過')).length, 0);
});

test('Workers-compatible Slack fetch never follows redirects or sends credentials to redirect targets', async () => {
  const h = harness(); const paths = [];
  const fetcher = async (url, init) => {
    // Actual workerd rejects redirect:error before making the request.
    assert.equal(init.redirect, 'manual'); paths.push(new URL(url).pathname);
    if (String(url).includes('auth.test')) return json({ ok: true, bot_id: 'TESTBOT', team_id: TARGET.team });
    if (String(url).includes('conversations.info')) return json({ ok: true, channel: { id: TARGET.channel, name: TARGET.name, is_archived: false, is_member: true } });
    return new Response('', { status: 302, headers: { Location: 'https://foreign.invalid/collect' } });
  };
  await h.tick(at('10:30:00'), { fetcher });
  assert.equal((await h.store.get(`delivery:ai-trends:${issue}:failure`)).status, 'unknown');
  assert.ok(paths.includes('/api/chat.postMessage'));
  assert.ok(paths.every(p => p.startsWith('/api/')));
});

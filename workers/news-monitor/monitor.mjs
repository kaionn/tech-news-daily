import { checkPublication, deadline, issueDate, newState, observe, validateState } from '../../scripts/ai-publication-core.mjs';

// Resolved against the connected installation; never accept a channel name alone.
export const TARGET = Object.freeze({ team: 'T0C6EM7M70E', channel: 'C0C6CBVA5TM', name: 'ci-alerts' });
export const LIMITS = Object.freeze({ ticks: 1800, observations: 600, sends: 16, issues: 1000, active: 16, stateBytes: 8192 });
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const iso = now => now.toISOString();
const key = issue => `issue:${issue}`;
const day = now => iso(now).slice(0, 10); // Account free quotas reset in UTC.
export function currentIssue(now) {
  const local = new Date(+now + 9 * 3600000);
  return [2,4,6].includes(local.getUTCDay()) && local.getUTCHours() >= 7 ? local.toISOString().slice(0,10) : null;
}
export function minuteWindow(now) {
  const issue = currentIssue(now);
  return issue !== null && +now <= +deadline(issue);
}
export function shouldTick(scheduledTime) {
  const now = new Date(scheduledTime);
  return minuteWindow(now) || now.getUTCMinutes() % 5 === 0;
}
function freshMeta(now) {
  return { version: 1, lastScheduled: 0, lastTick: null, active: [], issueCount: 0, cursor: 0, halted: false, health: {},
    daily: { day: day(now), ticks: 0, observations: 0, sends: 0 } };
}
function validateMeta(m) {
  if (m.version !== 1 || !Number.isSafeInteger(m.lastScheduled) || m.lastScheduled < 0 ||
      (m.lastTick !== null && !Number.isFinite(Date.parse(m.lastTick))) || !Array.isArray(m.active) ||
      m.active.length > LIMITS.active || new Set(m.active).size !== m.active.length ||
      !Number.isSafeInteger(m.issueCount) || m.issueCount < 0 || m.issueCount > LIMITS.issues ||
      !Number.isSafeInteger(m.cursor) || m.cursor < 0 || typeof m.halted !== 'boolean' ||
      !m.health || Object.keys(m.health).length > 16 || !/^\d{4}-\d{2}-\d{2}$/.test(m.daily?.day) ||
      !['ticks','observations','sends'].every(k => Number.isSafeInteger(m.daily[k]) && m.daily[k] >= 0 && m.daily[k] <= LIMITS[k])) throw Error('invalid monitor metadata');
  for (const issue of m.active) issueDate(issue);
  for (const h of Object.values(m.health)) {
    if (!h || !Number.isFinite(Date.parse(h.firstAt)) || !Number.isFinite(Date.parse(h.lastAt)) || !/^\d{4}-\d{2}-\d{2}$/.test(h.notifiedDay)) throw Error('invalid health state');
  }
}
async function boundedJson(url, options, fetcher) {
  const signal = AbortSignal.timeout(2000);
  const response = await fetcher(url, { ...options, signal, redirect: 'manual' });
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 16384) { await reader.cancel(); throw Error('oversized Slack response'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const content = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length; }
  return { status: response.status, data: JSON.parse(new TextDecoder().decode(content)) };
}
function validateTarget(env) {
  if (env.SLACK_TEAM_ID !== TARGET.team || env.SLACK_CHANNEL_ID !== TARGET.channel || !env.SLACK_BOT_TOKEN) throw Error('notification configuration missing/mismatched');
}
async function verifyTarget(env, fetcher) {
  validateTarget(env);
  const headers = { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` };
  const auth = await boundedJson('https://slack.com/api/auth.test', { headers }, fetcher);
  if (auth.status !== 200 || auth.data.ok !== true || auth.data.team_id !== TARGET.team || !auth.data.bot_id) throw Error('Slack workspace/bot mismatch');
  const info = await boundedJson(`https://slack.com/api/conversations.info?channel=${TARGET.channel}`, { headers }, fetcher);
  const channel = info.data.channel;
  if (info.status !== 200 || info.data.ok !== true || channel?.id !== TARGET.channel || channel?.name !== TARGET.name || channel.is_archived !== false || channel.is_member !== true) throw Error('Slack channel/membership mismatch');
}
function message(event) {
  if (event.kind === 'health') return `ニュース公開監視の異常: ${event.code} (${event.id})。通常成功通知・自動復旧は行いません。`;
  const label = event.kind === 'failure' ? '公開期限超過' : '期限超過後の公開復旧';
  return `AI trends ${event.issue}: ${label}。期限10:30 JST、観測 ${event.observed_at}。https://tech-news.kaion-lab.com/ai-trends/${event.issue} (${event.id})`;
}

// storage is the SQLite-backed DO KV API. Callers serialize the entire tick.
export async function runTick({ storage, env, scheduledTime, now = new Date(), clock = () => new Date(), fetcher = fetch, check = checkPublication }) {
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 1 || !Number.isFinite(+now)) throw Error('invalid tick clock');
  let m = await storage.get('meta') ?? freshMeta(now); validateMeta(m);
  if (scheduledTime <= m.lastScheduled) return { status: 'duplicate' };
  if (m.lastTick && +now < Date.parse(m.lastTick)) throw Error('monitor clock moved backwards');
  if (day(now) < m.daily.day) throw Error('quota clock moved backwards');
  if (m.daily.day !== day(now)) {
    m.daily = { day: day(now), ticks: 0, observations: 0, sends: 0 };
  }
  // Persistent caps are lower than free limits; account-wide usage remains a deployment gate.
  if (m.daily.ticks >= LIMITS.ticks) return { status: 'tick_budget_exhausted' };
  m.daily.ticks++; m.lastScheduled = scheduledTime;
  const gap = m.lastTick ? +now - Date.parse(m.lastTick) : 0;
  m.lastTick = iso(now);
  await storage.put('meta', m);

  async function deliver(event) {
    validateTarget(env);
    const deliveryKey = `delivery:${event.id}`;
    const previous = await storage.get(deliveryKey);
    if (previous) {
      if (!['attempting','sent','unknown','rejected'].includes(previous.status) || previous.id !== event.id ||
          typeof previous.at !== 'string' || !Number.isFinite(Date.parse(previous.at)) || Date.parse(previous.at) > +now ||
          (previous.status === 'sent' && (typeof previous.ts !== 'string' || !/^\d+\.\d+$/.test(previous.ts)))) throw Error('invalid delivery state');
      return previous.status === 'sent'; // Crash during send is never automatically retried.
    }
    if (m.daily.sends >= LIMITS.sends) return false;
    await verifyTarget(env, fetcher); // Revalidate each send; never cache across token/config changes.
    m.daily.sends++; await storage.put('meta', m);
    // Persist before posting. Lost acknowledgement means suppressed resend, not exactly-once proof.
    await storage.put(deliveryKey, { id: event.id, status: 'attempting', at: iso(now) });
    let result;
    try {
      const response = await boundedJson('https://slack.com/api/chat.postMessage', {
        method: 'POST', headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: TARGET.channel, text: message(event), unfurl_links: false, unfurl_media: false }),
      }, fetcher);
      const data = response.data;
      result = response.status === 200 && data.ok === true && data.channel === TARGET.channel && typeof data.ts === 'string' && /^\d+\.\d+$/.test(data.ts)
        ? { status: 'sent', ts: data.ts }
        : { status: response.status === 200 && data.ok === false ? 'rejected' : 'unknown' };
    } catch { result = { status: 'unknown' }; }
    await storage.put(deliveryKey, { id: event.id, at: iso(now), ...result });
    return result.status === 'sent';
  }
  async function health(code) {
    if (m.health[code]?.notifiedDay === m.daily.day) return;
    m.health[code] = { firstAt: m.health[code]?.firstAt ?? iso(now), lastAt: iso(now), notifiedDay: m.daily.day }; await storage.put('meta', m);
    try { await deliver({ id: `monitor:${m.daily.day}:${code}`, kind: 'health', code }); }
    catch { /* No credentials or storage: keep health latched; logs provide the fallback. */ }
    console.error(JSON.stringify({ monitor_error: code, at: iso(now) }));
  }
  if (gap > 6 * 60000 || Math.abs(+now - scheduledTime) > 90000) await health('tick_late_or_gap');
  if (m.halted) return { status: 'halted' };
  if (m.daily.observations >= LIMITS.observations || m.daily.sends >= LIMITS.sends - 1) {
    await health('daily_budget_exhausted'); return { status: 'daily_budget_exhausted' };
  }
  const current = currentIssue(now);
  if (current && !m.active.includes(current)) {
    const old = await storage.get(key(current));
    if (old) validateState(old, current);
    if (!old?.onTimeAt && !old?.recoveredAt) {
      if (m.active.length >= LIMITS.active || (!old && m.issueCount >= LIMITS.issues)) {
        m.halted = true; await storage.put('meta', m); await health('retention_budget_exhausted'); return { status: 'halted' };
      }
      if (!old) m.issueCount++;
      m.active.push(current); await storage.put('meta', m);
    }
  }
  let issue;
  // Old failures wait during the minute-window, then rotate without being lost on date rollover.
  if (minuteWindow(now) && m.active.includes(current)) issue = current;
  else if (new Date(scheduledTime).getUTCMinutes() % 5 === 0 && m.active.length) issue = m.active[m.cursor++ % m.active.length];
  if (!issue) return { status: 'idle' };
  const state = await storage.get(key(issue)) ?? newState(issue); validateState(state, issue);
  if (bytes(state) > LIMITS.stateBytes) { m.halted = true; await storage.put('meta', m); await health('state_budget_exhausted'); return { status: 'halted' }; }
  m.daily.observations++; await storage.put('meta', m); // Budget is consumed before I/O, including failed I/O.
  const publication = await check({ issue, fetcher });
  // Use the completed observation time in production; tests inject their clock.
  const observedAt = clock();
  const result = observe(state, { issue, now: observedAt, published: publication.published, reason: publication.published ? 'public_pages_agree' : 'public_pages_not_verified' });
  await storage.put(key(issue), result.state);
  if (result.status === 'published_deadline_unknown') await health('deadline_observation_unknown');
  const event = result.pending[0]; // Only one post per observation, in failure-before-recovery order.
  if (event) {
    try {
      if (await deliver(event)) {
        result.state.events.find(e => e.id === event.id).acked = true;
        await storage.put(key(issue), result.state);
      } else await health('notification_delivery_unconfirmed');
    } catch { await health('notification_adapter_error'); }
  }
  if (result.state.onTimeAt || (result.state.recoveredAt && result.state.events.every(e => e.acked))) {
    m.active = m.active.filter(i => i !== issue);
  }
  await storage.put('meta', m);
  return { status: result.status, issue };
}

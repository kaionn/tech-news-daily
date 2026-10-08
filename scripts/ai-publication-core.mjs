// Shared public-page and issue-state contract; no filesystem, credentials or runtime imports.
export const SITE = 'https://tech-news.kaion-lab.com';
const LIMIT = 2 * 1024 * 1024;
const JST = 9 * 3600000;
const text = (s) => typeof s === 'string' && s.trim().length > 0;
export function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw Error('invalid zoned timestamp');
  return new Date(value);
}
export function issueDate(issue) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issue ?? '')) throw Error('invalid issue date');
  const d = new Date(`${issue}T00:00:00Z`);
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== issue || ![2, 4, 6].includes(d.getUTCDay())) throw Error('issue must be a real Tuesday/Thursday/Saturday');
  return d;
}
export function deadline(issue) { issueDate(issue); return new Date(`${issue}T10:30:00+09:00`); }
export function scheduledIssue(now) {
  const d = new Date(+now + JST);
  d.setUTCHours(0, 0, 0, 0);
  while (![2, 4, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
export function resolveIssue({ event, createdAt, requested }) {
  const created = instant(createdAt);
  let issue;
  if (event === 'schedule') issue = scheduledIssue(new Date(+created - 7 * 3600000));
  else if (event === 'workflow_dispatch') { issueDate(requested); issue = requested; }
  else throw Error('unsupported generation event');
  if (+issueDate(issue) > +new Date(new Date(+created + JST).toISOString().slice(0, 10))) throw Error('future issue is forbidden');
  return issue;
}
export function validateIssue(raw, issue) {
  issueDate(issue);
  if (raw?.issue !== issue || !text(raw.theme?.title) || !Array.isArray(raw.theme?.sections) || !raw.theme.sections.length) throw Error('invalid issue/title/sections');
  if (raw.theme.tldr !== undefined && (!Array.isArray(raw.theme.tldr) || raw.theme.tldr.some(t => !text(t)))) throw Error('invalid tldr');
  for (const s of raw.theme.sections) {
    if (!text(s.heading) || !text(visible(s.body_html)) || !Array.isArray(s.examples)) throw Error('invalid section body/examples');
    for (const e of s.examples) if (!text(e.product) || !text(e.approach) || !https(e.source_url)) throw Error('invalid example');
  }
  if (!Array.isArray(raw.quick_picks) || raw.quick_picks.some(q => !text(q.title) || !https(q.url))) throw Error('invalid quick picks');
  if (!raw.quick_picks.length && !raw.theme.sections.some(s => s.examples.length)) throw Error('at least one primary source is required');
  return raw;
}
function https(s) {
  if (typeof s !== 'string' || !/^https:\/\/[^\s"'<>]+$/.test(s)) return false;
  try { const u = new URL(s); return text(u.hostname) && !u.username && !u.password; } catch { return false; }
}
function visible(s) {
  return String(s ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '').replace(/&nbsp;|&#(?:160|x[aA]0);/g, ' ').replace(/\s+/g, ' ').trim();
}
function content(html, issue) {
  // This is the renderer's article region, excluding navigation/archive/footer.
  // Match only the visible header's date, never a date in links/metadata/body.
  const date = html.match(/<p class="date">([^<]+)<\/p>/)?.[1];
  if (!date?.startsWith(`${issue} 発行（`)) throw Error('wrong/missing visible issue date');
  if (!html.includes('</body>') || !html.includes('</html>')) throw Error('truncated page');
  const start = html.indexOf('<div class="theme-hero">');
  if (start < 0) throw Error('missing theme');
  const archive = html.indexOf('<div class="section">\n  <div class="section-title">📚 過去号', start);
  const end = archive >= 0 ? archive : html.indexOf('<footer>', start);
  if (end < 0) throw Error('incomplete article');
  const body = html.slice(start, end).trim();
  if (!text(visible(body.match(/<h2>([\s\S]*?)<\/h2>/)?.[1]))) throw Error('empty theme title');
  const sections = [...body.matchAll(/<div class="theme-section">\s*([\s\S]*?)(?=<div class="(?:example|takeaway)"|<\/div>)/g)];
  if (!sections.length || sections.length !== (body.match(/<div class="theme-section">/g) ?? []).length || sections.some(m => !text(visible(m[1])))) throw Error('missing/empty section body');
  if (!/href="https:\/\/[^"\s]+"/.test(body)) throw Error('missing primary source');
  return body.replace(/\r\n/g, '\n');
}
export function verifyPages(top, article, issue, expected) {
  issueDate(issue);
  const b = content(article, issue);
  const topIssue = top.match(/<p class="date">(\d{4}-\d{2}-\d{2}) 発行（/)?.[1];
  issueDate(topIssue);
  let a;
  if (topIssue > issue) {
    // After a newer issue is released, top must still list this permalink/title.
    content(top, topIssue);
    const title = b.match(/<h2>([\s\S]*?)<\/h2>/)[1];
    const entries = [...top.matchAll(/<div class="archive-item"><span class="week">([^<]+)<\/span><div class="body"><a href="([^"<>]+)">([\s\S]*?)<\/a>/g)];
    const match = entries.find(e => e[1] === issue);
    if (!match || ![`ai-trends/${issue}.html`, `ai-trends/${issue}`].includes(match[2]) || match[3] !== title) throw Error('top archive/permalink mismatch');
    a = b;
  } else a = content(top, issue);
  if (a !== b) throw Error('top/permalink article mismatch');
  if (expected) {
    validateIssue(expected, issue);
    // Compare JSON-derived text/links too; generated_at is deliberately ignored.
    const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    if (!a.includes(`<h2>${escape(expected.theme.title.trim())}</h2>`)) throw Error('JSON/public title mismatch');
    const escapedText = [expected.theme.lede, ...(expected.theme.tldr ?? []), expected.editorial, ...expected.theme.sections.flatMap(s => [s.takeaway, ...s.examples.flatMap(e => [e.product, e.approach, e.detail])]), ...expected.quick_picks.flatMap(q => [q.title, q.summary])].filter(text);
    if (escapedText.some(t => !a.includes(escape(t)))) throw Error('JSON/public article text mismatch');
    for (const q of expected.quick_picks) if (!a.includes(`href="${q.url}"`)) throw Error('JSON/public quick pick mismatch');
    for (const s of expected.theme.sections) {
      if (!a.includes(s.body_html) || !a.includes(escape(s.heading.trim()))) throw Error('JSON/public section mismatch');
      for (const e of s.examples) if (!a.includes(`href="${e.source_url}"`)) throw Error('JSON/public source mismatch');
    }
  }
  return true;
}
export async function fetchText(url, fetcher = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const initial = new URL(url);
    let current = initial, response;
    for (let hop = 0; hop <= 3; hop++) {
      response = await fetcher(current, { signal: controller.signal, redirect: 'manual', headers: { 'Cache-Control': 'no-cache', Accept: 'text/html,application/json' } });
      if (![301,302,303,307,308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hop === 3) throw Error('invalid/too many redirects');
      const next = new URL(location, current);
      if (next.origin !== initial.origin || next.username || next.password) throw Error('cross-origin redirect');
      // Cloudflare canonicalizes .html to extensionless paths; keep cache bypass.
      if (!next.search) next.search = initial.search;
      current = next;
    }
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    let length = 0; const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > LIMIT) { await reader.cancel(); throw Error('body exceeds 2MiB'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(bytes);
  } finally { clearTimeout(timeout); }
}
export async function checkPublication({ issue, site = SITE, expected, fetcher = fetch }) {
  issueDate(issue);
  const base = new URL(site);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw Error('site must be an HTTPS origin');
  try {
    const nonce = Date.now();
    const [top, article] = await Promise.all([
      fetchText(new URL(`ai-trends.html?publication_check=${nonce}`, base), fetcher),
      fetchText(new URL(`ai-trends/${issue}.html?publication_check=${nonce}`, base), fetcher),
    ]);
    verifyPages(top, article, issue, expected);
    return { published: true, reason: 'visible issue and article bodies agree' };
  } catch (error) { return { published: false, reason: error.message }; }
}
export function newState(issue) { issueDate(issue); return { version: 1, issue, lastObservedAt: null, onTimeAt: null, failedAt: null, recoveredAt: null, events: [] }; }
export function validateState(state, issue) {
  if (state?.version !== 1 || state.issue !== issue || !Array.isArray(state.events)) throw Error('invalid monitor state');
  for (const key of ['lastObservedAt', 'onTimeAt', 'failedAt', 'recoveredAt']) if (state[key] !== null) instant(state[key]);
  const stamp = key => state[key] === null ? null : +instant(state[key]);
  if ((state.onTimeAt && stamp('onTimeAt') > +deadline(issue)) ||
      (state.failedAt && stamp('failedAt') < +deadline(issue)) ||
      (state.onTimeAt && state.failedAt) ||
      (state.recoveredAt && (!state.failedAt || stamp('recoveredAt') < stamp('failedAt'))) ||
      ['onTimeAt','failedAt','recoveredAt'].some(k => state[k] && (!state.lastObservedAt || stamp(k) > stamp('lastObservedAt')))) throw Error('inconsistent state timeline');
  const ids = new Set();
  for (const e of state.events) {
    if (!['failure','recovery'].includes(e.kind) || e.id !== `ai-trends:${issue}:${e.kind}` || ids.has(e.id) || typeof e.acked !== 'boolean') throw Error('invalid outbox');
    instant(e.observed_at);
    if (e.issue !== issue || e.deadline !== deadline(issue).toISOString() || e.observed_at !== state[e.kind === 'failure' ? 'failedAt' : 'recoveredAt'] || typeof e.reason !== 'string') throw Error('inconsistent event');
    ids.add(e.id);
  }
  if (Boolean(state.failedAt) !== ids.has(`ai-trends:${issue}:failure`) || Boolean(state.recoveredAt) !== ids.has(`ai-trends:${issue}:recovery`) || (state.recoveredAt && !state.failedAt)) throw Error('inconsistent monitor state');
}
export function observe(previous, { issue, now, published, reason = '' }) {
  validateState(previous, issue);
  if (!Number.isFinite(+now) || typeof published !== 'boolean') throw Error('invalid observation');
  const s = structuredClone(previous), at = now.toISOString();
  if (s.lastObservedAt && +now < +instant(s.lastObservedAt)) throw Error('clock moved backwards');
  s.lastObservedAt = at;
  if (published && +now <= +deadline(issue) && !s.failedAt) s.onTimeAt ??= at;
  const event = kind => s.events.push({ id: `ai-trends:${issue}:${kind}`, kind, issue, deadline: deadline(issue).toISOString(), observed_at: at, reason, acked: false });
  if (!published && +now >= +deadline(issue) && !s.failedAt && !s.onTimeAt) { s.failedAt = at; event('failure'); }
  if (published && s.failedAt && !s.recoveredAt) { s.recoveredAt = at; event('recovery'); }
  const status = s.recoveredAt ? 'late_recovery' : s.failedAt ? 'deadline_missed' : s.onTimeAt ? 'on_time' : published ? 'published_deadline_unknown' : 'pending';
  return { state: s, status, pending: s.events.filter(e => !e.acked) };
}

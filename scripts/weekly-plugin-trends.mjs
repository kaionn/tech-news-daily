#!/usr/bin/env node
// Weekly plugin trends: collect GitHub stars + npm weekly downloads for a fixed
// watchlist, snapshot them per ISO week (JST), diff against history, and
// render trends.html in the approved v4 layout (tmp/mock-trends.html is the
// canonical structure/CSS source). No dependencies (Node 20+ built-in fetch
// only). See tmp/context.md for design background.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA_DIR = path.join(ROOT, 'data/plugins');
const DEFAULT_TRENDS_HTML_PATH = path.join(ROOT, 'trends.html');

const CATEGORY_ORDER = ['claude-code', 'mcp', 'ai-tool'];
const CATEGORY_TITLE = {
  'claude-code': 'Claude Code エコシステム',
  mcp: 'MCP サーバー / SDK',
  'ai-tool': 'AI コーディング CLI / 拡張',
};
const CATEGORY_BADGE = { 'claude-code': 'Claude Code', mcp: 'MCP', 'ai-tool': 'CLI' };
const LANGUAGE_TAG_CLASS = {
  Python: 'tag-python',
  TypeScript: 'tag-ts',
  JavaScript: 'tag-js',
  Go: 'tag-go',
  Rust: 'tag-rust',
  Ruby: 'tag-ruby',
};
const LANGUAGE_TAG_LABEL = { TypeScript: 'TS' };

// ---- args --------------------------------------------------------------------

function parseArgs(argv) {
  const args = { renderOnly: false, dataDir: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--render-only') args.renderOnly = true;
    else if (a === '--data-dir') args.dataDir = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

// ---- date / week ---------------------------------------------------------------

function jstNow() {
  // Shift to JST wall-clock time, then read back with UTC getters so the
  // calendar date is JST regardless of the runner's local timezone.
  const now = new Date();
  return new Date(now.getTime() + 9 * 3600 * 1000);
}

function isoWeekKey(shiftedDate) {
  const d = new Date(Date.UTC(shiftedDate.getUTCFullYear(), shiftedDate.getUTCMonth(), shiftedDate.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0 .. Sunday = 6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 24 * 3600 * 1000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function jstDateLabel(isoString) {
  const shifted = new Date(new Date(isoString).getTime() + 9 * 3600 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---- io --------------------------------------------------------------------

async function loadJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function loadWatchlist(dataDir) {
  const local = path.join(dataDir, 'watchlist.json');
  const fallback = path.join(DEFAULT_DATA_DIR, 'watchlist.json');
  const target = existsSync(local) ? local : fallback;
  return loadJson(target);
}

async function loadAllSnapshots(snapshotsDir) {
  if (!existsSync(snapshotsDir)) return [];
  const files = (await readdir(snapshotsDir)).filter((f) => f.endsWith('.json')).sort();
  const snapshots = [];
  for (const f of files) snapshots.push(await loadJson(path.join(snapshotsDir, f)));
  return snapshots.sort((a, b) => a.week.localeCompare(b.week));
}

async function loadRising(dataDir, week) {
  const p = path.join(dataDir, 'rising', `${week}.json`);
  if (!existsSync(p)) return null;
  return loadJson(p);
}

// ---- collect -----------------------------------------------------------------

async function fetchGithubRepo(repo, token) {
  const headers = { 'User-Agent': 'tech-news-daily-weekly-plugin-trends' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repo}`);
  const json = await res.json();
  return { stars: json.stargazers_count, language: json.language ?? null };
}

async function fetchNpmDownloads(pkg) {
  const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`);
  if (!res.ok) throw new Error(`npm API ${res.status} for ${pkg}`);
  const json = await res.json();
  return json.downloads;
}

async function collectItem(item, token) {
  let stars = null;
  let language = null;
  let npmWeeklyDownloads = null;
  if (item.github) {
    try {
      const repo = await fetchGithubRepo(item.github, token);
      stars = repo.stars;
      language = repo.language;
    } catch (err) {
      console.warn(`[collect] ${item.id}: github fetch failed: ${err.message}`);
    }
  }
  if (item.npm) {
    try {
      npmWeeklyDownloads = await fetchNpmDownloads(item.npm);
    } catch (err) {
      console.warn(`[collect] ${item.id}: npm fetch failed: ${err.message}`);
    }
  }
  return { id: item.id, stars, npm_weekly_downloads: npmWeeklyDownloads, language };
}

async function collectAll(watchlist, token) {
  const results = [];
  for (const item of watchlist.items) {
    results.push(await collectItem(item, token));
  }
  const allNull = results.every((r) => r.stars === null && r.npm_weekly_downloads === null);
  if (allNull) {
    throw new Error('all items failed to collect (github + npm both null) — possible API outage');
  }
  return results;
}

// ---- discover (今週の新顔: GitHub Search で急上昇リポジトリを機械抽出) -----------

const DISCOVER_QUERIES = ['topic:ai', 'topic:llm', 'topic:mcp', 'claude in:name,description', 'ai agent in:name,description'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daysAgoDateStr(days) {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

async function fetchGithubSearchQuery(query, createdAfter, token) {
  const q = `${query} created:>=${createdAfter} stars:>=300`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`;
  const headers = { 'User-Agent': 'tech-news-daily-weekly-plugin-trends', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub Search API ${res.status} for query "${query}"`);
  const json = await res.json();
  return json.items || [];
}

async function searchCandidates(token) {
  const createdAfter = daysAgoDateStr(60);
  const results = [];
  for (const q of DISCOVER_QUERIES) {
    try {
      results.push(...(await fetchGithubSearchQuery(q, createdAfter, token)));
    } catch (err) {
      console.warn(`[discover] query "${q}" failed: ${err.message}`);
    }
    await sleep(1000);
  }
  return results;
}

function dedupeByFullName(repos) {
  const map = new Map();
  for (const r of repos) if (!map.has(r.full_name)) map.set(r.full_name, r);
  return [...map.values()];
}

function excludeKnown(repos, watchlist, featured) {
  const watchlistRepos = new Set(watchlist.items.map((w) => w.github).filter(Boolean));
  const featuredRepos = new Set((featured.featured || []).map((f) => f.full_name));
  return repos.filter((r) => !watchlistRepos.has(r.full_name) && !featuredRepos.has(r.full_name));
}

async function loadFeatured(dataDir) {
  const p = path.join(dataDir, 'featured.json');
  if (!existsSync(p)) return { featured: [] };
  return loadJson(p);
}

async function loadPreviousPool(dataDir, week) {
  const dir = path.join(dataDir, 'rising');
  if (!existsSync(dir)) return null;
  const files = (await readdir(dir))
    .filter((f) => f.startsWith('pool-') && f.endsWith('.json') && f !== `pool-${week}.json`)
    .sort();
  if (files.length === 0) return null;
  return loadJson(path.join(dir, files[files.length - 1]));
}

function weeksSinceCreated(createdAt) {
  const weeks = (Date.now() - new Date(createdAt).getTime()) / (7 * 24 * 3600 * 1000);
  return Math.max(1, weeks);
}

function computeWeeklyDelta(repo, prevPool) {
  const prevEntry = prevPool ? prevPool.items.find((p) => p.full_name === repo.full_name) : null;
  if (prevEntry) {
    return { weekly_delta: repo.stargazers_count - prevEntry.stars, weekly_delta_estimated: false };
  }
  const pace = repo.stargazers_count / weeksSinceCreated(repo.created_at);
  return { weekly_delta: Math.round(pace), weekly_delta_estimated: true };
}

function buildRisingItem(repo, prevPool) {
  const { weekly_delta, weekly_delta_estimated } = computeWeeklyDelta(repo, prevPool);
  return {
    full_name: repo.full_name,
    name: repo.name,
    url: repo.html_url,
    description: repo.description || '',
    language: repo.language ?? null,
    topics: repo.topics || [],
    created_at: repo.created_at,
    stars: repo.stargazers_count,
    weekly_delta,
    weekly_delta_estimated,
    blurb_ja: null,
  };
}

async function discover(dataDir, week, token) {
  const risingDir = path.join(dataDir, 'rising');
  await mkdir(risingDir, { recursive: true });

  const deduped = dedupeByFullName(await searchCandidates(token));
  const pool = { week, generated_at: new Date().toISOString(), items: deduped.map((r) => ({ full_name: r.full_name, stars: r.stargazers_count })) };
  await writeFile(path.join(risingDir, `pool-${week}.json`), `${JSON.stringify(pool, null, 2)}\n`);

  const prevPool = await loadPreviousPool(dataDir, week);
  const watchlist = await loadWatchlist(dataDir);
  const featured = await loadFeatured(dataDir);
  const candidates = excludeKnown(deduped, watchlist, featured);

  const items = candidates
    .map((repo) => buildRisingItem(repo, prevPool))
    .sort((a, b) => b.weekly_delta - a.weekly_delta)
    .slice(0, 10);

  await writeFile(path.join(risingDir, `${week}.json`), `${JSON.stringify({ week, generated_at: new Date().toISOString(), items }, null, 2)}\n`);

  featured.featured = [...(featured.featured || []), ...items.map((i) => ({ full_name: i.full_name, week }))];
  await writeFile(path.join(dataDir, 'featured.json'), `${JSON.stringify(featured, null, 2)}\n`);
}

// ---- trend computation -------------------------------------------------------

function findItem(items, id) {
  return items.find((i) => i.id === id);
}

function computeDelta(cur, prev) {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  return cur - prev;
}

function computePct(cur, prev) {
  if (cur === null || cur === undefined || !prev) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

function maxIgnoreNull(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? null : b;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}

function combinedWeekGrowth(curSnapshot, prevSnapshot, id) {
  const cur = findItem(curSnapshot.items, id);
  const prev = findItem(prevSnapshot.items, id);
  if (!cur || !prev) return null;
  const starsPct = computePct(cur.stars, prev.stars);
  const npmPct = computePct(cur.npm_weekly_downloads, prev.npm_weekly_downloads);
  return maxIgnoreNull(starsPct, npmPct);
}

function computeStreak(historySnapshots, id) {
  let streak = 0;
  for (let i = historySnapshots.length - 1; i > 0; i--) {
    const growth = combinedWeekGrowth(historySnapshots[i], historySnapshots[i - 1], id);
    if (growth === null || growth <= 0) break;
    streak++;
  }
  return streak;
}

function buildHistory(historySnapshots, id) {
  return historySnapshots.map((s) => {
    const entry = findItem(s.items, id);
    return {
      week: s.week,
      stars: entry ? entry.stars ?? null : null,
      npm_weekly_downloads: entry ? entry.npm_weekly_downloads ?? null : null,
    };
  });
}

function seriesFromHistory(history, key) {
  return history.map((h) => h[key]);
}

function buildItemTrend(w, sorted, historySnapshots) {
  const latest = sorted[sorted.length - 1];
  const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;
  const curEntry = findItem(latest.items, w.id);
  const stars = curEntry ? curEntry.stars : null;
  const npm = curEntry ? curEntry.npm_weekly_downloads : null;
  const language = curEntry ? curEntry.language ?? null : null;
  const prevEntry = prev ? findItem(prev.items, w.id) : null;
  const starsPrev = prevEntry ? prevEntry.stars : null;
  const npmPrev = prevEntry ? prevEntry.npm_weekly_downloads : null;
  const isNew = prev !== null && !prevEntry;

  return {
    id: w.id,
    name: w.name,
    category: w.category,
    url: w.url,
    github: w.github,
    npm: w.npm,
    description: w.description,
    language,
    stars,
    stars_prev: starsPrev,
    stars_delta: computeDelta(stars, starsPrev),
    stars_pct: computePct(stars, starsPrev),
    npm_weekly_downloads: npm,
    npm_prev: npmPrev,
    npm_delta: computeDelta(npm, npmPrev),
    npm_pct: computePct(npm, npmPrev),
    history: buildHistory(historySnapshots, w.id),
    streak: computeStreak(historySnapshots, w.id),
    is_new: isNew,
  };
}

function buildTrends(watchlist, snapshots) {
  const sorted = [...snapshots].sort((a, b) => a.week.localeCompare(b.week));
  const latest = sorted[sorted.length - 1];
  const historySnapshots = sorted.slice(-8);
  const items = watchlist.items.map((w) => buildItemTrend(w, sorted, historySnapshots));
  return {
    generated_at: new Date().toISOString(),
    latest_week: latest.week,
    weeks_available: sorted.length,
    items,
  };
}

function pickTop5(items) {
  const ranked = items
    .map((item) => {
      const starsPct = item.stars_pct;
      const npmPct = item.npm_pct;
      if (starsPct === null && npmPct === null) return null;
      const metric = maxIgnoreNull(starsPct, -Infinity) >= maxIgnoreNull(npmPct, -Infinity) ? 'stars' : 'npm';
      const pct = metric === 'stars' ? starsPct : npmPct;
      return { item, metric, pct };
    })
    .filter(Boolean)
    .sort((a, b) => b.pct - a.pct);
  return ranked.slice(0, 5);
}

function classifyTrend(item) {
  const rp = maxIgnoreNull(item.stars_pct, item.npm_pct);
  if (rp === null || rp === 0) return 'flat';
  return rp > 0 ? 'up' : 'down';
}

// ---- html rendering: primitives ----------------------------------------------

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatNumber(n) {
  return n === null || n === undefined ? '—' : n.toLocaleString('en-US');
}

function languageTagClass(lang) {
  return LANGUAGE_TAG_CLASS[lang] || 'tag-cat';
}

function languageTagLabel(lang) {
  return LANGUAGE_TAG_LABEL[lang] || lang;
}

function renderLanguageTag(lang) {
  if (!lang) return '';
  return ` <span class="tag ${languageTagClass(lang)}">${escapeHtml(languageTagLabel(lang))}</span>`;
}

function renderCategoryTag(category) {
  const label = CATEGORY_BADGE[category] || category;
  return `<span class="tag tag-cat">${escapeHtml(label)}</span>`;
}

function sparklinePoints(series) {
  const valid = series.map((v, i) => ({ v, i })).filter((p) => p.v !== null && p.v !== undefined);
  if (valid.length < 2) return null;
  const n = series.length;
  const xStep = n > 1 ? 88 / (n - 1) : 0;
  const values = valid.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const yTop = 2;
  const yBottom = 28;
  const yFor = (v) => (max === min ? (yTop + yBottom) / 2 : yBottom - ((v - min) / (max - min)) * (yBottom - yTop));
  return valid.map((p) => `${(p.i * xStep).toFixed(1)},${yFor(p.v).toFixed(1)}`).join(' ');
}

function renderSparkline(series, { withFill = false } = {}) {
  const pts = sparklinePoints(series);
  if (!pts) return '';
  const height = withFill ? 30 : 26;
  const fillPart = withFill ? `<polygon class="fill" points="${pts} 88,30 0,30"/>` : '';
  return `<svg class="sparkline" width="88" height="${height}" viewBox="0 0 88 30">${fillPart}<polyline points="${pts}"/></svg>`;
}

function relativeBarWidth(value, maxAbs) {
  if (value === null || value === undefined || !maxAbs) return 0;
  return Math.min(100, (Math.abs(value) / maxAbs) * 100);
}

function deltaLabelAndClass(delta, pct) {
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '→';
  const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const sign = delta > 0 ? '+' : '';
  return { label: `${arrow} ${sign}${formatNumber(delta)} (${sign}${pct.toFixed(1)}%)`, cls };
}

// ---- html rendering: metric block --------------------------------------------

function renderMetric({ label, glyph, value, isNew, unavailable, deltaInfo, barValue, barMax }) {
  const labelHtml = `<div class="label">${glyph} ${label}</div>`;
  if (unavailable) {
    return `<div class="metric">${labelHtml}<div class="value">—</div><div class="delta flat">npm 未公開</div></div>`;
  }
  if (value === null || value === undefined) {
    return `<div class="metric">${labelHtml}<div class="value">—</div><div class="delta flat">取得失敗</div></div>`;
  }
  if (isNew) {
    return `<div class="metric">${labelHtml}<div class="value">${formatNumber(value)}</div><div class="delta flat">— 初回計測</div></div>`;
  }
  const barCls = barValue < 0 ? ' neg' : '';
  const width = relativeBarWidth(barValue, barMax);
  return `<div class="metric">${labelHtml}<div class="value">${formatNumber(value)}</div><div class="delta ${deltaInfo.cls}">${deltaInfo.label}</div><div class="delta-bar${barCls}"><span style="width:${width}%"></span></div></div>`;
}

function renderToolCard(item, sectionMaxAbs) {
  const newBadge = item.is_new ? ' <span class="new-badge">NEW</span>' : '';
  const langTag = renderLanguageTag(item.language);
  const starsSeries = seriesFromHistory(item.history, 'stars');
  const npmSeries = seriesFromHistory(item.history, 'npm_weekly_downloads');
  const headSpark = renderSparkline(starsSeries.some((v) => v !== null) ? starsSeries : npmSeries, { withFill: false });
  const starsIsNew = item.is_new || item.stars_prev === null || item.stars_prev === undefined;
  const npmIsNew = item.is_new || item.npm_prev === null || item.npm_prev === undefined;
  const starsGuard = item.stars !== null && item.stars !== undefined && !starsIsNew;
  const npmGuard = item.npm && item.npm_weekly_downloads !== null && item.npm_weekly_downloads !== undefined && !npmIsNew;

  const starsMetric = renderMetric({
    label: 'Stars',
    glyph: '⭐',
    value: item.stars,
    isNew: starsIsNew,
    unavailable: false,
    deltaInfo: starsGuard ? deltaLabelAndClass(item.stars_delta, item.stars_pct) : null,
    barValue: item.stars_pct,
    barMax: sectionMaxAbs.stars,
  });
  const npmMetric = renderMetric({
    label: 'npm DL/週',
    glyph: '📦',
    value: item.npm_weekly_downloads,
    isNew: npmIsNew,
    unavailable: !item.npm,
    deltaInfo: npmGuard ? deltaLabelAndClass(item.npm_delta, item.npm_pct) : null,
    barValue: item.npm_pct,
    barMax: sectionMaxAbs.npm,
  });

  return `  <div class="tool-card">
    <div class="tool-head"><a href="${item.url}">${escapeHtml(item.name)}</a>${newBadge}${langTag}
      <span class="spacer"></span>
      ${headSpark}
    </div>
    <p class="tool-desc">${escapeHtml(item.description)}</p>
    <div class="tool-metrics">
      ${starsMetric}
      ${npmMetric}
    </div>
  </div>`;
}

function computeSectionMaxAbs(items) {
  const starsPcts = items.map((i) => i.stars_pct).filter((v) => v !== null && v !== undefined);
  const npmPcts = items.map((i) => i.npm_pct).filter((v) => v !== null && v !== undefined);
  const maxAbs = (arr) => (arr.length === 0 ? 0 : Math.max(...arr.map(Math.abs)));
  return { stars: maxAbs(starsPcts), npm: maxAbs(npmPcts) };
}

function renderCategorySection(category, items) {
  const catItems = items.filter((i) => i.category === category);
  if (catItems.length === 0) return '';
  const sectionMaxAbs = computeSectionMaxAbs(catItems);
  const cards = catItems.map((i) => renderToolCard(i, sectionMaxAbs)).join('\n\n');
  return `<div class="section">
  <div class="section-title">${escapeHtml(CATEGORY_TITLE[category])}</div>
${cards}
</div>`;
}

// ---- html rendering: top5 -------------------------------------------------------

function renderRankCard(rank, entry) {
  const { item, metric, pct } = entry;
  const series = metric === 'stars' ? seriesFromHistory(item.history, 'stars') : seriesFromHistory(item.history, 'npm_weekly_downloads');
  const spark = renderSparkline(series, { withFill: true });
  const delta = metric === 'stars' ? item.stars_delta : item.npm_delta;
  const value = metric === 'stars' ? item.stars : item.npm_weekly_downloads;
  const glyph = metric === 'stars' ? '⭐' : '📦';
  const suffix = metric === 'stars' ? '' : ' DL/週';
  const sign = delta > 0 ? '+' : '';
  const pctSign = pct > 0 ? '+' : '';
  const catTag = renderCategoryTag(item.category);
  const langTag = renderLanguageTag(item.language);
  return `    <div class="rank-card">
      <span class="rank-num">${rank}</span>
      ${spark}
      <div class="rank-body">
        <div class="rank-name">${escapeHtml(item.name)} ${catTag}${langTag}</div>
        <div class="rank-desc">${escapeHtml(item.description)}</div>
      </div>
      <div class="rank-metric"><div class="rank-delta">${pctSign}${pct.toFixed(1)}%</div><div class="rank-sub">${glyph} ${sign}${formatNumber(delta)} → ${formatNumber(value)}${suffix}</div></div>
    </div>`;
}

function renderTop5Section(top5) {
  if (top5.length === 0) return '';
  const cards = top5.map((entry, idx) => renderRankCard(idx + 1, entry)).join('\n');
  return `<div class="section">
  <div class="section-title">🚀 今週の急上昇 TOP 5（ウォッチリスト内）</div>
  <p class="section-desc">週間伸び率（stars と npm DL の大きい方）で全カテゴリ横断ランキング。折れ線は過去 8 週の推移。</p>
  <div class="rank-list">
${cards}
  </div>
</div>`;
}

// ---- html rendering: rising (今週の新顔) ----------------------------------------

function risingPct(item) {
  if (item.weekly_delta_estimated) return null;
  const prevStars = item.stars - item.weekly_delta;
  if (!prevStars || prevStars <= 0) return null;
  return Math.round((item.weekly_delta / prevStars) * 1000) / 10;
}

function renderRisingCard(item, maxDelta) {
  const langTag = renderLanguageTag(item.language);
  const desc = item.blurb_ja || item.description || '';
  const pct = risingPct(item);
  const pctText = pct !== null ? ` (+${pct.toFixed(0)}%)` : '';
  const badgeText = item.weekly_delta_estimated
    ? `🔥 約 +${formatNumber(item.weekly_delta)} stars/週 (平均)`
    : `🔥 +${formatNumber(item.weekly_delta)} stars / 週${pctText}`;
  const metricDeltaText = item.weekly_delta_estimated
    ? `▲ 約 +${formatNumber(item.weekly_delta)}/週 (平均)`
    : `▲ +${formatNumber(item.weekly_delta)}${pctText}`;
  const width = relativeBarWidth(item.weekly_delta, maxDelta);
  const created = item.created_at ? String(item.created_at).slice(0, 10) : '—';
  return `  <div class="tool-card">
    <div class="tool-head"><a href="${item.url}">${escapeHtml(item.full_name)}</a> <span class="new-badge">NEW</span> <span class="tag tag-cat">AI</span>${langTag}
      <span class="spacer"></span>
      <span class="delta-badge">${badgeText}</span>
    </div>
    <p class="tool-desc">${escapeHtml(desc)}</p>
    <div class="tool-metrics">
      <div class="metric"><div class="label">⭐ Stars</div><div class="value">${formatNumber(item.stars)}</div><div class="delta up">${metricDeltaText}</div><div class="delta-bar"><span style="width:${width}%"></span></div></div>
      <div class="metric"><div class="label">📅 Created</div><div class="value" style="font-size:.85rem">${escapeHtml(created)}</div></div>
    </div>
  </div>`;
}

function renderRisingSection(rising) {
  if (!rising || !Array.isArray(rising.items) || rising.items.length === 0) return '';
  const maxDelta = Math.max(...rising.items.map((i) => Math.abs(i.weekly_delta || 0)), 0);
  const cards = rising.items.map((i) => renderRisingCard(i, maxDelta)).join('\n\n');
  return `<div class="section">
  <div class="section-title">🔭 今週の新顔（GitHub 発掘）</div>
  <p class="section-desc">ウォッチリスト外から GitHub Search で機械抽出した急上昇リポジトリ（直近 60 日以内に誕生・週間伸び順・再掲なし）。紹介文は AI 生成（生成失敗時は GitHub の説明文をそのまま表示）。</p>
${cards}
</div>`;
}

// ---- html rendering: week summary ------------------------------------------------

function buildWeekSummary(trends, top5, isFirstWeek, rising) {
  const total = trends.items.length;
  if (isFirstWeek) {
    return `<strong>今週の概況:</strong> 追跡 ${total} ツール中 全 ${total} が初回計測。前週比は来週から表示される。`;
  }
  const counts = { up: 0, down: 0, flat: 0 };
  for (const item of trends.items) counts[classifyTrend(item)]++;
  let text = `追跡 ${total} ツール中 <strong>${counts.up} が上昇・${counts.flat} が横ばい/計測不能・${counts.down} が下落</strong>。`;
  if (top5.length > 0) {
    const top = top5[0];
    const metricLabel = top.metric === 'stars' ? 'stars' : 'npm DL';
    const streakClause = top.item.streak >= 2 ? `で ${top.item.streak} 週連続の上昇` : '';
    text += `最大の伸びは <strong>${escapeHtml(top.item.name)}</strong>（${metricLabel} +${top.pct.toFixed(1)}%）${streakClause}。`;
  }
  if (rising && Array.isArray(rising.items) && rising.items.length > 0) {
    const best = rising.items.reduce((a, b) => (Math.abs(b.weekly_delta || 0) > Math.abs(a.weekly_delta || 0) ? b : a));
    text += `新顔発掘では <strong>${escapeHtml(best.name || best.full_name)}</strong> が週間 +${formatNumber(best.weekly_delta)} stars で最大の伸び。`;
  }
  return `<strong>今週の概況:</strong> ${text}`;
}

// ---- html rendering: page -------------------------------------------------------

function renderTrendsHtml(trends, rising) {
  const isFirstWeek = trends.weeks_available <= 1;
  const top5 = isFirstWeek ? [] : pickTop5(trends.items);
  const summary = buildWeekSummary(trends, top5, isFirstWeek, rising);
  const top5Html = renderTop5Section(top5);
  const risingHtml = renderRisingSection(rising);
  const categorySections = CATEGORY_ORDER.map((c) => renderCategorySection(c, trends.items))
    .filter(Boolean)
    .join('\n\n');
  const weeksShown = Math.min(trends.weeks_available, 8);
  const dateLine = `${trends.latest_week}（${jstDateLabel(trends.generated_at)} 収集 · ${weeksShown} 週分の推移を表示）`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>週次プラグイントレンド | Tech News Daily</title>
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">
<style>
:root{--primary-600:#2250df;--primary-500:#2b70ef;--primary-50:#f0f5ff;--radius-lg:.75rem;--text-base:1.125rem;--bg:#fafafa;--surface:#fff;--text-primary:#1a1a2e;--text-secondary:#555570;--text-muted:#8888a0;--border:#e4e4ec;--accent-ai:#7c3aed;--up:#059669;--down:#dc2626;--spark:#2b70ef}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;background:var(--bg);color:var(--text-primary);font-size:var(--text-base);line-height:1.8;padding:2rem 1rem}
.container{max-width:720px;margin:0 auto}
header{text-align:center;margin-bottom:2rem;padding-bottom:1.5rem;border-bottom:1px solid var(--border)}
header h1{font-size:1.75rem;font-weight:700;letter-spacing:-.02em}
header .date{color:var(--text-muted);font-size:.9rem;margin-top:.25rem}
header .tagline{color:var(--text-secondary);font-size:.95rem;margin-top:.5rem}
.site-nav{display:flex;justify-content:center;gap:.5rem;margin-top:.75rem;flex-wrap:wrap}
.site-nav a{display:inline-block;padding:.25rem .6rem;font-size:.75rem;font-weight:600;color:var(--text-muted);text-decoration:none;border:1px solid var(--border);border-radius:9999px}
.site-nav a:hover,.site-nav a.active{color:var(--primary-500);border-color:var(--primary-500)}
.week-summary{background:linear-gradient(135deg,var(--primary-50),#f5f0ff);border-left:4px solid var(--primary-500);border-radius:var(--radius-lg);padding:1.1rem 1.25rem;margin-bottom:2rem;font-size:.92rem;color:var(--text-secondary);line-height:1.8}
.week-summary strong{color:var(--text-primary)}
.section{margin-bottom:2.25rem}
.section-title{font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:.4rem;display:flex;align-items:center;gap:.5rem}
.section-title::after{content:"";flex:1;height:1px;background:var(--border)}
.section-desc{font-size:.85rem;color:var(--text-secondary);margin-bottom:.9rem;line-height:1.7}
.rank-list{display:flex;flex-direction:column;gap:.5rem}
.rank-card{display:flex;align-items:center;gap:.9rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:.8rem 1rem}
.rank-num{font-size:1.3rem;font-weight:800;color:var(--primary-600);width:1.6rem;text-align:center;flex-shrink:0;letter-spacing:-.02em}
.rank-body{flex:1;min-width:0}
.rank-name{font-weight:700;font-size:.95rem}
.rank-desc{font-size:.8rem;color:var(--text-muted);line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rank-metric{text-align:right;flex-shrink:0}
.rank-delta{font-size:1.05rem;font-weight:800;color:var(--up)}
.rank-sub{font-size:.72rem;color:var(--text-muted)}
.sparkline{flex-shrink:0}
.sparkline polyline{fill:none;stroke:var(--spark);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.sparkline .fill{fill:url(#sg);stroke:none;opacity:.35}
.tool-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:1rem 1.1rem;margin-bottom:.6rem}
.tool-head{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.tool-head a{font-weight:700;font-size:.98rem;color:var(--text-primary);text-decoration:none}
.tool-head a:hover{color:var(--primary-500)}
.new-badge{font-size:.65rem;font-weight:700;color:var(--accent-ai);background:#f3e8ff;padding:.05rem .45rem;border-radius:9999px}
.tool-head .spacer{margin-left:auto}
.tool-desc{font-size:.85rem;color:var(--text-secondary);line-height:1.7;margin-top:.25rem}
.tool-metrics{display:flex;gap:1.25rem;margin-top:.6rem;flex-wrap:wrap;align-items:center}
.metric{min-width:110px}
.metric .label{font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)}
.metric .value{font-size:1rem;font-weight:700;font-variant-numeric:tabular-nums}
.metric .delta{font-size:.78rem;font-weight:700}
.up{color:var(--up)}.down{color:var(--down)}.flat{color:var(--text-muted)}
.delta-bar{height:4px;border-radius:2px;background:var(--border);margin-top:.3rem;overflow:hidden;width:110px}
.delta-bar span{display:block;height:100%;background:var(--up);border-radius:2px}
.delta-bar.neg span{background:var(--down)}
.tag{display:inline-block;font-size:.65rem;font-weight:700;padding:.05rem .45rem;border-radius:9999px;text-transform:uppercase;letter-spacing:.04em;vertical-align:middle}
.tag-cat{background:#f3e8ff;color:var(--accent-ai)}
.tag-python{background:#eef2ff;color:#4f46e5}
.tag-ts{background:#f0f5ff;color:#2563eb}
.tag-js{background:#fefce8;color:#a16207}
.tag-go{background:#ecfeff;color:#0891b2}
.tag-rust{background:#fff7ed;color:#c2410c}
.tag-ruby{background:#fef2f2;color:#dc2626}
.delta-badge{display:inline-block;font-size:.75rem;font-weight:700;white-space:nowrap;padding:.12rem .55rem;border-radius:9999px;background:#ecfdf5;color:var(--up)}
footer{text-align:center;margin-top:3rem;padding-top:1.5rem;border-top:1px solid var(--border);color:var(--text-muted);font-size:.8rem}
footer a{color:var(--primary-500);text-decoration:none}
@media(max-width:600px){body{padding:1rem .75rem}header h1{font-size:1.4rem}.rank-desc{white-space:normal}.rank-card{flex-wrap:wrap}.tool-metrics{gap:.9rem}}
@media(prefers-color-scheme:dark){:root{--bg:#0f0f1a;--surface:#1a1a2e;--text-primary:#e4e4ec;--text-secondary:#a0a0b8;--text-muted:#6b6b80;--border:#2a2a3e;--primary-50:#1a1a3e;--primary-600:#5b8af5;--primary-500:#6b9af5;--up:#34d399;--down:#f87171;--spark:#6b9af5}.week-summary{background:linear-gradient(135deg,#1a1a3e,#1f1a3e)}.new-badge,.tag-cat{background:#2d1b69}.delta-badge{background:#0a3d2a}.tag-python{background:#1a1a4d}.tag-ts{background:#0a1a3d}.tag-js{background:#3d2f0a}.tag-go{background:#0a2d3d}.tag-rust{background:#3d200a}.tag-ruby{background:#3d0a0a}}
</style>
</head>
<body>
<div class="container">
<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2b70ef" stop-opacity=".5"/><stop offset="100%" stop-color="#2b70ef" stop-opacity="0"/></linearGradient></defs></svg>

<header>
  <h1>🔌 週次プラグイントレンド</h1>
  <p class="date">${dateLine}</p>
  <p class="tagline">AI コーディング系ツールの GitHub stars / npm 週間ダウンロードを週 3 回定点観測</p>
  <nav class="site-nav">
    <a href="./">📰 日刊ダイジェスト</a>
    <a href="#" class="active">🔌 週次プラグイントレンド</a>
    <a href="ai-trends.html">🧠 AI プロダクト動向</a>
    <a href="archive/">🗂 アーカイブ</a>
  </nav>
</header>

<div class="week-summary">
  ${summary}
  <span style="font-size:.75rem;color:var(--text-muted);display:block;margin-top:.4rem">※ この概況文はスナップショット数値からテンプレートで自動生成（LLM 非経由）</span>
</div>

${top5Html}

${risingHtml}

${categorySections}

<footer>
  <p>データ: GitHub API / npm downloads API から毎週月・水・金 07:00 に自動収集（前週比は週次スナップショット基準、週内の run は数値を最新化）。数値・推移・概況文はすべてスナップショットからの決定論生成（LLM 非経由）。「今週の新顔」の紹介文のみ AI 生成（失敗時は GitHub 説明文で代替）</p>
  <p style="margin-top:.5rem"><a href="https://github.com/kaionn/tech-news-daily/tree/main/data/plugins">📊 生データ (data/plugins/)</a> · <a href="./">📰 日刊ダイジェストに戻る</a></p>
</footer>
</div>
</body>
</html>
`;
}

// ---- main -----------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir ? path.resolve(args.dataDir) : DEFAULT_DATA_DIR;
  const snapshotsDir = path.join(dataDir, 'snapshots');
  const trendsPath = path.join(dataDir, 'trends.json');
  const outPath = args.out ? path.resolve(args.out) : DEFAULT_TRENDS_HTML_PATH;

  const watchlist = await loadWatchlist(dataDir);

  if (!args.renderOnly) {
    const week = isoWeekKey(jstNow());
    await mkdir(snapshotsDir, { recursive: true });
    const items = await collectAll(watchlist, process.env.GITHUB_TOKEN);
    const snapshot = { week, collected_at: new Date().toISOString(), items };
    await writeFile(path.join(snapshotsDir, `${week}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
    await discover(dataDir, week, process.env.GITHUB_TOKEN);
  }

  const snapshots = await loadAllSnapshots(snapshotsDir);
  if (snapshots.length === 0) {
    console.error(
      `[weekly-plugin-trends] no snapshots found in ${snapshotsDir} — run without --render-only first, or check --data-dir`
    );
    process.exitCode = 1;
    return;
  }

  const trends = buildTrends(watchlist, snapshots);
  const rising = await loadRising(dataDir, trends.latest_week);
  await writeFile(trendsPath, `${JSON.stringify(trends, null, 2)}\n`);
  await writeFile(outPath, renderTrendsHtml(trends, rising));
  console.log(`[weekly-plugin-trends] wrote ${trendsPath} and ${outPath} for ${trends.latest_week}`);
}

main().catch((err) => {
  console.error(`[weekly-plugin-trends] fatal: ${err.message}`);
  process.exitCode = 1;
});

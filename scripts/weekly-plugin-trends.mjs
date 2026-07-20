#!/usr/bin/env node
// Weekly plugin trends: collect GitHub stars + npm weekly downloads for a fixed
// watchlist, snapshot them per ISO week (JST), diff against the previous
// snapshot, and render the result to data/plugins/trends.json + trends.html.
// No dependencies (Node 20+ built-in fetch only). See tmp/context.md for design.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCHLIST_PATH = path.join(ROOT, 'data/plugins/watchlist.json');
const SNAPSHOTS_DIR = path.join(ROOT, 'data/plugins/snapshots');
const TRENDS_PATH = path.join(ROOT, 'data/plugins/trends.json');
const TRENDS_HTML_PATH = path.join(ROOT, 'trends.html');
const RENDER_ONLY = process.argv.includes('--render-only');

const CATEGORY_LABELS = {
  'claude-code': 'Claude Code',
  mcp: 'MCP',
  'ai-tool': 'AI コーディングツール',
};

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

async function loadJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function fetchGithubStars(repo, token) {
  const headers = { 'User-Agent': 'tech-news-daily-weekly-plugin-trends' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repo}`);
  const json = await res.json();
  return json.stargazers_count;
}

async function fetchNpmDownloads(pkg) {
  const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`);
  if (!res.ok) throw new Error(`npm API ${res.status} for ${pkg}`);
  const json = await res.json();
  return json.downloads;
}

async function collectItem(item, token) {
  let stars = null;
  let npmWeeklyDownloads = null;
  if (item.github) {
    try {
      stars = await fetchGithubStars(item.github, token);
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
  return { id: item.id, stars, npm_weekly_downloads: npmWeeklyDownloads };
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

async function findPreviousSnapshot(currentWeek) {
  if (!existsSync(SNAPSHOTS_DIR)) return null;
  const files = (await readdir(SNAPSHOTS_DIR))
    .filter((f) => f.endsWith('.json') && f !== `${currentWeek}.json`)
    .sort();
  if (files.length === 0) return null;
  return loadJson(path.join(SNAPSHOTS_DIR, files[files.length - 1]));
}

function computeDelta(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return null;
  }
  return current - previous;
}

function computeGrowthPct(current, previous) {
  if (current === null || current === undefined || !previous) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function buildTrends(watchlist, currentItems, prevItems, week, prevWeek) {
  const prevMap = new Map((prevItems || []).map((i) => [i.id, i]));
  const currentMap = new Map(currentItems.map((i) => [i.id, i]));
  const items = watchlist.items.map((w) => {
    const cur = currentMap.get(w.id) || { stars: null, npm_weekly_downloads: null };
    const prev = prevMap.get(w.id) || null;
    const starsPrev = prev ? prev.stars : null;
    const dlPrev = prev ? prev.npm_weekly_downloads : null;
    return {
      id: w.id,
      name: w.name,
      category: w.category,
      url: w.url,
      github: w.github,
      npm: w.npm,
      stars: cur.stars,
      stars_prev: starsPrev,
      stars_delta: computeDelta(cur.stars, starsPrev),
      npm_weekly_downloads: cur.npm_weekly_downloads,
      npm_downloads_prev: dlPrev,
      npm_downloads_delta: computeDelta(cur.npm_weekly_downloads, dlPrev),
      npm_downloads_growth_pct: computeGrowthPct(cur.npm_weekly_downloads, dlPrev),
    };
  });
  return { week, prev_week: prevWeek, generated_at: new Date().toISOString(), items };
}

function formatNumber(n) {
  return n === null || n === undefined ? '—' : n.toLocaleString('en-US');
}

function formatSigned(n, suffix = '') {
  if (n === null || n === undefined) return '—';
  const sign = n > 0 ? '+' : '';
  const cls = n > 0 ? ' class="delta-up"' : n < 0 ? ' class="delta-down"' : '';
  return `<span${cls}>${sign}${n.toLocaleString('en-US')}${suffix}</span>`;
}

function renderCategoryTable(category, items) {
  const rows = items
    .filter((i) => i.category === category)
    .map(
      (i) => `          <tr>
            <td><a href="${i.url}">${i.name}</a></td>
            <td>${formatNumber(i.stars)}</td>
            <td>${formatSigned(i.stars_delta)}</td>
            <td>${formatNumber(i.npm_weekly_downloads)}</td>
            <td>${formatSigned(i.npm_downloads_growth_pct, '%')}</td>
          </tr>`
    )
    .join('\n');
  if (!rows) return '';
  return `    <div class="section">
      <div class="section-title">${CATEGORY_LABELS[category]}</div>
      <div class="table-wrap">
        <table class="trends-table">
          <thead>
            <tr><th>名前</th><th>GitHub Stars</th><th>前週比</th><th>npm 週間 DL</th><th>前週比</th></tr>
          </thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderTrendsHtml(trends) {
  const sections = Object.keys(CATEGORY_LABELS)
    .map((c) => renderCategoryTable(c, trends.items))
    .filter(Boolean)
    .join('\n\n');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weekly Plugin Trends — ${trends.week}</title>
  <link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">
  <link rel="stylesheet" href="style.css">
  <style>
    .table-wrap { overflow-x: auto; }
    .trends-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    .trends-table th, .trends-table td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
    .trends-table th:first-child, .trends-table td:first-child { text-align: left; white-space: normal; }
    .delta-up { color: var(--accent-dev); font-weight: 600; }
    .delta-down { color: var(--accent-security); font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Tech News Daily</h1>
      <div class="tagline">📈 Weekly Plugin Trends — ${trends.week}</div>
      <a href="index.html" class="archive-link">← Back to today's digest</a>
    </header>

${sections}

    <footer>
      <p>毎週月曜 07:00 JST 自動更新 / data source: GitHub API, npm downloads API</p>
    </footer>
  </div>
</body>
</html>
`;
}

async function main() {
  const watchlist = await loadJson(WATCHLIST_PATH);
  const week = isoWeekKey(jstNow());
  const snapshotPath = path.join(SNAPSHOTS_DIR, `${week}.json`);

  if (!RENDER_ONLY) {
    await mkdir(SNAPSHOTS_DIR, { recursive: true });
    const items = await collectAll(watchlist, process.env.GITHUB_TOKEN);
    const snapshot = { week, collected_at: new Date().toISOString(), items };
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  const currentSnapshot = await loadJson(snapshotPath);
  const previousSnapshot = await findPreviousSnapshot(week);
  const trends = buildTrends(
    watchlist,
    currentSnapshot.items,
    previousSnapshot ? previousSnapshot.items : null,
    week,
    previousSnapshot ? previousSnapshot.week : null
  );

  await writeFile(TRENDS_PATH, `${JSON.stringify(trends, null, 2)}\n`);
  await writeFile(TRENDS_HTML_PATH, renderTrendsHtml(trends));
  console.log(
    `[weekly-plugin-trends] wrote trends.json/trends.html for ${week} (prev: ${previousSnapshot ? previousSnapshot.week : 'none'})`
  );
}

main().catch((err) => {
  console.error(`[weekly-plugin-trends] fatal: ${err.message}`);
  process.exitCode = 1;
});

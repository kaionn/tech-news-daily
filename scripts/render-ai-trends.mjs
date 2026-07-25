#!/usr/bin/env node
// AI product trends renderer: reads data/ai-trends/*.json (LLM-authored
// theme deep-dive JSON, one file per issue — date-keyed YYYY-MM-DD since the
// 週3回 schedule; ISO-week-keyed YYYY-Www files from the weekly era are still
// rendered as-is) and deterministically renders ai-trends.html (latest issue)
// plus ai-trends/{key}.html (each issue's permalink). No LLM calls here.
// tmp/mock-ai-trends.html is the canonical layout/CSS. See
// ~/.claude/plans/tech-news-daily/ai-product-trends-weekly.md for design background.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA_DIR = path.join(ROOT, 'data/ai-trends');
const ISSUE_FILENAME_RE = /^(\d{4}-W\d{2}|\d{4}-\d{2}-\d{2})\.json$/;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 旧週次キー (2026-W30) と日付キー (2026-07-28) は素の文字列比較だと
// "W" > 数字で週キーが常に後ろへ来てしまうため、週キーはその ISO 週の
// 月曜日の日付に正規化してから比較する。
function issueSortKey(key) {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return key;
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const isoDay = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - isoDay + 1 + (Number(m[2]) - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

// ---- args --------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dataDir: null, outRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') args.dataDir = argv[++i];
    else if (a === '--out-dir') args.outRoot = argv[++i];
  }
  return args;
}

// ---- small helpers -------------------------------------------------------------

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, '');
}

function isHttpsUrl(u) {
  return typeof u === 'string' && u.startsWith('https://');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dateLabel(generatedAt) {
  return typeof generatedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(generatedAt) ? generatedAt.slice(0, 10) : null;
}

// ---- issue loading + sanitization ---------------------------------------------

function sanitizeExample(ex, warn) {
  if (!ex || typeof ex.product !== 'string' || typeof ex.approach !== 'string' || !isHttpsUrl(ex.source_url)) {
    warn(`dropping an example (missing product/approach or non-https source_url)`);
    return null;
  }
  return { product: ex.product, approach: ex.approach, detail: typeof ex.detail === 'string' ? ex.detail : '', source_url: ex.source_url };
}

function sanitizeSection(sec, warn) {
  if (!sec || typeof sec.heading !== 'string' || !sec.heading.trim() || typeof sec.body_html !== 'string' || !sec.body_html.trim()) {
    warn(`dropping a section (missing heading or body_html)`);
    return null;
  }
  const examples = (Array.isArray(sec.examples) ? sec.examples : []).map((e) => sanitizeExample(e, warn)).filter(Boolean);
  return { heading: sec.heading.trim(), body_html: sec.body_html, examples, takeaway: typeof sec.takeaway === 'string' ? sec.takeaway : '' };
}

function sanitizeQuickPick(qp, warn) {
  if (!qp || typeof qp.title !== 'string' || !qp.title.trim() || !isHttpsUrl(qp.url)) {
    warn(`dropping a quick_pick (missing title or non-https url)`);
    return null;
  }
  return { title: qp.title, summary: typeof qp.summary === 'string' ? qp.summary : '', url: qp.url };
}

function sanitizeIssue(raw, fallbackWeek, warn) {
  if (!raw || typeof raw !== 'object') {
    warn('not a JSON object');
    return null;
  }
  const theme = raw.theme;
  if (!theme || typeof theme !== 'object' || typeof theme.title !== 'string' || !theme.title.trim()) {
    warn('missing theme.title');
    return null;
  }
  const sections = (Array.isArray(theme.sections) ? theme.sections : []).map((s) => sanitizeSection(s, warn)).filter(Boolean);
  if (sections.length === 0) {
    warn('no valid sections after sanitization');
    return null;
  }
  const tldr = Array.isArray(theme.tldr) ? theme.tldr.filter((t) => typeof t === 'string' && t.trim()) : [];
  const quickPicks = (Array.isArray(raw.quick_picks) ? raw.quick_picks : []).map((q) => sanitizeQuickPick(q, warn)).filter(Boolean);

  // week = 号キー。日付キー時代の JSON は `issue` フィールド、週次時代は `week` フィールドに入っている
  const key = [raw.issue, raw.week].find((v) => typeof v === 'string' && v) || fallbackWeek;
  return {
    week: key,
    generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : null,
    theme: {
      title: theme.title.trim(),
      category: typeof theme.category === 'string' ? theme.category : '',
      lede: typeof theme.lede === 'string' ? theme.lede : '',
      tldr,
      sections,
    },
    editorial: typeof raw.editorial === 'string' ? raw.editorial : '',
    quick_picks: quickPicks,
  };
}

async function loadAllIssues(dataDir) {
  if (!existsSync(dataDir)) return [];
  const files = (await readdir(dataDir)).filter((f) => ISSUE_FILENAME_RE.test(f)).sort();
  const issues = [];
  for (const f of files) {
    const week = f.replace(/\.json$/, '');
    const warn = (msg) => console.warn(`[render-ai-trends] ${f}: ${msg}`);
    let raw;
    try {
      raw = JSON.parse(await readFile(path.join(dataDir, f), 'utf8'));
    } catch (err) {
      warn(`invalid JSON, skipping issue entirely: ${err.message}`);
      continue;
    }
    const issue = sanitizeIssue(raw, week, warn);
    if (!issue) {
      warn('issue skipped (structurally invalid)');
      continue;
    }
    issues.push(issue);
  }
  return issues.sort((a, b) => issueSortKey(a.week).localeCompare(issueSortKey(b.week)));
}

// ---- reading time ---------------------------------------------------------------

function computeReadingMinutes(issue) {
  const parts = [issue.theme.lede, ...issue.theme.tldr, issue.editorial];
  for (const s of issue.theme.sections) {
    parts.push(s.heading, s.body_html, s.takeaway);
    for (const e of s.examples) parts.push(e.product, e.approach, e.detail);
  }
  const totalChars = parts.map(stripTags).join('').length;
  return Math.max(1, Math.ceil(totalChars / 600));
}

// ---- html rendering: page pieces ------------------------------------------------

function renderHeader(issue, minutes, fromIsLatest) {
  const indexHref = fromIsLatest ? './' : '../';
  const trendsHref = fromIsLatest ? 'trends.html' : '../trends.html';
  const selfHref = fromIsLatest ? '#' : '../ai-trends.html';
  const label = dateLabel(issue.generated_at);
  // 日付キーの号は発行日そのものなので generated_at の日付を重ねて表示しない
  const dateLine = DATE_KEY_RE.test(issue.week)
    ? `${issue.week} 発行（読了 ${minutes} 分）`
    : label
      ? `${issue.week}（${label} 発行 · 読了 ${minutes} 分）`
      : `${issue.week}（読了 ${minutes} 分）`;
  return `<header>
  <h1>🧠 AI プロダクト動向</h1>
  <p class="date">${escapeHtml(dateLine)}</p>
  <p class="tagline">実プロダクトのアーキテクチャ・使用例から AI 開発の現在地を週 3 回・1 号 1 テーマで深掘り</p>
  <nav class="site-nav">
    <a href="${indexHref}">📰 日刊ダイジェスト</a>
    <a href="${trendsHref}">🔌 週次プラグイントレンド</a>
    <a href="${selfHref}" class="active">🧠 AI プロダクト動向</a>
  </nav>
</header>`;
}

function renderHero(issue) {
  const catLabel = issue.theme.category ? escapeHtml(issue.theme.category.toUpperCase()) : '';
  const catTag = catLabel ? ` <span class="tag tag-ai" style="margin-left:.4rem">${catLabel}</span>` : '';
  const lede = issue.theme.lede ? `\n  <p class="lede">${escapeHtml(issue.theme.lede)}</p>` : '';
  return `<div class="theme-hero">
  <span class="kicker">今号のテーマ${catTag}</span>
  <h2>${escapeHtml(issue.theme.title)}</h2>${lede}
</div>`;
}

function renderTldr(tldr) {
  if (tldr.length === 0) return '';
  const items = tldr.map((t) => `    <li>${escapeHtml(t)}</li>`).join('\n');
  return `<div class="tldr">
  <div class="label">TL;DR — 3 行で</div>
  <ul>
${items}
  </ul>
</div>`;
}

function renderExample(ex) {
  const detailHtml = ex.detail ? `\n      <div class="detail">${escapeHtml(ex.detail)}</div>` : '';
  return `    <div class="example">
      <div class="product">${escapeHtml(ex.product)}</div>
      <div class="approach">${escapeHtml(ex.approach)}</div>${detailHtml}
      <a href="${ex.source_url}">📄 一次ソース</a>
    </div>`;
}

function renderEditorial(text) {
  if (!text) return '';
  return `
  <div class="editorial">
    <span class="label">✍️ 編集後記</span>
    ${escapeHtml(text)}
  </div>`;
}

function renderSection(sec, idx, editorialHtml) {
  const examplesHtml = sec.examples.length ? `\n${sec.examples.map(renderExample).join('\n')}` : '';
  const takeawayHtml = sec.takeaway ? `\n    <div class="takeaway"><strong>示唆:</strong> ${escapeHtml(sec.takeaway)}</div>` : '';
  return `<div class="section">
  <div class="section-title">📐 パターン ${idx + 1}: ${escapeHtml(sec.heading)}</div>
  <div class="theme-section">
    ${sec.body_html}${examplesHtml}${takeawayHtml}
  </div>${editorialHtml}
</div>`;
}

function renderQuickPicks(picks) {
  if (picks.length === 0) return '';
  const items = picks
    .map((p) => `  <div class="quick-link"><a href="${p.url}">${escapeHtml(p.title)}</a><span class="quick-summary">${escapeHtml(p.summary)}</span></div>`)
    .join('\n');
  return `<div class="section">
  <div class="section-title">🔗 今号の動向ピックアップ</div>
${items}
</div>`;
}

function archiveHref(targetWeek, latestWeek, fromIsLatest) {
  if (targetWeek === latestWeek) return fromIsLatest ? '#' : '../ai-trends.html';
  return fromIsLatest ? `ai-trends/${targetWeek}.html` : `${targetWeek}.html`;
}

function renderArchiveList(allIssues, latestWeek, currentWeek, fromIsLatest) {
  const others = allIssues.filter((i) => i.week !== currentWeek).slice().reverse();
  if (others.length === 0) return '';
  const items = others
    .map((i) => {
      const href = archiveHref(i.week, latestWeek, fromIsLatest);
      const sub = i.theme.tldr[0] ? `<span class="sub">${escapeHtml(i.theme.tldr[0])}</span>` : '';
      return `  <div class="archive-item"><span class="week">${escapeHtml(i.week)}</span><div class="body"><a href="${href}">${escapeHtml(i.theme.title)}</a>${sub}</div></div>`;
    })
    .join('\n');
  return `<div class="section">
  <div class="section-title">📚 過去号</div>
${items}
</div>`;
}

function renderFooter(issue, fromIsLatest) {
  const dataHref = fromIsLatest ? `data/ai-trends/${issue.week}.json` : `../data/ai-trends/${issue.week}.json`;
  const indexHref = fromIsLatest ? './' : '../';
  return `<footer>
  <p>毎週火・木・土 07:00 発行。一次ソースは <a href="${dataHref}">data/ai-trends/${issue.week}.json</a>（このページは JSON からの生成物）</p>
  <p style="margin-top:.5rem"><a href="${indexHref}">📰 日刊ダイジェストに戻る</a></p>
</footer>`;
}

// ---- html rendering: page -------------------------------------------------------

const PAGE_STYLE = `:root{--primary-600:#2250df;--primary-500:#2b70ef;--primary-50:#f0f5ff;--radius-lg:.75rem;--text-base:1.125rem;--bg:#fafafa;--surface:#fff;--text-primary:#1a1a2e;--text-secondary:#555570;--text-muted:#8888a0;--border:#e4e4ec;--accent-ai:#7c3aed;--accent-dev:#059669}
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
.section{margin-bottom:2.25rem}
.section-title{font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem}
.section-title::after{content:"";flex:1;height:1px;background:var(--border)}
.tag{display:inline-block;font-size:.7rem;font-weight:600;padding:.15rem .5rem;border-radius:9999px;text-transform:uppercase;letter-spacing:.04em}
.tag-ai{background:#f3e8ff;color:var(--accent-ai)}
.theme-hero{background:linear-gradient(135deg,var(--primary-50),#f5f0ff);border-left:4px solid var(--primary-500);border-radius:var(--radius-lg);padding:1.5rem;margin-bottom:1rem}
.theme-hero .kicker{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--primary-600)}
.theme-hero h2{font-size:1.35rem;font-weight:700;line-height:1.5;margin:.35rem 0 .5rem}
.theme-hero .lede{font-size:.95rem;color:var(--text-secondary);line-height:1.85}
.tldr{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:1rem 1.25rem;margin-bottom:2rem}
.tldr .label{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--primary-600);margin-bottom:.35rem}
.tldr ul{list-style:none}
.tldr li{position:relative;padding-left:1.1rem;font-size:.88rem;color:var(--text-secondary);line-height:1.7;margin-bottom:.25rem}
.tldr li::before{content:"•";position:absolute;left:0;color:var(--primary-500);font-weight:700}
.theme-section{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:1.35rem;margin-bottom:.75rem}
.theme-section h3{font-size:1.05rem;font-weight:600;margin-bottom:.6rem}
.theme-section p{font-size:.92rem;color:var(--text-secondary);line-height:1.85;margin-bottom:.7rem}
.theme-section p:last-child{margin-bottom:0}
.example{margin-top:.8rem;padding:.8rem .95rem;background:var(--primary-50);border-radius:.5rem;font-size:.88rem;line-height:1.75}
.example .product{font-weight:700;color:var(--text-primary)}
.example .approach{color:var(--text-secondary);margin:.2rem 0 .3rem}
.example .detail{color:var(--text-secondary);font-size:.84rem;border-top:1px dashed var(--border);padding-top:.4rem;margin-top:.4rem}
.example a{color:var(--primary-500);text-decoration:none;font-size:.8rem}
.example a:hover{text-decoration:underline}
.takeaway{margin-top:.8rem;padding:.75rem .9rem;background:#fffbeb;border-radius:.5rem;font-size:.88rem;color:var(--text-secondary);line-height:1.75}
.takeaway strong{color:var(--text-primary)}
.editorial{margin-top:1rem;padding:.8rem .95rem;background:var(--primary-50);border-radius:.5rem;border-left:3px solid var(--primary-500);font-size:.88rem;color:var(--text-secondary);line-height:1.8}
.editorial .label{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--primary-600);display:block;margin-bottom:.2rem}
.quick-link{display:block;padding:.65rem 0;border-bottom:1px solid var(--border)}
.quick-link:last-child{border-bottom:none}
.quick-link a{font-size:.92rem;font-weight:600;color:var(--text-primary);text-decoration:none}
.quick-link a:hover{color:var(--primary-500)}
.quick-summary{font-size:.85rem;color:var(--text-secondary);line-height:1.7;display:block;margin-top:.1rem}
.archive-item{display:flex;align-items:baseline;gap:.75rem;padding:.55rem 0;border-bottom:1px solid var(--border)}
.archive-item:last-child{border-bottom:none}
.archive-item .week{font-size:.78rem;color:var(--text-muted);flex-shrink:0;font-variant-numeric:tabular-nums}
.archive-item .body a{font-size:.9rem;font-weight:600;color:var(--text-primary);text-decoration:none}
.archive-item .body a:hover{color:var(--primary-500)}
.archive-item .body .sub{font-size:.8rem;color:var(--text-muted);display:block}
footer{text-align:center;margin-top:3rem;padding-top:1.5rem;border-top:1px solid var(--border);color:var(--text-muted);font-size:.8rem}
footer a{color:var(--primary-500);text-decoration:none}
@media(max-width:600px){body{padding:1rem .75rem}header h1{font-size:1.4rem}.theme-hero{padding:1.1rem}.theme-hero h2{font-size:1.15rem}}
@media(prefers-color-scheme:dark){:root{--bg:#0f0f1a;--surface:#1a1a2e;--text-primary:#e4e4ec;--text-secondary:#a0a0b8;--text-muted:#6b6b80;--border:#2a2a3e;--primary-50:#1a1a3e;--primary-600:#5b8af5;--primary-500:#6b9af5}.tag-ai{background:#2d1b69}.theme-hero{background:linear-gradient(135deg,#1a1a3e,#1f1a3e)}.takeaway{background:#2a2510}}`;

function renderPage(issue, allIssues, latestWeek, fromIsLatest) {
  const minutes = computeReadingMinutes(issue);
  const lastIdx = issue.theme.sections.length - 1;
  const editorialHtml = renderEditorial(issue.editorial);
  const sections = issue.theme.sections.map((s, idx) => renderSection(s, idx, idx === lastIdx ? editorialHtml : '')).join('\n\n');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI プロダクト動向 | Tech News Daily</title>
<link rel="icon" type="image/png" sizes="32x32" href="${fromIsLatest ? '' : '../'}favicon-32.png">
<style>
${PAGE_STYLE}
</style>
</head>
<body>
<div class="container">
${renderHeader(issue, minutes, fromIsLatest)}

${renderHero(issue)}

${renderTldr(issue.theme.tldr)}

${sections}

${renderQuickPicks(issue.quick_picks)}

${renderArchiveList(allIssues, latestWeek, issue.week, fromIsLatest)}

${renderFooter(issue, fromIsLatest)}
</div>
</body>
</html>
`;
}

function renderPlaceholderPage() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI プロダクト動向 | Tech News Daily</title>
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">
<style>
${PAGE_STYLE}
</style>
</head>
<body>
<div class="container">
<header>
  <h1>🧠 AI プロダクト動向</h1>
  <p class="tagline">実プロダクトのアーキテクチャ・使用例から AI 開発の現在地を週 3 回・1 号 1 テーマで深掘り</p>
  <nav class="site-nav">
    <a href="./">📰 日刊ダイジェスト</a>
    <a href="trends.html">🔌 プラグイントレンド</a>
    <a href="#" class="active">🧠 AI プロダクト動向</a>
  </nav>
</header>
<div class="section">
  <div class="section-title">準備中</div>
  <p style="color:var(--text-secondary);font-size:.92rem">最初の号は次回の定期 run（毎週火・木・土 07:00 JST）で公開されます。</p>
</div>
<footer>
  <p style="margin-top:.5rem"><a href="./">📰 日刊ダイジェストに戻る</a></p>
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
  const outRoot = args.outRoot ? path.resolve(args.outRoot) : ROOT;
  const issuesDir = path.join(outRoot, 'ai-trends');

  const issues = await loadAllIssues(dataDir);

  if (issues.length === 0) {
    await writeFile(path.join(outRoot, 'ai-trends.html'), renderPlaceholderPage());
    console.log('[render-ai-trends] no issues found — wrote placeholder ai-trends.html');
    return;
  }

  const latest = issues[issues.length - 1];
  await mkdir(issuesDir, { recursive: true });
  await writeFile(path.join(outRoot, 'ai-trends.html'), renderPage(latest, issues, latest.week, true));
  for (const issue of issues) {
    await writeFile(path.join(issuesDir, `${issue.week}.html`), renderPage(issue, issues, latest.week, false));
  }
  console.log(`[render-ai-trends] wrote ai-trends.html (latest: ${latest.week}) and ${issues.length} issue page(s) under ai-trends/`);
}

main().catch((err) => {
  console.error(`[render-ai-trends] fatal: ${err.message}`);
  process.exitCode = 1;
});

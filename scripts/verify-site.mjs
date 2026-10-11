#!/usr/bin/env node
// Read-only checks against the exact deployed snapshot; no cloud credentials.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageAssets } from './stage-static-assets.mjs';

const excluded = ['/scripts/stage-static-assets.mjs', '/prompts/daily-digest.md',
  '/wrangler.jsonc', '/workers/news-monitor/wrangler.jsonc', '/AGENTS.md',
  '/.git/config', '/.github/workflows/daily-digest.yml', '/.claude/state/private.json',
  '/data/.private/token.json', '/__migration_missing__', '/archive/__migration_missing__.html'];
const canonical = file => file === 'index.html' ? '/' : file.endsWith('/index.html')
  ? `/${file.slice(0, -10)}` : `/${file.replace(/\.html$/, '')}`;
const media = file => file.endsWith('.html') ? ['text/html'] : file.endsWith('.css')
  ? ['text/css'] : file.endsWith('.json') ? ['application/json'] : file.endsWith('.xml')
    ? ['application/atom+xml', 'application/xml', 'text/xml'] : ['image/png'];

export async function verifySite(source, origin, { fetchImpl = fetch, log = console.log } = {}) {
  const base = new URL(origin);
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw Error('Expected an HTTPS origin (HTTP allowed only for loopback preview)');
  }
  const temp = await mkdtemp(path.join(tmpdir(), 'verify-site-'));
  try {
    const staged = path.join(temp, 'public');
    const stats = await stageAssets(source, staged);
    async function latest(directory, pattern) {
      const name = (await readdir(path.join(staged, directory))).filter(name => pattern.test(name)).sort().at(-1);
      if (!name) throw Error(`No representative asset in ${directory}`);
      return `${directory}/${name}`;
    }
    const files = ['index.html', 'trends.html', 'ai-trends.html', 'style.css', 'feed.xml',
      'favicon-32.png', 'favicon.png', 'apple-touch-icon.png', 'archive/index.html',
      await latest('archive', /^\d{4}-\d{2}-\d{2}\.html$/),
      await latest('ai-trends', /^\d{4}-\d{2}-\d{2}\.html$/),
      await latest('data/ai-trends', /^\d{4}-\d{2}-\d{2}\.json$/), 'data/plugins/trends.json'];
    async function get(route) {
      let url = new URL(route, base);
      const signal = AbortSignal.timeout(10000);
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw Error(`${route}: redirect without Location`);
          const next = new URL(location, url);
          if (next.origin !== base.origin || next.username || next.password) throw Error(`${route}: cross-origin redirect`);
          url = next;
          continue;
        }
        // Bound responses even if a bad host returns a streaming/oversized page.
        const chunks = []; let size = 0;
        for await (const chunk of response.body ?? []) {
          size += chunk.length;
          if (size > 25 * 1024 * 1024) throw Error(`${route}: response exceeds asset size limit`);
          chunks.push(chunk);
        }
        return { status: response.status, type: response.headers.get('content-type')?.split(';')[0].trim(),
          url, body: Buffer.concat(chunks) };
      }
      throw Error(`${route}: too many redirects`);
    }
    let checked = 0;
    for (const file of files) {
      const route = file === 'index.html' ? '/' : file === 'archive/index.html' ? '/archive/' : `/${file}`;
      const response = await get(route);
      if (response.status !== 200 || response.url.pathname !== canonical(file) || response.url.search || response.url.hash) {
        throw Error(`${route}: expected 200 at ${canonical(file)}, got ${response.status} at ${response.url.pathname}`);
      }
      if (!media(file).includes(response.type)) throw Error(`${route}: incorrect media type`);
      if (!response.body.equals(await readFile(path.join(staged, file)))) throw Error(`${route}: bytes differ from snapshot`);
      log(`PASS ${route}: canonical path, media type and source bytes`); checked++;
    }
    for (const route of excluded) {
      const response = await get(route);
      if (response.status !== 404) throw Error(`${route}: expected 404, got ${response.status}`);
      log(`PASS ${route}: 404`); checked++;
    }
    return { checked, staged: stats, origin: base.origin };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, origin, ...extra] = process.argv.slice(2);
  if (!source || !origin || extra.length) {
    console.error('usage: node scripts/verify-site.mjs DEPLOYED_SNAPSHOT HTTPS_ORIGIN'); process.exitCode = 1;
  } else {
    verifySite(source, origin).then(result => console.log(JSON.stringify(result))).catch(error => {
      console.error(`Site verification failed: ${error.message}`); process.exitCode = 1;
    });
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { verifySite } from '../verify-site.mjs';

async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'site-check-test-'));
  const files = ['index.html', 'trends.html', 'ai-trends.html', 'style.css', 'feed.xml',
    'favicon-32.png', 'favicon.png', 'apple-touch-icon.png', 'archive/index.html',
    'archive/2026-10-09.html', 'ai-trends/2026-10-10.html',
    'data/ai-trends/2026-10-10.json', 'data/plugins/trends.json'];
  const served = new Map();
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), file);
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.json') ? 'application/json'
      : file.endsWith('.xml') ? 'application/atom+xml' : file.endsWith('.css') ? 'text/css' : 'image/png';
    const route = file === 'index.html' ? '/' : file === 'archive/index.html' ? '/archive/' : `/${file.replace(/\.html$/, '')}`;
    served.set(route, () => new Response(file, { headers: { 'content-type': `${type}; charset=utf-8` } }));
    if (file.endsWith('.html') && !file.endsWith('index.html')) served.set(`/${file}`, () => new Response(null, { status: 308, headers: { location: route } }));
  }
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url.href); assert.equal(options.redirect, 'manual'); assert.equal(options.method, 'GET');
    return (served.get(url.pathname) ?? (() => new Response('missing', { status: 404 })))();
  };
  try { await fn(root, served, fetchImpl, calls); } finally { await rm(root, { recursive: true, force: true }); }
}
const options = fetchImpl => ({ fetchImpl, log: () => {} });
test('checks all publications, canonical redirects, media, bytes and excluded paths without credentials', async () => {
  await fixture(async (root, served, fetchImpl) => {
    const result = await verifySite(root, 'https://site.example', options(fetchImpl));
    assert.equal(result.checked, 24); assert.equal(result.staged.files, 13);
  });
});
test('rejects stale content, wrong media, HTML fallback and noncanonical routes', async () => {
  for (const [route, response, error] of [
    ['/', () => new Response('old', { headers: { 'content-type': 'text/html' } }), /bytes differ/],
    ['/', () => new Response('index.html', { headers: { 'content-type': 'text/plain' } }), /media type/],
    ['/scripts/stage-static-assets.mjs', () => new Response('index.html'), /expected 404/],
    ['/trends.html', () => new Response('trends.html', { headers: { 'content-type': 'text/html' } }), /expected 200 at \/trends/],
  ]) await fixture(async (root, served, fetchImpl) => {
    served.set(route, response); await assert.rejects(verifySite(root, 'https://site.example', options(fetchImpl)), error);
  });
});
test('rejects redirect escape and loops without fetching another origin', async () => {
  for (const location of ['https://other.example/', 'http://site.example/', '/']) {
    await fixture(async (root, served, fetchImpl, calls) => {
      served.set('/', () => new Response(null, { status: 302, headers: { location } }));
      await assert.rejects(verifySite(root, 'https://site.example', options(fetchImpl)), /cross-origin|too many redirects/);
      assert.ok(calls.every(url => url === 'https://site.example/')); assert.ok(calls.length <= 4);
    });
  }
});
test('rejects unsafe origins and network/TLS failures rather than passing an incomplete check', async () => {
  for (const origin of ['http://site.example', 'https://site.example/path', 'https://user:pass@site.example', 'https://site.example/?query']) {
    await assert.rejects(verifySite('/unused', origin), /HTTPS origin/);
  }
  await fixture(async root => {
    await assert.rejects(verifySite(root, 'https://site.example', options(async () => { throw Error('TLS failed'); })), /TLS failed/);
  });
});

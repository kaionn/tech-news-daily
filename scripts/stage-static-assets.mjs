#!/usr/bin/env node
// Only public site files from an archived Git snapshot may become Worker assets.
import { readdir, lstat, mkdir, copyFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT_FILES = ['index.html', 'trends.html', 'ai-trends.html', 'style.css', 'feed.xml',
  'favicon-32.png', 'favicon.png', 'apple-touch-icon.png'];
const PUBLIC_TREES = { archive: '.html', 'ai-trends': '.html', data: '.json' };
const MAX_FILES = 20000, MAX_BYTES = 25 * 1024 * 1024;

export async function stageAssets(source, output) {
  source = path.resolve(source); output = path.resolve(output);
  const inside = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
  if (inside(source, output) || inside(output, source)) throw Error('source and output must be separate trees');
  if (!(await lstat(source)).isDirectory()) throw Error('source must be a real directory');
  const files = [];
  async function collect(relative) {
    const stat = await lstat(path.join(source, relative));
    if (!stat.isFile()) throw Error(`public asset is not a regular file: ${relative}`);
    if (stat.size > MAX_BYTES) throw Error(`asset exceeds Workers Free file size limit: ${relative}`);
    files.push({ relative, bytes: stat.size });
    if (files.length > MAX_FILES) throw Error('assets exceed Workers Free file count limit');
  }
  async function walk(relative, extension) {
    if (!(await lstat(path.join(source, relative))).isDirectory()) throw Error(`public tree is not a real directory: ${relative}`);
    for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw Error(`symlink in public tree: ${child}`);
      if (entry.isDirectory()) await walk(child, extension);
      else if (entry.name.endsWith(extension)) await collect(child);
    }
  }
  for (const file of ROOT_FILES) await collect(file);
  for (const [directory, extension] of Object.entries(PUBLIC_TREES)) await walk(directory, extension);
  // Refuse reuse: stale assets from a previous edition must never survive staging.
  await mkdir(output);
  for (const { relative } of files) {
    await mkdir(path.dirname(path.join(output, relative)), { recursive: true });
    await copyFile(path.join(source, relative), path.join(output, relative));
  }
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2) { console.error('usage: stage-static-assets.mjs SOURCE OUTPUT'); process.exitCode = 1; }
  else stageAssets(...args).then(stats => console.log(JSON.stringify(stats))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}

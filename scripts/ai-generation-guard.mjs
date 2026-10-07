#!/usr/bin/env node
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveIssue, issueDate, validateIssue, checkPublication, fetchText, parseOptions } from './ai-publication.mjs';

export async function generationMode({ issue, root = '.', check = checkPublication }) {
  issueDate(issue);
  let raw;
  try { raw = JSON.parse(await readFile(path.join(root, 'data/ai-trends', `${issue}.json`), 'utf8')); validateIssue(raw, issue); }
  catch (e) { if (e.code !== 'ENOENT') throw Error(`existing JSON must not be overwritten: ${e.message}`); }
  const publication = await check({ issue, expected: raw });
  return publication.published ? 'skip' : raw ? 'render' : 'generate';
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const o = parseOptions(args, ['issue']);
  let output;
  if (command === 'resolve') {
    if (o.issue) throw Error('resolve uses workflow environment');
    let createdAt;
    if (process.env.GITHUB_EVENT_NAME === 'schedule') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY ?? '') || !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '')) throw Error('invalid run context');
      // Public repo metadata: no credential or new Actions permission is required.
      const run = JSON.parse(await fetchText(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`));
      createdAt = run.created_at;
    } else createdAt = new Date().toISOString();
    output = { issue: resolveIssue({ event: process.env.GITHUB_EVENT_NAME, createdAt, requested: process.env.TARGET_ISSUE }) };
  } else if (command === 'mode') output = { mode: await generationMode({ issue: o.issue }) };
  else if (command === 'validate') {
    const raw = JSON.parse(await readFile(`data/ai-trends/${o.issue}.json`, 'utf8'));
    validateIssue(raw, o.issue); output = { valid: 'true' };
  } else throw Error('use resolve, mode, validate');
  console.log(JSON.stringify(output));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(output).map(([k,v]) => `${k}=${v}\n`).join(''));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });

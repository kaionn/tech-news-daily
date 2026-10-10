#!/usr/bin/env node
// External, credential-free publication observer. No Actions dependency or dispatch.
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { issueDate, scheduledIssue, checkPublication, newState, validateState, observe } from './ai-publication-core.mjs';
export * from './ai-publication-core.mjs';
export async function withState(file, issue, operation) {
  const dir = path.dirname(file), lock = `${file}.lock`;
  await mkdir(dir, { recursive: true });
  await mkdir(lock); // Single shared filesystem writer. EEXIST fails closed; no stale-lock stealing.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    let state;
    try { state = JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; state = newState(issue); }
    validateState(state, issue);
    const result = await operation(state);
    validateState(result.state, issue);
    await writeFile(tmp, `${JSON.stringify(result.state, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
    return result;
  } finally { await rm(tmp, { force: true }); await rm(lock, { recursive: true }); }
}
export function parseOptions(args, allowed) {
  const o = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.includes(k) || o[k] !== undefined || !args[i+1] || args[i+1].startsWith('--')) throw Error('invalid/duplicate argument');
    o[k] = args[i+1];
  }
  return o;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const o = parseOptions(args, ['issue', 'site', 'state', 'event']);
  const issue = o.issue ?? scheduledIssue(new Date()); issueDate(issue);
  if (command === 'check') {
    if (o.state || o.event) throw Error('check is read-only');
    const r = await checkPublication({ issue, site: o.site });
    console.log(JSON.stringify({ issue, ...r })); return r.published ? 0 : 1;
  }
  if (!o.state) throw Error('--state is required');
  if (command === 'observe') {
    if (o.event) throw Error('--event is only for ack');
    const r = await withState(o.state, issue, async s => {
      const publication = await checkPublication({ issue, site: o.site });
      return observe(s, { issue, now: new Date(), ...publication });
    });
    console.log(JSON.stringify({ issue, status: r.status, pending: r.pending }));
    return r.status === 'deadline_missed' ? 1 : r.status === 'published_deadline_unknown' ? 3 : 0;
  }
  if (command === 'ack') {
    if (!o.event || o.site) throw Error('ack requires --event and no --site');
    await withState(o.state, issue, async state => {
      const event = state.events.find(e => e.id === o.event);
      if (!event) throw Error('unknown event');
      if (event.kind === 'recovery' && !state.events.find(e => e.kind === 'failure')?.acked) throw Error('ack failure before recovery');
      event.acked = true;
      return { state };
    });
    return 0;
  }
  throw Error('use check, observe, or ack');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(e => { console.error(e.message); process.exitCode = 2; });
}

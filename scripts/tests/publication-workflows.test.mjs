import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const root = path.resolve('.');
const read = p => readFileSync(p, 'utf8');
const call = (cmd, args, cwd, env) => spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
function git(cwd, ...args) { const r = call('git', args, cwd); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'publication-git-'));
  const bare = path.join(dir,'remote.git'), producer = path.join(dir,'producer'), old = path.join(dir,'old');
  mkdirSync(producer); git(dir,'init','--bare',bare); git(producer,'init','-b','main');
  git(producer,'config','user.name','Test'); git(producer,'config','user.email','test@example.invalid'); git(producer,'config','commit.gpgsign','false');
  writeFileSync(path.join(producer,'index.html'),'old'); git(producer,'add','index.html'); git(producer,'commit','-m','first');
  git(producer,'remote','add','origin',bare); git(producer,'push','-u','origin','main');
  git(dir,'clone','--branch','main',bare,old);
  git(old,'config','commit.gpgsign','false');
  return { dir, producer, old, bare };
}
test('every production Cloudflare path uses one reusable lock; no generator uploads its own HEAD', () => {
  for (const name of ['daily-digest','weekly-ai-trends','weekly-plugin-trends','deploy-site']) {
    const s = read(`.github/workflows/${name}.yml`);
    assert.match(s, /uses: \.\/\.github\/workflows\/deploy-current-site.yml/);
    assert.ok(!s.includes('wrangler@4')); assert.ok(!s.includes('git archive HEAD'));
  }
  const deploy = read('.github/workflows/deploy-current-site.yml');
  assert.match(deploy, /concurrency:\n\s+group: site-deploy\n\s+cancel-in-progress: false/);
  assert.match(deploy, /ref: main/);
  assert.ok(!read('.github/workflows/deploy-site.yml').includes('concurrency:'));
  assert.match(read('scripts/deploy-current-site.sh'), /git rev-parse origin\/main/);
});
test('natural/recovery path fixes issue once, gates model execution and preserves Git tool bans and Opus', () => {
  const s = read('.github/workflows/weekly-ai-trends.yml');
  assert.match(s, /issue_date:[\s\S]*required: true/);
  assert.ok(!s.includes("TZ=Asia/Tokyo date"));
  assert.match(s, /if: steps\.guard\.outputs\.mode == 'generate'/);
  assert.match(s, /if: steps\.guard\.outputs\.mode != 'skip'/);
  assert.match(s, /--model claude-opus-5-5/);
  for (const tool of ['git add','git commit','git push','git config','git reset','git rebase']) assert.ok(s.includes(`Bash(${tool}:*)`));
  assert.match(s, /node scripts\/ai-generation-guard.mjs validate/);
  assert.match(read('prompts/weekly-ai-trends.md'), /Never overwrite or regenerate an existing issue/);
});
test('a delayed caller at old HEAD deploys newest main including the other workflow; HEAD mutation exposes rollback', () => {
  const r = repo();
  try {
    writeFileSync(path.join(r.producer,'index.html'),'new daily digest'); git(r.producer,'add','index.html'); git(r.producer,'commit','-m','new'); git(r.producer,'push');
    const bin = path.join(r.dir,'bin'); mkdirSync(bin);
    writeFileSync(path.join(bin,'npx'),'#!/bin/sh\ncp "$5/index.html" "$CAPTURE"\n', { mode: 0o755 });
    const capture = path.join(r.dir,'captured');
    const env = { PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture };
    const result = call('bash',[path.join(root,'scripts/deploy-current-site.sh')],r.old,env);
    assert.equal(result.status,0,result.stderr); assert.equal(read(capture),'new daily digest');
    // Red probe: replacing origin/main with caller HEAD reproduces the old rollback.
    const mutant = path.join(r.dir,'mutant.sh'); writeFileSync(mutant,read('scripts/deploy-current-site.sh').replace('git rev-parse origin/main','git rev-parse HEAD'));
    assert.equal(call('bash',[mutant],r.old,env).status,0); assert.equal(read(capture),'old');
  } finally { rmSync(r.dir,{recursive:true}); }
});
test('same-date competing JSON is refused before commit/push, existing normal JSON clean tree requests deploy', () => {
  const r = repo(), issue = '2026-10-06';
  try {
    for (const target of [r.old,r.producer]) mkdirSync(path.join(target,'data/ai-trends'),{recursive:true});
    const file = `data/ai-trends/${issue}.json`;
    writeFileSync(path.join(r.producer,file),'other generation'); git(r.producer,'add',file); git(r.producer,'commit','-m','other generation'); git(r.producer,'push');
    writeFileSync(path.join(r.old,file),'late generation');
    const output = path.join(r.dir,'output');
    let result = call('bash',[path.join(root,'scripts/publish-ai-trends.sh')],r.old,{ ISSUE:issue,GITHUB_OUTPUT:output });
    assert.notEqual(result.status,0); assert.match(result.stdout,/Target JSON changed/); assert.equal(git(r.producer,'show',`HEAD:${file}`),'other generation');
    // New checkout with the normal issue and unchanged renderer can still recover deploy failure.
    git(r.old,'fetch','origin','main');
    // Test-owned untracked file must be removed before fast-forward.
    rmSync(path.join(r.old,file)); git(r.old,'merge','--ff-only','origin/main');
    mkdirSync(path.join(r.old,'ai-trends')); writeFileSync(path.join(r.old,'ai-trends/.keep'),''); writeFileSync(path.join(r.old,'ai-trends.html'),'html');
    git(r.old,'config','user.name','Test'); git(r.old,'config','user.email','test@example.invalid'); git(r.old,'add','ai-trends','ai-trends.html'); git(r.old,'commit','-m','render'); git(r.old,'push');
    result = call('bash',[path.join(root,'scripts/publish-ai-trends.sh')],r.old,{ ISSUE:issue,GITHUB_OUTPUT:output });
    assert.equal(result.status,0,result.stderr); assert.match(read(output),/deploy=true/);
  } finally { rmSync(r.dir,{recursive:true}); }
});

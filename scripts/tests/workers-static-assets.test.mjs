import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, symlinkSync, truncateSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stageAssets } from '../stage-static-assets.mjs';

const root = path.resolve('.');
const write = (base, name, text) => { mkdirSync(path.dirname(path.join(base, name)), { recursive: true }); writeFileSync(path.join(base, name), text); };
function fixture(base) {
  for (const name of ['index.html','trends.html','ai-trends.html','style.css','feed.xml','favicon-32.png','favicon.png','apple-touch-icon.png']) write(base, name, name);
  for (const name of ['archive/index.html','archive/2026-10-09.html','ai-trends/2026-10-10.html','data/ai-trends/2026-10-10.json','data/plugins/trends.json']) write(base,name,name);
}
function files(base, prefix = '') {
  return readdirSync(path.join(base,prefix), { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(base,path.join(prefix,e.name)) : [path.join(prefix,e.name)]).sort();
}
test('all three publications, archive, Atom and public JSON retain exact paths/bytes; implementation files are excluded', async () => {
  const dir = mkdtempSync(path.join(tmpdir(),'workers-assets-'));
  try {
    const source=path.join(dir,'source'), output=path.join(dir,'public'); fixture(source);
    const wanted=files(source);
    for (const name of ['.claude/state/secret.json','archive/.claude/state/private.html','data/.private/token.json','scripts/private.json','prompts/private.html','workers/news-monitor/wrangler.jsonc','README.md','archive/notes.md','data/notes.txt']) write(source,name,'must not publish');
    const stats=await stageAssets(source,output);
    assert.deepEqual(files(output),wanted); assert.equal(stats.files,wanted.length);
    for (const name of wanted) assert.deepEqual(readFileSync(path.join(output,name)),readFileSync(path.join(source,name)));
    await assert.rejects(stageAssets(source,output),/EEXIST/);
  } finally { rmSync(dir,{recursive:true}); }
});
test('unsafe symlinks, missing required pages, overlapping trees and Free file-size overflow fail before upload', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'workers-assets-bad-'));
  try {
    const source=path.join(dir,'source'); fixture(source);
    await assert.rejects(stageAssets(source,path.join(source,'public')),/separate trees/);
    symlinkSync(path.join(source,'index.html'),path.join(source,'data/escape.json'));
    await assert.rejects(stageAssets(source,path.join(dir,'public')),/symlink/);
    rmSync(path.join(source,'data/escape.json'));
    truncateSync(path.join(source,'favicon.png'),25*1024*1024+1);
    await assert.rejects(stageAssets(source,path.join(dir,'public')),/file size limit/);
    write(source,'favicon.png','png'); rmSync(path.join(source,'ai-trends.html'));
    await assert.rejects(stageAssets(source,path.join(dir,'public')),/ENOENT/);
    assert.equal(existsSync(path.join(dir,'public')),false);
  } finally { rmSync(dir,{recursive:true}); }
});
test('site Worker has only assets and no monitor, public route, cron or SPA fallback', () => {
  const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  assert.equal(config.name,'tech-news-daily-site'); assert.equal(config.workers_dev,false); assert.equal(config.preview_urls,false);
  assert.deepEqual(config.assets,{directory:'./public',html_handling:'auto-trailing-slash',not_found_handling:'none'});
  for (const key of ['main','routes','triggers','durable_objects','kv_namespaces','vars']) assert.equal(config[key],undefined);
  assert.match(readFileSync('.github/workflows/deploy-current-site.yml','utf8'),/SITE_DEPLOY_TARGET: \$\{\{ vars\.SITE_DEPLOY_TARGET \}\}/);
});
test('more than 20,000 public files fails before staging instead of requiring a paid plan', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'workers-assets-count-'));
  try {
    const source=path.join(dir,'source'), output=path.join(dir,'public'); fixture(source);
    // Fixture has 13 files; 19,988 additions make the first forbidden total.
    for (let i=0;i<19988;i++) write(source,`data/extra-${i}.json`,'{}');
    await assert.rejects(stageAssets(source,output),/file count limit/);
    assert.equal(existsSync(output),false);
  } finally { rmSync(dir,{recursive:true}); }
});
test('invalid deployment target is refused before fetch or uploader, without implicit fallback', () => {
  const r=spawnSync('bash',[path.join(root,'scripts/deploy-current-site.sh')],{cwd:tmpdir(),encoding:'utf8',env:{...process.env,SITE_DEPLOY_TARGET:'worker'}});
  assert.notEqual(r.status,0); assert.match(r.stdout,/must be pages or workers/); assert.ok(!r.stderr.includes('not a git repository'));
});
test('delayed Workers caller deploys latest main public snapshot/config, preserves Pages default and propagates upload failure', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'workers-deploy-'));
  const run=(cmd,args,cwd,env={})=>spawnSync(cmd,args,{cwd,encoding:'utf8',env:{...process.env,...env}});
  const git=(cwd,...args)=>{const r=run('git',args,cwd); assert.equal(r.status,0,r.stderr); return r.stdout.trim();};
  try {
    const producer=path.join(dir,'producer'), old=path.join(dir,'old'), bare=path.join(dir,'remote.git'), bin=path.join(dir,'bin');
    mkdirSync(producer); mkdirSync(bin); git(dir,'init','--bare',bare); git(producer,'init','-b','main');
    git(producer,'config','user.name','Test'); git(producer,'config','user.email','test@example.invalid'); git(producer,'config','commit.gpgsign','false');
    fixture(producer); write(producer,'index.html','old digest');
    for (const name of ['wrangler.jsonc','scripts/stage-static-assets.mjs']) { mkdirSync(path.dirname(path.join(producer,name)),{recursive:true}); cpSync(path.join(root,name),path.join(producer,name)); }
    write(producer,'.claude/state/private.json','not public');
    git(producer,'add','index.html','trends.html','ai-trends.html','style.css','feed.xml','favicon-32.png','favicon.png','apple-touch-icon.png','archive','ai-trends','data','wrangler.jsonc','scripts/stage-static-assets.mjs','.claude/state/private.json');
    git(producer,'commit','-m','old'); git(producer,'remote','add','origin',bare); git(producer,'push','-u','origin','main'); git(dir,'clone','--branch','main',bare,old);
    write(producer,'index.html','new digest'); write(producer,'data/plugins/trends.json','new plugin metrics');
    git(producer,'add','index.html','data/plugins/trends.json'); git(producer,'commit','-m','new'); git(producer,'push');
    const sha=git(producer,'rev-parse','HEAD');
    // Fake external uploader captures arguments and payload, never contacts Cloudflare.
    writeFileSync(path.join(bin,'npx'),`#!/bin/sh
set -eu
if [ "$3" = "pages" ]; then
 cp "$5/index.html" "$CAPTURE/pages"
else
 cp -R "$(dirname "$5")/public" "$CAPTURE/public"
 cp "$5" "$CAPTURE/config.json"
 printf '%s\\n' "$7" > "$CAPTURE/message"
fi
exit "\${UPLOAD_EXIT:-0}"
`,{mode:0o755});
    const capture=path.join(dir,'capture'); mkdirSync(capture);
    const env={PATH:`${bin}:${process.env.PATH}`,CAPTURE:capture,SITE_DEPLOY_TARGET:'workers'};
    let result=run('bash',[path.join(root,'scripts/deploy-current-site.sh')],old,env);
    assert.equal(result.status,0,result.stderr); assert.equal(readFileSync(path.join(capture,'public/index.html'),'utf8'),'new digest');
    assert.equal(readFileSync(path.join(capture,'public/data/plugins/trends.json'),'utf8'),'new plugin metrics');
    assert.equal(readFileSync(path.join(capture,'message'),'utf8').trim(),`main ${sha}`);
    assert.equal(existsSync(path.join(capture,'public/.claude')),false); assert.equal(existsSync(path.join(capture,'public/scripts')),false);
    assert.equal(JSON.parse(readFileSync(path.join(capture,'config.json'),'utf8')).name,'tech-news-daily-site');
    result=run('bash',[path.join(root,'scripts/deploy-current-site.sh')],old,{...env,SITE_DEPLOY_TARGET:''});
    assert.equal(result.status,0,result.stderr); assert.equal(readFileSync(path.join(capture,'pages'),'utf8'),'new digest');
    result=run('bash',[path.join(root,'scripts/deploy-current-site.sh')],old,{...env,UPLOAD_EXIT:'17'});
    assert.equal(result.status,17,result.stderr);
  } finally { rmSync(dir,{recursive:true}); }
});

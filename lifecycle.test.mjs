import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const agent = fileURLToPath(new URL('./agent.mjs', import.meta.url));
const result = { verdict: 'pass', body: 'Fixture review.' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, describe, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check().catch(() => false)) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${describe}`);
}
async function fixture(codex, fn, extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lifecycle-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  // Saved ChatGPT sign-ins for up to three concurrency slots.
  for (const home of ['codex-home', 'codex-home-2', 'codex-home-3']) { await mkdir(join(dir, home)); await writeFile(join(dir, home, 'auth.json'), '{}'); }
  const statePath = join(dir, 'prs-example--repo.json');
  const fixturePR = { number: 1, draft: false, state: 'open', head: { sha: 'a'.repeat(40) }, base: { ref: 'dev', sha: 'b'.repeat(40) }, title: 'Fixture', body: '' };
  await writeFile(join(dir, 'pr.json'), JSON.stringify(fixturePR));
  // Real Git checkout behavior is covered in agent.test.mjs; these stubs isolate failure handling.
  await writeFile(join(bin, 'git'), `#!/usr/bin/env node
import {mkdirSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='init') mkdirSync(args.at(-1),{recursive:true});
if(args[0]==='merge-base') console.log('b'.repeat(40));
if(args.includes('worktree')) {
 const base=args.at(-2);mkdirSync(base+'/skills/review',{recursive:true});
 writeFileSync(base+'/skills/review/SKILL.md','Read-only fixture review');
}
`, { mode: 0o700 });
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
writeFileSync(process.env.DATA_DIR+'/codex-pid',String(process.pid));
appendFileSync(process.env.DATA_DIR+'/codex-pids',process.pid+'\\n');
const args=process.argv.slice(2);let input='';for await(const part of process.stdin) input+=part;
const output=args[args.indexOf('-o')+1];const result=${JSON.stringify(result)};
${codex}
`, { mode: 0o700 });
  const loader = join(dir, 'mock.mjs');
  await writeFile(loader, `import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
// Speed up discovery polling ticks for deterministic lifecycle tests.
if(process.env.FAST_POLL==='true') { const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===1000?50:ms,...args); }
globalThis.fetch=async(url,options={})=>{
 const path=new URL(url).pathname;
 const statusFile=process.env.DATA_DIR+'/commit-statuses';
 const history=existsSync(statusFile)?JSON.parse(readFileSync(statusFile,'utf8')):[];
 if(path.includes('/commits/') && path.endsWith('/statuses')) return new Response(JSON.stringify(history.filter(s=>s.sha===path.split('/').at(-2)).reverse()));
 if(path.includes('/statuses/')) {
  if(existsSync(process.env.DATA_DIR+'/fail-status')) return new Response(JSON.stringify({message:'Fixture status failure'}),{status:503});
  const body={id:history.length+1,sha:path.split('/').at(-1),...JSON.parse(options.body)};
  history.push(body);appendFileSync(process.env.DATA_DIR+'/status-attempts','post\\n');
  writeFileSync(statusFile,JSON.stringify(history));
  return new Response(JSON.stringify(body));
 }

 if(path.endsWith('/pulls')) {
  appendFileSync(process.env.DATA_DIR+'/scans','scan\\n');
  if(existsSync(process.env.DATA_DIR+'/fail-discovery')) return new Response(JSON.stringify({message:'Fixture discovery failure'}),{status:503});
 }
 const stored=JSON.parse(readFileSync(process.env.DATA_DIR+'/pr.json','utf8'));
 const prs=existsSync(process.env.DATA_DIR+'/prs.json')?JSON.parse(readFileSync(process.env.DATA_DIR+'/prs.json','utf8')):[stored];
 const number=Number(path.match(/\\/pulls\\/(\\d+)/)?.[1]);
 const pr=prs.find(p=>p.number===number)??stored;
 if(options.method==='POST') {
  const body=JSON.parse(options.body);appendFileSync(process.env.DATA_DIR+'/posts',JSON.stringify(body)+'\\n');
  if(existsSync(process.env.DATA_DIR+'/fail-delivery')) return new Response(JSON.stringify({message:'Fixture delivery failure'}),{status:503});
  return new Response(JSON.stringify({id:1,state:'APPROVED',commit_id:body.commit_id}));
 }
 return new Response(JSON.stringify(path.endsWith('/pulls')?prs.filter(p=>p.state==='open'):path.includes('/reviews')?[]:pr));
};`);
  const runEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, CODEX_HOME: join(dir, 'codex-home'), DATA_DIR: dir, WORKSPACE: join(dir, 'workspace'), GITHUB_TOKEN: 'fixture-github', GITHUB_REPO: 'example/repo', SKILL: 'skills/review', TARGET_BRANCHES: 'main,dev', RUN_EXISTING: 'true', POLL_SECONDS: '15', ...extraEnv };
  let current;
  let logs = '';
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  const start = () => {
    assert.equal(current, undefined);
    const proc = spawn(process.execPath, ['--import', loader, agent, 'watch'], { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise(resolve => proc.once('close', (code, signal) => resolve({ code, signal })));
    current = { proc, closed, done: false };
    const run = current;
    closed.then(() => { run.done = true; });
    proc.stdout.on('data', p => logs += p); proc.stderr.on('data', p => logs += p);
  };
  const stop = async () => {
    current.proc.kill('SIGTERM');
    await until(async () => current.done, 'agent shutdown: ' + logs);
    const closed = await current.closed;
    current = undefined;
    assert.equal(closed.code, 0, logs);
  };
  const crash = async () => {
    // A container kill stops the watcher and all its descendant process groups.
    current.proc.kill('SIGKILL');
    const pids = await readFile(join(dir, 'codex-pids'), 'utf8');
    for (const pid of pids.trim().split('\n')) {
      try { process.kill(-Number(pid), 'SIGKILL'); } catch {}
    }
    const closed = await current.closed;
    current = undefined;
    assert.equal(closed.signal, 'SIGKILL');
  };
  try { await fn({ dir, start, stop, crash, state, statePath, logs: () => logs }); }
  finally {
    if (current) {
      const pids = await readFile(join(dir, 'codex-pids'), 'utf8').catch(() => '');
      for (const pid of pids.trim().split('\n').filter(Boolean)) {
        try { process.kill(-Number(pid), 'SIGKILL'); } catch {}
      }
      current.proc.kill('SIGKILL'); await current.closed;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test('discovery outages keep the heartbeat alive and preserve queued work until GitHub recovers', async () => {
  await fixture(`writeFileSync(output,JSON.stringify(result));`, async h => {
    const saved = { initialized: true, prs: {}, statuses: {}, queue: [1], lastPollAt: new Date(0).toISOString() };
    await writeFile(h.statePath, JSON.stringify(saved));
    await writeFile(join(h.dir, 'fail-discovery'), 'yes');
    h.start();
    await until(async () => Date.parse((await h.state()).lastPollAt) > 0, 'failed discovery updates heartbeat');
    const firstHeartbeat = (await h.state()).lastPollAt;
    await until(async () => (await h.state()).lastPollAt !== firstHeartbeat, 'polling continues during the outage');
    const duringOutage = await h.state();
    assert.deepEqual(duringOutage.queue, [1]);
    assert.deepEqual(duringOutage.prs, {});
    assert.deepEqual(duringOutage.statuses, {});
    assert.match(h.logs(), /Poll failed: GitHub 503: Fixture discovery failure/);
    const health = spawnSync(process.execPath, [agent, 'healthcheck'], {
      encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, DATA_DIR: h.dir, GITHUB_REPO: 'example/repo', POLL_SECONDS: '15' },
    });
    assert.equal(health.status, 0, health.stderr);
    await assert.rejects(readFile(join(h.dir, 'codex-pid')), { code: 'ENOENT' });
    await rm(join(h.dir, 'fail-discovery'));
    await until(async () => (await h.state()).prs[1]?.status === 'succeeded', 'queued review completes after recovery');
    await h.stop();
    assert.deepEqual((await h.state()).queue, []);
    assert.equal((await h.state()).prs[1].attempts, 1, 'discovery failures do not consume review attempts');
    assert.equal((await readFile(join(h.dir, 'posts'), 'utf8')).trim().split('\n').length, 1);
  }, { FAST_POLL: 'true' });
});

test('hard crash recovery removes abandoned checkouts and preserves saved data and the retry budget', async () => {
  await fixture(`
writeFileSync(process.env.DATA_DIR+'/checkout',args[args.indexOf('-C')+1]);
if(!existsSync(process.env.DATA_DIR+'/release')) {
 writeFileSync(process.env.DATA_DIR+'/ready','yes');
 while(!existsSync(process.env.DATA_DIR+'/release')) await new Promise(r=>setTimeout(r,50));
}
writeFileSync(output,JSON.stringify(result));
`, async h => {
    const retained = join(h.dir, 'runs', 'retained.md');
    await mkdir(join(h.dir, 'runs'));
    await writeFile(retained, 'existing result');
    h.start();
    await until(() => readFile(join(h.dir, 'ready')), 'first attempt running');
    const checkout = await readFile(join(h.dir, 'checkout'), 'utf8');
    assert.ok(checkout.startsWith(join(h.dir, 'workspaces')));
    await h.crash();
    assert.equal((await h.state()).prs[1].status, 'running');
    assert.equal((await h.state()).prs[1].attempts, 1);
    assert.ok((await readdir(join(h.dir, 'workspaces'))).length);
    await writeFile(join(h.dir, 'release'), 'yes');
    h.start();
    await until(async () => (await h.state()).prs[1]?.status === 'succeeded', 'crashed review recovered');
    await h.stop();
    assert.equal((await h.state()).prs[1].attempts, 2);
    assert.deepEqual(await readdir(join(h.dir, 'workspaces')), []);
    assert.equal(await readFile(retained, 'utf8'), 'existing result');
    assert.equal((await readFile(join(h.dir, 'posts'), 'utf8')).trim().split('\n').length, 1);
  });
});

test('shutdown escalates for stubborn descendants, preserves retry budget, and restart succeeds', async () => {
  await fixture(`
if(!existsSync(process.env.DATA_DIR+'/interrupted')) {
 writeFileSync(process.env.DATA_DIR+'/interrupted','yes');
 process.on('SIGTERM',()=>{});
 spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore',1,2]});
 writeFileSync(process.env.DATA_DIR+'/ready','yes');setInterval(()=>{},1000);
} else writeFileSync(output,JSON.stringify(result));
`, async h => {
    h.start();
    await until(() => readFile(join(h.dir, 'ready')), 'first run ready');
    const began = Date.now(); await h.stop();
    assert.ok(Date.now() - began < 9000, 'shutdown exceeded grace period');
    const stopped = (await h.state()).prs[1];
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.attempts, 0, 'graceful stop must not spend the attempt budget');
    h.start();
    await until(async () => (await h.state()).prs[1]?.status === 'succeeded', 'retry succeeds');
    await h.stop();
    assert.equal((await h.state()).prs[1].attempts, 1);
    assert.equal((await readFile(join(h.dir, 'posts'), 'utf8')).trim().split('\n').length, 1);
  });
});

test('task timeout kills descendants and records a retryable failure', async () => {
  await fixture(`
spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:['ignore',1,2]});
setInterval(()=>{},1000);
`, async h => {
    h.start();
    await until(async () => (await h.state()).prs[1]?.status === 'failed', 'timeout terminates the full process group');
    await h.stop();
    const entry = (await h.state()).prs[1];
    assert.match(entry.error, /timed out/);
    assert.equal(entry.attempts, 1);
    assert.ok(Date.parse(entry.retryAt) > Date.now());
  }, { TASK_TIMEOUT_SECONDS: '1' });
});

test('retry cannot submit an output left behind by a failed attempt', async () => {
  await fixture(`
appendFileSync(process.env.DATA_DIR+'/output-paths',output+'\\n');
if(!existsSync(process.env.DATA_DIR+'/first-attempt')) {
 writeFileSync(process.env.DATA_DIR+'/first-attempt','yes');writeFileSync(output,JSON.stringify(result));process.exit(1);
}
// Success exit with no output must not reuse the valid-looking file from the failed attempt.
`, async h => {
    h.start();
    await until(async () => (await h.state()).prs[1]?.status === 'failed', 'first attempt failed');
    await h.stop();
    const saved = await h.state(); saved.prs[1].retryAt = new Date(0).toISOString();
    await writeFile(h.statePath, JSON.stringify(saved));
    h.start();
    await until(async () => (await h.state()).prs[1]?.status === 'failed' && (await h.state()).prs[1]?.attempts === 2, 'second attempt fails for missing output');
    await h.stop();
    assert.match((await h.state()).prs[1].error, /ENOENT/);
    const outputs = (await readFile(join(h.dir, 'output-paths'), 'utf8')).trim().split('\n');
    assert.equal(outputs.length, 2);
    assert.notEqual(outputs[0], outputs[1]);
    await assert.rejects(readFile(join(h.dir, 'posts')), { code: 'ENOENT' });
  });
});

test('polling queues a new commit during review and skips the stale result', async () => {
  await fixture(`
const sha=input.match(/HEAD: ([a-f0-9]+)/)[1];
appendFileSync(process.env.DATA_DIR+'/executions',sha+'\\n');
if(sha==='a'.repeat(40)) {
 writeFileSync(process.env.DATA_DIR+'/ready','yes');
 while(!existsSync(process.env.DATA_DIR+'/release')) await new Promise(r=>setTimeout(r,50));
}
writeFileSync(output,JSON.stringify(result));
`, async h => {
    h.start();
    await until(() => readFile(join(h.dir, 'ready')), 'first commit under review');
    const prPath = join(h.dir, 'pr.json');
    const updated = JSON.parse(await readFile(prPath, 'utf8'));
    updated.head.sha = 'c'.repeat(40);
    await writeFile(prPath, JSON.stringify(updated));
    await until(async () => { const s=(await h.state()).statuses['1:'+updated.head.sha];return s?.delivered && /Queued/.test(s.payload.description); }, 'new commit has a queued status during review');
    assert.ok((await readFile(join(h.dir, 'scans'), 'utf8')).trim().split('\n').length >= 2);
    assert.equal((await readFile(join(h.dir, 'executions'), 'utf8')).trim(), 'a'.repeat(40));
    await writeFile(join(h.dir, 'release'), 'yes');
    await until(async () => (await h.state()).prs[1]?.sha === updated.head.sha && (await h.state()).prs[1]?.status === 'succeeded', 'new head reviewed');
    await h.stop();
    const posts = (await readFile(join(h.dir, 'posts'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].commit_id, updated.head.sha);
    assert.equal((await readFile(join(h.dir, 'executions'), 'utf8')).trim().split('\n').length, 2);
  }, { FAST_POLL: 'true' });
});

test('failed delivery waits across restarts, then retries the saved result without rerunning Codex', async () => {
  await fixture(`
appendFileSync(process.env.DATA_DIR+'/executions','run\\n');
writeFileSync(output,JSON.stringify(result));
`, async h => {
    await writeFile(join(h.dir, 'fail-delivery'), 'yes');
    h.start();
    await until(async () => Boolean((await h.state()).prs[1]?.retryAt), 'delivery failure saved');
    await pause(300);
    const pending = (await h.state()).prs[1];
    assert.equal(pending.status, 'review_pending');
    assert.ok(Date.parse(pending.retryAt) > Date.now());
    const posts = async () => (await readFile(join(h.dir, 'posts'), 'utf8')).trim().split('\n');
    assert.equal((await posts()).length, 1, 'delivery must not retry immediately');
    await h.stop();
    await rm(join(h.dir, 'fail-delivery'));
    h.start();
    await pause(500);
    assert.equal((await posts()).length, 1, 'restart must preserve delivery retry delay');
    await h.stop();
    const saved = await h.state(); saved.prs[1].retryAt = new Date(0).toISOString();
    await writeFile(h.statePath, JSON.stringify(saved));
    h.start();
    await until(async () => (await h.state()).prs[1]?.status === 'succeeded', 'saved delivery retried');
    await h.stop();
    assert.equal((await posts()).length, 2);
    assert.equal((await readFile(join(h.dir, 'executions'), 'utf8')).trim(), 'run');
    assert.equal((await h.state()).prs[1].retryAt, undefined);
  });
});

test('status publication exposes the lifecycle and does not repeat statuses after restart', async () => {
  await fixture(`writeFileSync(output,JSON.stringify(result));`, async h => {
    h.start();
    await until(async () => Object.values((await h.state()).statuses).some(s => s.delivered && s.payload.state === 'success'), 'final status delivered');
    await h.stop();
    const history = JSON.parse(await readFile(join(h.dir, 'commit-statuses'), 'utf8'));
    assert.deepEqual(history.map(s => s.state), ['pending', 'pending', 'pending', 'success']);
    assert.match(history[0].description, /^Queued/);
    assert.match(history[1].description, /running \(attempt 1\/3\)/);
    assert.match(history[2].description, /posting the result/);
    const before = (await readFile(join(h.dir, 'scans'), 'utf8')).length;
    h.start();
    await until(async () => (await readFile(join(h.dir, 'scans'), 'utf8')).length > before, 'restart scans');
    await h.stop();
    assert.equal(JSON.parse(await readFile(join(h.dir, 'commit-statuses'), 'utf8')).length, 4);
  });
});

test('status API failure does not stop review delivery; restart sends the saved final status without rerunning', async () => {
  await fixture(`appendFileSync(process.env.DATA_DIR+'/executions','run\\n');writeFileSync(output,JSON.stringify(result));`, async h => {
    await writeFile(join(h.dir, 'fail-status'), 'yes');
    h.start();
    await until(async () => Object.values((await h.state()).statuses).some(s => s.payload.state === 'success'), 'review completed despite unavailable status API');
    await h.stop();
    assert.equal((await h.state()).prs[1].status, 'succeeded');
    const saved = await h.state();
    for (const status of Object.values(saved.statuses)) {
      assert.equal(status.delivered, false);
      assert.ok(status.retryAt);
      status.retryAt = new Date(0).toISOString();
    }
    await writeFile(h.statePath, JSON.stringify(saved));
    await rm(join(h.dir, 'fail-status'));
    h.start();
    await until(async () => Object.values((await h.state()).statuses).every(s => s.delivered), 'final status recovered');
    await h.stop();
    assert.deepEqual(JSON.parse(await readFile(join(h.dir, 'commit-statuses'), 'utf8')).map(s => s.state), ['success']);
    assert.equal((await readFile(join(h.dir, 'executions'), 'utf8')).trim(), 'run');
    assert.equal((await readFile(join(h.dir, 'posts'), 'utf8')).trim().split('\n').length, 1);
  });
});

test('draft, retarget, and close/reopen cycles retain a completed review across restarts', async () => {
  await fixture(`appendFileSync(process.env.DATA_DIR+'/executions','run\\n');writeFileSync(output,JSON.stringify(result));`, async h => {
    h.start();
    await until(async () => (await h.state()).prs[1]?.status === 'succeeded', 'initial review delivered');
    await h.stop();
    const original = (await h.state()).prs[1];
    const path = join(h.dir, 'pr.json');
    const pr = JSON.parse(await readFile(path, 'utf8'));
    for (const change of [{ draft: true }, { base: { ...pr.base, ref: 'other' } }, { state: 'closed' }]) {
      await writeFile(path, JSON.stringify({ ...pr, ...change }));
      const scans = (await readFile(join(h.dir, 'scans'), 'utf8')).length;
      h.start();
      await until(async () => (await readFile(join(h.dir, 'scans'), 'utf8')).length > scans, 'ineligible PR scanned');
      await h.stop();
      assert.equal((await h.state()).prs[1]?.marker, original.marker, 'keep the review identity while ineligible');
      await writeFile(path, JSON.stringify(pr));
      const before = (await readFile(join(h.dir, 'scans'), 'utf8')).length;
      h.start();
      await until(async () => (await readFile(join(h.dir, 'scans'), 'utf8')).length > before, 'eligible again');
      await h.stop();
      assert.equal((await h.state()).prs[1]?.marker, original.marker);
    }
    assert.equal((await readFile(join(h.dir, 'executions'), 'utf8')).trim(), 'run');
    assert.equal((await readFile(join(h.dir, 'posts'), 'utf8')).trim().split('\n').length, 1);
  });
});

test('baseline PRs survive restart without attempt counts and new commits start at attempt one', async () => {
  await fixture(`writeFileSync(output,JSON.stringify(result));`, async h => {
    const path = join(h.dir, 'pr.json');
    const pr = JSON.parse(await readFile(path, 'utf8'));
    const entry = { sha: pr.head.sha, baseRef: pr.base.ref, status: 'baseline' };
    await writeFile(h.statePath, JSON.stringify({ initialized: true, prs: { 1: entry }, statuses: {}, queue: [] }));
    h.start();
    await until(async () => (await h.state()).lastPollAt, 'baseline PR observed');
    await h.stop();
    assert.deepEqual((await h.state()).prs[1], entry);
    await assert.rejects(readFile(join(h.dir, 'codex-pid')), { code: 'ENOENT' });

    const updated = { ...pr, head: { sha: 'c'.repeat(40) } };
    await writeFile(path, JSON.stringify(updated));
    h.start();
    await until(async () => (await h.state()).prs[1]?.status === 'succeeded', 'new revision reviewed');
    await h.stop();
    assert.equal((await h.state()).prs[1].sha, updated.head.sha);
    assert.equal((await h.state()).prs[1].attempts, 1);
  });
});

test('a crash on the last allowed attempt becomes an error status on restart', async () => {
  await fixture(`throw new Error('Must not execute after the retry budget is spent');`, async h => {
    await writeFile(h.statePath, JSON.stringify({ initialized: true, prs: { 1: { sha: 'a'.repeat(40), baseRef: 'dev', status: 'running', attempts: 3 } }, statuses: {}, queue: [] }));
    h.start();
    await until(async () => Object.values((await h.state()).statuses).some(s => s.delivered && s.payload.state === 'error'), 'interrupted terminal attempt reported');
    await h.stop();
    assert.equal((await h.state()).prs[1].status, 'failed');
    await assert.rejects(readFile(join(h.dir, 'codex-pid')), { code: 'ENOENT' });
  });
});

test('an open PR keeps its retry budget while temporarily ineligible', async () => {
  await fixture(`throw new Error('Retry delay has not elapsed');`, async h => {
    const entry = { sha: 'a'.repeat(40), baseRef: 'dev', status: 'failed', attempts: 2, retryAt: new Date(Date.now() + 600000).toISOString() };
    await writeFile(h.statePath, JSON.stringify({ initialized: true, prs: { 1: entry }, statuses: {}, queue: [] }));
    const path = join(h.dir, 'pr.json');
    const pr = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...pr, draft: true }));
    h.start();
    await until(() => readFile(join(h.dir, 'scans')), 'draft observed');
    await h.stop();
    assert.deepEqual((await h.state()).prs[1], entry);
    await writeFile(path, JSON.stringify(pr));
    h.start();
    await until(async () => (await h.state()).statuses[`1:${pr.head.sha}`]?.delivered, 'retry status restored');
    await h.stop();
    assert.deepEqual((await h.state()).prs[1], entry);
    await assert.rejects(readFile(join(h.dir, 'codex-pid')), { code: 'ENOENT' });
  });
});

test('concurrent workers handle a new head without overlapping the same PR or starving a queued PR', async () => {
  await fixture(`
const number=Number(input.match(/PR number: (\\d+)/)[1]);
const sha=input.match(/HEAD: ([a-f0-9]+)/)[1];
appendFileSync(process.env.DATA_DIR+'/executions',JSON.stringify({number,sha,home:process.env.CODEX_HOME})+'\\n');
if(sha==='a'.repeat(40) || sha==='c'.repeat(40)) {
 writeFileSync(process.env.DATA_DIR+'/ready-'+number,'yes');
 while(!existsSync(process.env.DATA_DIR+'/release-'+number)) await new Promise(r=>setTimeout(r,50));
}
writeFileSync(output,JSON.stringify(result));
`, async h => {
    const first = JSON.parse(await readFile(join(h.dir, 'pr.json'), 'utf8'));
    const second = { ...first, number: 2, head: { sha: 'c'.repeat(40) } };
    const third = { ...first, number: 3, head: { sha: 'd'.repeat(40) } };
    const path = join(h.dir, 'prs.json');
    await writeFile(path, JSON.stringify([first, second]));
    h.start();
    await until(async () => { await readFile(join(h.dir, 'ready-1')); await readFile(join(h.dir, 'ready-2')); return true; }, 'both workers running');
    first.head.sha = 'e'.repeat(40);
    await writeFile(path, JSON.stringify([first, second, third]));
    await until(async () => {
      const s = await h.state();
      return s.queue.includes(3) && /Queued/.test(s.statuses[`1:${first.head.sha}`]?.payload.description);
    }, 'new revision and waiting PR observed');
    const runs = async () => (await readFile(join(h.dir, 'executions'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal((await runs()).length, 2);
    assert.equal(new Set((await runs()).map(r => r.home)).size, 2);
    await writeFile(join(h.dir, 'release-2'), 'yes');
    await until(async () => (await h.state()).prs[3]?.status === 'succeeded', 'waiting PR uses the freed slot');
    assert.equal((await runs()).filter(r => r.number === 1).length, 1, 'new head waits for the active run on its PR');
    await writeFile(join(h.dir, 'release-1'), 'yes');
    await until(async () => { const s = await h.state(); return s.prs[1]?.sha === first.head.sha && [1, 2, 3].every(n => s.prs[n]?.status === 'succeeded'); }, 'latest revision and all PRs complete');
    await h.stop();
    const posts = (await readFile(join(h.dir, 'posts'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(posts.map(p => p.commit_id).sort(), ['c', 'd', 'e'].map(c => c.repeat(40)));
    assert.equal((await runs()).length, 4);
  }, { MAX_CONCURRENCY: '2', FAST_POLL: 'true' });
});

test('shutdown preserves both concurrent jobs and the waiting queue for restart', async () => {
  await fixture(`
const number=Number(input.match(/PR number: (\\d+)/)[1]);
if(!existsSync(process.env.DATA_DIR+'/release')) {
 writeFileSync(process.env.DATA_DIR+'/ready-'+number,'yes');
 while(!existsSync(process.env.DATA_DIR+'/release')) await new Promise(r=>setTimeout(r,50));
}
writeFileSync(output,JSON.stringify(result));
`, async h => {
    const pr = JSON.parse(await readFile(join(h.dir, 'pr.json'), 'utf8'));
    const prs = [1, 2, 3].map(number => ({ ...pr, number, head: { sha: ['a', 'c', 'd'][number - 1].repeat(40) } }));
    await writeFile(join(h.dir, 'prs.json'), JSON.stringify(prs));
    h.start();
    await until(async () => { await readFile(join(h.dir, 'ready-1')); await readFile(join(h.dir, 'ready-2')); return true; }, 'two concurrent jobs ready');
    await h.stop();
    const saved = await h.state();
    assert.deepEqual(saved.queue, [3]);
    for (const number of [1, 2]) {
      assert.equal(saved.prs[number].status, 'failed');
      assert.equal(saved.prs[number].attempts, 0);
    }
    await writeFile(join(h.dir, 'release'), 'yes');
    h.start();
    await until(async () => { const s = await h.state(); return [1, 2, 3].every(n => s.prs[n]?.status === 'succeeded'); }, 'all interrupted and waiting jobs completed');
    await h.stop();
    for (const number of [1, 2, 3]) assert.equal((await h.state()).prs[number].attempts, 1);
    assert.equal((await readFile(join(h.dir, 'posts'), 'utf8')).trim().split('\n').length, 3);
  }, { MAX_CONCURRENCY: '2', FAST_POLL: 'true' });
});

test('new PRs get queued statuses during a review; latest commits are used and closed PRs leave the queue', async () => {
  await fixture(`
const number=Number(input.match(/PR number: (\\d+)/)[1]);
const sha=input.match(/HEAD: ([a-f0-9]+)/)[1];
appendFileSync(process.env.DATA_DIR+'/executions',JSON.stringify({number,sha})+'\\n');
if(number===1) {
 writeFileSync(process.env.DATA_DIR+'/ready','yes');
 while(!existsSync(process.env.DATA_DIR+'/release')) await new Promise(r=>setTimeout(r,50));
}
writeFileSync(output,JSON.stringify(result));
`, async h => {
    h.start();
    await until(() => readFile(join(h.dir, 'ready')), 'first PR is running');
    const first = JSON.parse(await readFile(join(h.dir, 'pr.json'), 'utf8'));
    const second = { ...first, number: 2, head: { sha: 'c'.repeat(40) } };
    const third = { ...first, number: 3, head: { sha: 'd'.repeat(40) } };
    const list = join(h.dir, 'prs.json');
    await writeFile(list, JSON.stringify([first, second, third]));
    const queued = async (number, sha) => {
      const s = (await h.state()).statuses[`${number}:${sha}`];
      return s?.delivered && /Queued/.test(s.payload.description);
    };
    await until(async () => await queued(2, second.head.sha) && await queued(3, third.head.sha), 'new PRs visibly queued');
    assert.deepEqual((await h.state()).queue, [2, 3]);
    assert.equal((await h.state()).prs[1].status, 'running');
    assert.equal((await readFile(join(h.dir, 'executions'), 'utf8')).trim().split('\n').length, 1, 'only one PR executes');
    const previous = second.head.sha;
    second.head.sha = 'e'.repeat(40);
    third.state = 'closed';
    await writeFile(list, JSON.stringify([first, second, third]));
    await until(async () => await queued(2, second.head.sha) && !(await h.state()).queue.includes(3), 'queue refreshed with the newest head and closure');
    assert.equal((await h.state()).statuses[`2:${previous}`].payload.state, 'error');
    // The closed PR's record is pruned once delivered; the posted status itself is the observable outcome.
    const posted = async () => JSON.parse(await readFile(join(h.dir, 'commit-statuses'), 'utf8'));
    await until(async () => (await posted()).some(s => s.sha === third.head.sha && s.state === 'error'), 'closed PR status posted');
    assert.equal((await h.state()).statuses[`3:${third.head.sha}`], undefined);
    await writeFile(join(h.dir, 'release'), 'yes');
    await until(async () => (await h.state()).prs[2]?.status === 'succeeded', 'next queued PR completed');
    await h.stop();
    const runs = (await readFile(join(h.dir, 'executions'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(runs, [{ number: 1, sha: first.head.sha }, { number: 2, sha: second.head.sha }]);
  }, { FAST_POLL: 'true' });
});

test('waiting PRs survive a restart while an active review is interrupted', async () => {
  await fixture(`
const number=Number(input.match(/PR number: (\\d+)/)[1]);
appendFileSync(process.env.DATA_DIR+'/executions',number+'\\n');
if(number===1 && !existsSync(process.env.DATA_DIR+'/release')) {
 writeFileSync(process.env.DATA_DIR+'/ready','yes');
 while(!existsSync(process.env.DATA_DIR+'/release')) await new Promise(r=>setTimeout(r,50));
}
writeFileSync(output,JSON.stringify(result));
`, async h => {
    h.start();
    await until(() => readFile(join(h.dir, 'ready')), 'first PR running');
    const first = JSON.parse(await readFile(join(h.dir, 'pr.json'), 'utf8'));
    const second = { ...first, number: 2, head: { sha: 'c'.repeat(40) } };
    await writeFile(join(h.dir, 'prs.json'), JSON.stringify([first, second]));
    await until(async () => (await h.state()).queue.includes(2), 'second PR persisted in the queue');
    await h.stop();
    assert.deepEqual((await h.state()).queue, [2]);
    await writeFile(join(h.dir, 'release'), 'yes');
    h.start();
    await until(async () => {
      const s = await h.state();
      return [1, 2].every(n => s.prs[n]?.status === 'succeeded');
    }, 'waiting and interrupted work completed');
    await h.stop();
    assert.deepEqual((await readFile(join(h.dir, 'executions'), 'utf8')).trim().split('\n'), ['1', '2', '1']);
    assert.equal((await h.state()).prs[1].attempts, 1);
  }, { FAST_POLL: 'true' });
});

test('retargeting an active PR preserves the new target queued status until its own review runs', async () => {
  await fixture(`
appendFileSync(process.env.DATA_DIR+'/executions','run\\n');
if(!existsSync(process.env.DATA_DIR+'/ready')) {
 writeFileSync(process.env.DATA_DIR+'/ready','yes');
 while(!existsSync(process.env.DATA_DIR+'/release')) await new Promise(r=>setTimeout(r,50));
}
writeFileSync(output,JSON.stringify(result));
`, async h => {
    h.start();
    await until(() => readFile(join(h.dir, 'ready')), 'dev review running');
    const path = join(h.dir, 'pr.json');
    const pr = JSON.parse(await readFile(path, 'utf8')); pr.base.ref = 'main';
    await writeFile(path, JSON.stringify(pr));
    await until(async () => {
      const s = (await h.state()).statuses[`1:${pr.head.sha}`];
      return s?.baseRef === 'main' && s.delivered && /Queued/.test(s.payload.description);
    }, 'new target has a queued status');
    await writeFile(join(h.dir, 'release'), 'yes');
    await until(async () => {
      const s = await h.state();
      return s.prs[1]?.baseRef === 'main' && s.statuses[`1:${pr.head.sha}`]?.payload.state === 'success';
    }, 'main target review completed');
    await h.stop();
    assert.equal((await readFile(join(h.dir, 'posts'), 'utf8')).trim().split('\n').length, 1);
    assert.equal((await readFile(join(h.dir, 'executions'), 'utf8')).trim().split('\n').length, 2);
  }, { FAST_POLL: 'true' });
});

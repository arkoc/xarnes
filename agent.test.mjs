import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { pendingPRs, eligiblePRs, allPages, prepareReview, repositorySkillPath } from './agent.mjs';
const pr = (number, sha) => ({ number, head: { sha }, base: { ref: 'dev' } });

test('only non-draft PRs into a target branch are eligible', () => {
  const targets = new Set(['main', 'dev']);
  const into = (number, ref, draft = false) => ({ number, draft, head: { sha: 'a' }, base: { ref } });
  const prs = [into(1, 'main'), into(2, 'dev'), into(3, 'main', true), into(4, 'feature/x'), { number: 5, head: { sha: 'a' } }];
  assert.deepEqual(eligiblePRs(prs, targets).map(p => p.number), [1, 2]);
});

test('first scan skips existing PRs unless requested', () => {
  const state = { initialized: false, prs: {} };
  assert.deepEqual(pendingPRs([pr(1, 'a')], state), []);
  assert.equal(pendingPRs([pr(1, 'a')], state, { existing: true }).length, 1);
});
test('new PRs and commits trigger; completed SHAs do not repeat', () => {
  const state = { initialized: true, prs: { 1: { sha: 'a', baseRef: 'dev', status: 'succeeded' }, 2: { sha: 'b', baseRef: 'dev', status: 'baseline' } } };
  assert.deepEqual(pendingPRs([pr(1, 'a'), pr(2, 'b'), pr(4, 'd')], state).map(p => p.number), [4]);
  assert.equal(pendingPRs([pr(1, 'new')], state).length, 1);
  assert.equal(pendingPRs([pr(1, 'new')], state, { updates: false }).length, 0);
});
test('interrupted and failed runs retry within the attempt budget; failures wait for their backoff', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const state = { initialized: true, prs: {
    1: { sha: 'a', baseRef: 'dev', status: 'running', attempts: 1 },
    2: { sha: 'b', baseRef: 'dev', status: 'running', attempts: 3 },
    3: { sha: 'c', baseRef: 'dev', status: 'failed', attempts: 1, retryAt: '2026-01-01T11:59:00Z' },
    4: { sha: 'd', baseRef: 'dev', status: 'failed', attempts: 1, retryAt: '2026-01-01T12:01:00Z' },
    5: { sha: 'e', baseRef: 'dev', status: 'failed', attempts: 3 },
    6: { sha: 'f', baseRef: 'dev', status: 'failed', attempts: 0 },
  } };
  const prs = Object.entries(state.prs).map(([number, entry]) => pr(Number(number), entry.sha));
  assert.deepEqual(pendingPRs(prs, state, { now }).map(p => p.number), [1, 3, 6]);
  assert.deepEqual(pendingPRs(prs, state, { now, attempts: 1 }).map(p => p.number), [6]);
  assert.deepEqual(pendingPRs(prs, state, { now: now + 120_000 }).map(p => p.number), [1, 3, 4, 6]);
});
test('polling follows every page and propagates errors instead of marking unseen PRs', async () => {
  const calls = [];
  const result = await allPages(async path => { calls.push(path); return calls.length === 1 ? Array.from({ length: 100 }, (_, i) => pr(i, 'a')) : [pr(101, 'b')]; }, '/repos/example/repo/pulls?state=open');
  assert.equal(result.length, 101);
  assert.match(calls[1], /&per_page=100&page=2$/);
  await assert.rejects(allPages(async () => { throw new Error('rate limit'); }, '/pulls'), /rate limit/);
});
test('script runs instructions through CLI, saves output, and redacts split credential output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xarnes-test-'));
  try {
    const fake = join(dir, 'codex');
    await writeFile(fake, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);\nif (!args.includes('service_tier=\"fast\"') || !args.includes('features.fast_mode=true')) throw new Error('Fast tier was not forwarded');\nlet input=''; for await (const part of process.stdin) input+=part;\nwriteFileSync(args[args.indexOf('-o')+1], 'Done: '+input);\nprocess.stdout.write('fixture-secret-');\nsetTimeout(()=>process.stdout.write('not-for-logs\\n'),10);\n`, { mode: 0o700 });
    await mkdir(join(dir, 'home')); await writeFile(join(dir, 'home', 'auth.json'), '{}');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./agent.mjs', import.meta.url)), 'task'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, CODEX_BIN: fake, GITHUB_TOKEN: 'fixture-secret-not-for-logs', DATA_DIR: dir, CODEX_HOME: join(dir, 'home'), WORKSPACE: join(dir, 'work'), INSTRUCTIONS: 'Implement my task.', FAST_MODE: 'true' } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('fixture-secret-not-for-logs'));
    assert.match(result.stdout, /\[redacted\]/);
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(dir, 'runs'));
    assert.equal(await readFile(join(dir, 'runs', files[0]), 'utf8'), 'Done: Implement my task.');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('a failed sign-in stops the run before any task executes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xarnes-test-'));
  try {
    const fake = join(dir, 'codex');
    await writeFile(fake, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nif (process.argv[2] === 'login') { console.log('Open https://auth.example/device and enter code ABCD-0000'); process.exit(7); }\nwriteFileSync(process.env.DATA_DIR + '/executed', 'yes');\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./agent.mjs', import.meta.url)), 'task'], { encoding: 'utf8', env: { PATH: process.env.PATH, CODEX_BIN: fake, DATA_DIR: dir, CODEX_HOME: join(dir, 'home'), WORKSPACE: join(dir, 'work'), INSTRUCTIONS: 'Test' } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /needs a ChatGPT sign-in/);
    assert.match(result.stdout, /enter code ABCD-0000/);
    assert.match(result.stderr, /exited with 7/);
    await assert.rejects(readFile(join(dir, 'executed')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('incomplete persisted state stops before polling or changing saved data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xarnes-state-test-'));
  try {
    const statePath = join(dir, 'prs-example--repo.json');
    await mkdir(join(dir, 'workspaces'));
    await writeFile(join(dir, 'workspaces', 'retained'), 'keep');
    await mkdir(join(dir, 'codex')); await writeFile(join(dir, 'codex', 'auth.json'), '{}');
    const loader = join(dir, 'mock.mjs');
    await writeFile(loader, `import {writeFileSync} from 'node:fs'; globalThis.fetch=async()=>{writeFileSync(process.env.DATA_DIR+'/polled','yes'); throw Error('Must not poll');};`);
    const entry = { sha: 'a'.repeat(40), baseRef: 'dev', status: 'failed', attempts: 1 };
    const state = { initialized: true, prs: { 1: entry }, statuses: {}, queue: [] };
    const status = { number: 1, sha: entry.sha, baseRef: 'dev', payload: { state: 'pending' }, delivered: false };
    const invalid = [
      { ...state, prs: [] },
      { ...state, statuses: undefined },
      { ...state, queue: undefined },
      ...['baseRef', 'attempts'].map(field => ({ ...state, prs: { 1: { ...entry, [field]: undefined } } })),
      { ...state, prs: { 1: { ...entry, attempts: -1 } } },
      { ...state, statuses: { [`1:${entry.sha}`]: { ...status, baseRef: undefined } } },
      { ...state, queue: ['1'] },
    ];
    for (const saved of invalid) {
      const source = JSON.stringify(saved);
      await writeFile(statePath, source);
      const result = spawnSync(process.execPath, ['--import', loader, fileURLToPath(new URL('./agent.mjs', import.meta.url)), 'watch'], {
        encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, CODEX_BIN: join(dir, 'no-codex'), DATA_DIR: dir, GITHUB_REPO: 'example/repo', GITHUB_TOKEN: 'fixture-github', SKILL: 'skills/review', STATUS_CONTEXT: 'review' },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Invalid watcher state.*restore a valid backup/);
      assert.equal(await readFile(statePath, 'utf8'), source);
      assert.equal(await readFile(join(dir, 'workspaces', 'retained'), 'utf8'), 'keep');
      await assert.rejects(readFile(join(dir, 'polled')), { code: 'ENOENT' });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('healthcheck needs a recent discovery-loop heartbeat and no credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xarnes-health-test-'));
  try {
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('./agent.mjs', import.meta.url)), 'healthcheck'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, DATA_DIR: dir, GITHUB_REPO: 'example/repo', POLL_SECONDS: '15' },
    });
    const path = join(dir, 'prs-example--repo.json');
    assert.equal(run().status, 1, 'missing state is unhealthy');
    for (const [lastPollAt, expected] of [[undefined, 1], [new Date(0).toISOString(), 1], [new Date().toISOString(), 0]]) {
      await writeFile(path, JSON.stringify({ lastPollAt }));
      assert.equal(run().status, expected);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('watcher validates an explicit check name before requesting sign-in, and defaults it to the skill name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xarnes-config-test-'));
  try {
    // No STATUS_CONTEXT: validation passes with the skill's directory name and the run proceeds to sign-in.
    const defaulted = spawnSync(process.execPath, [fileURLToPath(new URL('./agent.mjs', import.meta.url)), 'watch'], { env: { PATH: process.env.PATH, DATA_DIR: dir, CODEX_BIN: join(dir, 'must-not-run'), GITHUB_REPO: 'example/repo', GITHUB_TOKEN: 'fixture-github', SKILL: 'skills/review' }, encoding: 'utf8', timeout: 5000 });
    assert.doesNotMatch(defaulted.stderr, /Set STATUS_CONTEXT/);
    assert.match(defaulted.stdout, /needs a ChatGPT sign-in/);
    for (const context of ['', '   ', '/', 'x'.repeat(201)]) {
      const env = { PATH: process.env.PATH, DATA_DIR: dir, CODEX_BIN: join(dir, 'must-not-run'),
        GITHUB_REPO: 'example/repo', GITHUB_TOKEN: 'fixture-github', SKILL: 'skills/review' };
      if (context !== undefined) env.STATUS_CONTEXT = context;
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./agent.mjs', import.meta.url)), 'watch'], { env, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Set STATUS_CONTEXT/);
      assert.doesNotMatch(result.stdout, /needs a ChatGPT sign-in/);
      await assert.rejects(readFile(join(dir, 'prs-example--repo.json')), { code: 'ENOENT' });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('without a saved sign-in, the watcher signs every slot in from its own logs, then starts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xarnes-auth-test-'));
  let w;
  try {
    const bin = join(dir, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
import {writeFileSync,appendFileSync} from 'node:fs';
if(process.argv[2]!=='login' || !process.argv.includes('--device-auth')) process.exit(9);
console.log('Open https://auth.example/device and enter code WXYZ-1234');
appendFileSync(process.env.LOGIN_LOG,'device '+process.env.CODEX_HOME+'\\n'); writeFileSync(process.env.CODEX_HOME+'/auth.json','{}');
`, { mode: 0o700 });
    const home = join(dir, 'codex'), log = join(dir, 'login-log');
    const base = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, CODEX_HOME: home, DATA_DIR: dir, MAX_CONCURRENCY: '2', LOGIN_LOG: log };
    const loader = join(dir, 'mock.mjs');
    await writeFile(loader, `globalThis.fetch=async()=>new Response('[]');`);
    w = watcher(loader, { ...base, GITHUB_REPO: 'example/repo', GITHUB_TOKEN: 'fixture-github', SKILL: 'skills/review' });
    w.start();
    await w.until(async () => JSON.parse(await readFile(join(dir, 'prs-example--repo.json'), 'utf8')).lastPollAt, 'watcher polling after device sign-in');
    await w.stop();
    assert.match(w.logs(), /slot 1 of 2 needs a ChatGPT sign-in/);
    assert.match(w.logs(), /enter code WXYZ-1234/);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [`device ${home}`, `device ${home}-2`]);
  } finally {
    await w?.stop('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('login initializes missing slots, reuses saved logins, and can renew one explicit slot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xarnes-login-test-'));
  try {
    const bin = join(dir, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
import {writeFileSync,appendFileSync} from 'node:fs';
if(process.argv[2]!=='login' || !process.argv.includes('--device-auth')) process.exit(9);
appendFileSync(process.env.LOGIN_LOG,process.env.CODEX_HOME+'\\n');
writeFileSync(process.env.CODEX_HOME+'/auth.json','{}');
`, { mode: 0o700 });
    const home = join(dir, 'codex'), log = join(dir, 'login-log');
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, CODEX_HOME: home, DATA_DIR: dir, MAX_CONCURRENCY: '3', LOGIN_LOG: log };
    const login = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./agent.mjs', import.meta.url)), 'login', ...args], { env, encoding: 'utf8' });
    assert.equal(login().status, 0);
    assert.equal(login().status, 0);
    assert.equal(login('2').status, 0);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [home, `${home}-2`, `${home}-3`, `${home}-2`]);
    const invalid = login('4');
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Usage: agent login \[1-3\]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function fixtureRepository(dir) {
  const repo = join(dir, 'source');
  await mkdir(join(repo, 'skills', 'review', 'references'), { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  await writeFile(join(repo, 'skills/review/SKILL.md'), 'Trusted BASE skill. Read references/checklist.md.');
  await writeFile(join(repo, 'skills/review/references/checklist.md'), 'Trusted BASE reference.');
  git('add', '.'); git('commit', '-qm', 'Base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'change');
  await writeFile(join(repo, 'skills/review/SKILL.md'), 'PR-controlled instructions.');
  await writeFile(join(repo, 'skills/review/references/checklist.md'), 'PR-controlled reference.');
  await writeFile(join(repo, 'change.txt'), 'PR change');
  git('add', '.'); git('commit', '-qm', 'PR');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  await writeFile(join(repo, 'target-only.txt'), 'Target moved after the PR branched.');
  git('add', '.'); git('commit', '-qm', 'Advance target');
  const target = git('rev-parse', 'HEAD');
  return { repo, git, base, head, target };
}

const agent = fileURLToPath(new URL('./agent.mjs', import.meta.url));
const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
// Keep real git checkout/worktree behavior; redirect only the network fetch to the local fixture repository.
async function fakeGit(bin, { logInit = false } = {}) {
  await writeFile(join(bin, 'git'), `#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
${logInit ? "if(args[0]==='init') appendFileSync(process.env.MOCK_RUNS,JSON.stringify({event:'prepare'})+'\\n');\n" : ''}const remote=args.findIndex(arg=>arg==='https://github.com/example/repo.git');
if(remote>=0) args[remote]=process.env.FIXTURE_REPO;
process.exit(spawnSync(process.env.REAL_GIT,args,{stdio:'inherit'}).status??1);
`, { mode: 0o700 });
}
// Runs the watcher as a child process against a mocked GitHub API; the handle can stop and restart it.
function watcher(loader, env) {
  let proc, logs = '';
  return {
    start() {
      proc = spawn(process.execPath, ['--import', loader, agent, 'watch'], { env: { STATUS_CONTEXT: 'review', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout.on('data', p => logs += p); proc.stderr.on('data', p => logs += p);
    },
    async stop(signal = 'SIGTERM') {
      if (!proc) return;
      const closed = new Promise(resolve => proc.once('close', resolve)); proc.kill(signal); await closed; proc = undefined;
    },
    async until(check, describe) {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await check().catch(() => false)) return;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error(`Timed out: ${describe}\n${logs}`);
    },
    logs: () => logs,
  };
}

test('watcher loads the BASE skill, approves pass, and recovers a lost GitHub response across restarts without rerunning Codex', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xarnes-watch-test-'));
  let w;
  try {
    const fixture = await fixtureRepository(dir);
    const bin = join(dir, 'bin'); await mkdir(bin);
    await fakeGit(bin);
    await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,appendFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2); let input=''; for await(const p of process.stdin) input+=p;
assert.ok(args.includes('project_doc_max_bytes=0'));
assert.ok(args.includes('--ignore-user-config') && args.includes('--ignore-rules'));
for(const key of ['GITHUB_TOKEN','GITHUB_TOKEN_FILE','GH_TOKEN']) assert.equal(process.env[key],undefined);
const workspace=JSON.parse(input.match(/Review workspace: ("[^"\\n]+")\./)[1]);
assert.equal(args[args.indexOf('-C')+1],dirname(workspace));
const manifest=JSON.parse(input.match(/skill defined in ("[^"\\n]+")./)[1]);
assert.match(readFileSync(manifest,'utf8'),/Trusted BASE skill/);
assert.equal(readFileSync(join(dirname(manifest),'references/checklist.md'),'utf8'),'Trusted BASE reference.');
assert.equal(execFileSync(process.env.REAL_GIT,['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim(),process.env.FIXTURE_HEAD);
assert.ok(input.includes('BASE (merge base): '+process.env.FIXTURE_BASE));
assert.ok(input.includes('\"verdict\" (\"pass\", \"comment\", or \"block\")') && input.includes('\"body\" (a non-empty string'));
assert.ok(input.includes('without Markdown fences or surrounding text'));
assert.ok(input.includes('Target branch tip: '+process.env.FIXTURE_TARGET));
assert.ok(!input.includes('untrusted-pr-title') && !input.includes('untrusted-pr-description'));
const metadata=JSON.parse(input.match(/PR metadata is in ("[^"\\n]+")./)[1]);
assert.equal(JSON.parse(readFileSync(metadata,'utf8')).title,'untrusted-pr-title');
appendFileSync(process.env.MOCK_RUNS,'run\\n');
writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({verdict:'pass',body:'Review completed.'}));
`, { mode: 0o700 });
    const loader = join(dir, 'mock.mjs');
    await writeFile(loader, `import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
const pr={number:1,draft:false,head:{sha:process.env.FIXTURE_HEAD},base:{ref:'main',sha:process.env.FIXTURE_TARGET},state:'open',merged:false,html_url:'https://github.com/example/repo/pull/1',title:'untrusted-pr-title',body:'untrusted-pr-description'};
const draft={...pr,number:2,draft:true,html_url:'https://github.com/example/repo/pull/2'};
const feature={...pr,number:3,base:{ref:'feature/other',sha:process.env.FIXTURE_TARGET},html_url:'https://github.com/example/repo/pull/3'};
globalThis.fetch=async(url,options={})=>{
 const path=new URL(url).pathname;
 if(path.includes('/commits/') && path.endsWith('/statuses')) return new Response('[]');
 if(path.includes('/statuses/')) return new Response(JSON.stringify({id:99,...JSON.parse(options.body)}));
 appendFileSync(process.env.MOCK_CALLS, JSON.stringify({path,method:options.method??'GET'})+'\\n');
 if(path==='/repos/example/repo/pulls') return new Response(JSON.stringify([pr,draft,feature]));
 if(path==='/repos/example/repo/pulls/1') return new Response(JSON.stringify(pr));
 if(path==='/repos/example/repo/pulls/1/reviews') {
   const reviews=existsSync(process.env.MOCK_REVIEWS)?JSON.parse(readFileSync(process.env.MOCK_REVIEWS,'utf8')):[];
   if(options.method==='POST') {
     const body=JSON.parse(options.body);
     if(body.event!=='APPROVE' || body.commit_id!==pr.head.sha) throw Error('Wrong review action');
     const review={id:123,state:'APPROVED',commit_id:body.commit_id,body:body.body,html_url:pr.html_url+'#pullrequestreview-123'};
     reviews.push(review);writeFileSync(process.env.MOCK_REVIEWS,JSON.stringify(reviews));
     throw Error('Simulated connection loss AFTER GitHub accepted the review');
   }
   return new Response(JSON.stringify(reviews));
 }
 throw Error('Unexpected request');
};`);
    const calls = join(dir, 'calls');
    const runs = join(dir, 'runs-count');
    const statePath = join(dir, 'prs-example--repo.json');
    const entry = async () => JSON.parse(await readFile(statePath, 'utf8')).prs['1'];
    await mkdir(join(dir, 'home')); await writeFile(join(dir, 'home', 'auth.json'), '{}');
    w = watcher(loader, { PATH: `${bin}:${process.env.PATH}`, HOME: dir, CODEX_HOME: join(dir, 'home'), DATA_DIR: dir, SKILL: 'skills/review', GITHUB_REPO: 'example/repo', GITHUB_TOKEN: 'fixture-github', RUN_EXISTING: 'true', MOCK_REVIEWS: join(dir, 'reviews.json'), MOCK_CALLS: calls, MOCK_RUNS: runs, REAL_GIT: realGit, FIXTURE_REPO: fixture.repo, FIXTURE_BASE: fixture.base, FIXTURE_HEAD: fixture.head, FIXTURE_TARGET: fixture.target });
    w.start();
    await w.until(async () => (await entry()).error?.includes('Simulated connection loss'), 'lost response recorded');
    await w.stop();
    const state = await entry();
    assert.equal(state.base, fixture.base);
    assert.equal(state.skill, 'skills/review');
    assert.equal(JSON.parse(await readFile(state.output, 'utf8')).verdict, 'pass');
    assert.ok(state.output.endsWith('.json'));
    assert.equal((await stat(statePath)).mode & 0o077, 0, 'state is private');
    assert.equal((await stat(state.output)).mode & 0o077, 0, 'saved result is private');
    assert.equal(state.status, 'review_pending');
    assert.match(state.marker, /xarnes:/);
    // Simulate the delivery delay elapsing before restarting to reconcile the lost response.
    const delayed = JSON.parse(await readFile(statePath, 'utf8'));
    delayed.prs['1'].retryAt = new Date(0).toISOString();
    await writeFile(statePath, JSON.stringify(delayed));
    w.start();
    await w.until(async () => (await entry()).status === 'succeeded', 'lost response reconciled');
    await w.stop();
    const completed = await entry();
    assert.equal(completed.reviewId, 123);
    assert.equal(completed.verdict, 'pass');
    const after = (await readFile(calls, 'utf8')).length;
    w.start();
    await w.until(async () => (await readFile(calls, 'utf8')).length > after, 'restart scanned again');
    await w.stop();
    assert.equal((await readFile(runs, 'utf8')).trim(), 'run');
    const requests = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests.filter(call => call.method === 'POST').length, 1);
    assert.ok(requests.filter(call => call.method === 'POST').every(call => call.path === '/repos/example/repo/pulls/1/reviews'));
  } finally {
    await w?.stop('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('repository skill selection rejects absolute paths and traversal', () => {
  assert.equal(repositorySkillPath('review'),'skills/review');
  assert.equal(repositorySkillPath('.agents/skills/review'),'.agents/skills/review');
  for (const path of [undefined, '', '../review', 'skills/../review', '/skills/review', 'skills//review', 'skills/./review', 'skills/review/', 'skills/review:HEAD']) {
    assert.throws(()=>repositorySkillPath(path),/Set SKILL/);
  }
});

test('missing skills at BASE fail; trusted symlinked resources are allowed', async () => {
  const dir=await mkdtemp(join(tmpdir(),'xarnes-base-test-'));
  try {
    const fixture=await fixtureRepository(dir);
    await assert.rejects(prepareReview(fixture.repo,join(dir,'missing'),fixture.target,fixture.head,'skills/missing'),/ENOENT/);
    const {symlink}=await import('node:fs/promises');
    await symlink('../SKILL.md',join(fixture.repo,'skills/review/references/link'));
    fixture.git('add','.'); fixture.git('commit','-qm','Symlink fixture');
    const linked=fixture.git('rev-parse','HEAD');
    const prepared = await prepareReview(fixture.repo,join(dir,'linked'),linked,linked,'skills/review');
    assert.equal(prepared.base, linked);
    assert.equal(await readFile(join(dir,'linked','skills/review/references/link'),'utf8'), await readFile(prepared.manifest,'utf8'));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('task skill instructions load the selected directory and reject missing or empty manifests', async () => {
  const { skillInstructions } = await import('./agent.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'xarnes-skills-test-'));
  try {
    await assert.rejects(skillInstructions(dir), /ENOENT/);
    const manifest = join(dir, 'SKILL.md');
    await writeFile(manifest, ' \n');
    await assert.rejects(skillInstructions(dir), /Empty skill/);
    await writeFile(manifest, 'Run the configured task.');
    assert.ok((await skillInstructions(dir)).includes(manifest));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('skills-only CLI task uses a repository-relative skill without a separate mount', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xarnes-skills-cli-'));
  try {
    const skills = join(dir,'work','skills');
    await mkdir(join(skills,'review-pr','references'),{recursive:true});
    await writeFile(join(skills,'review-pr','SKILL.md'),'---\nname: review-pr\ndescription: Review a PR.\n---\nRead references/checklist.md.');
    await writeFile(join(skills,'review-pr','references','checklist.md'),'Check correctness.');
    const fake=join(dir,'codex');
    await writeFile(fake, `#!/usr/bin/env node\nimport {writeFileSync,readFileSync} from 'node:fs';\nconst args=process.argv.slice(2);let input='';for await(const p of process.stdin)input+=p;\nif(!input.includes(process.env.WORKSPACE+'/skills/review-pr/SKILL.md'))process.exit(2);\nconst resource=readFileSync(process.env.WORKSPACE+'/skills/review-pr/references/checklist.md','utf8');\nwriteFileSync(args[args.indexOf('-o')+1],resource);\n`,{mode:0o700});
    await mkdir(join(dir,'auth')); await writeFile(join(dir,'auth','auth.json'),'{}');
    const env = { PATH: process.env.PATH, HOME: dir, DATA_DIR: dir, CODEX_HOME: join(dir, 'auth'), WORKSPACE: join(dir, 'work'), CODEX_BIN: fake };
    const run = extra => spawnSync(process.execPath, [fileURLToPath(new URL('./agent.mjs', import.meta.url)), 'task'], { encoding: 'utf8', env: { ...env, ...extra } });
    for (const config of [{ SKILL: 'skills/review-pr' }, { SKILL: 'review-pr', SKILLS_DIR: skills }]) {
      const result = run(config);
      assert.equal(result.status, 0, result.stderr);
    }
    const missing = run({});
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Set SKILL/, 'a single available skill must not be selected implicitly');
    const { readdir }=await import('node:fs/promises');
    const files=await readdir(join(dir,'runs'));
    assert.equal(await readFile(join(dir,'runs',files[0]),'utf8'),'Check correctness.');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('watcher processes every PR sequentially through review delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xarnes-sequential-test-'));
  let w;
  try {
    const fixture = await fixtureRepository(dir);
    const bin = join(dir, 'bin'); await mkdir(bin);
    // Record preparation, execution, and posting to prove entire PR runs never overlap.
    await fakeGit(bin, { logInit: true });
    await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
import {writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2); let input=''; for await(const p of process.stdin) input+=p;
const number=input.match(/PR number: (\\d+)/)[1];
appendFileSync(process.env.MOCK_RUNS,JSON.stringify({number,event:'start',at:Date.now()})+'\\n');
await new Promise(r=>setTimeout(r,200));
appendFileSync(process.env.MOCK_RUNS,JSON.stringify({number,event:'end',at:Date.now()})+'\\n');
writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({verdict:'pass',body:'Review of PR '+number}));
`, { mode: 0o700 });
    const loader = join(dir, 'mock.mjs');
    await writeFile(loader, `import {appendFileSync} from 'node:fs';
const make=number=>({number,draft:false,head:{sha:process.env.FIXTURE_HEAD},base:{ref:'dev',sha:process.env.FIXTURE_TARGET},state:'open',merged:false,html_url:'https://github.com/example/repo/pull/'+number,title:'t',body:''});
const prs=[make(1),make(2),make(3)];
globalThis.fetch=async(url,options={})=>{
 const path=new URL(url).pathname;
 if(path.includes('/commits/') && path.endsWith('/statuses')) return new Response('[]');
 if(path.includes('/statuses/')) return new Response(JSON.stringify({id:99,...JSON.parse(options.body)})); const method=options.method??'GET';
 appendFileSync(process.env.MOCK_CALLS, JSON.stringify({path,method})+'\\n');
 if(path==='/repos/example/repo/pulls') return new Response(JSON.stringify(prs));
 const one=path.match(/^\\/repos\\/example\\/repo\\/pulls\\/(\\d+)(\\/reviews)?$/);
 if(one && !one[2]) return new Response(JSON.stringify(prs[Number(one[1])-1]));
 if(one && method==='GET') return new Response('[]');
 if(one && method==='POST') { appendFileSync(process.env.MOCK_RUNS,JSON.stringify({number:one[1],event:'posted'})+'\\n'); const body=JSON.parse(options.body); return new Response(JSON.stringify({id:Number(one[1]),state:'APPROVED',commit_id:body.commit_id,html_url:'u'})); }
 throw Error('Unexpected request '+path);
};`);
    const calls = join(dir, 'calls'), runs = join(dir, 'runs-log');
    const runEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, CODEX_HOME: join(dir, 'home'), DATA_DIR: dir, SKILL: 'skills/review', GITHUB_REPO: 'example/repo', GITHUB_TOKEN: 'fixture-github', TARGET_BRANCHES: 'dev', RUN_EXISTING: 'true', POLL_SECONDS: '15', MOCK_CALLS: calls, MOCK_RUNS: runs, REAL_GIT: realGit, FIXTURE_REPO: fixture.repo, FIXTURE_HEAD: fixture.head, FIXTURE_TARGET: fixture.target };
    await mkdir(runEnv.CODEX_HOME); await writeFile(join(runEnv.CODEX_HOME, 'auth.json'), '{}');
    const statePath = join(dir, 'prs-example--repo.json');
    w = watcher(loader, runEnv);
    w.start();
    // All three PRs eventually run, each after the previous review has been delivered.
    await w.until(async () => { const prs = JSON.parse(await readFile(statePath, 'utf8')).prs; return [1, 2, 3].every(n => prs[n]?.status === 'succeeded'); }, 'all PRs delivered');
    await w.stop();
    const events = (await readFile(runs, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.filter(e => e.event === 'start').map(e => e.number), ['1', '2', '3']);
    assert.deepEqual(events.map(e => e.event), ['prepare', 'start', 'end', 'posted', 'prepare', 'start', 'end', 'posted', 'prepare', 'start', 'end', 'posted']);
    assert.match(w.logs(), /one PR at a time/);
    assert.match(w.logs(), /\[#1\]|\[#2\]/);
    const requests = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const scheduling = requests.filter(call => call.path === '/repos/example/repo/pulls' || call.method === 'POST');
    assert.deepEqual(scheduling.slice(0, 6).map(call => call.method), ['GET', 'POST', 'GET', 'POST', 'GET', 'POST'], 'fetch fresh PRs between deliveries');
    const posts = requests.filter(call => call.method === 'POST').map(call => call.path);
    assert.deepEqual(posts.sort(), ['/repos/example/repo/pulls/1/reviews', '/repos/example/repo/pulls/2/reviews', '/repos/example/repo/pulls/3/reviews']);
    const state = JSON.parse(await readFile(statePath, 'utf8')).prs;
    assert.deepEqual([1, 2, 3].map(n => state[n].reviewId), [1, 2, 3]);
  } finally {
    await w?.stop('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('closed and stale saved results become pending again once the PR is observed at the same revision', () => {
  const state = { initialized: true, prs: { 1: { sha: 'a', baseRef: 'dev', status: 'closed', output: 'o', marker: 'm' }, 2: { sha: 'b', baseRef: 'dev', status: 'stale', output: 'o', marker: 'm' }, 3: { sha: 'c', baseRef: 'dev', status: 'stale' } } };
  const prs = [pr(1, 'a'), pr(2, 'b'), { number: 3, head: { sha: 'c' }, base: { ref: 'dev' } }];
  assert.deepEqual(pendingPRs(prs, state, { updates: false }).map(p => p.number), [1, 2, 3]);
});

test('pruning preserves completed review identity and pending results while removing obsolete closed-PR records', async () => {
  const { pruneState } = await import('./agent.mjs');
  const state = { prs: {
    1: { sha: 'a', status: 'succeeded' }, 2: { sha: 'b', status: 'succeeded' }, 3: { sha: 'c', status: 'review_pending' },
    4: { sha: 'd', status: 'closed', output: 'o', marker: 'm' }, 5: { sha: 'e', status: 'failed', attempts: 3 }, 6: { sha: 'f', status: 'running' }, 7: { sha: 'g', status: 'baseline' },
    8: { sha: 'h', status: 'closed' }, 9: { sha: 'i', status: 'stale' },
  }, statuses: {
    '1:a': { number: 1, delivered: true }, '2:b': { number: 2, delivered: true }, '2:old': { number: 2, delivered: true },
    '5:e': { number: 5, delivered: false }, '6:f': { number: 6, delivered: true }, '7:g': { number: 7, delivered: true },
  } };
  pruneState(state, new Map([[1, {}]]), new Map([[6, Promise.resolve()]]));
  assert.deepEqual(Object.keys(state.prs), ['1', '2', '3', '4', '6']);
  assert.deepEqual(Object.keys(state.statuses), ['1:a', '5:e', '6:f']);
});

test('a reopened PR receives its saved review without running Codex again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xarnes-reopen-test-'));
  let w;
  try {
    const bin = join(dir, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'codex'), '#!/bin/sh\necho "codex must not run" >&2; exit 7\n', { mode: 0o700 });
    const sha = 'a'.repeat(40), marker = '<!-- xarnes:11111111-2222-3333-4444-555555555555 -->';
    await mkdir(join(dir, 'runs'));
    const output = join(dir, 'runs', 'saved.json');
    await writeFile(output, JSON.stringify({ verdict: 'block', body: 'Unsafe change.' }));
    const statePath = join(dir, 'prs-example--repo.json');
    await writeFile(statePath, JSON.stringify({ initialized: true, prs: { 7: { sha, baseRef: 'main', base: sha, skill: 'skills/review', status: 'closed', attempts: 1, verdict: 'block', output, marker } }, statuses: {}, queue: [] }));
    const loader = join(dir, 'mock.mjs');
    await writeFile(loader, `import {appendFileSync} from 'node:fs';
const pr={number:7,draft:false,head:{sha:'${sha}'},base:{ref:'main',sha:'${sha}'},state:'open',merged:false,html_url:'u',title:'t',body:''};
globalThis.fetch=async(url,options={})=>{
 const path=new URL(url).pathname, method=options.method??'GET';
 appendFileSync(process.env.MOCK_CALLS, JSON.stringify({path,method})+'\\n');
 if(path.includes('/commits/')) return new Response('[]');
 if(path.includes('/statuses/')) return new Response(JSON.stringify({id:1,...JSON.parse(options.body)}));
 if(path==='/repos/example/repo/pulls') return new Response(JSON.stringify([pr]));
 if(path==='/repos/example/repo/pulls/7') return new Response(JSON.stringify(pr));
 if(path==='/repos/example/repo/pulls/7/reviews' && method==='GET') return new Response('[]');
 if(path==='/repos/example/repo/pulls/7/reviews') { const body=JSON.parse(options.body); if(body.event!=='REQUEST_CHANGES') throw Error('wrong event'); return new Response(JSON.stringify({id:70,state:'CHANGES_REQUESTED',commit_id:body.commit_id,html_url:'r'})); }
 throw Error('Unexpected request '+path);
};`);
    const calls = join(dir, 'calls');
    await mkdir(join(dir, 'home')); await writeFile(join(dir, 'home', 'auth.json'), '{}');
    w = watcher(loader, { PATH: `${bin}:${process.env.PATH}`, HOME: dir, CODEX_HOME: join(dir, 'home'), DATA_DIR: dir, SKILL: 'skills/review', GITHUB_REPO: 'example/repo', GITHUB_TOKEN: 'fixture-github', MOCK_CALLS: calls });
    w.start();
    await w.until(async () => JSON.parse(await readFile(statePath, 'utf8')).prs[7]?.status === 'succeeded', 'saved review delivered');
    await w.stop();
    const entry = JSON.parse(await readFile(statePath, 'utf8')).prs[7];
    assert.equal(entry.reviewId, 70); assert.equal(entry.verdict, 'block');
    assert.ok(!w.logs().includes('codex must not run'), w.logs());
    assert.match(w.logs(), /eligible again/);
    const posts = (await readFile(calls, 'utf8')).trim().split('\n').map(l => JSON.parse(l)).filter(c => c.method === 'POST' && c.path.endsWith('/reviews'));
    assert.equal(posts.length, 1);
  } finally {
    await w?.stop('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('MAX_CONCURRENCY runs reviews in parallel, each in its own Codex home, and never two for one PR', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xarnes-concurrent-test-'));
  let w;
  try {
    const fixture = await fixtureRepository(dir);
    const bin = join(dir, 'bin'); await mkdir(bin);
    await fakeGit(bin);
    await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
import {writeFileSync,appendFileSync} from 'node:fs';
if(process.argv[2]==='login'){writeFileSync(process.env.CODEX_HOME+'/auth.json','{}');process.exit(0);}
const args=process.argv.slice(2); let input=''; for await(const p of process.stdin) input+=p;
const number=input.match(/PR number: (\\d+)/)[1];
appendFileSync(process.env.MOCK_RUNS,JSON.stringify({number,event:'start',at:Date.now(),home:process.env.CODEX_HOME})+'\\n');
await new Promise(r=>setTimeout(r,600));
appendFileSync(process.env.MOCK_RUNS,JSON.stringify({number,event:'end',at:Date.now()})+'\\n');
writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({verdict:'pass',body:'Review of PR '+number}));
`, { mode: 0o700 });
    const loader = join(dir, 'mock.mjs');
    await writeFile(loader, `const make=number=>({number,draft:false,head:{sha:process.env.FIXTURE_HEAD},base:{ref:'dev',sha:process.env.FIXTURE_TARGET},state:'open',merged:false,html_url:'u',title:'t',body:''});
const prs=[make(1),make(2),make(3)];
globalThis.fetch=async(url,options={})=>{
 const path=new URL(url).pathname, method=options.method??'GET';
 if(path.includes('/commits/')) return new Response('[]');
 if(path.includes('/statuses/')) return new Response(JSON.stringify({id:99,...JSON.parse(options.body)}));
 if(path==='/repos/example/repo/pulls') return new Response(JSON.stringify(prs));
 const one=path.match(/^\\/repos\\/example\\/repo\\/pulls\\/(\\d+)(\\/reviews)?$/);
 if(one && !one[2]) return new Response(JSON.stringify(prs[Number(one[1])-1]));
 if(one && method==='GET') return new Response('[]');
 if(one) { const body=JSON.parse(options.body); return new Response(JSON.stringify({id:Number(one[1]),state:'APPROVED',commit_id:body.commit_id,html_url:'u'})); }
 throw Error('Unexpected request '+path);
};`);
    const runs = join(dir, 'runs-log'), home = join(dir, 'codex');
    // Slot 1 reuses its saved sign-in; slot 2 signs in before reviews start.
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, CODEX_HOME: home, DATA_DIR: dir, SKILL: 'skills/review', GITHUB_REPO: 'example/repo', GITHUB_TOKEN: 'fixture-github', TARGET_BRANCHES: 'dev', RUN_EXISTING: 'true', MAX_CONCURRENCY: '2', MOCK_RUNS: runs, REAL_GIT: realGit, FIXTURE_REPO: fixture.repo, FIXTURE_HEAD: fixture.head, FIXTURE_TARGET: fixture.target };
    await mkdir(home); await writeFile(join(home, 'auth.json'), '{}');
    const statePath = join(dir, 'prs-example--repo.json');
    w = watcher(loader, env);
    w.start();
    await w.until(async () => { const prs = JSON.parse(await readFile(statePath, 'utf8')).prs; return [1, 2, 3].every(n => prs[n]?.status === 'succeeded'); }, 'all PRs delivered');
    await w.stop();
    assert.match(w.logs(), /up to 2 PRs at a time/);
    assert.match(w.logs(), /slot 2 of 2 needs a ChatGPT sign-in/, 'the unsigned slot is signed in from the logs before watching');
    assert.doesNotMatch(w.logs(), /slot 1 of 2 needs/);
    const events = (await readFile(runs, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const starts = events.filter(e => e.event === 'start'), ends = events.filter(e => e.event === 'end');
    assert.equal(starts.length, 3);
    assert.ok(starts[1].at < ends[0].at, 'second review must start while the first is running');
    assert.ok(starts[2].at >= Math.min(ends[0].at, ends[1].at), 'third review must wait for a free slot');
    assert.deepEqual(new Set(starts.slice(0, 2).map(e => e.home)), new Set([home, `${home}-2`]));
    assert.equal(new Set(starts.map(e => e.number)).size, 3);
  } finally {
    await w?.stop('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('ENGINE=claude reviews through claude -p with the isolation flags, one shared config dir, and pauses on a usage limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'standalone-claude-test-'));
  let w;
  try {
    const fixture = await fixtureRepository(dir);
    const bin = join(dir, 'bin'); await mkdir(bin);
    await fakeGit(bin);
    // Fake `claude`: checks the flags the runner relies on, then answers on stdout as JSON like the real CLI.
    await writeFile(join(bin, 'claude'), `#!/usr/bin/env node
import {appendFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const args=process.argv.slice(2); let input=''; for await(const p of process.stdin) input+=p;
const need=['-p','--output-format','json','--permission-mode','bypassPermissions','--setting-sources','user','--add-dir'];
const missing=need.filter(f=>!args.includes(f)); if(missing.length){console.error('missing flags '+missing); process.exit(9);}
const added=args[args.indexOf('--add-dir')+1];
if(resolve(added)===process.cwd()){console.error('must start outside the checkout'); process.exit(9);}
if(process.env.GITHUB_TOKEN||process.env.GH_TOKEN){console.error('token leaked into the engine'); process.exit(9);}
if(!process.env.CLAUDE_CONFIG_DIR){console.error('no CLAUDE_CONFIG_DIR'); process.exit(9);}
const number=input.match(/PR number: (\\d+)/)[1];
appendFileSync(process.env.MOCK_RUNS,JSON.stringify({number,home:process.env.CLAUDE_CONFIG_DIR,model:args[args.indexOf('--model')+1]})+'\\n');
if(existsSync(process.env.DATA_DIR+'/limit')){
  console.log(JSON.stringify({type:'result',is_error:true,api_error_status:429,result:'You have reached your weekly usage limit. Your limit will reset at 10:00 PM.'}));
  process.exit(1);
}
console.log(JSON.stringify({type:'result',is_error:false,num_turns:3,total_cost_usd:0.42,result:JSON.stringify({verdict:'pass',body:'Reviewed by fake claude for PR '+number})}));
`, { mode: 0o700 });
    const loader = join(dir, 'mock.mjs');
    await writeFile(loader, `const make=number=>({number,draft:false,head:{sha:process.env.FIXTURE_HEAD},base:{ref:'main',sha:process.env.FIXTURE_TARGET},state:'open',merged:false,html_url:'u',title:'t',body:''});
const prs=[make(1),make(2)];
globalThis.fetch=async(url,options={})=>{
 const path=new URL(url).pathname, method=options.method??'GET';
 if(path.includes('/commits/')) return new Response('[]');
 if(path.includes('/statuses/')) return new Response(JSON.stringify({id:99,...JSON.parse(options.body)}));
 if(path==='/repos/example/repo/pulls') return new Response(JSON.stringify(prs));
 const one=path.match(/^\\/repos\\/example\\/repo\\/pulls\\/(\\d+)(\\/reviews)?$/);
 if(one && !one[2]) return new Response(JSON.stringify(prs[Number(one[1])-1]));
 if(one && method==='GET') return new Response('[]');
 if(one) { const body=JSON.parse(options.body); return new Response(JSON.stringify({id:Number(one[1]),state:'APPROVED',commit_id:body.commit_id,html_url:'u'})); }
 throw Error('Unexpected request '+path);
};`);
    const runs = join(dir, 'runs-log'), home = join(dir, 'claude-home');
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ENGINE: 'claude', CLAUDE_CONFIG_DIR: home, MODEL: 'claude-opus-5-5', DATA_DIR: dir, SKILL: 'skills/review', GITHUB_REPO: 'example/repo', GITHUB_TOKEN: 'fixture-github', STATUS_CONTEXT: 'review', RUN_EXISTING: 'true', MAX_CONCURRENCY: '2', MOCK_RUNS: runs, REAL_GIT: realGit, FIXTURE_REPO: fixture.repo, FIXTURE_HEAD: fixture.head, FIXTURE_TARGET: fixture.target };
    // Without a token or saved credential the watcher refuses to start and says what to set.
    const refused = spawnSync(process.execPath, ['--import', loader, agent, 'watch'], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /CLAUDE_CODE_OAUTH_TOKEN/);
    const statePath = join(dir, 'prs-example--repo.json');
    w = watcher(loader, { ...env, CLAUDE_CODE_OAUTH_TOKEN: 'fixture-claude' });
    w.start();
    await w.until(async () => { const prs = JSON.parse(await readFile(statePath, 'utf8')).prs; return [1, 2].every(n => prs[n]?.status === 'succeeded'); }, 'both PRs reviewed by the claude engine');
    await w.stop();
    const events = (await readFile(runs, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(e => e.number).sort(), ['1', '2']);
    assert.deepEqual(new Set(events.map(e => e.home)), new Set([home]), 'every slot shares the one Claude config dir');
    assert.ok(events.every(e => e.model === 'claude-opus-5-5'));
    assert.doesNotMatch(w.logs(), /needs an? \w+ sign-in/, 'a token means no sign-in step');
    assert.match(w.logs(), /up to 2 PRs at a time/);
    // A usage-limit reply is a pause, not a failed attempt.
    await writeFile(join(dir, 'limit'), 'yes');
    const state = JSON.parse(await readFile(statePath, 'utf8')); delete state.prs[1]; await writeFile(statePath, JSON.stringify(state));
    w.start();
    await w.until(async () => JSON.parse(await readFile(statePath, 'utf8')).prs[1]?.status === 'limited', 'limit recorded');
    await w.stop();
    const limited = JSON.parse(await readFile(statePath, 'utf8')).prs[1];
    assert.equal(limited.attempts, 0);
    assert.match(limited.error, /weekly usage limit/);
    assert.match(w.logs(), /reviews paused until/);
  } finally {
    await w?.stop('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReview, publishReview, reviewSubmission, pendingPRs } from './agent.mjs';

const sha = 'a'.repeat(40);
const targets = new Set(['main', 'dev']);
const marker = '<!-- standalone-agent:00000000-0000-4000-8000-000000000001 -->';
const report = verdict => ({
  verdict,
  reasons: verdict === 'pass' ? [] : ['Authorization needs attention.'],
  briefing: { summary: 'The PR changes authorization.', decisions: ['The endpoint uses a different scope.'] },
  findings: verdict === 'pass' ? [] : [{ severity: verdict === 'block' ? 'high' : 'low', confidence: 'high', title: 'Authorization changed', path: 'api.cs', symbol: 'MapRoute', side: 'head', quote: 'AllowAnonymous()', evidence: 'An anonymous caller can reach MapRoute.', fix: 'Require the existing scope.' }],
  coverage: { invariants: [{ id: 'AUTH-1', status: verdict === 'pass' ? 'held' : verdict === 'block' ? 'violated' : 'unresolved', note: 'Checked `read|write` scopes.\nCaller must satisfy <scope>.' }], scan: [], not_reviewed: [] },
});
const stateFor = event => ({ APPROVE: 'APPROVED', COMMENT: 'COMMENTED', REQUEST_CHANGES: 'CHANGES_REQUESTED' })[event];
async function savedResult(verdict, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-review-result-'));
  try {
    const output = join(dir, 'result.md');
    await writeFile(output, JSON.stringify(report(verdict)));
    await fn({ sha, baseRef: 'dev', marker, output });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

for (const [verdict, event] of [['pass', 'APPROVE'], ['comment', 'COMMENT'], ['block', 'REQUEST_CHANGES']]) {
  test(`${verdict} submits ${event} on the reviewed commit with the report`, async () => {
    await savedResult(verdict, async entry => {
      const calls = [];
      const request = async (path, options) => {
        calls.push({ path, options });
        if (path.includes('/reviews?')) return [];
        if (!options) return { state: 'open', merged: false, head: { sha }, base: { ref: 'dev' } };
        const body = JSON.parse(options.body);
        assert.equal(options.method, 'POST');
        assert.equal(path, '/repos/example/repo/pulls/42/reviews');
        assert.equal(body.event, event);
        assert.equal(body.commit_id, sha);
        assert.ok(body.body.endsWith(marker));
        assert.doesNotMatch(body.body, /The PR changes authorization|The endpoint uses a different scope|### Decisions/);
        const label = { pass: '✅ PASS', comment: '💬 COMMENT', block: '⛔ BLOCKED' }[verdict];
        assert.ok(body.body.startsWith(`## ${label} · Review`));
        const status = { pass: '✅ Held', comment: '❓ Unresolved', block: '❌ Violated' }[verdict];
        assert.ok(body.body.includes(`| AUTH-1 | ${status} | Checked \`read\\|write\` scopes.<br>Caller must satisfy &lt;scope&gt;. |`));
        assert.doesNotMatch(body.body, /### Coverage|"invariants"|"not_reviewed"/);
        if (verdict !== 'pass') {
          assert.match(body.body, /AllowAnonymous\(\)/);
          assert.match(body.body, /Require the existing scope/);
        }
        return { id: 17, state: stateFor(event), commit_id: sha, html_url: 'https://github.com/example/repo/pull/42#pullrequestreview-17' };
      };
      const outcome = await publishReview(request, 'example/repo', 42, entry, targets);
      assert.equal(outcome.status, 'succeeded');
      assert.equal(outcome.verdict, verdict);
      assert.equal(outcome.reviewId, 17);
      assert.equal(calls.length, 3);
      assert.equal(calls[1].path, '/repos/example/repo/pulls/42');
    });
  });
}

test('findings retain every severity, location, impact, fix, and code quote in the compact layout', () => {
  const result = report('block');
  const quote = '```markdown\n</details>\n<script>example</script>\n```';
  result.findings = ['critical', 'high', 'medium', 'low'].map(severity => ({
    ...result.findings[0], severity, path: 'api/<route>`handler.cs', symbol: 'Handle<T>', quote,
  }));
  result.reasons = ['First reason.\nSupporting detail.', 'Second reason.'];
  const original = JSON.stringify(result);
  const { body } = reviewSubmission(result, sha, marker);
  for (const label of ['🚨 CRITICAL', '🔴 HIGH', '🟠 MEDIUM', '🟡 LOW']) assert.ok(body.includes(`#### ${label}`));
  assert.match(body, /### Findings \(4\)/);
  assert.match(body, /<code>api\/&lt;route&gt;`handler.cs<\/code>/);
  assert.match(body, /<code>Handle&lt;T&gt;<\/code>/);
  assert.match(body, /\*\*Confidence:\*\* high/);
  assert.match(body, /\*\*Impact\*\*\n\nAn anonymous caller/);
  assert.match(body, /\*\*Suggested fix\*\*\n\nRequire the existing scope/);
  assert.ok(body.includes(`\`\`\`\`text\n${quote}\n\`\`\`\``), 'embedded fences and HTML remain literal code');
  assert.match(body, /<summary>Review rationale<\/summary>\n\n- First reason\.\n  Supporting detail\.\n- Second reason\./);
  assert.ok(body.endsWith(marker), 'publication marker remains intact');
  assert.equal(JSON.stringify(result), original, 'presentation must not rewrite the saved result');
});

test('a verdict explained only by reasons keeps its rationale visible', () => {
  const result = report('block');
  result.findings = [];
  result.coverage.invariants = [];
  const { body, event } = reviewSubmission(parseReview(JSON.stringify(result)), sha, marker);
  assert.equal(event, 'REQUEST_CHANGES');
  assert.match(body, /❓ No invariant checks were reported/);
  assert.match(body, /### Review rationale\n\n- Authorization needs attention/);
  assert.doesNotMatch(body, /<details>|### Findings/);
});

test('invalid, unknown, incomplete, and contradictory results never approve', () => {
  const invalid = ['pass', '{"verdict":"pass"}', 'null', '[]', 'text\n' + JSON.stringify(report('pass'))];
  for (const verdict of ['needs_human', 'approve', 'PASS', 'toString', ['pass'], null]) invalid.push(JSON.stringify({ ...report('pass'), verdict }));
  invalid.push(JSON.stringify({ ...report('block'), verdict: 'pass' }));
  for (const coverage of [undefined, {}, { invariants: [{ id: 'RULE-1', status: 'unresolved', note: 'Missing evidence' }], scan: [], not_reviewed: [] }, { invariants: [], scan: [{ check: 'hidden', at: 'api.cs', resolution: 'failed' }], not_reviewed: [] }]) {
    invalid.push(JSON.stringify({ ...report('pass'), coverage }));
  }
  for (const source of invalid) assert.throws(() => parseReview(source));
  assert.equal(parseReview('```json\n' + JSON.stringify(report('comment')) + '\n```').verdict, 'comment');
});

test('invalid saved output fails before any GitHub request', async () => {
  await savedResult('pass', async entry => {
    await writeFile(entry.output, '{"verdict":"pass"}');
    let calls = 0;
    await assert.rejects(publishReview(async () => { calls++; }, 'example/repo', 42, entry, targets), /Incomplete/);
    assert.equal(calls, 0);
  });
});

for (const [name, latest, expected] of [
  ['new head', { state: 'open', head: { sha: 'b'.repeat(40) } }, 'stale'],
  ['closed PR', { state: 'closed', head: { sha } }, 'closed'],
  ['merged PR', { state: 'closed', merged: true, head: { sha } }, 'closed'],
]) {
  test(`${name} prevents review submission`, async () => {
    await savedResult('pass', async entry => {
      const outcome = await publishReview(async (path, options) => {
        assert.equal(options, undefined);
        return path.includes('/reviews?') ? [] : latest;
      }, 'example/repo', 42, entry, targets);
      assert.equal(outcome.status, expected);
    });
  });
}

test('reconciliation paginates reviews and does not repeat a submitted or dismissed review', async () => {
  for (const state of ['APPROVED', 'DISMISSED']) {
    await savedResult('pass', async entry => {
      let calls = 0;
      const outcome = await publishReview(async (path, options) => {
        calls++;
        assert.equal(options, undefined);
        if (path.endsWith('page=1')) return Array.from({ length: 100 }, (_, id) => ({ id, body: 'Unrelated review', commit_id: sha, state: 'COMMENTED' }));
        assert.ok(path.endsWith('page=2'));
        return [{ id: 999, commit_id: sha, body: 'Review\n\n' + marker, state }];
      }, 'example/repo', 42, entry, targets);
      assert.equal(outcome.reviewId, 999);
      assert.equal(calls, 2);
    });
  }
});

test('a marker on another revision does not suppress the current review', async () => {
  await savedResult('comment', async entry => {
    let posts = 0;
    await publishReview(async (path, options) => {
      if (path.includes('/reviews?')) return [{ id: 1, body: marker, commit_id: 'b'.repeat(40), state: 'COMMENTED' }];
      if (!options) return { state: 'open', head: { sha }, base: { ref: 'dev' } };
      posts++;
      return { id: 2, state: 'COMMENTED', commit_id: sha };
    }, 'example/repo', 42, entry, targets);
    assert.equal(posts, 1);
  });
});

test('unconfirmed review responses remain errors for later reconciliation', async () => {
  await savedResult('block', async entry => {
    await assert.rejects(publishReview(async (path, options) => {
      if (path.includes('/reviews?')) return [];
      if (!options) return { state: 'open', head: { sha }, base: { ref: 'dev' } };
      return { id: 3, state: 'PENDING', commit_id: sha };
    }, 'example/repo', 42, entry, targets), /did not confirm/);
  });
});

test('oversized reviews fail without dropping findings', () => {
  const result = report('block');
  result.findings[0].evidence = '証'.repeat(30000);
  assert.throws(() => reviewSubmission(result, sha, marker), /publishing limit/);
});

test('pending review delivery retries even with updates disabled, while a new head starts new work', () => {
  const state = { initialized: true, prs: { 1: { sha, baseRef: 'dev', status: 'review_pending' } } };
  const same = { number: 1, head: { sha }, base: { ref: 'dev' } };
  const newer = { ...same, head: { sha: 'b'.repeat(40) } };
  assert.deepEqual(pendingPRs([same], state, { updates: false }), [same]);
  assert.deepEqual(pendingPRs([newer], state), [newer]);
  assert.deepEqual(pendingPRs([newer], state, { updates: false }), []);
});

test('a PR becoming a draft or leaving target branches defers delivery until eligible again', async () => {
  for (const latest of [
    { state: 'open', draft: true, head: { sha }, base: { ref: 'dev' } },
    { state: 'open', draft: false, head: { sha }, base: { ref: 'feature' } },
  ]) {
    await savedResult('pass', async entry => {
      const outcome = await publishReview(async (path, options) => {
        assert.equal(options, undefined);
        return path.includes('/reviews?') ? [] : latest;
      }, 'example/repo', 42, entry, targets);
      assert.equal(outcome.status, 'review_pending');
    });
  }
});

test('retargeting requires a fresh review even without a new head commit', async () => {
  await savedResult('pass', async entry => {
    const outcome = await publishReview(async (path, options) => {
      assert.equal(options, undefined);
      return path.includes('/reviews?') ? [] : { state: 'open', head: { sha }, base: { ref: 'main' } };
    }, 'example/repo', 42, entry, targets);
    assert.equal(outcome.status, 'stale');
    const state = { initialized: true, prs: { 42: { ...entry, status: 'succeeded' } } };
    const changed = { number: 42, head: { sha }, base: { ref: 'main' } };
    assert.deepEqual(pendingPRs([changed], state, { updates: false }), [changed]);
  });
});

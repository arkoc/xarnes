import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReview, publishReview, reviewSubmission, pendingPRs } from './agent.mjs';

const sha = 'a'.repeat(40);
const targets = new Set(['main', 'dev']);
const marker = '<!-- xarnes:00000000-0000-4000-8000-000000000001 -->';
const report = verdict => ({ verdict, body: `Skill-written ${verdict} review.\n\n**Evidence:** See \`api.cs\`.` });
const stateFor = event => ({ APPROVE: 'APPROVED', COMMENT: 'COMMENTED', REQUEST_CHANGES: 'CHANGES_REQUESTED' })[event];
async function savedResult(verdict, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-review-result-'));
  try {
    const output = join(dir, 'result.json');
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
        assert.equal(body.body, report(verdict).body + '\n\n' + marker);
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

test('the skill owns Markdown formatting and whitespace; only the hidden delivery marker is appended', () => {
  const result = {
    verdict: 'block',
    body: '  ## Custom review\r\n\r\n| Check | Result |\r\n| --- | --- |\r\n| Scope | ⛔ |\r\n\r\n<details><summary>Evidence</summary>\r\n\r\n```js\r\na < b && c > d\r\n```\r\n</details>  \n',
  };
  const original = JSON.stringify(result);
  assert.deepEqual(parseReview(original), result);
  const submission = reviewSubmission(result, sha, marker);
  assert.deepEqual(submission, { event: 'REQUEST_CHANGES', commit_id: sha, body: result.body + '\n\n' + marker });
  assert.equal(JSON.stringify(result), original, 'the saved result is not rewritten');
});

test('only verdict and body are required; additional report fields do not affect delivery', () => {
  for (const verdict of ['pass', 'comment', 'block']) {
    const result = report(verdict);
    assert.deepEqual(parseReview(JSON.stringify(result)), result);
    const extra = { ...result, metadata: { checkedFiles: ['api.cs'] } };
    assert.deepEqual(parseReview(JSON.stringify(extra)), result);
  }
});

test('invalid JSON, unknown verdicts, and missing or blank bodies never publish', () => {
  const invalid = ['pass', '{"verdict":"pass"}', 'null', '[]', 'text\n' + JSON.stringify(report('pass')),
    '```json\n' + JSON.stringify(report('comment')) + '\n```'];
  for (const verdict of ['needs_human', 'approve', 'PASS', 'toString', '__proto__', ['pass'], null, undefined]) invalid.push(JSON.stringify({ ...report('pass'), verdict }));
  for (const body of [undefined, null, '', ' \t\r\n ', 12, [], {}]) invalid.push(JSON.stringify({ verdict: 'pass', body }));
  for (const source of invalid) assert.throws(() => parseReview(source));
  assert.deepEqual(parseReview(' \n' + JSON.stringify(report('comment')) + '\n'), report('comment'));
});

test('review bodies redact only the configured GitHub token', () => {
  const previous = process.env.GITHUB_TOKEN;
  try {
    process.env.GITHUB_TOKEN = 'configured-test-token';
    const example = 'ghp_' + 'x'.repeat(36);
    const result = { verdict: 'comment', body: `Credential: configured-test-token; example: ${example}` };
    assert.equal(reviewSubmission(result, sha, marker).body, `Credential: [redacted]; example: ${example}\n\n${marker}`);
    delete process.env.GITHUB_TOKEN;
    assert.equal(reviewSubmission(result, sha, marker).body, `${result.body}\n\n${marker}`);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
});

test('invalid saved output fails before any GitHub request', async () => {
  await savedResult('pass', async entry => {
    await writeFile(entry.output, '{"verdict":"pass"}');
    let calls = 0;
    await assert.rejects(publishReview(async () => { calls++; }, 'example/repo', 42, entry, targets), /body must be a non-empty string/);
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

test('the publishing limit includes the marker and counts UTF-8 bytes without truncating the body', () => {
  const suffix = '\n\n' + marker;
  const result = { verdict: 'block', body: 'x'.repeat(60000 - Buffer.byteLength(suffix)) };
  assert.equal(Buffer.byteLength(reviewSubmission(result, sha, marker).body), 60000);
  result.body += 'x';
  assert.throws(() => reviewSubmission(result, sha, marker), /publishing limit/);
  result.body = '証'.repeat(30000);
  assert.throws(() => reviewSubmission(result, sha, marker), /publishing limit/);
  assert.equal(result.body.length, 30000);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { commitStatus, publishStatus } from './agent.mjs';

const sha = 'a'.repeat(40);
test('commit status exposes progress, non-blocking comments, failures, and cancellation', () => {
  for (const [entry, expected] of [
    [{ status: 'queued' }, 'pending'],
    [{ status: 'running', attempts: 1 }, 'pending'],
    [{ status: 'review_pending' }, 'pending'],
    [{ status: 'failed', attempts: 1 }, 'pending'],
    [{ status: 'failed', attempts: 3 }, 'error'],
    [{ status: 'succeeded', verdict: 'pass' }, 'success'],
    [{ status: 'succeeded', verdict: 'comment' }, 'success'],
    [{ status: 'succeeded', verdict: 'block' }, 'failure'],
    [{ status: 'stale' }, 'error'],
    [{ status: 'closed' }, 'error'],
  ]) {
    const result = commitStatus('example/repo', 1, entry, 3, 'review');
    assert.equal(result.state, expected);
    if (expected === 'pending') assert.match(result.description, { queued: /^Queued for review$/, running: /running \(attempt 1\/3\)/, review_pending: /finished; posting/, failed: /retry scheduled/ }[entry.status]);
    assert.ok(result.description.length <= 140);
    assert.equal(result.target_url, 'https://github.com/example/repo/pull/1');
  }
  assert.equal(commitStatus('example/repo', 1, { status: 'baseline' }, 3, 'review'), null);
  const entry = { status: 'succeeded', verdict: 'pass', reviewUrl: 'https://github.com/example/repo/pull/1#pullrequestreview-1' };
  assert.equal(commitStatus('example/repo', 1, entry, 3, 'review').target_url, entry.reviewUrl);
  assert.notEqual(commitStatus('example/repo', 1, entry, 3, 'review').context, commitStatus('example/repo', 2, entry, 3, 'review').context, 'PRs sharing a SHA must not overwrite each other');
  assert.equal(commitStatus('example/repo', 7, entry, 3, 'review').context, 'review/pr-7');
  assert.equal(commitStatus('example/repo', 7, entry, 3, 'team/security-review').context, 'team/security-review/pr-7');
});

test('status reconciles a lost response, follows pagination, and only trusts the newest matching context', async () => {
  const payload = commitStatus('example/repo', 1, { status: 'succeeded', verdict: 'pass' }, 3, 'review');
  let stored = [], posts = 0;
  const request = async (path, options) => {
    if (options?.method === 'POST') {
      assert.equal(path, `/repos/example/repo/statuses/${sha}`);
      posts++;
      stored.unshift({ id: posts, ...JSON.parse(options.body) });
      if (posts === 1) throw new Error('Response lost after acceptance');
      return stored[0];
    }
    assert.ok(path.includes(`/commits/${sha}/statuses?`));
    if (path.endsWith('page=1')) return Array.from({ length: 100 }, () => ({ context: 'another/check' }));
    return stored;
  };
  await assert.rejects(publishStatus(request, 'example/repo', sha, payload), /Response lost/);
  await publishStatus(request, 'example/repo', sha, payload);
  assert.equal(posts, 1);
  stored.unshift({ id: 999, ...payload, state: 'pending' });
  await publishStatus(request, 'example/repo', sha, payload);
  assert.equal(posts, 2, 'an older matching status must not hide a newer different status');
});

test('unconfirmed status submission remains retryable', async () => {
  const payload = commitStatus('example/repo', 1, { status: 'queued' }, 3, 'review');
  await assert.rejects(publishStatus(async (_path, options) => options ? { id: 1, state: 'success' } : [], 'example/repo', sha, payload), /did not confirm/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { eventFromEnvironment, runAutoqueue } from '../templates/autoqueue/run.mjs';

const WORKFLOW = fileURLToPath(new URL('../templates/autoqueue.yml', import.meta.url));
const roster = { schema: 1, catalogCommit: 'a'.repeat(40), owner: 'simpsonm09-org', fullRepos: ['fixture'] };
const env = {
  AUTOQUEUE_PR_NUMBER: '17', AUTOQUEUE_BASE_OWNER: 'simpsonm09-org', AUTOQUEUE_BASE_NAME: 'fixture',
  AUTOQUEUE_BASE_REPO_ID: '123', AUTOQUEUE_STATE: 'open', AUTOQUEUE_DRAFT: 'false', AUTOQUEUE_MERGED: 'false',
  AUTOQUEUE_BASE_REF: 'main', AUTOQUEUE_HEAD_SHA: 'b'.repeat(40), AUTOQUEUE_HEAD_REPO_ID: '123',
  AUTOQUEUE_AUTHOR_LOGIN: 'simpsonm09', AUTOQUEUE_AUTHOR_TYPE: 'User', AUTOQUEUE_MERGEABLE: 'MERGEABLE',
  AUTOQUEUE_MERGE_COMMIT_ALLOWED: 'true', AUTOQUEUE_MODE: 'enable',
};
const pr = (changes = {}) => ({
  id: 'PR_17', number: 17, state: 'OPEN', isDraft: false, merged: false, mergeable: 'MERGEABLE',
  baseRefName: 'main', headRefOid: 'b'.repeat(40), baseRepository: { databaseId: 123 }, headRepository: { databaseId: 123 },
  author: { login: 'simpsonm09', __typename: 'User' }, autoMergeRequest: null, ...changes,
});
const repository = (pullRequest, mergeCommitAllowed = true) => ({ mergeCommitAllowed, pullRequest });
const graphQLRepository = (pullRequest, mergeCommitAllowed = true) => repository(pullRequest, mergeCommitAllowed);
const captureOutput = async (fn) => {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try { return { value: await fn(), lines }; } finally { console.log = original; }
};

test('revalidates changed metadata before any write', async () => {
  for (const change of [
    { headRefOid: 'c'.repeat(40) },
    { baseRepository: { databaseId: 456 } },
    { headRepository: { databaseId: 456 } },
    { author: { login: 'other', __typename: 'User' } },
    { isDraft: true },
    { state: 'CLOSED' },
  ]) {
    let writes = 0;
    const transport = async () => repository(pr(change));
    const { value } = await captureOutput(() => runAutoqueue({ env, roster, transport: async (request) => {
      if (request.operation === 'enable') writes += 1;
      return transport(request);
    } }));
    assert.equal(value.reason, 'head-changed');
    assert.equal(writes, 0);
  }
  let writes = 0;
  const { value } = await captureOutput(() => runAutoqueue({ env, roster, transport: async ({ operation }) => {
    if (operation === 'enable') writes += 1;
    return repository(pr(), false);
  } }));
  assert.equal(value.reason, 'head-changed');
  assert.equal(writes, 0);
});

test('already queued is idempotent and performs no enable write', async () => {
  let writes = 0;
  const { value } = await captureOutput(() => runAutoqueue({ env, roster, transport: async ({ operation }) => {
    if (operation === 'enable') writes += 1;
    return repository(pr({ autoMergeRequest: { enabledAt: '2026-10-24T12:00:00Z' } }));
  } }));
  assert.equal(value.outcome, 'already-queued');
  assert.equal(writes, 0);
});

test('permission denial is a no-op and never retries through another credential', async () => {
  let writes = 0;
  const { value } = await captureOutput(() => runAutoqueue({ env, roster, transport: async ({ operation }) => {
    if (operation === 'enable') { writes += 1; throw Object.assign(new Error('denied'), { isPermissionDenied: true, graphQLErrorType: 'FORBIDDEN' }); }
    return repository(pr());
  } }));
  assert.equal(value.outcome, 'permission-denied');
  assert.equal(writes, 1);
});

test('classifies post-read outcomes without trusting mutation response or error text', async () => {
  const queued = async (merged, request) => {
    let reads = 0;
    const { value } = await captureOutput(() => runAutoqueue({ env, roster, transport: async ({ operation }) => {
      if (operation === 'enable') return { ignored: true };
      reads += 1;
      return repository(pr(reads === 1 ? {} : { merged, autoMergeRequest: request }));
    } }));
    return value;
  };
  assert.equal((await queued(false, { enabledAt: 'now' })).outcome, 'queued');
  assert.equal((await queued(true, null)).outcome, 'merged-on-enable');

  let reads = 0;
  const errored = await captureOutput(() => runAutoqueue({ env, roster, transport: async ({ operation }) => {
    if (operation === 'enable') throw new Error('mutation failed');
    reads += 1;
    return repository(pr(reads > 1 ? { autoMergeRequest: { enabledAt: 'now' } } : {}));
  } }));
  assert.equal(errored.value.outcome, 'already-queued');

  reads = 0;
  const failed = await captureOutput(() => runAutoqueue({ env, roster, transport: async ({ operation }) => {
    if (operation === 'enable') throw Object.assign(new Error('private detail'), { code: '1' });
    reads += 1;
    return repository(pr());
  } }));
  assert.equal(failed.value.outcome, 'enable-failed');
  assert.equal(failed.value.exitCode, 1);
  assert.equal(failed.lines.join(' ').includes('private detail'), false);
});

test('uses webhook-rendered mergeable values as a conservative pre-filter', () => {
  const from = (mergeable) => eventFromEnvironment({ ...env, AUTOQUEUE_MERGEABLE: mergeable });
  assert.equal(from('true').mergeable, 'MERGEABLE');
  assert.equal(from('false').mergeable, 'CONFLICTING');
  assert.equal(from('').mergeable, null);
});

test('owner, fork, and Dependabot fixture flows use the GraphQL PR ID, head, and MERGE method', async () => {
  const scenarios = [
    { env: { ...env, AUTOQUEUE_MERGEABLE: 'true' }, changes: {} },
    { env: { ...env, AUTOQUEUE_MERGEABLE: 'true', AUTOQUEUE_HEAD_REPO_ID: '456' }, changes: { headRepository: { databaseId: 456 } } },
    {
      env: { ...env, AUTOQUEUE_MERGEABLE: 'true', AUTOQUEUE_AUTHOR_LOGIN: 'dependabot[bot]', AUTOQUEUE_AUTHOR_TYPE: 'Bot' },
      changes: { author: { login: 'dependabot[bot]', __typename: 'Bot' } },
    },
  ];
  for (const { env: scenarioEnv, changes } of scenarios) {
    const requests = [];
    let reads = 0;
    const { value } = await captureOutput(() => runAutoqueue({ env: scenarioEnv, roster, transport: async (request) => {
      requests.push(request);
      if (request.operation === 'enable') {
        assert.deepEqual(request.variables, {
          pullRequestId: 'PR_17',
          expectedHeadOid: 'b'.repeat(40),
          mergeMethod: 'MERGE',
        });
        assert.match(request.query, /mergeMethod:\s*\$mergeMethod/);
        assert.match(request.query, /\$mergeMethod:\s*PullRequestMergeMethod!/);
        return {};
      }
      reads += 1;
      return graphQLRepository(pr({ ...changes, ...(reads > 1 ? { autoMergeRequest: { enabledAt: 'now' } } : {}) }));
    } }));
    assert.equal(value.outcome, 'queued');
    assert.equal(requests.filter(({ operation }) => operation === 'enable').length, 1);
    assert.equal(reads, 2);
  }
});

test('rejects null and non-string GraphQL pull request IDs before any write', async () => {
  for (const id of [null, undefined, 17, '']) {
    let writes = 0;
    const { value } = await captureOutput(() => runAutoqueue({ env, roster, transport: async ({ operation }) => {
      if (operation === 'enable') writes += 1;
      return repository(pr({ id }));
    } }));
    assert.equal(value.outcome, 'read-failed');
    assert.equal(writes, 0);
  }
});

test('conflicting and unrecognized webhook mergeability never reaches the transport', async () => {
  for (const [mergeable, reason] of [['false', 'not-mergeable'], ['UNRECOGNIZED', 'mergeability-unknown']]) {
    let calls = 0;
    const { value } = await captureOutput(() => runAutoqueue({ env: { ...env, AUTOQUEUE_MERGEABLE: mergeable }, roster, transport: async () => {
      calls += 1;
      return graphQLRepository(pr());
    } }));
    assert.equal(value.reason, reason);
    assert.equal(calls, 0);
  }
});

test('pending webhook mergeability defers only to an authoritative fresh decision', async () => {
  const pendingEnvs = ['', 'UNKNOWN'].map((mergeable) => ({ ...env, AUTOQUEUE_MERGEABLE: mergeable }));
  let calls = [];
  for (const pendingEnv of pendingEnvs) {
    calls = [];
    const success = await captureOutput(() => runAutoqueue({ env: pendingEnv, roster, transport: async ({ operation, variables }) => {
      calls.push({ operation, variables });
      if (operation === 'enable') return {};
      const reads = calls.filter(({ operation: kind }) => kind === 'read').length;
      return repository(pr(reads === 2 ? { autoMergeRequest: { enabledAt: 'now' } } : {}));
    } }));
    assert.equal(success.value.outcome, 'queued');
    assert.deepEqual(calls.filter(({ operation }) => operation === 'enable').map(({ variables }) => variables.pullRequestId), ['PR_17']);
  }
  const pendingEnv = pendingEnvs[0];

  for (const mergeable of ['UNKNOWN', 'CONFLICTING']) {
    calls = [];
    const result = await captureOutput(() => runAutoqueue({ env: pendingEnv, roster, transport: async ({ operation }) => {
      calls.push(operation);
      return repository(pr({ mergeable }));
    } }));
    assert.equal(result.value.reason, mergeable === 'CONFLICTING' ? 'not-mergeable' : 'mergeability-pending');
    assert.deepEqual(calls, ['read']);
  }

  calls = [];
  const stale = await captureOutput(() => runAutoqueue({ env: pendingEnv, roster, transport: async ({ operation }) => {
    calls.push(operation);
    return repository(pr({ headRefOid: 'c'.repeat(40) }));
  } }));
  assert.equal(stale.value.reason, 'head-changed');
  assert.deepEqual(calls, ['read']);

  calls = [];
  const observed = await captureOutput(() => runAutoqueue({ env: { ...pendingEnv, AUTOQUEUE_MODE: 'observe' }, roster, transport: async ({ operation }) => {
    calls.push(operation);
    return repository(pr());
  } }));
  assert.equal(observed.value.outcome, 'observed');
  assert.deepEqual(calls, ['read']);

  for (const [scenarioEnv, scenarioRoster] of [
    [{ ...pendingEnv, AUTOQUEUE_AUTHOR_LOGIN: 'external' }, roster],
    [pendingEnv, { ...roster, fullRepos: [] }],
  ]) {
    calls = [];
    const denied = await captureOutput(() => runAutoqueue({ env: scenarioEnv, roster: scenarioRoster, transport: async ({ operation }) => {
      calls.push(operation);
      return repository(pr());
    } }));
    assert.equal(calls.length, 0);
    assert.ok(['author-not-eligible', 'repository-not-full'].includes(denied.value.reason));
  }
});

test('defaults to observe mode and fails closed when a roster cannot be supplied', async () => {
  let writes = 0;
  const { value } = await captureOutput(() => runAutoqueue({ env: { ...env, AUTOQUEUE_MODE: 'observe' }, roster, transport: async ({ operation }) => {
    if (operation === 'enable') writes += 1;
    return repository(pr());
  } }));
  assert.equal(value.outcome, 'observed');
  assert.equal(writes, 0);
  const missing = await captureOutput(() => runAutoqueue({ env: { ...env, AUTOQUEUE_MODE: 'enable' }, transport: async () => { throw new Error('must not call transport'); } }));
  assert.equal(missing.value.reason, 'roster-invalid');
});

test('read failures are no-ops and never enable auto-merge', async () => {
  let calls = 0;
  const { value } = await captureOutput(() => runAutoqueue({ env, roster, transport: async () => {
    calls += 1;
    throw Object.assign(new Error('network unavailable'), { code: '1' });
  } }));
  assert.equal(value.outcome, 'read-failed');
  assert.equal(calls, 1);
});

test('post-read failure reports enable failure without leaking transport details', async () => {
  let reads = 0;
  const { value, lines } = await captureOutput(() => runAutoqueue({ env, roster, transport: async ({ operation }) => {
    if (operation === 'enable') return {};
    reads += 1;
    if (reads === 1) return repository(pr());
    throw Object.assign(new Error('private transport detail'), { code: '1' });
  } }));
  assert.equal(value.outcome, 'enable-failed');
  assert.equal(value.exitCode, 1);
  assert.equal(lines.join(' ').includes('private transport detail'), false);
});

test('workflow is an inactive trusted-base metadata-only template', async () => {
  const source = await readFile(WORKFLOW, 'utf8');
  assert.match(source, /pull_request_target:/);
  assert.match(source, /types: \[opened, reopened, synchronize, ready_for_review, edited\]/);
  assert.doesNotMatch(source, /^\s*pull_request:/m);
  assert.match(source, /^permissions: \{\}$/m);
  assert.match(source, /pull-requests: write/);
  assert.doesNotMatch(source, /contents: write/);
  assert.match(source, /actions\/checkout@[0-9a-f]{40}/);
  assert.equal((source.match(/uses: actions\/checkout@/g) ?? []).length, 1);
  assert.match(source, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(source, /persist-credentials: false/);
  assert.doesNotMatch(source, /head\/sha|refs\/pull|merge_ref|gh pr merge|--admin|secrets\./i);
  assert.match(source, /AUTOQUEUE_MODE: \$\{\{ vars\.AUTOQUEUE_ENABLED == 'true' && vars\.AUTOQUEUE_PREREQUISITES_VERIFIED == 'true'/);
  const runBlocks = source.split(/^\s*run:/m).slice(1);
  assert.ok(runBlocks.every((block) => !block.slice(0, block.indexOf('\n')).includes('${{ github.event')));
});

test('template runtime and roster paths line up with the workflow invocation', async () => {
  const source = await readFile(WORKFLOW, 'utf8');
  const adapter = await readFile(new URL('../templates/autoqueue/run.mjs', import.meta.url), 'utf8');
  const helper = await readFile(new URL('../templates/autoqueue/decide.mjs', import.meta.url), 'utf8');
  assert.match(source, /run: node templates\/autoqueue\/run\.mjs/);
  assert.match(adapter, /from '\.\/decide\.mjs'/);
  assert.match(adapter, /new URL\('\.\/full-roster\.json', import\.meta\.url\)/);
  assert.match(helper, /export function validateRoster/);
});

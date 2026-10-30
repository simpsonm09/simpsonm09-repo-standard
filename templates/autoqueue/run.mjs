import { execFile as nodeExecFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { decide } from './decide.mjs';

const execFile = promisify(nodeExecFile);
const ELIGIBLE_AUTHORS = [
  { login: 'simpsonm09', typename: 'User' },
  { login: 'dependabot[bot]', typename: 'Bot' },
];
const POLICY = { eligibleAuthors: ELIGIBLE_AUTHORS, allowedBaseRef: 'main', allowedMergeMethods: ['MERGE'] };

const READ_QUERY = `query AutoqueuePullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed
    pullRequest(number: $number) {
      id number state isDraft merged mergeable baseRefName headRefOid
      baseRepository { databaseId }
      headRepository { databaseId }
      author { login __typename }
      autoMergeRequest { enabledAt }
    }
  }
}`;
const ENABLE_MUTATION = `mutation EnableAutoqueue($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $mergeMethod: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: {
    pullRequestId: $pullRequestId,
    expectedHeadOid: $expectedHeadOid,
    mergeMethod: $mergeMethod
  }) { pullRequest { id headRefOid autoMergeRequest { enabledAt } merged } }
}`;

export async function runAutoqueue({ env = process.env, transport = createGitHubTransport(), roster: providedRoster } = {}) {
  const event = eventFromEnvironment(env);
  const identity = { number: event.number, baseRepoId: event.baseRepoId, headSha: event.headSha };
  const roster = await loadRoster(providedRoster);
  if (!roster) return report(identity, 'no-op', 'roster-invalid');
  const initial = decide({ roster, event, policy: POLICY });
  if (!initial.eligible && initial.reason !== 'mergeability-pending') return report(identity, 'no-op', initial.reason);

  const current = await readCurrentPullRequest(transport, event, identity);
  if (current.result) return current.result;
  const { fresh, pullRequestId } = current;
  const freshDecision = decide({ roster, event: fresh, policy: POLICY });
  if (!freshDecision.eligible) return report(identity, 'no-op', freshDecision.reason);
  if (env.AUTOQUEUE_MODE !== 'enable') return report(identity, 'observed', 'writes-disabled');
  return enableAndClassify({ transport, event, identity, fresh, pullRequestId });
}

async function loadRoster(providedRoster) {
  if (providedRoster) return providedRoster;
  try {
    return JSON.parse(await readFile(new URL('./full-roster.json', import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}

async function readCurrentPullRequest(transport, event, identity) {
  let current;
  try {
    current = await transport({ operation: 'read', query: READ_QUERY, variables: queryVariables(event) });
  } catch (error) {
    return { result: report(identity, error.isPermissionDenied ? 'permission-denied' : 'read-failed', safeErrorType(error)) };
  }
  const pullRequestId = current?.pullRequest?.id;
  if (typeof pullRequestId !== 'string' || pullRequestId.length === 0) return { result: report(identity, 'read-failed', 'pr-id-missing') };
  const fresh = fromApi(current, event);
  if (!fresh) return { result: report(identity, 'read-failed', 'pr-metadata-missing') };
  if (!sameEvaluatedPr(event, fresh)) return { result: report(identity, 'no-op', 'head-changed') };
  if (fresh.merged || fresh.state !== 'OPEN') return { result: report(identity, 'no-op', 'pr-not-open') };
  if (fresh.autoMergeRequest && fresh.headSha === event.headSha) return { result: report(identity, 'already-queued', 'auto-merge-request-present') };
  return { fresh, pullRequestId };
}

async function enableAndClassify({ transport, event, identity, fresh, pullRequestId }) {
  let enableError;
  try {
    await transport({
      operation: 'enable',
      query: ENABLE_MUTATION,
      variables: { pullRequestId, expectedHeadOid: fresh.headSha, mergeMethod: 'MERGE' },
    });
  } catch (error) {
    enableError = error;
  }

  let after;
  try {
    after = await transport({ operation: 'read', query: READ_QUERY, variables: queryVariables(event) });
  } catch (error) {
    return report(identity, 'enable-failed', safeErrorType(enableError ?? error));
  }
  const post = fromApi(after, event);
  if (!post) return report(identity, 'enable-failed', 'post-read-metadata-missing');
  if (post.merged) return report(identity, 'merged-on-enable', 'github-merged-during-enable');
  if (sameEvaluatedPr(fresh, post) && post.autoMergeRequest) {
    return report(identity, enableError ? 'already-queued' : 'queued', enableError ? 'request-present-after-enable-error' : 'request-present');
  }
  if (enableError?.isPermissionDenied) return report(identity, 'permission-denied', safeErrorType(enableError));
  return report(identity, 'enable-failed', safeErrorType(enableError));
}

export function eventFromEnvironment(env) {
  const number = positiveInteger(env.AUTOQUEUE_PR_NUMBER);
  const baseRepoId = positiveInteger(env.AUTOQUEUE_BASE_REPO_ID);
  const headRepoId = env.AUTOQUEUE_HEAD_REPO_ID === '' || env.AUTOQUEUE_HEAD_REPO_ID === 'null'
    ? null
    : positiveInteger(env.AUTOQUEUE_HEAD_REPO_ID);
  const mergeMethodsConfigured = env.AUTOQUEUE_MERGE_COMMIT_ALLOWED === 'true' ? ['MERGE'] : [];
  return {
    repository: { owner: env.AUTOQUEUE_BASE_OWNER, name: env.AUTOQUEUE_BASE_NAME, databaseId: baseRepoId },
    number,
    state: env.AUTOQUEUE_STATE?.toUpperCase(),
    draft: parseBoolean(env.AUTOQUEUE_DRAFT),
    merged: parseBoolean(env.AUTOQUEUE_MERGED),
    baseRef: env.AUTOQUEUE_BASE_REF,
    baseRepoId,
    headSha: env.AUTOQUEUE_HEAD_SHA,
    headRepoId,
    author: { login: env.AUTOQUEUE_AUTHOR_LOGIN, typename: env.AUTOQUEUE_AUTHOR_TYPE },
    mergeable: normalizeMergeable(env.AUTOQUEUE_MERGEABLE),
    mergeMethodsConfigured,
  };
}

export function createGitHubTransport() {
  return async ({ operation, query, variables }) => {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [name, value] of Object.entries(variables)) args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`);
    let stdout;
    try {
      ({ stdout } = await execFile('gh', args, { env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN }, windowsHide: true, maxBuffer: 1024 * 1024 }));
    } catch (error) {
      const payload = parseJson(error.stdout);
      throw transportError(payload, error.code);
    }
    const payload = parseJson(stdout);
    if (!payload) throw transportError(null, 'invalid-json');
    if (payload.errors?.length) throw transportError(payload, 'graphql-error');
    if (operation === 'read') return payload.data?.repository;
    return payload.data?.enablePullRequestAutoMerge;
  };
}

function fromApi(repository, fallback) {
  const pr = repository?.pullRequest;
  if (!pr) return null;
  return {
    repository: fallback.repository,
    number: pr.number,
    state: pr.state,
    draft: pr.isDraft,
    merged: pr.merged,
    baseRef: pr.baseRefName,
    baseRepoId: pr.baseRepository?.databaseId,
    headSha: pr.headRefOid,
    headRepoId: pr.headRepository?.databaseId ?? null,
    author: { login: pr.author?.login, typename: pr.author?.__typename },
    mergeable: normalizeMergeable(pr.mergeable),
    mergeMethodsConfigured: repository.mergeCommitAllowed === true ? ['MERGE'] : [],
    autoMergeRequest: pr.autoMergeRequest,
  };
}

function sameEvaluatedPr(event, fresh) {
  return String(event.number) === String(fresh.number)
    && sameId(event.baseRepoId, fresh.baseRepoId)
    && event.baseRef === fresh.baseRef
    && event.headSha === fresh.headSha
    && sameOptionalId(event.headRepoId, fresh.headRepoId)
    && event.state === fresh.state
    && event.draft === fresh.draft
    && event.author?.login === fresh.author?.login
    && event.author?.typename === fresh.author?.typename
    && JSON.stringify(event.mergeMethodsConfigured) === JSON.stringify(fresh.mergeMethodsConfigured);
}

function queryVariables(event) {
  if (!event.number || !event.repository?.owner || !event.repository?.name) throw new Error('invalid repository or PR number');
  return { owner: event.repository.owner, name: event.repository.name, number: event.number };
}

function report(identity, outcome, reason) {
  const result = { ...identity, outcome, reason };
  console.log(JSON.stringify(result));
  return { ...result, exitCode: outcome === 'enable-failed' ? 1 : 0 };
}

function transportError(payload, code) {
  const graphQLErrorType = payload?.errors?.[0]?.type;
  const error = new Error('GitHub GraphQL request failed');
  error.graphQLErrorType = typeof graphQLErrorType === 'string' ? graphQLErrorType : undefined;
  error.isPermissionDenied = graphQLErrorType === 'FORBIDDEN' || graphQLErrorType === 'INSUFFICIENT_SCOPES';
  error.code = typeof code === 'string' ? code : undefined;
  return error;
}

function safeErrorType(error) {
  return error?.graphQLErrorType ?? error?.code ?? 'unknown';
}

function parseJson(value) {
  if (typeof value !== 'string' || value === '') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function parseBoolean(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function positiveInteger(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function normalizeMergeable(value) {
  if (value === true || value === 'true') return 'MERGEABLE';
  if (value === false || value === 'false') return 'CONFLICTING';
  if (value === 'MERGEABLE' || value === 'CONFLICTING' || value === 'UNKNOWN' || value === 'DIRTY') return value;
  return value === null || value === undefined || value === '' ? null : 'UNRECOGNIZED';
}

function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

function sameOptionalId(left, right) {
  return (left === null || left === undefined) && (right === null || right === undefined) || sameId(left, right);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAutoqueue().then(({ exitCode }) => { process.exitCode = exitCode; }).catch(() => {
    console.log(JSON.stringify({ outcome: 'no-op', reason: 'adapter-failed' }));
  });
}

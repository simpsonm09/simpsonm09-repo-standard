const OWNER = 'simpsonm09-org';
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export function validateRoster(roster) {
  if (roster?.schema !== 1 || roster.owner !== OWNER || !/^[0-9a-f]{40}$/i.test(roster.catalogCommit) || !Array.isArray(roster.fullRepos)) return false;
  const names = new Set();
  for (const name of roster.fullRepos) {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name) || name === '.' || name === '..' || names.has(name)) return false;
    names.add(name);
  }
  if (roster.ignoredNames !== undefined) {
    if (!Array.isArray(roster.ignoredNames) || roster.ignoredNames.some((name) => typeof name !== 'string' || !NAME_PATTERN.test(name))) return false;
    if (roster.ignoredNames.some((name) => names.has(name))) return false;
  }
  return true;
}

export function decide({ roster, event, policy }) {
  if (!validateRoster(roster)) return denied('roster-invalid');
  if (!event || !policy) return denied('event-invalid');
  const repositoryReason = repositoryFailure(roster, event, policy);
  if (repositoryReason) return denied(repositoryReason);
  const pullRequestReason = pullRequestFailure(event, policy);
  if (pullRequestReason) return denied(pullRequestReason);
  return {
    eligible: true,
    reason: 'eligible',
    queueIdentity: { baseRepoId: String(event.baseRepoId), number: event.number, headSha: event.headSha },
  };
}

function repositoryFailure(roster, event, policy) {
  if (event.repository?.owner !== OWNER || !roster.fullRepos.includes(event.repository?.name)) return 'repository-not-full';
  if (event.baseRef !== policy.allowedBaseRef) return 'base-ref-not-allowed';
  if (!sameId(event.baseRepoId, event.repository?.databaseId)) return 'base-repository-mismatch';
  return null;
}

function pullRequestFailure(event, policy) {
  if (event.state !== 'OPEN' || event.merged === true) return 'pr-not-open';
  if (event.draft !== false) return 'draft';
  if (typeof event.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(event.headSha)) return 'head-sha-missing';
  const author = policy.eligibleAuthors?.find(({ login, typename }) => login === event.author?.login && typename === event.author?.typename);
  if (!author) return 'author-not-eligible';
  if (!Array.isArray(event.mergeMethodsConfigured) || !event.mergeMethodsConfigured.includes('MERGE') || !policy.allowedMergeMethods?.includes('MERGE')) {
    return 'merge-method-not-allowed';
  }
  if (event.mergeable === 'CONFLICTING' || event.mergeable === 'DIRTY') return 'not-mergeable';
  if (event.mergeable === 'UNKNOWN' || event.mergeable === null) return 'mergeability-pending';
  if (event.mergeable !== 'MERGEABLE') return 'mergeability-unknown';
  return null;
}

function denied(reason) {
  return { eligible: false, reason, queueIdentity: null };
}

function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

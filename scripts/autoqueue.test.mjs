import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, validateRoster } from '../templates/autoqueue/decide.mjs';

const roster = { schema: 1, catalogCommit: 'a'.repeat(40), owner: 'simpsonm09-org', fullRepos: ['simpsonm09-fixture-go'] };
const policy = {
  eligibleAuthors: [
    { login: 'simpsonm09', typename: 'User' },
    { login: 'dependabot[bot]', typename: 'Bot' },
  ],
  allowedBaseRef: 'main',
  allowedMergeMethods: ['MERGE'],
};
const event = {
  repository: { owner: 'simpsonm09-org', name: 'simpsonm09-fixture-go', databaseId: 123 },
  number: 17,
  state: 'OPEN',
  draft: false,
  merged: false,
  baseRef: 'main',
  baseRepoId: 123,
  headSha: 'b'.repeat(40),
  headRepoId: 123,
  author: { login: 'simpsonm09', typename: 'User' },
  mergeable: 'MERGEABLE',
  mergeMethodsConfigured: ['MERGE'],
};
const decideEvent = (changes = {}, selectedRoster = roster) => decide({ roster: selectedRoster, event: { ...event, ...changes }, policy });

test('allows owner and Dependabot PRs for a FULL repository', () => {
  assert.equal(decideEvent().eligible, true);
  assert.equal(decideEvent({ author: { login: 'dependabot[bot]', typename: 'Bot' } }).eligible, true);
  assert.deepEqual(decideEvent().queueIdentity, { baseRepoId: '123', number: 17, headSha: 'b'.repeat(40) });
});

test('fails closed for absent, non-owned, or malformed roster identities', () => {
  assert.equal(decideEvent({}, { ...roster, fullRepos: [] }).reason, 'repository-not-full');
  assert.equal(decideEvent({ repository: { ...event.repository, owner: 'example' } }).reason, 'repository-not-full');
  assert.equal(decideEvent({ repository: { ...event.repository, name: 'simpsonm09' } }).reason, 'repository-not-full');
  for (const bad of [null, {}, { ...roster, schema: 2 }, { ...roster, catalogCommit: 'bad' }, { ...roster, owner: 'elsewhere' }, { ...roster, fullRepos: ['bad/name'] }, { ...roster, fullRepos: ['duplicate', 'duplicate'] }, { ...roster, ignoredNames: ['simpsonm09-fixture-go'] }]) {
    assert.equal(validateRoster(bad), false);
    assert.equal(decideEvent({}, bad).reason, 'roster-invalid');
  }
});

test('requires the exact base identity and main branch', () => {
  assert.equal(decideEvent({ baseRepoId: 999 }).reason, 'base-repository-mismatch');
  assert.equal(decideEvent({ baseRef: 'release' }).reason, 'base-ref-not-allowed');
});

test('denies non-open, merged, draft, and missing-head PRs', () => {
  assert.equal(decideEvent({ state: 'CLOSED' }).reason, 'pr-not-open');
  assert.equal(decideEvent({ merged: true }).reason, 'pr-not-open');
  assert.equal(decideEvent({ draft: true }).reason, 'draft');
  assert.equal(decideEvent({ headSha: '' }).reason, 'head-sha-missing');
});

test('requires trusted login and GraphQL actor type, including for fork heads', () => {
  assert.equal(decideEvent({ author: { login: 'external-user', typename: 'User' } }).reason, 'author-not-eligible');
  assert.equal(decideEvent({ author: { login: 'simpsonm09', typename: 'Bot' } }).reason, 'author-not-eligible');
  assert.equal(decideEvent({ headRepoId: 456 }).eligible, true);
  assert.equal(decideEvent({ headRepoId: 456, author: { login: 'external-user', typename: 'User' } }).eligible, false);
});

test('requires MERGE and treats mergeability conservatively', () => {
  assert.equal(decideEvent({ mergeMethodsConfigured: ['SQUASH'] }).reason, 'merge-method-not-allowed');
  assert.equal(decideEvent({ mergeable: 'CONFLICTING' }).reason, 'not-mergeable');
  assert.equal(decideEvent({ mergeable: 'DIRTY' }).reason, 'not-mergeable');
  assert.equal(decideEvent({ mergeable: 'UNKNOWN' }).reason, 'mergeability-pending');
  assert.equal(decideEvent({ mergeable: 'UNRECOGNIZED' }).reason, 'mergeability-unknown');
});

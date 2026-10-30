#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXIT } from './lib/exit.mjs';
import { isMain } from './lib/proc.mjs';
import { BASE_CONTEXTS, COVERAGE_CONTEXT, kindOf } from './lib/required.mjs';
import { CAPABILITIES, CAPABILITIES_BY_KIND, classify, decideTarget, resolveDestination } from './agent-access.mjs';
import { buildPayload } from './ruleset-payload.mjs';
import { approvalCountFor, expectedApprovalBypass } from './lib/ruleset-policy.mjs';

const contract = JSON.parse(readFileSync(new URL('../contracts/agent-app-behavior.v1.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../agent-app.manifest.json', import.meta.url), 'utf8'));
const fixtureDir = new URL('./fixtures/agent-access/', import.meta.url);
const readFixture = (name) => JSON.parse(readFileSync(new URL(name, fixtureDir), 'utf8'));
const roster = readFixture('repos.json');
const ownedForks = readFixture('owned-forks.json');
const ownedRepositories = readFixture('owned-repositories.json');
const ignore = { ignore: [{ name: 'fixture-ignored', reason: 'synthetic contract test', agentAccessIgnore: ['acme/fixture-ignored'] }] };

function permissionIsInManifest(permission) {
  const [name, access] = permission.split(':');
  const requested = manifest.default_permissions[name];
  return access === 'read' ? requested === 'read' || requested === 'write' : requested === access;
}

function permissionExampleStatus(example) {
  const permissionSets = example.permissionSetsAnyOf ?? [example.permissionsAllOf];
  if (permissionSets.some((permissions) => typeof permissions === 'string')) return 'not-inferable-from-classifier';
  return permissionSets.some((permissions) => permissions.every(permissionIsInManifest))
    ? 'present-in-manifest'
    : 'absent-from-manifest';
}

function testContract() {
  assert.equal(typeof classify, 'function');
  assert.equal(typeof resolveDestination, 'function');
  assert.equal(typeof decideTarget, 'function');
  assert.equal(contract.authority.classifier.split('(')[0], classify.name);
  assert.equal(contract.authority.destination.split('(')[0], resolveDestination.name);
  assert.equal(contract.authority.target.split('(')[0], decideTarget.name);

  assert.equal(contract.contractVersion, 1);
  assert.equal(contract.portabilityBoundary.includes('not a generic external API'), true);
  assert.deepEqual(contract.levels.propose.capabilities, CAPABILITIES.propose);
  assert.deepEqual(contract.levels.merge.capabilities, CAPABILITIES.merge);
  assert.deepEqual(contract.levels.full.capabilities, CAPABILITIES.full);
  assert.deepEqual(contract.appPermissionCeiling.requested, manifest.default_permissions);
  assert.deepEqual(contract.appPermissionCeiling.notRequested.filter((name) => manifest.default_permissions[name] === undefined), [
    'administration', 'issues', 'actions', 'secrets',
  ]);
  assert.equal(contract.appPermissionCeiling.installationGrantStatus.includes('Not verified'), true);
  for (const example of contract.appPermissionCeiling.operationPermissionExamples.examples) {
    assert.equal(example.manifestStatus, permissionExampleStatus(example), `${example.operation} manifest permission status`);
  }
  const release = contract.appPermissionCeiling.operationPermissionExamples.examples.find(({ operation }) => operation === 'createRelease');
  assert.deepEqual(release.permissionSetsAnyOf, [['contents:write'], ['contents:write', 'workflows:write']]);
  assert.equal(release.permissionSetsAnyOf.some((permissions) => permissions.every(permissionIsInManifest)), true);
  assert.equal(contract.appPermissionCeiling.operationPermissionExamples.examples
    .find(({ operation }) => operation === 'unmodeledRESTWrite').manifestStatus, 'not-inferable-from-classifier');

  const commandCapabilities = [
    ['gh pr create', 'openPr'],
    ['gh pr merge 1', 'mergePr'],
    ['gh workflow run ci.yml', 'admin'],
    ['gh workflow enable ci.yml', 'admin'],
    ['gh workflow disable ci.yml', 'admin'],
    ['gh secret set SAMPLE', 'admin'],
    ['gh release create v1', 'admin'],
    ['gh repo edit --description sample', 'admin'],
    ['gh api -X PATCH repos/acme/sample', 'admin'],
  ];
  for (const [command, expected] of commandCapabilities) assert.equal(classify(command), expected, command);

  for (const level of ['propose', 'merge', 'full']) {
    assert.equal(contract.levels[level].mainPullRequestApprovals, approvalCountFor(level));
    const approval = buildPayload(readFixtureRuleset('approval-main.json'), level);
    assert.equal(approval.rules.length, 1, `${level} approval-main has no path-specific rule`);
    assert.deepEqual(approval.bypass_actors, expectedApprovalBypass(level));
    assert.deepEqual(approval.bypass_actors, level === 'full' ? [] : [
      { actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'pull_request' },
    ], `${level} approval-main published bypass actor shape`);
    assert.equal(approval.rules.find((rule) => rule.type === 'pull_request')?.parameters.required_approving_review_count,
      contract.levels[level].mainPullRequestApprovals);
  }
  assert.deepEqual(expectedApprovalBypass('full'), []);
  assert.deepEqual(contract.mainProtection['protect-main'].bypassActors, []);
  assert.equal(contract.mainProtection.agentAppBypass, false);

  const resolve = (destination, ignorePolicy = ignore, host = 'github.com') => resolveDestination({
    roster,
    ownedForks,
    ownedRepositories,
    ignore: ignorePolicy,
    host,
    destination,
  });
  const allowedRead = { capability: null, readOnly: true, resolved: true };
  const unknown = resolve('acme/public-fixture');
  const ignored = resolve('acme/fixture-ignored');
  const unreadableIgnore = resolve('acme/public-fixture', null);
  const malformedIgnore = resolve('acme/public-fixture', { ignore: 'nope' });
  const nonGitHubWithoutIgnore = resolve('acme/public-fixture', null, 'gitlab.com');
  assert.equal(unknown.kind, 'unknown');
  assert.equal(decideTarget(unknown, allowedRead).allowed, true);
  assert.equal(decideTarget(unknown, { capability: 'pushBranch', resolved: true, refs: [{ kind: 'branch', isDefault: false }] }).allowed, false);
  assert.equal(ignored.kind, 'ignored');
  assert.equal(decideTarget(ignored, allowedRead).allowed, false);
  assert.equal(unreadableIgnore.source, 'ignore-unavailable');
  assert.equal(decideTarget(unreadableIgnore, allowedRead).allowed, false);
  assert.equal(malformedIgnore.source, 'ignore-unavailable');
  assert.equal(decideTarget(malformedIgnore, allowedRead).allowed, false);
  assert.equal(nonGitHubWithoutIgnore.kind, 'unknown');
  assert.equal(nonGitHubWithoutIgnore.source, 'unknown');
  assert.equal(decideTarget(nonGitHubWithoutIgnore, allowedRead).allowed, true);
  assert.equal(decideTarget(nonGitHubWithoutIgnore, { capability: 'pushBranch', resolved: true, refs: [{ kind: 'branch', isDefault: false }] }).allowed, false);

  const issue = resolve('simpsonm09-org/simpsonm09-fixture-nest');
  assert.equal(issue.level, 'propose');
  assert.equal(classify('gh issue create --title sample'), 'openPr');
  assert.equal(decideTarget(issue, { operation: 'openPr', capability: 'openPr', resolved: true }).allowed, true);
  assert.equal(permissionIsInManifest('issues:write'), false);
  assert.equal(CAPABILITIES_BY_KIND.ignored.length, 0);
  assert.equal(CAPABILITIES_BY_KIND.unknown.includes('read'), true);

  const protectBase = readFixtureRuleset('protect-main.json');
  const baseChecks = contract.mainProtection['protect-main'].requiredCheckContexts.baseContexts;
  assert.deepEqual(baseChecks, BASE_CONTEXTS);
  const coverageExceptions = [{ repo: 'acme/uncovered-fixture', checks: new Set(['ci/coverage']), reason: '', date: '' }];
  const coveredKind = kindOf(coverageExceptions, 'acme/covered-fixture');
  const uncoveredKind = kindOf(coverageExceptions, 'acme/uncovered-fixture');
  assert.equal(coveredKind, 'covered');
  assert.equal(uncoveredKind, 'uncovered');
  const covered = buildPayload(protectBase, 'full', coveredKind);
  const uncovered = buildPayload(protectBase, 'full', uncoveredKind);
  assert.deepEqual(checkContexts(covered), [...BASE_CONTEXTS, COVERAGE_CONTEXT]);
  assert.deepEqual(checkContexts(uncovered), BASE_CONTEXTS);
  assert.deepEqual(checkContexts(uncovered), baseChecks);
  assert.deepEqual(contract.mainProtection['protect-main'].requiredCheckContexts.coverage, {
    context: COVERAGE_CONTEXT,
    requiredWhen: 'repository has no ci/coverage exception in docs/exceptions.json',
    notRequiredWhen: 'repository has a ci/coverage exception in docs/exceptions.json',
  });
  assert.deepEqual(covered.bypass_actors, []);
  assert.equal(covered.rules.find((rule) => rule.type === 'required_signatures') !== undefined, true);
  assert.equal(covered.rules.find((rule) => rule.type === 'pull_request') !== undefined, true);
  assert.equal(covered.rules.find((rule) => rule.type === 'required_status_checks')?.parameters.strict_required_status_checks_policy, true);
}

function readFixtureRuleset(name) {
  return JSON.parse(readFileSync(new URL(`../rulesets/${name}`, import.meta.url), 'utf8'));
}

function checkContexts(payload) {
  return payload.rules.find((rule) => rule.type === 'required_status_checks')
    .parameters.required_status_checks.map(({ context }) => context);
}

export function runTest() {
  try {
    testContract();
    process.stdout.write('portable-app-contract: all assertions passed\n');
    return EXIT.OK;
  } catch (error) {
    process.stderr.write(`portable-app-contract: ${error.message}\n`);
    return EXIT.FAIL;
  }
}

if (isMain(import.meta.url)) process.exit(runTest());

#!/usr/bin/env node
// Validate the agent-access enforcement wiring end to end without pushing to the
// organization. Two layers are covered: the pure decision layer over a fixture
// catalog that maps the four fixture repositories to their levels, and the
// pre-push hook run as a subprocess against a throwaway clone.
//
// Usage:
//   node scripts/agent-access.test.mjs
//
// Exits 0 when every assertion holds and 1 on the first failure.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from './lib/proc.mjs';
import {
  CAPABILITIES,
  CAPABILITIES_BY_KIND,
  classify,
  decide,
  decideTarget,
  loadCatalog,
  loadCommittedOwnedForks,
  loadCommittedOwnedRepositories,
  resolveDestination,
  resolveLevel,
  resolveOwnedFork,
  resolveOwnedRepository,
} from './agent-access.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RESOLVER = join(HERE, 'agent-access.mjs');
const FIXTURE_CATALOG = join(HERE, 'fixtures', 'agent-access', 'repos.json');
const FIXTURE_OWNED_FORKS = join(HERE, 'fixtures', 'agent-access', 'owned-forks.json');
const FIXTURE_OWNED_REPOSITORIES = join(HERE, 'fixtures', 'agent-access', 'owned-repositories.json');
const HOOK_TEMPLATE = join(ROOT, 'templates', 'hooks', 'pre-push');
const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2 });

// The owned-fork fixture, as the resolver reads it. The pure policy tests use it
// directly; the loader tests commit it to a throwaway catalog clone.
const OWNED_FORKS = JSON.parse(readFileSync(FIXTURE_OWNED_FORKS, 'utf8'));
const [OWNED_ENTRY] = OWNED_FORKS.forks;
const OWNED_REPOSITORIES = JSON.parse(readFileSync(FIXTURE_OWNED_REPOSITORIES, 'utf8'));
const PROFILE_REPOSITORY = 'simpsonm09/simpsonm09';

// Each fixture repository and the exact level its catalog entry declares. The
// catalog is a fixture, so the live roster is never read.
const FIXTURES = [
  { repo: 'simpsonm09-fixture-nest', level: 'propose' },
  { repo: 'simpsonm09-fixture-go', level: 'full' },
  { repo: 'simpsonm09-fixture-rust', level: 'merge' },
  { repo: 'simpsonm09-fixture-dotnet', level: 'read' },
];

// Representative commands, the capability each needs, and whether the level
// grants it. A null capability is a command that reaches nothing governed, so
// every level allows it. `read` denies every remote write below.
const COMMANDS = [
  { command: 'git push origin feat/x', capability: 'pushBranch' },
  { command: 'git push origin main', capability: 'pushMain' },
  { command: 'gh pr create', capability: 'openPr' },
  { command: 'gh pr merge 1', capability: 'mergePr' },
  { command: 'gh api -X POST repos/o/r', capability: 'admin' },
  { command: 'git status', capability: null },
];

const EXPECTED = {
  propose: { read: true, pushBranch: true, pushMain: false, openPr: true, mergePr: false, admin: false },
  full: { read: true, pushBranch: true, pushMain: true, openPr: true, mergePr: true, admin: true },
  merge: { read: true, pushBranch: true, pushMain: false, openPr: true, mergePr: true, admin: false },
  read: { read: true, pushBranch: false, pushMain: false, openPr: false, mergePr: false, admin: false },
};

function makeAsserter() {
  let count = 0;
  const assert = (condition, message) => {
    count += 1;
    if (!condition) throw new Error(message);
  };
  return { assert, total: () => count };
}

// Level one: the fixture catalog resolves to the declared level, and the
// decision layer grants exactly the capabilities the level owns.
function testDecisionLayer(assert) {
  const catalog = loadCatalog(FIXTURE_CATALOG);
  for (const { repo, level } of FIXTURES) {
    const resolved = resolveLevel(catalog, repo);
    assert(resolved.level === level, `${repo} resolves to ${level}, got ${resolved.level}`);
    assert(resolved.source === 'override', `${repo} resolves from the per-repo override`);
    for (const { command, capability } of COMMANDS) {
      const { allowed } = decide(level, command);
      if (capability === null) {
        assert(allowed === true, `${repo} (${level}) allows ${JSON.stringify(command)}`);
      } else {
        const expected = EXPECTED[level][capability];
        assert(
          allowed === expected,
          `${level} ${allowed ? 'allows' : 'denies'} ${JSON.stringify(command)} (${capability}), expected ${expected}`,
        );
      }
    }
    for (const capability of CAPABILITIES[level]) {
      assert(EXPECTED[level][capability] !== undefined, `${level} capability ${capability} is covered`);
      assert(EXPECTED[level][capability] === true, `level ${level} grants ${capability}`);
    }
  }
  const read = resolveLevel(catalog, 'simpsonm09-fixture-dotnet').level;
  for (const { command, capability } of COMMANDS) {
    if (capability === null) continue;
    assert(decide(read, command).allowed === false, `read denies every remote write (${command})`);
  }
}

// The api method classifier. gh names the HTTP method after -X, after --method,
// in a --method=... form, or attached to the short flag (-XDELETE), and the
// attached form is the one the earlier token parser missed. A read method, a bare
// -X, and a token that merely starts with -X but is not a method stay reads.
function testMethodClassifier(assert) {
  const cases = [
    ['gh api -X GET repos/o/r', null],
    ['gh api -XGET repos/o/r', null],
    ['gh api -X HEAD repos/o/r', null],
    ['gh api -XHEAD repos/o/r', null],
    ['gh api repos/o/r', null],
    ['gh api -X', null],
    ['gh api -XPOSTED repos/o/r', 'admin'],
    ['gh api --method GET repos/o/r', null],
    ['gh api -X POST repos/o/r', 'admin'],
    ['gh api -XPOST repos/o/r', 'admin'],
    ['gh api -X PATCH repos/o/r', 'admin'],
    ['gh api -XPATCH repos/o/r', 'admin'],
    ['gh api -X PUT repos/o/r', 'admin'],
    ['gh api -XPUT repos/o/r', 'admin'],
    ['gh api -X DELETE repos/o/r', 'admin'],
    ['gh api -XDELETE repos/o/r', 'admin'],
    ['gh api -Xdelete repos/o/r', 'admin'],
    ['gh api --method POST repos/o/r', 'admin'],
    ['gh api --method=POST repos/o/r', 'admin'],
    ['gh api -X FROB repos/o/r', 'admin'],
    ['gh api -XFROB repos/o/r', 'admin'],
  ];
  for (const [command, expected] of cases) {
    const capability = classify(command);
    assert(capability === expected, `classify ${JSON.stringify(command)} -> ${expected}, got ${capability}`);
  }
  const read = decide('read', 'gh api -XDELETE repos/o/r');
  assert(read.allowed === false && read.capability === 'admin', 'a read level denies the attached write method');
  const full = decide('full', 'gh api -XDELETE repos/o/r');
  assert(full.allowed === true && full.capability === 'admin', 'a full level allows the attached write method');
}

// The push classifier. --prune removes the remote refs the refspec does not
// cover, so it needs pushMain wherever it sits relative to the remote and the
// refspecs, and the branch push without it stays pushBranch. A quoted example is
// not a push, because the classifier reads the program at the first token.
function testPushClassifier(assert) {
  const cases = [
    ['git push origin feat/x', 'pushBranch'],
    ['git push origin main', 'pushMain'],
    ['git push origin --prune feat/x', 'pushMain'],
    ['git push --prune origin feat/x', 'pushMain'],
    ['git push --dry-run --prune origin feat/x', 'pushMain'],
    ['git push origin --prune', 'pushMain'],
    ['git push --prune', 'pushMain'],
    ['git push origin --prune feat/x feat/y', 'pushMain'],
    ['git push origin --prune refs/heads/*:refs/heads/*', 'pushMain'],
    ['git push --dry-run origin feat/x', 'pushBranch'],
    ['echo "git push origin --prune feat/x"', null],
    ['git commit -m "git push origin --prune"', null],
  ];
  for (const [command, expected] of cases) {
    const capability = classify(command);
    assert(capability === expected, `classify ${JSON.stringify(command)} -> ${expected}, got ${capability}`);
  }
  const levels = [
    ['propose', 'git push origin --prune feat/x', 'pushMain', false],
    ['merge', 'git push origin --prune feat/x', 'pushMain', false],
    ['full', 'git push origin --prune feat/x', 'pushMain', true],
    ['read', 'git push origin --prune feat/x', 'pushMain', false],
    ['propose', 'git push origin feat/x', 'pushBranch', true],
  ];
  for (const [level, command, capability, allowed] of levels) {
    const decision = decide(level, command);
    assert(decision.capability === capability, `decide ${level} ${JSON.stringify(command)} needs ${capability}, got ${decision.capability}`);
    assert(decision.allowed === allowed, `a ${level} level ${allowed ? 'allows' : 'denies'} ${JSON.stringify(command)}, got ${decision.allowed}`);
  }
}

// The gh api body classifier. gh sends a body for -f/--field, -F/--raw-field,
// and --input, including the attached short form gh also accepts (-fkey=value,
// -Fkey=@file), which the earlier exact-token check missed. A read names none of
// them, a long flag is never read as an attached short flag, and a quoted
// example is not an api call.
function testApiBodyClassifier(assert) {
  const cases = [
    ['gh api -f name=value repos/o/r', 'admin'],
    ['gh api -fkey=value repos/o/r', 'admin'],
    ['gh api -Fkey=@file repos/o/r', 'admin'],
    ['gh api -f=key=value repos/o/r', 'admin'],
    ['gh api graphql -fquery=mutation', 'admin'],
    ['gh api --field=name=value repos/o/r', 'admin'],
    ['gh api --raw-field=name=value repos/o/r', 'admin'],
    ['gh api --input - repos/o/r', 'admin'],
    ['gh api -XPOST -fkey=value repos/o/r', 'admin'],
    ['gh api repos/o/r', null],
    ['gh api -XGET repos/o/r', null],
    ['gh api --jq .name repos/o/r', null],
    ['gh api repos/o/r --paginate', null],
    ['echo "gh api -fkey=value repos/o/r"', null],
    ['git commit -m "gh api -Fkey=@file"', null],
  ];
  for (const [command, expected] of cases) {
    const capability = classify(command);
    assert(capability === expected, `classify ${JSON.stringify(command)} -> ${expected}, got ${capability}`);
  }
  const read = decide('read', 'gh api -fkey=value repos/o/r');
  assert(read.allowed === false && read.capability === 'admin', 'a read level denies the attached body flag');
  const full = decide('full', 'gh api graphql -fquery=mutation');
  assert(full.allowed === true && full.capability === 'admin', 'a full level allows the attached body flag');
}

function testGhFallbackClassifier(assert) {
  const cases = [
    ['gh issue create --title "--help"', 'admin'],
    ['gh pr edit 52 --title "--help"', 'admin'],
    ['gh issue create --title -h', 'admin'],
    ['gh --help', null],
    ['gh -h', null],
    ['gh --version', null],
    ['gh issue --help', null],
    ['gh -h issue create --title x', 'admin'],
    ['gh --version issue create --title x', 'admin'],
    ['gh --help pr merge 52', 'admin'],
    ['gh issue --help create --title x', 'admin'],
    ['gh help issue create --title x', 'admin'],
    ['gh help pr', 'admin'],
    ['gh auth token', 'admin'],
    ['gh auth status', 'admin'],
    ['gh auth status --show-token', 'admin'],
    ['gh auth status -t', 'admin'],
    ['gh status', null],
    ['gh search repos foo', null],
    ['gh search foo x', 'admin'],
    ['gh repo unarchive o/r', 'admin'],
    ['gh mystery view', 'admin'],
    ['gh mystery list', 'admin'],
    ['gh pr list', null],
    ['gh issue list', null],
    ['gh release list', null],
    ['gh workflow list', null],
    ['gh api -X GET repos/o/r', null],
    ['gh api repos/o/r', null],
  ];
  for (const [command, expected] of cases) {
    assert(classify(command) === expected, `classify ${JSON.stringify(command)} -> ${expected}, got ${classify(command)}`);
  }
  assert(decide('read', 'gh issue create --title "--help"').allowed === false, 'help-like title does not make a write safe');
  assert(decide('none', 'gh auth token').allowed === false, 'auth token needs admin');
  assert(decide('read', 'gh auth status --show-token').allowed === false, 'token-bearing auth status needs admin');
  assert(decide('none', 'gh -h issue create --title x').allowed === false, 'help before a write verb needs admin');
  assert(decide('read', 'gh api -X FROB repos/o/r').allowed === false, 'unknown API method is not a read');
}

// Level one, destination half: one policy truth governs the organization
// repository and its personal push fork, the owned fork is a strict subset, and
// an upstream or an unknown destination gets reads only.
function testDestinationPolicy(assert) {
  const roster = loadCatalog(FIXTURE_CATALOG);
  const nest = 'simpsonm09-fixture-nest';
  const dotnet = 'simpsonm09-fixture-dotnet';
  const at = (localRepo, destination, host = 'github.com') =>
    resolveDestination({ roster, ownedForks: OWNED_FORKS, ownedRepositories: OWNED_REPOSITORIES, localRepo, host, destination });
  testRecognizedDestinations(assert, at, nest, dotnet);
  testInvalidOwnedPolicies(assert, roster, nest);
  testClosedDestinations(assert, roster, nest);
  testDestinationGrants(assert, at, nest, dotnet);
}

function testRecognizedDestinations(assert, at, nest, dotnet) {
  const recognized = [
    { name: 'the organization repository', local: nest, destination: `simpsonm09-org/${nest}`, kind: 'org', level: 'propose', source: 'org' },
    { name: 'a differently cased organization repository', local: nest, destination: 'SimpsonM09-Org/SimpsonM09-Fixture-Nest', kind: 'org', level: 'propose', source: 'org' },
    { name: 'the personal push fork of a propose repository', local: nest, destination: `simpsonm09/${nest}`, kind: 'org', level: 'propose', source: 'personal-fork' },
    { name: 'the personal push fork of a read repository', local: dotnet, destination: `simpsonm09/${dotnet}`, kind: 'org', level: 'read', source: 'personal-fork' },
    { name: 'an owned fork', local: 'pstack-max', destination: OWNED_ENTRY.repository, kind: 'owned-fork', level: 'propose', source: 'owned-fork' },
    { name: 'an exact standalone owned repository', local: 'simpsonm09', destination: PROFILE_REPOSITORY, kind: 'owned-repository', level: 'propose', source: 'owned-repository' },
    { name: 'a recorded upstream', local: 'pstack-max', destination: OWNED_ENTRY.upstream, kind: 'upstream', level: 'none', source: 'upstream' },
  ];
  for (const { name, local, destination, kind, level, source } of recognized) {
    const target = at(local, destination);
    assert(target.kind === kind, `${name} resolves to ${kind}, got ${target.kind}`);
    assert(target.level === level && target.source === source, `${name} resolves to ${level} from ${source}`);
  }

  const unknown = [
    { name: 'a third-party repository named like a governed repository', local: nest, destination: `acme/${nest}` },
    { name: "another governed repository's fork", local: nest, destination: 'simpsonm09/simpsonm09-fixture-go' },
    { name: 'an unrelated third party', local: nest, destination: 'acme/unrelated' },
    { name: 'another host', local: nest, destination: `simpsonm09-org/${nest}`, host: 'gitlab.com' },
    { name: 'an unlisted organization repository', local: nest, destination: 'simpsonm09-org/not-listed' },
    { name: 'a malformed destination', local: nest, destination: 'not-a-repository' },
    { name: 'an empty destination', local: nest, destination: '' },
  ];
  for (const { name, local, destination, host } of unknown) {
    const target = at(local, destination, host);
    assert(target.kind === 'unknown' && target.level === 'none', `${name} is unknown and level none, got ${target.kind}/${target.level}`);
  }
}

function testInvalidOwnedPolicies(assert, roster, nest) {
  assert(resolveOwnedFork(OWNED_FORKS, OWNED_ENTRY.repository.split('/')[0], OWNED_ENTRY.repository.split('/')[1]).owned === true, 'the fixture target matches itself');
  assert(resolveOwnedFork(OWNED_FORKS, OWNED_ENTRY.repository.split('/')[0].toUpperCase(), OWNED_ENTRY.repository.split('/')[1].toUpperCase()).owned === true, 'the owned-fork match is case-insensitive');
  assert(resolveOwnedFork(OWNED_FORKS, OWNED_ENTRY.repository.split('/')[0], 'other').owned === false, 'an unrelated repository is not an owned fork');
  assert(resolveOwnedFork(null, OWNED_ENTRY.repository.split('/')[0], OWNED_ENTRY.repository.split('/')[1]).owned === false, 'a missing policy owns nothing');
  assert(resolveOwnedRepository(OWNED_REPOSITORIES, 'SIMPSONM09', 'SIMPSONM09', OWNED_FORKS).owned === true, 'the standalone identity matches case-insensitively');
  assert(resolveOwnedRepository(OWNED_REPOSITORIES, 'simpsonm09', 'other', OWNED_FORKS).owned === false, 'a same-owner repository without an exact record is not owned');
  assert(resolveOwnedRepository(OWNED_REPOSITORIES, 'acme', 'simpsonm09', OWNED_FORKS).owned === false, 'a foreign owner with the same repository name is not owned');
  assert(resolveOwnedRepository({ repositories: [{ repository: OWNED_ENTRY.repository, agentAccess: 'propose' }] }, 'simpsonm09', OWNED_ENTRY.repository.split('/')[1], OWNED_FORKS).owned === false, 'a standalone record cannot collide with an owned-fork target');
  assert(resolveOwnedRepository({ repositories: [{ repository: OWNED_ENTRY.upstream, agentAccess: 'propose' }] }, ...OWNED_ENTRY.upstream.split('/'), OWNED_FORKS).owned === false, 'a standalone record cannot collide with a fork upstream');

  // A raw policy object a pure caller passes in must satisfy the same validation
  // the committed loader applies, including the single personal owner. A policy
  // the catalog validator would reject grants nothing and collapses nothing, on
  // its own entry and on a valid entry that shares the file with it.
  const foreignEntry = { repository: 'evil/fixture-owned', upstream: 'acme/upstream-lib', agentAccess: 'propose' };
  const foreignOnly = { forks: [foreignEntry] };
  assert(resolveOwnedFork(foreignOnly, 'evil', 'fixture-owned').owned === false, 'an entry owned by another account is not an owned fork');
  const foreignTarget = resolveDestination({ roster, ownedForks: foreignOnly, localRepo: 'fixture-owned', host: 'github.com', destination: foreignEntry.repository });
  assert(foreignTarget.kind === 'unknown' && foreignTarget.level === 'none', `a foreign-owner target is unknown, got ${foreignTarget.kind}/${foreignTarget.level}`);

  const foreignForkPolicy = { forks: [{ repository: `evil/${nest}`, upstream: 'acme/upstream-lib', agentAccess: 'propose' }] };
  const foreignCollapse = resolveDestination({ roster, ownedForks: foreignForkPolicy, localRepo: nest, host: 'github.com', destination: `evil/${nest}` });
  assert(foreignCollapse.kind === 'unknown' && foreignCollapse.level === 'none', `a foreign owner never collapses to the org level, got ${foreignCollapse.kind}/${foreignCollapse.level}`);

  const mixedOwners = { forks: [OWNED_ENTRY, foreignEntry] };
  assert(resolveOwnedFork(mixedOwners, ...OWNED_ENTRY.repository.split('/')).owned === false, 'a mixed-owner policy grants nothing, not even its valid entry');
  const mixedTarget = resolveDestination({ roster, ownedForks: mixedOwners, localRepo: 'fixture-owned', host: 'github.com', destination: OWNED_ENTRY.repository });
  assert(mixedTarget.kind === 'unknown' && mixedTarget.level === 'none', `a mixed-owner policy collapses nothing, got ${mixedTarget.kind}/${mixedTarget.level}`);
  const mixedFork = resolveDestination({ roster, ownedForks: mixedOwners, localRepo: nest, host: 'github.com', destination: `simpsonm09/${nest}` });
  assert(mixedFork.kind === 'unknown', `a mixed-owner policy admits no personal push fork, got ${mixedFork.kind}`);
}

function testClosedDestinations(assert, roster, nest) {
  const closed = [
    { name: 'a personal push fork', local: nest, destination: `simpsonm09/${nest}` },
    { name: 'an owned fork', local: 'pstack-max', destination: OWNED_ENTRY.repository },
  ];
  for (const { name, local, destination } of closed) {
    const target = resolveDestination({ roster, ownedForks: null, localRepo: local, host: 'github.com', destination });
    assert(target.kind === 'unknown', `${name} fails closed without the owned-fork policy, got ${target.kind}`);
  }
  const noRoster = resolveDestination({ roster: null, ownedForks: OWNED_FORKS, localRepo: nest, host: 'github.com', destination: `simpsonm09/${nest}` });
  assert(noRoster.kind === 'unknown', 'a missing roster closes the organization and personal-fork kinds');
  const rosterlessOwned = resolveDestination({ roster: null, ownedForks: OWNED_FORKS, localRepo: 'pstack-max', host: 'github.com', destination: OWNED_ENTRY.repository });
  assert(rosterlessOwned.kind === 'owned-fork', 'an owned fork resolves without the roster');
}

function testDestinationGrants(assert, at, nest, dotnet) {
  assert(CAPABILITIES_BY_KIND.org === null, 'the org kind defers to the level table');
  const ownedGrant = CAPABILITIES_BY_KIND['owned-fork'];
  assert(ownedGrant.every((capability) => CAPABILITIES.propose.includes(capability)), 'the owned-fork grant is a subset of propose');
  assert(['mergePr', 'pushMain', 'admin'].every((capability) => !ownedGrant.includes(capability)), 'the owned fork grants no merge, main push, or admin');

  const owned = at('pstack-max', OWNED_ENTRY.repository);
  const standalone = at('simpsonm09', PROFILE_REPOSITORY);
  const orgPropose = at(nest, `simpsonm09-org/${nest}`);
  const push = (extra) => ({
    operation: 'push',
    capability: 'pushBranch',
    readOnly: false,
    resolved: true,
    force: false,
    delete: false,
    refs: [{ kind: 'branch', name: 'feat/x', isDefault: false }],
    ...extra,
  });

  const table = [
    ['a non-default branch push', push(), true],
    ['a forced branch push', push({ force: true }), false],
    ['a branch deletion', push({ delete: true }), false],
    ['a default-branch push', push({ refs: [{ kind: 'branch', name: 'main', isDefault: true }] }), false],
    ['an unresolved default branch', push({ refs: [{ kind: 'branch', name: 'main', isDefault: null }] }), false],
    ['a push with no resolved ref', push({ refs: [] }), false],
    ['a tag push', push({ refs: [{ kind: 'tag', name: 'v1', isDefault: false }] }), false],
    ['a non-branch ref', push({ refs: [{ kind: 'other', name: 'v1', isDefault: false }] }), false],
    ['a multi-refspec push', push({ refs: [{ kind: 'branch', name: 'a', isDefault: false }, { kind: 'branch', name: 'b', isDefault: false }] }), false],
    ['an unresolved destination', push({ resolved: false }), false],
    ['a main push', push({ capability: 'pushMain' }), false],
    ['a merge', push({ capability: 'mergePr' }), false],
    ['an admin verb', push({ capability: 'admin' }), false],
    ['an unknown capability', push({ capability: 'nope' }), false],
    ['a pull request with branch-only sides', push({ capability: 'openPr', base: { branch: 'main' }, head: { branch: 'feat/x' } }), true],
    ['a pull request with an owner-qualified same repository base', push({ capability: 'openPr', base: { owner: 'simpsonm09', repo: 'fixture-owned', branch: 'main' } }), true],
    ['a pull request with a cross-owner base', push({ capability: 'openPr', base: { owner: 'acme', repo: 'upstream-lib', branch: 'main' } }), false],
    ['a pull request with an owner-qualified base and no repository', push({ capability: 'openPr', base: { owner: 'simpsonm09', branch: 'main' } }), false],
    ['a pull request with a cross-owner head', push({ capability: 'openPr', head: { owner: 'acme', repo: 'upstream-lib', branch: 'feat/x' } }), false],
    ['a read', { operation: 'read', capability: 'read', readOnly: true, resolved: true }, true],
    ['a known read with no capability', { operation: 'read', capability: null, readOnly: true, resolved: true }, true],
    ['an unqualified command with no capability', { operation: 'unknown', capability: null, readOnly: false, resolved: true }, false],
  ];
  const standaloneTable = [
    ['a non-default branch push', push(), true],
    ['a forced branch push', push({ force: true }), false],
    ['a branch deletion', push({ delete: true }), false],
    ['a default-branch push', push({ refs: [{ kind: 'branch', name: 'main', isDefault: true }] }), false],
    ['a tag push', push({ refs: [{ kind: 'tag', name: 'v1', isDefault: false }] }), false],
    ['a pull request with branch-only sides', push({ capability: 'openPr', base: { branch: 'main' }, head: { branch: 'feat/x' } }), true],
    ['a pull request with an owner-qualified same repository base', push({ capability: 'openPr', base: { owner: 'simpsonm09', repo: 'simpsonm09', branch: 'main' } }), true],
    ['a cross-repository pull request', push({ capability: 'openPr', base: { owner: 'acme', repo: 'other', branch: 'main' } }), false],
    ['a merge', push({ capability: 'mergePr' }), false],
    ['an admin verb', push({ capability: 'admin' }), false],
    ['an unknown capability', push({ capability: 'nope' }), false],
  ];
  for (const [name, intent, expected] of table) {
    const { allowed, reason } = decideTarget(owned, intent);
    assert(allowed === expected, `an owned fork ${expected ? 'allows' : 'denies'} ${name} (${reason})`);
  }
  for (const [name, intent, expected] of standaloneTable) {
    const { allowed, reason } = decideTarget(standalone, intent);
    assert(allowed === expected, `a standalone owned repository ${expected ? 'allows' : 'denies'} ${name} (${reason})`);
  }
  assert(decideTarget(at('simpsonm09', 'acme/other'), push()).allowed === false, 'a third-party destination denies a branch push');

  const orgRead = at(dotnet, `simpsonm09-org/${dotnet}`);
  assert(decideTarget(orgPropose, push()).allowed === true, 'a propose repository allows a branch push');
  assert(decideTarget(orgPropose, push({ capability: 'pushMain' })).allowed === false, 'a propose repository denies a main push');
  assert(decideTarget(orgPropose, push({ capability: 'mergePr' })).allowed === false, 'a propose repository denies a merge');
  assert(decideTarget(orgRead, push()).allowed === false, 'a read repository denies a branch push');
  assert(decideTarget(orgPropose, push({ resolved: false })).allowed === true, 'an org destination keeps its level when the ref is unresolved');

  testPullRequestSides(assert, owned, standalone, push);
  testIntentConsistency(assert, at, push, orgPropose);
}

function testPullRequestSides(assert, owned, standalone, push) {
  const prSideCases = [
    ['an omitted side', undefined, true],
    ['a branch-only side', { branch: 'feat/x' }, true],
    ['a foreign repo-only identity', { repo: 'elsewhere', branch: 'feat/x' }, false],
    ['a repo-only identity matching the target name', { repo: 'simpsonm09', branch: 'feat/x' }, false],
    ['an owner-only identity', { owner: 'simpsonm09', branch: 'feat/x' }, false],
    ['an explicit null owner', { owner: null, repo: 'simpsonm09', branch: 'feat/x' }, false],
    ['an explicit null repo', { owner: 'simpsonm09', repo: null, branch: 'feat/x' }, false],
    ['an empty owner with a repository', { owner: '', repo: 'simpsonm09', branch: 'feat/x' }, false],
    ['a repository with an empty owner', { owner: 'simpsonm09', repo: '', branch: 'feat/x' }, false],
    ['explicit empty identity fields', { owner: '', repo: '', branch: 'feat/x' }, false],
    ['an owner without a repo', { owner: 'simpsonm09', branch: 'feat/x' }, false],
    ['a complete cross-repository identity', { owner: 'acme', repo: 'elsewhere', branch: 'feat/x' }, false],
  ];
  for (const target of [owned, standalone]) {
    const cases = [...prSideCases, ['a case-insensitive full identity match', { owner: target.owner.toUpperCase(), repo: target.repo.toUpperCase(), branch: 'feat/x' }, true]];
    for (const [sideName, side, expected] of cases) {
      for (const position of ['base', 'head']) {
        const intent = push({ capability: 'openPr', ...(side === undefined ? {} : { [position]: side }) });
        assert(decideTarget(target, intent).allowed === expected, `${target.kind} ${expected ? 'allows' : 'denies'} ${sideName} in PR ${position}`);
      }
    }
  }
}

function testIntentConsistency(assert, at, push, orgPropose) {
  // An intent that contradicts itself about writing denies, whatever the
  // destination grants: the null-capability read path is not a way to launder a
  // write, and the reason names the mismatch. The last case is the one a
  // destination-only check would miss, because a propose repository grants the
  // push the intent claims not to be.
  const inconsistent = [
    ['a push operation with no capability', { ...push(), capability: null }],
    ['a push operation marked read-only with no capability', { ...push(), capability: null, readOnly: true }],
    ['a read operation with a write capability', { ...push(), operation: 'read', capability: 'pushBranch' }],
    ['a push operation with a read capability', { ...push(), capability: 'read', readOnly: true }],
  ];
  for (const [name, intent] of inconsistent) {
    const { allowed, reason } = decideTarget(orgPropose, intent);
    assert(allowed === false, `a propose repository denies ${name}`);
    assert(
      reason === 'the operation and the capability disagree about writing',
      `${name} is denied as an inconsistent intent, got ${JSON.stringify(reason)}`,
    );
  }
  assert(decideTarget(orgPropose, { operation: 'read', capability: null, readOnly: true, resolved: true }).allowed === true, 'a genuine read stays allowed');

  const readIntent = { operation: 'read', capability: null, readOnly: true, resolved: true };
  for (const destination of [OWNED_ENTRY.upstream, 'acme/unrelated']) {
    const target = at('pstack-max', destination);
    assert(decideTarget(target, push()).allowed === false, `${destination} denies a branch push`);
    assert(decideTarget(target, push({ capability: 'admin' })).allowed === false, `${destination} denies an admin verb`);
    assert(decideTarget(target, readIntent).allowed === true, `${destination} allows a read`);
  }
}

// Build a throwaway clone to stand in for the catalog. `policy` overrides the
// committed file, `upstream` controls whether the organization ref exists, and
// `forge` commits a widened policy to the writable local `main` afterwards.
function makeCatalog({ policy, ownedRepositories, includeOwnedRepositories = true, upstream = true, forge } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-access-catalog-'));
  const git = (...args) => spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'user.email=agent-access@example.invalid', '-c', 'user.name=agent-access-test', ...args],
    { windowsHide: true, cwd: dir, encoding: 'utf8' },
  );
  const commit = (message) => {
    git('add', '.');
    git('commit', '-q', '-m', message);
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'repos.json'), readFileSync(FIXTURE_CATALOG));
  writeFileSync(join(dir, 'owned-forks.json'), policy ?? readFileSync(FIXTURE_OWNED_FORKS));
  if (includeOwnedRepositories) {
    writeFileSync(join(dir, 'owned-repositories.json'), ownedRepositories ?? readFileSync(FIXTURE_OWNED_REPOSITORIES));
  }
  commit('the committed policy');
  if (upstream) git('update-ref', 'refs/remotes/upstream/main', 'HEAD');
  if (forge) {
    const entry = { repository: forge, upstream: OWNED_ENTRY.upstream, agentAccess: 'propose' };
    writeFileSync(join(dir, 'owned-forks.json'), JSON.stringify({ forks: [entry] }));
    commit('a forged local main');
  }
  return dir;
}

// The owned-fork loader reads one committed ref. A writable local ref, a
// malformed file, and an unsupported level must each close the kind instead of
// becoming a grant.
function testCommittedOwnedForks(assert) {
  const readable = makeCatalog();
  const forged = makeCatalog({ forge: 'simpsonm09/forged-target' });
  const localOnly = makeCatalog({ upstream: false, forge: 'simpsonm09/forged-target' });
  const unsupported = makeCatalog({ policy: JSON.stringify({ forks: [{ repository: 'simpsonm09/wide', upstream: OWNED_ENTRY.upstream, agentAccess: 'merge' }] }) });
  const foreignOwner = makeCatalog({ policy: JSON.stringify({ forks: [{ repository: 'acme/wide', upstream: OWNED_ENTRY.upstream, agentAccess: 'propose' }] }) });
  const mixedOwners = makeCatalog({ policy: JSON.stringify({ forks: [OWNED_ENTRY, { repository: 'evil/fixture-owned', upstream: 'acme/other', agentAccess: 'propose' }] }) });
  const malformed = makeCatalog({ policy: '{' });
  try {
    const policy = loadCommittedOwnedForks(readable);
    assert(policy?.forks?.length === 1, 'the loader reads the committed policy');
    assert(policy.forks[0].repository === OWNED_ENTRY.repository, 'the loader keeps the committed target');

    const forgedPolicy = loadCommittedOwnedForks(forged);
    assert(forgedPolicy.forks.length === 1, 'a forged local main cannot add a second target');
    const roster = loadCatalog(FIXTURE_CATALOG);
    const target = resolveDestination({ roster, ownedForks: forgedPolicy, localRepo: 'pstack-max', host: 'github.com', destination: 'simpsonm09/forged-target' });
    assert(target.kind === 'unknown', 'a forged target resolves to unknown');

    assert(loadCommittedOwnedForks(localOnly) === null, 'a local main ref is never a grant source');
    assert(loadCommittedOwnedForks(unsupported) === null, 'an unsupported level is not a grant');
    assert(loadCommittedOwnedForks(foreignOwner) === null, 'a policy owned by another account is not a grant');
    assert(loadCommittedOwnedForks(mixedOwners) === null, 'a mixed-owner policy is not a grant');
    assert(loadCommittedOwnedForks(malformed) === null, 'a malformed policy is not a grant');
    assert(loadCommittedOwnedForks(join(readable, 'missing')) === null, 'a missing clone closes the kind');
  } finally {
    for (const dir of [readable, forged, localOnly, unsupported, foreignOwner, mixedOwners, malformed]) rmSync(dir, { recursive: true, force: true });
  }
}

function testCommittedOwnedRepositories(assert) {
  const valid = makeCatalog();
  const missing = makeCatalog({ includeOwnedRepositories: false });
  const localOnly = makeCatalog({ includeOwnedRepositories: false, upstream: false });
  const malformed = makeCatalog({ ownedRepositories: '{' });
  const unknownKey = makeCatalog({ ownedRepositories: JSON.stringify({ repositories: [{ repository: PROFILE_REPOSITORY, agentAccess: 'propose', upstream: 'acme/x' }] }) });
  const foreignOwner = makeCatalog({ ownedRepositories: JSON.stringify({ repositories: [{ repository: 'acme/profile', agentAccess: 'propose' }] }) });
  const duplicate = makeCatalog({ ownedRepositories: JSON.stringify({ repositories: [{ repository: PROFILE_REPOSITORY, agentAccess: 'propose' }, { repository: 'SIMPSONM09/SIMPSONM09', agentAccess: 'propose' }] }) });
  const forkCollision = makeCatalog({ ownedRepositories: JSON.stringify({ repositories: [{ repository: OWNED_ENTRY.repository, agentAccess: 'propose' }] }) });
  const upstreamCollision = makeCatalog({ ownedRepositories: JSON.stringify({ repositories: [{ repository: OWNED_ENTRY.upstream, agentAccess: 'propose' }] }) });
  const wrongLevel = makeCatalog({ ownedRepositories: JSON.stringify({ repositories: [{ repository: PROFILE_REPOSITORY, agentAccess: 'merge' }] }) });
  const forgedLocal = makeCatalog({ ownedRepositories: '{', forge: 'simpsonm09/profile-forged' });
  const dirs = [valid, missing, localOnly, malformed, unknownKey, foreignOwner, duplicate, forkCollision, upstreamCollision, wrongLevel, forgedLocal];
  try {
    const loaded = loadCommittedOwnedRepositories(valid);
    assert(loaded?.repositories?.[0]?.repository === PROFILE_REPOSITORY, 'the loader reads the exact committed standalone identity');
    assert(loadCommittedOwnedRepositories(missing) === null, 'a missing standalone policy disables only this grant');
    assert(loadCommittedOwnedForks(missing)?.forks?.length === 1, 'a missing standalone policy leaves the fork policy available');
    const forkWithoutStandalone = resolveDestination({ roster: loadCatalog(FIXTURE_CATALOG), ownedForks: loadCommittedOwnedForks(missing), ownedRepositories: null, localRepo: 'pstack-max', host: 'github.com', destination: OWNED_ENTRY.repository });
    assert(forkWithoutStandalone.kind === 'owned-fork', 'a missing standalone policy leaves existing owned-fork resolution unchanged');
    assert(loadCommittedOwnedRepositories(valid) !== null && resolveOwnedRepository({ repositories: [] }, 'simpsonm09', 'simpsonm09', OWNED_FORKS).owned === false, 'an empty standalone policy is valid and grants no target');
    assert(loadCommittedOwnedRepositories(localOnly) === null, 'a local main or working-tree policy is never a grant source');
    for (const [name, dir] of [
      ['malformed JSON', malformed], ['unknown key', unknownKey], ['foreign owner', foreignOwner],
      ['duplicate identity', duplicate], ['fork target collision', forkCollision],
      ['upstream collision', upstreamCollision], ['wrong access level', wrongLevel],
    ]) assert(loadCommittedOwnedRepositories(dir) === null, `${name} disables the standalone grant`);
    const forged = loadCommittedOwnedRepositories(forgedLocal);
    assert(forged === null, 'a forged local policy cannot grant a standalone repository');
    const target = resolveDestination({ roster: loadCatalog(FIXTURE_CATALOG), ownedForks: OWNED_FORKS, ownedRepositories: forged, localRepo: 'simpsonm09', host: 'github.com', destination: 'simpsonm09/profile-forged' });
    assert(target.kind === 'unknown', 'the forged local identity resolves to unknown');
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
}

// Write a sibling resolver that the hook finds at
// <tmp>/simpsonm09-repo-standard/scripts/agent-access.mjs. It imports the real
// module by absolute path, but resolves against the fixture catalog, so the hook
// exercises the real capability table over the fixture levels without touching
// the live roster.
function writeFakeResolver(baseDir) {
  const shadow = join(baseDir, 'simpsonm09-repo-standard', 'scripts');
  mkdirSync(shadow, { recursive: true });
  const file = join(shadow, 'agent-access.mjs');
  const body = [
    `import { CAPABILITIES, loadCatalog, resolveLevel } from ${JSON.stringify(pathToFileURL(RESOLVER).href)};`,
    `const catalog = loadCatalog(${JSON.stringify(FIXTURE_CATALOG)});`,
    'const [repo, flag, capability] = process.argv.slice(2);',
    "if (flag !== '--allows') process.exit(2);",
    'const level = resolveLevel(catalog, repo).level;',
    'process.exit((CAPABILITIES[level] ?? []).includes(capability) ? 0 : 1);',
    '',
  ].join('\n');
  writeFileSync(file, body);
  const shared = join(shadow, 'lib');
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, 'env-pre-push.mjs'), readFileSync(join(ROOT, 'scripts', 'lib', 'env-pre-push.mjs')));
  writeFileSync(join(shared, 'env-path.mjs'), readFileSync(join(ROOT, 'scripts', 'lib', 'env-path.mjs')));
  return file;
}

function resolveShell() {
  if (process.platform !== 'win32') return 'sh';
  for (const candidate of [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'sh.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'sh.exe'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'sh';
}

// Level two: install the hook in a throwaway repository, invoke it with the
// remote arguments and the refs on stdin, and assert the exit code.
function testHook(assert) {
  const base = mkdtempSync(join(tmpdir(), 'agent-access-hook-'));
  try {
    const clone = join(base, 'fixture-clone');
    mkdirSync(clone, { recursive: true });
    const init = spawnSync('git', ['init', '-q', clone], { windowsHide: true, encoding: 'utf8' });
    assert(init.status === 0, `hook fixture: git init succeeds (${(init.stderr ?? '').trim()})`);
    const hook = join(clone, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, readFileSync(HOOK_TEMPLATE));
    chmodSync(hook, 0o755);
    writeFakeResolver(base);
    const shell = resolveShell();
    const orgUrl = (repo) => `https://github.com/simpsonm09-org/${repo}.git`;
    const orgScpUrl = (repo) => `git@github.com:simpsonm09-org/${repo}.git`;
    const forkUrl = (repo) => `https://github.com/simpsonm09/${repo}.git`;
    const nest = orgUrl('simpsonm09-fixture-nest');
    const go = orgUrl('simpsonm09-fixture-go');
    const rust = orgUrl('simpsonm09-fixture-rust');
    const dotnet = orgUrl('simpsonm09-fixture-dotnet');

    const cases = [
      { name: 'propose allows a branch push', ref: 'refs/heads/feat/x', url: nest, exit: 0 },
      { name: 'propose denies a main push', ref: 'refs/heads/main', url: nest, exit: 1 },
      { name: 'full allows a main push', ref: 'refs/heads/main', url: go, exit: 0 },
      { name: 'full allows a tag push', ref: 'refs/tags/v1', url: go, exit: 0 },
      { name: 'full allows an SCP-style organization remote', ref: 'refs/heads/feat/x', url: orgScpUrl('simpsonm09-fixture-go'), exit: 0 },
      { name: 'merge denies a main push', ref: 'refs/heads/main', url: rust, exit: 1 },
      { name: 'merge denies a tag push', ref: 'refs/tags/v1', url: rust, exit: 1 },
      { name: 'read denies a branch push', ref: 'refs/heads/feat/x', url: dotnet, exit: 1 },
      { name: 'read denies a branch push to an SCP-style organization remote', ref: 'refs/heads/feat/x', url: orgScpUrl('simpsonm09-fixture-dotnet'), exit: 1 },
      { name: 'read denies a branch push to an HTTP organization remote', ref: 'refs/heads/feat/x', url: 'http://github.com/simpsonm09-org/simpsonm09-fixture-dotnet.git', exit: 1 },
      { name: 'read denies a tag push', ref: 'refs/tags/v1', url: dotnet, exit: 1 },
      { name: 'a fork remote is out of scope', ref: 'refs/heads/main', url: forkUrl('simpsonm09-fixture-dotnet'), exit: 0 },
      { name: 'an SCP-style personal fork remote is out of scope', ref: 'refs/heads/main', url: `git@github.com:simpsonm09/simpsonm09-fixture-dotnet.git`, exit: 0 },
    ];

    for (const { name, ref, url, exit } of cases) {
      const zero = '0'.repeat(40);
      const stdin = `${ref} ${zero} ${ref} ${zero}\n`;
      const result = spawnSync(shell, [hook, 'origin', url], { windowsHide: true, cwd: clone, input: stdin, encoding: 'utf8' });
      assert(
        result.status === exit,
        `hook: ${name} exits ${exit}, got ${result.status} (${(result.stderr ?? '').trim()})`,
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// Run the resolver as an executable and return its status, stdout, and stderr.
// The process.exit edges in main() cannot be imported, so every CLI path is
// driven through a real subprocess.
function runResolver(extra) {
  const result = spawnSync(process.execPath, [RESOLVER, ...extra], { windowsHide: true, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// The CLI entry points main() shares with the flag-based consumers: argument
// parsing for every flag, the missing-repo usage exit, a JSON level report, the
// command mode with a JSON body and its allow/deny exit, the allows mode, and
// the self-test path. Every case resolves against the fixture catalog so the
// live roster is never read.
function testCli(assert) {
  const noRepo = runResolver([]);
  assert(noRepo.status === EXIT.USAGE, `no repository argument exits ${EXIT.USAGE}, got ${noRepo.status}`);
  assert(noRepo.stderr.includes('usage: agent-access'), 'the missing-repo path prints usage to stderr');

  const level = runResolver(['simpsonm09-fixture-rust', '--catalog', FIXTURE_CATALOG]);
  assert(level.status === EXIT.OK, `the level mode exits ${EXIT.OK}, got ${level.status}`);
  assert(level.stdout.trim() === 'merge', `the level mode prints the level, got ${JSON.stringify(level.stdout.trim())}`);

  const asJson = runResolver(['simpsonm09-fixture-rust', '--catalog', FIXTURE_CATALOG, '--json']);
  assert(asJson.status === EXIT.OK, `the JSON level mode exits ${EXIT.OK}, got ${asJson.status}`);
  const parsed = JSON.parse(asJson.stdout);
  assert(parsed.level === 'merge' && Array.isArray(parsed.capabilities), 'the JSON level mode carries the level and capabilities');

  const allowed = runResolver(['simpsonm09-fixture-go', '--catalog', FIXTURE_CATALOG, '--allows', 'pushMain']);
  assert(allowed.status === EXIT.OK, `an allowed capability exits ${EXIT.OK}, got ${allowed.status}`);
  const denied = runResolver(['simpsonm09-fixture-rust', '--catalog', FIXTURE_CATALOG, '--allows', 'pushMain']);
  assert(denied.status === EXIT.FAIL, `a denied capability exits ${EXIT.FAIL}, got ${denied.status}`);

  const permitted = runResolver([
    'simpsonm09-fixture-go', '--catalog', FIXTURE_CATALOG,
    '--command', 'git push origin feat/x', '--remote-url', 'https://github.com/simpsonm09-org/simpsonm09-fixture-go.git', '--json',
  ]);
  assert(permitted.status === EXIT.OK, `an allowed command exits ${EXIT.OK}, got ${permitted.status}`);
  const decision = JSON.parse(permitted.stdout);
  assert(decision.allowed === true && decision.capability === 'pushBranch', 'the command JSON carries the capability and verdict');
  const governed = runResolver([
    'simpsonm09-fixture-rust', '--catalog', FIXTURE_CATALOG,
    '--command', 'git push origin main', '--remote-url', 'https://github.com/simpsonm09-org/simpsonm09-fixture-rust.git',
  ]);
  assert(governed.status === EXIT.FAIL, `a denied command exits ${EXIT.FAIL}, got ${governed.status}`);

  const badCatalog = runResolver(['simpsonm09-fixture-go', '--catalog', join(HERE, 'no-such-catalog.json')]);
  assert(badCatalog.status === EXIT.USAGE, `an unreadable catalog exits ${EXIT.USAGE}, got ${badCatalog.status}`);
  assert(badCatalog.stderr.includes('cannot read the catalog'), 'an unreadable catalog prints the fail-closed message');

  const selfTest = runResolver(['--self-test']);
  assert(selfTest.status === EXIT.OK, `the self-test exits ${EXIT.OK}, got ${selfTest.status}`);
  assert(selfTest.stdout.includes('self-test ok'), 'the self-test prints its success line');
}

// The destination mode is the real entry a hook or an adapter calls, so it is
// driven as a subprocess against a throwaway committed catalog.
function testDestinationCli(assert) {
  const dir = makeCatalog();
  try {
    const common = ['--catalog-dir', dir, '--host', 'github.com'];
    const intent = (extra) => JSON.stringify({
      operation: 'push',
      capability: 'pushBranch',
      readOnly: false,
      resolved: true,
      refs: [{ kind: 'branch', name: 'feat/x', isDefault: false }],
      ...extra,
    });
    const destination = ['--destination', OWNED_ENTRY.repository];

    const allowed = runResolver(['fixture-owned', ...common, ...destination, '--intent', intent(), '--json']);
    assert(allowed.status === EXIT.OK, `an owned-fork branch push exits ${EXIT.OK}, got ${allowed.status} (${allowed.stderr.trim()})`);
    const decision = JSON.parse(allowed.stdout);
    assert(decision.allowed === true && decision.kind === 'owned-fork', 'the destination JSON carries the kind and the verdict');
    assert(decision.capability === 'pushBranch', 'the destination JSON carries the capability');

    const standalone = ['--destination', PROFILE_REPOSITORY];
    const standaloneAllowed = runResolver(['simpsonm09', ...common, ...standalone, '--intent', intent(), '--json']);
    assert(standaloneAllowed.status === EXIT.OK, `an owned-repository branch push exits ${EXIT.OK}, got ${standaloneAllowed.status}`);
    assert(JSON.parse(standaloneAllowed.stdout).kind === 'owned-repository', 'the CLI resolves the separate owned-repository kind');
    const openPr = JSON.stringify({ operation: 'openPr', capability: 'openPr', readOnly: false, resolved: true, base: { branch: 'main' }, head: { branch: 'feat/x' } });
    const standalonePr = runResolver(['simpsonm09', ...common, ...standalone, '--intent', openPr]);
    assert(standalonePr.status === EXIT.OK, `a same-repository pull request exits ${EXIT.OK}, got ${standalonePr.status}`);
    const qualifiedStandalonePr = JSON.stringify({ operation: 'openPr', capability: 'openPr', readOnly: false, resolved: true, base: { owner: 'SIMPSONM09', repo: 'SIMPSONM09', branch: 'main' }, head: { owner: 'simpsonm09', repo: 'SIMPSONM09', branch: 'feat/x' } });
    const qualifiedPr = runResolver(['simpsonm09', ...common, ...standalone, '--intent', qualifiedStandalonePr]);
    assert(qualifiedPr.status === EXIT.OK, `a case-insensitive full-identity pull request exits ${EXIT.OK}, got ${qualifiedPr.status}`);

    const standaloneDenied = [
      ['default branch push', intent({ refs: [{ kind: 'branch', name: 'main', isDefault: true }] })],
      ['force push', intent({ force: true })],
      ['deletion', intent({ delete: true })],
      ['tag push', intent({ refs: [{ kind: 'tag', name: 'v1', isDefault: false }] })],
      ['repo-only pull request base', JSON.stringify({ operation: 'openPr', capability: 'openPr', readOnly: false, resolved: true, base: { repo: 'other', branch: 'main' } })],
      ['repo-only pull request head', JSON.stringify({ operation: 'openPr', capability: 'openPr', readOnly: false, resolved: true, head: { repo: 'other', branch: 'feat/x' } })],
      ['owner-only pull request base', JSON.stringify({ operation: 'openPr', capability: 'openPr', readOnly: false, resolved: true, base: { owner: 'simpsonm09', branch: 'main' } })],
      ['partial null pull request base', JSON.stringify({ operation: 'openPr', capability: 'openPr', readOnly: false, resolved: true, base: { owner: null, repo: 'simpsonm09', branch: 'main' } })],
      ['empty pull request head identity', JSON.stringify({ operation: 'openPr', capability: 'openPr', readOnly: false, resolved: true, head: { owner: '', repo: '', branch: 'feat/x' } })],
      ['cross-repository pull request', JSON.stringify({ operation: 'openPr', capability: 'openPr', readOnly: false, resolved: true, base: { owner: 'acme', repo: 'other', branch: 'main' } })],
      ['merge', JSON.stringify({ operation: 'mergePr', capability: 'mergePr', readOnly: false, resolved: true })],
      ['administration', JSON.stringify({ operation: 'admin', capability: 'admin', readOnly: false, resolved: true })],
    ];
    for (const [name, policyIntent] of standaloneDenied) {
      const result = runResolver(['simpsonm09', ...common, ...standalone, '--intent', policyIntent]);
      assert(result.status === EXIT.FAIL, `an owned repository denies ${name}, got ${result.status}`);
    }

    const tag = { capability: 'pushMain', refs: [{ kind: 'tag', name: 'v1', isDefault: false }] };
    const tagPush = runResolver(['fixture-owned', ...common, ...destination, '--intent', intent(tag)]);
    assert(tagPush.status === EXIT.FAIL, `an owned-fork tag push exits ${EXIT.FAIL}, got ${tagPush.status}`);

    const defaultBranch = { refs: [{ kind: 'branch', name: 'main', isDefault: true }] };
    const mainPush = runResolver(['fixture-owned', ...common, ...destination, '--intent', intent(defaultBranch)]);
    assert(mainPush.status === EXIT.FAIL, `an owned-fork default-branch push exits ${EXIT.FAIL}, got ${mainPush.status}`);

    const forkPush = runResolver(['simpsonm09-fixture-nest', ...common, '--destination', 'simpsonm09/simpsonm09-fixture-nest', '--intent', intent()]);
    assert(forkPush.status === EXIT.OK, `a personal push fork follows the org level (${forkPush.stderr.trim()})`);
    const readFork = runResolver(['simpsonm09-fixture-dotnet', ...common, '--destination', 'simpsonm09/simpsonm09-fixture-dotnet', '--intent', intent()]);
    assert(readFork.status === EXIT.FAIL, `a read repository denies a fork push, got ${readFork.status}`);

    const upstream = runResolver(['fixture-owned', ...common, '--destination', OWNED_ENTRY.upstream, '--intent', intent()]);
    assert(upstream.status === EXIT.FAIL, `a third-party upstream exits ${EXIT.FAIL}, got ${upstream.status}`);

    const readOnly = JSON.stringify({ operation: 'read', capability: null, readOnly: true, resolved: true });
    const read = runResolver(['fixture-owned', ...common, '--destination', 'acme/other', '--intent', readOnly]);
    assert(read.status === EXIT.OK, `an unknown destination allows a read, got ${read.status}`);

    const unqualifiedIntent = JSON.stringify({ operation: 'unknown', capability: null, readOnly: false, resolved: true });
    const unqualified = runResolver(['fixture-owned', ...common, '--destination', 'acme/other', '--intent', unqualifiedIntent]);
    assert(unqualified.status === EXIT.FAIL, `an unknown destination denies an unqualified command, got ${unqualified.status}`);

    const inconsistentIntent = JSON.stringify({ operation: 'push', capability: null, readOnly: true, resolved: true });
    const inconsistent = runResolver(['fixture-owned', ...common, ...destination, '--intent', inconsistentIntent, '--json']);
    assert(inconsistent.status === EXIT.FAIL, `a push with no capability exits ${EXIT.FAIL}, got ${inconsistent.status}`);
    const inconsistentReport = JSON.parse(inconsistent.stdout);
    assert(inconsistentReport.allowed === false, 'the destination JSON denies the inconsistent intent');
    assert(inconsistentReport.reason === 'the operation and the capability disagree about writing', `the destination JSON names the mismatch, got ${JSON.stringify(inconsistentReport.reason)}`);

    const usages = [
      ['a missing host', ['fixture-owned', '--destination', OWNED_ENTRY.repository, '--intent', intent()]],
      ['a malformed intent', ['fixture-owned', ...common, ...destination, '--intent', '{']],
      ['an unknown intent field', ['fixture-owned', ...common, ...destination, '--intent', intent({ operation_note: 'x' })]],
      ['an unknown capability', ['fixture-owned', ...common, ...destination, '--intent', intent({ capability: 'nope' })]],
      ['an invalid ref kind', ['fixture-owned', ...common, ...destination, '--intent', intent({ refs: [{ kind: 'nope', name: 'x', isDefault: false }] })]],
      ['an unreadable committed catalog', ['fixture-owned', '--catalog-dir', join(dir, 'missing'), '--host', 'github.com', ...destination, '--intent', intent()]],
    ];
    for (const [name, argv] of usages) {
      const result = runResolver(argv);
      assert(result.status === EXIT.USAGE, `${name} exits ${EXIT.USAGE}, got ${result.status} (${result.stderr.trim()})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The organization plugin bundles this resolver and matches the ROOT literal to
// find the catalog. A second declaration would change which directory the bundle
// reads, so exactly one must remain.
function testRootLiteral(assert) {
  const declarations = readFileSync(RESOLVER, 'utf8').match(/\bconst ROOT = /g) ?? [];
  assert(declarations.length === 1, `the resolver declares ROOT exactly once, found ${declarations.length}`);
}

// Run the suite and return an exit code, so the runner (verify.mjs) and the CLI
// share one path. It never calls process.exit, so an import cannot end the caller.
export function runTest() {
  const { assert, total } = makeAsserter();
  try {
    testDecisionLayer(assert);
    testMethodClassifier(assert);
    testPushClassifier(assert);
    testApiBodyClassifier(assert);
    testGhFallbackClassifier(assert);
    testDestinationPolicy(assert);
    testCommittedOwnedForks(assert);
    testCommittedOwnedRepositories(assert);
    testHook(assert);
    testCli(assert);
    testDestinationCli(assert);
    testRootLiteral(assert);
    process.stdout.write(`agent-access.test: ok (${total()} assertions)\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`agent-access.test: failed: ${error.message}\n`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exit(runTest());

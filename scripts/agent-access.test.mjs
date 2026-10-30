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
  FORBIDDEN_CAPABILITY,
  LEVELS,
  allows,
  classify,
  decide,
  decideTarget,
  loadCatalog,
  loadCommittedIgnore,
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
const EMPTY_IGNORE = { ignore: [] };
const POLICY_IGNORE = {
  ignore: [
    {
      name: 'pdf_field_automation_acrobat', reason: 'fixture',
      agentAccessIgnore: ['simpsonm09-org/pdf_field_automation_acrobat', 'simpsonm09/pdf_field_automation_acrobat'],
    },
    {
      name: 'steam_wishlist_cleanup', reason: 'fixture',
      agentAccessIgnore: ['simpsonm09-org/steam_wishlist_cleanup', 'simpsonm09/steam_wishlist_cleanup'],
    },
    {
      name: 'The_Gaming_Index_Video_Game_Database_Final_Capstone', reason: 'fixture',
      agentAccessIgnore: [
        'simpsonm09-org/The_Gaming_Index_Video_Game_Database_Final_Capstone',
        'simpsonm09/The_Gaming_Index_Video_Game_Database_Final_Capstone',
      ],
    },
  ],
};

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
  assert(JSON.stringify(LEVELS) === JSON.stringify(['propose', 'merge', 'full']), 'only propose, merge, and full are selectable levels');
  const catalog = loadCatalog(FIXTURE_CATALOG);
  testFixtureLevels(assert, catalog);
  testTierDefaults(assert);
  testInvalidLevels(assert);
}

function testFixtureLevels(assert, catalog) {
  for (const { repo, level } of FIXTURES) {
    const resolved = resolveLevel(catalog, repo);
    assert(resolved.level === level, `${repo} resolves to ${level}, got ${resolved.level}`);
    assert(resolved.source === (level === 'read' ? 'invalid-override' : 'override'), `${repo} resolves from its valid override or the internal read baseline`);
    for (const entry of COMMANDS) assertFixtureCommand(assert, repo, level, entry);
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

function assertFixtureCommand(assert, repo, level, { command, capability }) {
  const allowed = decide(level, command).allowed;
  const expected = capability === null ? true : EXPECTED[level][capability];
  assert(allowed === expected, `${repo} (${level}) ${allowed ? 'allows' : 'denies'} ${JSON.stringify(command)} (${capability}), expected ${expected}`);
}

function testTierDefaults(assert) {
  const tierNames = ['standard', 'template', 'catalog', 'plugin', 'tooling', 'feature', 'fixture', 'legacy'];
  const fullDefaults = {
    agentAccessDefaults: Object.fromEntries(tierNames.map((tier) => [tier, 'full'])),
    repos: tierNames.map((tier) => ({ name: `default-${tier}`, tier })),
  };
  for (const tier of tierNames) {
    const resolved = resolveLevel(fullDefaults, `default-${tier}`);
    assert(resolved.level === 'full' && resolved.source === 'tier', `the ${tier} tier honors its full default`);
  }
}

function testInvalidLevels(assert) {
  for (const invalidLevel of ['none', 'read', 'admin', '', null]) {
    const invalid = resolveLevel({ repos: [{ name: 'invalid', tier: 'legacy', agentAccess: invalidLevel }] }, 'invalid');
    assert(invalid.level === 'read' && invalid.source === 'invalid-override', `non-selectable ${JSON.stringify(invalidLevel)} resolves to the internal read baseline`);
  }
  const invalidDefault = resolveLevel({ agentAccessDefaults: { legacy: 'read' }, repos: [{ name: 'invalid-default', tier: 'legacy' }] }, 'invalid-default');
  assert(invalidDefault.level === 'read' && invalidDefault.source === 'tier-fallback', 'a non-selectable tier default resolves to the internal read baseline');
  assert(allows('constructor', 'read') === false && allows('toString', 'read') === false, 'prototype names do not resolve to capabilities');
  assert(decide('constructor', 'gh pr create --title x').allowed === false, 'decide denies prototype-named levels without throwing');
  assert(decideTarget({ kind: 'org', level: 'toString' }, { operation: 'openPr', capability: 'openPr', resolved: true }).allowed === false, 'decideTarget denies prototype-named levels without throwing');
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
    ['git push origin --prune refs/heads/*:refs/heads/*', FORBIDDEN_CAPABILITY],
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
    ['gh issue create --title "--help"', 'openPr'],
    ['gh pr edit 52 --title "--help"', 'openPr'],
    ['gh issue create --title -h', 'openPr'],
    ['gh pr close 52', 'openPr'],
    ['gh pr reopen 52', 'openPr'],
    ['gh pr ready 52', 'openPr'],
    ['gh pr comment 52 --body x', 'openPr'],
    ['gh pr edit 52 --add-reviewer teammate --add-assignee teammate --add-label bug', 'openPr'],
    ['gh pr create --title --milestone', 'openPr'],
    ['gh pr edit 52 --body -m', 'openPr'],
    ['gh pr edit 52 --title "--remove-milestone"', 'openPr'],
    ['gh pr review 52 --comment --body x', 'openPr'],
    ['gh pr review 52 --request-changes --body x', 'openPr'],
    ['gh pr review 52 --body --approve', 'openPr'],
    ['gh pr merge 52 --subject --admin', FORBIDDEN_CAPABILITY],
    ['gh pr create --milestone v1 --title x', 'admin'],
    ['gh pr edit 52 -m v1', 'admin'],
    ['gh issue create --milestone v1 --title x', 'admin'],
    ['gh issue create -m v1 --title x', 'admin'],
    ['gh pr review 52 --approve', FORBIDDEN_CAPABILITY],
    ['gh pr review 52 -a', FORBIDDEN_CAPABILITY],
    ['gh pr review 52 --approve=true', FORBIDDEN_CAPABILITY],
    ['gh pr review 52 --dismiss', FORBIDDEN_CAPABILITY],
    ['gh pr review 52 --dismiss=true', FORBIDDEN_CAPABILITY],
    ['gh pr review 52 --app""rove', FORBIDDEN_CAPABILITY],
    ['gh pr review 52 --body "--approve"', 'openPr'],
    ['gh pr review 52 --request-changes --mystery', FORBIDDEN_CAPABILITY],
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
    ['gh constructor pr', 'admin'],
    ['gh toString create', 'admin'],
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
  assert(decide('propose', 'gh pr edit 52 --title x').allowed === true, 'propose permits ordinary PR management');
  assert(decide('propose', 'gh issue create --title x').allowed === true, 'propose permits issue creation');
  assert(decide('merge', 'gh pr create --milestone v1 --title x').allowed === false, 'milestone operands require full');
  assert(decide('full', 'gh pr create --milestone v1 --title x').allowed === true, 'full permits milestone operands');
  assert(decide('full', 'gh pr review 52 --approve').allowed === false, 'command authorization denies PR self-approval even at full');
  assert(decide('full', 'gh pr review 52 -a').allowed === false, 'short approval alias is denied at full');
  assert(decide('full', 'gh pr review 52 --app""rove').allowed === false, 'quoted flag concatenation is normalized and denied at full');
  assert(decide('full', 'gh pr review 52 --body "--approve"').allowed === true, 'quoted body text remains an operand, not an approval flag');
  assert(decide('full', 'gh pr review 52 --request-changes --mystery').allowed === false, 'unknown review flags are denied even at full');
  assert(decide('propose', 'gh pr edit 52 --remove-milestone').allowed === false, 'milestone removal requires admin');
  assert(decide('full', 'gh pr edit 52 --remove-milestone').allowed === true, 'full retains milestone removal');
  assert(decide('full', 'gh pr merge 52 --admin').allowed === false, 'command authorization denies admin merge bypass even at full');
  assert(classify('gh pr merge 52 --admin') === FORBIDDEN_CAPABILITY, 'admin merge has a never-granted classification');
  assert(classify('gh pr merge 52 --subject "--admin"') === FORBIDDEN_CAPABILITY, 'an exact admin-looking subject value is conservatively denied');
  assert(decide('full', 'gh pr review 52 --approve').capability === FORBIDDEN_CAPABILITY, 'approval denial exposes the forbidden classification');
  assert(classify('gh pr review 52 --approve"') === FORBIDDEN_CAPABILITY, 'malformed review quoting fails closed');
  assert(classify('gh api -X POST repos/simpsonm09-org/demo/pulls/52/reviews') === FORBIDDEN_CAPABILITY, 'REST review creation is forbidden');
  assert(classify('gh api -X POST https://api.github.com/repos/simpsonm09-org/demo/pulls/52/reviews') === FORBIDDEN_CAPABILITY, 'absolute REST review URLs are forbidden');
  assert(classify('gh api -X PATCH repos/simpsonm09-org/demo/pulls/52/reviews/9') === FORBIDDEN_CAPABILITY, 'REST review submission is forbidden');
  assert(classify('gh api --method PUT repos/simpsonm09-org/demo/pulls/52/reviews/9/dismissals') === FORBIDDEN_CAPABILITY, 'REST review dismissal is forbidden');
  assert(classify('gh api -X POST repos/o/r/issues -f title=repos/o/r/pulls/52/reviews') === 'admin', 'review-like body values do not change the API endpoint classification');
  assert(classify("gh api graphql -f query='mutation { submitPullRequestReview(input: $input) { clientMutationId } }'") === FORBIDDEN_CAPABILITY, 'GraphQL review submission is forbidden');
  assert(classify('gh api graphql -f query=@review.graphql') === FORBIDDEN_CAPABILITY, 'opaque GraphQL source files fail closed');
  assert(classify("gh api graphql -f query='mutation { updateIssue(input: $input) { issue { id } } }'") === 'admin', 'unrelated GraphQL admin mutations retain admin classification');
  assert(decide('full', 'gh api -X POST repos/simpsonm09-org/demo/pulls/52/reviews').allowed === false, 'REST review creation denies even at full');
  assert(decide('full', "gh api graphql -f query='mutation { submitPullRequestReview(input: $input) { clientMutationId } }'").allowed === false, 'GraphQL review submission denies even at full');
  assert(decide('full', 'gh pr merge 52 --subject --admin').allowed === false, 'an exact admin-looking operand is conservatively denied');
  assert(decide('none', 'gh auth token').allowed === false, 'auth token needs admin');
  assert(decide('read', 'gh auth status --show-token').allowed === false, 'token-bearing auth status needs admin');
  assert(decide('none', 'gh -h issue create --title x').allowed === false, 'help before a write verb needs admin');
  assert(decide('read', 'gh api -X FROB repos/o/r').allowed === false, 'unknown API method is not a read');
}

function testSimpleCommandBoundary(assert) {
  const reviewRoutes = [
    'repos/simpsonm09-org/demo/pulls/52/reviews',
    'repos/simpsonm09-org/demo/pulls/52/reviews/9/events',
    'repos/simpsonm09-org/demo/pulls/52/reviews/9/dismissals?x=1',
    'https://api.github.com/repos/simpsonm09-org/demo/pulls/52/reviews/9/events?x=1',
  ];
  for (const route of reviewRoutes) {
    const command = `gh api -X POST ${route} -f event=APPROVE`;
    assert(classify(command) === FORBIDDEN_CAPABILITY, `REST review route is forbidden: ${route}`);
    assert(decide('full', command).allowed === false, `REST review route denies at full: ${route}`);
  }
  for (const prefix of ['--hostname github.com', '-H "Accept: application/json"', '-q .name', '--paginate']) {
    const command = `gh api ${prefix} -X POST repos/o/r/pulls/52/reviews -f event=APPROVE`;
    assert(classify(command) === FORBIDDEN_CAPABILITY, `an option or option value cannot hide a REST review route: ${prefix}`);
    assert(decide('full', command).allowed === false, `hidden REST review route denies at full: ${prefix}`);
  }
  const graphql = "gh api --hostname github.com graphql -f query='mutation { submitPullRequestReview(input: $input) { clientMutationId } }'";
  assert(classify(graphql) === FORBIDDEN_CAPABILITY && decide('full', graphql).allowed === false, 'an option cannot hide a GraphQL review mutation endpoint');
  const unrelatedGraphql = "gh api --hostname github.com graphql -f query='mutation { updateIssue(input: $input) { issue { id } } }'";
  assert(classify(unrelatedGraphql) === 'admin' && decide('full', unrelatedGraphql).allowed === true, 'unrelated GraphQL writes retain broad admin capability');
  const bodyRoute = 'gh api -X POST repos/o/r/issues -f title repos/o/r/pulls/52/reviews';
  assert(classify(bodyRoute) === FORBIDDEN_CAPABILITY && decide('full', bodyRoute).allowed === false, 'an exact route-shaped body value is conservatively forbidden');

  const ambiguousReviewRoutes = [
    'gh api -X POST //repos/simpsonm09-org/demo/pulls/52/reviews -f event=APPROVE',
    'gh api -X POST repos/simpsonm09-org/demo/issues/1/../../pulls/52/reviews -f event=APPROVE',
    "gh api -X POST 'repos/simpsonm09-org/demo/pulls/52/%72eviews/9/events' -f event=APPROVE",
    "gh api //graphql -f query='mutation { addPullRequestReview(input: $input) { id } }'",
  ];
  for (const command of ambiguousReviewRoutes) {
    assert(classify(command) === FORBIDDEN_CAPABILITY, `ambiguous review API endpoint is conservatively forbidden: ${command}`);
    assert(decide('full', command).allowed === false, `ambiguous review API endpoint denies at full: ${command}`);
  }
  testNoncanonicalReviewApi(assert);

  const governedExecutableNames = [
    '\\gh pr review 52 --approve',
    'g\\h pr review 52 --approve',
    "$'gh' pr review 52 --approve",
    '$ANSI pr review 52 --approve',
    'GH pr review 52 --approve',
    'gh.exe pr review 52 --approve',
    '/usr/bin/gh pr review 52 --approve',
    '"C:\\Program Files\\GitHub CLI\\gh.exe" pr review 52 --approve',
  ];
  for (const command of governedExecutableNames) {
    assert(classify(command) === FORBIDDEN_CAPABILITY, `governed executable spelling is normalized or rejected: ${command}`);
    assert(decide('propose', command).allowed === false, `governed executable spelling denies at propose: ${command}`);
  }
  assert(classify('Git push origin main') === 'pushMain', 'case-insensitive git executable names are normalized');
  assert(classify('GIT.EXE push origin main') === 'pushMain', 'git.exe is normalized before push classification');
  assert(classify('\\git push origin main') === FORBIDDEN_CAPABILITY, 'escaped git executable is forbidden before classification');
  assert(classify('notgh.exe pr review 52 --approve') === null, 'an unrelated executable suffix is not normalized to gh');
  testShellBoundaryFixes(assert);

  for (const command of [
    "gh pr create --title 'Fix 100% coverage' --body 'a ^ b!'",
    'gh pr comment 52 --body "Looks good! 100% ^"',
    "gh pr create --body 'Quoted punctuation: ( ) < > ; & |'",
  ]) {
    assert(classify(command) === 'openPr', `percent, caret, and exclamation in quoted PR data remain literal: ${command}`);
    assert(decide('propose', command).allowed === true, `quoted PR data remains allowed at propose: ${command}`);
  }
  assert(classify("git commit -m 'don'\\''t'") === null, 'Bash apostrophe escape in a local commit message is valid ordinary data');
  assert(classify('git commit -m "it\\"s"') === null, 'escaped quote in a local commit message is valid ordinary data');

  const unsupported = [
    ['gh pr review 52 \\-a', 'propose'],
    ['gh api \\-X POST repos/o/r/pulls/52/reviews -f event=APPROVE', 'full'],
    ["gh pr review 52 $'--approve'", 'full'],
    ['gh pr review 52 {--approve,}', 'propose'],
    ['gh pr review 52 --body "$HOME"', 'full'],
    ['gh pr review 52 --body "price\\$HOME"', 'full'],
    ['gh pr create --body C:\\temp', 'propose'],
    ['git push origin refs/tags/v1*', 'propose'],
  ];
  for (const [command, level] of unsupported) {
    assert(classify(command) === FORBIDDEN_CAPABILITY, `unsupported expansion or escape is forbidden: ${JSON.stringify(command)}`);
    assert(decide(level, command).allowed === false, `unsupported syntax denies at ${level}: ${JSON.stringify(command)}`);
  }
  const literal = "gh pr review 52 --body '$HOME C:\\temp'";
  assert(classify(literal) === 'openPr' && decide('propose', literal).allowed === true, 'single-quoted body text and Windows path data stay literal');

  const malformed = ["git push origin HEAD:refs/tags/v1'", `git push origin HEAD:refs/tags/v1${String.fromCharCode(92)}'`];
  for (const command of malformed) {
    assert(classify(command) === FORBIDDEN_CAPABILITY, `malformed non-gh command is forbidden: ${JSON.stringify(command)}`);
    assert(decide('propose', command).allowed === false, `malformed tag push denies at propose: ${JSON.stringify(command)}`);
  }
  const adminMerge = 'gh pr merge 52 -s --admin';
  assert(classify(adminMerge) === FORBIDDEN_CAPABILITY && decide('full', adminMerge).allowed === false, 'a bare admin merge flag cannot hide after -s');
  const invalidIgnore = resolveDestination({ host: 'github.com', ignore: null, destination: 'simpsonm09-org/demo/' });
  assert(invalidIgnore.source === 'ignore-unavailable', 'ignore trust is checked before malformed destination parsing');
  assert(decideTarget(invalidIgnore, { operation: 'read', capability: 'read', readOnly: true }).allowed === false, 'invalid ignore policy denies malformed-destination reads');
}

function testNoncanonicalReviewApi(assert) {
  const noncanonicalReviewUrls = [
    'gh api -X POST repos/simpsonm09-org/demo//pulls/52/reviews -f event=APPROVE',
    'gh api -X POST https://api.github.com/repos/simpsonm09-org/demo//pulls/52/reviews -f event=APPROVE',
    'gh api -X POST https://api.github.com:443/repos/simpsonm09-org/demo/pulls/52/reviews -f event=APPROVE',
    'gh api -X POST https://api.github.com./repos/simpsonm09-org/demo/pulls/52/reviews -f event=APPROVE',
    'gh api -X POST http://api.github.com/repos/simpsonm09-org/demo/pulls/52/reviews -f event=APPROVE',
    'gh api -X POST https://user@api.github.com/repos/simpsonm09-org/demo/pulls/52/reviews -f event=APPROVE',
    "gh api -X POST https://api.github.com:443/graphql -f query='mutation { addPullRequestReview(input:{}) { clientMutationId } }'",
    'gh api -X POST ./repos/o/r/pulls/52/reviews -f event=APPROVE',
    'gh api -X POST ../repos/o/r/pulls/52/reviews -f event=APPROVE',
    'gh api -X POST %72epos/o/r/pulls/52/reviews -f event=APPROVE',
    'gh api -X POST repos%2Fo%2Fr%2Fpulls%2F52%2Freviews -f event=APPROVE',
  ];
  for (const command of noncanonicalReviewUrls) {
    assert(classify(command) === FORBIDDEN_CAPABILITY && decide('full', command).allowed === false, `noncanonical review API URL is forbidden at full: ${command}`);
  }
  for (const command of [
    'gh api -X POST https://api.github.com/repos/o/r/issues -f title=x',
    'gh api -X POST repos/o/r/issues -f body=/repos/o/r/pulls/1/reviews',
    'gh api -X POST repos/o/r/issues -f body=100%',
  ]) assert(classify(command) === 'admin', `non-review API write retains admin classification: ${command}`);
  assert(decide('full', 'gh api -X POST repos/o/r/issues -f body=100%').allowed === true, 'ordinary percent API body value remains allowed at full');

  for (const command of [
    'gh api -X POST repos/o/r/issues --input ./body.json',
    'gh api -X POST repos/o/r/issues --input ../body.json',
  ]) {
    assert(classify(command) === FORBIDDEN_CAPABILITY, `dot-prefixed API flag value is conservatively forbidden: ${command}`);
    for (const level of LEVELS) {
      assert(decide(level, command).allowed === false, `dot-prefixed API flag value denies at ${level}: ${command}`);
    }
  }
}

function testShellBoundaryFixes(assert) {
  for (const command of [
    '(gh pr merge 52 --admin)',
    '(gh pr review 52 --approve)',
    '<(gh pr review 52 --approve)',
    '! gh pr merge 52 --admin',
    'time gh pr merge 52 --admin',
  ]) assert(classify(command) === FORBIDDEN_CAPABILITY && decide('full', command).allowed === false, `grouping or keyword prefix cannot hide a governed command: ${command}`);
  assert(classify('time npm test') === FORBIDDEN_CAPABILITY && decide('none', 'time npm test').allowed === false, 'time keyword is conservatively forbidden at every level');
  assert(classify('! grep x') === FORBIDDEN_CAPABILITY && decide('none', '! grep x').allowed === false, 'negation keyword is conservatively forbidden at every level');
  assert(classify('echo <(gh pr review 52 --approve)') === null, 'nested command substitution remains outside the bounded tokenizer');
  for (const command of [
    'gh pr merge 52 --admin;',
    'gh pr merge 52 --admin&',
    'gh pr merge 52 --admin|x',
    'gh pr view 1 && gh pr review 1 --approve',
  ]) assert(classify(command) === FORBIDDEN_CAPABILITY, `shell separators are forbidden whether glued or spaced: ${command}`);

}

// Level one, destination half: one policy truth governs the organization
// repository and its personal push fork, the owned fork is a strict subset, and
// an upstream or an unknown destination gets reads only.
function testDestinationPolicy(assert) {
  const roster = loadCatalog(FIXTURE_CATALOG);
  const nest = 'simpsonm09-fixture-nest';
  const dotnet = 'simpsonm09-fixture-dotnet';
  const at = (localRepo, destination, host = 'github.com') =>
    resolveDestination({ roster, ownedForks: OWNED_FORKS, ownedRepositories: OWNED_REPOSITORIES, ignore: EMPTY_IGNORE, localRepo, host, destination });
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
    { name: 'a recorded upstream', local: 'pstack-max', destination: OWNED_ENTRY.upstream, kind: 'upstream', level: 'read', source: 'upstream' },
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
    assert(target.kind === 'unknown' && target.level === 'read', `${name} is unknown and read-only, got ${target.kind}/${target.level}`);
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
  const foreignTarget = resolveDestination({ roster, ownedForks: foreignOnly, ignore: EMPTY_IGNORE, localRepo: 'fixture-owned', host: 'github.com', destination: foreignEntry.repository });
  assert(foreignTarget.kind === 'unknown' && foreignTarget.level === 'read', `a foreign-owner target is unknown and read-only, got ${foreignTarget.kind}/${foreignTarget.level}`);

  const foreignForkPolicy = { forks: [{ repository: `evil/${nest}`, upstream: 'acme/upstream-lib', agentAccess: 'propose' }] };
  const foreignCollapse = resolveDestination({ roster, ownedForks: foreignForkPolicy, ignore: EMPTY_IGNORE, localRepo: nest, host: 'github.com', destination: `evil/${nest}` });
  assert(foreignCollapse.kind === 'unknown' && foreignCollapse.level === 'read', `a foreign owner never collapses to the org level, got ${foreignCollapse.kind}/${foreignCollapse.level}`);

  const mixedOwners = { forks: [OWNED_ENTRY, foreignEntry] };
  assert(resolveOwnedFork(mixedOwners, ...OWNED_ENTRY.repository.split('/')).owned === false, 'a mixed-owner policy grants nothing, not even its valid entry');
  const mixedTarget = resolveDestination({ roster, ownedForks: mixedOwners, ignore: EMPTY_IGNORE, localRepo: 'fixture-owned', host: 'github.com', destination: OWNED_ENTRY.repository });
  assert(mixedTarget.kind === 'unknown' && mixedTarget.level === 'read', `a mixed-owner policy collapses nothing, got ${mixedTarget.kind}/${mixedTarget.level}`);
  const mixedFork = resolveDestination({ roster, ownedForks: mixedOwners, ignore: EMPTY_IGNORE, localRepo: nest, host: 'github.com', destination: `simpsonm09/${nest}` });
  assert(mixedFork.kind === 'unknown', `a mixed-owner policy admits no personal push fork, got ${mixedFork.kind}`);
}

function testClosedDestinations(assert, roster, nest) {
  const closed = [
    { name: 'a personal push fork', local: nest, destination: `simpsonm09/${nest}` },
    { name: 'an owned fork', local: 'pstack-max', destination: OWNED_ENTRY.repository },
  ];
  for (const { name, local, destination } of closed) {
    const target = resolveDestination({ roster, ownedForks: null, ignore: EMPTY_IGNORE, localRepo: local, host: 'github.com', destination });
    assert(target.kind === 'unknown', `${name} fails closed without the owned-fork policy, got ${target.kind}`);
  }
  const noRoster = resolveDestination({ roster: null, ownedForks: OWNED_FORKS, ignore: EMPTY_IGNORE, localRepo: nest, host: 'github.com', destination: `simpsonm09/${nest}` });
  assert(noRoster.kind === 'unknown', 'a missing roster closes the organization and personal-fork kinds');
  const rosterlessOwned = resolveDestination({ roster: null, ownedForks: OWNED_FORKS, ignore: EMPTY_IGNORE, localRepo: 'pstack-max', host: 'github.com', destination: OWNED_ENTRY.repository });
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
  assert(decideTarget(orgPropose, push({ resolved: false })).allowed === false, 'an org branch push denies an unresolved ref');

  const orgFull = at('simpsonm09-fixture-go', 'simpsonm09-org/simpsonm09-fixture-go');
  assert(decideTarget(orgFull, { operation: 'admin', capability: FORBIDDEN_CAPABILITY, readOnly: false, resolved: true }).allowed === false, 'structured consumers cannot grant the forbidden capability at full');
  const mainPush = push({ capability: 'pushMain', refs: [{ kind: 'branch', name: 'main', isDefault: true }] });
  const tagPush = push({ capability: 'pushMain', refs: [{ kind: 'tag', name: 'v1', isDefault: false }] });
  assert(decideTarget(orgFull, mainPush).allowed === true, 'full retains a resolved default-branch push');
  assert(decideTarget(orgFull, tagPush).allowed === true, 'full retains a resolved tag push');
  assert(decideTarget(orgFull, push({ force: true })).allowed === false, 'force pushes stay denied at full');
  assert(decideTarget(orgFull, push({ delete: true })).allowed === false, 'delete pushes stay denied at full');
  assert(decideTarget(orgFull, { ...mainPush, force: true }).allowed === false, 'force default-branch pushes stay denied at full');
  assert(decideTarget(orgFull, { ...mainPush, delete: true }).allowed === false, 'default-branch deletions stay denied at full');
  assert(decideTarget(orgFull, { ...mainPush, resolved: false }).allowed === false, 'unresolved default-branch pushes are denied');
  assert(decideTarget(orgFull, { ...mainPush, refs: [...mainPush.refs, ...mainPush.refs] }).allowed === false, 'multiple protected refspecs are denied');
  const pairedPr = {
    operation: 'openPr', capability: 'openPr', readOnly: false, resolved: true,
    base: { owner: 'simpsonm09-org', repo: 'simpsonm09-fixture-go', branch: 'main' },
    head: { owner: 'simpsonm09', repo: 'simpsonm09-fixture-go', branch: 'feat/x' },
  };
  assert(decideTarget(orgFull, pairedPr).allowed === true, 'an org pull request accepts its paired personal-fork head');
  assert(decideTarget(orgFull, { ...pairedPr, resolved: false }).allowed === false, 'an unresolved organization pull request is denied');
  assert(decideTarget(orgFull, { ...pairedPr, base: { owner: 'acme', repo: 'other' } }).allowed === false, 'an org pull request rejects a foreign base');
  assert(decideTarget(orgFull, { ...pairedPr, head: { owner: 'cursor', repo: 'simpsonm09-fixture-go' } }).allowed === false, 'an org pull request rejects an unpaired head');

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
function makeCatalog({ policy, ownedRepositories, ignore = JSON.stringify({ ignore: [] }), includeOwnedRepositories = true, includeIgnore = true, upstream = true, forge, forgeIgnore } = {}) {
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
  if (includeIgnore) writeFileSync(join(dir, 'ignore.json'), ignore);
  commit('the committed policy');
  if (upstream) git('update-ref', 'refs/remotes/upstream/main', 'HEAD');
  if (forge) {
    const entry = { repository: forge, upstream: OWNED_ENTRY.upstream, agentAccess: 'propose' };
    writeFileSync(join(dir, 'owned-forks.json'), JSON.stringify({ forks: [entry] }));
    commit('a forged local main');
  }
  if (forgeIgnore) {
    writeFileSync(join(dir, 'ignore.json'), forgeIgnore);
    commit('a forged local ignore policy');
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
    const target = resolveDestination({ roster, ownedForks: forgedPolicy, ignore: EMPTY_IGNORE, localRepo: 'pstack-max', host: 'github.com', destination: 'simpsonm09/forged-target' });
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
    const forkWithoutStandalone = resolveDestination({ roster: loadCatalog(FIXTURE_CATALOG), ownedForks: loadCommittedOwnedForks(missing), ownedRepositories: null, ignore: EMPTY_IGNORE, localRepo: 'pstack-max', host: 'github.com', destination: OWNED_ENTRY.repository });
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
    const target = resolveDestination({ roster: loadCatalog(FIXTURE_CATALOG), ownedForks: OWNED_FORKS, ownedRepositories: forged, ignore: EMPTY_IGNORE, localRepo: 'simpsonm09', host: 'github.com', destination: 'simpsonm09/profile-forged' });
    assert(target.kind === 'unknown', 'the forged local identity resolves to unknown');
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
}

function testCommittedIgnore(assert) {
  const valid = makeCatalog({ ignore: JSON.stringify(POLICY_IGNORE) });
  const forged = makeCatalog({ forgeIgnore: JSON.stringify(POLICY_IGNORE) });
  const missing = makeCatalog({ includeIgnore: false });
  const localOnly = makeCatalog({ includeIgnore: false, upstream: false, forgeIgnore: JSON.stringify(POLICY_IGNORE) });
  const malformed = makeCatalog({ ignore: '{' });
  const malformedName = makeCatalog({ ignore: JSON.stringify({ ignore: [{ name: null, reason: 'fixture', agentAccessIgnore: ['simpsonm09-org/steam_wishlist_cleanup'] }] }) });
  const wrongName = makeCatalog({ ignore: JSON.stringify({ ignore: [{ name: 'other', reason: 'fixture', agentAccessIgnore: ['simpsonm09-org/steam_wishlist_cleanup'] }] }) });
  const malformedIdentity = makeCatalog({ ignore: JSON.stringify({ ignore: [{ name: 'steam_wishlist_cleanup', reason: 'fixture', agentAccessIgnore: ['simpson_m09-org/steam_wishlist_cleanup'] }] }) });
  const duplicateIdentity = makeCatalog({ ignore: JSON.stringify({ ignore: [
    { name: 'steam_wishlist_cleanup', reason: 'fixture', agentAccessIgnore: ['simpsonm09-org/steam_wishlist_cleanup', 'SIMPSONM09-ORG/STEAM_WISHLIST_CLEANUP'] },
  ] }) });
  const unknownField = makeCatalog({ ignore: JSON.stringify({ ignore: [], extra: true }) });
  const dirs = [valid, forged, missing, localOnly, malformed, malformedName, wrongName, malformedIdentity, duplicateIdentity, unknownField];
  try {
    const loaded = loadCommittedIgnore(valid);
    assert(loaded?.ignore?.length === 3, 'the loader reads all three committed ignore entries');
    assert(loaded.ignore.reduce((count, entry) => count + entry.agentAccessIgnore.length, 0) === 6, 'the committed policy holds six exact identities');
    assert(loadCommittedIgnore(missing) === null, 'a missing committed ignore file fails closed');
    assert(loadCommittedIgnore(forged)?.ignore?.length === 0, 'a writable local main ignore edit cannot replace upstream/main');
    assert(loadCommittedIgnore(localOnly) === null, 'a local main ignore file cannot replace missing upstream/main');
    assert(loadCommittedIgnore(malformed) === null, 'malformed committed ignore JSON fails closed');
    assert(loadCommittedIgnore(malformedName) === null, 'a malformed ignore entry name fails closed without throwing');
    assert(loadCommittedIgnore(wrongName) === null, 'an ignored identity must match its entry name');
    assert(loadCommittedIgnore(malformedIdentity) === null, 'a malformed owner/repository identity fails closed');
    assert(loadCommittedIgnore(duplicateIdentity) === null, 'duplicate identities fail closed case-insensitively');
    assert(loadCommittedIgnore(unknownField) === null, 'an unknown ignore schema field fails closed');

    const roster = loadCatalog(FIXTURE_CATALOG);
    const ownedForks = OWNED_FORKS;
    const missingPolicy = resolveDestination({ roster, ownedForks, localRepo: 'simpsonm09-fixture-go', host: 'github.com', destination: 'simpsonm09-org/simpsonm09-fixture-go' });
    assert(missingPolicy.kind === 'unknown' && missingPolicy.source === 'ignore-unavailable', 'destination resolution fails closed without a validated ignore policy');
    for (const intent of [
      { operation: 'read', capability: 'read', readOnly: true, resolved: true },
      { operation: 'read', capability: null, readOnly: true, resolved: true },
      { operation: 'push', capability: 'pushBranch', readOnly: false, resolved: true, refs: [{ kind: 'branch', name: 'feat/x', isDefault: false }] },
    ]) assert(decideTarget(missingPolicy, intent).allowed === false, 'an unavailable ignore policy denies reads, null capabilities, and writes');
    assert(decideTarget({ kind: 'org', level: 'full', source: 'ignore-unavailable' }, { operation: 'read', capability: null, readOnly: true }).allowed === false, 'ignore unavailability is denied before null-capability handling');
    const ignored = resolveDestination({ roster, ownedForks, ignore: loaded, localRepo: 'steam_wishlist_cleanup', host: 'github.com', destination: 'SIMPSONM09-ORG/STEAM_WISHLIST_CLEANUP' });
    assert(ignored.kind === 'ignored' && ignored.level === 'read' && ignored.source === 'ignore', 'exact identity matches ignore case-insensitively before roster resolution');
    for (const intent of [
      { operation: 'read', capability: 'read', readOnly: true, resolved: true },
      { operation: 'read', capability: null, readOnly: true, resolved: true },
      { operation: 'unknown', capability: null, readOnly: false, resolved: true },
      { operation: 'admin', capability: 'admin', readOnly: false, resolved: true },
    ]) assert(decideTarget(ignored, intent).allowed === false, 'an ignored identity is denied before read and null-capability handling');
    const sameNameOtherOwner = resolveDestination({ roster, ownedForks, ignore: loaded, localRepo: 'steam_wishlist_cleanup', host: 'github.com', destination: 'acme/steam_wishlist_cleanup' });
    assert(sameNameOtherOwner.kind === 'unknown', 'a same-name destination under another owner is not ignored or widened');
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
  const broadAdmin = runResolver(['simpsonm09-fixture-go', '--catalog', FIXTURE_CATALOG, '--allows', 'admin']);
  assert(broadAdmin.status === EXIT.OK, 'the public --allows interface preserves full admin capability');

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
  const approval = runResolver([
    'simpsonm09-fixture-go', '--catalog', FIXTURE_CATALOG, '--command', 'gh pr review 52 --approve', '--json',
  ]);
  assert(approval.status === EXIT.FAIL, 'the public --command interface denies PR approval even when full has admin');
  const approvalDecision = JSON.parse(approval.stdout);
  assert(approvalDecision.allowed === false && approvalDecision.capability === FORBIDDEN_CAPABILITY, 'the --command response preserves the forbidden classification and denial');

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
  const missingIgnore = makeCatalog({ includeIgnore: false });
  const malformedIgnore = makeCatalog({ ignore: '{' });
  const ignoredDir = makeCatalog({ ignore: JSON.stringify(POLICY_IGNORE) });
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

    const ignored = runResolver([
      'simpsonm09-fixture-go', '--catalog-dir', ignoredDir, '--host', 'github.com',
      '--destination', 'simpsonm09-org/steam_wishlist_cleanup',
      '--intent', JSON.stringify({ operation: 'read', capability: null, readOnly: true, resolved: true }), '--json',
    ]);
    assert(ignored.status === EXIT.FAIL, 'destination CLI denies an ignored repository before a null-capability read');
    assert(JSON.parse(ignored.stdout).kind === 'ignored', 'the CLI reports the ignored destination kind');

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
      ['an unreadable committed ignore policy', ['fixture-owned', '--catalog-dir', missingIgnore, '--host', 'github.com', ...destination, '--intent', intent()]],
      ['a malformed committed ignore policy', ['fixture-owned', '--catalog-dir', malformedIgnore, '--host', 'github.com', ...destination, '--intent', intent()]],
    ];
    for (const [name, argv] of usages) {
      const result = runResolver(argv);
      assert(result.status === EXIT.USAGE, `${name} exits ${EXIT.USAGE}, got ${result.status} (${result.stderr.trim()})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(missingIgnore, { recursive: true, force: true });
    rmSync(malformedIgnore, { recursive: true, force: true });
    rmSync(ignoredDir, { recursive: true, force: true });
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
    testSimpleCommandBoundary(assert);
    testDestinationPolicy(assert);
    testCommittedOwnedForks(assert);
    testCommittedOwnedRepositories(assert);
    testCommittedIgnore(assert);
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

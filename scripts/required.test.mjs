#!/usr/bin/env node
// Prove the required-check rules. A covered repository has a coverage job and
// requires coverage / coverage. An uncovered repository has no coverage job, because
// its exception on ci/coverage says why. Every required check has a job that reports
// it. Each rule gets a violating case that must report its named gap and a compliant
// case that must report nothing. The live ruleset is a fixture, so no API is called.
// The CLI cases run check-repo over throwaway repositories and read the committed
// exception file for the two uncovered repositories.
//
// Usage:
//   node --test scripts/required.test.mjs
//
// Exits 0 when every assertion holds and 1 on the first failure.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStandard } from './check-standard.mjs';
import { jobsCalling, parseJobs } from './lib/ci.mjs';
import { loadExceptions } from './lib/exceptions.mjs';
import { isMain } from './lib/proc.mjs';
import { ALL_CHECKS_REQUIRED, COVERAGE_CONTEXT, expectedChecks, kindOf, protectMainSelection, requiredGaps, rulesetGaps, uncoveredCallGaps } from './lib/required.mjs';

const CHECK_REPO = fileURLToPath(new URL('./check-repo.mjs', import.meta.url));
const EXCEPTIONS = fileURLToPath(new URL('../docs/exceptions.json', import.meta.url));
const STANDARD_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PIN = 'a'.repeat(40);
const UNCOVERED_REPO = 'simpsonm09-org/simpsonm09-repo-catalog';
const COVERED_REPO = 'simpsonm09-org/simpsonm09-fixture-go';
const SHARED_JOBS = ['lint', 'aislop', 'security', 'standard'];
const BASE_LIVE = ['lint / flint', 'aislop / aislop', 'security / trivy', 'security / secrets', 'standard / standard', 'test'];

function makeAsserter() {
  let count = 0;
  const assert = (condition, message) => {
    count += 1;
    if (!condition) throw new Error(message);
  };
  return { assert, total: () => count };
}

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'required-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const sharedUses = (name) => `simpsonm09-org/simpsonm09-repo-standard/.github/workflows/${name}.yml@${PIN}`;

// A ci.yml with the four shared jobs, a plain test job, and any extras. Each option
// changes one job so a case names the one thing it tests.
function ciText({ coverage = null, omit = [], testSuffixes = [] } = {}) {
  const blocks = SHARED_JOBS.filter((name) => !omit.includes(name)).map((name) => `  ${name}:\n    uses: ${sharedUses(name)}`);
  if (coverage !== null) blocks.push(`  coverage:\n    uses: ${coverage}`);
  if (!omit.includes('test')) blocks.push('  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: just test');
  for (const suffix of testSuffixes) blocks.push(`  test-${suffix}:\n    runs-on: windows-latest\n    steps:\n      - run: just test`);
  return ['name: ci', 'on:', '  pull_request:', 'jobs:', ...blocks, ''].join('\n');
}

const COVERED_JUST = 'coverage:\n    node scripts/cover.mjs\n';

function repoWith(ci, justfile = '') {
  return fixture({ '.github/workflows/ci.yml': ci, justfile });
}

function gapsOf(root) {
  const gaps = checkStandard(root).gaps;
  rmSync(root, { recursive: true, force: true });
  return gaps;
}

function gapIds(root) {
  return gapsOf(root).map((gap) => gap.id);
}

function jobsOf(names) {
  return new Map(names.map((name) => [name, []]));
}

const COVERED_JOBS = [...SHARED_JOBS, 'coverage', 'test'];
const UNCOVERED_JOBS = [...SHARED_JOBS, 'test'];

function ids(gaps) {
  return gaps.map((gap) => gap.id);
}

function testKindOf(assert) {
  const exceptions = [{ repo: UNCOVERED_REPO, checks: new Set(['ci/coverage']), reason: '', date: '' }];
  assert(kindOf(exceptions, UNCOVERED_REPO) === 'uncovered', 'a repository excepted on ci/coverage is uncovered');
  assert(kindOf(exceptions, COVERED_REPO) === 'covered', 'a repository with no exception is covered');
  assert(kindOf(exceptions, null) === 'covered', 'no repository identity is covered');
  const other = [{ repo: UNCOVERED_REPO, checks: new Set(['community/LICENSE']), reason: '', date: '' }];
  assert(kindOf(other, UNCOVERED_REPO) === 'covered', 'an exception on another check does not make a repository uncovered');
}

function testExpectedChecks(assert) {
  assert(!ALL_CHECKS_REQUIRED, 'all-checks stays outside required ruleset contexts until consumers are ready');
  assert(!expectedChecks('covered').includes('all-checks') && !expectedChecks('uncovered').includes('all-checks'), 'staged rollout does not break consumers before they report all-checks');
  assert(expectedChecks('covered').includes(COVERAGE_CONTEXT), 'a covered repository expects coverage / coverage');
  assert(!expectedChecks('uncovered').includes(COVERAGE_CONTEXT), 'an uncovered repository does not expect coverage / coverage');
  for (const kind of ['covered', 'uncovered']) {
    assert(expectedChecks(kind).includes('test'), `a ${kind} repository expects the test job`);
  }
}

function testUncoveredCallGaps(assert) {
  const gaps = uncoveredCallGaps('uncovered', true);
  assert(gaps.length === 1 && gaps[0].id === 'ci/coverage-unrequired', 'an uncovered repository that calls coverage is a gap');
  assert(uncoveredCallGaps('uncovered', false).length === 0, 'an uncovered repository without a coverage call is clean');
  assert(uncoveredCallGaps('covered', true).length === 0, 'a covered repository that calls coverage is clean');
}

function testLiveCoveredRepository(assert) {
  const clean = requiredGaps({ kind: 'covered', live: expectedChecks('covered'), jobs: jobsOf(COVERED_JOBS) });
  assert(clean.length === 0, `a covered repository matching its kind: expected no gaps, got ${JSON.stringify(clean)}`);

  const missing = requiredGaps({ kind: 'covered', live: BASE_LIVE, jobs: jobsOf(COVERED_JOBS) });
  assert(ids(missing).join() === 'ruleset/required-missing', `a covered repository without coverage required: got ${ids(missing)}`);
  assert(missing[0].message.includes(COVERAGE_CONTEXT), 'the missing gap names coverage / coverage');
}

function testLiveUncoveredRepository(assert) {
  const clean = requiredGaps({ kind: 'uncovered', live: BASE_LIVE, jobs: jobsOf(UNCOVERED_JOBS) });
  assert(clean.length === 0, `an uncovered repository matching its kind: expected no gaps, got ${JSON.stringify(clean)}`);

  const noJob = requiredGaps({ kind: 'uncovered', live: [...BASE_LIVE, COVERAGE_CONTEXT], jobs: jobsOf(UNCOVERED_JOBS) });
  assert(ids(noJob).join() === 'ruleset/required-no-job', `coverage required with no coverage job: got ${ids(noJob)}`);

  const unexpected = requiredGaps({
    kind: 'uncovered',
    live: [...BASE_LIVE, COVERAGE_CONTEXT],
    jobs: jobsOf([...UNCOVERED_JOBS, 'coverage']),
  });
  assert(ids(unexpected).join() === 'ruleset/required-unexpected', `coverage required on an uncovered repository with a job: got ${ids(unexpected)}`);
}

function testLiveExtraTestJob(assert) {
  const withJob = requiredGaps({ kind: 'covered', live: [...expectedChecks('covered'), 'test-node'], jobs: jobsOf([...COVERED_JOBS, 'test-node']) });
  assert(withJob.length === 0, `a stable test-node job may be required: got ${JSON.stringify(withJob)}`);

  const withoutJob = requiredGaps({ kind: 'covered', live: [...expectedChecks('covered'), 'test-node'], jobs: jobsOf(COVERED_JOBS) });
  assert(ids(withoutJob).join() === 'ruleset/required-no-job', `test-node required with no job: got ${ids(withoutJob)}`);
}

function testLiveNoJobForBaseCheck(assert) {
  const gaps = requiredGaps({ kind: 'covered', live: expectedChecks('covered'), jobs: jobsOf(['test', 'lint']) });
  assert(gaps.some((gap) => gap.id === 'ruleset/required-no-job'), 'a required check whose job is absent is a no-job gap');
}

function testTreeCoverageJob(assert) {
  const withCoverage = repoWith(ciText({ coverage: `${sharedUses('coverage')}` }), COVERED_JUST);
  assert(!gapIds(withCoverage).some((id) => id === 'ci/coverage' || id === 'ci/coverage-recipe'),
    'a covered repository with the coverage job and recipe reports no coverage gap');

  const missing = gapsOf(repoWith(ciText(), COVERED_JUST));
  const coverageGap = missing.find((gap) => gap.id === 'ci/coverage');
  assert(coverageGap !== undefined, 'a repository without a coverage job is a ci/coverage gap');
  assert(coverageGap.message.includes('cannot report'), 'the ci/coverage gap says the required check cannot report');

  const wrong = repoWith(ciText({ coverage: sharedUses('lint') }), COVERED_JUST);
  assert(gapIds(wrong).includes('ci/coverage'), 'a coverage job that calls another workflow is a ci/coverage gap');
}

function testStarterCoverageContract(assert) {
  const callerCi = readFileSync(join(STANDARD_ROOT, 'templates/caller-ci.yml'), 'utf8');
  const justfile = readFileSync(join(STANDARD_ROOT, 'templates/justfile'), 'utf8');
  const mise = readFileSync(join(STANDARD_ROOT, 'templates/mise.toml'), 'utf8');
  assert(/^\[tasks\.coverage\]$/m.test(mise), 'the mise starter declares a coverage task');
  assert(mise.includes('coverage/lcov.info'), 'the mise starter requests the required LCOV output path');
  const coverageRoot = fixture({
    '.github/workflows/ci.yml': callerCi,
    justfile,
    'mise.toml': mise,
  });
  const coverageGaps = checkStandard(coverageRoot).gaps.map((gap) => gap.id);
  rmSync(coverageRoot, { recursive: true, force: true });
  assert(!coverageGaps.includes('ci/coverage-recipe'),
    'the checked-in caller CI and task-runner starters include the required coverage recipe');

  const uncoveredCi = callerCi.replace(/^  coverage:\n(?:    .*\n)+/m, '');
  const uncoveredRoot = fixture({ '.github/workflows/ci.yml': uncoveredCi, justfile });
  const uncoveredGaps = checkStandard(uncoveredRoot).gaps.map((gap) => gap.id);
  rmSync(uncoveredRoot, { recursive: true, force: true });
  assert(uncoveredGaps.includes('ci/coverage'),
    'without a central exception, an opted-out starter has an open ci/coverage gap');
}

function testTreeSharedJobs(assert) {
  const noStandard = repoWith(ciText({ omit: ['standard'] }));
  assert(gapIds(noStandard).includes('ci/standard'), 'a missing standard job is a ci/standard gap, because standard / standard is required');
}

function testExtraTestJob(assert) {
  const withExtra = repoWith(ciText({ coverage: sharedUses('coverage'), testSuffixes: ['node'] }), COVERED_JUST);
  const found = gapIds(withExtra);
  assert(!found.includes('ci/test') && !found.includes('ci/coverage'), 'a test-node job beside a plain test job adds no gap');
}

function testJobsCallingCoverage(assert) {
  const jobs = parseJobs(ciText({ coverage: sharedUses('coverage') }));
  assert(jobsCalling(jobs, 'coverage', false).join() === 'coverage', 'the coverage job is found through its pinned reference');
  assert(jobsCalling(parseJobs(ciText()), 'coverage', false).length === 0, 'no coverage job, no calls');

  const local = parseJobs(ciText({ coverage: './.github/workflows/coverage.yml' }));
  assert(jobsCalling(local, 'coverage', true).join() === 'coverage', 'a local reference counts in the standard repository');
  assert(jobsCalling(local, 'coverage', false).length === 0, 'a local reference does not count in another repository');
}

function testRulesetGaps(assert) {
  const live = (contexts) => ({
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [{ type: 'required_status_checks', parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: contexts.map((context) => ({ context })),
    } }],
  });
  const coveredJobs = jobsOf(COVERED_JOBS);
  assert(rulesetGaps(live(expectedChecks('covered')), { kind: 'covered', jobs: coveredJobs }).length === 0,
    'a live ruleset matching the covered kind is clean');
  const gaps = rulesetGaps({ ...live([]), rules: [] }, { kind: 'covered', jobs: coveredJobs });
  assert(gaps.filter((gap) => gap.id === 'ruleset/required-missing').length === expectedChecks('covered').length
    && gaps.some((gap) => gap.id === 'ruleset/required-strict'),
  'a ruleset with no required checks is missing every expected check and strict enforcement');
  const extra = rulesetGaps(live([...expectedChecks('covered'), 'test-node']), { kind: 'covered', jobs: jobsOf(COVERED_JOBS) });
  assert(extra.length === 1 && extra[0].id === 'ruleset/required-no-job', 'a required test-node with no job is a no-job gap');

  const good = live(expectedChecks('covered'));
  const nonStrict = rulesetGaps({ ...good, rules: [{ ...good.rules[0], parameters: {
    ...good.rules[0].parameters, strict_required_status_checks_policy: false,
  } }] }, { kind: 'covered', jobs: coveredJobs });
  assert(nonStrict.some((gap) => gap.id === 'ruleset/required-strict'), 'branches must be required to be up to date');
  for (const enforcement of ['disabled', 'evaluate']) {
    const gaps = rulesetGaps({ ...good, enforcement }, { kind: 'covered', jobs: coveredJobs });
    assert(gaps.some((gap) => gap.id === 'ruleset/enforcement'), `${enforcement} enforcement is not active protection`);
  }
  for (const conditions of [undefined, { ref_name: { include: ['refs/heads/release'], exclude: [] } }]) {
    const gaps = rulesetGaps({ ...good, conditions }, { kind: 'covered', jobs: coveredJobs });
    assert(gaps.some((gap) => gap.id === 'ruleset/main-target'), 'missing or wrong ref target is not main protection');
  }
  const excluded = rulesetGaps({ ...good, conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/main'] } } }, { kind: 'covered', jobs: coveredJobs });
  assert(excluded.some((gap) => gap.id === 'ruleset/main-target'), 'an exclusion overrides a matching inclusion');

  for (const include of [['~ALL'], ['~DEFAULT_BRANCH'], ['refs/heads/ma*'], ['refs/heads/main']]) {
    const gaps = rulesetGaps({ ...good, conditions: { ref_name: { include, exclude: [] } } }, { kind: 'covered', jobs: coveredJobs });
    assert(!gaps.some((gap) => gap.id === 'ruleset/main-target'), `${include[0]} includes main`);
  }
  const branchStar = rulesetGaps({ ...good, conditions: { ref_name: { include: ['refs/heads/*'], exclude: [] } } }, { kind: 'covered', jobs: coveredJobs });
  assert(!branchStar.some((gap) => gap.id === 'ruleset/main-target'), 'a single-star pattern includes main');
  const malformedRange = rulesetGaps({ ...good, conditions: { ref_name: { include: ['refs/heads/[z-a]'], exclude: [] } } }, { kind: 'covered', jobs: coveredJobs });
  assert(malformedRange.some((gap) => gap.id === 'ruleset/main-target'), 'a malformed character range produces a target gap instead of throwing');
  const zeroDirectoryGlobstar = rulesetGaps({ ...good, conditions: { ref_name: { include: ['refs/heads/**/main'], exclude: [] } } }, { kind: 'covered', jobs: coveredJobs });
  assert(zeroDirectoryGlobstar.some((gap) => gap.id === 'ruleset/main-target'), 'unmodeled zero-directory globstar produces a target gap');
  const unknownPattern = rulesetGaps({ ...good, conditions: { ref_name: { include: ['refs/heads/[!m]ain'], exclude: [] } } }, { kind: 'covered', jobs: coveredJobs });
  assert(unknownPattern.some((gap) => gap.id === 'ruleset/main-target'), 'unsupported pattern syntax cannot prove main coverage');
  const braceInclude = rulesetGaps({ ...good, conditions: { ref_name: { include: ['refs/heads/{main,dev}'], exclude: [] } } }, { kind: 'covered', jobs: coveredJobs });
  assert(braceInclude.some((gap) => gap.id === 'ruleset/main-target'), 'unsupported brace syntax cannot prove main coverage');
  const braceExclude = rulesetGaps({ ...good, conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/{main,dev}'] } } }, { kind: 'covered', jobs: coveredJobs });
  assert(braceExclude.some((gap) => gap.id === 'ruleset/main-target'), 'unsupported brace syntax cannot hide a possible main exclusion');

  const generated = JSON.parse(readFileSync(join(STANDARD_ROOT, 'rulesets/protect-main.json'), 'utf8'));
  const generatedGaps = rulesetGaps(generated, { kind: 'covered', jobs: coveredJobs });
  assert(!generatedGaps.some((gap) => gap.id === 'ruleset/enforcement' || gap.id === 'ruleset/main-target'),
    'the committed protect-main payload remains a valid active main ruleset');
}

function testProtectMainSelection(assert) {
  assert(protectMainSelection(1).ok, 'exactly one named ruleset can be selected');
  const missing = protectMainSelection(0);
  assert(!missing.ok && missing.id === 'ruleset/protect-main', 'a missing ruleset remains a missing-ruleset gap');
  const duplicate = protectMainSelection(2);
  assert(!duplicate.ok && duplicate.id === 'ruleset/ambiguous', 'duplicate names fail closed as ambiguity');
}

// Every coverage exception is a declaration, so it must name the reason. The two
// reasons are records (no executable code under test) and not measurable by the
// shared workflow. Either reason text is free, but it cannot be empty.
function testExceptionReasons(assert) {
  const coverage = loadExceptions(EXCEPTIONS).filter((entry) => entry.checks.has('ci/coverage'));
  assert(coverage.length >= 4, `the coverage exceptions name the four repositories without a coverage job, got ${coverage.length}`);
  for (const entry of coverage) {
    assert(entry.repo.startsWith('simpsonm09-org/'), `${entry.repo} is an org repository`);
    assert(entry.reason.trim().length > 0, `${entry.repo} gives a reason for having no coverage job`);
  }
}

function runCheckRepo(root, repo) {
  return spawnSync(process.execPath, [CHECK_REPO, root, '--repo', repo, '--no-api'], { windowsHide: true, encoding: 'utf8' });
}

function testUncoveredCli(assert) {
  const plain = repoWith(ciText());
  const plainResult = runCheckRepo(plain, UNCOVERED_REPO);
  rmSync(plain, { recursive: true, force: true });
  assert(plainResult.stdout.includes('  ci/coverage (2026-10-12)'), 'a central exception lists ci/coverage as excepted');
  assert(!plainResult.stdout.includes('gap ci/coverage:'), 'a central ci/coverage exception clears the missing-job gap');

  const calls = repoWith(ciText({ coverage: sharedUses('coverage') }), COVERED_JUST);
  const callsResult = runCheckRepo(calls, UNCOVERED_REPO);
  rmSync(calls, { recursive: true, force: true });
  assert(callsResult.stdout.includes('gap ci/coverage-unrequired:'), 'an uncovered repository that calls coverage has an open gap');
}

function testCoveredCli(assert) {
  const missing = repoWith(ciText());
  const missingResult = runCheckRepo(missing, COVERED_REPO);
  rmSync(missing, { recursive: true, force: true });
  assert(missingResult.stdout.includes('gap ci/coverage:'), 'a covered repository without a coverage job has an open ci/coverage gap');

  const present = repoWith(ciText({ coverage: sharedUses('coverage') }), COVERED_JUST);
  const presentResult = runCheckRepo(present, COVERED_REPO);
  rmSync(present, { recursive: true, force: true });
  assert(!presentResult.stdout.includes('gap ci/coverage:'), 'a covered repository with the coverage job has no ci/coverage gap');
  assert(!presentResult.stdout.includes('ci/coverage-unrequired'), 'a covered repository is not flagged as uncovered');
}

export function runTest() {
  const { assert, total } = makeAsserter();
  try {
    testKindOf(assert);
    testExpectedChecks(assert);
    testUncoveredCallGaps(assert);
    testLiveCoveredRepository(assert);
    testLiveUncoveredRepository(assert);
    testLiveExtraTestJob(assert);
    testLiveNoJobForBaseCheck(assert);
    testRulesetGaps(assert);
    testProtectMainSelection(assert);
    testTreeCoverageJob(assert);
    testStarterCoverageContract(assert);
    testTreeSharedJobs(assert);
    testExtraTestJob(assert);
    testJobsCallingCoverage(assert);
    testExceptionReasons(assert);
    testUncoveredCli(assert);
    testCoveredCli(assert);
    process.stdout.write(`required.test: ok (${total()} assertions)\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`required.test: failed: ${error.message}\n`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exit(runTest());

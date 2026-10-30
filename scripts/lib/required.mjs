// The required status checks by repository kind. check-standard, check-repo, and
// ruleset-payload read this one list, so they cannot disagree. The rule is in
// docs/governance.md under "Required checks".

import { findException } from './exceptions.mjs';

export const COVERAGE_CONTEXT = 'coverage / coverage';

// Every repository reports these, so every repository requires them.
export const BASE_CONTEXTS = Object.freeze([
  'lint / flint',
  'aislop / aislop',
  'security / trivy',
  'security / secrets',
  'standard / standard',
  'test',
]);

// A repository with no coverage job declares that with an exception on this check
// id, in docs/exceptions.json. The entry's reason says why. Any other repository is
// covered and must have the job.
export const COVERAGE_EXCEPTION = 'ci/coverage';

const EXTRA_TEST_JOB = /^test-[A-Za-z0-9_-]+$/;

export function kindOf(exceptions, repo) {
  if (!repo) return 'covered';
  return findException(exceptions, repo, COVERAGE_EXCEPTION) ? 'uncovered' : 'covered';
}

export function expectedChecks(kind) {
  return kind === 'covered' ? [...BASE_CONTEXTS, COVERAGE_CONTEXT] : [...BASE_CONTEXTS];
}

// The job that reports a required check. "lint / flint" is reported by the caller
// job "lint", and a bare name such as "test" or "test-node" is its own job.
export function jobOf(context) {
  return context.split(' / ')[0];
}

// Compare the checks a live ruleset requires with the checks the kind expects.
// `jobs` is the parsed ci.yml. The gap ids are the ones check-repo prints.
export function requiredGaps({ kind, live, jobs }) {
  const gaps = [];
  const expected = expectedChecks(kind);
  const required = new Set(live);
  for (const context of expected) {
    if (!required.has(context)) {
      gaps.push({ id: 'ruleset/required-missing', message: `${context} is expected for this repository and is not required` });
    }
  }
  for (const context of live) {
    const job = jobOf(context);
    if (!jobs.has(job)) {
      gaps.push({ id: 'ruleset/required-no-job', message: `${context} is required, but ci.yml has no "${job}" job to report it` });
    } else if (!expected.includes(context) && !EXTRA_TEST_JOB.test(context)) {
      gaps.push({ id: 'ruleset/required-unexpected', message: `${context} is required, but this repository does not expect it` });
    }
  }
  return gaps;
}

function bracketSet(pattern, start) {
  const end = pattern.indexOf(']', start + 1);
  if (end === -1) return null;
  const set = pattern.slice(start + 1, end);
  if (!set || set.startsWith('!') || set.startsWith('^') || set.includes('[') || set.includes('/')) return null;
  return { source: `[${set}]`, end };
}

function starPattern(pattern, index) {
  return pattern[index + 1] === '*' ? { source: '.*', advance: 1 } : { source: '[^/]*', advance: 0 };
}

function patternToken(pattern, index) {
  const char = pattern[index];
  if (char === '*') return starPattern(pattern, index);
  if (char === '?') return { source: '[^/]', advance: 0 };
  if (char === ']') return null;
  if (char === '[') {
    const parsed = bracketSet(pattern, index);
    return parsed && { source: parsed.source, advance: parsed.end - index };
  }
  return { source: char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'), advance: 0 };
}

function fnmatchRegex(pattern) {
  // This checker models only the simple forms below; `**/` zero-directory
  // semantics are not modeled.
  if (pattern.includes('\\') || /[+@!{}]/.test(pattern) || pattern.includes('**/')) return null;
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const token = patternToken(pattern, index);
    if (!token) return null;
    source += token.source;
    index += token.advance;
  }
  try {
    return new RegExp(`${source}$`);
  } catch {
    // Malformed ranges such as [z-a] are unverified, not checker failures.
    return null;
  }
}

// Evaluate only GitHub's documented branch-target syntax that this checker models.
// null means the pattern is not understood well enough to prove main is covered.
function patternMatchesMain(pattern, defaultBranch) {
  if (pattern === '~ALL') return true;
  if (pattern === '~DEFAULT_BRANCH') return defaultBranch === 'main';
  if (typeof pattern !== 'string' || !pattern.startsWith('refs/heads/')) return null;
  const regex = fnmatchRegex(pattern);
  return regex ? regex.test('refs/heads/main') : null;
}

export function mainTargetStatus(ruleset, defaultBranch = 'main') {
  const conditions = ruleset?.conditions;
  const refName = conditions?.ref_name;
  if (ruleset?.target !== 'branch' || !conditions || Object.keys(conditions).some((key) => key !== 'ref_name') || !refName
    || !Array.isArray(refName.include) || !Array.isArray(refName.exclude)) return 'unknown';
  const includes = refName.include.map((pattern) => patternMatchesMain(pattern, defaultBranch));
  const excludes = refName.exclude.map((pattern) => patternMatchesMain(pattern, defaultBranch));
  if (includes.includes(null) || excludes.includes(null)) return 'unknown';
  if (!includes.includes(true) || excludes.includes(true)) return 'not-targeted';
  return 'targeted';
}

// The gaps for one live protect-main ruleset, as the API returns it.
export function rulesetGaps(ruleset, { kind, jobs, defaultBranch = 'main' }) {
  const gaps = [];
  if (ruleset?.enforcement !== 'active') {
    gaps.push({ id: 'ruleset/enforcement', message: `protect-main enforcement is ${ruleset?.enforcement ?? 'missing'}, expected active` });
  }
  const target = mainTargetStatus(ruleset, defaultBranch);
  if (target !== 'targeted') {
    const reason = target === 'unknown' ? 'cannot verify its branch conditions' : 'does not target main';
    gaps.push({ id: 'ruleset/main-target', message: `protect-main ${reason}` });
  }
  const rules = ruleset.rules;
  if (!Array.isArray(rules)) gaps.push({ id: 'ruleset/rules', message: 'protect-main rules are unreadable' });
  const rule = (Array.isArray(rules) ? rules : []).find((entry) => entry?.type === 'required_status_checks');
  const required = rule?.parameters?.required_status_checks;
  if (rule && !Array.isArray(required)) gaps.push({ id: 'ruleset/required-checks', message: 'protect-main required status checks are unreadable' });
  if (rule?.parameters?.strict_required_status_checks_policy !== true) {
    gaps.push({ id: 'ruleset/required-strict', message: 'protect-main does not require branches to be up to date' });
  }
  const live = (Array.isArray(required) ? required : []).map((entry) => entry?.context).filter((context) => typeof context === 'string');
  return [...gaps, ...requiredGaps({ kind, live, jobs })];
}

export function protectMainSelection(count) {
  if (count === 1) return { ok: true };
  return {
    ok: false,
    id: count === 0 ? 'ruleset/protect-main' : 'ruleset/ambiguous',
    message: count === 0 ? 'public repository has no protect-main ruleset' : `found ${count} protect-main rulesets; expected exactly one`,
  };
}

// An uncovered repository that calls the coverage workflow runs a check nothing
// requires, so the job is noise at best and a broken recipe at worst.
export function uncoveredCallGaps(kind, callsCoverage) {
  if (kind !== 'uncovered' || !callsCoverage) return [];
  return [
    {
      id: 'ci/coverage-unrequired',
      message: 'ci.yml calls the coverage workflow, but the exception file declares this repository as having no coverage job',
    },
  ];
}

export const COVERAGE_MISSING_MESSAGE =
  'ci.yml has no "coverage" job, so coverage / coverage cannot report. A repository with a coverage job calls the shared coverage workflow. A repository without one declares it with an exception on ci/coverage in docs/exceptions.json, and the reason says why';

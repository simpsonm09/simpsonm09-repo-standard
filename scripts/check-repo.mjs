#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT } from './lib/exit.mjs';
import { capture, isMain } from './lib/proc.mjs';
import { checkStandard } from './check-standard.mjs';
import { loadExceptions, findException } from './lib/exceptions.mjs';
import { jobsCalling, parseJobs } from './lib/ci.mjs';
import { normalize, readText } from './lib/tree.mjs';
import { kindOf, rulesetGaps, uncoveredCallGaps } from './lib/required.mjs';
import { compareMainRulesets, findUniqueRuleset, rulesetTargetErrors, SELECTABLE_LEVELS } from './lib/ruleset-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STANDARD_ROOT = resolve(HERE, '..');
const MAIN_BRANCH = 'main';
const GROUPS = ['files', 'mise', 'ci', 'dependabot', 'community', 'docs', 'scripting', 'env', 'subprocess', 'settings', 'ruleset'];

const USAGE = `usage: node scripts/check-repo.mjs [repo-path] [options]

options:
  --repo OWNER/NAME     repository identity for the exception file and the API checks
  --agent-level LEVEL   check level-specific approval-main policy (propose, merge, or full)
  --no-api              run only the tree-local checks
  -h, --help            show this help

Runs the single-repository standard check and applies docs/exceptions.json from
this standard. A repository runs it from its own ci.yml with its own token, so no
repository audits another. The API checks cover only what a repository can read
about itself.
`;

function parseArgs(argv) {
  const options = { root: null, repo: null, agentLevel: undefined, api: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--no-api') options.api = false;
    else if (arg === '--repo') { options.repo = argv[index + 1]; index += 1; }
    else if (arg === '--agent-level') { options.agentLevel = argv[index + 1] ?? ''; index += 1; }
    else if (options.root === null) options.root = arg;
  }
  return options;
}

function deriveRepo(root) {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const result = capture('git', ['-C', root, 'config', '--get', 'remote.origin.url']);
  if (result.error || result.status !== 0) return null;
  const match = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(result.stdout.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

function ghJson(args) {
  const result = capture('gh', args);
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout).trim() };
  try {
    return { ok: true, value: JSON.parse(result.stdout || 'null') };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error.message}` };
  }
}

function addPolicyGap(add, message) {
  add('ruleset/approval-policy', message);
}

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkApi(repo, add, notice, ci) {
  const meta = ghJson(['api', `repos/${repo}`]);
  if (!meta.ok || !isJsonObject(meta.value)) {
    const error = meta.ok ? 'unreadable repository metadata response body' : meta.error;
    notice(`cannot read ${repo} settings: ${error}`);
    if (ci.agentLevel !== undefined) addPolicyGap(add, `level not verified: cannot read repository metadata (${error})`);
    return;
  }
  const value = meta.value;
  if (value.default_branch !== 'main') add('settings/default-branch', `default branch is ${value.default_branch}`);
  if (!value.description) add('settings/description', 'repository description is empty');

  const owner = repo.split('/')[0];
  const topics = ghJson(['api', `repos/${repo}/topics`]);
  if (!topics.ok) notice(`cannot read ${repo} topics: ${topics.error}`);
  else if (!(topics.value?.names ?? []).includes(owner)) add('settings/topics', `topics do not include the owner "${owner}"`);

  if (value.visibility !== 'public') {
    if (ci.agentLevel !== undefined) addPolicyGap(add, `level not verified: ruleset audit is unsupported for ${value.visibility ?? 'unknown'} repositories`);
    return;
  }
  checkPublicRuleset(repo, add, notice, ci, ci.agentLevel);
}

function readRulesetSummaries(repo, add, notice, agentLevel) {
  const result = ghJson(['api', '--paginate', '--slurp', `repos/${repo}/rulesets`]);
  if (!result.ok) {
    notice(`cannot read ${repo} rulesets: ${result.error}`);
    if (agentLevel !== undefined) addPolicyGap(add, `level not verified: cannot read ruleset list (${result.error})`);
    return null;
  }
  if (!Array.isArray(result.value) || !result.value.every(Array.isArray)
    || !result.value.flat().every(isJsonObject)) {
    const error = 'unreadable ruleset list response body';
    notice(`cannot read ${repo} rulesets: ${error}`);
    if (agentLevel !== undefined) addPolicyGap(add, `level not verified: cannot read ruleset list (${error})`);
    return null;
  }
  const summaries = result.value.flat();
  const selected = {};
  for (const name of ['protect-main', 'approval-main']) {
    readOneRuleset(repo, summaries, name, selected, add, notice, agentLevel);
  }
  return selected;
}

function readOneRuleset(repo, summaries, name, selected, add, notice, agentLevel) {
  const match = findUniqueRuleset(summaries, name);
  if (!match.ok) {
    add(name === 'protect-main' ? 'ruleset/protect-main' : 'ruleset/approval-main', match.reason);
    if (agentLevel !== undefined) addPolicyGap(add, `level not verified: ${match.reason}`);
    return;
  }
  if (!Number.isSafeInteger(match.summary.id) || match.summary.id < 1) {
    add('ruleset/ambiguous', `could not select a numeric ${name} id`);
    if (agentLevel !== undefined) addPolicyGap(add, `level not verified: could not select a numeric ${name} id`);
    return;
  }
  const detail = ghJson(['api', `repos/${repo}/rulesets/${match.summary.id}`]);
  if (!detail.ok || !isJsonObject(detail.value)) {
    const error = detail.ok ? 'unreadable response body' : detail.error;
    notice(`cannot read ${name}: ${error}`);
    if (agentLevel !== undefined) addPolicyGap(add, `level not verified: cannot read ${name} detail (${error})`);
    return;
  }
  selected[name] = detail.value;
}

function checkPublicRuleset(repo, add, notice, ci, agentLevel) {
  const selected = readRulesetSummaries(repo, add, notice, agentLevel);
  if (!selected) return;
  const protect = selected['protect-main'];
  const approval = selected['approval-main'];
  checkLegacyProtect(protect, ci, add);
  if (agentLevel !== undefined) {
    if (SELECTABLE_LEVELS.includes(agentLevel) && protect && approval) checkLevelPolicy(agentLevel, protect, approval, add);
    return;
  }
  checkLegacyApproval(approval, add);
  notice('approval-main approval count and bypass actors were not compared; pass --agent-level to enable level-specific policy checks');
}

function checkLevelPolicy(agentLevel, protect, approval, add) {
  for (const error of compareMainRulesets(agentLevel, protect, approval, MAIN_BRANCH)) addPolicyGap(add, error);
}

function checkLegacyProtect(protect, ci, add) {
  if (protect) {
    for (const gap of rulesetGaps(protect, { ...ci, defaultBranch: MAIN_BRANCH })) add(gap.id, gap.message);
    const rules = Array.isArray(protect.rules) ? protect.rules : [];
    const pullRequests = rules.filter((entry) => entry?.type === 'pull_request');
    if (pullRequests.length !== 1) add('ruleset/protect-rule', `protect-main has ${pullRequests.length} pull_request rules, expected exactly one`);
    const count = pullRequests[0]?.parameters?.required_approving_review_count;
    if (count !== 0) add('ruleset/protect-approval', `protect-main approval count is ${count ?? 'unreadable'}, expected 0`);
    if (rules.filter((entry) => entry?.type === 'required_signatures').length !== 1) {
      add('ruleset/protect-signatures', 'protect-main must contain exactly one required_signatures rule');
    }
    if (!Array.isArray(protect.bypass_actors) || protect.bypass_actors.length !== 0) {
      add('ruleset/protect-bypass', 'protect-main must have a readable empty bypass actor list');
    }
  }
}

function checkLegacyApproval(approval, add) {
  if (approval && (!Array.isArray(approval.rules)
    || (approval.rules ?? []).filter((entry) => entry?.type === 'pull_request').length !== 1)) {
    add('ruleset/approval-rule', 'approval-main must contain exactly one pull_request rule');
  }
  if (approval) {
    for (const error of rulesetTargetErrors(approval, 'approval-main', MAIN_BRANCH)) add('ruleset/approval-target', error);
  }
}

function readJobs(root) {
  const file = join(root, '.github/workflows/ci.yml');
  return existsSync(file) ? parseJobs(normalize(readText(file))) : new Map();
}

function groupOf(id) {
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(0, slash);
}

function statusFor(gaps, group) {
  const count = gaps.filter((gap) => groupOf(gap.id) === group).length;
  return count === 0 ? 'ok' : `GAP(${count})`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    process.exit(EXIT.OK);
  }

  const root = resolve(options.root ?? '.');
  const repo = options.repo ?? deriveRepo(root);
  const exceptions = loadExceptionsOrExit();
  const kind = kindOf(exceptions, repo);
  const jobs = readJobs(root);
  const result = checkStandard(root);
  const gaps = [...result.gaps];
  const notices = [];
  const notice = (message) => notices.push(message);
  const addGap = (id, message) => gaps.push({ id, message });
  if (options.agentLevel !== undefined && !SELECTABLE_LEVELS.includes(options.agentLevel)) {
    addPolicyGap(addGap, `unsupported agent level ${options.agentLevel}`);
  }

  const callsCoverage = jobsCalling(jobs, 'coverage', root === STANDARD_ROOT).length > 0;
  gaps.push(...uncoveredCallGaps(kind, callsCoverage));

  const auditLevel = SELECTABLE_LEVELS.includes(options.agentLevel) ? options.agentLevel : undefined;
  if (auditLevel !== undefined && !options.api) addPolicyGap(addGap, 'level not verified: API checks were disabled with --no-api');
  else if (options.api && repo) runApiChecks(repo, gaps, notice, { kind, jobs, agentLevel: auditLevel });
  else if (auditLevel !== undefined) addPolicyGap(addGap, 'level not verified: repository identity could not be determined');

  const { open, excepted } = partitionGaps(gaps, repo, exceptions);
  report(root, repo, open, excepted, notices);
  process.exit(open.length === 0 ? EXIT.OK : EXIT.FAIL);
}

function runApiChecks(repo, gaps, notice, ci) {
  const add = (id, message) => gaps.push({ id, message });
  if (capture('gh', ['--version']).status === 0) checkApi(repo, add, notice, ci);
  else {
    notice('gh is not on PATH, so the API checks are skipped');
    if (ci.agentLevel !== undefined) addPolicyGap(add, 'level not verified: gh is not on PATH');
  }
}

function loadExceptionsOrExit() {
  try {
    return loadExceptions(resolve(STANDARD_ROOT, 'docs/exceptions.json'));
  } catch (error) {
    process.stderr.write(`check-repo: cannot read the exception file: ${error.message}\n`);
    process.exit(EXIT.FAIL);
  }
}

function partitionGaps(gaps, repo, exceptions) {
  const open = [];
  const excepted = [];
  for (const gap of gaps) {
    const match = repo ? findException(exceptions, repo, gap.id) : null;
    if (match) excepted.push({ gap, match });
    else open.push(gap);
  }
  return { open, excepted };
}

function report(root, repo, open, excepted, notices) {
  const header = ['repo'.padEnd(30), ...GROUPS.map((group) => group.padEnd(11))].join('');
  const row = [(repo ?? root).padEnd(30), ...GROUPS.map((group) => statusFor(open, group).padEnd(11))].join('');
  process.stdout.write(`check-repo  ${root}\n`);
  process.stdout.write(`${header}\n${row}\n`);
  for (const gap of open) process.stdout.write(`  gap ${gap.id}: ${gap.message}\n`);
  if (excepted.length > 0) {
    process.stdout.write(`\nexcepted:\n`);
    for (const entry of excepted) process.stdout.write(`  ${entry.gap.id} (${entry.match.date})\n`);
  }
  for (const message of notices) process.stdout.write(`notice: ${message}\n`);
  process.stdout.write(`\nstandard: ${open.length === 0 ? 'ok' : 'failed'}\n`);
}

if (isMain(import.meta.url)) main();

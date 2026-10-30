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
import { kindOf, protectMainSelection, rulesetGaps, uncoveredCallGaps } from './lib/required.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STANDARD_ROOT = resolve(HERE, '..');
const GROUPS = ['files', 'mise', 'ci', 'dependabot', 'community', 'docs', 'scripting', 'env', 'subprocess', 'settings', 'ruleset'];

const USAGE = `usage: node scripts/check-repo.mjs [repo-path] [options]

options:
  --repo OWNER/NAME     repository identity for the exception file and the API checks
  --no-api              run only the tree-local checks
  -h, --help            show this help

Runs the single-repository standard check and applies docs/exceptions.json from
this standard. A repository runs it from its own ci.yml with its own token, so no
repository audits another. The API checks cover only what a repository can read
about itself.
`;

function parseArgs(argv) {
  const options = { root: null, repo: null, api: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--no-api') options.api = false;
    else if (arg === '--repo') { options.repo = argv[index + 1]; index += 1; }
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

function checkApi(repo, add, notice, ci) {
  const meta = ghJson(['api', `repos/${repo}`]);
  if (!meta.ok) {
    notice(`cannot read ${repo} settings: ${meta.error}`);
    return;
  }
  const value = meta.value ?? {};
  if (value.default_branch !== 'main') add('settings/default-branch', `default branch is ${value.default_branch}`);
  if (!value.description) add('settings/description', 'repository description is empty');

  const owner = repo.split('/')[0];
  const topics = ghJson(['api', `repos/${repo}/topics`]);
  if (!topics.ok) notice(`cannot read ${repo} topics: ${topics.error}`);
  else if (!(topics.value?.names ?? []).includes(owner)) add('settings/topics', `topics do not include the owner "${owner}"`);

  if (value.visibility !== 'public') return;
  checkPublicRuleset(repo, add, notice, ci, value.default_branch);
}

function checkPublicRuleset(repo, add, notice, ci, defaultBranch) {
  const rulesets = ghJson(['api', '--paginate', '--slurp', `repos/${repo}/rulesets`, '--jq', '[.[][] | select(.name=="protect-main")] | length']);
  if (!rulesets.ok) {
    notice(`cannot read ${repo} rulesets: ${rulesets.error}`);
    return;
  }
  const selection = protectMainSelection(Number(rulesets.value));
  if (!selection.ok) {
    add(selection.id, selection.message);
    return;
  }
  checkRulesetApprovals(repo, add, notice, ci, defaultBranch);
}

function checkRulesetApprovals(repo, add, notice, ci, defaultBranch) {
  const id = ghJson(['api', '--paginate', '--slurp', `repos/${repo}/rulesets`, '--jq', '[.[][] | select(.name=="protect-main") | .id]']);
  if (!id.ok) {
    notice(`cannot read the protect-main id: ${id.error}`);
    return;
  }
  if (!Array.isArray(id.value) || id.value.length !== 1
    || !Number.isSafeInteger(id.value[0]) || id.value[0] < 1) {
    add('ruleset/ambiguous', 'could not select exactly one numeric protect-main id');
    return;
  }
  const detail = ghJson(['api', `repos/${repo}/rulesets/${id.value[0]}`]);
  if (!detail.ok) {
    notice(`cannot read protect-main: ${detail.error}`);
    return;
  }
  const rule = (detail.value.rules ?? []).find((entry) => entry.type === 'pull_request');
  const count = rule?.parameters?.required_approving_review_count;
  if (count !== 1) add('ruleset/approval', `protect-main requires ${count ?? 'no'} approving review, expected 1`);
  for (const gap of rulesetGaps(detail.value, { ...ci, defaultBranch })) add(gap.id, gap.message);
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

  const callsCoverage = jobsCalling(jobs, 'coverage', root === STANDARD_ROOT).length > 0;
  gaps.push(...uncoveredCallGaps(kind, callsCoverage));

  if (options.api && repo) runApiChecks(repo, gaps, notice, { kind, jobs });

  const { open, excepted } = partitionGaps(gaps, repo, exceptions);
  report(root, repo, open, excepted, notices);
  process.exit(open.length === 0 ? EXIT.OK : EXIT.FAIL);
}

function runApiChecks(repo, gaps, notice, ci) {
  if (capture('gh', ['--version']).status === 0) checkApi(repo, (id, message) => gaps.push({ id, message }), notice, ci);
  else notice('gh is not on PATH, so the API checks are skipped');
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

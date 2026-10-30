#!/usr/bin/env node
// Print the hard-protection or approval-only ruleset payload for one repository.
//
// Usage:
//   node scripts/ruleset-payload.mjs <ruleset.json> --level <propose|merge|full> [--repo <owner/name>]
//   node scripts/ruleset-payload.mjs --self-test

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadExceptions } from './lib/exceptions.mjs';
import { COVERAGE_CONTEXT, kindOf } from './lib/required.mjs';
import { approvalCountFor, expectedApprovalBypass } from './lib/ruleset-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXCEPTIONS = join(HERE, '..', 'docs', 'exceptions.json');

export function buildPayload(ruleset, level, kind = 'covered') {
  const approvals = approvalCountFor(level);
  const payload = JSON.parse(JSON.stringify(ruleset));
  if (payload.name === 'protect-main') {
    setCoverageContext(payload, kind);
    payload.bypass_actors = [];
    setApprovalCount(payload, 0);
  } else if (payload.name === 'approval-main') {
    payload.bypass_actors = expectedApprovalBypass(level);
    setApprovalCount(payload, approvals);
  }
  return payload;
}

function setApprovalCount(payload, count) {
  const rules = (payload.rules ?? []).filter((entry) => entry.type === 'pull_request');
  if (rules.length !== 1 || !rules[0].parameters) {
    throw new Error(`${payload.name} must define exactly one pull_request rule with parameters`);
  }
  rules[0].parameters.required_approving_review_count = count;
}

// The committed file lists the checks every repository reports. Only a covered
// repository also requires coverage, so the kind adds or removes that one context.
function setCoverageContext(payload, kind) {
  const rule = (payload.rules ?? []).find((entry) => entry.type === 'required_status_checks');
  if (!rule?.parameters) return;
  const others = (rule.parameters.required_status_checks ?? []).filter((entry) => entry.context !== COVERAGE_CONTEXT);
  rule.parameters.required_status_checks = kind === 'covered' ? [...others, { context: COVERAGE_CONTEXT }] : others;
}

function parseArgs(argv) {
  const args = { file: undefined, level: undefined, repo: undefined, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--level') {
      index += 1;
      args.level = argv[index];
    } else if (arg === '--repo') {
      index += 1;
      args.repo = argv[index];
    } else if (arg === '--self-test') args.selfTest = true;
    else if (!args.file) args.file = arg;
  }
  return args;
}

function selfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const protect = { name: 'protect-main', bypass_actors: [{ actor_type: 'Integration', actor_id: 42 }],
    rules: [{ type: 'pull_request', parameters: {} }] };
  const approval = { name: 'approval-main', bypass_actors: [], rules: [{ type: 'pull_request', parameters: {} }] };
  const propose = buildPayload(approval, 'propose');
  assert(propose.rules[0].parameters.required_approving_review_count === 1, 'propose requires one approval');
  assert(propose.bypass_actors.length === 1 && propose.bypass_actors[0].actor_type === 'OrganizationAdmin', 'propose has one human admin bypass');
  assert(propose.bypass_actors[0].bypass_mode === 'pull_request', 'admin bypass is PR-only');
  const merge = buildPayload(approval, 'merge');
  assert(merge.rules[0].parameters.required_approving_review_count === 1, 'merge requires one approval');
  const full = buildPayload(approval, 'full');
  assert(full.rules[0].parameters.required_approving_review_count === 0, 'full has zero approvals');
  assert(full.bypass_actors.length === 0, 'full has no approval bypass actor');
  assert(buildPayload(buildPayload(approval, 'merge'), 'full').bypass_actors.length === 0, 'full to merge to full converges without stale actors');
  assert(buildPayload(protect, 'merge').bypass_actors.length === 0, 'protect-main strips every bypass actor');
  let rejected = false;
  try { buildPayload(approval, 'read'); } catch { rejected = true; }
  assert(rejected, 'legacy read level fails closed');
  const tags = buildPayload({ name: 'protect-tags' }, 'merge');
  assert(tags.name === 'protect-tags', 'other rulesets are untouched');
}

// The required contexts of the protect-main payload, in order.
function contextsOf(payload) {
  const rule = (payload.rules ?? []).find((entry) => entry.type === 'required_status_checks');
  return (rule?.parameters?.required_status_checks ?? []).map((entry) => entry.context);
}

function selfTestKinds() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const base = {
    name: 'protect-main',
    rules: [
      { type: 'pull_request', parameters: {} },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint / flint' }, { context: 'test' }] } },
    ],
  };

  const covered = buildPayload(base, 'full', 'covered');
  assert(contextsOf(covered).includes(COVERAGE_CONTEXT), 'a covered repository requires coverage');
  assert(contextsOf(covered).includes('test'), 'a covered repository keeps the base checks');

  const uncovered = buildPayload(covered, 'full', 'uncovered');
  assert(!contextsOf(uncovered).includes(COVERAGE_CONTEXT), 'an uncovered repository does not require coverage');
  assert(contextsOf(uncovered).join(',') === 'lint / flint,test', 'an uncovered repository keeps exactly the base checks');

  assert(contextsOf(buildPayload(base, 'full')).includes(COVERAGE_CONTEXT),
    'without a kind the payload is for a covered repository');
  assert(contextsOf(buildPayload(covered, 'full', 'covered')).filter((c) => c === COVERAGE_CONTEXT).length === 1,
    'a covered repository never duplicates coverage');

  const tags = buildPayload({ name: 'protect-tags', rules: base.rules }, 'full', 'uncovered');
  assert(contextsOf(tags).includes(COVERAGE_CONTEXT) === false && contextsOf(tags).length === 2, 'protect-tags is untouched');
}

function runSelfTest() {
  try {
    selfTest();
    selfTestKinds();
    process.stdout.write('ruleset-payload: self-test ok\n');
  } catch (error) {
    process.stderr.write(`ruleset-payload: self-test failed: ${error.message}\n`);
    process.exit(1);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }
  if (!args.file) {
    process.stderr.write('usage: ruleset-payload <ruleset.json> --level <propose|merge|full> [--repo <owner/name>]\n');
    process.exit(2);
  }
  const ruleset = JSON.parse(readFileSync(args.file, 'utf8'));
  const kind = args.repo ? kindOf(loadExceptions(EXCEPTIONS), args.repo) : 'covered';
  try {
    process.stdout.write(`${JSON.stringify(buildPayload(ruleset, args.level, kind), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`ruleset-payload: ${error.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

#!/usr/bin/env node
// Check the named cumulative access contract against the resolver and ruleset builder.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/proc.mjs';
import { parseJobs } from './lib/ci.mjs';
import { CAPABILITIES, FORBIDDEN_CAPABILITY, LEVELS, allows, decide } from './agent-access.mjs';
import { rulesetGaps, expectedChecks } from './lib/required.mjs';
import { compareMainRulesets } from './lib/ruleset-policy.mjs';
import { buildPayload } from './ruleset-payload.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(readFileSync(join(HERE, 'fixtures', 'agent-access', 'cumulative-contract.json'), 'utf8'));
const PROTECT_MAIN = JSON.parse(readFileSync(join(HERE, '..', 'rulesets', 'protect-main.json'), 'utf8'));
const APPROVAL_MAIN = JSON.parse(readFileSync(join(HERE, '..', 'rulesets', 'approval-main.json'), 'utf8'));

function contextsOf(ruleset) {
  const rule = ruleset.rules.find((entry) => entry.type === 'required_status_checks');
  return rule.parameters.required_status_checks.map((entry) => entry.context);
}

function testContract() {
  assert.deepEqual(LEVELS, CONTRACT.selectableLevels, 'the contract names the selectable levels');
  assert.deepEqual(CAPABILITIES[CONTRACT.internalBaseline.level], CONTRACT.internalBaseline.grants,
    'the internal read baseline grants only its documented capability');
  assert.deepEqual(CAPABILITIES.none, [], 'none remains an internal empty capability set');

  const jobs = parseJobs(readFileSync(join(HERE, '..', '.github', 'workflows', 'ci.yml'), 'utf8'));
  let previous = CAPABILITIES[CONTRACT.internalBaseline.level];
  for (const level of CONTRACT.selectableLevels) {
    const { grants, adds } = CONTRACT.levels[level];
    assert.deepEqual(CAPABILITIES[level], grants, `${level} matches its exact contract grants`);
    assert(previous.every((capability) => grants.includes(capability)), `${level} retains every lower-level grant`);
    assert.deepEqual(grants.filter((capability) => !previous.includes(capability)), adds,
      `${level} adds only its named capabilities`);
    for (const capability of CONTRACT.neverGranted) {
      assert(!allows(level, capability), `${level} never grants ${capability}`);
      assert.equal(FORBIDDEN_CAPABILITY, capability, 'the never-granted contract uses the classifier sentinel');
    }

    const protect = buildPayload(PROTECT_MAIN, level, CONTRACT.hardProtection.kind);
    const approval = buildPayload(APPROVAL_MAIN, level);
    assert.equal(protect.name, CONTRACT.hardProtection.ruleset, `${level} uses the named hard-protection ruleset`);
    assert.deepEqual(protect.bypass_actors, CONTRACT.hardProtection.bypassActors,
      `${level} keeps hard protection free of bypass actors`);
    assert.deepEqual(contextsOf(protect), expectedChecks(CONTRACT.hardProtection.kind),
      `${level} preserves the current required hard checks`);
    assert.deepEqual(rulesetGaps(protect, { kind: CONTRACT.hardProtection.kind, jobs }), [],
      `${level} passes the shared required-check ruleset builder`);
    assert.equal(approval.rules[0].parameters.required_approving_review_count, CONTRACT.approvalCounts[level],
      `${level} uses its contract approval count`);
    assert(approval.bypass_actors.every((actor) => actor.actor_type !== 'Integration'),
      `${level} has no App bypass on approval protection`);
    assert.deepEqual(compareMainRulesets(level, protect, approval), [],
      `${level} passes shared ruleset approval and bypass policy`);
    previous = grants;
  }

  assert.equal(allows('unknown-level', 'read'), false, 'unknown levels fail closed');
  assert.equal(decide('unknown-level', 'gh pr create').allowed, false, 'unknown levels deny classified writes');
}

export function runTest() {
  try {
    testContract();
    return 0;
  } catch (error) {
    process.stderr.write(`agent-access-contract.test: failed: ${error.message}\n`);
    return 1;
  }
}

if (isMain(import.meta.url)) {
  const exitCode = runTest();
  if (exitCode === 0) process.stdout.write('agent-access-contract.test: ok\n');
  process.exitCode = exitCode;
}

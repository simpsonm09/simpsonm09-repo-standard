#!/usr/bin/env node
// Run every test suite and exit non-zero if any fails. One entry point so
// `just test`, the `mise` task, and verify.mjs all run the same set.
//
// Usage:
//   node scripts/test.mjs

import { EXIT } from './lib/exit.mjs';
import { isMain, run } from './lib/proc.mjs';
import { runTest as runAgentAccess } from './agent-access.test.mjs';
import { runTest as runAgentAccessContract } from './agent-access-contract.test.mjs';
import { runTest as runAllChecks } from './all-checks.test.mjs';
import { runTest as runEnv } from './env.test.mjs';
import { runTest as runPatchCoverage } from './patch-coverage.test.mjs';
import { runTest as runProc } from './proc.test.mjs';
import { runTest as runRepoMaintenance } from './repo-maintenance.test.mjs';
import { runTest as runRequired } from './required.test.mjs';
import { runTest as runRulesetPolicy } from './ruleset-policy.test.mjs';
import { runTest as runScripting } from './scripting.test.mjs';
import { runTest as runSubprocess } from './subprocess.test.mjs';

const SUITES = [runAgentAccess, runAgentAccessContract, runAllChecks, runPatchCoverage, runProc, runRepoMaintenance, runRequired, runRulesetPolicy, runScripting, runEnv, runSubprocess];

export function runTests() {
  let failed = false;
  for (const suite of SUITES) {
    if (suite() !== EXIT.OK) failed = true;
  }
  if (run(process.execPath, ['scripts/op.mjs', 'run', 'test-agent-token']) !== EXIT.OK) failed = true;
  return failed ? EXIT.FAIL : EXIT.OK;
}

if (isMain(import.meta.url)) process.exit(runTests());

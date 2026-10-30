#!/usr/bin/env node
import { applySettings } from './apply-settings.mjs';
import { compareMainRulesets, findUniqueRuleset } from './lib/ruleset-policy.mjs';
import { buildPayload } from './ruleset-payload.mjs';
import { compare } from './check-agent-access.mjs';
import { EXIT } from './lib/exit.mjs';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ruleset(name, count, actors = []) {
  return {
    name, target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    bypass_actors: actors,
    rules: [{ type: 'pull_request', parameters: { required_approving_review_count: count } }],
  };
}

function testRulesets() {
  const admin = [{ actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'pull_request' }];
  const protect = ruleset('protect-main', 0);
  const approval = ruleset('approval-main', 1, admin);
  assert(compareMainRulesets('propose', protect, approval).length === 0, 'propose policy passes');
  assert(compareMainRulesets('merge', protect, approval).length === 0, 'merge policy passes');
  assert(compareMainRulesets('full', protect, ruleset('approval-main', 0)).length === 0, 'full policy passes');
  assert(compareMainRulesets('legacy', protect, ruleset('approval-main', 0)).length > 0, 'unknown level fails');
  assert(compareMainRulesets('full', { ...protect, bypass_actors: admin }, ruleset('approval-main', 0)).some((item) => item.includes('protect-main has bypass')), 'hard protection bypass fails');
  assert(compareMainRulesets('merge', protect, ruleset('approval-main', 1, [{ actor_type: 'Integration', actor_id: 42, bypass_mode: 'always' }])).some((item) => item.includes('unexpected')), 'unexpected bypass actor fails');
  assert(compareMainRulesets('full', protect, ruleset('approval-main', 1)).some((item) => item.includes('expected 0')), 'wrong approval count fails');
  assert(compareMainRulesets('full', null, ruleset('approval-main', 0)).some((item) => item.includes('missing or unreadable')), 'missing ruleset fails');
  assert(compareMainRulesets('full', protect, { ...ruleset('approval-main', 0), enforcement: 'disabled' }).some((item) => item.includes('expected active')), 'inactive ruleset fails');
  assert(compareMainRulesets('full', protect, { ...ruleset('approval-main', 0), conditions: { ref_name: { include: ['refs/heads/release'], exclude: [] } } }).some((item) => item.includes('does not target exactly')), 'wrong branch target fails');
  assert(compareMainRulesets('full', protect, { ...ruleset('approval-main', 0), bypass_actors: undefined }).some((item) => item.includes('unreadable')), 'unreadable bypass list fails');
  assert(compareMainRulesets('full', protect, { ...ruleset('approval-main', 0), rules: [] }).some((item) => item.includes('expected one pull_request')), 'missing approval rule fails');
  assert(compareMainRulesets('full', protect, { ...ruleset('approval-main', 0), rules: [...ruleset('approval-main', 0).rules, ...ruleset('approval-main', 0).rules] }).some((item) => item.includes('found 2')), 'duplicate approval rules fail');
  assert(compareMainRulesets('full', protect, null).some((item) => item.includes('approval-main is missing')), 'missing approval ruleset fails');
  assert(compare('example', 'merge', protect, approval).ok, 'checker accepts the expected merge rulesets');
  assert(!compare('example', 'full', protect, ruleset('approval-main', 1)).ok, 'checker rejects a full approval mismatch');
  assert(!compare('example', 'merge', { ...protect, bypass_actors: undefined }, approval).ok,
    'check-agent-access fails closed when protect-main bypass actors are unreadable');
  assert(!compare('example', 'merge', protect, { ...approval, bypass_actors: undefined }).ok,
    'check-agent-access fails closed when approval-main bypass actors are unreadable');
  assert(!findUniqueRuleset([{ name: 'approval-main' }, { name: 'approval-main' }], 'approval-main').ok, 'duplicate rulesets fail');

  const approvalBase = ruleset('approval-main', 1, admin);
  const merge = buildPayload(approvalBase, 'merge');
  const full = buildPayload(merge, 'full');
  const backToMerge = buildPayload(full, 'merge');
  const fullAgain = buildPayload(backToMerge, 'full');
  assert(fullAgain.rules[0].parameters.required_approving_review_count === 0 && fullAgain.bypass_actors.length === 0, 'full to merge to full converges');
  assert(backToMerge.rules[0].parameters.required_approving_review_count === 1 && backToMerge.bypass_actors.length === 1, 'merge transition restores only human PR bypass');
  assert(buildPayload({ ...protect, bypass_actors: admin }, 'full').bypass_actors.length === 0, 'protect payload strips all bypass actors');

  const committedProtect = JSON.parse(readFileSync(new URL('../rulesets/protect-main.json', import.meta.url), 'utf8'));
  const committedApproval = JSON.parse(readFileSync(new URL('../rulesets/approval-main.json', import.meta.url), 'utf8'));
  const contexts = committedProtect.rules.find((entry) => entry.type === 'required_status_checks').parameters.required_status_checks.map((entry) => entry.context);
  assert(committedProtect.rules.some((entry) => entry.type === 'required_signatures'), 'protect-main keeps required signatures');
  assert(committedProtect.rules.find((entry) => entry.type === 'pull_request').parameters.required_approving_review_count === 0, 'protect-main carries zero approval count');
  assert(committedProtect.bypass_actors.length === 0, 'committed protect-main has no bypass actors');
  assert(contexts.includes('test') && contexts.includes('security / secrets') && !contexts.includes('all-checks'), 'existing hard checks remain and no unreported aggregate is required');
  assert(committedApproval.rules.length === 1 && committedApproval.rules[0].type === 'pull_request', 'approval-main contains only the approval rule');
}

function mockedApi(meta, calls) {
  return (args) => {
    calls.push(args);
    const path = args.find((part) => typeof part === 'string' && part.startsWith('repos/'));
    if (args[0] === '-X' && args[1] === 'PATCH') return { ok: true, value: null };
    if (path?.endsWith('/vulnerability-alerts')) return { ok: true, value: null };
    if (path?.endsWith('/automated-security-fixes')) return { ok: true, value: { enabled: true } };
    if (path?.endsWith('/topics')) return { ok: true, value: { names: ['simpsonm09-org'] } };
    return { ok: true, value: meta };
  };
}

function settingsApi(meta, outcomes, calls) {
  return (args) => {
    calls.push(args);
    if (isPatchRequest(args)) return settingsApiPatch(args, outcomes);
    return settingsApiRead(meta, args);
  };
}

function isPatchRequest(args) {
  return args[0] === '-X' && args[1] === 'PATCH';
}

function settingsApiPatch(args, outcomes) {
  const isAutoMerge = args.includes('allow_auto_merge=true') || args.includes('allow_auto_merge=false');
  return outcomes[isAutoMerge ? 'autoMerge' : 'settings'] ?? { ok: true, value: null };
}

function settingsApiRead(meta, args) {
  if (meta === null) return { ok: false, error: 'metadata unavailable' };
  const endpoint = args.at(-1);
  if (meta === 'unreadable' && endpoint === 'repos/simpsonm09-org/example') return { ok: true, value: null };
  if (endpoint?.endsWith('/vulnerability-alerts')) return { ok: true, value: null };
  if (endpoint?.endsWith('/automated-security-fixes')) return { ok: true, value: { enabled: true } };
  if (endpoint?.endsWith('/topics')) return { ok: true, value: { names: ['simpsonm09-org'] } };
  return { ok: true, value: meta };
}

function testAutoMergeSettings() {
  const desiredSettings = {
    delete_branch_on_merge: true,
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
    visibility: 'private',
    allow_auto_merge: false,
  };
  const dryCalls = [];
  const dry = applySettings('simpsonm09-org/example', { topics: [], allowAutoMerge: true }, false, mockedApi(desiredSettings, dryCalls));
  assert(dry.errors.length === 0, 'dry run reports no errors');
  assert(dry.changes.includes('simpsonm09-org/example allow_auto_merge -> true'), 'explicit auto-merge on is reported');
  assert(!dryCalls.some((args) => args[0] === '-X' && args[1] === 'PATCH'), 'dry run does not write');

  const applyCalls = [];
  const applied = applySettings('simpsonm09-org/example', { topics: [], allowAutoMerge: true }, true,
    mockedApi({ ...desiredSettings, delete_branch_on_merge: false }, applyCalls));
  const patches = applyCalls.filter((args) => args[0] === '-X' && args[1] === 'PATCH');
  const settingsPatch = patches.find((args) => args.includes('delete_branch_on_merge=true'));
  const autoMergePatch = patches.find((args) => args.includes('allow_auto_merge=true'));
  assert(applied.errors.length === 0 && settingsPatch && autoMergePatch, 'explicit apply sends both settings groups through API port');
  assert(!settingsPatch.includes('allow_auto_merge=true') && autoMergePatch.length === 5, 'auto-merge uses a separate PATCH');

  const offCalls = [];
  applySettings('simpsonm09-org/example', { topics: [], allowAutoMerge: false }, true,
    mockedApi({ ...desiredSettings, allow_auto_merge: true }, offCalls));
  const offPatch = offCalls.find((args) => args[0] === '-X' && args[1] === 'PATCH');
  assert(offPatch?.includes('allow_auto_merge=false'), 'explicit off is honored');

  const noPolicyCalls = [];
  const noPolicy = applySettings('simpsonm09-org/example', { topics: [] }, false,
    mockedApi({ ...desiredSettings, allow_auto_merge: true }, noPolicyCalls));
  assert(!noPolicy.changes.some((change) => change.includes('allow_auto_merge')), 'unspecified setting is not inferred or changed');

  const unsupportedCalls = [];
  const unsupportedApi = mockedApi({ ...desiredSettings, delete_branch_on_merge: false }, unsupportedCalls);
  const unsupported = applySettings('simpsonm09-org/example', { topics: [], allowAutoMerge: true }, true,
    (args) => args.includes('allow_auto_merge=true')
      ? { ok: false, error: 'auto-merge is not available on this plan' }
      : unsupportedApi(args));
  assert(unsupported.errors.some((error) => error.includes('not available on this plan')), 'unsupported plan response is surfaced');
  assert(unsupported.errors.some((error) => error.includes('other settings were handled independently')),
    'auto-merge rejection reports the partial outcome');
  const unaffectedSettingsPatch = unsupportedCalls.find((args) => args[0] === '-X' && args[1] === 'PATCH');
  assert(unaffectedSettingsPatch?.includes('delete_branch_on_merge=true') && !unaffectedSettingsPatch.includes('allow_auto_merge=true'),
    'auto-merge rejection does not couple unrelated settings to its PATCH');

  for (const [settingsResult, autoResult, label] of [
    [{ ok: false, error: 'settings rejected' }, { ok: true, value: null }, 'first fails, second succeeds'],
    [{ ok: true, value: null }, { ok: false, error: 'auto-merge rejected' }, 'first succeeds, second fails'],
    [{ ok: false, error: 'settings rejected' }, { ok: false, error: 'auto-merge rejected' }, 'both fail'],
    [{ ok: true, value: null }, { ok: true, value: null }, 'both succeed'],
  ]) {
    const calls = [];
    const outcomes = applySettings('simpsonm09-org/example', { topics: [], allowAutoMerge: true }, true,
      settingsApi({ ...desiredSettings, delete_branch_on_merge: false }, { settings: settingsResult, autoMerge: autoResult }, calls));
    const patches = calls.filter((args) => args[0] === '-X' && args[1] === 'PATCH');
    assert(patches.length === 2 && patches[0].includes('delete_branch_on_merge=true')
      && patches[1].includes('allow_auto_merge=true'), `${label}: both independent PATCHes are attempted`);
    assert(outcomes.errors.some((error) => error.includes('settings rejected')) === !settingsResult.ok,
      `${label}: settings result is reported accurately`);
    assert(outcomes.errors.some((error) => error.includes('auto-merge rejected')) === !autoResult.ok,
      `${label}: auto-merge result is reported accurately`);
    assert(outcomes.changes.includes('simpsonm09-org/example delete_branch_on_merge -> true') === settingsResult.ok,
      `${label}: settings change is reported only after success`);
    assert(outcomes.changes.includes('simpsonm09-org/example allow_auto_merge -> true') === autoResult.ok,
      `${label}: auto-merge change is reported only after success`);
  }

  const metadataFailureCalls = [];
  const metadataFailure = applySettings('simpsonm09-org/example', { topics: [], allowAutoMerge: true }, true,
    settingsApi(null, {}, metadataFailureCalls));
  assert(metadataFailure.errors.some((error) => error.includes('settings') && error.includes('metadata unavailable'))
    && metadataFailure.errors.some((error) => error.includes('allow_auto_merge') && error.includes('metadata unavailable')),
  'metadata read failure reports both requested settings as unavailable');
  assert(!metadataFailureCalls.some((args) => args[0] === '-X' && args[1] === 'PATCH'),
    'metadata read failure does not write without current settings');

  const malformedMetadataCalls = [];
  const malformedMetadata = applySettings('simpsonm09-org/example', { topics: [], allowAutoMerge: true }, true,
    settingsApi('unreadable', {}, malformedMetadataCalls));
  assert(malformedMetadata.errors.some((error) => error.includes('settings metadata') && error.includes('unreadable metadata response body'))
    && malformedMetadata.errors.some((error) => error.includes('allow_auto_merge metadata') && error.includes('unreadable metadata response body')),
  'empty metadata body explicitly makes both requested settings unavailable');
  assert(!malformedMetadataCalls.some((args) => args[0] === '-X' && args[1] === 'PATCH'),
    'empty metadata body does not write without current settings');
}

function mockGhSource() {
  return `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const scenario = process.env.POLICY_SCENARIO;
if (process.env.POLICY_CALL_LOG) appendFileSync(process.env.POLICY_CALL_LOG, args.join(' ') + '\\n');
function fail(message) { process.stderr.write(message); process.exit(1); }
if (args[0] === '--version') {
  if (scenario === 'missing-gh') fail('gh is unavailable in this fixture');
  process.stdout.write('gh mock\\n'); process.exit(0);
}
const endpoint = args.at(-1);
if (endpoint === 'repos/simpsonm09-org/example') {
  if (scenario === 'metadata-error') fail('mock metadata failure');
  if (scenario === 'metadata-empty') process.exit(0);
  if (scenario === 'metadata-null') { process.stdout.write('null'); process.exit(0); }
  if (scenario === 'metadata-array') { process.stdout.write('[]'); process.exit(0); }
  if (scenario === 'metadata-scalar') { process.stdout.write('7'); process.exit(0); }
  process.stdout.write(JSON.stringify({ visibility: scenario === 'private' ? 'private' : 'public', default_branch: 'main', description: 'fixture' }));
} else if (endpoint === 'repos/simpsonm09-org/example/topics') {
  process.stdout.write(JSON.stringify({ names: ['simpsonm09-org'] }));
} else if (endpoint === 'repos/simpsonm09-org/example/rulesets') {
  if (scenario === 'ruleset-list-error') fail('mock ruleset list failure');
  if (scenario === 'ruleset-list-empty') process.exit(0);
  if (scenario === 'ruleset-list-null') { process.stdout.write('null'); process.exit(0); }
  if (scenario === 'ruleset-list-object') { process.stdout.write('{}'); process.exit(0); }
  if (scenario === 'ruleset-list-array') { process.stdout.write('[{}]'); process.exit(0); }
  process.stdout.write(JSON.stringify([[{ id: 1, name: 'protect-main' }, { id: 2, name: 'approval-main' }]]));
} else if (endpoint.endsWith('/rulesets/1') || endpoint.endsWith('/rulesets/2')) {
  if (scenario === 'detail-error' && endpoint.endsWith('/rulesets/2')) fail('mock detail failure');
  const approval = endpoint.endsWith('/rulesets/2');
  const malformed = approval ? scenario.replace('approval-', '') : scenario.replace('protect-', '');
  if (malformed === 'detail-empty') process.exit(0);
  if (malformed === 'detail-null') { process.stdout.write('null'); process.exit(0); }
  if (malformed === 'detail-array') { process.stdout.write('[]'); process.exit(0); }
  if (malformed === 'detail-scalar') { process.stdout.write('7'); process.exit(0); }
  if (scenario === 'missing-required-checks' && !approval) {
    process.stdout.write(JSON.stringify({ name: 'protect-main', target: 'branch', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } }, bypass_actors: [],
      rules: [{ type: 'required_signatures' }, { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
        { type: 'required_status_checks', parameters: { required_status_checks: [] } }],
    }));
    process.exit(0);
  }
  if (scenario === 'null-approval-rule' && approval) {
    process.stdout.write(JSON.stringify({ name: 'approval-main', target: 'branch', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      bypass_actors: [{ actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'pull_request' }],
      rules: [null],
    }));
    process.exit(0);
  }
  if (scenario === 'broken-hard-protection' && !approval) {
    process.stdout.write(JSON.stringify({ name: 'protect-main', target: 'tag', enforcement: 'disabled',
      conditions: { ref_name: { include: ['refs/heads/release'], exclude: [] } },
      bypass_actors: [{ actor_type: 'Integration', actor_id: 9, bypass_mode: 'always' }],
      rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [] } }],
    }));
    process.exit(0);
  }
  const bypassActors = approval ? [{ actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'pull_request' }] : [];
  if (scenario === 'nonempty-protect-bypass' && !approval) bypassActors.push({ actor_id: 9, actor_type: 'Integration', bypass_mode: 'always' });
  const response = {
    name: approval ? 'approval-main' : 'protect-main', target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    ...(scenario !== (approval ? 'omit-approval-bypass' : 'omit-protect-bypass')
      ? { bypass_actors: scenario === 'invalid-protect-bypass' && !approval ? null : bypassActors } : {}),
    rules: approval
      ? [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }]
      : [{ type: 'required_signatures' }, { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
        { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
          required_status_checks: ['lint / flint', 'aislop / aislop', 'security / trivy', 'security / secrets', 'standard / standard', 'test', 'coverage / coverage'].map((context) => ({ context })) } }],
  };
  process.stdout.write(JSON.stringify(response));
} else fail('unexpected mock endpoint: ' + endpoint);
`;
}

function makeGhFixture(directory) {
  const source = join(directory, 'gh.mjs');
  writeFileSync(source, mockGhSource());
  if (process.platform === 'win32') {
    writeFileSync(join(directory, 'gh.cmd'), `@"${process.execPath}" "${source}" %*\r\n`);
    return;
  }
  const executable = join(directory, 'gh');
  writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${source}" "$@"\n`);
  chmodSync(executable, 0o755);
}

function runCheckRepoCli(args, path, scenario = '', repo = true) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = [path, process.env.PATH ?? process.env.Path].filter(Boolean).join(delimiterForPath());
  env.POLICY_SCENARIO = scenario;
  const callLog = join(path, `gh-calls-${scenario || 'default'}.txt`);
  env.POLICY_CALL_LOG = callLog;
  env.PATHEXT = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  delete env.GITHUB_REPOSITORY;
  const identityRoot = join(path, 'identity-root');
  if (!repo) mkdirSync(identityRoot, { recursive: true });
  const commandArgs = ['scripts/check-repo.mjs', repo ? '.' : identityRoot,
    ...(repo ? ['--repo', 'simpsonm09-org/example'] : []), ...args];
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, env,
  });
  result.fixtureCalls = existsSync(callLog) ? readFileSync(callLog, 'utf8') : '';
  return result;
}

function delimiterForPath() {
  return process.platform === 'win32' ? ';' : ':';
}

function expectPolicyGap(result, label, reason) {
  const count = (result.stdout.match(/gap ruleset\/approval-policy:/g) ?? []).length;
  assert(result.status === 1 && count === 1 && result.stdout.includes(reason),
    `${label} must fail with exactly one approval-policy gap containing ${reason}; got exit ${result.status}:\n${result.stdout}${result.stderr}\nfixture calls: ${result.fixtureCalls}`);
}

function testRequiredContextsBothModes(bin, level) {
  const withLevel = runCheckRepoCli(level, bin, 'missing-required-checks');
  assert(withLevel.status === 1 && withLevel.stdout.includes('gap ruleset/required-missing:'),
    'valid explicit level still reports hard protect-main missing required contexts');
  const withoutLevel = runCheckRepoCli([], bin, 'missing-required-checks');
  assert(withoutLevel.status === 1
    && (withoutLevel.stdout.match(/gap ruleset\/required-missing:/g) ?? []).length === 7,
  'without a level, the same corrupt required contexts produce all seven required-missing gaps and fail');
}

function testNullApprovalRuleBothModes(bin, level) {
  const cases = [
    { args: [], id: 'ruleset/approval-rule', reason: 'approval-main must contain exactly one pull_request rule', label: 'without a level' },
    { args: level, id: 'ruleset/approval-policy', reason: 'approval-main expected one pull_request rule, found 0', label: 'with a level' },
  ];
  for (const { args, id, reason, label } of cases) {
    const result = runCheckRepoCli(args, bin, 'null-approval-rule');
    const expectedGap = `  gap ${id}: ${reason}`;
    const reportedGaps = result.stdout.split(/\r?\n/).filter((line) => line.startsWith('  gap '));
    assert(result.status === 1 && reportedGaps.length === 1 && reportedGaps[0] === expectedGap
      && result.stdout.includes('standard: failed') && !result.stderr.includes('TypeError'),
    `null approval rule ${label} reports its expected gap and fails cleanly; got exit ${result.status}:\n${result.stdout}${result.stderr}`);
  }
}

function testBypassVisibilityBothModes(bin, level) {
  for (const [scenario, name] of [
    ['omit-protect-bypass', 'protect-main'],
    ['omit-approval-bypass', 'approval-main'],
  ]) {
    const noLevel = runCheckRepoCli([], bin, scenario);
    assert(noLevel.status === 0 && noLevel.stdout.includes(`cannot verify ${name} bypass actors: GitHub omitted bypass_actors`)
      && noLevel.stdout.includes('UNVERIFIED')
      && noLevel.stdout.includes('standard: ok (ruleset bypass visibility unverified)')
      && !noLevel.stdout.includes('gap ruleset/protect-bypass')
      && !noLevel.stdout.includes('gap ruleset/approval-policy'),
    `omitted ${name} bypass_actors is explicitly unverified without a level; got exit ${noLevel.status}:\n${noLevel.stdout}${noLevel.stderr}`);
    const explicit = runCheckRepoCli(level, bin, scenario);
    assert(explicit.status === 1 && explicit.stdout.includes('gap ruleset/approval-policy:')
      && explicit.stdout.includes(`${name} bypass actors are unreadable`),
    `omitted ${name} bypass_actors fails closed with an explicit level`);
  }
  for (const scenario of ['invalid-protect-bypass', 'nonempty-protect-bypass']) {
    const result = runCheckRepoCli([], bin, scenario);
    assert(result.status === 1 && result.stdout.includes('gap ruleset/protect-bypass:'),
      `readable ${scenario === 'invalid-protect-bypass' ? 'invalid' : 'nonempty'} protect-main bypass_actors remains a hard gap without a level`);
  }
}

function testCheckRepoCliFailures() {
  const fixture = mkdtempSync(join(tmpdir(), 'check-repo-cli-'));
  try {
    const bin = join(fixture, 'bin');
    mkdirSync(bin);
    makeGhFixture(bin);
    const level = ['--agent-level', 'merge'];
    expectPolicyGap(runCheckRepoCli(level, bin, 'missing-gh'), 'gh missing', 'gh is not on PATH');
    const noLevelMissing = runCheckRepoCli([], bin, 'missing-gh');
    assert(noLevelMissing.stdout.includes('notice: gh is not on PATH')
      && !noLevelMissing.stdout.includes('gap ruleset/approval-policy'), 'missing gh without an explicit level is notice only');
    const noLevelReadFailure = runCheckRepoCli([], bin, 'detail-error');
    assert(noLevelReadFailure.status === 0 && noLevelReadFailure.stdout.includes('notice: cannot read approval-main:')
      && !noLevelReadFailure.stdout.includes('gap ruleset/approval-policy'),
    'API read failure without an explicit level remains notice only');
    expectPolicyGap(runCheckRepoCli([...level, '--no-api'], bin), '--no-api', 'API checks were disabled');
    for (const [scenario, label, reason] of [
      ['metadata-error', 'metadata read failure', 'cannot read repository metadata'],
      ['private', 'private repository', 'unsupported for private repositories'],
      ['ruleset-list-error', 'ruleset list failure', 'cannot read ruleset list'],
      ['detail-error', 'ruleset detail failure', 'cannot read approval-main detail'],
    ]) {
      const result = runCheckRepoCli(level, bin, scenario);
      expectPolicyGap(result, label, reason);
      assert(result.fixtureCalls.includes('repos/simpsonm09-org/example'), `${label} fixture proves gh was invoked`);
    }
    const missingIdentity = runCheckRepoCli(level, bin, 'success', false);
    expectPolicyGap(missingIdentity, 'missing identity', 'repository identity could not be determined');
    const success = runCheckRepoCli(level, bin, 'success');
    assert(success.status === 0 && !success.stdout.includes('gap ruleset/approval-policy')
      && !success.stdout.includes('gap ruleset/required-missing') && !success.stdout.includes('notice: cannot read'),
    'a valid explicit-level API audit passes with hard checks present');
    const successWithoutLevel = runCheckRepoCli([], bin, 'success');
    assert(successWithoutLevel.stdout.includes('approval-main approval count and bypass actors were not compared')
      && !successWithoutLevel.stdout.includes('gap ruleset/approval-policy'), 'successful API read without a level remains notice only');
    testBypassVisibilityBothModes(bin, level);
    const noLevelNoApi = runCheckRepoCli(['--no-api'], bin);
    assert(!noLevelNoApi.stdout.includes('gap ruleset/approval-policy'), 'no-level --no-api does not add a policy gap');
    const invalid = runCheckRepoCli(['--agent-level', 'bogus'], bin, 'success');
    assert(invalid.status === 1 && (invalid.stdout.match(/gap ruleset\/approval-policy:/g) ?? []).length === 1,
      'unsupported level reports one gap');
    const invalidWithoutApi = runCheckRepoCli(['--agent-level', 'bogus', '--no-api'], bin);
    assert(invalidWithoutApi.status === 1 && (invalidWithoutApi.stdout.match(/gap ruleset\/approval-policy:/g) ?? []).length === 1,
      'unsupported level with API disabled does not duplicate its gap');
    for (const scenario of ['approval-detail-empty', 'approval-detail-null', 'approval-detail-array', 'approval-detail-scalar',
      'protect-detail-empty', 'protect-detail-null', 'protect-detail-array', 'protect-detail-scalar',
      'metadata-empty', 'metadata-null', 'metadata-array', 'metadata-scalar',
      'ruleset-list-empty', 'ruleset-list-null', 'ruleset-list-object', 'ruleset-list-array']) {
      const levelResult = runCheckRepoCli(level, bin, scenario);
      expectPolicyGap(levelResult, `${scenario} explicit`, `cannot read`);
      assert(levelResult.fixtureCalls.includes('repos/simpsonm09-org/example'), `${scenario} explicit fixture proves gh was invoked`);
      const noticeResult = runCheckRepoCli([], bin, scenario);
      assert(noticeResult.status === 0 && noticeResult.stdout.includes('notice: cannot read'),
        `${scenario} without a level remains notice-only and succeeds`);
    }
    testRequiredContextsBothModes(bin, level);
    testNullApprovalRuleBothModes(bin, level);
    const brokenHardChecks = runCheckRepoCli(level, bin, 'broken-hard-protection');
    for (const id of ['ruleset/enforcement', 'ruleset/main-target', 'ruleset/required-missing',
      'ruleset/required-strict', 'ruleset/protect-rule', 'ruleset/protect-signatures', 'ruleset/protect-bypass']) {
      assert(brokenHardChecks.status === 1 && brokenHardChecks.stdout.includes(`gap ${id}:`),
        `valid explicit level retains the ${id} hard check`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

export function runTest() {
  try {
    testRulesets();
    testCheckRepoCliFailures();
    testAutoMergeSettings();
    process.stdout.write('ruleset-policy: all assertions passed\n');
    return EXIT.OK;
  } catch (error) {
    process.stderr.write(`ruleset-policy: ${error.message}\n`);
    return EXIT.FAIL;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(runTest());

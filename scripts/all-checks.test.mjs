import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStandard } from './check-standard.mjs';
import { allChecksGaps, codeownersGaps, needsSucceeded } from './lib/all-checks.mjs';
import { EXIT } from './lib/exit.mjs';
import { isMain } from './lib/proc.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const base = ['lint', 'aislop', 'security', 'standard', 'coverage', 'test'];
const validBlock = [
  '    if: always()',
  `    needs: [${base.join(', ')}]`,
  '    runs-on: ubuntu-24.04',
  '    timeout-minutes: 5',
  '    permissions: {}',
  '    steps:',
  '      - name: Require every job to succeed',
  '        env:',
  `          NEEDS: \${{ toJSON(needs) }}`,
  `        run: echo "$NEEDS" | jq -e 'all(.[]; .result == "success")'`,
];

export function runTest() {
  const jobs = new Map([...base, 'all-checks'].map((name) => [name, name === 'all-checks' ? validBlock : []]));
  assert(allChecksGaps(jobs).length === 0, 'accept a complete caller aggregate');
  assert(allChecksGaps(new Map([...jobs].filter(([name]) => name !== 'test'))).some((gap) => gap.message.includes('every other CI job')), 'reject an omitted dependency');
  const newPlatform = new Map([...jobs, ['test-linux', []]]);
  assert(allChecksGaps(newPlatform).some((gap) => gap.message.includes('test-linux')), 'require a newly declared platform job');
  const withPlatforms = new Map([...base, 'test-windows', 'test-macos', 'all-checks'].map((name) => [name, name === 'all-checks' ? [...validBlock.slice(0, 1), `    needs: [${[...base, 'test-windows', 'test-macos'].join(', ')}]`, ...validBlock.slice(2)] : []]));
  assert(allChecksGaps(withPlatforms).length === 0, 'include both standard portability jobs');

  const unsafeIf = new Map(jobs).set('all-checks', validBlock.map((line) => line.replace('if: always()', 'if: success()')));
  assert(allChecksGaps(unsafeIf).some((gap) => gap.message.includes('if: always()')), 'reject conditional aggregate execution');
  const unsafeRun = new Map(jobs).set('all-checks', validBlock.map((line) => line.replace("all(.[]; .result == \"success\")", 'true')));
  assert(allChecksGaps(unsafeRun).some((gap) => gap.message.includes('jq all-needs-success')), 'reject an unsafe run check');
  const continuation = new Map(jobs).set('test', ['    continue-on-error: true']);
  assert(allChecksGaps(continuation).some((gap) => gap.message.includes('continue-on-error')), 'reject dependency continue-on-error');
  const aggregateContinuation = new Map(jobs).set('all-checks', [...validBlock, '    continue-on-error: true']);
  assert(allChecksGaps(aggregateContinuation).some((gap) => gap.message.includes('continue-on-error')), 'reject aggregate continue-on-error');
  const dynamicContinuation = new Map(jobs).set('test', [`    continue-on-error: \${{ inputs.allowFailure }}`]);
  assert(allChecksGaps(dynamicContinuation).some((gap) => gap.message.includes('continue-on-error')), 'reject unknown continue-on-error expressions');

  const dependencies = base.map((name) => name);
  const success = Object.fromEntries(dependencies.map((name) => [name, { result: 'success' }]));
  assert(needsSucceeded(success, dependencies), 'accept all successful dependency results');
  for (const result of ['failure', 'skipped', 'cancelled']) {
    assert(!needsSucceeded({ ...success, test: { result } }, dependencies), `reject ${result} dependency`);
  }
  const missing = { ...success };
  delete missing.test;
  assert(!needsSucceeded(missing, dependencies), 'reject a missing dependency result');

  assert(codeownersGaps('* @simpsonm09\n/docs/ @docs-team\n').length === 0, 'allow specific routes and additional owners');
  assert(codeownersGaps('/src/ @team\n').length === 1, 'require a default owner');
  assert(codeownersGaps('* @someone\n').length === 1, 'require the fleet default owner');

  const root = mkdtempSync(join(tmpdir(), 'all-checks-contract-'));
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), `jobs:\n${base.map((name) => `  ${name}:\n    runs-on: ubuntu-24.04`).join('\n')}\n`);
  writeFileSync(join(root, 'CODEOWNERS'), '* @someone\n');
  const integrated = checkStandard(root).gaps.map((gap) => gap.id);
  rmSync(root, { recursive: true, force: true });
  assert(integrated.includes('ci/all-checks'), 'check-standard enforces aggregate closure');
  assert(integrated.includes('community/CODEOWNERS'), 'check-standard enforces the fleet default owner');
  process.stdout.write('all-checks and CODEOWNERS contracts: ok\n');
  return EXIT.OK;
}

if (isMain(import.meta.url)) process.exit(runTest());

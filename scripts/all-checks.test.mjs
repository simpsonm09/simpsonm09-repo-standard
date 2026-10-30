import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStandard } from './check-standard.mjs';
import { allChecksGaps, codeownersGaps, needsSucceeded } from './lib/all-checks.mjs';
import { parseJobs } from './lib/ci.mjs';
import { EXIT } from './lib/exit.mjs';
import { isMain } from './lib/proc.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertGap(gaps, message, label) {
  assert(gaps.some((gap) => gap.id === 'ci/all-checks' && gap.message.includes(message)), label);
}

function assertCodeownersGap(text, message, label) {
  assert(codeownersGaps(text).some((gap) => gap.id === 'community/CODEOWNERS' && gap.message.includes(message)), label);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  assert(allChecksGaps(jobs, { required: false }).length === 0, 'accept a complete caller aggregate while readiness is off');
  for (const file of ['.github/workflows/ci.yml', 'templates/caller-ci.yml']) {
    const workflowText = readFileSync(join(ROOT, file), 'utf8');
    assert(allChecksGaps(parseJobs(workflowText), { required: false, workflowText }).length === 0, `accept checked-in ${file} aggregate`);
  }
  const benignFormatting = validBlock.map((line) => line
    .replace('    if: always()', '    if : always() # required')
    .replace('      - name:', '      -   name:')
    .replace(`        run: echo "$NEEDS" | jq -e 'all(.[]; .result == "success")'`, `        run: echo "$NEEDS" | jq -e 'all(.[]; .result == "success")' # pinned`));
  assert(allChecksGaps(new Map(jobs).set('all-checks', benignFormatting), { required: false }).length === 0, 'accept safely parsed spacing and comments around the pinned shape');
  assert(allChecksGaps(new Map(), { required: false }).length === 0, 'allow an absent aggregate before readiness rollout');
  assert(allChecksGaps(new Map(), { required: true }).some((gap) => gap.message.includes('no "all-checks"')), 'require the aggregate after readiness is enabled');
  assert(allChecksGaps(new Map([...jobs].filter(([name]) => name !== 'test')), { required: false }).some((gap) => gap.message.includes('every other CI job')), 'reject an omitted dependency');
  const newPlatform = new Map([...jobs, ['test-linux', []]]);
  assert(allChecksGaps(newPlatform, { required: false }).some((gap) => gap.message.includes('test-linux')), 'require a newly declared platform job');
  const withPlatforms = new Map([...base, 'test-windows', 'test-macos', 'all-checks'].map((name) => [name, name === 'all-checks' ? [...validBlock.slice(0, 1), `    needs: [${[...base, 'test-windows', 'test-macos'].join(', ')}]`, ...validBlock.slice(2)] : []]));
  assert(allChecksGaps(withPlatforms, { required: false }).length === 0, 'include both standard portability jobs');

  const unsafeIf = new Map(jobs).set('all-checks', validBlock.map((line) => line.replace('if: always()', 'if: success()')));
  assert(allChecksGaps(unsafeIf, { required: false }).some((gap) => gap.message.includes('if: always()')), 'reject the default success condition that skips the aggregate after a failed dependency');
  const defaultIf = new Map(jobs).set('all-checks', validBlock.filter((line) => !line.includes('if:')));
  assert(allChecksGaps(defaultIf, { required: false }).some((gap) => gap.message.includes('if: always()')), 'reject an omitted if condition that defaults to success');
  for (const [description, stepKey] of [['false first-key step', '      - if: false'], ['continue-on-error first-key step', '      - continue-on-error: true']]) {
    const changed = validBlock.map((line) => line === '      - name: Require every job to succeed' ? stepKey : line);
    const message = stepKey.includes('if:') ? 'conditionally skip' : 'continue-on-error';
    assertGap(allChecksGaps(new Map(jobs).set('all-checks', changed), { required: false }), message, `reject ${description} with its named reason`);
  }
  for (const [description, line, message] of [
    ['quoted inline step if', '      - "if": false', 'unsupported YAML key spelling for "if"'],
    ['spaced inline step if', '      -   if : false', 'conditionally skip'],
    ['quoted step if', '        "if": false', 'unsupported YAML key spelling for "if"'],
    ['spaced step if', '        if : false', 'conditionally skip'],
    ['quoted job if', '    "if": always()', 'unsupported YAML key spelling for "if"'],
    ['spaced job if', '    if : success()', 'if: always()'],
  ]) {
    const changed = validBlock.filter((entry) => !entry.trimStart().startsWith('if:'));
    const withVariant = [...changed, line];
    assertGap(allChecksGaps(new Map(jobs).set('all-checks', withVariant), { required: false }), message, `reject ${description}`);
  }
  const normalConditional = new Map(jobs).set('all-checks', [...validBlock, '        if: false']);
  assert(allChecksGaps(normalConditional, { required: false }).some((gap) => gap.message.includes('conditionally skip')), 'reject normal step if false');
  const normalStepContinuation = new Map(jobs).set('all-checks', [...validBlock, '        continue-on-error: true']);
  assert(allChecksGaps(normalStepContinuation, { required: false }).some((gap) => gap.message.includes('continue-on-error')), 'reject normal step continue-on-error');
  const needsInput = ['NEEDS: $', '{{ toJSON(needs) }}'].join('');
  const otherNeedsInput = ['NEEDS: $', '{{ toJSON(inputs.needs) }}'].join('');
  const unsafeNeedsEnv = new Map(jobs).set('all-checks', validBlock.map((line) => line.replace(needsInput, otherNeedsInput)));
  assertGap(allChecksGaps(unsafeNeedsEnv, { required: false }), 'set only NEEDS to $' + '{{ toJSON(needs) }}', 'require the actual needs object as jq input');
  const unsafeRun = new Map(jobs).set('all-checks', validBlock.map((line) => line.replace("all(.[]; .result == \"success\")", 'true')));
  assert(allChecksGaps(unsafeRun, { required: false }).some((gap) => gap.message.includes('jq all-needs-success')), 'reject an unsafe run check');
  const continuation = new Map(jobs).set('test', ['    continue-on-error: true']);
  assertGap(allChecksGaps(continuation, { required: false }), 'continue-on-error', 'reject dependency continue-on-error');
  for (const [description, line] of [
    ['quoted job-level', '    "continue-on-error": true'],
    ['spaced job-level', '    continue-on-error : true'],
    ['quoted step-level', '        "continue-on-error": true'],
    ['spaced step-level', '        continue-on-error : true'],
    ['quoted inline step-level', '      - "continue-on-error": true'],
    ['spaced inline step-level', '      -   continue-on-error : true'],
  ]) {
    const changed = new Map(jobs).set('test', [...(line.startsWith('    ') ? [] : ['      - name: Dependency step']), line]);
    assertGap(allChecksGaps(changed, { required: false }), 'continue-on-error', `reject ${description} continue-on-error on dependency jobs`);
  }
  for (const [description, line, reason] of [
    ['quoted aggregate job-level', '    "continue-on-error": true', 'unsupported YAML key spelling for "continue-on-error"'],
    ['spaced aggregate job-level', '    continue-on-error : true', 'unsupported job-level key "continue-on-error"'],
    ['quoted aggregate step-level', '        "continue-on-error": true', 'unsupported YAML key spelling for "continue-on-error"'],
    ['spaced aggregate step-level', '        continue-on-error : true', 'continue-on-error'],
  ]) {
    assertGap(allChecksGaps(new Map(jobs).set('all-checks', [...validBlock, line]), { required: false }), reason, `reject ${description} continuation`);
  }
  const aggregateContinuation = new Map(jobs).set('all-checks', [...validBlock, '    continue-on-error: true']);
  assert(allChecksGaps(aggregateContinuation, { required: false }).some((gap) => gap.message.includes('continue-on-error')), 'reject aggregate continue-on-error');
  const dynamicContinuation = new Map(jobs).set('test', [`    continue-on-error: \${{ inputs.allowFailure }}`]);
  assertGap(allChecksGaps(dynamicContinuation, { required: false }), 'continue-on-error', 'reject unknown continue-on-error expressions');
  for (const [description, block] of [
    ['indentless steps', ['    steps:', '    - name: Dependency step', '      run: exit 1', '      continue-on-error: true']],
    ['deeper step keys', ['    steps:', '        - name: Dependency step', '          run: exit 1', '          continue-on-error: true']],
    ['flow-style steps', ['    steps: [{ name: Dependency step, run: exit 1, continue-on-error: true }]']],
  ]) {
    assertGap(allChecksGaps(new Map(jobs).set('test', block), { required: false }), 'continue-on-error', `reject dependency continue-on-error in ${description} with ci/all-checks gap`);
  }

  for (const [key, lines, reason] of [
    ['defaults', ['    defaults:', '      run:', '        shell: /bin/true {0}'], 'unsupported job-level key "defaults"'],
    ['env', ['    env:', '      PATH: /tmp/fake'], 'unsupported job-level key "env"'],
    ['container', ['    container:', '      image: example/fake'], 'unsupported job-level key "container"'],
    ['shell', ['        shell: /bin/true {0}'], 'unsupported key "shell"'],
    ['uses', ['        uses: example/setup@v1'], 'unsupported key "uses"'],
  ]) {
    assertGap(allChecksGaps(new Map(jobs).set('all-checks', [...validBlock, ...lines]), { required: false }), reason, `reject aggregate ${key} override`);
  }
  assertGap(allChecksGaps(new Map(jobs).set('all-checks', [...validBlock, '      - uses: example/setup@v1']), { required: false }), 'exactly one step', 'reject an extra aggregate step');
  assertGap(allChecksGaps(jobs, { required: false, workflowText: 'defaults:\n  run:\n    shell: /bin/true {0}\njobs:\n' }), 'workflow-level "defaults"', 'reject a caller workflow default-shell override');
  assertGap(allChecksGaps(jobs, { required: false, workflowText: 'env:\n  PATH: /tmp/fake\njobs:\n' }), 'workflow-level "env"', 'reject caller workflow environment overrides');
  assertGap(allChecksGaps(jobs, { required: false, workflowText: '"defaults":\n  run:\n    shell: /bin/true {0}\njobs:\n' }), 'workflow-level "defaults"', 'reject quoted caller workflow default-shell key');
  const emptyGraph = new Map([['all-checks', validBlock.map((line) => line.startsWith('    needs:') ? '    needs: []' : line)]]);
  assertGap(allChecksGaps(emptyGraph, { required: false }), 'at least one dependency job', 'reject a vacuous empty needs graph');

  const parsed = parseJobs(`jobs:\n  lint: # standard\n    runs-on: ubuntu-latest\n  "test-macos": # platform\n    needs: lint\n`);
  assert(parsed.has('lint') && parsed.has('test-macos'), 'parse plain and quoted job keys with trailing comments');
  const parsedWithAggregate = parseJobs(`jobs:\n${[...base.map((name) => `  ${name}:\n    runs-on: ubuntu-latest`), '  "test-macos": # platform', '    runs-on: macos-latest', '  all-checks:', '    if: always()', '    needs: [lint, aislop, security, standard, coverage, test]', '    runs-on: ubuntu-24.04', '    timeout-minutes: 5', '    permissions: {}', '    steps:', '      - name: Require every job to succeed', '        env:', '          NEEDS: $' + '{{ toJSON(needs) }}', `        run: echo "$NEEDS" | jq -e 'all(.[]; .result == "success")'`].join('\n')}\n`);
  assert(allChecksGaps(parsedWithAggregate, { required: false }).some((gap) => gap.message.includes('test-macos')), 'require quoted/commented platform jobs in aggregate needs');
  const unsupported = parseJobs('jobs:\n  "unsupported job":\n    runs-on: ubuntu-latest\n  all-checks:\n    needs: [lint]\n');
  assert([...unsupported.keys()].some((name) => name.startsWith('!unsupported-jobs-key-line-')), 'surface unsupported two-space job keys instead of omitting them');
  assert(allChecksGaps(unsupported, { required: false }).some((gap) => gap.message.includes('!unsupported-jobs-key-line-')), 'fail aggregate closure when an unsupported two-space job key is omitted');
  const commentHeading = parseJobs('jobs: # jobs heading\n  lint:\n    runs-on: ubuntu-latest\n');
  assert(commentHeading.has('lint'), 'recognize jobs heading with trailing comment');
  const jobsAfterColumnZeroComment = parseJobs(`jobs:\n${[...base.map((name) => `  ${name}:\n    runs-on: ubuntu-24.04`), `  all-checks:\n${validBlock.join('\n')}`, '# later jobs', '  docs:\n    runs-on: ubuntu-24.04'].join('\n')}\n`);
  assert(jobsAfterColumnZeroComment.has('docs'), 'keep a column-zero comment inside jobs and recognize a following top-level job');
  assertGap(allChecksGaps(jobsAfterColumnZeroComment, { required: false }), 'every other CI job exactly once', 'include a job after a column-zero comment in aggregate closure (ci/all-checks)');
  assert(parseJobs('jobs:\n  lint:\nplain text\n  docs:\n').has('docs'), 'end jobs only at a new top-level mapping, not arbitrary column-zero text');
  const commentBeforeRiskKey = parseJobs('jobs:\n  test:\n    runs-on: ubuntu-latest\n# risk key follows\n    continue-on-error: true\n');
  const commentRiskJobs = new Map(jobs).set('test', commentBeforeRiskKey.get('test'));
  assertGap(allChecksGaps(commentRiskJobs, { required: false }), 'continue-on-error', 'retain dependency keys after a column-zero comment (ci/all-checks)');
  const lfCi = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const crlfCi = lfCi.replace(/\n/g, '\r\n');
  const crlfJobs = parseJobs(crlfCi);
  assert([...crlfJobs.keys()].includes('all-checks'), 'parse all job keys from CRLF ci.yml');
  assert(allChecksGaps(crlfJobs, { required: false, workflowText: crlfCi }).length === 0, 'CRLF ci.yml has the same no-gap result as LF ci.yml');
  assert(parseJobs('\uFEFFjobs:\n  lint:\n').has('lint'), 'recognize a UTF-8 BOM before the jobs heading');
  for (const [label, source, expectedMessage] of [
    ['explicit mapping key', 'jobs:\n  lint:\n    runs-on: ubuntu-latest\n  ? test\n    runs-on: ubuntu-latest\n', 'unsupported explicit key'],
    ['duplicate job key', 'jobs:\n  lint:\n    continue-on-error: true\n  lint:\n    runs-on: ubuntu-latest\n  all-checks:\n    needs: [lint]\n', 'repeats job key "lint"'],
    ['duplicate jobs heading', 'jobs:\n  lint:\n    runs-on: ubuntu-latest\njobs:\n  all-checks:\n    needs: [lint]\n', 'unsupported key or heading'],
    ['whitespace jobs heading', 'jobs :\n  lint:\n', 'unsupported key or heading'],
    ['quoted jobs heading', '"jobs":\n  lint:\n', 'unsupported key or heading'],
    ['inline jobs mapping', 'jobs: { lint: {} }\n', 'unsupported key or heading'],
  ]) {
    const parsedSource = parseJobs(source);
    assertGap(allChecksGaps(parsedSource, { required: false }), expectedMessage, `fail closed on ${label} with a named parse reason`);
  }

  const dependencies = base.map((name) => name);
  const success = Object.fromEntries(dependencies.map((name) => [name, { result: 'success' }]));
  assert(needsSucceeded(success, dependencies), 'accept all successful dependency results');
  for (const result of ['failure', 'skipped', 'cancelled']) {
    assert(!needsSucceeded({ ...success, test: { result } }, dependencies), `reject ${result} dependency`);
  }
  const missing = { ...success };
  delete missing.test;
  assert(!needsSucceeded(missing, dependencies), 'reject a missing dependency result');

  assert(codeownersGaps('* @simpsonm09\n/docs/ @docs-team\n').length === 0, 'allow specific routes');
  assert(codeownersGaps('* @simpsonm09 @other-owner\n').length === 0, 'allow additional default owners');
  assert(codeownersGaps('* @simpsonm09 @other-owner # fleet default\n').length === 0, 'allow trailing comments and tokenized default owners');
  assert(codeownersGaps('/src/ @team\n').length === 1, 'require a default owner');
  assert(codeownersGaps('* @someone\n').length === 1, 'require the fleet default owner');
  assert(codeownersGaps('* @SimpsonM09\n').length === 1, 'require exact fleet owner identity casing');
  assert(codeownersGaps('* @simpsonm09\n* @other-owner\n').length === 1, 'reject multiple default patterns');
  for (const pattern of ['/**', '/*', '**', '**/*', '/**/*']) {
    assertCodeownersGap(`* @simpsonm09\n${pattern} @other-owner\n`, 'broad catch-all', `require fleet owner on overriding ${pattern} catch-all (community/CODEOWNERS)`);
    assert(codeownersGaps(`* @simpsonm09\n${pattern} @simpsonm09 @other-owner\n`).length === 0, `allow fleet owner on ${pattern} catch-all`);
  }
  assert(codeownersGaps('* @simpsonm09\n/src/* @team\n').length === 0, 'allow wildcard routes with a fixed path prefix');

  const root = mkdtempSync(join(tmpdir(), 'all-checks-contract-'));
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), `jobs:\n${base.map((name) => `  ${name}:\n    runs-on: ubuntu-24.04`).join('\n')}\n`);
  writeFileSync(join(root, 'CODEOWNERS'), '* @someone\n');
  const integrated = checkStandard(root).gaps.map((gap) => gap.id);
  assert(!integrated.includes('ci/all-checks'), 'check-standard passes readiness false to allow a missing aggregate');
  assert(integrated.includes('community/CODEOWNERS'), 'check-standard enforces the fleet default owner');
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), `jobs:\n${base.map((name) => `  ${name}:\n    runs-on: ubuntu-24.04`).join('\n')}\n  all-checks:\n    if: success()\n`);
  assert(checkStandard(root).gaps.some((gap) => gap.id === 'ci/all-checks'), 'check-standard still validates a present aggregate while readiness is false');
  writeFileSync(join(root, 'CODEOWNERS'), '* @simpsonm09\n');
  mkdirSync(join(root, '.github'), { recursive: true });
  writeFileSync(join(root, '.github', 'CODEOWNERS'), '* @someone\n');
  assert(checkStandard(root).gaps.some((gap) => gap.message.includes('.github/CODEOWNERS overrides')), 'check the effective GitHub CODEOWNERS override');
  rmSync(root, { recursive: true, force: true });
  process.stdout.write('all-checks and CODEOWNERS contracts: ok\n');
  return EXIT.OK;
}

if (isMain(import.meta.url)) process.exit(runTest());

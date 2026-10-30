// Validate the deliberately small all-checks workflow contract. This is not a
// general YAML parser: only the plain-key shape used by the pinned template is
// accepted, and every other aggregate shape fails closed.
const SAFE_RUN = 'echo "$NEEDS" | jq -e \'all(.[]; .result == "success")\'';
const NEEDS_VALUE = '$' + '{{ toJSON(needs) }}';
const JOB_KEYS = new Set(['if', 'needs', 'runs-on', 'timeout-minutes', 'permissions', 'steps', 'name']);
const STEP_KEYS = new Set(['name', 'env', 'run']);

function stripComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const scan = scanValue(value, index, quote);
    if (scan.comment) return value.slice(0, index).trimEnd();
    quote = scan.quote;
    index += scan.skip;
  }
  return value.trimEnd();
}

function scanValue(value, index, quote) {
  const char = value[index];
  if (quote === '"' && char === '\\') return { quote, skip: 1 };
  if ((char === '"' || char === "'") && (quote === null || quote === char)) {
    return { quote: quote === null ? char : null, skip: 0 };
  }
  const comment = char === '#' && quote === null && (index === 0 || /\s/.test(value[index - 1]));
  return { quote, comment, skip: 0 };
}

function keyLine(line, indent, sequence = false) {
  const prefix = sequence ? ` {${indent}}-[ \\t]+` : ` {${indent}}`;
  const match = new RegExp(`^${prefix}([A-Za-z][A-Za-z0-9-]*)[ \\t]*:[ \\t]*(.*)$`).exec(line);
  return match ? { key: match[1], value: stripComment(match[2]).trim() } : null;
}

function keyCandidate(line, indent, sequence = false) {
  const prefix = sequence ? ` {${indent}}-[ \\t]+` : ` {${indent}}`;
  const match = new RegExp(`^${prefix}(?:"([^"]+)"|'([^']+)'|([A-Za-z][A-Za-z0-9 _-]*))[ \\t]*:`).exec(line);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function classifyAggregateLine(line, state) {
  if (!line.trim() || /^\s*#/.test(line)) return { kind: 'ignored' };
  const job = keyLine(line, 4);
  if (job) return { kind: 'job', entry: job };
  const jobName = keyCandidate(line, 4);
  if (jobName) return { kind: 'bad-job-key', key: jobName };
  const firstStep = keyLine(line, 6, true);
  if (firstStep) return { kind: 'first-step', entry: firstStep };
  const firstStepName = keyCandidate(line, 6, true);
  if (firstStepName) return { kind: 'bad-first-step-key', key: firstStepName };
  const step = keyLine(line, 8);
  if (step && state.stepStarted) return { kind: 'step', entry: step };
  const stepName = keyCandidate(line, 8);
  if (stepName && state.stepStarted) return { kind: 'bad-step-key', key: stepName };
  const env = keyLine(line, 10);
  if (env && state.inEnv) return { kind: 'env', entry: env };
  const envName = keyCandidate(line, 10);
  if (envName && state.inEnv) return { kind: 'bad-env-key', key: envName };
  return { kind: 'unknown' };
}

function recordJob(entry, job, gaps) {
  if (entry.key === 'continue-on-error') gaps.push('all-checks must not use continue-on-error');
  if (!JOB_KEYS.has(entry.key)) {
    gaps.push(`all-checks job has unsupported job-level key "${entry.key}"`);
    return;
  }
  if (job.has(entry.key)) gaps.push(`all-checks job repeats job-level key "${entry.key}"`);
  job.set(entry.key, entry.value);
}

function recordStep(entry, step, gaps, first) {
  if (entry.key === 'if') gaps.push('all-checks must not conditionally skip its verification step');
  if (entry.key === 'continue-on-error') gaps.push('all-checks must not use continue-on-error');
  if (first && entry.key !== 'name') gaps.push(`all-checks step has unsupported first key "${entry.key}"`);
  if (!first && !STEP_KEYS.has(entry.key)) {
    gaps.push(`all-checks step has unsupported key "${entry.key}"`);
    return;
  }
  if (step.has(entry.key)) gaps.push(`all-checks step repeats key "${entry.key}"`);
  step.set(entry.key, entry.value);
}

function recordEnv(entry, env, gaps) {
  if (entry.key !== 'NEEDS') gaps.push(`all-checks step env has unsupported key "${entry.key}"`);
  if (env.has(entry.key)) gaps.push(`all-checks step env repeats key "${entry.key}"`);
  env.set(entry.key, entry.value);
}

function validateParsedShape(aggregate) {
  const gaps = [];
  const job = new Map();
  const step = new Map();
  const env = new Map();
  const state = { stepCount: 0, stepStarted: false, inEnv: false };
  for (const line of aggregate) {
    const parsed = classifyAggregateLine(line, state);
    if (parsed.kind === 'ignored') continue;
    if (parsed.kind === 'job') recordJob(parsed.entry, job, gaps);
    else if (parsed.kind === 'first-step') {
      state.stepCount += 1;
      state.stepStarted = true;
      state.inEnv = false;
      recordStep(parsed.entry, step, gaps, true);
    } else if (parsed.kind === 'step') {
      state.inEnv = parsed.entry.key === 'env';
      recordStep(parsed.entry, step, gaps, false);
    } else if (parsed.kind === 'env') recordEnv(parsed.entry, env, gaps);
    else recordUnrecognized(parsed, gaps);
  }
  return { gaps, job, step, env, stepCount: state.stepCount };
}

function recordUnrecognized(parsed, gaps) {
  const key = parsed.key;
  if (parsed.kind === 'bad-job-key') gaps.push(`all-checks job uses unsupported YAML key spelling for "${key}"`);
  else if (parsed.kind === 'bad-first-step-key' || parsed.kind === 'bad-step-key') gaps.push(`all-checks step uses unsupported YAML key spelling for "${key}"`);
  else if (parsed.kind === 'bad-env-key') gaps.push(`all-checks step env uses unsupported YAML key spelling for "${key}"`);
  else gaps.push('all-checks aggregate contains an unrecognized YAML key or shape');
}

function validateRequiredShape(parsed) {
  const { job, step, env, stepCount } = parsed;
  const gaps = [];
  validateJobRequirements(job, gaps);
  validateStepRequirements(step, env, stepCount, gaps);
  return gaps;
}

function validateJobRequirements(job, gaps) {
  for (const key of JOB_KEYS) {
    if (key === 'name') continue;
    if (!job.has(key)) gaps.push(`all-checks job must declare ${key}`);
  }
  if (job.get('if') !== 'always()') gaps.push('all-checks must declare if: always()');
  if (job.get('runs-on') !== 'ubuntu-24.04') gaps.push('all-checks must declare runs-on: ubuntu-24.04');
  if (job.get('timeout-minutes') !== '5') gaps.push('all-checks must declare timeout-minutes: 5');
  if (job.get('permissions') !== '{}') gaps.push('all-checks must declare permissions: {}');
}

function validateStepRequirements(step, env, stepCount, gaps) {
  if (stepCount !== 1) gaps.push('all-checks must contain exactly one step');
  if (!step.has('name') || !step.get('name')) gaps.push('all-checks step must have a non-empty name');
  if (step.get('env') !== '') gaps.push('all-checks step env must contain only NEEDS');
  if (env.size !== 1 || env.get('NEEDS') !== NEEDS_VALUE) {
    gaps.push(`all-checks step env must set only NEEDS to ${NEEDS_VALUE}`);
  }
  if (step.get('run') !== SAFE_RUN) gaps.push('all-checks must run the pinned jq all-needs-success command');
  if (step.has('if')) gaps.push('all-checks must not conditionally skip its verification step');
  if (step.has('continue-on-error')) gaps.push('all-checks must not use continue-on-error');
}

function validateAggregateShape(aggregate) {
  const parsed = validateParsedShape(aggregate);
  return [...parsed.gaps, ...validateRequiredShape(parsed)];
}

function needsGaps(aggregate, expectedJobs) {
  const gaps = [];
  const needs = aggregate.find((line) => keyLine(line, 4)?.key === 'needs');
  const rawNeeds = needs ? keyLine(needs, 4).value : null;
  const parsedNeeds = rawNeeds?.startsWith('[') && rawNeeds.endsWith(']')
    ? rawNeeds.slice(1, -1).split(',').map((value) => value.trim()).filter(Boolean)
    : null;
  if (!expectedJobs.length) gaps.push('all-checks needs graph must contain at least one dependency job');
  if (!parsedNeeds || parsedNeeds.some((name) => !/^[A-Za-z0-9_.-]+$/.test(name))) {
    gaps.push('all-checks needs must use the supported inline job-name list');
  } else if (new Set(parsedNeeds).size !== parsedNeeds.length || parsedNeeds.length !== expectedJobs.length || expectedJobs.some((name) => !parsedNeeds.includes(name))) {
    gaps.push(`all-checks needs must name every other CI job exactly once (${expectedJobs.join(', ')})`);
  }
  return gaps;
}

function hasContinueOnError(block) {
  return block.some((line) => /["']?continue-on-error["']?[ \t]*:/.test(line));
}

function workflowShapeGaps(workflowText) {
  if (workflowText === undefined) return [];
  const topLevelKey = /^(?:"(defaults|env)"|'(defaults|env)'|(defaults|env))[ \t]*:/m;
  const match = topLevelKey.exec(workflowText.replace(/^\uFEFF/, ''));
  return match
    ? [`ci.yml workflow-level "${match[1] ?? match[2] ?? match[3]}" is unsupported for the pinned aggregate command`]
    : [];
}

export function allChecksGaps(jobs, { required, workflowText }) {
  const gaps = parseGaps(jobs);
  const aggregate = jobs.get('all-checks');
  if (!aggregate) {
    if (required) gaps.push({ id: 'ci/all-checks', message: 'ci.yml has no "all-checks" aggregate job' });
    return gaps;
  }
  const expectedJobs = [...jobs.keys()].filter((name) => name !== 'all-checks').sort();
  const messages = [
    ...workflowShapeGaps(workflowText),
    ...needsGaps(aggregate, expectedJobs),
    ...validateAggregateShape(aggregate),
  ];
  for (const message of messages) gaps.push({ id: 'ci/all-checks', message });
  appendDependencyGaps(jobs, gaps);
  return gaps;
}

function parseGaps(jobs) {
  const gaps = [];
  for (const name of jobs.keys()) {
    if (name.startsWith('!explicit-jobs-mapping-key-')) {
      gaps.push({ id: 'ci/all-checks', message: `ci.yml jobs mapping uses an unsupported explicit key at ${name.slice(name.lastIndexOf('-line-') + 1)}` });
    } else if (name.startsWith('!duplicate-jobs-key-')) {
      gaps.push({ id: 'ci/all-checks', message: `ci.yml jobs mapping repeats job key "${name.slice('!duplicate-jobs-key-'.length, name.lastIndexOf('-line-'))}"` });
    } else if (name.startsWith('!unsupported-jobs-') || name.startsWith('!duplicate-jobs-heading-')) {
      gaps.push({ id: 'ci/all-checks', message: `ci.yml jobs mapping has an unsupported key or heading (${name})` });
    }
  }
  return gaps;
}

function appendDependencyGaps(jobs, gaps) {
  for (const [name, block] of jobs) {
    if (name !== 'all-checks' && hasContinueOnError(block)) {
      gaps.push({ id: 'ci/all-checks', message: `job "${name}" uses continue-on-error, which can hide a failed dependency` });
    }
  }
}

export function codeownersGaps(text) {
  const lines = text.split(/\r?\n/).flatMap((line) => {
    const tokens = line.split('#', 1)[0].trim().split(/\s+/).filter(Boolean);
    return tokens.length ? [tokens] : [];
  });
  const defaults = lines.filter(([pattern]) => pattern === '*');
  const broadCatchalls = lines.filter(([pattern]) => /^[*/]+$/.test(pattern));
  if (defaults.length !== 1 || !defaults[0].slice(1).includes('@simpsonm09')) {
    return [{ id: 'community/CODEOWNERS', message: 'CODEOWNERS must assign the default "*" pattern to @simpsonm09 exactly once' }];
  }
  if (broadCatchalls.some(([, ...owners]) => !owners.includes('@simpsonm09'))) {
    return [{ id: 'community/CODEOWNERS', message: 'CODEOWNERS broad catch-all patterns must include @simpsonm09' }];
  }
  return [];
}

export function needsSucceeded(needs, expectedJobs) {
  return expectedJobs.length > 0
    && expectedJobs.every((name) => Object.hasOwn(needs, name) && needs[name]?.result === 'success');
}

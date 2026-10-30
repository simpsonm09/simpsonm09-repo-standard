// Validate the supported, deliberately small all-checks workflow shape. Unknown
// YAML forms fail closed so a parser limitation is reported as a gap.
const SAFE_RUN = /^echo "\$NEEDS" \| jq -e 'all\(\.\[\]; \.result == "success"\)'$/;

function property(block, name) {
  const matches = block.filter((line) => new RegExp(`^\\s+${name}:`).test(line));
  if (matches.length !== 1) return { value: null, malformed: true };
  const match = new RegExp(`^\\s+${name}:\\s*(.*?)\\s*(?:#.*)?$`).exec(matches[0]);
  return { value: match?.[1]?.trim() ?? null, malformed: !match?.[1]?.trim() };
}

function needsGaps(aggregate, expectedJobs) {
  const gaps = [];
  const needs = property(aggregate, 'needs');
  const rawNeeds = needs.value;
  const parsedNeeds = rawNeeds?.startsWith('[') && rawNeeds.endsWith(']')
    ? rawNeeds.slice(1, -1).split(',').map((value) => value.trim()).filter(Boolean)
    : null;
  if (needs.malformed || !parsedNeeds || parsedNeeds.some((name) => !/^[A-Za-z0-9_.-]+$/.test(name))) {
    gaps.push('all-checks needs must use the supported inline job-name list');
  } else if (new Set(parsedNeeds).size !== parsedNeeds.length || parsedNeeds.length !== expectedJobs.length || expectedJobs.some((name) => !parsedNeeds.includes(name))) {
    gaps.push(`all-checks needs must name every other CI job exactly once (${expectedJobs.join(', ')})`);
  }
  return gaps;
}

function allCheckShapeGaps(aggregate) {
  const gaps = [];

  for (const name of ['if', 'runs-on', 'timeout-minutes', 'permissions']) {
    const entry = property(aggregate, name);
    const expected = { if: 'always()', 'runs-on': 'ubuntu-24.04', 'timeout-minutes': '5', permissions: '{}' }[name];
    if (entry.malformed || entry.value !== expected) gaps.push(`all-checks must declare ${name}: ${expected}`);
  }
  if (aggregate.some((line) => /^\s+continue-on-error:\s*(?:true|\$\{\{\s*true)/i.test(line))) {
    gaps.push('all-checks must not use continue-on-error');
  }
  const runLines = aggregate.filter((line) => /^\s+run:/.test(line));
  if (runLines.length !== 1 || !SAFE_RUN.test(runLines[0].replace(/^\s+run:\s*/, '').trim())) gaps.push('all-checks must run the jq all-needs-success check');
  return gaps;
}

function hasContinueOnError(block) {
  return block.some((line) => {
    const match = /^\s+continue-on-error:\s*(.*?)\s*(?:#.*)?$/i.exec(line);
    return match !== null && match[1].toLowerCase() !== 'false';
  });
}

export function allChecksGaps(jobs) {
  const gaps = [];
  const aggregate = jobs.get('all-checks');
  if (!aggregate) return [{ id: 'ci/all-checks', message: 'ci.yml has no "all-checks" aggregate job' }];
  const expectedJobs = [...jobs.keys()].filter((name) => name !== 'all-checks').sort();
  for (const message of [...needsGaps(aggregate, expectedJobs), ...allCheckShapeGaps(aggregate)]) {
    gaps.push({ id: 'ci/all-checks', message });
  }
  for (const [name, block] of jobs) {
    if (hasContinueOnError(block)) gaps.push({ id: 'ci/all-checks', message: `job "${name}" uses continue-on-error, which can hide a failed dependency` });
  }
  return gaps;
}

export function codeownersGaps(text) {
  const lines = text.split(/\r?\n/);
  const ownership = lines.filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  const defaults = ownership.filter((line) => /^\*\s/.test(line));
  if (defaults.length !== 1 || defaults[0].trim() !== '* @simpsonm09') {
    return [{ id: 'community/CODEOWNERS', message: 'CODEOWNERS must contain the default ownership line "* @simpsonm09" exactly once' }];
  }
  return [];
}

export function needsSucceeded(needs, expectedJobs) {
  return expectedJobs.length > 0
    && expectedJobs.every((name) => Object.hasOwn(needs, name) && needs[name]?.result === 'success');
}

// Read the job structure of a GitHub Actions workflow token by token, so the
// checkers need no YAML parser. A job is a two-space key under `jobs:`, and its
// block is the indented lines that follow it.

export const EXTERNAL_WORKFLOW = /^simpsonm09-org\/simpsonm09-repo-standard\/\.github\/workflows\/([a-z0-9-]+)\.yml@([0-9a-fA-F]{40})$/;
export const LOCAL_WORKFLOW = /^\.\/\.github\/workflows\/([a-z0-9-]+)\.yml$/;

export function parseJobs(text) {
  const state = { jobs: new Map(), inJobs: false, jobsSeen: false, current: null, lineNumber: 0 };
  for (const rawLine of text.split('\n')) parseJobLine(rawLine.replace(/\r$/, ''), state);
  return state.jobs;
}

function parseJobLine(line, state) {
  state.lineNumber += 1;
  const content = state.lineNumber === 1 ? line.replace(/^\uFEFF/, '') : line;
  if (startJobsSection(content, state)) return;
  if (!state.inJobs) return;
  if (/^\S.*:(?:[ \t]|$)/.test(content) && !content.startsWith('#')) {
    state.inJobs = false;
    return;
  }
  if (startRecognizedJob(content, state)) return;
  if (startUnsupportedJobKey(content, state)) return;
  if (state.current) state.jobs.get(state.current).push(content);
}

function startJobsSection(line, state) {
  if (/^jobs:[ \t]*(?:#.*)?$/.test(line)) {
    state.inJobs = true;
    if (state.jobsSeen) setJob(state, `!duplicate-jobs-heading-line-${state.lineNumber}`);
    state.jobsSeen = true;
    return true;
  }
  if (/^(?:jobs|"jobs"|'jobs')[ \t]*:/.test(line)) {
    state.inJobs = true;
    state.jobsSeen = true;
    setJob(state, `!unsupported-jobs-heading-line-${state.lineNumber}`);
    return true;
  }
  return false;
}

function startRecognizedJob(line, state) {
  const match = /^ {2}(?:"([A-Za-z0-9_.-]+)"|'([A-Za-z0-9_.-]+)'|([A-Za-z0-9_.-]+)):[ \t]*(?:#.*)?$/.exec(line);
  if (!match) return false;
  const name = match[1] ?? match[2] ?? match[3];
  const key = state.jobs.has(name) ? `!duplicate-jobs-key-${name}-line-${state.lineNumber}` : name;
  setJob(state, key);
  return true;
}

function startUnsupportedJobKey(line, state) {
  if (/^ {2}\?/.test(line)) {
    setJob(state, `!explicit-jobs-mapping-key-line-${state.lineNumber}`);
    return true;
  }
  if (/^ {2}\S/.test(line) && !/^ {2}#/.test(line)) {
    setJob(state, `!unsupported-jobs-key-line-${state.lineNumber}`);
    return true;
  }
  return false;
}

function setJob(state, name) {
  state.current = name;
  state.jobs.set(name, []);
}

export function findUses(block) {
  for (const line of block) {
    const match = /^\s+uses:\s*(\S+)/.exec(line);
    if (match) return match[1].replace(/['"]/g, '');
  }
  return null;
}

// The names of the jobs that call one shared workflow. A local reference counts
// only in the standard repository itself, the one place those files live.
export function jobsCalling(jobs, workflow, isSelf) {
  return [...jobs.keys()].filter((name) => {
    const uses = findUses(jobs.get(name));
    if (!uses) return false;
    const external = EXTERNAL_WORKFLOW.exec(uses);
    if (external) return external[1] === workflow;
    const local = LOCAL_WORKFLOW.exec(uses);
    return isSelf && local !== null && local[1] === workflow;
  });
}

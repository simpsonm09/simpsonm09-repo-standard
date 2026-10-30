#!/usr/bin/env node
import { EXIT } from './lib/exit.mjs';
import { capture, isMain } from './lib/proc.mjs';

const USAGE = `usage: node scripts/apply-settings.mjs <owner/repo> [options]

options:
  --apply                 write the changes (default is a dry run)
  --allow-auto-merge on|off explicitly set GitHub's allow_auto_merge setting
  --topic NAME            add a topic alongside the owner login (repeatable)
  -h, --help              show this help

Converges the repository settings the standard requires, keeps the owner login
as a topic, and turns on the Dependabot alerts and security updates the fleet
uses. See docs/github-settings.md.
`;

const SETTINGS = [
  ['delete_branch_on_merge', true],
  ['allow_merge_commit', true],
  ['allow_squash_merge', true],
  ['allow_rebase_merge', true],
];

const SECURITY = ['secret_scanning', 'secret_scanning_push_protection'];

function parseArgs(argv) {
  const options = { repo: null, apply: false, topics: [], allowAutoMerge: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--topic') { options.topics.push(argv[index + 1]); index += 1; }
    else if (arg === '--allow-auto-merge') index = parseAutoMerge(argv, index, options);
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (options.repo === null) options.repo = arg;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function parseAutoMerge(argv, index, options) {
  const value = argv[index + 1];
  if (value !== 'on' && value !== 'off') throw new Error('--allow-auto-merge must be on or off');
  options.allowAutoMerge = value === 'on';
  return index + 1;
}

function gh(args) {
  const result = capture('gh', ['api', ...args]);
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout).trim() };
  if (result.stdout.trim() === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: true, value: result.stdout.trim() };
  }
}

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function convergeSettings(repo, apply, changes, api, allowAutoMerge) {
  const meta = api([`repos/${repo}`]);
  if (!meta.ok || !isJsonObject(meta.value)) {
    return unreadableSettingsErrors(repo, allowAutoMerge, meta);
  }
  const errors = convergeSettingsPatch(repo, apply, changes, api, meta.value);
  const autoMergeError = convergeAutoMerge(repo, apply, changes, api, meta.value, allowAutoMerge);
  if (autoMergeError) errors.push(autoMergeError);
  return errors;
}

function unreadableSettingsErrors(repo, allowAutoMerge, meta) {
  const error = meta.ok ? 'unreadable metadata response body' : meta.error;
  return [
    `cannot read ${repo} settings metadata: ${error}`,
    ...(allowAutoMerge === null ? [] : [`cannot read ${repo} allow_auto_merge metadata: ${error}`]),
  ];
}

function convergeSettingsPatch(repo, apply, changes, api, meta) {
  const patch = [];
  const pendingChanges = [];
  for (const [key, desired] of SETTINGS) {
    if (meta[key] !== desired) {
      patch.push([key, String(desired)]);
      pendingChanges.push(`${repo} ${key} -> ${desired}`);
    }
  }
  if (patch.length > 0 && apply) {
    const args = patch.flatMap(([key, value]) => ['-F', `${key}=${value}`]);
    const result = api(['-X', 'PATCH', `repos/${repo}`, ...args]);
    if (!result.ok) return [`cannot update ${repo}: ${result.error}`];
    changes.push(...pendingChanges);
  } else changes.push(...pendingChanges);
  return [];
}

function convergeAutoMerge(repo, apply, changes, api, meta, desired) {
  if (desired === null || meta?.allow_auto_merge === desired) return null;
  if (!apply) {
    changes.push(`${repo} allow_auto_merge -> ${desired}`);
    return null;
  }
  const result = api(['-X', 'PATCH', `repos/${repo}`, '-F', `allow_auto_merge=${String(desired)}`]);
  if (result.ok) {
    changes.push(`${repo} allow_auto_merge -> ${desired}`);
    return null;
  }
  return `cannot update ${repo} allow_auto_merge: ${result.error}; other settings were handled independently and were not part of this failed update`;
}

function convergeSecurity(repo, apply, changes, api) {
  const meta = api([`repos/${repo}`]);
  if (!meta.ok) return `cannot read ${repo}: ${meta.error}`;
  if (meta.value?.visibility !== 'public') return null;
  const analysis = meta.value?.security_and_analysis ?? {};
  const off = SECURITY.filter((key) => analysis[key]?.status !== 'enabled');
  if (off.length === 0) return null;
  const pendingChanges = off.map((key) => `${repo} ${key} -> enabled`);
  if (apply) {
    const args = off.flatMap((key) => ['-F', `security_and_analysis[${key}][status]=enabled`]);
    const result = api(['-X', 'PATCH', `repos/${repo}`, ...args]);
    if (!result.ok) return `cannot enable security for ${repo}: ${result.error}`;
  }
  changes.push(...pendingChanges);
  return null;
}

function convergeDependabot(repo, apply, changes, api) {
  const alerts = api([`repos/${repo}/vulnerability-alerts`]);
  if (!alerts.ok && !/404/.test(alerts.error ?? '')) {
    return `cannot read Dependabot alerts for ${repo}: ${alerts.error}`;
  }
  if (!alerts.ok) {
    const error = enableToggle(repo, 'vulnerability-alerts', 'Dependabot alerts', apply, changes, api);
    if (error) return error;
  }

  const fixes = api([`repos/${repo}/automated-security-fixes`]);
  if (!fixes.ok) return `cannot read Dependabot security updates for ${repo}: ${fixes.error}`;
  if (fixes.value?.enabled !== true) {
    const error = enableToggle(repo, 'automated-security-fixes', 'Dependabot security updates', apply, changes, api);
    if (error) return error;
  }
  return null;
}

function enableToggle(repo, endpoint, label, apply, changes, api) {
  if (apply) {
    const result = api(['-X', 'PUT', `repos/${repo}/${endpoint}`]);
    if (!result.ok) return `cannot enable ${label} for ${repo}: ${result.error}`;
  }
  changes.push(`${repo} ${label.toLowerCase()} -> enabled`);
  return null;
}

function convergeTopics(repo, ownerLogin, extras, apply, changes, api) {
  const current = api([`repos/${repo}/topics`]);
  if (!current.ok) return `cannot read topics for ${repo}: ${current.error}`;
  const names = current.value?.names ?? [];
  const desired = [...new Set([...names, ownerLogin, ...extras])];
  const missing = desired.filter((name) => !names.includes(name));
  if (missing.length === 0) return null;
  const change = `${repo} topics + ${missing.join(', ')}`;
  if (apply) {
    const result = api(['-X', 'PUT', `repos/${repo}/topics`, ...desired.flatMap((name) => ['-f', `names[]=${name}`])]);
    if (!result.ok) return `cannot update topics for ${repo}: ${result.error}`;
  }
  changes.push(change);
  return null;
}

export function applySettings(repo, options, apply, api = gh) {
  const owner = repo.split('/')[0];
  const changes = [];
  const errors = [];
  const steps = [
    () => convergeSettings(repo, apply, changes, api, options.allowAutoMerge ?? null),
    () => convergeSecurity(repo, apply, changes, api),
    () => convergeDependabot(repo, apply, changes, api),
    () => convergeTopics(repo, owner, options.topics, apply, changes, api),
  ];
  for (const step of steps) {
    const error = step();
    if (Array.isArray(error)) errors.push(...error);
    else if (error) errors.push(error);
  }
  return { changes, errors };
}

function main() {
  const options = parseOptionsOrExit();
  if (options.help || !options.repo || !options.repo.includes('/')) {
    reportUsage(options);
    process.exit(options.help ? EXIT.OK : EXIT.USAGE);
  }

  const { changes, errors } = applySettings(options.repo, options, options.apply);
  reportResult(options, changes, errors);
  process.exit(errors.length > 0 ? EXIT.FAIL : EXIT.OK);
}

function parseOptionsOrExit() {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`apply-settings: ${error.message}\n${USAGE}`);
    process.exit(EXIT.USAGE);
  }
}

function reportUsage(options) {
  if (!options.help && options.repo) process.stderr.write('apply-settings: repo must be owner/name\n');
  process.stdout.write(USAGE);
}

function reportResult(options, changes, errors) {
  process.stdout.write(`apply-settings  ${options.repo} (${options.apply ? 'apply' : 'dry run'})\n`);
  if (changes.length === 0) {
    process.stdout.write('  ok, already converged\n');
  } else {
    for (const change of changes) process.stdout.write(`  ${options.apply ? 'applied' : 'would'} ${change}\n`);
    if (!options.apply) process.stdout.write('  run with --apply to write these changes\n');
  }
  for (const error of errors) process.stderr.write(`error: ${error}\n`);
}

if (isMain(import.meta.url)) main();

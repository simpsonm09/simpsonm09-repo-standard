#!/usr/bin/env node
// Compare declared access levels with both active main rulesets. This is a
// read-only local audit; unreadable, missing, duplicate, or unsupported state is drift.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCatalog, loadCommittedCatalog, resolveLevel } from './agent-access.mjs';
import { compareMainRulesets, findUniqueRuleset } from './lib/ruleset-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_DIR = join(ROOT, '..', 'simpsonm09-repo-catalog');
const DEFAULT_CATALOG = join(CATALOG_DIR, 'repos.json');
const DEFAULT_ORG = 'simpsonm09-org';
const DEFAULT_BRANCH = 'main';

export function compare(repo, level, protectMain, approvalMain) {
  const errors = compareMainRulesets(level, protectMain, approvalMain, DEFAULT_BRANCH);
  return { repo, level, ok: errors.length === 0, errors, reason: errors.join('; ') || undefined };
}

function ghJson(org, repo, path) {
  const out = execFileSync('gh', ['api', `repos/${org}/${repo}/${path}`], { windowsHide: true, encoding: 'utf8' });
  return JSON.parse(out);
}

function ruleset(org, repo, name) {
  const pages = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${org}/${repo}/rulesets`], {
    windowsHide: true,
    encoding: 'utf8',
  }));
  const summaries = Array.isArray(pages) ? pages.flat() : null;
  const selected = findUniqueRuleset(summaries, name);
  if (!selected.ok) throw new Error(selected.reason);
  return ghJson(org, repo, `rulesets/${selected.summary.id}`);
}

function parseArgs(argv) {
  const args = { catalog: undefined, org: DEFAULT_ORG, json: false, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--catalog') { args.catalog = argv[++index]; }
    else if (arg === '--org') { args.org = argv[++index]; }
    else if (arg === '--json') args.json = true;
    else if (arg === '--self-test') args.selfTest = true;
  }
  return args;
}

function sample(name, count, actors = []) {
  return {
    name,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    bypass_actors: actors,
    rules: [{ type: 'pull_request', parameters: { required_approving_review_count: count } }],
  };
}

function selfTest() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const admin = [{ actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'pull_request' }];
  assert(compare('x', 'full', sample('protect-main', 0), sample('approval-main', 0)).ok, 'full has zero approvals and no bypass');
  assert(compare('x', 'merge', sample('protect-main', 0), sample('approval-main', 1, admin)).ok, 'merge has one approval and human PR-only bypass');
  assert(compare('x', 'propose', sample('protect-main', 0), sample('approval-main', 1, admin)).ok, 'propose has one approval');
  assert(!compare('x', 'full', sample('protect-main', 0, admin), sample('approval-main', 0)).ok, 'protect bypass fails');
  assert(!compare('x', 'merge', sample('protect-main', 0), sample('approval-main', 1, [...admin, { actor_type: 'Integration', actor_id: 42, bypass_mode: 'always' }])).ok, 'unexpected actor fails');
  assert(!compare('x', 'full', sample('protect-main', 0), sample('approval-main', 1)).ok, 'wrong approval count fails');
  assert(!compare('x', 'legacy', sample('protect-main', 0), sample('approval-main', 0)).ok, 'unknown level fails');
  assert(!compare('x', 'full', null, sample('approval-main', 0)).ok, 'missing protection ruleset fails');
  assert(!compare('x', 'full', sample('protect-main', 0), null).ok, 'missing approval ruleset fails');
  assert(!compare('x', 'full', sample('protect-main', 0), { ...sample('approval-main', 0), enforcement: 'disabled' }).ok, 'inactive approval ruleset fails');
  assert(!findUniqueRuleset([{ name: 'approval-main' }, { name: 'approval-main' }], 'approval-main').ok, 'duplicate ruleset names fail');
}

function loadCatalogOrExit(args) {
  try { return args.catalog ? loadCatalog(args.catalog) : loadCommittedCatalog() ?? loadCatalog(DEFAULT_CATALOG); }
  catch {
    process.stderr.write('check-agent-access: cannot read the catalog\n');
    process.exit(2);
  }
}

function collectRows(catalog, args) {
  return (catalog.repos ?? []).map((entry) => {
    const resolved = resolveLevel(catalog, entry.name);
    try {
      return compare(entry.name, resolved.level, ruleset(args.org, entry.name, 'protect-main'), ruleset(args.org, entry.name, 'approval-main'));
    } catch (error) {
      return { repo: entry.name, level: resolved.level, ok: false, errors: [error.message], reason: error.message };
    }
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    try { selfTest(); process.stdout.write('check-agent-access: self-test ok\n'); }
    catch (error) { process.stderr.write(`check-agent-access: self-test failed: ${error.message}\n`); process.exit(1); }
    return;
  }
  const rows = collectRows(loadCatalogOrExit(args), args);
  const drift = rows.some((row) => !row.ok);
  if (args.json) process.stdout.write(`${JSON.stringify({ org: args.org, rows }, null, 2)}\n`);
  else {
    for (const row of rows) process.stdout.write(`${row.repo}\tlevel=${row.level}\t${row.ok ? 'ok' : `DRIFT: ${row.reason}`}\n`);
    process.stdout.write(`check-agent-access: ${drift ? 'drift' : 'clean'} (${rows.length} repositories)\n`);
  }
  process.exit(drift ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

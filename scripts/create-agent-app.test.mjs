#!/usr/bin/env node
// Check the committed App manifest against the offline permission contract.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from './create-agent-app.mjs';
import { EXIT } from './lib/exit.mjs';
import { isMain } from './lib/proc.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function runTest() {
  try {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'agent-app.manifest.json'), 'utf8'));
    assert.equal(manifest.default_permissions.issues, 'write', 'issue creation permission is requested');
    assert.deepEqual(manifest.default_permissions, {
      metadata: 'read',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      workflows: 'write',
      checks: 'read',
    }, 'existing App permissions are preserved without administration');
    assert.deepEqual(validateManifest(manifest), [], 'committed manifest passes the existing validator');

    const administrationFixture = structuredClone(manifest);
    administrationFixture.default_permissions.administration = 'write';
    assert.deepEqual(
      validateManifest(administrationFixture),
      ['administration must not be granted'],
      'validator rejects the prohibited administration permission',
    );

    process.stdout.write('create-agent-app.test: ok (4 assertions)\n');
    return EXIT.OK;
  } catch (error) {
    process.stderr.write(`create-agent-app.test: failed: ${error.message}\n`);
    return EXIT.FAIL;
  }
}

if (isMain(import.meta.url)) process.exit(runTest());

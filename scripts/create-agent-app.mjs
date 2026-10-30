#!/usr/bin/env node
// Create the fleet agent GitHub App from a manifest and capture its credentials.
// GitHub has no API to create an app, so this drives the manifest flow. It serves
// the manifest form, your browser posts it to GitHub, and GitHub redirects a
// one-time code back here. The script exchanges the code for the app id and the
// private key.
//
// Usage:
//   node scripts/create-agent-app.mjs [--org simpsonm09-org] [--port 8721] [--print]
//   node scripts/create-agent-app.mjs --self-test
//
// The private key is written under the user config directory, never the repo.
// Move it into Infisical after the run. See docs/features/agent-access.md.

import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startSetupListener } from './lib/app-setup-listener.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'agent-app.manifest.json');
const CONFIG_DIR = join(homedir(), '.config', 'simpsonm09');

export function validateManifest(manifest) {
  const problems = [];
  if (!manifest.name) problems.push('name is required');
  if (!manifest.url) problems.push('url is required');
  if (!manifest.redirect_url) problems.push('redirect_url is required');
  for (const [scope, level] of Object.entries(manifest.default_permissions ?? {})) {
    if (!['read', 'write'].includes(level)) problems.push(`permission ${scope} must be read or write`);
  }
  if (manifest.default_permissions?.administration) {
    problems.push('administration must not be granted');
  }
  return problems;
}

function parseArgs(argv) {
  const args = { org: 'simpsonm09-org', port: 8721, print: false, selfTest: false, noOpen: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--org') {
      index += 1;
      args.org = argv[index];
    } else if (arg === '--port') {
      index += 1;
      args.port = Number(argv[index]);
    } else if (arg === '--print') args.print = true;
    else if (arg === '--no-open') args.noOpen = true;
    else if (arg === '--self-test') args.selfTest = true;
  }
  return args;
}

function loadManifest(port) {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  manifest.redirect_url = `http://localhost:${port}/callback`;
  return manifest;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(command, { windowsHide: true }, () => {});
}

function createUrl(org, state) {
  return `https://github.com/organizations/${org}/settings/apps/new?state=${state}`;
}

function formPage(manifest, org, state) {
  const value = escapeHtml(JSON.stringify(manifest));
  return `<!doctype html><html><body>
<form id="manifest" action="${createUrl(org, state)}" method="post">
<input type="hidden" name="manifest" value="${value}">
<button type="submit">Create the GitHub App</button>
</form>
<script>document.getElementById('manifest').submit();</script>
</body></html>`;
}

function successPage(data) {
  return `<!doctype html><html><body>
<h1>The app exists</h1>
<p>App id ${data.id}, slug ${data.slug}.</p>
<p>Install it: <a href="https://github.com/apps/${data.slug}/installations/new">install</a>.</p>
<p>You can close this tab.</p>
</body></html>`;
}

function failurePage(message) {
  return `<!doctype html><html><body><h1>Creation failed</h1><pre>${escapeHtml(message)}</pre></body></html>`;
}

async function exchange(code, signal) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9]+$/.test(code)) {
    throw new Error('invalid code from GitHub');
  }
  const endpoint = new URL(`https://api.github.com/app-manifests/${code}/conversions`);
  if (endpoint.origin !== 'https://api.github.com') {
    throw new Error(`refusing to call ${endpoint.origin}`);
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`conversion failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function store(data) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const keyPath = join(CONFIG_DIR, 'agent-app.pem');
  const metaPath = join(CONFIG_DIR, 'agent-app.json');
  writeFileSync(keyPath, data.pem, { mode: 0o600 });
  const meta = { id: data.id, slug: data.slug, client_id: data.client_id };
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return { keyPath, metaPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(args.port);
  const problems = validateManifest(manifest);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`create-agent-app: ${problem}\n`);
    process.exit(1);
  }

  if (args.selfTest) {
    process.stdout.write('create-agent-app: self-test ok\n');
    return;
  }

  if (args.print) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`create URL: ${createUrl(args.org, 'STATE')}\n`);
    return;
  }

  const state = randomBytes(16).toString('hex');
  let finished = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://localhost:${args.port}`);
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(formPage(manifest, args.org, state));
      return;
    }
    if (url.pathname === '/callback') {
      if (url.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/html' });
        response.end(failurePage('state mismatch'));
        return;
      }
      try {
        const data = await exchange(url.searchParams.get('code'), abortController.signal);
        abortController.signal.throwIfAborted();
        const { keyPath, metaPath } = store(data);
        finished = true;
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(successPage(data));
        process.stdout.write(`create-agent-app: app id ${data.id}, slug ${data.slug}\n`);
        process.stdout.write(`create-agent-app: private key ${keyPath}\n`);
        process.stdout.write(`create-agent-app: metadata ${metaPath}\n`);
        process.stdout.write(`create-agent-app: install at https://github.com/apps/${data.slug}/installations/new\n`);
        process.stdout.write('create-agent-app: move the key into Infisical, then delete the local file\n');
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/html' });
        response.end(failurePage(error.message));
        process.stderr.write(`create-agent-app: ${error.message}\n`);
      } finally {
        server.close();
      }
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });

  const abortController = new AbortController();
  const abort = () => abortController.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  server.once('close', () => {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    if (!finished) process.stderr.write('create-agent-app: closed before the app was created\n');
  });
  startSetupListener(server, {
    port: args.port,
    signal: abortController.signal,
    onStop: (reason, error) => {
      abortController.abort();
      if (!finished) process.exitCode = 1;
      if (reason === 'listen-failed') {
        const code = ['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'].includes(error?.code)
          ? error.code : 'listen-failed';
        process.stderr.write(`create-agent-app: ${code}\n`);
      }
    },
    onListening: () => {
      process.stdout.write(`create-agent-app: open http://localhost:${args.port}/\n`);
      process.stdout.write(`create-agent-app: the browser posts the manifest to ${createUrl(args.org, state)}\n`);
      if (!args.noOpen) openBrowser(`http://localhost:${args.port}/`);
    },
  });

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  encodeFrame,
  mapOversizeResult,
  runOne,
  validAllowList,
} from "./carrier.mjs";
import { main as entryMain } from "./execute-one.mjs";
import { createOperationExecutor } from "./index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const childPath = join(here, "stdio-fixture-child.mjs");
const entryPath = join(here, "execute-one.mjs");
const requestId = "0123456789abcdef0123456789abcdef";
const identity = {
  userSid: "S-1-5-21-1004336348-1177238915-682003330-1001",
  logonSid: "S-1-5-5-0-1234567",
  alias: "agent-01",
};
const target = { host: "github.com", owner: "acme", repo: "sample" };
const readData = {
  full_name: "acme/sample",
  name: "sample",
  private: true,
  default_branch: "main",
};
const identityText = JSON.stringify(identity);
const requestText = JSON.stringify({
  operationId: "readRepository",
  target,
});

function readOperation() {
  return { operationId: "readRepository", target };
}

function payload(overrides = {}) {
  return {
    version: 1,
    requestId,
    identity: { ...identity },
    request: readOperation(),
    ...overrides,
  };
}

function frame(value) {
  const encoded = encodeFrame(value, 128 * 1024);
  assert.equal(encoded.ok, true);
  return encoded.frame;
}

function framed(body) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function declaredLength(length) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(length, 0);
  return header;
}

// A byte that only fatal UTF-8 decoding rejects: a lenient decoder would
// accept this frame and answer internal-channel-invalid.
function invalidUtf8Frame() {
  return framed(
    Buffer.concat([
      Buffer.from(
        `{"version":1,"requestId":"${requestId}",` +
          `"identity":{"userSid":"${identity.userSid}",` +
          `"logonSid":"${identity.logonSid}","alias":"agent-`,
      ),
      Buffer.from([0xff]),
      Buffer.from(`01"},"request":${requestText}}`),
    ]),
  );
}

// A valid request padded past the request limit: without the length check the
// frame would decode, parse, and execute.
function oversizeFrame() {
  const text = Buffer.from(JSON.stringify(payload()));
  const padded = Buffer.concat([
    text,
    Buffer.alloc(128 * 1024 + 1 - text.length, 0x20),
  ]);
  return framed(padded);
}

// A complete request under a header that promises more: without the
// truncation check the readable prefix would execute.
function truncatedFrame() {
  const text = Buffer.from(JSON.stringify(payload()));
  return Buffer.concat([declaredLength(text.length + 16), text]);
}

function pin(value) {
  const bytes = JSON.stringify(value);
  return {
    bytes,
    expectedSHA256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ports(calls) {
  return {
    appId: 91,
    registrationOwner: "acme",
    manifestCeiling: { contents: "write", pull_requests: "write" },
    policy: {
      roster: pin({
        org: "acme",
        repos: [{ name: "sample", tier: "S1" }],
        agentAccessDefaults: { S1: "propose" },
      }),
      ownedForks: pin({ forks: [] }),
      ownedRepositories: pin({ repositories: [] }),
      ignore: pin({ ignore: [] }),
    },
    signAppJwt: async () => "synthetic-jwt-marker",
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith("/installation"))
        return json({
          id: 12,
          app_id: 91,
          account: { login: "acme", type: "Organization" },
          permissions: { contents: "write", pull_requests: "write" },
        });
      if (url.endsWith("/access_tokens"))
        return json({
          token: "synthetic-installation-token-marker",
          repositories: [{ full_name: "acme/sample" }],
          permissions: { contents: "read", metadata: "read" },
        });
      return json(readData);
    },
  };
}

async function runInProcess({
  bytes,
  bootstrap,
  executor = createOperationExecutor(bootstrap),
  deadlineMs,
  holdOpen,
}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written = [];
  output.on("data", (chunk) => written.push(chunk));
  const pending = runOne({
    input,
    output,
    executor,
    allowedUserSids: [identity.userSid],
    deadlineMs,
  });
  input.write(bytes);
  if (!holdOpen) input.end();
  const code = await pending;
  output.end();
  input.destroy();
  return { code, bytes: Buffer.concat(written) };
}

function decode(bytes) {
  const frames = [];
  let offset = 0;
  while (offset < bytes.length) {
    assert.ok(offset + 4 <= bytes.length, "response header truncated");
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    assert.ok(offset + length <= bytes.length, "response payload truncated");
    const text = bytes.subarray(offset, offset + length).toString("utf8");
    frames.push(JSON.parse(text));
    offset += length;
  }
  return frames;
}

function runChild(path, bytes, { holdOpen = false } = {}) {
  const child = spawn(process.execPath, [path], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const out = [];
  const guard = setTimeout(() => child.kill(), 10_000);
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stdin.on("error", () => {});
  if (bytes && holdOpen) child.stdin.write(bytes);
  else if (bytes) child.stdin.end(bytes);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(guard);
      child.stdin.destroy();
      resolve({ code, bytes: Buffer.concat(out) });
    });
  });
}

async function testChildHappyPath() {
  const result = await runChild(childPath, frame(payload()));
  assert.equal(result.code, 0);
  assert.deepEqual(decode(result.bytes), [
    {
      version: 1,
      requestId,
      result: {
        status: "completed",
        operation: "readRepository",
        repository: {
          fullName: "acme/sample",
          name: "sample",
          private: true,
          defaultBranch: "main",
        },
      },
    },
  ]);
}

async function testChildSecondFrame() {
  const result = await runChild(
    childPath,
    Buffer.concat([frame(payload()), frame(payload())]),
  );
  assert.equal(result.code, 1);
  assert.equal(result.bytes.length, 0);
}

async function testHappyPath() {
  const calls = [];
  const result = await runInProcess({
    bytes: frame(payload()),
    bootstrap: ports(calls),
  });
  assert.equal(result.code, 0);
  const frames = decode(result.bytes);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].requestId, requestId);
  assert.equal(frames[0].result.status, "completed");
  const repoPath = "https://api.github.com/repos/acme/sample";
  assert.deepEqual(calls, [
    `${repoPath}/installation`,
    "https://api.github.com/app/installations/12/access_tokens",
    repoPath,
  ]);
  assert.equal(calls.filter((url) => url === repoPath).length, 1);
}

async function testFrameRules() {
  const cases = [
    [
      "duplicate-key",
      framed(
        Buffer.from(
          `{"version":1,"version":1,"requestId":"${requestId}",` +
            `"identity":${identityText},"request":${requestText}}`,
        ),
      ),
    ],
    [
      "unknown-key",
      framed(
        Buffer.from(
          `{"version":1,"requestId":"${requestId}",` +
            `"identity":${identityText},"request":${requestText},"x":1}`,
        ),
      ),
    ],
    ["wrong-version", frame(payload({ version: 2 }))],
    ["bad-request-id", frame(payload({ requestId: requestId.toUpperCase() }))],
    [
      "nested-duplicate-key",
      framed(
        Buffer.from(
          `{"version":1,"requestId":"${requestId}",` +
            `"identity":${identityText},"request":{"operationId":` +
            `"readRepository","target":${JSON.stringify(target)},` +
            `"target":${JSON.stringify(target)}}}`,
        ),
      ),
    ],
    [
      "escaped-duplicate-key",
      framed(
        Buffer.from(
          `{"version":1,"\\u0076ersion":1,"requestId":"${requestId}",` +
            `"identity":${identityText},"request":${requestText}}`,
        ),
      ),
    ],
    [
      "escaped-quote-duplicate-key",
      framed(
        Buffer.from(
          `{"version":1,"requestId":"${requestId}",` +
            `"identity":${identityText},"request":{"a\\"b":1,"a\\"b":2}}`,
        ),
      ),
    ],
    [
      "duplicate-after-array",
      framed(
        Buffer.from(
          `{"version":1,"requestId":"${requestId}",` +
            `"identity":${identityText},"request":{"a":[{"b":1}],"a":2}}`,
        ),
      ),
    ],
    [
      "byte-order-mark",
      framed(
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(JSON.stringify(payload())),
        ]),
      ),
    ],
    ["trailing-bytes", Buffer.concat([frame(payload()), Buffer.from("x")])],
    ["invalid-utf8", invalidUtf8Frame()],
    ["oversize-length", oversizeFrame()],
    ["truncated", truncatedFrame()],
  ];
  for (const [name, bytes] of cases) {
    const calls = [];
    const result = await runInProcess({ bytes, bootstrap: ports(calls) });
    assert.equal(result.code, 1, name);
    assert.equal(result.bytes.length, 0, name);
    assert.equal(calls.length, 0, name);
  }
}

async function testDeadline() {
  const result = await runInProcess({
    bytes: Buffer.from([0, 0]),
    bootstrap: ports([]),
    deadlineMs: 200,
    holdOpen: true,
  });
  assert.equal(result.code, 1);
  assert.equal(result.bytes.length, 0);
}

async function testIdentity() {
  const cases = [
    ["missing", { version: 1, requestId, request: readOperation() }],
    ["not-object", payload({ identity: "S-1-5-21-1" })],
    ["bad-user-sid", payload({ identity: { ...identity, userSid: "S-1-5" } })],
    ["bad-alias", payload({ identity: { ...identity, alias: "Agent 01" } })],
    ["extra-key", payload({ identity: { ...identity, extra: "x" } })],
    [
      "unlisted-account",
      payload({ identity: { ...identity, userSid: "S-1-5-21-1-2-3-500" } }),
    ],
    ["request-not-object", payload({ request: [readOperation()] })],
    ["bad-logon-sid", payload({ identity: { ...identity, logonSid: "x" } })],
  ];
  for (const [name, value] of cases) {
    const calls = [];
    const result = await runInProcess({
      bytes: frame(value),
      bootstrap: ports(calls),
    });
    assert.equal(result.code, 0, name);
    assert.deepEqual(
      decode(result.bytes),
      [
        {
          version: 1,
          requestId,
          result: { status: "denied", code: "internal-channel-invalid" },
        },
      ],
      name,
    );
    assert.equal(calls.length, 0, name);
  }
}

async function testCrossOwner() {
  const calls = [];
  const value = payload({
    request: {
      operationId: "createPullRequest",
      target,
      title: "fixture PR",
      head: { owner: "someone-else", repo: "sample", branch: "feature" },
      base: { owner: "acme", repo: "sample", branch: "main" },
    },
  });
  const result = await runInProcess({
    bytes: frame(value),
    bootstrap: ports(calls),
  });
  assert.equal(result.code, 0);
  assert.deepEqual(decode(result.bytes), [
    {
      version: 1,
      requestId,
      result: { status: "denied", code: "invalid-request" },
    },
  ]);
  assert.equal(calls.length, 0);
}

function testOversizeResult() {
  // The executor returns bounded fields, so no real result reaches the frame
  // limit; the mapping carries the outcome rule on its own.
  assert.deepEqual(
    mapOversizeResult({ status: "denied", code: "policy-denied" }),
    { status: "denied", code: "response-too-large" },
  );
  assert.deepEqual(
    mapOversizeResult({ status: "completed", operation: "readRepository" }),
    { status: "outcome-unknown", code: "response-too-large" },
  );
  assert.deepEqual(
    mapOversizeResult({ status: "outcome-unknown", code: "timeout" }),
    { status: "outcome-unknown", code: "response-too-large" },
  );
}

async function testOversizeResponse() {
  const padding = "x".repeat(17 * 1024);
  for (const [status, expected] of [
    ["completed", "outcome-unknown"],
    ["outcome-unknown", "outcome-unknown"],
    ["denied", "denied"],
  ]) {
    let executions = 0;
    const result = await runInProcess({
      bytes: frame(payload()),
      executor: {
        execute: async () => {
          executions += 1;
          return { status, code: padding };
        },
      },
    });
    assert.equal(result.code, 0, status);
    assert.equal(executions, 1, status);
    assert.deepEqual(
      decode(result.bytes),
      [
        {
          version: 1,
          requestId,
          result: { status: expected, code: "response-too-large" },
        },
      ],
      status,
    );
  }
}

async function testChildDeadline() {
  const started = Date.now();
  const result = await runChild(childPath, Buffer.from([0, 0]), {
    holdOpen: true,
  });
  assert.equal(result.code, 1);
  assert.equal(result.bytes.length, 0);
  // The five-second frame deadline must end the process, not the guard kill.
  assert.ok(Date.now() - started < 8000);
}

async function testAllowList() {
  for (const allowed of [
    identity.userSid,
    [],
    ["S-1-5"],
    [identity.userSid, 7],
    undefined,
  ]) {
    let executions = 0;
    const input = new PassThrough();
    const output = new PassThrough();
    const written = [];
    output.on("data", (chunk) => written.push(chunk));
    input.end(frame(payload()));
    const code = await runOne({
      input,
      output,
      executor: {
        execute: async () => {
          executions += 1;
          return { status: "completed" };
        },
      },
      allowedUserSids: allowed,
    });
    assert.equal(code, 1, String(allowed));
    assert.equal(written.length, 0, String(allowed));
    assert.equal(executions, 0, String(allowed));

    const saved = process.exitCode;
    const entryCode = await entryMain({
      bootstrap: ports([]),
      allowedUserSids: allowed,
    });
    process.exitCode = saved;
    assert.equal(entryCode, 1, `entry ${String(allowed)}`);
    assert.equal(process.stdin.destroyed, false, "entry must not touch stdin");
  }
  const maxSubauthorities = `S-1-5${"-1".repeat(15)}`;
  assert.equal(validAllowList([maxSubauthorities]), true);
  assert.equal(validAllowList([`${maxSubauthorities}-1`]), false);
}

async function testDirectEntry() {
  const started = Date.now();
  const result = await runChild(entryPath);
  assert.equal(result.code, 1);
  assert.equal(result.bytes.length, 0);
  // It must fail before stdin, not after the five-second frame deadline.
  assert.ok(Date.now() - started < 3000);
}

async function main() {
  await testChildHappyPath();
  await testChildSecondFrame();
  await testHappyPath();
  await testFrameRules();
  await testDeadline();
  await testIdentity();
  await testCrossOwner();
  testOversizeResult();
  await testOversizeResponse();
  await testChildDeadline();
  await testAllowList();
  await testDirectEntry();
  console.log("fleet-broker-stdio-fixture: passed");
}

await main();

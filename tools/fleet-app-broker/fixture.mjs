import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { createOperationExecutor } from "./index.mjs";

const jwtMarker = "synthetic-jwt-marker";
const tokenMarker = "synthetic-installation-token-marker";
const target = { host: "github.com", owner: "acme", repo: "sample" };
const readRequest = { operationId: "readRepository", target };
const readData = {
  full_name: "acme/sample",
  name: "sample",
  private: true,
  default_branch: "main",
};

function pin(value) {
  const bytes = JSON.stringify(value);
  return {
    bytes,
    expectedSHA256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function bootstrap(fetch, overrides = {}) {
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
    signAppJwt: async ({ appId }) => (appId === 91 ? jwtMarker : "wrong-app"),
    fetch,
    ...overrides,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiScript({ installation, token, operation, calls }) {
  return async (url, init) => {
    calls.push({
      url,
      init,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (url.endsWith("/installation"))
      return json(
        installation ?? {
          id: 12,
          app_id: 91,
          account: { login: "acme", type: "Organization" },
          permissions: { contents: "write", pull_requests: "write" },
        },
      );
    if (url.endsWith("/access_tokens"))
      return json(
        token ?? {
          token: tokenMarker,
          repositories: [{ full_name: "acme/sample" }],
          permissions:
            operation === "createPullRequest"
              ? { pull_requests: "write", metadata: "read" }
              : { contents: "read", metadata: "read" },
        },
      );
    return json(
      operation === "createPullRequest"
        ? {
            number: 3,
            title: "fixture PR",
            html_url: "https://github.com/acme/sample/pull/3",
            state: "open",
          }
        : readData,
    );
  };
}

async function testRequestSnapshot() {
  const calls = [];
  let resume;
  let entered;
  const paused = new Promise((resolve) => {
    entered = resolve;
  });
  const signing = new Promise((resolve) => {
    resume = resolve;
  });
  const executor = createOperationExecutor(
    bootstrap(apiScript({ calls, operation: "createPullRequest" }), {
      signAppJwt: () => {
        entered();
        return signing;
      },
    }),
  );
  const request = {
    operationId: "createPullRequest",
    target: { ...target },
    title: "original",
    head: { owner: "acme", repo: "sample", branch: "feature" },
    base: { owner: "acme", repo: "sample", branch: "main" },
  };
  const pending = executor.execute(request);
  await paused;
  request.title = "mutated";
  request.head.owner = "attacker";
  request.head.branch = "changed";
  request.target.repo = "elsewhere";
  resume(jwtMarker);
  assert.equal((await pending).status, "completed");
  assert.deepEqual(calls[2].body, {
    title: "original",
    head: "feature",
    base: "main",
  });
  let getterCalls = 0;
  const malformed = {
    operationId: "readRepository",
    get target() {
      getterCalls += 1;
      throw new Error("synthetic getter");
    },
  };
  assert.deepEqual(await executor.execute(malformed), {
    status: "denied",
    code: "invalid-request",
  });
  assert.equal(getterCalls, 0);
  assert.equal(calls.length, 3);
}

async function testInstallationType() {
  const calls = [];
  const executor = createOperationExecutor(
    bootstrap(
      apiScript({
        calls,
        installation: {
          id: 12,
          app_id: 91,
          account: { login: "acme", type: "User" },
          permissions: { contents: "write" },
        },
      }),
    ),
  );
  assert.equal(
    (await executor.execute(readRequest)).code,
    "installation-mismatch",
  );
  assert.equal(calls.length, 1);
}

async function testResponseCleanup() {
  for (const mode of [
    "error",
    "redirect",
    "declared",
    "overflow",
    "read-failure",
  ]) {
    let cancelled = 0;
    const scripted = apiScript({ calls: [] });
    const executor = createOperationExecutor(
      bootstrap(async (url, init) => {
        if (!url.endsWith("/sample")) return scripted(url, init);
        const body = new ReadableStream({
          pull(controller) {
            if (mode === "read-failure")
              throw new Error("synthetic read failure");
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
          },
          cancel() {
            cancelled += 1;
          },
        });
        return new Response(body, {
          status: mode === "error" ? 500 : mode === "redirect" ? 302 : 200,
          headers: mode === "declared" ? { "content-length": "1048577" } : {},
        });
      }),
    );
    assert.equal(
      (await executor.execute(readRequest)).code,
      "operation-failed",
    );
    // An errored stream is already closed; cancellation need not reach its source.
    assert.equal(cancelled, mode === "read-failure" ? 0 : 1, mode);
  }
}

async function testChunkListeners() {
  const scripted = apiScript({ calls: [] });
  let operationSignal;
  const bytes = new TextEncoder().encode(JSON.stringify(readData));
  let offset = 0;
  const executor = createOperationExecutor(
    bootstrap(async (url, init) => {
      if (!url.endsWith("/sample")) return scripted(url, init);
      operationSignal = init.signal;
      return new Response(
        new ReadableStream({
          pull(controller) {
            assert.ok(getEventListeners(operationSignal, "abort").length <= 1);
            if (offset === bytes.length) controller.close();
            else controller.enqueue(bytes.slice(offset, ++offset));
          },
        }),
      );
    }),
  );
  assert.equal((await executor.execute(readRequest)).status, "completed");
  assert.equal(getEventListeners(operationSignal, "abort").length, 0);
}

async function testUnknownPrOutcome() {
  const request = {
    operationId: "createPullRequest",
    target,
    title: "fixture PR",
    head: { owner: "acme", repo: "sample", branch: "feature" },
    base: { owner: "acme", repo: "sample", branch: "main" },
  };
  for (const mode of [
    "disconnect",
    "invalid-json",
    "invalid-result",
    "http-error",
    "timeout",
    "body-timeout",
    "declared-oversize",
  ]) {
    const calls = [];
    const scripted = apiScript({ calls, operation: "createPullRequest" });
    let posts = 0;
    const executor = createOperationExecutor(
      bootstrap(async (url, init) => {
        if (!url.endsWith("/pulls")) return scripted(url, init);
        posts += 1;
        assert.equal(init.method, "POST");
        if (mode === "disconnect") throw new Error("synthetic disconnect");
        if (mode === "timeout") return new Promise(() => {});
        if (mode === "body-timeout")
          return new Response(new ReadableStream(), { status: 201 });
        if (mode === "declared-oversize")
          return new Response("{}", {
            status: 201,
            headers: { "content-length": "1048577" },
          });
        if (mode === "invalid-json") return new Response("{");
        if (mode === "invalid-result") return json({ number: 3 });
        return json({ message: "synthetic error" }, 500);
      }),
    );
    const result = await executor.execute(request);
    assert.deepEqual(
      result,
      {
        status: "outcome-unknown",
        code:
          mode.endsWith("timeout")
            ? "timeout"
            : mode === "invalid-result"
              ? "invalid-response"
              : "operation-failed",
      },
      mode,
    );
    assert.equal(posts, 1, "an uncertain PR creation must not be retried");
    assert.equal(
      calls.length,
      2,
      "installation and token checks precede the POST",
    );
    assert.equal(JSON.stringify(result).includes(tokenMarker), false);
  }

  let posts = 0;
  const scripted = apiScript({ calls: [], operation: "createPullRequest" });
  const executor = createOperationExecutor(
    bootstrap(async (url, init) => {
      if (url.endsWith("/access_tokens"))
        throw new Error("synthetic token failure");
      if (url.endsWith("/pulls")) posts += 1;
      return scripted(url, init);
    }),
  );
  assert.deepEqual(await executor.execute(request), {
    status: "denied",
    code: "operation-failed",
  });
  assert.equal(posts, 0, "a pre-dispatch failure must not create a PR");
}

async function testSameRepositoryHeads() {
  const sameBase = { owner: "acme", repo: "sample", branch: "main" };
  for (const [head, base] of [
    [{ owner: "simpsonm09", repo: "sample", branch: "feature" }, sameBase],
    [{ owner: "acme", repo: "other", branch: "feature" }, sameBase],
    [
      { owner: "acme", repo: "sample", branch: "feature" },
      { owner: "acme", repo: "other", branch: "main" },
    ],
  ]) {
    const calls = [];
    let signed = 0;
    const executor = createOperationExecutor(
      bootstrap(apiScript({ calls, operation: "createPullRequest" }), {
        signAppJwt: async () => { signed += 1; return jwtMarker; },
      }),
    );
    assert.deepEqual(await executor.execute({
      operationId: "createPullRequest",
      target,
      title: "fixture PR",
      head,
      base,
    }), { status: "denied", code: "invalid-request" });
    assert.equal(signed, 0);
    assert.equal(calls.length, 0);
  }
}

async function main() {
  await testSameRepositoryHeads();
  let signerCalls = 0;
  let calls = [];
  let executor = createOperationExecutor(
    bootstrap(apiScript({ calls }), {
      signAppJwt: async () => {
        signerCalls += 1;
        return jwtMarker;
      },
    }),
  );
  let result = await executor.execute({
    ...readRequest,
    allowed: true,
    policy: { org: "forged" },
  });
  assert.deepEqual(result, { status: "denied", code: "invalid-request" });
  assert.equal(signerCalls, 0);
  assert.equal(calls.length, 0);

  executor = createOperationExecutor(
    bootstrap(apiScript({ calls }), {
      signAppJwt: async () => {
        signerCalls += 1;
        return jwtMarker;
      },
    }),
  );
  result = await executor.execute({
    operationId: "readRepository",
    target: { ...target, repo: "unlisted" },
  });
  assert.equal(result.code, "policy-denied");
  assert.equal(signerCalls, 0);
  assert.equal(calls.length, 0);

  calls = [];
  executor = createOperationExecutor(
    bootstrap(apiScript({ calls }), {
      signAppJwt: async () => {
        signerCalls += 1;
        return jwtMarker;
      },
    }),
  );
  result = await executor.execute(readRequest);
  assert.deepEqual(result, {
    status: "completed",
    operation: "readRepository",
    repository: {
      fullName: "acme/sample",
      name: "sample",
      private: true,
      defaultBranch: "main",
    },
  });
  assert.deepEqual(
    calls.map(({ url, init }) => [init.method, url]),
    [
      ["GET", "https://api.github.com/repos/acme/sample/installation"],
      ["POST", "https://api.github.com/app/installations/12/access_tokens"],
      ["GET", "https://api.github.com/repos/acme/sample"],
    ],
  );
  assert.deepEqual(calls[1].body, {
    repositories: ["sample"],
    permissions: { contents: "read" },
  });
  assert.equal(calls[0].init.headers.authorization, `Bearer ${jwtMarker}`);
  assert.equal(calls[2].init.headers.authorization, `Bearer ${tokenMarker}`);
  assert.equal(JSON.stringify(result).includes(tokenMarker), false);

  const prCalls = [];
  executor = createOperationExecutor(
    bootstrap(apiScript({ calls: prCalls, operation: "createPullRequest" })),
  );
  result = await executor.execute({
    operationId: "createPullRequest",
    target,
    title: "fixture PR",
    head: { owner: "acme", repo: "sample", branch: "feature" },
    base: { owner: "acme", repo: "sample", branch: "main" },
    body: "bounded body",
    draft: true,
  });
  assert.equal(result.status, "completed");
  assert.equal(
    prCalls[2].url,
    "https://api.github.com/repos/acme/sample/pulls",
  );
  assert.equal(prCalls[2].init.method, "POST");
  assert.deepEqual(prCalls[1].body, {
    repositories: ["sample"],
    permissions: { pull_requests: "write" },
  });
  assert.deepEqual(prCalls[2].body, {
    title: "fixture PR",
    head: "feature",
    base: "main",
    body: "bounded body",
    draft: true,
  });

  for (const installation of [
    {
      app_id: 91,
      account: { login: "acme", type: "Organization" },
      permissions: { contents: "write" },
    },
    {
      id: 12,
      app_id: 999,
      account: { login: "acme", type: "Organization" },
      permissions: { contents: "write" },
    },
    {
      id: 12,
      app_id: 91,
      account: { login: "elsewhere" },
      permissions: { contents: "write" },
    },
    {
      id: 12,
      app_id: 91,
      account: { login: "acme", type: "Organization" },
      permissions: {},
    },
  ]) {
    const badCalls = [];
    executor = createOperationExecutor(
      bootstrap(apiScript({ installation, calls: badCalls })),
    );
    result = await executor.execute(readRequest);
    assert.equal(result.code, "installation-mismatch");
    assert.equal(badCalls.length, 1);
  }

  for (const token of [
    {
      token: tokenMarker,
      repositories: [{ full_name: "acme/other" }],
      permissions: { contents: "read" },
    },
    {
      token: tokenMarker,
      repositories: [{ full_name: "acme/sample" }],
      permissions: { contents: "write" },
    },
  ]) {
    const badCalls = [];
    executor = createOperationExecutor(
      bootstrap(apiScript({ token, calls: badCalls })),
    );
    result = await executor.execute(readRequest);
    assert.equal(result.code, "token-scope-mismatch");
    assert.equal(badCalls.length, 2);
  }

  for (const fetch of [
    async () => new Response("server secret sentinel", { status: 500 }),
    async () =>
      new Response("redirect", {
        status: 302,
        headers: { location: "https://evil.invalid" },
      }),
  ]) {
    const errorCalls = [];
    const scripted = apiScript({ calls: errorCalls });
    executor = createOperationExecutor(
      bootstrap(async (url, init) => {
        if (url.endsWith("/sample")) return fetch(url, init);
        return scripted(url, init);
      }),
    );
    result = await executor.execute(readRequest);
    assert.equal(result.code, "operation-failed");
    assert.equal(
      JSON.stringify(result).includes("server secret sentinel"),
      false,
    );
  }

  let step = 0;
  executor = createOperationExecutor(
    bootstrap(async () => {
      step += 1;
      if (step === 1)
        return json({
          id: 12,
          app_id: 91,
          account: { login: "acme", type: "Organization" },
          permissions: { contents: "write" },
        });
      if (step === 2)
        return json({
          token: tokenMarker,
          repositories: [{ full_name: "acme/sample" }],
          permissions: { contents: "read" },
        });
      return new Response("x".repeat(1024 * 1024 + 1));
    }),
  );
  result = await executor.execute(readRequest);
  assert.equal(result.code, "operation-failed");

  const wrongOwner = createOperationExecutor(
    bootstrap(
      async () => {
        throw new Error("must not fetch");
      },
      { registrationOwner: "someone-else" },
    ),
  );
  result = await wrongOwner.execute(readRequest);
  assert.equal(result.code, "invalid-request");

  const corrupt = bootstrap(async () => {
    throw new Error("must not fetch");
  });
  corrupt.policy.roster.expectedSHA256 = "0".repeat(64);
  result = await createOperationExecutor(corrupt).execute(readRequest);
  assert.equal(result.code, "bootstrap-invalid");

  executor = createOperationExecutor(bootstrap(apiScript({ calls: [] })));
  result = await executor.execute({
    operationId: "createIssue",
    target,
    title: "no",
  });
  assert.equal(result.code, "invalid-request");
  await testRequestSnapshot();
  await testInstallationType();
  await testResponseCleanup();
  await testChunkListeners();
  await testUnknownPrOutcome();
  console.log("fleet-app-operation-executor-fixture: passed");
}

await main();

import { createHash } from "node:crypto";
import {
  decideTarget,
  resolveDestination,
} from "../../scripts/agent-access.mjs";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_POLICY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^(?![-/.])(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;
const OPERATIONS = new Set(["readRepository", "createPullRequest"]);

function deny(code) {
  return { status: "denied", code };
}

function failure(progress, code) {
  return progress.writeDispatched
    ? { status: "outcome-unknown", code }
    : deny(code);
}

function ownKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function hasExactKeys(value, keys) {
  return ownKeys(value, keys) && keys.length === Object.keys(value).length;
}

function parsePinnedSnapshot(snapshot) {
  if (
    !ownKeys(snapshot, ["bytes", "expectedSHA256"]) ||
    typeof snapshot.bytes !== "string" ||
    Buffer.byteLength(snapshot.bytes, "utf8") > MAX_POLICY_BYTES ||
    !/^[a-f\d]{64}$/i.test(snapshot.expectedSHA256)
  )
    return null;
  const digest = createHash("sha256")
    .update(snapshot.bytes, "utf8")
    .digest("hex");
  if (digest !== snapshot.expectedSHA256.toLowerCase()) return null;
  try {
    return JSON.parse(snapshot.bytes);
  } catch {
    return null;
  }
}

function readTrustedConfig(config) {
  if (
    !ownKeys(config, [
      "appId",
      "registrationOwner",
      "manifestCeiling",
      "policy",
      "signAppJwt",
      "fetch",
    ]) ||
    !Number.isSafeInteger(config.appId) ||
    config.appId <= 0 ||
    typeof config.registrationOwner !== "string" ||
    !OWNER.test(config.registrationOwner) ||
    typeof config.signAppJwt !== "function" ||
    typeof config.fetch !== "function" ||
    !ownKeys(config.manifestCeiling, ["contents", "pull_requests"]) ||
    !hasExactKeys(config.policy, [
      "roster",
      "ownedForks",
      "ownedRepositories",
      "ignore",
    ])
  )
    return null;
  const policy = Object.fromEntries(
    Object.entries(config.policy).map(([key, value]) => [
      key,
      parsePinnedSnapshot(value),
    ]),
  );
  if (Object.values(policy).some((value) => value === null)) return null;
  return {
    appId: config.appId,
    registrationOwner: config.registrationOwner,
    manifestCeiling: Object.freeze({ ...config.manifestCeiling }),
    policy,
    signAppJwt: config.signAppJwt,
    fetch: config.fetch,
  };
}

function requiredPermissions(operation) {
  return operation === "readRepository"
    ? { contents: "read" }
    : { pull_requests: "write" };
}

function permissionGranted(granted, required) {
  const level = granted?.[Object.keys(required)[0]];
  return (
    level === "write" ||
    (level === "read" && Object.values(required)[0] === "read")
  );
}

function tokenPermissionsMatch(actual, required) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual))
    return false;
  return (
    Object.entries(actual).every(
      ([name, access]) =>
        (name === "metadata" && access === "read") || required[name] === access,
    ) &&
    Object.entries(required).every(([name, access]) => actual[name] === access)
  );
}

function validTarget(target, owner) {
  return (
    ownKeys(target, ["host", "owner", "repo"]) &&
    target.host === "github.com" &&
    typeof target.owner === "string" &&
    OWNER.test(target.owner) &&
    target.owner.toLowerCase() === owner.toLowerCase() &&
    typeof target.repo === "string" &&
    REPO.test(target.repo)
  );
}

function makeIntent(request) {
  if (
    request.operationId === "readRepository" &&
    ownKeys(request, ["operationId", "target"])
  ) {
    return { operation: "read", capability: null, readOnly: true };
  }
  if (
    request.operationId !== "createPullRequest" ||
    !ownKeys(request, [
      "operationId",
      "target",
      "title",
      "head",
      "base",
      "body",
      "draft",
    ])
  )
    return null;
  if (
    typeof request.title !== "string" ||
    request.title.trim().length === 0 ||
    request.title.length > 256 ||
    (request.body !== undefined &&
      (typeof request.body !== "string" || request.body.length > 65_536)) ||
    (request.draft !== undefined && typeof request.draft !== "boolean")
  )
    return null;
  for (const side of [request.head, request.base]) {
    if (
      !ownKeys(side, ["owner", "repo", "branch"]) ||
      typeof side.owner !== "string" ||
      !OWNER.test(side.owner) ||
      typeof side.repo !== "string" ||
      !REPO.test(side.repo) ||
      typeof side.branch !== "string" ||
      !BRANCH.test(side.branch) ||
      side.owner.toLowerCase() !== request.target.owner.toLowerCase() ||
      side.repo.toLowerCase() !== request.target.repo.toLowerCase()
    )
      return null;
  }
  return {
    operation: "openPr",
    capability: "openPr",
    readOnly: false,
    resolved: true,
    head: { owner: request.head.owner, repo: request.head.repo },
    base: { owner: request.base.owner, repo: request.base.repo },
  };
}

function cancelBody(body) {
  try {
    Promise.resolve(body?.cancel()).catch(() => {});
  } catch {
    // Cancellation must not replace the fixed operation result.
  }
}

async function withAbort(start, signal) {
  if (signal.aborted) throw new Error("aborted");
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(start), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readResponse(response, signal) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (
    response.redirected === true ||
    (response.status >= 300 && response.status < 400) ||
    !response.body?.getReader ||
    (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
  ) {
    cancelBody(response.body);
    return null;
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await withAbort(() => reader.read(), signal);
      if (done) {
        complete = true;
        break;
      }
      if (
        !(value instanceof Uint8Array) ||
        size + value.byteLength > MAX_RESPONSE_BYTES
      )
        return null;
      bytes.set(value, size);
      size += value.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
  } catch {
    return null;
  } finally {
    if (!complete) cancelBody(reader);
    reader.releaseLock();
  }
}

async function apiRequest(
  config,
  path,
  method,
  bearer,
  body,
  signal,
  onDispatch,
) {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${bearer}`,
    "x-github-api-version": API_VERSION,
    "user-agent": "fleet-app-operation-executor",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await withAbort(() => {
    onDispatch?.();
    return config
      .fetch(`${API}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal,
      })
      .then((result) => {
        if (signal.aborted) cancelBody(result?.body);
        return result;
      });
  }, signal);
  if (!response?.ok) {
    cancelBody(response?.body);
    return null;
  }
  return readResponse(response, signal);
}

function exactRepositoryScope(repositories, target) {
  if (!Array.isArray(repositories) || repositories.length !== 1) return false;
  const entry = repositories[0];
  const fullName =
    typeof entry?.full_name === "string" ? entry.full_name : null;
  return (
    fullName !== null &&
    fullName.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase()
  );
}

function publicResult(operation, data, target) {
  if (operation === "readRepository") {
    if (
      typeof data?.full_name !== "string" ||
      typeof data?.name !== "string" ||
      data.full_name.toLowerCase() !==
        `${target.owner}/${target.repo}`.toLowerCase() ||
      typeof data?.private !== "boolean" ||
      typeof data?.default_branch !== "string"
    )
      return deny("invalid-response");
    return {
      status: "completed",
      operation,
      repository: {
        fullName: data.full_name.slice(0, 202),
        name: data.name.slice(0, 100),
        private: data.private,
        defaultBranch: data.default_branch.slice(0, 200),
      },
    };
  }
  const expectedUrl = `https://github.com/${target.owner}/${target.repo}/pull/${data?.number}`;
  if (
    !Number.isSafeInteger(data?.number) ||
    data.number < 1 ||
    typeof data?.title !== "string" ||
    typeof data?.html_url !== "string" ||
    data.html_url.toLowerCase() !== expectedUrl.toLowerCase() ||
    typeof data?.state !== "string"
  )
    return deny("invalid-response");
  return {
    status: "completed",
    operation,
    pullRequest: {
      number: data.number,
      title: data.title.slice(0, 256),
      url: data.html_url.slice(0, 512),
      state: data.state.slice(0, 32),
    },
  };
}

function authorizeRequest(config, request) {
  if (
    !ownKeys(request, [
      "operationId",
      "target",
      "title",
      "head",
      "base",
      "body",
      "draft",
    ]) ||
    !OPERATIONS.has(request?.operationId) ||
    !validTarget(request.target, config.registrationOwner)
  )
    return deny("invalid-request");
  const intent = makeIntent(request);
  if (!intent) return deny("invalid-request");
  const required = requiredPermissions(request.operationId);
  const permission = Object.keys(required)[0];
  if (
    !permissionGranted(
      { [permission]: config.manifestCeiling[permission] },
      required,
    )
  )
    return deny("permission-unavailable");

  const resolved = resolveDestination({
    ...config.policy,
    localRepo: undefined,
    host: request.target.host,
    destination: `${request.target.owner}/${request.target.repo}`,
  });
  if (
    resolved.kind !== "org" ||
    decideTarget(resolved, intent).allowed !== true
  )
    return deny("policy-denied");
  return {
    request,
    required,
    target: { owner: resolved.owner, repo: resolved.repo },
  };
}

async function signJwt(config, signal) {
  const jwt = await withAbort(
    () => config.signAppJwt({ appId: config.appId, signal }),
    signal,
  );
  return typeof jwt === "string" && jwt.length > 0 && jwt.length <= 8192
    ? jwt
    : null;
}

async function findInstallation(config, target, jwt, required, signal) {
  const installation = await apiRequest(
    config,
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/installation`,
    "GET",
    jwt,
    undefined,
    signal,
  );
  if (
    !Number.isSafeInteger(installation?.id) ||
    installation.id < 1 ||
    installation.app_id !== config.appId ||
    installation.account?.type !== "Organization" ||
    typeof installation.account?.login !== "string" ||
    installation.account.login.toLowerCase() !==
      config.registrationOwner.toLowerCase() ||
    !permissionGranted(installation.permissions, required)
  )
    return null;
  return installation;
}

async function mintNarrowToken(
  config,
  installation,
  target,
  jwt,
  required,
  signal,
) {
  const token = await apiRequest(
    config,
    `/app/installations/${installation.id}/access_tokens`,
    "POST",
    jwt,
    { repositories: [target.repo], permissions: required },
    signal,
  );
  if (
    typeof token?.token !== "string" ||
    token.token.length < 1 ||
    token.token.length > 8192 ||
    !exactRepositoryScope(token.repositories, target) ||
    !tokenPermissionsMatch(token.permissions, required)
  )
    return null;
  return token.token;
}

async function invokeEndpoint(
  config,
  request,
  target,
  token,
  signal,
  progress,
) {
  const repoPath = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  if (request.operationId === "readRepository")
    return apiRequest(config, repoPath, "GET", token, undefined, signal);
  return apiRequest(
    config,
    `${repoPath}/pulls`,
    "POST",
    token,
    {
      title: request.title,
      head: request.head.branch,
      base: request.base.branch,
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.draft === undefined ? {} : { draft: request.draft }),
    },
    signal,
    () => {
      progress.writeDispatched = true;
    },
  );
}

async function executeAuthorized(config, authorized, signal, progress) {
  const jwt = await signJwt(config, signal);
  if (!jwt) return deny("signing-failed");
  const installation = await findInstallation(
    config,
    authorized.target,
    jwt,
    authorized.required,
    signal,
  );
  if (!installation) return deny("installation-mismatch");
  const token = await mintNarrowToken(
    config,
    installation,
    authorized.target,
    jwt,
    authorized.required,
    signal,
  );
  if (!token) return deny("token-scope-mismatch");
  const data = await invokeEndpoint(
    config,
    authorized.request,
    authorized.target,
    token,
    signal,
    progress,
  );
  return data
    ? publicResult(authorized.request.operationId, data, authorized.target)
    : deny("operation-failed");
}

function snapshotRequest(value, depth = 0) {
  if (value === null || typeof value !== "object") {
    if (["string", "boolean", "undefined"].includes(typeof value)) return value;
    throw new Error("invalid-request");
  }
  if (
    depth > 2 ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("invalid-request");
  const fields = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(fields);
  if (keys.length > 8) throw new Error("invalid-request");
  const snapshot = Object.create(null);
  for (const key of keys) {
    const descriptor = fields[key];
    if (typeof key !== "string" || !("value" in descriptor))
      throw new Error("invalid-request");
    snapshot[key] = snapshotRequest(descriptor.value, depth + 1);
  }
  return Object.freeze(snapshot);
}

function safeConfig(bootstrap) {
  try {
    return readTrustedConfig(bootstrap);
  } catch {
    return null;
  }
}

/** Build a local executor. This factory is not an isolation boundary. */
export function createOperationExecutor(trustedBootstrap) {
  const config = safeConfig(trustedBootstrap);
  if (!config)
    return Object.freeze({ execute: async () => deny("bootstrap-invalid") });

  return Object.freeze({
    async execute(request) {
      let authorized;
      try {
        authorized = authorizeRequest(config, snapshotRequest(request));
      } catch {
        return deny("invalid-request");
      }
      if (authorized.status === "denied") return authorized;
      const progress = { writeDispatched: false };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const result = await executeAuthorized(
          config,
          authorized,
          controller.signal,
          progress,
        );
        if (result.status !== "denied") return result;
        return failure(
          progress,
          controller.signal.aborted ? "timeout" : result.code,
        );
      } catch {
        return failure(
          progress,
          controller.signal.aborted ? "timeout" : "operation-failed",
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

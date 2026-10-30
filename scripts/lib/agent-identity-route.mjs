// Pure, unconsumed contract planner. No credential or network operations.
import { decideTarget, resolveDestination } from "../agent-access.mjs";

const PERMISSION_LEVELS = ["read", "write"];

// Supported operation examples, not a repository capability grant table.
function operationPermissions(intent) {
  if (
    intent?.operation === "read" &&
    intent.readOnly === true &&
    intent.capability === null
  )
    return { contents: "read" };
  if (
    intent?.operation === "push" &&
    intent.capability === "pushBranch" &&
    intent.readOnly === false
  )
    return { contents: "write" };
  if (
    intent?.operation === "openPr" &&
    intent.capability === "openPr" &&
    intent.readOnly === false
  )
    return { pull_requests: "write" };
  return null;
}

function matchesPermissions(required, expected) {
  return (
    expected !== null &&
    required !== null &&
    typeof required === "object" &&
    !Array.isArray(required) &&
    Object.keys(required).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => required[key] === value)
  );
}

function sameIdentity(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function hasPermission(granted, required) {
  return (
    PERMISSION_LEVELS.includes(granted) &&
    PERMISSION_LEVELS.includes(required) &&
    (granted === "write" || required === "read")
  );
}

function denied(reason) {
  return { status: "denied", route: "agent-app", evidence: "planned", reason };
}

function validPermissions(required, appPermissions, granted) {
  if (
    !required ||
    typeof required !== "object" ||
    Array.isArray(required) ||
    Object.keys(required).length === 0
  )
    return false;
  if (
    !appPermissions ||
    typeof appPermissions !== "object" ||
    Array.isArray(appPermissions)
  )
    return false;
  if (!granted || typeof granted !== "object" || Array.isArray(granted))
    return false;
  return Object.entries(required).every(
    ([permission, access]) =>
      typeof permission === "string" &&
      permission.length > 0 &&
      Object.hasOwn(appPermissions, permission) &&
      Object.hasOwn(granted, permission) &&
      hasPermission(appPermissions[permission], access) &&
      hasPermission(granted[permission], access),
  );
}

/**
 * Re-evaluate shared policy for this exact target and intent. Policy data and
 * installation observations remain trusted caller inputs, not authenticated evidence.
 */
export function planAgentIdentityRoute({
  invocation,
  policy,
  intent,
  target,
  installation,
  requiredPermissions,
} = {}) {
  if (invocation === "human") {
    return {
      status: "pass-through",
      route: "human-session",
      authorization: "not-governed",
    };
  }
  if (invocation !== "agent") return denied("invalid-input");
  const resolvedTarget = resolveDestination({
    ...policy,
    host: target?.host,
    destination: `${target?.owner}/${target?.repo}`,
  });
  if (decideTarget(resolvedTarget, intent).allowed !== true)
    return denied("policy-denied");
  if (!matchesPermissions(requiredPermissions, operationPermissions(intent)))
    return denied("permission-unavailable");
  if (!installation) return denied("installation-missing");

  const targetOwner = target?.owner;
  const targetRepo = target?.repo;
  const accountOwner = installation.accountOwner;
  const selected = installation.repositories;
  if (
    target?.host !== "github.com" ||
    !targetOwner ||
    !targetRepo ||
    !sameIdentity(targetOwner, accountOwner) ||
    !Array.isArray(selected) ||
    !selected.some(
      (repository) =>
        sameIdentity(repository?.owner, targetOwner) &&
        sameIdentity(repository?.repo, targetRepo),
    )
  ) {
    return denied("target-mismatch");
  }
  if (
    !validPermissions(
      requiredPermissions,
      installation.appPermissions,
      installation.permissions,
    )
  ) {
    return denied("permission-unavailable");
  }

  return {
    status: "ready",
    route: "agent-app",
    evidence: "planned",
    target: { host: target.host, owner: targetOwner, repo: targetRepo },
    tokenPermissions: { ...requiredPermissions },
  };
}

/**
 * Test-only contract port. It is not a broker or runtime enforcement boundary.
 * Credential handles remain local to this call and are never returned.
 */
export async function runThroughTestPorts(
  plan,
  { mintCredential, invoke } = {},
) {
  if (plan?.status !== "ready" || plan.route !== "agent-app")
    return { status: "not-invoked" };
  if (typeof mintCredential !== "function" || typeof invoke !== "function") {
    return { status: "denied", reason: "credential-unavailable" };
  }
  let credential;
  try {
    credential = await mintCredential({
      target: plan.target,
      permissions: plan.tokenPermissions,
    });
    if (
      credential === null ||
      (typeof credential !== "object" && typeof credential !== "symbol")
    ) {
      return { status: "denied", reason: "credential-unavailable" };
    }
  } catch {
    return { status: "denied", reason: "credential-unavailable" };
  }
  try {
    await invoke({ target: plan.target, credential });
    return { status: "invoked" };
  } catch {
    return { status: "denied", reason: "invocation-failed" };
  }
}

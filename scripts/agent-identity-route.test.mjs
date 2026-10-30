#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  planAgentIdentityRoute,
  runThroughTestPorts,
} from "./lib/agent-identity-route.mjs";
import { EXIT } from "./lib/exit.mjs";
import { isMain } from "./lib/proc.mjs";

const contract = JSON.parse(
  readFileSync(
    new URL("../contracts/agent-app-behavior.v1.json", import.meta.url),
    "utf8",
  ),
);
const manifest = JSON.parse(
  readFileSync(new URL("../agent-app.manifest.json", import.meta.url), "utf8"),
);
const fixtureDir = new URL("./fixtures/agent-access/", import.meta.url);
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8"));
const roster = fixture("repos.json");
const ownedForks = fixture("owned-forks.json");
const ownedRepositories = fixture("owned-repositories.json");
const ignored = {
  ignore: [
    {
      name: "fixture-ignored",
      reason: "route fixture",
      agentAccessIgnore: ["acme/fixture-ignored"],
    },
  ],
};
const target = (owner, repo) => ({ host: "github.com", owner, repo });
const selectedInstallation = (
  owner,
  repo,
  permissions = { contents: "write", pull_requests: "write", metadata: "read" },
) => ({
  accountOwner: owner,
  repositories: [{ owner, repo }],
  appPermissions: manifest.default_permissions,
  permissions,
});

function plan(destination, ignore, intent, installation, requiredPermissions) {
  return planAgentIdentityRoute({
    invocation: "agent",
    policy: {
      roster,
      ownedForks,
      ownedRepositories,
      ignore,
      localRepo: destination.repo,
    },
    intent,
    target: destination,
    installation,
    requiredPermissions,
  });
}

async function testRoutes() {
  assert.equal(
    contract.identityRoutingTarget.status,
    "planned-unconsumed-contract",
  );
  assert.deepEqual(contract.identityRoutingTarget.evidenceStates, [
    "planned",
    "observed-app",
    "observed-human",
    "unknown",
  ]);
  assert.equal(
    contract.identityRoutingTarget.runtimeAdoption.includes("unconsumed"),
    true,
  );
  const org = target("simpsonm09-org", "simpsonm09-fixture-nest");
  const fork = target("simpsonm09", "simpsonm09-fixture-nest");
  const readIntent = {
    operation: "read",
    capability: null,
    readOnly: true,
    resolved: true,
  };
  const pushIntent = {
    operation: "push",
    capability: "pushBranch",
    readOnly: false,
    resolved: true,
    refs: [{ kind: "branch", name: "feat/identity", isDefault: false }],
  };
  const prIntent = {
    operation: "openPr",
    capability: "openPr",
    readOnly: false,
    resolved: true,
  };
  const orgInstall = selectedInstallation(org.owner, org.repo);
  const forkInstall = selectedInstallation(fork.owner, fork.repo);

  const orgRead = plan(org, ignored, readIntent, orgInstall, {
    contents: "read",
  });
  assert.equal(
    orgRead.status,
    "ready",
    "org repository read plans an App route",
  );
  assert.deepEqual(
    orgRead.tokenPermissions,
    { contents: "read" },
    "token scope narrows a write-capable installation to read",
  );
  assert.equal(
    orgRead.evidence,
    "planned",
    "the planner does not claim observed actor evidence",
  );

  const orgPr = plan(org, ignored, prIntent, orgInstall, {
    pull_requests: "write",
  });
  assert.equal(orgPr.status, "ready", "org PR creation plans an App route");
  const forkRead = plan(fork, ignored, readIntent, forkInstall, {
    contents: "read",
  });
  assert.equal(
    forkRead.status,
    "ready",
    "personal fork read plans an App route",
  );
  const forkPush = plan(fork, ignored, pushIntent, forkInstall, {
    contents: "write",
  });
  assert.equal(
    forkPush.status,
    "ready",
    "personal fork branch push plans an App route",
  );
  const otherHost = plan(
    { ...org, host: "gitlab.com" },
    ignored,
    readIntent,
    orgInstall,
    { contents: "read" },
  );
  assert.equal(
    otherHost.reason,
    "target-mismatch",
    "a non-GitHub read cannot use this App route",
  );
  const caseVariant = plan(
    target(org.owner.toUpperCase(), org.repo.toUpperCase()),
    ignored,
    readIntent,
    orgInstall,
    { contents: "read" },
  );
  assert.equal(
    caseVariant.status,
    "ready",
    "case variants of the same account and repository match",
  );

  const ignoredTarget = target("acme", "fixture-ignored");
  const ignoredPlan = plan(
    ignoredTarget,
    ignored,
    readIntent,
    selectedInstallation("acme", "fixture-ignored"),
    { contents: "read" },
  );
  assert.deepEqual(
    ignoredPlan,
    {
      status: "denied",
      route: "agent-app",
      evidence: "planned",
      reason: "policy-denied",
    },
    "resolver denial is preserved",
  );
  const deniedCalls = { mint: 0, invoke: 0 };
  const deniedResult = await runThroughTestPorts(ignoredPlan, {
    mintCredential: async () => {
      deniedCalls.mint += 1;
      throw new Error("must not mint");
    },
    invoke: async () => {
      deniedCalls.invoke += 1;
    },
  });
  assert.deepEqual(
    deniedCalls,
    { mint: 0, invoke: 0 },
    "policy denial never reaches a credential or invocation port",
  );

  assert.deepEqual(deniedResult, { status: "not-invoked" });

  assert.equal(
    plan(org, ignored, readIntent, null, { contents: "read" }).reason,
    "installation-missing",
  );
  assert.equal(
    plan(fork, ignored, pushIntent, null, { contents: "write" }).reason,
    "installation-missing",
    "agent writes require installation too",
  );
  assert.equal(
    plan(org, ignored, readIntent, orgInstall, { contents: "admin" }).reason,
    "permission-unavailable",
    "unknown permission level fails closed",
  );
  assert.equal(
    plan(org, ignored, readIntent, orgInstall, { issues: "read" }).reason,
    "permission-unavailable",
    "permission outside the App manifest ceiling fails closed",
  );
  assert.equal(
    plan(
      org,
      ignored,
      readIntent,
      selectedInstallation(org.owner, org.repo, { pull_requests: "write" }),
      { contents: "read" },
    ).reason,
    "permission-unavailable",
    "read permission is required for reads too",
  );
  assert.equal(
    plan(
      org,
      ignored,
      readIntent,
      selectedInstallation("simpsonm09", org.repo),
      { contents: "read" },
    ).reason,
    "target-mismatch",
    "installation from another owner cannot route this target",
  );
  assert.equal(
    plan(
      org,
      ignored,
      readIntent,
      selectedInstallation(org.owner, "another-repo"),
      { contents: "read" },
    ).reason,
    "target-mismatch",
    "unselected repository cannot route this target",
  );
  assert.equal(
    plan(
      org,
      ignored,
      pushIntent,
      selectedInstallation(org.owner, org.repo, { contents: "read" }),
      { contents: "write" },
    ).reason,
    "permission-unavailable",
    "installation permission ceiling is enforced",
  );
  assert.equal(
    plan(
      fork,
      ignored,
      pushIntent,
      selectedInstallation(fork.owner, fork.repo, { contents: "read" }),
      { contents: "write" },
    ).reason,
    "permission-unavailable",
    "write permission cannot exceed the accepted installation grant",
  );

  assert.equal(
    plan(org, ignored, readIntent, orgInstall, { contents: "write" }).reason,
    "permission-unavailable",
    "read intent cannot request write-scoped credentials",
  );
  const replayed = planAgentIdentityRoute({
    invocation: "agent",
    policyDecision: { allowed: true, target: org, intent: readIntent },
    policy: {
      roster,
      ownedForks,
      ownedRepositories,
      ignore: ignored,
      localRepo: org.repo,
    },
    intent: readIntent,
    target: ignoredTarget,
    installation: selectedInstallation(ignoredTarget.owner, ignoredTarget.repo),
    requiredPermissions: { contents: "read" },
  });
  assert.equal(
    replayed.reason,
    "policy-denied",
    "an allow from another destination is not consumed",
  );
  assert.equal(
    planAgentIdentityRoute({ invocation: "unknown" }).reason,
    "invalid-input",
  );
  for (const permissions of [
    null,
    [],
    {},
    { contents: "read", pull_requests: "write" },
  ]) {
    assert.equal(
      plan(org, ignored, readIntent, orgInstall, permissions).status,
      "denied",
    );
  }
  for (const installation of [
    { ...orgInstall, repositories: {} },
    { ...orgInstall, appPermissions: [] },
    { ...orgInstall, permissions: null },
  ]) {
    assert.equal(
      plan(org, ignored, readIntent, installation, { contents: "read" }).status,
      "denied",
    );
  }

  const human = planAgentIdentityRoute({
    invocation: "human",
    target: org,
    installation: null,
  });
  assert.deepEqual(
    human,
    {
      status: "pass-through",
      route: "human-session",
      authorization: "not-governed",
    },
    "human invocation passes through without an authorization grant",
  );
  let humanPortCalls = 0;
  const humanPortResult = await runThroughTestPorts(human, {
    mintCredential: async () => {
      humanPortCalls += 1;
      return Object.freeze({});
    },
    invoke: async () => {
      humanPortCalls += 1;
    },
  });
  assert.equal(humanPortResult.status, "not-invoked");
  assert.equal(
    humanPortCalls,
    0,
    "human pass-through does not mint or invoke any credential route",
  );

  const attempts = { mint: 0, invoke: 0 };
  const mintFailure = await runThroughTestPorts(orgPr, {
    mintCredential: async () => {
      attempts.mint += 1;
      throw new Error("fake mint failure");
    },
    invoke: async () => {
      attempts.invoke += 1;
    },
  });
  assert.deepEqual(mintFailure, {
    status: "denied",
    reason: "credential-unavailable",
  });
  assert.equal(
    attempts.invoke,
    0,
    "mint failure never invokes the target or an ambient fallback",
  );
  assert.equal(attempts.mint, 1, "the fake token port was called once");

  const invokeFailure = await runThroughTestPorts(orgPr, {
    mintCredential: async () => Object.freeze({}),
    invoke: async () => {
      throw new Error("fake invocation failure");
    },
  });
  assert.deepEqual(invokeFailure, {
    status: "denied",
    reason: "invocation-failed",
  });

  const credential = Object.freeze({ opaqueTestHandle: true });
  let observedCredential;
  const invoked = await runThroughTestPorts(orgPr, {
    mintCredential: async () => credential,
    invoke: async (input) => {
      observedCredential = input.credential;
    },
  });
  assert.equal(invoked.status, "invoked");
  assert.equal(
    observedCredential,
    credential,
    "opaque handle stays inside the test-port invocation",
  );
  assert.deepEqual(
    invoked,
    { status: "invoked" },
    "neither the handle nor invocation result is returned",
  );
}

export async function runTest() {
  try {
    await testRoutes();
    process.stdout.write("agent-identity-route: all assertions passed\n");
    return EXIT.OK;
  } catch (error) {
    process.stderr.write(`agent-identity-route: ${error.message}\n`);
    return EXIT.FAIL;
  }
}

if (isMain(import.meta.url)) process.exit(await runTest());

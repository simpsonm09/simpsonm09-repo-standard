import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runGit } from "./git-read.mjs";

export const PUSH_FACT_LIMITS = Object.freeze({
  commits: 500,
  objects: 10_000,
  paths: 20_000,
  commandOutputBytes: 8 * 1024 * 1024,
  totalOutputBytes: 64 * 1024 * 1024,
  commandTimeoutMs: 30_000,
  totalTimeoutMs: 60_000,
  parentsPerCommit: 16,
});

const ZERO_ID = /^0+$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function splitNul(buffer) {
  if (buffer.length === 0) return [];
  if (buffer[buffer.length - 1] !== 0)
    fail("GIT_QUERY_FAILED", "Git returned incomplete path data");
  const parts = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      parts.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  return parts;
}

function pathFact(pathBytes) {
  return {
    path: pathBytes.toString("utf8"),
    pathBase64: pathBytes.toString("base64"),
  };
}

function parseRawDiff(buffer, commitId, parentIndex) {
  const fields = splitNul(buffer);
  const changes = [];
  for (let index = 0; index < fields.length; ) {
    const header = fields[index++].toString("ascii");
    const match =
      /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z][0-9]*)$/.exec(
        header,
      );
    if (!match || index >= fields.length)
      fail("GIT_QUERY_FAILED", "Git returned malformed raw path data");
    const [, oldMode, newMode, oldObjectId, newObjectId, status] = match;
    const pathBytes = fields[index++];
    const path = pathFact(pathBytes);
    changes.push({
      commitId,
      parentIndex,
      status,
      oldMode,
      newMode,
      oldObjectId,
      newObjectId,
      ...path,
      workflowPath:
        path.path.toLowerCase().startsWith(".github/workflows/") ||
        path.path.toLowerCase() === ".github/workflows" ||
        path.path.toLowerCase() === ".github",
      deleted: status === "D",
      symlink: oldMode === "120000" || newMode === "120000",
      submodule: oldMode === "160000" || newMode === "160000",
    });
  }
  return changes;
}

async function resolveCommit(repositoryRoot, objectId, limits, state) {
  let resolved;
  try {
    resolved = (
      await runGit(
        repositoryRoot,
        ["rev-parse", "--verify", `${objectId}^{commit}`],
        limits,
        state,
      )
    )
      .toString("ascii")
      .trim();
  } catch (error) {
    if (error.code?.startsWith("GIT_EXIT_"))
      fail("MISSING_OBJECT", "An endpoint commit object is unavailable");
    throw error;
  }
  if (resolved !== objectId)
    fail(
      "INVALID_OBJECT",
      "An endpoint is not the exact commit object requested",
    );
  return resolved;
}

function validateEndpoint(value, label) {
  if (typeof value !== "string" || !OID.test(value))
    fail(
      "INVALID_OBJECT_ID",
      `${label} must be a full 40- or 64-character object ID`,
    );
}

function resolveLimits(suppliedLimits) {
  if (suppliedLimits === undefined) return PUSH_FACT_LIMITS;
  if (
    !suppliedLimits ||
    typeof suppliedLimits !== "object" ||
    Array.isArray(suppliedLimits)
  ) {
    fail(
      "INVALID_LIMITS",
      "Limits must be an object that only lowers built-in bounds",
    );
  }
  const limits = { ...PUSH_FACT_LIMITS };
  for (const [name, value] of Object.entries(suppliedLimits)) {
    if (
      !Object.hasOwn(PUSH_FACT_LIMITS, name) ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > PUSH_FACT_LIMITS[name]
    ) {
      fail(
        "INVALID_LIMITS",
        "Limits must be safe integers no greater than built-in bounds",
      );
    }
    limits[name] = value;
  }
  if (
    limits.commandOutputBytes < 1 ||
    limits.totalOutputBytes < 1 ||
    limits.commandTimeoutMs < 1 ||
    limits.totalTimeoutMs < 1 ||
    limits.parentsPerCommit < 1
  ) {
    fail("INVALID_LIMITS", "Output and time bounds must be positive");
  }
  return limits;
}

function canonicalRoot(directory) {
  try {
    return realpathSync(directory);
  } catch {
    fail(
      "INVALID_REPOSITORY_ROOT",
      "An accessible repository root is required",
    );
  }
}

async function validateRepositoryRoot(repositoryRoot, limits, state) {
  let root;
  let declaredRoot;
  try {
    root = canonicalRoot(repositoryRoot);
    const flags = (
      await runGit(
        repositoryRoot,
        ["rev-parse", "--is-bare-repository", "--is-shallow-repository"],
        limits,
        state,
      )
    )
      .toString("ascii")
      .trim()
      .split(/\r?\n/);
    if (flags[1] === "true")
      fail("SHALLOW_REPOSITORY", "Shallow repository history is incomplete");
    if (!["true", "false"].includes(flags[0]) || flags[1] !== "false")
      fail(
        "INVALID_REPOSITORY_ROOT",
        "Unable to verify repository history and root",
      );
    const arg = flags[0] === "true" ? "--absolute-git-dir" : "--show-toplevel";
    const location = (
      await runGit(repositoryRoot, ["rev-parse", arg], limits, state)
    )
      .toString("utf8")
      .trim();
    declaredRoot = canonicalRoot(resolve(location));
  } catch (error) {
    if (error.code?.startsWith("GIT_EXIT_"))
      fail(
        "INVALID_REPOSITORY_ROOT",
        "An accessible repository root is required",
      );
    throw error;
  }
  const normalize = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(root) !== normalize(declaredRoot))
    fail(
      "INVALID_REPOSITORY_ROOT",
      "The supplied directory must be the repository root",
    );
}

async function assertAncestor(
  repositoryRoot,
  oldCommit,
  newCommit,
  limits,
  state,
) {
  try {
    await runGit(
      repositoryRoot,
      ["merge-base", "--is-ancestor", oldCommit, newCommit],
      limits,
      state,
    );
  } catch (error) {
    if (error.code === "GIT_EXIT_1")
      fail(
        "NON_ANCESTOR_BASE",
        "The old endpoint is not an ancestor of the new endpoint",
      );
    throw error;
  }
}

async function readRangeCommits(
  repositoryRoot,
  oldCommit,
  newCommit,
  limits,
  state,
) {
  const output = await runGit(
    repositoryRoot,
    [
      "rev-list",
      "--reverse",
      "--topo-order",
      `--max-count=${limits.commits + 1}`,
      `${oldCommit}..${newCommit}`,
    ],
    limits,
    state,
  );
  const commitLines = output.toString("ascii").trim();
  const commits = commitLines ? commitLines.split(/\r?\n/) : [];
  if (commits.length > limits.commits)
    fail("COMMIT_LIMIT", "Push range exceeds the commit bound");
  return commits;
}

async function countRangeObjects(
  repositoryRoot,
  oldCommit,
  newCommit,
  limits,
  state,
) {
  const objectsOutput = await runGit(
    repositoryRoot,
    [
      "rev-list",
      "--objects",
      "--no-object-names",
      "-z",
      `${oldCommit}..${newCommit}`,
    ],
    limits,
    state,
  );
  const objectIds = splitNul(objectsOutput).map((item) =>
    item.toString("ascii"),
  );
  const count = new Set(objectIds).size;
  if (count > limits.objects)
    fail("OBJECT_LIMIT", "Push range exceeds the object bound");
  return count;
}

async function diffCommit(repositoryRoot, commitId, limits, state) {
  const parentLine = (
    await runGit(
      repositoryRoot,
      ["rev-list", "--parents", "-n", "1", commitId],
      limits,
      state,
    )
  )
    .toString("ascii")
    .trim();
  const parents = parentLine.split(" ").slice(1);
  if (parents.length > limits.parentsPerCommit)
    fail("PARENT_LIMIT", "A commit exceeds the merge-parent bound");
  const parentIds = parents.length ? parents : [null];
  const changes = [];
  for (const [parentIndex, parentId] of parentIds.entries()) {
    const args = [
      "diff-tree",
      "--raw",
      "-r",
      "-z",
      "--no-commit-id",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
    ];
    if (!parentId) args.push("--root");
    args.push(...(parentId ? [parentId, commitId] : [commitId]));
    const raw = await runGit(repositoryRoot, args, limits, state);
    const parsed = parseRawDiff(raw, commitId, parentIndex);
    state.pathCount += parsed.length;
    if (state.pathCount > limits.paths)
      fail("PATH_LIMIT", "Push range exceeds the changed-path bound");
    changes.push(...parsed);
  }
  return { changes, mergeCommit: parents.length > 1 };
}

async function collectCommitChanges(repositoryRoot, commits, limits, state) {
  const changes = [];
  const mergeCommits = [];
  for (const commitId of commits) {
    const result = await diffCommit(repositoryRoot, commitId, limits, state);
    changes.push(...result.changes);
    mergeCommits.push(result.mergeCommit);
    if (changes.length > limits.paths)
      fail("PATH_LIMIT", "Push range exceeds the changed-path bound");
  }
  return { changes, mergeCommits };
}

export async function collectPushRangeFacts({
  repositoryRoot,
  oldObjectId,
  newObjectId,
  limits: suppliedLimits,
} = {}) {
  if (
    typeof repositoryRoot !== "string" ||
    !repositoryRoot ||
    !isAbsolute(repositoryRoot)
  ) {
    fail(
      "INVALID_REPOSITORY_ROOT",
      "An explicit absolute repository root is required",
    );
  }
  const limits = resolveLimits(suppliedLimits);
  const state = {
    outputBytes: 0,
    pathCount: 0,
    deadlineAt: performance.now() + limits.totalTimeoutMs,
  };
  if (oldObjectId === undefined || newObjectId === undefined)
    fail("MISSING_ENDPOINT", "Both old and new object IDs are required");
  validateEndpoint(oldObjectId, "oldObjectId");
  validateEndpoint(newObjectId, "newObjectId");
  if (oldObjectId.length !== newObjectId.length)
    fail(
      "INVALID_OBJECT_ID",
      "Object IDs must use the same repository object format",
    );
  await validateRepositoryRoot(repositoryRoot, limits, state);

  const format = (
    await runGit(
      repositoryRoot,
      ["rev-parse", "--show-object-format=storage"],
      limits,
      state,
    )
  )
    .toString("ascii")
    .trim();
  if (
    (format === "sha1" && oldObjectId.length !== 40) ||
    (format === "sha256" && oldObjectId.length !== 64) ||
    !["sha1", "sha256"].includes(format)
  ) {
    fail(
      "INVALID_OBJECT_ID",
      "Object ID length does not match the repository object format",
    );
  }

  const oldIsZero = ZERO_ID.test(oldObjectId);
  const newIsZero = ZERO_ID.test(newObjectId);
  if (oldIsZero && newIsZero)
    fail("INVALID_OBJECT_ID", "A ref update cannot have two zero object IDs");
  if (oldIsZero) {
    await resolveCommit(repositoryRoot, newObjectId, limits, state);
    fail(
      "UNBOUNDED_NEW_BRANCH",
      "A new branch has no bounded base; explicit base selection is required",
    );
  }

  const oldCommit = await resolveCommit(
    repositoryRoot,
    oldObjectId,
    limits,
    state,
  );
  if (newIsZero) {
    return Object.freeze({
      kind: "delete-branch",
      oldObjectId: oldCommit,
      newObjectId,
      commitCount: 0,
      objectCount: 0,
      changes: Object.freeze([]),
      flags: Object.freeze({
        workflowPaths: false,
        deletions: false,
        symlinks: false,
        submodules: false,
        mergeCommits: false,
      }),
    });
  }
  const newCommit = await resolveCommit(
    repositoryRoot,
    newObjectId,
    limits,
    state,
  );

  await assertAncestor(repositoryRoot, oldCommit, newCommit, limits, state);
  const commits = await readRangeCommits(
    repositoryRoot,
    oldCommit,
    newCommit,
    limits,
    state,
  );
  const objectCount = await countRangeObjects(
    repositoryRoot,
    oldCommit,
    newCommit,
    limits,
    state,
  );
  const { changes, mergeCommits } = await collectCommitChanges(
    repositoryRoot,
    commits,
    limits,
    state,
  );
  const frozenChanges = Object.freeze(
    changes.map((change) => Object.freeze(change)),
  );
  if (performance.now() >= state.deadlineAt)
    fail("TOTAL_TIMEOUT", "Git extraction exceeded its time bound");
  return Object.freeze({
    kind: "update",
    oldObjectId: oldCommit,
    newObjectId: newCommit,
    commitCount: commits.length,
    objectCount,
    commits: Object.freeze(
      commits.map((commitId, index) =>
        Object.freeze({ commitId, mergeCommit: mergeCommits[index] }),
      ),
    ),
    changes: frozenChanges,
    flags: Object.freeze({
      workflowPaths: changes.some((change) => change.workflowPath),
      deletions: changes.some((change) => change.deleted),
      symlinks: changes.some((change) => change.symlink),
      submodules: changes.some((change) => change.submodule),
      mergeCommits: mergeCommits.some(Boolean),
    }),
  });
}

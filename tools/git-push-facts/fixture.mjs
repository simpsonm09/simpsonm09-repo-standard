import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizedGitEnvironment } from "./git-read.mjs";
import { collectPushRangeFacts } from "./index.mjs";

const evidenceRoot = mkdtempSync(join(tmpdir(), "git-push-facts-"));
const repo = join(evidenceRoot, "repo");
// Deliberately poisoned but contained paths: every fixture/collector Git call
// must strip these instead of touching any inherited caller repository.
const poisonRoot = join(evidenceRoot, "must-not-be-written");
process.env.GIT_DIR = poisonRoot;
process.env.GIT_WORK_TREE = poisonRoot;
process.env.GIT_INDEX_FILE = join(poisonRoot, "index");

function git(args, cwd = repo, input) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Push Facts Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      input,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      env: sanitizedGitEnvironment(),
    },
  );
  if (result.status !== 0)
    throw new Error(
      `Synthetic fixture Git setup failed (${result.status}): ${result.stderr}`,
    );
  return result.stdout.trim();
}

function commit(message) {
  git(["add", "-A"]);
  git(["commit", "--no-gpg-sign", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}

function commitIndex(message) {
  const tree = git(["write-tree"]);
  const parent = git(["rev-parse", "HEAD"]);
  const objectId = git(["commit-tree", tree, "-p", parent, "-m", message]);
  git(["update-ref", "HEAD", objectId]);
  return objectId;
}

function expectCode(promise, code) {
  return assert.rejects(promise, (error) => error.code === code);
}

git(["init", "-q", repo], evidenceRoot);
git(["config", "core.autocrlf", "false"]);
writeFileSync(join(repo, "ordinary.txt"), "one\n");
const base = commit("base");
const initialBranch = git(["branch", "--show-current"]);

writeFileSync(join(repo, "ordinary.txt"), "two\n");
writeFileSync(join(repo, "café file.txt"), "non-ASCII path\n");
const ordinary = commit("ordinary and unusual path");
const quotedBlob = git(
  ["hash-object", "-w", "--stdin"],
  repo,
  "quoted path content\n",
);
const priorTreeEntries = git(["ls-tree", "-z", ordinary])
  .split("\0")
  .filter(Boolean);
const quotedEntry = `100644 blob ${quotedBlob}\tquoted " path.txt`;
const quotedTree = git(
  ["mktree", "-z"],
  repo,
  `${[...priorTreeEntries, quotedEntry].join("\0")}\0`,
);
const quotedTip = git([
  "commit-tree",
  quotedTree,
  "-p",
  ordinary,
  "-m",
  "quoted path",
]);
const ordinaryFacts = await collectPushRangeFacts({
  repositoryRoot: repo,
  oldObjectId: base,
  newObjectId: quotedTip,
});
assert.equal(ordinaryFacts.commitCount, 2);
assert.ok(ordinaryFacts.changes.some(({ path }) => path === "ordinary.txt"));
assert.ok(ordinaryFacts.changes.some(({ path }) => path === "café file.txt"));
assert.ok(
  ordinaryFacts.changes.some(({ path }) => path === 'quoted " path.txt'),
);
assert.ok(
  ordinaryFacts.changes.every(
    ({ path, pathBase64 }) =>
      Buffer.from(pathBase64, "base64").toString("utf8") === path,
  ),
);

git(["checkout", "-q", "-b", "workflow-revert"]);
mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
writeFileSync(
  join(repo, ".github", "workflows", "example.yml"),
  "name: fixture\n",
);
const workflowAdded = commit("add workflow");
git(["rm", "-q", ".github/workflows/example.yml"]);
const workflowReverted = commit("revert workflow");
const workflowFacts = await collectPushRangeFacts({
  repositoryRoot: repo,
  oldObjectId: ordinary,
  newObjectId: workflowReverted,
});
assert.equal(workflowFacts.commitCount, 2);
assert.equal(workflowFacts.flags.workflowPaths, true);
assert.deepEqual(
  workflowFacts.changes
    .filter(({ workflowPath }) => workflowPath)
    .map(({ status }) => status),
  ["A", "D"],
);
assert.ok(workflowAdded !== workflowReverted);

git(["checkout", "-q", initialBranch]);
git(["checkout", "-q", "-b", "merge-side"]);
writeFileSync(join(repo, "side.txt"), "side contribution\n");
commit("side contribution");
git(["checkout", "-q", initialBranch]);
writeFileSync(join(repo, "main.txt"), "main contribution\n");
commit("main contribution");
git(["merge", "--no-ff", "-q", "merge-side", "-m", "merge contribution"]);
const mergeTip = git(["rev-parse", "HEAD"]);
const mergeFacts = await collectPushRangeFacts({
  repositoryRoot: repo,
  oldObjectId: ordinary,
  newObjectId: mergeTip,
});
assert.equal(mergeFacts.flags.mergeCommits, true);
assert.ok(mergeFacts.commits.some(({ mergeCommit }) => mergeCommit));
assert.ok(mergeFacts.changes.some(({ path }) => path === "side.txt"));
assert.ok(mergeFacts.changes.some(({ path }) => path === "main.txt"));

const symlinkBlob = git(["hash-object", "-w", "--stdin"], repo, "target-file");
git([
  "update-index",
  "--add",
  "--cacheinfo",
  `120000,${symlinkBlob},link-entry`,
]);
git([
  "update-index",
  "--add",
  "--cacheinfo",
  `160000,${"a".repeat(40)},vendor/module`,
]);
const specialTip = commitIndex("symlink and submodule modes");
const specialFacts = await collectPushRangeFacts({
  repositoryRoot: repo,
  oldObjectId: mergeTip,
  newObjectId: specialTip,
});
assert.equal(specialFacts.flags.symlinks, true);
assert.equal(specialFacts.flags.submodules, true);
assert.ok(
  specialFacts.changes.some(
    ({ oldMode, newMode }) => oldMode === "000000" && newMode === "120000",
  ),
);
assert.ok(
  specialFacts.changes.some(
    ({ oldMode, newMode }) => oldMode === "000000" && newMode === "160000",
  ),
);

git(["rm", "-q", "ordinary.txt"]);
const deletionTip = commit("delete ordinary file");
const deletionFacts = await collectPushRangeFacts({
  repositoryRoot: repo,
  oldObjectId: specialTip,
  newObjectId: deletionTip,
});
assert.equal(deletionFacts.flags.deletions, true);
assert.ok(
  deletionFacts.changes.some(
    ({ path, status }) => path === "ordinary.txt" && status === "D",
  ),
);

const refName = "refs/heads/captured-tip";
git(["update-ref", refName, ordinary]);
const captured = await collectPushRangeFacts({
  repositoryRoot: repo,
  oldObjectId: base,
  newObjectId: ordinary,
});
git(["update-ref", refName, mergeTip]);
assert.equal(git(["rev-parse", refName]), mergeTip);
const capturedAgain = await collectPushRangeFacts({
  repositoryRoot: repo,
  oldObjectId: base,
  newObjectId: ordinary,
});
assert.deepEqual(captured, capturedAgain);
assert.equal(capturedAgain.newObjectId, ordinary);
assert.notEqual(capturedAgain.newObjectId, git(["rev-parse", refName]));

const deletedRef = await collectPushRangeFacts({
  repositoryRoot: repo,
  oldObjectId: ordinary,
  newObjectId: "0".repeat(40),
});
assert.equal(deletedRef.kind, "delete-branch");
assert.equal(deletedRef.commitCount, 0);

await expectCode(
  collectPushRangeFacts({
    repositoryRoot: repo,
    oldObjectId: "bad",
    newObjectId: ordinary,
  }),
  "INVALID_OBJECT_ID",
);
await expectCode(
  collectPushRangeFacts({
    repositoryRoot: repo,
    oldObjectId: "f".repeat(40),
    newObjectId: ordinary,
  }),
  "MISSING_OBJECT",
);
await expectCode(
  collectPushRangeFacts({
    repositoryRoot: repo,
    oldObjectId: "0".repeat(40),
    newObjectId: ordinary,
  }),
  "UNBOUNDED_NEW_BRANCH",
);
await expectCode(
  collectPushRangeFacts({
    repositoryRoot: repo,
    oldObjectId: base,
    newObjectId: ordinary,
    limits: { commits: 0 },
  }),
  "COMMIT_LIMIT",
);
await expectCode(
  collectPushRangeFacts({
    repositoryRoot: repo,
    oldObjectId: base,
    newObjectId: ordinary,
    limits: { commandOutputBytes: 1 },
  }),
  "OUTPUT_LIMIT",
);

for (const [limits, code] of [
  [{ objects: 0 }, "OBJECT_LIMIT"],
  [{ paths: 0 }, "PATH_LIMIT"],
  [{ parentsPerCommit: 1 }, "PARENT_LIMIT"],
  [{ totalTimeoutMs: 1 }, "TOTAL_TIMEOUT"],
]) {
  await expectCode(
    collectPushRangeFacts({
      repositoryRoot: repo,
      oldObjectId: ordinary,
      newObjectId: mergeTip,
      limits,
    }),
    code,
  );
}
await expectCode(
  collectPushRangeFacts({
    repositoryRoot: repo,
    oldObjectId: mergeTip,
    newObjectId: workflowReverted,
  }),
  "NON_ANCESTOR_BASE",
);
const subdirectory = join(repo, "subdirectory");
mkdirSync(subdirectory);
for (const repositoryRoot of [subdirectory, evidenceRoot]) {
  await expectCode(
    collectPushRangeFacts({
      repositoryRoot,
      oldObjectId: base,
      newObjectId: ordinary,
    }),
    "INVALID_REPOSITORY_ROOT",
  );
}

const shallowRepo = join(evidenceRoot, "shallow");
git(["init", "-q", shallowRepo], evidenceRoot);
git(
  ["commit", "--allow-empty", "--no-gpg-sign", "-m", "shallow boundary"],
  shallowRepo,
);
const shallowId = git(["rev-parse", "HEAD"], shallowRepo);
writeFileSync(join(shallowRepo, ".git", "shallow"), `${shallowId}\n`);
await expectCode(
  collectPushRangeFacts({
    repositoryRoot: shallowRepo,
    oldObjectId: shallowId,
    newObjectId: shallowId,
  }),
  "SHALLOW_REPOSITORY",
);

git([
  "update-index",
  "--add",
  "--cacheinfo",
  `100644,${quotedBlob},.GitHub/Workflows/case.yml`,
]);
const caseTip = commitIndex("workflow case variation");
const caseFacts = await collectPushRangeFacts({
  repositoryRoot: repo,
  oldObjectId: deletionTip,
  newObjectId: caseTip,
});
assert.equal(caseFacts.flags.workflowPaths, true);
git(["update-index", "--add", "--cacheinfo", `120000,${symlinkBlob},.github`]);
const bareGithubTip = commitIndex("bare github symlink entry");
const bareGithubFacts = await collectPushRangeFacts({
  repositoryRoot: repo,
  oldObjectId: caseTip,
  newObjectId: bareGithubTip,
});
assert.ok(
  bareGithubFacts.changes.some((f) => f.path === ".github" && f.workflowPath),
);
assert.equal(
  existsSync(poisonRoot),
  false,
  "inherited Git overrides were not used for writes",
);

const sha256Repo = join(evidenceRoot, "sha256");
git(["init", "-q", "--object-format=sha256", sha256Repo], evidenceRoot);
git(["commit", "--allow-empty", "--no-gpg-sign", "-m", "base"], sha256Repo);
const sha256Base = git(["rev-parse", "HEAD"], sha256Repo);
writeFileSync(join(sha256Repo, "ordinary.txt"), "sha256 fixture\n");
git(["add", "ordinary.txt"], sha256Repo);
git(["commit", "--no-gpg-sign", "-m", "change"], sha256Repo);
const sha256Tip = git(["rev-parse", "HEAD"], sha256Repo);
const sha256Facts = await collectPushRangeFacts({
  repositoryRoot: sha256Repo,
  oldObjectId: sha256Base,
  newObjectId: sha256Tip,
});
assert.equal(sha256Facts.newObjectId.length, 64);
assert.equal(sha256Facts.changes[0].path, "ordinary.txt");

console.log(
  "git-push-facts fixture: passed; synthetic repository evidence retained in OS temp",
);

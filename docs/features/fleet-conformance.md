# Conformance

Conformance answers one question. Does this repository match the standard? Each
repository answers it about itself, from its own CI, with its own token. No
repository audits another, and there is no organization-wide audit or token.

## `check-standard`

[`../../scripts/check-standard.mjs`](../../scripts/check-standard.mjs) takes one
repository path and prints a compact matrix of nine tree-local groups.

| Group | Checks |
| --- | --- |
| `files` | The required paths exist, including `.github/ISSUE_TEMPLATE/`. |
| `mise` | `mise.toml` pins `aqua:casey/just`. |
| `ci` | `ci.yml` calls `lint`, `aislop`, `security`, `standard`, and `coverage` at a pinned 40-character SHA, and defines a `test` job that runs on a runner. A repository without a coverage job is excepted on `ci/coverage` in `check-repo`, and the exception gives the reason. |
| `dependabot` | `.github/dependabot.yml` declares version 2, a scheduled ecosystem, and no inline credential. |
| `community` | The byte-identical community files match the pinned standard. |
| `docs` | The [documentation layout](../documentation.md) holds. |
| `scripting` | Recipe bodies stay portable, scripts are declared or twinned, non-vendored skills call `just <recipe>`, and a repo-local skill id is in one skill root. |
| `env` | Git's index contains no actual `.env` file at any depth, and the pre-push hook rejects such filenames in every proposed ref's reachable history before upload. If a repository opts into the env convention, a root `.worktreeinclude` lists each local file, `.gitignore` ignores it, and each listed path has a committed sibling `.example` template. |
| `subprocess` | Every `node:child_process` call in a source file passes a literal `windowsHide: true`, so Windows opens no empty console window. |

The script exits `1` when any group has a gap. It never reads the exception file, so
a single repository can be checked on its own.

### The `subprocess` group

The `subprocess` group is named for its scope, the child processes a Node script
starts. Its rule id is `subprocess/windows-hide`, and each gap prints `file:line`. It
reads each `.mjs`, `.js`, `.cjs`, `.ts`, `.mts`, and `.cts` file in the working tree,
except `node_modules`, `.git`, and vendored PStack skills, which the scripting group
also exempts.

The scan is token-based, so it needs no parser dependency. It follows a
`node:child_process` binding through a static, namespace, default, destructured,
renamed, `require`, or dynamic `import` form, and a name defaulted or assigned
straight from one of its functions (`spawn = spawnSync`). A call fails when:

- it has no options, or its options are a callback alone;
- its options are a variable, so the key cannot be read;
- its options object does not set `windowsHide: true` as a literal; or
- a spread follows that key, because the spread could override it.

The scan does not follow any other function value. A child_process function stored
in a variable, passed as an argument, or read from a property is not checked, and
neither is a member call written with a string key, `cp['spawn'](`. A method that
shares a name with an imported child_process function is read as a call.
Fix a finding by writing the options as a literal object in the call.

## `check-repo`

[`../../scripts/check-repo.mjs`](../../scripts/check-repo.mjs) runs `check-standard`
and then adds the checks a repository can make about itself through the GitHub API
with its own token. It reads the identity from `GITHUB_REPOSITORY` or the `--repo`
flag, and it applies the subset of [`../exceptions.json`](../exceptions.json) that
names the repository.

The API groups are `settings` and `ruleset`.

- `settings` requires the default branch to be `main`, the description to be set, and
  the owner topic to be present.
- `ruleset` requires exactly one `protect-main` ruleset on a public repository. It must be active, target `main`, and require checks matching the repository's coverage state. Each required check needs a job in `ci.yml`. The rule is in [governance.md](../governance.md#required-checks).

The target check evaluates `refs/heads/main`, `~DEFAULT_BRANCH` (when the API reports
`main` as the default branch), `~ALL`, and a limited locally modeled subset of
patterns: `*` without crossing `/`, `?` within one path segment, `**` as any sequence,
and positive bracket sets. It does not model `**/`, braces, or malformed ranges.
Exclusions override inclusions.
Missing conditions and patterns the checker does not model produce a gap, so they
cannot prove main coverage. Successful API responses are validated for the active
ruleset and target. API read failures remain notices; they do not establish
protection, and `standard: ok` does not prove complete API coverage. This check
validates the repository ruleset's branch condition; it does not inventory
organization rulesets.

A repository cannot read its own secret scanning, push protection, or merge methods
with its own token, so those are applied once and not audited. See
[github-settings.md](../github-settings.md).

## The reusable workflow

[`../../.github/workflows/standard.yml`](../../.github/workflows/standard.yml) is the
entry point. It checks out the caller and this repository at the caller's pinned SHA,
then runs `check-repo` with the caller's `GITHUB_TOKEN`. A repository adopts a new
standard by bumping its pin. See [adoption.md](../adoption.md).

Gaps tolerated for a reason are listed in [`../exceptions.json`](../exceptions.json).
Every other gap fails the command with exit `1`.

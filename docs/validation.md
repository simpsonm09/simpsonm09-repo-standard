# Validation

Every repository checks itself against the standard. A repository runs one job
from its own `ci.yml`, and the job reports whether the repository matches the
standard. There is no organization-wide token, and no repository audits another
through the API.

The standard also ships a local fleet audit. `scripts/audit-fleet.mjs` reads the
sibling checkouts on disk and prints one matrix. It runs from a checkout of this
repository, needs no token, and never runs in a consuming repository's CI. See
[scripting.md](scripting.md).

## Run the checks

```bash
just check-standard .        # the pure tree-local check
just check-repo .            # the check a repository runs in its own CI
```

`check-standard` reads only the working tree and the pinned standard. It never
reads the exception file, so it is honest on its own.

`check-repo` runs `check-standard` and then adds the checks a repository can make
about itself through the GitHub API with its own token. It applies the subset of
[`exceptions.json`](exceptions.json) that names the repository. Pass `--no-api` to
skip the API checks.

## Groups

| Group | Checks |
| --- | --- |
| `files` | The required paths exist. |
| `mise` | `mise.toml` pins `aqua:casey/just`. |
| `ci` | `ci.yml` calls `lint`, `aislop`, `security`, and `standard` at a pinned SHA, and defines a `test` job that runs on a runner. It also defines a `coverage` job that calls the shared coverage workflow at a pinned SHA. `check-repo` accepts an exception on `ci/coverage` as the declaration of a repository without a coverage job. See [governance.md](governance.md#required-checks). |
| `dependabot` | `.github/dependabot.yml` declares version 2, a scheduled ecosystem, and no inline credential. |
| `community` | The byte-identical community files match the pinned standard. |
| `docs` | The [documentation layout](documentation.md) holds. |
| `scripting` | Recipe bodies stay portable, scripts are declared or twinned, non-vendored skills call `just <recipe>`, and a repo-local skill id is in one skill root. |
| `env` | Git's index contains no actual `.env` file at any depth, and the pre-push hook rejects such filenames in every proposed ref's reachable history before upload. If a repository opts into the env convention, a root `.worktreeinclude` lists each local file, `.gitignore` ignores it, and each listed path has a committed sibling `.example` template. |
| `subprocess` | Every `node:child_process` call in a source file passes a literal `windowsHide: true`. See [fleet-conformance.md](features/fleet-conformance.md). |
| `settings` | The default branch is `main`, the description is set, and the owner topic is present. |
| `ruleset` | Successful API responses for a public repository are checked for exactly one active `protect-main` targeting `main`; its required checks match the repository's coverage state, with a job for each. |

API read failures are reported as notices and do not establish protection. A
`standard: ok` result does not prove complete API coverage when a read failed.

Each gap prints its id and a one-line reason. Check ids are stable and are the
values the exception file matches.

## What a repository cannot check about itself

Two settings are not readable with a repository token. Secret scanning and push
protection need admin on the repository. The merge methods need `contents: write`.
The standard applies them once with `apply-settings` and does not audit them. See
[github-settings.md](github-settings.md).

A repository also cannot see another repository through the API, so nothing
checks a fork or a sibling in CI. Each repository is responsible for itself. The
local fleet audit reads sibling checkouts on disk instead, outside CI.

## Exceptions

`check-repo` reads [`exceptions.json`](exceptions.json). An exception records a
tolerated gap with a reason and a date. Never silence a gap inline in code.

```json
{
  "exceptions": [
    {
      "repo": "simpsonm09-org/simpsonm09-postman-test-utils",
      "checks": ["community/.aislop/config.yml"],
      "reason": "The aislop audit is off because newman's optional peer tree has advisories with no upstream fix, and Trivy is the dependency gate.",
      "date": "2026-09-30"
    }
  ]
}
```

- `repo` is the full `owner/name`, or `"*"` to match every repository.
- `checks` is one check id or an array of them, matching the ids the checker prints. `"*"` matches every check for the repository.
- `reason` states why the gap is tolerated.
- `date` is the day the exception was recorded, as `YYYY-MM-DD`.

An exception that no longer matches a gap is harmless. You should still delete it,
because the exception file is the record of what the standard tolerates.

An exception on `ci/coverage` declares that a repository has no coverage job. Its reason
says why: the repository has no executable code under test, or its code under test cannot
be measured by the shared coverage workflow. See [governance.md](governance.md#required-checks).

## The caller workflow

A repository runs the check through the reusable `standard.yml`, pinned to a commit
of this repository. The workflow checks out the caller and this repository at the
pin, then runs `check-repo` with the caller's own token. See
[adoption.md](adoption.md) and [features/fleet-conformance.md](features/fleet-conformance.md).

# Governance

This document defines the branch model and the protection rules for repositories in `simpsonm09-org`.

## Branch model

- `main` is the integration branch and is protected.
- Feature branches open pull requests into `main`.
- Anything not on `main` is a pull request candidate.

## Pull requests

A pull request against `main` runs the shared checks from the repository. The checks are lint, aislop, security, standard, and coverage.

### Where a pull request may go

Open a pull request, issue, or comment only on a repository owned by `simpsonm09` or `simpsonm09-org`, the owners of the personal and organization plugins. Never open one automatically against any other owner, including the project a fork came from. A contribution to a repository we do not own needs the maintainer's review first. `gh pr create` targets a fork's parent by default, so pass `-R <owner>/<repo>` with an owned repository, and push only to `origin`.

Merge through the rulesets below. Use an administrator merge only on an owned repository, only when the maintainer grants it for the current session, and only after every check on the pull request's head is green.

## Protection rules

Two rulesets live in [`../rulesets/`](../rulesets).

### protect-main

Targets `refs/heads/main`.

- Block creations, deletions, and force pushes. The pull request rule blocks direct updates, so `main` only changes through a pull request. Do not add a separate `update` rule. It also blocks the pull request merge the ruleset requires, and every merge then needs the administrator bypass.
- Require a pull request before merging.
- Required approvals set to one. The agent identity cannot approve its own pull request, so a `propose` repository cannot be merged by the agent. The maintainer merges through the admin bypass, or approves the pull request first.
- Extra approval for unattributed changes is off. GitHub enables `require_extra_approval_for_unattributed_changes` when the field is absent, and that would demand an approval a solo maintainer cannot give. The ruleset sets it to `false` explicitly.
- Dismiss stale approvals and require conversation resolution.
- Require signed commits on the branch.
- Require the lint, aislop, security, standard, and test status checks, and require branches to be up to date. A covered repository also requires `coverage / coverage`. See [Required checks](#required-checks).
- No linear-history rule. Merge commits are allowed.
- Bypass list is the organization admin role with mode `pull_request`, plus the fleet agent's GitHub App integration on a `merge` or `full` repository. The committed file is the base. [Bypass actors](#bypass-actors) gives the per-level entry. The admin is the maintainer's escape hatch. The App bypass lets the agent land its own green pull request without a direct push. Every bypass is recorded in the audit log.

### protect-tags

Targets `refs/tags/v*`. Blocks update, deletion, and force push.

## Required checks

A required status check must be reported by a job that the repository runs. A required check with no job never reports, so every pull request waits on it forever. The required set follows the repository's coverage job.

The local `ci.yml` workflow also has an `all-checks` job. It waits for every other parsed job in that workflow and succeeds only when every dependency result is `success`; failure, cancellation, and skipping fail the aggregate. The checker requires the dependency list to close over every job it recognizes, including platform test jobs, and in those recognized job blocks conservatively scans for the spelling `continue-on-error` followed by a colon. That lexical scan may also reject comments or literal script text containing that spelling. Conditional verification steps are rejected. The aggregate must use the supported plain-key shape: `if: always()`, `ubuntu-24.04`, a five-minute timeout, and `permissions: {}`; exactly one step with `env.NEEDS` set to `${{ toJSON(needs) }}`; and the pinned run command `echo "$NEEDS" | jq -e 'all(.[]; .result == "success")'`. Job and step keys are allowlisted, and workflow-level `defaults` or `env` are unsupported because they can change how that command runs. The checker accepts benign spacing and comments only where it can parse them reliably. It is a bounded contract checker, not a general YAML parser: quoted aggregate field keys or otherwise unrecognized keys, duplicate job keys, explicit mapping keys, and unsupported aggregate shapes produce a gap. This conservative rule can produce a false red for valid YAML outside the supported form; that is intentional, and unknown forms are never silently treated as safe. The reusable-workflow caller contract is structurally checked; its result propagation has not yet been proven by a real fixture-repository run.

`all-checks` is deliberately not yet in the required ruleset contexts. The exported `ALL_CHECKS_REQUIRED` readiness flag in `scripts/lib/required.mjs` remains false while consumers are migrated. Rollout order: add the aggregate to each repository's `ci.yml`, verify a green run and caller propagation, then enable the flag in the ruleset contract. While the flag is false, a missing aggregate is allowed; any aggregate that is present is still checked for its full job closure and supported safe shape. This does not rename or replace any existing required context.

The aggregate covers jobs in `.github/workflows/ci.yml` only. A separate `codeql.yml` workflow is outside its `needs` graph. The committed `protect-main` payload does not require CodeQL, and [automation.md](automation.md#codeql) says it is not a required status check. No live repository contexts were read for this change; leave any existing live CodeQL requirement untouched during rollout. Do not treat `all-checks` as proof that every workflow or every possible check has passed.

A repository has one of two coverage states.

- **Covered.** The repository has a coverage job. It calls the shared `coverage` workflow, defines the `coverage` recipe, and requires `coverage / coverage`. Covered is the default: a repository is covered unless it has an entry, below.
- **Uncovered.** The repository has no coverage job and does not require `coverage / coverage`. The repository declares this with an entry in [`exceptions.json`](exceptions.json) on the check id `ci/coverage`. The entry's reason says which of two cases applies:
  - **Records.** The repository has no executable code under test. Its records, documents, configuration, or composition are the product. Its tests, if any, check its own records.
  - **Not measurable.** The repository has code under test, but the shared coverage workflow cannot measure all of it. The reason names the part it cannot measure. An entry of this kind should be revisited when the repository gains code the workflow can measure.

Covered and uncovered repositories both require `lint / flint`, `aislop / aislop`, `security / trivy`, `security / secrets`, `standard / standard`, and `test`. A repository may add a second test job named `test-<suffix>` and require it once it is stable. See [testing.md](testing.md).

The checker enforces the rule. Each gap prints its id.

- `ci/coverage` (`check-standard`): ci.yml has no `coverage` job. `check-standard` cannot read exceptions, so an uncovered repository shows this gap until `check-repo` applies its entry.
- `ci/coverage-unrequired` (`check-repo`): an uncovered repository calls the coverage workflow.
- `ruleset/protect-main` and `ruleset/ambiguous` (`check-repo` with the API, on a public repository): no uniquely named `protect-main` ruleset can be selected.
- `ruleset/enforcement` and `ruleset/main-target`: the selected ruleset is not active or its conditions cannot be verified to cover `main`.
- `ruleset/required-missing`, `ruleset/required-no-job`, and `ruleset/required-unexpected`: the live `protect-main` requires a set other than the one the repository expects, or requires a check that no job reports.

The apply script builds each repository's payload from the committed file. It adds `coverage / coverage` for a covered repository and removes it for an uncovered one.

## Code owners and reviewers

The effective CODEOWNERS file must assign the default `*` pattern to the exact owner identity `@simpsonm09`; repositories may retain specific path routes, comments, and additional owners. Any wildcard-only pattern made from `/` and `*` must also include `@simpsonm09`, since it can override the default for the whole repository. The root `CODEOWNERS` path remains required, and when `.github/CODEOWNERS` exists the checker also validates it because GitHub gives it precedence. GitHub auto-requests the code owner as an optional reviewer, because `require_code_owner_review` is `false`. The review is not a gate.

GitHub never requests the pull-request author as a reviewer. A self-authored pull request shows no request. This is expected, not a missing configuration.

## Repository settings

Rulesets do not cover these. Set them on each repository.

- Default branch `main`.
- Merge, squash, and rebase enabled.
- Delete branch on merge.
- Auto-merge enabled. The API does not enable it on the Free organization plan, so it stays off on the current private repositories.
- Default Actions token read-only.

## Signed commits

Signed commits are required on `main`, and the `protect-main` ruleset enforces it with the `required_signatures` rule. GitHub signs the merge commits it creates through the web UI and through the API, so the merge itself passes. Each commit on the feature branch must be signed. Configure an SSH signing key on each runtime.

## Enforcement timing

Rulesets on private repositories need GitHub Pro for a personal account and GitHub Team for an organization. On the free plan, private repositories cannot carry rulesets. The apply script reads each repository's visibility. While a repository is private it reports the ruleset it would apply and stops. When the repository becomes public, the same script applies for real.

`check-repo` fails a public repository that is missing `protect-main`, so the gap cannot be forgotten.

## Bypass actors

`rulesets/protect-main.json` is the base for every repository. It lists one bypass actor, the `OrganizationAdmin` role with mode `pull_request`. For a repository that is not in an organization, replace that entry with `RepositoryRole` and the administrator role ID.

The apply script adds one more entry per repository, for the fleet agent's GitHub App integration. The entry depends on the repository's agent access level. See [agent access](features/agent-access.md#the-agent-identity).

| Level | Fleet agent App entry on the bypass list |
| --- | --- |
| `none`, `read`, `propose` | None. |
| `merge` | Mode `pull_request`. |
| `full` | Mode `always`, because a `full` repository pushes to `main` directly. |

The committed file names no actor id for the App. A live ruleset is the base, plus `coverage / coverage` for a covered repository (see [Required checks](#required-checks)), plus the App entry for its level.

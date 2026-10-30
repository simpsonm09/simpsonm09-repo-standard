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

- Block creations, deletions, and force pushes. The pull request rule requires PR-based integration, so `main` only changes through a pull request. Do not add a separate `update` rule.
- Require a pull request before merging.
- Required approvals set to zero here. Review counts live in `approval-main`, so an administrator bypass cannot skip checks or signatures.
- Extra approval for unattributed changes is off. GitHub enables `require_extra_approval_for_unattributed_changes` when the field is absent, and that would demand an approval a solo maintainer cannot give. The ruleset sets it to `false` explicitly.
- Dismiss stale approvals and require conversation resolution.
- Require signed commits on the branch.
- Require the lint, aislop, security, standard, and test status checks, and require branches to be up to date. A covered repository also requires `coverage / coverage`. See [Required checks](#required-checks).
- No linear-history rule. Merge commits are allowed.
- Bypass list is empty at every access level. No GitHub App integration can bypass this ruleset.

### approval-main

Targets exactly `refs/heads/main` and contains only the pull request review rule. It is always applied, including at `full`, so level changes update one named ruleset instead of leaving a stale review policy behind.

- `propose` and `merge` require one human approval. The organization administrator role has a `pull_request` bypass on this ruleset only.
- `full` requires zero approvals and has no bypass actors.
- The bypass does not apply to `protect-main`; signed commits, pull requests, and its required checks continue to apply.
- For repositories outside an organization, configure a supported repository-owner administrator actor explicitly. Do not copy an organization role actor into a personal repository without confirming GitHub supports it there.

The owner decision for `full` is checks only. Full-level pull requests have no required human approval, including changes to CI, security, or permission controls.

### protect-tags

Targets `refs/tags/v*`. Blocks update, deletion, and force push.

## Required checks

A required status check must be reported by a job that the repository runs. A required check with no job never reports, so every pull request waits on it forever. The required set follows the repository's coverage job.

A repository has one of two coverage states.

- **Covered.** The repository has a coverage job. It calls the shared `coverage` workflow, defines the `coverage` recipe, and requires `coverage / coverage`. Covered is the default: a repository is covered unless it has an entry, below.
- **Uncovered.** The repository has no coverage job and does not require `coverage / coverage`. The repository declares this with an entry in [`exceptions.json`](exceptions.json) on the check id `ci/coverage`. The entry's reason says which of two cases applies:
  - **Records.** The repository has no executable code under test. Its records, documents, configuration, or composition are the product. Its tests, if any, check its own records.
  - **Not measurable.** The repository has code under test, but the shared coverage workflow cannot measure all of it. The reason names the part it cannot measure. An entry of this kind should be revisited when the repository gains code the workflow can measure.

Covered and uncovered repositories both require `lint / flint`, `aislop / aislop`, `security / trivy`, `security / secrets`, `standard / standard`, and `test`. A repository may add a second test job named `test-<suffix>` and require it once it is stable. See [testing.md](testing.md).

The checker enforces the rule. Each gap prints its id.

- `ci/coverage` (`check-standard`): ci.yml has no `coverage` job. `check-standard` cannot read exceptions, so an uncovered repository shows this gap until `check-repo` applies its entry.
- `ci/coverage-unrequired` (`check-repo`): an uncovered repository calls the coverage workflow.
- `ruleset/protect-main` or `ruleset/approval-main` (`check-repo` with the API, on a public repository): the named ruleset is missing or duplicated. `ruleset/ambiguous` means its id is not numeric.
- `ruleset/approval-policy`: the explicit level is unsupported, could not be audited, or does not match the level-specific approval and bypass policy.
- `ruleset/rules` and `ruleset/required-checks`: `protect-main` rules or its required status checks are unreadable.
- `ruleset/enforcement` and `ruleset/main-target`: `protect-main` is not active or its conditions cannot be verified to cover `main`.
- `ruleset/protect-rule`, `ruleset/protect-approval`, `ruleset/protect-signatures`, and `ruleset/protect-bypass`: hard protection lacks exactly one pull request rule, has a nonzero approval count, lacks exactly one signature rule, or has an unreadable/nonempty bypass list.
- `ruleset/approval-rule` and `ruleset/approval-target`: `approval-main` does not contain exactly one pull request rule or does not target exactly `main`.
- `ruleset/required-strict`: `protect-main` does not require branches to be up to date.
- `ruleset/required-missing`, `ruleset/required-no-job`, and `ruleset/required-unexpected`: the live `protect-main` requires a set other than the one the repository expects, or requires a check that no job reports.

The apply scripts upsert every committed ruleset by name. They build both main ruleset payloads from the selected access level, add `coverage / coverage` for a covered repository, and remove it for an uncovered one. They do not delete rulesets. An unknown, legacy, `read`, or `none` level fails closed. The old catalog must not apply this payload until its compatible three-level rollout is ready. Do not promote an old value to `full` implicitly or use an unreviewed legacy fallback.

`check-agent-access` compares the two unique, active rulesets targeting exactly `main`, including approval counts and bypass actors. `check-repo` always runs the hard `protect-main` audit, including required checks, enforcement, target, pull request rule, signatures, approval count, and bypass actors. Pass `--agent-level propose|merge|full` to add the level-specific approval and bypass comparison. Without that option, readable API state that cannot be compared at a level remains notice-only; API read failures also remain notices and do not change the no-level exit behavior. With an explicit level, unreadable API state is a `ruleset/approval-policy` gap; an unexcepted gap fails the audit. Exception metadata is reviewed independently.

## Code owners and reviewers

`CODEOWNERS` is `* @simpsonm09` in every repository. GitHub auto-requests the code owner as an optional reviewer, because `require_code_owner_review` is `false`. The review is not a gate.

GitHub never requests the pull-request author as a reviewer. A self-authored pull request shows no request. This is expected, not a missing configuration.

## Repository settings

Rulesets do not cover these. Set them on each repository.

- Default branch `main`.
- Merge, squash, and rebase enabled.
- Delete branch on merge.
- `allow_auto_merge` is controlled explicitly with `--allow-auto-merge on|off`. The setting is left unchanged when the flag is omitted. The command is a dry run unless `--apply` is also passed. A plan or permission error is reported; support is not inferred from access level and no current setting is assumed.
- Default Actions token read-only.

## Signed commits

Signed commits are required on `main`, and the `protect-main` ruleset enforces it with the `required_signatures` rule. GitHub signs the merge commits it creates through the web UI and through the API, so the merge itself passes. Each commit on the feature branch must be signed. Configure an SSH signing key on each runtime.

## Enforcement timing

Rulesets on private repositories need GitHub Pro for a personal account and GitHub Team for an organization. On the free plan, private repositories cannot carry rulesets. The apply script reads each repository's visibility. While a repository is private it reports the ruleset it would apply and stops. When the repository becomes public, the same script applies for real.

`check-repo` fails a public repository that is missing `protect-main`, so the gap cannot be forgotten.

## Bypass actors

`rulesets/protect-main.json` has no bypass actor. `rulesets/approval-main.json` carries the human administrator bypass for review-only policy. Organization repositories use the existing `OrganizationAdmin` role. A personal repository may require a supported repository-owner administrator role and its role id; this standard does not guess that id.

| Level | `approval-main` approval count | `approval-main` bypass |
| --- | ---: | --- |
| `propose` | 1 | Organization admin, `pull_request` |
| `merge` | 1 | Organization admin, `pull_request` |
| `full` | 0 | None |

The approval bypass is confined to `approval-main`; it cannot skip hard protection. No agent App actor appears in either main ruleset.

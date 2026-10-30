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

The local `ci.yml` workflow also has an `all-checks` job. It waits for every other parsed job in that workflow and succeeds only when every dependency result is `success`; failure, cancellation, and skipping fail the aggregate. The checker requires the dependency list to close over every job it recognizes, including platform test jobs, and in those recognized job blocks conservatively scans for the spelling `continue-on-error` followed by a colon or as an explicit `? continue-on-error` mapping key. That lexical scan may also reject comments or literal script text containing that spelling. Conditional verification steps are rejected. The aggregate must use the supported plain-key shape: `if: always()`, `ubuntu-24.04`, a five-minute timeout, and `permissions: {}`; exactly one step with `env.NEEDS` set to `${{ toJSON(needs) }}`; and the pinned run command `echo "$NEEDS" | jq -e 'all(.[]; .result == "success")'`. Job and step keys are allowlisted, and workflow-level `defaults` or `env` are unsupported because they can change how that command runs. The checker accepts benign spacing and comments only where it can parse them reliably. It is a bounded contract checker, not a general YAML parser: quoted aggregate field keys or otherwise unrecognized keys, duplicate job keys, explicit mapping keys, and unsupported aggregate shapes produce a gap. This conservative rule can produce a false red for valid YAML outside the supported form; that is intentional. YAML escape sequences in keys are not decoded, so arbitrary YAML key encodings are outside this lexical check. The reusable-workflow caller contract is structurally checked; its result propagation has not yet been proven by a real fixture-repository run.

`all-checks` is deliberately not yet in the required ruleset contexts. The exported `ALL_CHECKS_REQUIRED` readiness flag in `scripts/lib/required.mjs` remains false while consumers are migrated. Rollout order: add the aggregate to each repository's `ci.yml`, verify a green run and caller propagation, then enable the flag in the ruleset contract. While the flag is false, a missing aggregate is allowed; any aggregate that is present is still checked for its full job closure and supported safe shape. This does not rename or replace any existing required context.

The aggregate covers jobs in `.github/workflows/ci.yml` only. A separate `codeql.yml` workflow is outside its `needs` graph. The committed `protect-main` payload does not require CodeQL, and [automation.md](automation.md#codeql) says it is not a required status check. No live repository contexts were read for this change; leave any existing live CodeQL requirement untouched during rollout. Do not treat `all-checks` as proof that every workflow or every possible check has passed.

A repository has one of two coverage states.

- **Covered.** The repository has a coverage job. It calls the shared `coverage` workflow, defines the `coverage` recipe, and requires `coverage / coverage`. Covered is the default: a repository is covered unless it has an entry, below.
- **Uncovered.** The repository has no coverage job and does not require `coverage / coverage`. The repository declares this with an entry in [`exceptions.json`](exceptions.json) on the check id `ci/coverage`. The entry's reason says which of two cases applies:
  - **Records.** The repository has no executable code under test. Its records, documents, configuration, or composition are the product. Its tests, if any, check its own records.
  - **Not measurable.** The repository has code under test, but the shared coverage workflow cannot measure all of it. The reason names the part it cannot measure. An entry of this kind should be revisited when the repository gains code the workflow can measure.

Covered and uncovered repositories both require `lint / flint`, `aislop / aislop`, `security / trivy`, `security / secrets`, `standard / standard`, and `test`. A repository may add a second test job named `test-<suffix>` and require it once it is stable. See [testing.md](testing.md).

The checker enforces the rule. Each gap prints its id. GitHub omits [`bypass_actors`](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset)
from ruleset detail responses unless the requesting identity has write access to the
ruleset. The standard CI token is read-only, so the default audit reports an explicit
unverified notice when GitHub omits that field; it does not infer an empty list or
claim bypass protection is verified. A readable invalid or nonempty `protect-main`
bypass list remains a gap. Pass `--agent-level propose|merge|full` for the privileged
policy audit; an omitted field then fails closed. `check-agent-access` also fails
closed when either ruleset's bypass list is unreadable.

- `ci/coverage` (`check-standard`): ci.yml has no `coverage` job. `check-standard` cannot read exceptions, so an uncovered repository shows this gap until `check-repo` applies its entry.
- `ci/coverage-unrequired` (`check-repo`): an uncovered repository calls the coverage workflow.
- `ruleset/protect-main` or `ruleset/approval-main` (`check-repo` with the API, on a public repository): the named ruleset is missing or duplicated. `ruleset/ambiguous` means its id is not numeric.
- `ruleset/approval-policy`: the explicit level is unsupported, could not be audited, or does not match the level-specific approval and bypass policy.
- `ruleset/rules` and `ruleset/required-checks`: `protect-main` rules or its required status checks are unreadable.
- `ruleset/enforcement` and `ruleset/main-target`: `protect-main` is not active or its conditions cannot be verified to cover `main`.
- `ruleset/protect-rule`, `ruleset/protect-approval`, `ruleset/protect-signatures`, and `ruleset/protect-bypass`: hard protection lacks exactly one pull request rule, has a nonzero approval count, lacks exactly one signature rule, or has a readable invalid/nonempty bypass list. An omitted `bypass_actors` field is unverified in the default read-only audit and fails the explicit privileged audit.
- `ruleset/approval-rule` and `ruleset/approval-target`: `approval-main` does not contain exactly one pull request rule or does not target exactly `main`.
- `ruleset/required-strict`: `protect-main` does not require branches to be up to date.
- `ruleset/required-missing`, `ruleset/required-no-job`, and `ruleset/required-unexpected`: the live `protect-main` requires a set other than the one the repository expects, or requires a check that no job reports.

The apply scripts upsert every committed ruleset by name. They build both main ruleset payloads from the selected access level, add `coverage / coverage` for a covered repository, and remove it for an uncovered one. They do not delete rulesets. An unknown, legacy, `read`, or `none` level fails closed. The old catalog must not apply this payload until its compatible three-level rollout is ready. Do not promote an old value to `full` implicitly or use an unreviewed legacy fallback.

`check-agent-access` compares the two unique, active rulesets targeting exactly `main`, including approval counts and bypass actors, and fails closed when either bypass list is unreadable. `check-repo` always runs the hard `protect-main` audit, including required checks, enforcement, target, pull request rule, signatures, and approval count. A readable invalid or nonempty `protect-main` bypass list is a gap. GitHub may omit `bypass_actors` from a read-only response; the default CI audit reports this as unverified, never as an empty list or verified protection. Pass `--agent-level propose|merge|full` to add the level-specific approval and bypass comparison; omitted bypass fields then produce a `ruleset/approval-policy` gap. Without that option, approval counts and approval-main actors are not compared because no access level was selected. API read failures remain notices and do not change the no-level exit behavior. Exception metadata is reviewed independently.

## Code owners and reviewers

The effective CODEOWNERS file must assign the default `*` pattern to the exact owner identity `@simpsonm09`; repositories may retain specific path routes, comments, and additional owners. Any wildcard-only pattern made from `/` and `*` must also include `@simpsonm09`, since it can override the default for the whole repository. The root `CODEOWNERS` path remains required, and when `.github/CODEOWNERS` exists the checker also validates it because GitHub gives it precedence. GitHub auto-requests the code owner as an optional reviewer, because `require_code_owner_review` is `false`. The review is not a gate.

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

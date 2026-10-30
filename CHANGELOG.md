# Changelog

## Unreleased

- Report uncertain PR creation as `outcome-unknown` after dispatch instead of
  claiming a denial. Never retry a potentially completed write.

- Add an inactive fixed-endpoint App executor for repository reads and PR
  creation with pinned policy, narrowed tokens, immutable authorized requests,
  bounded response cleanup, and fake-only fixtures. No deployed credential or
  caller route changes.

- Add bounded local Git push-range facts, including intermediate and merge-parent
  workflow changes. Reject incomplete history and subdirectory roots, isolate
  fixture Git overrides, and enforce aggregate time and merge-parent limits.
  This collects facts only; no broker authorization or push transport is added.
- Restrict the App-creation listener to IPv4 loopback and five minutes. Cancel
  pending exchange on timeout or interruption; test lifecycle with fake servers.
  This does not change deployed App credentials or run the creation flow.
- Add a planned, unconsumed App identity route planner and bounded fake-port
  fixtures. Keep the existing resolver authoritative, require exact installation
  scope and permission ceilings, and fail closed without ambient fallback for
  agent reads or writes. Document that human pass-through is not an authorization
  grant, commit author/committer/signer are separate from the authentication
  actor, App ownership/visibility remain undecided, and runtime adoption remains
  pending. No broker or adapter behavior changes.
- Add a versioned, local App behavior contract and focused fixture test mapped to
  the existing classifier, destination resolver, target decision, manifest, and
  ruleset payloads; register it in the existing test suite. Document rendered,
  endpoint-specific App permission examples, approval routes, public
  distribution state boundaries, and current broker limitations without
  changing token transport. Qualify ignore-policy behavior by host and describe
  coverage through the `ci/coverage` exception.
- Add committed `upstream/main:ignore.json` destination denies and validate full
  case-insensitive identities. Preserve broad `full` push/admin capabilities,
  resolve invalid or missing policy levels to the internal read-only baseline,
  check organization push and paired-fork PR operands, classify ordinary PR
  management and issue creation at `openPr`, and keep milestone operations at
  `admin`. For one supported simple command, return a never-granted `forbidden`
  capability for approval/dismissal, admin-merge flags, canonical REST
  review-route writes, and recognized GraphQL review mutations, including at
  `full`. Ambiguous API endpoint spellings, including noncanonical absolute
  URLs and ambiguous endpoint-like tokens beginning with `/`, `.`, `%`, `repos/`,
  or `repos%` that use `//`, backslashes, dot segments, or percent encoding are
  conservatively forbidden without assuming GitHub normalization. Literal
  executable basenames are matched case-insensitively with `.exe` removed;
  unsupported first-word grouping, keyword prefixes, escapes, and expansions
  are forbidden. Unsupported argument expansion, command substitution,
  grouping, redirection, unquoted shell separators (including glued separators), globbing,
  or escape syntax is forbidden on governed `gh` and `git push` commands.
  Bash `%`, `^`, and `!` punctuation remains literal data in argument position.
  The tokenizer supports one bounded command only; wrappers and nested commands
  remain outside its scope. This is not universal shell enforcement or branch
  protection.
- Split main-branch approval policy into an always-present `approval-main` ruleset. Keep `protect-main` at zero required approvals with signed commits, pull requests, strict existing checks, and no bypass actors; use one human admin PR-only bypass for `propose`/`merge`, and no approval bypass for `full`. Unknown and legacy levels fail closed during application.
- Make `allow_auto_merge` an explicit `apply-settings` option (`--allow-auto-merge on|off`), dry-run by default and unchanged when omitted.
- Add an `all-checks` CI aggregate and a fail-closed checker for its pinned safe
  shape and every job in `.github/workflows/ci.yml`, with progressive ruleset
  readiness and default CODEOWNERS validation.
- Validate active `protect-main` ruleset targeting when the API response is readable; ambiguous names and unmodeled target patterns produce gaps. API read failures remain notices and do not establish protection.
- Update the five starter CI reusable workflow pins to the reviewed published standard commit `6f754925`.
- Add a default coverage recipe and Python LCOV scaffold to the starter templates, and clarify that coverage opt-outs require a reviewed exception in the standard.
- Make unmodeled `gh` commands require `admin` in the public command classifier,
  while retaining known read commands and existing write-capability mappings.
  Help/version controls count only as final tokens; `gh auth` commands,
  including token-bearing status, and `gh repo sync` require `admin`.
- Update the CodeQL workflow template to match the CodeQL action pin used by the repository workflow.
- Add a separate committed `owned-repositories.json` resolver policy for exact
  `simpsonm09` identities without fork upstreams. Its `propose` mapping allows
  only non-default branch pushes and same-repository pull requests. Missing or
  invalid committed policy grants nothing; no production profile entry is added.
  Pull request sides use branch-only shorthand only when owner and repository
  identity fields are omitted; any supplied identity must fully match the target.
- Reject actual `.env` files and runtime variants in Git's index and before any push, including personal-fork pushes and filenames later deleted in branch history. Keep `.env.example` templates tracked and local `.env` files in `.worktreeinclude` so worktrees can copy them.
- Scope GitHub App installation tokens to the requested repository. Existing
  installation permission defaults remain unchanged.
- Add the pure repository-maintenance planner under `tools/repo-maintenance/`. It
  is planning only: it turns an immutable snapshot into typed eligibility actions
  and ships no executor, no CLI, and no cleanup. Its pure suite runs through
  `just test-repo-maintenance` and the hosted `repo-maintenance-planner`
  workflow. The dispatcher selects its interpreter from a fixed list of names on
  `PATH` and takes none from the environment.
- Add the pure ownership-policy planner under `tools/repo-maintenance/ownership/`.
  It is candidate only: it turns a fleet inventory and an optional operator config
  into per-repository local, fork-sync, and cleanup ownership, and ships no
  executor, no CLI, and no apply step. Its synthetic suite runs through
  `just test-repo-maintenance` and the hosted `repo-maintenance-planner` workflow.
- Add a pure T3 activity evidence evaluator to the cleanup planner. It derives
  freshness from an observed timestamp, an injected aware clock, and an explicit
  maximum age, while unknown, bound, and running evidence continues to hold.
  Direct `T3Activity` construction remains a caller assertion for compatibility.

# Changelog

## Unreleased

- Split main-branch approval policy into an always-present `approval-main` ruleset. Keep `protect-main` at zero required approvals with signed commits, pull requests, strict existing checks, and no bypass actors; use one human admin PR-only bypass for `propose`/`merge`, and no approval bypass for `full`. Unknown and legacy levels fail closed during application.
- Make `allow_auto_merge` an explicit `apply-settings` option (`--allow-auto-merge on|off`), dry-run by default and unchanged when omitted.
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

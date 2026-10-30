# Adopting the standard

Do these steps once per repository.

## 1. Add the caller workflow

Copy [`templates/caller-ci.yml`](../templates/caller-ci.yml) to `.github/workflows/ci.yml` in the consuming repository. It calls the reusable lint, aislop, security, standard, and coverage workflows. Keep coverage enabled by default and complete the coverage task described in steps 2 and 3 before running conformance. If the repository cannot use the gate, remove the coverage job and request an exception on `ci/coverage`, keyed by this repository in `docs/exceptions.json` of `simpsonm09-repo-standard`. `check-repo` applies the pinned standard's exception file; an adopter-local exception file does not apply. A new opt-out therefore needs a reviewed change to the standard. See [governance.md](governance.md#required-checks).

The `standard` job runs [`check-repo.mjs`](../scripts/check-repo.mjs) for the repository and applies [`exceptions.json`](exceptions.json) from the pinned standard. It checks the tree-local groups on the pull request. See [`features/fleet-conformance.md`](features/fleet-conformance.md).

The caller template pins each reusable workflow to a reviewed, published revision of this standard. When you copy the template or roll it out to a consuming repository, replace its pin with the full SHA of the published standard revision you reviewed. Keep that SHA fixed until you review and adopt a later revision. Do not chase `main` on every change. The pin-update workflow reports when a newer revision is available; review that update before changing the pin.

The trailing comment on each pinned line names what the line pins:

```yaml
uses: simpsonm09-org/simpsonm09-repo-standard/.github/workflows/lint.yml@<sha> # repo-standard, pinned commit
```

Run this workflow in the upstream repository. The fleet rule is that a personal fork runs no Actions, and the upstream repository runs the caller on pushes to `main` and on pull requests. Disable Actions on every personal fork, in its Settings under Actions and General, or with `gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=false`.

The shared jobs do not run tests. Add the repository's own `test` job next to them. See [`testing.md`](testing.md).

## 2. Add the tool pins

Copy [`templates/mise.toml`](../templates/mise.toml) to the repository root. Run `flint init` to choose linters and formatters, then commit the pins it adds. Replace the placeholder `test` task with the repository test command. The `coverage` task is a Python example scaffold: replace its dependency-install and test commands with commands for this repository, and ensure the task creates `coverage/lcov.info`. The example assumes a `[test]` extra that installs `pytest-cov`; add that dependency or replace the example with the project's coverage tool. The shared workflow installs pinned tools only; the coverage task must install the repository's own dependencies. See [coverage.md](coverage.md).

## 3. Add the task runner

Copy [`templates/justfile`](../templates/justfile) to the repository root. It gives a human or an agent one entry point for lint, test, coverage, and the AI-slop gate. Keep `just coverage` mapped to the real, self-contained coverage task. Copy [`scripts/prune.mjs`](../scripts/prune.mjs) to the repository root as `scripts/prune.mjs` so `just prune` works. See [`task-runner.md`](task-runner.md).

`just` is pinned in `mise.toml`. Run `mise install` to get it.

## 4. Add the README

Copy [`templates/README.md`](../templates/README.md) to the repository root and replace the placeholders. See [`root-readme.md`](root-readme.md).

## 5. Add the license

Copy [`templates/LICENSE`](../templates/LICENSE) to the repository root and add the `## License` section to the README. See [`license.md`](license.md).

## 6. Add the scan configuration

- Copy [`trivy.yaml`](../trivy.yaml) to the repository root.
- Copy [`templates/aislop-config.yml`](../templates/aislop-config.yml) to `.aislop/config.yml`. Adjust `failBelow` to the score the repository should hold, and keep the value consistent across repositories.
- Copy [`.github/config/flint.toml`](../.github/config/flint.toml) so Flint has a configuration file to fill in.

## 7. Adopt Dependabot

Add `.github/dependabot.yml` at the repository root so dependency and action pins update consistently across repositories. Start from [`../templates/dependabot.yml`](../templates/dependabot.yml) and uncomment the ecosystem the repository ships:

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

Dependabot has no shareable preset, so the file lives in each repository. The standard checks its shape. Version updates start when the file is on the default branch, and the organization enables alerts and security updates.

## 8. Add the editor and git conventions

Copy `.editorconfig`, `.gitattributes`, and `.gitignore` entries of interest. Mark generated files in `.gitattributes` with `linguist-generated` so Flint and GitHub both skip them.

Never commit or push actual `.env` files or runtime variants, even when they contain no secrets or were later deleted from the branch. The pre-push guard checks filenames in reachable commit history without reading blobs; the `env` group also checks the index. Commit a sibling `.example` template, ignore the local file, and list it in the root `.worktreeinclude` so worktrees can copy it. Start from [`templates/.env.example`](../templates/.env.example) and [`templates/.worktreeinclude`](../templates/.worktreeinclude). The `env` group checks the index, ignore rule, example, and include. See [`features/fleet-conformance.md`](features/fleet-conformance.md).

## 9. Add the documentation layout

Copy [`templates/docs/`](../templates/docs/) into `docs/`, then replace the skeleton with the repository's own index, manifest, architecture page, and feature pages. The manifest declares which optional artifacts apply, including an OpenAPI or AsyncAPI document when the repository exposes a contract. See [`documentation.md`](documentation.md).

## 10. Add agent and skill files

Copy [`templates/AGENTS.md`](../templates/AGENTS.md) when the repository has repo-specific facts. Do not add a `CLAUDE.md`: Claude Code reads `AGENTS.md` when there is none. Copy [`templates/skills/example-skill/`](../templates/skills/example-skill/) to `.claude/skills/<id>/`, renamed to the skill id, for each repo-specific skill. Claude Code and OpenCode both read that location. Copy [`templates/agents/`](../templates/agents/) into `.opencode/agents/` only when the repository needs a repo-specific OpenCode agent profile. Those templates are OpenCode format, and Claude Code does not read them. General best practices and integration come from the plugins, which both harnesses load; the repository holds only its own facts. See [`agents-and-skills.md`](agents-and-skills.md).

## 11. Add community files

Copy `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CODEOWNERS`, `LICENSE`, and the templates from `.github/ISSUE_TEMPLATE/` and `.github/pull_request_template.md` if the repository does not have its own. These are the files GitHub shows in the community health files bar. See [community.md](community.md) for the fields, the required set, and the optional files.

These files are byte-identical across the fleet. Copy `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE`, `.editorconfig`, `.aislop/config.yml`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/bug.yml`, `.github/ISSUE_TEMPLATE/feature.yml`, and `.github/ISSUE_TEMPLATE/config.yml` from this repository without edits. `CODEOWNERS` and `.gitattributes` are the exceptions. Set the owner in `CODEOWNERS`, and add `linguist-generated` lines to `.gitattributes` for the files the repository generates.

## 12. Apply branch protection and repository settings

Run the ruleset apply script for the repository. See [`governance.md`](governance.md).

```bash
bash scripts/apply-rulesets.sh <owner>/<repo> --apply
```

```powershell
pwsh -File scripts/apply-rulesets.ps1 -Repo <owner>/<repo> -Apply
```

Converge the repository settings and add the owner topic. See [`github-settings.md`](github-settings.md).

```bash
node scripts/apply-settings.mjs <owner>/<repo> --apply
```

## 13. Verify

Open a pull request and confirm the lint, aislop, and security jobs run and report to the Security tab. If the repository added a test job, confirm it runs too. Confirm the README, the license, and the docs index are in place.

Run the checker from the repository root. It exits zero when the repository conforms.

```bash
node scripts/check-standard.mjs .
```

From the pinned standard you can run the same check with the exception file applied.

```bash
node scripts/check-repo.mjs . --repo <owner>/<repo>
```

## Optional automation

A repository copies the workflows it needs from `templates/`. See [`automation.md`](automation.md).

- Dependency and Action updates come from Dependabot. Add [`.github/dependabot.yml`](../templates/dependabot.yml) from the template; the organization enables alerts and security updates. See [`automation.md`](automation.md).
- Labels come from [`../templates/workflows/labeler.yml`](../templates/workflows/labeler.yml) and [`../templates/labeler.yml`](../templates/labeler.yml). Create the labels before the workflow runs.
- Releases come from [`../templates/workflows/release.yml`](../templates/workflows/release.yml), which creates a release with generated notes when a `v*` tag is pushed.
- CodeQL comes from [`../templates/workflows/codeql.yml`](../templates/workflows/codeql.yml), for a repository with executable source in a language CodeQL supports. It is not a required check. See [automation.md](automation.md#codeql).

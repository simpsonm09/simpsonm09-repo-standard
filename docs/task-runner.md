# Task runner

Repositories in the fleet expose a `justfile` at the root. `just` is the one entry point for a human or an agent. Run `just --list` to see the recipes.

Keep the recipes thin. A recipe calls a portable executable such as `mise`, `npm`, or `node`, or a script under `scripts/`. The logic lives in one place and the recipe works on Windows, macOS, and Linux.

## Recipes

| Recipe | Does |
| --- | --- |
| `just` | Lists the recipes. |
| `just install` | Installs the pinned tools with `mise install`. |
| `just lint` | Runs the repository linters. |
| `just lint-fix` | Fixes what the linters can fix. |
| `just aislop` | Runs the AI-slop gate. |
| `just test` | Runs the test suite. |
| `just coverage` | Runs the suite with coverage and writes `coverage/lcov.info`. |
| `just test-portable` | Runs the focused cross-platform regression on the host OS. |
| `just verify` | Runs the full local check. |
| `just prune` | Prunes remote-tracking refs and deletes local branches merged into `main`. |

Keep the recipe set small and conventional so a reader can guess a name. Arguments are positional, as in `just emit config.json out.json`.

A repository that calls the shared coverage workflow defines the `coverage` recipe, which is self-contained: the shared workflow installs only the pinned tools, so the recipe installs the repository's own dependencies (`npm ci`, `pip install -e ".[test]"`, and so on), runs the suite with coverage, and writes `coverage/lcov.info`. The standard check requires the recipe whenever the workflow is called. The starter `mise.toml` task is an illustrative Python scaffold, not a working coverage setup for every project. Its Python example assumes a `[test]` extra that installs `pytest-cov`. Replace its dependency-install and test commands with the repository's actual commands, verify that it writes the required LCOV path, and exclude `.standard/` if the test runner globs the repository. See [`coverage.md`](coverage.md).

## Twin operations

An operation whose logic must differ by platform is a twin. It has a bash version and a PowerShell version under `scripts/` and one recipe. See [`scripting.md`](scripting.md).

A single-platform script declares its platform in a header comment within the first ten lines. The value is `windows`, `posix`, `linux`, or `macos`. A `.ps1` file declares `windows`; a `.sh` file declares `posix` when it is portable, or the more specific `linux` or `macos` when it is not.

Call a twin the same way on every platform. Do not name the interpreter or the script file in the call.

```bash
just apply-rulesets <owner>/<repo> --apply
```

The recipe calls `scripts/op.mjs`, which runs the bash version on macOS and Linux and the PowerShell version on Windows. Each platform runs only its own version, so the call needs only that platform's interpreter.

Pass arguments in the POSIX spelling. `--apply` and a positional `<owner>/<repo>` work in both versions. A PowerShell-only spelling such as `-Apply` does not work in the bash version, which reads it as the repository name.

`just <op> help` prints the usage line on either platform.

## Author rules

- Prefer a portable recipe. Split into per-platform scripts only when the logic needs the platform.
- Call a portable executable. Do not put shell operators (`&&`, `&`, `;`, `|`), redirection, `$VAR`, backtick substitution, `./`, or `.\` in a recipe.
- Put multi-step logic in a script under `scripts/` and call it from the recipe.
- Keep the `set windows-shell` line at the top so a recipe behaves the same on Windows.

Start from [`../templates/justfile`](../templates/justfile).

## Conformance

The standard checks every repository's recipes with the `scripting` group in `scripts/check-standard.mjs`. A recipe body stays portable: no shell operators, no `$VAR`, no relative `./` path, and no interpreter name. Name an interpreter only inside a `{{ ... }}` expression or on a `mise exec`/`mise run` line. Route platform logic through a twin and call it as `just <recipe>`.

Run the check on one repository with `just check-standard .`. Run it over the fleet with `just audit-fleet <repos-dir>`, which prints one matrix and exits non-zero when any repository fails. See [`scripting.md`](scripting.md).

## Pinning

`just` is pinned in `mise.toml`. Run `mise install` to get it. Dependabot does not manage `mise.toml`, so bump the pin by hand.

## When there is no justfile

Fall back to the commands in the repository README or `mise.toml`. Prefer `just` when it exists.

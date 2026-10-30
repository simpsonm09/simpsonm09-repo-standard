# Git push range facts

`index.mjs` collects bounded facts for a Git ref update from an explicit local repository root and full old/new commit IDs. It uses fixed, read-only Git commands without a shell, disables external diff/text conversion and lazy object fetching, and ignores the moving branch ref after IDs are supplied.

The result includes every commit in the range and per-parent raw path changes, preserving mode, status, and object IDs. This captures intermediate changes and merge contributions, including workflow paths later reverted. Symlink and submodule modes are reported as data. New branches fail closed because they have no bounded base; branch deletion returns an explicit deletion fact.

Built-in bounds: 500 commits, 16 parents per commit, 10,000 reachable objects,
20,000 path records, 8 MiB per Git command, 64 MiB total Git output, 30 seconds
per command, and a 60-second aggregate extraction deadline. Each child query uses
the smaller remaining time budget; path limits are checked after each parent.
Tests may lower these limits; callers cannot raise them. Subdirectory roots and
shallow histories are rejected. Filesystem root errors use fixed diagnostics.
The module does not make authorization decisions, and its facts are not a broker
or enforcement boundary.

Use `pathBase64` as the lossless path identity; `path` is a UTF-8 display value and
can replace invalid bytes. Workflow-path flags conservatively case-fold the
ASCII directory spelling and flag a bare `.github` entry as well. They do not
establish GitHub workflow eligibility or authorize workflow changes.

Run the named synthetic fixture with `node tools/git-push-facts/fixture.mjs`. It leaves its temporary repository intact for evidence.

The fixture deliberately sets contained `GIT_DIR`, `GIT_WORK_TREE`, and
`GIT_INDEX_FILE` poison paths. Both collector and fixture commands remove all
inherited `GIT_*` overrides (case-insensitively), so fixture writes cannot follow
those overrides into the caller's repository.

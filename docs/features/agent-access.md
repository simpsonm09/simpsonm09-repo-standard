# Agent access

Agent access answers one question for one repository. How much may an AI agent do
against it? The policy is intent, and it lives in
[`repo-catalog`](https://github.com/simpsonm09-org/simpsonm09-repo-catalog). The
resolver and the push guard live here, because the standard owns enforcement.

## The level

`repos.json` carries a default per tier in `agentAccessDefaults` and an optional
`agentAccess` override on a repository. The effective selectable level is the
override when present, otherwise the tier default. The selectable levels are
`propose`, `merge`, and `full`. `read` is an internal baseline for unknown
repositories and invalid or missing policy values; it grants no writes. `none`
is also an internal empty capability set, not a catalog level.

## Capabilities

An enforcement point never asks for a level. It asks whether the repository grants a
capability, so the mapping from the policy to a decision lives in one table in
[`../../scripts/agent-access.mjs`](../../scripts/agent-access.mjs).

| Level | Grants | Added at this level |
| --- | --- | --- |
| Internal `read` baseline | `read` | — |
| `propose` | `read`, `pushBranch`, `openPr` | `pushBranch`, `openPr` |
| `merge` | all `propose` grants, plus `mergePr` | `mergePr` |
| `full` | all `merge` grants, plus `pushMain`, `admin` | `pushMain`, `admin` |

The table is cumulative: selecting a higher level retains every lower-level
grant. The resolver encodes that relationship directly, and the named
`test-agent-access-contract` operation checks the grants against
[`cumulative-contract.json`](../../scripts/fixtures/agent-access/cumulative-contract.json)
and the shared ruleset builder.

## Ownership and scope

The catalog owns repository and tier level assignments. This standard owns the
capability meanings, the shared resolver, the main ruleset payloads, and the
checks that compare policy with protection. The organization plugin owns its
harness gate adapters and bundled resolver API; Maxstack owns installing and
composing plugin layers. The personal plugin layer supplies personal-account
identity, services, and preferences; it cannot redefine repository grant
policy. Those gates consult the standard resolver, but remain guardrails around
a user's personal identity. The GitHub App installation is a separate identity
and permission grant, governed by the App manifest and the catalog's
installation policy.

Levels describe technical capabilities, not task authorization or an instruction
to exercise every grant. An authorized `propose` task can push a feature branch
and open a pull request; neither operation requires `full`. A `full` assignment
does not by itself authorize publishing or activating a particular change.
Publication and activation follow the task's standing or explicit authorization
and the repository's gates.

An explicit committed ignore entry denies its listed destination before normal
read or capability handling. The catalog loader tries `upstream/main`, then the
local `main` ref; if neither loads, the CLI can read the working-tree catalog
file. A per-repository `agentAccess` override takes precedence over its tier
default in whichever catalog was loaded. Therefore roster grants do not always
come from an organization-controlled ref, and a local ref or file can influence
resolution when the fallback is used. The ignore, owned-fork, and owned-repository
loaders are stricter: they read only from `upstream/main`, and invalid or missing
policy does not create a grant. This roster-source limitation is documented for
a separate migration; it does not weaken the ignore or owned-policy source
checks. An explicit CLI `--catalog` path also reads that selected file. Command
text and adapter inputs remain untrusted and the gate's classifier is not a
universal shell boundary. App permissions and branch protection are separate
controls: an access level does not change App permissions, and a full grant does
not remove required checks, signatures, or other hard protection. These
mechanisms are guardrails, not a universal sandbox.

## The resolver

[`../../scripts/agent-access.mjs`](../../scripts/agent-access.mjs) reads the catalog
and resolves one repository.

Destination mode also reads `ignore.json` from `upstream/main` only. The optional
`agentAccessIgnore` field is an array of full `owner/repository` identities on an
existing ignore entry. Each repository name must match that entry's `name`;
identities are matched case insensitively and duplicates or malformed entries
invalidate the committed policy. An ignored destination is denied before read or
null-capability handling. A missing or invalid committed ignore file makes
destination mode exit `2` and deny the decision. The resolver does not inspect
the ignored repositories.

The exported resolver API now includes `loadCommittedIgnore(dir)` and
`FORBIDDEN_CAPABILITY`. The organization plugin bundle must update its pinned
resolver API to version 5, load the committed ignore policy, and pass it as
`ignore` to `resolveDestination(...)`. Its command adapter must preserve the
exact capability returned by `classify`; it must pass `forbidden` through to
`decideTarget` or deny it directly. It must not remap `forbidden` to `mergePr`
or `admin`. Structured intents may use `capability: 'forbidden'`; the resolver
denies that value at every target and level. `--allows` remains a capability
query and is not an authorization decision for a classified command. The `ROOT`
declaration remains the bundle's catalog-location bootstrap and must appear
exactly once.

```bash
node scripts/agent-access.mjs simpsonm09-repo-catalog              # prints the level
node scripts/agent-access.mjs simpsonm09-browser-calculator --json # prints the level, tier, and source
node scripts/agent-access.mjs simpsonm09-repo-catalog --allows pushMain  # exits 1 when denied
node scripts/agent-access.mjs pstack-max --host github.com \
  --destination simpsonm09/pstack-max \
  --intent '{"operation":"push","capability":"pushBranch","readOnly":false,"resolved":true,"refs":[{"kind":"branch","name":"feat/x","isDefault":false}]}' \
  # exits 0 when the destination may be written this way, 1 when it may not, 2 on usage
```

The `--allows` mode exits `0` when the level grants the capability and `1` when it
does not, so a shell caller branches on the exit code.

### Exact owned repositories

`owned-repositories.json` in the catalog can list exact repositories owned by
`simpsonm09` that have no recorded upstream. The resolver reads this policy only
from `upstream/main`; a missing or invalid committed file disables these grants.
The schema accepts only `repositories`, with entries containing `repository`
and `agentAccess: "propose"`. Identities are case insensitive for matching, but
must be fully qualified, unique, owned by the exact configured account, and must
not collide with an owned-fork target or recorded upstream. No owner-prefix
inference grants access.

This destination kind grants `read`, a resolved push to one non-default branch,
and a pull request whose head and base remain in that same repository. It denies
default-branch, force, delete, and tag pushes; cross-repository pull requests;
merges; administration; unknown destinations; and third-party repositories.
This policy is separate from `owned-forks.json`, whose upstream provenance rules
and existing decisions are unchanged. The profile repository remains ungranted
until an exact entry is committed to the catalog.

## The command classifier

`--command` classifies one shell command to the capability it needs, so a gate can
ask about a concrete action instead of translating it to a capability by hand.

```bash
node scripts/agent-access.mjs simpsonm09-repo-catalog --command "gh pr merge 1"        # exits 1, needs mergePr
node scripts/agent-access.mjs simpsonm09-browser-calculator --command "gh pr merge 1" # exits 0
node scripts/agent-access.mjs simpsonm09-repo-catalog --command "gh pr create"        # exits 0, needs openPr
node scripts/agent-access.mjs simpsonm09-repo-standard --command "git push --dry-run origin main" --remote-url "https://github.com/simpsonm09/simpsonm09-repo-standard.git"  # exits 0, fork is out of scope
```

[`classify(command, remoteUrl)`](../../scripts/agent-access.mjs) is pure and returns
the capability or `null`. The `remoteUrl` is optional. The table is ordered, first
match wins.

| Command | Needs |
| --- | --- |
| `gh pr merge ...` | `mergePr` |
| `gh pr merge ... --admin` (including a bare `--admin` in any operand position) | `forbidden` |
| `gh pr create\|edit\|close\|reopen\|ready\|comment\|review\|update-branch ...` | `openPr` |
| `gh issue create ...` | `openPr` |
| `gh pr review` with only recognized comment or request-changes flags | `openPr` |
| `gh pr review` with approval, dismissal, unknown flags, or unsupported quoting | `forbidden` |
| PR create/edit or issue create with `-m`, `--milestone`, or `--remove-milestone` | `admin` |
| `git push <remote> main` or `refs/heads/main` | `pushMain` |
| `git push <remote> refs/tags/<tag>`, or a `--tags`, `--all`, `--mirror`, `--follow-tags`, `--delete`, or `--prune` flag | `pushMain` |
| `git push <remote> <other-ref>` | `pushBranch` |
| `gh release create\|edit\|delete\|upload` | `admin` |
| `gh workflow run\|enable\|disable` | `admin` |
| `gh secret set\|delete` | `admin` |
| `gh repo create\|delete\|edit\|rename\|transfer\|archive\|unarchive\|sync` | `admin` |
| An unmodeled `gh` command | `admin` |
| Known read forms such as `gh pr view`/`list`, `gh status`, and known `gh search` groups | none |
| `gh auth` commands, including `gh auth token` and `gh auth status --show-token` | `admin` |
| Bare `gh -h`, `gh --help`, and `gh --version` final controls | none |
| Other `gh` forms, including an unknown group followed by a read-looking verb | `admin` |
| `gh api` with an explicit method other than `GET`/`HEAD`, including unknown methods and attached `-XDELETE`, or with `-f`/`--field`/`--raw-field`/`--input` | `admin` |
| A REST review-route write or recognized GraphQL review mutation recognized within the supported command grammar | `forbidden` |
| Any other well-formed, unmodeled non-`gh` command | none, allowed |

The `gh` read contract is intentionally narrow: only listed known read group/verb
pairs remain unclassified; every other `gh` form needs `admin`. Help and version
controls are recognized only when the control token is the final argument, never
by scanning operands such as a title value. A help/version token before another
argument, and help topics with trailing words, need `admin`. All `gh auth`
commands need `admin` because token-printing options can expose credentials.
`gh repo sync` is admin-only; this intentional tightening can deny the fork sync
workflow at `merge` level and requires its operator to have `admin`. `gh api` with
an explicit method other than `GET` or `HEAD`,
including an unknown method, needs `admin`; an omitted method remains a read.
The `--command` tokenizer supports one command made of whitespace-separated
tokens with quote grouping and joined adjacent quoted/unquoted fragments. It
models only the literal quoting needed for this boundary; it is not a shell
interpreter. A malformed quote returns `forbidden` for any command. The first
word is checked before command policy lookup: shell escapes, expansions,
grouping punctuation (`(`, `)`, `<`, `>`, `{`, `}`), and the keyword prefixes
`!` and `time` are forbidden there, while a literal executable name is matched by its basename,
case-insensitively, with a final `.exe` removed. This recognizes forms such as
`GH`, `gh.exe`, `/usr/bin/gh`, and a quoted Windows path ending in `gh.exe`
without matching unrelated names such as `notgh.exe`.

These keyword prefixes are refused even before ordinary local commands such as
`time npm test` or `! grep x`; that is a conservative cost of checking the first
word. A compound whose first word is not a governed executable is outside this
check, so `echo ok; gh pr merge 52 --admin` is not classified by this resolver.

For arguments, `$` parameter expansion, backticks for command substitution,
brace expansion, glob characters, grouping and redirection punctuation
(`(`, `)`, `<`, `>`), and unquoted shell separators (`;`, `&`, `|`) are
unsupported syntax; on recognized `gh` commands and `git push`, they return
`forbidden`. Separators are refused whether spaced or glued. Quoted punctuation
remains argument data. Bash punctuation `%`, `^`, and `!` remains literal data
in argument position, including inside quoted PR titles and bodies.
Single-quoted values preserve all their contents. Unquoted backslash escapes are tokenized literally and remain
unsupported on governed commands. Inside double quotes, only Bash's special
backslash escapes for `"`, `\\`, `$`, and backtick are interpreted as escapes
and are unsupported on governed commands. Other backslashes remain literal, so
a quoted Windows executable path can be recognized; Windows path arguments on
governed commands may still be conservatively denied when backslashes form
actual escape sequences. A valid local commit message such as
`git commit -m 'don'\''t'` is accepted by this bounded tokenizer.

This is a finite, supported single-command grammar. It does not inspect leading
environment assignments, wrappers such as `env`, `command`, `exec`, `builtin`,
`nohup`, `sudo`, or `xargs`, nested commands such as `bash -c` or command
substitutions, or newlines. These forms remain outside this resolver unit and
require a separate organization observer. A genuinely
unbalanced quote, including one in a heredoc body, is forbidden even for an
ordinary local command. This is a known false denial. Structured push intents
and standalone command classification are separate interfaces; the command
classifier continues to classify explicit force/refspec forms by its current
rules and this change does not broaden that contract.
For example, `echo <(gh pr review 52 --approve)` is accepted as an ordinary
first-word command: nested command substitution is outside this parser's scope.

A bare `--admin` in any `gh pr merge` operand position is denied conservatively,
even when it is a value such as a subject. Other unmodeled `gh` forms require
`admin` within this single-command scope.

REST route checks inspect every token for a canonical route, including canonical
absolute `https://api.github.com` URLs, query suffixes, and any subtree below
`/pulls/{number}/reviews`. Canonical route and URL spellings are recognized; an
API write with an absolute URL other than the exact `https://api.github.com`
authority, or a candidate endpoint token beginning with `/`, `.`, `%`, `repos/`,
or `repos%` that contains `//`, a backslash, dot segments, or percent encoding
is conservatively forbidden instead of assuming how GitHub or `gh` normalizes
it. Tokens outside those endpoint-like forms are not all treated as paths. This
is a boundary choice, not a claim that GitHub accepts those spellings. The API
write check scans the whole argv lexically without flag-arity parsing, so a
separate flag value beginning with `.` or `%` (such as `--input ./body.json`)
may also be conservatively forbidden. An exact route-shaped token in a separate
argv token is also forbidden, even when it follows a flag; `key=value` body
values are not split. GraphQL review mutations are denied when the canonical
`graphql` endpoint token and mutation can be inspected; opaque input remains
forbidden.

A `git push` is parsed by tokens, not by position. A flag token (leading `-`) is
skipped, the first non-flag token is the remote when it is not a refspec, and the
remaining non-flag tokens are refspecs. A refspec naming `main` or
`refs/heads/main`, including a destination form such as `X:main`, is `pushMain`.
A refspec whose destination is `refs/tags/*` is `pushMain` too, which aligns the
resolver with the [push guard](#the-push-guard), and the `--tags`, `--all`,
`--mirror`, `--follow-tags`, and `--delete` flags are `pushMain` because they
write refs the command does not name. The `--prune` flag is `pushMain` in the
same way: it removes the remote refs the refspec does not cover, so it writes a
scope the command does not name. Any other branch refspec is `pushBranch`,
and no refspec is `pushBranch`. This handles a flag before the remote or the ref,
so `git push --dry-run origin main` is `pushMain`.

The command-string classifier does not interpret `--force`, a leading `+` in a
refspec, or resolve an unqualified destination such as `HEAD:v1` against remote
refs. Those command forms retain their existing `pushBranch` classification and
can be allowed at `propose`; for example, `HEAD:v1` could name a tag if that tag
exists remotely. Structured push intents independently deny a force push. This
is a documented boundary between the two interfaces.

An `api` method is read the same way, by token. `-X` and `--method` take the next
token, `--method=POST` carries its own value, and `-XDELETE` appends the value to
the short flag, which is the form gh also accepts. A read method such as `GET` or
`HEAD`, a bare `-X`, and a token that only starts with `-X` without naming a
method are all reads. The check is the `-X` prefix on one token, not a scan of the
command text, so an argument that contains a verb is not a method.

The same attached short form is read for a body flag. `-f` and `-F` count when
the value is attached (`-fkey=value`, `-Fkey=@file`) as well as when it is a
separate token, because any of them makes `gh api` send a body. A long flag
begins with `--`, so it is never read as an attached short flag, and
`--field=`/`--raw-field=`/`--input=` carry their value after `=`.

`decide(level, command, remoteUrl)` returns `{ capability, allowed }`. A command
with no capability reaches nothing governed, so every level allows it. The command
mode exits `0` when allowed and `1` when denied.

The classifier returns the never-granted `forbidden` capability for admin merge,
review approval/dismissal, unsafe review flags, and review API writes. `decide`,
`--command`, and `decideTarget` deny it at every level, including `full`.
REST review routes are matched narrowly; unrelated API admin writes remain
`admin`. GraphQL review mutations are denied, and an opaque GraphQL query file
fails closed because its mutation cannot be inspected. `--allows admin` is only
a capability query and cannot authorize a specific command. The structured
destination API also validates operands:
organization pushes require a resolved single ref; force and delete are denied;
and a PR base must stay in the destination while its head may use the paired
`simpsonm09/<repository>` fork. An adapter that constructs structured intents
must forward the classifier capability unchanged, including `forbidden`.

## The push scope

A `git push` is governed only when it targets the organization remote. The gate
and the [push hook](#the-push-guard) share one rule: a remote URL under
`github.com/simpsonm09-org/` is in scope, and every other remote, including the
personal fork under `github.com/simpsonm09/`, is out of scope.

The scope enters through the optional remote URL. When it is known and does not
contain `simpsonm09-org`, `classify` returns `null` for the push, so the level does
not govern it and every level allows it. When the URL is unknown, the push stays
governed, so a caller that cannot resolve the remote fails closed. The `--command`
CLI mode takes the URL as `--remote-url <url>`; without it the behavior is
unchanged.

This scope rule is the level-and-classifier path. The destination policy below
decides the same push from the resolved destination instead of a URL substring,
so it closes the third-party hole this scope leaves open. The policy is additive;
the push guard and the org plugin migrate to it in later changes, and until they
do, the URL scope above is what they apply.

## The destination policy

The classifier answers what a command needs. The destination policy answers the
sharper question: which repository is being written, and may it be written this
way? The policy is pure. It takes a destination and a structured intent, and it
returns one verdict.

```js
resolveDestination({ roster, ownedForks, ignore, localRepo, host, destination })
  // -> { kind, owner, repo, level, source, upstream? }
  // kind is 'ignored' | 'org' | 'owned-fork' | 'upstream' | 'unknown'
decideTarget(target, intent)
  // -> { allowed, capability, reason }
```

`resolveDestination` takes a fully qualified `owner/repo` destination and the
host, and resolves one kind. `host` must be `github.com`. Any other host, and a
malformed destination, is `unknown`. First match wins:

| Destination | Kind | Level |
| --- | --- | --- |
| exact identity in `ignore.json` | `ignored` | no capabilities; denied before read checks |
| owner is the roster `org` and the repository is in the roster | `org` | the roster level |
| the personal owner's fork of the clone's own governed repository | `org` | the same roster level |
| a target recorded in `owned-forks.json` | `owned-fork` | `propose` |
| a recorded `upstream` in `owned-forks.json` | `upstream` | internal `read` baseline |
| anything else | `unknown` | internal `read` baseline |

An identity in `agentAccessIgnore` resolves to `ignored` before other destination
matches. It denies reads and writes, including intents with a null capability.

A repository and its personal push fork share one level on purpose. The fork is
not a second grant; it is the same policy applied to the fork the clone pushes
to. A `read` repository's fork push is denied, and a `propose` repository's is
allowed. `localRepo` is the clone's own identity, and the personal owner is the
owner of the repositories the owned-fork policy records, so a third-party
repository that happens to share a governed repository's name resolves to
`unknown` instead of inheriting its level.

`decideTarget` takes one structured intent. The caller builds the destination and
the intent from the command and the observed git state, and nothing in the
command text can widen a grant.

| Field | Meaning |
| --- | --- |
| `operation` | `push`, `openPr`, `mergePr`, `admin`, `read`, `none`, or `unknown` |
| `capability` | the capability the caller resolved, or `null` for a read or a local command |
| `readOnly` | `true` only for a known read or a local command |
| `resolved` | `false` when the destination or the ref kind could not be resolved |
| `refs` | the pushed refs, each `{ kind, name, isDefault }` |
| `force`, `delete` | the push flags that change what a refspec means |
| `base`, `head` | pull request sides; absent sides or branch-only sides with no identity fields use the observed same-repository shorthand, while any supplied `owner` or `repo` must be a non-empty, complete, case-insensitive match to the destination |

`capability` is `null` for a known read or a local command, and that path
requires `readOnly: true`. An intent that contradicts itself about writing is
denied before that path is reached: a writing operation (`push`, `openPr`,
`mergePr`, `admin`) with no capability, a writing operation with a read
capability, or a read operation with a write capability all deny. A caller that
omits `operation` entirely is judged on the capability alone, which is how a
direct pure call that names only a capability keeps its behavior.

`CAPABILITIES_BY_KIND` is the one table per kind:

| Kind | Grants |
| --- | --- |
| `org` | the level's capabilities, from `CAPABILITIES` |
| `owned-fork` | `read`, `pushBranch`, `openPr` |
| `upstream` | `read` |
| `unknown` | `read` |

An owned fork gets a strict subset of `propose`. A branch push is granted only
for a single ref that is a `branch` and is not the resolved default branch, so a
tag, a bare tag, `--tags`, `--all`, `--mirror`, a deletion, a force, a
multi-refspec, and an unresolved ref all deny. A pull request is granted only
when its head and its base stay in the same repository, so a cross-owner `--base`
or `--head` denies. Merge, `main`, release, workflow, secret, repository, and
`api` writes deny at every owned fork, and so do every write to an `upstream` and
to an `unknown` destination.

The default branch is the caller's resolved default rather than a literal name, so
a bare `HEAD`, a bare `git push`, and a default branch that is not `main` are
decided from observed git state.

## Reading the policy from committed refs

The roster comes from `upstream/main`, then `main`. The owned-fork policy comes
from `upstream/main` **only**. For owned-fork data, local `main` is writable by
the same user who runs the agent, so it is never a grant source: a forged
`main:owned-forks.json` would otherwise add a write target. A missing, malformed,
or unsupported policy closes the owned-fork and upstream kinds, so every write to
them is denied. The reader applies the catalog validator's shape rules, accepts
only `propose`, and rejects an unknown field, a duplicate, a malformed identity,
an entry whose repository equals its upstream, and an entry whose repository is
not owned by the one personal account the catalog validator fixes.

That validation is one rule applied in one place, and every pure entry point uses
it: the loader rejects a bad file, and `resolveDestination` and `resolveOwnedFork`
reject a raw policy object a caller passes directly. A policy that mixes a valid
entry with one from another owner is rejected whole rather than half trusted, so
the owner of a recorded fork can never be inferred from the file it is in. That is
what keeps a third-party repository that shares a governed repository's name out
of the organization level.

## What the destination policy does not do

The destination and the ref kind come from git state. The operation, the ref text,
`-R`/`--repo`/`--head`/`--base`, and everything inside a compound command come
from an untrusted command and a recognized-form parse. An unrecognized form is
handled conservatively. The gate stays a guardrail, not a boundary.

These cases are not decided here, and belong to the adapter that migrates later:

- `pushurl`, multiple push URLs, and an unparseable remote URL.
- The real default push remote: `remote.pushDefault`, then
  `branch.<b>.pushRemote`, then `branch.<b>.remote`, then `origin`.
- Resolving a bare ref name, a bare `HEAD`, and the default branch through git.
- `git -C <path>`, aliases, `--no-verify`, pipelines, `$(...)`, `iex`,
  `Start-Process`, `& 'git'`, `bash -c`, and a global `-R` before the subcommand.
- Quoted examples of a write, which the whole-string scans of past versions
  rejected: `echo "gh pr create"`, `git commit -m "gh pr create docs"`, and
  `npm test 2>&1 | grep "git push origin main"`. This classifier reads the program
  at the first token, so none of the three is a write, and the adapter must keep
  that behavior when it replaces its own scan.

The gate acts only in a fleet repository. A command run outside a fleet clone is
not gated, which is unchanged. The destination policy is a decision, and the
adapter decides whether the command's directory is in scope.

## The drift check

[`../../scripts/check-agent-access.mjs`](../../scripts/check-agent-access.mjs) reads
the declared level per repository and compares both active main rulesets. It
requires unique `protect-main` and `approval-main` rulesets targeting exactly
`main`, zero approval and no bypass actors on `protect-main`, and the expected
approval count on `approval-main`. `propose` and `merge` require one approval with
an organization-admin PR-only bypass; `full` requires zero approvals and no bypass
actors. Any App actor, extra actor, missing ruleset, or unreadable count is drift.

```bash
node scripts/check-agent-access.mjs          # exits 1 on drift, 0 when clean
just check-agent-access                      # same, through the operation runner
```

It exits `1` on any drift, including an unreadable ruleset, and `0` when clean. It
is local only: it is not wired into CI, because it needs a token that can read the
rulesets and it reports live state rather than a repository fact.

The resolver prefers the catalog at `upstream/main`, then uses local `main` if
that organization ref is unavailable. The CLI reads the working-tree catalog
file if neither ref loads. This compatibility fallback means a missing
organization ref does not, by itself, make roster grants fail closed. A missing
catalog or clone still denies remote writes.

## The push guard

[`../../templates/hooks/pre-push`](../../templates/hooks/pre-push) installs at
`.git/hooks/pre-push`. It reads the refs on stdin, resolves the repository from the
remote URL, and refuses a push the level does not allow. A push to `main` or a tag
needs `pushMain`, and a push to any other branch needs `pushBranch`. It governs a
URL under `github.com/simpsonm09-org/` and passes every other remote, so the
resolver's push scope above matches the hook exactly.

```mermaid
flowchart LR
    Push["git push"] --> Hook["pre-push hook"]
    Hook --> Resolver["agent-access resolver"]
    Resolver --> Catalog["repo-catalog repos.json"]
    Hook -->|denied| Refuse["push refused"]
    Hook -->|allowed| Remote["origin or upstream"]
```

## Failure modes

The guard fails closed on remote writes.

- A missing or unreadable catalog exits `2`, and the hook refuses the push.
- A missing resolver makes the hook refuse the push, with the expected path in the message.
- A repository absent from the roster resolves to `read`, so a branch push is refused.
- A remote that is not under `simpsonm09-org` is out of scope. The personal fork is a private mirror, so the guard leaves it alone. The resolver agrees when the gate passes the remote URL it is pushing to.

## The agent identity

The boundary is a separate identity, a GitHub App named in
[`../../agent-app.manifest.json`](../../agent-app.manifest.json). The manifest
requests `contents`, `pull_requests`, and `workflows` at write, and `checks` and
`metadata` at read. It never requests `administration`, so the identity cannot change
settings or rulesets.

GitHub has no API to create an app, so
[`../../scripts/create-agent-app.mjs`](../../scripts/create-agent-app.mjs) drives the
manifest flow. It serves the manifest form, your browser posts it to GitHub, and
GitHub redirects a one-time code back to the script. The script exchanges the code
for the app id and the private key.

```bash
just create-agent-app
```

The script writes the private key under the user config directory, never the repo.
Move it into Infisical, where the runtime loads it as `AGENT_APP_PRIVATE_KEY` beside
`AGENT_APP_ID`.

The installation is the per-repository grant. `none` and `read` get no installation.
`propose`, `merge`, and `full` get one. No GitHub App integration appears in either
main ruleset or bypasses protection at any level. The human approval bypass for
`propose` and `merge` is confined to `approval-main`. See
[governance](../governance.md#bypass-actors).

## The token broker

[`../../scripts/agent-token.mjs`](../../scripts/agent-token.mjs) mints an
installation token from the app id and key. Each token request names the target
repository, so the token is scoped to that repository within the installation.
The broker keeps the app's existing installation permission defaults. It does not
narrow permissions by operation.

```bash
node scripts/agent-token.mjs simpsonm09-org/simpsonm09-repo-catalog
node scripts/agent-token.mjs simpsonm09-org/simpsonm09-repo-catalog --json
```

The app id and key come from `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY`, with a
fallback to the user config directory for development. The token is printed to
stdout. Never log it, and never write it to a file.

## The agent-side gates

The push guard is a git hook, so it runs for a `git push` from a clone that has it
installed, unless the push skips hooks. The org plugin ships agent-side gates for
OpenCode, Claude Code, GitHub Copilot CLI, and Pi. All four use the shared resolver and
gate decision, so a level means the same thing in each. They act only in a fleet repository,
a clone under `projects\repos` or a worktree of one. Any other path is not gated. See the org plugin's [gate overview](https://github.com/simpsonm09-org/simpsonm09-org-ai-plugin#the-agent-access-gate).

- **OpenCode** calls the gate in its `create.before` shell hook. It rewrites denied
  commands to a shell-specific error and sets `GH_TOKEN` for an allowed `gh` command.
  Resolver-permitted writes run without an approval prompt. See the plugin README's
  [Known limits](https://github.com/simpsonm09-org/simpsonm09-org-ai-plugin#known-limits).
- **Claude Code** uses `PreToolUse` for Bash and PowerShell. It denies disallowed calls
  and rewrites allowed Bash `gh` calls through the token launcher. Read-only `gh` calls
  run without a prompt; other allowed `gh` calls ask first. `gh` in PowerShell is denied
  with a hint to use Bash. A `SessionStart` hook states the repository's level.
- **GitHub Copilot CLI** adapts its native hook payload to the Claude decision and maps
  command rewrites to `modifiedArgs`. It supports Bash and PowerShell. Allowed `gh` writes ask
  first unless the hook process has `AGENT_ACCESS_COPILOT_ASK=allow`.
- **Pi** gates Bash calls through its `tool_call` extension. Denials block the call, and
  allowed `gh` calls use the token launcher. Read-only `gh` calls need no prompt; other allowed
  `gh` calls ask when a prompt is available and block if no one can answer. `AGENT_ACCESS_PI_ASK=allow`
  skips that prompt in RPC or no-prompt sessions. For child agents to load the gate, install
  the package in Pi's saved `packages` list.

All adapters decide from the first command only. They do not inspect scripts or later
commands in a chain. Unclassified non-`gh` commands can pass, and the adapters differ in failure
handling, prompting, and shell coverage. The plugin README's [Known limits](https://github.com/simpsonm09-org/simpsonm09-org-ai-plugin#known-limits)
and [Known limits (Pi)](https://github.com/simpsonm09-org/simpsonm09-org-ai-plugin#known-limits-pi)
sections have the complete shared and harness-specific list, including behavior that has not been
measured live.

The Copilot hook must keep the native camelCase event keys. PascalCase keys do not tell
the adapter which shell dialect is in use, so it denies the call. For more detail on the
four adapter protocols, see the org plugin README's [gate overview](https://github.com/simpsonm09-org/simpsonm09-org-ai-plugin#the-agent-access-gate),
the [Copilot build](https://github.com/simpsonm09-org/simpsonm09-org-ai-plugin#github-copilot-cli-build),
and the [Pi build](https://github.com/simpsonm09-org/simpsonm09-org-ai-plugin#pi-coding-agent-build).

The Claude hook can fail open if Claude Code kills it at its own hook timeout or cannot find
`node`; its internal failures deny. Copilot's timeout behavior and its PowerShell rewrite
have not been measured live. Pi's gate has no hook time budget, and whether Pi executes a
rewritten command or accepts the documented confirmation API has not been verified live.
On Windows, Bash token launches require Git Bash. Copilot's PowerShell launches use Windows
PowerShell. The plugin also needs Node and Git, plus
the local repo-standard resolver/catalog. Tokenized `gh` calls require broker credentials and a
successful token mint. See the plugin README's [Known limits](https://github.com/simpsonm09-org/simpsonm09-org-ai-plugin#known-limits)
and [Known limits (Pi)](https://github.com/simpsonm09-org/simpsonm09-org-ai-plugin#known-limits-pi)
for the precise cases and remaining limits.

## What this does not do

The resolver and the hook are a guardrail, not a boundary. Any command the gate does not
rewrite runs under the maintainer's own login, so an agent that bypasses the hook is not
stopped. A process running as the same user can also reach the token broker. The
boundary is the agent identity above, which the catalog roadmap tracks.

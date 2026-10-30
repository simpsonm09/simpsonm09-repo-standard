# Fleet App operation executor

This source-only unit executes two fixed GitHub REST operations: `readRepository`
and `createPullRequest`. It accepts only operation operands, resolves the exact
target and concrete intent through the shared `resolveDestination` and
`decideTarget` APIs, verifies pinned policy bytes, looks up that repository's App
installation, requests a one-repository token with the operation's exact
permission, validates the returned scope, and then calls the fixed endpoint.
Issue creation, arbitrary REST calls, Git transport, pushes, merges, admin
operations, and broad `openPr` dispatch are unsupported.

The factory requires a trusted bootstrap object containing the App ID, expected
registration owner, manifest permission ceiling, four policy snapshots with
expected SHA-256 digests, and explicit signer and fetch functions. It has no
default signer or global `fetch`; invalid bootstrap data returns before I/O.
Policy snapshots must come from a separately trusted bootstrap process. Local
working-tree and `main` fallback are not used. Targets must resolve as an org
repository, so clone-local inference and personal-fork target execution are not
enabled here.

The executor keeps the JWT and installation token in local variables and returns
only bounded repository or pull request fields, or a fixed failure code. HTTP
requests use `api.github.com`, manual redirect handling, a one-megabyte response
limit, a 15-second overall operation timeout, and no retries. PR request fields
are copied from data-only descriptors into an immutable snapshot before policy
authorization, then reduced to the endpoint's allowlisted payload. Installation
lookup requires an Organization account. Unread or rejected response streams are
cancelled without awaiting cancellation, and abort listeners are removed when
each asynchronous wait settles.

Results distinguish a pre-write failure (`denied`) from an uncertain PR creation
(`outcome-unknown`). Once the PR fetch is dispatched, a disconnect, timeout,
HTTP error, or invalid response cannot prove that no PR was created. Those paths
return `outcome-unknown` with a fixed code and never retry. This conservative
classification also covers fetch errors before the transport can confirm a send.
Installation lookup and token minting can precede a `denied` result; local policy
denials perform no I/O, and failures before PR dispatch perform no PR POST.
A caller that loses the broker's response after submitting a PR request must
also treat the result as `outcome-unknown` and must not resend automatically.
While fork topology is unresolved, PR heads and bases must name the target
repository itself; a fork or other-repository head is `invalid-request` before
any I/O. The shared agent-access resolver's grants are unchanged.
`readRepository` returns metadata only. There is no PR lookup or automatic
recovery operation; an uncertain creation requires separate authorized inspection
before any retry, subject to final-denial restrictions.

## Verification

Run only this fake-port fixture with:

```powershell
just test-fleet-app-executor
```

The named operation is also registered in the aggregate suite; only the named
fixture is run during this local unit. It uses built-in `Response`, synthetic policy digests, marker-only signer/token
values, and injected fetch. It performs no network or credential access.

## Deployment limits

A JavaScript factory and fakeable ports are not a security boundary. Deployment
requires a separately isolated broker service with a trusted bootstrap, protected
App key custody, and authenticated operation channel. This code does not prevent
same-user processes from using ambient human credentials. It does not integrate
a daemon, CLI, runtime caller, or installed adapter. Existing legacy
`mintForRepo` and stdout/environment token paths remain unchanged and unsafe
until coordinated caller migration; this unit does not claim they are fixed or
active. Key custody, accepted live installation grants, caller migration,
authenticated isolation, actor evidence, and runtime adoption remain
prerequisites before activation.

## Stdio carrier

`carrier.mjs` is the child half of the planned native-host transport. A future
native Windows host spawns one `execute-one.mjs` child per authenticated
request, writes one framed request to its stdin, and reads one framed response
from its stdout. This unit is not a service, a pipe server, or native code.

A frame is a four-byte unsigned big-endian length followed by strict UTF-8 JSON
with no byte-order mark: 128 KiB maximum request payload and 16 KiB maximum
response payload. A request is `{ version: 1, requestId, identity, request }`
with exactly those keys and no duplicate keys; `requestId` is 32 lowercase hex
characters, `identity` carries the `userSid`, `logonSid`, and bounded `alias`
that the native host attaches after authenticating the pipe client, and
`request` reaches the executor unchanged. SIDs use the
Windows string form (`S-1-...`, as `ConvertSidToStringSid` writes it), not hex.
The host writes the one frame and then closes the child's stdin; the child
reads to end of input before it acts, so a host that keeps stdin open gets no
response.

A frame that is not exactly one readable request writes no response and exits
nonzero: duplicate or unknown keys, a wrong version, an unreadable requestId,
trailing bytes, invalid UTF-8, an oversize declared length, a truncated frame,
or a missed frame deadline (five seconds by default). The exit code and empty
stdout do not say whether the executor ran, so the host must report a missing
response for a forwarded request as `outcome-unknown`, never `denied`. A
readable requestId with a missing or malformed identity record, an account SID
outside the allowed list, or a non-object `request` is answered locally with
`{status:"denied",code:"internal-channel-invalid"}` before any executor call.
A result that cannot fit the response frame becomes `response-too-large` and
keeps its outcome class: `denied` stays `denied`, while `completed` and
`outcome-unknown` become `outcome-unknown`.

The child trusts the host for identity. It checks that `userSid` is one of the
allowed agent accounts from trusted custody, but it cannot prove that this is
the account the host authenticated for this request; that binding is the
native host's job and its own fixture's. `logonSid` and `alias` are
shape-checked only and are not compared to any expected value.

`execute-one.mjs` loads no key, credential, or environment value. Its trusted
bootstrap and the allowed agent account SIDs are supplied by protected release
custody in a later unit; run directly it has neither, so it exits nonzero
without reading stdin and performs no operation. `runOne` takes a ready
executor, so the fixture can drive the oversize-response path with a fake one. `stdio-fixture-child.mjs` is a fixture-only entry with a
fake bootstrap and an injected fetch. Run the named fixture with
`just test-fleet-broker-stdio`; it spawns real child processes for the happy
path, the second-frame case, the frame deadline, and the direct entry with no
custody, and drives the other cases in-process through `runOne` with
`PassThrough` streams.

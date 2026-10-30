# T005 fixed boundary control implementation contract

Status: selected implementation contract after independent protocol review and
primary correction of its health-propagation finding; this is not runtime
acceptance. Same original Task/producer/authority and exhausted diagnostic
history. Network controls, T004 handoff, graph and final acceptance remain
original obligations. This contract settles the next complete boundary-control
capability and its dependent negative probe.

## Source facts and reuse

ResourceOps.createBoundaryControl currently rejects; prepareProbe cannot select
host-boundary. The accepted managed qualifier already accepts only an opaque
OwnedBoundaryControl, calls assertPositiveControls, selects host-boundary, then
requires probe cleanup before disposing the control. Existing unmanaged backend
verifyProfileHostBoundaries creates two 0600 canaries and a fixed Node secret
process, positively reads them and checks /dev/vdb and /var/run/docker.sock,
then demands six negative guest facts. Keep those exact assessments and limits.
Reuse the pure fixed-probe catalog and existing retained-FD, guardian identity,
authenticated receipt, serialized mutation and actual process-group settlement
mechanisms. No guardian import of runtime-oci/backend; no second backend,
public factory, generic host-process/argv/path/target relay or readiness flip.

## One original control keeper

Add a private versioned fixed boundary-control lifecycle, for example
qdroid.fixed-boundary-control/v1, with strict request/reply key sets. A fresh
SandboxGuardianClient is idle until the same BuildSession ResourceOps has
registered the control intent, attested its real boot/PID/start/group, persisted
that identity and acknowledged the existing provider journal. Only then may
trusted ResourceOps authorize this exact fixed creation. Register the raw
construction responsibility before the first fork; any await must recheck
closing/cancel/deadline before new effects. A stopped/closing control can never
resume creation or accept new dependent probes.

ResourceOps creates a UUID resource ID; all receipt and fixture names derive
from that ID in the existing fixed private session layout. The guardian validates
that layout, owner/session/resource tuple and the trusted fixed recipe before
effects. Control IPC carries no caller-selected executable, program, environment,
arbitrary file names, devices or extra Docker arguments. A private key/receipt
path is internal owner-to-guardian data, never a package input or public API.

The original keeper opens and validates the exact existing fixture parent with
nofollow retained descriptors, then creates and retains its own boundary
subdirectory plus two fixed canary files with explicit private modes. It retains
the original parent/child/file descriptors and per-child identity inventory,
uses bounded fixed contents, and never acquires deletion ownership by reopening
a pathname later. Replacement, extra entries, links or unknown close/writer
facts remain unresolved. Reuse the existing per-child postorder removal.

The keeper launches only the fixed Node standby child with a fresh random
process-secret environment entry and a minimal trusted environment. Do not
inherit the supervisor's arbitrary credentials. The child stays in the keeper's
owned group; capture actual child PID/start before acknowledging creation.
Observe all child error/exit/raw streams immediately. The secret is not returned,
logged or journaled; only the original keeper can perform the positive read of
/proc/<exact-child-pid>/environ. A PID/start mismatch is failure, never permission
to signal a reused PID/group. Device and Docker-socket positive reads use the
existing fixed reference-host paths; unavailable controls reject qualification.
No device/socket is mounted into the workload.

After files and child exist and their identities are durable, the keeper writes
an authenticated immutable control-created receipt, file sync and parent-dir
sync before parent acknowledgement. It binds protocol, owner/session/resource,
keeper boot/PID/start/group, child PID/start, exact fixed relative canary names
and original inode identities. Domain-separate this receipt from assembly,
provider and probe receipts. Parent persists/acknowledges its exact receipt tag
before returning the privately registered opaque handle. Missing/ambiguous
creation success retains ownership and blocks later use.

## Closed operations and dependency registration

The public private-adapter surface remains OwnedBoundaryControl with
assertPositiveControls and dispose. WeakMap/object identity binds it to this
actual ResourceOps; structural/cross-session/stale/closing handles reject before
effects. Target paths and process identity are readonly keeper-owned facts,
resolved internally into the fixed negative probe, never accepted back as
authority through a package-facing API.

Positive-control IPC performs only the fixed canary contents/inode reads, exact
child identity/environment-secret read, and fixed device/socket type checks.
It is tracked, bounded and lifecycle-fenced through raw settlement. Unexpected
keeper/child loss or control mutation permanently latches failure. Concurrent
dispose seals admission synchronously and waits admitted control reads before
deleting anything. A healthy pre-disposal result cannot erase a later failure.
After all dependent probes and admitted reads have actually settled, dispose
must revalidate the fixed positive controls before initiating its own child
shutdown or file removal. Any prior or newly observed health failure makes
dispose reject with the original latched cause even when physical cleanup is
subsequently confirmed. Retain that independent physical cleanup proof internally;
never return plain confirmed cleanup to hide invalid controls. Mark only the
actually initiated, identity-verified cleanup shutdown as expected, so ordinary
self-disposal does not manufacture a control-health failure. This preserves the
existing consumer API, which checks positives before the probe and only awaits
dispose afterwards; no public health field or frozen consumer edit is needed.

prepareProbe synchronously acquires the existing same-session dependency
reference before returning its owned probe; prepared-but-unused cleanup releases
it through an explicit no-create path. It must not fork or authorize a negative
probe before registering the probe responsibility. Before a probe guardian is
authorized to create Docker resources, attest/persist that idle guardian and
register its exact dependency with the control keeper. The keeper durably
acknowledges that dependency BEFORE any Docker create authorization. Pending
registration plus parent loss cannot permit creation afterward. Registration
identifies one fixed probe resource, exact name/image/labels, actual guardian
boot/PID/start/group and fixed original creation/terminal proof locations; no
arbitrary cleanup command is accepted. Original keeper owns the registry and
serializes its durable updates; it cannot be reconstructed as a fresh file
deletion authority.

Do not leave an unexplained gap between an idle guardian fork and dependency
registration. Inside OwnedProbe.create, first configure that guardian with the
fixed dependency/spec and durably acknowledge a not-yet-authorized probe state;
this step performs no Docker create/start. Next the control keeper registers
that exact configured guardian and proof, then acknowledges durably. Only then
may the parent send a distinct one-shot create authorization. The configured
guardian records authorization before Docker effects and writes a no-create
terminal on parent loss while still never authorized. A guardian crash or
possibly-submitted create with missing original proof remains unknown. This
private preparation/authorization split does not change the OwnedProbe API or
unmanaged/v1 existing selector behavior.

The dependent host-boundary variant extends the closed private probe union with
mandatory control-created and dependency bindings. Existing fixed-probe/v1
selectors keep their exact schemas and meaning; an old parser must reject the
new variant before effects, not ignore its required fields. Exact schema/nonce
and owner tuple checks bind the new variant to the authenticated control and
registered dependency. The new variant always selects the existing code-owned
negative-boundary program and fixed profile limits. Pass only internally resolved
canary paths and exact secret-child PID as data to the code-owned program.
Preserve all six original negative facts and unchanged workload isolation.
Resolve profileId only through the existing immutable SANDBOX_PROFILE_CATALOG
IDs (build-restricted, render-offline and tool-offline) and their exact original
limits/digests. Do not accept caller-defined profile values or add profile kinds.

The original probe guardian durably records exact Docker create success before
start. Before reporting final cleanup it writes an authenticated terminal proof
bound to this control dependency and immutable first command result, after actual
raw command/observer/attach settlement and exact container removal. Use the
existing original no-create versus created-cleaned distinction: no-create
requires a proved never-authorized create and actual idle guardian settlement;
possibly-submitted create without authentic success remains unknown. Immutable
first command result and final resource cleanup remain separate facts.

Parent drops its dependency reference only after original proof plus actual
guardian/group settlement. The control keeper validates that same original
proof/identity before durably retiring its registered dependency. Lost parent
ack does not repeat creation or change the original outcome. Probe cleanup does
not wait for or shut down the control keeper; control dispose stops/drains probes
first. There is no cycle from probe cleanup back into control dispose.

## Cleanup, parent loss and fresh recovery

dispose is cached/idempotent, seals new dependencies immediately, and requests
stopAndRemove for all admitted dependent probes. It may remove its canaries or
stop the secret process only after every dependent resource is proved cleaned
and its original writer/group is gone. No dependency terminal is inferred from
IPC close, elapsed time, missing path, container-name search or parent death.
Unknown dependencies retain original FDs and evidence, and disposal cannot
report confirmed cleanup.

On parent disconnect the original keeper seals all effects and performs only
cleanup/observation. Already authorized probe guardians perform their own
cleanup; the control keeper waits their exact authenticated receipts and actual
identity/group absence, with bounded reporting and continued ownership of raw
obligations. It never starts/replays a probe or reconstructs a deletion writer.
When dependencies settle, it stops and joins its original secret child, removes
only its original per-child inventory through retained FDs, syncs/settles all
raw descriptor operations, then writes its authenticated durable cleanup
terminal and exits. A replaced child/root or unknown writer retains evidence;
all independent command/fsync/close/cleanup errors survive aggregation.

Fresh BuildAuthority recovery can consume only this original authenticated
terminal plus original dependency and real keeper/group settlement. An absent
keeper/receipt is not success. This capability owns only its boundary subtree;
it cannot delete the shared ResourceOps fixture root or imply complete provider
recovery. Complete original provider-root/other-control/T004 cleanup and terminal
proof remain necessary before retiring a session/new admission. Same physical
BuildAuthority/recovery transaction rules remain unchanged.

## Acceptance for this capability; original whole Task still required

Implement boundary keeper, private protocol/receipts, opaque handle, dependency
lifetime and actual managed host-boundary probe as one bounded deliverable under
the same producer. Keep network and full qualification readiness unsupported
until their own actual inventories are complete. No frozen consumer helper/test
or CLI changes are needed; main may change backend integration within its
existing transferred write scope. No new actor/factory or generic recovery port.

Necessary current-input verification: exact closed protocol/forged/cross-session/
disposed inputs reject with zero effects; actual host positive controls and
fixed Linux six-negative probe; stop during creation and late acknowledgements;
no-create and actual created cleanup proofs; dispose waits held prepared/created
probe and raw control read; original probe cleanup leaves controls usable;
actual parent SIGKILL after dependency registration, keeper waits a held owned
probe writer and then cleans its own resources; replaced canary/subdirectory
retained; lost/mismatched receipt/child/guardian identity remains unknown and
blocks new admission; independent original and cleanup errors preserved.
Explicitly exercise secret-child loss after the first positive check but before
the negative probe reads /proc: negatives alone cannot qualify, dispose rejects
with the latched health cause even if physical cleanup is confirmed. Normal
identity-verified self-disposal must succeed without a false health failure.
Preserve all old failures, unsupported scopes, diagnostic allowances and final
unified host/Linux/cumulative/graph/USE-003/independent-review acceptance.

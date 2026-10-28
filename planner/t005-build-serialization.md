# T005 build serialization contract

Planning input for a concrete integration gap: T004's resource counters belong
to an immutable-image backend object. They do not serialize two installer
processes or two image backends. T004 was accepted on the r34 input; the API
alignment below is the T005 implementation contract. The Feature engineering
context owns the effective plan.

## One trusted build authority

All executable installation paths for one qdroid node use the same administrator
configured installer root, registry and build authority. Workload/package input
cannot select another root, lock, owner store, image backend or runtime flags.
Content-only validation and registry reads do not obtain execution authority.

Serialize actual qualification and build execution across images and installer
processes. Qualification belongs inside this exclusion because its resource
probes also consume the node envelope. First fetch/validate/freeze the bounded
candidate, then acquire the trusted build lease before any qualification or
builder side effect. Keep the current execution limits; two 1024 MiB builders
cannot run concurrently under the 1536 MiB envelope.

Use a private versioned SQLite lock database dedicated to this exclusion, with
the accepted recovery-lock mechanism as the reuse reference. A dedicated
connection holds BEGIN IMMEDIATE over qualification/build/confirmed cleanup.
This lock database is separate from the registry/Policy transaction authority;
holding its lock must not hold the registry or permission database's write
transaction across awaits. Use finite contention behavior and strict private
file/schema ownership checks. Do not use mtime/TTL or check-then-unlink locks.

## Durable ownership and failure

Before backend side effects, persist a build-session/candidate intent containing
trusted owner boot/PID/start identity, immutable image/profile/candidate binding
and the service-owned cleanup-store reference. Only host-generated relative
store identities under the trusted installer root are accepted. Complete/fsync
the intent before launching. Package metadata cannot forge this record or supply
a cleanup path.

Physical lock availability after a process crash is not cleanup evidence. The
next build owner checks all retained incomplete sessions from this authority
before starting another qualifier/builder. Recover only dead owners' precisely
identified resources; a live guardian or unresolved/malformed/unknown ownership
keeps the session pending and blocks new build execution. Preserve old evidence.
Do not construct a new backend to bypass the retained reservation.

An ordinary execution failure can retire its session only after the backend's
actual cleanup is confirmed. If qualification fails without enough cleanup
evidence, conservatively retain a blocked session rather than interpreting the
exception as zero resource usage. Provide trusted cleanup/observation for that
existing session; it cannot rerun the build or grant a permission. Keep the first
failure and any cleanup uncertainty distinguishable.

Actual T004 inspection found that execution journals do not cover all legacy and
profile qualification resources. Before the first executable installer can use
qualification, extend the trusted runtime adapter with a durable qualification
session. Persist its exclusive intent before calling either qualifier, then bind
every probe container, dedicated control/attach process group, synthetic network
fixture and I/O/control directory to that session before its creation side effect.
Use host-generated exact identities and private resource namespaces, never a
package path or a prefix scan. Reuse the accepted guardian/store mechanisms for
process creation handshakes, authenticated ownership and cleanup-only recovery.

The session receives complete cleanup evidence on success, failure and fresh
recovery. A qualifier return, an empty execution-journal scan or release of the
physical lease is insufficient. Unknown creation, live control groups, late
commands, unsupported record versions or any unaccounted resource retain the
exclusive session and candidate/image references. Recovery observes or removes
only authenticated, precisely owned resources after their original writer can
no longer create them; it never reruns qualification or a build. The exact
internal API must be aligned to the accepted T004 implementation before dispatch.

Use a narrowly injected production `ResourceOps` dependency in the existing
trusted adapter address space. It owns actual resource creation, durable intent,
writer settlement and cleanup; before/after observation hooks are insufficient.
Reuse the accepted guardian/create-success receipt, fixed cleanup-only writer and
raw-mutation lease mechanisms. Do not depend on `trustedTestHooks`, expose a
workload control API, add a generic IPC command relay or duplicate the backend.
Qualification records need their own explicit namespace/version; they cannot be
misread as execution records or grant execution authority.

One continuous `BuildSession` remains responsible from the first qualification
resource through qualification cleanup, subsequent `create`/`execute` fingerprint
preflight, execution ownership handoff and final confirmed session cleanup.
The accepted backend's `assertQualification` also invokes native Docker/runtime
version and checksum commands before an execution journal exists. Closing a
qualification-only session before `create` leaves these detached process groups
unowned if the installer dies. Register these exact commands/groups before their
creation effects under the same production ResourceOps; no new executable step
may escape session ownership between qualification and journal handoff.
Qualification resources still require confirmed cleanup before build execution;
a continuous owner does not authorize overlap, replay or reuse of an unknown
qualification. Preserve opaque same-backend qualification handles and existing
T002/T003 API behavior. A trusted constructor dependency is enough; this does not
require changing the public `SandboxBackend` contract.

Release the durable reservation only after identified cleanup confirmation, then
release the physical lease. If the process crashes between those operations, the
next owner may confirm absence and retire the same old intent. It never obtains
permission to repeat the old build by reusing its session. Re-running an explicit
installation request still follows candidate/input identity and registry rules.

## Registry publication and future composition

The build lease does not select or activate a version. Immutable output/image
validation, sealing and the atomic installed-disabled registry commit retain
their existing independent contract. No grants/instances arise from the lock.
Registry transactions remain short and compatible with T006's shared lifecycle
and permission authority. A completed build may release its execution lease
before final publication; immutable-key/output conflict checks still serialize
the actual commit.

The current `PolicyAuthority` owns its SQLite connection, migration and
`PRAGMA user_version`. Registry schema metadata must use its own namespace and
must not overwrite that version. Keep registry tables compatible with the later
single selection/permission transaction authority; a separate registry file must
not become a claimed atomic lifecycle implementation. T005 does not change
admission migrations or expose a general database handle. T006 must align its
narrow shared transaction adapter with the accepted registry before activation.

Final immutable images can be shared by two independently assembled candidates.
An uncommitted candidate therefore does not own deletion of its final image,
even after its original builder is dead. T005 never automatically removes a
sealed final image during candidate failure or crash recovery. It retains the
image identity and candidate receipt for trusted observation; another candidate
may publish the same image concurrently. Only precisely owned temporary
assembly containers, staging files and sessions follow the existing confirmed
cleanup rules. Catalog bases and committed images are never candidate cleanup
targets. Finite storage admission still applies: retained images cannot justify
an unlimited new build or deletion outside this rule.

T006 may later reclaim these retained images only through its registry reference
and collecting-state protocol, with publication and reference acquisition
serialized against collection. This is an explicit first-version choice to
retain uncertain/shared images, not an assumption that checking for a registry
reference before an asynchronous delete would be safe.

This initial build-only authority assumes no already running application/tool
service. T006 must compose all build/application/MCP/render executions through
one trusted SandboxManager with shared cross-image reservations and version
references before those services coexist. A build-only mutex is not the future
node-wide workload resource manager.

## Current API integration map

Read-only mapping of the accepted T004 implementation.
This map locates the already-required durable qualification work and adds no
installer support claim or resource limit.

| Existing API or owner                              | Actual composition fact                                                                                                                 | Required T005 integration                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `SandboxBackend` in contracts                      | Opaque qualify/create/execute/stop; no qualification-session cleanup receipt                                                            | Keep workload-facing authority opaque; session ownership belongs to the trusted runtime adapter                                  |
| `OciSandboxBackend.qualify` in runtime-oci/backend | Calls fixed legacy qualification and profile probes; backend image and execution reservations are object-local                          | Persist one exclusive qualification-session intent before either qualifier and return/retain its actual cleanup evidence         |
| `DockerSandboxManager` in runtime-oci/index        | Owns fixed-profile probe containers, attached commands, synthetic canary/secret/store files, network controls and I/O files             | Register every owned resource before its creation effect; process handshake and exact create settlement must survive owner death |
| `verifyProfileTuple` / profile workload helpers    | Own profile probes, a private boundary directory and per-profile I/O/control resources; network operations have a separate tracked lane | Compose all resources into the same qualification session; the network lane alone cannot attest whole-session cleanup            |
| `recoverAbandoned`                                 | Recovers authenticated execution/network records; an empty report does not inventory the legacy qualifier                               | Keep its accepted execution meaning; add explicit trusted qualification-session recovery rather than inferring absence           |

The current legacy I/O root is a trusted configured synthetic-test location;
it is not a package-selected path. A session records the exact host-generated
file identity there before creation, and must prove writer settlement before
retirement. Source files and fixture controls created before a qualifier's
local try/finally still require the same durable owner. Production ownership
must not depend on test-only hooks. Existing T002/T003 entry points and their
qualification semantics retain compatibility; only the installer composes the
new durable exclusive session before its executable path is enabled.

## Required evidence

- Two independent installers sharing the configured authority and different
  immutable builder images show actual peak qualification/build concurrency one.
  No second backend bypasses an active or cleanup-unknown reservation.
- Kill a holder before creation, during an actual build and after cleanup before
  lease release. A fresh owner observes/reclaims only that identified abandoned
  session and starts no new build while its guardian/cleanup remains unresolved.
- Kill a qualifier after the actual legacy/profile container, dedicated control
  process and I/O fixture creation boundaries. Fresh recovery accounts for the
  complete session, preserves live peers and blocks another installer until all
  owned resources are confirmed gone; an empty execution store cannot release it.
- Kill the installer after qualification cleanup but during actual post-qualification
  Docker/runtime fingerprint preflight, before the execution journal. A fresh
  owner must account for the registered native process/group, admit no next build
  until cleanup is confirmed and perform no qualification/workload replay.
- A live owner, malformed/future record, changed boot/start identity or daemon
  unknown result is handled according to the existing ownership contract, with
  no false cleanup confirmation or unrelated resource deletion.
- A denied/failed candidate leaves installed versions unchanged; a repeated
  committed identical input still returns the same disabled record without a
  new build, instance or grant. Preserve the original concurrent publication
  conflict and crash tests rather than replacing them with mutex-only tests.
- Two candidates resolve to the same final image. Crash the first before
  publication, interleave its recovery with the second candidate's disabled
  commit, and verify the image remains usable with no image-remove operation.
  Recovery retains the first candidate's image receipt and does not reclaim the
  second candidate's committed content or resources.

This alignment keeps the accepted T004 opaque backend API and cleanup/error
semantics. T005 implements its candidate schema within the separately settled
package contract. No additional framework or external service is required.

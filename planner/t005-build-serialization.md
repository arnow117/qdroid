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

The executable USE-003 reference composition uses the code-fixed Linux directory
`/var/tmp/qdroid-package-install-demo-reference-node-uid-<trusted uid>` as its
reference-node state root. It must not derive this authority namespace from
`TMPDIR`, `TMP`, `TEMP`, `HOME`, a package, image, PID or per-call randomness.
Unavailable or invalid state rejects without choosing a fallback root. Before
constructing PackageInstaller/runtime, create or strictly validate this root and
its fixed `installer` and `owner-store` subdirectories as actual directories of
the expected trusted UID and exact private mode, refusing symlinks, foreign
ownership or wrong mode without repair. Complete directory and parent-directory
synchronization before use; retain independent sync/close failures and perform
zero installer/runtime actions on failure. Content-only and direct controlled
Mock fixtures continue using isolated temporary directories. This is a reference
fixture path choice, not a claim about deployed robot state configuration.

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

## Accepted internal ResourceOps implementation choice

This section resolves the concrete API gap found during T005 implementation.
The accepted T004 backend has no production resource dependency. A separate raw
Docker build executor is not a qualified replacement and must not be used.
The following is a private trusted-adapter contract, not a workload API or a new
backend proxy. Names may change without changing these capabilities.

```ts
interface RuntimeResourceOps {
  native(intent: FixedNativeIntent): Promise<OwnedNativeCommand>;
  prepareProbe(recipe: TrustedProbeRecipe): Promise<OwnedProbe>;
  createFixture(recipe: TrustedFixtureRecipe): Promise<OwnedFixture>;
  createBoundaryControl(): Promise<OwnedBoundaryControl>;
  createNetworkControls(kind: 'legacy' | 'profile'): Promise<OwnedNetworkControls>;
  createProfileNetworkFixture(): Promise<OwnedProfileNetworkFixture>;
}

interface OwnedProbe {
  create(): Promise<void>;
  inspect(query: FixedProbeInspection): Promise<ProbeInspection>;
  start(mode: 'detached' | 'attached'): Promise<OwnedProbeExecution>;
  stopAndRemove(): Promise<SandboxCleanupEvidence>;
}
```

`BuildSession.resources` is passed explicitly through trusted constructor options
to `OciSandboxBackend`, its cached `DockerSandboxManager`, every legacy/profile
helper and `assertQualification`/fingerprint helper. No module-global or mutable
ambient context. The same backend and qualification cache remain bound to that
one continuous session. Existing T002/T003 callers retain the old default fixture
provider; the executable installer requires managed resources and cannot silently
fall back to that default. The public `SandboxBackend` interface stays unchanged.

The production provider owns the actual creation primitives and all raw
settlement. It is not a before/after observer or a callback around a raw spawn.
`FixedNativeIntent` and probe recipes are closed tagged unions of the existing
trusted operations: host/kernel/runtime/image facts and checksums, storage/device
facts, owned synthetic-I/O cache drop, owned probe inspection/start/stop/removal,
and the fixed guest process-table observer. They cannot carry arbitrary executable,
argv, host path, Docker flags or format-template requests. Necessary paths refer
to approved runtime components or opaque owned-fixture/container handles. Keep
existing probe programs and profile argument generation as the source of truth;
do not introduce another package-execution profile.

Reuse/extend the existing private guardian process mechanism for fixed native and
probe controls: fork idle, observe errors immediately, durably record the real
boot/PID/start/group identity, then authorize the fixed operation. All native
children inherit that recorded group. A narrow fixed-operation control mode is
permitted; a generic IPC exec/argv relay is not. Ordinary execution mode retains
its current behavior. Probe mode additionally separates create-only, fixed
inspection and start because qualification needs stopped-container inspection.
If a bootstrap/fork or identity publication is uncertain, retain that resource
intent as unknown; do not infer that an unreported idle child never existed.
Create must really close successfully and persist an authenticated success proof,
then bind the full ID/image/labels before allowing start or ID-based cleanup.
Reuse the accepted receipt, cleanup-only writer and actual-group-exit rules; do
not retain the current legacy name-only cleanup as managed ownership proof.

Owned process/stream handles expose bounded stdout/stderr, input/EOF, completion
and cleanup evidence, not a raw `ChildProcess`. Bounded return and raw settlement
are different facts. If creation fails before a handle reaches its caller, the
provider still owns and retains that intent/resource. Cancellation seals new
actions; late raw settlement records facts only and cannot release a reservation
or authorize another command. The BuildAuthority lease remains held through
actual non-cancellable mutation settlement, using the existing recovery-lease
pattern. Cleanup is explicit and limited to the original resources.

The provider covers every direct creation site, including legacy canary/secret/
store files before local try/finally, exact I/O files and nocache helper, all
profile container branches, both direct attach branches, boundary directory and
secret-control process. Parent-owned sockets/FDs are also session resources:
close them while the original parent lives; fresh recovery uses actual original
parent exit as the OS cleanup proof and never deletes by port number. Reuse the
current network controller and authenticated network records through an async
production factory which persists actual idle-controller identity before start;
the synchronous test hook is not this factory. Persistent owner stores, keys,
SQLite files and raw journal mutations are control evidence, not probe scratch
to recursively remove when a probe ends. Future/malformed evidence is preserved.

The implementation inventory is the legacy fingerprint/container/attach/observer/
CPU/I/O/file/socket paths in runtime-oci/index, every independent profile probe
branch and boundary control in backend, current network-controller lifecycle,
and the shared currentHostFingerprint/collectRuntimeComponentDigests chain used
by qualify, create and execute. Replacing only the two runCommand helpers or
wrapping qualify misses direct creation paths and is insufficient.

### Concrete closed qualification recipes and handles

The initial two-family recipe stub does not express the actual qualifier's
operations. The following closes that integration gap without adding an argv,
source-code, host-path or Docker-flag relay. These are private trusted TypeScript
interfaces; names may vary, but the capability set and ownership rules may not.
The existing public SandboxBackend and unmanaged T002/T003 entry points retain
their behavior. The implementer may introduce this closed discriminated union
and the corresponding opaque fixture/control handles within T005.

```ts
type LegacyProbeSelection =
  | { kind: 'configuration' }
  | { kind: 'filesystem'; fixture: LegacyHostInputFixture }
  | { kind: 'scratch-write' | 'scratch-read' | 'pids' | 'scratch-limit' }
  | { kind: 'cpu' | 'memory' | 'output-limit' | 'descendants' }
  | { kind: 'network'; controls: OwnedLegacyNetworkControls }
  | { kind: 'io'; fixture: LegacyIoFixture };

type ProfileProbeSelection =
  | { kind: 'configuration' | 'controls' | 'cgroup-limits' | 'cpu' }
  | { kind: 'scratch-limit' | 'shared-memory-limit' | 'pids' | 'memory' }
  | { kind: 'host-boundary'; boundary: OwnedBoundaryControl }
  | { kind: 'network'; controls: OwnedProfileNetworkControls }
  | { kind: 'io'; fixture: LegacyIoFixture };

type TrustedProbeRecipe =
  | {
      kind: 'legacy-fixed-profile';
      imageId: string;
      selection: LegacyProbeSelection;
    }
  | {
      kind: 'profile-tuple';
      imageId: string;
      profileId: SandboxProfileId;
      selection: ProfileProbeSelection;
    };

type ProbeQuery =
  | { kind: 'configuration' }
  | { kind: 'container-state' }
  | { kind: 'live-cgroup' }
  | { kind: 'guest-descendants' };

interface OwnedProbeExecution {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  completion: Promise<ProbeCommandCompletion>;
  command(phase: 'start' | 'read' | 'release' | 'cancel'): Promise<void>;
  closeInput(): Promise<void>;
  stop(): Promise<ResourceCleanupEvidence>;
}

interface OwnedProbe {
  create(): Promise<void>;
  inspect(query: ProbeQuery): Promise<BoundedProbeInspection>;
  start(): Promise<OwnedProbeExecution>;
  stopAndRemove(): Promise<ResourceCleanupEvidence>;
}
```

Each selector maps to the existing code-owned probe program, explicit fixed
entrypoint, parameters, limits, start mode and legal input phases. Extract shared
pure probe-template/profile-argument builders into a private catalog module when
needed; reuse the accepted programs and assessment logic instead of duplicating
a backend. Resolve profileId through SANDBOX_PROFILE_CATALOG and bind its exact
digest. A package cannot provide profile values, script bytes, generic mode
strings, arguments, targets or executable paths. An immutable image ID comes
from the already validated trusted catalog/assembly chain, not package input.
The trusted probe files remain in the template's protected image namespace.

Configuration selectors create and inspect without starting. CPU and I/O use
the existing attached interactive programs. Legacy memory retains its attached
completion and original exit137 evidence; profile memory and profile cgroup
probes retain detached start with independent state/counter queries. The
family plus selector fixes the mode inside the provider; start() takes no
caller-selected attached/detached mode. command maps the allowed phase to fixed newline bytes and
enforces the real recipe state/one-shot ordering; noninteractive recipes reject
it. Start/read cannot authorize computation after closing; cancellation/release
of already registered work follows cleanup-only authority. No raw WritableStream
or arbitrary writeInput bytes are exposed by this private probe interface.

ProbeCommandCompletion preserves the original reason, exitCode, bounded stream
byte counts and actual control-command/group settlement. It does not claim that
a stopped container has been removed. The final stopAndRemove evidence covers
the exact container, attach/native/observer groups and their raw writes; stop
and concurrent cleanup share that same responsibility. Never replace an original
nonzero/deadline/unknown result with a later successful stop.

inspect returns bounded typed configuration/binding, state/OOM/exit or live
cgroup snapshots. Configuration includes the full ID/image/labels and the result
of the existing fixed-profile/mount verification. Cgroup snapshots bind the
actual container, PID/start identity and validated cgroup to fixed cpu/io/pids/
memory counters used by the existing assessment functions. guest-descendants
uses only the accepted fixed nonroot process-table observer in that same exact
container. The query never accepts a container ID/name, PID, cgroup path, Docker
format string or an arbitrary file path from its caller. Every spawned command
and already-started descriptor operation remains tracked through raw settlement.

Fixture/control objects are provider-created, opaque and privately registered
to the actual session by object identity. Reject structural forgeries, stale,
closing, disposed and cross-session handles before effects. The provider resolves
paths, mount destination, target addresses/ports and control PID internally;
readonly paths retained for compatibility are data, not authority accepted back
through a managed recipe. Hold dependency references until all containers and
commands that use a fixture/control are confirmed removed. Cleanup stops/drains
dependent probes before disposing files, sockets or controls. An out-of-order
disposal cannot unlink a mounted file or report confirmed cleanup.

Extend the closed legacy/profile network-control handles with only fixed
positive-control, receipt reset, bounded receipt snapshot, health/failure and
settling/dispose operations needed by the current verifiers. Legacy controls
own the existing four protocol listeners/connection facts; profile controls own
the fixed target catalog, parent sockets and one existing authenticated dummy
controller fixture via the async production factory. Their managed probe is
selected by the opaque controls handle; it never exposes the existing raw
runQualificationWorkload(profile, image, argv) as a ResourceOps capability.
The boundary handle similarly owns its private canaries and fixed secret-control
process, exposes fixed positive validation/disposal, and supplies negative-probe
inputs only through the host-boundary recipe. Persist actual controller/process
identity before authorization and retain parent exit as socket/FD recovery proof.

Inject the same optional resources parameter explicitly from qualify through
verifyProfileTuple, host-boundary/network/cgroup/CPU/I/O/memory helpers and every
runProfileWorkload/create/start/inspect/cleanup branch. DockerSandboxManager's
configuration, JSON, CPU, memory, network, I/O, output and descendant paths use
their closed recipes when resources is present. Fixed post-qualification native
fingerprints remain on the same resource owner. Existing unmanaged helpers stay
the compatibility path only when resources is absent; a managed unsupported
selector rejects, without executing that fallback. Assertions remain in the
existing qualification logic; lifecycle ownership belongs to ResourceOps.

Readiness remains fail-closed until all actual selected qualifier creation,
inspection, stream, control, fixture and recovery paths are migrated. Required
evidence includes unsupported/forged/cross-session recipes with zero effects,
exact create-success binding before start, phase/EOF/EPIPE and original-result
behavior, actual CPU/I/O/cgroup and network controls, crashes at the registered
create/attach/control boundaries, legacy compatibility and the original final
T005 host/Linux/cumulative/USE-003/review/primary acceptance.

The trusted copy-only assembler gains an internal `purpose: 'builder' | 'runtime'`
selection. Its resolved frozen catalog snapshot chooses `builderImage` or
`baseImage`, respectively; a package cannot supply another image. Before creating
the backend, assemble frozen source/dependencies into an immutable builder
candidate with the fixed directory template. Qualify that exact resulting image,
create a supervised current-boot identity and execute through the same T004
backend under the original build-restricted limits. Consume both bounded streams,
preserve original completion, use at most the required same-owner explicit stop,
and require final confirmed cleanup. Then assemble the validated generated output
into the runtime candidate. No assembly container is started; no source Dockerfile
or host/package RUN is introduced. All temporary assembly effects are session
resources. Retain sealed builder/runtime images and receipts under finite storage
admission until the later reference-aware collection protocol can account for them.

Preserve the current execution environment whitelist. Use only approved locale/
timezone/QDROID fields in the execution request. Fixed HOME/PATH needed by the
builder belong in its trusted immutable image/template configuration, not a new
manifest environment field or a broader backend whitelist. Use the fixed digest-
scoped guest source directory for cwd; never pass a host staging path as guest cwd.

This choice follows actual source mapping and independent read-only architecture
analysis; it is not implemented/qualified evidence. Code, compatibility, all
resource creation crash boundaries and final integration still require acceptance.

### Executable probe protocol and dependency lifetime

Executable selectors require a private fixed-probe protocol distinct from the
existing normal execution/native lifecycle. The trusted parent and guardian
select `qdroid.fixed-probe/v1` on every new probe request/reply and reject a
missing or unsupported version before effects. Existing T002/T003/T004 normal
guardian messages and public SandboxBackend semantics remain compatible. Private
message names are implementation details; the following state/authority rules
are required, without a generic command or source relay.

One probe has one create operation and at most one executable start. Its states
separate prepared, creating, created, running, command-completed, removing and
removed/unknown. Record actual successful create proof and exact ID/image/labels
before allowing executable start. A configuration selector has no start and
rejects it before creation. Fixed family/selector catalog data chooses the
program, entrypoint, arguments, limits, attached/detached mode and legal input
phases; callers do not choose these values.

Starting launches the existing fixed program and returns control to the guardian
message loop while execution remains in flight. Fixed phase input and cleanup
must remain processable; never await program completion inside a serialized
start handler that prevents its own release/cancel input. Attached output uses
the accepted bounded credit/EOF/error discipline. Detached start CLI exit0 is
only a start fact: completion observes the actual exact container's workload
exit/OOM or its original deadline/cancellation. A persistent cgroup-control probe
stays running until explicitly stopped. Keep original exit/reason/counts and
input/EPIPE failures; a later successful cleanup cannot rewrite them.

The guardian sends a nonterminal command-completion fact separately from final
resource cleanup. A normal command completion does not remove the container or
disconnect the guardian: state/OOM inspection may still be needed. A command
deadline stops the identified running work but does not turn that deadline into
success or infer final resource removal. Preserve the first command terminal
fact and use separate monotonic resource-cleanup facts; delayed create/start or
journal callbacks cannot regress either fact. Checks after prerequisite awaits
must observe explicit stop, owner closing and autonomous guardian completion.

ProbeCommandCompletion.cleanupConfirmed describes only the command settlement
that is actually proved, not container removal. If a live guardian group prevents
proving all command descendants gone, leave it false; do not fabricate group
absence. Existing qualification assessments consume original command result and
bounded evidence, then require the separate final stopAndRemove confirmation.
The latter seals new actions, stops/drains the exact container and its private
attach/native/observer/fixed-control command groups and raw writes, removes the
exact container, and waits its actual guardian/group settlement. It then releases
its dependency references. It does not close or wait for the referenced
fixture/control handle's own controller, listeners or unrelated dependent probes;
those resources belong to the referenced handle, not to this probe. In
particular, network controls remain healthy after probe cleanup for the existing
post-workload health/receipt assertions. OwnedProbeExecution.stop delegates
to that same cached probe cleanup responsibility. Concurrent provider/probe/fixture
cleanup shares it. The original command result remains immutable afterwards.

Parent disconnect invokes cleanup-only shutdown of this already owned probe;
it cannot start a selector or restore authority. Fresh recovery uses the required
authenticated intents/success receipts, actual original-writer/group exit and
exact resource binding. Unreported command outcome or daemon uncertainty stays
unknown. Recovery never reruns a program, phase input or qualification.

prepareProbe validates actual same-session fixture/control identities and
acquires their internal dependency references without an intervening await.
Register the prepared probe's cleanup responsibility before returning its handle.
A prepared-but-unused probe holds no external resource but must release its
references through confirmed no-create cleanup; stop seals it against later
create. Disposing a fixture/control synchronously prevents new dependencies,
requests stopAndRemove on its already registered dependent probes, and waits
their actual confirmed cleanup before unlinking mounted files or closing the
controls they use. Pending/unknown dependent cleanup retains the files/control
ownership and references, and cannot report confirmed disposal. Only after all
dependent probe cleanup is confirmed does the fixture/control dispose its own
controller/listeners/FDs and confirm that separate resource cleanup. Provider
close confirms both layers in dependency order rather than running file deletion
or control shutdown in parallel with unconfirmed dependent probes. There is no
wait from a probe's cleanup back to its referenced handle's disposal.

Required evidence includes private version/unknown-selector zero effects,
normal command-completed with container still present followed by exact removal,
attached phase/EOF/EPIPE and original failure preservation, detached actual-exit
versus start-CLI distinction, autonomous completion intersecting delayed create,
cross-session/forged/disposed dependencies, out-of-order dependency disposal and
concurrent stop/close, referenced-control health after probe cleanup, control
disposal waiting for dependents before its own shutdown, and cleanup-only
disconnect/crash recovery. Exercise the
existing fixed CPU/I/O and other verifiers without altering their assessments or
limits. Full readiness remains disabled until the entire inventory is migrated.

### Concrete closed assembly capability

The production copy-only adapter uses one additional private ResourceOps
capability. The outer TrustedImageAssembler port stays compatible; its managed
constructor receives the actual BuildSession owner and resources together.
Supplying only one rejects. A managed call never uses the generic Docker runner
or the unmanaged template helper. The default unmanaged adapter remains a trusted
fixture, without a managed-installation claim.

```ts
declare const preparedAssemblyInput: unique symbol;

interface PreparedAssemblyInput {
  readonly [preparedAssemblyInput]: true;
}

interface RuntimeResourceOps {
  assembleFixed(input: PreparedAssemblyInput): Promise<ImageAssemblyResult>;
}
```

PackageInstaller alone registers the actual frozen ImageAssemblyRequest object
after its existing complete source-tree/inventory, resolved-lock and optional
generated-output checks. Its private WeakMaps bind request and prepared-input
object identities to the actual active owner, candidate/package identity,
purpose, frozen catalog selection, semantic resolved-lock digest, template and
toolchain digests, source inventory and optional generated-output digest. Bind
the exact trusted-root material references and path identities as internal
metadata. A canonical material digest covers those immutable content/catalog
identities; host paths and a new verification session's candidate ID are not
semantic content identities.

Expose only lookup functions such as preparedAssemblyInputFor(owner, request)
and readPreparedAssemblyInput(owner, input) to trusted adapters. Neither function
registers or authorizes caller-provided paths or self-reported digests. Actual
registration stays private inside the validated installer path; there is no test
registration export. Reject structural copies, changed requests, wrong purpose,
stale/cross-session/closing owners and unregistered inputs before effects. Claim
the prepared input synchronously before the first await and share one operation
and terminal result for concurrent use of that same admitted input. No second
commit or retry after an unknown outcome is authorized by reusing the input.

The provider reuses complete sealed-material verification and checks it again
before copy under the trusted-writer exclusion. It resolves source/generated
paths and fixed guest destinations internally. Opaque provenance does not replace
actual tree, identity, mode, digest or retention checks. Keep those references
until every dependent command, template, container and raw mutation is settled.

Use a versioned `qdroid.assembly-resource/v1` record inside the required
authenticated session journal. Bind resource/session/owner/candidate IDs,
package/purpose, selected source image and catalog identity, material digest,
input/generated/lock/template/toolchain digests, exact private template reference,
generated container name and later full ID, owner/guardian boot/PID/start/group,
creation-success proof, current fixed phase, commit intent/result and cleanup
status. The authentication covers every field and domain-separates this record;
keys come from the configured trusted authority and never from package input or
cleanup scratch. An unsigned legacy record is not upgraded into deletion
authority. Full authenticated-session and cleanup-only recovery requirements
remain necessary; this record does not replace them.

Persist the assembly intent and material retention before any template creation
or guardian fork. Template files/directories use the accepted live-descriptor,
explicit-mode, fsync, exclusive-writer and failure-settlement rules. The guardian
has only code-owned create, template/source/generated copy, commit, fixed inspect
and exact removal phases. Persist actual guardian identity before authorization.
Create is stopped-only with pull=never; require actual successful create and its
durable authenticated success proof, then match full ID, approved image and
owner/session/resource/candidate/purpose labels before copy or commit. All later
container commands use that full ID. No start, RUN, Dockerfile, arbitrary flags,
change text, source path or destination is a caller capability.

Persist commit intent before sending commit. Durably record an observed immutable
image result before final verification or cleanup. Use managed receipt
`qdroid.fixed-copy-commit/v2`, binding the original candidate, package/purpose,
source/final image, platform, catalog/material/input/generated/resolved-lock/
template/toolchain identities. Existing v1 fixture receipts do not become managed
receipts automatically. Verification of an existing v2 receipt uses the same
ResourceOps owner's closed image-configuration inspection and actual retained
material; it never assembles, starts or removes anything. The original receipt
candidate need not equal the new verification session's candidate.

Existing-image verification has its own installer-private registration. After
complete retained source/inventory, resolved-lock, generated-output and outer
receipt checks, PackageInstaller registers the actual frozen SealedImageVerification
object in a private WeakMap, binding the current real owner, the independently
expected original candidate, expected catalog/material/input/generated/lock/
template/toolchain identities, image/purpose and retained material references.
The managed adapter uses lookup-only access to this registered verification
binding. Never use fields read from the inner receipt as their own expected
material proof, and never export a registration function for caller data.

For the existing registry layout, derive original candidate identity from its
trusted canonical retained seal references under seals/<candidate>/, validate
the candidate spelling and exact purpose-specific paths, and compare the outer
resolved-lock/receipt candidate fields to that expected identity. Builder/runtime
references for the same publication must agree. Reject mismatched or noncanonical
references without rewriting them. This uses existing immutable registry fields
and introduces no second database or registry-format change. Compare v2 receipt
and actual fixed image inspection against the privately registered expected
material proof; verification retains its references through actual read/command
settlement and has no assembly/deletion capability.

Reuse the existing guardian's fixed 10-second per-Docker-command deadline and
65,536-byte command-output bound. Initial trusted assembly orchestration has a
120-second total admission deadline; cleanup gets a separate finite 10-second
attempt. These are trusted implementation constants for this reference path,
not package parameters or altered sandbox profile limits. A deadline bounds the
returned outcome, not raw settlement: retain operations, journals, leases and
references until the original writers/groups/FDs and mutations actually settle.

An uncertain commit is a distinct unknown outcome. Stopping its CLI or observing
the temporary container absent does not prove the daemon produced no image.
Never repeat commit, publish in a late callback or retire that unknown intent
without adequate original evidence. A late result records facts only. Confirmed
temporary cleanup and original result are separate obligations; preserve all
independent operation/cleanup/persistence errors. Retain every sealed image and
candidate receipt; neither failure nor recovery may image-remove shared content.

Required affected evidence includes zero-effect forged/cross-session/closing
inputs, altered material rejection, actual create-before-ID persistence,
in-flight copy/commit death and late results, foreign-name preservation, unknown
blocking the next installer, combined failures, shared-image retention and
existing-image verification with zero new assembly containers. Full production
assembly stays disabled until its complete owned path and recovery are ready.

### Bounded package graph and retained node materials

This section selects the remaining resolver integration for the original T005
scope. It extends the single-package material binding above; the same real root
owner, factory, provider, build lease and cleanup rules remain authoritative.
The original graph contract has completed independent pre-implementation review.
The accepted executable-graph unit alignment below selects the additive material
port and exclusive installer unit; actual production copy/recovery and final
integration remain with the original producer. The already selected probe and
single-package assembly implementation can continue.

Use a new explicit `qdroid.plugin/v0.2` manifest and matching
`qdroid.lock/v0.2` source lock for graph packages. Preserve v0.1 single-package
validation and identities; v0.1 still rejects a dependencies field. V0.2 declares
an optional dependencies array of exact `{name, version, sourceId}` records.
Names and canonical versions use the existing validators; no version ranges,
aliases, URLs, paths, headers, credentials or command fields occur here. The v0.2
source lock contains inputContentDigest and the same exact direct dependency
records, canonically ordered by name/version; mismatches and duplicate logical
keys reject. Empty dependencies are valid. The source ID is a request to the
administrator's existing approved source catalog, whose frozen expected
transport digest and maximum bytes are the actual fetch authority. Do not put
transport/package/future-output hashes of a recursively dependent artifact into
its own source lock. Actual digest pins are recorded in the external trusted
resolved graph; this also permits real cycle detection without circular hashes.

Resolve the whole graph before staging, assembly, qualification or package code.
The logical key is `(manifest.name, canonical manifest.version)`. Verify each
edge's expected name/version against the fetched node. A repeated key must have
the same sourceId, approved transport digest and verified package digest; reject
conflicting source bindings rather than selecting a winner. Reject duplicate
direct edges. Detect cycles with an active traversal stack, including a return
to the root. Shared diamond nodes are fetched/decoded once and keep one frozen
object. Count the root in the32 unique packages; root depth0, at most8 edges on
any root-to-node path. Sum actual unique transport bytes up to64MiB and actual
expanded USTAR bytes, including headers/padding, up to128MiB. The existing
per-source16MiB transport/32MiB expanded/path/file/ratio limits still apply.
Add expandedBytes to the internal FrozenArchive result from its existing bounded
decoder; do not infer it from file payload lengths.

Fetch one source at a time per graph. Use trusted constants5 seconds per source
and30 seconds total graph resolution, no automatic retries. Extend the trusted
byte-source port with an optional bounded-read request carrying AbortSignal and
maximumBytes; existing trusted memory fixtures can implement it without I/O.
Production byte providers must bound buffering and cancel their underlying read.
Timeout seals the resolver, aborts the original read and forbids late staging or
publication. Keep the raw read observed and its references/budget reserved until
actual settlement; a bounded return alone is not settlement. This port does not
add an HTTP implementation or package-selected network authority. Required
negative fixtures cover a held read, late bytes, cancellation and no late effects.

Dependencies are private materials of the root installation, not independently
installed/activated records. No dependency capabilities become grants. A
content-only root permits only content-only graph members and no build anywhere;
reject an incompatible node before staging. For an executable root, a member
can be content-only or select exactly one variant for the same target. All
executable members must resolve to the root's exact approved catalog identity,
platform and ABI; reject unsupported cross-catalog composition before effects.
This prevents implicitly merging unrelated base images or assuming binary ABI
compatibility. A declared dependency entrypoint is data; only root runtime
selection starts a workload. No dependency service is auto-started.

Execute declared node builds in deterministic dependency-first order, one at a
time inside the same root BuildSession. Do not recursively call public install
or acquire another BuildAuthority lease, clone owners, change the owner's root
packageDigest or initialize another factory/provider. Register actual validated
graph membership privately in PackageInstaller. A prepared assembly/build input
may name a member only through that actual owner/member registration. A member
with no build contributes frozen sources; a member with build must finish its
declared operation and output validation. Never silently skip its build.

For each node build, assemble a separate immutable builder from its approved
builder base, that node's sources and its already validated transitive dependency
sources/outputs. Qualify the exact builder image and run the existing offline
executor with the node's declared argv and fixed digest-scoped cwd, unchanged
build-restricted limits. Confirm all qualification/execution cleanup before the
next node. Preserve original failures and unknown reservations; no later node or
root runtime assembly proceeds after failure/uncertainty. There is no independent
dependency runtime image: the final root runtime assembly copies the root and
all validated graph materials into their respective fixed
`/opt/qdroid/packages/<packageDigest>/{source,generated}` directories. The fixed
read-only resolved graph maps logical keys to those paths; no host path is
exposed. A node cannot overwrite another node or a trusted runtime directory.

Keep each packageDigest as its own complete input inventory identity. The
semantic resolved graph binds every node's sourceId/approved transport digest,
input/package digests, exact direct edges, selected catalog/platform/ABI, build
declaration and toolchain/template/profile identity, in bytewise canonical order.
Its digest is outside package bytes. Graph build-input identity covers this
complete planned source/build graph, not future outputs. Per-step prepared
material/receipt identities additionally bind the already produced child-output
digests. Graph build-output identity covers the canonical generated inventories
of all built nodes under digest-specific namespaces. A root without its own build
can therefore have dependency output; validate per-node declarations rather than
using the old root-build-absent shortcut. Preserve v0.1 identity formulas for the
empty single-package path instead of silently relabeling historical materials.

Durably seal a versioned `qdroid.graph-material/v1` manifest at
`seals/<rootCandidate>/graph-material.json`. It contains the independently
verified semantic graph, complete immutable node inventory/material references,
generated identities and each node builder's actual image/receipt. It excludes
the final root runtime image/receipt, so the final runtime receipt can bind this
manifest digest without a cycle. Node builder seals use
`seals/<rootCandidate>/nodes/<packageDigest>/...`; retain the existing canonical
root seal paths for root receipts. Bind original root candidate and exact node
identity/purpose in each node receipt; do not overwrite a fixed builder filename
when another node builds. All referenced files/images use the existing retention,
nofollow/live-descriptor/exclusive-writer/actual-settlement rules.

The managed prepared-input/verification registries bind the complete permitted
node set, actual node/closure material and graph digest, not caller-supplied lists.
One claim remains per actual prepared input, allowing distinct node builds while
forbidding replay of the same input after unknown. The fixed assembly catalog
may copy only those registered node sources/outputs to their fixed paths. Its
authenticated resource record and v2 receipt bind the graph/step material digest.
Existing-image verification independently reconstructs the expected retained
graph from the registry and sealed manifest before comparing any receipt.
Unknown cleanup retains the entire referenced closure. No graph recovery starts
a node build, qualification, assembly commit or another source fetch.

This graph case requires a minimal registry extension: namespaced
`qdroid.package-registry/v3` adds nullable graphMaterialPath/graphMaterialDigest
to the immutable disabled record. V0.1 single-package records retain null values.
A short transactional v2-to-v3 column/schema migration preserves every existing
row and PolicyAuthority user_version/history; it creates no graph proof for old
rows and never repairs missing materials. This explicitly extends the earlier
single-package no-registry-format-change choice only where graph retention needs
an independent reference. No second material database, active pointer or grant.

For committed graph reuse, first resolve/validate the same approved source graph,
then compare its semantic input/catalog identity to the retained graph. Verify
all original source/generated inventories, actual builder/final images and
receipts through a fresh read-only managed session. Recompute output/material
identities from retained bytes; do not rebuild missing/corrupt outputs or compare
receipt fields only to themselves. Return the original disabled record. New
concurrent candidates with different validated node/root outputs conflict;
identical outputs cannot replace the earlier selected images/record. Publication
retains the entire closure atomically, with no partial child registrations.

Required evidence adds valid shared-diamond resolution, actual two-node offline
build ordering and root material use, canonical identities/no hash cycle,
cycle/conflicting binding/each graph budget/deadline/cross-catalog rejection,
zero grant/instance/child publication, generated dependency retention and
read-only reuse, per-node failure/unknown blocking successors, v0.1 compatibility
and namespaced migration preserving Policy data. Original full T005 malicious,
crash, concurrent/shared-image, final Linux/cumulative/USE-003/review/primary
acceptance still applies. This is a private local/simulator/Mock implementation
selection, not package-market access, real accounts/models or a release.

## Content publication serialization after the bounded diagnosis

This evidence-backed selection supersedes event-loop-turn retries for immutable
source-content adoption. It is not a new delivery segment or diagnosis allowance.
V62 kept the v61 production index unchanged: one installer rejected at103ms while
the original publisher completed at271ms and left complete frozen sidecars and
one disabled root row. A fixed number of metadata reads cannot synchronize that
publisher, and Promise.all early failure must not delete its active root.

Reuse the existing held SQLite-exclusion approach through a narrow trusted
content-publication lease, separate from BuildAuthority and the package registry.
Use one canonical authority below the configured installer root, not a package
supplied path or per-instance in-memory mutex. All source-content publishers and
adopters, including v0.1 and v0.2 nodes, participate in this same authority.
Content-only publication does not mint a BuildSession owner or create a runtime.
The publication lease confers no native execution, deletion, grant or recovery
right. Reuse the existing node:sqlite dependency rather than introduce a service.

Acquire physical BEGIN IMMEDIATE exclusion before deciding whether canonical
content already exists, renaming a staged tree, or adopting existing content.
Use a dedicated lock connection with busy_timeout0. On recognized SQLite busy
only, yield asynchronously and retry acquisition within one fixed trusted10s
admission deadline. Never synchronously block the event loop waiting for a lease
held by another async publisher in that process. Timeout rejects the waiter;
it does not cancel the actual holder or establish its cleanup. Other errors are
not busy and propagate. Initialization obeys the same finite admission and
future/incomplete namespace rejection rules; no unconditional DDL on foreign
formats. The lock database's format/physical lifetime is not evidence that an
immutable content tree is complete or safe to remove.

A root installation holds at most one content-publication lease while sealing
its source closure. Recheck canonical existence only after acquisition. A prior
fully sealed tree is independently validated and synchronized using the existing
no-follow descriptor and full-inventory rules. A new publisher completes its
private validated preparation, directory move, final mode/synchronization, full
input/materialized inventories and final readiness before relinquishing the
lease. The complete content/metadata validators remain the readiness condition;
a filename, mode, lock release or metadata existence alone is insufficient.
Preserve the existing canonical material paths, v0.1 identities and immutable
registry/winner references. This does not change the archive/package digest.

Remove the32-setImmediate metadata-adoption retry protocol. Once the exclusive
lease is held, incomplete/corrupt preexisting material is a real unresolved
material condition, not an invitation to wait, repair or overwrite it. Preserve
it and reject. Do not convert a rename/chmod/fsync failure into success merely
because the destination exists. Unexpected destination interference while this
cooperative writer lease is held remains an error, with original evidence
retained. Do not overwrite committed content, invent a repair record or delete
another candidate's material. The original immutable-file and directory durability
rules continue to apply.

Hold the lease through all admitted raw publication/verification operations,
including errors and their actual filesystem settlement. Release/close once and
preserve independent primary, rollback and close failures. A bounded returned
error is not permission to release while a raw operation still continues.
Release source-publication exclusion before acquiring BuildAuthority or starting
assembly/qualification/build; never wait for the build authority while holding
this content lease. The short registry transaction remains outside filesystem
awaits. Generated-output/native ownership keeps its existing separate contract;
this correction does not introduce an execution-lock bypass.

A crashed writer's SQLite release does not assert that its content is complete.
Fresh code still verifies every retained prerequisite and refuses incomplete or
corrupt content. No automatic build, metadata repair or deletion follows merely
from a dead publisher. Full T005 authenticated ownership, cleanup-only recovery,
unknown references and the original crash matrix remain required; this narrow
exclusion is not a replacement recovery mechanism.

Retain v62's finite observation of both installer settlements and its failure
root retention as a permanent fixture correction. Add actual same-process and
independent-process concurrent candidates: both return the same original disabled
root, one row, no child installation/grant and fetch/material identity preserved.
A controlled publisher paused between canonical directory move and sidecar
completion keeps the second publisher outside adoption until physical release;
a waiter deadline cannot stop the holder. A publication/fsync failure preserves
its original error, leaves no new disabled record and cannot be accepted through
the old destination-exists catch. A dead/failed publisher's incomplete tree is
retained and rejected without repair; unchanged committed reuse stays read-only.
Use finite barriers and actual raw-settlement observations, not enlarged polling
counts, arbitrary sleeps or Promise.all early-cleanup assumptions. Preserve the
v58–v62 failures and the now-used one-diagnosis allowance through all corrections.
If this same objective triggers nonconvergence again without new acceptance or
causal evidence, stop and report without another diagnosis.

This selection requires an independent pre-implementation check and the root's
complete supersedes brief before the stopped production segment resumes. All
unaffected T005 work remains authorized within its already accepted contracts.

## Accepted fresh recovery API alignment

The original effective Plan requires this alignment before implementation.
Primary accepts the independent read-only protocol review with no P1/P2. This is
not a new Task, authorization, experiment or diagnosis. Main worker confirmed
existing BuildAuthority only refuses any session and lacks owner identity or a
safe fresh runtime entry. Its keeper cleanup-only proposal is sound in direction;
this file specifies the missing authority/persistence composition. Public
SandboxBackend and InstallRequest remain unchanged. No real accounts/robot.

### Closed trusted composition

BuildAuthority remains the sole cross-process authority. Within its SAME existing
BEGIN IMMEDIATE, read/validate original pending sessions and cleanup evidence
before creating a new owner/runtime. Optional narrow trusted runtime-factory ports
may capture the current owner identity and observe recovery for an opaque old
session; neither is exposed in CLI flags/package data/workload RPC.

The exact names may vary:

- captureOwnerIdentity(): Linux boot ID + current installer PID + real /proc
  start identity (group only if actually owned, not a shared shell group).
- recoverSession(opaqueRecovery): bounded confirmed/pending/unknown evidence.
  Opaque recovery is privately registered by BuildAuthority only while this
  exact physical transaction is held, carries no new-work authority, and can
  only be read by the trusted adapter. Structural/stale/cross-root/session
  objects reject before effects. NEVER register it as an active BuildSessionOwner.

Production OciSessionBoundRuntimeFactory implements both. Synthetic host/Mock
factories without the identity/recovery port may remain compatible, but their
records are explicitly unverified and cannot be freshly reclaimed as production
proof. Default production provider must reject such unverified owners; no host
fallback or readiness relaxation. Linux identity capture uses fixed fact reads,
not a new unowned process. Thus existing host Mock tests need no fake production
security claim, and actual Linux installer intent always has full identity before
its first runtime/provider side effect.

### Session format and durable handshake

New authenticated versioned session intent (v2, explicit domain separate from
resource/create/commit/terminal receipts) binds authority key identity, candidate,
package digest, original owner ID, actual Linux boot/PID/start (or explicit
synthetic-unverified state), and only host-derived relative runtime-store identity.
Strict field/size/version/path validation; a package cannot select a cleanup path.
Read/resync the existing private authority key before validating old records;
if pending records exist but key is absent/corrupt, preserve them and refuse.
Do not create a replacement key to make old records unverifiable. Old unsigned
v1, malformed/future/foreign-key/changed identity records remain unknown and
untouched. Bounded inventory; unexpected names or overflow block, no prefix-based
runtime/Docker sweep. Existing evidence/control DBs/keys stay retained.

Durably distinguish pre-provider intent from provider-journal-ready. Provider
writes/authenticates its initial inventory, then obtains a durable acknowledged
session binding to the expected journal/namespace before any resource action.
Every later resource intent is journaled/authenticated before its side effect.
Fresh recovery may recognize the provably pre-effect case only from this actual
handshake/state ordering and dead original owner; merely missing/empty execution
journals cannot prove no qualifier/native/fixture resources existed. Missing
expected ready journal, inconsistent nonempty journal before acknowledgement,
failed/late persistence or unexplained evidence => unknown, no new owner.

### Recovery responsibility and supported outcomes

First implementation can be observation-only: original keeper/guardian handles
parent disconnect, synchronously seals new work, settles its original commands,
cleans exact owned resources using original FDs and publishes an independently
authenticated complete terminal. Fresh side never reconstructs filesystem deletion
authority from HMAC/dev/ino/hash, reopens a scratch path for deletion, executes
qualification/build/assembly/commit or replays a recipe. It validates original
session/journal/resource/dependency/receipt identities, actual old parent death,
original guardian/keeper and owned writer group settlement, exact container
removal evidence, full terminal and cleanup outcome. Shared/uncommitted images
and all control evidence remain. Never kill an unrelated/shared installer group.

Live original parent/controller/keeper/writer, absent/bad terminal, unknown daemon
or raw result, replaced material or changed identity keeps old session pending/
unknown and blocks new execution. Do not force success for missing evidence. A
bounded deadline is for observation return, not a cleanup fact. Keep exclusion/
reference responsibility durable after returning. Ordinary parent-death positive
cases must actually settle via original keepers and be reclaimed; if a required
positive crash case cannot be supported without a narrowly scoped new cleanup
writer, return exact causal facts to root before extending the interface. The
original Plan already permits authenticated exact cleanup-only writers, but
this implementation does not authorize any generic relay or blind new cleanup action.

### Retirement order and errors

Under the same physical SQLite transaction, after complete original cleanup proof,
write/fsync a bounded authenticated retirement receipt that binds the old intent,
original result and all required cleanup references, then retire that exact live
session intent and fsync its parent directory. Preserve receipt/resource journals.
Only then may a new session intent be created. A crash between retirement steps
is idempotently verified from the original receipt and same old identity; it
never authorizes retry of the old build. Normal current-owner retirement uses
the same durable order after sealing/draining raw operations, but does not wait
for its own still-live installer PID to die. Physical lease release follows
logical retirement; failures preserve original + independent persistence/close/
cleanup errors and block new execution. No mtime/TTL recovery, live peer removal,
record repair, cleanup-by-path or image GC.

### Required verification (original full acceptance remains)

Meaningful source and actual Linux checks for dead-holder before first effect,
parent loss with actual qualifier container/I/O/control and fingerprint/native,
actual build cancellation/crash, cleanup finished before lease release, live peer,
unsigned/future/foreign/changed boot/start, missing journal/terminal and bounded
unknown blocking, wrong opaque recovery handle zero effects, and interrupted
retirement. Trace zero new qualification/build/commit during recovery and actual
serial peak one across images/installers. Preserve every original failed run,
unknown root and used diagnosis allowance. No full-T005 completion until final
managed install/graph/shared-image/cumulative/USE-003/Linux/review acceptance.

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

## Accepted managed execution handoff alignment

Primary source inspection identified a guardian fork before the T004 journal,
so a post-journal callback alone cannot cover the full BuildSession. Independent
protocol review localized the public-recovery bypass and legitimate no-create
branch; this accepted interface incorporates both corrections. Existing execution
implementation and required runtime verification remain the producer responsibility.

### Registered T004 sub-owner

Keep accepted public SandboxBackend and unmanaged T002/T003/T004 behavior. Reuse
the existing T004 journal/create receipt/guardian/recovery-lock/raw-mutation
implementation, program/limit/argument validation and first-result semantics.
ResourceOps owns a durable handoff to that exact existing execution sub-owner;
it is not a passive test hook. Registration/authorization failure blocks the
first fork or subsequent start, provider close must settle the sub-owner, and
BuildAuthority stays held until the complete handoff has cleanup proof.
No generic IPC/argv/path/Docker relay or another build backend is introduced.

Before any actual managed normal-execution guardian fork, allocate its trusted
session UUID and expected exact T004 journal/receipt identity. Oci factory's
ownerStore is fixed trusted configuration, same reference-node root; package
input cannot select it. Private descriptor registration binds the actual
ResourceOps object/session, current qualified image/profile digest and this exact
store owner/key identity/session UUID. Store paths never round-trip as caller
authority. Structural/stale/cross-owner descriptors reject before effects.
An opaque live descriptor carries only cleanup/recovery responsibility, not a
public execution method or a raw ChildProcess.

### Before-effect and pre-authorization operations

Names may vary, but these operations and order are mandatory:

1. Executor admits one build-execution responsibility under its active real
   BuildSession, before invoking backend execution and its fingerprint preflight.
   Already-managed fixed native commands remain on the same provider. This
   operation does not authorize a guardian fork or a workload.
2. In backend.execute, AFTER normal qualification/request checks and session UUID
   allocation but BEFORE `new SandboxGuardianClient`, register/fsync the exact
   session/store/image/profile handoff under that responsibility. Journal the
   bootstrap-possibly-authorized transition before fork. Before authorization
   can be proved not issued, a pre-effect record can retire with dead owner;
   after possible fork an absent journal is uncertainty, not no-create proof.
3. Existing backend creates/owns its original guardian, observes errors immediately
   and writes its authenticated T004 intent with real guardian boot/PID/start/
   group. BEFORE possibly-submitted/create/start authorization, an awaited
   production handoff acknowledgement verifies that original durable T004 record,
   persists its exact identity/reference in ResourceOps and checks current active
   owner. Failure/cancellation/closing prevents start and invokes only original
   cleanup. Recheck fencing after awaits, including T004 authorization mutation.

A parent loss between fork and T004 journal may remain unknown. After the exact
T004 journal exists, fresh recovery can resolve the registration window only from
that original authenticated record at the already registered UUID/store; it does
not need to pretend the parent received its callback. Never infer a never-reported
idle child did not exist. The exact before-fork binding is essential.

### Managed-record compatibility and recovery fencing

Managed executions use a new private authenticated T004 journal version with a
mandatory complete handoff/BuildSession/authority/store binding. The accepted
legacy and current unmanaged versions retain their existing semantics. An old
parser must reject the new version; it must not ignore a new optional marker and
interpret a managed execution as unmanaged. Missing, malformed, forged, future
or mismatched binding fails closed. Package/workload input cannot choose either
version or the authority binding.

Every recovery and retirement path, including normal completion, public
recoverAbandoned, retained late retirement, no-create and exact cleanup writer,
checks the managed constraint before acting. Public recovery without the matching
active/recovery-only BuildAuthority capability reports the managed record as
pending/unknown; it may not launch a cleanup writer, unlink evidence or acquire
BuildAuthority in reverse order. This also applies when public recovery runs
before targeted recovery in another process. Only the originally bound live
handoff or the validated targeted recovery capability may authorize the managed
cleanup and durable ResourceOps acknowledgement. Unmanaged public recovery stays
compatible; a managed record is not downgraded or silently skipped as clean.

### Completion proof before evidence retirement

A managed cleanup acknowledgement is required BEFORE existing T004 retirement
unlinks its exact execution journal. Only the accepted original execution/recovery
code can create the opaque cleanup proof after actual original writer/group and
raw journal mutation settlement. The proof is explicitly discriminated:

- `no-create`: bind the original authenticated journal, exact guardian identity,
  session/store/image/profile/handoff, and durable `not-authorized` state. Prove
  actual guardian/group/writer settlement. No container ID, removal or create-
  success receipt exists or is required; never fabricate one.
- `created-cleaned`: bind the original exact authenticated create-success receipt,
  actual container identity/removal and guardian/writer/group settlement, with
  original session/store/image/profile/handoff and journal identity.
  `possibly-submitted` without its authentic create-success receipt stays unknown;
  absence at a daemon observation cannot become no-create proof. Both supported
  branches bind original command outcome (unknown if not observed) separately from
  confirmed cleanup. A failed/cancelled acknowledgement may retire only through
  its actual no-create proof and must preserve the original failure.
  ResourceOps validates and durably writes its domain-separated terminal receipt
  and handoff status before acknowledging journal retirement. It retains the
  handoff/journal/receipt history under the session control store; normal close
  must not simply remove the handoff or discard its evidence.

Failure to persist that proof retains original T004 evidence and BuildSession
reservation and aggregates independent original/cleanup/persistence errors. A
later cleanup success cannot rewrite an original deadline/nonzero/unknown result.
Late retirement remains owned until real writes settle; an already absent active
file is reconciled only through its authenticated original retirement receipt.
No new action can be authorized by a late callback.

### Targeted fresh cleanup-only port

A live process's WeakMap object cannot survive a crash. Fresh BuildAuthority,
while holding the SAME existing BEGIN IMMEDIATE and authenticated recovery-only
capability, may mint a NEW recovery-only T004 capability from the validated
original handoff and fixed configured owner store. This does not reconstruct an
active owner, backend qualification or execution handle. It exposes only bounded
observation/authorized exact cleanup of the registered old session and cannot
qualify/create/execute/replay any recipe or build.

The private targeted port uses exact registered UUID/owner/key/store binding,
strict original T004 journal/create/retirement authentication and existing original
writer/group rules. No owner-store scan, caller journal path, name-prefix target,
mtime or empty-store inference. Keep recoverAbandoned's accepted public semantics
unchanged. A private helper/context may reuse its exact single-record logic;
don't instantiate a new executable backend to bypass unknown state.

Lock order: existing BuildAuthority lease -> existing targeted T004 recovery
lock/raw-mutation lease. T004 cleanup must not acquire BuildAuthority in reverse.
Finite contention returns pending/unknown, preserving both lease responsibilities.
Live unrelated peers, missing/future/foreign/changed ownership, uncertain daemon
or raw writes, and bootstrap uncertainty block retirement/new execution. Never
signal a reused/foreign numeric group or delete image/control evidence. Fresh
side must never regenerate a missing proof or replay execution.

Normal provider close drains the registered existing execution before session
terminal/retirement. Fresh owner can retire the BuildSession only after this exact
sub-owner's complete cleanup/retirement evidence plus every qualifier/assembly/
fixture/native/control resource is confirmed. A known cleaned build with unknown
business outcome remains unknown; a new explicit install request is separate
and follows original immutable-input/registry rules, never resumes the old build.

Required actual evidence includes before-fork death; fork-before-journal unknown;
journal-before-ack resolution; failed acknowledgement with zero start and valid
no-create retirement; public recovery before targeted recovery with zero
unauthorized cleanup; managed/unmanaged/future version rejection; actual build
and post-cleanup crashes; fingerprint preflight death; live/forged/foreign/store
mismatch; late mutation/unlink; zero qualification/workload/commit replay; first
outcome plus independent cleanup failures. All original final Linux, graph,
concurrency, storage, shared-image, cumulative, USE-003 and independent review
conditions remain. Backend implementation write ownership transfers only after
the current managed-profile routing consumer is accepted by primary.

## Evidence-backed fixed-probe startup correction

The human-authorized additional diagnostic used one exact owned container with
unchanged v85 image/runtime/isolation/limits. Its pre-start inspected State was
created, Running=false, Pid=0; direct attached start then observed the same full
ID running with Pid=4125765 at 51, 501 and 1504 ms before explicit two-second
cancellation. The diagnostic does not prove which State v85 first saw. It does
prove the fixed guest can stay live under the original tuple, localizing the
remaining boundary to guardian startup/attachment/observation. The v85 global
startup wait treats Running=false as exit, including the valid created state;
the prior v78 fixed-probe/v1 acknowledged an owned attached-command launch
before any live-PID assertion. Do not conflate those two protocol facts.

Keep fixed-probe/v1 start acknowledgement compatible with the original owned
attached-command lifecycle. It acknowledges accepted start responsibility, not
a claim that Docker already exposes a running guest. Preserve immediate error
observation, original command result, output credit, finite deadlines, stop and
exact cleanup; no short-lived fixed program should become an invalid before-
start terminal merely because the caller did not need a live cgroup snapshot.

Require bounded exact-owned Running=true plus a positive host PID at the
`live-cgroup` inspection boundary, before reading the actual cgroup. Reuse
existing closed query/intent/profile/container/image/label/guardian authority;
every observation remains bound to the same full container and current active
lifecycle. A valid created/starting observation is pending, not an exit or
success; only supported actual running state yields a snapshot. Explicit
exited/dead, invalid/missing/foreign identity, stop/cancel, command terminal or
observation deadline rejects the live snapshot without inventing cleanup. Do
not accept a late observation after cancellation or extend raw command/cleanup
budgets. Keep original writer/process obligations on uncertain return.

The same implementer corrects only this localized guardian/inspection boundary
and necessary fixture regressions: delayed created-to-running, terminal-before-
liveness, actual short fixed-command lifecycle, unknown/mismatched identity and
stop/deadline during observation. Verify the actual dedicated Linux cgroup case
and affected original guardian/qualification contracts on one frozen changed
input, retaining all command/raw/source evidence. No sandbox/profile/limit or
qualification assertion is relaxed. Full remaining producer, installation,
recovery, graph and final acceptance still apply. The additional diagnostic is
now used; subsequent nonconvergence does not obtain another diagnostic allowance
through this correction or supersedes.

## Accepted fixed boundary-control keeper alignment

The original producer's source mapping confirms that managed boundary/network
controls still reject and the unmanaged factories cannot be called through a
public or circular ResourceOps factory. The next complete boundary capability
uses the [fixed boundary-control contract](t005-boundary-control.md), SHA256
fbe754110bd3086e1630f7549d3883791965f2fafab1d091f28cad44731aed7d.
It is normative for this implementation step. Independent protocol review found
one health-propagation omission, corrected explicitly in the selected contract;
it otherwise agrees with the original closed recipe/dependency/FD boundaries.

One original keeper owns its canaries, fixed secret child and retained
descriptors. Its private versioned protocol creates no public process/path/
argv/target relay. A dependent probe is configured and durably not-authorized,
then registered/acknowledged by the control keeper, before its one-shot create
authorization. Original no-create versus created-cleaned proofs, actual raw
guardian/group settlement and exact dependency identity precede cleanup. Parent
loss never permits replay or reconstructed file-deletion authority. The keeper
owns only its subtree; complete provider-root/T004 recovery remains separately
required before session retirement or new admission.

After probes and admitted reads settle, disposal rechecks fixed positive
controls before intentional shutdown. Any latched health failure must reject
the existing dispose call with its original cause, even if physical cleanup is
confirmed internally. Normal identity-verified self-disposal does not manufacture
a failure. This closes the consumer's positive-before-probe/dispose-after-probe
window without changing its frozen interface. New boundary probes resolve only
the existing immutable build-restricted/render-offline/tool-offline catalog
IDs and original limits/digests. Network controls and full qualification
readiness remain unsupported until their inventories are actually complete.

Implement and test this full bounded capability with the same original producer;
all already assigned terminal corrections, execution handoff, graph, storage,
legacy compatibility and unified final acceptance remain. This Plan selection
is protocol approval only, not runtime qualification, a new Task/segment,
diagnostic allowance or additional external-operation authority.

## Accepted fixed network-control keeper alignment

Use the [fixed network-control contract](t005-network-controls.md), SHA256
96d90ae1b757a3739df240bdd4f5fe209d8a8bdbcad0f43abe1e099b54cd2000,
as the normative next original producer capability. Independent protocol review
closed its receipt-reset and post-disposal-health findings. This settles the
previously unsupported legacy/profile network composition; it does not enable
readiness or claim runtime acceptance before actual implementation/verification.
The accepted boundary contract remains unchanged and is implemented first/as
needed for the shared dependency-proof primitives.

One original keeper owns the fixed listeners and, for profile controls, the
original fixed interface writer. Reuse private pure target/interface recipes
without importing runtime backend into supervisor or adding a public factory.
Unlike the unmanaged controller's immediate disconnect cleanup, managed cleanup
waits original dependent probe proofs and actual raw writer settlement. Preserve
unmanaged protocol/behavior and original legacy four-attempt assessments.

Separate the unused private legacy four-traffic receipt DTO from the accepted
profile five-traffic DTO including IPv6 UDP; leave the profile consumer and
public SandboxBackend unchanged. One handle has exactly one measurement epoch:
positive clients settle before the sole reset, every later reset/positive send
rejects, negative receipts remain monotonic, and snapshots always use that same
epoch. The first settled snapshot seals new probe dependencies. Thus cleanup
cannot expose a reset-before-snapshot evidence loss window. The exact original
disposed handle's assertHealthy remains a read-only cached terminal-health
check; every new resource/positive/reset/probe operation still rejects.

Migrate legacy network control creation before any raw target constructor;
managed unsupported paths never use the unmanaged fallback. Keep readiness
fail-closed until all original qualification/recovery inventories, execution
handoff and other original requirements are complete. Actual Linux positive/
negative/epoch/dependency/parent-loss/interface-identity/raw-error regressions,
legacy compatibility and unified final T005 acceptance remain required. Same
producer, scope, authority, failures and used diagnostic allowances are retained.

## Accepted executable-graph installer unit alignment

Use the [executable-graph unit contract](t005-executable-graph-unit.md), SHA256
13d11ccaead7d3d03470450dec304fb7bf1fe1d090b37d52719b0bf47031628a.
Independent read-only interface/split review found no remaining P1/P2. This
selects an additive opaque prepared-material port and an independently verifiable
package-runtime installer/retention/reuse unit using actual filesystem/SQLite
and trusted Mock runtime ports. It does not establish production graph support.

The original producer confirms its boundary/network work imports existing
BuildSession APIs without changing the unit's index/archive/package-test files.
Those exact paths and new private graph modules/tests transfer exclusively to
the graph implementer until primary acceptance, then explicitly return to the
original producer for production integration. Existing owner, journal, recovery,
publication and retirement primitive behavior remains unchanged. The original
producer retains ResourceOps, guardians, assembler/executor/session-runtime,
backend, all dedicated VM work and every original production/final obligation.

The trusted factory's optional graph-material capability must be strictly true
before any v0.2 executable-graph staging, authority/database/resource effect or
factory creation. Default production remains incapable and rejects until its
actual multi-node copy/verification/recovery paths are complete. Root-owned
member registration, exact per-step dependency closure, complete retained-byte
assertions, one root owner/provider, versioned graph template/material identity,
cycle-free seals and read-only original-record reuse are mandatory. This is
constructor injection only; packages, manifests and CLI receive no authority.

The unit verifies against the frozen v97 120-source base plus only its exclusive
overlay in isolated host directories. It does not copy producer WIP or share
dist/runtime resources. Complete unit checks and independent review precede
handoff; one unified current input is still required for all final host/Linux,
public CLI and whole-T005 acceptance. All original failures and exhausted
diagnostic allowances remain; no split or new worker resets the segment.

## Host regression assets and isolated unit verification alignment

The first corrected graph overlay's actual whole-host run is not passing:
229 tests,208 pass,5 fail,16 skipped. Primary reads its retained raw and source.
Three sandbox assertions expect the old generic input-close text, although the
unchanged trusted guardian now returns the original receipt/create/identity
error. The late-inspection test attaches its rejection assertion only after
awaiting another terminal, producing an unhandled rejection. The admission
crash fixture writes directly to a report path that its parent treats as a
complete JSON marker as soon as the path exists, allowing a partial read.

The original producer owns the complete compatible correction to
tests/contracts/sandbox-backend.test.ts,
tests/contracts/guardian-native.test.ts,
fixtures/admission/src/crash-worker.ts and, only if required for a discriminating
checkpoint assertion, tests/recovery/crash-and-race.test.ts. Preserve all product
logic, phases, deadlines, unknown/effect/non-replay/foreign-operation assertions
and original owned process settlement. Match the actual independent original
errors; attach observation before rejection can become unhandled; publish only
a fully written/closed JSON checkpoint using an atomic owned marker. No polling
for partial JSON, broader regex, retry, timeout increase or runtime relaxation.

The graph unit still cannot write those paths. To resolve its frozen non-owned
baseline failures without copying live control WIP, the same producer also
provides the exact correction as a four-path maximum overlay derived from the
frozen v97 files, with unchanged imports and interfaces. It applies the same
minimal behavior to its live owned files. This compatibility overlay is a
selected exception to the original v97-plus-graph-only verification base; it
does not change the graph implementation boundary or transfer those test files.
Primary verifies the exact delta and sends it to the same graph implementer.
The resulting one frozen v97-plus-owned-graph-plus-compatibility input requires
true complete pre/post source manifests including the new graph test, pinned
static/build and whole-host cumulative checks. Existing scoped checks are reused
only for identical relevant inputs; the failed cumulative remains failed until
the changed-input run actually passes. No unchanged rerun merely for logs.

This settles required test-asset behavior and verification composition, not a
waiver of required checks or acceptance of graph, boundary, production or T005.
Original producer remains sole runtime-oci/index/guardian/VM owner; only
package-runtime/index and its selected graph unit paths remain transferred.
All previous failed runs, source/raw attribution, unknown roots and used
diagnostic allowances remain. Final unified current-source acceptance is required.

## Graph unit acceptance and production ownership return

The independently verifiable executable-graph installer/retention/reuse unit is
accepted only for host/Mock scope. Its exact v97-plus-owned-graph-plus-accepted
compatibility input has121 regular sources, unchanged across the actual run;
pinned format/typecheck/build and whole-host cumulative pass,230 tests with214
pass,0 fail and16 Linux-only skips. Independent source correction review closes
all product and test P1/P2. This evidence is not current whole-production or
Linux graph qualification. Source manifest
b0b28b6f9382a5902cd4a9b23daa2d5373ec898590e1965d19de5839fc5d33e3
binds the unit's actual tested input.

Only its three accepted files are copied into the live checkout, with original
baseline guards and primary regular-file/hash verification. Their exact starts:
package-runtime/index c8c7dab17ad2f49d3d822d017886297810461988a703d12aa8c2d584fb10dad7;
installer.test a6ca3d9c19630bb81e92a8ba5d808bb465e59f671f8dfef2827a8f51787e82b4;
executable-graph.test 7d0e76be2936405980615a73321a468ed71875ad55f41c084926ede4a7dfedc3.
Primary now explicitly returns package-runtime/index/archive/private graph
modules and installer/graph tests to the original producer. The separate unit
has no further write ownership. Production integration and all original final
acceptance remain the original producer's responsibility.

The stable optional graph metadata carries exact registered per-step node
closure, logical map, source/generated identities, root/step identities, fixed
graphTemplateDigest and final graphMaterialDigest where required. Obtain it only
through genuine opaque prepared inputs and revalidate retained bytes. Root owner
identity never changes to a child. Builder verification excludes its own output;
original assembly and verification use the same per-node selected resolved-lock
identity, while the registry/graph seal also binds the complete graph lock.
Material identity uses semantic digests/mapping, not physical host paths. The
actual immutable winner supplies every retained closure/image/receipt on reuse.
Graph-absent v0.1 formulas and behavior remain unchanged.

The optional supportsGraphMaterialV1 capability remains absent in the production
factory. Advertise it only after actual multi-node stopped-copy/verification,
fixed guest mapping, complete original resource/keeper/T004 recovery and required
Linux graph/installation checks are ready. No property, package or CLI option
may bypass the other readiness requirements. Complete boundary fault matrix,
network controls, provider-root cleanup, finite image storage, public CLI,
unified host/Linux cumulative and independent whole-Task review remain required.
No Task lifecycle completion, commit/push or diagnostic reset follows this unit.

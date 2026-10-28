# T006 lifecycle contract draft

Planning input for an independent architecture check; T006 remains todo. This
does not authorize execution before T005 acceptance or claim implemented behavior.
The Feature engineering context owns the eventual effective implementation plan.

## Authority and identities

Use the accepted package specification's logical slot identity
`owner/name/target`, immutable version record, package/image digest and independent
instance identity. Operator identity comes from trusted configuration, never
package bytes or workload RPC arguments. Activation/removal administration is not
part of the workload protocol.

Co-locate installation selection and its authorization fence in one trusted
runtime's local SQLite transaction authority. Registry metadata has its own
schema namespace and must coexist with PolicyAuthority's versioned tables.
Do not attempt an atomic lifecycle commit by calling two independent database
transactions. The implementation must expose a narrow shared transaction adapter;
it must not expose arbitrary SQL or a database handle to workloads.

Retain T001–T003 protocol behavior and state history. Removal must fence both the
legacy readonly path and the counter admission/dispatch path. Today the legacy
grant evaluator does not inspect installation policy; setting only
`installation_allowed=false` would leave that path callable.

## Selection and failure ordering

Persist attempts with an immutable request digest, expected installation
generation, expected active digest and the candidate version. Same attempt/same
request returns its durable result; a different request under that attempt is a
conflict. Prepare immutable content and bounded sandbox readiness outside the
selection transaction. Readiness receives no privileged grants.

Preparation acquires a durable candidate reference before readiness and retains
it until selection commits or the attempt is durably abandoned. Commit a new
active selection only through one compare-and-swap transaction over the expected
generation/digest, a non-removed slot, and a target version still validated and
neither collecting nor collected. The same transaction transfers the preparation
reference into selection retention. GC marking and activation/rollback selection
therefore serialize in this authority. Increment generation on success. A late
failed attempt cannot write a previous selection. If an already
committed candidate later fails health checking, rollback may change the pointer
only while that candidate still owns the exact committed generation/digest.
Otherwise record the obsolete failure without changing the current selection.

Rollback selects a retained, validated version through a new conditional
transaction. It does not restore grants, policy generations, proxy keys or old
workload channels. Additional requested permissions remain ungranted. Existing
running instances retain their immutable resolved version and their own grants;
new instances receive no grants by activation alone.

In the initial subset a removed slot is a durable tombstone: late activation,
rollback, health results and repeated installation cannot make it runnable.
An explicit reinstall-incarnation workflow is outside this Task; report it as
unsupported rather than silently reviving the removed identity.

## Removal and supervision

One conditional transaction marks the slot removed, clears active selection,
increments installation/policy generations, invalidates all instance grants and
leases, and durably requests retirement/cleanup. Future discovery, invocation,
queued dispatch and new instance creation must see that committed fence.
Dispatched effects remain subject to actual cancellation guarantees and unknown
outcome reconciliation; pointer removal cannot undo an external effect.

Revoked workload leases must not block recording the outcome of an already
dispatched task. Provide separate trusted cancellation/observation/reconciliation
authority for historical tasks, derived from the persisted admission/dispatch and
the trusted owner service. It binds the original installation, task, admission,
provider/epoch and executor fencing state, and preserves observation ordering.
It permits only cancellation or authoritative observation of that existing
operation. It cannot invoke, resend, create a new task or revive a workload lease.
Neither this authority nor historical results become available through retired
workload channels. Today PolicyAuthority's observation path requires liveContext;
the implementation must deliberately separate these two authorities.

After commit, retire supervisor channels and request bounded task/sandbox stop.
Distinguish committed removal from confirmed resource cleanup. Cleanup failures
retain a pending/unknown result, owned recovery evidence and content references;
they cannot roll back the removal fence. A fresh trusted process resumes only
identified cleanup, never a workload or permission. Retain sanitized task/audit
history. External OAuth authorization is independent and no real account action
is part of this batch.

## Shared sandbox composition

The current image backend's local counters cannot enforce a node-wide budget.
Before T006 starts concurrent versions, compose all application, readiness and
installer execution through one trusted SandboxManager for the configured node
root. Later MCP/render/media-validation services use the same authority. Package
metadata and workload calls cannot construct another backend/root or reserve
resources directly.

Prefer one active trusted manager process in this first subset. Reuse the private
SQLite ownership-lease pattern in a separate database; a second manager for the
same root fails busy rather than silently creating independent counters. Holding
that manager ownership lease must not hold the registry/Policy write transaction
across awaits. This does not require a new public administration transport or a
distributed scheduler. An installer in another process must use the active
trusted service or fail busy; it cannot fall back to a standalone builder.

Persist the manager boot/PID/start identity, host-generated backend-store
identities and resource reservations before execution side effects. Actual
execution reservations remain at most two with summed memory limits at most
1536 MiB across images. Reserve synchronously/transactionally before awaiting a
backend start; confirmed cleanup alone releases the reservation. Unknown cleanup
or an unresolved old owner retains its budget and version/image references.

For the first subset, serialize qualification against all actual workload
execution. It may start only with no active/pending-cleanup reservation, and new
work cannot start while it runs. The exact qualifier's own probe envelope and
recoverable resource identities must be checked against accepted T004 code
before this plan becomes effective. Do not assume an exception or a crashed
qualifier means it created no resources. If its ownership cannot be recovered,
keep the node busy with explicit unresolved evidence rather than bypass it.
This is a bounded initial scheduling choice, not a claim of uninterrupted
installation while arbitrary applications are running.

The T005 runtime integration must first provide a durable QualificationSession
covering the actual legacy and profile qualifier resources. Reuse that same
trusted session in this manager rather than wrapping an untracked qualify call.
Its exclusive intent precedes qualification; every container, dedicated control
or attach process group, network fixture and I/O/control directory is registered
under its authenticated ownership before the creation side effect. A complete
cleanup result covers success, failure and fresh recovery. Original writers and
late commands must have exited before absence or exact deletion can confirm
cleanup. An empty execution journal or a returned qualification Promise cannot
release the exclusive reservation. Unaccounted or unknown resources keep the
session busy and its candidate/version/image references retained. No recovery
path may rerun the original qualifier or build. Align the exact internal port
to accepted T004/T005 code before implementation.

Use existing current qualification handles only for their exact immutable
image/profile/host tuple. A new image still needs its own actual qualification.
Readiness without privileged grants and already qualified 768 MiB application
executions can coexist within the shared budget; a 1024 MiB builder/renderer
cannot coexist with a 768 MiB application. Return busy rather than raising the
envelope, stopping unrelated work or executing any step on the host.

A fresh owner first reconciles all persisted old reservations and owned stores
after confirming the previous manager's actual exit. Live guardians, unknown
daemon state, malformed/future records or incomplete qualification evidence
block new execution. Recovery is cleanup-only and never restores an old opaque
handle, workload channel, task send right or grant. Process/lock disappearance
alone cannot release storage references or resource reservations.

## Version references and collection

Acquire a durable version/image reference in the same authority that validates
the selected version before starting a workload. Upgrades do not retarget existing
references. A process crash alone does not prove its guardian/container exited;
release the reference only with appropriate trusted cleanup evidence.

Collection transactionally marks only unreferenced, unselected versions as
collecting. New references to collecting content are refused. Delete only those
identified package-owned files/final images outside the transaction, then record
confirmed completion. Preserve shared images and catalog bases, active/running
references, and unresolved deletion records. An image daemon failure is unknown,
not proof that storage was removed. Later Artifact/Scene references must join the
same retention contract when those Tasks exist.

T005 also retains sealed images from uncommitted candidates. Their trusted
candidate receipts and pending publication/build sessions are image references
for this collection decision, even without an installed version row. Publication
must acquire/transfer image retention in the same short authority transaction
that rejects collecting images. A recovery process cannot release another
candidate's retention or infer exclusive image ownership from a dead builder.
Until the actual registry can account for all these references, keep the T005
rule of retaining sealed images rather than partially implementing image GC.

## Required evidence

- Independent-process A/B barriers: A late failure cannot replace B; A post-commit
  health failure cannot roll back B's newer generation.
- Upgrade/removal and activation/removal races, crash before/after every durable
  selection/fence, and same-attempt conflicts/retry results.
- Dispatch followed by removal, late provider completion/stop and fresh-process
  authoritative reconciliation without any second invocation.
- Old readonly and counter channels denied after removal; queued dispatch cannot
  cross the committed fence; no grant inherited by a new instance or rollback.
- Real qualified Linux readiness/instance start/stop, live-old-version retention
  across upgrade, crash recovery and collection racing reference acquisition,
  activation and rollback in independent processes.
- Two different immutable image backends share the actual execution budget;
  competing manager/installer processes cannot bypass it. Qualification excludes
  active work, and a manager crash with a live guardian or unknown cleanup keeps
  the old reservation until precise cleanup confirmation.
- Crash qualification at actual legacy/profile resource creation boundaries;
  fresh recovery covers its full durable session, preserves live peers and
  cannot mistake an empty execution store for confirmed qualifier cleanup.
- Cleanup failure remains removed with retained evidence; unrelated installation
  survives. Zero real accounts, model calls or robot operations.
- Current-input cumulative checks, usage CLI, frozen evidence and independent
  code review before acceptance, commit/push and GitHub tracking.

T005's actual schema/API must be checked before this draft becomes the effective
T006 plan. Do not invent compatibility with an unimplemented registry interface.

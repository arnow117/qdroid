# T005 fixed network controls implementation contract

Selected contract after independent protocol review and correction of its two
receipt-epoch/terminal-health findings. This is not implementation acceptance.
Same original Task, producer, authority, scope and used diagnosis history.
Boundary implementation continues independently. This settles the next original
legacy/profile network capability without a public or circular factory.

## Source facts and selected reuse

Legacy index.ts runNetworkProbe still calls SyntheticNetworkTarget.create before
its managed workload route. It owns four original controls: non-loopback host
IPv4 TCP/UDP/DNS and IPv6 loopback TCP. Preserve its original four attempts and
assessment. Profile backend.ts owns the five fixed categories and TCP/UDP/DNS
listeners for each; fixed-probe-catalog already owns the original profile probe.
ProfileNetworkFixtureController lives in backend.ts and its standalone worker
immediately removes its dummy interface on parent disconnect. Calling that raw
factory or inheriting that disconnect behavior unchanged is incompatible with
managed dependencies and the supervisor's dependency direction.

Select one original network keeper per createNetworkControls('legacy'|'profile'),
under the same ResourceOps owner and control/dependent-proof lifetime established
by the boundary contract. The keeper owns its listeners, accepted connections,
positive-client sockets, receipt state and, for profile controls, the original
fixed synthetic interface writer. The keeper is the controller; no second
independently disconnect-cleaning controller process is added. Network APIs are
private and versioned, e.g. qdroid.fixed-network-control/v1; strict kind-specific
request/reply schemas accept no arbitrary source/argv/target/Docker options.

Reuse/extract the pure fixed target catalog and original fixed interface recipe
plus identity-checked cleanup verification into private supervisor modules.
Both the unmanaged standalone worker and new managed keeper may use those
fixed recipes; preserve unmanaged IPC, exported controller compatibility and
existing tests. Supervisor never imports runtime backend. Keep generic process
transport internal to trusted implementation; ResourceOps exposes no executable
or argument runner. The new managed writer must track real sudo/ip children and
raw descriptor settlement; do not copy the old timeout's early return as proof
that all descendants settled. Use the original command limits or stricter bounds,
not wider limits. A bounded report never discards its actual raw responsibility.

## Identity and creation before use

Register the raw responsibility and authenticated resource intent before keeper
fork. Capture/persist actual boot/PID/start/group before fixed creation authority,
under the same registered active BuildSession and durable provider ack. All names
are host UUID-derived and ports are ephemeral host allocations; no package picks
an address, interface, MAC, path or target port. Profile addresses are exactly
the current fixed loopback/private/link-local/synthetic-metadata/ULA catalog.
The synthetic metadata endpoint remains 169.254.169.253, never a real cloud
metadata endpoint. Legacy non-loopback host address is chosen by the original
trusted host algorithm, not caller input; ::1 remains the original IPv6 target.

Profile interface creation uses only the fixed dummy-interface commands and
addresses. Record the unique name/MAC marker before effects, inspect the actual
created interface and bind its namespace/ifindex/type/marker and fixed addresses
in the original authenticated creation proof before returning usable controls.
Before removal verify that same original identity; absent/foreign/replaced or
unknown evidence never permits deleting another interface or replaying creation.
A possibly submitted late ip operation stays owned and blocks confirmed cleanup.

Every socket/listener is registered as soon as constructed, before asynchronous
bind/listen or connect/send. Observe errors/close immediately and retain partial
construction resources on failure. After actual binds and required identity
publication, file+directory sync the immutable keeper-created receipt, then
acknowledge parent journal binding before returning the opaque handle. It binds
the exact owner/session/resource/keeper, kind, fixed target IDs, actual ports
and original interface proof where applicable. Domain-separate from other
receipts. Values are readonly internal facts, not authority accepted from callers.

## Opaque operations and truthful kind-specific receipts

Keep existing assertHealthy/assertPositiveControls/resetReceipts/snapshot/dispose
operations and privately registered same-session handles. Reject structural,
cross-session, wrong-kind, closing, disposed and stale handles before effects.
The exact original registered handle's assertHealthy is an explicit read-only
exception after disposal: it reads cached terminal health/latched causes, performs
no new I/O or creation, succeeds for healthy normal own shutdown and rejects any
recorded failure. All positive/reset/new-probe operations remain rejected.
Positive controls send only the original fixed packets/connections, to every
required fixed target/protocol, and verify actual server-side receipts. Track
each client operation through actual closure. Health failure is permanently
latched across reset, probe cleanup, disposal and recovery; expected verified
own shutdown after required settlement does not fabricate a failure.

Correct the unused legacy receipt type without weakening the accepted profile
type: a common base contains lifecycle/health/positive/reset/dispose methods;
OwnedLegacyNetworkControls.snapshot returns a distinct strict DTO with settled,
tcpIpv4, tcpIpv6, udpDns and udpIpv4, matching its four actual original controls.
OwnedProfileNetworkControls.snapshot retains the accepted required five traffic
fields including udpIpv6 plus settled, unchanged. Do not fill an unobserved
legacy IPv6-UDP field with false and claim a control that did not exist. Existing
profile consumer/helper and tests are frozen; their legacy overload rejects
without constructing a legacy handle, so this split requires no consumer edit.
An actual compile/interface conflict returns to root and the same consumer.

Profile receipt aggregation covers every fixed target's TCP/UDP/DNS, including
ULA UDP and DNS; positive validation retains the per-target/per-protocol detail.
Snapshot booleans report any observed matching traffic; missing/invalid fields
reject, never normalize to false. Legacy preserves its original four-positive /
four-negative assessment; profile qualification supplies the broader category
and IPv6-UDP coverage. This is no change to public SandboxBackend qualifications.

Use exactly ONE measurement epoch per control handle. Positive operations run
only before measurement. resetReceipts is one-shot, serialized with all positive
clients and receipt callbacks, requires their actual settlement and no prepared
dependency, then enters measurement. Every later reset or positive send rejects
before effects, including after a probe releases its dependency and before the
consumer reads snapshot. Negative evidence is monotonic and cannot be cleared.
No public epoch/token or new consumer API is needed.

Probe preparation requires that measurement has begun. Snapshots always read
that SAME immutable epoch. A snapshot is settled only after all admitted sends,
receipt callbacks and dependent negative producers actually settle, plus the
existing bounded receipt-settling observation. A timeout or held writer yields
unsettled/unknown, not zero traffic. The first settled snapshot seals new probe
dependencies and caches the final measurement; subsequent reads cannot switch
to an empty epoch or enable another assessment. Recheck lifecycle and health
after every await and before reply. Existing consumers create fresh handles for
each assessment; reuse/retry needs a new controlled handle after exact disposal.

## Dependent probes and destruction ordering

Use the same control-bound prepared-not-authorized probe, durable dependency ack,
then one-shot create authorization protocol as the selected boundary contract.
New strict legacy/profile network variants resolve only authenticated keeper
facts and the code-owned program/catalog. A legacy network variant invokes the
original protected probe.mjs network program with the original four targets;
profile invokes the existing pure PROFILE_NETWORK_PROBE_SOURCE and exact current
immutable profile catalog limits/digests. No runQualificationWorkload(argv)
capability is exported through ResourceOps. Preserve existing assessments.

Probe cleanup preserves the immutable first result and separately proves exact
container removal, all original writer/attach/observer settlement and its
authenticated dependency terminal. It releases references only after the keeper
validates original no-create or created-cleaned proof and actual group absence.
Probe cleanup does not close the controls; assertHealthy and snapshot remain
usable afterwards. Dispose seals new dependencies synchronously, stops/drains
all admitted probes and positive operations, then closes/join actual sockets,
accepted clients and original ip writers before exact interface cleanup. Keep
latched health failures observable even after independent confirmed cleanup.

Parent disconnect permits only original cleanup/observation. The network keeper
must not delete its interface or intentionally close controlled listeners while
dependent probes/writers remain unknown. Original probe guardians clean up and
publish their bound proofs; the keeper waits those exact facts. Unexpected
keeper death closes OS sockets but does not establish health or cleanup proof;
the remaining interface/session stays unknown and blocks admission. No new
fresh path-reconstructed or generic interface cleanup writer is introduced.
Original keeper may remove only its exact verified interface after dependencies
and raw ip writers settle, then durably write its terminal and actually exit.
Fresh recovery observes original receipts and identities under the SAME physical
BuildAuthority transaction; it cannot replay positive controls, network probes,
interface creation or installation. Complete provider-root/other-resource cleanup
is still required before retirement. Keep all original evidence and causes.

## Acceptance and remaining original scope

Implement both owned legacy/profile controls, strict protocol/receipts, fixed
probes, consumer routing and cleanup/crash lifetime as one bounded capability.
Migrate legacy runNetworkProbe before raw SyntheticNetworkTarget construction;
managed missing/unsupported controls never execute that fallback. Full readiness
remains false until this and ALL other selected qualification/recovery creation
sites are actually complete. Do not change frozen profile helper/test or CLI
without an actual root-settled compatibility conflict.

Necessary current-input tests include original real host positives, four legacy
attempts and profile category/protocol negatives under each original profile;
strict DTO/version/kind/forged/cross-session rejection with zero effects; positive
client/receipt hold across reset and no reset after probe authorization; late
snapshot cannot conceal health/epoch change; prepared/no-create/created cleanup;
reset attempted after probe cleanup but before snapshot must reject and preserve
injected negative receipts; repeated snapshots read the same sealed epoch;
normal post-dispose assertHealthy is read-only success and a latched failure
still rejects, while all post-dispose new operations have zero effects;
out-of-order/concurrent dispose waits probe and writer; controls remain usable
after probe removal; actual installer SIGKILL while a dependent writer is held
does not remove interface/listeners early, then original keeper completes;
controller/keeper loss, interface marker/ifindex replacement, missing receipts
and ip timeout preserve unknown and untouched foreign resources; all independent
original/control/fsync/close errors survive. Existing unmanaged/T004 network
compatibility is still required. No Task completion, fresh diagnostic allowance,
permission expansion, shared-interface cleanup or final T005 acceptance follows
from this proposal or a component pass.

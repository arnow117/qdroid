# Sandbox, identity, and permission contract

Status: proposed v0.1, 2026-10-23. MUST/SHOULD describe implementation acceptance requirements, not controls that already exist. This design does not assert certified physical safety or complete prevention of information leakage.

## Threat model and trust classes

Assume a malicious or compromised Skill, local MCP server, application, generated shell command, HTML page, dependency installation hook, or model/tool response. It can execute arbitrary code within its assigned workload and forge any message/data available there. Assume the host kernel, configured isolation runtime, trusted broker binaries, administrator, and vendor safety system are trusted for this MVP. Host-root compromise, hardware attacks, and vendor firmware exploits require separate treatment.

Protect host/device credentials, unrelated files and applications, control network/device access, physical-operation authority, external account operations, and enough resources for vendor services. Read access also matters: rendered MP4, logs, model prompts, and retrieved documents may contain private data.

| Class                  | Examples                                                    | Admission                                                               |
| ---------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| Untrusted app/tool     | Skill scripts, shell, local MCP, agent extension            | Required isolation profile, task-bound capability channel               |
| Untrusted build        | npm hooks, Python build backend, downloaded installers      | Separate no-credential build sandbox, approved registries               |
| Untrusted render/media | HTML/JS, fonts/images/media parsers                         | No broker credentials, no device/network access, bounded inputs         |
| Trusted infrastructure | PolicyAuthority, SandboxManager, robotd, credential brokers | Admin-controlled release, least privilege, separate identity and stores |
| Vendor services        | SDK server, player, safety/manual control                   | Device-specific contract and integration qualification                  |

An in-process plugin, Python environment, Node VM, chroot, permission prompt, or MCP read-only annotation is not this isolation boundary.

## Caller identity

The trusted PluginSupervisor creates an installation identity `(package digest, installation ID, owner)` and a workload identity `(instance ID, host boot ID, instance epoch, sandbox ID)`. A task may be further bound to a specific invocation channel.

For local stdio, the supervisor owns pipes and binds them to a supervised process handle and epoch. For Unix sockets, peer credentials alone are insufficient when workloads share a UID; use a dedicated supervised endpoint and identity binding, with separate mounts/namespaces and revocable instance credentials where needed. Never trust PID values, principal IDs, grants, or sandbox IDs supplied in JSON arguments.

Cross-node service links authenticate the actual service and authorize the device/application scope. A generic remote plugin endpoint is not enabled in the MVP. If later introduced, its transport/session identity and revocation must be defined separately; same-host Lark HTTP sidecar is not a cross-node protocol.

## Three distinct records

| Record             | Author                                                   | Meaning                                                                      |
| ------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Capability request | Package/application author                               | The operations/resources the package asks to use                             |
| Grant              | Authenticated operator/administrator via PolicyAuthority | A bounded permission for a subject, capability, resources, risk and lifetime |
| Invocation         | Workload through its bound channel                       | A specific requested operation, requiring current checks                     |

Package signature, installation approval, OAuth scope, and command allowlist do not imply a qdroid operation grant. The model cannot author or approve a Grant.

Effective permission is constrained by all applicable host policy, installation policy, task grant, provider limits, runtime qualification, and resource/lease state. An explicit applicable deny wins. Absence of an allow is denial. Conflicting/malformed/unrecognized policy is denial; a failed policy lookup must not allow execution.

## Authorization algorithm

Before routing an invocation, the core MUST:

1. Resolve identity from the supervised channel and reject stale boot/instance/task epochs.
2. Resolve the exact capability/provider/schema version. Validate all input, including unknown fields where forbidden, bounds, units, resource IDs, and payload size.
3. Load current policy and revocation generation. Match capability, operation, resource selectors, task, risk, use count, and expiry. A caller cannot choose a lower risk category.
4. Verify the workload's qualified sandbox satisfies this invocation's minimum isolation requirements. Cache only with policy/provider/profile generations and revalidate on dispatch.
5. Acquire the relevant execution resource/lease and route the request to the trusted execution broker. This queueing/precheck does not consume authority to execute.
6. Immediately before submission, the broker calls PolicyAuthority's `commitDispatch` against its service-owned admission ledger. In one transaction, verify the live subject/grant/generation/lease, pre-dispatch cancellation state and exact input digest; reserve/consume the Grant use budget and any approval use; and persist the dispatch intent/internal ticket. The ticket is bound to this trusted broker, operation, task and provider epoch. A bare client-supplied grant/ticket ID is never proof.
7. Record accepted, observed progress, terminal evidence, failure, or unknown. Sanitize output for the caller and audit record.

Step 6 is the authorization/dispatch linearization point and closes the queued-request race. A revocation or queued cancellation committed before it prevents the side effect. A cancellation/revocation after it concerns an already in-flight dispatch, even if the vendor call/result is not yet observable; it cannot be promised to undo that operation. A crash between commit and the external call is therefore reconciled as potentially dispatched, not automatically retried.

Grant budget checks cannot be an independent read followed by a later decrement. A budget of one admits at most one distinct concurrent dispatch. The same idempotent operation reuses its existing admission record without another debit or another unconstrained execution. Unknown outcomes do not automatically refund committed use. Any refund requires authoritative non-execution evidence and a unique audited adjustment under the same policy, rather than creating a fresh task to bypass limits.

## Grant and approval scope

Grants contain a host-generated subject binding, capability/schema scope, permitted semantic operations, resource selector, limits, risk ceiling, lease/lifetime, use budget, revocation generation, and issuer. Resource selectors are typed values such as calendar IDs or artifact ownership, not arbitrary executable policy supplied by a package.

For an external write, any approval is bound to the exact semantic operation, recipient/resource, canonical payload hash, subject/task, expiry, and allowed use count. Canonicalization is performed by the trusted broker with a versioned schema. Unknown fields and alternate encodings cannot change effect interpretation after approval. The operator UI/endpoint is separately authenticated and is not reachable as an approval issuer from workloads. The initial Lark use case is read-only; arbitrary message/email/document writes are not required for MVP.

Approval use does not imply a safe retry. After a timeout, reconcile via downstream idempotency or an authoritative query. If neither exists, retain unknown and require an explicit recovery decision; do not issue a second write with a new key.

## Runtime profiles

All following profiles are planned. A profile has an immutable digest, runtime/image/platform constraints, actual feature-probe evidence, resource limits, and a qualification-suite version. The same name on another kernel does not carry qualification.

| Profile                  | Filesystem                                | Network                                      | Broker reachability                                            | Device privileges                                        |
| ------------------------ | ----------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| `tool-offline`           | Read-only package; private scratch/output | No external traffic                          | Only its bounded capability channel                            | None                                                     |
| `connector-readonly`     | Same; no token/keyring mounts             | Only its trusted connector endpoint          | Only granted connector operations and optional artifact output | None                                                     |
| `render-offline`         | Immutable scene/assets; private output    | No external traffic                          | Artifact input/output handles only                             | No control devices/GPU passthrough in initial profile    |
| `build-restricted`       | Source read-only, private build scratch   | Approved registry/mirror via enforced egress | No robot/connector/model credentials                           | None                                                     |
| `trusted-device-service` | Explicit vendor config/runtime paths      | Explicit vendor/control links                | Admin-authorized device service                                | Minimal required device/SDK access; not a plugin sandbox |

Profiles must enforce distinct user/PID/mount/network contexts as applicable, read-only roots, no privilege escalation, minimal capabilities, appropriate syscall restrictions, and host-enforced CPU/memory/PID/storage/IO/output/time budgets. Engine prerequisites and controller delegation are verified by actual failure tests. Host management sockets, SSH/cloud credentials, `/proc` access to other trust domains, and unrelated application directories are not mounted.

The initial T004 implementation selects offline tool/build/render profiles.
Approved dependency downloads belong to the separate trusted fetch service; build
scripts receive pinned content and no direct registry connection. This is the
strict offline subset of `build-restricted`, not evidence for a network-enabled
profile. Each actual image/profile tuple needs its own qualification. Render
profile isolation does not establish browser/codec compatibility before T008.

All child processes remain in the same sandbox/resource boundary. Killing only the parent shell is insufficient; cancellation cleans the task-owned process group/cgroup and verifies completion, without touching shared/vendor services.

An independent trusted supervisor retains deadline and cleanup ownership if the
manager exits. Service-private cleanup records cannot authorize new execution.
After an owner crash, recovery verifies boot/process-start identity and exact
container ownership before reclaiming only its abandoned resources; live peers and
unknown records are preserved. A resource is not reported stopped until actual
termination and the declared cleanup conditions are confirmed.

A recorded numeric process-group ID alone cannot authorize termination: the
number may have been reused. Recovery must preserve unknown outcomes when current
ownership cannot be established. Likewise, a client timeout or killed CLI does
not prove cancellation of a daemon request. Retain durable evidence and resource
reservations until the relevant operation and cleanup are actually confirmed.

For supervisor-created children, retain the actual child ownership for controlled
termination. An asynchronous PID/start check followed by a numeric PID signal is
not an atomic identity check. Do not reconstruct termination authority from a
stored process number after the original child exits.

API deadlines do not cancel filesystem mutations. Recovery retains exclusive
ownership of already-started durable writes until they settle, even when the
caller has received a bounded unknown result. Late completion cannot authorize
another effect or release a reservation. A later explicit recovery must reconcile
the actual durable result; neither a temporary missing file nor a timeout alone
proves successful retirement.

Losing supervision permanently invalidates that qualification. Its original
bounded cleanup may still persist proven creation and exact removal facts;
confirmed cleanup does not restore execution authority. Repeated successful
cleanup is idempotent. Public recovery must also reconcile a recorded late
retirement whose file has already been unlinked. Preserve the original failure
alongside any independent cleanup failure through composed service calls.

## Network enforcement

Default deny is enforced in the runtime's network boundary, not by asking the process to respect proxy environment variables. Negative tests include direct-IP sockets, DNS/UDP, IPv4/IPv6 loopback, private/link-local/metadata addresses, alternate ports, redirect chains, and DNS rebinding where network resolution is allowed. Approved broker endpoints are explicit exceptions with identity binding, not a broad allowance for host/private networks.

Renderers receive no internet or connector access. Package/dependency fetch occurs in build/fetch services, with size/hash/source validation. Broker uploads/downloads authorize operation and destination/resource; a same-domain write is still a possible data leak and requires the appropriate grant.

Rootless containers share the kernel and do not by themselves prove sufficient isolation. gVisor is a candidate, not a universal promise; its selected mode, application compatibility, network behavior, and host limits must pass qualification. OpenShell and VM options remain candidates when host requirements are satisfied. No failed qualification may silently select host execution or remove seccomp/user namespace/browser isolation.

## Secrets and external connectors

App secrets, refresh tokens and real access tokens live in a dedicated trusted connector identity/store. Workloads cannot read the store, broker process memory, operator session, or token-bearing logs. Local filesystem permissions and at-rest encryption are separately reported; chmod alone is not hardware-backed secret protection.

If a workload needs the official Lark CLI, use a pinned `authsidecar` build. Its HMAC key is a workload capability, not an external account token. The trusted broker maps authenticated requests to a catalog of allowed semantic API operations and validates method/path/query/body/resource and identity. Unknown/raw endpoints, config/auth/update/apps/subprocess commands, and unapproved writes remain denied. Local CLI restriction is only additional defense because malicious code can forge a request with the HMAC key.

The sidecar's timestamp window is not replay prevention. Use per-instance keys and trusted replay/usage tracking, bind allowed operation/resource to the task, and enforce request/body size, rate, timeout, token-refresh serialization, and response limits. Real downstream tokens are injected only after these checks, and never returned to the workload. Presigned download URLs require a separate policy-approved fetch path.

The agent may receive private connector results by an explicit read grant. ModelBroker access can therefore transmit those results to the configured model provider. Separate read permission from permission to disclose externally, record the configured data-handling policy, and do not claim credential isolation prevents all prompt-injection exfiltration. Offline/private-data deployments can disable that model route.

## Device and display safety

Device actions use a fixed provider catalog with explicit limits, frame/units, local lease, form/state preconditions, and resource arbitration. No direct DDS/HAL/CAN/serial access from arbitrary workloads. A generic speed tool is not a navigation implementation. Manual takeover and vendor safety retain priority according to actual verified semantics.

Display grant does not grant arbitrary filesystem paths or vendor priority. Import only owned/authorized ArtifactRefs with permitted format, size, producer provenance, and output profile. Treat media validation and decoding as untrusted parsing; isolate them and re-encode through the trusted pipeline where required. Do not expose the vendor player to arbitrary caller-supplied files by path.

Private scene/video caches have owner/app access controls, quotas, expiry, and account-removal cleanup. Player-side lease supervision and verified clearing/fallback behavior are prerequisites for unattended sensitive scenes. A finite clip may hold its last frame; finite duration alone is not proof of clearing.

## Installation and upgrades

Installation cannot execute package-controlled code on the trusted host. Extraction rejects path traversal, escaping links, device nodes, forbidden ownership/modes, duplicate paths and archive bombs. Use trusted staging not writable concurrently by a workload, component-aware/descriptor-relative file access, freeze content before validation and activation, and never validate one path then follow a different mutable link.

Lifecycle mutations are serialized per installation. Activation/removal/rollback use a durable installation generation and expected active digest. A failed attempt may revert its pointer only while it still owns that activation generation; it cannot overwrite a newer successful install or resurrect a removed package. Shared content garbage collection respects active-version/running-task references and is independent of grant revocation.

Build outputs are untrusted until validated. Pin source/lock/image digest, target platform, declared components, licenses and provenance. A signature authenticates publisher/content, not safety. Upgrade compares requested permissions; newly requested rights are not inherited. Activation atomically selects a validated version; running tasks keep their version. Failed upgrades restore the prior package pointer without silently restoring revoked grants.

## Qualification and acceptance

The MVP must collect evidence on an actual Linux host for the exact backend/image/kernel/profile. A Mac rendering experiment and simulator assertions are not isolation qualification.

Required negative scenarios are: forged principal/grant; stale epoch; revoked queued call; two concurrent invocations with one remaining use; cancellation before/after dispatch commit; resource-selector bypass; replay; unknown-outcome retry/refund; host canary read; cross-app access; direct network bypass; denied robot network/device; credential/memory/log access; archive escape; child-process escape; actual memory/PID/CPU/output limits; cancellation of descendants; runtime downgrade attempt; concurrent activation/rollback/removal; and crash recovery of dispatch/approval/budget records.

Use synthetic secrets, mock downstream APIs, and isolated test networks. Never run destructive qualification against the live robot or a personal account. T1 device acceptance separately proves adapter behavior, manual takeover and display recovery; it does not replace generic isolation tests.

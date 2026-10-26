# Core interface contract

Status: proposed v0.1, 2026-10-23. Examples describe the intended language-neutral API. T001 implements only the restricted initialization, discovery, read-only simulator invocation and task-query subset described in [the usage guide](../USAGE.md). Other interfaces below remain proposals; their presence is not implementation or qualification evidence.

## Compatibility and transport

Use JSON-compatible DTOs with versioned schemas and bounded payloads. Local plugin transport initially uses supervisor-owned stdio JSON-RPC 2.0. Private service-to-service IPC may use authenticated Unix sockets; cross-node transport is a separate deployment implementation. JSON-RPC connection identity comes from the supervisor/transport, never a `principal` field supplied in params.

The host and provider negotiate protocol major/minor, capability schemas and limits at initialization. Reject incompatible majors and unknown required features. Within a compatible major, additive optional fields require schema-defined handling; silently ignoring unknown authorization-relevant fields is forbidden. A capability schema change that alters execution or cancellation semantics requires an explicit version change and conformance evidence.

Messages contain a bounded request ID. Tasks, artifacts, grants, providers and installations use opaque host-generated IDs. IDs are identifiers, not bearer authority. Do not expose database keys, filesystem paths or raw vendor objects as access tokens.

## Public plugin methods

| Method | Input | Result | Authority |
|---|---|---|---|
| `runtime.initialize` | Compatible protocol versions, package content identity | Bound instance, negotiated features/limits | Package identity must match supervisor's installation record |
| `capabilities.list` | Optional typed filter | Available descriptors allowed for this subject | No discovery of unrelated private resources |
| `capabilities.invoke` | Capability/schema, arguments, optional idempotency key | TaskHandle or validated immediate result | Current grants, provider and sandbox checks |
| `tasks.get` | Task ID | State, permitted evidence and result | Owner or explicit observer grant |
| `tasks.cancel` | Task ID, reason | Cancellation request state | Owner/authorized controller; not proof of stop |
| `events.subscribe` | Permitted topic/filter and cursor | Bounded subscription | Subject/resource-scoped, no arbitrary bus access |
| `artifacts.put` | Permitted format/size and input bytes/stream | ArtifactRef | Private quota and ownership |
| `artifacts.get` | Artifact ID and optional range | Permitted metadata/content | Ownership or explicit read grant |
| `display.present` | SceneRef, state, revision, presentation policy | Presentation TaskHandle | Display lease and format compatibility |

There is no public `grant.create`, `approval.confirm`, `container.exec-on-host`, arbitrary network proxy, raw SDK RPC, or direct secret retrieval. Administrative APIs use a separate authenticated endpoint and cannot be reached as workload tools.

Example invocation:

```json
{
  "jsonrpc": "2.0",
  "id": "call-42",
  "method": "capabilities.invoke",
  "params": {
    "capability": "speech.speak/v1",
    "arguments": {"text": "Your next meeting starts at ten.", "locale": "en-US"},
    "idempotencyKey": "utterance-42"
  }
}
```

The host derives subject, installation, task grant, allowed provider, risk and maximum lease. The optional key does not manufacture downstream idempotency; its actual guarantee is returned by the provider contract.

## CapabilityProvider port

Illustrative structural types; the normative implementation must supply per-capability JSON Schema and conformance tests.

```typescript
interface CapabilityProvider {
  describe(): Promise<ProviderDescriptor>;
  probe(context: TrustedProbeContext): Promise<ProbeReport>;
  invoke(request: AuthorizedInvocation): Promise<ProviderReceipt>;
  observe(task: ProviderTaskRef): AsyncIterable<ProviderEvent>;
  cancel(task: ProviderTaskRef): Promise<CancelReceipt>;
  reconcile(task: ProviderTaskRef): Promise<ObservedOutcome>;
}
```

Only trusted routing services construct `AuthorizedInvocation`; applications never instantiate it as proof. A provider verifies a live authorization/lease context at actual dispatch or validates a narrowly scoped authenticated record. `probe` is an administrator-controlled, bounded operation; loading a package does not authorize physical probing.

`ProviderDescriptor` identifies vendor/provider build, firmware compatibility, implemented capability schemas, input constraints, completion/cancellation/idempotency behavior, resource claims, observation support and failure modes. Implementation declaration, successful probe, operator policy and task grant remain distinct records.

`ProviderReceipt` distinguishes rejection from acceptance and links a provider task/reference when available. It includes the evidence kind and what is still unobserved. Providers with no query/feedback return unsupported observation rather than synthetic completion.

## Internal PolicyAuthority port

This port is reachable only from authenticated trusted services. Operator administration has a separate authenticated endpoint; no method below becomes a public workload tool by appearing in a tool catalog.

| Operation | Trusted input and output | Required behavior |
|---|---|---|
| `evaluate` | Bound subject, normalized operation/resources/input digest, provider/profile identity → allow/deny precheck with policy generation | Advisory precheck only; does not issue execution authority or reserve a use |
| `commitDispatch` | Authenticated execution-broker identity, bound intent/task, exact request digest, grant/provider/instance generations, live local lease → admitted/existing/denied and internal admission record | One durable transaction checks cancellation/current authority and consumes budgets/approval with dispatch intent; an existing idempotent admission never issues a fresh unconstrained dispatch |
| `requestCancellation` | Bound authorized controller/task → ordered cancellation marker and admission status | Uses the same admission owner as commit; queued cancellation wins only if committed first |
| `lookupAdmission` | Authenticated broker/task owner scope and admission identity → permitted durable evidence | Recovery query; does not issue permission to repeat a side effect |
| `revoke` | Separately authenticated operator/system revocation rule → new policy generation | Workloads cannot invoke it as an issuer or restore an old generation |

`BoundDispatchIntent` binds installation/workload/task identity, resolved operation/resource scope, canonical input/schema digest, provider epoch, required isolation and deduplication scope. Values are derived/validated by trusted services; accepting a field with the same name from a plugin is not binding it. Caller-supplied idempotency keys remain untrusted identifiers.

An internal admission ticket is authenticated and scoped to one execution broker, operation/digest and provider epoch. Its durable record is authoritative; copying the ticket must not create a second execution right. The initial implementation uses broker-authenticated IPC plus journal lookup rather than handing a reusable bearer credential to the application. Broker recovery after an ambiguous send reconciles or reports unknown; a valid historical ticket alone does not justify resending.

Policy/database unavailability or failed transaction commit is denial/unavailable before dispatch. Task status and audit writes cannot turn a rejected admission into an allowed one. Record an execution result against its existing admission, preserving evidence even if the core projection temporarily lags.

## Shared task model

```text
created → authorizing → queued → dispatched → running
    └─ rejected/failed            └─ succeeded/failed/canceled/unknown
```

`running` requires actual supporting evidence; an accepted-only provider may move from dispatched to unknown when authoritative observation is unavailable. `cancelRequested` is an independent field that may coexist with running/unknown and does not by itself make an in-flight task terminal.

Queued cancellation and first dispatch compete through the same trusted admission ledger. If cancellation commits before `commitDispatch`, no execution ticket can be issued and the task becomes canceled without a provider side effect. If dispatch commits first, cancellation is recorded/requested and the provider's actual evidence decides the result. qdroidd must not decide this race from an independently cached Task projection.

| Field | Contract |
|---|---|
| `taskId`, `parentTaskId` | Host-generated; scoped visibility |
| `subjectBinding` | Trusted installation/instance/task association, not public caller-selected identity |
| `capability`, `provider`, `schemaVersion` | Exact resolved versions; no mid-task provider switch |
| `state`, `stateVersion` | Monotonic state version; compare-and-set/journal rules reject stale transitions |
| `dispatchRecord` | Durable request digest, authorization generation, provider epoch and send intent |
| `cancelRequested` | Request time/reason and actual cancellation guarantee |
| `evidence` | Observed result, source/sequence, observation time, confidence category |
| `outcome` | Typed result or structured error; unknown reason where applicable |

Journal intent before side effects. PolicyAuthority transactionally owns dispatch admission, cancellation markers, Grant budget and approval use; core task progress and provider execution records refer to the same admission ID. The single-host initial store is local SQLite with durability/transaction settings qualified by crash tests. It is not an atomic transaction with an external vendor/API call.

Recovery queries authoritative state where supported; it does not resume motion or external writes solely because a dispatch record exists. A crash at an ambiguous boundary produces unknown. Preserve historical evidence; reconciliation can resolve unknown only from authoritative evidence, with a new state version. Committed unknown uses are not automatically refunded, and idempotent repeat requests cannot debit or dispatch anew outside their existing admission record.

Deduplication scope is `(installation, operation, key, request digest, provider epoch/contract)`. Reusing a key with different canonical input is rejected. A recorded response can be replayed only within its actual contract. Idempotency is not inferred from HTTP method, tool name or the existence of this host journal.

## Errors

Use JSON-RPC protocol errors for invalid framing/method/params. Domain errors carry stable `data.code`, non-sensitive `message`, task ID if created, and a recovery classification.

| Code | Meaning | Default recovery |
|---|---|---|
| `QD_PERMISSION_DENIED` | No matching current grant, or explicit deny | No automatic approval/retry |
| `QD_UNSUPPORTED_CAPABILITY` | Required semantic capability unavailable | Explicit application fallback or reject |
| `QD_INCOMPATIBLE_VERSION` | Protocol/schema/package mismatch | Install compatible version |
| `QD_RUNTIME_NOT_QUALIFIED` | Required isolation property unavailable/unproven | Refuse execution |
| `QD_RESOURCE_LIMIT` | Quota/concurrency/size/time constraint | Bounded application recovery |
| `QD_STALE_CONTEXT` | Old boot/instance/provider epoch, expired lease | Re-establish context; never replay old side effect |
| `QD_IDEMPOTENCY_CONFLICT` | Same key with different effect | Reject and inspect |
| `QD_OUTCOME_UNKNOWN` | Dispatch may have taken effect | Reconcile or request a recovery decision |
| `QD_PROVIDER_UNAVAILABLE` | Provider not ready/disconnected | Retry only when absence of prior side effect is known |
| `QD_VALIDATION_FAILED` | Schema/resource/format constraints invalid | Correct input; no side effect |

Do not expose broker tokens, raw credential-bearing upstream requests, private files or full provider environments in error messages.

## Events and input

Events include schema version, topic, resource, provider boot/epoch, sequence, correlation/task ID, observed timestamp and bounded payload. A sequence/cursor is scoped to its event stream. Reconnection may deliver duplicates or report a gap; the consumer must handle both. The host applies ACLs and backpressure before delivery, with a documented bounded drop/gap policy.

Timestamps from different nodes are not automatically comparable. Input expiry is checked using the qualified transport/clock context. Touch/ASR is normalized to semantic application actions through InputBinding. Sensors, camera orientation and device-specific IDs stay in adapters. Do not invoke an old side effect when replaying an input log after a reboot.

## Robot capability minimums

All IDs below are proposed qdroid schemas, not vendor APIs.

| Capability | Required semantic contract |
|---|---|
| `speech.speak/v1` | Text/locale validation, utterance identity, supported interruption, accepted-versus-played evidence |
| `vision.capture/v1` | Camera descriptor, orientation/frame metadata, bounded output ArtifactRef, privacy/resource grant |
| `input.touch/v1` | Supported physical locations/events, duplicate/gap behavior, observed source |
| `motion.action/v1` | Installed semantic action catalog, vendor mapping, form/state preconditions, limits and resource lock |
| `motion.twist/v1` | Explicit supported axes; meters/second and radians/second; named coordinate frame; local finite lease; stop/timeout behavior |

For motion, a coordinate frame includes axis orientation and reference link; adapter conversion is explicit and tested. Unsupported axes are rejected instead of silently dropped. No generic `navigate_to` is synthesized from velocity unless a separately qualified navigation provider implements its goal/result/cancel semantics. Physical movement is not required to complete the first software MVP.

## ArtifactStore port

`ArtifactRef` contains opaque ID, media type, byte size, content digest and safe descriptive metadata. Trusted metadata separately records owner, installation/task, producer image/operation, validation profile and retention policy. The workload cannot self-attest provenance by sending these fields.

Writes use a bounded staging stream; verify digest/size and atomically publish an immutable object after closure. Read/transform/import require the actual resource grant. Paths are an internal implementation detail. Scene render input/output and media parser results cannot mount or overwrite arbitrary trusted state. Cross-node staging verifies source identity/content and returns a node-scoped internal handle; a path on node A is never treated as readable on node B.

## Scene and DisplayBackend ports

`SceneRef` identifies immutable scene content/version/format. `PresentRequest` contains SceneRef, schema-validated state, application revision, presentation lease request and output requirements. Host policy selects actual device priority and maximum lease. The result distinguishes rendered, imported, submitted and observed-visible evidence.

`DisplayBackend` describes accepted scene/artifact formats and supported feedback; it prepares/imports/presents, reports actual state when available, and restores the configured safe/default display. A backend may delegate HTML rendering to `RenderBackend`. A direct web backend does not require MP4 encoding.

Scene revision checks prevent stale unsent work. They do not retract an old RPC already inside a vendor service. A single player-agent serializes calls; unresolved calls keep unknown state. Strong latest-visible guarantees require verified device ordering/feedback. Sensitive scenes require player-side lease supervision and verified clear/fallback behavior.

The detailed authoring API, frozen timeline, capture/encode pipeline and interaction rules are specified in [scene rendering](scene-rendering.md).

## SandboxBackend and PackageRuntime ports

```typescript
interface SandboxBackend {
  qualify(profile: ApprovedRuntimeProfile): Promise<QualificationReport>;
  create(request: TrustedSandboxRequest): Promise<SandboxHandle>;
  execute(handle: SandboxHandle, request: BoundedExecRequest): Promise<ExecHandle>;
  stop(handle: SandboxHandle): Promise<CleanupEvidence>;
}
```

Only SandboxManager calls these methods. Public plugin input cannot choose arbitrary mounts, capabilities, devices, host network, daemon sockets, privileged flags or image references. A fixed digest/qualified platform/profile is resolved from the trusted installation record.

Exec specifies a fixed executable/argument vector, working directory handle, minimal environment, input/output limits and deadline. Never interpolate it into a host shell. If a Skill intentionally runs a shell, that shell and all descendants run inside the assigned sandbox with identical limits. Cleanup covers descendants and verifies task-owned resources only.

Qualification evidence is keyed by host kernel/runtime/image/profile/test-suite versions and actual settings. Changed inputs invalidate the relevant evidence. Do not report qualification from feature detection alone.

## AgentBackend and connector boundaries

AgentBackend receives a restricted tool catalog and result stream. It may suggest invocations, but cannot mint identities/grants/approvals or bypass execute-time broker checks. Model credentials are held by a separately authorized model route.

ConnectorBroker exposes semantic operations or an exact validated mapping of supported CLI-sidecar requests. It resolves account identity, enforces operation/resource policy, handles refresh and downstream idempotency, and filters results. A host allowlist alone is insufficient. Readonly may use POST on some APIs; risk classification belongs to a trusted operation catalog, not a blanket GET/POST rule.

## Core conformance scenarios

The planned suite must verify forged subject/grant rejection, unsupported capability/version, invalid units/axes, stale epochs, revoked queued calls, one-use/two-call budget races, cancellation before/after dispatch commit, same-key/different-body conflict, accepted-only providers, unknown after crash, cancellation without stop evidence, task/artifact ACLs, duplicate/gap events, scene revision handling and failed runtime qualification. See [the security specification](sandbox-permissions.md) for host-level negative scenarios.

# T007 Agent and MCP preparation

Planning input only. T007 remains todo and depends on accepted T006 interfaces.
The Feature engineering context owns the effective implementation plan. This
document does not establish an implemented SDK, model route or MCP capability.

## Execution and trust

The Agent engine and local MCP servers are separate untrusted sandbox workloads.
The trusted host does not import their entry modules or use an SDK's host process
launcher. A trusted MCP client adapter uses the qualified SandboxExecutionHandle
byte streams. Runtime/image/profile construction remains trusted administration.

For the batch demonstration the Agent receives a deterministic model transport
inside its sandbox. No actual model provider, account token, model SDK default
route or remote MCP endpoint is enabled. Pin and verify the selected Agent and
MCP SDK packages against their published APIs during implementation; do not infer
compatibility from a package name.

The Agent's tool catalog is a filtered view of current permission and installation
state. Tool suggestions are untrusted requests; every call rechecks the actual
bound channel and current policy. Descriptions, results, package Skills and
prompt text cannot construct identities, approvals or grants. A tool server also
has its own supervised installation/instance identity. Any delegated broker call
must retain the original caller and intersect explicitly permitted delegation;
the server's grants cannot silently become the caller's grants.

## Protocol and schema limits

Use bounded strict JSON framing before handing messages to the MCP SDK: fatal
UTF-8, duplicate-key rejection, finite nesting/string/message limits, bounded
pending IDs and per-message schema validation. Stdout carries protocol only;
stderr is bounded diagnostic output. Transport EOF, subprocess exit, MCP result
and confirmed cleanup are separate observations.

The installed package and trusted capability registration bind server namespace,
tool identity, argument/result schema digests and server/version epoch. Tool
discovery is untrusted metadata, not registration or permission. A changed tool
list cannot add an operation or widen a schema. Reject unsupported schema features
and external references rather than fetching or compiling unrestricted content.
Fix the supported JSON Schema subset and validation dependency before coding.

Disable server-initiated sampling, roots access, elicitation, arbitrary URL fetch,
host command execution and unknown extensions in the first subset. Unexpected
server requests receive a bounded unsupported response or terminate the session;
they do not recursively invoke a privileged host tool. Initialization, list/call,
notifications and cancellation each have an explicit allowed message set.

## Durable asynchronous invocation

Current T003's negotiated admission feature is specific to the simulator counter;
its synchronous provider port is not a general asynchronous MCP API. Preserve
that existing wire behavior. Before T007 implementation, define and independently
check the new generic tool feature/schema and its coexistence with the actual
T006 SQLite authority. The T007 write scope must explicitly include any necessary
Core/Policy adapter changes; a worker must not hide them in an SDK callback.

The generic intent binds a trusted registered capability/provider/version and
validated canonical arguments. The caller supplies no provider identity, epoch,
grant, lease or execution ticket. Idempotency binds the stable caller namespace,
request digest and original provider/version; a retry after restart or a version
change cannot create a new send right for an existing key.

Public invocation records a queued task. At the final trusted submission boundary
one SQLite transaction rechecks current permission/generation, lease, queued
cancellation, schema/provider binding and budget, then records dispatch and
consumes its one permitted use. Commit must finish before the asynchronous MCP
write. Hold no SQLite transaction across awaiting transport, tool execution or
cleanup. A failed commit sends nothing. Only a fresh committed decision permits
one send; an existing record authorizes query, not resend.

The crash interval between durable dispatch, transport write and result record
remains ambiguous. MCP request IDs and tool annotations do not prove external
idempotency or authoritative recovery. Preserve unknown after ambiguous failure;
do not automatically retry an invocation on reconnect, SDK recovery or startup.
Only a separately qualified provider observation/idempotency contract can resolve
the old operation without guessing.

## Cancellation, removal and lifetime

Queued cancellation competes with dispatch in the same transactional authority.
After dispatch, record cancellation as a request and use the provider's actual
supported cancellation mechanism. An MCP cancellation notification alone does
not prove the tool or an external effect stopped. Distinguish tool completion,
stop request, observed stop, unknown outcome and sandbox cleanup.

Use T006's separate trusted historical observation/cancellation authority after
removal; it cannot revive a retired workload channel or issue a new invocation.
Reject late results with wrong request/provider epoch or executor ownership and
retain bounded audit evidence. Cleanup after process failure never restarts or
replays an old tool call.

All sessions fit the qualified sandbox deadline. A server process is not granted
unlimited lifetime because MCP normally uses a persistent connection. Fresh
sessions may initialize for new tasks under current permission, but cannot resend
the old task. Explicitly define whether one server session owns one invocation
or several bounded calls; cancellation must identify every affected in-flight
operation and leave unrelated sandbox instances available.

Agent and MCP workloads share the actual trusted SandboxManager resource budget
across images. Two 768 MiB tool workloads consume the current 1536 MiB envelope;
a renderer/build cannot bypass it using another backend object. T006 must settle
the manager's restart and unconfirmed-cleanup reservations before this composition
is implemented.

For the first demonstration, use a bounded Agent turn and an MCP session that
owns one invocation. After its result or cancellation, finish that MCP session
and confirm its cleanup; a later invocation starts a fresh session without
resending an old task. An SDK's persistent-session default cannot retain the
second sandbox indefinitely.

T008 presentation must not make an Agent tool callback wait for a 1024 MiB
renderer while the 768 MiB Agent still holds its reservation. The candidate
handoff is a durable presentation acceptance from the trusted coordinator while
the caller lease is still live, followed by validated turn output and confirmed
Agent/MCP cleanup, before the coordinator's internal render stage starts. A
merely queued, undispatched generic tool task cannot survive by bypassing its
caller-lease check.
This is a planning constraint for the future negotiated presentation feature,
not an already supported T007 tool. See the
[serialized presentation handoff](t008-renderer-implementation-notes.md#serialized-presentation-handoff)
for permission, reference and recovery conditions. Align the actual feature,
schema and authority to accepted T006/T007 interfaces before implementation.

## Required evidence before acceptance

- A deterministic sandboxed Agent proposes an authorized tool invocation that
  crosses the real trusted admission boundary and local sandboxed MCP transport.
- Unsupported tools, changed discovery/schema, forged identity, stale version or
  epoch, private discovery/task access and administration requests are denied
  with zero unauthorized provider invocations.
- Tool descriptions/results and Skills containing prompt injection cannot widen
  the catalog or bypass the same invocation checks. Zero real model calls.
- Strict malformed framing, duplicate keys, partial/oversized messages, stdout
  noise, stderr floods, timeout, early exit, disconnect and output backpressure
  terminate or reject within bounded resource/cleanup behavior.
- Independent-process cancellation/dispatch and crash boundaries show one durable
  use, no send on denied commit, and no resend after an ambiguous send. Removal
  fences new work while trusted historical outcomes remain recordable.
- Actual Linux descendant cleanup, held peer availability, global composition
  limits, current-input cumulative tests and the unique usage CLI are checked.
  Freeze inputs and obtain independent source review plus primary acceptance.

The concrete SDK pins, schema validator, generic feature/migration and T006 API
alignment are unresolved implementation prerequisites, not completed work.

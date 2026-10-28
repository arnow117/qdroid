# qdroid usage

## USE-001: trusted reference-simulator capability journey

This is the current usage entry for the first milestone journey in [US-01 / US-02](../.sdlc-v1/context/REQ-MVP-001.product.md#用户故事-us-01--us-02--授权插件的最小闭环优先级p1).
It covers the T001 host-driver portion of AC-01 and AC-02 only. It is not Linux
sandbox qualification, device support, package installation, connector access, or
model execution.

The actor is a developer running the trusted fixture driver. The driver creates the
installation, supervised instance, boot identity, and operator fixture grant. A
JSON-RPC caller cannot supply a `principal`, `grantId`, `ticket`, or `instanceId`
as authority; strict request validation rejects those fields before simulator work.

### Prerequisites and parameter sources

- Use Node `24.16.x` with npm `11.13.x`. The tested local runtime was Node
  `v24.16.0`, which provides the `node:sqlite` API used by the trusted policy store.
- Install the repository's pinned development dependencies with no package scripts:

  ```sh
  npm install --ignore-scripts --no-audit --no-fund
  ```

- The fixed protocol value is `qdroid.rpc/v0.1`. The only supported capability is
  `sim.status.read/v1`, with schema `qdroid.capability.sim.status.read/v1` and an
  empty `arguments` object. Their owner is
  [the core interface contract](specs/core-interfaces.md#compatibility-and-transport).
- The fixture-only grant input is `--fixture allow`, `--fixture deny`, or
  `--fixture none`. It is consumed by trusted test-driver code; it is not an
  installation request or a public authorization API.

### Run the journey

Run the allowed host fixture:

```sh
npm run demo -- --fixture allow
```

The observed result includes `reference-simulator`, one simulator operation, and
two sanitized audit records: `admitted` and `succeeded`. Each has the same opaque
instance, grant, request-digest, admission, and task correlation values.

Run the explicit-deny fixture:

```sh
npm run demo -- --fixture deny
```

The observed result is `QD_PERMISSION_DENIED` and
`"simulatorOperationCount": 0`. The durable audit records the rejected admission
without raw request arguments or identity-like caller fields.

The commands above were run in the T001 local host-driver environment. Their output
labels the scope as `trusted host fixture only; this is not a Linux sandbox
qualification`.

### Failure feedback and recovery

`npm run demo -- --fixture unknown` exits with code `1` and prints:

```text
Usage: qdroid demo [--fixture allow|deny|none]
```

At the protocol boundary, malformed or unknown fields return
`QD_VALIDATION_FAILED`; an unsupported protocol version or required feature returns
`QD_INCOMPATIBLE_VERSION`; unsupported methods or capability schemas return
`QD_UNSUPPORTED_CAPABILITY`; a missing or denied grant returns
`QD_PERMISSION_DENIED`. Correct the request or choose the trusted fixture mode;
none of these failures performs a simulator operation.

An explicit active deny takes precedence over every active allow for the same
fixture subject and capability, regardless of grant creation order. Discovery and
invocation therefore both deny the capability, and no simulator operation occurs.
Fixture grants are append-only in T001; later grants do not silently deactivate an
earlier deny.

If admission storage is unavailable before dispatch, the runtime returns
`QD_PROVIDER_UNAVAILABLE` with recovery `retry-safe`; the provider has not run.
If a provider call or result journal fails after admission, the runtime returns
`QD_OUTCOME_UNKNOWN` with recovery `manual-reconcile` and the opaque `taskId` in
the error data. Use `tasks.get` with that task ID to inspect the durable `unknown`
state before any further action. Do not retry that request blindly: the provider
may already have run. The contract tests inject both provider and result-journal
failures to exercise this host-fixture recovery boundary; they do not qualify a
Linux workload recovery system.

The CLI creates temporary fixture state and closes it before exit. Do not treat
this driver as an external workload launcher. T002 is responsible for attaching a
supervisor-owned channel to a qualified Linux workload and for publishing any
sandbox evidence.

## USE-002: negotiated admission and persistent counter journey

This T003 journey adds `qdroid.admission/v1` to the existing `qdroid.rpc/v0.1`
channel. It uses `sim.counter.add/v1`, schema
`qdroid.capability.sim.counter.add/v1`, resource `counter.default`, an amount from
`1` through `10`, and a UTF-16-bounded idempotency key. The public protocol only
queues work and exposes `tasks.get` and `tasks.cancel`; dispatch and reconciliation
remain trusted broker operations.

Use the local fixture to run the normal queued-and-dispatched path:

```sh
npm run build
node dist/apps/cli/src/index.js admission-demo --fixture allow
```

The result has one provider attempt and one persistent counter effect. The task is
first queued, then the trusted fixture dispatches it exactly once. Reusing the same
key with changed input returns `QD_IDEMPOTENCY_CONFLICT`; it never creates another
provider effect.

Run cancellation before trusted dispatch, an ungranted request, and an attempt to
forge caller authority:

```sh
node dist/apps/cli/src/index.js admission-demo --fixture cancel-first
node dist/apps/cli/src/index.js admission-demo --fixture ungranted
node dist/apps/cli/src/index.js admission-demo --fixture forged
```

The cancellation journey ends with a canceled task and zero attempts/effects. The
ungranted request returns `QD_PERMISSION_DENIED`; the forged request returns
`QD_VALIDATION_FAILED`. Neither starts a provider operation.

Run the finite accepted-observation recovery path:

```sh
node dist/apps/cli/src/index.js admission-demo --fixture recovery
```

It records `dispatched`, waits for the persisted observation deadline, and records
`unknown` with one attempt and zero effects. The trusted fixture then completes the
same original provider operation and reconciles it by query; the result succeeds
with one attempt and one effect. It never sends the queued request a second time.

If a post-commit operation reports `QD_OUTCOME_UNKNOWN`, keep the original task ID.
Do not resubmit its idempotency key. First call `tasks.get`; a trusted broker can
then reconcile the original provider epoch's historical record. An unsupported or
deadline-expired observation remains `unknown` with no refund or replay. A new
executor may reconcile only after the old executor session has been fenced after a
confirmed exit.

For the fixed ARM64 Linux sandbox journey, build the changed fixture image on the
dedicated VM, then resolve immutable local image IDs for both trusted test
surfaces. The two names may resolve to the same immutable ID only when their
inputs are identical. The cumulative suite requires both values: the retained
T002/T003 fixture and the T004 offline-profile qualification matrix.

```sh
docker build --tag qdroid-t002:local fixtures/readonly-sim
docker build --tag qdroid-t004:local fixtures/readonly-sim
t002_image="$(docker image inspect --format '{{.Id}}' qdroid-t002:local)"
t004_image="$(docker image inspect --format '{{.Id}}' qdroid-t004:local)"
QDROID_T002_IMAGE="$t002_image" QDROID_T004_IMAGE="$t004_image" npm run test:linux
```

The Linux test must exit successfully before treating its records as evidence. It
uses the existing fixed gVisor profile and does not claim broader device or hardware
qualification.

The verified T003 image on 2026-10-26 was
`sha256:ba0d9c3ddb249ef76ea8a369b17de94e5cce92d4f88d67bfbdcf81b50e386f0f`.
The cumulative host and VM tests passed 60/60; the final Linux suite and an
independent public Linux CLI journey passed with all eleven scenarios. The normal
counter call produced one attempt/effect; cancel-first and both rejected modes
produced zero. Unknown recovery is a trusted fixture journey. The retained
first-run cleanup failure and exact manifest are in the engineering context.

### T002 Linux path: fixed first-call fixture

This path runs the first real sandboxed fixture for AC-01, AC-02, AC-04, and AC-05.
It was verified on dedicated ARM64 Linux with cgroup v2, Docker `29.2.1`, the
`qdroid-runsc` gVisor runtime (`--platform=systrap`, `--network=none`), and the
fixed Ubuntu 22 / Node 24.16.0 image inputs in
[the host profile](../profiles/hosts/qdroid-t002-readonly-sim.json). These VM paths
and the `/dev/vdb` device are development-fixture inputs, not T1 configuration.

The dedicated development VM was updated to fixed Engine/CLI `29.9.2` on
2026-10-28 after retained logs localized a Docker exit-event defect during a
backwards clock step. gVisor, images and isolation limits were preserved. The
version above describes historical acceptance; T004 has now verified the new
runtime fingerprint, the retained eleven call scenarios and three offline profiles
on this fixed ARM64 development environment.

Use Node `v24.16.0` and npm `11.13.0`. The broker requires the named runtime to be
registered before it starts; inspect it before running the suite:

```sh
export PATH=/opt/qdroid-tools/node-v24.16.0/bin:$PATH
docker info --format '{{json .Runtimes.qdroid-runsc}}'
```

The qualification-only I/O root must already be a private directory owned by the
broker user on Docker's `/dev/vdb1` backing partition. On the dedicated Linux VM,
an operator can prepare that empty directory with:

```sh
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" \
  /mnt/lima-colima-qdroid-t002/qdroid-t002-io
```

Build the fixture locally, resolve immutable IDs for both trusted Linux surfaces,
and run the cumulative qualification plus first-call scenarios:

```sh
docker build --tag qdroid-t002:local fixtures/readonly-sim
docker build --tag qdroid-t004:local fixtures/readonly-sim
t002_image="$(docker image inspect --format '{{.Id}}' qdroid-t002:local)"
t004_image="$(docker image inspect --format '{{.Id}}' qdroid-t004:local)"
QDROID_T002_IMAGE="$t002_image" QDROID_T004_IMAGE="$t004_image" npm run test:linux
```

To print the qualification report and all eleven scenario results from the public
CLI, use the retained fixture image:

```sh
npm run linux:demo -- --image "$t002_image"
```

The accepted T003 CLI journey used immutable image
`sha256:ba0d9c3ddb249ef76ea8a369b17de94e5cce92d4f88d67bfbdcf81b50e386f0f`.
It exited `0`; all eleven scenarios completed with exit `0` after consuming
their final response. The allowed status call performed one simulator operation,
and every rejected status call performed zero. Task containers and qualification
I/O files were absent afterward. Final T004 checks require their own current
source and image evidence in the Feature engineering context.

An earlier T002-only qualification on 2026-10-26 used
`sha256:91a138aa70d02bc0cc94b3293cd8f7d76763bcd542ea679f677dd00957125252`
and exited `0`. Its qualification observed a `16,777,216` byte cgroup read delta
in `15,957.337871` ms under the fixed `1,048,576` B/s I/O limit. Before the
sandbox-negative probe, the broker reached every existing synthetic control:
TCP/IPv4, UDP/IPv4, DNS-over-UDP using valid `qdroid.invalid` wire encoding, and
TCP/IPv6. Every per-protocol receipt was true; after counters were reset, the
sandbox-negative probe left their total at zero. The normal
allow scenario completed with one simulator operation and no error; none, deny,
active deny, forged authority, duplicate-key, and unsupported-method scenarios
completed with zero simulator operations and their expected denial or validation
codes.

The I/O file is a non-secret, broker-created, non-sparse `0644` synthetic file.
The manager requests cache eviction only for that file, binds it read-only at the
fixed `/opt/qdroid/io-probe.bin` destination only during qualification, verifies
the mount, and removes it afterward. Normal workloads receive no host mounts,
host-path parameters, Docker socket, source tree, credentials, devices, or host
execution. Qualification also uses a manager-owned fixed `docker exec` action to
inspect the guest process table; the observer excludes itself and accepts only a
separate child of workload PID 1.

`QDROID_T002_IMAGE` is trusted operator input selecting an already local immutable
fixture image; it is not a workload-controlled image or Docker-options interface.
The manager binds qualification to the live boot, kernel, architecture, Docker,
runtime components, profile, image, and suite fingerprint. A stale or foreign
qualification handle is rejected.

### Linux failure feedback and support boundary

Omitting both image variables exits nonzero with
`QDROID_T002_IMAGE, QDROID_T004_IMAGE is required for the real Linux fixture suite.`
If only one is missing, the bounded error names that variable. A missing image,
profile mismatch, failed qualification, or runtime failure fails closed before the
first-call scenarios; the implementation never falls back to runc or host
execution. Preserve the bounded error and cleanup evidence, then correct the
trusted VM configuration or image selection before retrying.

This result covers one fixed ARM64 Linux profile, the supervisor-owned stdio
`sim.status.read/v1` first-call fixture, and the bounded T003 admission journey
for `sim.counter.add/v1`: trusted queue dispatch, cancel-first, forged and
ungranted rejection, and unknown-to-authoritative-query recovery. It does not
support package installation, external MCP servers, models, display, real
accounts, robot hardware, or later work beyond this fixed fixture. The
implementation and evidence are tracked in
[T002](https://github.com/arnow117/qdroid/issues/4),
[T003](https://github.com/arnow117/qdroid/issues/5), and the
[engineering context](../.sdlc-v1/context/FEAT-MVP-001.engineering.md).

## USE-001 / USE-002: offline sandbox-backend qualification

T004 has accepted the trusted `SandboxBackend` path for `tool-offline`,
`build-restricted`, and `render-offline`. A package does not call this API. The
trusted manager selects an already-local immutable image, a code-owned profile,
and the supervised identity before it creates a sandbox. The first three profiles
all have `network=none`; `build-restricted` receives content from a future trusted
fetch service and does not receive direct registry access. Render qualification
does not claim Chromium or MP4 support.

Use the dedicated ARM64 Linux VM and images that satisfy the fixed T002
preconditions. After building the two fixture tags in the preceding Linux
section, resolve both immutable IDs for the cumulative suite:

```sh
t002_image="$(docker image inspect --format '{{.Id}}' qdroid-t002:local)"
t004_image="$(docker image inspect --format '{{.Id}}' qdroid-t004:local)"
QDROID_T002_IMAGE="$t002_image" QDROID_T004_IMAGE="$t004_image" npm run test:linux
```

The T004 case qualifies every profile/image tuple separately, then checks binary
stdio round-trip, EOF, task-owned cancellation and peer survival. It uses a
private cleanup journal owned by the trusted manager. A foreign, malformed, or
future-version record remains for investigation; it never restores execution
authority. The manager admits at most two active sandboxes and reserves their
declared memory until cleanup is confirmed. Its total active memory limit is
1536 MiB, so two 1024 MiB profiles are not admitted together.

Execution completion and cleanup confirmation are separate results. The trusted
fixture retains the original completion, then explicitly stops each completed
handle that has not already received a stop. It requires that owning backend's
final `status=confirmed` and `cleanupConfirmed=true` before admitting the next
independent scenario. A later confirmation does not change the first result or
turn an execution failure into success. Pending or unknown final cleanup fails
the journey and retains its evidence and reservation; the fixture does not loop
or replay the workload.

The execution journal does not establish complete crash recovery for all legacy
and profile qualification resources. Executable installer integration requires
the planned durable qualification session to cover those resources before it
can release a crashed qualifier's reservation. An empty execution journal is
insufficient cleanup evidence. Cross-image, node-wide admission is also a later
integration; the current backend's counters are local to that backend.

To run only the T004 public trusted-manager journey after building, use:

```sh
npm run sandbox:demo -- --image "$t004_image"
```

Failure to qualify, a stale handle, an unknown profile, an unavailable guardian,
or unconfirmed cleanup fails closed. Stop the affected task and inspect the
trusted manager evidence; do not retry a workload by using host execution or by
altering a package profile. This remains a fixed Linux development qualification,
not T1, real-account, package-installation, network-enabled build, Chromium, or
media support.

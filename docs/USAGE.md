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

### T002 Linux path: fixed first-call fixture

This path runs the first real sandboxed fixture for AC-01, AC-02, AC-04, and AC-05.
It was verified on dedicated ARM64 Linux with cgroup v2, Docker `29.2.1`, the
`qdroid-runsc` gVisor runtime (`--platform=systrap`, `--network=none`), and the
fixed Ubuntu 22 / Node 24.16.0 image inputs in
[the host profile](../profiles/hosts/qdroid-t002-readonly-sim.json). These VM paths
and the `/dev/vdb` device are development-fixture inputs, not T1 configuration.

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

Build the fixture locally, resolve its immutable ID, and run the complete Linux
qualification plus seven first-call scenarios:

```sh
docker build --tag qdroid-t002:local fixtures/readonly-sim
image_id="$(docker image inspect --format '{{.Id}}' qdroid-t002:local)"
QDROID_T002_IMAGE="$image_id" npm run test:linux
```

To print the qualification report and all seven scenario results from the public
CLI, use the same local image:

```sh
npm run linux:demo -- --image "$image_id"
```

The CLI journey was independently run on the same frozen source and image. It
exited `0`; every scenario completed with exit `0` after consuming its final
response. The allowed call performed one simulator operation, and every rejected
call performed zero. Task containers and qualification I/O files were absent
afterward.

The verified 2026-10-26 invocation used
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

Omitting `QDROID_T002_IMAGE` exits nonzero with
`QDROID_T002_IMAGE is required for the real Linux fixture suite.` A missing image,
profile mismatch, failed qualification, or runtime failure fails closed before the
first-call scenarios; the implementation never falls back to runc or host
execution. Preserve the bounded error and cleanup evidence, then correct the
trusted VM configuration or image selection before retrying.

This result covers one fixed ARM64 Linux profile and the supervisor-owned stdio
`sim.status.read/v1` first-call fixture. It does not support package installation,
external MCP servers, models, display, real accounts, robot hardware, or the
concurrency and recovery work assigned to later tasks. The implementation and
evidence are tracked in [T002](https://github.com/arnow117/qdroid/issues/4) and
the [engineering context](../.sdlc-v1/context/FEAT-MVP-001.engineering.md).

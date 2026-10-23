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

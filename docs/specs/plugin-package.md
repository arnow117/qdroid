# Plugin package specification

Status: proposed `qdroid.plugin/v0.1`, 2026-10-23. This is a design contract; the installer, schema validator and registry client are not implemented. Examples are illustrative, not installation commands or published packages.

## Package classes

| Kind | Content | Execution/trust |
|---|---|---|
| `application` | App logic, Skills, Scene/input definitions, tool dependencies | Untrusted app instance; granted capability channel |
| `tool` | CLI/MCP entrypoint, Skills, platform variants | Untrusted isolated tool process |
| `renderer` | Scene/artifact transformations | Untrusted no-credential render profile |
| `device-adapter` | Vendor integration and capability implementation | Administrator-installed trusted device service |
| `host-backend` | Host/runtime isolation integration | Administrator-installed trusted infrastructure |

The first three use the application installation path. The last two require a separate explicit admin workflow and qualification. A signed tool package cannot promote itself to a device adapter at runtime. All classes remain subject to their content licenses.

An Agent Skill is a directory of instructions/resources, not an executable permission model. Skill installation, runtime dependency resolution and account authorization are separate operations.

## Layout

```text
package/
  qdroid.plugin.json
  qdroid.lock.json
  README.md
  LICENSE
  skills/
    lark-calendar/
      SKILL.md
      references/
  scenes/                  # optional supported Scene formats
  assets/                  # optional immutable resources
  attestations/            # build/source/SBOM/provenance metadata
```

Executable dependencies normally reside in fixed-digest OCI images, not arbitrary host install hooks. A simple content-only Skill package may have no executable variant. Referenced files must remain within the frozen package root. Content digests cover the manifest, lock, Skills and assets; archive hashes are separately recorded when transport bytes matter.

`README` explains capability requests and expected side effects. It must not claim installation grants permissions or that a signature proves safety.

## Manifest fields

| Field | Required | Semantics |
|---|---|---|
| `schema` | Yes | Exact supported manifest schema, initially `qdroid.plugin/v0.1` |
| `kind` | Yes | Installation class from the table above |
| `name`, `version` | Yes | Stable publisher-qualified name and immutable semantic version |
| `license` | Yes | SPDX expression or explicit license-file reference |
| `engineCompatibility` | Yes | Supported qdroid API range, resolved against host version |
| `entrypoint` | For executable kinds | Typed command/stdio-MCP/app entrypoint inside a resolved image |
| `runtimeVariants` | For executable kinds | Platform/ABI/image digest and required runtime properties |
| `skills`, `scenes`, `assets` | As used | Package-root-relative content paths and supported format/version |
| `dependencies` | As used | Pinned package/tool references, resolved into lock |
| `requestedCapabilities` | Yes, may be empty | Typed operation/resource requests, never actual grants |
| `requestedResources` | Yes | Upper-bound resource request; host policy may reduce it or refuse |
| `configurationSchema` | As used | Validated non-secret settings; secret references resolved only by brokers |

Reject unknown authorization/runtime fields and duplicate JSON keys. Optional extensions must live in a separately versioned, explicitly supported extension namespace. A new required field/semantic behavior cannot be ignored as an additive upgrade. Version ranges in source declarations must resolve to exact content in the installation lock.

## Illustrative tool package

The example image digest is a synthetic fixture, not a real image. Resource values are requested limits for discussion, not measured T1 capacity or installed defaults.

```json
{
  "schema": "qdroid.plugin/v0.1",
  "kind": "tool",
  "name": "qdroid/lark-calendar",
  "version": "0.1.0",
  "license": "Apache-2.0",
  "engineCompatibility": ">=0.1.0 <0.2.0",
  "entrypoint": {
    "type": "command",
    "executable": "/opt/tools/lark-cli",
    "argumentSchema": "schemas/calendar-arguments.json"
  },
  "runtimeVariants": [
    {
      "platform": "linux/arm64",
      "image": "registry.example/qdroid/lark@sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "requiredProfile": "connector-readonly",
      "requiredFeatures": ["filesystem-isolation", "enforced-egress", "host-resource-limits"]
    }
  ],
  "skills": ["skills/lark-calendar"],
  "requestedCapabilities": [
    {
      "id": "connector.lark.calendar.read/v1",
      "operations": ["calendar.listEvents"],
      "resourceSelector": {"type": "configured-calendars"}
    }
  ],
  "requestedResources": {
    "memoryMiB": 256,
    "pids": 32,
    "scratchMiB": 64,
    "outputBytes": 1048576,
    "deadlineMs": 30000
  }
}
```

An actual package must include the argument schema it references, an SPDX-compliant license expression covering its own material, and separate notices/licenses for the Lark binary and dependencies. `/opt/tools/lark-cli` is resolved inside the locked image. The host does not execute that path on the trusted filesystem.

A calendar-card application may depend on this tool and separately request display presentation. Its renderer and tool processes have attenuated identities; the renderer does not inherit calendar access or sidecar keys. Multi-component applications cannot turn one task grant into shared unlimited privileges across all components.

## Lock and provenance

`qdroid.lock.json` records exact manifest/asset/Skill content digests, package dependency resolutions, source commits, image digests/platforms, executable build identity, SBOM/license references, qdroid schema versions, and build attestation references. Host-approved installation records separately select a qualified runtime profile; package bytes cannot self-attest qualification.

For an executable platform variant, include OS, CPU architecture and any required libc/ABI or native runtime constraints. `linux/arm64` is not a claim that every ARM64 firmware or kernel is compatible. Pure instruction content can be shared across variants, while binaries/images remain platform-specific.

Content-addressed dependencies are immutable. Updating a tag or repository branch does not change an installed package. Installed tasks retain their resolved package and image digests until they finish or are canceled.

## Installation lifecycle

```text
fetched → staged → validated → resolved → installed-disabled
                                        ↓ explicit policy/grants + qualification
                                     activated → running instances
```

1. Resolve approved source and exact version; fetch through the bounded fetch service. Repeated install of the same digest must not duplicate active instances or grants.
2. Extract into trusted-owned, non-shared staging. Enforce path/link/type/size/count/compression limits and reject ambiguous duplicate entries. Do not follow a mutable link after validation.
3. Validate manifest/schema, referenced files, content/transport hashes, licenses and compatibility. Show any trust/publisher status accurately.
4. Resolve dependencies into immutable lock. Build scripts, if needed, execute only in no-credential build sandboxes with approved registries and limits. Prefer published ARM64/AMD64 images to compiling arbitrary native modules on the robot.
5. Register the installation as disabled. Signature verification and package validation do not create a Grant.
6. Obtain necessary operator decisions and accounts through their trusted flows. Select a backend/profile only after actual qualification for the host.
7. Activate atomically; supervise instances and bounded readiness/health checks. Those checks run with the same restricted permissions as the package.

The application pipeline has no `postinstall` on the trusted host, no arbitrary systemd/unit edits, and no plugin-supplied runtime-manager flags. Infrastructure packages follow the separate admin path.

## Upgrade, revocation and removal

Compare manifest permissions, trust class, image/platform requirements, broker operations, resources and sources before upgrade. Additional requested rights stay ungranted until authorized. No in-place mutation of a running task's files or image.

Serialize activation, rollback and removal for the same installation. Prepare candidate immutable content outside the lock, but commit active selection using `installationGeneration` and `expectedActiveDigest`; persist the attempt identity and result. A failed activation can roll back only if it still owns the active generation/digest. A late failure from candidate A cannot replace successful candidate B or resurrect a removed installation. Retain immutable content referenced by running tasks; garbage collection must not delete it during lifecycle changes. None of these operations restore revoked permissions.

Revoking a Grant increments policy generation and prevents queued future dispatch. Stop affected workloads and request cancellation of dispatched operations according to actual guarantees. Removing a package does not automatically revoke the user's external OAuth authorization; offer an explicit separate account-management operation. Clean private scratch, scene caches, proxy keys and package-owned state according to retention policy, while preserving required non-secret audit evidence.

## CLI and MCP execution

Use argument vectors and validated stdin; avoid string interpolation in a host shell. CLI execution may intentionally include a shell only inside the sandbox. Configure a minimal environment; no inherited host credential variables or user Home. Package working directories and file inputs use scoped workspace/artifact handles.

For stdio MCP, reserve stdout for JSON-RPC and capture bounded stderr. Enforce initialization timeout, tool namespace/schema pinning, per-call timeout, max message/output size and cancellation/descendant cleanup. Tool annotations and descriptions are untrusted metadata, not authorization. A server/tool-list change cannot add permitted operations automatically; revalidate against the installed package/grant version.

Remote MCP requires an explicitly configured connection/auth policy, restricted discovery/redirect URLs, actual operation authorization and isolated external credentials. Arbitrary marketplace remote MCP endpoints are outside the first executable MVP.

## Conformance cases

The planned installer suite covers missing/referenced files, invalid/unknown manifest fields, duplicate keys, semver/schema mismatch, unpinned or wrong-platform images, digest mismatch, archive traversal/link/race/bomb cases, dependency build attempting credential/network access, new permissions on upgrade, interrupted atomic activation, two interleaved candidate activations and late rollback, upgrade/removal races, running-task artifact retention, grant revocation during queueing, MCP child-process cleanup and removal of private state.

See [core interfaces](core-interfaces.md) and [sandbox permissions](sandbox-permissions.md) for the execution authority behind the package format.

# Plugin package specification

Status: proposed `qdroid.plugin/v0.1`, 2026-10-23. This is a design contract; the installer, schema validator and registry client are not implemented. Examples are illustrative, not installation commands or published packages.

## Package classes

| Kind             | Content                                                       | Execution/trust                                    |
| ---------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| `application`    | App logic, Skills, Scene/input definitions, tool dependencies | Untrusted app instance; granted capability channel |
| `tool`           | CLI/MCP entrypoint, Skills, platform variants                 | Untrusted isolated tool process                    |
| `renderer`       | Scene/artifact transformations                                | Untrusted no-credential render profile             |
| `device-adapter` | Vendor integration and capability implementation              | Administrator-installed trusted device service     |
| `host-backend`   | Host/runtime isolation integration                            | Administrator-installed trusted infrastructure     |

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

| Field                        | Required                  | Semantics                                                                                        |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| `schema`                     | Yes                       | Exact supported manifest schema, initially `qdroid.plugin/v0.1`                                  |
| `kind`                       | Yes                       | Installation class from the table above                                                          |
| `name`, `version`            | Yes                       | Stable publisher-qualified name and immutable semantic version                                   |
| `license`                    | Yes                       | SPDX expression or explicit license-file reference                                               |
| `engineCompatibility`        | Yes                       | Supported qdroid API range, resolved against host version                                        |
| `entrypoint`                 | For executable kinds      | Typed command/stdio-MCP/app entrypoint inside a resolved image                                   |
| `runtimeVariants`            | For executable kinds      | Platform/ABI/image digest and required runtime properties                                        |
| `skills`, `scenes`, `assets` | As used                   | Package-root-relative content paths and supported format/version                                 |
| `dependencies`               | As used                   | Pinned package/tool references, resolved into lock                                               |
| `build`                      | When source must be built | Versioned offline command, output format and exact generated-file export list; never a host hook |
| `requestedCapabilities`      | Yes, may be empty         | Typed operation/resource requests, never actual grants                                           |
| `requestedResources`         | Yes                       | Upper-bound resource request; host policy may reduce it or refuse                                |
| `configurationSchema`        | As used                   | Validated non-secret settings; secret references resolved only by brokers                        |

Reject unknown authorization/runtime fields and duplicate JSON keys. Optional extensions must live in a separately versioned, explicitly supported extension namespace. A new required field/semantic behavior cannot be ignored as an additive upgrade. Version ranges in source declarations must resolve to exact content in the installation lock.

Manifest versions use canonical SemVer spelling. Reject a `v` prefix and leading
or trailing whitespace instead of admitting another immutable-version key for
the same spelling after normalization. Preserve canonical prerelease and build
metadata in the version identity. A content-only installation rejects a `build`
declaration before staging or runtime effects; it cannot silently skip a declared
build and register an installation with missing output.

## Versioned dependency declarations

The selected graph format uses `qdroid.plugin/v0.2` with a matching
`qdroid.lock/v0.2`. Direct dependencies are exact `{name, version, sourceId}`
records; the source lock repeats the same canonical declarations and binds the
node's input-content digest. The approved host catalog supplies each source's
transport digest and byte limit. The external trusted resolved graph records
the actual complete content/catalog identities. Dependency declarations convey
no URL, host path, network permission or recursive artifact hash authority.
V0.1 remains a single-package format and rejects dependency fields.

Resolve and validate the entire graph before staging or execution. Include the
root in32 distinct package keys, use root depth0 with at most8 dependency edges,
and bound unique transports/expanded archives to64/128MiB. Reject cycles,
conflicting key/source bindings and duplicate edges. Dependencies remain private
root-installation materials; declared builds run in dependency order under the
same managed owner and original sandbox limits. No child installation, service
or grant is created automatically. Unsupported platform/catalog composition
rejects before effects. The effective T005 engineering plan defines retained
node proof, read-only reuse and preserving registry migration; this specification
does not claim the graph implementation has passed acceptance.

The retained graph-material JSON uses the same256KiB metadata limit on writing
and reading. Validate the complete sealed graph and node materials before the
atomic disabled registration; an oversized or unreadable record cannot leave a
committed root installation. Semantic graph equality is distinct from a
candidate's physical proof paths: identical reuse verifies and returns the
original winner's immutable references.

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
      "resourceSelector": { "type": "configured-calendars" }
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

## First installer subset

This section fixes the T005 implementation input. It is not an installer-support claim. The application installation path accepts only `application`, `tool`, and `renderer`; infrastructure kinds remain outside this path. A content-only application may omit executable variants. An executable variant must match the actual host OS, CPU and approved ABI; an unsupported or ambiguous variant is rejected.

### Trusted image assembly

For this subset, a variant's image declaration requests a base from a trusted runtime catalog. The resolver checks its local immutable image ID, platform, ABI and approved configuration. A declaration or package attestation cannot approve an image. The fixed assembly template may use only that catalog base, not an arbitrary package-selected `FROM`. The base has no `ONBUILD` triggers, implicit writable `VOLUME`, or automatic health-check command. This prevents inherited build commands and undeclared execution or storage; Docker's [ONBUILD semantics](https://docs.docker.com/reference/dockerfile/#onbuild) apply even when the child Dockerfile is fixed.

Assembly only copies validated, frozen payload into fixed package directories. It does not run package code, use package-controlled builder flags/context paths, perform remote `ADD`, or expose host build credentials, sockets or bind paths. Declared source/dependency identifiers resolve through trusted fetch policy. A registry name, source URL or image digest in a package is a request, not fetch or builder authority.

### Archive dialect and limits

The transport format is `qdroid.bundle/ustar-v1`: uncompressed POSIX USTAR or one gzip-compressed USTAR archive. Entries are root-relative files and directories; `qdroid.plugin.json` and `qdroid.lock.json` are at the archive root. PAX/GNU extensions, sparse entries, links, devices, FIFOs and other types are unsupported and reject the candidate. Gzip integrity, tar checksums, complete bodies, two terminal zero blocks and zero-only final padding are required; trailing or concatenated content is rejected.

Paths use ASCII letters, digits, `_`, `-`, and `.` within components, with `/` separators. Reject absolute/drive paths, backslashes, control/NUL bytes, empty or dot components, upward traversal, duplicate paths, case-fold aliases, and file/directory ancestor conflicts. A directory's single trailing slash identifies the same directory path and cannot hide a duplicate. Allow file modes `0644` or `0755` and directory mode `0755`; reject other requested modes. The trusted writer assigns ownership, normalizes timestamps and freezes files as read-only, preserving only the declared executable distinction.

Initial hard limits are 16 MiB transport, 32 MiB expanded archive, 8 MiB per file, 1024 entries, depth 16, path length 240 bytes, component length 64 bytes, and gzip expansion ratio 100. Metadata JSON is at most 256 KiB and depth 64, decoded as strict UTF-8 with duplicate keys and isolated surrogates rejected. Trusted policy may reduce limits; package declarations cannot raise them.

Validation and extraction consume the same frozen bytes. A maintained tar parser may decode the supported format, but ignored entries, warnings, path rewriting and sanitization do not count as acceptance. Validate effective entry semantics and conflicts before writing each entry into private, trusted-owned staging. Neither the source nor an extracted file may be swapped through a mutable link between validation and use. A rejected candidate never changes registered or active content.

### Acyclic identities

All inventories use canonical JSON with a versioned schema, bytewise-sorted canonical paths, entry type, normalized executable mode, file length and SHA-256 of exact file bytes. Directory presence is included. No filesystem timestamps or archive ownership claims enter the identity.

| Identity             | Computed from / recorded by                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| Transport digest     | Exact fetched archive bytes; trusted fetch receipt outside the archive                                        |
| Input-content digest | Frozen manifest and payload inventory, excluding `qdroid.lock.json`                                           |
| Package digest       | The complete frozen input inventory, including the source lock                                                |
| Resolved-lock digest | Trusted resolver's canonical exact source/dependency/platform/base selection, kept outside package bytes      |
| Build-input digest   | Package/resolved-lock digests, declared build operation and pinned toolchain/profile identity; trusted record |
| Build-output digest  | Canonical inventory of fully received, validated generated files; trusted record                              |
| Final image ID       | Actual assembled immutable image; trusted installation record outside that image                              |

The source lock may refer to the input-content digest and exact dependency/base identities. It cannot contain its own digest, the enclosing transport/package digest, a future build-output digest or its final assembled image ID. An embedded attestation is a publisher claim; the trusted receipt records actual resolver/build/assembly facts. This keeps hashes acyclic while the package digest still covers the source lock.

### Offline build output

The optional build declaration uses `qdroid.build/stdout-ustar-v1`: a container executable/argument vector, fixed package working directory and exact regular-file export list under reserved `generated/`. Source payload cannot occupy that reserved tree. Trusted catalog selection determines the builder image and qualified `build-restricted` profile. Dependencies arrive through the trusted fetch/resolver before execution; the build has no credentials or direct network access.

Stdout contains exactly one complete USTAR output archive using the encoding, integrity and safety rules of `qdroid.bundle/ustar-v1`; stderr is bounded diagnostic data. The build-output format does not inherit the installation bundle's required manifest/lock files: it contains only the declared generated files. Exports are at most 8 MiB total and 256 files, also subject to the backend's aggregate byte, memory and time limits. Completion requires valid stream termination, exit code zero, confirmed descendant cleanup and full output validation. Exit zero or EOF alone is insufficient.

Outputs pass the same path/type/size/conflict checks and have their digests recomputed by the trusted receiver. They cannot replace source manifest/lock, permission requests, dependency selections or trusted provenance. Only after validation does fixed assembly copy generated files alongside frozen inputs. Partial, missing, undeclared, conflicting or malformed output fails installation; it cannot register a disabled package.

### Disabled registration and recovery

Installation ownership comes from the trusted operator context. A logical installation slot is keyed by owner, publisher-qualified package name and target platform; content-only packages use an explicit content target. The slot has one stable installation identity across its immutable versions. The immutable-version key adds the package version, and its version-record identity is distinct from the slot identity and a running instance. A different package or build-input digest under that version key is a conflict. The same package and build-input digests return the existing version without another instance or grant. Concurrent builds with different validated output digests conflict; identical outputs cannot overwrite an already selected image/record.

Seal and durably store the complete inputs, resolved lock, generated files, actual image and trusted receipt before one atomic registry transaction publishes `installed-disabled`. A crash before that transaction leaves an unregistered candidate; a crash after it returns the same disabled record on retry. Recovery may clean identified uncommitted candidates but cannot replace a committed record, grant permissions, execute a package or change an active pointer. Activation, rollback, removal and running-version references remain T006 responsibilities.

Final immutable images can be shared across candidates. The first installer therefore retains sealed final images and their receipts after an uncommitted candidate fails or crashes; candidate recovery never automatically removes these images. It may clean only precisely owned temporary assembly containers and staging resources. Another candidate can publish the same image concurrently. Storage admission remains bounded, and later image collection must serialize registry references/publication with its collecting state rather than check for references and then delete asynchronously.

## Installation lifecycle

```text
fetched → staged → validated → resolved → installed-disabled
                                        ↓ explicit policy/grants + qualification
                                     activated → running instances
```

1. Resolve approved source and exact version; fetch through the bounded fetch service. Repeated install of the same digest must not duplicate active instances or grants.
2. Extract into trusted-owned, non-shared staging. Enforce path/link/type/size/count/compression limits and reject ambiguous duplicate entries. Do not follow a mutable link after validation.
3. Validate manifest/schema, referenced files, content/transport hashes, licenses and compatibility. Show any trust/publisher status accurately.
4. Resolve dependencies into immutable lock. The trusted bounded fetch service obtains approved, digest-pinned dependency bytes. Build scripts, if needed, execute only in no-credential, offline build sandboxes with those prepared inputs and qualified limits. Prefer published ARM64/AMD64 images to compiling arbitrary native modules on the robot.
5. Register the installation as disabled. Signature verification and package validation do not create a Grant.
6. Obtain necessary operator decisions and accounts through their trusted flows. Select a backend/profile only after actual qualification for the host.
7. Activate atomically; supervise instances and bounded readiness/health checks. Those checks run with the same restricted permissions as the package.

The application pipeline has no `postinstall` on the trusted host, no arbitrary systemd/unit edits, and no plugin-supplied runtime-manager flags. Infrastructure packages follow the separate admin path.

The first executable subset uses `tool-offline`, `build-restricted`, and `render-offline`, all with `network=none`. A package cannot request direct registry access by selecting a build profile. Validated package files enter an immutable image through a trusted, fixed assembly template; a package-supplied Dockerfile is never executed by the trusted host builder. Workloads cannot select host bind paths. A future network-enabled profile requires its own interface contract and actual qualification before use.

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

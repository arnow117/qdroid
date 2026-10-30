# T005 executable graph package-runtime unit contract

Selected after independent read-only interface and split review with no remaining
P1/P2. This independently verifiable graph installer/material-retention unit is
not a replacement for the current boundary implementer or a new diagnostic
segment. Root retains full T005 acceptance and all history. The original
producer confirms boundary/network WIP neither modifies nor needs the exclusive
package-runtime index/archive/package-test paths below, provided existing
BuildSession owner/operation/journal behavior and ResourceOps contracts remain.
Root explicitly transfers those paths to the graph unit until its acceptance.
Protocol approval does not establish implementation or production graph support.

## Unit goal and exclusive boundary

Complete the accepted v0.2 executable graph package-runtime orchestration,
retained material/registry/reuse and opaque prepared graph data against a trusted
Mock runtime port. Preserve the complete current graph limits, source pinning,
archive rules, v0.1/content-only behavior and all existing owner/cleanup semantics.
The original producer separately implements actual ResourceOps/guardian multi-
node copy, qualification/execution/T004 recovery and all dedicated Linux/final
integration. A Mock unit pass is not production graph support or T005 completion.

Exclusive implementation paths: packages/package-runtime/src/index.ts,
archive.ts only if actual resolver/expanded-byte fixes are necessary, new private
package-runtime graph modules, tests/packages/install/installer.test.ts and new
graph-specific tests/helpers there. Do not change existing BuildSession,
BuildAuthority/recovery/publication/retirement primitive implementations; use
them as-is. Prepared-input registry/material helper extensions are in scope only
for the new graph branch. Do not edit tests for session-runtime/build-executor/
assembler, any runtime-oci/supervisor/backend/CLI/consumer files, root contexts,
Plan/specs/state/Git/GitHub. No VM, Docker or external service/model/account calls.
Same new unit worker owns implementation/tests/corrections through acceptance;
after acceptance root explicitly transfers these files back to the producer.

## Compatibility and fail-closed production boundary

All existing exported BuildSession types/functions and their behavior remain
unchanged. V0.1 material/identity formulas and all existing port fields retain
their exact meanings. Add only optional graph metadata for the new v0.2 branch.
No package/CLI argument can claim graph/runtime/owner authority.

Add a narrow trusted-factory capability declaration, for example readonly
supportsGraphMaterialV1?: true. A v0.2 executable graph requires an explicitly
capable trusted factory BEFORE staging, authority/database/resource effects or
factory creation, at the current unsupported-graph preflight. Existing factories
without this declaration keep rejecting executable graphs; the production OCI
factory remains unchanged and incapable during this unit. Only private test
factories declare support. The original producer later advertises it only after
real registered multi-node copy/verification/recovery paths are complete. This
declaration is trusted constructor DI, never a package field, CLI switch,
permission grant, sandbox qualification or bypass of other readiness checks.

## Settled additive material port

Keep all current ImageAssemblyRequest/SealedImageVerification/
PreparedAssemblyMaterial fields. Add an optional graph value for the graph branch;
the following data contract is selected (readable names may vary, semantics may
not). Both request and retained verification carry the same data through private
identity registration; runtime adapters read it only from the actual opaque
prepared capability, never from caller-provided lists.

```ts
interface PreparedGraphNodeMaterial {
  readonly packageDigest: string;
  readonly packageDirectory: string;
  readonly sourceInventoryDigest: string;
  readonly buildOutputDirectory?: string;
  readonly generatedOutputDigest?: string;
}

interface PreparedGraphAssemblyMaterial {
  readonly schema: 'qdroid.prepared-graph-assembly/v1';
  readonly graphInputDigest: string;
  readonly rootPackageDigest: string;
  readonly stepNodePackageDigest: string;
  readonly nodes: readonly PreparedGraphNodeMaterial[];
  readonly resolvedMapping: readonly Readonly<{
    name: string;
    version: string;
    packageDigest: string;
  }>[];
  readonly graphMaterialDigest?: string;
}
```

For a node builder, nodes/mapping are its exact validated transitive dependency
closure plus the step node, dependency-first. Only completed child outputs are
included, not future/self outputs or the builder's own future image/receipt.
For final runtime, include the full validated graph and require graphMaterialDigest
from the final retained graph seal. Step packageDigest remains the existing
material.packageDigest; candidateId stays the one root candidate. Root owner
packageDigest never changes. Paths are canonical installer-owned retained paths;
generated fields are present together. Fixed guest paths derive from packageDigest,
never host paths or caller mapping strings. resolvedMapping is a canonical logical
key map; the production adapter later emits /opt/qdroid/resolved-graph.json with
fixed /opt/qdroid/packages/<digest>/{source,generated} locations. No new workload
environment variables or dependency auto-start behavior.

Register the validated root graph/members privately once for the actual owner.
Reject a prepared graph request that names an unregistered/missing/foreign member
or wrong closure/step/output, including structural clones and replay of the same
prepared capability after unknown. This is no exported registration method.
Extend prepared material assertion to revalidate EVERY registered source and
generated inventory from retained bytes, with existing nofollow/alias/descriptor
rules. Keep the actual frozen entry arrays and validated outputs in private
registration, not trusted caller hashes. Existing v0.1 capability lookup and
one-claim behavior remain unchanged.

Graph materialDigest canonically binds the complete graph input plus step,
closure source/generated identities, resolved map and graph seal digest where
required. Keep old formulas for graph-absent requests. The existing v2 managed
receipt's materialDigest can bind this new graph/step identity transitively;
do not invent acceptance of extra/unversioned receipt keys or relabel old data.
For graph-only template extension, bind a fixed code-owned graph-copy template
schema/digest together with the approved base template identity; never claim an
unchanged v0.1 template for a different layout. Keep every approved catalog,
platform/ABI/toolchain/profile identity in graph input material.

## Full graph orchestration and retention

Resolve and preflight ALL nodes/catalog/ABI/build declarations before staging or
runtime effects. Preserve optional-omission normalization only, exact canonical
locks/catalog pins, one fetch per shared diamond node, cycle/conflicting logical
key detection,32 nodes/8 path edges/64MiB transport/128MiB expanded incl USTAR
framing, per-source16/32MiB, absolute5s/source and30s graph budgets including final
normalization/hash. Observe held/aborted/late reads and retain their references;
no late staging/publication. Content-only forbids executable/build members before
effects. No HTTP transport, automatic retries or new source authority.

Create one root BuildAuthority owner/factory/provider and one runtime handle.
Build actual declared nodes in deterministic dependency-first order using that
same injected assembler/executor; never recursively install, clone owner or
create a child runtime. Each node builder gets its own sources plus already
validated transitive child sources/outputs. Preserve existing argv/environment/
cwd/profile/limits and generated output validation. A node with no build adds
sources; a declared build must execute. Unknown/failure or unconfirmed cleanup
blocks every successor and final runtime, retaining the full closure.

Use nodes/<packageDigest> seal namespaces for child builders/generated outputs;
preserve canonical root receipt paths for root material and v0.1. Retain every
actual node builder image/receipt; only root gets a final runtime image/record.
Seal complete qdroid.graph-material/v1 before final runtime, excluding the final
runtime image/receipt to avoid cycles. Preserve the existing content-only seal
format byte identity. An executable seal may add a strict versioned execution
section and fill its node generated/builder identities; distinguish it using
record target/schema, never silently accept missing execution proof. Reconstruct
expected material from approved graph/catalog and retained bytes, not fields
compared only to themselves.

Graph buildInputDigest covers the complete planned source/build graph, excluding
future outputs/images. Graph buildOutputDigest covers all actual generated
inventories, including dependency output when the root has no build. A declared
build with empty outputs is still a built node. Root builder fields stay null
when the root itself has no build; child builder refs live in graph material.
Graph receipt/material digests bind child results per step without self/future
hash cycles. The current registry v3 graph refs remain the single root record;
no second registry, child publication, grants, instances or active pointer.

Reuse resolves the same approved graph, validates its full semantic input, all
original source/generated files, exact retained node/final images and receipts
through a fresh read-only same-owner managed session, recomputes output/material
digests and returns the ORIGINAL root disabled record. Never rebuild/repair a
missing or corrupt child/output/image. Concurrent identical outputs preserve the
winner's images/record; differing validated outputs conflict without overwrite.
Keep existing cross-image physical publication/build authority and immutable
storage/retention rules; no image or evidence garbage collection.

## Verification/output and integration handoff

Use actual filesystem/SQLite with trusted Mock assembler/executor for the unit,
including genuinely emitted bounded USTAR output from the mock port; never run
package code on host and never fabricate Linux sandbox/build evidence. Cover
shared-diamond dependency-first two-node builds, root-without-build child output,
complete prepared closure and fixed guest map, same factory/owner identity,
unsupported production factory zero effects, undeclared/foreign/forged member
zero effects, per-node failure/unknown blocks successors, no child grants/rows,
retained sources/generated/node images/receipts verified on reuse with no rebuild,
missing/corrupt material no repair, immutable conflict/shared winner, no hash
cycle, exact budgets/held/late/cancel read behavior and all v0.1/content/migration
regressions. Existing relevant checks plus cumulative checks on a frozen unit
input are required. Source stays readable; no unrelated refactor/dependency.

Use the proven v97 120-regular archive as the stable non-owned validation base,
with only the unit's owned files added/overlaid. Do NOT copy the producer's
in-flight control files or share live dist/node_modules. Pin actual Node24.16 /
npm11.13, existing dependencies and ignore-scripts/offline preparation where
available. Record this as an explicit unit overlay, not current whole source.
The final producer integrates one unified current snapshot including both units.

Return awaiting_acceptance only for the COMPLETE unit, exact changed paths,
stable DTO/version/digest identity details and any material port conflict,
source/archive manifests, actual commands/exits/raw/env and remaining production
scope. No lifecycle transitions; root alone accepts. Do not stop at a partial
resolver or one generated file. Preserve all original failed attempts/used
diagnosis allowances; two nonconverging attempts without new cause evidence
stop the segment, never obtain a fresh allowance by this ownership split.

# T008 implementation preparation

Planning notes only. T008 remains todo and depends on T006. The normative source
is `docs/specs/scene-rendering.md`; the Feature engineering context owns the
effective plan. No browser, codec or display support is established by these notes.

## First actual compatibility check

Before implementing the full media pipeline, construct a pinned trusted renderer
catalog image and check the actual Chromium launch under the qualified offline
boundary with Chromium's own sandbox explicitly enabled. Capture runtime flags
and browser sandbox evidence in the same actual Linux environment. A successful
outer Node probe is insufficient. Do not use `--no-sandbox`, privileged containers,
host IPC, added host devices or global user-namespace changes to obtain a pass.

Failure must retain the image/runtime/flags and bounded diagnostic evidence.
Localize a compatibility or resource issue within the project's attempt rule.
An unsupported required boundary blocks T008 acceptance; T009 can still proceed
once its own T007 dependency is accepted. Do not replace this check with a host
browser or claim that a desktop recording establishes Linux support.

## Required Web engine integration

Read-only inspection of upstream commit
[`ce249b62b0d6a510a198506c2f093eeac2c439d0`](https://github.com/tester-army/e2e/tree/ce249b62b0d6a510a198506c2f093eeac2c439d0)
found candidate source versions `e2e` 0.21.3 and `@e2e-dev/web` 0.15.3. The Web
package uses `playwright-core` 1.64.1 and declares Node `^22.22.3 || >=24.8.0`.
These are inspected source candidates, not installed or tested dependencies;
verify published artifacts, integrity, licenses and the actual fixed API before
T008 implementation.

The inspected
[`BrowserConnection`](https://github.com/tester-army/e2e/blob/ce249b62b0d6a510a198506c2f093eeac2c439d0/packages/web/src/browser-connection.ts)
default launch passes headless/timeout/signal options without explicitly enabling
Chromium's sandbox. Do not use that default as evidence of the required boundary.
Its
[`WebConnectOptions`](https://github.com/tester-army/e2e/blob/ce249b62b0d6a510a198506c2f093eeac2c439d0/packages/web/src/surface.ts)
accepts a CDP endpoint resolver. One integration candidate is to run the CLI and
Web engine inside the same qualified execution as an explicitly sandboxed browser,
then attach through private in-sandbox loopback CDP. Do not expose a management
port/socket outside that execution or add a host browser fallback. Actual browser
creation, endpoint confinement, process cleanup and limits still require testing;
this source inspection is not a working launch recipe.

Use deterministic locators and exact state/action/result assertions with no agent
steps or provider credentials. Disable telemetry explicitly and verify zero model
calls. Independent Validate uses read-only caches; strict cache alone does not
guarantee zero model calls. Preserve a fresh per-run report and actual CLI exit,
with zero collected tests, missing reports or skipped required journeys treated as
incomplete. The required CLI/Web engine remains the test runner; direct Playwright
checks may supplement its sandbox/renderer evidence.

## Bounded first scene

Use the same two-page synthetic calendar and next/back/close actions for video
and simulated web presentation. Choose a small code-owned simulator output tuple
first, for example 320x240, 8 fps and 2 seconds; this is a candidate that still
requires measurement. Caller state cannot supply encoder flags or arbitrary
dimensions. Do not infer the actual T1 screen or decoder profile from this tuple.

Freeze scene/assets/state digests, revision, seed, explicit frame times and the
complete browser/fonts/encoder/profile identity. The page implements the existing
initialize/renderFrame/dispose API. Dynamic strings enter as text. Await fonts,
asset decoding and frame readiness with a finite per-frame timeout. Scene code
receives no Node, broker, account, host path or browser-management capability.

Enforce an immutable local asset catalog and navigation/request allowlist.
Reject remote/undeclared assets, file-scheme escapes, redirects, popups, downloads
and service-worker mutation. The debugging transport remains inside the render
workload. Image/font/media parsing also stays within the qualified boundary.

## Streaming and resource composition

Run Chromium capture and FFmpeg in the renderer sandbox. Stream frames to the
encoder rather than collecting the full clip in memory or sending untrusted media
to a host encoder. Limit dimensions, frame count, total bytes, scratch, stderr,
subprocesses and wall time. The first clip contains no audio. Pin the actual
encoder build/options and preserve license/source provenance; the selected codec
is an output-profile fact, not a claim about T1 compatibility.

Return one bounded output envelope through the SandboxExecutionHandle streams.
Reuse the accepted package archive validator for envelope integrity/path checks;
do not require installation manifest/lock metadata in media output. Validate the
MP4 in an isolated media-validation execution before publishing. EOF or exit zero
alone cannot publish a partial file. Require the validated result, actual exit,
confirmed cleanup and complete trusted input/provenance binding.

The current node envelope cannot fit a 768 MiB application and 1024 MiB renderer
at the same time. Use T006's shared manager budget. A bounded sandboxed reducer
can finish and clean up before rendering its validated state; do not move an
untrusted reducer into Core to avoid the resource constraint. Media validation
also follows the shared budget rather than constructing another unrestricted
backend. Unknown cleanup prevents starting the next stage.

## Serialized presentation handoff

The first Agent/MCP-to-display journey must avoid waiting for rendering while
holding the resources rendering needs. A future presentation tool accepts only
the bound caller's permitted SceneRef, bounded schema-validated state and
revision. While the caller lease is still live, normal admission dispatches
this request to the trusted DisplayCoordinator. The coordinator durably accepts
the presentation, its bounded operation lifetime and immutable content/version
references, then promptly acknowledges accepted/waiting-resources. It does not
report rendered, submitted or visible. Queue capacity, request lifetime and
cancellation are bounded; no host path or executable state enters this handoff.

The SDK finishes its bounded turn after that acknowledgment. The trusted
coordinator validates and retains the turn result, then waits for confirmed
cleanup of that turn's Agent and MCP invocation before dispatching the renderer.
It does not stop unrelated workloads to make room. Other occupied or unknown
reservations keep the job waiting/busy until its finite deadline or cancellation;
they do not permit a larger budget, a second manager or host execution. A
misbehaving caller that keeps running cannot receive a synchronous completed
render through this subset.

The accepted job holds its own durable immutable references before the originating
instance releases them. Its coordinator-owned operation context is created only
by the trusted authority; a caller cannot supply it or mint a lease. This is an
already admitted presentation whose internal render stage is waiting, rather than
an undispatched generic tool task allowed to ignore its now-expired caller lease.
The future negotiated presentation feature must explicitly define this bounded
lifetime; existing T003/T007 task semantics do not change implicitly. The old
workload channel stays closed. Internal render dispatch rechecks current
installation/generation, display permission, focus/presentation lease, revision,
cancellation and shared-manager capacity. Removal or revocation invalidates
waiting work before execution. Historical task observation is not new invocation
authority and retains its existing separate trusted path.

Internal stage dispatch must use the same durable ordering authority and
commit-before-send rule as other admitted effects. A cached permission or lease
precheck cannot authorize a later send. Map each stage to the actual accepted
transaction and executor fencing interfaces before implementing this feature.

Restart may resume an accepted, not-yet-dispatched internal stage of a currently
authorized job after the manager has
reconciled old reservations. It must not restart Agent/MCP code to reconstruct
state or resend an ambiguously dispatched operation. Keep render/import/submission
unknown outcomes distinct. State, references, admission and recovery must use
the actual accepted T006/T007 authority; this note does not introduce another
uncoordinated queue database or claim an implemented protocol.

Before acceptance, demonstrate the Agent acknowledgment, confirmed Agent/MCP
cleanup and renderer start in that order within the unchanged 1536 MiB envelope.
Prove the coordinator durably accepted while the original caller lease was live;
an unadmitted generic task must still reject after caller cleanup.
Cover held unrelated peers, unknown cleanup, caller non-exit, revocation/removal
while queued, cancellation and restart on both sides of dispatch. No render or
qualified-image probe may bypass the shared budget while the originating turn
or an unrelated reservation still prevents it.

## Artifact publication and presentation

The host stores immutable validated bytes under a host-generated ArtifactRef.
Keep owner/application/data-policy ACL separate from content digest. An identical
cache key is not permission to read another application's data. Publish only by
durable atomic metadata selection after complete bytes and validation evidence
exist. Failed staging never becomes an artifact; handle truncation/digest mismatch
and crashes on both sides of commit explicitly.

Treat render-complete, imported, submitted and observed-visible as separate
evidence types. The simulator can attest only its implemented observations.
One trusted presentation sender owns the display lease. A newer revision can
discard/cancel old unsent work, but cannot retract an already submitted vendor
operation. Preserve unknown ordering rather than reporting latest-visible without
the relevant backend evidence. T1 import/player/lease recovery remains T011.

## Required acceptance evidence

- Identical frozen state/time/seed/environment produces identical frame hashes;
  a changed time changes expected pixels. Check MP4 byte identity separately.
- Two pages and next/back/close use the same validated action/state semantics
  across video and simulated web output. Invalid, duplicate, stale or unfocused
  actions cannot produce an authorized new presentation.
- Exercise empty/busy/failure, frame timeout, browser crash, encoder OOM/cancel,
  truncation, wrong digest and cross-application access. Confirm descendants and
  owned staging are cleaned without affecting a held peer.
- Reordered render/import completion and quick revisions cannot publish obsolete
  unsent work. Retain separate import/submission/visible observations.
- Execute the project's required committed Web E2E engine with deterministic
  assertions inside the accepted test boundary; screenshots/traces are supporting
  evidence, not an assertion substitute. Disable model/telemetry routes.
- Freeze actual browser/fonts/codec/image/profile/test inputs, run applicable
  cumulative Linux checks and USE-004 CLI, then independent source review and
  primary acceptance. No real account, model, robot screen or formal release.

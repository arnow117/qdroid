# Tracking and delivery workflow

Status: early implementation, 2026-10-29. This file defines tracking ownership; it does not introduce another runtime or automatic synchronization service.

## Public tracking

- Repository: [arnow117/qdroid](https://github.com/arnow117/qdroid)
- Design/repository foundation: [#1](https://github.com/arnow117/qdroid/issues/1)
- Runtime MVP epic, `REQ-MVP-001` / `FEAT-MVP-001`: [#2](https://github.com/arnow117/qdroid/issues/2)

| Milestone                                            | Verifiable outcome                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| [M0](https://github.com/arnow117/qdroid/milestone/1) | Real Linux sandbox, first granted simulator call and denied operation |
| [M1](https://github.com/arnow117/qdroid/milestone/2) | Portable immutable package and isolated Skill/MCP/agent lifecycle     |
| [M2](https://github.com/arnow117/qdroid/milestone/3) | State-driven scene rendering/presentation and bounded connector       |
| [M3](https://github.com/arnow117/qdroid/milestone/4) | Separate T1 on-device qualification and acceptance                    |

Milestones have no promised calendar dates. Runtime Task-to-Issue links are maintained in the accepted [execution navigation](../planner/sdlc-stage-plan.md) and the table below; Issue closure requires corresponding evidence.

## Sources of truth

| Information                                                                       | Authority                                                |
| --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Product scope, user decisions, observable acceptance                              | Requirement product context under `.sdlc-v1/context/`    |
| Current implementation design, task boundaries/dependencies, validation strategy  | Feature engineering context under `.sdlc-v1/context/`    |
| Requirement/Feature/Task execution progress and validation/review/release records | `.sdlc-v1/state.json`, changed only by the lifecycle CLI |
| Reusable interface/security rules                                                 | `docs/specs/`                                            |
| Present source and history                                                        | Git working tree/commits                                 |
| Public collaboration and discovery                                                | GitHub Issues/milestones, linked to lifecycle IDs        |

GitHub state is a human-maintained projection. Closing an issue does not automatically update lifecycle state, and no bidirectional synchronization is implemented. Maintain the two representations in the same accepted delivery segment, with links and actual evidence. If they conflict, reconcile execution progress from the lifecycle state and associated Git evidence, and correct the public projection. Do not silently infer implementation completion from a document, comment or checkbox.

## Current scope

T001 through T004 are accepted implementation increments. T001 established the trusted host-driver path; T002 verifies real supervisor-bound simulator calls in one fixed ARM64 Linux/gVisor profile. T003 adds atomic admission, cancellation ordering, and authoritative recovery without resending unknown work. T004 adds qualified offline profiles and execution recovery; T005 through T009 are authorized, and T010 through T012 await device prerequisites. A completed design/setup issue is separate from the runtime epic and cannot close the MVP acceptance.

Current checkpoint (accepted 2026-10-29 +08): T004 passed the final r34
serial Linux cumulative31/31 with zero skipped/cancelled tests, focused real
concurrent-orphan/v2-negative2/2, and host format/lint/build plus111 passing
host tests (7 Linux-only skips). Primary independently ran both public CLIs:
all eleven supervised call scenarios passed, and all eight lifecycle/resource
assertions passed across tool-offline/build-restricted/render-offline.
The same independent reviewer verified95/95 frozen inputs and closed the final
fixture findings without a remaining P1/P2. Manifest9465f9672ec29fd53aa5be362d3a0550a845fcbd59b058729aac05de51071540
binds the reviewed and executed inputs. Engine29.9.2, the fixed images and original
limits were retained; acceptance covers this ARM64 reference environment.
Qualification-wide durable resource ownership and cross-image installer
serialization belong to T005; installation, Chromium/media and T1 remain pending.
All old failures, unknown stores and used diagnosis allowances remain preserved.
Formal Feature Validate/Review/Release remain pending. The paragraphs below are
historical checkpoints and do not override this acceptance.

Earlier r33 checkpoint (retained): the r33 final serial cumulative failed30/31, exit1 with
zero skips/cancellations. The corrected main lifecycle passed; the sole failure
is a separate concurrent-recovery fixture rewriting a live manager's journal,
then expecting its container ID to remain absent. Primary verified the frozen
source, raw logs and95 VM inputs. Independent review accepts reuse of the genuine
create-before-ID handshake, bounded original-process exit and post-exit proof of
the real target before two recovery owners start. The actual orphan cleanup and
future/forged preservation assertions remain required. A synthetic replacement
was rejected and restored before any build or run. The same worker owns this
fixture-only correction; no production runtime/permission/limit change is
justified. Current host111pass/7 Linux-only skips, actual Linux contracts58/58,
deadline/acquisition2/2 and main lifecycle1/1 remain input-specific evidence.
New affected/v2-negative, cumulative, frozen delta review and primary public CLIs
remain required before acceptance, commit/push and closure. All failed stores and
used allowances remain preserved; T005 still depends on T004 acceptance.

Earlier r31 checkpoint (retained): r31 final serial cumulative failed30/31, exit1,
zero skips/cancellations. The sole original lifecycle fixture reports a failed
deadline combination before its next resource-budget result. It retains one
tool-offline execution journal/receipt and therefore its unknown reservation;
source shows no explicit stop of that completed deadline handle before the next
budget case. Independent read-only contract review confirms that first completion
may legitimately leave cleanup unknown. The accepted correction preserves that
first result and adds one same-owner explicit stop for each completed handle
without an earlier stop; final unknown/pending still fails and prevents further
admission. The same worker owns this fixture-only correction and its required
current checks. No production runtime or permission change is justified by this
finding. Host checks105pass/7 Linux-only skips, actual Linux contracts52/52
and affected2/2 remain valid input-specific evidence; they do not establish
cumulative acceptance. T004 is unaccepted/uncommitted, with all failed stores and
used allowances retained. The following paragraphs are historical checkpoints.

The current T004 correction batch covers five reviewed network-recovery issues:
cross-process lease ownership through actual durable-write settlement,
cleanup-only confirmation after cancellation, explicit consumption of late
retirement, preservation of both primary and cleanup errors, and retention of
test evidence when inventory reads fail. Targeted passes establish only their
individual scenarios. Independent r20 review confirmed the remaining public
recovery, repeated disposal and composed-error corrections, with no new P1/P2;
its three Mock Docker contracts passed on Linux. This closes that correction
batch, while real-runtime acceptance remains pending. The dedicated VM now uses pinned Docker Engine/CLI 29.9.2;
the final matrix, cumulative Linux run, maintainer CLI and independent review
remain pending on the final inputs. See the [current issue summary](https://github.com/arnow117/qdroid/issues/6#issuecomment-6424115277)
and the effective Feature engineering context. The following paragraphs retain
earlier evidence and failures; they do not supersede this current checkpoint.

The subsequent r20 serial cumulative Linux run failed with 21/27 passing,
six failing and zero skipped/cancelled tests (exit 1, 2026-10-28
05:25:11–05:44:12 UTC). The retained T002/T003 scenarios, all offline-profile
lifecycle qualifications and the real late-retirement reservation/peer case
passed. The maintainer verified the raw logs and localized the six failures to
five fixture/observation issues and one pre-intent cancellation state defect.
The same worker is implementing that bounded correction batch before targeted
checks and a new final cumulative run. Legacy creation uncertainty remains
fail-closed, and all six failed stores remain preserved. T004 is still open.

The next r22 intermediate cumulative run passed 27/28 (exit 1, zero
skipped/cancelled tests, 06:08:35–06:26:44 UTC). All six earlier failures passed.
Its remaining late-retirement fixture failed the combined peer/replacement
cleanup condition: the target reservation was released correctly, while the
replacement's retained cleanup record had not received an explicit stop from
its owning backend. Existing Docker events show that replacement exited 0 and
was destroyed. The worker is completing that cleanup composition and the two
independently identified actual-exit/daemon-fixture cleanup conditions. The
first unconfirmed cleanup result is retained; its deeper cause is not asserted.

The final T002 source passed formatting, TypeScript checks and 28 contract tests on the development host and Linux VM, followed by both real Linux tests. Every synthetic TCP/IPv4, UDP/IPv4, DNS/UDP and TCP/IPv6 target received its broker control; the sandbox-negative probe delivered zero packets. The allowed simulator call performed one operation; all six rejected modes performed zero and consumed their final responses before normal exit. Main-agent CLI integration also passed, and independent source review confirmed the lifecycle and timeout cleanup fixes. The final input manifest, immutable image, I/O measurements and retained failure history are recorded in the engineering context. Task containers and synthetic I/O files were removed. This completes the fixed T002 fixture, while general qualification, package installation and T1 acceptance remain pending.

T003 passed 60 cumulative tests on both the host and Linux VM, including independent-process races, four real SIGKILL boundaries, migration, and failure paths. The Linux suite retained all T002 assertions and added four sandbox admission scenarios. Main-agent integration passed five local CLI modes and the public Linux CLI's eleven scenarios, and independent code review has no remaining blocker. The first Linux suite attempt exceeded the existing output-limit cleanup deadline; its logs remain alongside the successful same-input retry, without an asserted root cause. M0 is 3/4 tasks complete; formal Feature Validate/Review/Release remain pending.

T004 is not accepted. Permanent sandbox retirement passed an intermediate Linux lifecycle run. A bounded CPU diagnosis showed guest accounting above 0.8 while the same live host cgroup consumed approximately 0.5 CPU; qualification now measures trusted host usage and retains guest accounting as diagnostic data, with the original rejection threshold. Fresh-manager recovery then passed 4/4 targeted Linux checks, including independent-process SQLite lock contention and SIGKILL recovery. These intermediate inputs do not establish final cumulative acceptance.

The next profile/lifecycle run failed its output-limit assertion. A bounded diagnosis localized premature intermediate-buffer stopping: the guardian read 1,114,112 bytes and delivered 1,048,576 bytes from a 17 MiB producer before stopping, below the unchanged 16 MiB total cap. The correction uses bounded consumer-credit flow control, cross-stream out-of-order acknowledgements and post-completion tail draining. The worker then reported host format/type checks and 76/76 tests passing. Independent review of a frozen 62-file snapshot found no new P1/P2 in those output semantics, but found seven P2 items in stop/start ordering and cleanup evidence, qualification cleanup/tuple consistency, missing negatives, independent crash-peer coverage and the old usage command. The same worker is correcting them; this is not acceptance.

New crash runs stopped in qualification before their crash assertions. A single bounded observation localized the new I/O baseline issue: the same live cgroup's device record had no nested counters before reading, then explicit `rbytes=16777216` after the original 16 MiB read in `15920.603666` ms, with unchanged identity and quota. Only that strictly empty pre-read record may become a zero baseline; post-read counters and all actual-rate requirements remain mandatory. The [earlier issue update](https://github.com/arnow117/qdroid/issues/6#issuecomment-6420894499) records those facts. An erroneous VM checkout replacement lost some checkout-local older logs; externally preserved owner stores and main-agent archived evidence remain, and missing logs cannot count toward acceptance. Future syncs use new unique directories.

The v4 VM host aggregate passed 78/78 after a static EOF-progress fix and a deterministic real-child regression; the prior 76/77 aggregate failure and same-input single-test pass remain recorded. Its focused Linux crash/recovery matrix passed 6/6, including both startup stop windows and a genuine create-before-ID crash with an independently managed heartbeat peer. Independent review verified 64/64 frozen inputs and found five P2 items in failure handling, cleanup, missing negatives and the old usage command. The [v4 issue update](https://github.com/arnow117/qdroid/issues/6#issuecomment-6422244308) records that intermediate input.

The v8 single Linux cumulative run failed: 6 passed and 3 failed in 942.17 seconds. One peer-readiness assertion timed out; two cases failed legacy fixed-profile output cleanup. Independent review verified 65/65 inputs and identified remaining stdin-error handling, durable network-fixture ownership and missing regression coverage. Subsequent host corrections were reported passing 86/86, while Linux acceptance remains pending. Frozen-source inspection localized the ordinary peer timeout: absent phase fields compared equal to the undefined expected failure phase, swallowing valid ready/heartbeat messages before their handlers. That branch is corrected; its ordinary-peer Linux regression passed 1/1 in a new input root, confirmed from the raw log by the maintainer. A separate network-startup failure test passed 1/1 with Mock commands and no privileged link. The corrected post-sudo Linux test then passed 1/1: an elevated helper and its parent shared the controller group, followed by real link creation, exact cleanup and group exit, verified from frozen source and raw evidence by the maintainer. The earlier pre-exec-only test remains insufficient for that condition; actual network crash/uncertain-create recovery is still incomplete. One bounded legacy-output diagnosis passed its single original probe but localized the earlier failures through retained daemon events: stop/kill waits and delayed removal exceeded the existing command budget, while a finally error obscured the first failure. The same worker is completing bounded removal of the exact owned container, separate primary/cleanup errors and the reviewed network-recovery contract, without increasing timeouts or relaxing isolation. The [latest issue update](https://github.com/arnow117/qdroid/issues/6#issuecomment-6424115277) and [acceptance evidence index](../planner/t004-acceptance.md) distinguish this work from the pending final matrix, cumulative run, maintainer CLI and independent final review. T004 remains unaccepted, uncommitted and open.

The subsequent network-recovery run failed and retained its exact synthetic interface. A corrected run stopped in peer qualification because that interface still occupied the fixed test addresses; it never reached the intended crash assertions. The maintainer verified matching boot, exact interface identity/addresses and absence of the original controller group. The cleanup-only API still returned unknown. One bounded read-only diagnosis then localized the actual cause: the whole-process scan rejected a legitimate kernel thread's PGID zero, while the original interface queries both succeeded. No delete was attempted by that diagnosis. Independent review of 26 frozen inputs additionally found four P2 issues in uncertainty propagation, qualification after controller loss, early fork errors and durable ownership of recovery commands. The effective plan now requires the same worker to correct those paths before exact cleanup and further network tests; stores, records and logs remain preserved. The network segment's primary diagnosis allowance is used. No final matrix or T004 acceptance is implied.

The worker then reported targeted contracts 30/30 and a new q input that built in
the VM, but its exact cleanup recovery still returned unknown and retained the
link. The v2 record now identifies the recovery writer; that writer and its group
were reported exited. The summary result does not locate the remaining failure
and is not final acceptance. The affected segment has stopped under the parent
AGENTS.md nonconvergence rule, pending explicit direction for any further
diagnosis. The working tree, owner stores and original logs are preserved; no
manual deletion or new test retry was performed. T004 remains in progress and
unaccepted, so dependent T005–T009 implementation has not started.

The user subsequently approved one additional bounded diagnosis. Its single
cleanup-only invocation from a file entry recovered the exact retained fixture;
the maintainer verified link/record absence and complete writer-group exit.
The remaining startup failure was localized from the original inline ESM
command and a real Node24.16 fork reproduction: inherited `--input-type=module`
causes a worker-file process to exit with `ERR_INPUT_TYPE_NOT_ALLOWED`.
The effective plan now fixes trusted child runtime arguments and resumes the
same implementation worker. The successful diagnostic cleanup is not final
qualification or acceptance; the full remaining matrix, cumulative run, public
CLI and final independent review are still required. The additional diagnosis
allowance is used, and all original failures and private evidence are retained.

The same worker subsequently reported 95/95 host tests for startup diagnostics,
controller-loss handling and cancellation. These are intermediate results, not
final Linux evidence. Independent review found two ordinary-execution recovery
gaps: a create CLI can outlive its guardian, and a cleanup CLI can outlive its
recovery owner. The reviewed correction requires versioned durable writer
identities, a separate authenticated create-success receipt, cleanup-only
recovery writers and actual group-exit proof. Missing creation proof remains
unknown, including legacy records; killing a CLI does not prove the daemon
request was cancelled. The network-probe cancellation path must obey the same
uncertainty rule. T004 remains open pending those corrections and the original
final matrix, cumulative Linux run, maintainer CLI and independent review.

The v3 intermediate source is now under independent delta review (59 captured
inputs). Host child-IPC tests with Mock Docker commands additionally exercise
cleanup-mode termination, rejected creation, ownership mismatch and fixed-ID
operations. These results do not establish actual Docker crash recovery or
Linux qualification. The remaining controlled crash and late-operation matrix
still precedes final acceptance.

That review identified four further P2 issues: reused process-group numbers,
receipt retirement order, an authorization write outside the stop wait-chain,
and an unbounded cleanup completion wait. The reviewed correction removes
numeric-group termination, uses verified container IDs for cleanup, preserves
proof until durable journal retirement, and bounds the whole cleanup lifecycle.
One intermediate host aggregate reported 38/40; a network timeout remains
unexplained and has not been rerun or accepted. Full original logs were not
saved to a separate file for that aggregate, so those missing artifacts are not
presented as verified evidence. T004 remains unaccepted.

Current-source inspection also confirmed that a timed-out durable write could
outlive the SQLite recovery lock and overwrite a successor's writer record. The
independently reviewed correction keeps the original API deadline while retaining
the lease until already-started non-cancelable mutations settle. Late results
cannot authorize further effects or release reservations; a later explicit
cleanup must be able to reconcile a genuinely completed retirement. Implementation,
cross-process regressions and the original final acceptance remain with the same
worker. Existing authorization covers this work and the required final tests.

The maintainer then verified an intermediate 101/101 host log and its ten scoped
source hashes against the 61-input review snapshot. Independent review of that
snapshot found four remaining P2 issues: PID reuse during idle-writer termination,
premature orphan-receipt collection, unreleased reservations after public recovery,
and incomplete retirement retry state. The same worker is correcting them under
the effective plan. New Linux regressions and final cumulative acceptance remain
pending; the original network-timeout failure is preserved despite its later host
pass. No T004 commit or acceptance is implied.

Four later Linux checks on the r6 inputs now have verified raw logs: real
reservation recovery and three delayed-mutation/directory-sync cases all passed.
The reservation fixture checks the exact still-live peer record, replacement
capacity, retired-handle rejection and repeated recovery. The preceding r4/r5
failures remain recorded. Receipt deletion followed by failed directory fsync
still needed correction at that snapshot; the later r8 evidence follows below.
Network pending-create and final cumulative acceptance remain outstanding.

A separate r8 receipt-directory-sync regression passed 1/1 on Linux with real filesystem mutations and Mock Docker; it does not prove real-container budget/peer behavior. The r7 real combination stopped during filesystem qualification. Retained service logs show a backwards clock step and Docker 29.2.1 dropping that container's normal exit, matching the timestamp defect fixed by [Moby #52156](https://github.com/moby/moby/pull/52156). The maintainer and independent reviewer accepted a controlled correction to fixed official Engine/CLI 29.9.2 within the existing dedicated-VM authorization. Only the two signed Engine/CLI packages were updated successfully after checking task quiescence; containerd stayed at 2.2.1. Old packages, configuration, objects and records are preserved, and version holds were restored. gVisor, images, storage and sandbox restrictions/limits remain unchanged. All relevant qualification must be obtained again on the new runtime fingerprint. This does not explain every historical cleanup failure or accept T004. Network pending-create handling, the real combination and final cumulative/CLI/review remain pending.

Independent review of the r11 network delta found two remaining P2s: public qualification checks pending records too late, and non-cancelable persistent writes can make supervision-loss settlement unbounded. Its 2/2 Linux tests cover limited paths and do not close the in-flight cancellation requirement. r12 then stopped at a synthetic-address prerequisite: the r10/r11 tests had discarded unresolved stores while leaving two dummy links. Existing OS sudo logs established the exact task ownership, allowing the maintainer to archive evidence and remove only those two links under the existing controlled-test authorization. Lost records are not recreated; TAP passes do not establish cleanup. The effective plan now covers early public rejection, owned bounded writes, separate interface/probe cleanup and retained test evidence. T004 remains unaccepted.

Later r13/r14/r15 increments have verified frozen94-file inputs and raw logs. The held-create/controller-loss case passed after correcting only the fake command ledger, and the after-rename timeout case returned within its original bound with zero Docker create and retained evidence. These limited results do not close the independent r14 review: five concrete P2s remain in cross-process mutation ownership, cleanup-only fact updates, explicit late-retirement consumption, error aggregation and unknown test-inventory handling. The public precheck source finding is closed. Known cleanup must remain recoverable while genuinely uncertain effects remain unknown; no old authority is restored. The same worker owns the complete correction batch and remaining final acceptance.

The initial publication uses `codex/project-foundation` as the first branch; it is not a product release. Later implementation follows the Feature's registered branch or a controlled branch-registration migration. Do not invent branch changes from a task description.

## Issue format

Each implementation issue includes its Requirement/Feature/Task IDs, user outcome, source specification, write scope, dependencies, acceptance conditions, verification/environment, and external authorization/device prerequisites. Milestones group verifiable increments; they do not carry guessed calendar deadlines.

Use labels for component, priority, security and device prerequisites. A task waiting for a T1 or real account is not equivalent to failed software verification. Record the precise missing resource/AC and continue independent authorized tasks.

## Lifecycle tooling

The maintainer uses the external [sdlc-pilot](https://github.com/arnow117/sdlc-pilot) lifecycle CLI; its implementation is not copied into qdroid. The foundation used version 4.0.0; current task transitions use 4.2.0. Resolve the installed tool location locally; do not commit a personal absolute path. GitHub contributors can discuss/propose changes through Issues without installing the agent tooling.

The CLI's `--help` defines current options. Verified operations used in this foundation are `init`, `status`, `next`, `capture-requirement`, `mark-requirement-ready`, `start-feature`, and `add-task`. Query `status`/`next` read-only before stage work; stage agents propose changes and the main maintainer applies them. Do not edit the JSON manually.

## Completion and evidence

An implementation task requires its actual code/configuration, relevant tests, reviewed evidence and main-agent acceptance before its state changes to done. Record actual commands, exit results, tested commit, environment/profile/image/provider versions, and missing coverage. Changed inputs invalidate affected evidence.

Simulator behavior, Linux isolation qualification, real external-account integration and T1 hardware acceptance are distinct evidence classes. Record-release is used only after the declared release target and required validation/review/observation are complete; uploading this design foundation to GitHub is not an MVP product release.

## Repository setup verification

Before publication, inspect the explicit file list and diff, confirm personal agent links are ignored, validate document links/examples and lifecycle references, and inspect public contents for credentials/private paths/vendor binaries. Publication is authorized by the user's project-creation request. Only this independent repository is staged; unrelated parent-workspace changes are excluded.

## Registered task links

`FEAT-MVP-001` is `in_progress`; T001 through T003 are `done`, T004 is `in_progress`, and T005 through T012 remain `todo`. Exact progress is owned by lifecycle state.

| Lifecycle Task | GitHub Issue                                                                               | Milestone |
| -------------- | ------------------------------------------------------------------------------------------ | --------- |
| T001           | [#3 — 最小契约、受监督身份与只读模拟器](https://github.com/arnow117/qdroid/issues/3)       | M0        |
| T002           | [#4 — Linux 最低隔离与允许/拒绝真实闭环](https://github.com/arnow117/qdroid/issues/4)      | M0        |
| T003           | [#5 — 原子 admission、取消与未知结果恢复](https://github.com/arnow117/qdroid/issues/5)     | M0        |
| T004           | [#6 — 完整 SandboxBackend 与隔离资格](https://github.com/arnow117/qdroid/issues/6)         | M0        |
| T005           | [#7 — 固定包、安全解包与无凭据构建安装](https://github.com/arnow117/qdroid/issues/7)       | M1        |
| T006           | [#8 — 条件激活、升级回滚与移除](https://github.com/arnow117/qdroid/issues/8)               | M1        |
| T007           | [#9 — 受限 AgentBackend 与本地 MCP 生命周期](https://github.com/arnow117/qdroid/issues/9)  | M1        |
| T008           | [#10 — Artifact、Scene 与受限视频呈现闭环](https://github.com/arnow117/qdroid/issues/10)   | M2        |
| T009           | [#11 — ConnectorBroker 与只读 Mock 业务闭环](https://github.com/arnow117/qdroid/issues/11) | M2        |
| T010           | [#12 — T1 设备基线与受信适配器探测](https://github.com/arnow117/qdroid/issues/12)          | M3        |
| T011           | [#13 — T1 媒体导入、串行播放与本地恢复](https://github.com/arnow117/qdroid/issues/13)      | M3        |
| T012           | [#14 — T1 语音触摸交互与资源预算集成](https://github.com/arnow117/qdroid/issues/14)        | M3        |

Detailed scope, dependencies and acceptance are owned by the [engineering context](../.sdlc-v1/context/FEAT-MVP-001.engineering.md). T001/T002/T003 are accepted. The user has authorized continuous T004–T009 implementation, project/dedicated-VM dependencies and controlled tests, independent review, and post-acceptance commit/push and tracking updates. Robot operations, real accounts/models, paid remote resources and formal releases still require their specific authorization.

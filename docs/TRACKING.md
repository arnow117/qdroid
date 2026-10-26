# Tracking and delivery workflow

Status: early implementation, 2026-10-26. This file defines tracking ownership; it does not introduce another runtime or automatic synchronization service.

## Public tracking

- Repository: [arnow117/qdroid](https://github.com/arnow117/qdroid)
- Design/repository foundation: [#1](https://github.com/arnow117/qdroid/issues/1)
- Runtime MVP epic, `REQ-MVP-001` / `FEAT-MVP-001`: [#2](https://github.com/arnow117/qdroid/issues/2)

| Milestone | Verifiable outcome |
|---|---|
| [M0](https://github.com/arnow117/qdroid/milestone/1) | Real Linux sandbox, first granted simulator call and denied operation |
| [M1](https://github.com/arnow117/qdroid/milestone/2) | Portable immutable package and isolated Skill/MCP/agent lifecycle |
| [M2](https://github.com/arnow117/qdroid/milestone/3) | State-driven scene rendering/presentation and bounded connector |
| [M3](https://github.com/arnow117/qdroid/milestone/4) | Separate T1 on-device qualification and acceptance |

Milestones have no promised calendar dates. Runtime Task-to-Issue links are maintained in the accepted [execution navigation](../planner/sdlc-stage-plan.md) and the table below; Issue closure requires corresponding evidence.

## Sources of truth

| Information | Authority |
|---|---|
| Product scope, user decisions, observable acceptance | Requirement product context under `.sdlc-v1/context/` |
| Current implementation design, task boundaries/dependencies, validation strategy | Feature engineering context under `.sdlc-v1/context/` |
| Requirement/Feature/Task execution progress and validation/review/release records | `.sdlc-v1/state.json`, changed only by the lifecycle CLI |
| Reusable interface/security rules | `docs/specs/` |
| Present source and history | Git working tree/commits |
| Public collaboration and discovery | GitHub Issues/milestones, linked to lifecycle IDs |

GitHub state is a human-maintained projection. Closing an issue does not automatically update lifecycle state, and no bidirectional synchronization is implemented. Maintain the two representations in the same accepted delivery segment, with links and actual evidence. If they conflict, reconcile execution progress from the lifecycle state and associated Git evidence, and correct the public projection. Do not silently infer implementation completion from a document, comment or checkbox.

## Current scope

T001 through T003 are accepted implementation increments. T001 established the trusted host-driver path; T002 verifies real supervisor-bound simulator calls in one fixed ARM64 Linux/gVisor profile. T003 adds atomic admission, cancellation ordering, and authoritative recovery without resending unknown work. T004 through T012 are planned. A completed design/setup issue is separate from the runtime epic and cannot close the MVP acceptance.

The final T002 source passed formatting, TypeScript checks and 28 contract tests on the development host and Linux VM, followed by both real Linux tests. Every synthetic TCP/IPv4, UDP/IPv4, DNS/UDP and TCP/IPv6 target received its broker control; the sandbox-negative probe delivered zero packets. The allowed simulator call performed one operation; all six rejected modes performed zero and consumed their final responses before normal exit. Main-agent CLI integration also passed, and independent source review confirmed the lifecycle and timeout cleanup fixes. The final input manifest, immutable image, I/O measurements and retained failure history are recorded in the engineering context. Task containers and synthetic I/O files were removed. This completes the fixed T002 fixture, while general qualification, package installation and T1 acceptance remain pending.

T003 passed 60 cumulative tests on both the host and Linux VM, including independent-process races, four real SIGKILL boundaries, migration, and failure paths. The Linux suite retained all T002 assertions and added four sandbox admission scenarios. Main-agent integration passed five local CLI modes and the public Linux CLI's eleven scenarios, and independent code review has no remaining blocker. The first Linux suite attempt exceeded the existing output-limit cleanup deadline; its logs remain alongside the successful same-input retry, without an asserted root cause. M0 is 3/4 tasks complete; formal Feature Validate/Review/Release remain pending.

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

`FEAT-MVP-001` is `in_progress`; T001 through T003 are `done`, and T004 through T012 remain `todo`. Exact progress is owned by lifecycle state.

| Lifecycle Task | GitHub Issue | Milestone |
|---|---|---|
| T001 | [#3 — 最小契约、受监督身份与只读模拟器](https://github.com/arnow117/qdroid/issues/3) | M0 |
| T002 | [#4 — Linux 最低隔离与允许/拒绝真实闭环](https://github.com/arnow117/qdroid/issues/4) | M0 |
| T003 | [#5 — 原子 admission、取消与未知结果恢复](https://github.com/arnow117/qdroid/issues/5) | M0 |
| T004 | [#6 — 完整 SandboxBackend 与隔离资格](https://github.com/arnow117/qdroid/issues/6) | M0 |
| T005 | [#7 — 固定包、安全解包与无凭据构建安装](https://github.com/arnow117/qdroid/issues/7) | M1 |
| T006 | [#8 — 条件激活、升级回滚与移除](https://github.com/arnow117/qdroid/issues/8) | M1 |
| T007 | [#9 — 受限 AgentBackend 与本地 MCP 生命周期](https://github.com/arnow117/qdroid/issues/9) | M1 |
| T008 | [#10 — Artifact、Scene 与受限视频呈现闭环](https://github.com/arnow117/qdroid/issues/10) | M2 |
| T009 | [#11 — ConnectorBroker 与只读 Mock 业务闭环](https://github.com/arnow117/qdroid/issues/11) | M2 |
| T010 | [#12 — T1 设备基线与受信适配器探测](https://github.com/arnow117/qdroid/issues/12) | M3 |
| T011 | [#13 — T1 媒体导入、串行播放与本地恢复](https://github.com/arnow117/qdroid/issues/13) | M3 |
| T012 | [#14 — T1 语音触摸交互与资源预算集成](https://github.com/arnow117/qdroid/issues/14) | M3 |

Detailed scope, dependencies and acceptance are owned by the [engineering context](../.sdlc-v1/context/FEAT-MVP-001.engineering.md). The authorized T001/T002/T003 implementation and validation are accepted; commit/push and tracking updates are part of the same authorization. T004 and later implementation, device/account/model access remain outside this authorization.

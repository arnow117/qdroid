# qdroid

Portable agent application runtime for robot hosts: capabilities, Skills, MCP, isolated tools, and interactive scenes.

**WIP snapshot — 2026-10-30.** This branch preserves unfinished T005 implementation
for continuation after cloning. It is not whole-task acceptance or a release.
The accepted baseline is `a3973e56d442e75361946eb26fc2e3b8b494882b` (T001–T004).
Start with the [recovery checkpoint](.sdlc-v1/checkpoints/FEAT-MVP-001.md), then the
engineering context and current lifecycle state. Private raw evidence, runtime
state, the dedicated Linux VM and its images are not included in Git. T006/T008
planning drafts remain unimplemented.

**Status: early implementation.** T001 provides a trusted host-driver fixture with versioned RPC, bound identities, SQLite admission/audit, and a read-only simulator. T002 verifies that path in one fixed ARM64 Linux/gVisor profile. T003 adds atomic budget/approval admission, cancellation, and recovery of unknown outcomes against a persistent synthetic counter, with Linux and crash/race evidence. [T004 reusable sandbox qualification](https://github.com/arnow117/qdroid/issues/6) is accepted for three offline profiles on the fixed ARM64 Linux reference environment, including bounded stdio, resource enforcement and execution crash recovery. [T005 package installation](https://github.com/arnow117/qdroid/issues/7) is in progress and has not passed whole-task acceptance; the T1 adapter remains planned. Primebot T1 Pro is the first planned device target; it is not a dependency of the core architecture.

## Intended experience

An application installs a fixed version of its Skills and tools, requests capabilities, and runs in a qualified sandbox. Trusted services authorize robot operations and external connectors. The same scene state can be presented through an appropriate display backend; T1 initially uses HTML rendered to MP4 and the vendor player.

Initial host scope is Linux ARM64/AMD64, subject to actual runtime qualification. MCU/RTOS controllers can be attached through a device adapter; they are not assumed to run the full harness.

Run the current fixture using [the usage guide](docs/USAGE.md). The guide distinguishes the trusted host fixture from the qualified fixed Linux fixture. T1 hardware qualification remains separate.

## Design documents

- [Architecture and trust boundaries](docs/architecture/overview.md)
- [Core interfaces](docs/specs/core-interfaces.md)
- [Plugin package specification](docs/specs/plugin-package.md)
- [Sandbox and permissions](docs/specs/sandbox-permissions.md)
- [Interactive scenes and HTML to MP4](docs/specs/scene-rendering.md)
- [T1 adapter contract and arrival checklist](docs/specs/t1-adapter.md)
- [MVP implementation plan](planner/sdlc-stage-plan.md)
- [Tracking and contribution workflow](docs/TRACKING.md)
- [Research sources and evidence limits](docs/research/2026-10-22-findings.md)
- [Linux development baseline and relationship to T1](docs/research/2026-10-23-linux-baseline.md)

## MVP target

First prove an allowed plugin call and a denied operation in a Linux sandbox against a reference simulator. Then add package installation, scene output, a read-only Lark connector, and the T1 device adapter. Physical-device acceptance remains separate from simulator or desktop results.

The [MVP epic #2](https://github.com/arnow117/qdroid/issues/2) tracks twelve implementation tasks across [four milestones](https://github.com/arnow117/qdroid/milestones). Detailed dependencies and acceptance live in the Feature engineering context; no task is complete merely because this design is published.

## Security

Untrusted packages do not receive raw vendor control, host files, container-management sockets, or connector credentials. A sandbox backend must satisfy the task's minimum isolation requirements before execution. See [the threat model and permission contract](docs/specs/sandbox-permissions.md) and [SECURITY.md](SECURITY.md).

## License

Original qdroid material is licensed under Apache-2.0. Vendor SDKs, firmware, bundled tools, fonts, and media retain their own licenses; redistribution requires separate verification.

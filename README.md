# qdroid

Portable agent application runtime for robot hosts: capabilities, Skills, MCP, isolated tools, and interactive scenes.

**Status: early implementation.** T001 provides a trusted host-driver fixture with versioned RPC, bound identities, SQLite admission/audit, and a read-only simulator. Linux isolation is the next task; the package installer and T1 adapter remain planned. Primebot T1 Pro is the first planned device target; it is not a dependency of the core architecture.

## Intended experience

An application installs a fixed version of its Skills and tools, requests capabilities, and runs in a qualified sandbox. Trusted services authorize robot operations and external connectors. The same scene state can be presented through an appropriate display backend; T1 initially uses HTML rendered to MP4 and the vendor player.

Initial host scope is Linux ARM64/AMD64, subject to actual runtime qualification. MCU/RTOS controllers can be attached through a device adapter; they are not assumed to run the full harness.

Run the current fixture using [the usage guide](docs/USAGE.md). This fixture is not evidence of Linux sandbox or T1 hardware qualification.

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

## MVP target

First prove an allowed plugin call and a denied operation in a Linux sandbox against a reference simulator. Then add package installation, scene output, a read-only Lark connector, and the T1 device adapter. Physical-device acceptance remains separate from simulator or desktop results.

The [MVP epic #2](https://github.com/arnow117/qdroid/issues/2) tracks twelve implementation tasks across [four milestones](https://github.com/arnow117/qdroid/milestones). Detailed dependencies and acceptance live in the Feature engineering context; no task is complete merely because this design is published.

## Security

Untrusted packages do not receive raw vendor control, host files, container-management sockets, or connector credentials. A sandbox backend must satisfy the task's minimum isolation requirements before execution. See [the threat model and permission contract](docs/specs/sandbox-permissions.md) and [SECURITY.md](SECURITY.md).

## License

Original qdroid material is licensed under Apache-2.0. Vendor SDKs, firmware, bundled tools, fonts, and media retain their own licenses; redistribution requires separate verification.

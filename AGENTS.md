# qdroid contributor instructions

## Project boundary

qdroid is a portable agent application runtime for Linux robot hosts. Primebot T1 Pro is the first device adapter. Core must not depend on vendor SDKs, ROS2 messages, a particular CPU architecture, or MP4-only displays.

This repository contains design specifications, a tracked implementation backlog, and an early trusted simulator fixture. A specification, mock, or local media experiment is not evidence of device support or sandbox security.

## Read first

1. `README.md` for current delivery status and document entry points.
2. `.sdlc-v1/project.md` and lifecycle state before working on tracked changes.
3. The current Requirement product context and Feature engineering context.
4. The relevant normative specification under `docs/specs/`.

The Feature engineering context owns the current implementation plan. `docs/specs/` owns reusable interface and security contracts. GitHub Issues are collaboration links; `.sdlc-v1/state.json` is the execution-progress authority and may be changed only using the lifecycle CLI documented in `docs/TRACKING.md`.

## Non-negotiable boundaries

- Third-party applications, Skills, MCP servers, renderers, and build scripts are untrusted workloads.
- Vendor control and connector credentials stay in separate trusted services. Manifest permissions are requests, not grants.
- Bind callers to supervised workload identity; never trust a principal or grant supplied in tool arguments.
- Enforce permission, lease, epoch, schema, and resource constraints at the execution boundary. Deny unsupported or unverified requirements.
- Never fall back from a required sandbox to host execution. Do not disable isolation to make a demo pass.
- Preserve `unknown` outcomes for side effects; accepted, completed, cancel-requested, and stop-confirmed are different facts.
- No raw HAL/servo control from an LLM. Retain vendor safety and manual takeover.
- Do not publish credentials, private device access details, personal data, local home paths, or unlicensed vendor software.

## Work and verification

Planning and complex analysis establish the contract before implementation. Use an implementation worker where the calling environment provides that role, with a bounded goal, write scope, acceptance criteria, and verification. The primary agent owns integration and acceptance. Independent review is read-only.

Keep normal indentation, line breaks, and readable source. Verify boundary and failure behavior, not merely a happy-path mock. Report actual commands, results, revision, environment, and remaining gaps. Do not invent passing checks for an unimplemented runtime.

Do not mark MVP tasks complete because design documents exist. Current authorization for the repository foundation covers design, planning, GitHub publication, and tracking; a later implementation request selects the next tracked task.

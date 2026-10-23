# Contributing

Start with `AGENTS.md` and the linked specifications. Select a tracked task, state its scope and acceptance criteria, and keep its dependency assumptions explicit.

Current work is design-stage. Proposed runtime APIs, configuration examples, and planned test commands must be labeled as such until implemented and verified. Do not mark hardware support or isolation qualified from desktop-only results.

Changes to public schemas, authorization, persistence, replay, cancellation, or device control require focused review. Runtime changes need proportionate contract and boundary tests, with the tested commit and environment recorded. Keep vendor adapters and local/private configuration out of portable core.

See `docs/TRACKING.md` for the relationship between lifecycle state, GitHub Issues, milestones, and implementation evidence.

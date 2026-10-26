# Security policy

qdroid is in early implementation. No release is supported for deployment. Qualification evidence is limited to the exact tested fixture/host/profile recorded in the Feature engineering context; it does not establish general-purpose isolation, T1 hardware support or physical safety.

Use GitHub private vulnerability reporting for sensitive findings when it is enabled for this repository. If that entry is unavailable, open a public issue containing only a request for a private reporting channel. Do not include tokens, exploit payloads, personal data, device credentials, or private firmware in public issues.

Security-relevant changes must address the threat model, actual enforcement point, failure behavior, and negative acceptance scenarios in `docs/specs/sandbox-permissions.md`. A permission prompt, manifest entry, MCP annotation, or successful mock is not an isolation boundary.

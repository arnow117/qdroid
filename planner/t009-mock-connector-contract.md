# T009 Mock connector preparation

Planning input only. T009 remains todo and depends on T007's accepted generic
tool/admission interfaces. The Feature engineering context owns the effective
plan. No actual Lark CLI/OAuth compatibility, account access or model route is
established here.

## One semantic operation

The first connector exposes a bounded read-calendar operation over synthetic
accounts, calendars and events. Trusted configuration maps the operation to an
isolated Mock API. The workload cannot choose a URL, credential store, request
header, account identity, provider epoch or arbitrary API method.

Keep the tool process offline and connect it to the trusted broker through its
supervised bounded channel. Only the trusted broker talks to the Mock API and
injects the synthetic downstream token. No host token/keyring/config directory is
mounted into the tool. The Mock CLI is explicitly a qdroid fixture; it is not the
official Lark CLI and cannot count as authsidecar compatibility evidence.

## Identity, authorization and replay

Resolve caller/task/installation/instance identity from the bound transport and
actual admission record. A per-instance proxy key authenticates only the scoped
proxy session. Malicious workload code knows that key and can generate a valid
MAC; possession does not authorize arbitrary reads, writes or account access.

Bind the canonical request to operation, actual caller context/generation, task,
provider, method, path, query, body digest, key ID, timestamp and nonce. Define a
strict canonical encoding and reject unsupported or ambiguous encodings rather
than trusting two parsers to interpret them alike. The semantic allowlist and
typed calendar/time/resource validation remain authoritative after MAC checks.

Check replay and permitted use in the same durable admission authority used at
the final submission boundary. Two concurrent copies of one authenticated
request cannot produce two API calls or consume/refund independently. A bounded
timestamp window alone is not replay protection. Same nonce with changed bytes
is a conflict. Unknown outcome after submission does not permit automatic resend.

T006 removal/revocation fences new broker submissions immediately through current
policy. Asynchronous physical key deletion is additional cleanup, not the fence.
An in-flight result can be recorded under trusted historical authority, but cannot
be delivered to a retired or unauthorized workload channel. Reissuing an instance
or key does not revive an existing idempotency key's send authority.

## Secret and refresh ownership

The trusted broker owns the synthetic credential store and refresh operation.
One accepted account/provider owner serializes refresh; concurrent callers share
the same bounded refresh result. Establish explicit single-owner behavior and
restart handling in the actual implementation rather than describing an in-memory
promise as cross-process serialization. A refresh failure yields an unavailable
or authorization result with no token-bearing error detail.

Token values never enter workload bytes, task/audit records, model inputs, shell
arguments or logs. Keep only opaque IDs, versions/digests, operation counts and
sanitized errors in ordinary evidence. Tests distinguish the protected synthetic
secret store from workload/log output when scanning a canary. Private file modes
are local access controls, not hardware-backed encryption claims.

## Results and model disclosure

Validate and filter the Mock API response to a bounded typed event projection;
drop unrelated fields and token-bearing headers, and reject excessive or malformed
data. Treat event text as data. No unapproved download URL, attachment fetch,
callback or upload follows from a calendar read.

A calendar read grant and external model disclosure are separate decisions. The
test uses a deterministic Mock model route to verify the disclosure policy and
zero actual model-provider calls. Do not claim that hiding the token prevents
all exfiltration of event content already available to an authorized application.

## Required evidence

- Actual offline Linux tool → supervised broker → isolated Mock API returns
  allowed and empty data with exact operation counts and sanitized output.
- Independently tamper method, path, query, body, account/resource/caller/task,
  nonce, timestamp, key and generation, including a valid MAC from an over-scoped
  caller. Every denied semantic operation makes zero unauthorized API calls.
- Concurrent replay/duplicate requests produce at most one admitted submission;
  expired/revoked sessions and removed installations remain denied.
- Concurrent refresh is serialized under the implemented owner contract; offline,
  refresh failure, response truncation/oversize and ambiguous submission remain
  distinguishable without automatic resend or token leakage.
- A secret canary is absent from workload, normal logs/audit, results and Mock
  model input. Private event disclosure is separately allowed/denied by policy.
- Freeze current inputs/environment, run relevant cumulative host/Linux tests
  and USE-005 CLI, obtain independent code review and primary acceptance before
  commit/push and tracking. No live Lark/account/model/robot or formal release.

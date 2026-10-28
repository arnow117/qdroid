# T004 acceptance evidence index

This index organizes the existing T004 completion conditions and accepted review
corrections. It adds no new scope and does not replace the effective plan in
[the Feature engineering context](../.sdlc-v1/context/FEAT-MVP-001.engineering.md).
This is a static contract index. Actual results remain in the engineering
context, and progress remains in lifecycle state; this file is not another
validation report or progress record.

## Frozen inputs and commands

| Evidence             | Requirement                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Source identity      | Record the actual base revision, final source/lock/profile/probe/guardian manifest and immutable image IDs |
| Intermediate results | Distinguish superseded code and partial runs from final tested inputs; retain original failures            |
| Host checks          | Preserve actual final commands, exit codes and raw logs after relevant code changes                        |
| Linux matrix         | Reuse evidence only for unchanged relevant inputs; execute the required final serial cumulative command    |
| Independent review   | Verify the final frozen input manifest and actual delta; resolve findings before primary acceptance        |
| Public journey       | Primary runs the documented public CLI on the final frozen Linux inputs                                    |

## Contract coverage

All rows are required by the existing engineering or normative contract. A mock
or contract test can verify rejection/control flow; it does not qualify a Linux
image/profile. A completed process, requested stop and confirmed cleanup remain
separate facts.

| Area                       | Evidence to locate in final handback                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opaque authority           | Fake, foreign and stale qualification/instance handles reject before side effects; identity and epoch bind to trusted supervision                                                                                                                                                         |
| Qualification tuple        | Actual image/profile matrix; complete tuple before/after probes; config/binary/args drift and missing requirements reject                                                                                                                                                                 |
| Files/processes/devices    | Host positives and sandbox negatives for synthetic host/store/cross-app files, process secrets, control device and management socket                                                                                                                                                      |
| Controlled network         | Matching per-category/protocol host positives and zero sandbox receipts, including private/link-local/synthetic metadata-class/IPv6 targets; no real metadata access                                                                                                                      |
| Network fixture recovery   | Durable authenticated intent before creation; exact marker/kind checks; uncertain create and controller/manager/both deaths; actual control-group exit before cleanup; live/foreign/malformed records preserved                                                                           |
| Network cleanup facts      | Cancellation permanently invalidates qualification; the original bounded cleanup may still record proven create/removal facts, while genuinely uncertain creation retains ownership                                                                                                       |
| Network applicability      | Explicit redirect/rebind non-applicability for network-none; no claim of network-enabled connector qualification                                                                                                                                                                          |
| Recovery writers           | Persist cleanup-only writer/group identity before recovery effects; writer loss, late commands and uncertain deletion retain evidence; actual group exit precedes retirement                                                                                                              |
| Creation settlement        | Execution v3 authorization precedes IPC; authenticated success receipt follows actual create close/exit0 and contains no container ID; pending creation without proof cannot retire on temporary absence                                                                                  |
| Legacy execution record    | Preserve v2 authentication; missing writer-group or creation proof remains unresolved, without defaulting legacy data into successful v3 state                                                                                                                                            |
| Controller failure         | Missing PID/error is observed without killing the manager; controller loss permanently rejects qualification despite successful cleanup-only takeover                                                                                                                                     |
| Qualification cancellation | Own and await in-flight operations; loss during dispose cannot qualify; create cancellation prevents later start and preserves unknown ownership when daemon creation is not proven terminal                                                                                              |
| Process group scan         | Legitimate kernel-thread PGID zero cannot match a positive target; malformed/unreadable identities remain unknown; real Linux scan and targeted negatives                                                                                                                                 |
| Resources                  | Actual CPU, memory, PID, scratch/shared memory, I/O, output and deadline enforcement for each relevant profile; original thresholds retained                                                                                                                                              |
| I/O accounting             | Only the observed pre-read empty-device record maps to zero; malformed/partial/missing and post-read empty records reject; live identity and counter delta retained                                                                                                                       |
| Transport                  | Multi-round/binary input-output, backpressure, bounded queues and aggregate output, slow/missing consumers, stdin EOF/EPIPE and pending-write cancellation                                                                                                                                |
| EOF                        | Real child exits after its final payload has already drained; zero-credit EOF advances without consuming payload or credit; original deadline retained                                                                                                                                    |
| Stop ordering              | Qualification/intent startup barriers; stop retires before awaits; no late start or old-handle rerun                                                                                                                                                                                      |
| Stop result                | Confirmed/pending/unknown evidence matches resources; unknown cleanup retains reservations and journals                                                                                                                                                                                   |
| Manager composition        | Preserve original completion; one same-owner explicit stop for completed handles without an earlier stop; require final confirmed cleanup before the next scenario; unknown/pending blocks continuation, and execution failures remain failures                                           |
| Stop deadline              | One original absolute startup-cleanup deadline includes trailing reads, lock acquisition, recovery and retirement; raw late acquisition has a cleanup-only release owner and cannot run recovery actions                                                                                  |
| Early failure              | Idle guardian internal rejections observed immediately; manager and held peer survive early stop and intent-write failures                                                                                                                                                                |
| Intent failures            | Before-write and after-rename failures, delayed writes and cleanup retry cannot leak an untracked guardian, recreate retired records or restore execution                                                                                                                                 |
| Qualification failure      | Uncertain create, CPU/I/O/baseline/attach failure and unresponsive release have bounded cleanup, first-failure preservation and no unhandled rejection                                                                                                                                    |
| Legacy termination         | Exact owned force removal avoids the observed preliminary graceful-stop wait; original command/grace/deadline bounds retained; first error and unknown cleanup remain distinct                                                                                                            |
| Budget                     | Maximum two owned executions and 1536 MiB reserved limit per existing backend; no node-wide/cross-image claim before later composition                                                                                                                                                    |
| Crash recovery             | Actual manager-only, guardian-only and both-process deaths; genuine create-before-ID interruption; held old create and in-flight recovery rm cannot escape durable ownership; exact cleanup only, zero replay                                                                             |
| Peer continuity            | Independent manager's same live peer responds before/after crash and fresh recovery, then receives explicit confirmed cleanup                                                                                                                                                             |
| Recovery negatives         | Future/forged/malformed records, live owner, identity mismatch, daemon unknown and concurrent recovery retain/report unresolved evidence                                                                                                                                                  |
| Journal order              | Delayed created updates cannot resurrect a journal after terminal retirement; cleanup uncertainty preserves evidence                                                                                                                                                                      |
| Recovery timeout ownership | Non-cancelable durable mutations retain the SQLite lease until settled; API returns within its existing deadline; late results cannot advance effects, overwrite a successor or strand an explicitly retried cleanup                                                                      |
| Explicit retirement        | A real owned sandbox reservation is released exactly once by any successful explicit recovery entry; partial unlink/fsync failures remain retryable, and fresh backends preserve another owner's receipt proof                                                                            |
| Failure evidence           | Preserve the primary failure alongside cleanup-confirmation errors; an unreadable resource inventory retains its store and key rather than treating the inventory as empty; original public sandbox-suite failures retain bounded phase/subresults without raw workload output or secrets |
| Regression                 | Final serial Linux cumulative command covers retained T002/T003 scenarios and T004; no isolation fallback, raised limits or assertion removal                                                                                                                                             |
| Usage                      | USE-001/002/004 commands match required image parameters and actual failure wording; demonstrated commands and parameter sources agree                                                                                                                                                    |

## Failure history and handoff

The engineering context preserves each failure, static finding, bounded
diagnostic window, original logs and used allowance. This index, a new source
manifest, a renamed VM root or a new review does not create a new delivery
segment or reset those limits.

Raw private artifacts stay outside Git. Public evidence records sanitized
commands, versions, immutable identifiers, results and support limits. Missing
logs cannot be reconstructed as claimed passes. Retain failed roots/stores and
clean only precisely identified task-owned resources with adequate evidence.

Only after primary acceptance may the lifecycle CLI mark T004 done, followed by
the authorized exact-file commit, push and GitHub tracking update. T005 depends
on that acceptance. No T1, actual account/model or formal release is included.

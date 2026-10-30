# T008 renderer compatibility notes

Read-only planning input, checked 2026-10-29. T008 remains todo; this note does not
select a browser build, change the effective Plan or claim runtime qualification.
No browser, new image or VM command was run for this check.

## Primary-source observations

Chromium documents namespaces and seccomp-BPF among its Linux sandbox
mechanisms, selected according to available kernel features. Browser launch
alone therefore does not establish the required internal isolation. See the
[current Chromium Linux sandbox design](https://chromium.googlesource.com/chromium/src/+/main/sandbox/linux/README.md).

The automatically generated [gVisor ARM64 syscall compatibility table](https://gvisor.dev/docs/user_guide/compatibility/linux/arm64/)
currently describes clone/unshare as partial implementations, and seccomp filter
mode with flags0 or TSYNC as supported. These are current public documentation,
not a browser result for the retained release-20261019.0 binary. Their presence
neither proves that Chromium's complete sandbox works nor proves that it fails.

## Consequence for later implementation

After T005/T006/T007 prerequisites, first check a pinned immutable browser image
through the actual owned render-offline path. Retain the outer runtime's exact
host/image/profile qualification and inspect the browser's actual process,
namespace and seccomp state; a successful screenshot or a launch argument alone
cannot replace that evidence. Keep the existing no-credential/offline/resource
and confirmed-cleanup requirements. A browser's own status page is diagnostic
input rather than independent proof of the whole outer or inner boundary.

Do not disable browser isolation, add SYS_ADMIN, share host IPC, change global
host policy, or use host browser execution to make rendering pass. Unsupported
inner isolation remains an explicit T008 prerequisite failure under the existing
candidate Plan. Record the exact failing operation and retained version before
considering any separately reviewed alternative. Documentation lookup does not
authorize replacing the backend or claiming T1 playback support.

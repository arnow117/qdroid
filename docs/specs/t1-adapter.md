# Primebot T1 Pro adapter contract

Status: first planned adapter, not implemented or tested on a robot. Public-source baseline: 2026-10-22; project setup: 2026-10-23. No SSH address, private key, firmware dump, or personal account information belongs in this file.

## Portable boundary

`PrimebotT1Adapter` implements qdroid capability/provider schemas through the vendor SDK. ROS2/FastDDS message types, action IDs, form names, touch sensor IDs, display file paths and vendor priorities stay inside this adapter. Core, Skills and applications must not import these details.

The adapter declares capabilities as implemented/unverified until device qualification proves them. No hazardous capability becomes callable merely because a corresponding SDK method exists. The initial application demo is fixed-position speech/input/display; arbitrary movement and raw joint control are outside that demo.

## Public evidence baseline

The reviewed SDK snapshot is `a460300013003b29b9ad291b1b857b0afe295b22` in [PrimebotTech/primebot-t1-sdk](https://github.com/PrimebotTech/primebot-t1-sdk/tree/a460300013003b29b9ad291b1b857b0afe295b22). The actual delivered firmware/SDK/extensions remain to be recorded on arrival.

| Proposed qdroid capability | Public SDK evidence | Device acceptance still required |
|---|---|---|
| `speech.speak/v1` | PlayTts and audio interfaces | Actual start/finish/interrupt feedback; original agent coexistence |
| ASR input provider | `/aima/agent/asr_result` | Finality, duplicates, session correlation and active publisher |
| `input.touch/v1` | `/aima/hal/touch/state`; T-series back/chest IDs | Actual supported events; conservative single-click mapping |
| `vision.capture/v1` | JPEG/RTSP interfaces | Real camera IDs, orientation, output bounds and ownership |
| `display.video/v1` | PlayEmotion file playback | Player node/path, codecs/profile/size, replacement and clear behavior |
| `motion.action/v1` | High-level action/preset/source controls | Per-action preconditions, observation, cancellation and manual takeover |

The application-side `only_asr`, final ASR JSON and TTS-status extension clues are not proof that the delivered firmware supplies compatible services. Inspect actual schemas; do not fabricate a compatible type or treat an unavailable extension as mandatory core functionality.

## Host and deployment profile

Record actual board roles, OS/architecture/kernel/libc, firmware, installed SDK/runtime packages, resource headroom and permissions. Do not assume the Orin board physically drives the screen. If media playback occurs on another board, use a trusted player agent and authenticated artifact transfer; absolute paths are node-local.

Orin Nano's lack of NVENC makes CPU encoding a relevant design constraint, but actual card/animation performance must be measured with vendor services running. Screen dimensions and codec settings are discovered values. The desktop example's 480×480/10fps is not a robot profile.

Probe user namespaces, seccomp, cgroup/controller enforcement, allowed mounts, network isolation and available runtime versions on the actual host. OpenShell/gVisor availability is conditional on these facts; board branding is not a qualification report. Do not flash or upgrade a vendor kernel merely to satisfy an unverified runtime candidate.

## Input and speech mapping

Map verified touch events to semantic `ui.next`/`ui.back` actions in RobotProfile. Do not hardcode a head-touch assumption inherited from another model. Record any single/multiple-click contradiction in docs and bind only proven events.

ASR events retain source identity, finality and event/correlation IDs where available; deduplicate without automatically replaying commands after reconnect. Verify whether qdroid can own a conversation while preserving vendor ASR, safety announcements and recovery of the original agent mode. Requested mode changes need a lease and crash-safe restoration contract, not only a finally block.

Speech receipts distinguish accepted, observed playing, finished, stopped and unknown. Missing continuous playback progress prevents a promise of precise word-synchronized subtitles. The first display path uses silent visual cards to avoid an unverified audio/video synchronization contract.

## Display implementation

The HTML video renderer produces a bounded, validated media artifact. A trusted media importer checks ownership/provenance/size/digest/output profile and stages it atomically into the actual player node. The application receives ArtifactRef, not a path or SSH key.

A single player-agent submits PlayEmotion on behalf of qdroid, with policy-selected priority and loop count. It serializes requests and coalesces unsent revisions; unresolved submission becomes unknown. Already-dispatched vendor requests cannot be canceled by changing a host revision field. Verify real replacement/order/feedback before asserting latest-visible semantics.

An independent service on the player node enforces the display lease and restores a pre-generated default/vendor-safe display. Test coordinator crash, player-agent restart, lost inter-board link, stale epoch and delayed RPC. A finite clip may leave a final frame visible; do not use duration as a privacy clearing guarantee. Without bounded fallback evidence, prohibit unattended sensitive scenes and report the exact limitation.

Vendor alarms and manual intervention remain authoritative under the verified vendor priority scheme. Do not escalate priority indefinitely to win the screen back.

## Device resource and motion rules

SDK source registration, priority and timeout are adapter state, with boot/epoch reconciliation and resource ownership. Releasing a source can hand control to another source; it is not proof of an emergency stop. A timeout after dispatch is not proof that the action failed.

Future bounded motion maps explicit SI units, supported axes, frame and finite local lease into vendor commands. robotd enforces limits and form/precondition checks locally. The LLM never publishes servo frames or accesses HAL devices. Run only separately authorized physical acceptance cases, preserving hardware/manual takeover and a concrete recovery method.

## Arrival and qualification sequence

1. Obtain legitimate device access and record the actual system/firmware/SDK baseline; save only necessary local non-public evidence.
2. Read-only map the board/display/SDK services and process manager. Identify the exact player, permitted deployment locations and recovery path.
3. Inspect actual ASR/touch/TTS schemas, supported events and publisher behavior. Keep unverified capabilities disabled.
4. Qualify the chosen sandbox on a non-destructive controlled workload; verify host resource limits and denial of control-network/device access.
5. Present an owned test MP4 and restore the original display. Measure actual codec, dimensions, replacement, replay, interruption and fallback behavior.
6. Exercise fixed-position voice/touch scene navigation with delayed results, duplicate input, coordinator crash and link loss.
7. Add read-only Lark test-account input only after its separate account authorization and connector checks; keep private source material out of public evidence.
8. Treat any physical action qualification as its own authorized acceptance, with limits, observation, manual takeover and stop evidence.

Record tested host/profile/image/provider/firmware versions, command/result summaries, timing/resource observations and unresolved behavior. The adapter's public support matrix lists exactly the verified capabilities and their weaker guarantees.

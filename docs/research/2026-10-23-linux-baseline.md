# Linux development baseline

Recorded 2026-10-23. This describes the environment selected for T002. Passing environment preflights is not qualification of the final application image or a T1 robot.

## Relationship to T1

The [official T1 SDK guide, pinned at a460300](https://github.com/PrimebotTech/primebot-t1-sdk/blob/a460300013003b29b9ad291b1b857b0afe295b22/PrimeBot_SDK%E5%BF%AB%E9%80%9F%E5%85%A5%E9%97%A8%E4%B8%8E%E9%9B%86%E6%88%90%E6%8C%87%E5%8D%97.md) recommends Ubuntu 22.04 and ROS2 Humble for SDK development and documents Docker build environments. qdroid therefore uses Ubuntu 22.04 as the initial application image base. The reference simulator has no ROS dependency; vendor SDK/ROS integration belongs in the trusted T1 adapter.

An Ubuntu container supplies userspace, not the host kernel. The dedicated development VM currently runs Ubuntu 24.04.4, Linux 6.8.0-100-generic, ARM64, Docker 29.2.1 and cgroup v2. It has four CPUs and 4 GiB memory, with no host workspace mounts. These are development resources, not measurements of T1 capacity or compatibility.

## Fixed inputs

| Input | Selected value |
|---|---|
| Ubuntu application base | `ubuntu@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956` |
| Node binary source image | `node@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203` — Node 24.16.0 |
| Isolation runtime | [gVisor release-20261019.0](https://github.com/google/gvisor/releases/tag/release-20261019.0), ARM64, systrap, network none |
| runsc SHA-256 | `c771292129c7ff96e83c5074485e3d33cfc938652dc70682bb792a66842d4de2` |
| gvisor_sentry SHA-256 | `79f406de247333489ad3e1bdc5c936ede9bbe1eb1b36a315b601bc782c56aa16` |

The selected image digests were pulled and exercised on ARM64. This does not qualify another architecture. The final fixture image additionally contains project code and requires its own image identity and qualification evidence.

The complete gVisor archive and adjacent sidecars were installed together, following the current [installation model](https://gvisor.dev/docs/user_guide/install/). The dedicated runtime is registered separately; the Docker default remains unchanged. No automatic downgrade to that default is permitted.

## Evidence boundaries

Initial probes successfully ran non-root Ubuntu/Node under gVisor. A bounded memory-allocation probe was killed with exit 137 and Docker `OOMKilled: true`; a bounded fork probe reached `EAGAIN` under the guest process limit. Their containers were removed. Final-image tests must repeat the relevant checks and add filesystem, network, CPU, scratch, output, deadline, identity and descendant-cleanup evidence.

gVisor guest processes do not map one-to-one to host PIDs. Its [resource model](https://gvisor.dev/docs/architecture_guide/resources/) therefore informs separate guest process and host cgroup checks; guest `/proc` values alone are insufficient host enforcement evidence.

Actual commands, tested source/image/profile identities and acceptance results belong in the [Feature engineering context](../../.sdlc-v1/context/FEAT-MVP-001.engineering.md). The [usage guide](../USAGE.md) owns reproducible operations. T1 host kernel, vendor-service coexistence and on-device resource budgets remain unverified.

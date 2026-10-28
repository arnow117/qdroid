import assert from 'node:assert/strict';
import test from 'node:test';

import { runLinuxReadonlyFixtureSuite } from '../../../fixtures/readonly-sim/src/linux-broker.js';

const image = process.env.QDROID_T002_IMAGE;
const suitePromise = image === undefined ? undefined : runLinuxReadonlyFixtureSuite({ image });

test(
  'the fixed gVisor profile qualifies before a bound Linux fixture runs',
  { skip: image === undefined },
  async (t) => {
    if (suitePromise === undefined) {
      return;
    }

    const suite = await suitePromise;

    assert.equal(suite.qualification.profile.runtime, 'qdroid-runsc');
    assert.equal(suite.qualification.profile.network, 'none');
    assert.equal(suite.qualification.profile.readOnlyRoot, true);
    assert.equal(suite.qualification.profile.sharedMemoryMiB, 64);
    assert.equal(suite.qualification.probes.filesystem.nonRoot, true);
    assert.equal(suite.qualification.probes.filesystem.readOnlyRoot, true);
    assert.equal(suite.qualification.probes.filesystem.rootMountReadOnly, true);
    assert.equal(suite.qualification.probes.filesystem.zeroEffectiveCapabilities, true);
    assert.equal(suite.qualification.probes.filesystem.noNewPrivileges, true);
    assert.equal(suite.qualification.probes.filesystem.canaryUnreadable, true);
    assert.equal(suite.qualification.probes.filesystem.canaryUnmodified, true);
    assert.equal(suite.qualification.probes.filesystem.hostCanaryUnchanged, true);
    assert.equal(suite.qualification.probes.filesystem.syntheticSecretUnreadable, true);
    assert.equal(suite.qualification.probes.filesystem.trustedStoreUnreadable, true);
    assert.equal(suite.qualification.probes.filesystem.dockerSocketUnreadable, true);
    assert.equal(suite.qualification.probes.filesystem.privateScratch, true);
    assert.equal(suite.qualification.probes.pids.forkDenied, true);
    assert.equal(suite.qualification.probes.io.cgroupHostPidsLimit, 256);
    assert.equal(suite.qualification.probes.io.cgroupCpuQuotaMicros, 50_000);
    assert.equal(suite.qualification.probes.io.cgroupCpuPeriodMicros, 100_000);
    assert.equal(suite.qualification.probes.io.cgroupReadLimitBytesPerSecond, 1_048_576);
    assert.equal(suite.qualification.probes.io.qualificationSyntheticFileBytes, 16 * 1024 * 1024);
    assert.ok(
      suite.qualification.probes.io.cgroupReadBytesObserved >=
        suite.qualification.probes.io.qualificationSyntheticFileBytes,
    );
    assert.ok(suite.qualification.probes.io.elapsedMs >= 12_000);
    assert.ok(Number.isFinite(suite.qualification.probes.cpu.cpuToWallRatio));
    assert.ok(suite.qualification.probes.cpu.hostCpuToWallRatio <= 0.8);
    assert.ok(suite.qualification.probes.cpu.hostUsageMicros > 0);
    assert.ok(suite.qualification.probes.cpu.observedThrottledPeriods > 0);
    assert.equal(suite.qualification.probes.outputLimit.enforced, true);
    assert.equal(suite.qualification.probes.deadline.enforced, true);
    assert.equal(suite.qualification.probes.descendantCleanup.confirmed, true);
    assert.deepEqual(suite.qualification.probes.network.controlTargetReceipts, {
      dnsUdp: true,
      ipv6Tcp: true,
      tcpIpv4: true,
      udpIpv4: true,
    });
    assert.equal(suite.qualification.probes.network.controlTargetReceivedPackets, 0);
    assert.equal(suite.qualification.probes.memory.oomKilled, true);
    assert.equal(suite.qualification.probes.scratch.enospc, true);

    t.diagnostic(
      `qualification=${JSON.stringify({
        cpu: suite.qualification.probes.cpu,
        imageId: suite.qualification.imageId,
        io: suite.qualification.probes.io,
        network: suite.qualification.probes.network,
      })}`,
    );
  },
);

test(
  'Linux workload calls remain supervisor-bound and deny untrusted authority',
  { skip: image === undefined },
  async (t) => {
    if (suitePromise === undefined) {
      return;
    }

    const suite = await suitePromise;

    assert.equal(suite.allow.simulatorOperationCount, 1);
    assert.equal(suite.none.simulatorOperationCount, 0);
    assert.equal(suite.deny.simulatorOperationCount, 0);
    assert.equal(suite.forgedAuthority.simulatorOperationCount, 0);
    assert.equal(suite.duplicateKey.simulatorOperationCount, 0);
    assert.equal(suite.activeDeny.simulatorOperationCount, 0);
    assert.equal(suite.unsupportedMethod.simulatorOperationCount, 0);
    assert.equal(suite.none.errorCode, 'QD_PERMISSION_DENIED');
    assert.equal(suite.deny.errorCode, 'QD_PERMISSION_DENIED');
    assert.equal(suite.forgedAuthority.errorCode, 'QD_VALIDATION_FAILED');
    assert.equal(suite.duplicateKey.errorCode, 'QD_VALIDATION_FAILED');
    assert.equal(suite.activeDeny.errorCode, 'QD_PERMISSION_DENIED');
    assert.equal(suite.unsupportedMethod.errorCode, 'QD_UNSUPPORTED_CAPABILITY');
    assert.equal(suite.allow.errorCode, undefined);
    assert.equal(suite.allow.binding.bootId, suite.qualification.host.bootId);

    const scenarios = [
      suite.activeDeny,
      suite.allow,
      suite.deny,
      suite.duplicateKey,
      suite.forgedAuthority,
      suite.none,
      suite.unsupportedMethod,
    ];

    for (const scenario of scenarios) {
      assert.equal(scenario.stopReason, 'completed');
      assert.equal(scenario.exitCode, 0);
      assert.equal(scenario.workloadReceivedResponse, true);
    }

    t.diagnostic(
      `first-call=${JSON.stringify({
        activeDeny: suite.activeDeny.errorCode,
        allow: suite.allow.errorCode,
        deny: suite.deny.errorCode,
        duplicateKey: suite.duplicateKey.errorCode,
        forgedAuthority: suite.forgedAuthority.errorCode,
        none: suite.none.errorCode,
        operationCounts: {
          activeDeny: suite.activeDeny.simulatorOperationCount,
          allow: suite.allow.simulatorOperationCount,
          deny: suite.deny.simulatorOperationCount,
          duplicateKey: suite.duplicateKey.simulatorOperationCount,
          forgedAuthority: suite.forgedAuthority.simulatorOperationCount,
          none: suite.none.simulatorOperationCount,
          unsupportedMethod: suite.unsupportedMethod.simulatorOperationCount,
        },
        unsupportedMethod: suite.unsupportedMethod.errorCode,
      })}`,
    );
  },
);

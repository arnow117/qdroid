import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DockerSandboxManager,
  type NetworkControlReceipts,
} from '../../packages/runtime-oci/src/index.js';
import type {
  BoundedProbeInspection,
  LegacyNetworkReceiptSnapshot,
  OwnedLegacyNetworkControls,
  OwnedProbe,
  OwnedProbeExecution,
  ResourceCleanupEvidence,
  RuntimeResourceOps,
  TrustedProbeRecipe,
} from '../../packages/runtime-oci/src/resource-ops.js';

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const CONTAINER_ID = 'b'.repeat(64);

interface ManagedNetworkProbeManager {
  runNetworkProbe(image: string): Promise<{
    controlTargetReachable: boolean;
    controlTargetReceipts: NetworkControlReceipts;
    controlTargetReceivedPackets: number;
  }>;
}

test('managed legacy network qualification uses opaque controls before any synthetic target', async () => {
  const events: string[] = [];
  const controls = createLegacyControls(events);
  const probe = createNetworkProbe(events);
  const resources = {
    createNetworkControls: async (kind: 'legacy') => {
      events.push(`controls:${kind}`);
      return controls;
    },
    prepareProbe: async (recipe: TrustedProbeRecipe) => {
      events.push(`probe:${recipe.kind}:${recipe.selection.kind}`);
      assert.equal(recipe.kind, 'legacy-fixed-profile');
      assert.equal(recipe.selection.kind, 'network');
      if (recipe.selection.kind === 'network') {
        assert.equal(recipe.selection.controls, controls);
      }
      return probe;
    },
  } as unknown as RuntimeResourceOps;
  const manager = new DockerSandboxManager({ image: IMAGE_ID, resources }) as unknown as
    | DockerSandboxManager
    | ManagedNetworkProbeManager;

  const result = await (manager as ManagedNetworkProbeManager).runNetworkProbe(IMAGE_ID);

  assert.deepEqual(result, {
    controlTargetReachable: true,
    controlTargetReceipts: {
      dnsUdp: true,
      ipv6Tcp: true,
      tcpIpv4: true,
      udpIpv4: true,
    },
    controlTargetReceivedPackets: 0,
  });
  assert.deepEqual(events, [
    'controls:legacy',
    'healthy',
    'positive',
    'healthy',
    'reset',
    'probe:legacy-fixed-profile:network',
    'probe:create',
    'probe:inspect',
    'probe:start',
    'probe:close-input',
    'healthy',
    'snapshot',
    'probe:remove',
    'dispose',
  ]);
});

test('managed legacy network qualification fails closed before the raw synthetic target', async () => {
  const events: string[] = [];
  const resources = {
    createNetworkControls: async () => {
      events.push('controls:legacy');
      throw new Error('managed control creation rejected');
    },
  } as unknown as RuntimeResourceOps;
  const manager = new DockerSandboxManager({ image: IMAGE_ID, resources }) as unknown as
    | DockerSandboxManager
    | ManagedNetworkProbeManager;

  await assert.rejects(
    (manager as ManagedNetworkProbeManager).runNetworkProbe(IMAGE_ID),
    /managed control creation rejected/,
  );
  assert.deepEqual(events, ['controls:legacy']);
});

function createLegacyControls(events: string[]): OwnedLegacyNetworkControls {
  const snapshot: LegacyNetworkReceiptSnapshot = Object.freeze({
    settled: true,
    tcpIpv4: false,
    tcpIpv6: false,
    udpDns: false,
    udpIpv4: false,
  });
  return Object.freeze({
    assertHealthy: async (): Promise<void> => {
      events.push('healthy');
    },
    assertPositiveControls: async (): Promise<void> => {
      events.push('positive');
    },
    dispose: async (): Promise<ResourceCleanupEvidence> => {
      events.push('dispose');
      return confirmedCleanup();
    },
    resetReceipts: async (): Promise<void> => {
      events.push('reset');
    },
    snapshot: async (): Promise<LegacyNetworkReceiptSnapshot> => {
      events.push('snapshot');
      return snapshot;
    },
  });
}

function createNetworkProbe(events: string[]): OwnedProbe {
  return Object.freeze({
    create: async (): Promise<void> => {
      events.push('probe:create');
    },
    inspect: async (): Promise<BoundedProbeInspection> => {
      events.push('probe:inspect');
      return {
        binding: {
          fullId: CONTAINER_ID,
          imageId: IMAGE_ID,
          labels: { 'io.qdroid.owner': 'test-owner' },
        },
        fixedProfileVerified: true,
        kind: 'configuration',
      };
    },
    start: async (): Promise<OwnedProbeExecution> => {
      events.push('probe:start');
      return Object.freeze({
        closeInput: async (): Promise<void> => {
          events.push('probe:close-input');
        },
        command: async (): Promise<void> => {
          throw new Error('The fixed legacy network probe does not accept control input.');
        },
        completion: Promise.resolve({
          cleanupConfirmed: false,
          exitCode: 0,
          reason: 'completed' as const,
          stderrBytes: 0,
          stdoutBytes: Buffer.byteLength('{"attempted":4}'),
        }),
        stderr: emptyOutput(),
        stdout: textOutput('{"attempted":4}'),
        stop: async (): Promise<ResourceCleanupEvidence> => confirmedCleanup(),
      });
    },
    stopAndRemove: async (): Promise<ResourceCleanupEvidence> => {
      events.push('probe:remove');
      return confirmedCleanup();
    },
  });
}

function confirmedCleanup(): ResourceCleanupEvidence {
  return Object.freeze({ cleanupConfirmed: true, status: 'confirmed' });
}

async function* emptyOutput(): AsyncIterable<Uint8Array> {
  return;
}

async function* textOutput(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value, 'utf8');
}

import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  SandboxBackend,
  SandboxCleanupEvidence,
  SandboxExecutionHandle,
  SandboxExecutionRequest,
  SandboxIdentityBinding,
  SandboxInstance,
  SandboxQualification,
} from '../../../packages/contracts/src/index.js';
import {
  OciOfflineBuildExecutor,
  type OciOfflineBuildExecutorBackendInput,
} from '../../../packages/runtime-oci/src/index.js';
import type { RuntimeResourceOps } from '../../../packages/runtime-oci/src/resource-ops.js';

const BUILDER_IMAGE = `sha256:${'b'.repeat(64)}`;
const identity: SandboxIdentityBinding = {
  bootId: 'boot-1',
  channelId: 'channel-1',
  epoch: 1,
  installationId: 'installation-1',
  instanceId: 'instance-1',
};

test('the offline executor qualifies the builder candidate and closes stdin before output', async () => {
  const calls: string[] = [];
  const requests: SandboxExecutionRequest[] = [];
  let backendInput: OciOfflineBuildExecutorBackendInput | undefined;
  const backend: SandboxBackend = {
    create: async (_qualification, receivedIdentity) => {
      calls.push('create');
      assert.deepEqual(receivedIdentity, identity);
      return {} as SandboxInstance;
    },
    execute: async (_sandbox, request) => {
      calls.push('execute');
      requests.push(request);
      return executionHandle(calls, 'completed');
    },
    qualify: async (profile) => {
      calls.push('qualify');
      assert.equal(profile, 'build-restricted');
      return qualification();
    },
    stop: async () => {
      calls.push('stop');
      return confirmedCleanup();
    },
  };
  const executor = new OciOfflineBuildExecutor({
    createBackend: (input) => {
      backendInput = input;
      return backend;
    },
    createIdentity: async () => identity,
    ownerStorePath: '/trusted/owners',
    resources: unusedResources(),
  });

  const result = await executor.execute(buildRequest());
  const completion = await result.completion;

  assert.equal(backendInput?.image, BUILDER_IMAGE);
  assert.equal(backendInput?.ownerStorePath, '/trusted/owners');
  assert.deepEqual(calls, ['qualify', 'create', 'execute', 'close-input']);
  assert.deepEqual(requests, [
    {
      argv: ['build.mjs', '--offline'],
      cwd: '/opt/qdroid/packages/package/source',
      environment: { LANG: 'C.UTF-8', TZ: 'UTC' },
      executable: '/usr/local/bin/node',
    },
  ]);
  assert.deepEqual(completion, {
    cleanupConfirmed: true,
    exitCode: 0,
    reason: 'completed',
  });

  await result.cancel?.();
  assert.deepEqual(calls, ['qualify', 'create', 'execute', 'close-input', 'stop']);
});

test('an input-close failure stops the same sandbox and refuses an unresolved cleanup', async () => {
  const calls: string[] = [];
  const backend: SandboxBackend = {
    create: async () => ({}) as SandboxInstance,
    execute: async () => executionHandle(calls, 'completed', true),
    qualify: async () => qualification(),
    stop: async () => {
      calls.push('stop');
      return { cleanupConfirmed: false, status: 'unknown' };
    },
  };
  const executor = new OciOfflineBuildExecutor({
    createBackend: () => backend,
    createIdentity: async () => identity,
    ownerStorePath: '/trusted/owners',
    resources: unusedResources(),
  });

  await assert.rejects(
    executor.execute(buildRequest()),
    /input could not close and cleanup is unresolved/,
  );
  assert.deepEqual(calls, ['close-input', 'stop']);
});

function buildRequest() {
  return {
    argv: ['/usr/local/bin/node', 'build.mjs', '--offline'],
    builderImage: BUILDER_IMAGE,
    candidateId: 'candidate-1',
    cwd: '/opt/qdroid/packages/package/source',
    environment: { LANG: 'C.UTF-8', TZ: 'UTC' },
    packageDirectory: '/host/package',
    packageDigest: 'e'.repeat(64),
    profile: 'build-restricted' as const,
    runtime: {
      abi: 'glibc-2.39',
      baseImage: `sha256:${'a'.repeat(64)}`,
      builderImage: BUILDER_IMAGE,
      features: [],
      id: 'catalog/build',
      platform: 'linux/arm64' as const,
      profile: 'build-restricted' as const,
      templateDigest: 'c'.repeat(64),
      toolchainDigest: 'd'.repeat(64),
    },
  };
}

function qualification(): SandboxQualification {
  return {
    fingerprint: 'fingerprint',
    imageId: BUILDER_IMAGE,
    profileDigest: 'profile',
    profileId: 'build-restricted',
  };
}

function executionHandle(
  calls: string[],
  reason: 'completed' | 'deadline' | 'guardian-lost' | 'output-limit' | 'stopped',
  closeFails = false,
): SandboxExecutionHandle {
  return {
    closeInput: async () => {
      calls.push('close-input');
      if (closeFails) {
        throw new Error('input close failed');
      }
    },
    completion: Promise.resolve({
      cleanupConfirmed: true,
      exitCode: 0,
      reason,
      stderrBytes: 0,
      stderrDeliveredBytes: 0,
      stdoutBytes: 0,
      stdoutDeliveredBytes: 0,
    }),
    stderr: chunks([]),
    stdout: chunks([]),
    writeInput: async () => undefined,
  };
}

function confirmedCleanup(): SandboxCleanupEvidence {
  return { cleanupConfirmed: true, status: 'confirmed' };
}

function unusedResources(): RuntimeResourceOps {
  const unexpected = async (): Promise<never> => {
    throw new Error('The fake backend must not create runtime resources.');
  };
  return {
    assertQualificationReady: () => {
      throw new Error('The fake backend must not qualify a runtime.');
    },
    assembleFixed: unexpected,
    createBoundaryControl: unexpected,
    createFixture: unexpected,
    createNetworkControls: unexpected,
    native: unexpected,
    prepareProbe: unexpected,
    verifySealedFixed: unexpected,
  };
}

async function* chunks(values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}

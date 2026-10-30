import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OciSandboxBackend } from '../../packages/runtime-oci/src/index.js';
import type { RuntimeResourceOps } from '../../packages/runtime-oci/src/resource-ops.js';

test('a session-bound backend refuses incomplete managed qualification before any owner-store effect', async () => {
  const ownerStorePath = join(tmpdir(), `qdroid-incomplete-resources-${Date.now()}`);
  const backend = new OciSandboxBackend({
    image: `sha256:${'a'.repeat(64)}`,
    ownerStorePath,
    resources: incompleteResources(),
  });

  await assert.rejects(
    backend.qualify('build-restricted'),
    /has not migrated every qualification creation site/,
  );
  await assert.rejects(lstat(ownerStorePath));
});

function incompleteResources(): RuntimeResourceOps {
  const unavailable = async (): Promise<never> => {
    throw new Error('This test must not create a managed resource.');
  };

  return {
    assertQualificationReady: () => {
      throw new Error(
        'The managed runtime resource provider has not migrated every qualification creation site.',
      );
    },
    assembleFixed: unavailable,
    createBoundaryControl: unavailable,
    createFixture: unavailable,
    createNetworkControls: unavailable,
    native: unavailable,
    prepareProbe: unavailable,
    verifySealedFixed: unavailable,
  };
}

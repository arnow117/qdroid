import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  rm,
  rmdir,
  type FileHandle,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createUstarFixture as createUstar } from '../../../fixtures/packages/src/ustar-fixture.js';
import { readFrozenBundle } from '../../../packages/package-runtime/src/archive.js';
import {
  inventoryDigest,
  beginBuildSessionCleanupOperation,
  PackageInstaller,
  recordBuildSessionProviderTerminal,
  type BuildSessionOwner,
  type PackageInstallerPublicationTestHooks,
  type PackageSource,
  type SessionBoundRuntime,
  type TrustedImageCatalogEntry,
  type TrustedRuntimeFactory,
} from '../../../packages/package-runtime/src/index.js';
import { readTrustedLinuxBootId } from '../../../packages/supervisor/src/index.js';
import {
  ManagedRuntimeResourceOps,
  type LegacyHostInputFixture,
  type OwnedProbe,
} from '../../../packages/runtime-oci/src/resource-ops.js';

const FIXTURE_DEADLINE_MS = 1_000;
const HELD_ADMISSION_DEADLINE_MS = 50;
const T004_CONFIGURATION_IMAGE =
  'sha256:85ec5b256629377c431378387603d94c5b7a4a68be3b687ef35c69989ac76a4d';

test('managed native and legacy-host fixture ownership uses a BuildAuthority owner and serializes settlement', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-runtime-resources-'));
  const source = packageSource('catalog/native-owner');
  const statuses: string[] = [];
  let capturedOwner: BuildSessionOwner | undefined;
  let closeCompleted = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      capturedOwner = owner;
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        await assert.rejects(
          ManagedRuntimeResourceOps.create({
            bootId: await readTrustedLinuxBootId(),
            owner,
            ownerId: owner.ownerId,
            resourceDirectory: owner.privateStateDirectory,
            sessionId: owner.sessionId,
          }),
          /already has a managed resource provider initialization/,
        );
        await assert.rejects(
          ManagedRuntimeResourceOps.create({
            bootId: await readTrustedLinuxBootId(),
            owner: { ...owner },
            ownerId: owner.ownerId,
            resourceDirectory: owner.privateStateDirectory,
            sessionId: owner.sessionId,
          }),
          /BuildSession owner is not active for a trusted runtime operation/,
        );

        const [first, second] = await Promise.all([
          resources.native({ kind: 'machine-architecture' }),
          resources.native({ kind: 'kernel-release' }),
        ]);
        const [firstResult, secondResult] = await Promise.all([
          first.completion,
          second.completion,
        ]);
        assert.equal(firstResult.cleanupConfirmed, true);
        assert.equal(secondResult.cleanupConfirmed, true);

        const fixture = await resources.createFixture({ kind: 'legacy-host-inputs' });
        assert.equal(await fixture.assertUnchanged(), true);
        assert.equal(dirname(fixture.paths.canary), dirname(fixture.paths.secret));
        assert.equal(dirname(fixture.paths.canary), dirname(fixture.paths.store));
        assert.match(
          fixture.paths.canary,
          new RegExp(`^${escapeRegularExpression(owner.privateStateDirectory)}/fixtures/fixture-`),
        );
        const [canary, secret, store] = await Promise.all([
          lstat(fixture.paths.canary),
          lstat(fixture.paths.secret),
          lstat(fixture.paths.store),
        ]);
        assert.equal(canary.isFile(), true);
        assert.equal(secret.isFile(), true);
        assert.equal(store.isFile(), true);
        assert.equal(canary.mode & 0o777, 0o644);
        assert.equal(secret.mode & 0o777, 0o600);
        assert.equal(store.mode & 0o777, 0o600);

        const forgedFixture: LegacyHostInputFixture = {
          ...fixture,
          paths: { ...fixture.paths },
        };
        await assert.rejects(
          resources.prepareProbe({
            imageId: `sha256:${'a'.repeat(64)}`,
            kind: 'legacy-fixed-profile',
            selection: { fixture: forgedFixture, kind: 'filesystem' },
          }),
          /fixture handle is not active for this session/,
        );
        const preparedFilesystemProbe = await resources.prepareProbe({
          imageId: `sha256:${'a'.repeat(64)}`,
          kind: 'legacy-fixed-profile',
          selection: { fixture, kind: 'filesystem' },
        });
        assert.deepEqual(await preparedFilesystemProbe.stopAndRemove(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        const fixtureDisposal = fixture.dispose();
        await assert.rejects(
          resources.prepareProbe({
            imageId: `sha256:${'a'.repeat(64)}`,
            kind: 'legacy-fixed-profile',
            selection: { fixture, kind: 'filesystem' },
          }),
          /fixture handle is not active for this session/,
        );
        assert.strictEqual(fixture.dispose(), fixtureDisposal);
        assert.deepEqual(await fixtureDisposal, {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        await assert.rejects(
          resources.prepareProbe({
            imageId: `sha256:${'a'.repeat(64)}`,
            kind: 'legacy-fixed-profile',
            selection: { fixture, kind: 'filesystem' },
          }),
          /fixture handle is not active for this session/,
        );
        await Promise.all(
          [fixture.paths.canary, fixture.paths.secret, fixture.paths.store].map((path) =>
            assert.rejects(lstat(path), /ENOENT/),
          ),
        );

        const ioFixture = await resources.createFixture({ kind: 'legacy-io-file' });
        const ioStatus = await lstat(ioFixture.sourcePath);
        assert.equal(ioStatus.isFile(), true);
        assert.equal(ioStatus.mode & 0o777, 0o644);
        assert.equal(ioStatus.size, 16 * 1024 * 1024);
        const ioFixtureDisposal = ioFixture.dispose();
        assert.strictEqual(ioFixture.dispose(), ioFixtureDisposal);
        assert.deepEqual(await ioFixtureDisposal, {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        await assert.rejects(lstat(ioFixture.sourcePath), /ENOENT/);

        const journalPath = join(
          owner.privateStateDirectory,
          `${owner.sessionId}.native-resources.json`,
        );
        const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
          readonly resources: readonly { readonly status: string }[];
        };
        statuses.push(...journal.resources.map((resource) => resource.status));
        return sealedImage();
      });
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    await installer.install({ sourceId: source.id, target: 'linux/arm64' });
    closeCompleted = true;
    assert.deepEqual(statuses, [
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
    ]);

    const retiredOwner = capturedOwner as BuildSessionOwner;
    await assert.rejects(
      ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner: retiredOwner,
        ownerId: retiredOwner.ownerId,
        resourceDirectory: retiredOwner.privateStateDirectory,
        sessionId: retiredOwner.sessionId,
      }),
      /BuildSession owner is not active for a trusted runtime operation/,
    );
  } finally {
    if (closeCompleted) {
      await removeFixtureRoot(root);
    } else {
      t.diagnostic(`Retained managed native resource evidence: ${root}`);
    }
  }
});

test('managed fixed scratch probe preserves command completion until exact removal', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-fixed-scratch-probe-'));
  const source = packageSource('catalog/managed-fixed-scratch-probe');
  let cleaned = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const probe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'scratch-write' },
        });
        await probe.create();
        const execution = await probe.start();
        await execution.closeInput();
        const [stdout, completion] = await Promise.all([
          collectProbeOutput(execution.stdout),
          execution.completion,
        ]);

        assert.equal(completion.reason, 'completed');
        assert.equal(completion.exitCode, 0);
        assert.equal(completion.cleanupConfirmed, false);
        assert.equal(JSON.parse(stdout).wrote, true);

        const state = await probe.inspect({ kind: 'container-state' });
        assert.equal(state.kind, 'container-state');
        assert.equal(state.state, 'exited');

        const cleanup = execution.stop();
        assert.strictEqual(probe.stopAndRemove(), cleanup);
        assert.deepEqual(await cleanup, { cleanupConfirmed: true, status: 'confirmed' });
        return sealedImage();
      });
    },
  };

  try {
    await createInstaller(root, source, runtimeFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    await removeFixtureRoot(root);
    cleaned = true;
  } finally {
    if (!cleaned) {
      t.diagnostic(`Retained fixed scratch-probe evidence: ${root}`);
    }
  }
});

test('managed fixed filesystem probe accepts only its registered host-input fixture', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-fixed-filesystem-probe-'));
  const source = packageSource('catalog/managed-fixed-filesystem-probe');
  let cleaned = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const fixture = await resources.createFixture({ kind: 'legacy-host-inputs' });
        const probe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { fixture, kind: 'filesystem' },
        });
        await probe.create();
        const execution = await probe.start();
        await execution.closeInput();
        const [stdout, completion] = await Promise.all([
          collectProbeOutput(execution.stdout),
          execution.completion,
        ]);
        const output = JSON.parse(stdout) as Record<string, unknown>;

        assert.equal(completion.reason, 'completed');
        assert.equal(completion.exitCode, 0);
        assert.equal(completion.cleanupConfirmed, false);
        assert.equal(output.canaryUnreadable, true);
        assert.equal(output.syntheticSecretUnreadable, true);
        assert.equal(output.trustedStoreUnreadable, true);
        assert.equal(await fixture.assertUnchanged(), true);

        assert.deepEqual(await probe.stopAndRemove(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        assert.deepEqual(await fixture.dispose(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        return sealedImage();
      });
    },
  };

  try {
    await createInstaller(root, source, runtimeFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    await removeFixtureRoot(root);
    cleaned = true;
  } finally {
    if (!cleaned) {
      t.diagnostic(`Retained fixed filesystem-probe evidence: ${root}`);
    }
  }
});

test('managed filesystem fixture disposal drains a prepared probe before deleting its inputs', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-filesystem-probe-dependency-'));
  const source = packageSource('catalog/managed-filesystem-probe-dependency');
  let cleaned = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const fixture = await resources.createFixture({ kind: 'legacy-host-inputs' });
        const probe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { fixture, kind: 'filesystem' },
        });

        assert.deepEqual(await fixture.dispose(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        await assert.rejects(probe.create(), /fixed configuration probe handle is stopped/);
        await assert.rejects(probe.start(), /fixed configuration probe handle is stopped/);
        return sealedImage();
      });
    },
  };

  try {
    await createInstaller(root, source, runtimeFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    await removeFixtureRoot(root);
    cleaned = true;
  } finally {
    if (!cleaned) {
      t.diagnostic(`Retained filesystem-probe dependency evidence: ${root}`);
    }
  }
});

test('managed fixed selector catalog retains program limits and original command outcomes', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-fixed-selector-limits-'));
  const source = packageSource('catalog/managed-fixed-selector-limits');
  let cleaned = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const outputProbe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'output-limit' },
        });
        await outputProbe.create();
        const outputExecution = await outputProbe.start();
        await outputExecution.closeInput();
        const [, outputCompletion] = await Promise.all([
          collectProbeOutput(outputExecution.stdout),
          outputExecution.completion,
        ]);
        assert.equal(outputCompletion.reason, 'output-limit');
        assert.equal(outputCompletion.cleanupConfirmed, false);
        assert.ok(outputCompletion.stdoutBytes > 8_192);
        assert.deepEqual(await outputExecution.stop(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });

        const descendantProbe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'descendants' },
        });
        await descendantProbe.create();
        const descendantExecution = await descendantProbe.start();
        await descendantExecution.closeInput();
        const startedAt = Date.now();
        const descendantCompletion = await descendantExecution.completion;
        const elapsedMs = Date.now() - startedAt;
        assert.equal(descendantCompletion.reason, 'deadline');
        assert.equal(descendantCompletion.cleanupConfirmed, false);
        assert.ok(elapsedMs >= 1_500);
        assert.ok(elapsedMs < 5_000);
        assert.deepEqual(await descendantExecution.stop(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });

        const pidsProbe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'pids' },
        });
        await pidsProbe.create();
        const pidsExecution = await pidsProbe.start();
        await pidsExecution.closeInput();
        const [pidsOutput, pidsCompletion] = await Promise.all([
          collectProbeOutput(pidsExecution.stdout),
          pidsExecution.completion,
        ]);
        assert.equal(pidsCompletion.reason, 'completed');
        assert.equal(pidsCompletion.exitCode, 0);
        assert.equal(pidsCompletion.cleanupConfirmed, false);
        assert.equal(JSON.parse(pidsOutput).forkDenied, true);
        assert.deepEqual(await pidsExecution.stop(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });

        const scratchProbe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'scratch-limit' },
        });
        await scratchProbe.create();
        const scratchExecution = await scratchProbe.start();
        await scratchExecution.closeInput();
        const [scratchOutput, scratchCompletion] = await Promise.all([
          collectProbeOutput(scratchExecution.stdout),
          scratchExecution.completion,
        ]);
        assert.equal(scratchCompletion.reason, 'completed');
        assert.equal(scratchCompletion.exitCode, 0);
        assert.equal(scratchCompletion.cleanupConfirmed, false);
        assert.equal(JSON.parse(scratchOutput).enospc, true);
        assert.deepEqual(await scratchExecution.stop(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });

        const memoryProbe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'memory' },
        });
        await memoryProbe.create();
        const memoryExecution = await memoryProbe.start();
        await memoryExecution.closeInput();
        const memoryCompletion = await memoryExecution.completion;
        assert.equal(memoryCompletion.reason, 'completed');
        assert.equal(memoryCompletion.exitCode, 137);
        assert.equal(memoryCompletion.cleanupConfirmed, false);
        assert.deepEqual(await memoryExecution.stop(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        return sealedImage();
      });
    },
  };

  try {
    await createInstaller(root, source, runtimeFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    await removeFixtureRoot(root);
    cleaned = true;
  } finally {
    if (!cleaned) {
      t.diagnostic(`Retained fixed selector-limit evidence: ${root}`);
    }
  }
});

test('managed profile controls use the fixed tool-offline envelope and retain exact cleanup', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-profile-controls-'));
  const source = packageSource('catalog/managed-profile-controls');
  let completed = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const probe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'profile-tuple',
          profileId: 'tool-offline',
          selection: { kind: 'controls' },
        });

        await probe.create();
        const execution = await probe.start();
        await execution.closeInput();
        const [stdout, completion] = await Promise.all([
          collectProbeOutput(execution.stdout),
          execution.completion,
        ]);
        assert.equal(completion.reason, 'completed');
        assert.equal(completion.exitCode, 0);
        assert.equal(completion.cleanupConfirmed, false);
        assert.deepEqual(JSON.parse(stdout), {
          noNewPrivileges: true,
          nonRoot: true,
          rootReadOnly: true,
        });
        assert.deepEqual(await probe.stopAndRemove(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        return sealedImage();
      });
    },
  };

  try {
    await createInstaller(root, source, runtimeFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    await removeFixtureRoot(root);
    completed = true;
  } finally {
    if (!completed) {
      t.diagnostic(`Retained managed profile-controls evidence: ${root}`);
    }
  }
});

test('managed host-boundary controls bind the fixed keeper before the probe creates Docker state', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-host-boundary-'));
  const source = packageSource('catalog/managed-host-boundary');
  let completed = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const boundary = await resources.createBoundaryControl();
        await boundary.assertPositiveControls();

        for (const profileId of ['build-restricted', 'render-offline', 'tool-offline'] as const) {
          const probe = await resources.prepareProbe({
            imageId: T004_CONFIGURATION_IMAGE,
            kind: 'profile-tuple',
            profileId,
            selection: { boundary, kind: 'host-boundary' },
          });
          await probe.create();
          const configuration = await probe.inspect({ kind: 'configuration' });
          assert.equal(configuration.kind, 'configuration');
          assert.equal(configuration.fixedProfileVerified, true);
          const execution = await probe.start();
          await execution.closeInput();
          const [stdout, completion] = await Promise.all([
            collectProbeOutput(execution.stdout),
            execution.completion,
          ]);
          assert.equal(completion.reason, 'completed');
          assert.equal(completion.exitCode, 0);
          assert.deepEqual(JSON.parse(stdout), {
            controlledDeviceUnreadable: true,
            crossAppUnreadable: true,
            dockerSocketUnreadable: true,
            hostPidHidden: true,
            hostProcessSecretUnreadable: true,
            trustedStoreUnreadable: true,
          });
          assert.deepEqual(await probe.stopAndRemove(), {
            cleanupConfirmed: true,
            status: 'confirmed',
          });
        }

        // A created boundary probe that is stopped before `docker start` must
        // still retain and authenticate its immutable never-started outcome
        // before the keeper may retire this exact dependency.
        const neverStartedProbe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'profile-tuple',
          profileId: 'build-restricted',
          selection: { boundary, kind: 'host-boundary' },
        });
        await neverStartedProbe.create();
        assert.deepEqual(await neverStartedProbe.stopAndRemove(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });

        await boundary.assertPositiveControls();
        assert.deepEqual(await boundary.dispose(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        return sealedImage();
      });
    },
  };

  try {
    await createInstaller(root, source, runtimeFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    await removeFixtureRoot(root);
    completed = true;
  } finally {
    if (!completed) {
      t.diagnostic(`Retained managed host-boundary evidence: ${root}`);
    }
  }
});

test('managed host-boundary configuration confirms a no-create terminal before control cleanup', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-host-boundary-no-create-'));
  const source = packageSource('catalog/managed-host-boundary-no-create');
  let completed = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        beforeBoundaryDependencyPersist: async () => {
          throw new Error('controlled host-boundary dependency journal failure');
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      const journalPath = join(
        owner.privateStateDirectory,
        `${owner.sessionId}.native-resources.json`,
      );
      return nativeRuntime(resources, async () => {
        const boundary = await resources.createBoundaryControl();
        const probe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'profile-tuple',
          profileId: 'build-restricted',
          selection: { boundary, kind: 'host-boundary' },
        });

        await assert.rejects(probe.create(), /controlled host-boundary dependency journal failure/);
        assert.deepEqual(await probe.stopAndRemove(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });

        const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
          readonly resources: readonly {
            readonly boundary?: {
              readonly terminalReceiptPath?: unknown;
            };
            readonly containerId?: unknown;
            readonly kind?: unknown;
            readonly status?: unknown;
          }[];
        };
        const probeRecord = journal.resources.find((resource) => resource.kind === 'probe');
        assert.notEqual(probeRecord, undefined);
        assert.equal(probeRecord?.containerId, undefined);
        assert.equal(probeRecord?.status, 'confirmed');
        assert.equal(typeof probeRecord?.boundary?.terminalReceiptPath, 'string');

        const terminal = JSON.parse(
          await readFile(probeRecord?.boundary?.terminalReceiptPath as string, 'utf8'),
        ) as {
          readonly status?: unknown;
        };
        assert.equal(terminal.status, 'no-create');

        assert.deepEqual(await boundary.dispose(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        return sealedImage();
      });
    },
  };

  try {
    await createInstaller(root, source, runtimeFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    await removeFixtureRoot(root);
    completed = true;
  } finally {
    if (!completed) {
      t.diagnostic(`Retained host-boundary no-create evidence: ${root}`);
    }
  }
});

test('managed legacy network controls retain the one measurement epoch through disposal', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-legacy-network-'));
  const source = packageSource('catalog/managed-legacy-network');
  let completed = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const controls = await resources.createNetworkControls('legacy');
        await controls.assertHealthy();
        await controls.assertPositiveControls();
        await controls.assertHealthy();
        await controls.resetReceipts();

        assert.deepEqual(await controls.snapshot(), {
          settled: true,
          tcpIpv4: false,
          tcpIpv6: false,
          udpDns: false,
          udpIpv4: false,
        });
        await assert.rejects(
          controls.assertPositiveControls(),
          /no longer permits positive controls/,
        );
        await assert.rejects(controls.resetReceipts(), /cannot reset its receipt epoch/);
        assert.deepEqual(await controls.dispose(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        await controls.assertHealthy();
        await assert.rejects(controls.snapshot(), /being disposed/);
        return sealedImage();
      });
    },
  };

  try {
    await createInstaller(root, source, runtimeFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    await removeFixtureRoot(root);
    completed = true;
  } finally {
    if (!completed) {
      t.diagnostic(`Retained managed legacy network evidence: ${root}`);
    }
  }
});

test('managed profile network controls verify their fixed interface and cache one snapshot epoch', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-profile-network-'));
  const source = packageSource('catalog/managed-profile-network');
  let completed = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const controls = await resources.createNetworkControls('profile');
        await controls.assertHealthy();
        await controls.assertPositiveControls();
        await controls.assertHealthy();
        await controls.resetReceipts();

        const [firstSnapshot, secondSnapshot] = await Promise.all([
          controls.snapshot(),
          controls.snapshot(),
        ]);
        assert.strictEqual(firstSnapshot, secondSnapshot);
        assert.deepEqual(firstSnapshot, {
          settled: true,
          tcpIpv4: false,
          tcpIpv6: false,
          udpDns: false,
          udpIpv4: false,
          udpIpv6: false,
        });

        // The cached path still awaits a keeper health observation.  Disposal
        // must fence that late reply instead of returning the prior snapshot.
        const lateCachedSnapshot = controls.snapshot();
        const disposal = controls.dispose();
        await assert.rejects(lateCachedSnapshot, /being disposed/);
        assert.deepEqual(await disposal, {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        await controls.assertHealthy();
        await assert.rejects(controls.snapshot(), /being disposed/);
        return sealedImage();
      });
    },
  };

  try {
    await createInstaller(root, source, runtimeFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    await removeFixtureRoot(root);
    completed = true;
  } finally {
    if (!completed) {
      t.diagnostic(`Retained managed profile network evidence: ${root}`);
    }
  }
});

test('managed legacy configuration probes create, inspect, and remove one fixed container', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-configuration-probe-'));
  const source = packageSource('catalog/managed-configuration-probe');
  let completed = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const probe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'configuration' },
        });
        await probe.create();

        const configuration = await probe.inspect({ kind: 'configuration' });
        assert.equal(configuration.kind, 'configuration');
        assert.equal(configuration.binding.imageId, T004_CONFIGURATION_IMAGE);
        assert.equal(configuration.binding.labels['io.qdroid.owner'], owner.ownerId);
        assert.equal(configuration.binding.labels['io.qdroid.session'], owner.sessionId);
        assert.equal(configuration.fixedProfileVerified, true);

        const state = await probe.inspect({ kind: 'container-state' });
        assert.equal(state.kind, 'container-state');
        assert.equal(state.state, 'created');
        assert.equal(state.exitCode, 0);
        assert.equal(state.oomKilled, false);

        await assert.rejects(probe.start(), /fixed configuration probe has no start phase/);
        assert.deepEqual(await probe.stopAndRemove(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        return sealedImage();
      });
    },
  };

  try {
    await createInstaller(root, source, runtimeFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    completed = true;
  } finally {
    if (completed) {
      await removeFixtureRoot(root);
    } else {
      t.diagnostic(`Retained managed configuration-probe evidence: ${root}`);
    }
  }
});

test('managed configuration creation stops a created container when ID persistence fails', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-configuration-probe-failure-'));
  const source = packageSource('catalog/managed-configuration-probe-failure');
  let journalPath: string | undefined;
  let cleaned = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        afterProbeCreate: async () => {
          throw new Error('controlled fixed-probe persistence failure');
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      journalPath = join(owner.privateStateDirectory, `${owner.sessionId}.native-resources.json`);
      return nativeRuntime(resources, async () => {
        const probe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'configuration' },
        });
        await probe.create();
        return sealedImage();
      });
    },
  };

  try {
    await assert.rejects(
      createInstaller(root, source, runtimeFactory).install({
        sourceId: source.id,
        target: 'linux/arm64',
      }),
      /controlled fixed-probe persistence failure/,
    );
    await assert.rejects(lstat(journalPath as string), /ENOENT/);
    await removeFixtureRoot(root);
    cleaned = true;
  } finally {
    if (!cleaned) {
      t.diagnostic(`Retained fixed-probe persistence-failure evidence: ${root}`);
    }
  }
});

test('managed configuration creation confirms an idle guardian before probe authorization', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-configuration-probe-idle-'));
  const source = packageSource('catalog/managed-configuration-probe-idle');
  let completed = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        beforeProbeCreate: async () => {
          throw new Error('controlled pre-authorization probe failure');
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      const journalPath = join(
        owner.privateStateDirectory,
        `${owner.sessionId}.native-resources.json`,
      );
      return nativeRuntime(resources, async () => {
        const probe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'configuration' },
        });
        await assert.rejects(probe.create(), /controlled pre-authorization probe failure/);

        const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
          readonly resources: readonly { readonly status: string }[];
        };
        assert.equal(journal.resources.at(-1)?.status, 'confirmed');
        return sealedImage();
      });
    },
  };

  try {
    await createInstaller(root, source, runtimeFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    completed = true;
  } finally {
    if (completed) {
      await removeFixtureRoot(root);
    } else {
      t.diagnostic(`Retained idle configuration-probe evidence: ${root}`);
    }
  }
});

test('managed configuration probe preserves creation and terminal-status persistence failures', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-configuration-probe-double-failure-'));
  const source = packageSource('catalog/managed-configuration-probe-double-failure');
  let journalPath: string | undefined;
  const retained = true;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        afterProbeCreate: async () => {
          throw new Error('controlled fixed-probe creation failure');
        },
        beforeProbeStatusPersist: async (_resourceId, status) => {
          if (status === 'confirmed') {
            throw new Error('controlled fixed-probe terminal status persistence failure');
          }
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      journalPath = join(owner.privateStateDirectory, `${owner.sessionId}.native-resources.json`);
      return nativeRuntime(resources, async () => {
        const probe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'configuration' },
        });
        await probe.create();
        return sealedImage();
      });
    },
  };

  try {
    let installationFailure: unknown;
    try {
      await createInstaller(root, source, runtimeFactory).install({
        sourceId: source.id,
        target: 'linux/arm64',
      });
    } catch (error) {
      installationFailure = error;
    }

    assert.notEqual(installationFailure, undefined);
    const messages = allErrorMessages(installationFailure);
    assert.match(messages, /controlled fixed-probe creation failure/);
    assert.match(messages, /controlled fixed-probe terminal status persistence failure/);
    assert.match(messages, /unresolved cleanup evidence/);
    assert.match(await readFile(journalPath as string, 'utf8'), /"status":"starting"/);
  } finally {
    if (retained) {
      t.diagnostic(`Retained fixed-probe double-failure evidence: ${root}`);
    }
  }
});

test('managed configuration probe preserves an autonomous deadline before delayed ID persistence', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-configuration-probe-deadline-'));
  const source = packageSource('catalog/managed-configuration-probe-deadline');
  let journalPath: string | undefined;
  let releasePersistence: (() => void) | undefined;
  let signalIdMutation: (() => void) | undefined;
  const idMutationStarted = new Promise<void>((resolve) => {
    signalIdMutation = resolve;
  });
  let signalTerminal: (() => void) | undefined;
  const terminalObserved = new Promise<void>((resolve) => {
    signalTerminal = resolve;
  });
  let observedTerminalReason: string | undefined;
  let signalTerminalStatusPersistence: (() => void) | undefined;
  const terminalStatusPersistenceStarted = new Promise<void>((resolve) => {
    signalTerminalStatusPersistence = resolve;
  });
  const persistenceRelease = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  let cleaned = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        afterProbeTerminalObserved: async (reason) => {
          observedTerminalReason = reason;
          signalTerminal?.();
        },
        beforeProbeContainerIdPersist: async () => {
          signalIdMutation?.();
          await persistenceRelease;
        },
        beforeProbeStatusPersist: async (_resourceId, status) => {
          if (status === 'confirmed') {
            signalTerminalStatusPersistence?.();
          }
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      journalPath = join(owner.privateStateDirectory, `${owner.sessionId}.native-resources.json`);
      return nativeRuntime(resources, async () => {
        const probe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'configuration' },
        });
        await probe.create();
        return sealedImage();
      });
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);
  let installing: Promise<unknown> | undefined;
  let primaryFailure: unknown;

  try {
    installing = installer.install({ sourceId: source.id, target: 'linux/arm64' });
    const installationTerminal = observedTerminal(
      installing,
      'The delayed configuration-probe installation unexpectedly completed.',
    );
    await waitForFixtureBarrier(
      idMutationStarted,
      [installationTerminal],
      'the serialized fixed configuration container-ID journal mutation',
    );
    await completesWithin(
      Promise.race([terminalObserved, installationTerminal]),
      12_000,
      'Timed out waiting for the autonomous fixed-probe deadline while the ID mutation is held.',
    );
    assert.equal(observedTerminalReason, 'deadline');
    const heldJournal = await readFile(journalPath as string, 'utf8');
    assert.match(heldJournal, /"status":"starting"/);
    assert.doesNotMatch(heldJournal, /"containerId":/);

    releasePersistence?.();
    await waitForFixtureBarrier(
      terminalStatusPersistenceStarted,
      [installationTerminal],
      'terminal status persistence after the held ID mutation releases',
    );
    const failure = await assertRejectsWithin(
      installationTerminal,
      'The delayed configuration-probe installation did not settle after persistence release.',
    );
    assert.match(
      allErrorMessages(failure),
      /completed before durable container-ID persistence \(deadline\)/,
    );
    await assert.rejects(lstat(journalPath as string), /ENOENT/);
    await removeFixtureRoot(root);
    cleaned = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    releasePersistence?.();
    if (!cleaned) {
      t.diagnostic(`Retained autonomous-deadline probe evidence: ${root}`);
    }
    if (installing !== undefined) {
      try {
        await settleFixtureOperations(
          [installing],
          'The delayed configuration-probe installation did not settle during fixture cleanup.',
        );
      } catch (settlementError) {
        if (primaryFailure !== undefined) {
          throw new AggregateError(
            [primaryFailure, settlementError],
            'The delayed configuration-probe test failed and its owned work did not settle.',
          );
        }
        throw settlementError;
      }
    }
  }
});

test('managed configuration probe rejects an unsupported start before creation and seals a stopped handle', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-configuration-probe-before-create-'));
  const source = packageSource('catalog/managed-configuration-probe-before-create');
  let probeCreateAdmitted = false;
  let completed = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        beforeProbeCreate: async () => {
          probeCreateAdmitted = true;
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const probe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'configuration' },
        });

        await assert.rejects(probe.start(), /fixed configuration probe has no start phase/);
        assert.equal(probeCreateAdmitted, false);

        const firstStop = probe.stopAndRemove();
        const repeatedStop = probe.stopAndRemove();
        assert.strictEqual(repeatedStop, firstStop);
        assert.deepEqual(await firstStop, {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        await assert.rejects(probe.create(), /fixed configuration probe handle is stopped/);
        await assert.rejects(
          probe.inspect({ kind: 'configuration' }),
          /fixed configuration probe handle is stopped/,
        );
        assert.equal(probeCreateAdmitted, false);
        return sealedImage();
      });
    },
  };

  try {
    await createInstaller(root, source, runtimeFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    completed = true;
  } finally {
    if (completed) {
      await removeFixtureRoot(root);
    } else {
      t.diagnostic(`Retained stopped-before-create probe evidence: ${root}`);
    }
  }
});

test('managed configuration probe waits for a held created container before shared stop cleanup', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-configuration-probe-stop-race-'));
  const source = packageSource('catalog/managed-configuration-probe-stop-race');
  let probe: OwnedProbe | undefined;
  let releasePersistence: (() => void) | undefined;
  let signalCreated: (() => void) | undefined;
  const created = new Promise<void>((resolve) => {
    signalCreated = resolve;
  });
  const persistenceRelease = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  let cleaned = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        afterProbeCreate: async () => {
          signalCreated?.();
          await persistenceRelease;
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const currentProbe = await resources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'configuration' },
        });
        probe = currentProbe;
        await currentProbe.create();
        return sealedImage();
      });
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);
  let installing: Promise<unknown> | undefined;
  let firstStop: Promise<unknown> | undefined;
  let primaryFailure: unknown;

  try {
    installing = installer.install({ sourceId: source.id, target: 'linux/arm64' });
    const installationTerminal = observedTerminal(
      installing,
      'The held configuration-probe installation unexpectedly completed.',
    );
    await waitForFixtureBarrier(
      created,
      [installationTerminal],
      'actual fixed configuration container creation',
    );

    const currentProbe = probe;
    if (currentProbe === undefined) {
      throw new Error('The held configuration probe was not exposed before creation.');
    }

    firstStop = currentProbe.stopAndRemove();
    const repeatedStop = currentProbe.stopAndRemove();
    assert.strictEqual(repeatedStop, firstStop);
    await assert.rejects(
      completesWithin(
        firstStop,
        HELD_ADMISSION_DEADLINE_MS,
        'The held configuration-probe stop did not remain pending before persistence release.',
      ),
      /did not remain pending before persistence release/,
    );

    releasePersistence?.();
    assert.deepEqual(
      await completesWithin(
        firstStop,
        FIXTURE_DEADLINE_MS,
        'The held configuration-probe stop did not settle after persistence release.',
      ),
      {
        cleanupConfirmed: true,
        status: 'confirmed',
      },
    );
    assert.match(
      allErrorMessages(
        await assertRejectsWithin(
          installationTerminal,
          'The held configuration-probe installation did not fail after stop.',
        ),
      ),
      /fixed configuration probe handle is stopped/,
    );
    await removeFixtureRoot(root);
    cleaned = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    releasePersistence?.();
    const operations: Promise<unknown>[] = [];
    if (firstStop !== undefined) {
      operations.push(firstStop);
    }
    if (installing !== undefined) {
      operations.push(installing);
    }
    try {
      await settleFixtureOperations(
        operations,
        'The held configuration-probe fixture did not settle during final cleanup.',
      );
    } catch (settlementError) {
      if (primaryFailure !== undefined) {
        throw new AggregateError(
          [primaryFailure, settlementError],
          'The held configuration-probe test failed and its owned work did not settle.',
        );
      }
      throw settlementError;
    }
    if (!cleaned) {
      t.diagnostic(`Retained held configuration-probe stop evidence: ${root}`);
    }
  }
});

test('managed configuration probe rejects a closing inspection and waits for an admitted inspection', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-configuration-probe-inspection-race-'));
  const source = packageSource('catalog/managed-configuration-probe-inspection-race');
  let resources: ManagedRuntimeResourceOps | undefined;
  let probe: OwnedProbe | undefined;
  let releaseInspection: (() => void) | undefined;
  let signalInspection: (() => void) | undefined;
  let inspectionsCompleted = 0;
  const inspectionCompleted = new Promise<void>((resolve) => {
    signalInspection = resolve;
  });
  const inspectionRelease = new Promise<void>((resolve) => {
    releaseInspection = resolve;
  });
  let completed = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const activeResources = await ManagedRuntimeResourceOps.create({
        afterProbeInspection: async () => {
          inspectionsCompleted += 1;
          signalInspection?.();
          await inspectionRelease;
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      resources = activeResources;
      return nativeRuntime(activeResources, async () => {
        const currentProbe = await activeResources.prepareProbe({
          imageId: T004_CONFIGURATION_IMAGE,
          kind: 'legacy-fixed-profile',
          selection: { kind: 'configuration' },
        });
        probe = currentProbe;
        await currentProbe.create();
        await currentProbe.inspect({ kind: 'configuration' });
        return sealedImage();
      });
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);
  let installing: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  let primaryFailure: unknown;

  try {
    installing = installer.install({ sourceId: source.id, target: 'linux/arm64' });
    const installationTerminal = observedTerminal(
      installing,
      'The held configuration inspection unexpectedly completed installation.',
    );
    await waitForFixtureBarrier(
      inspectionCompleted,
      [installationTerminal],
      'admitted fixed configuration inspection completion',
    );

    const activeResources = resources;
    const currentProbe = probe;
    if (activeResources === undefined || currentProbe === undefined) {
      throw new Error('The managed configuration inspection did not expose its live owner.');
    }

    closing = activeResources.close();
    void closing.catch(() => undefined);
    await assert.rejects(
      currentProbe.inspect({ kind: 'configuration' }),
      /managed runtime resource session is closed/,
    );
    assert.equal(inspectionsCompleted, 1);
    await assert.rejects(
      completesWithin(
        closing,
        HELD_ADMISSION_DEADLINE_MS,
        'The provider close did not remain pending for the admitted inspection.',
      ),
      /did not remain pending for the admitted inspection/,
    );

    releaseInspection?.();
    await completesWithin(
      closing,
      FIXTURE_DEADLINE_MS,
      'The provider close did not settle after the admitted inspection completed.',
    );
    await completesWithin(
      installing,
      FIXTURE_DEADLINE_MS,
      'The configuration inspection installation did not settle after provider close.',
    );
    await removeFixtureRoot(root);
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    releaseInspection?.();
    const operations: Promise<unknown>[] = [];
    if (closing !== undefined) {
      operations.push(closing);
    }
    if (installing !== undefined) {
      operations.push(installing);
    }
    try {
      await settleFixtureOperations(
        operations,
        'The held configuration-inspection fixture did not settle during final cleanup.',
      );
    } catch (settlementError) {
      if (primaryFailure !== undefined) {
        throw new AggregateError(
          [primaryFailure, settlementError],
          'The held configuration-inspection test failed and its owned work did not settle.',
        );
      }
      throw settlementError;
    }
    if (!completed) {
      t.diagnostic(`Retained configuration-inspection race evidence: ${root}`);
    }
  }
});

test('managed fixture-root replacement remains unresolved and preserves the substitute', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  for (const replacement of ['file', 'directory'] as const) {
    const root = await mkdtemp(join(tmpdir(), `qdroid-managed-fixture-root-${replacement}-`));
    const source = packageSource(`catalog/fixture-root-${replacement}`);
    let fixtureRoot: string | undefined;
    let fixtureRootOriginal: PathObservation | undefined;
    let fixtureRootReplacement: PathObservation | undefined;
    let journalPath: string | undefined;
    let closeAttempts = 0;
    let closeFailure: unknown;
    let closeResult = 'not-called';

    const runtimeFactory: TrustedRuntimeFactory = {
      create: async (owner) => {
        const resources = await ManagedRuntimeResourceOps.create({
          bootId: await readTrustedLinuxBootId(),
          owner,
          ownerId: owner.ownerId,
          resourceDirectory: owner.privateStateDirectory,
          sessionId: owner.sessionId,
        });
        const runtime = nativeRuntime(resources, async () => {
          const fixture = await resources.createFixture({ kind: 'legacy-host-inputs' });
          await fixture.dispose();

          fixtureRoot = join(owner.privateStateDirectory, 'fixtures');
          journalPath = join(
            owner.privateStateDirectory,
            `${owner.sessionId}.native-resources.json`,
          );
          fixtureRootOriginal = await observePath(fixtureRoot);
          await rmdir(fixtureRoot);
          if (replacement === 'file') {
            await writeFile(fixtureRoot, 'foreign fixture root', { mode: 0o600 });
          } else {
            await mkdir(fixtureRoot, { mode: 0o700 });
          }
          fixtureRootReplacement = await observePath(fixtureRoot);
          return sealedImage();
        });
        return {
          ...runtime,
          close: async () => {
            closeAttempts += 1;
            try {
              await runtime.close();
              closeResult = 'fulfilled';
            } catch (error) {
              closeFailure = error;
              closeResult = allErrorMessages(error);
              throw error;
            }
          },
        };
      },
    };
    const installer = createInstaller(root, source, runtimeFactory);

    try {
      const installationOutcome = await installer
        .install({ sourceId: source.id, target: 'linux/arm64' })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const postCloseFixtureRoot = await observePath(fixtureRoot as string);
      const postCloseJournal = await observePath(journalPath as string);
      t.diagnostic(
        `root-replacement diagnosis ${JSON.stringify({
          closeAttempts,
          closeResult,
          iteration: replacement,
          journalPath,
          original: fixtureRootOriginal,
          postCloseFixtureRoot,
          postCloseJournal,
          replacement: fixtureRootReplacement,
        })}`,
      );
      assert.equal(closeAttempts, 1);
      assert.match(allErrorMessages(closeFailure), /fixture root ownership is unresolved/);
      assert.notEqual(
        installationOutcome,
        undefined,
        'The installer accepted a runtime-close failure after publication.',
      );
      assert.match(allErrorMessages(installationOutcome), /fixture root ownership is unresolved/);
      const replacementStatus = await lstat(fixtureRoot as string);
      assert.equal(postCloseJournal.state, 'present');
      assert.equal(postCloseJournal.type, 'file');
      assert.equal(replacementStatus.isFile(), replacement === 'file');
      assert.equal(replacementStatus.isDirectory(), replacement === 'directory');
      if (replacement === 'file') {
        assert.equal(await readFile(fixtureRoot as string, 'utf8'), 'foreign fixture root');
      } else {
        assert.deepEqual(await readdir(fixtureRoot as string), []);
      }
    } finally {
      t.diagnostic(`Retained ${replacement} fixture-root evidence: ${root}`);
    }
  }
});

test('managed fixture writes explicit modes under a restrictive process umask', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-fixture-umask-'));
  const source = packageSource('catalog/fixture-umask');
  const originalUmask = process.umask(0o077);
  let completed = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const fixture = await resources.createFixture({ kind: 'legacy-host-inputs' });
        const [canary, secret, store] = await Promise.all([
          lstat(fixture.paths.canary),
          lstat(fixture.paths.secret),
          lstat(fixture.paths.store),
        ]);
        assert.equal(canary.mode & 0o777, 0o644);
        assert.equal(secret.mode & 0o777, 0o600);
        assert.equal(store.mode & 0o777, 0o600);
        assert.deepEqual(await fixture.dispose(), {
          cleanupConfirmed: true,
          status: 'confirmed',
        });
        return sealedImage();
      });
    },
  };

  try {
    await createInstaller(root, source, runtimeFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    completed = true;
  } finally {
    process.umask(originalUmask);
    if (completed) {
      await removeFixtureRoot(root);
    } else {
      t.diagnostic(`Retained restrictive-umask fixture evidence: ${root}`);
    }
  }
});

test('managed I/O fixture closes during root verification before any file is created', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-io-close-verification-'));
  const source = packageSource('catalog/io-close-verification');
  const initialEntries = (await readdir('/mnt/lima-colima-qdroid-t002/qdroid-t002-io')).sort();
  let resources: ManagedRuntimeResourceOps | undefined;
  let releaseWriteAdmission: (() => void) | undefined;
  let signalWriteAdmission: (() => void) | undefined;
  const writeAdmissionStarted = new Promise<void>((resolve) => {
    signalWriteAdmission = resolve;
  });
  const writeAdmissionRelease = new Promise<void>((resolve) => {
    releaseWriteAdmission = resolve;
  });
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const activeResources = await ManagedRuntimeResourceOps.create({
        beforeLegacyIoFixtureWrite: async () => {
          signalWriteAdmission?.();
          await writeAdmissionRelease;
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      resources = activeResources;
      return nativeRuntime(activeResources, async () => {
        await activeResources.createFixture({ kind: 'legacy-io-file' });
        return sealedImage();
      });
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);
  let installing: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  let settled = false;

  try {
    installing = installer.install({ sourceId: source.id, target: 'linux/arm64' });
    const installationTerminal = observedTerminal(
      installing,
      'The held I/O verification unexpectedly completed installation.',
    );
    await waitForFixtureBarrier(
      writeAdmissionStarted,
      [installationTerminal],
      'successful managed I/O root verification',
    );

    const activeResources = resources;
    if (activeResources === undefined) {
      throw new Error('The managed I/O runtime did not expose its resource owner.');
    }
    closing = activeResources.close();
    void closing.catch(() => undefined);
    releaseWriteAdmission?.();
    const installationFailure = await assertRejectsWithin(
      installationTerminal,
      'Timed out waiting for the managed I/O installation to fail.',
    );
    assert.match(
      allErrorMessages(installationFailure),
      /managed runtime resource session is closed/,
    );
    await completesWithin(
      closing,
      FIXTURE_DEADLINE_MS,
      'Timed out waiting for the managed I/O resource close to settle.',
    );
    assert.deepEqual(
      (await readdir('/mnt/lima-colima-qdroid-t002/qdroid-t002-io')).sort(),
      initialEntries,
    );
    await removeFixtureRoot(root);
    settled = true;
  } finally {
    releaseWriteAdmission?.();
    if (!settled) {
      const settlements: Promise<unknown>[] = [];
      if (installing !== undefined) {
        settlements.push(
          completesWithin(
            installing,
            FIXTURE_DEADLINE_MS,
            'Timed out settling the held I/O installation after release.',
          ),
        );
      }
      if (closing !== undefined) {
        settlements.push(
          completesWithin(
            closing,
            FIXTURE_DEADLINE_MS,
            'Timed out settling the held I/O resource close after release.',
          ),
        );
      }
      const results = await Promise.allSettled(settlements);
      const rejected = results.filter((result) => result.status === 'rejected');
      if (rejected.length > 0) {
        t.diagnostic(
          `Retained held-I/O evidence after ${rejected.length} settlement failure(s): ${root}`,
        );
      }
    }
  }
});

test('managed fixture disposal joins concurrent callers and session close before release', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-fixture-disposal-'));
  const source = packageSource('catalog/fixture-disposal-join');
  let releaseDisposal: (() => void) | undefined;
  let signalDisposalStarted: (() => void) | undefined;
  let signalRuntimeFinalizer: (() => void) | undefined;
  let fixture: LegacyHostInputFixture | undefined;
  const disposalStarted = new Promise<void>((resolve) => {
    signalDisposalStarted = resolve;
  });
  const runtimeFinalizerEntered = new Promise<void>((resolve) => {
    signalRuntimeFinalizer = resolve;
  });
  const disposalRelease = new Promise<void>((resolve) => {
    releaseDisposal = resolve;
  });
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        beforeFixtureDisposal: async () => {
          signalDisposalStarted?.();
          await disposalRelease;
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      const runtime = nativeRuntime(resources, async () => {
        fixture = await resources.createFixture({ kind: 'legacy-host-inputs' });
        return sealedImage();
      });
      return {
        ...runtime,
        close: async () => {
          signalRuntimeFinalizer?.();
          await runtime.close();
        },
      };
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);
  let installing: Promise<unknown> | undefined;
  let concurrentDisposal: Promise<unknown> | undefined;
  let settled = false;

  try {
    installing = installer.install({ sourceId: source.id, target: 'linux/arm64' });
    const installationTerminal = observedTerminal(
      installing,
      'The fixture disposal installation unexpectedly completed.',
    );
    await waitForFixtureBarrier(
      runtimeFinalizerEntered,
      [installationTerminal],
      'managed runtime finalization',
    );
    await waitForFixtureBarrier(
      disposalStarted,
      [installationTerminal],
      'managed fixture disposal admission',
    );

    const activeFixture = fixture;
    if (activeFixture === undefined) {
      throw new Error('The fixture disposal test did not create its managed fixture.');
    }
    concurrentDisposal = activeFixture.dispose();
    await assert.rejects(
      completesWithin(
        installationTerminal,
        HELD_ADMISSION_DEADLINE_MS,
        'The installation released while managed fixture disposal was pending.',
      ),
      /released while managed fixture disposal was pending/,
    );
    await assert.rejects(
      createInstaller(root, source, runtimeFactory).install({
        sourceId: source.id,
        target: 'linux/arm64',
      }),
      /already in use/,
    );

    releaseDisposal?.();
    await Promise.all([
      completesWithin(
        installing,
        FIXTURE_DEADLINE_MS,
        'Timed out waiting for the installation after fixture disposal release.',
      ),
      completesWithin(
        concurrentDisposal,
        FIXTURE_DEADLINE_MS,
        'Timed out waiting for concurrent fixture disposal release.',
      ),
    ]);
    settled = true;
    await removeFixtureRoot(root);
  } finally {
    releaseDisposal?.();
    if (!settled && installing !== undefined) {
      const settlement = [
        completesWithin(
          installing,
          FIXTURE_DEADLINE_MS,
          'Timed out settling the installation after fixture disposal release.',
        ),
      ];
      if (concurrentDisposal !== undefined) {
        settlement.push(
          completesWithin(
            concurrentDisposal,
            FIXTURE_DEADLINE_MS,
            'Timed out settling concurrent fixture disposal after release.',
          ),
        );
      }
      const results = await Promise.allSettled(settlement);
      const rejected = results.filter((result) => result.status === 'rejected');
      if (rejected.length > 0) {
        t.diagnostic(
          `Retained held-disposal evidence after ${rejected.length} settlement failure(s): ${root}`,
        );
      }
    }
  }
});

test('managed close preserves a fixture-disposal journal failure and unresolved evidence', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-fixture-journal-failure-'));
  const source = packageSource('catalog/fixture-journal-failure');
  let resourceDirectory: string | undefined;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      resourceDirectory = owner.privateStateDirectory;
      return nativeRuntime(resources, async () => {
        await resources.createFixture({ kind: 'legacy-host-inputs' });
        await chmod(owner.privateStateDirectory, 0o500);
        return sealedImage();
      });
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      (error: unknown) => {
        const messages = allErrorMessages(error);
        assert.match(messages, /EACCES/);
        assert.match(messages, /unresolved cleanup evidence/);
        return true;
      },
    );
  } finally {
    if (resourceDirectory !== undefined) {
      await chmod(resourceDirectory, 0o700);
    }
    t.diagnostic(`Retained fixture journal-failure evidence: ${root}`);
  }
});

test('managed fixture replacement retains unknown ownership and never deletes the replacement', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-fixture-replacement-'));
  const source = packageSource('catalog/fixture-replacement');
  // The scenario begins changing a managed fixture before installer.install()
  // can report its result. This test always retains the root: a failed
  // replacement setup is evidence, not confirmed cleanup.
  let disposalCompleted = false;
  let journalPath: string | undefined;
  let original: PathObservation | undefined;
  let replacement: PathObservation | undefined;
  let replacementPrepared = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      journalPath = join(owner.privateStateDirectory, `${owner.sessionId}.native-resources.json`);
      return nativeRuntime(resources, async () => {
        const fixture = await resources.createFixture({ kind: 'legacy-host-inputs' });
        original = await observePath(fixture.paths.canary);
        await rm(fixture.paths.canary, { force: false });
        await writeFile(fixture.paths.canary, 'qdroid-synthetic-canary', { mode: 0o644 });
        replacement = await observePath(fixture.paths.canary);
        replacementPrepared = true;

        const firstDisposal = fixture.dispose();
        const repeatedDisposal = fixture.dispose();
        assert.strictEqual(repeatedDisposal, firstDisposal);
        assert.deepEqual(await firstDisposal, {
          cleanupConfirmed: false,
          status: 'unknown',
        });
        assert.notEqual(replacement?.ino, original?.ino);
        assert.equal(await readFile(fixture.paths.canary, 'utf8'), 'qdroid-synthetic-canary');
        assert.equal((await lstat(journalPath as string)).isFile(), true);
        assert.match(await readFile(journalPath as string, 'utf8'), /"status":"unknown"/);
        disposalCompleted = true;
        return sealedImage();
      });
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      (error: unknown) => {
        assert.equal(replacementPrepared, true, 'the replacement setup must complete');
        assert.equal(disposalCompleted, true, 'the intended fixture disposal must complete');
        assert.match(allErrorMessages(error), /unresolved cleanup evidence/);
        return true;
      },
    );
  } finally {
    t.diagnostic(`Retained replacement-fixture evidence: ${root}`);
  }
});

test('managed fixture child-directory replacement remains unknown with a retained descriptor', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-fixture-child-directory-'));
  const source = packageSource('catalog/fixture-child-directory');
  let retainedDirectory: string | undefined;
  let original: PathObservation | undefined;
  let replacement: PathObservation | undefined;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        beforeFixtureDirectoryRemoval: async (directoryPath) => {
          retainedDirectory = directoryPath;
          original = await observePath(directoryPath);
          await rmdir(directoryPath);
          await mkdir(directoryPath, { mode: 0o700 });
          replacement = await observePath(directoryPath);
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const fixture = await resources.createFixture({ kind: 'legacy-host-inputs' });
        const fixtureDisposal = fixture.dispose();
        assert.strictEqual(fixture.dispose(), fixtureDisposal);
        assert.deepEqual(await fixtureDisposal, {
          cleanupConfirmed: false,
          status: 'unknown',
        });
        assert.notEqual(replacement?.ino, original?.ino);
        assert.deepEqual(await readdir(retainedDirectory as string), []);
        return sealedImage();
      });
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      (error: unknown) => {
        assert.match(allErrorMessages(error), /unresolved cleanup evidence/);
        return true;
      },
    );
  } finally {
    t.diagnostic(`Retained child-directory replacement evidence: ${root}`);
  }
});

test('managed I/O file replacement remains unknown with identical bytes and mode', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-io-replacement-'));
  const source = packageSource('catalog/io-replacement');
  let original: PathObservation | undefined;
  let replacement: PathObservation | undefined;
  let retainedPath: string | undefined;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const fixture = await resources.createFixture({ kind: 'legacy-io-file' });
        retainedPath = fixture.sourcePath;
        original = await observePath(fixture.sourcePath);
        await rm(fixture.sourcePath, { force: false });
        await writeFile(fixture.sourcePath, Buffer.alloc(16 * 1024 * 1024, 0x5a), {
          mode: 0o644,
        });
        await chmod(fixture.sourcePath, 0o644);
        replacement = await observePath(fixture.sourcePath);

        assert.deepEqual(await fixture.dispose(), {
          cleanupConfirmed: false,
          status: 'unknown',
        });
        assert.notEqual(replacement?.ino, original?.ino);
        const replacementStatus = await lstat(fixture.sourcePath);
        assert.equal(replacementStatus.mode & 0o777, 0o644);
        assert.equal(replacementStatus.size, 16 * 1024 * 1024);
        return sealedImage();
      });
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      (error: unknown) => {
        assert.match(allErrorMessages(error), /unresolved cleanup evidence/);
        return true;
      },
    );
  } finally {
    t.diagnostic(`Retained I/O replacement evidence: ${root}; file=${retainedPath}`);
  }
});

test('managed I/O creation closes a pre-receipt descriptor and retains unknown evidence', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-io-pre-receipt-'));
  const source = packageSource('catalog/io-pre-receipt');
  let journalPath: string | undefined;
  let retainedPath: string | undefined;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        afterLegacyIoFixtureOpen: async (sourcePath) => {
          retainedPath = sourcePath;
          throw new Error('controlled I/O failure after exclusive open');
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      journalPath = join(owner.privateStateDirectory, `${owner.sessionId}.native-resources.json`);
      return nativeRuntime(resources, async () => {
        await assert.rejects(
          resources.createFixture({ kind: 'legacy-io-file' }),
          /controlled I\/O failure after exclusive open/,
        );
        return sealedImage();
      });
    },
  };

  try {
    await assert.rejects(
      createInstaller(root, source, runtimeFactory).install({
        sourceId: source.id,
        target: 'linux/arm64',
      }),
      (error: unknown) => {
        assert.match(allErrorMessages(error), /unresolved cleanup evidence/);
        return true;
      },
    );
    assert.equal((await lstat(retainedPath as string)).isFile(), true);
    assert.deepEqual(await descriptorsFor(retainedPath as string), []);
    assert.equal((await lstat(journalPath as string)).isFile(), true);
    assert.match(await readFile(journalPath as string, 'utf8'), /"status":"unknown"/);
  } finally {
    t.diagnostic(`Retained pre-receipt I/O evidence: ${root}; file=${retainedPath}`);
  }
});

test('managed fixture creation preserves creation, cleanup, and status-persistence failures', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-fixture-create-double-failure-'));
  const source = packageSource('catalog/fixture-create-double-failure');
  let resourceDirectory: string | undefined;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        beforeFixtureDirectoryRemoval: async () => {
          await chmod(owner.privateStateDirectory, 0o500);
          throw new Error('controlled fixture cleanup failure');
        },
        beforeFixtureFileCreate: async (_resourceId, name) => {
          if (name === 'canary') {
            throw new Error('controlled fixture creation failure');
          }
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      resourceDirectory = owner.privateStateDirectory;
      return nativeRuntime(resources, async () => {
        await assert.rejects(
          resources.createFixture({ kind: 'legacy-host-inputs' }),
          (error: unknown) => {
            const messages = allErrorMessages(error);
            assert.match(messages, /controlled fixture creation failure/);
            assert.match(messages, /controlled fixture cleanup failure/);
            assert.match(messages, /EACCES/);
            return true;
          },
        );
        return sealedImage();
      });
    },
  };

  try {
    await assert.rejects(
      createInstaller(root, source, runtimeFactory).install({
        sourceId: source.id,
        target: 'linux/arm64',
      }),
      (error: unknown) => {
        assert.match(allErrorMessages(error), /unresolved cleanup evidence/);
        return true;
      },
    );
  } finally {
    if (resourceDirectory !== undefined) {
      await chmod(resourceDirectory, 0o700);
    }
    t.diagnostic(`Retained fixture creation double-failure evidence: ${root}`);
  }
});

test('managed fixture creation rechecks closure between files and cleans only its confirmed entries', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-fixture-close-between-files-'));
  const source = packageSource('catalog/fixture-close-between-files');
  let resources: ManagedRuntimeResourceOps | undefined;
  let releaseSecretAdmission: (() => void) | undefined;
  let signalSecretAdmission: (() => void) | undefined;
  const secretAdmission = new Promise<void>((resolve) => {
    signalSecretAdmission = resolve;
  });
  const secretRelease = new Promise<void>((resolve) => {
    releaseSecretAdmission = resolve;
  });
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const activeResources = await ManagedRuntimeResourceOps.create({
        beforeFixtureFileCreate: async (_resourceId, name) => {
          if (name === 'secret') {
            signalSecretAdmission?.();
            await secretRelease;
          }
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      resources = activeResources;
      return nativeRuntime(activeResources, async () => {
        await activeResources.createFixture({ kind: 'legacy-host-inputs' });
        return sealedImage();
      });
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    const installing = installer.install({ sourceId: source.id, target: 'linux/arm64' });
    const installationTerminal = observedTerminal(
      installing,
      'The close-between-files installation unexpectedly completed.',
    );
    await waitForFixtureBarrier(
      secretAdmission,
      [installationTerminal],
      'second managed fixture file admission',
    );

    const closing = resources?.close();
    releaseSecretAdmission?.();
    await assert.rejects(installationTerminal, /managed runtime resource session is closed/);
    await closing;
    await removeFixtureRoot(root);
  } finally {
    releaseSecretAdmission?.();
  }
});

test('managed fixture directory collisions leave the foreign entries intact', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-fixture-collision-'));
  const source = packageSource('catalog/fixture-collision');
  let foreignCanary: string | undefined;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        beforeFixtureDirectoryCreate: async (directory) => {
          await mkdir(directory, { mode: 0o700 });
          foreignCanary = join(directory, 'canary');
          await writeFile(foreignCanary, 'foreign fixture entry', { mode: 0o644 });
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        await assert.rejects(resources.createFixture({ kind: 'legacy-host-inputs' }), /EEXIST/);
        assert.equal(await readFile(foreignCanary as string, 'utf8'), 'foreign fixture entry');
        return sealedImage();
      });
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      (error: unknown) => {
        assert.match(
          allErrorMessages(error),
          /ENOTEMPTY|unresolved cleanup evidence|fixture root ownership is unresolved/,
        );
        return true;
      },
    );
    assert.equal(await readFile(foreignCanary as string, 'utf8'), 'foreign fixture entry');
  } finally {
    t.diagnostic(`Retained fixture-collision evidence: ${root}`);
  }
});

test('managed close fences a native guardian during identity publication', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-runtime-close-'));
  const source = packageSource('catalog/native-close-race');
  let closeCompleted = false;
  let signalIdentityReadStarted: (() => void) | undefined;
  let releaseIdentityRead: (() => void) | undefined;
  const identityReadStarted = new Promise<void>((resolve) => {
    signalIdentityReadStarted = resolve;
  });
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        readGuardianProcessStart: async (pid) => {
          signalIdentityReadStarted?.();
          await new Promise<void>((resolve) => {
            releaseIdentityRead = resolve;
          });
          return readProcessStart(pid);
        },
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      let closed = false;
      return nativeRuntime(
        resources,
        async () => {
          const native = resources.native({ kind: 'kernel-release' });
          await waitForIdentityRead(native, identityReadStarted);
          const closing = resources.close();
          releaseIdentityRead?.();

          await assert.rejects(native, /managed runtime resource session is closed/);
          await closing;
          closed = true;
          return sealedImage();
        },
        () => closed,
      );
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    await installer.install({ sourceId: source.id, target: 'linux/arm64' });
    closeCompleted = true;
  } finally {
    if (closeCompleted) {
      await removeFixtureRoot(root);
    } else {
      t.diagnostic(`Retained managed close-race evidence: ${root}`);
    }
  }
});

test('a sealed BuildSession fences new work and holds release for its original provider terminal', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-provider-terminal-fence-'));
  const source = packageSource('catalog/provider-terminal-fence');
  let capturedOwner: BuildSessionOwner | undefined;
  let terminalPath: string | undefined;
  let releaseTerminalDescriptor: (() => void) | undefined;
  let signalTerminalDescriptor: (() => void) | undefined;
  let newAdmissionRejected = false;
  const terminalDescriptorHeld = new Promise<void>((resolve) => {
    signalTerminalDescriptor = resolve;
  });
  const terminalDescriptorRelease = new Promise<void>((resolve) => {
    releaseTerminalDescriptor = resolve;
  });
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      capturedOwner = owner;
      terminalPath = join(root, 'build-authority', 'provider-terminals', `${owner.sessionId}.json`);
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return {
        buildExecutor: {
          managesResources: true,
          execute: async () => {
            throw new Error('This terminal-fencing test does not execute a package build.');
          },
        },
        close: async () => {
          assert.throws(
            () => resources.native({ kind: 'kernel-release' }),
            /BuildSession owner is not active for a trusted runtime operation/,
          );
          newAdmissionRejected = true;
          await resources.close();
        },
        imageAssembler: {
          assemble: async () => sealedImage(),
          verifySealed: async () => undefined,
        },
      };
    },
  };
  const installer = createInstaller(root, source, runtimeFactory, {
    afterDurableWriteFileSync: async (path) => {
      if (!path.includes('/provider-terminals/')) {
        return;
      }
      signalTerminalDescriptor?.();
      await terminalDescriptorRelease;
    },
  });
  let completed = false;

  try {
    const installing = installer.install({ sourceId: source.id, target: 'linux/arm64' });
    const installationTerminal = observedTerminal(
      installing,
      'The held provider terminal installation unexpectedly completed.',
    );
    await waitForFixtureBarrier(
      terminalDescriptorHeld,
      [installationTerminal],
      'the original provider terminal descriptor after sync',
    );
    assert.equal(newAdmissionRejected, true);
    await assert.rejects(
      readFile(terminalPath as string, 'utf8'),
      /ENOENT/,
      'The terminal receipt must not publish before its held descriptor closes.',
    );

    const cleanupOperation = beginBuildSessionCleanupOperation(capturedOwner as BuildSessionOwner);
    cleanupOperation.settle();
    await assert.rejects(
      completesWithin(
        installationTerminal,
        HELD_ADMISSION_DEADLINE_MS,
        'The BuildSession released before its held provider terminal descriptor settled.',
      ),
      /released before its held provider terminal descriptor settled/,
    );

    releaseTerminalDescriptor?.();
    const installed = await installing;
    assert.equal(installed.reusedExisting, false);

    const owner = capturedOwner as BuildSessionOwner;
    const journalPath = join(
      owner.privateStateDirectory,
      `${owner.sessionId}.native-resources.json`,
    );
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      readonly authenticationTag: string;
      readonly sessionId: string;
    };
    assert.equal(journal.sessionId, owner.sessionId);
    assert.match(journal.authenticationTag, /^[a-f0-9]{64}$/);

    const terminalBefore = await readFile(terminalPath as string);
    const terminal = JSON.parse(terminalBefore.toString('utf8')) as {
      readonly candidateId: string;
      readonly journalAuthenticationTag: string;
      readonly sessionId: string;
    };
    assert.equal(terminal.candidateId, owner.candidateId);
    assert.equal(terminal.sessionId, owner.sessionId);
    assert.equal(terminal.journalAuthenticationTag, journal.authenticationTag);
    await assert.rejects(
      recordBuildSessionProviderTerminal(owner, journal.authenticationTag),
      /not available for its original provider terminal/,
    );
    assert.deepEqual(await readFile(terminalPath as string), terminalBefore);

    completed = true;
  } finally {
    releaseTerminalDescriptor?.();
    if (completed) {
      await removeFixtureRoot(root);
    } else {
      t.diagnostic(`Retained provider-terminal fencing evidence: ${root}`);
    }
  }
});

test('managed close retains directory sync and close failures before terminal publication', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-resource-directory-sync-failure-'));
  const source = packageSource('catalog/resource-directory-sync-failure');
  const directoryOperations: string[] = [];
  let capturedOwner: BuildSessionOwner | undefined;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      capturedOwner = owner;
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        openResourceDirectoryForSync: async (path) => {
          assert.equal(path, owner.privateStateDirectory);
          return {
            close: async () => {
              directoryOperations.push('close');
              throw new Error('controlled resource-directory close failure');
            },
            sync: async () => {
              directoryOperations.push('sync');
              throw new Error('controlled resource-directory sync failure');
            },
          };
        },
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => sealedImage());
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      (error: unknown) => {
        const messages = allErrorMessages(error);
        assert.match(messages, /controlled resource-directory sync failure/);
        assert.match(messages, /controlled resource-directory close failure/);
        return true;
      },
    );
    assert.deepEqual(directoryOperations, ['sync', 'close']);

    const owner = capturedOwner as BuildSessionOwner;
    const journalPath = join(
      owner.privateStateDirectory,
      `${owner.sessionId}.native-resources.json`,
    );
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      readonly authenticationTag: string;
      readonly sessionId: string;
    };
    assert.equal(journal.sessionId, owner.sessionId);
    assert.match(journal.authenticationTag, /^[a-f0-9]{64}$/);

    await assert.rejects(
      lstat(join(root, 'build-authority', 'provider-terminals', `${owner.sessionId}.json`)),
      /ENOENT/,
      'A failed resource-directory sync must not publish a provider terminal.',
    );
    await assert.rejects(
      lstat(join(root, 'build-authority', 'retirements', `${owner.sessionId}.json`)),
      /ENOENT/,
      'A failed resource-directory sync must not retire the BuildSession.',
    );
  } finally {
    t.diagnostic(`Retained resource-directory sync failure evidence: ${root}`);
  }
});

test('a failed resource-journal write retains its original journal and both descriptor failures', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-resource-journal-write-failure-'));
  const source = packageSource('catalog/resource-journal-write-failure');
  let temporaryPath: string | undefined;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const journalPath = join(
        owner.privateStateDirectory,
        `${owner.sessionId}.native-resources.json`,
      );
      const resources = await ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        openResourceJournalFileForWrite: async (path) => {
          temporaryPath = path;
          const descriptor = await open(path, 'wx', 0o600);
          return {
            close: async () => {
              await descriptor.close();
              throw new Error('controlled resource-journal close failure');
            },
            sync: () => descriptor.sync(),
            writeFile: async (...args: Parameters<FileHandle['writeFile']>) => {
              await descriptor.writeFile(...args);
              throw new Error('controlled resource-journal write failure');
            },
          };
        },
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      return nativeRuntime(resources, async () => {
        const originalJournal = await readFile(journalPath);
        await assert.rejects(
          resources.createFixture({ kind: 'legacy-host-inputs' }),
          (error: unknown) => {
            const messages = allErrorMessages(error);
            assert.match(messages, /controlled resource-journal write failure/);
            assert.match(messages, /controlled resource-journal close failure/);
            return true;
          },
        );
        assert.deepEqual(
          await readFile(journalPath),
          originalJournal,
          'The failed journal update must not replace the authenticated original.',
        );

        const temporary = temporaryPath as string;
        const attemptedJournal = await readFile(temporary, 'utf8');
        assert.match(attemptedJournal, /"kind":"fixture"/);

        throw new Error('The controlled resource-journal persistence failure remains unresolved.');
      });
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      (error: unknown) => {
        assert.match(
          allErrorMessages(error),
          /controlled resource-journal persistence failure remains unresolved/,
        );
        return true;
      },
    );
  } finally {
    t.diagnostic(`Retained resource-journal write failure evidence: ${root}`);
  }
});

test('sealed BuildSession prevents a held resource-provider initialization from writing its journal', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-runtime-initialization-seal-'));
  const source = packageSource('catalog/native-initialization-seal');
  let capturedOwner: BuildSessionOwner | undefined;
  let startedProvider: Promise<ManagedRuntimeResourceOps> | undefined;
  let admissionHookEntered = false;
  let settlementHookEntered = false;
  let signalInitialJournalAdmission: (() => void) | undefined;
  let signalSettlement: (() => void) | undefined;
  let releaseInitialJournalAdmission: (() => void) | undefined;
  const initialJournalAdmission = new Promise<void>((resolve) => {
    signalInitialJournalAdmission = resolve;
  });
  const settlementStarted = new Promise<void>((resolve) => {
    signalSettlement = resolve;
  });
  const initialJournalRelease = new Promise<void>((resolve) => {
    releaseInitialJournalAdmission = resolve;
  });
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      capturedOwner = owner;
      startedProvider = ManagedRuntimeResourceOps.create({
        beforePersistInitial: async () => {
          admissionHookEntered = true;
          signalInitialJournalAdmission?.();
          await initialJournalRelease;
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      const providerTerminal = observedTerminal(
        startedProvider,
        'The held managed resource provider unexpectedly completed initialization.',
      );
      await waitForFixtureBarrier(
        initialJournalAdmission,
        [providerTerminal],
        'initial managed resource journal admission',
      );
      throw new Error('outer provider factory failed after reserving initialization');
    },
    settleFailedCreate: async () => {
      settlementHookEntered = true;
      signalSettlement?.();
      await startedProvider;
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    const installing = installer.install({ sourceId: source.id, target: 'linux/arm64' });
    const installationTerminal = observedTerminal(
      installing,
      'The held initialization unexpectedly completed installation.',
    );
    await waitForFixtureBarrier(
      initialJournalAdmission,
      [installationTerminal],
      'held managed resource journal admission',
    );
    assert.equal(admissionHookEntered, true);
    await waitForFixtureBarrier(
      settlementStarted,
      [installationTerminal],
      'held managed resource provider settlement',
    );
    assert.equal(settlementHookEntered, true);

    await assert.rejects(
      completesWithin(
        installationTerminal,
        HELD_ADMISSION_DEADLINE_MS,
        'The held provider installation did not remain pending while admission was withheld.',
      ),
      /did not remain pending while admission was withheld/,
    );
    releaseInitialJournalAdmission?.();

    assert.match(
      allErrorMessages(
        await assertRejectsWithin(
          installationTerminal,
          'The held provider installation did not settle after releasing admission.',
        ),
      ),
      /outer provider factory failed after reserving initialization/,
    );

    const owner = capturedOwner as BuildSessionOwner;
    const journalPath = join(
      owner.privateStateDirectory,
      `${owner.sessionId}.native-resources.json`,
    );
    await assert.rejects(readFile(journalPath, 'utf8'), /ENOENT/);
    await assert.rejects(
      ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      }),
      /BuildSession owner is not active for a trusted runtime operation/,
    );
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /prior build session has unresolved cleanup evidence/,
    );
  } finally {
    releaseInitialJournalAdmission?.();
    t.diagnostic(`Retained initialization-seal evidence: ${root}`);
  }
});

test('provider initialization failure before journal admission settles without an unbounded fixture wait', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-runtime-early-provider-failure-'));
  const source = packageSource('catalog/native-early-provider-failure');
  let capturedOwner: BuildSessionOwner | undefined;
  let beforePersistInitialCalled = false;
  let provider: Promise<ManagedRuntimeResourceOps> | undefined;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      capturedOwner = owner;
      await mkdir(owner.privateStateDirectory, { mode: 0o700, recursive: true });
      await chmod(owner.privateStateDirectory, 0o755);
      provider = ManagedRuntimeResourceOps.create({
        beforePersistInitial: async () => {
          beforePersistInitialCalled = true;
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      await provider;
      throw new Error(
        'The early provider failure unexpectedly created a usable runtime resource owner.',
      );
    },
    settleFailedCreate: async () => {
      await provider;
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    const installation = installer.install({ sourceId: source.id, target: 'linux/arm64' });
    const installationTerminal = observedTerminal(
      installation,
      'The early provider failure unexpectedly completed installation.',
    );
    const failure = await assertRejectsWithin(
      installationTerminal,
      'The early provider failure did not settle installation.',
    );

    assert.match(allErrorMessages(failure), /managed runtime resource directory is not private/);
    assert.equal(beforePersistInitialCalled, false);

    const owner = capturedOwner as BuildSessionOwner;
    await assert.rejects(
      ManagedRuntimeResourceOps.create({
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      }),
      /BuildSession owner is not active for a trusted runtime operation/,
    );
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /prior build session has unresolved cleanup evidence/,
    );
  } finally {
    t.diagnostic(`Retained early-provider-failure evidence: ${root}`);
  }
});

test('failed provider initialization closes its retained fixture-root descriptor before release', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-runtime-init-descriptor-'));
  const source = packageSource('catalog/native-init-descriptor');
  let fixtureRoot: string | undefined;
  let provider: Promise<ManagedRuntimeResourceOps> | undefined;
  let cleaned = false;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      fixtureRoot = join(owner.privateStateDirectory, 'fixtures');
      provider = ManagedRuntimeResourceOps.create({
        beforePersistInitial: async () => {
          throw new Error('controlled initial journal failure');
        },
        bootId: await readTrustedLinuxBootId(),
        owner,
        ownerId: owner.ownerId,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      await provider;
      throw new Error('The controlled provider initialization unexpectedly succeeded.');
    },
    settleFailedCreate: async () => {
      await provider?.catch(() => undefined);
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /controlled initial journal failure/,
    );
    const retainedFixtureRoot = fixtureRoot as string;
    assert.equal((await lstat(retainedFixtureRoot)).isDirectory(), true);
    assert.deepEqual(await descriptorsFor(retainedFixtureRoot), []);
    await rmdir(retainedFixtureRoot);
    await removeFixtureRoot(root);
    cleaned = true;
  } finally {
    if (!cleaned) {
      t.diagnostic(`Retained failed-initialization descriptor evidence: ${root}`);
    }
  }
});

function nativeRuntime(
  resources: ManagedRuntimeResourceOps,
  assemble: () => Promise<{
    readonly cleanupConfirmed: true;
    readonly imageId: string;
    readonly receipt: {};
  }>,
  isClosed: () => boolean = () => false,
): SessionBoundRuntime {
  return {
    buildExecutor: {
      managesResources: true,
      execute: async () => {
        throw new Error('This native ownership test does not execute a package build.');
      },
    },
    close: async () => {
      if (!isClosed()) {
        await resources.close();
      }
    },
    imageAssembler: {
      assemble,
      verifySealed: async () => undefined,
    },
  };
}

function createInstaller(
  root: string,
  source: PackageSource,
  runtimeFactory: TrustedRuntimeFactory,
  publicationTestHooks?: PackageInstallerPublicationTestHooks,
): PackageInstaller {
  return new PackageInstaller({
    installerRoot: root,
    ownerId: 'trusted-owner',
    ...(publicationTestHooks === undefined ? {} : { publicationTestHooks }),
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    runtimeFactory,
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });
}

function packageSource(id: string): PackageSource {
  const bytes = createNoBuildExecutablePackageBundle();
  return {
    expectedSha256: sha256(bytes),
    id,
    maxBytes: bytes.byteLength,
    read: async () => bytes,
  };
}

function sealedImage(): {
  readonly cleanupConfirmed: true;
  readonly imageId: string;
  readonly receipt: {};
} {
  return {
    cleanupConfirmed: true,
    imageId: `sha256:${'c'.repeat(64)}`,
    receipt: {},
  };
}

async function collectProbeOutput(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createNoBuildExecutablePackageBundle(): Buffer {
  const manifest = JSON.stringify({
    assets: [],
    engineCompatibility: '>=0.1.0 <0.2.0',
    entrypoint: { executable: '/opt/qdroid/entrypoint', type: 'command' },
    kind: 'tool',
    license: 'Apache-2.0',
    name: 'qdroid/native-owner',
    requestedCapabilities: [],
    requestedResources: {
      deadlineMs: 30_000,
      memoryMiB: 256,
      outputBytes: 1_048_576,
      pids: 32,
      scratchMiB: 64,
    },
    runtimeVariants: [
      {
        abi: 'glibc-2.39',
        baseCatalogId: 'catalog/node-build-v1',
        image: `sha256:${'a'.repeat(64)}`,
        platform: 'linux/arm64',
        requiredFeatures: [],
        requiredProfile: 'build-restricted',
      },
    ],
    scenes: [],
    schema: 'qdroid.plugin/v0.1',
    skills: [],
    version: '0.1.0',
  });
  const preliminary = createUstar([
    { body: manifest, path: 'qdroid.plugin.json' },
    { body: '{}', path: 'qdroid.lock.json' },
  ]);
  const inputContentDigest = inventoryDigest(
    readFrozenBundle(preliminary).entries.filter((entry) => entry.path !== 'qdroid.lock.json'),
  );
  return createUstar([
    { body: manifest, path: 'qdroid.plugin.json' },
    {
      body: JSON.stringify({ inputContentDigest, schema: 'qdroid.lock/v0.1' }),
      path: 'qdroid.lock.json',
    },
  ]);
}

function trustedRuntimeCatalogEntry(): TrustedImageCatalogEntry {
  return {
    abi: 'glibc-2.39',
    baseImage: `sha256:${'a'.repeat(64)}`,
    builderImage: `sha256:${'b'.repeat(64)}`,
    features: [],
    id: 'catalog/node-build-v1',
    platform: 'linux/arm64',
    profile: 'build-restricted',
    templateDigest: 'c'.repeat(64),
    toolchainDigest: 'd'.repeat(64),
  };
}

function observedTerminal<T>(
  operation: Promise<T>,
  unexpectedSuccessMessage: string,
): Promise<never> {
  const terminal = operation.then(
    () => Promise.reject(new Error(unexpectedSuccessMessage)),
    (error: unknown) => Promise.reject(error),
  );
  void terminal.catch(() => undefined);
  return terminal;
}

async function waitForFixtureBarrier(
  barrier: Promise<void>,
  terminals: readonly Promise<never>[],
  description: string,
): Promise<void> {
  await completesWithin(
    Promise.race([barrier, ...terminals]),
    FIXTURE_DEADLINE_MS,
    `Timed out waiting for ${description}.`,
  );
}

async function assertRejectsWithin(
  terminal: Promise<never>,
  timeoutMessage: string,
): Promise<unknown> {
  try {
    await completesWithin(terminal, FIXTURE_DEADLINE_MS, timeoutMessage);
  } catch (error) {
    return error;
  }
  throw new Error('The fixture terminal unexpectedly completed successfully.');
}

async function completesWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function settleFixtureOperations(
  operations: readonly Promise<unknown>[],
  timeoutMessage: string,
): Promise<void> {
  if (operations.length === 0) {
    return;
  }
  await completesWithin(
    Promise.allSettled(operations).then(() => undefined),
    FIXTURE_DEADLINE_MS,
    timeoutMessage,
  );
}

async function waitForProbeJournalStatus(
  journalPath: string,
  expectedStatus: string,
  terminal: Promise<never>,
  description: string,
): Promise<void> {
  let cancelled = false;
  let timeout: NodeJS.Timeout | undefined;
  const pollDeadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${description}.`));
    }, 12_000);
  });
  const observedStatus = (async () => {
    while (!cancelled) {
      try {
        const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
          readonly resources?: readonly { readonly status?: string }[];
        };
        if (journal.resources?.some((resource) => resource.status === expectedStatus)) {
          return;
        }
      } catch {
        // The journal may be between its durable writes while the guardian is
        // still live. The bounded terminal race below remains authoritative.
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }

    throw new Error(`Stopped waiting for ${description}.`);
  })();
  try {
    await Promise.race([observedStatus, terminal, pollDeadline]);
  } finally {
    cancelled = true;
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await Promise.allSettled([observedStatus]);
  }
}

async function waitForIdentityRead(
  native: Promise<unknown>,
  identityReadStarted: Promise<void>,
): Promise<void> {
  await Promise.race([
    identityReadStarted,
    native.then(
      () =>
        Promise.reject(new Error('The native operation completed before identity publication.')),
      (error: unknown) => Promise.reject(error),
    ),
  ]);
}

async function descriptorsFor(path: string): Promise<readonly string[]> {
  const descriptors = await readdir('/proc/self/fd');
  const targets = await Promise.all(
    descriptors.map(async (descriptor) => {
      try {
        return await readlink(`/proc/self/fd/${descriptor}`);
      } catch {
        return undefined;
      }
    }),
  );
  return targets.filter((target): target is string => target === path);
}

async function readProcessStart(pid: number): Promise<string> {
  const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  const closeParenthesis = contents.lastIndexOf(')');
  const processStart = contents.slice(closeParenthesis + 2).split(' ')[19];
  if (closeParenthesis < 0 || processStart === undefined || !/^\d+$/.test(processStart)) {
    throw new Error('The test guardian process identity is invalid.');
  }
  return processStart;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function allErrorMessages(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error instanceof AggregateError) {
    return [error.message, ...[...error.errors].map((item) => allErrorMessages(item))].join('\n');
  }
  return error.message;
}

interface PathObservation {
  readonly dev?: number;
  readonly errorCode?: string;
  readonly ino?: number;
  readonly mode?: string;
  readonly path: string;
  readonly size?: number;
  readonly state: 'error' | 'missing' | 'present';
  readonly type?: 'directory' | 'file' | 'other' | 'symbolic-link';
}

async function observePath(path: string): Promise<PathObservation> {
  try {
    const status = await lstat(path);
    const type = status.isSymbolicLink()
      ? 'symbolic-link'
      : status.isDirectory()
        ? 'directory'
        : status.isFile()
          ? 'file'
          : 'other';
    return {
      dev: status.dev,
      ino: status.ino,
      mode: (status.mode & 0o777).toString(8).padStart(4, '0'),
      path,
      size: status.size,
      state: 'present',
      type,
    };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
    return {
      ...(code === undefined ? {} : { errorCode: code }),
      path,
      state: code === 'ENOENT' ? 'missing' : 'error',
    };
  }
}

async function removeFixtureRoot(path: string): Promise<void> {
  await makeFixtureTreeWritable(path);
  await rm(path, { force: true, recursive: true });
}

async function makeFixtureTreeWritable(path: string): Promise<void> {
  const status = await lstat(path).catch(() => undefined);
  if (status === undefined) {
    return;
  }
  if (!status.isDirectory()) {
    await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    await makeFixtureTreeWritable(join(path, entry.name));
  }
}

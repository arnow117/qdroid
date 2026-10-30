import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createUstarFixture as createUstar } from '../../../fixtures/packages/src/ustar-fixture.js';
import { readFrozenBundle } from '../../../packages/package-runtime/src/archive.js';
import {
  inventoryDigest,
  PackageInstaller,
  readBuildSessionRecovery,
  readPreparedAssemblyInput,
  readPreparedSealedImageVerification,
  type BuildSessionOwner,
  type PackageInstallerPublicationTestHooks,
  type PackageSource,
  type SessionBoundRuntime,
  type TrustedBuildExecutor,
  type TrustedImageAssembler,
  type TrustedImageCatalogEntry,
  type TrustedRuntimeFactory,
} from '../../../packages/package-runtime/src/index.js';
import { OciSessionBoundRuntimeFactory } from '../../../packages/runtime-oci/src/index.js';
import type { RuntimeResourceOps } from '../../../packages/runtime-oci/src/resource-ops.js';
import { readTrustedLinuxBootId } from '../../../packages/supervisor/src/index.js';

test('the OCI runtime factory binds assembler and executor to one BuildAuthority owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-session-runtime-'));
  const sourceBytes = createNoBuildExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/session-runtime',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  const calls: string[] = [];
  let capturedOwner: BuildSessionOwner | undefined;
  let capturedResources: RuntimeResourceOps | undefined;

  const factory = new OciSessionBoundRuntimeFactory({
    createBuildExecutor: (resources, owner) => {
      calls.push('executor');
      capturedOwner = owner;
      capturedResources = resources;
      return testExecutor();
    },
    createImageAssembler: (resources, owner) => {
      calls.push('assembler');
      assert.equal(owner, capturedOwner);
      assert.equal(resources, capturedResources);
      return testAssembler(calls);
    },
    createResources: async (options) => {
      calls.push(`resources:${options.bootId}:${options.ownerId}:${options.sessionId}`);
      assert.equal(options.resourceDirectory, options.owner.privateStateDirectory);
      return testResources(calls);
    },
    ownerStorePath: join(root, 'owners'),
    readBootId: async () => 'boot-id-for-test',
  });
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'trusted-owner',
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    runtimeFactory: factory,
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await installer.install({ sourceId: source.id, target: 'linux/arm64' });

    assert.equal(calls.length, 6);
    assert.match(calls[0]!, /^resources:boot-id-for-test:trusted-owner:candidate-/);
    assert.deepEqual(calls.slice(1), ['executor', 'assembler', 'assemble', 'verify', 'close']);
    assert.notEqual(capturedOwner, undefined);

    const retiredOwner = capturedOwner as BuildSessionOwner;
    await assert.rejects(
      factory.create(retiredOwner),
      /BuildSession owner is not active for a trusted runtime operation/,
    );
    await assert.rejects(
      factory.create({ ...retiredOwner }),
      /BuildSession owner is not active for a trusted runtime operation/,
    );
  } finally {
    await removeFixtureRoot(root);
  }
});

test('an existing resource journal key is resynchronized before a runtime can use it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-resource-journal-key-resync-'));
  const source = packageSource('catalog/resource-journal-key-resync');
  const calls: string[] = [];
  let journalKeySyncAttempts = 0;
  const factory = testOciFactory(root, calls);
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'trusted-owner',
    publicationTestHooks: {
      afterResourceJournalKeyFileSync: async () => {
        journalKeySyncAttempts += 1;
        if (journalKeySyncAttempts === 1) {
          throw new Error('Injected first resource journal key sync failure.');
        }
      },
    },
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    runtimeFactory: factory,
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /first resource journal key sync failure/,
    );
    assert.deepEqual(calls, [], 'a failed key sync must not construct a runtime');

    await installer.install({ sourceId: source.id, target: 'linux/arm64' });
    assert.equal(journalKeySyncAttempts, 2);
    assert.deepEqual(
      calls.filter((call) => call === 'resources'),
      ['resources'],
    );
  } finally {
    await removeFixtureRoot(root);
  }
});

test('the default OCI assembler accepts only installer-registered managed material', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-managed-assembly-runtime-'));
  const source = packageSource('catalog/managed-assembly-runtime');
  const assembledMaterials: string[] = [];
  const verifiedMaterials: string[] = [];
  const factory = new OciSessionBoundRuntimeFactory({
    createBuildExecutor: () => testExecutor(),
    createResources: async (options) => {
      const unavailable = async (): Promise<never> => {
        throw new Error('This test does not create non-assembly resources.');
      };
      return {
        assembleFixed: async (input) => {
          await assert.rejects(
            Promise.resolve().then(() =>
              readPreparedAssemblyInput(options.owner, {} as typeof input),
            ),
            /not owned by this BuildSession/,
          );
          const material = readPreparedAssemblyInput(options.owner, input);
          assembledMaterials.push(material.materialDigest);
          return {
            cleanupConfirmed: true,
            imageId: `sha256:${'c'.repeat(64)}`,
            receipt: {
              assembler: 'qdroid.fixed-copy-commit/v2',
              candidateId: material.candidateId,
              materialDigest: material.materialDigest,
              packageDigest: material.packageDigest,
              purpose: material.purpose,
            },
          };
        },
        assertQualificationReady: () => {
          throw new Error('This test does not qualify a runtime.');
        },
        close: async () => undefined,
        createBoundaryControl: unavailable,
        createFixture: unavailable,
        createNetworkControls: unavailable,
        native: unavailable,
        prepareProbe: unavailable,
        verifySealedFixed: async (verification) => {
          await assert.rejects(
            Promise.resolve().then(() =>
              readPreparedSealedImageVerification(options.owner, {} as typeof verification),
            ),
            /not owned by this BuildSession/,
          );
          const material = readPreparedSealedImageVerification(options.owner, verification);
          verifiedMaterials.push(material.materialDigest);
        },
      };
    },
    ownerStorePath: join(root, 'owners'),
    readBootId: async () => 'boot-id-for-test',
  });
  const installer = createInstaller(root, source, factory);

  try {
    const installed = await installer.install({ sourceId: source.id, target: 'linux/arm64' });

    assert.equal(assembledMaterials.length, 1);
    assert.deepEqual(verifiedMaterials, assembledMaterials);
    const resourceJournalKeyPath = join(root, 'build-authority', '.resource-journal-key');
    const resourceJournalKey = await readFile(resourceJournalKeyPath);
    const resourceJournalKeyStatus = await lstat(resourceJournalKeyPath);
    assert.equal(resourceJournalKey.byteLength, 32);
    assert.equal(resourceJournalKeyStatus.mode & 0o777, 0o600);

    const receiptPath = installed.record.runtimeReceiptPath;
    assert.notEqual(receiptPath, null);
    const originalReceiptPath = receiptPath as string;
    const originalReceipt = await readFile(originalReceiptPath);

    const originalSealDirectory = dirname(originalReceiptPath);
    const sealsDirectory = dirname(originalSealDirectory);
    await chmod(sealsDirectory, 0o700);
    await chmod(originalSealDirectory, 0o700);
    await chmod(originalReceiptPath, 0o600);
    const tamperedReceipt = JSON.parse(originalReceipt.toString('utf8')) as Record<string, unknown>;
    tamperedReceipt.candidateId = 'candidate-00000000-0000-4000-8000-000000000001';
    await writeFile(originalReceiptPath, `${JSON.stringify(tamperedReceipt)}\n`);
    await chmod(originalReceiptPath, 0o444);

    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /not bound to its original seal/,
    );
    assert.equal(assembledMaterials.length, 1);
    assert.equal(verifiedMaterials.length, 1);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a settled OCI runtime-factory failure retires its BuildAuthority session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-session-runtime-failure-'));
  const sourceBytes = createNoBuildExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/session-runtime-failure',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  const calls: string[] = [];
  let rejectAssemblerConstruction = true;
  const factory = new OciSessionBoundRuntimeFactory({
    createBuildExecutor: () => testExecutor(),
    createImageAssembler: () => {
      if (rejectAssemblerConstruction) {
        throw new Error('the trusted assembler constructor failed');
      }
      return testAssembler(calls);
    },
    createResources: async () => testResources(calls),
    ownerStorePath: join(root, 'owners'),
    readBootId: async () => 'boot-id-for-test',
  });
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'trusted-owner',
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    runtimeFactory: factory,
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /assembler constructor failed/,
    );
    rejectAssemblerConstruction = false;
    const retried = await installer.install({ sourceId: source.id, target: 'linux/arm64' });

    assert.equal(retried.reusedExisting, false);
    assert.equal(calls.filter((call) => call === 'close').length, 2);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('fresh factory and cleanup failures retain their causes, owner evidence, and session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-session-runtime-fresh-double-failure-'));
  const source = packageSource('catalog/session-runtime-fresh-double-failure');
  const calls: string[] = [];
  let capturedOwner: BuildSessionOwner | undefined;
  const factory = new OciSessionBoundRuntimeFactory({
    createBuildExecutor: () => testExecutor(),
    createImageAssembler: () => {
      throw new Error('fresh factory construction failed');
    },
    createResources: async (options) => {
      capturedOwner = options.owner;
      return testResources(calls, new Error('fresh factory cleanup failed'));
    },
    ownerStorePath: join(root, 'owners'),
    readBootId: async () => 'boot-id-for-test',
  });
  const installer = createInstaller(root, source, factory);

  try {
    await assertDoubleFailure(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      'fresh factory construction failed',
      'fresh factory cleanup failed',
    );
    assert.equal(calls.filter((call) => call === 'close').length, 1);
    await assertOwnerRetired(factory, capturedOwner);
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /synthetic-unverified build-session intent cannot authorize fresh recovery/,
    );
  } finally {
    await removeFixtureRoot(root);
  }
});

test('executable reuse preserves factory and cleanup failures without retaining the SQL lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-session-runtime-reuse-double-failure-'));
  const source = packageSource('catalog/session-runtime-reuse-double-failure');
  const successfulCalls: string[] = [];
  const successfulFactory = new OciSessionBoundRuntimeFactory({
    createBuildExecutor: () => testExecutor(),
    createImageAssembler: () => testAssembler(successfulCalls),
    createResources: async () => testResources(successfulCalls),
    ownerStorePath: join(root, 'owners-success'),
    readBootId: async () => 'boot-id-for-test',
  });
  const initialInstaller = createInstaller(root, source, successfulFactory);
  const failedCalls: string[] = [];
  let capturedOwner: BuildSessionOwner | undefined;
  const failedFactory = new OciSessionBoundRuntimeFactory({
    createBuildExecutor: () => testExecutor(),
    createImageAssembler: () => {
      throw new Error('reuse factory construction failed');
    },
    createResources: async (options) => {
      capturedOwner = options.owner;
      return testResources(failedCalls, new Error('reuse factory cleanup failed'));
    },
    ownerStorePath: join(root, 'owners-failed'),
    readBootId: async () => 'boot-id-for-test',
  });
  const failedInstaller = createInstaller(root, source, failedFactory);

  try {
    await initialInstaller.install({ sourceId: source.id, target: 'linux/arm64' });

    await assertDoubleFailure(
      failedInstaller.install({ sourceId: source.id, target: 'linux/arm64' }),
      'reuse factory construction failed',
      'reuse factory cleanup failed',
    );
    assert.equal(failedCalls.filter((call) => call === 'close').length, 1);
    await assertOwnerRetired(failedFactory, capturedOwner);
    await assert.rejects(
      failedInstaller.install({ sourceId: source.id, target: 'linux/arm64' }),
      /synthetic-unverified build-session intent cannot authorize fresh recovery/,
    );
  } finally {
    await removeFixtureRoot(root);
  }
});

test('runtime initialization is exclusive across factory objects for one BuildSession', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-session-runtime-exclusive-'));
  const source = packageSource('catalog/session-runtime-exclusive');
  const calls: string[] = [];
  const firstFactory = testOciFactory(root, calls);
  const secondFactory = testOciFactory(root, calls);
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      const runtime = await firstFactory.create(owner);
      await assert.rejects(
        secondFactory.create(owner),
        /already has a trusted runtime initialization/,
      );
      return runtime;
    },
    settleFailedCreate: async (owner) => firstFactory.settleFailedCreate(owner),
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    await installer.install({ sourceId: source.id, target: 'linux/arm64' });
    assert.deepEqual(
      calls.filter((call) => call === 'resources'),
      ['resources'],
    );
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a held factory initialization cannot continue after finalization seals its owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-session-runtime-initialization-seal-'));
  const source = packageSource('catalog/session-runtime-initialization-seal');
  const calls: string[] = [];
  let capturedOwner: BuildSessionOwner | undefined;
  let releaseBootRead: (() => void) | undefined;
  let signalBootRead: (() => void) | undefined;
  let signalSettlement: (() => void) | undefined;
  const bootReadStarted = new Promise<void>((resolve) => {
    signalBootRead = resolve;
  });
  const settlementStarted = new Promise<void>((resolve) => {
    signalSettlement = resolve;
  });
  const bootReadRelease = new Promise<void>((resolve) => {
    releaseBootRead = resolve;
  });
  const innerFactory = new OciSessionBoundRuntimeFactory({
    createBuildExecutor: () => testExecutor(),
    createImageAssembler: () => testAssembler(calls),
    createResources: async () => {
      calls.push('resources');
      return testResources(calls);
    },
    ownerStorePath: join(root, 'owners'),
    readBootId: async () => {
      signalBootRead?.();
      await bootReadRelease;
      return 'boot-id-for-test';
    },
  });
  let startedInnerCreate: Promise<SessionBoundRuntime> | undefined;
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async (owner) => {
      capturedOwner = owner;
      startedInnerCreate = innerFactory.create(owner);
      void startedInnerCreate.catch(() => undefined);
      throw new Error('outer factory failed after starting trusted initialization');
    },
    settleFailedCreate: async (owner) => {
      signalSettlement?.();
      await innerFactory.settleFailedCreate(owner);
    },
  };
  const installer = createInstaller(root, source, runtimeFactory);

  try {
    const installing = installer.install({ sourceId: source.id, target: 'linux/arm64' });
    await bootReadStarted;
    await settlementStarted;
    releaseBootRead?.();

    await assert.rejects(installing, (error: unknown) => {
      assert.match(
        allErrorMessages(error),
        /outer factory failed after starting trusted initialization/,
      );
      return true;
    });
    assert.deepEqual(calls, []);
    await assertOwnerRetired(innerFactory, capturedOwner);
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /synthetic-unverified build-session intent cannot authorize fresh recovery/,
    );
  } finally {
    releaseBootRead?.();
    await removeFixtureRoot(root);
  }
});

test('a dead verified pre-provider session is retired before a fresh runtime is admitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-session-runtime-fresh-recovery-'));
  const source = packageSource('catalog/session-runtime-fresh-recovery');
  const identity = Object.freeze({
    bootId: '12345678-1234-1234-1234-123456789abc',
    kind: 'linux-verified' as const,
    pid: 999_999,
    processStart: '1',
  });
  const staleFactory: TrustedRuntimeFactory = {
    captureOwnerIdentity: async () => identity,
    create: async () => {
      throw new Error('Injected pre-provider factory failure.');
    },
    settleFailedCreate: async () => {
      throw new Error('Injected failed-create settlement failure.');
    },
  };
  let recoveredCandidate: string | undefined;
  const calls: string[] = [];
  const freshFactory: TrustedRuntimeFactory = {
    captureOwnerIdentity: async () => Object.freeze({ kind: 'synthetic-unverified' as const }),
    create: async () => ({
      buildExecutor: testExecutor(),
      close: async () => {
        calls.push('close');
      },
      imageAssembler: testAssembler(calls),
    }),
    recoverSession: async (recovery) => {
      const details = readBuildSessionRecovery(recovery);
      recoveredCandidate = details.candidateId;
      assert.equal(details.identity.kind, 'linux-verified');
      assert.equal(details.journalPath, undefined);
      return Object.freeze({
        cleanupReceiptTag: 'f'.repeat(64),
        status: 'confirmed' as const,
      });
    },
  };

  try {
    await assert.rejects(
      createInstaller(root, source, staleFactory).install({
        sourceId: source.id,
        target: 'linux/arm64',
      }),
      (error: unknown) => {
        assert.match(allErrorMessages(error), /Injected pre-provider factory failure/);
        assert.match(allErrorMessages(error), /Injected failed-create settlement failure/);
        return true;
      },
    );

    const sessionsDirectory = join(root, 'build-authority', 'sessions');
    assert.equal((await readdir(sessionsDirectory)).length, 1);

    await createInstaller(root, source, freshFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });

    assert.match(recoveredCandidate ?? '', /^candidate-/);
    assert.equal((await readdir(sessionsDirectory)).length, 0);
    assert.deepEqual(calls, ['assemble', 'verify', 'close']);
  } finally {
    await removeFixtureRoot(root);
  }
});

test(
  'the production OCI recovery adapter retires a dead verified pre-provider owner',
  { skip: process.platform !== 'linux' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'qdroid-session-runtime-production-recovery-'));
    const source = packageSource('catalog/session-runtime-production-recovery');
    const bootId = await readTrustedLinuxBootId();
    const staleFactory: TrustedRuntimeFactory = {
      captureOwnerIdentity: async () =>
        Object.freeze({
          bootId,
          kind: 'linux-verified' as const,
          pid: 999_999_999,
          processStart: '1',
        }),
      create: async () => {
        throw new Error('Injected production-recovery pre-provider factory failure.');
      },
      settleFailedCreate: async () => {
        throw new Error('Injected production-recovery failed-create settlement failure.');
      },
    };
    const productionRecovery = new OciSessionBoundRuntimeFactory({
      ownerStorePath: join(root, 'owners'),
    });
    const calls: string[] = [];
    const freshFactory: TrustedRuntimeFactory = {
      captureOwnerIdentity: async () => Object.freeze({ kind: 'synthetic-unverified' as const }),
      create: async () => ({
        buildExecutor: testExecutor(),
        close: async () => {
          calls.push('close');
        },
        imageAssembler: testAssembler(calls),
      }),
      recoverSession: (recovery) => productionRecovery.recoverSession(recovery),
    };

    try {
      await assert.rejects(
        createInstaller(root, source, staleFactory).install({
          sourceId: source.id,
          target: 'linux/arm64',
        }),
        (error: unknown) => {
          assert.match(allErrorMessages(error), /production-recovery pre-provider factory failure/);
          assert.match(
            allErrorMessages(error),
            /production-recovery failed-create settlement failure/,
          );
          return true;
        },
      );

      const sessionsDirectory = join(root, 'build-authority', 'sessions');
      assert.equal((await readdir(sessionsDirectory)).length, 1);

      await createInstaller(root, source, freshFactory).install({
        sourceId: source.id,
        target: 'linux/arm64',
      });

      assert.equal((await readdir(sessionsDirectory)).length, 0);
      assert.deepEqual(calls, ['assemble', 'verify', 'close']);
    } finally {
      await removeFixtureRoot(root);
    }
  },
);

test(
  'the production OCI recovery adapter retains a nonempty pre-provider runtime store',
  { skip: process.platform !== 'linux' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'qdroid-session-runtime-foreign-pre-provider-'));
    const source = packageSource('catalog/session-runtime-foreign-pre-provider');
    const bootId = await readTrustedLinuxBootId();
    let staleStore: string | undefined;
    const staleFactory: TrustedRuntimeFactory = {
      captureOwnerIdentity: async () =>
        Object.freeze({
          bootId,
          kind: 'linux-verified' as const,
          pid: 999_999_998,
          processStart: '1',
        }),
      create: async (owner) => {
        staleStore = owner.privateStateDirectory;
        await mkdir(staleStore, { mode: 0o700, recursive: true });
        await writeFile(join(staleStore, 'foreign-writer.json'), 'foreign\n', { mode: 0o600 });
        throw new Error('Injected pre-provider store conflict.');
      },
      settleFailedCreate: async () => {
        throw new Error('Injected pre-provider store settlement failure.');
      },
    };
    const productionRecovery = new OciSessionBoundRuntimeFactory({
      ownerStorePath: join(root, 'owners'),
    });
    let freshCreateCalls = 0;
    const freshFactory: TrustedRuntimeFactory = {
      captureOwnerIdentity: async () => Object.freeze({ kind: 'synthetic-unverified' as const }),
      create: async () => {
        freshCreateCalls += 1;
        return {
          buildExecutor: testExecutor(),
          close: async () => undefined,
          imageAssembler: testAssembler([]),
        };
      },
      recoverSession: (recovery) => productionRecovery.recoverSession(recovery),
    };

    try {
      await assert.rejects(
        createInstaller(root, source, staleFactory).install({
          sourceId: source.id,
          target: 'linux/arm64',
        }),
        (error: unknown) => {
          assert.match(allErrorMessages(error), /pre-provider store conflict/);
          return true;
        },
      );
      assert.notEqual(staleStore, undefined);

      await assert.rejects(
        createInstaller(root, source, freshFactory).install({
          sourceId: source.id,
          target: 'linux/arm64',
        }),
        /prior build session remains unknown/,
      );

      assert.equal(freshCreateCalls, 0);
      assert.equal(
        await readFile(join(staleStore as string, 'foreign-writer.json'), 'utf8'),
        'foreign\n',
      );
      assert.equal((await readdir(join(root, 'build-authority', 'sessions'))).length, 1);
    } finally {
      await removeFixtureRoot(root);
    }
  },
);

test(
  'the production OCI recovery adapter retains a pre-provider intent behind a runtime-sessions symlink',
  { skip: process.platform !== 'linux' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'qdroid-session-runtime-symlinked-pre-provider-'));
    const source = packageSource('catalog/session-runtime-symlinked-pre-provider');
    const bootId = await readTrustedLinuxBootId();
    let staleStore: string | undefined;
    const staleFactory: TrustedRuntimeFactory = {
      captureOwnerIdentity: async () =>
        Object.freeze({
          bootId,
          kind: 'linux-verified' as const,
          pid: 999_999_997,
          processStart: '1',
        }),
      create: async (owner) => {
        staleStore = owner.privateStateDirectory;
        throw new Error('Injected symlinked pre-provider failure.');
      },
      settleFailedCreate: async () => {
        throw new Error('Injected symlinked pre-provider settlement failure.');
      },
    };
    const productionRecovery = new OciSessionBoundRuntimeFactory({
      ownerStorePath: join(root, 'owners'),
    });
    let freshCreateCalls = 0;
    const freshFactory: TrustedRuntimeFactory = {
      captureOwnerIdentity: async () => Object.freeze({ kind: 'synthetic-unverified' as const }),
      create: async () => {
        freshCreateCalls += 1;
        return {
          buildExecutor: testExecutor(),
          close: async () => undefined,
          imageAssembler: testAssembler([]),
        };
      },
      recoverSession: (recovery) => productionRecovery.recoverSession(recovery),
    };

    try {
      await assert.rejects(
        createInstaller(root, source, staleFactory).install({
          sourceId: source.id,
          target: 'linux/arm64',
        }),
        (error: unknown) => {
          assert.match(allErrorMessages(error), /symlinked pre-provider failure/);
          return true;
        },
      );
      const runtimeStore = staleStore as string;
      const runtimeSessionsDirectory = dirname(runtimeStore);
      const retainedRuntimeSessionsDirectory = join(root, 'retained-runtime-sessions');
      const foreignEmptyDirectory = join(root, 'foreign-empty-runtime-sessions');
      await mkdir(runtimeSessionsDirectory, { mode: 0o700, recursive: true });
      await mkdir(foreignEmptyDirectory, { mode: 0o700 });
      await rename(runtimeSessionsDirectory, retainedRuntimeSessionsDirectory);
      await symlink(foreignEmptyDirectory, runtimeSessionsDirectory);

      await assert.rejects(
        createInstaller(root, source, freshFactory).install({
          sourceId: source.id,
          target: 'linux/arm64',
        }),
        /prior build session remains unknown/,
      );

      assert.equal(freshCreateCalls, 0);
      assert.deepEqual(await readdir(foreignEmptyDirectory), []);
      assert.equal((await readdir(join(root, 'build-authority', 'sessions'))).length, 1);
    } finally {
      await removeFixtureRoot(root);
    }
  },
);

test('recovery preserves durable retirement failures and resynchronizes a linked receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-session-runtime-retirement-durability-'));
  const source = packageSource('catalog/session-runtime-retirement-durability');
  const identity = Object.freeze({
    bootId: '12345678-1234-1234-1234-123456789abc',
    kind: 'linux-verified' as const,
    pid: 999_999,
    processStart: '1',
  });
  const staleFactory: TrustedRuntimeFactory = {
    captureOwnerIdentity: async () => identity,
    create: async () => {
      throw new Error('Injected durable-retirement pre-provider failure.');
    },
    settleFailedCreate: async () => {
      throw new Error('Injected durable-retirement settlement failure.');
    },
  };
  let recoveryCalls = 0;
  const freshFactory: TrustedRuntimeFactory = {
    captureOwnerIdentity: async () => Object.freeze({ kind: 'synthetic-unverified' as const }),
    create: async () => ({
      buildExecutor: testExecutor(),
      close: async () => undefined,
      imageAssembler: testAssembler([]),
    }),
    recoverSession: async () => {
      recoveryCalls += 1;
      return Object.freeze({ cleanupReceiptTag: 'f'.repeat(64), status: 'confirmed' as const });
    },
  };
  const isRetirementPath = (path: string): boolean => path.includes('/retirements/');
  const descriptorFailureHooks: PackageInstallerPublicationTestHooks = {
    afterDurableWriteFileClose: async (path) => {
      if (isRetirementPath(path)) {
        throw new Error('Injected durable retirement descriptor close failure.');
      }
    },
    afterDurableWriteFileSync: async (path) => {
      if (isRetirementPath(path)) {
        throw new Error('Injected durable retirement file sync failure.');
      }
    },
  };
  const linkFailureHooks: PackageInstallerPublicationTestHooks = {
    afterDurableWriteLink: async (path) => {
      if (isRetirementPath(path)) {
        throw new Error('Injected durable retirement directory sync failure after link.');
      }
    },
    afterDurableWriteTemporaryUnlink: async (path) => {
      if (isRetirementPath(path)) {
        throw new Error('Injected durable retirement staging unlink failure.');
      }
    },
  };

  try {
    await assert.rejects(
      createInstaller(root, source, staleFactory).install({
        sourceId: source.id,
        target: 'linux/arm64',
      }),
      (error: unknown) => {
        assert.match(allErrorMessages(error), /durable-retirement pre-provider failure/);
        return true;
      },
    );

    await assert.rejects(
      createInstaller(root, source, freshFactory, descriptorFailureHooks).install({
        sourceId: source.id,
        target: 'linux/arm64',
      }),
      (error: unknown) => {
        const messages = allErrorMessages(error);
        assert.match(messages, /durable retirement file sync failure/);
        assert.match(messages, /durable retirement descriptor close failure/);
        return true;
      },
    );
    assert.equal((await readdir(join(root, 'build-authority', 'sessions'))).length, 1);

    await assert.rejects(
      createInstaller(root, source, freshFactory, linkFailureHooks).install({
        sourceId: source.id,
        target: 'linux/arm64',
      }),
      (error: unknown) => {
        const messages = allErrorMessages(error);
        assert.match(messages, /durable retirement directory sync failure after link/);
        assert.match(messages, /durable retirement staging unlink failure/);
        return true;
      },
    );
    assert.equal((await readdir(join(root, 'build-authority', 'sessions'))).length, 1);
    assert.equal((await readdir(join(root, 'build-authority', 'retirements'))).length > 0, true);

    await createInstaller(root, source, freshFactory).install({
      sourceId: source.id,
      target: 'linux/arm64',
    });
    assert.equal(recoveryCalls, 2, 'an existing retirement receipt must not replay cleanup');
    assert.equal((await readdir(join(root, 'build-authority', 'sessions'))).length, 0);
  } finally {
    await removeFixtureRoot(root);
  }
});

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

function testOciFactory(root: string, calls: string[]): OciSessionBoundRuntimeFactory {
  return new OciSessionBoundRuntimeFactory({
    createBuildExecutor: () => testExecutor(),
    createImageAssembler: () => testAssembler(calls),
    createResources: async () => {
      calls.push('resources');
      return testResources(calls);
    },
    ownerStorePath: join(root, 'owners'),
    readBootId: async () => 'boot-id-for-test',
  });
}

async function assertDoubleFailure(
  operation: Promise<unknown>,
  primaryMessage: string,
  cleanupMessage: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.match(allErrorMessages(error), new RegExp(primaryMessage));
    assert.match(allErrorMessages(error), new RegExp(cleanupMessage));
    return true;
  });
}

async function assertOwnerRetired(
  factory: OciSessionBoundRuntimeFactory,
  owner: BuildSessionOwner | undefined,
): Promise<void> {
  assert.notEqual(owner, undefined);
  await assert.rejects(
    factory.create(owner as BuildSessionOwner),
    /BuildSession owner is not active for a trusted runtime operation/,
  );
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

function testResources(
  calls: string[],
  closeFailure?: Error,
): RuntimeResourceOps & { close(): Promise<void> } {
  const unavailable = async (): Promise<never> => {
    throw new Error('This factory test does not execute resource effects.');
  };
  return {
    assertQualificationReady: () => {
      throw new Error('This factory test does not qualify a runtime.');
    },
    close: async () => {
      calls.push('close');
      if (closeFailure !== undefined) {
        throw closeFailure;
      }
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

function testExecutor(): TrustedBuildExecutor {
  return {
    managesResources: true,
    execute: async () => {
      throw new Error('This factory test does not execute a build.');
    },
  };
}

function testAssembler(calls: string[]): TrustedImageAssembler {
  return {
    assemble: async () => {
      calls.push('assemble');
      return {
        cleanupConfirmed: true,
        imageId: `sha256:${'c'.repeat(64)}`,
        receipt: {},
      };
    },
    verifySealed: async () => {
      calls.push('verify');
    },
  };
}

function createNoBuildExecutablePackageBundle(): Buffer {
  const manifest = JSON.stringify({
    assets: [],
    engineCompatibility: '>=0.1.0 <0.2.0',
    entrypoint: { executable: '/opt/qdroid/entrypoint', type: 'command' },
    kind: 'tool',
    license: 'Apache-2.0',
    name: 'qdroid/session-runtime',
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

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
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

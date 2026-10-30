import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  readFrozenBundle,
  readFrozenUstar,
} from '../../../packages/package-runtime/src/archive.js';
import {
  assertPreparedAssemblyMaterial,
  inventoryDigest,
  PackageInstaller,
  preparedAssemblyInputFor,
  preparedSealedImageVerificationFor,
  readPreparedAssemblyInput,
  readPreparedSealedImageVerification,
  type BuildSessionOwner,
  type DisabledInstallationRecord,
  type ImageAssemblyRequest,
  type InstallResult,
  type PackageSource,
  type PackageInstallerPublicationTestHooks,
  type TrustedBuildExecutor,
  type TrustedImageAssembler,
  type TrustedImageCatalogEntry,
  type TrustedRuntimeFactory,
} from '../../../packages/package-runtime/src/index.js';
import { createUstarFixture as createUstar } from '../../../fixtures/packages/src/ustar-fixture.js';

const catalog = Object.freeze({
  abi: 'glibc-2.39',
  baseImage: `sha256:${'a'.repeat(64)}`,
  builderImage: `sha256:${'b'.repeat(64)}`,
  features: [],
  id: 'catalog/graph-v1',
  platform: 'linux/arm64',
  profile: 'build-restricted',
  templateDigest: 'c'.repeat(64),
  toolchainDigest: 'd'.repeat(64),
} satisfies TrustedImageCatalogEntry);

test('an executable graph builds shared dependencies serially under one runtime and reuses retained material', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-executable-graph-'));
  let completed = false;
  const reads = new Map<string, number>();
  const leaf = createGraphBundle({ name: 'qdroid/leaf' });
  const left = createGraphBundle({
    build: true,
    dependencies: [{ name: 'qdroid/leaf', sourceId: 'catalog/leaf', version: '1.0.0' }],
    name: 'qdroid/left',
  });
  const right = createGraphBundle({
    build: true,
    dependencies: [{ name: 'qdroid/leaf', sourceId: 'catalog/leaf', version: '1.0.0' }],
    name: 'qdroid/right',
  });
  const rootBundle = createGraphBundle({
    dependencies: [
      { name: 'qdroid/left', sourceId: 'catalog/left', version: '1.0.0' },
      { name: 'qdroid/right', sourceId: 'catalog/right', version: '1.0.0' },
    ],
    executable: true,
    name: 'qdroid/root',
  });
  const builderSteps: string[] = [];
  const assemblyRequests: ImageAssemblyRequest[] = [];
  let originalOwner: BuildSessionOwner | undefined;
  let runtimeCreations = 0;
  let verificationCalls = 0;
  const executor: TrustedBuildExecutor = {
    managesResources: true,
    execute: async (request) => {
      builderSteps.push(request.packageDigest);
      return completedExecution(
        createUstar([{ body: `built:${request.packageDigest}`, path: 'generated/result.txt' }]),
      );
    },
  };
  const assembler: TrustedImageAssembler = {
    assemble: async (request) => {
      assemblyRequests.push(request);
      const graph = request.graph;
      assert.ok(graph !== undefined, 'graph assembly must carry installer-created graph material');
      assert.equal(graph.schema, 'qdroid.prepared-graph-assembly/v1');
      if (request.purpose === 'builder') {
        assert.equal(graph.graphMaterialDigest, undefined);
        assert.equal(graph.nodes.length, 2, 'a builder receives only its dependency closure');
        assert.equal(
          graph.nodes.filter((node) => node.generatedOutputDigest !== undefined).length,
          0,
          'a builder cannot receive its own future output',
        );
        assert.equal(graph.nodes.at(-1)?.packageDigest, request.packageDigest);
      } else {
        assert.notEqual(graph.graphMaterialDigest, undefined);
        assert.equal(graph.nodes.length, 4);
      }
      return {
        cleanupConfirmed: true,
        imageId: `sha256:${String(assemblyRequests.length).padStart(64, '0')}`,
        receipt: {},
      };
    },
    verifySealed: async (request) => {
      verificationCalls += 1;
      assert.ok(request.graph !== undefined);
    },
  };
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([[catalog.id, catalog]]),
    runtimeFactory: graphRuntimeFactory(
      executor,
      assembler,
      (owner) => {
        originalOwner ??= owner;
        runtimeCreations += 1;
      },
      true,
    ),
    sources: new Map([
      ['catalog/root', graphSource('catalog/root', rootBundle, reads)],
      ['catalog/left', graphSource('catalog/left', left, reads)],
      ['catalog/right', graphSource('catalog/right', right, reads)],
      ['catalog/leaf', graphSource('catalog/leaf', leaf, reads)],
    ]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const first = await installer.install({ sourceId: 'catalog/root', target: 'linux/arm64' });
    const material = JSON.parse(await readFile(first.record.graphMaterialPath!, 'utf8')) as {
      execution: { schema: string };
      nodes: readonly { generatedOutputDigest: string | null; packageDigest: string }[];
    };
    const second = await installer.install({ sourceId: 'catalog/root', target: 'linux/arm64' });

    assert.equal(first.reusedExisting, false);
    assert.equal(second.reusedExisting, true);
    assert.deepEqual(second.record, first.record);
    assert.equal(first.record.builderImageId, null);
    assert.equal(first.record.builderReceiptPath, null);
    assert.equal(first.record.generatedDirectory, null);
    assert.equal(first.record.generatedInventoryPath, null);
    assert.equal(
      runtimeCreations,
      2,
      'one root runtime for publication and one for read-only reuse',
    );
    assert.equal(builderSteps.length, 2, 'only declared child builds execute');
    assert.deepEqual(builderSteps, [
      inventoryDigest(readFrozenBundle(left).entries),
      inventoryDigest(readFrozenBundle(right).entries),
    ]);
    assert.equal(
      assemblyRequests.length,
      3,
      'two child builders and one root runtime are assembled',
    );
    assert.equal(
      verificationCalls,
      6,
      'publication and reuse each verify two child builders and the final image',
    );
    assert.equal(material.execution.schema, 'qdroid.graph-execution/v1');
    assert.equal(material.nodes.filter((node) => node.generatedOutputDigest !== null).length, 2);
    assert.deepEqual([...reads.entries()].sort(), [
      ['catalog/leaf', 2],
      ['catalog/left', 2],
      ['catalog/right', 2],
      ['catalog/root', 2],
    ]);
    assert.notEqual(originalOwner, undefined);
    assert.throws(
      () => preparedAssemblyInputFor(originalOwner!, assemblyRequests[0]!),
      /not active for a trusted runtime operation/,
    );
    assert.throws(
      () => preparedAssemblyInputFor({ ...originalOwner! }, assemblyRequests[0]!),
      /not active for a trusted runtime operation/,
    );

    const registry = new DatabaseSync(join(root, 'registry', 'registry.sqlite'));
    try {
      const rows = registry
        .prepare('SELECT package_name FROM package_versions')
        .all() as unknown as readonly { package_name: string }[];
      assert.deepEqual(
        rows.map((row) => row.package_name),
        ['qdroid/root'],
      );
    } finally {
      registry.close();
    }
    completed = true;
  } finally {
    await cleanupGraphFixture(root, completed);
  }
});

test('an unsupported graph factory rejects before filesystem authority or runtime effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-executable-graph-unsupported-'));
  let completed = false;
  const bundle = createGraphBundle({ executable: true, name: 'qdroid/root' });
  let runtimeCreations = 0;
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([[catalog.id, catalog]]),
    runtimeFactory: {
      create: async () => {
        runtimeCreations += 1;
        throw new Error('The unsupported factory must not create a runtime.');
      },
    },
    sources: new Map([['catalog/root', graphSource('catalog/root', bundle, new Map())]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: 'catalog/root', target: 'linux/arm64' }),
      /require a trusted graph-material runtime factory/,
    );
    assert.equal(runtimeCreations, 0);
    assert.deepEqual(await readdir(root), []);
    completed = true;
  } finally {
    await cleanupGraphFixture(root, completed);
  }
});

test('a built dependency chain exposes only already-sealed outputs to each builder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-executable-graph-chain-'));
  let completed = false;
  const first = createGraphBundle({ build: true, name: 'qdroid/first' });
  const second = createGraphBundle({
    build: true,
    dependencies: [{ name: 'qdroid/first', sourceId: 'catalog/first', version: '1.0.0' }],
    name: 'qdroid/second',
  });
  const rootBundle = createGraphBundle({
    dependencies: [{ name: 'qdroid/second', sourceId: 'catalog/second', version: '1.0.0' }],
    executable: true,
    name: 'qdroid/root',
  });
  const assemblyRequests: ImageAssemblyRequest[] = [];
  const executor: TrustedBuildExecutor = {
    managesResources: true,
    execute: async (request) =>
      completedExecution(
        createUstar([{ body: request.packageDigest, path: 'generated/result.txt' }]),
      ),
  };
  const assembler: TrustedImageAssembler = {
    assemble: async (request) => {
      assemblyRequests.push(request);
      return {
        cleanupConfirmed: true,
        imageId: `sha256:${String(assemblyRequests.length).padStart(64, '0')}`,
        receipt: {},
      };
    },
    verifySealed: async () => undefined,
  };
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([[catalog.id, catalog]]),
    runtimeFactory: graphRuntimeFactory(executor, assembler, () => undefined, true),
    sources: new Map([
      ['catalog/root', graphSource('catalog/root', rootBundle, new Map())],
      ['catalog/first', graphSource('catalog/first', first, new Map())],
      ['catalog/second', graphSource('catalog/second', second, new Map())],
    ]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const installed = await installer.install({ sourceId: 'catalog/root', target: 'linux/arm64' });
    await installer.install({ sourceId: 'catalog/root', target: 'linux/arm64' });

    const builderRequests = assemblyRequests.filter((request) => request.purpose === 'builder');
    assert.equal(builderRequests.length, 2);
    const firstBuilder = builderRequests[0]!.graph!;
    const secondBuilder = builderRequests[1]!.graph!;
    assert.equal(firstBuilder.nodes.length, 1);
    assert.equal(firstBuilder.nodes[0]?.generatedOutputDigest, undefined);
    assert.equal(secondBuilder.nodes.length, 2);
    assert.equal(
      secondBuilder.nodes.filter((node) => node.generatedOutputDigest !== undefined).length,
      1,
    );
    assert.equal(
      secondBuilder.nodes.find((node) => node.packageDigest === secondBuilder.stepNodePackageDigest)
        ?.generatedOutputDigest,
      undefined,
    );
    const finalAssembly = assemblyRequests.find((request) => request.purpose === 'runtime')!.graph!;
    assert.equal(finalAssembly.nodes.length, 3);
    assert.equal(
      finalAssembly.nodes.filter((node) => node.generatedOutputDigest !== undefined).length,
      2,
    );
    assert.notEqual(finalAssembly.graphMaterialDigest, undefined);
    assert.equal(installed.record.builderImageId, null);
    completed = true;
  } finally {
    await cleanupGraphFixture(root, completed);
  }
});

test('graph builder material is semantic across roots while final material binds its selected seal', async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), 'qdroid-executable-graph-semantic-first-'));
  const secondRoot = await mkdtemp(join(tmpdir(), 'qdroid-executable-graph-semantic-second-'));
  let firstCompleted = false;
  let secondCompleted = false;
  const child = createGraphBundle({ build: true, name: 'qdroid/child' });
  const rootBundle = createGraphBundle({
    dependencies: [{ name: 'qdroid/child', sourceId: 'catalog/child', version: '1.0.0' }],
    executable: true,
    name: 'qdroid/root',
  });
  const materialDigests: Array<{ purpose: 'builder' | 'runtime'; root: string; value: string }> =
    [];
  const createInstaller = (root: string): PackageInstaller => {
    let imageNumber = 0;
    return new PackageInstaller({
      installerRoot: root,
      ownerId: 'operator-example',
      runtimeCatalog: new Map([[catalog.id, catalog]]),
      runtimeFactory: graphRuntimeFactory(
        {
          managesResources: true,
          execute: async () =>
            completedExecution(
              createUstar([{ body: 'deterministic', path: 'generated/result.txt' }]),
            ),
        },
        {
          assemble: async () => {
            imageNumber += 1;
            return {
              cleanupConfirmed: true,
              imageId: `sha256:${String(imageNumber).padStart(64, '0')}`,
              receipt: {},
            };
          },
          verifySealed: async () => undefined,
        },
        () => undefined,
        true,
        (request, materialDigest) => {
          materialDigests.push({ purpose: request.purpose, root, value: materialDigest });
        },
      ),
      sources: new Map([
        ['catalog/root', graphSource('catalog/root', rootBundle, new Map())],
        ['catalog/child', graphSource('catalog/child', child, new Map())],
      ]),
      supportedEngineVersion: '0.1.0',
    });
  };

  try {
    await createInstaller(firstRoot).install({ sourceId: 'catalog/root', target: 'linux/arm64' });
    await createInstaller(secondRoot).install({ sourceId: 'catalog/root', target: 'linux/arm64' });

    const builders = materialDigests.filter((entry) => entry.purpose === 'builder');
    const runtimes = materialDigests.filter((entry) => entry.purpose === 'runtime');
    assert.equal(builders.length, 2);
    assert.equal(runtimes.length, 2);
    assert.equal(builders[0]?.value, builders[1]?.value);
    assert.notEqual(runtimes[0]?.value, runtimes[1]?.value);
    firstCompleted = true;
    secondCompleted = true;
  } finally {
    await cleanupGraphFixture(secondRoot, secondCompleted);
    await cleanupGraphFixture(firstRoot, firstCompleted);
  }
});

test('concurrent identical graph candidates return the original published winner and its sealed closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-executable-graph-winner-'));
  let completed = false;
  let firstInstallation: Promise<InstallResult> | undefined;
  const firstAuthorityClosed = deferred<void>();
  const releaseFirstAuthority = deferred<void>();
  const child = createGraphBundle({ build: true, name: 'qdroid/child' });
  const rootBundle = createGraphBundle({
    dependencies: [{ name: 'qdroid/child', sourceId: 'catalog/child', version: '1.0.0' }],
    executable: true,
    name: 'qdroid/root',
  });
  const firstOwners: BuildSessionOwner[] = [];
  const secondOwners: BuildSessionOwner[] = [];
  const firstPreparedAssemblies: GraphPreparedAssemblyObservation[] = [];
  const secondPreparedAssemblies: GraphPreparedAssemblyObservation[] = [];
  const buildAuthorityPath = join(root, 'build-authority', 'authority.sqlite');
  let firstAuthorityPauseCount = 0;
  const firstInstaller = createWinnerRaceInstaller({
    buildOutputBody: 'identical-output',
    child,
    imageHex: 'a',
    owners: firstOwners,
    preparedAssemblies: firstPreparedAssemblies,
    publicationTestHooks: {
      afterAuthorityDatabaseClose: async (path) => {
        if (path !== buildAuthorityPath) {
          return;
        }
        firstAuthorityPauseCount += 1;
        firstAuthorityClosed.resolve();
        await releaseFirstAuthority.promise;
      },
    },
    root,
    rootBundle,
  });
  const secondInstaller = createWinnerRaceInstaller({
    buildOutputBody: 'identical-output',
    child,
    imageHex: 'b',
    owners: secondOwners,
    preparedAssemblies: secondPreparedAssemblies,
    root,
    rootBundle,
  });

  try {
    firstInstallation = firstInstaller.install({ sourceId: 'catalog/root', target: 'linux/arm64' });
    void firstInstallation.catch(() => undefined);
    await awaitWithin(
      firstAuthorityClosed.promise,
      4_000,
      'first graph candidate build-authority database close',
    );
    assert.equal(firstAuthorityPauseCount, 1);
    await assertNoPublishedGraphRecords(root);

    const originalWinner = await awaitWithin(
      secondInstaller.install({ sourceId: 'catalog/root', target: 'linux/arm64' }),
      4_000,
      'second graph candidate publication',
    );
    assert.equal(originalWinner.reusedExisting, false);
    assert.equal(secondOwners.length, 1);
    await assertGraphWinnerArtifacts({
      buildOutputBody: 'identical-output',
      child,
      imageHex: 'b',
      preparedAssemblies: secondPreparedAssemblies,
      record: originalWinner.record,
      root,
      rootBundle,
    });

    releaseFirstAuthority.resolve();
    const firstResult = await awaitWithin(
      firstInstallation,
      4_000,
      'first graph candidate publication after winner commit',
    );
    assert.equal(firstResult.reusedExisting, true);
    assert.deepEqual(firstResult.record, originalWinner.record);
    assert.equal(firstOwners.length, 1);
    await assertGraphWinnerArtifacts({
      buildOutputBody: 'identical-output',
      child,
      imageHex: 'b',
      preparedAssemblies: secondPreparedAssemblies,
      record: firstResult.record,
      root,
      rootBundle,
    });
    assert.equal(firstPreparedAssemblies.length, 2);
    completed = true;
  } finally {
    releaseFirstAuthority.resolve();
    const responsibilitySettled = await settleGraphInstallation(
      firstInstallation,
      'first identical graph candidate settlement',
    );
    await cleanupGraphFixture(root, completed, responsibilitySettled);
  }
});

test('a conflicting graph candidate preserves the original winner record and sealed closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-executable-graph-conflict-'));
  let completed = false;
  let firstInstallation: Promise<InstallResult> | undefined;
  const firstAuthorityClosed = deferred<void>();
  const releaseFirstAuthority = deferred<void>();
  const child = createGraphBundle({ build: true, name: 'qdroid/child' });
  const rootBundle = createGraphBundle({
    dependencies: [{ name: 'qdroid/child', sourceId: 'catalog/child', version: '1.0.0' }],
    executable: true,
    name: 'qdroid/root',
  });
  const firstOwners: BuildSessionOwner[] = [];
  const secondOwners: BuildSessionOwner[] = [];
  const firstPreparedAssemblies: GraphPreparedAssemblyObservation[] = [];
  const secondPreparedAssemblies: GraphPreparedAssemblyObservation[] = [];
  const buildAuthorityPath = join(root, 'build-authority', 'authority.sqlite');
  let firstAuthorityPauseCount = 0;
  const firstInstaller = createWinnerRaceInstaller({
    buildOutputBody: 'first-output',
    child,
    imageHex: 'c',
    owners: firstOwners,
    preparedAssemblies: firstPreparedAssemblies,
    publicationTestHooks: {
      afterAuthorityDatabaseClose: async (path) => {
        if (path !== buildAuthorityPath) {
          return;
        }
        firstAuthorityPauseCount += 1;
        firstAuthorityClosed.resolve();
        await releaseFirstAuthority.promise;
      },
    },
    root,
    rootBundle,
  });
  const secondInstaller = createWinnerRaceInstaller({
    buildOutputBody: 'second-output',
    child,
    imageHex: 'd',
    owners: secondOwners,
    preparedAssemblies: secondPreparedAssemblies,
    root,
    rootBundle,
  });

  try {
    firstInstallation = firstInstaller.install({ sourceId: 'catalog/root', target: 'linux/arm64' });
    void firstInstallation.catch(() => undefined);
    await awaitWithin(
      firstAuthorityClosed.promise,
      4_000,
      'first conflicting graph candidate build-authority database close',
    );
    assert.equal(firstAuthorityPauseCount, 1);
    await assertNoPublishedGraphRecords(root);

    const originalWinner = await awaitWithin(
      secondInstaller.install({ sourceId: 'catalog/root', target: 'linux/arm64' }),
      4_000,
      'second conflicting graph candidate publication',
    );
    assert.equal(originalWinner.reusedExisting, false);
    assert.equal(secondOwners.length, 1);
    await assertGraphWinnerArtifacts({
      buildOutputBody: 'second-output',
      child,
      imageHex: 'd',
      preparedAssemblies: secondPreparedAssemblies,
      record: originalWinner.record,
      root,
      rootBundle,
    });

    releaseFirstAuthority.resolve();
    await assert.rejects(
      awaitWithin(
        firstInstallation,
        4_000,
        'first conflicting graph candidate publication after winner commit',
      ),
      /immutable installation version conflicts with an existing disabled record/,
    );
    assert.equal(firstOwners.length, 1);
    assert.equal(firstPreparedAssemblies.length, 2);
    await assertGraphWinnerArtifacts({
      buildOutputBody: 'second-output',
      child,
      imageHex: 'd',
      preparedAssemblies: secondPreparedAssemblies,
      record: originalWinner.record,
      root,
      rootBundle,
    });
    completed = true;
  } finally {
    releaseFirstAuthority.resolve();
    const responsibilitySettled = await settleGraphInstallation(
      firstInstallation,
      'first conflicting graph candidate settlement',
    );
    await cleanupGraphFixture(root, completed, responsibilitySettled);
  }
});

test('an unknown graph-member cleanup blocks successors and preserves its retained evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-executable-graph-cleanup-unknown-'));
  let completed = false;
  const first = createGraphBundle({ build: true, name: 'qdroid/first' });
  const second = createGraphBundle({
    build: true,
    dependencies: [{ name: 'qdroid/first', sourceId: 'catalog/first', version: '1.0.0' }],
    name: 'qdroid/second',
  });
  const rootBundle = createGraphBundle({
    dependencies: [{ name: 'qdroid/second', sourceId: 'catalog/second', version: '1.0.0' }],
    executable: true,
    name: 'qdroid/root',
  });
  let assemblies = 0;
  let executions = 0;
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([[catalog.id, catalog]]),
    runtimeFactory: graphRuntimeFactory(
      {
        managesResources: true,
        execute: async () => {
          executions += 1;
          return {
            completion: Promise.resolve({
              cleanupConfirmed: false,
              exitCode: 0,
              reason: 'completed',
            }),
            stderr: chunks([]),
            stdout: chunks([createUstar([{ body: 'first', path: 'generated/result.txt' }])]),
          };
        },
      },
      {
        assemble: async () => {
          assemblies += 1;
          return { cleanupConfirmed: true, imageId: `sha256:${'1'.repeat(64)}`, receipt: {} };
        },
        verifySealed: async () => undefined,
      },
      () => undefined,
    ),
    sources: new Map([
      ['catalog/root', graphSource('catalog/root', rootBundle, new Map())],
      ['catalog/first', graphSource('catalog/first', first, new Map())],
      ['catalog/second', graphSource('catalog/second', second, new Map())],
    ]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: 'catalog/root', target: 'linux/arm64' }),
      /offline package build cleanup was not confirmed/,
    );
    await assert.rejects(
      installer.install({ sourceId: 'catalog/root', target: 'linux/arm64' }),
      /synthetic-unverified build-session intent cannot authorize fresh recovery/,
    );
    assert.equal(executions, 1);
    assert.equal(assemblies, 1);

    const registry = new DatabaseSync(join(root, 'registry', 'registry.sqlite'));
    try {
      const row = registry
        .prepare('SELECT COUNT(*) AS count FROM package_versions')
        .get() as unknown as { count: number };
      assert.equal(row.count, 0);
    } finally {
      registry.close();
    }
    completed = true;
  } finally {
    await cleanupGraphFixture(root, completed, false);
  }
});

test('corrupt retained graph output rejects reuse without rebuilding a child or final image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-executable-graph-corrupt-'));
  let completed = false;
  const child = createGraphBundle({ build: true, name: 'qdroid/child' });
  const rootBundle = createGraphBundle({
    dependencies: [{ name: 'qdroid/child', sourceId: 'catalog/child', version: '1.0.0' }],
    executable: true,
    name: 'qdroid/root',
  });
  let executions = 0;
  let assemblies = 0;
  const executor: TrustedBuildExecutor = {
    managesResources: true,
    execute: async () => {
      executions += 1;
      return completedExecution(createUstar([{ body: 'original', path: 'generated/result.txt' }]));
    },
  };
  const assembler: TrustedImageAssembler = {
    assemble: async () => {
      assemblies += 1;
      return {
        cleanupConfirmed: true,
        imageId: `sha256:${String(assemblies).padStart(64, '0')}`,
        receipt: {},
      };
    },
    verifySealed: async () => undefined,
  };
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([[catalog.id, catalog]]),
    runtimeFactory: graphRuntimeFactory(executor, assembler, () => undefined),
    sources: new Map([
      ['catalog/root', graphSource('catalog/root', rootBundle, new Map())],
      ['catalog/child', graphSource('catalog/child', child, new Map())],
    ]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const first = await installer.install({ sourceId: 'catalog/root', target: 'linux/arm64' });
    const material = JSON.parse(await readFile(first.record.graphMaterialPath!, 'utf8')) as {
      nodes: readonly { generatedDirectory: string | null; packageDigest: string }[];
    };
    const childNode = material.nodes.find(
      (node) => node.packageDigest !== first.record.packageDigest,
    );
    assert.ok(childNode !== undefined && childNode.generatedDirectory !== null);
    const generatedPath = join(childNode.generatedDirectory, 'result.txt');
    await chmod(generatedPath, 0o600);
    await writeFile(generatedPath, 'corrupt');
    await chmod(generatedPath, 0o444);

    await assert.rejects(
      installer.install({ sourceId: 'catalog/root', target: 'linux/arm64' }),
      /sealed generated file does not match its inventory/,
    );
    assert.equal(executions, 1);
    assert.equal(assemblies, 2);
    completed = true;
  } finally {
    await cleanupGraphFixture(root, completed);
  }
});

test('a missing graph image receipt rejects reuse without repairing or rebuilding it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-executable-graph-missing-receipt-'));
  let completed = false;
  const bundle = createGraphBundle({ executable: true, name: 'qdroid/root' });
  let assemblies = 0;
  const assembler: TrustedImageAssembler = {
    assemble: async () => {
      assemblies += 1;
      return {
        cleanupConfirmed: true,
        imageId: `sha256:${String(assemblies).padStart(64, '0')}`,
        receipt: {},
      };
    },
    verifySealed: async () => undefined,
  };
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([[catalog.id, catalog]]),
    runtimeFactory: graphRuntimeFactory(noOpExecutor(), assembler, () => undefined),
    sources: new Map([['catalog/root', graphSource('catalog/root', bundle, new Map())]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const first = await installer.install({ sourceId: 'catalog/root', target: 'linux/arm64' });
    assert.notEqual(first.record.runtimeReceiptPath, null);
    await chmod(dirname(first.record.runtimeReceiptPath!), 0o700);
    await rm(first.record.runtimeReceiptPath!);

    await assert.rejects(
      installer.install({ sourceId: 'catalog/root', target: 'linux/arm64' }),
      /image receipt is missing/,
    );
    assert.equal(assemblies, 1, 'reuse must never rebuild a missing sealed image');
    completed = true;
  } finally {
    await cleanupGraphFixture(root, completed, false);
  }
});

test('a failed graph member blocks dependent builds, final assembly, and disabled publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-executable-graph-failure-'));
  let completed = false;
  const left = createGraphBundle({ build: true, name: 'qdroid/left' });
  const right = createGraphBundle({ build: true, name: 'qdroid/right' });
  const rootBundle = createGraphBundle({
    dependencies: [
      { name: 'qdroid/left', sourceId: 'catalog/left', version: '1.0.0' },
      { name: 'qdroid/right', sourceId: 'catalog/right', version: '1.0.0' },
    ],
    executable: true,
    name: 'qdroid/root',
  });
  let executions = 0;
  let assemblies = 0;
  const executor: TrustedBuildExecutor = {
    managesResources: true,
    execute: async () => {
      executions += 1;
      return {
        completion: Promise.resolve({ cleanupConfirmed: true, exitCode: 1, reason: 'completed' }),
        stderr: chunks([]),
        stdout: chunks([]),
      };
    },
  };
  const assembler: TrustedImageAssembler = {
    assemble: async () => {
      assemblies += 1;
      return { cleanupConfirmed: true, imageId: `sha256:${'1'.repeat(64)}`, receipt: {} };
    },
    verifySealed: async () => undefined,
  };
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([[catalog.id, catalog]]),
    runtimeFactory: graphRuntimeFactory(executor, assembler, () => undefined),
    sources: new Map([
      ['catalog/root', graphSource('catalog/root', rootBundle, new Map())],
      ['catalog/left', graphSource('catalog/left', left, new Map())],
      ['catalog/right', graphSource('catalog/right', right, new Map())],
    ]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: 'catalog/root', target: 'linux/arm64' }),
      /offline package build did not exit zero/,
    );
    assert.equal(executions, 1);
    assert.equal(assemblies, 1, 'the first member builder is the only native assembly effect');

    const registry = new DatabaseSync(join(root, 'registry', 'registry.sqlite'));
    try {
      const row = registry
        .prepare('SELECT COUNT(*) AS count FROM package_versions')
        .get() as unknown as { count: number };
      assert.equal(row.count, 0);
    } finally {
      registry.close();
    }
    completed = true;
  } finally {
    await cleanupGraphFixture(root, completed);
  }
});

interface GraphPreparedAssemblyObservation {
  readonly candidateId: string;
  readonly materialDigest: string;
  readonly packageDigest: string;
  readonly purpose: 'builder' | 'runtime';
}

interface WinnerRaceInstallerInput {
  readonly buildOutputBody: string;
  readonly child: Buffer;
  readonly imageHex: string;
  readonly owners: BuildSessionOwner[];
  readonly preparedAssemblies: GraphPreparedAssemblyObservation[];
  readonly publicationTestHooks?: PackageInstallerPublicationTestHooks;
  readonly root: string;
  readonly rootBundle: Buffer;
}

interface GraphWinnerArtifactInput {
  readonly buildOutputBody: string;
  readonly child: Buffer;
  readonly imageHex: string;
  readonly preparedAssemblies: readonly GraphPreparedAssemblyObservation[];
  readonly record: DisabledInstallationRecord;
  readonly root: string;
  readonly rootBundle: Buffer;
}

function createWinnerRaceInstaller(input: WinnerRaceInstallerInput): PackageInstaller {
  let imageNumber = 0;
  return new PackageInstaller({
    installerRoot: input.root,
    ownerId: 'operator-example',
    ...(input.publicationTestHooks === undefined
      ? {}
      : { publicationTestHooks: input.publicationTestHooks }),
    runtimeCatalog: new Map([[catalog.id, catalog]]),
    runtimeFactory: graphRuntimeFactory(
      {
        managesResources: true,
        execute: async () =>
          completedExecution(
            createUstar([{ body: input.buildOutputBody, path: 'generated/result.txt' }]),
          ),
      },
      {
        assemble: async () => {
          imageNumber += 1;
          return {
            cleanupConfirmed: true,
            imageId: graphImageId(input.imageHex, imageNumber),
            receipt: {},
          };
        },
        verifySealed: async () => undefined,
      },
      (owner) => input.owners.push(owner),
      true,
      (request, materialDigest) => {
        input.preparedAssemblies.push({
          candidateId: request.candidateId,
          materialDigest,
          packageDigest: request.packageDigest,
          purpose: request.purpose,
        });
      },
    ),
    sources: new Map([
      ['catalog/root', graphSource('catalog/root', input.rootBundle, new Map())],
      ['catalog/child', graphSource('catalog/child', input.child, new Map())],
    ]),
    supportedEngineVersion: '0.1.0',
  });
}

async function assertNoPublishedGraphRecords(root: string): Promise<void> {
  const registry = new DatabaseSync(join(root, 'registry', 'registry.sqlite'));
  try {
    const rows = registry.prepare('SELECT package_name FROM package_versions').all();
    assert.deepEqual(rows, []);
  } finally {
    registry.close();
  }
}

async function assertGraphWinnerArtifacts(input: GraphWinnerArtifactInput): Promise<void> {
  const graphMaterialPath = requireRetainedGraphPath(
    input.record.graphMaterialPath,
    'graph material',
  );
  const resolvedLockPath = requireRetainedGraphPath(input.record.resolvedLockPath, 'resolved lock');
  const runtimeReceiptPath = requireRetainedGraphPath(
    input.record.runtimeReceiptPath,
    'runtime receipt',
  );
  const imageId = requireRetainedGraphPath(input.record.imageId, 'runtime image');
  const graphMaterial = await readGraphWinnerMaterial(graphMaterialPath);
  const candidateId = graphMaterial.candidateId;
  const childPackageDigest = inventoryDigest(readFrozenBundle(input.child).entries);
  const rootPackageDigest = inventoryDigest(readFrozenBundle(input.rootBundle).entries);
  const preparedAssemblies = input.preparedAssemblies.filter(
    (entry) => entry.candidateId === candidateId,
  );
  const builder = requireGraphValue(
    preparedAssemblies.find(
      (entry) => entry.packageDigest === childPackageDigest && entry.purpose === 'builder',
    ),
    'prepared child builder material',
  );
  const runtime = requireGraphValue(
    preparedAssemblies.find(
      (entry) => entry.packageDigest === rootPackageDigest && entry.purpose === 'runtime',
    ),
    'prepared root runtime material',
  );

  assert.equal(preparedAssemblies.length, 2);
  assert.equal(input.record.graphMaterialDigest, sha256(await readFile(graphMaterialPath)));
  assert.equal(graphMaterialPath, join(input.root, 'seals', candidateId, 'graph-material.json'));
  assert.equal(resolvedLockPath, join(input.root, 'seals', candidateId, 'resolved-lock.json'));
  assert.equal(
    runtimeReceiptPath,
    join(input.root, 'seals', candidateId, 'runtime-image-receipt.json'),
  );
  assert.equal(imageId, graphImageId(input.imageHex, 2));
  assert.equal(input.record.builderImageId, null);
  assert.equal(input.record.builderReceiptPath, null);
  assert.equal(input.record.generatedDirectory, null);
  assert.equal(input.record.generatedInventoryPath, null);
  assert.equal(graphMaterial.execution.graphBuildInputDigest, input.record.buildInputDigest);
  assert.equal(graphMaterial.execution.graphBuildOutputDigest, input.record.buildOutputDigest);
  assert.equal(graphMaterial.execution.resolvedLockDigest, input.record.resolvedLockDigest);

  const childNode = requireGraphValue(
    graphMaterial.nodes.find((node) => node.packageDigest === childPackageDigest),
    'retained child graph member',
  );
  const rootNode = requireGraphValue(
    graphMaterial.nodes.find((node) => node.packageDigest === rootPackageDigest),
    'retained root graph member',
  );
  assert.equal(graphMaterial.nodes.length, 2);
  assert.equal(childNode.generatedOutputDigest, graphGeneratedOutputDigest(input.buildOutputBody));
  assert.equal(childNode.nodeBuilderImageId, graphImageId(input.imageHex, 1));
  assert.equal(
    childNode.nodeBuilderReceiptPath,
    join(
      input.root,
      'seals',
      candidateId,
      'nodes',
      childPackageDigest,
      'builder-image-receipt.json',
    ),
  );
  assert.equal(
    childNode.generatedDirectory,
    join(
      input.root,
      'generated',
      'graphs',
      candidateId,
      'nodes',
      childPackageDigest,
      childNode.generatedOutputDigest,
    ),
  );
  assert.equal(childNode.generatedInventoryPath, `${childNode.generatedDirectory}.inventory.json`);
  assert.equal(
    await readFile(join(childNode.generatedDirectory, 'result.txt'), 'utf8'),
    input.buildOutputBody,
  );
  assert.equal(rootNode.generatedDirectory, null);
  assert.equal(rootNode.generatedInventoryPath, null);
  assert.equal(rootNode.generatedOutputDigest, null);
  assert.equal(rootNode.nodeBuilderImageId, null);
  assert.equal(rootNode.nodeBuilderReceiptPath, null);

  await assertGraphWinnerReceipt(
    requireRetainedGraphPath(childNode.nodeBuilderReceiptPath, 'child builder receipt'),
    builder,
    graphImageId(input.imageHex, 1),
  );
  await assertGraphWinnerReceipt(runtimeReceiptPath, runtime, imageId);

  const resolvedLock = await readGraphWinnerJson(resolvedLockPath);
  assert.deepEqual(resolvedLock, {
    candidateId,
    graphDigest: graphMaterial.graphDigest,
    resolvedLockDigest: input.record.resolvedLockDigest,
    schema: 'qdroid.executable-graph-resolved-lock/v1',
  });
}

async function assertGraphWinnerReceipt(
  path: string,
  observation: GraphPreparedAssemblyObservation | undefined,
  imageId: string,
): Promise<void> {
  const sealedObservation = requireGraphValue(observation, 'prepared sealed image material');
  assert.deepEqual(await readGraphWinnerJson(path), {
    candidateId: sealedObservation.candidateId,
    imageId,
    packageDigest: sealedObservation.packageDigest,
    purpose: sealedObservation.purpose,
    receipt: fixedCopyReceipt(sealedObservation),
    schema: 'qdroid.image-receipt/v1',
  });
}

function graphGeneratedOutputDigest(buildOutputBody: string): string {
  return inventoryDigest(
    readFrozenUstar(createUstar([{ body: buildOutputBody, path: 'generated/result.txt' }]), {
      requirePackageMetadata: false,
    }).entries,
  );
}

function graphImageId(imageHex: string, number: number): string {
  if (!/^[a-f]$/.test(imageHex) || number < 1 || number > 15) {
    throw new Error('The graph image fixture identity is invalid.');
  }
  return `sha256:${imageHex.repeat(63)}${number.toString(16)}`;
}

function requireRetainedGraphPath(value: string | null, description: string): string {
  if (value === null) {
    throw new Error(`The retained ${description} must be present.`);
  }
  return value;
}

function requireGraphValue<T>(value: T | undefined, description: string): T {
  if (value === undefined) {
    throw new Error(`The ${description} must be present.`);
  }
  return value;
}

async function readGraphWinnerMaterial(path: string): Promise<{
  readonly candidateId: string;
  readonly execution: {
    readonly graphBuildInputDigest: string;
    readonly graphBuildOutputDigest: string;
    readonly resolvedLockDigest: string;
  };
  readonly graphDigest: string;
  readonly nodes: readonly {
    readonly generatedDirectory: string | null;
    readonly generatedInventoryPath: string | null;
    readonly generatedOutputDigest: string | null;
    readonly nodeBuilderImageId: string | null;
    readonly nodeBuilderReceiptPath: string | null;
    readonly packageDigest: string;
  }[];
}> {
  const parsed = await readGraphWinnerJson(path);
  return parsed as {
    readonly candidateId: string;
    readonly execution: {
      readonly graphBuildInputDigest: string;
      readonly graphBuildOutputDigest: string;
      readonly resolvedLockDigest: string;
    };
    readonly graphDigest: string;
    readonly nodes: readonly {
      readonly generatedDirectory: string | null;
      readonly generatedInventoryPath: string | null;
      readonly generatedOutputDigest: string | null;
      readonly nodeBuilderImageId: string | null;
      readonly nodeBuilderReceiptPath: string | null;
      readonly packageDigest: string;
    }[];
  };
}

async function readGraphWinnerJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function settleGraphInstallation(
  installation: Promise<unknown> | undefined,
  description: string,
): Promise<boolean> {
  if (installation === undefined) {
    return true;
  }
  try {
    await awaitWithin(Promise.allSettled([installation]), 4_000, description);
    return true;
  } catch (error) {
    console.error(
      `Retaining executable-graph fixture after an unsettled installation: ${description}`,
    );
    console.error(error);
    return false;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve(value: T): void {
      resolve?.(value);
    },
  };
}

async function awaitWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${description} after ${timeoutMs} ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function createGraphBundle(options: {
  readonly build?: boolean;
  readonly dependencies?: readonly { name: string; sourceId: string; version: string }[];
  readonly executable?: boolean;
  readonly name: string;
}): Buffer {
  const dependencies = [...(options.dependencies ?? [])].sort(compareDependencies);
  const executable = options.executable === true || options.build === true;
  const manifest = JSON.stringify({
    assets: [],
    ...(options.build
      ? {
          build: {
            argv: ['/opt/qdroid/build'],
            cwd: '.',
            exports: ['generated/result.txt'],
            schema: 'qdroid.build/stdout-ustar-v1',
          },
        }
      : {}),
    dependencies,
    engineCompatibility: '>=0.1.0 <0.2.0',
    ...(executable
      ? { entrypoint: { executable: '/opt/qdroid/entrypoint', type: 'command' } }
      : {}),
    kind: executable ? 'tool' : 'application',
    license: 'Apache-2.0',
    name: options.name,
    requestedCapabilities: [],
    requestedResources: {
      deadlineMs: 30_000,
      memoryMiB: 256,
      outputBytes: 1_048_576,
      pids: 32,
      scratchMiB: 64,
    },
    runtimeVariants: executable
      ? [
          {
            abi: catalog.abi,
            baseCatalogId: catalog.id,
            image: catalog.baseImage,
            platform: catalog.platform,
            requiredFeatures: [],
            requiredProfile: catalog.profile,
          },
        ]
      : [],
    scenes: [],
    schema: 'qdroid.plugin/v0.2',
    skills: [],
    version: '1.0.0',
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
      body: JSON.stringify({
        dependencies,
        inputContentDigest,
        schema: 'qdroid.lock/v0.2',
      }),
      path: 'qdroid.lock.json',
    },
  ]);
}

function graphSource(id: string, bytes: Buffer, reads: Map<string, number>): PackageSource {
  return {
    expectedSha256: sha256(bytes),
    id,
    maxBytes: bytes.byteLength,
    read: async (request) => {
      assert.ok(request !== undefined);
      assert.equal(request.signal.aborted, false);
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return Buffer.from(bytes);
    },
  };
}

function graphRuntimeFactory(
  executor: TrustedBuildExecutor,
  assembler: TrustedImageAssembler,
  onCreate: (owner: BuildSessionOwner) => void,
  verifyOpaqueGraphMaterial = false,
  onPreparedAssembly?: (request: ImageAssemblyRequest, materialDigest: string) => void,
): TrustedRuntimeFactory {
  return {
    create: async (owner) => {
      onCreate(owner);
      if (!verifyOpaqueGraphMaterial) {
        return { buildExecutor: executor, close: async () => undefined, imageAssembler: assembler };
      }
      return {
        buildExecutor: executor,
        close: async () => undefined,
        imageAssembler: {
          assemble: async (request) => {
            const input = preparedAssemblyInputFor(owner, request);
            const material = await assertPreparedAssemblyMaterial(owner, input);
            assert.strictEqual(readPreparedAssemblyInput(owner, input), material);
            assert.ok(material.graph !== undefined);
            onPreparedAssembly?.(request, material.materialDigest);
            assert.throws(
              () => preparedAssemblyInputFor(owner, { ...request }),
              /not registered for this BuildSession owner/,
            );
            assert.throws(() => preparedAssemblyInputFor(owner, request), /already been claimed/);
            const assembled = await assembler.assemble(request);
            return Object.freeze({
              ...assembled,
              receipt: fixedCopyReceipt(material),
            });
          },
          verifySealed: async (request) => {
            const verification = preparedSealedImageVerificationFor(owner, request);
            const material = readPreparedSealedImageVerification(owner, verification);
            assert.ok(material.graph !== undefined);
            assert.deepEqual(request.receipt, fixedCopyReceipt(material));
            assert.throws(
              () => preparedSealedImageVerificationFor(owner, { ...request }),
              /not registered for this BuildSession owner/,
            );
            assert.throws(
              () => preparedSealedImageVerificationFor(owner, request),
              /already been claimed/,
            );
            await assembler.verifySealed(request);
          },
        },
      };
    },
    supportsGraphMaterialV1: true,
  };
}

function fixedCopyReceipt(
  material: Readonly<{
    candidateId: string;
    materialDigest: string;
    packageDigest: string;
    purpose: 'builder' | 'runtime';
  }>,
): Readonly<Record<string, string>> {
  return Object.freeze({
    assembler: 'qdroid.fixed-copy-commit/v2',
    candidateId: material.candidateId,
    materialDigest: material.materialDigest,
    packageDigest: material.packageDigest,
    purpose: material.purpose,
  });
}

function completedExecution(output: Uint8Array): {
  completion: Promise<{ cleanupConfirmed: true; exitCode: 0; reason: 'completed' }>;
  stderr: AsyncIterable<Uint8Array>;
  stdout: AsyncIterable<Uint8Array>;
} {
  return {
    completion: Promise.resolve({ cleanupConfirmed: true, exitCode: 0, reason: 'completed' }),
    stderr: chunks([]),
    stdout: chunks([output]),
  };
}

function noOpExecutor(): TrustedBuildExecutor {
  return {
    managesResources: true,
    execute: async () => {
      throw new Error('A no-build graph member must not execute a build.');
    },
  };
}

function compareDependencies(
  left: Readonly<{ name: string; version: string }>,
  right: Readonly<{ name: string; version: string }>,
): number {
  return left.name.localeCompare(right.name) || left.version.localeCompare(right.version);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function removeFixtureRoot(path: string): Promise<void> {
  await makeFixtureTreeWritable(path);
  await rm(path, { force: true, maxRetries: 3, recursive: true, retryDelay: 25 });
}

async function cleanupGraphFixture(
  root: string,
  completed: boolean,
  responsibilitySettled = true,
): Promise<void> {
  if (!completed || !responsibilitySettled) {
    console.error(
      `Retaining executable-graph fixture after an unexpected or unsettled outcome: ${root}`,
    );
    return;
  }
  await removeFixtureRoot(root);
}

async function makeFixtureTreeWritable(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) {
    return;
  }
  await chmod(path, 0o700);
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await makeFixtureTreeWritable(child);
    } else {
      await chmod(child, 0o600);
    }
  }
}

async function* chunks(values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield value;
  }
}

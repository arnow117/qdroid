import assert from 'node:assert/strict';
import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import { readFrozenBundle } from '../../../packages/package-runtime/src/archive.js';
import {
  inventoryDigest,
  PackageInstaller,
  preparedAssemblyInputFor,
  readPreparedAssemblyInput,
  type BuildSessionOwner,
  type ImageAssemblyRequest,
  type InstallResult,
  type TrustedBuildExecutor,
  type TrustedImageAssembler,
  type TrustedRuntimeFactory,
  type TrustedImageCatalogEntry,
  type PackageSource,
} from '../../../packages/package-runtime/src/index.js';
import { createUstarFixture as createUstar } from '../../../fixtures/packages/src/ustar-fixture.js';

const execFile = promisify(execFileCallback);

test('content-only installation freezes nested Skill bytes and returns the same disabled record on retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-'));
  const outsideCanary = join(root, '..', `${root.split('/').pop()!}-outside-canary`);
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/example-v1',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const first = await installer.install({ sourceId: source.id, target: 'content-only' });
    const second = await installer.install({ sourceId: source.id, target: 'content-only' });

    assert.equal(first.reusedExisting, false);
    assert.equal(second.reusedExisting, true);
    assert.deepEqual(second.record, first.record);
    assert.equal(first.record.status, 'installed-disabled');
    assert.equal(first.record.imageId, null);
    assert.equal(first.record.buildInputDigest, null);
    assert.equal(
      await readFile(join(first.record.contentDirectory, 'assets', 'notice.txt'), 'utf8'),
      'frozen',
    );
    assert.equal(
      await readFile(join(first.record.contentDirectory, 'skills', 'example', 'SKILL.md'), 'utf8'),
      '# Example\n',
    );
    await assert.rejects(readFile(outsideCanary, 'utf8'));
  } finally {
    await removeFixtureRoot(root);
  }
});

test('content-only installation rejects build declarations before staging or runtime effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-content-build-'));
  const bundle = createPackageBundle({
    build: {
      argv: ['/usr/bin/node', '/opt/build.js'],
      cwd: '.',
      exports: ['generated/result.txt'],
      schema: 'qdroid.build/stdout-ustar-v1',
    },
  });
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/content-build',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  let runtimeFactoryCalls = 0;
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    runtimeFactory: {
      create: async () => {
        runtimeFactoryCalls += 1;
        throw new Error('The content-only target must not create a runtime.');
      },
    },
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'content-only' }),
      /content-only target/,
    );
    assert.equal(runtimeFactoryCalls, 0);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('manifest versions reject aliases and preserve canonical prerelease build metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-semver-'));
  const canonicalVersion = '0.1.0';
  const canonicalBundle = createPackageBundle({ version: canonicalVersion });
  const metadataVersion = '0.1.0-rc.1+build.20261029';
  const metadataBundle = createPackageBundle({ version: metadataVersion });
  const aliases = ['v0.1.0', ' 0.1.0', '0.1.0 ', '01.0.0'];
  const sources = new Map<string, PackageSource>([
    [
      'catalog/canonical-version',
      {
        expectedSha256: sha256(canonicalBundle),
        id: 'catalog/canonical-version',
        maxBytes: canonicalBundle.byteLength,
        read: async () => Buffer.from(canonicalBundle),
      },
    ],
    [
      'catalog/metadata-version',
      {
        expectedSha256: sha256(metadataBundle),
        id: 'catalog/metadata-version',
        maxBytes: metadataBundle.byteLength,
        read: async () => Buffer.from(metadataBundle),
      },
    ],
    ...aliases.map((version) => {
      const bundle = createPackageBundle({ version });
      const id = `catalog/version-alias-${encodeURIComponent(version)}`;
      return [
        id,
        {
          expectedSha256: sha256(bundle),
          id,
          maxBytes: bundle.byteLength,
          read: async () => Buffer.from(bundle),
        },
      ] as const;
    }),
  ]);
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources,
    supportedEngineVersion: '0.1.0',
  });

  try {
    const canonical = await installer.install({
      sourceId: 'catalog/canonical-version',
      target: 'content-only',
    });
    assert.equal(canonical.record.version, canonicalVersion);

    for (const version of aliases) {
      await assert.rejects(
        installer.install({
          sourceId: `catalog/version-alias-${encodeURIComponent(version)}`,
          target: 'content-only',
        }),
        /canonical semantic version/,
        version,
      );
    }

    const reused = await installer.install({
      sourceId: 'catalog/canonical-version',
      target: 'content-only',
    });
    assert.equal(reused.reusedExisting, true);
    assert.deepEqual(reused.record, canonical.record);

    const metadata = await installer.install({
      sourceId: 'catalog/metadata-version',
      target: 'content-only',
    });
    assert.equal(metadata.record.version, metadataVersion);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a content-only v0.2 graph seals a shared diamond as one disabled root installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-diamond-'));
  const reads = new Map<string, number>();
  const leaf = createGraphPackageBundle({
    name: 'qdroid/leaf',
    version: '1.0.0',
  });
  const left = createGraphPackageBundle({
    dependencies: [{ name: 'qdroid/leaf', sourceId: 'catalog/leaf', version: '1.0.0' }],
    name: 'qdroid/left',
    version: '1.0.0',
  });
  const right = createGraphPackageBundle({
    dependencies: [{ name: 'qdroid/leaf', sourceId: 'catalog/leaf', version: '1.0.0' }],
    name: 'qdroid/right',
    version: '1.0.0',
  });
  const graphRoot = createGraphPackageBundle({
    dependencies: [
      { name: 'qdroid/right', sourceId: 'catalog/right', version: '1.0.0' },
      { name: 'qdroid/left', sourceId: 'catalog/left', version: '1.0.0' },
    ],
    name: 'qdroid/root',
    version: '1.0.0',
  });
  const sources = new Map<string, PackageSource>([
    ['catalog/root', graphSource('catalog/root', graphRoot, reads)],
    ['catalog/left', graphSource('catalog/left', left, reads)],
    ['catalog/right', graphSource('catalog/right', right, reads)],
    ['catalog/leaf', graphSource('catalog/leaf', leaf, reads)],
  ]);
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources,
    supportedEngineVersion: '0.1.0',
  });

  try {
    const first = await installer.install({ sourceId: 'catalog/root', target: 'content-only' });
    const second = await installer.install({ sourceId: 'catalog/root', target: 'content-only' });

    assert.equal(first.reusedExisting, false);
    assert.equal(second.reusedExisting, true);
    assert.deepEqual(second.record, first.record);
    assert.notEqual(first.record.graphMaterialPath, null);
    assert.notEqual(first.record.graphMaterialDigest, null);
    assert.equal(first.record.imageId, null);
    const graphMaterial = JSON.parse(await readFile(first.record.graphMaterialPath!, 'utf8')) as {
      readonly nodes: readonly unknown[];
      readonly schema: string;
    };
    assert.equal(graphMaterial.schema, 'qdroid.graph-material/v1');
    assert.equal(graphMaterial.nodes.length, 4);
    assert.deepEqual([...reads.entries()].sort(), [
      ['catalog/leaf', 2],
      ['catalog/left', 2],
      ['catalog/right', 2],
      ['catalog/root', 2],
    ]);
    const registry = new DatabaseSync(join(root, 'registry', 'registry.sqlite'));
    try {
      const rows = registry
        .prepare('SELECT package_name FROM package_versions')
        .all() as unknown as readonly {
        package_name: string;
      }[];
      assert.deepEqual(
        rows.map((row) => row.package_name),
        ['qdroid/root'],
      );
    } finally {
      registry.close();
    }
  } finally {
    await removeFixtureRoot(root);
  }
});

test('content-only graph reuse rejects corrupt retained member content without rebuilding it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-retained-content-'));
  const reads = new Map<string, number>();
  const leaf = createGraphPackageBundle({ name: 'qdroid/leaf', version: '1.0.0' });
  const graphRoot = createGraphPackageBundle({
    dependencies: [{ name: 'qdroid/leaf', sourceId: 'catalog/leaf', version: '1.0.0' }],
    name: 'qdroid/root',
    version: '1.0.0',
  });
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([
      ['catalog/root', graphSource('catalog/root', graphRoot, reads)],
      ['catalog/leaf', graphSource('catalog/leaf', leaf, reads)],
    ]),
    supportedEngineVersion: '0.1.0',
  });
  const leafDigest = inventoryDigest(readFrozenBundle(leaf).entries);
  const leafManifestPath = join(root, 'content', leafDigest, 'qdroid.plugin.json');

  try {
    const first = await installer.install({ sourceId: 'catalog/root', target: 'content-only' });
    await chmod(leafManifestPath, 0o600);
    await writeFile(leafManifestPath, '{"corrupt":true}');
    await chmod(leafManifestPath, 0o444);

    await assert.rejects(
      installer.install({ sourceId: 'catalog/root', target: 'content-only' }),
      /sealed content file does not match the frozen inventory/,
    );
    assert.equal(await readFile(leafManifestPath, 'utf8'), '{"corrupt":true}');
    assert.equal(first.record.packageName, 'qdroid/root');
    assert.deepEqual([...reads.entries()].sort(), [
      ['catalog/leaf', 2],
      ['catalog/root', 2],
    ]);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('concurrent content-only graph candidates publish one immutable disabled root record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-concurrent-'));
  const reads = new Map<string, number>();
  const leaf = createGraphPackageBundle({ name: 'qdroid/leaf', version: '1.0.0' });
  const graphRoot = createGraphPackageBundle({
    dependencies: [{ name: 'qdroid/leaf', sourceId: 'catalog/leaf', version: '1.0.0' }],
    name: 'qdroid/root',
    version: '1.0.0',
  });
  const sources = new Map<string, PackageSource>([
    ['catalog/root', graphSource('catalog/root', graphRoot, reads)],
    ['catalog/leaf', graphSource('catalog/leaf', leaf, reads)],
  ]);
  const createInstaller = (): PackageInstaller =>
    new PackageInstaller({
      installerRoot: root,
      ownerId: 'operator-example',
      runtimeCatalog: new Map(),
      sources,
      supportedEngineVersion: '0.1.0',
    });

  const rootDigest = inventoryDigest(readFrozenBundle(graphRoot).entries);
  const leafDigest = inventoryDigest(readFrozenBundle(leaf).entries);
  const startedAt = Date.now();
  const observations: Array<Readonly<Record<string, unknown>>> = [];
  const observeInstallation = (label: string): Promise<InstallResult> => {
    const startedInstallationAt = Date.now();
    const installation = createInstaller().install({
      sourceId: 'catalog/root',
      target: 'content-only',
    });
    const observed = installation.then(
      (result) => {
        observations.push(
          Object.freeze({
            elapsedMs: Date.now() - startedAt,
            outcome: 'fulfilled',
            record: result.record,
            reusedExisting: result.reusedExisting,
            startedAfterMs: startedInstallationAt - startedAt,
            worker: label,
          }),
        );
        return result;
      },
      (error) => {
        observations.push(
          Object.freeze({
            elapsedMs: Date.now() - startedAt,
            error: allErrorMessages(error),
            outcome: 'rejected',
            startedAfterMs: startedInstallationAt - startedAt,
            worker: label,
          }),
        );
        throw error;
      },
    );
    void observed.catch(() => undefined);
    return observed;
  };
  const firstInstallation = observeInstallation('first');
  const secondInstallation = observeInstallation('second');
  const settlement = Promise.allSettled([firstInstallation, secondInstallation]);
  let retainRoot = false;

  try {
    const results = await awaitConcurrentInstallSettlement(settlement, 10_000);
    const contentObservations = await describeConcurrentContentDestinations(root, [
      rootDigest,
      leafDigest,
    ]);
    t.diagnostic(
      `Concurrent content publication diagnosis: ${JSON.stringify({
        contentObservations,
        elapsedMs: Date.now() - startedAt,
        observations,
        results: results.map((result) =>
          result.status === 'fulfilled'
            ? { outcome: 'fulfilled', reusedExisting: result.value.reusedExisting }
            : { error: allErrorMessages(result.reason), outcome: 'rejected' },
        ),
        root,
      })}`,
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      retainRoot = true;
      throw new AggregateError(failures, 'Concurrent content publication failed.');
    }

    const firstResult = results[0];
    const secondResult = results[1];
    if (
      firstResult === undefined ||
      secondResult === undefined ||
      firstResult.status !== 'fulfilled' ||
      secondResult.status !== 'fulfilled'
    ) {
      throw new Error('The concurrent content publication did not settle successfully.');
    }
    const first = firstResult.value;
    const second = secondResult.value;
    assert.deepEqual(first.record, second.record);
    assert.deepEqual([first.reusedExisting, second.reusedExisting].sort(), [false, true]);

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
  } catch (error) {
    retainRoot = true;
    t.diagnostic(
      `Retaining concurrent content publication diagnosis root after failure: ${root}; ${allErrorMessages(error)}`,
    );
    throw error;
  } finally {
    if (!retainRoot) {
      await removeFixtureRoot(root);
    }
  }
});

test('content-only graph rejects a member build before staging or runtime creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-content-build-'));
  const reads = new Map<string, number>();
  const builtLeaf = createGraphPackageBundle({
    build: {
      argv: ['/usr/bin/node', '/opt/qdroid/build.js'],
      cwd: '.',
      exports: ['generated/result.txt'],
      schema: 'qdroid.build/stdout-ustar-v1',
    },
    name: 'qdroid/leaf',
    version: '1.0.0',
  });
  const graphRoot = createGraphPackageBundle({
    dependencies: [{ name: 'qdroid/leaf', sourceId: 'catalog/leaf', version: '1.0.0' }],
    name: 'qdroid/root',
    version: '1.0.0',
  });
  let runtimeFactoryCalls = 0;
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    runtimeFactory: {
      create: async () => {
        runtimeFactoryCalls += 1;
        throw new Error('The content-only graph must not create a runtime.');
      },
    },
    sources: new Map([
      ['catalog/root', graphSource('catalog/root', graphRoot, reads)],
      ['catalog/leaf', graphSource('catalog/leaf', builtLeaf, reads)],
    ]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: 'catalog/root', target: 'content-only' }),
      /may not contain executable package material/,
    );
    assert.equal(runtimeFactoryCalls, 0);
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual([...reads.entries()].sort(), [
      ['catalog/leaf', 1],
      ['catalog/root', 1],
    ]);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('registry migration from v2 preserves records and its existing user version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-registry-v2-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/v2-registry',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const initial = await installer.install({ sourceId: source.id, target: 'content-only' });
    const registryPath = join(root, 'registry', 'registry.sqlite');
    const legacyRegistry = new DatabaseSync(registryPath);
    try {
      legacyRegistry.exec('ALTER TABLE package_versions DROP COLUMN graph_material_path');
      legacyRegistry.exec('ALTER TABLE package_versions DROP COLUMN graph_material_digest');
      legacyRegistry
        .prepare('UPDATE package_registry_metadata SET schema_version = ? WHERE schema_name = ?')
        .run('qdroid.package-registry/v2', 'schema');
      legacyRegistry.exec('PRAGMA user_version = 73');
    } finally {
      legacyRegistry.close();
    }

    const migrated = await installer.install({ sourceId: source.id, target: 'content-only' });
    assert.equal(migrated.reusedExisting, true);
    assert.deepEqual(migrated.record, initial.record);

    const migratedRegistry = new DatabaseSync(registryPath);
    try {
      const metadata = migratedRegistry
        .prepare('SELECT schema_version FROM package_registry_metadata WHERE schema_name = ?')
        .get('schema') as { schema_version: string };
      const columns = migratedRegistry
        .prepare('PRAGMA table_info(package_versions)')
        .all() as unknown as readonly {
        name: string;
      }[];
      const userVersion = migratedRegistry.prepare('PRAGMA user_version').get() as {
        user_version: number;
      };
      assert.equal(metadata.schema_version, 'qdroid.package-registry/v3');
      assert.equal(
        columns.some((column) => column.name === 'graph_material_path'),
        true,
      );
      assert.equal(
        columns.some((column) => column.name === 'graph_material_digest'),
        true,
      );
      assert.equal(userVersion.user_version, 73);
    } finally {
      migratedRegistry.close();
    }
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a future registry schema rejects without creating the current versions table', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-registry-future-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/future-registry',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  const registryDirectory = join(root, 'registry');
  const registryPath = join(registryDirectory, 'registry.sqlite');
  await mkdir(registryDirectory, { mode: 0o700, recursive: true });
  const futureRegistry = new DatabaseSync(registryPath);
  try {
    futureRegistry.exec(`
      CREATE TABLE package_registry_metadata (
        schema_name TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL
      ) STRICT;
      CREATE TABLE future_package_versions (
        key TEXT PRIMARY KEY
      ) STRICT;
    `);
    futureRegistry
      .prepare('INSERT INTO package_registry_metadata (schema_name, schema_version) VALUES (?, ?)')
      .run('schema', 'qdroid.package-registry/v4');
  } finally {
    futureRegistry.close();
  }

  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'content-only' }),
      /registry database schema is unsupported/,
    );

    const inspectedRegistry = new DatabaseSync(registryPath);
    try {
      const tables = inspectedRegistry
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as unknown as readonly { name: string }[];
      const metadata = inspectedRegistry
        .prepare('SELECT schema_version FROM package_registry_metadata WHERE schema_name = ?')
        .get('schema') as { schema_version: string };
      assert.deepEqual(
        tables.map((table) => table.name),
        ['future_package_versions', 'package_registry_metadata'],
      );
      assert.equal(metadata.schema_version, 'qdroid.package-registry/v4');
    } finally {
      inspectedRegistry.close();
    }
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a case-insensitive registry namespace view rejects before any current schema mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-registry-view-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/registry-view',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  const registryDirectory = join(root, 'registry');
  const registryPath = join(registryDirectory, 'registry.sqlite');
  await mkdir(registryDirectory, { mode: 0o700, recursive: true });
  const futureRegistry = new DatabaseSync(registryPath);
  try {
    futureRegistry.exec("CREATE VIEW PACKAGE_VERSIONS AS SELECT 'future' AS layout;");
  } finally {
    futureRegistry.close();
  }

  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'content-only' }),
      /registry database schema is unsupported/,
    );

    const inspectedRegistry = new DatabaseSync(registryPath);
    try {
      const objects = inspectedRegistry
        .prepare(
          "SELECT name, type, sql FROM sqlite_master WHERE name = 'package_versions' COLLATE NOCASE",
        )
        .all() as unknown as readonly { name: string; sql: string; type: string }[];
      const metadataObjects = inspectedRegistry
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'package_registry_metadata' COLLATE NOCASE",
        )
        .all() as unknown as readonly { name: string }[];
      assert.deepEqual(
        objects.map((object) => ({ name: object.name, sql: object.sql, type: object.type })),
        [
          {
            name: 'PACKAGE_VERSIONS',
            sql: "CREATE VIEW PACKAGE_VERSIONS AS SELECT 'future' AS layout",
            type: 'view',
          },
        ],
      );
      assert.deepEqual(
        metadataObjects.map((object) => object.name),
        [],
      );
    } finally {
      inspectedRegistry.close();
    }
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a case-insensitive content authority namespace view rejects before registry initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-publication-authority-view-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/publication-authority-view',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  const authorityDirectory = join(root, 'content-publication');
  const authorityPath = join(authorityDirectory, 'authority.sqlite');
  await mkdir(authorityDirectory, { mode: 0o700, recursive: true });
  const authority = new DatabaseSync(authorityPath);
  try {
    authority.exec("CREATE VIEW CoNtEnT_PuBlIcAtIoN_MeTaDaTa AS SELECT 'future' AS layout;");
  } finally {
    authority.close();
  }
  await chmod(authorityPath, 0o600);

  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'content-only' }),
      /content publication authority database schema is unsupported/,
    );

    const inspectedAuthority = new DatabaseSync(authorityPath);
    try {
      const objects = inspectedAuthority
        .prepare(
          "SELECT name, type, sql FROM sqlite_master WHERE name = 'content_publication_metadata' COLLATE NOCASE",
        )
        .all() as unknown as readonly { name: string; sql: string; type: string }[];
      assert.deepEqual(
        objects.map((object) => ({ name: object.name, sql: object.sql, type: object.type })),
        [
          {
            name: 'CoNtEnT_PuBlIcAtIoN_MeTaDaTa',
            sql: "CREATE VIEW CoNtEnT_PuBlIcAtIoN_MeTaDaTa AS SELECT 'future' AS layout",
            type: 'view',
          },
        ],
      );
    } finally {
      inspectedAuthority.close();
    }
    await assert.rejects(lstat(join(root, 'registry', 'registry.sqlite')));
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a sqliteX schema object rejects registry initialization without changing its data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-registry-sqlitex-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/registry-sqlitex',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  const registryDirectory = join(root, 'registry');
  const registryPath = join(registryDirectory, 'registry.sqlite');
  await mkdir(registryDirectory, { mode: 0o700, recursive: true });
  const foreignRegistry = new DatabaseSync(registryPath);
  try {
    foreignRegistry.exec(
      "CREATE TABLE sqliteXforeign (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO sqliteXforeign (id, value) VALUES ('source', 'unchanged');",
    );
  } finally {
    foreignRegistry.close();
  }

  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'content-only' }),
      /registry database schema is unsupported/,
    );

    const inspectedRegistry = new DatabaseSync(registryPath);
    try {
      const rows = inspectedRegistry
        .prepare('SELECT id, value FROM sqliteXforeign')
        .all() as unknown as readonly { id: string; value: string }[];
      const objects = inspectedRegistry
        .prepare("SELECT name, type FROM sqlite_master WHERE name = 'sqliteXforeign'")
        .all() as unknown as readonly { name: string; type: string }[];
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [{ id: 'source', value: 'unchanged' }],
      );
      assert.deepEqual(
        objects.map((object) => ({ ...object })),
        [{ name: 'sqliteXforeign', type: 'table' }],
      );
    } finally {
      inspectedRegistry.close();
    }
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a sqliteX schema object rejects publication authority initialization without changing its data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-publication-sqlitex-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/publication-sqlitex',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  const authorityDirectory = join(root, 'content-publication');
  const authorityPath = join(authorityDirectory, 'authority.sqlite');
  await mkdir(authorityDirectory, { mode: 0o700, recursive: true });
  const foreignAuthority = new DatabaseSync(authorityPath);
  try {
    foreignAuthority.exec(
      "CREATE TABLE sqliteXforeign (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO sqliteXforeign (id, value) VALUES ('source', 'unchanged');",
    );
  } finally {
    foreignAuthority.close();
  }
  await chmod(authorityPath, 0o600);

  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'content-only' }),
      /content publication authority database schema is unsupported/,
    );

    const inspectedAuthority = new DatabaseSync(authorityPath);
    try {
      const rows = inspectedAuthority
        .prepare('SELECT id, value FROM sqliteXforeign')
        .all() as unknown as readonly { id: string; value: string }[];
      const objects = inspectedAuthority
        .prepare("SELECT name, type FROM sqlite_master WHERE name = 'sqliteXforeign'")
        .all() as unknown as readonly { name: string; type: string }[];
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [{ id: 'source', value: 'unchanged' }],
      );
      assert.deepEqual(
        objects.map((object) => ({ ...object })),
        [{ name: 'sqliteXforeign', type: 'table' }],
      );
    } finally {
      inspectedAuthority.close();
    }
    await assert.rejects(lstat(join(root, 'registry', 'registry.sqlite')));
  } finally {
    await removeFixtureRoot(root);
  }
});

test('malformed content authority metadata rejects without changing its rows or schema', async () => {
  const cases = [
    {
      name: 'non-strict metadata without a primary key',
      schema: `
        CREATE TABLE content_publication_metadata (
          schema_name TEXT,
          schema_version TEXT NOT NULL
        );
        INSERT INTO content_publication_metadata (schema_name, schema_version)
        VALUES ('schema', 'qdroid.content-publication/v1'), ('future', 'qdroid.content-publication/v2');
      `,
    },
    {
      name: 'strict metadata with an additional future row',
      schema: `
        CREATE TABLE content_publication_metadata (
          schema_name TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL
        ) STRICT;
        INSERT INTO content_publication_metadata (schema_name, schema_version)
        VALUES ('schema', 'qdroid.content-publication/v1'), ('future', 'qdroid.content-publication/v2');
      `,
    },
  ] as const;

  for (const malformed of cases) {
    const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-publication-metadata-'));
    const bundle = createPackageBundle();
    const source: PackageSource = {
      expectedSha256: sha256(bundle),
      id: `catalog/publication-metadata-${malformed.name.replaceAll(' ', '-')}`,
      maxBytes: bundle.byteLength,
      read: async () => Buffer.from(bundle),
    };
    const authorityDirectory = join(root, 'content-publication');
    const authorityPath = join(authorityDirectory, 'authority.sqlite');
    await mkdir(authorityDirectory, { mode: 0o700, recursive: true });
    const authority = new DatabaseSync(authorityPath);
    try {
      authority.exec(malformed.schema);
    } finally {
      authority.close();
    }
    await chmod(authorityPath, 0o600);

    const installer = new PackageInstaller({
      installerRoot: root,
      ownerId: 'operator-example',
      runtimeCatalog: new Map(),
      sources: new Map([[source.id, source]]),
      supportedEngineVersion: '0.1.0',
    });

    try {
      await assert.rejects(
        installer.install({ sourceId: source.id, target: 'content-only' }),
        /content publication authority database schema is unsupported/,
        malformed.name,
      );

      const inspectedAuthority = new DatabaseSync(authorityPath);
      try {
        const rows = inspectedAuthority
          .prepare(
            'SELECT schema_name, schema_version FROM content_publication_metadata ORDER BY schema_name',
          )
          .all() as unknown as readonly { schema_name: string; schema_version: string }[];
        assert.deepEqual(
          rows.map((row) => ({ ...row })),
          [
            { schema_name: 'future', schema_version: 'qdroid.content-publication/v2' },
            { schema_name: 'schema', schema_version: 'qdroid.content-publication/v1' },
          ],
          malformed.name,
        );
      } finally {
        inspectedAuthority.close();
      }
      await assert.rejects(lstat(join(root, 'registry', 'registry.sqlite')));
    } finally {
      await removeFixtureRoot(root);
    }
  }
});

test('authority database creation preserves both original sync and close failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-authority-create-failure-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/authority-create-failure',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    publicationTestHooks: {
      afterAuthorityDatabaseClose: async () => {
        throw new Error('Injected authority database close failure.');
      },
      afterAuthorityDatabaseSync: async () => {
        throw new Error('Injected authority database sync failure.');
      },
    },
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'content-only' }),
      (error: unknown) => {
        const messages = allErrorMessages(error);
        assert.match(messages, /authority database sync failure/);
        assert.match(messages, /authority database close failure/);
        return true;
      },
    );
    await assert.rejects(lstat(join(root, 'registry', 'registry.sqlite')));
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a sqliteX schema object rejects build authority initialization without starting a runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-build-authority-sqlitex-'));
  const sourceBytes = createNoBuildExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/build-authority-sqlitex',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  const authorityDirectory = join(root, 'build-authority');
  const authorityPath = join(authorityDirectory, 'authority.sqlite');
  await mkdir(authorityDirectory, { mode: 0o700, recursive: true });
  const foreignAuthority = new DatabaseSync(authorityPath);
  try {
    foreignAuthority.exec(
      "CREATE TABLE sqliteXforeign (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO sqliteXforeign (id, value) VALUES ('source', 'unchanged');",
    );
  } finally {
    foreignAuthority.close();
  }
  await chmod(authorityPath, 0o600);

  let runtimeFactoryCalls = 0;
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    runtimeFactory: {
      create: async () => {
        runtimeFactoryCalls += 1;
        throw new Error('The runtime factory must not run for an invalid build authority.');
      },
    },
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /build authority database schema is unsupported/,
    );
    assert.equal(runtimeFactoryCalls, 0);

    const inspectedAuthority = new DatabaseSync(authorityPath);
    try {
      const rows = inspectedAuthority
        .prepare('SELECT id, value FROM sqliteXforeign')
        .all() as unknown as readonly { id: string; value: string }[];
      const objects = inspectedAuthority
        .prepare("SELECT name, type FROM sqlite_master WHERE name = 'sqliteXforeign'")
        .all() as unknown as readonly { name: string; type: string }[];
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [{ id: 'source', value: 'unchanged' }],
      );
      assert.deepEqual(
        objects.map((object) => ({ ...object })),
        [{ name: 'sqliteXforeign', type: 'table' }],
      );
    } finally {
      inspectedAuthority.close();
    }
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a future build authority schema rejects without altering its metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-build-authority-future-'));
  const sourceBytes = createNoBuildExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/build-authority-future',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  const authorityDirectory = join(root, 'build-authority');
  const authorityPath = join(authorityDirectory, 'authority.sqlite');
  await mkdir(authorityDirectory, { mode: 0o700, recursive: true });
  const futureAuthority = new DatabaseSync(authorityPath);
  try {
    futureAuthority.exec(`
      CREATE TABLE build_authority_metadata (
        schema_name TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL
      ) STRICT;
      INSERT INTO build_authority_metadata (schema_name, schema_version)
      VALUES ('schema', 'qdroid.build-authority/v2');
    `);
  } finally {
    futureAuthority.close();
  }
  await chmod(authorityPath, 0o600);

  let runtimeFactoryCalls = 0;
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    runtimeFactory: {
      create: async () => {
        runtimeFactoryCalls += 1;
        throw new Error('The runtime factory must not run for a future build authority.');
      },
    },
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /build authority database schema is unsupported/,
    );
    assert.equal(runtimeFactoryCalls, 0);

    const inspectedAuthority = new DatabaseSync(authorityPath);
    try {
      const rows = inspectedAuthority
        .prepare('SELECT schema_name, schema_version FROM build_authority_metadata')
        .all() as unknown as readonly { schema_name: string; schema_version: string }[];
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [{ schema_name: 'schema', schema_version: 'qdroid.build-authority/v2' }],
      );
    } finally {
      inspectedAuthority.close();
    }
  } finally {
    await removeFixtureRoot(root);
  }
});

test('an oversized retained graph material record rejects before disabled publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-material-limit-'));
  const reads = new Map<string, number>();
  const dependencyNames = Array.from(
    { length: 10 },
    (_, index) => `qdroid/${'n'.repeat(20_000)}-${index}`,
  );
  const dependencies = dependencyNames.map((name, index) =>
    Object.freeze({
      name,
      sourceId: `catalog/large-leaf-${index}`,
      version: '1.0.0',
    }),
  );
  const rootBundle = createGraphPackageBundle({
    dependencies,
    name: 'qdroid/large-root',
    version: '1.0.0',
  });
  const sources = new Map<string, PackageSource>([
    ['catalog/large-root', graphSource('catalog/large-root', rootBundle, reads)],
    ...dependencies.map((dependency) => {
      const leaf = createGraphPackageBundle({
        name: dependency.name,
        version: dependency.version,
      });
      return [dependency.sourceId, graphSource(dependency.sourceId, leaf, reads)] as const;
    }),
  ]);
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources,
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: 'catalog/large-root', target: 'content-only' }),
      /sealed graph material exceeds the 256 KiB metadata limit/,
    );
    assert.equal(reads.size, 11);
    assert.equal(
      [...reads.values()].every((count) => count === 1),
      true,
    );

    const registry = new DatabaseSync(join(root, 'registry', 'registry.sqlite'));
    try {
      const row = registry.prepare('SELECT COUNT(*) AS count FROM package_versions').get() as {
        count: number;
      };
      assert.equal(row.count, 0);
    } finally {
      registry.close();
    }
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a v0.2 graph rejects cycles and conflicting logical source bindings before staging', async () => {
  const cycleRoot = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-cycle-'));
  const cycleReads = new Map<string, number>();
  const cycleLeaf = createGraphPackageBundle({
    dependencies: [{ name: 'qdroid/root', sourceId: 'catalog/root', version: '1.0.0' }],
    name: 'qdroid/leaf',
    version: '1.0.0',
  });
  const cyclePackage = createGraphPackageBundle({
    dependencies: [{ name: 'qdroid/leaf', sourceId: 'catalog/leaf', version: '1.0.0' }],
    name: 'qdroid/root',
    version: '1.0.0',
  });
  const cycleInstaller = new PackageInstaller({
    installerRoot: cycleRoot,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([
      ['catalog/root', graphSource('catalog/root', cyclePackage, cycleReads)],
      ['catalog/leaf', graphSource('catalog/leaf', cycleLeaf, cycleReads)],
    ]),
    supportedEngineVersion: '0.1.0',
  });

  const conflictRoot = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-conflict-'));
  const conflictReads = new Map<string, number>();
  const sharedLeft = createGraphPackageBundle({ name: 'qdroid/shared', version: '1.0.0' });
  const sharedRight = createGraphPackageBundle({ name: 'qdroid/shared', version: '1.0.0' });
  const left = createGraphPackageBundle({
    dependencies: [{ name: 'qdroid/shared', sourceId: 'catalog/shared-left', version: '1.0.0' }],
    name: 'qdroid/left',
    version: '1.0.0',
  });
  const right = createGraphPackageBundle({
    dependencies: [{ name: 'qdroid/shared', sourceId: 'catalog/shared-right', version: '1.0.0' }],
    name: 'qdroid/right',
    version: '1.0.0',
  });
  const conflictPackage = createGraphPackageBundle({
    dependencies: [
      { name: 'qdroid/left', sourceId: 'catalog/left', version: '1.0.0' },
      { name: 'qdroid/right', sourceId: 'catalog/right', version: '1.0.0' },
    ],
    name: 'qdroid/root',
    version: '1.0.0',
  });
  const conflictInstaller = new PackageInstaller({
    installerRoot: conflictRoot,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([
      ['catalog/root', graphSource('catalog/root', conflictPackage, conflictReads)],
      ['catalog/left', graphSource('catalog/left', left, conflictReads)],
      ['catalog/right', graphSource('catalog/right', right, conflictReads)],
      ['catalog/shared-left', graphSource('catalog/shared-left', sharedLeft, conflictReads)],
      ['catalog/shared-right', graphSource('catalog/shared-right', sharedRight, conflictReads)],
    ]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      cycleInstaller.install({ sourceId: 'catalog/root', target: 'content-only' }),
      /contains a cycle/,
    );
    assert.deepEqual(await readdir(cycleRoot), []);
    assert.deepEqual([...cycleReads.entries()].sort(), [
      ['catalog/leaf', 1],
      ['catalog/root', 1],
    ]);

    await assert.rejects(
      conflictInstaller.install({ sourceId: 'catalog/root', target: 'content-only' }),
      /multiple sources/,
    );
    assert.deepEqual(await readdir(conflictRoot), []);
    assert.equal(conflictReads.get('catalog/shared-left'), 1);
    assert.equal(conflictReads.get('catalog/shared-right'), undefined);
  } finally {
    await removeFixtureRoot(cycleRoot);
    await removeFixtureRoot(conflictRoot);
  }
});

test('a shared graph accepts depth eight and rejects the same suffix at depth nine', async () => {
  const acceptedRoot = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-depth-eight-'));
  const acceptedReads = new Map<string, number>();
  const rejectedRoot = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-depth-nine-'));
  const rejectedReads = new Map<string, number>();
  const sharedLeaf = createGraphPackageBundle({
    name: 'qdroid/shared-c',
    version: '1.0.0',
  });
  const sharedMiddle = createGraphPackageBundle({
    dependencies: [{ name: 'qdroid/shared-c', sourceId: 'catalog/shared-c', version: '1.0.0' }],
    name: 'qdroid/shared-b',
    version: '1.0.0',
  });
  const sharedHead = createGraphPackageBundle({
    dependencies: [{ name: 'qdroid/shared-b', sourceId: 'catalog/shared-b', version: '1.0.0' }],
    name: 'qdroid/shared-a',
    version: '1.0.0',
  });

  const createSharedTopology = (branchLength: number): ReadonlyMap<string, Buffer> => {
    const sources = new Map<string, Buffer>([
      ['catalog/shared-a', sharedHead],
      ['catalog/shared-b', sharedMiddle],
      ['catalog/shared-c', sharedLeaf],
    ]);
    let branchDependency: Readonly<{ name: string; sourceId: string; version: string }> =
      Object.freeze({
        name: 'qdroid/shared-a',
        sourceId: 'catalog/shared-a',
        version: '1.0.0',
      });
    for (let index = branchLength; index >= 1; index -= 1) {
      const name = `qdroid/z${index}`;
      const sourceId = `catalog/z${index}`;
      sources.set(
        sourceId,
        createGraphPackageBundle({
          dependencies: [branchDependency],
          name,
          version: '1.0.0',
        }),
      );
      branchDependency = Object.freeze({ name, sourceId, version: '1.0.0' });
    }
    sources.set(
      'catalog/root',
      createGraphPackageBundle({
        dependencies: [
          { name: 'qdroid/shared-a', sourceId: 'catalog/shared-a', version: '1.0.0' },
          branchDependency,
        ],
        name: 'qdroid/root',
        version: '1.0.0',
      }),
    );
    return sources;
  };

  const acceptedInstaller = new PackageInstaller({
    installerRoot: acceptedRoot,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: graphSources(createSharedTopology(5), acceptedReads),
    supportedEngineVersion: '0.1.0',
  });
  const rejectedInstaller = new PackageInstaller({
    installerRoot: rejectedRoot,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: graphSources(createSharedTopology(6), rejectedReads),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const accepted = await acceptedInstaller.install({
      sourceId: 'catalog/root',
      target: 'content-only',
    });
    assert.equal(accepted.reusedExisting, false);
    assert.notEqual(accepted.record.graphMaterialDigest, null);
    assert.equal(acceptedReads.get('catalog/shared-a'), 1);
    assert.equal(acceptedReads.get('catalog/shared-b'), 1);
    assert.equal(acceptedReads.get('catalog/shared-c'), 1);
    assert.equal(
      [...acceptedReads.values()].every((count) => count === 1),
      true,
    );

    await assert.rejects(
      rejectedInstaller.install({ sourceId: 'catalog/root', target: 'content-only' }),
      /exceeds the maximum depth/,
    );
    assert.equal(rejectedReads.get('catalog/shared-a'), 1);
    assert.equal(rejectedReads.get('catalog/shared-b'), 1);
    assert.equal(rejectedReads.get('catalog/shared-c'), 1);
    assert.equal(
      [...rejectedReads.values()].every((count) => count === 1),
      true,
    );
    assert.deepEqual(await readdir(rejectedRoot), []);
  } finally {
    await removeFixtureRoot(acceptedRoot);
    await removeFixtureRoot(rejectedRoot);
  }
});

test('a v0.2 manifest may omit dependencies, while invalid dependency values still reject', async () => {
  const omittedRoot = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-omitted-'));
  const omittedReads = new Map<string, number>();
  const omittedBundle = createGraphPackageBundle({ omitDependencies: true });
  const omittedInstaller = new PackageInstaller({
    installerRoot: omittedRoot,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([
      ['catalog/omitted', graphSource('catalog/omitted', omittedBundle, omittedReads)],
    ]),
    supportedEngineVersion: '0.1.0',
  });

  const invalidRoot = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-invalid-'));
  const invalidReads = new Map<string, number>();
  const invalidBundle = createGraphPackageBundle({ manifestDependencies: null });
  const invalidInstaller = new PackageInstaller({
    installerRoot: invalidRoot,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([
      ['catalog/invalid', graphSource('catalog/invalid', invalidBundle, invalidReads)],
    ]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const omitted = await omittedInstaller.install({
      sourceId: 'catalog/omitted',
      target: 'content-only',
    });
    assert.equal(omitted.reusedExisting, false);
    assert.notEqual(omitted.record.graphMaterialDigest, null);
    assert.deepEqual([...omittedReads.entries()], [['catalog/omitted', 1]]);
    assert.equal(omitted.record.status, 'installed-disabled');

    await assert.rejects(
      invalidInstaller.install({ sourceId: 'catalog/invalid', target: 'content-only' }),
      /manifest dependencies must be an array/,
    );
    assert.deepEqual([...invalidReads.entries()], [['catalog/invalid', 1]]);
    assert.deepEqual(await readdir(invalidRoot), []);
  } finally {
    await removeFixtureRoot(omittedRoot);
    await removeFixtureRoot(invalidRoot);
  }
});

test('a source that returns after its fixed graph deadline cannot stage package material', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-deadline-'));
  const bundle = createGraphPackageBundle();
  let observedTime = 0;
  t.mock.method(Date, 'now', () => observedTime);
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/late-graph-source',
    maxBytes: bundle.byteLength,
    read: async (request) => {
      assert.ok(request !== undefined);
      assert.equal(request.signal.aborted, false);
      observedTime = 5_001;
      return Buffer.from(bundle);
    },
  };
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'content-only' }),
      /source read exceeded its deadline/,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a graph that exceeds its deadline during final identity construction cannot stage material', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-final-deadline-'));
  const bundle = createGraphPackageBundle();
  let nowCalls = 0;
  t.mock.method(Date, 'now', () => {
    nowCalls += 1;
    return nowCalls >= 7 ? 30_001 : 0;
  });
  let sourceSignal: AbortSignal | undefined;
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/final-graph-deadline',
    maxBytes: bundle.byteLength,
    read: async (request) => {
      assert.ok(request !== undefined);
      sourceSignal = request.signal;
      return Buffer.from(bundle);
    },
  };
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'content-only' }),
      /graph resolution exceeded its deadline/,
    );
    assert.equal(nowCalls, 7);
    assert.equal(sourceSignal?.aborted, true);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a timed-out graph read aborts and blocks a retry until its raw read settles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-graph-held-read-'));
  const bundle = createGraphPackageBundle();
  const firstReadEntered = deferred<void>();
  const releaseFirstRead = deferred<void>();
  const firstReadReturned = deferred<void>();
  let firstRead = true;
  let abortObserved = false;
  let nowCalls = 0;
  t.mock.method(Date, 'now', () => {
    nowCalls += 1;
    return nowCalls === 1 ? 0 : 29_999;
  });
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/held-graph-source',
    maxBytes: bundle.byteLength,
    read: async (request) => {
      assert.ok(request !== undefined);
      if (firstRead) {
        firstRead = false;
        firstReadEntered.resolve(undefined);
        request.signal.addEventListener(
          'abort',
          () => {
            abortObserved = true;
          },
          { once: true },
        );
        await releaseFirstRead.promise;
        firstReadReturned.resolve(undefined);
      }
      return Buffer.from(bundle);
    },
  };
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const timedOut = installer.install({ sourceId: source.id, target: 'content-only' });
    await firstReadEntered.promise;
    await assert.rejects(timedOut, /source read exceeded its deadline/);
    assert.equal(abortObserved, true);
    assert.deepEqual(await readdir(root), []);

    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'content-only' }),
      /prior trusted package graph source read is still unsettled/,
    );

    releaseFirstRead.resolve(undefined);
    await firstReadReturned.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await readdir(root), []);
    t.mock.restoreAll();

    const retry = await installer.install({ sourceId: source.id, target: 'content-only' });
    assert.equal(retry.reusedExisting, false);
  } finally {
    t.mock.restoreAll();
    releaseFirstRead.resolve(undefined);
    await removeFixtureRoot(root);
  }
});

test('graph transport and expanded byte budgets reject before materialization', async () => {
  const transportRoot = await mkdtemp(
    join(tmpdir(), 'qdroid-package-runtime-graph-transport-budget-'),
  );
  const transportReads = new Map<string, number>();
  const transportPayloads = [
    Buffer.alloc(7 * 1024 * 1024, 0x61),
    Buffer.alloc(7 * 1024 * 1024, 0x62),
  ];
  const transportGraph = createSizedGraphChain('transport-budget', 4, transportPayloads, false);
  const transportInstaller = new PackageInstaller({
    installerRoot: transportRoot,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: graphSources(transportGraph.bundles, transportReads),
    supportedEngineVersion: '0.1.0',
  });

  const expandedRoot = await mkdtemp(
    join(tmpdir(), 'qdroid-package-runtime-graph-expanded-budget-'),
  );
  const expandedReads = new Map<string, number>();
  const expandedPayload = createMixedEntropyPayload(7 * 1024 * 1024);
  const expandedGraph = createSizedGraphChain(
    'expanded-budget',
    4,
    [expandedPayload, expandedPayload, expandedPayload, expandedPayload],
    true,
  );
  const expandedInstaller = new PackageInstaller({
    installerRoot: expandedRoot,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: graphSources(expandedGraph.bundles, expandedReads),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      transportInstaller.install({ sourceId: transportGraph.rootSourceId, target: 'content-only' }),
      /transport byte limit/,
    );
    assert.equal(transportReads.size, 5);
    assert.equal(
      [...transportReads.values()].every((count) => count === 1),
      true,
    );
    assert.deepEqual(await readdir(transportRoot), []);

    await assert.rejects(
      expandedInstaller.install({ sourceId: expandedGraph.rootSourceId, target: 'content-only' }),
      /expanded byte limit/,
    );
    assert.equal(expandedReads.size, 5);
    assert.equal(
      [...expandedReads.values()].every((count) => count === 1),
      true,
    );
    assert.deepEqual(await readdir(expandedRoot), []);
  } finally {
    await removeFixtureRoot(transportRoot);
    await removeFixtureRoot(expandedRoot);
  }
});

test('v0.1 metadata rejects dependency declarations before source graph traversal or staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-v01-dependencies-'));
  const bundle = createPackageBundle({
    dependencies: [{ name: 'qdroid/child', sourceId: 'catalog/child', version: '1.0.0' }],
  });
  const reads = new Map<string, number>();
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([
      ['catalog/root', graphSource('catalog/root', bundle, reads)],
      ['catalog/child', graphSource('catalog/child', createGraphPackageBundle(), reads)],
    ]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: 'catalog/root', target: 'content-only' }),
      /v0\.1 package manifest may not declare dependencies/,
    );
    assert.deepEqual([...reads.entries()], [['catalog/root', 1]]);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a restrictive child-process umask cannot weaken sealed content or metadata modes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-umask-'));
  try {
    const child = await execFile(
      process.execPath,
      [new URL('./restrictive-umask-child.js', import.meta.url).pathname],
      {
        env: { ...process.env, QDROID_RESTRICTIVE_UMASK_ROOT: root },
      },
    );
    const result = JSON.parse(child.stdout) as {
      readonly modes: readonly { readonly mode: number; readonly path: string }[];
      readonly reusedExisting: boolean;
    };
    assert.equal(result.modes.length, 8);
    assert.equal(result.reusedExisting, true);
    for (const entry of result.modes) {
      const expectedMode =
        entry.path.endsWith('.txt') || entry.path.endsWith('.md') || entry.path.endsWith('.json')
          ? 0o444
          : 0o555;
      assert.equal(entry.mode, expectedMode, entry.path);
    }
  } finally {
    await removeFixtureRoot(root);
  }
});

test('independent processes serialize graph content publication through the root authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-publication-processes-'));
  try {
    const childPath = new URL('./publication-authority-child.js', import.meta.url).pathname;
    const [first, second] = await Promise.all([
      execFile(process.execPath, [childPath], {
        env: { ...process.env, QDROID_PUBLICATION_CHILD_ROOT: root },
      }),
      execFile(process.execPath, [childPath], {
        env: { ...process.env, QDROID_PUBLICATION_CHILD_ROOT: root },
      }),
    ]);
    assert.equal(first.stderr, '');
    assert.equal(second.stderr, '');
    const firstResult = JSON.parse(first.stdout) as InstallResult;
    const secondResult = JSON.parse(second.stdout) as InstallResult;
    assert.deepEqual(firstResult.record, secondResult.record);
    assert.deepEqual([firstResult.reusedExisting, secondResult.reusedExisting].sort(), [
      false,
      true,
    ]);

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
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a held content publication authority excludes same-process publishers until release', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-publication-held-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/publication-held',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  const holder = startPublicationAuthorityHolder(root);
  let retainRoot = false;

  try {
    await awaitWithin(holder.ready, 2_000, 'content publication authority holder readiness');
    const createInstaller = (): PackageInstaller =>
      new PackageInstaller({
        installerRoot: root,
        ownerId: 'operator-example',
        runtimeCatalog: new Map(),
        sources: new Map([[source.id, source]]),
        supportedEngineVersion: '0.1.0',
      });
    const first = createInstaller().install({ sourceId: source.id, target: 'content-only' });
    const second = createInstaller().install({ sourceId: source.id, target: 'content-only' });
    void first.catch(() => undefined);
    void second.catch(() => undefined);

    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(lstat(join(root, 'content')));
    await assert.rejects(lstat(join(root, 'registry')));
    assert.equal(holder.child.exitCode, null);
    assert.equal(holder.child.signalCode, null);

    await releasePublicationAuthorityHolder(holder);
    const results = await awaitWithin(
      Promise.all([first, second]),
      2_000,
      'content publishers after authority release',
    );
    assert.deepEqual([results[0].reusedExisting, results[1].reusedExisting].sort(), [false, true]);
    assert.deepEqual(results[0].record, results[1].record);
  } catch (error) {
    retainRoot = true;
    t.diagnostic(
      `Retaining held content publication authority root after failure: ${root}; ${allErrorMessages(error)}`,
    );
    throw error;
  } finally {
    await settlePublicationAuthorityHolder(holder);
    if (!retainRoot) {
      await removeFixtureRoot(root);
    }
  }
});

test('content publication admission timeout does not stop its physical holder', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-publication-timeout-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/publication-timeout',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  const holder = startPublicationAuthorityHolder(root);
  let retainRoot = false;
  let installation: Promise<InstallResult> | undefined;

  try {
    await awaitWithin(holder.ready, 2_000, 'content publication authority holder readiness');
    const installer = new PackageInstaller({
      installerRoot: root,
      ownerId: 'operator-example',
      runtimeCatalog: new Map(),
      sources: new Map([[source.id, source]]),
      supportedEngineVersion: '0.1.0',
    });
    installation = installer.install({ sourceId: source.id, target: 'content-only' });
    void installation.catch(() => undefined);

    await assert.rejects(
      awaitWithin(installation, 12_000, 'content publication authority admission timeout'),
      /content publication authority admission timed out/,
    );
    assert.equal(holder.child.exitCode, null);
    assert.equal(holder.child.signalCode, null);
    await assert.rejects(lstat(join(root, 'content')));
    await assert.rejects(lstat(join(root, 'registry')));
  } catch (error) {
    retainRoot = true;
    t.diagnostic(
      `Retaining timed-out content publication authority root after failure: ${root}; ${allErrorMessages(error)}`,
    );
    throw error;
  } finally {
    await settlePublicationAuthorityHolder(holder);
    if (installation !== undefined) {
      await Promise.allSettled([installation]);
    }
    if (!retainRoot) {
      await removeFixtureRoot(root);
    }
  }
});

test('a publisher paused after rename retains its lease until every content sidecar settles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-publication-rename-pause-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/publication-rename-pause',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  let releaseRename: (() => void) | undefined;
  let renamedDestination: string | undefined;
  const renamePaused = new Promise<void>((resolve) => {
    releaseRename = resolve;
  });
  let signalRename: (() => void) | undefined;
  const renameObserved = new Promise<void>((resolve) => {
    signalRename = resolve;
  });
  const publisher = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    publicationTestHooks: {
      afterContentRename: async (destination) => {
        renamedDestination = destination;
        signalRename?.();
        await renamePaused;
      },
    },
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });
  const waiter = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });
  let first: Promise<InstallResult> | undefined;
  let second: Promise<InstallResult> | undefined;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  const settlementFailures: unknown[] = [];
  let retainRoot = false;

  try {
    first = publisher.install({ sourceId: source.id, target: 'content-only' });
    void first.catch(() => undefined);
    await awaitWithin(renameObserved, 2_000, 'publisher pause after content rename');
    const destination = renamedDestination;
    assert.notEqual(destination, undefined);
    await assert.rejects(lstat(`${destination}.input-inventory.json`));
    second = waiter.install({ sourceId: source.id, target: 'content-only' });
    void second.catch(() => undefined);
    let secondSettled = false;
    void second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondSettled, false);
    await assertNoPublishedRegistryRows(root);

    releaseRename?.();
    const [firstResult, secondResult] = await awaitWithin(
      Promise.all([first, second]),
      2_000,
      'publishers after the paused sidecars settle',
    );
    assert.deepEqual([firstResult.reusedExisting, secondResult.reusedExisting].sort(), [
      false,
      true,
    ]);
    assert.deepEqual(firstResult.record, secondResult.record);
  } catch (error) {
    primaryFailure = error;
    retainRoot = true;
    t.diagnostic(
      `Retaining paused publication root after failure: ${root}; ${allErrorMessages(error)}`,
    );
  } finally {
    releaseRename?.();
    try {
      const installations = [first, second].filter(
        (installation): installation is Promise<InstallResult> => installation !== undefined,
      );
      const settlements = await awaitWithin(
        Promise.allSettled(installations),
        2_000,
        'paused content publisher and waiter settlement',
      );
      settlementFailures.push(...rejectedSettlementReasons(settlements));
      if (settlementFailures.length > 0) {
        retainRoot = true;
      }
      if (!retainRoot) {
        await removeFixtureRoot(root);
      }
    } catch (error) {
      cleanupFailure = error;
      retainRoot = true;
      t.diagnostic(
        `Retaining paused publication root after cleanup failure: ${root}; ${allErrorMessages(error)}`,
      );
    }
  }
  throwTestFailures(primaryFailure, cleanupFailure, settlementFailures);
});

test('publication settlement preserves a second publisher rejection and cleanup failure', async () => {
  const firstPublisherFailure = new Error('first publisher failure');
  const secondPublisherFailure = new Error('second publisher failure');
  const cleanupFailure = new Error('publisher cleanup failure');
  const settlements = await Promise.allSettled([
    Promise.reject(firstPublisherFailure),
    Promise.reject(secondPublisherFailure),
  ]);

  assert.throws(
    () =>
      throwTestFailures(
        firstPublisherFailure,
        cleanupFailure,
        rejectedSettlementReasons(settlements),
      ),
    (error: unknown) => {
      const messages = allErrorMessages(error);
      assert.match(messages, /first publisher failure/);
      assert.match(messages, /second publisher failure/);
      assert.match(messages, /publisher cleanup failure/);
      return true;
    },
  );
});

test('a child publisher paused after rename excludes an independent installer until sidecars settle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-publication-child-pause-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/publication-child-pause',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  let publisher: PublicationCrashPublisher | undefined;
  let waitingInstall: Promise<InstallResult> | undefined;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  const settlementFailures: unknown[] = [];
  let retainRoot = false;

  try {
    publisher = startPublicationCrashPublisher(root, source, bundle, 'release');
    await awaitWithin(publisher.renamed, 2_000, 'child publisher rename before sidecars');

    const waiter = new PackageInstaller({
      installerRoot: root,
      ownerId: 'operator-example',
      runtimeCatalog: new Map(),
      sources: new Map([[source.id, source]]),
      supportedEngineVersion: '0.1.0',
    });
    waitingInstall = waiter.install({ sourceId: source.id, target: 'content-only' });
    let waiterSettled = false;
    void waitingInstall.then(
      () => {
        waiterSettled = true;
      },
      () => {
        waiterSettled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(waiterSettled, false);
    await assertNoPublishedRegistryRows(root);

    publisher.child.stdin.end();
    const publisherExit = await awaitWithin(
      publisher.exit,
      2_000,
      'child publisher completion after sidecars settle',
    );
    assert.equal(publisherExit.code, 0);
    assert.equal(publisherExit.signal, null);
    const result = await awaitWithin(
      waitingInstall,
      2_000,
      'independent installer after child publication settles',
    );
    assert.equal(result.reusedExisting, true);
  } catch (error) {
    primaryFailure = error;
    retainRoot = true;
    t.diagnostic(
      `Retaining child-paused publication root after failure: ${root}; ${allErrorMessages(error)}`,
    );
  } finally {
    const cleanupFailures: unknown[] = [];
    if (publisher !== undefined) {
      try {
        await terminatePublicationCrashPublisher(publisher);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (waitingInstall !== undefined) {
      try {
        const settlements = await awaitWithin(
          Promise.allSettled([waitingInstall]),
          2_000,
          'independent content installer settlement after child publisher cleanup',
        );
        settlementFailures.push(...rejectedSettlementReasons(settlements));
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (settlementFailures.length > 0) {
      retainRoot = true;
    }
    if (cleanupFailures.length > 0) {
      cleanupFailure = aggregateTestFailures(
        cleanupFailures,
        'The child publisher cleanup and independent installer settlement both failed.',
      );
      retainRoot = true;
    }
    if (!retainRoot) {
      try {
        await removeFixtureRoot(root);
      } catch (error) {
        cleanupFailure = appendTestFailure(cleanupFailure, error);
        retainRoot = true;
      }
    }
    if (cleanupFailure !== undefined) {
      t.diagnostic(
        `Retaining child-paused publication root after cleanup failure: ${root}; ${allErrorMessages(cleanupFailure)}`,
      );
    }
  }
  throwTestFailures(primaryFailure, cleanupFailure, settlementFailures);
});

test('a failure after content rename retains incomplete content and cannot publish a registry record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-publication-incomplete-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/publication-incomplete',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  const failingPublisher = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    publicationTestHooks: {
      afterContentRename: async () => {
        throw new Error('Injected content publication synchronization failure.');
      },
    },
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });
  const freshInstaller = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  let retainRoot = false;

  try {
    await assert.rejects(
      failingPublisher.install({ sourceId: source.id, target: 'content-only' }),
      /Injected content publication synchronization failure/,
    );

    const contentDirectories = await readdir(join(root, 'content'));
    assert.equal(contentDirectories.length, 1);
    const retainedDestination = join(root, 'content', contentDirectories[0]!);
    await assert.rejects(lstat(`${retainedDestination}.input-inventory.json`));
    await assertNoPublishedRegistryRows(root);

    await assert.rejects(
      freshInstaller.install({ sourceId: source.id, target: 'content-only' }),
      /input inventory|cannot be rebuilt automatically/,
    );
    assert.deepEqual(await readdir(join(root, 'content')), contentDirectories);
    await assertNoPublishedRegistryRows(root);
  } catch (error) {
    primaryFailure = error;
    retainRoot = true;
    t.diagnostic(
      `Retaining incomplete publication root after failure: ${root}; ${allErrorMessages(error)}`,
    );
  } finally {
    try {
      if (!retainRoot) {
        await removeFixtureRoot(root);
      }
    } catch (error) {
      cleanupFailure = error;
      retainRoot = true;
      t.diagnostic(
        `Retaining incomplete publication root after cleanup failure: ${root}; ${allErrorMessages(error)}`,
      );
    }
  }
  throwTestFailures(primaryFailure, cleanupFailure);
});

test('an original FileHandle sync failure after content rename cannot publish a registry record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-publication-fsync-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/publication-fsync',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  const descriptor = await open(root, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(descriptor) as {
    sync(this: unknown): Promise<void>;
  };
  const originalSync = fileHandlePrototype.sync;
  await descriptor.close();
  let failNextSync = false;
  t.mock.method(fileHandlePrototype, 'sync', async function sync(this: unknown): Promise<void> {
    if (failNextSync) {
      failNextSync = false;
      throw new Error('Injected original FileHandle.sync failure.');
    }
    await originalSync.call(this);
  });

  const failingPublisher = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    publicationTestHooks: {
      afterContentRename: async () => {
        failNextSync = true;
      },
    },
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });
  const freshInstaller = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  let retainRoot = false;

  try {
    await assert.rejects(
      failingPublisher.install({ sourceId: source.id, target: 'content-only' }),
      /Injected original FileHandle\.sync failure/,
    );

    const contentDirectories = await readdir(join(root, 'content'));
    assert.equal(contentDirectories.length, 1);
    const retainedDestination = join(root, 'content', contentDirectories[0]!);
    await assert.rejects(lstat(`${retainedDestination}.input-inventory.json`));
    await assertNoPublishedRegistryRows(root);

    await assert.rejects(
      freshInstaller.install({ sourceId: source.id, target: 'content-only' }),
      /input inventory|cannot be rebuilt automatically/,
    );
    assert.deepEqual(await readdir(join(root, 'content')), contentDirectories);
    await assertNoPublishedRegistryRows(root);
  } catch (error) {
    primaryFailure = error;
    retainRoot = true;
    t.diagnostic(
      `Retaining fsync publication root after failure: ${root}; ${allErrorMessages(error)}`,
    );
  } finally {
    try {
      if (!retainRoot) {
        await removeFixtureRoot(root);
      }
    } catch (error) {
      cleanupFailure = error;
      retainRoot = true;
      t.diagnostic(
        `Retaining fsync publication root after cleanup failure: ${root}; ${allErrorMessages(error)}`,
      );
    }
  }
  throwTestFailures(primaryFailure, cleanupFailure);
});

test('a SIGKILL publisher leaves unregistered incomplete content that a fresh installer rejects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-publication-sigkill-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/publication-sigkill',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  let publisher: PublicationCrashPublisher | undefined;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  let retainRoot = false;

  try {
    publisher = startPublicationCrashPublisher(root, source, bundle);
    await awaitWithin(publisher.renamed, 2_000, 'publisher rename before SIGKILL');
    assert.equal(publisher.child.kill('SIGKILL'), true);
    const exit = await awaitWithin(publisher.exit, 2_000, 'SIGKILL publisher exit');
    assert.equal(exit.code, null);
    assert.equal(exit.signal, 'SIGKILL');

    const contentDirectories = await readdir(join(root, 'content'));
    assert.equal(contentDirectories.length, 1);
    const retainedDestination = join(root, 'content', contentDirectories[0]!);
    await assert.rejects(lstat(`${retainedDestination}.input-inventory.json`));
    await assertNoPublishedRegistryRows(root);

    const freshInstaller = new PackageInstaller({
      installerRoot: root,
      ownerId: 'operator-example',
      runtimeCatalog: new Map(),
      sources: new Map([[source.id, source]]),
      supportedEngineVersion: '0.1.0',
    });
    await assert.rejects(
      freshInstaller.install({ sourceId: source.id, target: 'content-only' }),
      /input inventory|cannot be rebuilt automatically/,
    );
    assert.deepEqual(await readdir(join(root, 'content')), contentDirectories);
    await assertNoPublishedRegistryRows(root);
  } catch (error) {
    primaryFailure = error;
    retainRoot = true;
    t.diagnostic(
      `Retaining SIGKILL publication root after failure: ${root}; ${allErrorMessages(error)}`,
    );
  } finally {
    try {
      if (publisher !== undefined) {
        await terminatePublicationCrashPublisher(publisher);
      }
      if (!retainRoot) {
        await removeFixtureRoot(root);
      }
    } catch (error) {
      cleanupFailure = error;
      retainRoot = true;
      t.diagnostic(
        `Retaining SIGKILL publication root after cleanup failure: ${root}; ${allErrorMessages(error)}`,
      );
    }
  }
  throwTestFailures(primaryFailure, cleanupFailure);
});

test('a crash publisher exits when its parent channel closes and leaves incomplete content retained', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-publication-parent-loss-'));
  const bundle = createPackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/publication-parent-loss',
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
  let publisher: PublicationCrashPublisher | undefined;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  let retainRoot = false;

  try {
    publisher = startPublicationCrashPublisher(root, source, bundle);
    await awaitWithin(publisher.renamed, 2_000, 'publisher rename before parent-channel loss');
    publisher.child.stdin.end();

    const exit = await awaitWithin(
      publisher.exit,
      2_000,
      'crash publisher exit after parent-channel loss',
    );
    assert.equal(exit.code, 1);
    assert.equal(exit.signal, null);
    assert.match(
      Buffer.concat(publisher.stderr).toString('utf8'),
      /lost its parent channel before SIGKILL/,
    );

    const contentDirectories = await readdir(join(root, 'content'));
    assert.equal(contentDirectories.length, 1);
    const retainedDestination = join(root, 'content', contentDirectories[0]!);
    await assert.rejects(lstat(`${retainedDestination}.input-inventory.json`));
    await assertNoPublishedRegistryRows(root);

    const freshInstaller = new PackageInstaller({
      installerRoot: root,
      ownerId: 'operator-example',
      runtimeCatalog: new Map(),
      sources: new Map([[source.id, source]]),
      supportedEngineVersion: '0.1.0',
    });
    await assert.rejects(
      freshInstaller.install({ sourceId: source.id, target: 'content-only' }),
      /input inventory|cannot be rebuilt automatically/,
    );
    await assert.deepEqual(await readdir(join(root, 'content')), contentDirectories);
  } catch (error) {
    primaryFailure = error;
    retainRoot = true;
    t.diagnostic(
      `Retaining parent-loss publication root after failure: ${root}; ${allErrorMessages(error)}`,
    );
  } finally {
    try {
      if (publisher !== undefined) {
        await terminatePublicationCrashPublisher(publisher);
      }
      if (!retainRoot) {
        await removeFixtureRoot(root);
      }
    } catch (error) {
      cleanupFailure = error;
      retainRoot = true;
      t.diagnostic(
        `Retaining parent-loss publication root after cleanup failure: ${root}; ${allErrorMessages(error)}`,
      );
    }
  }
  throwTestFailures(primaryFailure, cleanupFailure);
});

test('committed content with missing, extra, or type-conflicting paths rejects reuse without repair', async () => {
  const mutations: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (record: { readonly contentDirectory: string }) => Promise<void>;
  }> = [
    {
      name: 'missing file',
      mutate: async (record) => {
        const path = join(record.contentDirectory, 'assets', 'notice.txt');
        await chmod(dirname(path), 0o700);
        await unlink(path);
        await chmod(dirname(path), 0o555);
      },
    },
    {
      name: 'extra file',
      mutate: async (record) => {
        await chmod(record.contentDirectory, 0o700);
        await writeFile(join(record.contentDirectory, 'unexpected.txt'), 'unexpected', {
          mode: 0o444,
        });
        await chmod(record.contentDirectory, 0o555);
      },
    },
    {
      name: 'directory replacing a file',
      mutate: async (record) => {
        const path = join(record.contentDirectory, 'assets', 'notice.txt');
        await chmod(dirname(path), 0o700);
        await unlink(path);
        await mkdir(path, { mode: 0o555 });
        await chmod(dirname(path), 0o555);
      },
    },
  ];

  for (const mutation of mutations) {
    const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-corrupt-content-'));
    const bundle = createPackageBundle();
    const source: PackageSource = {
      expectedSha256: sha256(bundle),
      id: 'catalog/corrupt-content',
      maxBytes: bundle.byteLength,
      read: async () => bundle,
    };
    const installer = new PackageInstaller({
      installerRoot: root,
      ownerId: 'operator-example',
      runtimeCatalog: new Map(),
      sources: new Map([[source.id, source]]),
      supportedEngineVersion: '0.1.0',
    });

    try {
      const installed = await installer.install({ sourceId: source.id, target: 'content-only' });
      await mutation.mutate(installed.record);
      await assert.rejects(
        installer.install({ sourceId: source.id, target: 'content-only' }),
        /committed disabled installation content/,
        mutation.name,
      );
    } finally {
      await removeFixtureRoot(root);
    }
  }
});

test('content reuse requires both inventories and the final sealed readiness record', async () => {
  const mutations: ReadonlyArray<{
    readonly name: string;
    readonly remove: (record: {
      readonly contentDirectory: string;
      readonly inputInventoryPath: string;
    }) => Promise<void>;
    readonly expected: RegExp;
  }> = [
    {
      expected: /input inventory is missing or corrupt/,
      name: 'input inventory',
      remove: async (record) => unlink(record.inputInventoryPath),
    },
    {
      expected: /not fully sealed/,
      name: 'readiness record',
      remove: async (record) => unlink(`${record.contentDirectory}.ready.json`),
    },
  ];

  for (const mutation of mutations) {
    const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-readiness-'));
    const bundle = createPackageBundle();
    const source: PackageSource = {
      expectedSha256: sha256(bundle),
      id: 'catalog/readiness',
      maxBytes: bundle.byteLength,
      read: async () => bundle,
    };
    const installer = new PackageInstaller({
      installerRoot: root,
      ownerId: 'operator-example',
      runtimeCatalog: new Map(),
      sources: new Map([[source.id, source]]),
      supportedEngineVersion: '0.1.0',
    });

    try {
      const installed = await installer.install({ sourceId: source.id, target: 'content-only' });
      await mutation.remove(installed.record);
      await assert.rejects(
        installer.install({ sourceId: source.id, target: 'content-only' }),
        mutation.expected,
        mutation.name,
      );
    } finally {
      await removeFixtureRoot(root);
    }
  }
});

test('installer rejects strict JSON duplicate keys before disabled registry publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-invalid-'));
  const invalidManifest = Buffer.from(
    '{"schema":"qdroid.plugin/v0.1","schema":"forged","kind":"application"}',
  );
  const bundle = createUstar([
    { path: 'qdroid.plugin.json', body: invalidManifest.toString('utf8') },
    {
      path: 'qdroid.lock.json',
      body: '{"schema":"qdroid.lock/v0.1","inputContentDigest":"0000000000000000000000000000000000000000000000000000000000000000"}',
    },
  ]);
  const source: PackageSource = {
    expectedSha256: sha256(bundle),
    id: 'catalog/invalid',
    maxBytes: bundle.byteLength,
    read: async () => bundle,
  };
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'content-only' }),
      /Invalid JSON input/,
    );
  } finally {
    await removeFixtureRoot(root);
  }
});

test('installer rejects undeclared capability authority fields and malformed resource requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-schema-'));
  const unsafeCapability = createPackageBundle({
    requestedCapabilities: [
      {
        id: 'connector.calendar.read/v1',
        operations: ['calendar.listEvents'],
        resourceSelector: { mounts: ['/host'], type: 'configured-calendars' },
      },
    ],
  });
  const malformedResources = createPackageBundle({
    requestedResources: { ...defaultRequestedResources(), pids: '32' },
  });
  const sources = new Map<string, PackageSource>([
    [
      'catalog/unsafe-capability',
      {
        expectedSha256: sha256(unsafeCapability),
        id: 'catalog/unsafe-capability',
        maxBytes: unsafeCapability.byteLength,
        read: async () => unsafeCapability,
      },
    ],
    [
      'catalog/malformed-resources',
      {
        expectedSha256: sha256(malformedResources),
        id: 'catalog/malformed-resources',
        maxBytes: malformedResources.byteLength,
        read: async () => malformedResources,
      },
    ],
  ]);
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map(),
    sources,
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: 'catalog/unsafe-capability', target: 'content-only' }),
      /metadata contains unknown fields/,
    );
    await assert.rejects(
      installer.install({ sourceId: 'catalog/malformed-resources', target: 'content-only' }),
      /positive safe integer/,
    );
  } finally {
    await removeFixtureRoot(root);
  }
});

test('inventory digest uses bytewise ASCII path ordering', () => {
  const archive = readFrozenBundle(
    createUstar([
      { path: 'assets/a.txt', body: 'lowercase' },
      { path: 'assets/Z.txt', body: 'uppercase' },
      { path: 'assets/-.txt', body: 'punctuation' },
      { path: 'qdroid.lock.json', body: '{}' },
      { path: 'qdroid.plugin.json', body: '{}' },
    ]),
  );
  const expectedEntries = [...archive.entries]
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.path, 'ascii'), Buffer.from(right.path, 'ascii')),
    )
    .map((entry) => ({
      digest: entry.digest,
      executable: entry.executable,
      length: entry.bytes.byteLength,
      path: entry.path,
      type: entry.type,
    }));
  const expected = sha256(
    Buffer.from(JSON.stringify({ entries: expectedEntries, schema: 'qdroid.inventory/v1' })),
  );

  assert.equal(inventoryDigest(archive.entries), expected);
});

test('executable installation accepts only declared offline build output before assembly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-build-'));
  const sourceBytes = createExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/executable-v1',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  const output = createUstar([{ path: 'generated/result.txt', body: 'built offline' }]);
  const executor: TrustedBuildExecutor = {
    managesResources: true,
    execute: async (request) => {
      assert.equal(request.builderImage, `sha256:${'d'.repeat(64)}`);
      assert.deepEqual(request.environment, { LANG: 'C.UTF-8', TZ: 'UTC' });
      assert.equal(request.profile, 'build-restricted');
      return completedExecution(output);
    },
  };
  const assembler: TrustedImageAssembler = {
    assemble: async (request) => {
      if (request.purpose === 'builder') {
        assert.equal(request.buildOutputDirectory, undefined);
        return {
          cleanupConfirmed: true,
          imageId: `sha256:${'d'.repeat(64)}`,
          receipt: {},
        };
      }

      assert.equal(request.purpose, 'runtime');
      assert.equal(request.buildOutputDirectory?.includes('/generated/'), true);
      assert.equal(
        await readFile(join(request.buildOutputDirectory as string, 'result.txt'), 'utf8'),
        'built offline',
      );
      return {
        cleanupConfirmed: true,
        imageId: `sha256:${'c'.repeat(64)}`,
        receipt: {},
      };
    },
    verifySealed: async () => undefined,
  };
  const installer = new PackageInstaller({
    runtimeFactory: testRuntimeFactory(executor, assembler),
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([
      [
        'catalog/node-build-v1',
        {
          abi: 'glibc-2.39',
          baseImage: `sha256:${'a'.repeat(64)}`,
          builderImage: `sha256:${'b'.repeat(64)}`,
          features: [],
          id: 'catalog/node-build-v1',
          platform: 'linux/arm64',
          profile: 'build-restricted',
          templateDigest: 'c'.repeat(64),
          toolchainDigest: 'd'.repeat(64),
        },
      ],
    ]),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const installed = await installer.install({ sourceId: source.id, target: 'linux/arm64' });
    assert.equal(installed.record.status, 'installed-disabled');
    assert.equal(installed.record.buildOutputDigest === null, false);
    assert.equal(installed.record.imageId, `sha256:${'c'.repeat(64)}`);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('executable installation rejects decoded generated output above 8 MiB before publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-output-size-'));
  const sourceBytes = createExecutablePackageBundle({}, [
    'generated/first.txt',
    'generated/second.txt',
  ]);
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/executable-output-size',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  const bodyBytes = 4_718_592;
  const output = gzipSync(
    createUstar([
      { body: deterministicAsciiBody(bodyBytes, 0x1234_5678), path: 'generated/first.txt' },
      { body: deterministicAsciiBody(bodyBytes, 0x9abc_def0), path: 'generated/second.txt' },
    ]),
  );
  assert.ok(output.byteLength < 8 * 1024 * 1024);
  let assemblyCalls = 0;
  const installer = new PackageInstaller({
    runtimeFactory: testRuntimeFactory(
      {
        managesResources: true,
        execute: async () => completedExecution(output),
      },
      {
        assemble: async () => {
          assemblyCalls += 1;
          return {
            cleanupConfirmed: true,
            imageId: `sha256:${'c'.repeat(64)}`,
            receipt: {},
          };
        },
        verifySealed: async () => undefined,
      },
    ),
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      (error) => {
        assert.match(allErrorMessages(error), /decoded 8 MiB file limit/);
        return true;
      },
    );
    assert.equal(assemblyCalls, 1);
    const database = new DatabaseSync(join(root, 'registry', 'registry.sqlite'));
    try {
      const row = database.prepare('SELECT COUNT(*) AS count FROM package_versions').get() as {
        readonly count: number;
      };
      assert.equal(row.count, 0);
    } finally {
      database.close();
    }
  } finally {
    await removeFixtureRoot(root);
  }
});

test('executable variants must bind the trusted base and required features', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-variant-'));
  const mismatchedImage = createExecutablePackageBundle({
    image: `sha256:${'e'.repeat(64)}`,
  });
  const missingFeature = createExecutablePackageBundle({
    requiredFeatures: ['network=none'],
  });
  const sources = new Map<string, PackageSource>([
    [
      'catalog/mismatched-image',
      {
        expectedSha256: sha256(mismatchedImage),
        id: 'catalog/mismatched-image',
        maxBytes: mismatchedImage.byteLength,
        read: async () => mismatchedImage,
      },
    ],
    [
      'catalog/missing-feature',
      {
        expectedSha256: sha256(missingFeature),
        id: 'catalog/missing-feature',
        maxBytes: missingFeature.byteLength,
        read: async () => missingFeature,
      },
    ],
  ]);
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    sources,
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: 'catalog/mismatched-image', target: 'linux/arm64' }),
      /not in the trusted catalog/,
    );
    await assert.rejects(
      installer.install({ sourceId: 'catalog/missing-feature', target: 'linux/arm64' }),
      /not in the trusted catalog/,
    );
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a changed trusted catalog selection cannot reuse an executable installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-resolved-lock-'));
  const sourceBytes = createExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/executable-resolved-lock',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  const runtimeCatalog = new Map<string, TrustedImageCatalogEntry>([
    ['catalog/node-build-v1', trustedRuntimeCatalogEntry()],
  ]);
  const output = createUstar([{ path: 'generated/result.txt', body: 'built offline' }]);
  const installer = new PackageInstaller({
    runtimeFactory: testRuntimeFactory(
      {
        managesResources: true,
        execute: async () => completedExecution(output),
      },
      {
        assemble: async () => ({
          cleanupConfirmed: true,
          imageId: `sha256:${'c'.repeat(64)}`,
          receipt: {},
        }),
        verifySealed: async () => undefined,
      },
    ),
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog,
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const first = await installer.install({ sourceId: source.id, target: 'linux/arm64' });
    assert.notEqual(first.record.resolvedLockDigest, null);

    runtimeCatalog.set(
      'catalog/node-build-v1',
      trustedRuntimeCatalogEntry({ toolchainDigest: 'e'.repeat(64) }),
    );
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /immutable installation version is already bound/,
    );
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a no-build executable seals runtime content and reuses it without executing a build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-no-build-'));
  const sourceBytes = createNoBuildExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/executable-no-build',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  let assemblyCount = 0;
  let executionCount = 0;
  let imageAvailable = true;
  const legacyRuntimeMaterialDigest =
    '2125561ea6fdc38ad083f1ebe690849e89ef88c5ba396a37af777c9f4758d888';
  const preparedMaterialDigests: string[] = [];
  let verificationCount = 0;
  const installer = new PackageInstaller({
    runtimeFactory: testRuntimeFactory(
      {
        managesResources: true,
        execute: async () => {
          executionCount += 1;
          return completedExecution(Buffer.alloc(0));
        },
      },
      {
        assemble: async () => {
          assemblyCount += 1;
          return {
            cleanupConfirmed: true,
            imageId: `sha256:${'c'.repeat(64)}`,
            receipt: { materialDigest: preparedMaterialDigests.at(-1)! },
          };
        },
        verifySealed: async () => {
          verificationCount += 1;
          if (!imageAvailable) {
            throw new Error('the retained image is unavailable');
          }
        },
      },
      async (owner, request) => {
        const input = preparedAssemblyInputFor(owner, request);
        preparedMaterialDigests.push(readPreparedAssemblyInput(owner, input).materialDigest);
      },
    ),
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const first = await installer.install({ sourceId: source.id, target: 'linux/arm64' });
    const second = await installer.install({ sourceId: source.id, target: 'linux/arm64' });

    assert.equal(first.record.buildInputDigest === null, false);
    assert.equal(first.record.buildOutputDigest, null);
    assert.equal(first.record.builderImageId, null);
    assert.equal(first.record.generatedDirectory, null);
    assert.equal(second.reusedExisting, true);
    assert.equal(assemblyCount, 1);
    assert.equal(executionCount, 0);
    assert.deepEqual(preparedMaterialDigests, [legacyRuntimeMaterialDigest]);
    const sealedReceipt = JSON.parse(await readFile(first.record.runtimeReceiptPath!, 'utf8')) as {
      receipt: { materialDigest: string };
    };
    assert.equal(sealedReceipt.receipt.materialDigest, legacyRuntimeMaterialDigest);
    // The newly published winner and the subsequent reuse each verify the
    // immutable receipt under their managed BuildAuthority sessions.
    assert.equal(verificationCount, 2);

    imageAvailable = false;
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /retained image is unavailable/,
    );
    imageAvailable = true;
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /synthetic-unverified build-session intent cannot authorize fresh recovery/,
    );
    assert.equal(assemblyCount, 1);
    assert.equal(executionCount, 0);
    assert.equal(
      verificationCount,
      3,
      'the retained-image failure leaves durable evidence that blocks a new provider call',
    );
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a session runtime factory failure retains the durable BuildAuthority intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-factory-failure-'));
  const sourceBytes = createNoBuildExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/runtime-factory-failure',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  let factoryCalls = 0;
  const installer = new PackageInstaller({
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    runtimeFactory: {
      create: async () => {
        factoryCalls += 1;
        throw new Error('the trusted runtime factory could not bind the session');
      },
    },
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      (error) => {
        assert.match(allErrorMessages(error), /could not bind the session/);
        assert.match(allErrorMessages(error), /did not provide failed-create settlement/);
        return true;
      },
    );
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /synthetic-unverified build-session intent cannot authorize fresh recovery/,
    );
    assert.equal(factoryCalls, 1);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('corrupt retained build material rejects reuse before any managed image verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-generated-corrupt-'));
  const sourceBytes = createExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/generated-corrupt',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  const output = createUstar([{ path: 'generated/result.txt', body: 'built offline' }]);
  let assemblyCount = 0;
  let executionCount = 0;
  let verificationCount = 0;
  const installer = new PackageInstaller({
    runtimeFactory: testRuntimeFactory(
      {
        managesResources: true,
        execute: async () => {
          executionCount += 1;
          return completedExecution(output);
        },
      },
      {
        assemble: async (request) => {
          assemblyCount += 1;
          return {
            cleanupConfirmed: true,
            imageId:
              request.purpose === 'builder'
                ? `sha256:${'d'.repeat(64)}`
                : `sha256:${'c'.repeat(64)}`,
            receipt: {},
          };
        },
        verifySealed: async () => {
          verificationCount += 1;
        },
      },
    ),
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const installed = await installer.install({ sourceId: source.id, target: 'linux/arm64' });
    assert.notEqual(installed.record.generatedDirectory, null);
    const outputDirectory = installed.record.generatedDirectory as string;
    const outputPath = join(outputDirectory, 'result.txt');
    const assemblyCountBeforeCorruption = assemblyCount;
    const verificationCountBeforeCorruption = verificationCount;
    await chmod(outputDirectory, 0o700);
    await chmod(outputPath, 0o644);
    await writeFile(outputPath, 'modified output');
    await chmod(outputPath, 0o444);
    await chmod(outputDirectory, 0o555);

    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /sealed generated file does not match its inventory/,
    );
    assert.equal(executionCount, 1);
    assert.equal(assemblyCount, assemblyCountBeforeCorruption);
    assert.equal(verificationCount, verificationCountBeforeCorruption);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a corrupt retained builder receipt rejects reuse before any managed image verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-builder-receipt-corrupt-'));
  const sourceBytes = createExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/builder-receipt-corrupt',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  const output = createUstar([{ path: 'generated/result.txt', body: 'built offline' }]);
  let assemblyCount = 0;
  let verificationCount = 0;
  const installer = new PackageInstaller({
    runtimeFactory: testRuntimeFactory(
      {
        managesResources: true,
        execute: async () => completedExecution(output),
      },
      {
        assemble: async (request) => {
          assemblyCount += 1;
          return {
            cleanupConfirmed: true,
            imageId:
              request.purpose === 'builder'
                ? `sha256:${'d'.repeat(64)}`
                : `sha256:${'c'.repeat(64)}`,
            receipt: {},
          };
        },
        verifySealed: async () => {
          verificationCount += 1;
        },
      },
    ),
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    const installed = await installer.install({ sourceId: source.id, target: 'linux/arm64' });
    const builderReceiptPath = installed.record.builderReceiptPath;
    assert.notEqual(builderReceiptPath, null);
    const verificationCountBeforeCorruption = verificationCount;
    const assemblyCountBeforeCorruption = assemblyCount;
    const builderReceiptDirectory = dirname(builderReceiptPath as string);
    await chmod(builderReceiptDirectory, 0o700);
    await chmod(builderReceiptPath as string, 0o600);
    const builderReceipt = JSON.parse(
      await readFile(builderReceiptPath as string, 'utf8'),
    ) as Record<string, unknown>;
    builderReceipt.candidateId = 'candidate-00000000-0000-4000-8000-000000000001';
    await writeFile(builderReceiptPath as string, `${JSON.stringify(builderReceipt)}\n`);
    await chmod(builderReceiptPath as string, 0o444);
    await chmod(builderReceiptDirectory, 0o555);

    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /not bound to its original seal/,
    );
    assert.equal(assemblyCount, assemblyCountBeforeCorruption);
    assert.equal(verificationCount, verificationCountBeforeCorruption);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a completed fresh retry reuses a fully sealed generated output tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-generated-retry-'));
  const sourceBytes = createExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/generated-retry',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  const output = createUstar([{ path: 'generated/result.txt', body: 'built offline' }]);
  let assemblyCount = 0;
  let executionCount = 0;
  const createInstaller = (): PackageInstaller =>
    new PackageInstaller({
      runtimeFactory: testRuntimeFactory(
        {
          managesResources: true,
          execute: async () => {
            executionCount += 1;
            return completedExecution(output);
          },
        },
        {
          assemble: async (request) => {
            assemblyCount += 1;
            return {
              cleanupConfirmed: true,
              imageId:
                request.purpose === 'builder'
                  ? `sha256:${'d'.repeat(64)}`
                  : `sha256:${'c'.repeat(64)}`,
              receipt: {},
            };
          },
          verifySealed: async () => undefined,
        },
      ),
      installerRoot: root,
      ownerId: 'operator-example',
      runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
      sources: new Map([[source.id, source]]),
      supportedEngineVersion: '0.1.0',
    });

  try {
    const first = await createInstaller().install({ sourceId: source.id, target: 'linux/arm64' });
    const generatedDirectory = first.record.generatedDirectory;
    assert.notEqual(generatedDirectory, null);

    // This represents an explicitly new install after the prior disabled
    // publication record was removed by an authorized lifecycle owner. The
    // immutable source and generated trees remain sealed and reusable.
    await rm(join(root, 'registry'), { force: true, recursive: true });
    const second = await createInstaller().install({ sourceId: source.id, target: 'linux/arm64' });

    assert.equal(second.record.generatedDirectory, generatedDirectory);
    assert.equal(executionCount, 2);
    assert.equal(assemblyCount, 4);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('the build authority serializes competing executable installs and preserves idempotence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-authority-'));
  const sourceBytes = createExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/executable-authority',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  const output = createUstar([{ path: 'generated/result.txt', body: 'built offline' }]);
  const buildStarted = deferred<void>();
  const allowBuildCompletion = deferred<void>();
  let executionCount = 0;
  const createInstaller = (): PackageInstaller =>
    new PackageInstaller({
      runtimeFactory: testRuntimeFactory(
        {
          managesResources: true,
          execute: async () => {
            executionCount += 1;
            buildStarted.resolve(undefined);
            await allowBuildCompletion.promise;
            return completedExecution(output);
          },
        },
        {
          assemble: async () => ({
            cleanupConfirmed: true,
            imageId: `sha256:${'c'.repeat(64)}`,
            receipt: {},
          }),
          verifySealed: async () => undefined,
        },
      ),
      installerRoot: root,
      ownerId: 'operator-example',
      runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
      sources: new Map([[source.id, source]]),
      supportedEngineVersion: '0.1.0',
    });
  const firstInstaller = createInstaller();
  const secondInstaller = createInstaller();
  let first: ReturnType<PackageInstaller['install']> | undefined;

  try {
    first = firstInstaller.install({ sourceId: source.id, target: 'linux/arm64' });
    await buildStarted.promise;
    await assert.rejects(
      secondInstaller.install({ sourceId: source.id, target: 'linux/arm64' }),
      /already in use/,
    );
    assert.equal(executionCount, 1);

    allowBuildCompletion.resolve(undefined);
    const installed = await first;
    const retried = await secondInstaller.install({ sourceId: source.id, target: 'linux/arm64' });
    assert.equal(retried.reusedExisting, true);
    assert.deepEqual(retried.record, installed.record);
    assert.equal(executionCount, 1);
  } finally {
    allowBuildCompletion.resolve(undefined);
    await first?.catch(() => undefined);
    await removeFixtureRoot(root);
  }
});

test('a cleanup-unknown build session blocks replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-cleanup-unknown-'));
  const sourceBytes = createExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/executable-cleanup-unknown',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  const output = createUstar([{ path: 'generated/result.txt', body: 'built offline' }]);
  let cleanupConfirmed = false;
  let executionCount = 0;
  const installer = new PackageInstaller({
    runtimeFactory: testRuntimeFactory(
      {
        managesResources: true,
        execute: async () => {
          executionCount += 1;
          return completedExecution(output, cleanupConfirmed);
        },
      },
      {
        assemble: async () => ({
          cleanupConfirmed: true,
          imageId: `sha256:${'c'.repeat(64)}`,
          receipt: {},
        }),
        verifySealed: async () => undefined,
      },
    ),
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /cleanup was not confirmed/,
    );
    cleanupConfirmed = true;
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /synthetic-unverified build-session intent cannot authorize fresh recovery/,
    );
    assert.equal(executionCount, 1);
  } finally {
    await removeFixtureRoot(root);
  }
});

test('a confirmed non-completed build rejects zero exit but retires its session for retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qdroid-package-runtime-stop-reason-'));
  const sourceBytes = createExecutablePackageBundle();
  const source: PackageSource = {
    expectedSha256: sha256(sourceBytes),
    id: 'catalog/executable-stop-reason',
    maxBytes: sourceBytes.byteLength,
    read: async () => sourceBytes,
  };
  const output = createUstar([{ path: 'generated/result.txt', body: 'built offline' }]);
  let reason: 'completed' | 'stopped' = 'stopped';
  let executions = 0;
  const installer = new PackageInstaller({
    runtimeFactory: testRuntimeFactory(
      {
        managesResources: true,
        execute: async () => {
          executions += 1;
          return completedExecution(output, true, 0, reason);
        },
      },
      {
        assemble: async () => ({
          cleanupConfirmed: true,
          imageId: `sha256:${'c'.repeat(64)}`,
          receipt: {},
        }),
        verifySealed: async () => undefined,
      },
    ),
    installerRoot: root,
    ownerId: 'operator-example',
    runtimeCatalog: new Map([['catalog/node-build-v1', trustedRuntimeCatalogEntry()]]),
    sources: new Map([[source.id, source]]),
    supportedEngineVersion: '0.1.0',
  });

  try {
    await assert.rejects(
      installer.install({ sourceId: source.id, target: 'linux/arm64' }),
      /did not exit zero/,
    );
    reason = 'completed';
    const retried = await installer.install({ sourceId: source.id, target: 'linux/arm64' });
    assert.equal(retried.reusedExisting, false);
    assert.equal(executions, 2);
  } finally {
    await removeFixtureRoot(root);
  }
});

function createPackageBundle(overrides: Record<string, unknown> = {}): Buffer {
  const manifest = JSON.stringify({
    assets: ['assets/notice.txt'],
    engineCompatibility: '>=0.1.0 <0.2.0',
    kind: 'application',
    license: 'Apache-2.0',
    name: 'qdroid/example',
    requestedCapabilities: [],
    requestedResources: defaultRequestedResources(),
    scenes: [],
    schema: 'qdroid.plugin/v0.1',
    skills: ['skills/example'],
    version: '0.1.0',
    ...overrides,
  });
  const preliminaryArchive = createUstar([
    { path: 'qdroid.plugin.json', body: manifest },
    { path: 'assets/notice.txt', body: 'frozen' },
    { path: 'skills/example/SKILL.md', body: '# Example\n' },
    { path: 'skills/example', type: 'directory' },
    { path: 'qdroid.lock.json', body: '{}' },
  ]);
  const inputDigest = inventoryDigest(
    readFrozenBundle(preliminaryArchive).entries.filter(
      (entry) => entry.path !== 'qdroid.lock.json',
    ),
  );
  const lock = JSON.stringify({ inputContentDigest: inputDigest, schema: 'qdroid.lock/v0.1' });
  return createUstar([
    { path: 'qdroid.plugin.json', body: manifest },
    { path: 'assets/notice.txt', body: 'frozen' },
    { path: 'skills/example/SKILL.md', body: '# Example\n' },
    { path: 'skills/example', type: 'directory' },
    { path: 'qdroid.lock.json', body: lock },
  ]);
}

function createGraphPackageBundle(
  options: Readonly<{
    assetBodies?: readonly Uint8Array[];
    build?: unknown;
    dependencies?: readonly {
      readonly name: string;
      readonly sourceId: string;
      readonly version: string;
    }[];
    gzipTransport?: boolean;
    manifestDependencies?: unknown;
    name?: string;
    omitDependencies?: boolean;
    version?: string;
  }> = {},
): Buffer {
  const dependencies = options.dependencies ?? [];
  const assetEntries = (options.assetBodies ?? []).map((body, index) => ({
    body,
    path: `assets/payload-${index}.bin`,
  }));
  const hasManifestDependencies = Object.hasOwn(options, 'manifestDependencies');
  const manifestDependencies = hasManifestDependencies
    ? options.manifestDependencies
    : dependencies;
  const manifest = JSON.stringify({
    assets: assetEntries.map((entry) => entry.path),
    ...(options.build === undefined ? {} : { build: options.build }),
    ...(options.omitDependencies ? {} : { dependencies: manifestDependencies }),
    engineCompatibility: '>=0.1.0 <0.2.0',
    kind: 'application',
    license: 'Apache-2.0',
    name: options.name ?? 'qdroid/graph-example',
    requestedCapabilities: [],
    requestedResources: defaultRequestedResources(),
    runtimeVariants: [],
    scenes: [],
    schema: 'qdroid.plugin/v0.2',
    skills: [],
    version: options.version ?? '1.0.0',
  });
  const preliminaryArchive = createUstar([
    { path: 'qdroid.plugin.json', body: manifest },
    ...assetEntries,
    { path: 'qdroid.lock.json', body: '{}' },
  ]);
  const preliminaryTransport = options.gzipTransport
    ? gzipSync(preliminaryArchive)
    : preliminaryArchive;
  const inputDigest = inventoryDigest(
    readFrozenBundle(preliminaryTransport).entries.filter(
      (entry) => entry.path !== 'qdroid.lock.json',
    ),
  );
  const canonicalDependencies = [...dependencies].sort(compareGraphDependencies);
  const lock = JSON.stringify({
    dependencies: canonicalDependencies,
    inputContentDigest: inputDigest,
    schema: 'qdroid.lock/v0.2',
  });
  const archive = createUstar([
    { path: 'qdroid.plugin.json', body: manifest },
    ...assetEntries,
    { path: 'qdroid.lock.json', body: lock },
  ]);
  return options.gzipTransport ? gzipSync(archive) : archive;
}

function createSizedGraphChain(
  prefix: string,
  edgeCount: number,
  assetBodies: readonly Uint8Array[],
  gzipTransport: boolean,
): Readonly<{ bundles: ReadonlyMap<string, Buffer>; rootSourceId: string }> {
  const bundles = new Map<string, Buffer>();
  let dependency:
    | Readonly<{
        name: string;
        sourceId: string;
        version: string;
      }>
    | undefined;
  for (let index = edgeCount; index >= 0; index -= 1) {
    const name = `qdroid/${prefix}-${index}`;
    const sourceId = `catalog/${prefix}-${index}`;
    const archive = createGraphPackageBundle({
      assetBodies,
      ...(dependency === undefined ? {} : { dependencies: [dependency] }),
      gzipTransport,
      name,
      version: '1.0.0',
    });
    bundles.set(sourceId, archive);
    dependency = Object.freeze({ name, sourceId, version: '1.0.0' });
  }
  return Object.freeze({ bundles, rootSourceId: `catalog/${prefix}-0` });
}

function createMixedEntropyPayload(byteLength: number): Buffer {
  const payload = Buffer.alloc(byteLength);
  const blockBytes = 32 * 1024;
  const randomBytesPerBlock = 3 * 1024;
  let state = 0x6d2b79f5;
  for (let offset = 0; offset < payload.byteLength; offset += blockBytes) {
    const end = Math.min(offset + randomBytesPerBlock, payload.byteLength);
    for (let index = offset; index < end; index += 1) {
      state = Math.imul(state ^ (state >>> 15), 1 | state);
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
      payload[index] = (state ^ (state >>> 14)) & 0xff;
    }
  }
  return payload;
}

function createGraphChain(
  prefix: string,
  edgeCount: number,
): Readonly<{ bundles: ReadonlyMap<string, Buffer>; rootSourceId: string }> {
  const bundles = new Map<string, Buffer>();
  let dependency:
    | Readonly<{
        name: string;
        sourceId: string;
        version: string;
      }>
    | undefined;
  for (let index = edgeCount; index >= 0; index -= 1) {
    const name = `qdroid/${prefix}-${index}`;
    const sourceId = `catalog/${prefix}-${index}`;
    bundles.set(
      sourceId,
      createGraphPackageBundle({
        ...(dependency === undefined ? {} : { dependencies: [dependency] }),
        name,
        version: '1.0.0',
      }),
    );
    dependency = Object.freeze({ name, sourceId, version: '1.0.0' });
  }
  return Object.freeze({ bundles, rootSourceId: `catalog/${prefix}-0` });
}

function graphSources(
  bundles: ReadonlyMap<string, Buffer>,
  reads: Map<string, number>,
): ReadonlyMap<string, PackageSource> {
  return new Map(
    [...bundles.entries()].map(([sourceId, bundle]) => [
      sourceId,
      graphSource(sourceId, bundle, reads),
    ]),
  );
}

function graphSource(id: string, bundle: Buffer, reads: Map<string, number>): PackageSource {
  return {
    expectedSha256: sha256(bundle),
    id,
    maxBytes: bundle.byteLength,
    read: async (request) => {
      assert.ok(request !== undefined, 'graph resolution must use the bounded source read request');
      assert.ok(request.maxBytes >= bundle.byteLength);
      assert.equal(request.signal.aborted, false);
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return Buffer.from(bundle);
    },
  };
}

function compareGraphDependencies(
  left: Readonly<{ name: string; version: string }>,
  right: Readonly<{ name: string; version: string }>,
): number {
  if (left.name < right.name) {
    return -1;
  }
  if (left.name > right.name) {
    return 1;
  }
  if (left.version < right.version) {
    return -1;
  }
  if (left.version > right.version) {
    return 1;
  }
  return 0;
}

function createExecutablePackageBundle(
  runtimeOverrides: Record<string, unknown> = {},
  exports: readonly string[] = ['generated/result.txt'],
): Buffer {
  const manifest = JSON.stringify({
    assets: [],
    build: {
      argv: ['/usr/bin/node', '/opt/build.js'],
      cwd: '.',
      exports,
      schema: 'qdroid.build/stdout-ustar-v1',
    },
    engineCompatibility: '>=0.1.0 <0.2.0',
    entrypoint: { executable: '/opt/qdroid/entrypoint', type: 'command' },
    kind: 'tool',
    license: 'Apache-2.0',
    name: 'qdroid/executable-example',
    requestedCapabilities: [],
    requestedResources: defaultRequestedResources(),
    runtimeVariants: [
      {
        abi: 'glibc-2.39',
        baseCatalogId: 'catalog/node-build-v1',
        image: `sha256:${'a'.repeat(64)}`,
        platform: 'linux/arm64',
        requiredFeatures: [],
        requiredProfile: 'build-restricted',
        ...runtimeOverrides,
      },
    ],
    scenes: [],
    schema: 'qdroid.plugin/v0.1',
    skills: [],
    version: '0.1.0',
  });
  const preliminaryArchive = createUstar([
    { path: 'qdroid.plugin.json', body: manifest },
    { path: 'qdroid.lock.json', body: '{}' },
  ]);
  const inputDigest = inventoryDigest(
    readFrozenBundle(preliminaryArchive).entries.filter(
      (entry) => entry.path !== 'qdroid.lock.json',
    ),
  );
  const lock = JSON.stringify({ inputContentDigest: inputDigest, schema: 'qdroid.lock/v0.1' });
  return createUstar([
    { path: 'qdroid.plugin.json', body: manifest },
    { path: 'qdroid.lock.json', body: lock },
  ]);
}

function deterministicAsciiBody(length: number, seed: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const body = Buffer.allocUnsafe(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    body[index] = alphabet.charCodeAt((state >>> 24) & 0x3f);
  }
  return body.toString('ascii');
}

function createNoBuildExecutablePackageBundle(): Buffer {
  return createPackageBundle({
    assets: [],
    entrypoint: { executable: '/opt/qdroid/entrypoint', type: 'command' },
    kind: 'tool',
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
    skills: [],
  });
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function allErrorMessages(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause === undefined ? [] : [allErrorMessages(error.cause)];
  if (error instanceof AggregateError) {
    return [
      error.message,
      ...[...error.errors].map((item) => allErrorMessages(item)),
      ...cause,
    ].join('\n');
  }
  return [error.message, ...cause].join('\n');
}

function defaultRequestedResources(): Record<string, number> {
  return {
    deadlineMs: 30_000,
    memoryMiB: 256,
    outputBytes: 1_048_576,
    pids: 32,
    scratchMiB: 64,
  };
}

function trustedRuntimeCatalogEntry(
  overrides: Partial<TrustedImageCatalogEntry> = {},
): TrustedImageCatalogEntry {
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
    ...overrides,
  };
}

function testRuntimeFactory(
  buildExecutor: TrustedBuildExecutor,
  imageAssembler: TrustedImageAssembler,
  beforeAssemble?: (owner: BuildSessionOwner, request: ImageAssemblyRequest) => Promise<void>,
): TrustedRuntimeFactory {
  return {
    create: async (owner) => ({
      buildExecutor,
      close: async () => undefined,
      imageAssembler:
        beforeAssemble === undefined
          ? imageAssembler
          : {
              assemble: async (request) => {
                await beforeAssemble(owner, request);
                return imageAssembler.assemble(request);
              },
              verifySealed: imageAssembler.verifySealed,
            },
    }),
  };
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

function completedExecution(
  output: Uint8Array,
  cleanupConfirmed = true,
  exitCode: number | null = 0,
  reason: 'completed' | 'deadline' | 'guardian-lost' | 'output-limit' | 'stopped' = 'completed',
): {
  completion: Promise<{
    cleanupConfirmed: boolean;
    exitCode: number | null;
    reason: 'completed' | 'deadline' | 'guardian-lost' | 'output-limit' | 'stopped';
  }>;
  stderr: AsyncIterable<Uint8Array>;
  stdout: AsyncIterable<Uint8Array>;
} {
  return {
    completion: Promise.resolve({ cleanupConfirmed, exitCode, reason }),
    stderr: chunks([]),
    stdout: chunks([output]),
  };
}

async function removeFixtureRoot(path: string): Promise<void> {
  await makeFixtureTreeWritable(path);
  await rm(path, { force: true, maxRetries: 3, recursive: true, retryDelay: 25 });
}

async function assertNoPublishedRegistryRows(root: string): Promise<void> {
  const registry = new DatabaseSync(join(root, 'registry', 'registry.sqlite'));
  try {
    const row = registry
      .prepare('SELECT COUNT(*) AS count FROM package_versions')
      .get() as unknown as {
      count: number;
    };
    assert.equal(row.count, 0);
  } finally {
    registry.close();
  }
}

async function awaitConcurrentInstallSettlement(
  settlement: Promise<readonly PromiseSettledResult<InstallResult>[]>,
  timeoutMs: number,
): Promise<readonly PromiseSettledResult<InstallResult>[]> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settlement,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Concurrent content publication did not settle within the diagnostic ${timeoutMs} ms deadline.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

interface PublicationAuthorityHolder {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  readonly ready: Promise<void>;
  readonly stderr: readonly Buffer[];
}

interface PublicationCrashPublisher {
  readonly child: ChildProcessWithoutNullStreams;
  readonly close: Promise<void>;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  readonly renamed: Promise<void>;
  readonly stderr: readonly Buffer[];
}

function startPublicationCrashPublisher(
  root: string,
  source: PackageSource,
  bundle: Uint8Array,
  pauseMode: 'crash' | 'release' = 'crash',
): PublicationCrashPublisher {
  const childPath = new URL('./publication-crash-child.js', import.meta.url).pathname;
  const child = spawn(process.execPath, [childPath], {
    env: {
      ...process.env,
      QDROID_PUBLICATION_CRASH_BUNDLE: Buffer.from(bundle).toString('base64'),
      QDROID_PUBLICATION_CRASH_PAUSE_MODE: pauseMode,
      QDROID_PUBLICATION_CRASH_ROOT: root,
      QDROID_PUBLICATION_CRASH_SOURCE_ID: source.id,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  let stdout = '';
  let resolveRenamed: (() => void) | undefined;
  let rejectRenamed: ((error: Error) => void) | undefined;
  const renamed = new Promise<void>((resolve, reject) => {
    resolveRenamed = resolve;
    rejectRenamed = reject;
  });
  const close = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', (error) => {
        rejectRenamed?.(error);
        reject(error);
      });
      child.once('exit', async (code, signal) => {
        if (!stdout.includes('renamed\n')) {
          rejectRenamed?.(
            new Error(
              `The publication crash fixture exited before renaming content: ${String(code)} ${String(signal)} ${Buffer.concat(stderr).toString('utf8')}`,
            ),
          );
        }
        await close;
        resolve({ code, signal });
      });
    },
  );
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (stdout.includes('renamed\n')) {
      resolveRenamed?.();
    }
  });
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  return Object.freeze({ child, close, exit, renamed, stderr });
}

async function terminatePublicationCrashPublisher(
  publisher: PublicationCrashPublisher,
): Promise<void> {
  if (publisher.child.exitCode === null && publisher.child.signalCode === null) {
    publisher.child.kill('SIGKILL');
  }
  await awaitWithin(publisher.exit, 2_000, 'publication crash fixture termination');
}

function rejectedSettlementReasons<T>(
  settlements: readonly PromiseSettledResult<T>[],
): readonly unknown[] {
  return settlements.flatMap((settlement) =>
    settlement.status === 'rejected' ? [settlement.reason] : [],
  );
}

function appendTestFailure(current: unknown, next: unknown): unknown {
  if (current === undefined) {
    return next;
  }
  return aggregateTestFailures(
    [current, next],
    'The publication test cleanup reported multiple independent failures.',
  );
}

function aggregateTestFailures(failures: readonly unknown[], message: string): unknown {
  const distinctFailures = failures.filter(
    (failure, index) => failure !== undefined && failures.indexOf(failure) === index,
  );
  if (distinctFailures.length === 0) {
    return undefined;
  }
  if (distinctFailures.length === 1) {
    return distinctFailures[0];
  }
  return new AggregateError(distinctFailures, message);
}

function throwTestFailures(
  primaryFailure: unknown,
  cleanupFailure: unknown,
  settlementFailures: readonly unknown[] = [],
): void {
  const failures = [primaryFailure, ...settlementFailures, cleanupFailure];
  const result = aggregateTestFailures(failures, 'The publication test and cleanup both failed.');
  if (result !== undefined) {
    throw result;
  }
}

function startPublicationAuthorityHolder(root: string): PublicationAuthorityHolder {
  const childPath = new URL('./publication-authority-holder.js', import.meta.url).pathname;
  const child = spawn(process.execPath, [childPath], {
    env: { ...process.env, QDROID_PUBLICATION_HOLDER_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  let stdout = '';
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (!stdout.includes('ready\n')) {
          rejectReady?.(
            new Error(
              `The content publication authority holder exited before readiness: ${String(code)} ${String(signal)} ${Buffer.concat(stderr).toString('utf8')}`,
            ),
          );
        }
        resolve({ code, signal });
      });
    },
  );
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (stdout.includes('ready\n')) {
      resolveReady?.();
    }
  });
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.once('error', (error) => rejectReady?.(error));
  return Object.freeze({ child, exit, ready, stderr });
}

async function releasePublicationAuthorityHolder(
  holder: PublicationAuthorityHolder,
): Promise<void> {
  if (holder.child.exitCode === null && holder.child.signalCode === null) {
    holder.child.stdin.end();
  }
  const exit = await awaitWithin(holder.exit, 2_000, 'content publication authority holder exit');
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(
      `The content publication authority holder did not exit cleanly: ${String(exit.code)} ${String(exit.signal)} ${Buffer.concat(holder.stderr).toString('utf8')}`,
    );
  }
}

async function settlePublicationAuthorityHolder(holder: PublicationAuthorityHolder): Promise<void> {
  try {
    await releasePublicationAuthorityHolder(holder);
  } catch (error) {
    if (holder.child.exitCode === null && holder.child.signalCode === null) {
      holder.child.kill('SIGTERM');
      await awaitWithin(
        holder.exit,
        2_000,
        'owned content publication authority holder termination',
      );
    }
    throw error;
  }
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

async function describeConcurrentContentDestinations(
  root: string,
  packageDigests: readonly string[],
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  return Promise.all(
    packageDigests.flatMap((packageDigest) => {
      const contentDirectory = join(root, 'content', packageDigest);
      return [
        describeConcurrentPublicationPath('content', contentDirectory),
        describeConcurrentPublicationPath(
          'inputInventory',
          `${contentDirectory}.input-inventory.json`,
        ),
        describeConcurrentPublicationPath(
          'materializedInventory',
          `${contentDirectory}.inventory.json`,
        ),
        describeConcurrentPublicationPath('readiness', `${contentDirectory}.ready.json`),
      ];
    }),
  );
}

async function describeConcurrentPublicationPath(
  label: string,
  path: string,
): Promise<Readonly<Record<string, unknown>>> {
  const status = await lstat(path).catch(() => undefined);
  if (status === undefined) {
    return Object.freeze({ label, path, state: 'missing' });
  }
  const mode = status.mode & 0o777;
  if (status.isFile()) {
    const bytes = await readFile(path);
    return Object.freeze({
      byteLength: bytes.byteLength,
      digest: sha256(bytes),
      label,
      mode,
      path,
      type: 'file',
    });
  }
  if (status.isDirectory()) {
    const entries = await readdir(path);
    return Object.freeze({ label, mode, path, entries: entries.sort(), type: 'directory' });
  }
  return Object.freeze({ label, mode, path, type: 'other' });
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

async function* chunks(values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield value;
  }
}

import { createHash } from 'node:crypto';

import { createUstarFixture as createUstar } from '../../../fixtures/packages/src/ustar-fixture.js';
import { readFrozenBundle } from '../../../packages/package-runtime/src/archive.js';
import {
  inventoryDigest,
  PackageInstaller,
  type PackageSource,
} from '../../../packages/package-runtime/src/index.js';

const root = process.env.QDROID_PUBLICATION_CHILD_ROOT;
if (root === undefined) {
  throw new Error('QDROID_PUBLICATION_CHILD_ROOT is required for the publication authority child.');
}

const leaf = createGraphPackageBundle({ name: 'qdroid/leaf' });
const rootBundle = createGraphPackageBundle({
  dependencies: [{ name: 'qdroid/leaf', sourceId: 'catalog/leaf', version: '1.0.0' }],
  name: 'qdroid/root',
});
const sources = new Map<string, PackageSource>([
  ['catalog/root', source('catalog/root', rootBundle)],
  ['catalog/leaf', source('catalog/leaf', leaf)],
]);
const installer = new PackageInstaller({
  installerRoot: root,
  ownerId: 'operator-example',
  runtimeCatalog: new Map(),
  sources,
  supportedEngineVersion: '0.1.0',
});
const result = await installer.install({ sourceId: 'catalog/root', target: 'content-only' });
process.stdout.write(`${JSON.stringify(result)}\n`);

function source(id: string, bundle: Buffer): PackageSource {
  return {
    expectedSha256: sha256(bundle),
    id,
    maxBytes: bundle.byteLength,
    read: async () => Buffer.from(bundle),
  };
}

function createGraphPackageBundle(options: {
  readonly dependencies?: readonly {
    readonly name: string;
    readonly sourceId: string;
    readonly version: string;
  }[];
  readonly name: string;
}): Buffer {
  const dependencies = options.dependencies ?? [];
  const manifest = JSON.stringify({
    assets: [],
    dependencies,
    engineCompatibility: '>=0.1.0 <0.2.0',
    kind: 'application',
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
    runtimeVariants: [],
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
  const lock = JSON.stringify({
    dependencies,
    inputContentDigest,
    schema: 'qdroid.lock/v0.2',
  });
  return createUstar([
    { body: manifest, path: 'qdroid.plugin.json' },
    { body: lock, path: 'qdroid.lock.json' },
  ]);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

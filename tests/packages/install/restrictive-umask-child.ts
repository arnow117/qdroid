import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { createUstarFixture as createUstar } from '../../../fixtures/packages/src/ustar-fixture.js';
import { readFrozenBundle } from '../../../packages/package-runtime/src/archive.js';
import {
  inventoryDigest,
  PackageInstaller,
  type PackageSource,
} from '../../../packages/package-runtime/src/index.js';

const root = process.env.QDROID_RESTRICTIVE_UMASK_ROOT;
if (root === undefined) {
  throw new Error('QDROID_RESTRICTIVE_UMASK_ROOT is required for the restrictive umask child.');
}

process.umask(0o077);
const sourceBytes = createContentOnlyBundle();
const source: PackageSource = {
  expectedSha256: sha256(sourceBytes),
  id: 'catalog/restrictive-umask',
  maxBytes: sourceBytes.byteLength,
  read: async () => sourceBytes,
};
const installer = new PackageInstaller({
  installerRoot: root,
  ownerId: 'operator-example',
  runtimeCatalog: new Map(),
  sources: new Map([[source.id, source]]),
  supportedEngineVersion: '0.1.0',
});
const installed = await installer.install({ sourceId: source.id, target: 'content-only' });
const reused = await installer.install({ sourceId: source.id, target: 'content-only' });
const paths = [
  installed.record.contentDirectory,
  join(installed.record.contentDirectory, 'assets'),
  join(installed.record.contentDirectory, 'assets', 'notice.txt'),
  join(installed.record.contentDirectory, 'skills', 'example'),
  join(installed.record.contentDirectory, 'skills', 'example', 'SKILL.md'),
  installed.record.inputInventoryPath,
  `${installed.record.contentDirectory}.inventory.json`,
  `${installed.record.contentDirectory}.ready.json`,
];
const modes = await Promise.all(
  paths.map(async (path) => ({ mode: (await lstat(path)).mode & 0o777, path })),
);
process.stdout.write(`${JSON.stringify({ modes, reusedExisting: reused.reusedExisting })}\n`);

function createContentOnlyBundle(): Buffer {
  const manifest = JSON.stringify({
    assets: ['assets/notice.txt'],
    engineCompatibility: '>=0.1.0 <0.2.0',
    kind: 'application',
    license: 'Apache-2.0',
    name: 'qdroid/example',
    requestedCapabilities: [],
    requestedResources: {
      deadlineMs: 30_000,
      memoryMiB: 256,
      outputBytes: 1_048_576,
      pids: 32,
      scratchMiB: 64,
    },
    scenes: [],
    schema: 'qdroid.plugin/v0.1',
    skills: ['skills/example'],
    version: '0.1.0',
  });
  const preliminary = createUstar([
    { body: manifest, path: 'qdroid.plugin.json' },
    { body: 'frozen', path: 'assets/notice.txt' },
    { body: '# Example\n', path: 'skills/example/SKILL.md' },
    { path: 'skills/example', type: 'directory' },
    { body: '{}', path: 'qdroid.lock.json' },
  ]);
  const inputContentDigest = inventoryDigest(
    readFrozenBundle(preliminary).entries.filter((entry) => entry.path !== 'qdroid.lock.json'),
  );
  return createUstar([
    { body: manifest, path: 'qdroid.plugin.json' },
    { body: 'frozen', path: 'assets/notice.txt' },
    { body: '# Example\n', path: 'skills/example/SKILL.md' },
    { path: 'skills/example', type: 'directory' },
    {
      body: JSON.stringify({ inputContentDigest, schema: 'qdroid.lock/v0.1' }),
      path: 'qdroid.lock.json',
    },
  ]);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

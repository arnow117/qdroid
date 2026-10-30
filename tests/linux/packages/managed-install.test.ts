import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createUstarFixture as createUstar } from '../../../fixtures/packages/src/ustar-fixture.js';
import { readFrozenBundle } from '../../../packages/package-runtime/src/archive.js';
import {
  inventoryDigest,
  PackageInstaller,
  type PackageSource,
  type TrustedImageCatalogEntry,
} from '../../../packages/package-runtime/src/index.js';
import { OciSessionBoundRuntimeFactory } from '../../../packages/runtime-oci/src/index.js';

const image = process.env.QDROID_T004_IMAGE;
const SOURCE_ID = 'fixture/managed-production-assembly/v0.1';

test(
  'the production session factory assembles and verifies a managed retained image',
  { skip: image === undefined, timeout: 60_000 },
  async (t) => {
    const trustedImage = requireTrustedImage(image);

    const root = await mkdtemp(join(tmpdir(), 'qdroid-t005-managed-install-'));
    let completed = false;

    try {
      const source = managedAssemblySource(trustedImage);
      const catalog = runtimeCatalog(trustedImage);
      const installer = new PackageInstaller({
        installerRoot: root,
        ownerId: 'trusted-managed-linux-assembly',
        runtimeCatalog: new Map([[catalog.id, catalog]]),
        runtimeFactory: new OciSessionBoundRuntimeFactory({
          ownerStorePath: join(root, 'owner-store'),
        }),
        sources: new Map([[source.id, source]]),
        supportedEngineVersion: '0.1.0',
      });

      const initial = await installer.install({ sourceId: source.id, target: 'linux/arm64' });
      assert.equal(initial.reusedExisting, false);
      assert.match(initial.record.imageId ?? '', /^sha256:[0-9a-f]{64}$/);
      assert.equal(
        await readFile(join(initial.record.contentDirectory, 'src', 'payload.txt'), 'utf8'),
        'frozen managed assembly source\n',
      );
      assert.equal(
        await readFile(join(initial.record.contentDirectory, 'host-hook-never-run'), 'utf8'),
        '#!/bin/sh\nexit 99\n',
      );

      const runtimeSessionsDirectory = join(root, 'build-authority', 'runtime-sessions');
      const [candidateId] = await readdir(runtimeSessionsDirectory);
      assert.match(candidateId ?? '', /^candidate-[0-9a-f-]+$/);
      const journal = JSON.parse(
        await readFile(
          join(
            runtimeSessionsDirectory,
            candidateId as string,
            `${candidateId}.native-resources.json`,
          ),
          'utf8',
        ),
      ) as {
        readonly authenticationTag: string;
        readonly sessionId: string;
      };
      assert.equal(journal.sessionId, candidateId);
      assert.match(journal.authenticationTag, /^[a-f0-9]{64}$/);

      const terminal = JSON.parse(
        await readFile(
          join(root, 'build-authority', 'provider-terminals', `${candidateId}.json`),
          'utf8',
        ),
      ) as {
        readonly candidateId: string;
        readonly journalAuthenticationTag: string;
        readonly sessionId: string;
      };
      assert.equal(terminal.candidateId, candidateId);
      assert.equal(terminal.sessionId, candidateId);
      assert.equal(terminal.journalAuthenticationTag, journal.authenticationTag);

      const repeated = await installer.install({ sourceId: source.id, target: 'linux/arm64' });
      assert.equal(repeated.reusedExisting, true);
      assert.equal(repeated.record.imageId, initial.record.imageId);
      assert.equal(repeated.record.runtimeReceiptPath, initial.record.runtimeReceiptPath);

      completed = true;
    } finally {
      if (completed) {
        await removeFixtureRoot(root);
      } else {
        t.diagnostic(`Retained managed assembly test state: ${root}`);
      }
    }
  },
);

function managedAssemblySource(trustedImage: string): PackageSource {
  const transport = createNoBuildPackageBundle(trustedImage);
  const archive = readFrozenBundle(transport);

  return Object.freeze({
    expectedSha256: archive.transportDigest,
    id: SOURCE_ID,
    maxBytes: archive.transport.byteLength,
    read: async () => Buffer.from(archive.transport),
  });
}

function requireTrustedImage(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('QDROID_T004_IMAGE is required for managed Linux assembly.');
  }
  return value;
}

function createNoBuildPackageBundle(trustedImage: string): Buffer {
  const manifest = JSON.stringify({
    assets: [],
    engineCompatibility: '>=0.1.0 <0.2.0',
    entrypoint: { executable: '/opt/qdroid/entrypoint', type: 'command' },
    kind: 'tool',
    license: 'Apache-2.0',
    name: 'qdroid/managed-production-assembly',
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
        abi: 'glibc-2.35',
        baseCatalogId: 'catalog/managed-production-assembly-v1',
        image: trustedImage,
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
  const files = [
    { body: '#!/bin/sh\nexit 99\n', executable: true, path: 'host-hook-never-run' },
    { body: manifest, path: 'qdroid.plugin.json' },
    { body: 'frozen managed assembly source\n', path: 'src/payload.txt' },
  ] as const;
  const preliminary = createUstar([...files, { body: '{}', path: 'qdroid.lock.json' }]);
  const inputContentDigest = inventoryDigest(
    readFrozenBundle(preliminary).entries.filter((entry) => entry.path !== 'qdroid.lock.json'),
  );

  return createUstar([
    ...files,
    {
      body: JSON.stringify({ inputContentDigest, schema: 'qdroid.lock/v0.1' }),
      path: 'qdroid.lock.json',
    },
  ]);
}

function runtimeCatalog(trustedImage: string): TrustedImageCatalogEntry {
  return Object.freeze({
    abi: 'glibc-2.35',
    baseImage: trustedImage,
    builderImage: trustedImage,
    features: Object.freeze([]),
    id: 'catalog/managed-production-assembly-v1',
    platform: 'linux/arm64',
    profile: 'build-restricted',
    templateDigest: createHash('sha256').update('managed-assembly-template').digest('hex'),
    toolchainDigest: createHash('sha256').update('managed-assembly-toolchain').digest('hex'),
  });
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

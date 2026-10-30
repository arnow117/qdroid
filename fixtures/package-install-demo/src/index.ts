import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PackageInstaller,
  inventoryDigest,
  type DisabledInstallationRecord,
  type PackageSource,
  type TrustedImageCatalogEntry,
  type TrustedRuntimeFactory,
} from '../../../packages/package-runtime/src/index.js';
import { readFrozenBundle } from '../../../packages/package-runtime/src/archive.js';
import { OciSessionBoundRuntimeFactory } from '../../../packages/runtime-oci/src/index.js';
import { createUstarFixture, type UstarFixtureEntry } from '../../packages/src/ustar-fixture.js';
import { preparePrivateReferenceNodeState } from './reference-node-root.js';

export const PACKAGE_INSTALL_DEMO_SOURCE_ID = 'fixture/package-install-demo/v0.1';

const CONTENT_ASSET_PATH = 'assets/notice.txt';
const CONTENT_ASSET = 'Trusted package-install-demo content asset.\n';
const CONTENT_SKILL_PATH = 'skills/package-install-demo/SKILL.md';
const CONTENT_SKILL =
  '# Package install demo\n\nThis Skill is frozen with the trusted content fixture.\n';
const EXECUTABLE_RESULT_PATH = 'generated/result.txt';
const EXECUTABLE_RESULT = 'trusted package-install-demo build result\n';
const EXECUTABLE_OUTPUT = createUstarFixture([
  { body: EXECUTABLE_RESULT, path: EXECUTABLE_RESULT_PATH },
]);
const EXECUTABLE_OUTPUT_BASE64 = EXECUTABLE_OUTPUT.toString('base64');
const REFERENCE_CATALOG_ID = 'qdroid.package-install-demo.ubuntu22-node24/v1';
// SHA-256 of qdroid.package-install-demo/assembly-template/ubuntu22.04/linux-arm64/build-restricted/v1.
const REFERENCE_TEMPLATE_DIGEST =
  'd8554e8ee033b3ec65957a7470f68c1224d698f0d3f5655c68f0ff51f238089e';
// SHA-256 of qdroid.package-install-demo/toolchain/node-24.16.0/glibc-2.35/build-stdout-ustar-v1.
const REFERENCE_TOOLCHAIN_DIGEST =
  'f6f85f82888fb6141ca76d8981393028114a154a64fc48db301239a508c4474a';
const TRUSTED_OWNER_ID = 'qdroid-package-install-demo';
const TRUSTED_IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const REFERENCE_NODE_ROOT_PARENT = '/var/tmp';
const REFERENCE_NODE_ROOT_PREFIX = 'qdroid-package-install-demo-reference-node-uid-';

export type PackageInstallDemoFixture = 'content' | 'executable';

export interface PackageInstallDemoOptions {
  readonly fixture: PackageInstallDemoFixture;
  readonly image?: string;
  /** Trusted fixture seam; the CLI never exposes it as an argument. */
  readonly runtimeFactory?: TrustedRuntimeFactory;
  /**
   * Test-only permission for the typed Mock runtime seam to exercise the fixed
   * Linux package definition on a non-Linux or non-ARM64 host. It is invalid
   * without `runtimeFactory`, and the CLI never supplies it.
   */
  readonly testOnlyAllowUnsupportedPlatform?: true;
}

export interface PackageInstallDemoReport {
  readonly executionScope: string;
  readonly fixture: PackageInstallDemoFixture;
  readonly initial: DemoInstallRecord;
  readonly repeat: DemoInstallRecord;
  readonly retainedStateRoot: string;
  readonly status: 'installed-disabled';
  readonly verified: readonly string[];
}

export interface DemoInstallRecord {
  readonly buildOutputDigest: string | null;
  readonly builderImageId: string | null;
  readonly imageId: string | null;
  readonly installationId: string;
  readonly packageDigest: string;
  readonly resolvedLockDigest: string | null;
  readonly reusedExisting: boolean;
  readonly versionRecordId: string;
}

export class PackageInstallDemoError extends Error {
  public constructor(
    readonly category: 'content' | 'runtime',
    readonly retainedStateRoot: string,
    cause: unknown,
  ) {
    super(`The trusted package-install-demo ${category} phase failed.`, { cause });
    this.name = 'PackageInstallDemoError';
  }
}

export async function runPackageInstallDemo(
  options: PackageInstallDemoOptions,
): Promise<PackageInstallDemoReport> {
  const validated = validateDemoOptions(options);
  const productionReferenceNode = describeProductionReferenceNode(validated);
  const stateRoot =
    productionReferenceNode?.root ??
    (await mkdtemp(join(tmpdir(), 'qdroid-package-install-demo-')));

  try {
    const referenceNodeState =
      productionReferenceNode === undefined
        ? undefined
        : await preparePrivateReferenceNodeState(stateRoot, productionReferenceNode.uid);
    const installerRoot = referenceNodeState?.installerRoot ?? join(stateRoot, 'installer');
    const ownerStorePath = referenceNodeState?.ownerStorePath ?? join(stateRoot, 'owner-store');
    const source = createPackageInstallDemoSource(validated.fixture, validated.image);
    const runtimeCatalog = createRuntimeCatalog(validated.fixture, validated.image);
    const runtimeFactory =
      validated.runtimeFactory ?? new OciSessionBoundRuntimeFactory({ ownerStorePath });
    const installer = new PackageInstaller({
      installerRoot,
      ownerId: TRUSTED_OWNER_ID,
      runtimeCatalog,
      runtimeFactory,
      sources: new Map([[source.id, source]]),
      supportedEngineVersion: '0.1.0',
    });
    const target = validated.fixture === 'content' ? 'content-only' : 'linux/arm64';
    const initial = await installer.install({ sourceId: source.id, target });
    const repeat = await installer.install({ sourceId: source.id, target });

    if (productionReferenceNode === undefined) {
      assert.equal(initial.reusedExisting, false);
    }
    assert.equal(repeat.reusedExisting, true);
    assert.deepEqual(repeat.record, initial.record);
    assert.equal(initial.record.status, 'installed-disabled');

    const verified =
      validated.fixture === 'content'
        ? await verifyContentFixture(initial.record)
        : await verifyExecutableFixture(initial.record);

    return Object.freeze({
      executionScope:
        validated.fixture === 'content'
          ? 'trusted host package-content fixture; no sandbox workload, application activation, or grant'
          : 'trusted fixed Linux ARM64 package fixture with shared per-user reference-node state; runtime qualification remains required before execution',
      fixture: validated.fixture,
      initial: summarizeRecord(initial.reusedExisting, initial.record),
      repeat: summarizeRecord(repeat.reusedExisting, repeat.record),
      retainedStateRoot: stateRoot,
      status: initial.record.status,
      verified,
    });
  } catch (error) {
    const category = validated.fixture === 'content' ? 'content' : 'runtime';
    throw new PackageInstallDemoError(category, stateRoot, error);
  }
}

interface ProductionReferenceNode {
  readonly root: string;
  readonly uid: number;
}

function describeProductionReferenceNode(
  options: ValidatedPackageInstallDemoOptions,
): ProductionReferenceNode | undefined {
  if (options.fixture !== 'executable' || options.runtimeFactory !== undefined) {
    return undefined;
  }

  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('The executable package-install-demo requires a host user identity.');
  }
  return Object.freeze({
    root: productionReferenceNodeRootForUid(uid),
    uid,
  });
}

export function productionReferenceNodeRootForUid(uid: number): string {
  return join(REFERENCE_NODE_ROOT_PARENT, `${REFERENCE_NODE_ROOT_PREFIX}${uid}`);
}

interface ValidatedPackageInstallDemoOptions {
  readonly fixture: PackageInstallDemoFixture;
  readonly image: string | undefined;
  readonly runtimeFactory: TrustedRuntimeFactory | undefined;
}

function validateDemoOptions(
  options: PackageInstallDemoOptions,
): ValidatedPackageInstallDemoOptions {
  const candidate = options as {
    readonly fixture?: unknown;
    readonly image?: unknown;
    readonly runtimeFactory?: unknown;
    readonly testOnlyAllowUnsupportedPlatform?: unknown;
  };
  const fixture = candidate.fixture;
  const image = candidate.image;
  const runtimeFactory = candidate.runtimeFactory;
  const testOnlyAllowUnsupportedPlatform = candidate.testOnlyAllowUnsupportedPlatform;

  if (fixture !== 'content' && fixture !== 'executable') {
    throw new Error('The package-install-demo fixture must be content or executable.');
  }
  if (image !== undefined && typeof image !== 'string') {
    throw new Error('The package-install-demo image must be a string when supplied.');
  }
  if (testOnlyAllowUnsupportedPlatform !== undefined && testOnlyAllowUnsupportedPlatform !== true) {
    throw new Error('The unsupported-platform fixture seam requires the exact test-only value.');
  }

  if (fixture === 'content') {
    if (image !== undefined) {
      throw new Error('The content package-install-demo must not receive an image ID.');
    }
    if (runtimeFactory !== undefined || testOnlyAllowUnsupportedPlatform !== undefined) {
      throw new Error('The content package-install-demo has no runtime fixture seam.');
    }
    return Object.freeze({ fixture, image: undefined, runtimeFactory: undefined });
  }

  if (typeof image !== 'string' || !TRUSTED_IMAGE_ID.test(image)) {
    throw new Error('The executable package-install-demo requires a trusted immutable image ID.');
  }

  if (testOnlyAllowUnsupportedPlatform === true) {
    if (runtimeFactory === undefined) {
      throw new Error('The unsupported-platform fixture seam requires a typed runtime factory.');
    }
  } else if (process.platform !== 'linux' || process.arch !== 'arm64') {
    throw new Error('The executable package-install-demo requires a Linux ARM64 production host.');
  }

  return Object.freeze({
    fixture,
    image,
    runtimeFactory: runtimeFactory as TrustedRuntimeFactory | undefined,
  });
}

function createPackageInstallDemoSource(
  fixture: PackageInstallDemoFixture,
  image: string | undefined,
): PackageSource {
  const bundle =
    fixture === 'content'
      ? createContentPackageBundle()
      : createExecutablePackageBundle(requireImage(image));
  const archive = readFrozenBundle(bundle);

  return Object.freeze({
    expectedSha256: archive.transportDigest,
    id: PACKAGE_INSTALL_DEMO_SOURCE_ID,
    maxBytes: archive.transport.byteLength,
    read: async () => Buffer.from(archive.transport),
  });
}

function createRuntimeCatalog(
  fixture: PackageInstallDemoFixture,
  image: string | undefined,
): ReadonlyMap<string, TrustedImageCatalogEntry> {
  if (fixture === 'content') {
    return new Map();
  }

  const trustedImage = requireImage(image);
  const entry: TrustedImageCatalogEntry = Object.freeze({
    abi: 'glibc-2.35',
    baseImage: trustedImage,
    builderImage: trustedImage,
    features: Object.freeze([]),
    id: REFERENCE_CATALOG_ID,
    platform: 'linux/arm64',
    profile: 'build-restricted',
    templateDigest: REFERENCE_TEMPLATE_DIGEST,
    toolchainDigest: REFERENCE_TOOLCHAIN_DIGEST,
  });

  return new Map([[entry.id, entry]]);
}

function createContentPackageBundle(): Buffer {
  const manifest = JSON.stringify({
    assets: [CONTENT_ASSET_PATH],
    engineCompatibility: '>=0.1.0 <0.2.0',
    kind: 'application',
    license: 'Apache-2.0',
    name: 'qdroid/package-install-demo-content',
    requestedCapabilities: [],
    requestedResources: requestedResources(),
    runtimeVariants: [],
    scenes: [],
    schema: 'qdroid.plugin/v0.1',
    skills: ['skills/package-install-demo'],
    version: '0.1.0',
  });

  return createLockedBundle(manifest, [
    { body: CONTENT_ASSET, path: CONTENT_ASSET_PATH },
    { body: CONTENT_SKILL, path: CONTENT_SKILL_PATH },
    { path: 'skills/package-install-demo', type: 'directory' },
  ]);
}

function createExecutablePackageBundle(image: string): Buffer {
  const manifest = JSON.stringify({
    assets: [],
    build: {
      argv: ['/usr/local/bin/node', 'build.mjs'],
      cwd: '.',
      exports: [EXECUTABLE_RESULT_PATH],
      schema: 'qdroid.build/stdout-ustar-v1',
    },
    engineCompatibility: '>=0.1.0 <0.2.0',
    entrypoint: { executable: '/opt/qdroid/package-install-demo', type: 'command' },
    kind: 'tool',
    license: 'Apache-2.0',
    name: 'qdroid/package-install-demo-executable',
    requestedCapabilities: [],
    requestedResources: requestedResources(),
    runtimeVariants: [
      {
        abi: 'glibc-2.35',
        baseCatalogId: REFERENCE_CATALOG_ID,
        image,
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
  const buildScript = [
    `const output = Buffer.from('${EXECUTABLE_OUTPUT_BASE64}', 'base64');`,
    'process.stdout.write(output);',
  ].join('\n');

  return createLockedBundle(manifest, [{ body: buildScript, path: 'build.mjs' }]);
}

function createLockedBundle(manifest: string, entries: readonly UstarFixtureEntry[]): Buffer {
  const preliminary = createUstarFixture([
    { body: manifest, path: 'qdroid.plugin.json' },
    ...entries,
    { body: '{}', path: 'qdroid.lock.json' },
  ]);
  const inputContentDigest = inventoryDigest(
    readFrozenBundle(preliminary).entries.filter((entry) => entry.path !== 'qdroid.lock.json'),
  );
  const lock = JSON.stringify({ inputContentDigest, schema: 'qdroid.lock/v0.1' });

  return createUstarFixture([
    { body: manifest, path: 'qdroid.plugin.json' },
    ...entries,
    { body: lock, path: 'qdroid.lock.json' },
  ]);
}

function requestedResources(): Readonly<Record<string, number>> {
  return Object.freeze({
    deadlineMs: 30_000,
    memoryMiB: 256,
    outputBytes: 1_048_576,
    pids: 32,
    scratchMiB: 64,
  });
}

async function verifyContentFixture(
  record: DisabledInstallationRecord,
): Promise<readonly string[]> {
  const [asset, skill] = await Promise.all([
    readFile(join(record.contentDirectory, CONTENT_ASSET_PATH), 'utf8'),
    readFile(join(record.contentDirectory, CONTENT_SKILL_PATH), 'utf8'),
  ]);
  assert.equal(asset, CONTENT_ASSET);
  assert.equal(skill, CONTENT_SKILL);

  return Object.freeze(['retained nested Skill bytes', 'retained content asset bytes']);
}

async function verifyExecutableFixture(
  record: DisabledInstallationRecord,
): Promise<readonly string[]> {
  const buildOutputDigest = requireSealedReference(record.buildOutputDigest, 'build output digest');
  const builderImageId = requireSealedReference(record.builderImageId, 'builder image ID');
  const generatedDirectory = requireSealedReference(
    record.generatedDirectory,
    'generated directory',
  );
  const imageId = requireSealedReference(record.imageId, 'runtime image ID');
  const builderReceiptPath = requireSealedReference(
    record.builderReceiptPath,
    'builder receipt path',
  );
  const runtimeReceiptPath = requireSealedReference(
    record.runtimeReceiptPath,
    'runtime receipt path',
  );

  const [generatedResult, builderReceipt, runtimeReceipt] = await Promise.all([
    readFile(join(generatedDirectory, 'result.txt'), 'utf8'),
    readFile(builderReceiptPath, 'utf8'),
    readFile(runtimeReceiptPath, 'utf8'),
  ]);
  assert.equal(generatedResult, EXECUTABLE_RESULT);
  assert.ok(buildOutputDigest.length > 0);
  assert.ok(builderImageId.startsWith('sha256:'));
  assert.ok(imageId.startsWith('sha256:'));
  assert.ok(builderReceipt.length > 0);
  assert.ok(runtimeReceipt.length > 0);

  return Object.freeze([
    'retained generated result bytes',
    'sealed builder receipt reference',
    'sealed runtime receipt reference',
  ]);
}

function summarizeRecord(
  reusedExisting: boolean,
  record: DisabledInstallationRecord,
): DemoInstallRecord {
  return Object.freeze({
    buildOutputDigest: record.buildOutputDigest,
    builderImageId: record.builderImageId,
    imageId: record.imageId,
    installationId: record.installationId,
    packageDigest: record.packageDigest,
    resolvedLockDigest: record.resolvedLockDigest,
    reusedExisting,
    versionRecordId: record.versionRecordId,
  });
}

function requireSealedReference(value: string | null, label: string): string {
  if (value === null) {
    throw new Error(`The disabled executable record has no ${label}.`);
  }
  return value;
}

function requireImage(image: string | undefined): string {
  if (image === undefined || !TRUSTED_IMAGE_ID.test(image)) {
    throw new Error('The executable package-install-demo requires a trusted immutable image ID.');
  }
  return image;
}

export function demoExecutableOutput(): Buffer {
  return Buffer.from(EXECUTABLE_OUTPUT);
}

import assert from 'node:assert/strict';
import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { DockerImageAssembler } from '../../../packages/runtime-oci/src/assembler.js';
import type { ImageAssemblyRequest } from '../../../packages/package-runtime/src/index.js';

const execFile = promisify(executeFile);
const baseImage = process.env.QDROID_T004_IMAGE;
const packageDigest = 'e'.repeat(64);

test(
  'the fixed copy-only assembler materializes package directories in a stopped trusted image',
  { skip: baseImage === undefined, timeout: 30_000 },
  async () => {
    assert.notEqual(baseImage, undefined, 'QDROID_T004_IMAGE is required for T005 Linux assembly.');

    const root = await mkdtemp(join(tmpdir(), 'qdroid-t005-assembly-linux-'));
    const packageDirectory = join(root, 'package');
    const outputDirectory = join(root, 'generated');
    const canaryPath = join(root, 'outside-root-canary');
    const inspectionDirectory = join(root, 'inspection');
    const inspectionContainer = `qdroid-t005-inspection-${process.pid}-${Date.now()}`;

    try {
      await mkdir(join(packageDirectory, 'src'), { recursive: true });
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(packageDirectory, 'src', 'payload.txt'), 'frozen source\n', {
        encoding: 'utf8',
        flag: 'w',
      });
      await writeFile(join(packageDirectory, 'host-hook-never-run'), '#!/bin/sh\nexit 99\n', {
        encoding: 'utf8',
        flag: 'w',
      });
      await writeFile(join(outputDirectory, 'generated.txt'), 'validated output\n', {
        encoding: 'utf8',
        flag: 'w',
      });
      await writeFile(canaryPath, 'outside root remains unchanged\n', 'utf8');

      const result = await new DockerImageAssembler().assemble({
        base: trustedBase(baseImage as string),
        buildOutputDirectory: outputDirectory,
        candidateId: `linux-${process.pid}`,
        packageDirectory,
        packageDigest,
        purpose: 'runtime',
      });

      assert.equal(result.cleanupConfirmed, true);
      assert.match(result.imageId, /^sha256:[0-9a-f]{64}$/);
      assert.equal(await readFile(canaryPath, 'utf8'), 'outside root remains unchanged\n');

      await execFile('docker', ['create', '--name', inspectionContainer, result.imageId]);
      await execFile('docker', [
        'cp',
        `${inspectionContainer}:/opt/qdroid/packages/${packageDigest}`,
        inspectionDirectory,
      ]);

      assert.equal(
        await readFile(join(inspectionDirectory, 'source', 'src', 'payload.txt'), 'utf8'),
        'frozen source\n',
      );
      assert.equal(
        await readFile(join(inspectionDirectory, 'generated', 'generated.txt'), 'utf8'),
        'validated output\n',
      );
      assert.equal(
        await readFile(join(inspectionDirectory, 'source', 'host-hook-never-run'), 'utf8'),
        '#!/bin/sh\nexit 99\n',
      );
    } finally {
      await execFile('docker', ['rm', '--force', inspectionContainer]).catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }
  },
);

function trustedBase(image: string): ImageAssemblyRequest['base'] {
  return {
    abi: 'glibc-2.35',
    baseImage: image,
    builderImage: image,
    features: [],
    id: 'qdroid.t005.linux-assembly-fixture',
    platform: 'linux/arm64',
    profile: 'build-restricted',
    templateDigest: 'a'.repeat(64),
    toolchainDigest: 'b'.repeat(64),
  };
}

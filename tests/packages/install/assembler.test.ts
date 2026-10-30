import assert from 'node:assert/strict';
import test from 'node:test';

import { DockerImageAssembler } from '../../../packages/runtime-oci/src/assembler.js';
import type { ImageAssemblyRequest } from '../../../packages/package-runtime/src/index.js';

const BASE_IMAGE = `sha256:${'a'.repeat(64)}`;
const FINAL_IMAGE = `sha256:${'c'.repeat(64)}`;

test('the trusted assembler only creates, copies, commits, inspects, and removes', async () => {
  const commands: string[][] = [];
  const assembler = new DockerImageAssembler({
    run: async (argv) => {
      commands.push([...argv]);
      if (argv[0] === 'image') {
        const image = argv.at(-1);
        return successInspection(image === BASE_IMAGE ? BASE_IMAGE : FINAL_IMAGE);
      }
      if (argv[0] === 'commit') {
        return { exitCode: 0, stderr: '', stdout: `${FINAL_IMAGE}\n` };
      }
      return { exitCode: 0, stderr: '', stdout: '' };
    },
  });

  const result = await assembler.assemble(assemblyRequest());

  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.imageId, FINAL_IMAGE);
  assert.deepEqual(
    commands.map((argv) => argv[0]),
    ['image', 'create', 'cp', 'cp', 'cp', 'commit', 'image', 'rm'],
  );
  assert.equal(
    commands.some((argv) => argv[0] === 'start' || argv[0] === 'build'),
    false,
  );
  assert.deepEqual(commands[1]?.slice(0, 3), ['create', '--pull=never', '--name']);
  assert.match(commands[2]?.[1] ?? '', /qdroid-assembly-template-.+\/opt\/\.$/);
  assert.match(commands[2]?.[2] ?? '', /qdroid-package-assembly-.+:/);
  assert.match(commands[2]?.[2] ?? '', /:\/opt$/);
  assert.deepEqual(commands[3]?.slice(0, 2), ['cp', '/trusted/package/.']);
  assert.deepEqual(commands[4]?.slice(0, 2), ['cp', '/trusted/generated/.']);
  assert.deepEqual(commands[5]?.slice(0, 2), ['commit', '--pause=false']);
});

test('the builder purpose selects the frozen approved builder image', async () => {
  const builderImage = `sha256:${'b'.repeat(64)}`;
  const commands: string[][] = [];
  const assembler = new DockerImageAssembler({
    run: async (argv) => {
      commands.push([...argv]);
      if (argv[0] === 'image') {
        const image = argv.at(-1);
        return successInspection(image === builderImage ? builderImage : FINAL_IMAGE);
      }
      if (argv[0] === 'commit') {
        return { exitCode: 0, stderr: '', stdout: `${FINAL_IMAGE}\n` };
      }
      return { exitCode: 0, stderr: '', stdout: '' };
    },
  });

  const request = assemblyRequest();
  const { buildOutputDirectory: _buildOutputDirectory, ...builderRequest } = request;
  await assembler.assemble({ ...builderRequest, purpose: 'builder' });

  assert.equal(commands[0]?.at(-1), builderImage);
  assert.equal(commands[1]?.at(-1), builderImage);
  const commit = commands.find((argv) => argv[0] === 'commit');
  assert.deepEqual(commit?.slice(0, 8), [
    'commit',
    '--pause=false',
    '--change',
    `LABEL io.qdroid.package.digest=${'f'.repeat(64)}`,
    '--change',
    `LABEL io.qdroid.package.source=${builderImage}`,
    '--change',
    'LABEL io.qdroid.package.purpose=builder',
  ]);
});

test('the trusted assembler accepts Docker null and empty representations of inert configuration', async () => {
  const configurations = [
    { Healthcheck: null, OnBuild: null, Volumes: null },
    { Healthcheck: { Test: [] }, OnBuild: [], Volumes: {} },
    { Healthcheck: { Test: ['NONE'] }, OnBuild: [], Volumes: [] },
  ];

  for (const configuration of configurations) {
    const assembler = new DockerImageAssembler({
      run: async (argv) => {
        if (argv[0] === 'image') {
          const image = argv.at(-1);
          return successInspection(image === BASE_IMAGE ? BASE_IMAGE : FINAL_IMAGE, configuration);
        }
        if (argv[0] === 'commit') {
          return { exitCode: 0, stderr: '', stdout: `${FINAL_IMAGE}\n` };
        }
        return { exitCode: 0, stderr: '', stdout: '' };
      },
    });

    await assembler.assemble(assemblyRequest());
  }
});

test('the trusted assembler rejects an inherited health check before creating a container', async () => {
  const commands: string[][] = [];
  const assembler = new DockerImageAssembler({
    run: async (argv) => {
      commands.push([...argv]);
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          Architecture: 'arm64',
          Config: { Healthcheck: { Test: ['CMD', 'unexpected'] } },
          Id: BASE_IMAGE,
          Os: 'linux',
        }),
      };
    },
  });

  await assert.rejects(
    assembler.assemble(assemblyRequest()),
    /does not match its approved immutable configuration/,
  );
  assert.deepEqual(
    commands.map((argv) => argv[0]),
    ['image'],
  );
});

test('the trusted assembler rejects every nonempty inherited image configuration', async () => {
  const configurations = [
    { Healthcheck: null, OnBuild: ['RUN unexpected'], Volumes: null },
    { Healthcheck: null, OnBuild: null, Volumes: { '/mutable': {} } },
    { Healthcheck: { Test: ['CMD', 'unexpected'] }, OnBuild: null, Volumes: null },
  ];

  for (const configuration of configurations) {
    const commands: string[][] = [];
    const assembler = new DockerImageAssembler({
      run: async (argv) => {
        commands.push([...argv]);
        return successInspection(BASE_IMAGE, configuration);
      },
    });

    await assert.rejects(
      assembler.assemble(assemblyRequest()),
      /does not match its approved immutable configuration/,
    );
    assert.deepEqual(
      commands.map((argv) => argv[0]),
      ['image'],
    );
  }
});

test('the trusted assembler canonicalizes Docker commit IDs without a sha256 prefix', async () => {
  const assembler = new DockerImageAssembler({
    run: async (argv) => {
      if (argv[0] === 'image') {
        const image = argv.at(-1);
        return successInspection(image === BASE_IMAGE ? BASE_IMAGE : FINAL_IMAGE);
      }
      if (argv[0] === 'commit') {
        return { exitCode: 0, stderr: '', stdout: `${FINAL_IMAGE.slice('sha256:'.length)}\n` };
      }
      return { exitCode: 0, stderr: '', stdout: '' };
    },
  });

  const result = await assembler.assemble(assemblyRequest());

  assert.equal(result.imageId, FINAL_IMAGE);
});

test('the trusted assembler accepts a single Docker commit ID from diagnostic output', async () => {
  const assembler = new DockerImageAssembler({
    run: async (argv) => {
      if (argv[0] === 'image') {
        const image = argv.at(-1);
        return successInspection(image === BASE_IMAGE ? BASE_IMAGE : FINAL_IMAGE);
      }
      if (argv[0] === 'commit') {
        return {
          exitCode: 0,
          stderr: `committed immutable image ${FINAL_IMAGE}\n`,
          stdout: '',
        };
      }
      return { exitCode: 0, stderr: '', stdout: '' };
    },
  });

  const result = await assembler.assemble(assemblyRequest());

  assert.equal(result.imageId, FINAL_IMAGE);
});

test('the trusted assembler verifies a retained image against its sealed receipt and labels', async () => {
  const request = assemblyRequest();
  const assembler = new DockerImageAssembler({
    run: async () =>
      successInspection(FINAL_IMAGE, {
        Labels: {
          'io.qdroid.package.digest': request.packageDigest,
          'io.qdroid.package.purpose': request.purpose,
          'io.qdroid.package.source': request.base.baseImage,
        },
      }),
  });

  await assembler.verifySealed({
    base: request.base,
    imageId: FINAL_IMAGE,
    packageDigest: request.packageDigest,
    purpose: request.purpose,
    receipt: {
      assembler: 'qdroid.fixed-copy-commit/v1',
      baseImage: request.base.baseImage,
      candidateId: request.candidateId,
      finalImageId: FINAL_IMAGE,
      packageDigest: request.packageDigest,
      platform: request.base.platform,
      purpose: request.purpose,
    },
  });
});

test('the trusted assembler rejects a retained image with a missing sealed label', async () => {
  const request = assemblyRequest();
  const assembler = new DockerImageAssembler({
    run: async () => successInspection(FINAL_IMAGE, { Labels: {} }),
  });

  await assert.rejects(
    assembler.verifySealed({
      base: request.base,
      imageId: FINAL_IMAGE,
      packageDigest: request.packageDigest,
      purpose: request.purpose,
      receipt: {
        assembler: 'qdroid.fixed-copy-commit/v1',
        baseImage: request.base.baseImage,
        candidateId: request.candidateId,
        finalImageId: FINAL_IMAGE,
        packageDigest: request.packageDigest,
        platform: request.base.platform,
        purpose: request.purpose,
      },
    }),
    /no longer matches its sealed trusted receipt/,
  );
});

function assemblyRequest(): ImageAssemblyRequest {
  return {
    base: {
      abi: 'glibc-2.39',
      baseImage: BASE_IMAGE,
      builderImage: `sha256:${'b'.repeat(64)}`,
      features: [],
      id: 'catalog/node-build-v1',
      platform: 'linux/arm64',
      profile: 'build-restricted',
      templateDigest: 'd'.repeat(64),
      toolchainDigest: 'e'.repeat(64),
    },
    buildOutputDirectory: '/trusted/generated',
    candidateId: 'candidate-123',
    packageDirectory: '/trusted/package',
    packageDigest: 'f'.repeat(64),
    purpose: 'runtime',
  };
}

function successInspection(
  image: string,
  configuration: Record<string, unknown> = {},
): { exitCode: number; stderr: string; stdout: string } {
  return {
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({
      Architecture: 'arm64',
      Config: configuration,
      Id: image,
      Os: 'linux',
    }),
  };
}

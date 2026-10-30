import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  FIXED_ASSEMBLY_PROTOCOL,
  FIXED_BOUNDARY_CONTROL_PROTOCOL,
  FIXED_BOUNDARY_PROBE_PROTOCOL,
  FIXED_NETWORK_CONTROL_PROTOCOL,
  FIXED_PROBE_PROTOCOL,
  SandboxGuardianClient,
} from '../../packages/supervisor/src/index.js';

const T004_CONFIGURATION_IMAGE =
  'sha256:85ec5b256629377c431378387603d94c5b7a4a68be3b687ef35c69989ac76a4d';

test('the guardian runs a fixed native fact with bounded output and confirmed settlement', async () => {
  const guardian = new SandboxGuardianClient();
  const stdout: Buffer[] = [];

  guardian.on('output', (stream, chunk, acknowledgeConsumption) => {
    if (stream === 'stdout') {
      stdout.push(Buffer.from(chunk));
    }
    acknowledgeConsumption();
  });

  await guardian.startNative({
    deadlineMs: 1_000,
    intent: { kind: 'machine-architecture' },
    maxOutputBytes: 1_024,
  });
  const completion = await guardian.completion;

  assert.deepEqual(completion, {
    cleanupConfirmed: true,
    exitCode: 0,
    reason: 'completed',
    stderrBytes: 0,
    stderrDeliveredBytes: 0,
    stdoutBytes: Buffer.byteLength(Buffer.concat(stdout)),
    stdoutDeliveredBytes: Buffer.byteLength(Buffer.concat(stdout)),
  });
  assert.match(Buffer.concat(stdout).toString('utf8'), /\S/);
});

test('the guardian rejects a native operation with an unapproved runtime path', async () => {
  const guardian = new SandboxGuardianClient();

  await assert.rejects(
    guardian.startNative({
      deadlineMs: 1_000,
      intent: {
        kind: 'runtime-version',
        path: '/bin/sh',
      },
      maxOutputBytes: 1_024,
    }),
    /received an invalid fixed native operation/,
  );
});

test('the guardian rejects an I/O cache-drop path outside its generated fixture namespace', async () => {
  const guardian = new SandboxGuardianClient();

  await assert.rejects(
    guardian.startNative({
      deadlineMs: 1_000,
      intent: {
        kind: 'legacy-io-cache-drop',
        path: '/mnt/lima-colima-qdroid-t002/qdroid-t002-io/io-not-a-uuid.bin',
      },
      maxOutputBytes: 1_024,
    }),
    /received an invalid fixed native operation/,
  );
});

test('the guardian rejects an unrecognized fixed probe recipe before container creation', async () => {
  const guardian = new SandboxGuardianClient();

  await assert.rejects(
    guardian.createProbe({
      containerName: 'qdroid-t005-probe-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      deadlineMs: 1_000,
      imageId: `sha256:${'a'.repeat(64)}`,
      intent: {
        kind: 'legacy-fixed-configuration',
        unexpected: 'not-an-allowed-probe-field',
      } as unknown as { readonly kind: 'legacy-fixed-configuration' },
      maxOutputBytes: 1_024,
      ownership: {
        imageId: `sha256:${'a'.repeat(64)}`,
        labels: {
          'io.qdroid.owner': 'trusted-owner',
          'io.qdroid.profile': 'qdroid.t002.readonly-sim/v1',
          'io.qdroid.session': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        },
      },
      protocol: FIXED_PROBE_PROTOCOL,
    }),
    /received an invalid fixed probe creation/,
  );

  const completion = await guardian.completion;
  assert.equal(completion.cleanupConfirmed, false);
  assert.equal(completion.reason, 'stopped');
});

test('the guardian rejects an unsupported fixed-probe protocol before it can create a container', async () => {
  const guardian = new SandboxGuardianClient();

  await assert.rejects(
    guardian.createProbe({
      containerName: 'qdroid-t005-probe-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      deadlineMs: 1_000,
      imageId: `sha256:${'a'.repeat(64)}`,
      intent: { kind: 'legacy-fixed-configuration' },
      maxOutputBytes: 1_024,
      ownership: {
        imageId: `sha256:${'a'.repeat(64)}`,
        labels: {
          'io.qdroid.owner': 'trusted-owner',
          'io.qdroid.profile': 'qdroid.t002.readonly-sim/v1',
          'io.qdroid.session': 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        },
      },
      protocol: 'qdroid.fixed-probe/v0' as typeof FIXED_PROBE_PROTOCOL,
    }),
    /fixed probe protocol is unsupported/,
  );

  assert.equal(guardian.requestIdleWorkerExit(), true);
  await assert.rejects(guardian.completion, /IPC channel disconnected before cleanup/);
});

test('a boundary keeper retains a replaced canary and reports unconfirmed cleanup', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Boundary keeper ownership requires the trusted Linux host.');
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'qdroid-boundary-replaced-canary-'));
  const sessionId = 'candidate-5e03f81c-e51c-41b1-bccb-5a3f6ff66271';
  const resourceId = 'boundary-271a1fc6-e309-4c51-b2cc-34ffb89d6252';
  const fixtureRoot = join(directory, 'runtime-sessions', sessionId, 'fixtures');
  const receiptPath = join(dirname(fixtureRoot), `${resourceId}.boundary-created.json`);
  let guardian: SandboxGuardianClient | undefined;
  let guardianExit:
    | Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
    | undefined;
  let completed = false;
  let primaryFailure: unknown;

  try {
    await mkdir(fixtureRoot, { mode: 0o700, recursive: true });
    await chmod(fixtureRoot, 0o700);
    guardian = new SandboxGuardianClient();
    guardianExit = observeGuardianExit(guardian);
    const guardianPid = guardian.pid;
    assert.notEqual(guardianPid, undefined);
    const guardianStart = await readProcessStart(guardianPid as number);

    await awaitWithin(
      guardian.createBoundaryControl({
        bootId: '67d6379b-e05c-49f0-893d-f66d76a817a9',
        fixtureRoot,
        journalKey: Buffer.alloc(32, 9),
        keeperPid: guardianPid as number,
        keeperStart: guardianStart,
        ownerId: 'trusted-boundary-owner',
        protocol: FIXED_BOUNDARY_CONTROL_PROTOCOL,
        receiptPath,
        resourceId,
        sessionId,
      }),
      'create the controlled boundary keeper',
    );

    const canaryPath = join(fixtureRoot, resourceId, 'cross-app-canary');
    await rm(canaryPath, { force: false });
    await writeFile(canaryPath, 'foreign replacement\n', { encoding: 'utf8', mode: 0o600 });

    await awaitWithin(guardian.stop('stopped'), 'stop the boundary keeper with a replaced canary');
    const completion = await awaitWithin(
      guardian.completion,
      'settle the boundary keeper with a replaced canary',
    );
    assert.equal(completion.cleanupConfirmed, false);
    assert.match(completion.errorMessage ?? '', /canary (?:identity|contents) changed/);
    assert.equal(await readFile(canaryPath, 'utf8'), 'foreign replacement\n');
    await awaitWithin(guardianExit, 'wait for the boundary keeper after replacement rejection');
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (guardian !== undefined) {
      await collectCleanupStep(
        guardian.stop('stopped'),
        'stop the boundary keeper after a replacement test failure',
        cleanupFailures,
      );
      await collectCleanupStep(
        guardian.completion,
        'settle the boundary keeper after a replacement test failure',
        cleanupFailures,
      );
    }
    if (guardianExit !== undefined) {
      await collectCleanupStep(
        guardianExit,
        'wait for the boundary keeper process after a replacement test failure',
        cleanupFailures,
      );
    }
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained boundary replacement evidence: ${directory}`);
    } else {
      await rm(directory, { force: true, recursive: true });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'Boundary replacement cleanup did not settle independently.',
      );
    }
  }
});

test('a boundary probe rejects a mismatched nested control receipt before it writes configuration', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Boundary probe configuration requires the trusted Linux host.');
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'qdroid-boundary-configure-mismatch-'));
  const sessionId = 'candidate-2ca29ed2-1f8f-4e5d-a035-e1a274b47cde';
  const controlResourceId = 'boundary-45e6cbb4-330d-4d54-89f3-c5db0de2e28c';
  const resourceId = 'probe-913d8b75-147e-4eca-8e4e-760de4657181';
  const sessionDirectory = join(directory, 'runtime-sessions', sessionId);
  const fixtureRoot = join(sessionDirectory, 'fixtures');
  const configurationReceiptPath = join(sessionDirectory, `${resourceId}.boundary-configured.json`);
  const creationReceiptPath = join(sessionDirectory, `${resourceId}.boundary-created.json`);
  const terminalReceiptPath = join(sessionDirectory, `${resourceId}.boundary-terminal.json`);
  let guardian: SandboxGuardianClient | undefined;
  let guardianExit:
    | Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
    | undefined;
  let completed = false;
  let primaryFailure: unknown;

  try {
    await mkdir(fixtureRoot, { mode: 0o700, recursive: true });
    await chmod(fixtureRoot, 0o700);
    guardian = new SandboxGuardianClient();
    guardianExit = observeGuardianExit(guardian);
    const guardianPid = guardian.pid;
    assert.notEqual(guardianPid, undefined);
    const guardianStart = await readProcessStart(guardianPid as number);
    const controlReceiptAuthenticationTag = 'a'.repeat(64);

    await assert.rejects(
      awaitWithin(
        guardian.configureBoundaryProbe({
          bootId: 'f3e98500-b5d6-4714-aa87-8cdff569b0f2',
          configurationReceiptPath,
          creationReceiptPath,
          controlReceiptAuthenticationTag,
          controlResourceId,
          guardianPid: guardianPid as number,
          guardianStart,
          journalKey: Buffer.alloc(32, 19),
          ownerId: 'trusted-boundary-owner',
          probe: {
            containerName: 'qdroid-t005-probe-913d8b75-147e-4eca-8e4e-760de4657181',
            deadlineMs: 1_000,
            imageId: T004_CONFIGURATION_IMAGE,
            intent: {
              childPid: 1,
              childStart: '1',
              controlReceiptAuthenticationTag: 'b'.repeat(64),
              controlResourceId,
              crossAppPath: join(fixtureRoot, controlResourceId, 'cross-app-canary'),
              kind: 'profile-boundary-program',
              profileId: 'build-restricted',
              trustedStorePath: join(fixtureRoot, controlResourceId, 'trusted-store-canary'),
            },
            maxOutputBytes: 8_192,
            ownership: {
              imageId: T004_CONFIGURATION_IMAGE,
              labels: {
                'io.qdroid.owner': 'trusted-boundary-owner',
                'io.qdroid.profile': 'build-restricted',
                'io.qdroid.session': sessionId,
              },
            },
            protocol: FIXED_BOUNDARY_PROBE_PROTOCOL,
          },
          resourceId,
          sessionId,
          terminalReceiptPath,
        }),
        'reject the mismatched nested boundary probe configuration',
      ),
      /invalid boundary probe configuration/,
    );
    const terminal = await awaitWithin(
      guardian.completion,
      'settle the rejected nested boundary probe configuration',
    );
    assert.equal(terminal.cleanupConfirmed, false);
    await assert.rejects(lstat(configurationReceiptPath), /ENOENT/);
    await assert.rejects(lstat(creationReceiptPath), /ENOENT/);
    await assert.rejects(lstat(terminalReceiptPath), /ENOENT/);
    await awaitWithin(guardianExit, 'wait for the rejected boundary probe guardian');
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (guardian !== undefined) {
      await collectCleanupStep(
        guardian.stop('stopped'),
        'stop the rejected nested boundary probe guardian after a test failure',
        cleanupFailures,
      );
      await collectCleanupStep(
        guardian.completion,
        'settle the rejected nested boundary probe guardian after a test failure',
        cleanupFailures,
      );
    }
    if (guardianExit !== undefined) {
      await collectCleanupStep(
        guardianExit,
        'wait for the rejected nested boundary probe guardian after a test failure',
        cleanupFailures,
      );
    }
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained boundary configuration mismatch evidence: ${directory}`);
    } else {
      await rm(directory, { force: true, recursive: true });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'Boundary configuration mismatch cleanup did not settle independently.',
      );
    }
  }
});

test('a boundary probe retains its receipt persistence and nonzero removal failures', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Boundary probe cleanup requires the trusted Linux host.');
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'qdroid-boundary-probe-dual-failure-'));
  const dockerPath = join(directory, 'docker');
  const sessionId = 'candidate-832efb8c-5a97-4dfe-88bf-6c2e35e728d2';
  const controlResourceId = 'boundary-832efb8c-5a97-4dfe-88bf-6c2e35e728d2';
  const resourceId = 'probe-832efb8c-5a97-4dfe-88bf-6c2e35e728d2';
  const sessionDirectory = join(directory, 'runtime-sessions', sessionId);
  const fixtureRoot = join(sessionDirectory, 'fixtures');
  const configurationReceiptPath = join(sessionDirectory, `${resourceId}.boundary-configured.json`);
  const creationReceiptPath = join(sessionDirectory, `${resourceId}.boundary-created.json`);
  const terminalReceiptPath = join(sessionDirectory, `${resourceId}.boundary-terminal.json`);
  const executionReceiptPath = `${creationReceiptPath}.execution`;
  const imageId = T004_CONFIGURATION_IMAGE;
  const containerId = 'b'.repeat(64);
  const containerName = 'qdroid-t005-probe-832efb8c-5a97-4dfe-88bf-6c2e35e728d2';
  const ownerId = 'trusted-boundary-owner';
  const journalKey = Buffer.alloc(32, 29);
  const controlReceiptAuthenticationTag = 'c'.repeat(64);
  const originalPath = process.env.PATH;
  let guardian: SandboxGuardianClient | undefined;
  let guardianExit:
    | Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
    | undefined;
  let completed = false;
  let primaryFailure: unknown;

  try {
    await mkdir(fixtureRoot, { mode: 0o700, recursive: true });
    await chmod(fixtureRoot, 0o700);
    await mkdir(executionReceiptPath, { mode: 0o700 });
    await writeFile(
      dockerPath,
      `#!/bin/sh
case "$1" in
  create)
    printf '%s\\n' '${containerId}'
    ;;
  inspect)
    if [ "$2" = "--format" ]; then
      printf '%s\\n' 'false 0'
    else
      printf '%s\\n' '[{"Id":"${containerId}","Image":"${imageId}","Config":{"Labels":{"io.qdroid.owner":"${ownerId}","io.qdroid.profile":"build-restricted","io.qdroid.session":"${sessionId}"}},"State":{"Running":false,"Pid":0,"ExitCode":0,"OOMKilled":false}}]'
    fi
    ;;
  rm)
    printf '%s\\n' 'expected removal failure' >&2
    exit 17
    ;;
esac
`,
      { encoding: 'utf8', mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;

    guardian = new SandboxGuardianClient();
    guardianExit = observeGuardianExit(guardian);
    const guardianPid = guardian.pid;
    assert.notEqual(guardianPid, undefined);
    const guardianStart = await readProcessStart(guardianPid as number);
    const probe = {
      containerName,
      deadlineMs: 1_000,
      imageId,
      intent: {
        childPid: 1,
        childStart: '1',
        controlReceiptAuthenticationTag,
        controlResourceId,
        crossAppPath: join(fixtureRoot, controlResourceId, 'cross-app-canary'),
        kind: 'profile-boundary-program' as const,
        profileId: 'build-restricted' as const,
        trustedStorePath: join(fixtureRoot, controlResourceId, 'trusted-store-canary'),
      },
      maxOutputBytes: 8_192,
      ownership: {
        imageId,
        labels: {
          'io.qdroid.owner': ownerId,
          'io.qdroid.profile': 'build-restricted',
          'io.qdroid.session': sessionId,
        },
      },
      protocol: FIXED_BOUNDARY_PROBE_PROTOCOL as typeof FIXED_BOUNDARY_PROBE_PROTOCOL,
    };
    const configured = await awaitWithin(
      guardian.configureBoundaryProbe({
        bootId: '81669c16-b581-40d6-9d9b-48d9a33f3511',
        configurationReceiptPath,
        creationReceiptPath,
        controlReceiptAuthenticationTag,
        controlResourceId,
        guardianPid: guardianPid as number,
        guardianStart,
        journalKey,
        ownerId,
        probe,
        resourceId,
        sessionId,
        terminalReceiptPath,
      }),
      'configure the boundary probe before its controlled dual failure',
    );
    const dependencyPayload = {
      boundaryReceiptAuthenticationTag: controlReceiptAuthenticationTag,
      configurationAuthenticationTag: configured.configurationAuthenticationTag,
      containerName,
      guardian: {
        groupId: guardianPid as number,
        pid: guardianPid as number,
        start: guardianStart,
      },
      imageId,
      labels: probe.ownership.labels,
      ownerId,
      protocol: FIXED_BOUNDARY_CONTROL_PROTOCOL,
      resourceId,
      sessionId,
      terminalReceiptPath,
      version: 1,
    };
    const dependencyAuthenticationTag = createHmac('sha256', journalKey)
      .update('qdroid.boundary-dependency/v1')
      .update('\0')
      .update(JSON.stringify(dependencyPayload))
      .digest('hex');

    await awaitWithin(
      guardian.createProbe({
        ...probe,
        boundaryAuthorization: {
          controlResourceId,
          dependencyAuthenticationTag,
          resourceId,
        },
      }),
      'create the controlled boundary probe before final cleanup',
    );
    await awaitWithin(guardian.stop('stopped'), 'request controlled boundary probe cleanup');
    const completion = await awaitWithin(
      guardian.completion,
      'settle the boundary probe with both retained failures',
    );
    assert.equal(completion.cleanupConfirmed, false);
    assert.match(completion.errorMessage ?? '', /EISDIR/);
    assert.match(completion.errorMessage ?? '', /Docker remove failed \(exit code 17/);
    assert.match(completion.errorMessage ?? '', /expected removal failure/);
    await awaitWithin(guardianExit, 'wait for the dual-failure boundary probe guardian');
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (guardian !== undefined) {
      await collectCleanupStep(
        guardian.stop('stopped'),
        'stop the dual-failure boundary probe guardian after a test failure',
        cleanupFailures,
      );
      await collectCleanupStep(
        guardian.completion,
        'settle the dual-failure boundary probe guardian after a test failure',
        cleanupFailures,
      );
    }
    if (guardianExit !== undefined) {
      await collectCleanupStep(
        guardianExit,
        'wait for the dual-failure boundary probe guardian after a test failure',
        cleanupFailures,
      );
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained boundary dual-failure evidence: ${directory}`);
    } else {
      await rm(directory, { force: true, recursive: true });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'Boundary dual-failure cleanup did not settle independently.',
      );
    }
  }
});

test('a profile network keeper rejects a caller-selected interface before any creation effect', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Managed runtime resource ownership requires the trusted Linux host.');
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-forged-interface-'));
  const sessionId = 'candidate-2ff89cca-e61d-4eb8-9115-3ad00ffad9c5';
  const resourceId = 'network-2f3261e7-341f-4d0e-ab8e-7ec7ff355450';
  const fixtureRoot = join(directory, 'runtime-sessions', sessionId, 'fixtures');
  const receiptPath = join(dirname(fixtureRoot), `${resourceId}.network-created.json`);
  const terminalReceiptPath = join(dirname(fixtureRoot), `${resourceId}.network-terminal.json`);
  let guardian: SandboxGuardianClient | undefined;
  let guardianExit:
    | Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
    | undefined;
  let completed = false;
  let primaryFailure: unknown;

  try {
    await mkdir(fixtureRoot, { mode: 0o700, recursive: true });
    await chmod(fixtureRoot, 0o700);
    guardian = new SandboxGuardianClient();
    guardianExit = observeGuardianExit(guardian);
    const guardianPid = guardian.pid;
    assert.notEqual(guardianPid, undefined);
    const guardianStart = await readProcessStart(guardianPid as number);

    await assert.rejects(
      guardian.createNetworkControl({
        bootId: 'd217501e-8cbd-4b36-9fd4-0d8de8f0fec0',
        fixtureRoot,
        interfaceMarker: '02:aa:bb:cc:dd:ee',
        interfaceName: 'qd5aaaaaaaaaa',
        journalKey: Buffer.alloc(32, 7),
        keeperGroupId: guardianPid as number,
        keeperPid: guardianPid as number,
        keeperStart: guardianStart,
        kind: 'profile',
        ownerId: 'trusted-network-owner',
        protocol: FIXED_NETWORK_CONTROL_PROTOCOL,
        receiptPath,
        resourceId,
        sessionId,
        terminalReceiptPath,
      }),
      /invalid fixed network control creation/,
    );
    await assert.rejects(access(receiptPath), /ENOENT/);
    await assert.rejects(access(terminalReceiptPath), /ENOENT/);
    const completion = await guardian.completion;
    assert.equal(completion.cleanupConfirmed, false);
    await awaitWithin(guardianExit, 'wait for the forged network keeper rejection');
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (guardian !== undefined) {
      await collectCleanupStep(
        guardian.stop('stopped'),
        'stop the forged network keeper after a test failure',
        cleanupFailures,
      );
      await collectCleanupStep(
        guardian.completion,
        'settle the forged network keeper after a test failure',
        cleanupFailures,
      );
    }
    if (guardianExit !== undefined) {
      await collectCleanupStep(
        guardianExit,
        'wait for the forged network keeper after a test failure',
        cleanupFailures,
      );
    }
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained forged network keeper evidence: ${directory}`);
    } else {
      await rm(directory, { force: true, recursive: true });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'Forged network keeper cleanup did not settle independently.',
      );
    }
  }
});

test('a created fixed probe settles every pending phase when final cleanup starts', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Fixed probe lifecycle cleanup requires the trusted Linux host.');
    return;
  }

  const guardian = new SandboxGuardianClient();
  const ownerId = 'trusted-fixed-probe-owner';
  const sessionId = 'c2b9a4d8-8b0f-4e0d-a961-cd91503b94ad';

  let primaryFailure: unknown;
  let completed = false;
  try {
    await awaitWithin(
      guardian.createProbe({
        containerName: 'qdroid-t005-probe-c2b9a4d8-8b0f-4e0d-a961-cd91503b94ad',
        deadlineMs: 10_000,
        imageId: T004_CONFIGURATION_IMAGE,
        intent: { kind: 'legacy-fixed-configuration' },
        maxOutputBytes: 8_192,
        ownership: {
          imageId: T004_CONFIGURATION_IMAGE,
          labels: {
            'io.qdroid.owner': ownerId,
            'io.qdroid.profile': 'qdroid.t002.readonly-sim/v1',
            'io.qdroid.session': sessionId,
          },
        },
        protocol: FIXED_PROBE_PROTOCOL,
      }),
      'create the fixed probe before final cleanup',
    );

    await awaitWithin(guardian.stop(), 'stop the created fixed probe');
    await awaitWithin(
      assert.rejects(guardian.startProbe(), /no longer available for input/),
      'reject a fixed probe start after final cleanup',
    );
    await awaitWithin(
      assert.rejects(
        guardian.inspectProbe('container-state'),
        /no longer available for inspection/,
      ),
      'reject a fixed probe inspection after final cleanup',
    );
    await awaitWithin(
      assert.rejects(
        guardian.probeCommandCompletion,
        /closed before completing its fixed probe command/,
      ),
      'reject the unfinished fixed probe command after final cleanup',
    );

    const completion = await awaitWithin(
      guardian.completion,
      'settle the created fixed probe after final cleanup',
    );
    assert.equal(completion.reason, 'stopped');
    assert.equal(completion.cleanupConfirmed, true);
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await collectCleanupStep(
      guardian.stop(),
      'stop the created fixed probe after a test failure',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian.completion,
      'settle the created fixed probe after a test failure',
      cleanupFailures,
    );
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic('The created fixed probe must remain available for managed cleanup review.');
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'The created fixed probe test failed and cleanup did not settle independently.',
      );
    }
  }
});

test('a profile-tuple probe returns a live fixed cgroup snapshot only while its owned process runs', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Live cgroup inspection requires the trusted Linux host.');
    return;
  }

  const guardian = new SandboxGuardianClient();
  const ownerId = 'trusted-profile-cgroup-owner';
  const sessionId = 'e4e98d3a-1515-4a3a-8e45-0db9025c4840';
  const guardianOutput: string[] = [];
  let completed = false;
  let primaryFailure: unknown;

  guardian.on('output', (stream, chunk, acknowledgeConsumption) => {
    guardianOutput.push(`${stream}: ${Buffer.from(chunk).toString('utf8')}`);
    acknowledgeConsumption();
  });

  try {
    await awaitWithin(
      guardian.createProbe({
        containerName: 'qdroid-t005-probe-e4e98d3a-1515-4a3a-8e45-0db9025c4840',
        deadlineMs: 10_000,
        imageId: T004_CONFIGURATION_IMAGE,
        intent: {
          kind: 'profile-fixed-program',
          profileId: 'tool-offline',
          selector: 'cgroup-limits',
        },
        maxOutputBytes: 65_536,
        ownership: {
          imageId: T004_CONFIGURATION_IMAGE,
          labels: {
            'io.qdroid.owner': ownerId,
            'io.qdroid.profile': 'qdroid.t004.profile-catalog/v1:tool-offline',
            'io.qdroid.session': sessionId,
          },
        },
        protocol: FIXED_PROBE_PROTOCOL,
      }),
      'create a profile-tuple cgroup probe',
    );

    const configuration = await awaitWithin(
      guardian.inspectProbe('configuration'),
      'inspect the profile-tuple configuration',
    );
    assert.equal(configuration.kind, 'configuration');
    assert.equal(configuration.fixedProfileVerified, true);

    await awaitWithin(guardian.startProbe(), 'start the profile-tuple cgroup probe');
    const inspection = await awaitWithin(
      guardian.inspectProbe('live-cgroup'),
      'inspect the live profile-tuple cgroup',
    );
    assert.equal(inspection.kind, 'live-cgroup');
    assert.match(inspection.cgroup.identity.key, /^[a-f0-9]{64}$/);
    assert.equal(inspection.cgroup.memoryMaximumBytes, 768 * 1024 * 1024);
    assert.equal(inspection.cgroup.cpu.periodMicros, 100_000);
    assert.equal(inspection.cgroup.cpu.quotaMicros, 100_000);
    assert.equal(inspection.cgroup.pidsMaximum, 256);
    assert.equal(inspection.cgroup.io.deviceMajorMinor, '253:16');
    assert.equal(inspection.cgroup.io.counters.readBytesPerSecond, 1_048_576);
    assert.equal(inspection.cgroup.io.counters.writeBytesPerSecond, 1_048_576);

    await awaitWithin(guardian.stop('stopped'), 'stop the profile-tuple cgroup probe');
    const completion = await awaitWithin(
      guardian.completion,
      'settle the profile-tuple cgroup probe',
    );
    assert.equal(completion.cleanupConfirmed, true);
    completed = true;
  } catch (error) {
    primaryFailure = error;
    if (guardianOutput.length > 0) {
      t.diagnostic(`Profile cgroup guardian output:\n${guardianOutput.join('')}`);
    }
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await collectCleanupStep(
      guardian.stop('stopped'),
      'stop the profile-tuple cgroup probe after a test failure',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian.completion,
      'settle the profile-tuple cgroup probe after a test failure',
      cleanupFailures,
    );
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic('The profile-tuple cgroup probe must remain available for cleanup review.');
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'The profile-tuple cgroup probe test failed and cleanup did not settle independently.',
      );
    }
  }
});

test('a fixed profile start acknowledges an owned created container before live cgroup inspection', async (t) => {
  const fixture = await createFixedProfileProbeDockerFixture('held');
  const heldProcess = spawn('sleep', ['10']);
  await fixture.setLiveProcessId(heldProcess.pid);
  const guardian = new SandboxGuardianClient();
  const guardianExit = observeGuardianExit(guardian);
  const heldProcessExit = observeChildExit(heldProcess);
  let completed = false;
  let primaryFailure: unknown;

  try {
    await awaitWithin(
      guardian.createProbe(fixture.probeSpec()),
      'create the delayed fixed profile probe',
    );
    await awaitWithin(guardian.startProbe(), 'acknowledge the delayed fixed profile probe start');

    const created = await awaitWithin(
      guardian.inspectProbe('container-state'),
      'observe the pending created fixed profile probe',
    );
    assert.equal(created.kind, 'container-state');
    assert.equal(created.state, 'created');

    const liveInspection = guardian.inspectProbe('live-cgroup');
    await waitForLogLine(fixture.logPath, 'inspect-created');
    assert.equal(
      await settlesWithin(liveInspection, 50),
      false,
      'created is pending for live cgroup observation, not a start failure or success',
    );

    await fixture.setState('running');
    await waitForLogLine(fixture.logPath, 'inspect-running');
    try {
      const inspection = await awaitWithin(
        liveInspection,
        'settle the delayed live cgroup observation',
      );
      assert.equal(inspection.kind, 'live-cgroup');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(
        message,
        /^(?:The fixed probe (?:cpu|io|memory|pids)|ENOENT:|EACCES:)/,
        'the controlled fixture may reject only a concrete host cgroup read limitation',
      );
    }

    await awaitWithin(guardian.stop('stopped'), 'stop the delayed fixed profile probe');
    const completion = await awaitWithin(
      guardian.completion,
      'settle the delayed fixed profile probe cleanup',
    );
    assert.equal(completion.cleanupConfirmed, true);
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await collectCleanupStep(
      guardian.stop('stopped'),
      'stop the delayed fixed profile probe after a test failure',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian.completion,
      'settle the delayed fixed profile probe after a test failure',
      cleanupFailures,
    );
    if (heldProcess.exitCode === null && heldProcess.signalCode === null) {
      try {
        heldProcess.kill('SIGKILL');
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    await collectCleanupStep(
      heldProcessExit,
      'wait for the delayed fixed profile process after cleanup',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardianExit,
      'wait for the delayed fixed profile guardian process after cleanup',
      cleanupFailures,
    );
    await fixture.restore(primaryFailure !== undefined || cleanupFailures.length > 0 || !completed);
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained delayed fixed profile probe evidence: ${fixture.directory}`);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'The delayed fixed profile probe cleanup failed independently.',
      );
    }
  }
});

test('a late fixed profile inspection cannot return a running snapshot after its command deadline', async (t) => {
  const fixture = await createFixedProfileProbeDockerFixture('held');
  const heldProcess = spawn('sleep', ['10']);
  await fixture.setLiveProcessId(heldProcess.pid);
  const guardian = new SandboxGuardianClient();
  const guardianExit = observeGuardianExit(guardian);
  const heldProcessExit = observeChildExit(heldProcess);
  let completed = false;
  let primaryFailure: unknown;

  try {
    await awaitWithin(
      guardian.createProbe(fixture.probeSpec(250)),
      'create the deadline-fenced fixed profile probe',
    );
    await awaitWithin(
      guardian.startProbe(),
      'acknowledge the deadline-fenced fixed profile probe start',
    );
    await fixture.setState('running');
    await fixture.holdRunningInspection();

    const observation = guardian.inspectProbe('live-cgroup');
    const observationRejection = assert.rejects(
      observation,
      /stopped before live cgroup/,
      'a running inspect result that arrives after the command deadline must not grant cgroup access',
    );
    await waitForLogLine(fixture.logPath, 'inspect-running-held');
    const terminal = await awaitWithin(
      guardian.probeCommandCompletion,
      'settle the fixed profile command deadline while inspection is held',
    );
    assert.equal(terminal.reason, 'deadline');

    await fixture.releaseRunningInspection();
    await observationRejection;

    await awaitWithin(
      guardian.stop('stopped'),
      'request final cleanup after the deadline-fenced inspection',
    );
    const completion = await awaitWithin(
      guardian.completion,
      'settle the deadline-fenced fixed profile probe cleanup',
    );
    assert.equal(completion.cleanupConfirmed, true);
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await collectCleanupStep(
      fixture.releaseRunningInspection(),
      'release the held fixed profile inspection after a test failure',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian.stop('stopped'),
      'stop the deadline-fenced fixed profile probe after a test failure',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian.completion,
      'settle the deadline-fenced fixed profile probe after a test failure',
      cleanupFailures,
    );
    if (heldProcess.exitCode === null && heldProcess.signalCode === null) {
      try {
        heldProcess.kill('SIGKILL');
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    await collectCleanupStep(
      heldProcessExit,
      'wait for the deadline-fenced fixed profile process after cleanup',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardianExit,
      'wait for the deadline-fenced fixed profile guardian process after cleanup',
      cleanupFailures,
    );
    await fixture.restore(primaryFailure !== undefined || cleanupFailures.length > 0 || !completed);
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained deadline-fenced fixed profile evidence: ${fixture.directory}`);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'The deadline-fenced fixed profile test cleanup failed independently.',
      );
    }
  }
});

test('live cgroup observation rejects a terminal fixed profile probe after start acknowledgement', async (t) => {
  const terminalFixture = await createFixedProfileProbeDockerFixture('short');
  const terminalGuardian = new SandboxGuardianClient();
  let completed = false;
  let primaryFailure: unknown;

  try {
    await awaitWithin(
      terminalGuardian.createProbe(terminalFixture.probeSpec()),
      'create the short fixed profile probe',
    );
    await awaitWithin(
      terminalGuardian.startProbe(),
      'acknowledge the short fixed profile probe start',
    );
    const terminal = await awaitWithin(
      terminalGuardian.probeCommandCompletion,
      'settle the short fixed profile command',
    );
    assert.equal(terminal.reason, 'completed');
    await assert.rejects(
      terminalGuardian.inspectProbe('live-cgroup'),
      /stopped before live cgroup|exited before live cgroup/,
      'a terminal command must not create a live cgroup observation',
    );
    await awaitWithin(terminalGuardian.stop('stopped'), 'stop the short fixed profile probe');
    assert.equal(
      (await awaitWithin(terminalGuardian.completion, 'settle the short fixed profile probe'))
        .cleanupConfirmed,
      true,
    );
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await collectCleanupStep(
      terminalGuardian.stop('stopped'),
      'stop the short fixed profile probe after a test failure',
      cleanupFailures,
    );
    await collectCleanupStep(
      terminalGuardian.completion,
      'settle the short fixed profile probe after a test failure',
      cleanupFailures,
    );
    await terminalFixture.restore(
      primaryFailure !== undefined || cleanupFailures.length > 0 || !completed,
    );
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained terminal fixed profile probe evidence: ${terminalFixture.directory}`);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'The terminal fixed profile probe cleanup failed independently.',
      );
    }
  }
});

test('live cgroup observation rejects a mismatched fixed profile identity before reading cgroups', async (t) => {
  const fixture = await createFixedProfileProbeDockerFixture('held');
  const guardian = new SandboxGuardianClient();
  let completed = false;
  let primaryFailure: unknown;

  try {
    await awaitWithin(
      guardian.createProbe(fixture.probeSpec()),
      'create the mismatched fixed profile probe',
    );
    await awaitWithin(
      guardian.startProbe(),
      'acknowledge the mismatched fixed profile probe start',
    );
    await fixture.setState('mismatch');
    await assert.rejects(
      guardian.inspectProbe('live-cgroup'),
      /identity no longer matches/,
      'a foreign identity must fail before any cgroup observation',
    );
    await awaitWithin(guardian.stop('stopped'), 'stop the mismatched fixed profile probe');
    assert.equal(
      (await awaitWithin(guardian.completion, 'settle the mismatched fixed profile probe'))
        .cleanupConfirmed,
      true,
    );
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await collectCleanupStep(
      guardian.stop('stopped'),
      'stop the mismatched fixed profile probe after a test failure',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian.completion,
      'settle the mismatched fixed profile probe after a test failure',
      cleanupFailures,
    );
    await fixture.restore(primaryFailure !== undefined || cleanupFailures.length > 0 || !completed);
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained mismatch fixed profile probe evidence: ${fixture.directory}`);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'The mismatched fixed profile probe cleanup failed independently.',
      );
    }
  }
});

test('cancelling a pending fixed profile observation rejects it without granting a late cgroup snapshot', async (t) => {
  const fixture = await createFixedProfileProbeDockerFixture('held');
  const guardian = new SandboxGuardianClient();
  let completed = false;
  let primaryFailure: unknown;

  try {
    await awaitWithin(
      guardian.createProbe(fixture.probeSpec()),
      'create the cancellable fixed profile probe',
    );
    await awaitWithin(
      guardian.startProbe(),
      'acknowledge the cancellable fixed profile probe start',
    );
    const observation = guardian.inspectProbe('live-cgroup');
    await waitForLogLine(fixture.logPath, 'inspect-created');
    await awaitWithin(guardian.stop('stopped'), 'cancel the pending fixed profile probe');
    await assert.rejects(
      observation,
      /stopped before live cgroup|sandbox guardian is closed/,
      'cancellation must reject the pending live cgroup observation before it can return a snapshot',
    );
    const completion = await awaitWithin(
      guardian.completion,
      'settle the cancelled fixed profile probe',
    );
    assert.equal(completion.cleanupConfirmed, true);
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await collectCleanupStep(
      guardian.stop('stopped'),
      'stop the cancellable fixed profile probe after a test failure',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian.completion,
      'settle the cancellable fixed profile probe after a test failure',
      cleanupFailures,
    );
    await fixture.restore(primaryFailure !== undefined || cleanupFailures.length > 0 || !completed);
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained cancelled fixed profile probe evidence: ${fixture.directory}`);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'The cancelled fixed profile probe cleanup failed independently.',
      );
    }
  }
});

test('a held fixed command terminal prevents final removal from overtaking its first result', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-fixed-probe-terminal-'));
  const dockerPath = join(directory, 'docker');
  const commandReleasePath = join(directory, 'command.release');
  const inspectReleasePath = join(directory, 'inspect.release');
  const inspectCountPath = join(directory, 'inspect.count');
  const logPath = join(directory, 'docker.log');
  const originalPath = process.env.PATH;
  const originalCommandRelease = process.env.QDROID_TEST_COMMAND_RELEASE;
  const originalInspectRelease = process.env.QDROID_TEST_INSPECT_RELEASE;
  const originalInspectCount = process.env.QDROID_TEST_INSPECT_COUNT;
  const originalLog = process.env.QDROID_TEST_DOCKER_LOG;
  const imageId = `sha256:${'a'.repeat(64)}`;
  const containerId = 'a'.repeat(64);
  const ownerId = 'trusted-fixed-probe-owner';
  const sessionId = '11962252-5ae0-48c8-8a2d-70a06d690a0d';

  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  create)
    printf '%s\\n' '${containerId}'
    ;;
  inspect)
    if [ "$2" = "--format" ]; then
      inspect_count=0
      if [ -f "$QDROID_TEST_INSPECT_COUNT" ]; then
        inspect_count=$(cat "$QDROID_TEST_INSPECT_COUNT")
      fi
      inspect_count=$((inspect_count + 1))
      printf '%s\\n' "$inspect_count" > "$QDROID_TEST_INSPECT_COUNT"
      if [ "$inspect_count" -eq 1 ]; then
        printf '%s\\n' command-terminal-inspect >> "$QDROID_TEST_DOCKER_LOG"
        while [ ! -f "$QDROID_TEST_INSPECT_RELEASE" ]; do sleep 0.01; done
      else
        printf '%s\\n' cleanup-inspect >> "$QDROID_TEST_DOCKER_LOG"
      fi
      printf '%s\\n' 'false 0'
    else
      if [ -f "$QDROID_TEST_DOCKER_LOG" ] && grep -q '^started$' "$QDROID_TEST_DOCKER_LOG"; then
        printf '%s\\n' '[{"Id":"${containerId}","Image":"${imageId}","Config":{"Labels":{"io.qdroid.owner":"${ownerId}","io.qdroid.profile":"qdroid.t002.readonly-sim/v1","io.qdroid.session":"${sessionId}"}},"State":{"Running":true,"Pid":123,"ExitCode":0,"OOMKilled":false}}]'
      else
        printf '%s\\n' '[{"Id":"${containerId}","Image":"${imageId}","Config":{"Labels":{"io.qdroid.owner":"${ownerId}","io.qdroid.profile":"qdroid.t002.readonly-sim/v1","io.qdroid.session":"${sessionId}"}},"State":{"Running":false,"ExitCode":0,"OOMKilled":false}}]'
      fi
    fi
    ;;
  start)
    printf '%s\\n' started >> "$QDROID_TEST_DOCKER_LOG"
    while [ ! -f "$QDROID_TEST_COMMAND_RELEASE" ]; do sleep 0.01; done
    ;;
  stop)
    printf '%s\\n' stop >> "$QDROID_TEST_DOCKER_LOG"
    ;;
  rm)
    printf '%s\\n' rm >> "$QDROID_TEST_DOCKER_LOG"
    ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.QDROID_TEST_COMMAND_RELEASE = commandReleasePath;
  process.env.QDROID_TEST_INSPECT_RELEASE = inspectReleasePath;
  process.env.QDROID_TEST_INSPECT_COUNT = inspectCountPath;
  process.env.QDROID_TEST_DOCKER_LOG = logPath;

  const guardian = new SandboxGuardianClient();
  let primaryFailure: unknown;
  let completed = false;
  try {
    await awaitWithin(
      guardian.createProbe({
        containerName: 'qdroid-t005-probe-11962252-5ae0-48c8-8a2d-70a06d690a0d',
        deadlineMs: 1_000,
        imageId,
        intent: { kind: 'legacy-fixed-program', program: 'scratch-write' },
        maxOutputBytes: 8_192,
        ownership: {
          imageId,
          labels: {
            'io.qdroid.owner': ownerId,
            'io.qdroid.profile': 'qdroid.t002.readonly-sim/v1',
            'io.qdroid.session': sessionId,
          },
        },
        protocol: FIXED_PROBE_PROTOCOL,
      }),
      'create the controlled fixed probe',
    );
    await awaitWithin(guardian.startProbe(), 'start the controlled fixed probe');
    await waitForPath(logPath, 'the fixed probe command start');
    await writeFile(commandReleasePath, 'release\n', { mode: 0o600 });
    await waitForLogLine(logPath, 'command-terminal-inspect');

    await awaitWithin(guardian.stop('stopped'), 'stop the controlled fixed probe');
    assert.equal(
      await settlesWithin(guardian.completion, 50),
      false,
      'final cleanup must wait for the in-flight command terminal inspection',
    );
    const pendingLog = await readFile(logPath, 'utf8');
    assert.doesNotMatch(pendingLog, /^cleanup-inspect$/m);
    assert.doesNotMatch(pendingLog, /^rm$/m);

    await writeFile(inspectReleasePath, 'release\n', { mode: 0o600 });
    const command = await awaitWithin(
      guardian.probeCommandCompletion,
      'the fixed probe command terminal after release',
    );
    assert.deepEqual(command, {
      cleanupConfirmed: false,
      exitCode: 0,
      reason: 'completed',
      stderrBytes: 0,
      stdoutBytes: 0,
    });

    const completion = await awaitWithin(
      guardian.completion,
      'final fixed probe cleanup after release',
    );
    assert.equal(completion.cleanupConfirmed, true);
    assert.equal(completion.exitCode, 0);
    assert.equal(completion.reason, 'completed');
    await waitForLogLine(logPath, 'rm');
    await waitForLogLine(logPath, 'cleanup-inspect');
    const log = await readFile(logPath, 'utf8');
    assert.ok(log.indexOf('command-terminal-inspect') < log.indexOf('cleanup-inspect'));
    assert.ok(log.indexOf('command-terminal-inspect') < log.indexOf('rm'));
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await collectCleanupStep(
      writeFile(commandReleasePath, 'release\n', { flag: 'a', mode: 0o600 }),
      'release the fixed probe command',
      cleanupFailures,
    );
    await collectCleanupStep(
      writeFile(inspectReleasePath, 'release\n', { flag: 'a', mode: 0o600 }),
      'release the fixed probe terminal inspection',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian.stop('stopped'),
      'stop the controlled fixed probe guardian',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian.completion,
      'settle the controlled fixed probe guardian',
      cleanupFailures,
    );
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalCommandRelease === undefined) {
      delete process.env.QDROID_TEST_COMMAND_RELEASE;
    } else {
      process.env.QDROID_TEST_COMMAND_RELEASE = originalCommandRelease;
    }
    if (originalInspectRelease === undefined) {
      delete process.env.QDROID_TEST_INSPECT_RELEASE;
    } else {
      process.env.QDROID_TEST_INSPECT_RELEASE = originalInspectRelease;
    }
    if (originalInspectCount === undefined) {
      delete process.env.QDROID_TEST_INSPECT_COUNT;
    } else {
      process.env.QDROID_TEST_INSPECT_COUNT = originalInspectCount;
    }
    if (originalLog === undefined) {
      delete process.env.QDROID_TEST_DOCKER_LOG;
    } else {
      process.env.QDROID_TEST_DOCKER_LOG = originalLog;
    }
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained fixed probe terminal race evidence: ${directory}`);
    } else {
      await rm(directory, { force: true, recursive: true });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'The fixed probe terminal race failed and cleanup did not settle independently.',
      );
    }
  }
});

test('a held fixed command failure remains visible after successful final removal', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-fixed-probe-terminal-failure-'));
  const dockerPath = join(directory, 'docker');
  const commandReleasePath = join(directory, 'command.release');
  const inspectReleasePath = join(directory, 'inspect.release');
  const inspectCountPath = join(directory, 'inspect.count');
  const logPath = join(directory, 'docker.log');
  const originalPath = process.env.PATH;
  const originalCommandRelease = process.env.QDROID_TEST_COMMAND_RELEASE;
  const originalInspectRelease = process.env.QDROID_TEST_INSPECT_RELEASE;
  const originalInspectCount = process.env.QDROID_TEST_INSPECT_COUNT;
  const originalLog = process.env.QDROID_TEST_DOCKER_LOG;
  const imageId = `sha256:${'c'.repeat(64)}`;
  const containerId = 'c'.repeat(64);
  const ownerId = 'trusted-fixed-probe-owner';
  const sessionId = '37236ed4-7e4d-4c9a-b9ca-a37d97793300';

  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  create)
    printf '%s\\n' '${containerId}'
    ;;
  inspect)
    if [ "$2" = "--format" ]; then
      printf '%s\\n' command-terminal-inspect >> "$QDROID_TEST_DOCKER_LOG"
      while [ ! -f "$QDROID_TEST_INSPECT_RELEASE" ]; do sleep 0.01; done
      inspect_count=0
      if [ -f "$QDROID_TEST_INSPECT_COUNT" ]; then
        inspect_count=$(cat "$QDROID_TEST_INSPECT_COUNT")
      fi
      inspect_count=$((inspect_count + 1))
      printf '%s\\n' "$inspect_count" > "$QDROID_TEST_INSPECT_COUNT"
      if [ "$inspect_count" -eq 1 ]; then
        printf '%s\\n' 'false 0'
        printf '%s\\n' 'command terminal inspect failed' >&2
        exit 23
      fi
      printf '%s\\n' cleanup-inspect >> "$QDROID_TEST_DOCKER_LOG"
      printf '%s\\n' 'false 0'
    else
      if [ -f "$QDROID_TEST_DOCKER_LOG" ] && grep -q '^started$' "$QDROID_TEST_DOCKER_LOG"; then
        printf '%s\\n' '[{"Id":"${containerId}","Image":"${imageId}","Config":{"Labels":{"io.qdroid.owner":"${ownerId}","io.qdroid.profile":"qdroid.t002.readonly-sim/v1","io.qdroid.session":"${sessionId}"}},"State":{"Running":true,"Pid":123,"ExitCode":0,"OOMKilled":false}}]'
      else
        printf '%s\\n' '[{"Id":"${containerId}","Image":"${imageId}","Config":{"Labels":{"io.qdroid.owner":"${ownerId}","io.qdroid.profile":"qdroid.t002.readonly-sim/v1","io.qdroid.session":"${sessionId}"}},"State":{"Running":false,"ExitCode":0,"OOMKilled":false}}]'
      fi
    fi
    ;;
  start)
    printf '%s\\n' started >> "$QDROID_TEST_DOCKER_LOG"
    while [ ! -f "$QDROID_TEST_COMMAND_RELEASE" ]; do sleep 0.01; done
    ;;
  stop)
    printf '%s\\n' stop >> "$QDROID_TEST_DOCKER_LOG"
    ;;
  rm)
    printf '%s\\n' rm >> "$QDROID_TEST_DOCKER_LOG"
    ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.QDROID_TEST_COMMAND_RELEASE = commandReleasePath;
  process.env.QDROID_TEST_INSPECT_RELEASE = inspectReleasePath;
  process.env.QDROID_TEST_INSPECT_COUNT = inspectCountPath;
  process.env.QDROID_TEST_DOCKER_LOG = logPath;

  const guardian = new SandboxGuardianClient();
  const guardianExit = observeGuardianExit(guardian);
  let primaryFailure: unknown;
  let completed = false;
  try {
    await awaitWithin(
      guardian.createProbe({
        containerName: `qdroid-t005-probe-${sessionId}`,
        deadlineMs: 1_000,
        imageId,
        intent: { kind: 'legacy-fixed-program', program: 'scratch-write' },
        maxOutputBytes: 8_192,
        ownership: {
          imageId,
          labels: {
            'io.qdroid.owner': ownerId,
            'io.qdroid.profile': 'qdroid.t002.readonly-sim/v1',
            'io.qdroid.session': sessionId,
          },
        },
        protocol: FIXED_PROBE_PROTOCOL,
      }),
      'create the controlled fixed probe with a held command inspection',
    );
    await awaitWithin(guardian.startProbe(), 'start the held fixed probe command');
    await waitForPath(logPath, 'the held fixed probe command start');
    await writeFile(commandReleasePath, 'release\n', { mode: 0o600 });
    await waitForLogLine(logPath, 'command-terminal-inspect');

    await awaitWithin(guardian.stop('stopped'), 'stop while the command inspection is held');
    assert.equal(
      await settlesWithin(guardian.completion, 50),
      false,
      'final cleanup must join the held command terminal before it removes the container',
    );

    await writeFile(inspectReleasePath, 'release\n', { mode: 0o600 });
    const command = await awaitWithin(
      guardian.probeCommandCompletion,
      'settle the held command inspection failure',
    );
    assert.match(command.errorMessage ?? '', /Docker inspect failed \(exit code 23/);
    assert.match(command.errorMessage ?? '', /command terminal inspect failed/);

    const completion = await awaitWithin(
      guardian.completion,
      'settle final cleanup after the retained command failure',
    );
    assert.equal(completion.cleanupConfirmed, false);
    assert.match(completion.errorMessage ?? '', /Docker inspect failed \(exit code 23/);
    assert.match(completion.errorMessage ?? '', /command terminal inspect failed/);
    await waitForLogLine(logPath, 'cleanup-inspect');
    await waitForLogLine(logPath, 'rm');
    await awaitWithin(guardianExit, 'wait for the held command failure guardian');
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await collectCleanupStep(
      writeFile(commandReleasePath, 'release\n', { flag: 'a', mode: 0o600 }),
      'release the held fixed command after a test failure',
      cleanupFailures,
    );
    await collectCleanupStep(
      writeFile(inspectReleasePath, 'release\n', { flag: 'a', mode: 0o600 }),
      'release the held command inspection after a test failure',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian.stop('stopped'),
      'stop the held command failure guardian after a test failure',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian.completion,
      'settle the held command failure guardian after a test failure',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardianExit,
      'wait for the held command failure guardian after a test failure',
      cleanupFailures,
    );
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalCommandRelease === undefined) {
      delete process.env.QDROID_TEST_COMMAND_RELEASE;
    } else {
      process.env.QDROID_TEST_COMMAND_RELEASE = originalCommandRelease;
    }
    if (originalInspectRelease === undefined) {
      delete process.env.QDROID_TEST_INSPECT_RELEASE;
    } else {
      process.env.QDROID_TEST_INSPECT_RELEASE = originalInspectRelease;
    }
    if (originalInspectCount === undefined) {
      delete process.env.QDROID_TEST_INSPECT_COUNT;
    } else {
      process.env.QDROID_TEST_INSPECT_COUNT = originalInspectCount;
    }
    if (originalLog === undefined) {
      delete process.env.QDROID_TEST_DOCKER_LOG;
    } else {
      process.env.QDROID_TEST_DOCKER_LOG = originalLog;
    }
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained held command failure evidence: ${directory}`);
    } else {
      await rm(directory, { force: true, recursive: true });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'The held command failure cleanup did not settle independently.',
      );
    }
  }
});

test('a missing fixed native command settles as unknown without crashing the guardian', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-guardian-native-path-'));
  const originalPath = process.env.PATH;

  try {
    process.env.PATH = directory;
    const guardian = new SandboxGuardianClient();

    await guardian.startNative({
      deadlineMs: 1_000,
      intent: { kind: 'docker-runtime-info' },
      maxOutputBytes: 1_024,
    });
    const completion = await guardian.completion;

    assert.equal(completion.cleanupConfirmed, false);
    assert.equal(completion.reason, 'stopped');
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('an assembly keeper waits for a live copy writer before parent-loss cleanup', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Assembly keeper process-group verification requires the trusted Linux host.');
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'qdroid-assembly-copy-settlement-'));
  const dockerPath = join(directory, 'docker');
  const copyReleasePath = join(directory, 'copy.release');
  const logPath = join(directory, 'docker.log');
  const resourceId = 'assembly-90a8d0bb-7bca-4187-b3c2-4e69e0ec079b';
  const candidateId = 'candidate-a1b2c3d4-0000-4000-8000-000000000001';
  const sessionId = candidateId;
  const containerId = 'e'.repeat(64);
  const sourceImage = `sha256:${'a'.repeat(64)}`;
  const packageDigest = 'b'.repeat(64);
  const packageDirectory = join(directory, 'content', packageDigest);
  const templateDirectory = join(
    directory,
    'runtime-sessions',
    sessionId,
    `assembly-template-${resourceId.slice('assembly-'.length)}`,
  );
  const terminalReceiptPath = join(
    dirname(templateDirectory),
    `${resourceId}.assembly-terminal.json`,
  );
  const creationReceiptPath = join(
    dirname(templateDirectory),
    `${resourceId}.assembly-created.json`,
  );
  const commitReceiptPath = join(
    dirname(templateDirectory),
    `${resourceId}.assembly-committed.json`,
  );
  const originalPath = process.env.PATH;
  const originalCopyRelease = process.env.QDROID_TEST_ASSEMBLY_COPY_RELEASE;
  const originalLog = process.env.QDROID_TEST_ASSEMBLY_LOG;

  let guardian: SandboxGuardianClient | undefined;
  let completed = false;
  let primaryFailure: unknown;
  try {
    await mkdir(packageDirectory, { mode: 0o700, recursive: true });
    await writeFile(join(packageDirectory, 'payload.txt'), 'frozen payload\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await mkdir(dirname(templateDirectory), { mode: 0o700, recursive: true });
    await writeFile(
      dockerPath,
      `#!/bin/sh
case "$1" in
  create)
    printf '%s\\n' '${containerId}'
    ;;
  inspect)
    if [ "$2" = "--format" ]; then
      if [ -f "${join(directory, 'removed')}" ]; then
        printf '%s\\n' "Error: No such object: $4" >&2
        exit 1
      fi
      case "$4" in
        qdroid-t005-assembly-*)
          printf '%s %s trusted-owner ${sessionId} ${resourceId} ${candidateId} runtime\\n' '${containerId}' '${sourceImage}'
          ;;
        sha256:*)
          printf '%s\\n' "$4"
          ;;
      esac
    fi
    ;;
  cp)
    printf '%s\\n' copy-start >> "$QDROID_TEST_ASSEMBLY_LOG"
    while [ ! -f "$QDROID_TEST_ASSEMBLY_COPY_RELEASE" ]; do sleep 0.01; done
    printf '%s\\n' copy-settled >> "$QDROID_TEST_ASSEMBLY_LOG"
    ;;
  rm)
    printf '%s\\n' rm >> "$QDROID_TEST_ASSEMBLY_LOG"
    : > '${join(directory, 'removed')}'
    ;;
  commit)
    printf '%s\\n' 'sha256:${'c'.repeat(64)}'
    ;;
esac
`,
      { encoding: 'utf8', mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_ASSEMBLY_COPY_RELEASE = copyReleasePath;
    process.env.QDROID_TEST_ASSEMBLY_LOG = logPath;
    guardian = new SandboxGuardianClient();

    await awaitWithin(
      guardian.startAssembly({
        bootId: '12345678-1234-1234-1234-123456789abc',
        candidateId,
        commitReceiptPath,
        containerName: `qdroid-t005-assembly-${resourceId.slice('assembly-'.length)}`,
        creationReceiptPath,
        deadlineMs: 5_000,
        journalKey: Buffer.alloc(32, 7),
        materialDigest: 'd'.repeat(64),
        ownerId: 'trusted-owner',
        packageDirectory,
        packageDigest,
        platform: 'linux/arm64',
        protocol: FIXED_ASSEMBLY_PROTOCOL,
        purpose: 'runtime',
        resourceId,
        sessionId,
        sourceImage,
        templateDirectory,
        terminalReceiptPath,
      }),
      'create the controlled managed assembly container',
    );

    const copying = guardian.copyAssembly();
    void copying.catch(() => undefined);
    await waitForLogLine(logPath, 'copy-start');
    await guardian.stop('stopped');
    assert.equal(
      await settlesWithin(guardian.completion, 50),
      false,
      'cleanup must not overtake the live Docker copy writer after parent loss',
    );
    const logBeforeRelease = await readFile(logPath, 'utf8');
    assert.doesNotMatch(logBeforeRelease, /^rm$/m);

    await writeFile(copyReleasePath, 'release\n', { encoding: 'utf8', mode: 0o600 });
    await assert.rejects(
      awaitWithin(copying, 'settle the controlled managed assembly copy'),
      /parent disconnected before the phase settled/,
      'parent loss must prevent later assembly copy commands',
    );
    const completion = await awaitWithin(
      guardian.completion,
      'settle the managed assembly keeper after the copy writer exits',
    );
    assert.equal(
      completion.cleanupConfirmed,
      true,
      'a stopped pre-commit assembly can confirm exact temporary cleanup',
    );
    await waitForLogLine(logPath, 'rm');
    const receipt = JSON.parse(await readFile(terminalReceiptPath, 'utf8')) as {
      readonly dependencies: {
        readonly commit: { readonly settled: boolean | null };
        readonly copy: { readonly settled: boolean | null };
      };
    };
    assert.equal(receipt.dependencies.copy.settled, false);
    assert.equal(receipt.dependencies.commit.settled, null);
    const log = await readFile(logPath, 'utf8');
    assert.ok(log.indexOf('copy-settled') < log.indexOf('rm'));
    assert.equal(
      log.split('\n').filter((line) => line === 'copy-start').length,
      1,
      'parent loss must prevent source or generated copy after the held template copy settles',
    );
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await collectCleanupStep(
      writeFile(copyReleasePath, 'release\n', { flag: 'a', mode: 0o600 }),
      'release the controlled managed assembly copy',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian?.stop('stopped') ?? Promise.resolve(),
      'stop the controlled managed assembly keeper',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian?.completion ?? Promise.resolve(),
      'settle the controlled managed assembly keeper',
      cleanupFailures,
    );
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalCopyRelease === undefined) {
      delete process.env.QDROID_TEST_ASSEMBLY_COPY_RELEASE;
    } else {
      process.env.QDROID_TEST_ASSEMBLY_COPY_RELEASE = originalCopyRelease;
    }
    if (originalLog === undefined) {
      delete process.env.QDROID_TEST_ASSEMBLY_LOG;
    } else {
      process.env.QDROID_TEST_ASSEMBLY_LOG = originalLog;
    }
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained managed assembly copy-settlement evidence: ${directory}`);
    } else {
      await rm(directory, { force: true, recursive: true });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'Managed assembly copy-settlement cleanup failed independently.',
      );
    }
  }
});

test('a SIGKILL parent cannot make an assembly keeper delete a live copy dependency', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Assembly parent-loss ownership requires the trusted Linux host.');
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'qdroid-assembly-parent-loss-'));
  const dockerPath = join(directory, 'docker');
  const copyReleasePath = join(directory, 'copy.release');
  const logPath = join(directory, 'docker.log');
  const removedPath = join(directory, 'removed');
  const sessionId = 'candidate-98c139d3-f6ed-4c4e-9a94-13e98e3ecdd8';
  const resourceId = 'assembly-98c139d3-f6ed-4c4e-9a94-13e98e3ecdd8';
  const containerId = 'e'.repeat(64);
  const sourceImage = `sha256:${'a'.repeat(64)}`;
  const packageDigest = 'b'.repeat(64);
  const terminalReceiptPath = join(
    directory,
    'runtime-sessions',
    sessionId,
    `${resourceId}.assembly-terminal.json`,
  );
  const packageDirectory = join(directory, 'content', packageDigest);
  const childPath = new URL('./assembly-keeper-parent-loss-child.js', import.meta.url).pathname;
  let child: ReturnType<typeof spawn> | undefined;
  let guardianProcessGroup: number | undefined;
  let completed = false;
  let primaryFailure: unknown;

  try {
    await mkdir(packageDirectory, { mode: 0o700, recursive: true });
    await writeFile(join(packageDirectory, 'payload.txt'), 'frozen payload\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await mkdir(dirname(terminalReceiptPath), { mode: 0o700, recursive: true });
    await writeFile(
      dockerPath,
      `#!/bin/sh
case "$1" in
  create)
    printf '%s\\n' '${containerId}'
    ;;
  inspect)
    if [ "$2" = "--format" ]; then
      if [ -f '${removedPath}' ]; then
        printf '%s\\n' "Error: No such object: $4" >&2
        exit 1
      fi
      printf '%s %s trusted-owner ${sessionId} ${resourceId} candidate-98c139d3-f6ed-4c4e-9a94-13e98e3ecdd8 runtime\\n' '${containerId}' '${sourceImage}'
    fi
    ;;
  cp)
    printf '%s\\n' copy-start >> "$QDROID_TEST_ASSEMBLY_LOG"
    while [ ! -f "$QDROID_TEST_ASSEMBLY_COPY_RELEASE" ]; do sleep 0.01; done
    printf '%s\\n' copy-settled >> "$QDROID_TEST_ASSEMBLY_LOG"
    ;;
  rm)
    printf '%s\\n' rm >> "$QDROID_TEST_ASSEMBLY_LOG"
    : > '${removedPath}'
    ;;
esac
`,
      { encoding: 'utf8', mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    child = spawn(process.execPath, [childPath], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        QDROID_TEST_ASSEMBLY_COPY_RELEASE: copyReleasePath,
        QDROID_TEST_ASSEMBLY_LOG: logPath,
        QDROID_TEST_ASSEMBLY_ROOT: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.notEqual(child.stdout, null);
    const readiness = await awaitFixtureJson(
      child.stdout as NodeJS.ReadableStream,
      'assembly parent-loss copy admission',
    );
    assert.equal(typeof readiness.guardianPid, 'number');
    assert.equal(readiness.terminalReceiptPath, terminalReceiptPath);
    guardianProcessGroup = await readProcessGroupId(readiness.guardianPid as number);

    assert.equal(child.kill('SIGKILL'), true);
    const exit = await awaitChildExit(child, 'SIGKILL the assembly fixture parent');
    assert.equal(exit.signal, 'SIGKILL');
    await delay(100);
    await assert.rejects(access(removedPath));
    await assert.rejects(access(terminalReceiptPath));

    await writeFile(copyReleasePath, 'release\n', { encoding: 'utf8', mode: 0o600 });
    await waitForLogLine(logPath, 'rm');
    await waitForPath(terminalReceiptPath, 'the keeper terminal receipt after copy settlement');
    const receipt = JSON.parse(await readFile(terminalReceiptPath, 'utf8')) as {
      readonly cleanup: { readonly containerRemoved: boolean; readonly templateRemoved: boolean };
      readonly dependencies: {
        readonly commit: { readonly settled: boolean | null };
        readonly copy: { readonly settled: boolean | null };
      };
    };
    assert.equal(receipt.dependencies.copy.settled, false);
    assert.equal(receipt.dependencies.commit.settled, null);
    assert.equal(receipt.cleanup.containerRemoved, true);
    assert.equal(receipt.cleanup.templateRemoved, true);
    const dockerLog = await readFile(logPath, 'utf8');
    assert.equal(
      dockerLog.split('\n').filter((line) => line === 'copy-start').length,
      1,
      'parent loss must not authorize a later source or generated copy',
    );
    assert.doesNotMatch(dockerLog, /^commit$/m);
    await waitForProcessGroupExit(
      guardianProcessGroup,
      'the detached assembly keeper process group',
    );
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await collectCleanupStep(
      writeFile(copyReleasePath, 'release\n', { flag: 'a', mode: 0o600 }),
      'release the assembly parent-loss copy helper',
      cleanupFailures,
    );
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        cleanupFailures.push(error);
      }
      await collectCleanupStep(
        awaitChildExit(child, 'stop the assembly fixture parent'),
        'wait for the assembly fixture parent',
        cleanupFailures,
      );
    }
    if (guardianProcessGroup !== undefined) {
      await collectCleanupStep(
        waitForProcessGroupExit(guardianProcessGroup, 'the assembly keeper process group'),
        'wait for the assembly keeper process group',
        cleanupFailures,
      );
    }
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained assembly parent-loss evidence: ${directory}`);
    } else {
      await rm(directory, { force: true, recursive: true });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'Assembly parent-loss fixture cleanup failed independently.',
      );
    }
  }
});

test('an assembly keeper preserves a replaced template child instead of recursively removing it', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Assembly template ownership requires the trusted Linux host.');
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'qdroid-assembly-template-child-'));
  const dockerPath = join(directory, 'docker');
  const copyReleasePath = join(directory, 'copy.release');
  const logPath = join(directory, 'docker.log');
  const removedPath = join(directory, 'removed');
  const resourceId = 'assembly-d7e327ea-0acf-42ce-a525-907509249bc8';
  const candidateId = 'candidate-d7e327ea-0acf-42ce-a525-907509249bc8';
  const sessionId = candidateId;
  const containerId = 'e'.repeat(64);
  const sourceImage = `sha256:${'a'.repeat(64)}`;
  const packageDigest = 'b'.repeat(64);
  const packageDirectory = join(directory, 'content', packageDigest);
  const templateDirectory = join(
    directory,
    'runtime-sessions',
    sessionId,
    `assembly-template-${resourceId.slice('assembly-'.length)}`,
  );
  const creationReceiptPath = join(
    dirname(templateDirectory),
    `${resourceId}.assembly-created.json`,
  );
  const commitReceiptPath = join(
    dirname(templateDirectory),
    `${resourceId}.assembly-committed.json`,
  );
  const terminalReceiptPath = join(
    dirname(templateDirectory),
    `${resourceId}.assembly-terminal.json`,
  );
  const replacedChildPath = join(templateDirectory, 'opt', 'qdroid');
  const originalPath = process.env.PATH;
  const originalCopyRelease = process.env.QDROID_TEST_ASSEMBLY_COPY_RELEASE;
  const originalLog = process.env.QDROID_TEST_ASSEMBLY_LOG;
  let guardian: SandboxGuardianClient | undefined;
  let guardianProcessGroup: number | undefined;
  let completed = false;
  let primaryFailure: unknown;

  try {
    await mkdir(packageDirectory, { mode: 0o700, recursive: true });
    await writeFile(join(packageDirectory, 'payload.txt'), 'frozen payload\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await mkdir(dirname(templateDirectory), { mode: 0o700, recursive: true });
    await writeFile(
      dockerPath,
      `#!/bin/sh
case "$1" in
  create)
    printf '%s\\n' '${containerId}'
    ;;
  inspect)
    if [ "$2" = "--format" ]; then
      if [ -f '${removedPath}' ]; then
        printf '%s\\n' "Error: No such object: $4" >&2
        exit 1
      fi
      printf '%s %s trusted-owner ${sessionId} ${resourceId} ${candidateId} runtime\\n' '${containerId}' '${sourceImage}'
    fi
    ;;
  cp)
    printf '%s\\n' template-copy-start >> "$QDROID_TEST_ASSEMBLY_LOG"
    while [ ! -f "$QDROID_TEST_ASSEMBLY_COPY_RELEASE" ]; do sleep 0.01; done
    ;;
  rm)
    printf '%s\\n' rm >> "$QDROID_TEST_ASSEMBLY_LOG"
    : > '${removedPath}'
    ;;
esac
`,
      { encoding: 'utf8', mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_ASSEMBLY_COPY_RELEASE = copyReleasePath;
    process.env.QDROID_TEST_ASSEMBLY_LOG = logPath;
    guardian = new SandboxGuardianClient();
    guardianProcessGroup = await readProcessGroupId(guardian.pid as number);

    await awaitWithin(
      guardian.startAssembly({
        bootId: '12345678-1234-1234-1234-123456789abc',
        candidateId,
        commitReceiptPath,
        containerName: `qdroid-t005-assembly-${resourceId.slice('assembly-'.length)}`,
        creationReceiptPath,
        deadlineMs: 5_000,
        journalKey: Buffer.alloc(32, 7),
        materialDigest: 'd'.repeat(64),
        ownerId: 'trusted-owner',
        packageDirectory,
        packageDigest,
        platform: 'linux/arm64',
        protocol: FIXED_ASSEMBLY_PROTOCOL,
        purpose: 'runtime',
        resourceId,
        sessionId,
        sourceImage,
        templateDirectory,
        terminalReceiptPath,
      }),
      'create the controlled managed assembly container',
    );

    const copying = guardian.copyAssembly();
    void copying.catch(() => undefined);
    await waitForLogLine(logPath, 'template-copy-start');

    await rm(replacedChildPath, { force: false, recursive: true });
    await mkdir(replacedChildPath, { mode: 0o700 });
    await writeFile(join(replacedChildPath, 'foreign-child.txt'), 'foreign\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await writeFile(copyReleasePath, 'release\n', { encoding: 'utf8', mode: 0o600 });

    await assert.rejects(
      copying,
      /could not confirm managed assembly template cleanup/,
      'a substituted template child must reject the copy phase',
    );
    const completion = await awaitWithin(
      guardian.completion,
      'settle the substituted-template managed assembly keeper',
    );
    assert.equal(completion.cleanupConfirmed, false);
    assert.equal((await lstat(replacedChildPath)).isDirectory(), true);
    assert.equal(
      await readFile(join(replacedChildPath, 'foreign-child.txt'), 'utf8'),
      'foreign\n',
      'the guardian must not recursively delete a foreign replacement child',
    );
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await collectCleanupStep(
      writeFile(copyReleasePath, 'release\n', { flag: 'a', mode: 0o600 }),
      'release the substituted-template copy helper',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian?.stop('stopped') ?? Promise.resolve(),
      'stop the substituted-template keeper',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian?.completion ?? Promise.resolve(),
      'settle the substituted-template keeper',
      cleanupFailures,
    );
    if (guardianProcessGroup !== undefined) {
      await collectCleanupStep(
        waitForProcessGroupExit(guardianProcessGroup, 'the substituted-template keeper group'),
        'wait for the substituted-template keeper group',
        cleanupFailures,
      );
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalCopyRelease === undefined) {
      delete process.env.QDROID_TEST_ASSEMBLY_COPY_RELEASE;
    } else {
      process.env.QDROID_TEST_ASSEMBLY_COPY_RELEASE = originalCopyRelease;
    }
    if (originalLog === undefined) {
      delete process.env.QDROID_TEST_ASSEMBLY_LOG;
    } else {
      process.env.QDROID_TEST_ASSEMBLY_LOG = originalLog;
    }
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained assembly child-replacement evidence: ${directory}`);
    } else {
      await rm(directory, { force: true, recursive: true });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'Assembly child-replacement fixture cleanup failed independently.',
      );
    }
  }
});

test('an assembly keeper preserves its committed image receipt when image inspection fails', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Assembly commit receipt persistence requires the trusted Linux host.');
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'qdroid-assembly-commit-receipt-'));
  const dockerPath = join(directory, 'docker');
  const logPath = join(directory, 'docker.log');
  const resourceId = 'assembly-4c15c859-4f1e-4ac6-8f47-9f4090e1d7d5';
  const candidateId = 'candidate-4c15c859-4f1e-4ac6-8f47-9f4090e1d7d5';
  const sessionId = candidateId;
  const containerId = 'e'.repeat(64);
  const imageId = `sha256:${'c'.repeat(64)}`;
  const sourceImage = `sha256:${'a'.repeat(64)}`;
  const packageDigest = 'b'.repeat(64);
  const removedPath = join(directory, 'removed');
  const packageDirectory = join(directory, 'content', packageDigest);
  const templateDirectory = join(
    directory,
    'runtime-sessions',
    sessionId,
    `assembly-template-${resourceId.slice('assembly-'.length)}`,
  );
  const creationReceiptPath = join(
    dirname(templateDirectory),
    `${resourceId}.assembly-created.json`,
  );
  const commitReceiptPath = join(
    dirname(templateDirectory),
    `${resourceId}.assembly-committed.json`,
  );
  const terminalReceiptPath = join(
    dirname(templateDirectory),
    `${resourceId}.assembly-terminal.json`,
  );
  const originalPath = process.env.PATH;
  const originalLog = process.env.QDROID_TEST_ASSEMBLY_LOG;
  let guardian: SandboxGuardianClient | undefined;
  let guardianProcessGroup: number | undefined;
  let completed = false;
  let primaryFailure: unknown;

  try {
    await mkdir(packageDirectory, { mode: 0o700, recursive: true });
    await writeFile(join(packageDirectory, 'payload.txt'), 'frozen payload\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await mkdir(dirname(templateDirectory), { mode: 0o700, recursive: true });
    await writeFile(
      dockerPath,
      `#!/bin/sh
case "$1" in
  create)
    printf '%s\\n' '${containerId}'
    ;;
  inspect)
    if [ "$2" = "--format" ]; then
      if [ -f '${removedPath}' ]; then
        printf '%s\\n' "Error: No such object: $4" >&2
        exit 1
      fi
      printf '%s %s trusted-owner ${sessionId} ${resourceId} ${candidateId} runtime\\n' '${containerId}' '${sourceImage}'
    fi
    ;;
  cp)
    printf '%s\\n' copy >> "$QDROID_TEST_ASSEMBLY_LOG"
    ;;
  commit)
    printf '%s\\n' commit >> "$QDROID_TEST_ASSEMBLY_LOG"
    printf '%s\\n' '${imageId}'
    ;;
  image)
    printf '%s\\n' image-inspect-failed >> "$QDROID_TEST_ASSEMBLY_LOG"
    exit 1
    ;;
  rm)
    printf '%s\\n' rm >> "$QDROID_TEST_ASSEMBLY_LOG"
    : > '${removedPath}'
    ;;
esac
`,
      { encoding: 'utf8', mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_ASSEMBLY_LOG = logPath;
    guardian = new SandboxGuardianClient();
    guardianProcessGroup = await readProcessGroupId(guardian.pid as number);

    await awaitWithin(
      guardian.startAssembly({
        bootId: '12345678-1234-1234-1234-123456789abc',
        candidateId,
        commitReceiptPath,
        containerName: `qdroid-t005-assembly-${resourceId.slice('assembly-'.length)}`,
        creationReceiptPath,
        deadlineMs: 5_000,
        journalKey: Buffer.alloc(32, 7),
        materialDigest: 'd'.repeat(64),
        ownerId: 'trusted-owner',
        packageDirectory,
        packageDigest,
        platform: 'linux/arm64',
        protocol: FIXED_ASSEMBLY_PROTOCOL,
        purpose: 'runtime',
        resourceId,
        sessionId,
        sourceImage,
        templateDirectory,
        terminalReceiptPath,
      }),
      'create the controlled managed assembly container',
    );
    await awaitWithin(guardian.copyAssembly(), 'copy the controlled managed assembly material');
    await assert.rejects(
      guardian.commitAssembly(),
      /could not inspect its committed managed assembly image/,
      'the failed post-commit inspection must not report a verified image',
    );

    const completion = await awaitWithin(
      guardian.completion,
      'settle the managed assembly after its image inspection failure',
    );
    assert.equal(completion.cleanupConfirmed, true);

    const commitReceipt = JSON.parse(await readFile(commitReceiptPath, 'utf8')) as {
      readonly imageId: string;
    };
    const terminalReceipt = JSON.parse(await readFile(terminalReceiptPath, 'utf8')) as {
      readonly errors: readonly string[];
      readonly imageId: string;
    };
    assert.equal(
      commitReceipt.imageId,
      imageId,
      'the pre-inspection commit receipt must retain the immutable image ID',
    );
    assert.equal(
      terminalReceipt.imageId,
      imageId,
      'the terminal result must retain the observed immutable image ID',
    );
    assert.ok(
      terminalReceipt.errors.some((error) => /could not inspect its committed/.test(error)),
      'the terminal receipt must retain the original failed inspection reason',
    );
    const dockerLog = await readFile(logPath, 'utf8');
    assert.equal(
      dockerLog.split('\n').filter((line) => line === 'commit').length,
      1,
      'the failed inspection must not repeat Docker commit',
    );
    assert.match(dockerLog, /^image-inspect-failed$/m);
    completed = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await collectCleanupStep(
      guardian?.stop('stopped') ?? Promise.resolve(),
      'stop the failed-commit keeper',
      cleanupFailures,
    );
    await collectCleanupStep(
      guardian?.completion ?? Promise.resolve(),
      'settle the failed-commit keeper',
      cleanupFailures,
    );
    if (guardianProcessGroup !== undefined) {
      await collectCleanupStep(
        waitForProcessGroupExit(guardianProcessGroup, 'the failed-commit keeper group'),
        'wait for the failed-commit keeper group',
        cleanupFailures,
      );
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalLog === undefined) {
      delete process.env.QDROID_TEST_ASSEMBLY_LOG;
    } else {
      process.env.QDROID_TEST_ASSEMBLY_LOG = originalLog;
    }
    if (primaryFailure !== undefined || cleanupFailures.length > 0 || !completed) {
      t.diagnostic(`Retained assembly commit receipt evidence: ${directory}`);
    } else {
      await rm(directory, { force: true, recursive: true });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'Assembly commit-receipt fixture cleanup failed independently.',
      );
    }
  }
});

type FixedProfileProbeDockerMode = 'held' | 'short';
type FixedProfileProbeDockerState = 'created' | 'exited' | 'mismatch' | 'running';

interface FixedProfileProbeDockerFixture {
  readonly directory: string;
  readonly logPath: string;
  holdRunningInspection(): Promise<void>;
  probeSpec(deadlineMs?: number): Parameters<SandboxGuardianClient['createProbe']>[0];
  releaseRunningInspection(): Promise<void>;
  restore(retain: boolean): Promise<void>;
  setLiveProcessId(processId: number | undefined): Promise<void>;
  setState(state: FixedProfileProbeDockerState): Promise<void>;
}

async function createFixedProfileProbeDockerFixture(
  mode: FixedProfileProbeDockerMode,
): Promise<FixedProfileProbeDockerFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-fixed-profile-probe-'));
  const dockerPath = join(directory, 'docker');
  const releasePath = join(directory, 'command.release');
  const inspectHoldPath = join(directory, 'inspect.running.hold');
  const inspectReleasePath = join(directory, 'inspect.running.release');
  const statePath = join(directory, 'state');
  const logPath = join(directory, 'docker.log');
  const imageId = `sha256:${'a'.repeat(64)}`;
  const containerId = 'a'.repeat(64);
  const ownerId = 'trusted-fixed-profile-owner';
  const sessionId = '6a9fb051-97aa-4cf2-92bc-7bfe91be065a';
  const profile = 'qdroid.t004.profile-catalog/v1:tool-offline';
  const environmentKeys = [
    'PATH',
    'QDROID_TEST_FIXED_PROBE_COMMAND_MODE',
    'QDROID_TEST_FIXED_PROBE_INSPECT_HOLD',
    'QDROID_TEST_FIXED_PROBE_INSPECT_RELEASE',
    'QDROID_TEST_FIXED_PROBE_LIVE_PID',
    'QDROID_TEST_FIXED_PROBE_LOG',
    'QDROID_TEST_FIXED_PROBE_RELEASE',
    'QDROID_TEST_FIXED_PROBE_STATE',
  ] as const;
  const originalEnvironment = new Map(
    environmentKeys.map((key) => [key, process.env[key]] as const),
  );

  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  create)
    printf '%s\\n' '${containerId}'
    ;;
  inspect)
    if [ "$2" = "--format" ]; then
      printf '%s %s %s %s %s\\n' '${containerId}' '${imageId}' '${ownerId}' '${profile}' '${sessionId}'
      exit 0
    fi
    state=$(cat "$QDROID_TEST_FIXED_PROBE_STATE")
    printf 'inspect-%s\\n' "$state" >> "$QDROID_TEST_FIXED_PROBE_LOG"
    case "$state" in
      created)
        printf '%s\\n' '[{"Id":"${containerId}","Image":"${imageId}","Config":{"Labels":{"io.qdroid.owner":"${ownerId}","io.qdroid.profile":"${profile}","io.qdroid.session":"${sessionId}"}},"State":{"Running":false,"Pid":0,"Status":"created","ExitCode":0,"OOMKilled":false}}]'
        ;;
      running)
        if [ -f "$QDROID_TEST_FIXED_PROBE_INSPECT_HOLD" ]; then
          printf '%s\\n' inspect-running-held >> "$QDROID_TEST_FIXED_PROBE_LOG"
          while [ ! -f "$QDROID_TEST_FIXED_PROBE_INSPECT_RELEASE" ]; do sleep 0.01; done
        fi
        printf '[{"Id":"${containerId}","Image":"${imageId}","Config":{"Labels":{"io.qdroid.owner":"${ownerId}","io.qdroid.profile":"${profile}","io.qdroid.session":"${sessionId}"}},"State":{"Running":true,"Pid":%s,"Status":"running","ExitCode":0,"OOMKilled":false}}]\\n' "$QDROID_TEST_FIXED_PROBE_LIVE_PID"
        ;;
      exited)
        printf '%s\\n' '[{"Id":"${containerId}","Image":"${imageId}","Config":{"Labels":{"io.qdroid.owner":"${ownerId}","io.qdroid.profile":"${profile}","io.qdroid.session":"${sessionId}"}},"State":{"Running":false,"Pid":0,"Status":"exited","ExitCode":0,"OOMKilled":false}}]'
        ;;
      mismatch)
        printf '%s\\n' '[{"Id":"${containerId}","Image":"${imageId}","Config":{"Labels":{"io.qdroid.owner":"${ownerId}","io.qdroid.profile":"${profile}","io.qdroid.session":"00000000-0000-4000-8000-000000000000"}},"State":{"Running":false,"Pid":0,"Status":"created","ExitCode":0,"OOMKilled":false}}]'
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  start)
    printf '%s\\n' start >> "$QDROID_TEST_FIXED_PROBE_LOG"
    if [ "$QDROID_TEST_FIXED_PROBE_COMMAND_MODE" = "short" ]; then
      printf '%s\\n' exited > "$QDROID_TEST_FIXED_PROBE_STATE"
      exit 0
    fi
    while [ ! -f "$QDROID_TEST_FIXED_PROBE_RELEASE" ]; do sleep 0.01; done
    ;;
  stop)
    printf '%s\\n' exited > "$QDROID_TEST_FIXED_PROBE_STATE"
    printf '%s\\n' stop >> "$QDROID_TEST_FIXED_PROBE_LOG"
    ;;
  rm)
    printf '%s\\n' rm >> "$QDROID_TEST_FIXED_PROBE_LOG"
    ;;
esac
`,
    { encoding: 'utf8', mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);
  await writeFile(statePath, 'created\n', { encoding: 'utf8', mode: 0o600 });

  process.env.PATH = `${directory}:${originalEnvironment.get('PATH') ?? ''}`;
  process.env.QDROID_TEST_FIXED_PROBE_COMMAND_MODE = mode;
  process.env.QDROID_TEST_FIXED_PROBE_INSPECT_HOLD = inspectHoldPath;
  process.env.QDROID_TEST_FIXED_PROBE_INSPECT_RELEASE = inspectReleasePath;
  process.env.QDROID_TEST_FIXED_PROBE_LOG = logPath;
  process.env.QDROID_TEST_FIXED_PROBE_RELEASE = releasePath;
  process.env.QDROID_TEST_FIXED_PROBE_STATE = statePath;

  const setState = async (state: FixedProfileProbeDockerState): Promise<void> => {
    const temporary = join(directory, `state-${randomFixtureSuffix()}`);
    await writeFile(temporary, `${state}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, statePath);
  };

  return {
    directory,
    logPath,
    holdRunningInspection: async () => {
      await writeFile(inspectHoldPath, 'hold\\n', { encoding: 'utf8', mode: 0o600 });
    },
    probeSpec: (deadlineMs = 5_000) => ({
      containerName: `qdroid-t005-probe-${sessionId}`,
      deadlineMs,
      imageId,
      intent: {
        kind: 'profile-fixed-program',
        profileId: 'tool-offline',
        selector: 'cgroup-limits',
      },
      maxOutputBytes: 8_192,
      ownership: {
        imageId,
        labels: {
          'io.qdroid.owner': ownerId,
          'io.qdroid.profile': profile,
          'io.qdroid.session': sessionId,
        },
      },
      protocol: FIXED_PROBE_PROTOCOL,
    }),
    releaseRunningInspection: async () => {
      await writeFile(inspectReleasePath, 'release\\n', { encoding: 'utf8', mode: 0o600 });
    },
    restore: async (retain: boolean): Promise<void> => {
      for (const key of environmentKeys) {
        const value = originalEnvironment.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      if (!retain) {
        await rm(directory, { force: true, recursive: true });
      }
    },
    setLiveProcessId: async (processId: number | undefined): Promise<void> => {
      if (processId === undefined || !Number.isSafeInteger(processId) || processId < 1) {
        throw new Error('The fixed profile probe test process has no live PID.');
      }
      process.env.QDROID_TEST_FIXED_PROBE_LIVE_PID = String(processId);
    },
    setState,
  };
}

function randomFixtureSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function waitForPath(path: string, description: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function readProcessGroupId(pid: number): Promise<number> {
  const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  const closeParenthesis = contents.lastIndexOf(')');
  const fields = contents.slice(closeParenthesis + 2).split(' ');
  const processGroup = Number.parseInt(fields[2] ?? '', 10);
  if (closeParenthesis < 0 || !Number.isSafeInteger(processGroup) || processGroup < 1) {
    throw new Error(`The assembly keeper ${pid} has no valid process group.`);
  }
  return processGroup;
}

async function readProcessStart(pid: number): Promise<string> {
  const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  const closeParenthesis = contents.lastIndexOf(')');
  const start = contents.slice(closeParenthesis + 2).split(' ')[19];
  if (closeParenthesis < 0 || start === undefined || !/^\d+$/.test(start)) {
    throw new Error(`The boundary keeper ${pid} has no valid process-start identity.`);
  }
  return start;
}

async function waitForProcessGroupExit(processGroup: number, description: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroup, 0);
    } catch (error) {
      if (isMissingProcess(error)) {
        return;
      }
      throw error;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${description} to exit.`);
}

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ESRCH'
  );
}

async function awaitFixtureJson(
  stdout: NodeJS.ReadableStream,
  description: string,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const newline = Buffer.concat(chunks).indexOf(0x0a);
    if (newline >= 0) {
      return JSON.parse(Buffer.concat(chunks).subarray(0, newline).toString('utf8')) as Record<
        string,
        unknown
      >;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function awaitChildExit(
  child: ReturnType<typeof spawn>,
  description: string,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return awaitWithin(observeChildExit(child), description);
}

function observeChildExit(
  child: ReturnType<typeof spawn>,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function observeGuardianExit(
  guardian: SandboxGuardianClient,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    guardian.once('exited', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForLogLine(path: string, line: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, 'utf8')).split('\n').includes(line)) {
        return;
      }
    } catch {
      // The controlled Docker helper has not written its first observation yet.
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for the controlled Docker ${line} observation.`);
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function awaitWithin<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${description}.`));
        }, 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function collectCleanupStep(
  promise: Promise<unknown>,
  description: string,
  failures: unknown[],
): Promise<void> {
  try {
    await awaitWithin(promise, description);
  } catch (error) {
    failures.push(error);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

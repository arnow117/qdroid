import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  AsyncByteStream,
  SANDBOX_PROFILE_CATALOG,
  SerializedJournalUpdates,
  observeProfileProbeInput,
  parseSandboxProfile,
  parseProfileIoFields,
  parseProfileIoReadBytes,
  parseObservedProcessGroupId,
  parseTrustedProcessStart,
  ProfileNetworkFixtureController,
  runOwnedProfileNetworkOperation,
  runProfileWorkload,
  isConfirmedContainerAbsence,
} from '../../packages/runtime-oci/src/backend.js';
import { SandboxGuardianClient } from '../../packages/supervisor/src/index.js';
import { assessCpuProbe, parseCpuStatSnapshot } from '../../packages/runtime-oci/src/index.js';
import type {
  SandboxCleanupEvidence,
  SandboxExecutionCompletion,
  SandboxExecutionRequest,
  SandboxIdentityBinding,
  SandboxInstance,
  SandboxQualification,
} from '../../packages/contracts/src/index.js';
import { OciSandboxBackend } from '../../packages/runtime-oci/src/backend.js';
import {
  completeExecutionAndConfirmCleanup,
  createSandboxBackendLinuxSuiteFailure,
  createExactlyOnceSandboxStopper,
  formatSandboxBackendLinuxSuiteFailure,
} from '../../fixtures/host-boundary/src/backend-suite.js';

const stalledCleanupGuardianPath = fileURLToPath(
  new URL('../../fixtures/host-boundary/src/stalled-cleanup-guardian.js', import.meta.url),
);

test('sandbox suite failures expose only a bounded phase and trusted subresults', () => {
  const message = formatSandboxBackendLinuxSuiteFailure(
    'output-limit-peer',
    { completedProfiles: 3, outputLimitAndPeerSurvived: false },
    new Error('workload output and fixture secret must not escape'),
  );

  assert.match(message, /T004 Linux suite failed during output-limit-peer/);
  assert.match(message, /"completedProfiles":3/);
  assert.match(message, /"outputLimitAndPeerSurvived":false/);
  assert.doesNotMatch(message, /workload output|fixture secret/);
  assert.ok(message.length <= 1_200);
});

test('the sandbox suite wrapper retains a composed internal failure as its cause', () => {
  const completionFailure = new Error('completion failed');
  const cleanupFailure = new Error('cleanup failed');
  const combinedFailure = new AggregateError(
    [completionFailure, cleanupFailure],
    'The execution and cleanup both failed.',
  );

  const wrapped = createSandboxBackendLinuxSuiteFailure(
    'deadline-peer',
    { deadlineAndPeerSurvived: false },
    combinedFailure,
  );

  assert.match(wrapped.message, /T004 Linux suite failed during deadline-peer/);
  assert.equal(wrapped.cause, combinedFailure);
  assert.deepEqual(combinedFailure.errors, [completionFailure, cleanupFailure]);
});

test('fixture cleanup preserves the raw completion and stops the same handle once', async () => {
  const sandbox = { id: 'fixture-completed-sandbox' } as SandboxInstance;
  const completion: SandboxExecutionCompletion = Object.freeze({
    cleanupConfirmed: false,
    exitCode: 0,
    reason: 'completed',
    stderrBytes: 0,
    stderrDeliveredBytes: 0,
    stdoutBytes: 2,
    stdoutDeliveredBytes: 2,
  });
  const finalCleanup: SandboxCleanupEvidence = {
    cleanupConfirmed: true,
    status: 'confirmed',
  };
  let stopCalls = 0;
  const stop = createExactlyOnceSandboxStopper(async (stoppedSandbox) => {
    assert.equal(stoppedSandbox, sandbox);
    stopCalls += 1;
    return finalCleanup;
  });

  const settled = await completeExecutionAndConfirmCleanup(
    stop,
    sandbox,
    Promise.resolve(completion),
  );

  assert.equal(settled.completion, completion);
  assert.equal(settled.initialCleanupConfirmed, false);
  assert.equal(settled.finalCleanup, finalCleanup);
  assert.equal(stopCalls, 1);
  await assert.rejects(stop(sandbox), /duplicate explicit sandbox stop/);
});

test('fixture explicit-stop paths block continuation on unconfirmed cleanup', async () => {
  const sandbox = { id: 'fixture-explicit-stop-unknown' } as SandboxInstance;
  let stopCalls = 0;
  let continued = false;
  const stop = createExactlyOnceSandboxStopper(async () => {
    stopCalls += 1;
    return { cleanupConfirmed: false, status: 'pending' };
  });

  try {
    await stop(sandbox);
    continued = true;
  } catch (error) {
    assert.match(String(error), /final cleanup was not confirmed/);
  }

  assert.equal(stopCalls, 1);
  assert.equal(continued, false);
  await assert.rejects(stop(sandbox), /duplicate explicit sandbox stop/);
});

test('fixture cleanup blocks continuation when its one final stop is pending or unknown', async () => {
  const sandbox = { id: 'fixture-unknown-cleanup' } as SandboxInstance;
  const completion: SandboxExecutionCompletion = {
    cleanupConfirmed: false,
    exitCode: 0,
    reason: 'completed',
    stderrBytes: 0,
    stderrDeliveredBytes: 0,
    stdoutBytes: 0,
    stdoutDeliveredBytes: 0,
  };
  for (const status of ['pending', 'unknown'] as const) {
    let stopCalls = 0;
    let continued = false;

    try {
      await completeExecutionAndConfirmCleanup(
        async () => {
          stopCalls += 1;
          return { cleanupConfirmed: false, status };
        },
        sandbox,
        Promise.resolve(completion),
      );
      continued = true;
    } catch (error) {
      assert.match(String(error), /final cleanup was not confirmed/);
    }

    assert.equal(stopCalls, 1);
    assert.equal(continued, false);
  }
});

test('fixture cleanup retains an execution failure after confirmed cleanup', async () => {
  const sandbox = { id: 'fixture-completion-failure' } as SandboxInstance;
  const completionFailure = new Error('completion failed');
  let stopCalls = 0;

  await assert.rejects(
    completeExecutionAndConfirmCleanup(
      async () => {
        stopCalls += 1;
        return { cleanupConfirmed: true, status: 'confirmed' };
      },
      sandbox,
      Promise.reject(completionFailure),
    ),
    (error: unknown) => error === completionFailure,
  );

  assert.equal(stopCalls, 1);
});

test('fixture cleanup composes an execution failure with an independent cleanup failure', async () => {
  const sandbox = { id: 'fixture-combined-failure' } as SandboxInstance;
  const completionFailure = new Error('completion failed');
  const cleanupFailure = new Error('cleanup failed');

  await assert.rejects(
    completeExecutionAndConfirmCleanup(
      async () => {
        throw cleanupFailure;
      },
      sandbox,
      Promise.reject(completionFailure),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [completionFailure, cleanupFailure]);
      return true;
    },
  );
});

test('sandbox profiles are an immutable offline trusted catalog', () => {
  const profile = parseSandboxProfile('tool-offline');

  assert.equal(profile.network, 'none');
  assert.equal(profile.readOnlyRoot, true);
  assert.equal(profile.limits.memoryMiB, 768);
  assert.throws(() => parseSandboxProfile('tool-offline-forged'), /unsupported/);
  assert.equal(SANDBOX_PROFILE_CATALOG['build-restricted'].network, 'none');
  assert.equal(SANDBOX_PROFILE_CATALOG['render-offline'].featureSet.chromium, false);
});

test('the backend rejects forged and foreign qualification or sandbox handles before Docker work', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-forged-handle-'));
  const backend = new OciSandboxBackend({
    image: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ownerStorePath,
  });
  const binding: SandboxIdentityBinding = {
    bootId: 'trusted-boot',
    channelId: 'trusted-channel',
    epoch: 1,
    installationId: 'trusted-installation',
    instanceId: 'trusted-instance',
  };
  const request: SandboxExecutionRequest = {
    argv: ['-e', 'process.stdout.write("forged")'],
    cwd: '/tmp',
    environment: { LANG: 'C.UTF-8' },
    executable: '/usr/local/bin/node',
  };
  const forgedQualification = Object.freeze({}) as SandboxQualification;
  const foreignSandbox = Object.freeze({
    id: 'sandbox-foreign',
    profileId: 'tool-offline',
  }) as SandboxInstance;

  try {
    await assert.rejects(backend.create(forgedQualification, binding), /not trusted/);
    await assert.rejects(backend.execute(foreignSandbox, request), /not owned/);
    await assert.rejects(backend.stop(foreignSandbox), /not owned/);
  } finally {
    await rm(ownerStorePath, { force: true, recursive: true });
  }
});

test('an already-expired recovery deadline does not acquire a SQLite lease', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-expired-recovery-lease-'));
  let recoveryActionStarted = false;
  let leaseReturnHookCalled = false;
  const backend = new OciSandboxBackend({
    image: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ownerStorePath,
    trustedTestHooks: {
      beforeRecoveryLockLeaseReturn: async () => {
        leaseReturnHookCalled = true;
      },
    },
  });
  const withRecoveryLock = (
    backend as unknown as {
      withRecoveryLock(action: () => Promise<void>, deadline?: number): Promise<void | undefined>;
    }
  ).withRecoveryLock.bind(backend);

  try {
    await assert.rejects(
      withRecoveryLock(async () => {
        recoveryActionStarted = true;
      }, Date.now() - 1),
      /did not settle before its deadline/,
    );

    assert.equal(recoveryActionStarted, false);
    assert.equal(leaseReturnHookCalled, false);
    assert.deepEqual(await readdir(ownerStorePath), []);
  } finally {
    await rm(ownerStorePath, { force: true, recursive: true });
  }
});

test('execution byte streams preserve binary chunks and reject a second consumer', async () => {
  const stream = new AsyncByteStream(16);
  const chunks: Uint8Array[] = [];
  const reader = stream[Symbol.asyncIterator]();
  let consumptionAcknowledgements = 0;

  assert.equal(
    stream.push(Buffer.from([0, 255, 1]), () => {
      consumptionAcknowledgements += 1;
    }),
    true,
  );
  assert.equal(consumptionAcknowledgements, 0);
  stream.end();

  for (;;) {
    const next = await reader.next();

    if (next.done) {
      break;
    }

    chunks.push(next.value);
  }

  assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 255, 1]));
  assert.equal(consumptionAcknowledgements, 1);
  assert.throws(() => stream[Symbol.asyncIterator](), /single consumer/);
});

test('a slow byte-stream consumer reaches a bounded overflow state', () => {
  const stream = new AsyncByteStream(2);

  assert.equal(stream.push(Buffer.from([1, 2])), true);
  assert.equal(stream.push(Buffer.from([3])), false);
  assert.equal(stream.overflowed, true);
});

test('profile probe input keeps observing EPIPE after the write path has returned', async () => {
  const input = new PassThrough();
  const failures: Error[] = [];
  const observation = observeProfileProbeInput(input, (failure) => {
    failures.push(failure);
  });

  input.write('start\n');
  input.destroy(Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));

  await new Promise<void>((resolve) => {
    input.once('close', resolve);
  });

  assert.equal(observation.failure?.message, 'EPIPE');
  assert.equal(failures.length, 1);
  assert.equal(failures[0], observation.failure);
  observation.detach();
});

test('process-group parsing accepts unrelated kernel workers while rejecting malformed identities', () => {
  assert.equal(parseObservedProcessGroupId('100 (kworker/1:1H-kblockd) I 2 0 0 0'), 0);
  assert.equal(parseObservedProcessGroupId('101 (trusted-controller) S 2 101 101 0'), 101);
  assert.throws(
    () => parseObservedProcessGroupId('102 (corrupt) S 2 -1 0 0'),
    /observed process group identity is invalid/,
  );
  assert.throws(
    () => parseObservedProcessGroupId('103 corrupt S 2 103 0 0'),
    /observed process group identity is invalid/,
  );
});

test('trusted process start parsing rejects malformed identities instead of treating them as dead', () => {
  const fields = Array.from({ length: 20 }, () => '0');
  fields[0] = 'S';
  fields[19] = '12345';
  const valid = `101 (trusted-controller) ${fields.join(' ')}`;

  assert.equal(parseTrustedProcessStart(valid), '12345');
  assert.throws(
    () => parseTrustedProcessStart('101 (truncated) S 2 101'),
    /trusted process start identity is invalid/,
  );
  assert.throws(
    () => parseTrustedProcessStart('101 corrupt S 2 101 101 0'),
    /trusted process start identity is invalid/,
  );
});

test('a controlled child closing stdin surfaces the real probe-input failure', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      [
        'process.stdout.write("ready\\n");',
        'process.stdin.once("data", () => {',
        '  process.stdin.destroy();',
        '  setTimeout(() => process.exit(0), 500);',
        '});',
      ].join('\n'),
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const observation = observeProfileProbeInput(child.stdin);
  let output = '';

  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.includes('ready\n')) {
          resolve();
        }
      });
      child.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      child.stdin.write('start\n', (error) =>
        error === null || error === undefined ? resolve() : reject(error),
      );
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        child.stdin.write(Buffer.alloc(1024 * 1024), (error) =>
          error === null || error === undefined ? resolve() : reject(error),
        );
      }),
      /EPIPE/,
    );
    assert.notEqual(observation.failure, undefined);
  } finally {
    observation.detach();
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }
});

test('an idle recovery guardian can only exit through its owned private IPC channel', async () => {
  const guardian = new SandboxGuardianClient({ workerPath: stalledCleanupGuardianPath });

  try {
    assert.equal(guardian.requestIdleWorkerExit(), true);
    await assert.rejects(
      guardian.completion,
      /IPC channel disconnected|exited before reporting cleanup/,
    );
    assert.equal(guardian.requestIdleWorkerExit(), false);
  } finally {
    await guardian.stop().catch(() => undefined);
    await guardian.completion.catch(() => undefined);
  }
});

test('an inline ESM trusted parent starts and cleans up its guardian without inheriting input flags', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-inline-esm-guardian-'));
  const dockerPath = join(directory, 'docker');
  const guardianModuleUrl = new URL('../../packages/supervisor/src/index.js', import.meta.url).href;

  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  create|stop|rm)
    exit 0
    ;;
  inspect)
    case "$3" in
      '{{.Id}}')
        printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        ;;
      *)
        printf '%s\\n' 'false 0'
        ;;
    esac
    exit 0
    ;;
  start)
    cat
    ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);

  const inlineProgram = [
    `import { SandboxGuardianClient } from ${JSON.stringify(guardianModuleUrl)};`,
    'const guardian = new SandboxGuardianClient();',
    'await guardian.start({',
    "  containerName: 'qdroid-t004-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',",
    '  deadlineMs: 1_000,',
    "  dockerArguments: ['sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],",
    '  maxOutputBytes: 64,',
    '});',
    "await guardian.stop('stopped');",
    'const completion = await guardian.completion;',
    'if (!completion.cleanupConfirmed) { throw new Error("guardian cleanup was unconfirmed"); }',
    "process.stdout.write('inline-guardian-cleaned\\n');",
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', inlineProgram], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  try {
    const exitCode = await waitForSpawnExit(child, 5_000);

    assert.equal(exitCode, 0, stderr);
    assert.equal(stdout, 'inline-guardian-cleaned\n');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('an inline ESM trusted parent starts and cleans up its profile network controller', async () => {
  const backendModuleUrl = new URL('../../packages/runtime-oci/src/backend.js', import.meta.url)
    .href;

  const controllerWorkerUrl = new URL(
    '../../packages/runtime-oci/src/profile-network-controller.js',
    import.meta.url,
  ).href;
  const inlineProgram = [
    'import { forkTrustedProfileNetworkFixtureController } from ' +
      JSON.stringify(backendModuleUrl) +
      ';',
    'const child = forkTrustedProfileNetworkFixtureController(new URL(' +
      JSON.stringify(controllerWorkerUrl) +
      '));',
    'const completion = await new Promise((resolve, reject) => {',
    '  const timeout = setTimeout(() => reject(new Error("controller did not finish")), 1_000);',
    '  child.on("message", (message) => {',
    '    if (message?.type === "ready") {',
    '      child.send({ type: "stop" }, (error) => { if (error) reject(error); });',
    '      return;',
    '    }',
    '    if (message?.type === "finished") {',
    '      clearTimeout(timeout);',
    '      resolve(message);',
    '    }',
    '  });',
    '  child.once("error", reject);',
    '});',
    'if (completion.cleanupConfirmed !== true || completion.cleanupUncertain !== false) {',
    '  throw new Error("controller cleanup was unconfirmed");',
    '}',
    "process.stdout.write('inline-network-controller-stopped\\n');",
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', inlineProgram], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  try {
    const exitCode = await waitForSpawnExit(child, 5_000);

    assert.equal(exitCode, 0, stderr);
    assert.equal(stdout, 'inline-network-controller-stopped\n');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }
});

test('trusted worker startup diagnostics are bounded and redact stderr secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-worker-diagnostic-'));
  const workerPath = join(directory, 'failing-worker.mjs');
  const overflow = 'x'.repeat(5_000);

  await writeFile(
    workerPath,
    [
      "import { writeSync } from 'node:fs';",
      `writeSync(2, 'ERR_INPUT_TYPE_NOT_ALLOWED TOKEN=super-secret ${overflow} OVERFLOW_MARKER\\n');`,
      'process.exit(23);',
    ].join('\n'),
  );

  const guardian = new SandboxGuardianClient({ workerPath });
  const guardianExit = waitForGuardianExit(guardian);
  const guardianFailure = await guardian.completion.then(
    () => assert.fail('the failing guardian worker unexpectedly completed'),
    (error: unknown) => asTestError(error),
  );

  const controller = new ProfileNetworkFixtureController(() =>
    fork(workerPath, [], {
      detached: true,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }),
  );
  const controllerFailure = await controller.waitUntilReady().then(
    () => assert.fail('the failing network controller unexpectedly became ready'),
    (error: unknown) => asTestError(error),
  );

  try {
    await guardianExit;
    await waitForExactChildExit(controller.pid);

    for (const failure of [guardianFailure, controllerFailure]) {
      assert.match(failure.message, /ERR_INPUT_TYPE_NOT_ALLOWED/);
      assert.match(failure.message, /exit code 23/);
      assert.doesNotMatch(failure.message, /super-secret|TOKEN=|OVERFLOW_MARKER/);
      assert.ok(Buffer.byteLength(failure.message, 'utf8') < 4_700);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('a cancelled profile workload removes its exact container before an attach can continue', async () => {
  for (const phase of ['create', 'attach'] as const) {
    const directory = await mkdtemp(join(tmpdir(), `qdroid-profile-workload-${phase}-`));
    const dockerPath = join(directory, 'docker');
    const logPath = join(directory, 'docker.log');
    const originalPath = process.env.PATH;
    const originalLog = process.env.QDROID_TEST_LOG;
    const originalPhase = process.env.QDROID_TEST_PHASE;

    await writeFile(
      dockerPath,
      `#!/bin/sh
case "$1" in
  create)
    printf '%s\\n' create >> "$QDROID_TEST_LOG"
    if [ "$QDROID_TEST_PHASE" = create ]; then sleep 30; fi
    exit 0
    ;;
  inspect)
    printf '%s\\n' '[{"HostConfig":{"ReadonlyRootfs":true,"NetworkMode":"none","Memory":805306368,"MemorySwap":805306368,"NanoCpus":1000000000,"PidsLimit":256,"ShmSize":134217728,"SecurityOpt":["no-new-privileges"],"CapDrop":["ALL"]},"Config":{"User":"65532:65532"},"Mounts":[]}]'
    exit 0
    ;;
  start)
    printf '%s\\n' start >> "$QDROID_TEST_LOG"
    sleep 30
    ;;
  rm)
    printf '%s\\n' rm >> "$QDROID_TEST_LOG"
    exit 0
    ;;
esac
`,
      { mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_PHASE = phase;
    process.env.QDROID_TEST_LOG = logPath;
    const cancellation = new AbortController();
    const workload = runProfileWorkload(
      parseSandboxProfile('tool-offline'),
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ['-e', 'setInterval(() => {}, 1_000)'],
      undefined,
      cancellation.signal,
    );

    try {
      await waitForLogLine(logPath, phase === 'create' ? 'create' : 'start');
      cancellation.abort(new Error(`fixture-lost-during-${phase}`));

      await assert.rejects(workload, new RegExp(`fixture-lost-during-${phase}`));
      const lines = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean);
      assert.ok(lines.includes('rm'));
      if (phase === 'create') {
        assert.equal(lines.includes('start'), false);
      }
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPhase === undefined) {
        delete process.env.QDROID_TEST_PHASE;
      } else {
        process.env.QDROID_TEST_PHASE = originalPhase;
      }
      if (originalLog === undefined) {
        delete process.env.QDROID_TEST_LOG;
      } else {
        process.env.QDROID_TEST_LOG = originalLog;
      }
      await rm(directory, { force: true, recursive: true });
    }
  }
});

test(
  'a network qualification create that returns nonzero retains its exact pending record',
  { skip: process.platform !== 'linux' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-pending-create-'));
    const ownerStorePath = join(directory, 'owner-store');
    const dockerPath = join(directory, 'docker');
    const ipPath = join(directory, 'ip');
    const logPath = join(directory, 'docker.log');
    const originalPath = process.env.PATH;
    const originalLog = process.env.QDROID_TEST_LOG;
    let controllerPid: number | undefined;
    let fixture:
      | {
          dispose(): Promise<void>;
          runQualificationWorkload(
            profile: ReturnType<typeof parseSandboxProfile>,
            imageId: string,
            argv: readonly string[],
            signal: AbortSignal,
          ): Promise<string>;
        }
      | undefined;

    await writeFile(
      dockerPath,
      `#!/bin/sh
case "$1" in
  create)
    printf '%s\\n' create >> "$QDROID_TEST_LOG"
    setsid sh -c 'sleep 0.1; printf "%s\\n" late-daemon-create >> "$QDROID_TEST_LOG"' >/dev/null 2>&1 &
    exit 1
    ;;
  start|rm)
    printf '%s\\n' "$1" >> "$QDROID_TEST_LOG"
    exit 0
    ;;
esac
exit 97
`,
      { mode: 0o700 },
    );
    await writeFile(ipPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(dockerPath, 0o700);
    await chmod(ipPath, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_LOG = logPath;

    const backend = new OciSandboxBackend({
      image: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownerStorePath,
      trustedTestHooks: {
        beforeNetworkFixtureIntentPersist: async ({ controllerPid: pid }) => {
          controllerPid = pid;
        },
        afterNetworkFixtureQualificationOperationRename: async ({ operation }) => {
          if (operation === 'removed') {
            throw new Error('The trusted cleanup confirmation write failed after controller loss.');
          }
        },
      },
    });
    const trustedBackend = backend as unknown as {
      createTrustedProfileNetworkFixture(): Promise<{
        dispose(): Promise<void>;
        runQualificationWorkload(
          profile: ReturnType<typeof parseSandboxProfile>,
          imageId: string,
          argv: readonly string[],
          signal: AbortSignal,
        ): Promise<string>;
      }>;
    };

    try {
      fixture = await trustedBackend.createTrustedProfileNetworkFixture();
      const cancellation = new AbortController();
      await assert.rejects(
        fixture.runQualificationWorkload(
          parseSandboxProfile('tool-offline'),
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          ['-e', 'process.stdout.write("unreachable")'],
          cancellation.signal,
        ),
        /could not create a container/,
      );
      await waitForLogLine(logPath, 'late-daemon-create');

      const lines = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean);
      assert.deepEqual(lines, ['create', 'late-daemon-create']);
      const records = (await readdir(ownerStorePath)).filter((entry) =>
        entry.startsWith('.network-fixture-'),
      );
      assert.equal(records.length, 1);
      const recordPath = join(ownerStorePath, records[0] as string);
      const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
        interfaceName: string;
        qualificationOperation?: { state?: string };
      };
      assert.equal(record.qualificationOperation?.state, 'possibly-submitted');

      assert.notEqual(controllerPid, undefined);
      process.kill(controllerPid as number, 'SIGKILL');
      await waitForExactChildExit(controllerPid as number);

      await assert.rejects(
        fixture.dispose(),
        /unresolved qualification container create|cleanup is unconfirmed/,
      );
      await assertTaskNetworkFixtureAbsent(record.interfaceName);
      assert.equal((await readdir(ownerStorePath)).includes(records[0] as string), true);
      await assert.rejects(
        trustedBackend.createTrustedProfileNetworkFixture(),
        /unresolved cleanup evidence/,
      );
    } finally {
      await fixture?.dispose().catch(() => undefined);
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalLog === undefined) {
        delete process.env.QDROID_TEST_LOG;
      } else {
        process.env.QDROID_TEST_LOG = originalLog;
      }
      await terminateExactTestChild(controllerPid);
      await retainNetworkFixtureEvidenceOrRemove(directory, ownerStorePath);
    }
  },
);

test(
  'a network qualification create binds its response ID before it can use inspected metadata',
  { skip: process.platform !== 'linux' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-create-binding-'));
    const ownerStorePath = join(directory, 'owner-store');
    const dockerPath = join(directory, 'docker');
    const ipPath = join(directory, 'ip');
    const logPath = join(directory, 'docker.log');
    const originalPath = process.env.PATH;
    const originalLog = process.env.QDROID_TEST_LOG;

    const createdContainerId = 'c'.repeat(64);
    const inspectedImageId = `sha256:${'d'.repeat(64)}`;
    const expectedImageId = `sha256:${'a'.repeat(64)}`;

    await writeFile(
      dockerPath,
      `#!/bin/sh
case "$1" in
  create)
    printf '%s\\n' create >> "$QDROID_TEST_LOG"
    printf '%s\\n' "${createdContainerId}"
    exit 0
    ;;
  inspect)
    printf '%s\\n' inspect >> "$QDROID_TEST_LOG"
    cat <<'JSON'
[{"Id":"${createdContainerId}","Image":"${inspectedImageId}","HostConfig":{"ReadonlyRootfs":true,"NetworkMode":"none","Memory":805306368,"MemorySwap":805306368,"NanoCpus":1000000000,"PidsLimit":256,"ShmSize":134217728,"SecurityOpt":["no-new-privileges"],"CapDrop":["ALL"]},"Config":{"User":"65532:65532","Labels":{}},"Mounts":[]}]
JSON
    exit 0
    ;;
  start|rm)
    printf '%s\\n' "$1" >> "$QDROID_TEST_LOG"
    exit 0
    ;;
esac
exit 97
`,
      { mode: 0o700 },
    );
    await writeFile(ipPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(dockerPath, 0o700);
    await chmod(ipPath, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_LOG = logPath;

    const backend = new OciSandboxBackend({
      image: expectedImageId,
      ownerStorePath,
    });
    const trustedBackend = backend as unknown as {
      createTrustedProfileNetworkFixture(): Promise<{
        dispose(): Promise<void>;
        runQualificationWorkload(
          profile: ReturnType<typeof parseSandboxProfile>,
          imageId: string,
          argv: readonly string[],
          signal: AbortSignal,
        ): Promise<string>;
      }>;
    };

    try {
      const fixture = await trustedBackend.createTrustedProfileNetworkFixture();
      await assert.rejects(
        fixture.runQualificationWorkload(
          parseSandboxProfile('tool-offline'),
          expectedImageId,
          ['-e', 'process.stdout.write("unreachable")'],
          new AbortController().signal,
        ),
        /exact trusted binding/,
      );

      const lines = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean);
      assert.deepEqual(lines, ['create', 'inspect']);
      const records = (await readdir(ownerStorePath)).filter((entry) =>
        entry.startsWith('.network-fixture-'),
      );
      assert.equal(records.length, 1);
      const record = JSON.parse(
        await readFile(join(ownerStorePath, records[0] as string), 'utf8'),
      ) as {
        interfaceName: string;
      };
      await assert.rejects(fixture.dispose(), /unresolved qualification container create/);
      await assertTaskNetworkFixtureAbsent(record.interfaceName);
      await assert.rejects(
        trustedBackend.createTrustedProfileNetworkFixture(),
        /unresolved cleanup evidence/,
      );
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalLog === undefined) {
        delete process.env.QDROID_TEST_LOG;
      } else {
        process.env.QDROID_TEST_LOG = originalLog;
      }
      await retainNetworkFixtureEvidenceOrRemove(directory, ownerStorePath);
    }
  },
);

test(
  'public qualification rejects a live network fixture before it runs any probe',
  { skip: process.platform !== 'linux' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-public-preflight-'));
    const ownerStorePath = join(directory, 'owner-store');
    const dockerPath = join(directory, 'docker');
    const ipPath = join(directory, 'ip');
    const logPath = join(directory, 'docker.log');
    const originalPath = process.env.PATH;
    const originalLog = process.env.QDROID_TEST_LOG;
    let fixture: { dispose(): Promise<void> } | undefined;

    await writeFile(dockerPath, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$QDROID_TEST_LOG"\nexit 97\n', {
      mode: 0o700,
    });
    await writeFile(ipPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(dockerPath, 0o700);
    await chmod(ipPath, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_LOG = logPath;

    const backend = new OciSandboxBackend({
      image: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownerStorePath,
    });
    const trustedBackend = backend as unknown as {
      createTrustedProfileNetworkFixture(): Promise<{
        dispose(): Promise<void>;
      }>;
    };

    try {
      fixture = await trustedBackend.createTrustedProfileNetworkFixture();
      await assert.rejects(backend.qualify('tool-offline'), /unresolved cleanup evidence/);
      assert.equal(await readFile(logPath, 'utf8').catch(() => ''), '');

      await fixture.dispose();
      assert.equal(
        (await readdir(ownerStorePath)).some((entry) => entry.startsWith('.network-fixture-')),
        false,
      );
    } finally {
      await fixture?.dispose().catch(() => undefined);
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalLog === undefined) {
        delete process.env.QDROID_TEST_LOG;
      } else {
        process.env.QDROID_TEST_LOG = originalLog;
      }
      await retainNetworkFixtureEvidenceOrRemove(directory, ownerStorePath);
    }
  },
);

test(
  'a controller lost during a pending create removes only its late exact ID and retains unknown evidence',
  { skip: process.platform !== 'linux' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-controller-loss-create-'));
    const ownerStorePath = join(directory, 'owner-store');
    const dockerPath = join(directory, 'docker');
    const ipPath = join(directory, 'ip');
    const logPath = join(directory, 'docker.log');
    const releasePath = join(directory, 'release-create');
    const statePath = join(directory, 'create-state');
    const originalPath = process.env.PATH;
    const originalLog = process.env.QDROID_TEST_LOG;
    const originalRelease = process.env.QDROID_TEST_CREATE_RELEASE;
    const originalState = process.env.QDROID_TEST_CREATE_STATE;
    const createdContainerId = 'b'.repeat(64);
    let controllerPid: number | undefined;
    let fixture:
      | {
          dispose(): Promise<void>;
          failure: Promise<never>;
          runQualificationWorkload(
            profile: ReturnType<typeof parseSandboxProfile>,
            imageId: string,
            argv: readonly string[],
            signal: AbortSignal,
          ): Promise<string>;
        }
      | undefined;

    await writeFile(
      dockerPath,
      `#!/bin/sh
case "$1" in
  create)
    profile=''
    session=''
    for argument in "$@"; do
      case "$argument" in
        io.qdroid.profile=*) profile="\${argument#io.qdroid.profile=}" ;;
        io.qdroid.session=*) session="\${argument#io.qdroid.session=}" ;;
      esac
    done
    printf '%s\\n' create >> "$QDROID_TEST_LOG"
    printf '%s %s\\n' "$profile" "$session" > "$QDROID_TEST_CREATE_STATE"
    while [ ! -f "$QDROID_TEST_CREATE_RELEASE" ]; do sleep 0.02; done
    printf '%s\\n' '${createdContainerId}'
    ;;
  inspect)
    read profile session < "$QDROID_TEST_CREATE_STATE"
    printf '%s\\n' inspect >> "$QDROID_TEST_LOG"
    cat <<JSON
[{"Id":"${createdContainerId}","Image":"sha256:${'a'.repeat(64)}","HostConfig":{"ReadonlyRootfs":true,"NetworkMode":"none","Memory":805306368,"MemorySwap":805306368,"NanoCpus":1000000000,"PidsLimit":256,"ShmSize":134217728,"SecurityOpt":["no-new-privileges"],"CapDrop":["ALL"]},"Config":{"User":"65532:65532","Labels":{"io.qdroid.owner":"qualification","io.qdroid.profile":"$profile","io.qdroid.session":"$session"}},"Mounts":[]}]
JSON
    ;;
  start)
    printf 'start %s\\n' "$2" >> "$QDROID_TEST_LOG"
    ;;
  rm)
    printf 'rm %s\\n' "$3" >> "$QDROID_TEST_LOG"
    ;;
esac
exit 0
`,
      { mode: 0o700 },
    );
    await writeFile(ipPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(dockerPath, 0o700);
    await chmod(ipPath, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_LOG = logPath;
    process.env.QDROID_TEST_CREATE_RELEASE = releasePath;
    process.env.QDROID_TEST_CREATE_STATE = statePath;

    const backend = new OciSandboxBackend({
      image: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownerStorePath,
      trustedTestHooks: {
        beforeNetworkFixtureIntentPersist: async ({ controllerPid: pid }) => {
          controllerPid = pid;
        },
        afterNetworkFixtureQualificationOperationRename: async ({ operation }) => {
          if (operation === 'removed') {
            throw new Error('The trusted cleanup confirmation write failed after controller loss.');
          }
        },
      },
    });
    const trustedBackend = backend as unknown as {
      createTrustedProfileNetworkFixture(): Promise<NonNullable<typeof fixture>>;
    };

    try {
      const activeFixture = await trustedBackend.createTrustedProfileNetworkFixture();
      fixture = activeFixture;
      const workload = runOwnedProfileNetworkOperation(
        (signal) =>
          activeFixture.runQualificationWorkload(
            parseSandboxProfile('tool-offline'),
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            ['-e', 'process.stdout.write("unreachable")'],
            signal,
          ),
        activeFixture.failure,
      );
      await waitForLogLine(logPath, 'create');
      assert.notEqual(controllerPid, undefined);
      process.kill(controllerPid as number, 'SIGKILL');
      await waitForExactChildExit(controllerPid as number);
      await writeFile(releasePath, 'release\n', { mode: 0o600 });

      await assert.rejects(workload, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.ok(
          error.errors.some((failure) =>
            String(failure).includes('cleanup confirmation write failed'),
          ),
        );
        assert.ok(
          error.errors.some((failure) => String(failure).includes('network fixture controller')),
        );
        assert.equal(
          error.errors.filter((failure) => String(failure).includes('network fixture controller'))
            .length,
          1,
        );
        return true;
      });
      const lines = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean);
      assert.deepEqual(lines, ['create', 'inspect', `rm ${createdContainerId}`]);

      const records = (await readdir(ownerStorePath)).filter((entry) =>
        entry.startsWith('.network-fixture-'),
      );
      assert.equal(records.length, 1);
      const record = JSON.parse(
        await readFile(join(ownerStorePath, records[0] as string), 'utf8'),
      ) as { interfaceName: string; qualificationOperation?: { state?: string } };
      assert.equal(record.qualificationOperation, undefined);

      await assert.rejects(
        fixture.dispose(),
        /network fixture controller|profile network fixture/i,
      );
      await assertTaskNetworkFixtureAbsent(record.interfaceName);
      assert.equal(
        (await readdir(ownerStorePath)).some((entry) => entry.startsWith('.network-fixture-')),
        false,
      );
    } finally {
      await fixture?.dispose().catch(() => undefined);
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalLog === undefined) {
        delete process.env.QDROID_TEST_LOG;
      } else {
        process.env.QDROID_TEST_LOG = originalLog;
      }
      if (originalRelease === undefined) {
        delete process.env.QDROID_TEST_CREATE_RELEASE;
      } else {
        process.env.QDROID_TEST_CREATE_RELEASE = originalRelease;
      }
      if (originalState === undefined) {
        delete process.env.QDROID_TEST_CREATE_STATE;
      } else {
        process.env.QDROID_TEST_CREATE_STATE = originalState;
      }
      await terminateExactTestChild(controllerPid);
      await retainNetworkFixtureEvidenceOrRemove(directory, ownerStorePath);
    }
  },
);

test(
  'a timed-out network record write seals the fixture before Docker create can begin',
  { skip: process.platform !== 'linux', timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-write-timeout-'));
    const ownerStorePath = join(directory, 'owner-store');
    const dockerPath = join(directory, 'docker');
    const ipPath = join(directory, 'ip');
    const logPath = join(directory, 'docker.log');
    const originalPath = process.env.PATH;
    const originalLog = process.env.QDROID_TEST_LOG;
    let releaseOperationWrite: (() => void) | undefined;
    let markOperationRename: (() => void) | undefined;
    let fixture:
      | {
          dispose(): Promise<void>;
          runQualificationWorkload(
            profile: ReturnType<typeof parseSandboxProfile>,
            imageId: string,
            argv: readonly string[],
            signal: AbortSignal,
          ): Promise<string>;
        }
      | undefined;

    const operationRenamed = new Promise<void>((resolve) => {
      markOperationRename = resolve;
    });
    const delayedOperationWrite = new Promise<void>((resolve) => {
      releaseOperationWrite = resolve;
    });

    await writeFile(dockerPath, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$QDROID_TEST_LOG"\nexit 97\n', {
      mode: 0o700,
    });
    await writeFile(ipPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(dockerPath, 0o700);
    await chmod(ipPath, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_LOG = logPath;

    const backend = new OciSandboxBackend({
      image: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownerStorePath,
      trustedTestHooks: {
        afterNetworkFixtureQualificationOperationRename: async ({ operation }) => {
          if (operation !== 'possibly-submitted') {
            return;
          }
          markOperationRename?.();
          await delayedOperationWrite;
        },
      },
    });
    const trustedBackend = backend as unknown as {
      createTrustedProfileNetworkFixture(): Promise<NonNullable<typeof fixture>>;
    };

    try {
      fixture = await trustedBackend.createTrustedProfileNetworkFixture();
      const workload = fixture.runQualificationWorkload(
        parseSandboxProfile('tool-offline'),
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ['-e', 'process.stdout.write("unreachable")'],
        new AbortController().signal,
      );
      await operationRenamed;

      await assert.rejects(workload, /did not settle before its deadline/);
      assert.equal(await readFile(logPath, 'utf8').catch(() => ''), '');

      releaseOperationWrite?.();
      await assert.rejects(fixture.dispose(), /unresolved qualification container create/);
      const records = (await readdir(ownerStorePath)).filter((entry) =>
        entry.startsWith('.network-fixture-'),
      );
      assert.equal(records.length, 1);
      await assert.rejects(backend.qualify('tool-offline'), /unresolved cleanup evidence/);
    } finally {
      releaseOperationWrite?.();
      await fixture?.dispose().catch(() => undefined);
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalLog === undefined) {
        delete process.env.QDROID_TEST_LOG;
      } else {
        process.env.QDROID_TEST_LOG = originalLog;
      }
      await retainNetworkFixtureEvidenceOrRemove(directory, ownerStorePath);
    }
  },
);

test(
  'public recovery consumes a late network fixture unlink before scanning the owner store',
  { skip: process.platform !== 'linux', timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-late-retirement-'));
    const ownerStorePath = join(directory, 'owner-store');
    const sudoPath = join(directory, 'sudo');
    const markerPath = join(directory, 'marker');
    const originalPath = process.env.PATH;
    const originalMarkerPath = process.env.QDROID_TEST_MARKER_PATH;
    let releaseRetirement: (() => void) | undefined;
    let markUnlinked: (() => void) | undefined;
    let fixture: { dispose(): Promise<void> } | undefined;
    let retryFixture: { dispose(): Promise<void> } | undefined;

    const recordUnlinked = new Promise<void>((resolve) => {
      markUnlinked = resolve;
    });
    const delayedRetirement = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });

    await writeFile(
      sudoPath,
      `#!/bin/sh
test "$1" = -n || exit 97
test "$2" = ip || exit 98
shift 2
if [ "$1" = link ] && [ "$2" = add ]; then
  printf '%s\\n' "$5" > "$QDROID_TEST_MARKER_PATH"
fi
if [ "$1" = -o ] && [ "$2" = link ] && [ "$3" = show ]; then
  marker="$(cat "$QDROID_TEST_MARKER_PATH")"
  printf '42: %s: <BROADCAST> mtu 1500 link/ether %s brd ff:ff:ff:ff:ff:ff\\n' "$5" "$marker"
fi
if [ "$1" = -d ] && [ "$2" = link ] && [ "$3" = show ]; then
  marker="$(cat "$QDROID_TEST_MARKER_PATH")"
  printf '42: %s: <BROADCAST> mtu 1500 dummy link/ether %s brd ff:ff:ff:ff:ff:ff\\n' "$5" "$marker"
fi
exit 0
`,
      { mode: 0o700 },
    );
    await chmod(sudoPath, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_MARKER_PATH = markerPath;

    const backend = new OciSandboxBackend({
      image: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownerStorePath,
      trustedTestHooks: {
        afterNetworkFixtureRecordUnlinkBeforeDirectorySync: async () => {
          markUnlinked?.();
          await delayedRetirement;
        },
      },
    });
    const trustedBackend = backend as unknown as {
      createTrustedProfileNetworkFixture(): Promise<{ dispose(): Promise<void> }>;
    };

    try {
      fixture = await trustedBackend.createTrustedProfileNetworkFixture();
      const initialDispose = fixture.dispose();
      await recordUnlinked;
      await assert.rejects(initialDispose, /did not settle before its deadline/);

      releaseRetirement?.();
      const recovery = await backend.recoverAbandoned();
      assert.equal(recovery.recoveredRecords, 1);
      assert.equal(recovery.unresolvedRecordCount, 0);

      // Public recovery consumed the exact in-memory retirement after the
      // record disappeared. The original fixture observes that terminal
      // cleanup result once, then remains idempotent without another write.
      await fixture.dispose();
      await fixture.dispose();

      retryFixture = await trustedBackend.createTrustedProfileNetworkFixture();
      await retryFixture.dispose();
    } finally {
      releaseRetirement?.();
      await retryFixture?.dispose().catch(() => undefined);
      await fixture?.dispose().catch(() => undefined);
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalMarkerPath === undefined) {
        delete process.env.QDROID_TEST_MARKER_PATH;
      } else {
        process.env.QDROID_TEST_MARKER_PATH = originalMarkerPath;
      }
      await retainNetworkFixtureEvidenceOrRemove(directory, ownerStorePath);
    }
  },
);

test(
  'a profile workload preserves its primary failure when exact cleanup fact persistence fails',
  { skip: process.platform !== 'linux' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-cleanup-failure-'));
    const ownerStorePath = join(directory, 'owner-store');
    const dockerPath = join(directory, 'docker');
    const sudoPath = join(directory, 'sudo');
    const markerPath = join(directory, 'marker');
    const dockerLogPath = join(directory, 'docker.log');
    const originalPath = process.env.PATH;
    const originalMarkerPath = process.env.QDROID_TEST_MARKER_PATH;
    const originalDockerLogPath = process.env.QDROID_TEST_LOG;
    const originalCreateState = process.env.QDROID_TEST_CREATE_STATE;
    const containerId = 'e'.repeat(64);
    let fixture:
      | {
          dispose(): Promise<void>;
          runQualificationWorkload(
            profile: ReturnType<typeof parseSandboxProfile>,
            imageId: string,
            argv: readonly string[],
            signal: AbortSignal,
          ): Promise<string>;
        }
      | undefined;

    await writeFile(
      dockerPath,
      `#!/bin/sh
case "$1" in
  create)
    profile=''
    session=''
    for argument in "$@"; do
      case "$argument" in
        io.qdroid.profile=*) profile="\${argument#io.qdroid.profile=}" ;;
        io.qdroid.session=*) session="\${argument#io.qdroid.session=}" ;;
      esac
    done
    printf 'create\\n' >> "$QDROID_TEST_LOG"
    printf '%s %s\\n' "$profile" "$session" > "$QDROID_TEST_CREATE_STATE"
    printf '%s\\n' '${containerId}'
    ;;
  inspect)
    read profile session < "$QDROID_TEST_CREATE_STATE"
    printf 'inspect\\n' >> "$QDROID_TEST_LOG"
    cat <<JSON
[{"Id":"${containerId}","Image":"sha256:${'a'.repeat(64)}","HostConfig":{"ReadonlyRootfs":true,"NetworkMode":"none","Memory":805306368,"MemorySwap":805306368,"NanoCpus":1000000000,"PidsLimit":256,"ShmSize":134217728,"SecurityOpt":["no-new-privileges"],"CapDrop":["ALL"]},"Config":{"User":"65532:65532","Labels":{"io.qdroid.owner":"qualification","io.qdroid.profile":"$profile","io.qdroid.session":"$session"}},"Mounts":[]}]
JSON
    ;;
  start)
    printf 'start\\n' >> "$QDROID_TEST_LOG"
    exit 1
    ;;
  rm)
    printf 'rm %s\\n' "$3" >> "$QDROID_TEST_LOG"
    ;;
esac
exit 0
`,
      { mode: 0o700 },
    );
    await writeFile(
      sudoPath,
      `#!/bin/sh
test "$1" = -n || exit 97
test "$2" = ip || exit 98
shift 2
if [ "$1" = link ] && [ "$2" = add ]; then
  printf '%s\\n' "$5" > "$QDROID_TEST_MARKER_PATH"
fi
if [ "$1" = -o ] && [ "$2" = link ] && [ "$3" = show ]; then
  marker="$(cat "$QDROID_TEST_MARKER_PATH")"
  printf '42: %s: <BROADCAST> mtu 1500 link/ether %s brd ff:ff:ff:ff:ff:ff\\n' "$5" "$marker"
fi
if [ "$1" = -d ] && [ "$2" = link ] && [ "$3" = show ]; then
  marker="$(cat "$QDROID_TEST_MARKER_PATH")"
  printf '42: %s: <BROADCAST> mtu 1500 dummy link/ether %s brd ff:ff:ff:ff:ff:ff\\n' "$5" "$marker"
fi
exit 0
`,
      { mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    await chmod(sudoPath, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_MARKER_PATH = markerPath;
    process.env.QDROID_TEST_LOG = dockerLogPath;
    process.env.QDROID_TEST_CREATE_STATE = join(directory, 'container-state');

    const backend = new OciSandboxBackend({
      image: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownerStorePath,
      trustedTestHooks: {
        afterNetworkFixtureQualificationOperationRename: async ({ operation }) => {
          if (operation === 'removed') {
            throw new Error('The trusted cleanup fact write failed after its rename.');
          }
        },
      },
    });
    const trustedBackend = backend as unknown as {
      createTrustedProfileNetworkFixture(): Promise<NonNullable<typeof fixture>>;
    };

    try {
      fixture = await trustedBackend.createTrustedProfileNetworkFixture();
      await assert.rejects(
        fixture.runQualificationWorkload(
          parseSandboxProfile('tool-offline'),
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          ['-e', 'process.stdout.write("unreachable")'],
          new AbortController().signal,
        ),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 2);
          assert.match(String(error.errors[0]), /did not complete successfully/);
          assert.match(String(error.errors[1]), /cleanup fact write failed/);
          return true;
        },
      );
      assert.deepEqual((await readFile(dockerLogPath, 'utf8')).trim().split('\n'), [
        'create',
        'inspect',
        'start',
        `rm ${containerId}`,
      ]);
      const recordName = (await readdir(ownerStorePath)).find((entry) =>
        entry.startsWith('.network-fixture-'),
      );
      assert.notEqual(recordName, undefined);
      const record = JSON.parse(
        await readFile(join(ownerStorePath, recordName as string), 'utf8'),
      ) as {
        qualificationOperation?: unknown;
      };
      assert.equal(record.qualificationOperation, undefined);
    } finally {
      await fixture?.dispose().catch(() => undefined);
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalMarkerPath === undefined) {
        delete process.env.QDROID_TEST_MARKER_PATH;
      } else {
        process.env.QDROID_TEST_MARKER_PATH = originalMarkerPath;
      }
      if (originalDockerLogPath === undefined) {
        delete process.env.QDROID_TEST_LOG;
      } else {
        process.env.QDROID_TEST_LOG = originalDockerLogPath;
      }
      if (originalCreateState === undefined) {
        delete process.env.QDROID_TEST_CREATE_STATE;
      } else {
        process.env.QDROID_TEST_CREATE_STATE = originalCreateState;
      }
      await retainNetworkFixtureEvidenceOrRemove(directory, ownerStorePath);
    }
  },
);

test('the profile network controller uses only its fixed synthetic interface commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-controller-'));
  const sudoPath = join(directory, 'sudo');
  const logPath = join(directory, 'commands.log');
  const workerPath = fileURLToPath(
    new URL('../../packages/runtime-oci/src/profile-network-controller.js', import.meta.url),
  );
  const interfaceName = 'qd4aabbccddee';
  const marker = '02:11:22:33:44:55';

  await writeFile(
    sudoPath,
    `#!/bin/sh
test "$1" = -n || exit 97
test "$2" = ip || exit 98
shift 2
printf '%s\\n' "$*" >> "$QDROID_TEST_LOG"
if [ "$1" = -o ] && [ "$2" = link ] && [ "$3" = show ]; then
  printf '42: %s: <BROADCAST> mtu 1500 link/ether %s brd ff:ff:ff:ff:ff:ff\\n' "$5" "$QDROID_TEST_MARKER"
fi
if [ "$1" = -d ] && [ "$2" = link ] && [ "$3" = show ]; then
  printf '42: %s: <BROADCAST> mtu 1500 qdisc noop state DOWN mode DEFAULT group default qlen 1000 link/ether %s brd ff:ff:ff:ff:ff:ff dummy\\n' "$5" "$QDROID_TEST_MARKER"
fi
if [ "$1" = -o ] && [ "$2" = address ] && [ "$3" = show ]; then
  printf '42: %s    inet 10.23.45.1/24 scope global\\n' "$5"
  printf '42: %s    inet 169.254.77.1/24 scope link\\n' "$5"
  printf '42: %s    inet 169.254.169.253/32 scope global\\n' "$5"
  printf '42: %s    inet6 fd42:515d:4::1/64 scope global\\n' "$5"
fi
exit 0
`,
    { mode: 0o700 },
  );
  await chmod(sudoPath, 0o700);
  const controller = fork(workerPath, [], {
    detached: true,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      QDROID_TEST_LOG: logPath,
      QDROID_TEST_MARKER: marker,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  try {
    const created = waitForControllerMessage(controller, 'created');
    await sendControllerMessage(controller, { interfaceName, marker, type: 'start' });
    await created;

    const finished = waitForControllerMessage(controller, 'finished');
    await sendControllerMessage(controller, { type: 'stop' });
    const completion = await finished;
    assert.equal(completion.cleanupConfirmed, true);

    const commands = (await readFile(logPath, 'utf8')).trim().split('\n');
    assert.deepEqual(commands, [
      `link add ${interfaceName} address ${marker} type dummy`,
      `address add 10.23.45.1/24 dev ${interfaceName}`,
      `address add 169.254.77.1/24 dev ${interfaceName}`,
      `address add 169.254.169.253/32 dev ${interfaceName}`,
      `address add fd42:515d:4::1/64 dev ${interfaceName}`,
      `link set dev ${interfaceName} up`,
      `-o link show dev ${interfaceName}`,
      `-d link show dev ${interfaceName}`,
      `link delete ${interfaceName}`,
    ]);
  } finally {
    if (controller.exitCode === null) {
      controller.kill('SIGKILL');
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('the profile network controller cleanup operation cannot create a fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-controller-cleanup-'));
  const sudoPath = join(directory, 'sudo');
  const logPath = join(directory, 'commands.log');
  const workerPath = fileURLToPath(
    new URL('../../packages/runtime-oci/src/profile-network-controller.js', import.meta.url),
  );
  const interfaceName = 'qd4ccddeeff00';
  const marker = '02:21:43:65:87:a9';

  await writeFile(
    sudoPath,
    `#!/bin/sh
test "$1" = -n || exit 97
test "$2" = ip || exit 98
shift 2
printf '%s\\n' "$*" >> "$QDROID_TEST_LOG"
if [ "$1" = -o ] && [ "$2" = link ] && [ "$3" = show ]; then
  printf '42: %s: <BROADCAST> mtu 1500 link/ether %s brd ff:ff:ff:ff:ff:ff\\n' "$5" "$QDROID_TEST_MARKER"
fi
if [ "$1" = -d ] && [ "$2" = link ] && [ "$3" = show ]; then
  printf '42: %s: <BROADCAST> mtu 1500 dummy link/ether %s brd ff:ff:ff:ff:ff:ff\\n' "$5" "$QDROID_TEST_MARKER"
fi
exit 0
`,
    { mode: 0o700 },
  );
  await chmod(sudoPath, 0o700);
  const controller = fork(workerPath, [], {
    detached: true,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      QDROID_TEST_LOG: logPath,
      QDROID_TEST_MARKER: marker,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  try {
    const finished = waitForControllerMessage(controller, 'finished');
    await sendControllerMessage(controller, { interfaceName, marker, type: 'cleanup' });
    const completion = await finished;
    assert.equal(completion.cleanupConfirmed, true);
    assert.equal(completion.cleanupUncertain, false);

    const commands = (await readFile(logPath, 'utf8')).trim().split('\n');
    assert.deepEqual(commands, [
      `-o link show dev ${interfaceName}`,
      `-d link show dev ${interfaceName}`,
      `link delete ${interfaceName}`,
    ]);
  } finally {
    if (controller.exitCode === null) {
      controller.kill('SIGKILL');
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('a timed-out fixture delete remains uncertain even when a later absence could be observed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-controller-delete-timeout-'));
  const sleeperPath = join(directory, 'sleeper.pid');
  const sudoPath = join(directory, 'sudo');
  const workerPath = fileURLToPath(
    new URL('../../packages/runtime-oci/src/profile-network-controller.js', import.meta.url),
  );
  const interfaceName = 'qd43344556677';
  const marker = '02:33:44:55:66:77';
  let sleeperPid: number | undefined;

  await writeFile(
    sudoPath,
    `#!/bin/sh
test "$1" = -n || exit 97
test "$2" = ip || exit 98
shift 2
if [ "$1" = -o ] && [ "$2" = link ] && [ "$3" = show ]; then
  printf '42: %s: <BROADCAST> mtu 1500 link/ether %s brd ff:ff:ff:ff:ff:ff\\n' "$5" "$QDROID_TEST_MARKER"
fi
if [ "$1" = -d ] && [ "$2" = link ] && [ "$3" = show ]; then
  printf '42: %s: <BROADCAST> mtu 1500 dummy link/ether %s brd ff:ff:ff:ff:ff:ff\\n' "$5" "$QDROID_TEST_MARKER"
fi
if [ "$1" = link ] && [ "$2" = delete ]; then
  sleep 30 &
  printf '%s\\n' "$!" > "$QDROID_TEST_SLEEPER"
  wait
fi
exit 0
`,
    { mode: 0o700 },
  );
  await chmod(sudoPath, 0o700);
  const controller = fork(workerPath, [], {
    detached: true,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      QDROID_TEST_MARKER: marker,
      QDROID_TEST_SLEEPER: sleeperPath,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  try {
    const finished = waitForControllerMessage(controller, 'finished', 7_000);
    await sendControllerMessage(controller, { interfaceName, marker, type: 'cleanup' });
    sleeperPid = Number.parseInt(await readFileWithin(sleeperPath, 3_000), 10);
    assert.ok(Number.isSafeInteger(sleeperPid) && sleeperPid > 0);

    const completion = await finished;
    assert.equal(completion.cleanupConfirmed, false);
    assert.equal(completion.cleanupUncertain, true);
  } finally {
    if (sleeperPid !== undefined) {
      try {
        process.kill(sleeperPid, 'SIGKILL');
      } catch {
        // The exact task-owned fake sudo descendant can exit during teardown.
      }
    }
    if (controller.exitCode === null) {
      controller.kill('SIGKILL');
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('the profile network controller cleans a delayed create after parent disconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-controller-disconnect-'));
  const sudoPath = join(directory, 'sudo');
  const logPath = join(directory, 'commands.log');
  const workerPath = fileURLToPath(
    new URL('../../packages/runtime-oci/src/profile-network-controller.js', import.meta.url),
  );
  const interfaceName = 'qd4ddeeff0011';
  const marker = '02:aa:bb:cc:dd:ee';

  await writeFile(
    sudoPath,
    `#!/bin/sh
test "$1" = -n || exit 97
test "$2" = ip || exit 98
shift 2
printf '%s\\n' "$*" >> "$QDROID_TEST_LOG"
if [ "$1" = link ] && [ "$2" = add ]; then
  sleep 0.2
fi
if [ "$1" = -o ] && [ "$2" = link ] && [ "$3" = show ]; then
  printf '42: %s: <BROADCAST> mtu 1500 link/ether %s brd ff:ff:ff:ff:ff:ff\\n' "$5" "$QDROID_TEST_MARKER"
fi
if [ "$1" = -d ] && [ "$2" = link ] && [ "$3" = show ]; then
  printf '42: %s: <BROADCAST> mtu 1500 dummy link/ether %s brd ff:ff:ff:ff:ff:ff\\n' "$5" "$QDROID_TEST_MARKER"
fi
if [ "$1" = -o ] && [ "$2" = address ] && [ "$3" = show ]; then
  printf '42: %s    inet 10.23.45.1/24 scope global\\n' "$5"
  printf '42: %s    inet 169.254.77.1/24 scope link\\n' "$5"
  printf '42: %s    inet 169.254.169.253/32 scope global\\n' "$5"
  printf '42: %s    inet6 fd42:515d:4::1/64 scope global\\n' "$5"
fi
exit 0
`,
    { mode: 0o700 },
  );
  await chmod(sudoPath, 0o700);
  const controller = fork(workerPath, [], {
    detached: true,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      QDROID_TEST_LOG: logPath,
      QDROID_TEST_MARKER: marker,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  try {
    await sendControllerMessage(controller, { interfaceName, marker, type: 'start' });
    await waitForLogLine(logPath, `link add ${interfaceName} address ${marker} type dummy`);
    controller.disconnect();
    await waitForChildExit(controller);

    const commands = (await readFile(logPath, 'utf8')).trim().split('\n');
    assert.ok(commands.includes(`link add ${interfaceName} address ${marker} type dummy`));
    assert.equal(commands.at(-1), `link delete ${interfaceName}`);
  } finally {
    if (!controller.killed) {
      controller.kill('SIGKILL');
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('the profile network controller removes an exact partially-created fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-controller-partial-'));
  const sudoPath = join(directory, 'sudo');
  const logPath = join(directory, 'commands.log');
  const workerPath = fileURLToPath(
    new URL('../../packages/runtime-oci/src/profile-network-controller.js', import.meta.url),
  );
  const interfaceName = 'qd41122334455';
  const marker = '02:10:20:30:40:50';

  await writeFile(
    sudoPath,
    `#!/bin/sh
test "$1" = -n || exit 97
test "$2" = ip || exit 98
shift 2
printf '%s\\n' "$*" >> "$QDROID_TEST_LOG"
if [ "$1" = link ] && [ "$2" = add ]; then
  exit 0
fi
if [ "$1" = address ] && [ "$2" = add ]; then
  exit 42
fi
if [ "$1" = -o ] && [ "$2" = link ] && [ "$3" = show ]; then
  printf '42: %s: <BROADCAST> mtu 1500 link/ether %s brd ff:ff:ff:ff:ff:ff\\n' "$5" "$QDROID_TEST_MARKER"
fi
if [ "$1" = -d ] && [ "$2" = link ] && [ "$3" = show ]; then
  printf '42: %s: <BROADCAST> mtu 1500 dummy link/ether %s brd ff:ff:ff:ff:ff:ff\\n' "$5" "$QDROID_TEST_MARKER"
fi
exit 0
`,
    { mode: 0o700 },
  );
  await chmod(sudoPath, 0o700);
  const controller = fork(workerPath, [], {
    detached: true,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      QDROID_TEST_LOG: logPath,
      QDROID_TEST_MARKER: marker,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  try {
    const finished = waitForControllerMessage(controller, 'finished');
    await sendControllerMessage(controller, { interfaceName, marker, type: 'start' });
    const completion = await finished;
    assert.equal(completion.cleanupConfirmed, true);

    const commands = (await readFile(logPath, 'utf8')).trim().split('\n');
    assert.deepEqual(commands, [
      `link add ${interfaceName} address ${marker} type dummy`,
      `address add 10.23.45.1/24 dev ${interfaceName}`,
      `-o link show dev ${interfaceName}`,
      `-d link show dev ${interfaceName}`,
      `link delete ${interfaceName}`,
    ]);
  } finally {
    if (controller.exitCode === null) {
      controller.kill('SIGKILL');
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('the profile network controller reports a timed-out command without waiting for inherited pipes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-controller-timeout-'));
  const sleeperPath = join(directory, 'sleeper.pid');
  const sudoPath = join(directory, 'sudo');
  const workerPath = fileURLToPath(
    new URL('../../packages/runtime-oci/src/profile-network-controller.js', import.meta.url),
  );
  const interfaceName = 'qd45566778899';
  const marker = '02:01:23:45:67:89';
  let sleeperPid: number | undefined;

  await writeFile(
    sudoPath,
    `#!/bin/sh
test "$1" = -n || exit 97
test "$2" = ip || exit 98
shift 2
if [ "$1" = link ] && [ "$2" = add ]; then
  sleep 30 &
  printf '%s\\n' "$!" > "$QDROID_TEST_SLEEPER"
  wait
fi
exit 0
`,
    { mode: 0o700 },
  );
  await chmod(sudoPath, 0o700);
  const controller = fork(workerPath, [], {
    detached: true,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      QDROID_TEST_SLEEPER: sleeperPath,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  try {
    const startedAt = Date.now();
    const finished = waitForControllerMessage(controller, 'finished', 7_000);
    await sendControllerMessage(controller, { interfaceName, marker, type: 'start' });
    sleeperPid = Number.parseInt(await readFileWithin(sleeperPath, 3_000), 10);
    assert.ok(Number.isSafeInteger(sleeperPid) && sleeperPid > 0);
    const completion = await finished;
    const elapsedMs = Date.now() - startedAt;
    assert.equal(completion.cleanupConfirmed, false);
    assert.equal(completion.cleanupUncertain, true);
    assert.ok(elapsedMs < 7_000, `The controller returned after ${elapsedMs}ms.`);

    await waitForChildExit(controller);
  } finally {
    if (sleeperPid !== undefined) {
      try {
        process.kill(sleeperPid, 'SIGKILL');
      } catch {
        // The exact task-owned fake sudo descendant may have exited already.
      }
    }
    if (controller.exitCode === null) {
      controller.kill('SIGKILL');
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('network fixture startup failures stop an idle controller and retain an uncertain renamed intent', async () => {
  for (const scenario of [
    { expectedRecords: 0, phase: 'identity' },
    { expectedRecords: 0, phase: 'before-intent' },
    { expectedRecords: 1, phase: 'after-rename' },
  ] as const) {
    if (process.platform !== 'linux' && scenario.phase !== 'identity') {
      // The latter two fault edges intentionally run after trusted /proc
      // identity reads. Their actual branch coverage belongs to the Linux
      // qualification fixture; macOS has no compatible process identity path.
      continue;
    }

    const directory = await mkdtemp(join(tmpdir(), `qdroid-network-startup-${scenario.phase}-`));
    const ownerStorePath = join(directory, 'owner-store');
    const ipPath = join(directory, 'ip');
    let controllerPid: number | undefined;

    await writeFile(ipPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(ipPath, 0o700);
    const failure = new Error(`trusted ${scenario.phase} failure`);
    const backend = new OciSandboxBackend({
      image: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownerStorePath,
      trustedTestHooks: {
        ...(scenario.phase === 'identity'
          ? {
              beforeNetworkFixtureIdentityRead: async ({ controllerPid: pid }) => {
                controllerPid = pid;
                throw failure;
              },
            }
          : {}),
        ...(scenario.phase === 'before-intent'
          ? {
              beforeNetworkFixtureIntentPersist: async ({ controllerPid: pid }) => {
                controllerPid = pid;
                throw failure;
              },
            }
          : {}),
        ...(scenario.phase === 'after-rename'
          ? {
              afterNetworkFixtureIntentRename: async ({ controllerPid: pid }) => {
                controllerPid = pid;
                throw failure;
              },
            }
          : {}),
      },
    });
    const createNetworkFixture = backend as unknown as {
      createTrustedProfileNetworkFixture(): Promise<unknown>;
    };
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ''}`;

    try {
      await assert.rejects(createNetworkFixture.createTrustedProfileNetworkFixture(), failure);
      assert.notEqual(controllerPid, undefined);
      await waitForExactChildExit(controllerPid as number);
      const records = (await readdir(ownerStorePath)).filter((entry) =>
        entry.startsWith('.network-fixture-'),
      );
      assert.equal(records.length, scenario.expectedRecords);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await terminateExactTestChild(controllerPid);
      await rm(directory, { force: true, recursive: true });
    }
  }
});

test('a network controller fork error remains observed when no PID becomes available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-controller-fork-error-'));
  const ownerStorePath = join(directory, 'owner-store');
  const ipPath = join(directory, 'ip');
  await writeFile(ipPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(ipPath, 0o700);

  const backend = new OciSandboxBackend({
    image: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ownerStorePath,
    trustedTestHooks: {
      forkNetworkFixtureController: () => {
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { connected: false, pid: undefined });
        queueMicrotask(() => {
          child.emit('error', Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' }));
        });
        return child;
      },
    },
  });
  const createNetworkFixture = backend as unknown as {
    createTrustedProfileNetworkFixture(): Promise<unknown>;
  };
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}:${originalPath ?? ''}`;

  try {
    await assert.rejects(
      createNetworkFixture.createTrustedProfileNetworkFixture(),
      /did not expose a PID/,
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('terminal journal retirement prevents a delayed container-ID update from writing afterward', async () => {
  const updates = new SerializedJournalUpdates();
  let releaseUpdate: (() => void) | undefined;
  let writes = 0;
  let markUpdateStarted: (() => void) | undefined;
  const delayedUpdate = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const updateStarted = new Promise<void>((resolve) => {
    markUpdateStarted = resolve;
  });

  updates.enqueue(async () => {
    markUpdateStarted?.();
    await delayedUpdate;
    if (!updates.isClosing) {
      writes += 1;
    }
  });

  await updateStarted;
  const terminalRetirement = updates.finish();
  releaseUpdate?.();
  await terminalRetirement;

  assert.equal(writes, 0);
  assert.equal(updates.failed, undefined);
});

test('a completed container-ID update retires cleanly before guardian loss recovery', async () => {
  const updates = new SerializedJournalUpdates();
  let writes = 0;

  updates.enqueue(async () => {
    writes += 1;
  });
  await updates.waitForPendingUpdate();
  await updates.finish();

  assert.equal(writes, 1);
  assert.equal(updates.failed, undefined);
});

test('profile I/O counters accept an empty fixed-device baseline only before the trusted read', () => {
  const fields = parseProfileIoFields(
    '253:32 rbytes=1 wbytes=2\n253:16   rbytes=16777216   wbytes=0 rios=16 wios=0\n',
    'io.stat',
  );

  assert.equal(fields.rbytes, '16777216');
  assert.equal(fields.wbytes, '0');
  assert.throws(
    () => parseProfileIoFields('253:16 rbytes=1 rbytes=2\n', 'io.stat'),
    /invalid I\/O field/,
  );
  assert.throws(() => parseProfileIoFields('253:16 rbytes\n', 'io.stat'), /invalid I\/O field/);

  const zeroBaseline = parseProfileIoFields('253:16 \n', 'io.stat');
  assert.equal(parseProfileIoReadBytes(zeroBaseline, 'before-read'), 0);
  assert.throws(
    () => parseProfileIoReadBytes(zeroBaseline, 'after-read'),
    /io\.stat rbytes counter is invalid/,
  );

  const partialBaseline = parseProfileIoFields('253:16 wbytes=0\n', 'io.stat');
  assert.throws(
    () => parseProfileIoReadBytes(partialBaseline, 'before-read'),
    /io\.stat rbytes counter is invalid/,
  );
  assert.throws(
    () => parseProfileIoFields('253:17 rbytes=1\n', 'io.stat'),
    /did not contain the fixed I\/O device/,
  );
});

test('the independent guardian transports binary stdin/stdout and cleans its named container', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-guardian-docker-'));
  const dockerPath = join(directory, 'docker');
  const originalPath = process.env.PATH;

  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  create|rm|stop) exit 0 ;;
  inspect)
    if [ "$2" = "--format" ] && [ "$3" = "{{.Id}}" ]; then
      printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    else
      printf '%s\\n' 'false 0'
    fi
    exit 0
    ;;
  start) cat ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  const guardian = new SandboxGuardianClient();

  try {
    const output: Uint8Array[] = [];
    guardian.on('output', (stream, chunk) => {
      if (stream === 'stdout') {
        output.push(chunk);
      }
    });

    await guardian.start({
      containerName: 'qdroid-t004-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      deadlineMs: 1_000,
      dockerArguments: ['sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      maxOutputBytes: 64,
    });
    await guardian.writeInput(Buffer.from([0, 255, 1]));
    await guardian.closeInput();

    const completion = await guardian.completion;
    assert.equal(completion.cleanupConfirmed, true);
    assert.equal(completion.reason, 'completed');
    assert.deepEqual(Buffer.concat(output), Buffer.from([0, 255, 1]));
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('the guardian persists an authenticated create receipt before it reports input readiness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-guardian-create-receipt-'));
  const dockerPath = join(directory, 'docker');
  const receiptPath = join(directory, 'receipt.json');
  const originalPath = process.env.PATH;
  const key = Buffer.alloc(32, 7);

  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  create|rm|stop) exit 0 ;;
  inspect)
    if [ "$2" = "--format" ] && [ "$3" = "{{.Id}}" ]; then
      printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    else
      printf '%s\\n' 'false 0'
    fi
    exit 0
    ;;
  start) cat ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  const guardian = new SandboxGuardianClient();
  const guardianPid = guardian.pid;
  assert.notEqual(guardianPid, undefined);
  const containerName = 'qdroid-t004-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const sessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const hostBootId = '11111111-1111-1111-1111-111111111111';

  try {
    await guardian.start({
      containerName,
      creationReceipt: {
        guardianBootId: hostBootId,
        guardianPid: guardianPid as number,
        guardianStart: '1',
        key,
        path: receiptPath,
        sessionId,
      },
      deadlineMs: 1_000,
      dockerArguments: ['sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      maxOutputBytes: 64,
    });

    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    const payload = {
      containerName,
      guardian: { pid: guardianPid, start: '1' },
      hostBootId,
      sessionId,
      version: 1,
    };
    const expectedTag = createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
    assert.equal(receipt.authenticationTag, expectedTag);
    assert.deepEqual(
      {
        containerName: receipt.containerName,
        guardian: receipt.guardian,
        hostBootId: receipt.hostBootId,
        sessionId: receipt.sessionId,
        version: receipt.version,
      },
      payload,
    );

    await guardian.stop();
    assert.equal((await guardian.completion).cleanupConfirmed, true);
  } finally {
    await guardian.stop().catch(() => undefined);
    await guardian.completion.catch(() => undefined);
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('a failed create-receipt write leaves a created container unstarted and unremoved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-guardian-create-receipt-failure-'));
  const dockerPath = join(directory, 'docker');
  const receiptPath = join(directory, 'receipt.json');
  const logPath = join(directory, 'docker.log');
  const originalPath = process.env.PATH;
  const key = Buffer.alloc(32, 9);
  const containerName = 'qdroid-t004-cccccccc-cccc-cccc-cccc-cccccccccccc';
  const sessionId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  await writeFile(
    dockerPath,
    `#!/bin/sh
printf '%s\\n' "$1" >> "$QDROID_TEST_LOG"
case "$1" in
  create)
    printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);
  await mkdir(receiptPath, { mode: 0o700 });
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.QDROID_TEST_LOG = logPath;
  const guardian = new SandboxGuardianClient();
  const guardianPid = guardian.pid;
  assert.notEqual(guardianPid, undefined);

  try {
    await assert.rejects(
      guardian.start({
        containerName,
        creationReceipt: {
          guardianBootId: '22222222-2222-2222-2222-222222222222',
          guardianPid: guardianPid as number,
          guardianStart: '1',
          key,
          path: receiptPath,
          sessionId,
        },
        deadlineMs: 1_000,
        dockerArguments: [
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ],
        maxOutputBytes: 64,
      }),
      /EISDIR/,
    );

    const completion = await guardian.completion;
    assert.equal(completion.cleanupConfirmed, false);
    assert.deepEqual((await readFile(logPath, 'utf8')).trim().split('\n'), ['create']);
  } finally {
    await guardian.stop().catch(() => undefined);
    await guardian.completion.catch(() => undefined);
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    delete process.env.QDROID_TEST_LOG;
    await rm(directory, { force: true, recursive: true });
  }
});

test('a cleanup-only ownership mismatch closes without a name-based removal on disconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-guardian-cleanup-mismatch-'));
  const dockerPath = join(directory, 'docker');
  const logPath = join(directory, 'docker.log');
  const originalPath = process.env.PATH;
  const expectedName = 'qdroid-t004-cccccccc-cccc-cccc-cccc-cccccccccccc';
  const expectedLabels = {
    'io.qdroid.owner': 'expected-owner',
    'io.qdroid.profile': 'd'.repeat(64),
    'io.qdroid.session': 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  };

  await writeFile(
    dockerPath,
    `#!/bin/sh
printf '%s\\n' "$1" >> "$QDROID_TEST_LOG"
case "$1" in
  inspect)
    printf '%s\\n' 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb foreign-owner foreign-profile foreign-session'
    exit 0
    ;;
  rm) exit 0 ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.QDROID_TEST_LOG = logPath;
  const guardian = new SandboxGuardianClient();

  try {
    const completion = await guardian.cleanup({
      containerName: expectedName,
      imageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      labels: expectedLabels,
    });
    assert.equal(completion.cleanupConfirmed, false);
    assert.deepEqual((await readFile(logPath, 'utf8')).trim().split('\n'), ['inspect']);
    await guardian.stop();
    assert.deepEqual((await readFile(logPath, 'utf8')).trim().split('\n'), ['inspect']);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    delete process.env.QDROID_TEST_LOG;
    await rm(directory, { force: true, recursive: true });
  }
});

test('a create rejection never removes a same-named object without a trusted ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-guardian-create-rejection-'));
  const dockerPath = join(directory, 'docker');
  const logPath = join(directory, 'docker.log');
  const originalPath = process.env.PATH;

  await writeFile(
    dockerPath,
    `#!/bin/sh
printf '%s\\n' "$1" >> "$QDROID_TEST_LOG"
if [ "$1" = create ]; then exit 1; fi
exit 0
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.QDROID_TEST_LOG = logPath;
  const guardian = new SandboxGuardianClient();

  try {
    await assert.rejects(
      guardian.start({
        containerName: 'qdroid-t004-dddddddd-dddd-dddd-dddd-dddddddddddd',
        deadlineMs: 1_000,
        dockerArguments: [
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ],
        maxOutputBytes: 64,
      }),
      /could not create its task-owned container/,
    );
    await guardian.completion;
    assert.deepEqual((await readFile(logPath, 'utf8')).trim().split('\n'), ['create']);
  } finally {
    await guardian.stop().catch(() => undefined);
    await guardian.completion.catch(() => undefined);
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    delete process.env.QDROID_TEST_LOG;
    await rm(directory, { force: true, recursive: true });
  }
});

test('a successful create must bind its response ID, image, and labels before start', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-guardian-start-mismatch-'));
  const dockerPath = join(directory, 'docker');
  const logPath = join(directory, 'docker.log');
  const originalPath = process.env.PATH;
  const expectedLabels = {
    'io.qdroid.owner': 'expected-owner',
    'io.qdroid.profile': 'e'.repeat(64),
    'io.qdroid.session': 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  };

  await writeFile(
    dockerPath,
    `#!/bin/sh
printf '%s\\n' "$1" >> "$QDROID_TEST_LOG"
case "$1" in
  create)
    printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    exit 0
    ;;
  inspect)
    printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb foreign-owner foreign-profile foreign-session'
    exit 0
    ;;
esac
exit 0
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.QDROID_TEST_LOG = logPath;
  const guardian = new SandboxGuardianClient();

  try {
    await assert.rejects(
      guardian.start({
        containerName: 'qdroid-t004-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        deadlineMs: 1_000,
        dockerArguments: [
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ],
        maxOutputBytes: 64,
        ownership: {
          imageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          labels: expectedLabels,
        },
      }),
      /could not identify its task-owned container/,
    );
    await guardian.completion;
    assert.deepEqual((await readFile(logPath, 'utf8')).trim().split('\n'), ['create', 'inspect']);
  } finally {
    await guardian.stop().catch(() => undefined);
    await guardian.completion.catch(() => undefined);
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    delete process.env.QDROID_TEST_LOG;
    await rm(directory, { force: true, recursive: true });
  }
});

test('a bound create starts and removes the immutable response ID rather than the name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-guardian-bound-id-'));
  const dockerPath = join(directory, 'docker');
  const logPath = join(directory, 'docker.log');
  const originalPath = process.env.PATH;
  const containerName = 'qdroid-t004-ffffffff-ffff-ffff-ffff-ffffffffffff';
  const containerId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const expectedLabels = {
    'io.qdroid.owner': 'expected-owner',
    'io.qdroid.profile': 'f'.repeat(64),
    'io.qdroid.session': 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  };

  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  create)
    printf '%s\\n' "create:$*" >> "$QDROID_TEST_LOG"
    printf '%s\\n' '${containerId}'
    ;;
  inspect)
    printf '%s\\n' "inspect:$*" >> "$QDROID_TEST_LOG"
    if [ "$3" = '{{.State.Running}} {{.State.ExitCode}}' ]; then
      printf '%s\\n' 'false 0'
    else
      printf '%s\\n' '${containerId} sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa expected-owner ${'f'.repeat(64)} ffffffff-ffff-ffff-ffff-ffffffffffff'
    fi
    ;;
  start)
    printf '%s\\n' "start:$*" >> "$QDROID_TEST_LOG"
    cat
    ;;
  stop|rm)
    printf '%s\\n' "$1:$*" >> "$QDROID_TEST_LOG"
    ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.QDROID_TEST_LOG = logPath;
  const guardian = new SandboxGuardianClient();

  try {
    await guardian.start({
      containerName,
      deadlineMs: 1_000,
      dockerArguments: ['sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      maxOutputBytes: 64,
      ownership: {
        imageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        labels: expectedLabels,
      },
    });
    await waitForLogLine(logPath, 'start:');
    await guardian.stop();
    assert.equal((await guardian.completion).cleanupConfirmed, true);
    const commands = await readFile(logPath, 'utf8');
    assert.match(commands, new RegExp(`start:.*${containerId}`));
    assert.match(commands, new RegExp(`stop:.*${containerId}`));
    assert.match(commands, new RegExp(`rm:.*${containerId}`));
    assert.doesNotMatch(commands, new RegExp(`start:.*${containerName}`));
    assert.doesNotMatch(commands, new RegExp(`stop:.*${containerName}`));
    assert.doesNotMatch(commands, new RegExp(`rm:.*${containerName}`));
  } finally {
    await guardian.stop().catch(() => undefined);
    await guardian.completion.catch(() => undefined);
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    delete process.env.QDROID_TEST_LOG;
    await rm(directory, { force: true, recursive: true });
  }
});

test('the guardian delivers a fast binary burst beyond the IPC window only after consumption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-guardian-output-credit-'));
  const dockerPath = join(directory, 'docker');
  const originalPath = process.env.PATH;

  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  create|rm|stop) exit 0 ;;
  inspect)
    if [ "$2" = "--format" ] && [ "$3" = "{{.Id}}" ]; then
      printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    else
      printf '%s\\n' 'false 0'
    fi
    exit 0
    ;;
  start) head -c 1048576 /dev/zero ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  const guardian = new SandboxGuardianClient();
  const output: Uint8Array[] = [];
  let receivedCreditCallback = false;

  const consumeOutput = (
    stream: 'stderr' | 'stdout',
    chunk: Uint8Array,
    returnCredit: () => void,
  ): void => {
    if (stream === 'stdout') {
      output.push(chunk);
    }
    receivedCreditCallback = typeof returnCredit === 'function';
    returnCredit?.();
  };

  guardian.on(
    'output',
    consumeOutput as unknown as (stream: 'stderr' | 'stdout', chunk: Uint8Array) => void,
  );

  try {
    await guardian.start({
      containerName: 'qdroid-t004-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      deadlineMs: 5_000,
      dockerArguments: ['sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      maxOutputBytes: 2 * 1024 * 1024,
    });

    const completion = await guardian.completion;
    assert.equal(receivedCreditCallback, true);
    assert.equal(completion.reason, 'completed');
    assert.equal(completion.cleanupConfirmed, true);
    assert.equal(Buffer.concat(output).byteLength, 1_048_576);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('the guardian forwards a small live reply before the workload exits', async () => {
  await withOutputGuardianDocker(
    `IFS= read -r first
printf '%s\\n' "$first"
IFS= read -r second
printf '%s\\n' "$second"`,
    async (guardian) => {
      let bufferedOutput = Buffer.alloc(0);
      let resolveFirstReply: ((value: string) => void) | undefined;
      const firstReply = new Promise<string>((resolve) => {
        resolveFirstReply = resolve;
      });

      guardian.on('output', (_stream, chunk, returnCredit) => {
        bufferedOutput = Buffer.concat([bufferedOutput, chunk]);
        returnCredit();
        const newline = bufferedOutput.indexOf(0x0a);
        if (newline !== -1) {
          resolveFirstReply?.(bufferedOutput.subarray(0, newline + 1).toString('utf8'));
          resolveFirstReply = undefined;
        }
      });

      await guardian.start(guardianLaunchSpec('12121212-1212-1212-1212-121212121212'));
      await guardian.writeInput(Buffer.from('first\n'));
      assert.equal(await firstReply, 'first\n');

      await guardian.writeInput(Buffer.from('second\n'));
      await guardian.closeInput();
      const completion = await guardian.completion;

      assert.equal(completion.reason, 'completed');
      assert.equal(completion.cleanupConfirmed, true);
    },
  );
});

test('the guardian consumes EOF after the final credited output has already drained', async () => {
  await withOutputGuardianDocker(
    `printf 'final-payload'
IFS= read -r release
test "$release" = release`,
    async (guardian) => {
      let resolvePayload: (() => void) | undefined;
      const payloadReceived = new Promise<void>((resolve) => {
        resolvePayload = resolve;
      });

      guardian.on('output', (_stream, chunk, returnCredit) => {
        assert.equal(Buffer.from(chunk).toString('utf8'), 'final-payload');
        returnCredit();
        resolvePayload?.();
        resolvePayload = undefined;
      });

      await guardian.start(guardianLaunchSpec('abababab-abab-abab-abab-abababababab'));
      await payloadReceived;
      await guardian.writeInput(Buffer.from('release\n'));
      await guardian.closeInput();

      const completion = await guardian.completion;
      assert.equal(completion.reason, 'completed');
      assert.equal(completion.cleanupConfirmed, true);
      assert.equal(completion.stdoutDeliveredBytes, Buffer.byteLength('final-payload'));
    },
  );
});

test('the guardian accepts independent stdout and stderr credits out of sequence order', async () => {
  await withOutputGuardianDocker(
    `head -c 32768 /dev/zero
head -c 32768 /dev/zero >&2
sleep 0.2`,
    async (guardian) => {
      const heldStdoutCredits: Array<() => void> = [];
      let returnedStderrCreditFirst = false;

      guardian.on('output', (stream, _chunk, returnCredit) => {
        if (stream === 'stdout') {
          heldStdoutCredits.push(returnCredit);
          return;
        }

        returnedStderrCreditFirst = heldStdoutCredits.length > 0;
        returnCredit();
        setTimeout(() => {
          for (const returnStdoutCredit of heldStdoutCredits.splice(0)) {
            returnStdoutCredit();
          }
        }, 20);
      });

      await guardian.start(guardianLaunchSpec('cccccccc-cccc-cccc-cccc-cccccccccccc'));
      const completion = await guardian.completion;

      assert.equal(returnedStderrCreditFirst, true);
      assert.equal(completion.reason, 'completed');
      assert.equal(completion.cleanupConfirmed, true);
      assert.equal(completion.stdoutDeliveredBytes, 32_768);
      assert.equal(completion.stderrDeliveredBytes, 32_768);
    },
  );
});

test('a terminal guardian result does not wait for late stream consumption', async () => {
  await withOutputGuardianDocker('head -c 32768 /dev/zero', async (guardian) => {
    const delayedCredits: Array<() => void> = [];
    const received: Uint8Array[] = [];

    guardian.on('output', (_stream, chunk, returnCredit) => {
      received.push(chunk);
      delayedCredits.push(returnCredit);
    });

    await guardian.start(guardianLaunchSpec('dddddddd-dddd-dddd-dddd-dddddddddddd'));
    const completion = await guardian.completion;

    assert.equal(completion.reason, 'completed');
    assert.equal(completion.cleanupConfirmed, true);
    assert.equal(Buffer.concat(received).byteLength, 32_768);
    assert.equal(completion.stdoutDeliveredBytes, 32_768);

    for (const returnCredit of delayedCredits) {
      assert.doesNotThrow(returnCredit);
    }
  });
});

test('the guardian clips a fast aggregate burst at the trusted output limit', async () => {
  await withOutputGuardianDocker('head -c 17825792 /dev/zero', async (guardian) => {
    const output: Uint8Array[] = [];

    guardian.on('output', (_stream, chunk, returnCredit) => {
      output.push(chunk);
      returnCredit();
    });

    await guardian.start({
      ...guardianLaunchSpec('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
      maxOutputBytes: 16 * 1024 * 1024,
    });
    const completion = await guardian.completion;

    assert.equal(completion.reason, 'output-limit');
    assert.equal(completion.cleanupConfirmed, true);
    assert.equal(Buffer.concat(output).byteLength, 16 * 1024 * 1024);
    assert.equal(completion.stdoutDeliveredBytes, 16 * 1024 * 1024);
    assert.ok(completion.stdoutBytes > completion.stdoutDeliveredBytes);
  });
});

test('a non-consuming parent can stop a credit-stalled guardian without waiting for output', async () => {
  await withOutputGuardianDocker(
    `head -c 1048576 /dev/zero
sleep 30`,
    async (guardian) => {
      await guardian.start(guardianLaunchSpec('ffffffff-ffff-ffff-ffff-ffffffffffff'));
      await guardian.stop('stopped');
      const completion = await guardian.completion;

      assert.equal(completion.reason, 'stopped');
      assert.equal(completion.cleanupConfirmed, true);
      assert.ok(completion.stdoutDeliveredBytes <= 65_536);
    },
  );
});

test('a live guardian IPC disconnect rejects outstanding input and completion without waiting for exit', async () => {
  const workerPath = fileURLToPath(
    new URL('../../fixtures/host-boundary/src/stalled-guardian.js', import.meta.url),
  );
  const guardian = new SandboxGuardianClient({ workerPath });
  const guardianPid = guardian.pid;

  try {
    await guardian.start({
      containerName: 'qdroid-t004-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      deadlineMs: 1_000,
      dockerArguments: [],
      maxOutputBytes: 64,
    });

    const outstandingInput = guardian.writeInput(Buffer.from('pending'));
    await assert.rejects(outstandingInput, /IPC channel disconnected/);
    await assert.rejects(guardian.completion, /IPC channel disconnected/);
    assert.notEqual(guardianPid, undefined);
    assert.doesNotThrow(() => process.kill(guardianPid as number, 0));
  } finally {
    if (guardianPid !== undefined) {
      try {
        process.kill(guardianPid, 'SIGKILL');
      } catch {
        // The fixture may have exited before the test cleanup ran.
      }
    }
  }
});

async function sendControllerMessage(
  controller: ChildProcess,
  message: Record<string, string>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    controller.send(message, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function waitForControllerMessage(
  controller: ChildProcess,
  expectedType: 'created' | 'finished',
  timeoutMs = 5_000,
): Promise<{ cleanupConfirmed: boolean; cleanupUncertain: boolean }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(new Error('The profile network controller did not return its trusted result.'));
    }, timeoutMs);
    const finish = (
      error?: Error,
      result?: { cleanupConfirmed: boolean; cleanupUncertain: boolean },
    ): void => {
      clearTimeout(timeout);
      controller.off('message', onMessage);
      controller.off('error', onError);
      controller.off('exit', onExit);
      if (error === undefined && result !== undefined) {
        resolve(result);
      } else {
        reject(error ?? new Error('The profile network controller returned no result.'));
      }
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (): void =>
      finish(new Error('The profile network controller exited before its trusted result.'));
    const onMessage = (message: unknown): void => {
      if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        finish(new Error('The profile network controller returned malformed IPC.'));
        return;
      }
      const value = message as Record<string, unknown>;
      if (value.type !== expectedType) {
        return;
      }
      if (expectedType === 'created') {
        finish(undefined, { cleanupConfirmed: false, cleanupUncertain: false });
        return;
      }
      if (
        typeof value.cleanupConfirmed !== 'boolean' ||
        typeof value.cleanupUncertain !== 'boolean'
      ) {
        finish(new Error('The profile network controller omitted its cleanup evidence.'));
        return;
      }
      finish(undefined, {
        cleanupConfirmed: value.cleanupConfirmed,
        cleanupUncertain: value.cleanupUncertain,
      });
    };
    controller.on('message', onMessage);
    controller.once('error', onError);
    controller.once('exit', onExit);
  });
}

function guardianLaunchSpec(suffix: string): {
  containerName: string;
  deadlineMs: number;
  dockerArguments: string[];
  maxOutputBytes: number;
} {
  return {
    containerName: `qdroid-t004-${suffix}`,
    deadlineMs: 5_000,
    dockerArguments: ['sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    maxOutputBytes: 2 * 1024 * 1024,
  };
}

async function withOutputGuardianDocker(
  startCommand: string,
  run: (guardian: SandboxGuardianClient) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-guardian-output-'));
  const dockerPath = join(directory, 'docker');
  const originalPath = process.env.PATH;

  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  create|rm|stop) exit 0 ;;
  inspect)
    if [ "$2" = "--format" ] && [ "$3" = "{{.Id}}" ]; then
      printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    else
      printf '%s\\n' 'false 0'
    fi
    exit 0
    ;;
  start)
${startCommand}
    ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  const guardian = new SandboxGuardianClient();

  try {
    await run(guardian);
  } finally {
    await guardian.stop().catch(() => undefined);
    await guardian.completion.catch(() => undefined);
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(directory, { force: true, recursive: true });
  }
}

test('host cgroup CPU evidence controls half-core acceptance independently of guest diagnostics', () => {
  const before = parseCpuStatSnapshot('usage_usec 100\nnr_periods 10\nnr_throttled 2\n');
  const hostGood = parseCpuStatSnapshot('usage_usec 1100000\nnr_periods 31\nnr_throttled 21\n');
  const hostOverLimit = parseCpuStatSnapshot(
    'usage_usec 1800001\nnr_periods 31\nnr_throttled 21\n',
  );

  const assessment = assessCpuProbe({
    after: hostGood,
    before,
    cpuMaximum: '50000 100000\n',
    elapsedNanoseconds: 2_000_000_000n,
  });

  assert.equal(assessment.hostUsageMicros, 1_099_900);
  assert.ok(assessment.hostCpuToWallRatio <= 0.8, 'a high guest ratio is diagnostic only');
  assert.throws(
    () =>
      assessCpuProbe({
        after: hostOverLimit,
        before,
        cpuMaximum: '50000 100000\n',
        elapsedNanoseconds: 2_000_000_000n,
      }),
    /host cgroup CPU evidence/,
    'a low guest ratio must not accept host cgroup overuse',
  );
  assert.throws(
    () => parseCpuStatSnapshot('usage_usec 1\nnr_periods missing\nnr_throttled 1\n'),
    /malformed/,
  );
});

test('guardian disconnect during a delayed create preserves unknown ownership without attaching it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-guardian-disconnect-'));
  const dockerPath = join(directory, 'docker');
  const logPath = join(directory, 'docker.log');
  const workerPath = fileURLToPath(
    new URL('../../packages/supervisor/src/guardian-worker.js', import.meta.url),
  );

  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  create)
    printf '%s\\n' create >> "$QDROID_TEST_LOG"
    sleep 1
    exit 0
    ;;
  inspect)
    printf '%s\\n' inspect >> "$QDROID_TEST_LOG"
    printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    exit 0
    ;;
  rm)
    printf '%s\\n' rm >> "$QDROID_TEST_LOG"
    exit 0
    ;;
  stop)
    printf '%s\\n' stop >> "$QDROID_TEST_LOG"
    exit 0
    ;;
  start)
    printf '%s\\n' start >> "$QDROID_TEST_LOG"
    cat
    ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);
  const child = fork(workerPath, [], {
    detached: true,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      QDROID_TEST_LOG: logPath,
    },
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      child.send(
        {
          containerName: 'qdroid-t004-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          deadlineMs: 1_000,
          dockerArguments: [
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          ],
          maxOutputBytes: 64,
          type: 'start',
        },
        (error) => (error === null || error === undefined ? resolve() : reject(error)),
      );
    });
    await waitForLogLine(logPath, 'create');
    child.disconnect();
    await waitForChildExit(child);

    const lines = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(lines.includes('start'), false);
    assert.equal(lines.includes('rm'), false);
  } finally {
    if (!child.killed) {
      child.kill('SIGKILL');
    }
    await rm(directory, { force: true, recursive: true });
  }
});

async function waitForLogLine(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 3_000;

  while (Date.now() < deadline) {
    const contents = await readFile(path, 'utf8').catch(() => '');
    if (contents.split('\n').some((line) => line === expected || line.startsWith(expected))) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`The guardian test did not record ${expected}.`);
}

function asTestError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('The trusted worker returned a non-error failure.');
}

function waitForGuardianExit(guardian: SandboxGuardianClient): Promise<void> {
  return new Promise<void>((resolve) => {
    guardian.once('exited', () => resolve());
  });
}

async function readFileWithin(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const contents = await readFile(path, 'utf8').catch(() => undefined);
    if (contents !== undefined) {
      return contents;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`The controlled command did not write its task-owned PID: ${path}`);
}

async function waitForExactChildExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`The exact task-owned controller ${pid} did not exit.`);
}

async function assertTaskNetworkFixtureAbsent(interfaceName: string): Promise<void> {
  const result = await runTaskNetworkCommand([
    '-n',
    '/usr/sbin/ip',
    '-o',
    'link',
    'show',
    'dev',
    interfaceName,
  ]);

  assert.equal(result.exitCode, 1, 'The exact task-owned network fixture still exists.');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), `Device "${interfaceName}" does not exist.`);
}

async function runTaskNetworkCommand(
  argumentsValue: readonly string[],
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = spawn('/usr/bin/sudo', argumentsValue, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('The exact task-owned network fixture check exceeded its deadline.'));
    }, 3_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });
}

test('network fixture evidence cleanup retains its directory when inventory fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-network-evidence-inventory-'));
  const missingOwnerStorePath = join(directory, 'missing-owner-store');

  try {
    await retainNetworkFixtureEvidenceOrRemove(directory, missingOwnerStorePath);
    assert.equal((await stat(directory)).isDirectory(), true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

async function retainNetworkFixtureEvidenceOrRemove(
  directory: string,
  ownerStorePath: string,
): Promise<void> {
  let retainedRecords: string[];
  try {
    retainedRecords = (await readdir(ownerStorePath)).filter((entry) =>
      entry.startsWith('.network-fixture-'),
    );
  } catch (error) {
    const failure = asTestError(error);
    process.stderr.write(
      `T004 retained network fixture evidence at ${directory}: inventory failed: ${failure.message}\n`,
    );
    return;
  }
  if (retainedRecords.length === 0) {
    await rm(directory, { force: true, recursive: true });
    return;
  }

  process.stderr.write(
    `T004 retained network pending-create evidence at ${directory}: ${retainedRecords.join(',')}\n`,
  );
}

async function terminateExactTestChild(pid: number | undefined): Promise<void> {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

async function waitForChildExit(child: ReturnType<typeof fork>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('The guardian did not exit after its parent disconnected.'));
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForSpawnExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('The inline ESM guardian parent did not exit within its trusted deadline.'));
    }, timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test('recovery preserves journals when Docker inspection is not an exact absence result', () => {
  const name = 'qdroid-t004-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  assert.equal(
    isConfirmedContainerAbsence(
      {
        exitCode: 1,
        stderr:
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
        stdout: '',
      },
      name,
    ),
    false,
  );
  for (const stderr of [
    `Error response from daemon: No such container: ${name}\n`,
    `Error: No such object: ${name}\n`,
    `error: no such object: ${name}\n`,
  ]) {
    assert.equal(isConfirmedContainerAbsence({ exitCode: 1, stderr, stdout: '' }, name), true);
  }

  for (const stderr of [
    `error: no such object: ${name} extra context\n`,
    `error: no such object: qdroid-t004-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\n`,
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
    'operation timed out\n',
  ]) {
    assert.equal(isConfirmedContainerAbsence({ exitCode: 1, stderr, stdout: '' }, name), false);
  }
});

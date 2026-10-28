import { OciSandboxBackend } from '../../../packages/runtime-oci/src/backend.js';
import { createLinuxSupervisor } from '../../../packages/supervisor/src/index.js';
import type { SandboxIdentityBinding } from '../../../packages/contracts/src/index.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function main(): Promise<void> {
  const [image, ownerStorePath, mode] = process.argv.slice(2);
  if (image === undefined || ownerStorePath === undefined) {
    throw new Error('The crash worker requires an image and a private owner store path.');
  }

  let blockedContainerIdPersistence = false;
  const neverReleaseBarrier = new Promise<void>(() => undefined);
  let releaseStopFence: (() => void) | undefined;
  const stopFence = new Promise<void>((resolve) => {
    releaseStopFence = resolve;
  });
  const stopsBeforeQualification = mode === 'stop-before-qualification';
  const stopsBeforeIntentPersistence = mode === 'stop-before-intent-persistence';
  const closesGuardianBeforeIntentPersistence = mode === 'stop-before-intent-closed-guardian';
  const stopsBeforeAuthorizationRename = mode === 'stop-before-authorization-rename';
  const failsCreateReceiptWrite = mode === 'create-receipt-write-failure';
  const failsBeforeIntentWrite = mode === 'intent-before-write-failure-peer';
  const failsAfterIntentWrite = mode === 'intent-after-write-failure-peer';
  let beforeIntentWriteFailurePending = failsBeforeIntentWrite;
  let afterIntentWriteFailurePending = failsAfterIntentWrite;
  let intentFailureArmed = false;
  const backend = new OciSandboxBackend({
    image,
    ownerStorePath,
    ...(mode === 'created-before-id' ||
    stopsBeforeQualification ||
    stopsBeforeIntentPersistence ||
    closesGuardianBeforeIntentPersistence ||
    stopsBeforeAuthorizationRename ||
    failsCreateReceiptWrite ||
    failsBeforeIntentWrite ||
    failsAfterIntentWrite
      ? {
          trustedTestHooks: {
            ...(closesGuardianBeforeIntentPersistence
              ? {
                  guardianWorkerPath: () =>
                    fileURLToPath(new URL('./closed-but-live-guardian.js', import.meta.url)),
                }
              : {}),
            ...(stopsBeforeQualification
              ? {
                  beforeExecuteQualification: async () => {
                    process.stdout.write(`${JSON.stringify({ phase: 'before-qualification' })}\n`);
                    await stopFence;
                  },
                }
              : {}),
            beforeJournalIntentPersist: async ({ sessionId }) => {
              if (stopsBeforeIntentPersistence || closesGuardianBeforeIntentPersistence) {
                process.stdout.write(`${JSON.stringify({ phase: 'before-intent-persistence' })}\n`);
                await stopFence;
              }
              if (failsCreateReceiptWrite) {
                await mkdir(join(ownerStorePath, `.create-receipt-${sessionId}.json`), {
                  mode: 0o700,
                });
              }
              if (intentFailureArmed && beforeIntentWriteFailurePending) {
                beforeIntentWriteFailurePending = false;
                process.stdout.write(
                  `${JSON.stringify({ phase: 'intent-before-write-failure' })}\n`,
                );
                throw new Error('trusted fixture rejected the intent before its durable write');
              }
            },
            beforeJournalCreationAuthorizationRename: async () => {
              if (!stopsBeforeAuthorizationRename) {
                return;
              }
              process.stdout.write(`${JSON.stringify({ phase: 'before-authorization-rename' })}\n`);
              await stopFence;
            },
            afterJournalIntentPersist: async () => {
              if (!intentFailureArmed || !afterIntentWriteFailurePending) {
                return;
              }
              afterIntentWriteFailurePending = false;
              process.stdout.write(`${JSON.stringify({ phase: 'intent-after-write-failure' })}\n`);
              throw new Error('trusted fixture rejected after the durable intent write');
            },
            beforeJournalContainerIdPersist: async ({ containerId, sessionId }) => {
              if (mode !== 'created-before-id' || blockedContainerIdPersistence) {
                return;
              }
              blockedContainerIdPersistence = true;
              process.stdout.write(
                `${JSON.stringify({ containerId, phase: 'created-before-id', sessionId })}\n`,
              );
              await neverReleaseBarrier;
            },
          },
        }
      : {}),
  });
  const supervisor = await createLinuxSupervisor(() => {
    throw new Error('The crash worker does not expose a workload RPC route.');
  });
  const channel = supervisor.createBoundChannel({ installationId: 't004-crash-worker' });
  const qualification = await backend.qualify('tool-offline');

  if (mode === 'heartbeat-peer') {
    await runHeartbeatPeer(backend, qualification, channel.trustedBinding);
    return;
  }

  const targetSandbox = await backend.create(qualification, channel.trustedBinding);
  const targetRequest = {
    argv: ['-e', 'setInterval(() => {}, 1_000)'],
    cwd: '/tmp',
    environment: { LANG: 'C.UTF-8' },
    executable: '/usr/local/bin/node',
  };

  if (
    stopsBeforeQualification ||
    stopsBeforeIntentPersistence ||
    closesGuardianBeforeIntentPersistence ||
    stopsBeforeAuthorizationRename
  ) {
    await runStopFence(
      backend,
      targetSandbox,
      targetRequest,
      releaseStopFence,
      closesGuardianBeforeIntentPersistence,
    );
    return;
  }

  if (failsCreateReceiptWrite) {
    const rejected = await backend.execute(targetSandbox, targetRequest).then(
      () => false,
      () => true,
    );
    if (!rejected) {
      throw new Error('The receipt-write-failure fixture unexpectedly started an execution.');
    }
    process.stdout.write(`${JSON.stringify({ phase: 'create-receipt-write-failure' })}\n`);
    process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
    return;
  }

  if (failsBeforeIntentWrite || failsAfterIntentWrite) {
    // tool-offline reserves 768 MiB, so the held peer and target consume the
    // complete 1536 MiB trusted-manager budget without exceeding it. Starting
    // the peer first proves that an intent-write failure only retires the
    // target; an already-running sibling continues to serve heartbeats.
    await runHeartbeatPeer(
      backend,
      qualification,
      channel.trustedBinding,
      false,
      async (heartbeat) => {
        await heartbeat('before-intent-failure');
      },
    );
    intentFailureArmed = true;
    process.stdout.write(`${JSON.stringify({ phase: 'peer-running-before-intent-failure' })}\n`);

    const rejected = await backend.execute(targetSandbox, targetRequest).then(
      () => false,
      () => true,
    );
    if (!rejected) {
      throw new Error('The trusted intent-failure fixture unexpectedly started an execution.');
    }
    process.stdout.write(`${JSON.stringify({ intentRejected: true })}\n`);
    process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
    return;
  }

  const targetExecution = await backend.execute(targetSandbox, targetRequest);

  void targetExecution.completion.catch(() => undefined);

  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
  setInterval(() => undefined, 1_000);
}

async function runStopFence(
  backend: OciSandboxBackend,
  sandbox: Awaited<ReturnType<OciSandboxBackend['create']>>,
  request: {
    argv: string[];
    cwd: string;
    environment: Record<string, string>;
    executable: string;
  },
  releaseFence: (() => void) | undefined,
  awaitRetry = false,
): Promise<void> {
  if (releaseFence === undefined) {
    throw new Error('The stop fence was not initialized.');
  }
  const execution = backend.execute(sandbox, request);

  await new Promise<void>((resolve, reject) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk: string) => {
      void (async () => {
        if (chunk.trim() !== 'stop') {
          throw new Error('The stop fence received an invalid trusted test command.');
        }
        const stopping = backend.stop(sandbox);
        releaseFence();
        const cleanup = await stopping;
        process.stdout.write(`${JSON.stringify({ cleanup })}\n`);
        const rejected = await execution.then(
          () => false,
          () => true,
        );
        process.stdout.write(`${JSON.stringify({ executeRejected: rejected })}\n`);
        if (!awaitRetry) {
          resolve();
          return;
        }

        process.stdin.once('data', (retryChunk: string) => {
          void (async () => {
            if (retryChunk.trim() !== 'retry') {
              throw new Error('The stop fence received an invalid trusted retry command.');
            }
            const retryCleanup = await backend.stop(sandbox);
            process.stdout.write(`${JSON.stringify({ retryCleanup })}\n`);
            resolve();
          })().catch(reject);
        });
      })().catch(reject);
    });
  });
}

async function runHeartbeatPeer(
  backend: OciSandboxBackend,
  qualification: Awaited<ReturnType<OciSandboxBackend['qualify']>>,
  binding: SandboxIdentityBinding,
  announceReady = true,
  beforeReady?: (heartbeat: (token: string) => Promise<void>) => Promise<void>,
): Promise<void> {
  const sandbox = await backend.create(qualification, binding);
  const execution = await backend.execute(sandbox, {
    argv: [
      '-e',
      [
        'let buffered = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => {',
        '  buffered += chunk;',
        '  for (;;) {',
        '    const newline = buffered.indexOf("\\n");',
        '    if (newline === -1) { break; }',
        '    const token = buffered.slice(0, newline);',
        '    buffered = buffered.slice(newline + 1);',
        '    process.stdout.write(`${token}\\n`);',
        '  }',
        '});',
      ].join('\n'),
    ],
    cwd: '/tmp',
    environment: { LANG: 'C.UTF-8' },
    executable: '/usr/local/bin/node',
  });
  let buffered = Buffer.alloc(0);
  const heartbeatWaiters = new Map<string, () => void>();

  void (async () => {
    for await (const chunk of execution.stdout) {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline === -1) {
          break;
        }
        const token = buffered.subarray(0, newline).toString('utf8');
        buffered = buffered.subarray(newline + 1);
        heartbeatWaiters.get(token)?.();
        heartbeatWaiters.delete(token);
        process.stdout.write(`${JSON.stringify({ heartbeat: token })}\n`);
      }
    }
  })().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });

  const heartbeat = async (token: string): Promise<void> => {
    if (heartbeatWaiters.has(token)) {
      throw new Error('The trusted heartbeat token is already pending.');
    }
    const acknowledgement = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        heartbeatWaiters.delete(token);
        reject(new Error('The trusted heartbeat did not receive its stdout response.'));
      }, 5_000);
      heartbeatWaiters.set(token, () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await execution.writeInput(Buffer.from(`${token}\n`));
    await acknowledgement;
  };

  await beforeReady?.(heartbeat);
  if (announceReady) {
    process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    peerCommandQueue = peerCommandQueue
      .then(() => handlePeerCommand(chunk, execution, backend, sandbox))
      .catch((error: unknown) => {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      });
  });
}

let peerCommandBuffer = '';
let peerCommandQueue = Promise.resolve();
let peerStopRequested = false;

async function handlePeerCommand(
  chunk: string,
  execution: Awaited<ReturnType<OciSandboxBackend['execute']>>,
  backend: OciSandboxBackend,
  sandbox: Awaited<ReturnType<OciSandboxBackend['create']>>,
): Promise<void> {
  peerCommandBuffer += chunk;
  for (;;) {
    const newline = peerCommandBuffer.indexOf('\n');
    if (newline === -1) {
      return;
    }
    const command = peerCommandBuffer.slice(0, newline);
    peerCommandBuffer = peerCommandBuffer.slice(newline + 1);
    if (command.startsWith('heartbeat:')) {
      await execution.writeInput(Buffer.from(`${command.slice('heartbeat:'.length)}\n`));
      continue;
    }
    if (command === 'stop' && !peerStopRequested) {
      peerStopRequested = true;
      const cleanup = await backend.stop(sandbox);
      const completion = await execution.completion;
      process.stdout.write(`${JSON.stringify({ cleanup, completion })}\n`);
      return;
    }
    throw new Error('The heartbeat peer received an invalid trusted test command.');
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  PackageInstallDemoError,
  demoExecutableOutput,
  productionReferenceNodeRootForUid,
  runPackageInstallDemo,
} from '../../fixtures/package-install-demo/src/index.js';
import {
  preparePrivateReferenceNodeState,
  type ReferenceNodeDirectorySynchronizer,
} from '../../fixtures/package-install-demo/src/reference-node-root.js';
import type {
  BuildExecutionResult,
  TrustedImageAssembler,
  TrustedRuntimeFactory,
} from '../../packages/package-runtime/src/index.js';

const COMMAND_CLOSE_GRACE_MS = 1_000;
const COMMAND_DEADLINE_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const TRUSTED_IMAGE = `sha256:${'1'.repeat(64)}`;

test('the trusted content fixture installs and reuses a disabled record with retained content', async () => {
  const report = await runPackageInstallDemo({ fixture: 'content' });

  assert.equal(report.status, 'installed-disabled');
  assert.equal(report.initial.reusedExisting, false);
  assert.equal(report.repeat.reusedExisting, true);
  assert.equal(report.initial.installationId, report.repeat.installationId);
  assert.equal(report.initial.versionRecordId, report.repeat.versionRecordId);
  assert.equal(report.initial.packageDigest, report.repeat.packageDigest);
  assert.match(report.executionScope, /trusted host package-content fixture/);
  await lstat(report.retainedStateRoot);
});

test('fixture input rejects before it creates package-install-demo state', async () => {
  const invalidCalls: ReadonlyArray<() => Promise<unknown>> = [
    () =>
      runPackageInstallDemo({
        fixture: 'unknown-fixture' as 'content',
      }),
    () =>
      runPackageInstallDemo({
        fixture: 'content',
        image: TRUSTED_IMAGE,
      }),
    () =>
      runPackageInstallDemo({
        fixture: 'executable',
      }),
    () =>
      runPackageInstallDemo({
        fixture: 'executable',
        image: `sha256:${'A'.repeat(64)}`,
      }),
    () =>
      runPackageInstallDemo({
        fixture: 'executable',
        image: TRUSTED_IMAGE,
        testOnlyAllowUnsupportedPlatform: true,
      }),
  ];

  for (const invalidCall of invalidCalls) {
    await assertRejectsWithoutNewDemoState(invalidCall);
  }
});

test('the production reference-node root accepts only private state directories', async () => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('The reference-node root test requires a host user identity.');
  }
  const testRoot = await mkdtemp(join(tmpdir(), 'qdroid-package-install-demo-root-check-'));
  const referenceRoot = join(testRoot, 'reference-node');

  const state = await preparePrivateReferenceNodeState(referenceRoot, uid);
  const created = await lstat(referenceRoot);
  assert.ok(created.isDirectory());
  assert.equal(created.uid, uid);
  assert.equal(created.mode & 0o7777, 0o700);
  assert.equal(state.installerRoot, join(referenceRoot, 'installer'));
  assert.equal(state.ownerStorePath, join(referenceRoot, 'owner-store'));
  assert.equal((await lstat(state.installerRoot)).mode & 0o7777, 0o700);
  assert.equal((await lstat(state.ownerStorePath)).mode & 0o7777, 0o700);

  await chmod(referenceRoot, 0o755);
  await assert.rejects(
    preparePrivateReferenceNodeState(referenceRoot, uid),
    /required private mode/,
  );
  assert.equal((await lstat(referenceRoot)).mode & 0o7777, 0o755);

  const specialModeRoot = join(testRoot, 'special-mode');
  await mkdir(specialModeRoot, { mode: 0o700 });
  await chmod(specialModeRoot, 0o1700);
  await assert.rejects(
    preparePrivateReferenceNodeState(specialModeRoot, uid),
    /required private mode/,
  );
  assert.equal((await lstat(specialModeRoot)).mode & 0o7777, 0o1700);
  await assertMissing(join(specialModeRoot, 'installer'));
  await assertMissing(join(specialModeRoot, 'owner-store'));

  const differentOwnerRoot = join(testRoot, 'different-owner');
  await mkdir(differentOwnerRoot, { mode: 0o700 });
  await assert.rejects(
    preparePrivateReferenceNodeState(differentOwnerRoot, uid + 1),
    /not owned by the trusted user/,
  );

  const symlinkTarget = join(testRoot, 'symlink-target');
  const symlinkRoot = join(testRoot, 'symlink-root');
  await mkdir(symlinkTarget, { mode: 0o700 });
  await symlink(symlinkTarget, symlinkRoot);
  await assert.rejects(preparePrivateReferenceNodeState(symlinkRoot, uid), /not a directory/);
  assert.ok((await lstat(symlinkRoot)).isSymbolicLink());
});

test(
  'the production reference-node root ignores mutable temporary directories',
  { concurrency: false },
  () => {
    const uid = process.getuid?.();
    if (uid === undefined) {
      throw new Error('The reference-node root test requires a host user identity.');
    }
    const environmentKeys = ['TMPDIR', 'TMP', 'TEMP'] as const;
    const originalValues = new Map(environmentKeys.map((key) => [key, process.env[key]]));

    try {
      process.env.TMPDIR = '/untrusted/tmpdir';
      process.env.TMP = '/untrusted/tmp';
      process.env.TEMP = '/untrusted/temp';
      assert.equal(
        productionReferenceNodeRootForUid(uid),
        `/var/tmp/qdroid-package-install-demo-reference-node-uid-${uid}`,
      );
    } finally {
      for (const key of environmentKeys) {
        const original = originalValues.get(key);
        if (original === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original;
        }
      }
    }
  },
);

test('reference-node state rejects invalid child directories before writing another subtree', async () => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('The reference-node root test requires a host user identity.');
  }
  const testRoot = await mkdtemp(join(tmpdir(), 'qdroid-package-install-demo-child-check-'));

  const wrongModeRoot = join(testRoot, 'wrong-mode');
  const wrongModeOwnerStore = join(wrongModeRoot, 'owner-store');
  await mkdir(wrongModeRoot, { mode: 0o700 });
  await mkdir(wrongModeOwnerStore, { mode: 0o755 });
  await chmod(wrongModeOwnerStore, 0o755);
  await assert.rejects(
    preparePrivateReferenceNodeState(wrongModeRoot, uid),
    /owner-store root does not have the required private mode/,
  );
  await assertMissing(join(wrongModeRoot, 'installer'));
  assert.equal((await lstat(wrongModeOwnerStore)).mode & 0o7777, 0o755);

  const symlinkRoot = join(testRoot, 'symlink');
  const symlinkInstaller = join(symlinkRoot, 'installer');
  const symlinkTarget = join(testRoot, 'symlink-target');
  await mkdir(symlinkRoot, { mode: 0o700 });
  await mkdir(symlinkTarget, { mode: 0o700 });
  await symlink(symlinkTarget, symlinkInstaller);
  await assert.rejects(
    preparePrivateReferenceNodeState(symlinkRoot, uid),
    /installer root is not a directory/,
  );
  assert.ok((await lstat(symlinkInstaller)).isSymbolicLink());
  await assertMissing(join(symlinkRoot, 'owner-store'));

  const fileRoot = join(testRoot, 'file');
  const fileInstaller = join(fileRoot, 'installer');
  await mkdir(fileRoot, { mode: 0o700 });
  await writeFile(fileInstaller, 'not a directory', { mode: 0o600 });
  await assert.rejects(
    preparePrivateReferenceNodeState(fileRoot, uid),
    /installer root is not a directory/,
  );
  assert.equal(await readFile(fileInstaller, 'utf8'), 'not a directory');
  await assertMissing(join(fileRoot, 'owner-store'));
});

test('reference-node preparation retains sync and close failures before it exposes state', async () => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('The reference-node root test requires a host user identity.');
  }
  const testRoot = await mkdtemp(join(tmpdir(), 'qdroid-package-install-demo-sync-check-'));
  const referenceRoot = join(testRoot, 'reference-node');
  const openedPaths: string[] = [];
  let failRootHandle = true;
  const synchronizer: ReferenceNodeDirectorySynchronizer = {
    open: async (path) => {
      const handle = await open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      openedPaths.push(path);
      const failThisHandle = path === referenceRoot && failRootHandle;
      failRootHandle = failRootHandle && !failThisHandle;

      return {
        close: async () => {
          await handle.close();
          if (failThisHandle) {
            throw new Error('Injected reference-node directory close failure.');
          }
        },
        stat: () => handle.stat(),
        sync: async () => {
          if (failThisHandle) {
            throw new Error('Injected reference-node directory sync failure.');
          }
          await handle.sync();
        },
      };
    },
  };

  await assert.rejects(
    preparePrivateReferenceNodeState(referenceRoot, uid, { directorySynchronizer: synchronizer }),
    (error: unknown) => {
      const messages = collectErrorMessages(error);
      assert.ok(messages.includes('Injected reference-node directory sync failure.'));
      assert.ok(messages.includes('Injected reference-node directory close failure.'));
      return true;
    },
  );
  assert.ok(openedPaths.includes(join(referenceRoot, 'installer')));
  assert.ok(openedPaths.includes(join(referenceRoot, 'owner-store')));
  await lstat(referenceRoot);
  await lstat(join(referenceRoot, 'installer'));
  await lstat(join(referenceRoot, 'owner-store'));
});

test(
  'the production executable fixture rejects an unsupported host before it creates state',
  {
    skip:
      process.platform === 'linux' && process.arch === 'arm64'
        ? 'The current host is the production Linux ARM64 platform.'
        : false,
  },
  async () => {
    await assertRejectsWithoutNewDemoState(() =>
      runPackageInstallDemo({
        fixture: 'executable',
        image: TRUSTED_IMAGE,
      }),
    );
  },
);

test('the executable fixture composes its trusted Mock runtime, seals output, and reuses it', async () => {
  const calls: string[] = [];
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async () => ({
      buildExecutor: {
        managesResources: true,
        execute: async (request): Promise<BuildExecutionResult> => {
          calls.push(`build:${request.builderImage}`);
          assert.deepEqual(request.argv, ['/usr/local/bin/node', 'build.mjs']);
          assert.equal(request.profile, 'build-restricted');
          return completedExecution(demoExecutableOutput());
        },
      },
      close: async () => {
        calls.push('close');
      },
      imageAssembler: mockAssembler(calls, TRUSTED_IMAGE),
    }),
  };

  const report = await runPackageInstallDemo({
    fixture: 'executable',
    image: TRUSTED_IMAGE,
    runtimeFactory,
    testOnlyAllowUnsupportedPlatform: true,
  });

  assert.equal(report.status, 'installed-disabled');
  assert.equal(report.initial.reusedExisting, false);
  assert.equal(report.repeat.reusedExisting, true);
  assert.equal(report.initial.imageId, `sha256:${'3'.repeat(64)}`);
  assert.notEqual(report.initial.buildOutputDigest, null);
  assert.equal(report.initial.imageId, report.repeat.imageId);
  assert.ok(calls.some((call) => call === `build:sha256:${'2'.repeat(64)}`));
  assert.ok(calls.some((call) => call === 'assemble:builder'));
  assert.ok(calls.some((call) => call === 'assemble:runtime'));
  assert.ok(calls.some((call) => call === 'verify'));
  assert.ok(calls.filter((call) => call === 'close').length >= 2);
});

test('a runtime and independent cleanup failure retain state and both causes', async () => {
  const runtimeFactory: TrustedRuntimeFactory = {
    create: async () => ({
      buildExecutor: {
        managesResources: true,
        execute: async () => {
          throw new Error('Mock runtime qualification remains unavailable.');
        },
      },
      close: async () => {
        throw new Error('Mock runtime cleanup confirmation failed.');
      },
      imageAssembler: mockAssembler([]),
    }),
  };

  let failure: unknown;
  try {
    await runPackageInstallDemo({
      fixture: 'executable',
      image: TRUSTED_IMAGE,
      runtimeFactory,
      testOnlyAllowUnsupportedPlatform: true,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof PackageInstallDemoError);
  assert.equal(failure.category, 'runtime');
  assert.deepEqual(collectErrorMessages(failure), [
    'The trusted package-install-demo runtime phase failed.',
    'Package installation failed and managed cleanup also failed.',
    'Mock runtime qualification remains unavailable.',
    'Mock runtime cleanup confirmation failed.',
  ]);
  await lstat(failure.retainedStateRoot);
  const contentRoot = join(failure.retainedStateRoot, 'installer', 'content');
  await lstat(contentRoot);
});

test('the compiled CLI runs content and rejects strict flags without fixture state', async () => {
  const cliPath = new URL('../../apps/cli/src/index.js', import.meta.url).pathname;
  const content = await runCommand(process.execPath, [
    cliPath,
    'install-demo',
    '--fixture',
    'content',
  ]);

  assert.equal(content.exitCode, 0);
  assert.equal(content.stderr, '');
  const report = JSON.parse(content.stdout) as { retainedStateRoot: string; status: string };
  assert.equal(report.status, 'installed-disabled');
  await lstat(report.retainedStateRoot);

  const malformedArguments = [
    ['install-demo', '--fixture', 'content', '--image', TRUSTED_IMAGE],
    ['install-demo', '--fixture', 'content', '--fixture', 'content'],
    ['install-demo', '--fixture', 'executable'],
    ['install-demo', '--fixture', 'executable', '--image', `sha256:${'A'.repeat(64)}`],
    ['install-demo', '--fixture', 'unknown'],
    ['install-demo', '--fixture', 'content', '--unknown', 'value'],
  ];
  const rootsBefore = await listDemoStateRoots();

  for (const argumentsValue of malformedArguments) {
    const malformed = await runCommand(process.execPath, [cliPath, ...argumentsValue]);
    assert.equal(malformed.exitCode, 1);
    assert.match(malformed.stderr, /qdroid install-demo --fixture content/);
  }

  assert.deepEqual(await listDemoStateRoots(), rootsBefore);
});

test(
  'the compiled CLI rejects an unsupported executable platform before fixture state',
  {
    skip:
      process.platform === 'linux' && process.arch === 'arm64'
        ? 'The current host is the production Linux ARM64 platform.'
        : false,
  },
  async () => {
    const cliPath = new URL('../../apps/cli/src/index.js', import.meta.url).pathname;
    const rootsBefore = await listDemoStateRoots();
    const result = await runCommand(process.execPath, [
      cliPath,
      'install-demo',
      '--fixture',
      'executable',
      '--image',
      TRUSTED_IMAGE,
    ]);

    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.stderr), {
      category: 'input',
      retainedStateRoot: null,
      status: 'failed',
    });
    assert.deepEqual(await listDemoStateRoots(), rootsBefore);
  },
);

test('the CLI command helper retains output and TERM-timeout failures after bounded cleanup', async () => {
  const outputLimitedChild = [
    "process.on('SIGTERM', () => undefined);",
    "process.stdout.write('x'.repeat(96 * 1024));",
    'setInterval(() => undefined, 1_000);',
  ].join('\n');

  await assert.rejects(
    runCommand(process.execPath, ['--eval', outputLimitedChild]),
    (error: unknown) => {
      const messages = collectErrorMessages(error);
      assert.ok(messages.some((message) => /output exceeded 65536 bytes/.test(message)));
      assert.ok(messages.some((message) => /child close after SIGTERM/.test(message)));
      return true;
    },
  );
});

test(
  'the CLI command helper reports an unsettled owned group after the leader closes',
  { skip: process.platform === 'win32' ? 'Windows does not expose POSIX process groups.' : false },
  async () => {
    const evidenceDirectory = await mkdtemp(join(tmpdir(), 'qdroid-package-install-demo-keeper-'));
    const evidencePath = join(evidenceDirectory, 'descendant-exit.txt');
    const keeperPath = new URL(
      '../../fixtures/package-install-demo/src/owned-process-group-keeper.js',
      import.meta.url,
    ).pathname;

    await assert.rejects(
      runCommand(process.execPath, [keeperPath, evidencePath]),
      (error: unknown) => {
        const messages = collectErrorMessages(error);
        assert.ok(
          messages.some((message) =>
            /process group \d+ remained after its leader closed/.test(message),
          ),
        );
        return true;
      },
    );
    assert.equal(await waitForFile(evidencePath), 'finite descendant exited\n');
  },
);

function mockAssembler(calls: string[], expectedBaseImage?: string): TrustedImageAssembler {
  return {
    assemble: async (request) => {
      calls.push(`assemble:${request.purpose}`);
      if (expectedBaseImage !== undefined) {
        assert.equal(request.base.baseImage, expectedBaseImage);
        assert.equal(request.base.builderImage, expectedBaseImage);
      }
      return {
        cleanupConfirmed: true,
        imageId:
          request.purpose === 'builder' ? `sha256:${'2'.repeat(64)}` : `sha256:${'3'.repeat(64)}`,
        receipt: { purpose: request.purpose },
      };
    },
    verifySealed: async () => {
      calls.push('verify');
    },
  };
}

function completedExecution(output: Uint8Array): BuildExecutionResult {
  return {
    completion: Promise.resolve({ cleanupConfirmed: true, exitCode: 0, reason: 'completed' }),
    stderr: chunks([]),
    stdout: chunks([output]),
  };
}

async function* chunks(values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield value;
  }
}

async function assertRejectsWithoutNewDemoState(operation: () => Promise<unknown>): Promise<void> {
  const rootsBefore = await listDemoStateRoots();
  await assert.rejects(operation);
  assert.deepEqual(await listDemoStateRoots(), rootsBefore);
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(lstat(path), (error: unknown) => {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  });
}

async function listDemoStateRoots(): Promise<readonly string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith('qdroid-package-install-demo-')).sort();
}

function collectErrorMessages(error: unknown): readonly string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap((member) => collectErrorMessages(member))];
  }
  if (!(error instanceof Error)) {
    return [String(error)];
  }

  const cause = 'cause' in error ? error.cause : undefined;
  return [error.message, ...(cause === undefined ? [] : collectErrorMessages(cause))];
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface ChildExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

type CapturedChild = ChildProcessByStdio<null, Readable, Readable>;

async function runCommand(
  executable: string,
  argumentsValue: readonly string[],
): Promise<CommandResult> {
  const failures: unknown[] = [];
  let stopReason: Error | undefined;
  let resolveStop: ((reason: Error) => void) | undefined;
  const stopRequested = new Promise<Error>((resolve) => {
    resolveStop = resolve;
  });
  const requestStop = (reason: Error): void => {
    if (stopReason !== undefined) {
      return;
    }
    stopReason = reason;
    resolveStop?.(reason);
  };
  const recordFailure = (error: Error): void => {
    failures.push(error);
    requestStop(error);
  };
  const child = spawn(executable, [...argumentsValue], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let capturedBytes = 0;
  const childExit = waitForChildExit(child, recordFailure);
  const streamsClosed = Promise.all([
    waitForStreamClose(child.stdout, recordFailure),
    waitForStreamClose(child.stderr, recordFailure),
  ]);

  const capture = (chunks: Buffer[], chunk: Buffer, streamName: string): void => {
    const remaining = MAX_COMMAND_OUTPUT_BYTES - capturedBytes;
    if (remaining > 0) {
      const boundedChunk = chunk.subarray(0, remaining);
      chunks.push(boundedChunk);
      capturedBytes += boundedChunk.byteLength;
    }
    if (chunk.byteLength > remaining) {
      requestStop(
        new Error(
          `The CLI command output exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes on ${streamName}.`,
        ),
      );
    }
  };
  child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk, 'stderr'));

  const deadline = setTimeout(() => {
    requestStop(new Error(`The CLI command exceeded ${COMMAND_DEADLINE_MS} ms.`));
  }, COMMAND_DEADLINE_MS);
  let exit: ChildExit | undefined;

  try {
    const outcome = await Promise.race([
      childExit.then((value) => ({ type: 'child-exit' as const, value })),
      stopRequested.then((value) => ({ type: 'stop' as const, value })),
    ]);

    if (outcome.type === 'child-exit') {
      exit = outcome.value;
    } else {
      if (!failures.includes(outcome.value)) {
        failures.push(outcome.value);
      }
      failures.push(...(await terminateOwnedChild(child, childExit, streamsClosed)));
    }
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(deadline);
  }

  exit ??= await settleAndRecord(childExit, COMMAND_CLOSE_GRACE_MS, 'child close', failures);
  const streamsSettled = await settleAndRecord(
    streamsClosed,
    COMMAND_CLOSE_GRACE_MS,
    'child standard streams',
    failures,
  );
  if (streamsSettled === undefined) {
    closeOwnedStreams(child, failures);
    await settleAndRecord(
      streamsClosed,
      COMMAND_CLOSE_GRACE_MS,
      'child standard streams after forced close',
      failures,
    );
  }

  if (exit === undefined) {
    failures.push(new Error('The CLI command ended without child close evidence.'));
  } else {
    const processGroupFailure = confirmProcessGroupSettled(child.pid);
    if (processGroupFailure !== undefined) {
      failures.push(processGroupFailure);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'The bounded CLI command or its owned-child cleanup failed.',
    );
  }
  if (exit === undefined) {
    throw new Error('The CLI command has no child close evidence after settlement.');
  }

  return {
    exitCode: exit.exitCode,
    signal: exit.signal,
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout).toString('utf8'),
  };
}

function waitForChildExit(
  child: CapturedChild,
  recordFailure: (error: Error) => void,
): Promise<ChildExit> {
  return new Promise((resolve) => {
    child.once('error', recordFailure);
    child.once('close', (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });
}

function waitForStreamClose(
  stream: Readable,
  recordFailure: (error: Error) => void,
): Promise<void> {
  return new Promise((resolve) => {
    if (stream.closed) {
      resolve();
      return;
    }
    stream.once('error', recordFailure);
    stream.once('close', resolve);
  });
}

async function terminateOwnedChild(
  child: CapturedChild,
  childExit: Promise<ChildExit>,
  streamsClosed: Promise<unknown>,
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  signalExactChild(child, 'SIGTERM', failures);
  const terminated = await settleAndRecord(
    childExit,
    COMMAND_CLOSE_GRACE_MS,
    'child close after SIGTERM',
    failures,
  );
  if (terminated === undefined) {
    signalExactChild(child, 'SIGKILL', failures);
    await settleAndRecord(childExit, COMMAND_CLOSE_GRACE_MS, 'child close after SIGKILL', failures);
  }
  closeOwnedStreams(child, failures);

  await settleAndRecord(
    streamsClosed,
    COMMAND_CLOSE_GRACE_MS,
    'child standard streams after cleanup',
    failures,
  );
  return failures;
}

function signalExactChild(child: CapturedChild, signal: NodeJS.Signals, failures: unknown[]): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    failures.push(new Error(`The exact CLI child was unavailable for ${signal} cleanup.`));
    return;
  }

  try {
    if (!child.kill(signal)) {
      failures.push(new Error(`The exact CLI child rejected ${signal} cleanup.`));
    }
  } catch (error) {
    failures.push(error);
  }
}

function closeOwnedStreams(child: CapturedChild, failures: unknown[]): void {
  for (const stream of [child.stdout, child.stderr]) {
    try {
      stream.destroy();
    } catch (error) {
      failures.push(error);
    }
  }
}

function confirmProcessGroupSettled(pid: number | undefined): Error | undefined {
  if (pid === undefined) {
    return new Error('The CLI child had no process identity for group settlement evidence.');
  }
  if (process.platform === 'win32') {
    return undefined;
  }

  try {
    process.kill(-pid, 0);
    return new Error(
      `The owned process group ${pid} remained after its leader closed; cleanup is unknown.`,
    );
  } catch (error) {
    if (isAlreadyExitedError(error)) {
      return undefined;
    }
    return new Error('The owned process group could not be confirmed as settled.', {
      cause: error,
    });
  }
}

async function settleAndRecord<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  failures: unknown[],
): Promise<T | undefined> {
  try {
    return await settleWithin(promise, timeoutMs, label);
  } catch (error) {
    failures.push(error);
    return undefined;
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${label} after ${timeoutMs} ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function isAlreadyExitedError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + COMMAND_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
    await delay(25);
  }
  throw new Error(
    `The finite descendant did not write its exit evidence within ${COMMAND_DEADLINE_MS} ms.`,
  );
}

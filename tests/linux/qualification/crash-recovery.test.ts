import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { OciSandboxBackend } from '../../../packages/runtime-oci/src/backend.js';

const image = process.env.QDROID_T004_IMAGE;
const journalKeyName = '.journal-key';
const workerPath = fileURLToPath(
  new URL('../../../fixtures/host-boundary/src/backend-crash-worker.js', import.meta.url),
);
const recoveryLockWorkerPath = fileURLToPath(
  new URL('../../../fixtures/host-boundary/src/recovery-lock-worker.js', import.meta.url),
);
const networkFixtureCrashWorkerPath = fileURLToPath(
  new URL('../../../fixtures/host-boundary/src/network-fixture-crash-worker.js', import.meta.url),
);
const stalledCleanupGuardianPath = fileURLToPath(
  new URL('../../../fixtures/host-boundary/src/stalled-cleanup-guardian.js', import.meta.url),
);
const delayedRecoveryMutationWorkerPath = fileURLToPath(
  new URL(
    '../../../fixtures/host-boundary/src/delayed-recovery-mutation-worker.js',
    import.meta.url,
  ),
);

interface ProcessIdentity {
  pid: number;
  start: string | null;
}

interface CrashWorkerReady {
  barrier?: {
    containerId: string;
    sessionId: string;
  };
}

interface CrashWorker extends ChildProcessWithoutNullStreams {
  t004Ready: CrashWorkerReady;
}

interface NetworkFixtureBarrier {
  controllerPgid: number;
  controllerPid: number;
  interfaceName: string;
  marker: string;
  sessionId: string;
}

interface NetworkFixtureCrashWorker extends ChildProcessWithoutNullStreams {
  networkFixtureBarrier: NetworkFixtureBarrier;
}

interface NetworkFixtureJournal {
  controller: ProcessIdentity;
  controllerPgid: number;
  interfaceName: string;
  marker: string;
  parent: ProcessIdentity;
  sessionId: string;
}

interface HeartbeatPeerWorker {
  intentRejected: boolean;
  heartbeat(token: string): Promise<void>;
  stop(): Promise<{
    cleanup: { cleanupConfirmed: boolean; status: string };
    completion: { cleanupConfirmed: boolean; reason: string };
  }>;
  worker: ChildProcessWithoutNullStreams;
}

interface StopFenceWorker {
  retry(): Promise<{ cleanupConfirmed: boolean; status: string }>;
  stop(): Promise<{
    cleanup: { cleanupConfirmed: boolean; status: string };
    executeRejected: boolean;
  }>;
  worker: ChildProcessWithoutNullStreams;
}

interface CleanupJournal {
  authenticationTag: string;
  containerId?: string;
  containerName: string;
  creationAuthorization?: 'not-authorized' | 'possibly-submitted';
  guardian: ProcessIdentity;
  guardianPgid?: number;
  hostBootId: string;
  imageId: string;
  labels: Record<string, string>;
  ownerId: string;
  parent: ProcessIdentity;
  profileDigest: string;
  profileId: string;
  recoveryWriter?: ProcessIdentity;
  recoveryWriterPgid?: number;
  sessionId: string;
  version: number;
}

test('recovery keeps a receipt-backed current journal on Docker inspection failure and ignores an obsolete lock artifact', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-recovery-inspect-'));
  const dockerDirectory = await mkdtemp(join(tmpdir(), 'qdroid-t004-fake-docker-'));
  const dockerPath = join(dockerDirectory, 'docker');
  const originalPath = process.env.PATH;
  let completed = false;

  try {
    const backend = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    await backend.recoverAbandoned();
    const { journal, journalFile } = await writeReceiptBackedDeadJournal(ownerStorePath);
    const recoveryLock = {
      bootId: journal.hostBootId,
      owner: { pid: -1, start: null },
      token: randomUUID(),
      version: 1,
    };
    await writeFile(join(ownerStorePath, '.recovery.lock'), `${JSON.stringify(recoveryLock)}\n`, {
      mode: 0o600,
    });

    await writeFakeDocker(
      dockerPath,
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    );
    process.env.PATH = `${dockerDirectory}:${originalPath ?? ''}`;
    const unknownReport = await backend.recoverAbandoned();
    assert.deepEqual(unknownReport, {
      recoveredRecords: 0,
      unresolvedRecordCount: 1,
      unresolvedRecords: [{ record: `${journal.sessionId}.json`, status: 'remove-failed' }],
      unresolvedRecordsTruncated: false,
    });
    await assert.doesNotReject(readFile(journalFile, 'utf8'));
    await assert.doesNotReject(readFile(join(ownerStorePath, '.recovery.lock'), 'utf8'));

    await writeFakeDocker(dockerPath, `error: no such object: ${journal.containerName}`);
    const recoveredReport = await backend.recoverAbandoned();
    assert.deepEqual(recoveredReport, {
      recoveredRecords: 1,
      unresolvedRecordCount: 0,
      unresolvedRecords: [],
      unresolvedRecordsTruncated: false,
    });
    await assert.rejects(readFile(journalFile, 'utf8'), /ENOENT/);
    completed = true;
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(dockerDirectory, { force: true, recursive: true });
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('legacy journals without current create proof remain unresolved without Docker inspection or rewrite', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-legacy-journal-'));
  const dockerDirectory = await mkdtemp(join(tmpdir(), 'qdroid-t004-legacy-docker-'));
  const dockerPath = join(dockerDirectory, 'docker');
  const dockerLogPath = join(dockerDirectory, 'docker.log');
  const originalPath = process.env.PATH;
  let completed = false;

  try {
    const bootstrap = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    await bootstrap.recoverAbandoned();
    const { journal, journalFile } = await writeDeadAuthenticatedJournal(ownerStorePath);
    const originalJournal = await readFile(journalFile, 'utf8');

    await writeFile(dockerPath, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${dockerLogPath}'\nexit 1\n`, {
      mode: 0o700,
    });
    await chmod(dockerPath, 0o700);
    process.env.PATH = `${dockerDirectory}:${originalPath ?? ''}`;

    const report = await bootstrap.recoverAbandoned();
    assert.deepEqual(report, {
      recoveredRecords: 0,
      unresolvedRecordCount: 1,
      unresolvedRecords: [{ record: `${journal.sessionId}.json`, status: 'creation-unknown' }],
      unresolvedRecordsTruncated: false,
    });
    assert.equal(await readFile(journalFile, 'utf8'), originalJournal);
    await assert.rejects(readFile(dockerLogPath, 'utf8'), /ENOENT/);
    completed = true;
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(dockerDirectory, { force: true, recursive: true });
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('SQLite recovery ownership excludes a live peer and is released by SIGKILL', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-recovery-lock-'));
  const dockerDirectory = await mkdtemp(join(tmpdir(), 'qdroid-t004-lock-docker-'));
  const dockerPath = join(dockerDirectory, 'docker');
  const logPath = join(dockerDirectory, 'docker.log');
  const originalPath = process.env.PATH;
  let firstWorker: ChildProcessWithoutNullStreams | undefined;
  let completed = false;

  try {
    const bootstrap = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    await bootstrap.recoverAbandoned();
    const { journalFile } = await writeReceiptBackedDeadJournal(ownerStorePath);

    await writeSlowFakeDocker(dockerPath, logPath);
    const workerEnvironment = {
      ...process.env,
      PATH: `${dockerDirectory}:${originalPath ?? ''}`,
    };
    firstWorker = startRecoveryLockWorker(requiredImage(), ownerStorePath, workerEnvironment);
    await waitForLogLine(logPath, 'inspect');

    const competingWorker = startRecoveryLockWorker(
      requiredImage(),
      ownerStorePath,
      workerEnvironment,
    );
    const competingResult = await waitForWorkerExit(competingWorker, 5_000);
    assert.notEqual(competingResult.exitCode, 0);
    assert.match(competingResult.stderr, /Another sandbox recovery owner is already active/);
    const heldWorker = firstWorker;
    if (heldWorker?.pid === undefined) {
      throw new Error('The first recovery-lock worker did not expose a task-owned PID.');
    }
    assert.doesNotThrow(() => process.kill(heldWorker.pid as number, 0));

    heldWorker.kill('SIGKILL');
    await waitForWorkerExit(heldWorker, 5_000);
    await writeFakeDocker(
      dockerPath,
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    );

    const recoveredWorker = startRecoveryLockWorker(
      requiredImage(),
      ownerStorePath,
      workerEnvironment,
    );
    const recoveredResult = await waitForWorkerExit(recoveredWorker, 5_000);
    assert.equal(recoveredResult.exitCode, 0, recoveredResult.stderr);
    await assert.doesNotReject(readFile(journalFile, 'utf8'));
    completed = true;
  } finally {
    if (firstWorker?.pid !== undefined) {
      try {
        process.kill(firstWorker.pid, 'SIGKILL');
      } catch {
        // The worker was already stopped after the recovery-lock assertion.
      }
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(dockerDirectory, { force: true, recursive: true });
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('a crash after durable journal retirement leaves an inert receipt without replaying cleanup', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-receipt-retirement-crash-'));
  const dockerDirectory = await mkdtemp(join(tmpdir(), 'qdroid-t004-receipt-retirement-docker-'));
  const dockerPath = join(dockerDirectory, 'docker');
  const dockerLogPath = join(dockerDirectory, 'docker.log');
  const originalPath = process.env.PATH;
  let recoveryWorker: ChildProcessWithoutNullStreams | undefined;
  let guardian: ChildProcess | undefined;
  let guardianPgid: number | undefined;
  let completed = false;

  try {
    const bootstrap = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    await bootstrap.recoverAbandoned();
    const key = await readFile(join(ownerStorePath, journalKeyName));
    const hostBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const sessionId = randomUUID();
    const ownerId = randomUUID();
    const profileDigest = 'd'.repeat(64);
    const containerName = `qdroid-t004-${sessionId}`;

    guardian = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    assert.notEqual(guardian.pid, undefined);
    const guardianStart = await readProcessStart(guardian.pid as number);
    const observedGuardianPgid = await readProcessGroupId(guardian.pid as number);
    if (guardianStart === null || observedGuardianPgid === null) {
      throw new Error('The receipt-retirement fixture guardian did not expose a trusted identity.');
    }
    guardianPgid = observedGuardianPgid;
    const guardianIdentity = { pid: guardian.pid as number, start: guardianStart };

    const journalIntent = {
      containerName,
      creationAuthorization: 'possibly-submitted' as const,
      guardian: guardianIdentity,
      guardianPgid: observedGuardianPgid,
      hostBootId,
      imageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      labels: {
        'io.qdroid.owner': ownerId,
        'io.qdroid.profile': profileDigest,
        'io.qdroid.session': sessionId,
      },
      ownerId,
      parent: { pid: -1, start: null },
      profileDigest,
      profileId: 'tool-offline',
      sessionId,
      version: 3 as const,
    };
    const journalFile = join(ownerStorePath, `${sessionId}.json`);
    await writeFile(
      journalFile,
      `${JSON.stringify({
        ...journalIntent,
        authenticationTag: createHmac('sha256', key)
          .update(JSON.stringify(journalPayload(journalIntent)))
          .digest('hex'),
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(journalFile, 0o600);

    const receiptPayload = {
      containerName,
      guardian: guardianIdentity,
      hostBootId,
      sessionId,
      version: 1,
    };
    const receiptPath = creationReceiptPath(ownerStorePath, sessionId);
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        ...receiptPayload,
        authenticationTag: createHmac('sha256', key)
          .update(JSON.stringify(receiptPayload))
          .digest('hex'),
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(receiptPath, 0o600);

    await killExactProcess(guardianIdentity);
    await waitForProcessGroupExit(observedGuardianPgid);

    await writeFile(
      dockerPath,
      `#!/bin/sh
printf '%s\\n' "$1" >> "$QDROID_TEST_LOG"
if [ "$1" = inspect ]; then
  printf '%s\\n' "Error: No such object: $4" >&2
fi
exit 1
`,
      { mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    const environment = {
      ...process.env,
      PATH: `${dockerDirectory}:${originalPath ?? ''}`,
      QDROID_TEST_LOG: dockerLogPath,
    };
    recoveryWorker = startRecoveryLockWorker(
      requiredImage(),
      ownerStorePath,
      environment,
      'after-journal-retired',
    );
    await waitForWorkerStdoutLine(recoveryWorker, `journal-retired:${sessionId}`);

    const recoveryIdentity = {
      pid: recoveryWorker.pid as number,
      start: await readProcessStart(recoveryWorker.pid as number),
    };
    assert.notEqual(recoveryIdentity.start, null);
    await killExactProcess(recoveryIdentity);
    assert.equal(await waitForChildExit(recoveryWorker, 15_000), true);

    await assert.rejects(readFile(journalFile, 'utf8'), /ENOENT/);
    await assert.doesNotReject(readFile(receiptPath, 'utf8'));
    assert.deepEqual((await readFile(dockerLogPath, 'utf8')).trim().split('\n'), ['inspect']);

    const afterCrashRecovery = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    assert.deepEqual(await afterCrashRecovery.recoverAbandoned(), {
      recoveredRecords: 0,
      unresolvedRecordCount: 0,
      unresolvedRecords: [],
      unresolvedRecordsTruncated: false,
    });
    assert.deepEqual((await readFile(dockerLogPath, 'utf8')).trim().split('\n'), ['inspect']);
    completed = true;
  } finally {
    await terminateTaskOwnedChild(recoveryWorker);
    if (guardian?.pid !== undefined && guardianPgid !== undefined) {
      const guardianStart = await readProcessStart(guardian.pid);
      if (guardianStart !== null) {
        await terminateProcessGroupIfExactMember(
          { pid: guardian.pid, start: guardianStart },
          guardianPgid,
        );
      }
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(dockerDirectory, { force: true, recursive: true });
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('receipt-backed recovery never signals a reused foreign process group', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-reused-group-'));
  const dockerDirectory = await mkdtemp(join(tmpdir(), 'qdroid-t004-reused-group-docker-'));
  const dockerPath = join(dockerDirectory, 'docker');
  const dockerLogPath = join(dockerDirectory, 'docker.log');
  const originalPath = process.env.PATH;
  let recordedGuardian: ChildProcess | undefined;
  let foreignProcess: ChildProcess | undefined;
  let foreignIdentity: ProcessIdentity | undefined;
  let foreignPgid: number | undefined;
  let completed = false;

  try {
    const bootstrap = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    await bootstrap.recoverAbandoned();
    const key = await readFile(join(ownerStorePath, journalKeyName));
    const hostBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const sessionId = randomUUID();
    const ownerId = randomUUID();
    const profileDigest = 'e'.repeat(64);
    const containerName = `qdroid-t004-${sessionId}`;

    recordedGuardian = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    assert.notEqual(recordedGuardian.pid, undefined);
    const guardianStart = await readProcessStart(recordedGuardian.pid as number);
    const recordedGuardianPgid = await readProcessGroupId(recordedGuardian.pid as number);
    if (guardianStart === null || recordedGuardianPgid === null) {
      throw new Error('The recorded guardian did not expose a trusted identity.');
    }
    const guardianIdentity = { pid: recordedGuardian.pid as number, start: guardianStart };
    await killExactProcess(guardianIdentity);
    await waitForProcessGroupExit(recordedGuardianPgid);

    foreignProcess = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    assert.notEqual(foreignProcess.pid, undefined);
    const foreignStart = await readProcessStart(foreignProcess.pid as number);
    const observedForeignPgid = await readProcessGroupId(foreignProcess.pid as number);
    if (foreignStart === null || observedForeignPgid === null) {
      throw new Error('The foreign process did not expose a trusted identity.');
    }
    foreignIdentity = { pid: foreignProcess.pid as number, start: foreignStart };
    foreignPgid = observedForeignPgid;

    const journalIntent = {
      containerName,
      creationAuthorization: 'possibly-submitted' as const,
      guardian: guardianIdentity,
      // Simulate numeric process-group reuse after the authenticated guardian
      // has exited. The live group is deliberately unrelated to this journal.
      guardianPgid: observedForeignPgid,
      hostBootId,
      imageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      labels: {
        'io.qdroid.owner': ownerId,
        'io.qdroid.profile': profileDigest,
        'io.qdroid.session': sessionId,
      },
      ownerId,
      parent: { pid: -1, start: null },
      profileDigest,
      profileId: 'tool-offline',
      sessionId,
      version: 3 as const,
    };
    const journalFile = join(ownerStorePath, `${sessionId}.json`);
    await writeFile(
      journalFile,
      `${JSON.stringify({
        ...journalIntent,
        authenticationTag: createHmac('sha256', key)
          .update(JSON.stringify(journalPayload(journalIntent)))
          .digest('hex'),
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(journalFile, 0o600);
    const receiptPayload = {
      containerName,
      guardian: guardianIdentity,
      hostBootId,
      sessionId,
      version: 1,
    };
    await writeFile(
      creationReceiptPath(ownerStorePath, sessionId),
      `${JSON.stringify({
        ...receiptPayload,
        authenticationTag: createHmac('sha256', key)
          .update(JSON.stringify(receiptPayload))
          .digest('hex'),
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(creationReceiptPath(ownerStorePath, sessionId), 0o600);

    await writeFile(
      dockerPath,
      `#!/bin/sh
printf '%s\\n' "$1" >> "$QDROID_TEST_LOG"
if [ "$1" = inspect ]; then
  printf '%s\\n' "Error: No such object: $4" >&2
fi
exit 1
`,
      { mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    process.env.PATH = `${dockerDirectory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_LOG = dockerLogPath;

    const recovery = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    assert.deepEqual(await recovery.recoverAbandoned(), {
      recoveredRecords: 0,
      unresolvedRecordCount: 1,
      unresolvedRecords: [{ record: `${sessionId}.json`, status: 'control-group-live' }],
      unresolvedRecordsTruncated: false,
    });
    assert.doesNotThrow(() => process.kill(foreignIdentity?.pid as number, 0));
    assert.deepEqual((await readFile(dockerLogPath, 'utf8')).trim().split('\n'), ['inspect']);
    await assert.doesNotReject(readFile(journalFile, 'utf8'));
    completed = true;
  } finally {
    if (foreignIdentity !== undefined && foreignPgid !== undefined) {
      await terminateProcessGroupIfExactMember(foreignIdentity, foreignPgid);
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    delete process.env.QDROID_TEST_LOG;
    await rm(dockerDirectory, { force: true, recursive: true });
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

async function writeFakeDocker(path: string, stderr: string): Promise<void> {
  await writeFile(
    path,
    `#!/bin/sh
printf '%s\\n' '${stderr}' >&2
exit 1
`,
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
}

async function writeSlowFakeDocker(path: string, logPath: string): Promise<void> {
  await writeFile(
    path,
    `#!/bin/sh
if [ "$1" = inspect ]; then
  printf '%s\\n' inspect >> '${logPath}'
  sleep 10
  printf '%s\\n' 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2
  exit 1
fi
exit 1
`,
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
}

async function writeDeadAuthenticatedJournal(
  ownerStorePath: string,
): Promise<{ journal: CleanupJournal; journalFile: string }> {
  const key = await readFile(join(ownerStorePath, journalKeyName));
  const hostBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const ownerId = randomUUID();
  const profileDigest = 'a'.repeat(64);
  const sessionId = randomUUID();
  const intent = {
    containerName: `qdroid-t004-${sessionId}`,
    guardian: { pid: -1, start: null },
    hostBootId,
    imageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    labels: {
      'io.qdroid.owner': ownerId,
      'io.qdroid.profile': profileDigest,
      'io.qdroid.session': sessionId,
    },
    ownerId,
    parent: { pid: -1, start: null },
    profileDigest,
    profileId: 'tool-offline',
    sessionId,
    version: 2,
  };
  const journal: CleanupJournal = {
    ...intent,
    authenticationTag: createHmac('sha256', key)
      .update(JSON.stringify(journalPayload(intent)))
      .digest('hex'),
  };
  const journalFile = join(ownerStorePath, `${sessionId}.json`);
  await writeFile(journalFile, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  await chmod(journalFile, 0o600);
  return { journal, journalFile };
}

async function writeReceiptBackedDeadJournal(
  ownerStorePath: string,
): Promise<{ journal: CleanupJournal; journalFile: string }> {
  const key = await readFile(join(ownerStorePath, journalKeyName));
  const hostBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const ownerId = randomUUID();
  const profileDigest = 'f'.repeat(64);
  const sessionId = randomUUID();
  const containerName = `qdroid-t004-${sessionId}`;
  const guardianProcess = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (guardianProcess.pid === undefined) {
    throw new Error('The receipt-backed recovery fixture guardian did not expose a PID.');
  }

  const guardianStart = await readProcessStart(guardianProcess.pid);
  const guardianPgid = await readProcessGroupId(guardianProcess.pid);
  if (guardianStart === null || guardianPgid === null) {
    throw new Error('The receipt-backed recovery fixture guardian identity is unavailable.');
  }
  const guardian = { pid: guardianProcess.pid, start: guardianStart };
  const journalIntent = {
    containerName,
    creationAuthorization: 'possibly-submitted' as const,
    guardian,
    guardianPgid,
    hostBootId,
    imageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    labels: {
      'io.qdroid.owner': ownerId,
      'io.qdroid.profile': profileDigest,
      'io.qdroid.session': sessionId,
    },
    ownerId,
    parent: { pid: -1, start: null },
    profileDigest,
    profileId: 'tool-offline',
    sessionId,
    version: 3 as const,
  };
  const journal: CleanupJournal = {
    ...journalIntent,
    authenticationTag: createHmac('sha256', key)
      .update(JSON.stringify(journalPayload(journalIntent)))
      .digest('hex'),
  };
  const journalFile = join(ownerStorePath, `${sessionId}.json`);
  await writeFile(journalFile, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  await chmod(journalFile, 0o600);

  const receiptPayload = {
    containerName,
    guardian,
    hostBootId,
    sessionId,
    version: 1,
  };
  const receiptPath = creationReceiptPath(ownerStorePath, sessionId);
  await writeFile(
    receiptPath,
    `${JSON.stringify({
      ...receiptPayload,
      authenticationTag: createHmac('sha256', key)
        .update(JSON.stringify(receiptPayload))
        .digest('hex'),
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(receiptPath, 0o600);

  await killExactProcess(guardian);
  await waitForProcessGroupExit(guardianPgid);
  return { journal, journalFile };
}

function startDelayedRecoveryMutationWorker(
  imageValue: string,
  ownerStorePath: string,
  mode: 'retire-journal' | 'writer-registration',
  releasePath: string,
  environment: NodeJS.ProcessEnv = process.env,
  convergencePath?: string,
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      delayedRecoveryMutationWorkerPath,
      imageValue,
      ownerStorePath,
      mode,
      releasePath,
      ...(convergencePath === undefined ? [] : [convergencePath]),
    ],
    {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

function startRecoveryLockWorker(
  imageValue: string,
  ownerStorePath: string,
  environment: NodeJS.ProcessEnv,
  mode?: 'after-journal-retired' | 'after-network-writer-registration',
  releasePath?: string,
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      recoveryLockWorkerPath,
      imageValue,
      ownerStorePath,
      ...(mode === undefined ? [] : [mode]),
      ...(releasePath === undefined ? [] : [releasePath]),
    ],
    {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

async function waitForWorkerExit(
  worker: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stderr: string }> {
  const stderr: Buffer[] = [];
  worker.stderr.on('data', (chunk: Buffer) => {
    if (Buffer.concat(stderr).byteLength < 65_536) {
      stderr.push(chunk);
    }
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (worker.pid !== undefined) {
        worker.kill('SIGKILL');
      }
      reject(new Error('The recovery-lock worker exceeded its bounded test deadline.'));
    }, timeoutMs);
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

async function waitForWorkerStdoutLine(
  worker: ChildProcessWithoutNullStreams,
  expected: string,
): Promise<void> {
  let output = '';
  await waitWithin(
    new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        if (!output.split('\n').includes(expected)) {
          return;
        }
        worker.stdout.off('data', onData);
        worker.off('exit', onExit);
        resolve();
      };
      const onExit = (): void => {
        worker.stdout.off('data', onData);
        reject(new Error(`The recovery worker exited before ${expected}.`));
      };
      worker.stdout.on('data', onData);
      worker.once('exit', onExit);
    }),
    15_000,
    `The recovery worker did not reach ${expected}.`,
  );
}

async function stopHeartbeatPeerOrTerminate(peer: HeartbeatPeerWorker | undefined): Promise<void> {
  if (peer === undefined || peer.worker.exitCode !== null) {
    return;
  }

  await peer.stop().catch(() => undefined);
  await terminateTaskOwnedChild(peer.worker);
}

async function terminateTaskOwnedChild(worker: ChildProcess | undefined): Promise<void> {
  if (worker?.pid === undefined || worker.exitCode !== null) {
    return;
  }

  const pid = worker.pid;
  const start = await readProcessStart(pid);
  if (start === null) {
    return;
  }

  if (await signalTaskOwnedChild(worker, pid, start, 'SIGTERM')) {
    const exitedAfterTerm = await waitForChildExit(worker, 5_000);
    if (exitedAfterTerm) {
      return;
    }
  }

  await signalTaskOwnedChild(worker, pid, start, 'SIGKILL');
  await waitForChildExit(worker, 5_000);
}

async function signalTaskOwnedChild(
  worker: ChildProcess,
  pid: number,
  expectedStart: string,
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (worker.exitCode !== null || (await readProcessStart(pid)) !== expectedStart) {
    return false;
  }

  try {
    return worker.kill(signal);
  } catch {
    return false;
  }
}

async function waitForChildExit(worker: ChildProcess, timeoutMs: number): Promise<boolean> {
  const exited = (): boolean => worker.exitCode !== null || worker.signalCode !== null;

  if (exited()) {
    return true;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      worker.off('exit', onExit);
      resolve(exited());
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    worker.once('exit', onExit);
  });
}

test('a SIGKILLed manager leaves guardian cleanup to a fresh manager without replaying work', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-manager-crash-'));
  let worker: CrashWorker | undefined;
  let completed = false;

  try {
    worker = await startCrashWorker(requiredImage(), ownerStorePath);
    const journal = await waitForJournal(ownerStorePath);

    await killWorker(worker, journal.parent);
    await waitForProcessExit(journal.guardian);
    await waitForContainerAbsence(journal.containerName);

    const recovery = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    await recovery.recoverAbandoned();

    await assert.rejects(readFile(journalPath(ownerStorePath, journal), 'utf8'), /ENOENT/);
    completed = true;
  } finally {
    await terminateTaskOwnedChild(worker);
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('a late daemon-side create effect after client death keeps a receipt-less journal unresolved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-t004-late-create-effect-'));
  const ownerStorePath = join(directory, 'owner-store');
  const effectPath = join(directory, 'late-create-effect');
  const daemonReadyPath = join(directory, 'late-create-ready.json');
  const releasePath = join(directory, 'release-late-create-effect');
  const backend = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
  let delayedClient: ChildProcess | undefined;
  let delayedDaemon: ChildProcess | undefined;
  let delayedDaemonIdentity: ProcessIdentity | undefined;
  let delayedClientIdentity: ProcessIdentity | undefined;
  let completed = false;

  try {
    await backend.recoverAbandoned();
    const key = await readFile(join(ownerStorePath, journalKeyName));
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const sessionId = randomUUID();
    const ownerId = randomUUID();
    const profileDigest = 'b'.repeat(64);
    const delayedDaemonProgram = [
      "const { existsSync, writeFileSync } = require('node:fs');",
      `const releasePath = ${JSON.stringify(releasePath)};`,
      `const effectPath = ${JSON.stringify(effectPath)};`,
      `const daemonReadyPath = ${JSON.stringify(daemonReadyPath)};`,
      "writeFileSync(daemonReadyPath, JSON.stringify({ pid: process.pid }) + '\\n');",
      'const timer = setInterval(() => {',
      '  if (!existsSync(releasePath)) { return; }',
      "  writeFileSync(effectPath, 'late-daemon-create');",
      '  clearInterval(timer);',
      '  process.exit(0);',
      '}, 10);',
    ].join('\n');
    delayedDaemon = spawn(process.execPath, ['-e', delayedDaemonProgram], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    assert.notEqual(delayedDaemon.pid, undefined);
    const delayedDaemonStart = await readProcessStart(delayedDaemon.pid as number);
    assert.notEqual(delayedDaemonStart, null);
    delayedDaemonIdentity = { pid: delayedDaemon.pid as number, start: delayedDaemonStart };

    delayedClient = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    assert.notEqual(delayedClient.pid, undefined);
    const delayedClientStart = await readProcessStart(delayedClient.pid as number);
    const observedPgid = await readProcessGroupId(delayedClient.pid as number);
    if (delayedClientStart === null || observedPgid === null) {
      throw new Error('The controlled delayed-create client did not expose a trusted identity.');
    }
    assert.equal(observedPgid, delayedClient.pid);
    delayedClientIdentity = { pid: delayedClient.pid as number, start: delayedClientStart };

    await waitForCondition(
      async () => {
        const contents = await readFile(daemonReadyPath, 'utf8').catch(() => '');
        return contents.trim() !== '';
      },
      5_000,
      'The controlled delayed daemon did not report readiness before the client death.',
    );
    const daemonReady = JSON.parse(await readFile(daemonReadyPath, 'utf8')) as { pid: number };
    assert.equal(daemonReady.pid, delayedDaemonIdentity.pid);
    assert.equal(await readProcessStart(daemonReady.pid), delayedDaemonIdentity.start);

    const journalIntent = {
      containerName: `qdroid-t004-${sessionId}`,
      creationAuthorization: 'possibly-submitted' as const,
      guardian: delayedClientIdentity,
      guardianPgid: observedPgid,
      hostBootId: bootId,
      imageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      labels: {
        'io.qdroid.owner': ownerId,
        'io.qdroid.profile': profileDigest,
        'io.qdroid.session': sessionId,
      },
      ownerId,
      parent: { pid: -1, start: null },
      profileDigest,
      profileId: 'tool-offline',
      sessionId,
      version: 3 as const,
    };
    const authenticationTag = createHmac('sha256', key)
      .update(JSON.stringify(journalPayload(journalIntent)))
      .digest('hex');
    const journalFile = join(ownerStorePath, `${sessionId}.json`);
    await writeFile(journalFile, `${JSON.stringify({ ...journalIntent, authenticationTag })}\n`, {
      mode: 0o600,
    });
    await chmod(journalFile, 0o600);

    await killExactProcess(delayedClientIdentity);
    await waitForProcessExit(delayedClientIdentity);
    const recovery = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    assert.deepEqual(await recovery.recoverAbandoned(), {
      recoveredRecords: 0,
      unresolvedRecordCount: 1,
      unresolvedRecords: [{ record: `${sessionId}.json`, status: 'creation-unknown' }],
      unresolvedRecordsTruncated: false,
    });
    await assert.doesNotReject(readFile(journalFile, 'utf8'));

    await writeFile(releasePath, 'release\n', { mode: 0o600 });
    await waitForCondition(
      async () => (await readFile(effectPath, 'utf8').catch(() => '')) === 'late-daemon-create',
      5_000,
      'The delayed daemon-side create effect did not occur after the client death.',
    );
    await waitForProcessExit(delayedDaemonIdentity);

    completed = true;
  } finally {
    await terminateTaskOwnedChild(delayedDaemon);
    await terminateTaskOwnedChild(delayedClient);
    if (!completed) {
      process.stderr.write(`T004 delayed-create fixture preserved for inspection: ${directory}\n`);
    } else {
      await rm(directory, { force: true, recursive: true });
    }
  }
});

test('an unresponsive durable recovery writer retains its record until a later exact recovery', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-recovery-writer-stall-'));
  const bootstrap = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
  let originalGuardian: ChildProcess | undefined;
  let originalGuardianPgid: number | undefined;
  let recoveryWriter: ProcessIdentity | undefined;
  let recoveryWriterPgid: number | undefined;
  let completed = false;

  try {
    await bootstrap.recoverAbandoned();
    const key = await readFile(join(ownerStorePath, journalKeyName));
    const hostBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const sessionId = randomUUID();
    const ownerId = randomUUID();
    const profileDigest = 'c'.repeat(64);
    const containerName = `qdroid-t004-${sessionId}`;

    originalGuardian = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    assert.notEqual(originalGuardian.pid, undefined);
    const guardianStart = await readProcessStart(originalGuardian.pid as number);
    const guardianPgid = await readProcessGroupId(originalGuardian.pid as number);
    if (guardianStart === null || guardianPgid === null) {
      throw new Error('The recovery-writer fixture guardian did not expose a trusted identity.');
    }
    assert.equal(guardianPgid, originalGuardian.pid);
    const guardian = { pid: originalGuardian.pid as number, start: guardianStart };
    originalGuardianPgid = guardianPgid;

    const journalIntent = {
      containerName,
      creationAuthorization: 'possibly-submitted' as const,
      guardian,
      guardianPgid,
      hostBootId,
      imageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      labels: {
        'io.qdroid.owner': ownerId,
        'io.qdroid.profile': profileDigest,
        'io.qdroid.session': sessionId,
      },
      ownerId,
      parent: { pid: -1, start: null },
      profileDigest,
      profileId: 'tool-offline',
      sessionId,
      version: 3 as const,
    };
    const authenticationTag = createHmac('sha256', key)
      .update(JSON.stringify(journalPayload(journalIntent)))
      .digest('hex');
    const journalFile = join(ownerStorePath, `${sessionId}.json`);
    await writeFile(journalFile, `${JSON.stringify({ ...journalIntent, authenticationTag })}\n`, {
      mode: 0o600,
    });
    await chmod(journalFile, 0o600);

    const receiptPayload = {
      containerName,
      guardian,
      hostBootId,
      sessionId,
      version: 1,
    };
    await writeFile(
      creationReceiptPath(ownerStorePath, sessionId),
      `${JSON.stringify({
        ...receiptPayload,
        authenticationTag: createHmac('sha256', key)
          .update(JSON.stringify(receiptPayload))
          .digest('hex'),
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(creationReceiptPath(ownerStorePath, sessionId), 0o600);

    await killExactProcess(guardian);
    await waitForProcessGroupExit(guardianPgid);

    const stalledRecovery = new OciSandboxBackend({
      image: requiredImage(),
      ownerStorePath,
      trustedTestHooks: {
        guardianWorkerPath: () => stalledCleanupGuardianPath,
      },
    });
    const recoveryStartedAt = performance.now();
    const stalledReport = await stalledRecovery.recoverAbandoned();
    const recoveryElapsedMilliseconds = performance.now() - recoveryStartedAt;
    assert.deepEqual(stalledReport, {
      recoveredRecords: 0,
      unresolvedRecordCount: 1,
      unresolvedRecords: [{ record: `${sessionId}.json`, status: 'recovery-writer-group-live' }],
      unresolvedRecordsTruncated: false,
    });
    // One recovery writer lifecycle has one cleanup deadline. This generous
    // ceiling distinguishes it from two consecutive ten-second waits while
    // retaining room for a loaded dedicated VM.
    assert.ok(recoveryElapsedMilliseconds < 15_000);

    const stalledJournal = await readJournal(journalFile);
    assert.notEqual(stalledJournal.recoveryWriter, undefined);
    assert.notEqual(stalledJournal.recoveryWriterPgid, undefined);
    recoveryWriter = stalledJournal.recoveryWriter;
    recoveryWriterPgid = stalledJournal.recoveryWriterPgid;
    await assert.doesNotReject(readFile(journalFile, 'utf8'));

    await killExactProcess(recoveryWriter as ProcessIdentity);
    await waitForProcessGroupExit(recoveryWriterPgid as number);

    const recovered = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    assert.deepEqual(await recovered.recoverAbandoned(), {
      recoveredRecords: 1,
      unresolvedRecordCount: 0,
      unresolvedRecords: [],
      unresolvedRecordsTruncated: false,
    });
    await assert.rejects(readFile(journalFile, 'utf8'), /ENOENT/);
    completed = true;
  } finally {
    if (recoveryWriter !== undefined && recoveryWriterPgid !== undefined) {
      await terminateProcessGroupIfExactMember(recoveryWriter, recoveryWriterPgid);
    }
    if (originalGuardian !== undefined && originalGuardianPgid !== undefined) {
      const originalStart =
        originalGuardian.pid === undefined ? null : await readProcessStart(originalGuardian.pid);
      if (originalStart !== null) {
        await terminateProcessGroupIfExactMember(
          { pid: originalGuardian.pid as number, start: originalStart },
          originalGuardianPgid,
        );
      }
    }
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('a late recovery-writer registration retains the SQLite lease until its rename settles', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-late-writer-registration-'));
  const barrierDirectory = await mkdtemp(
    join(tmpdir(), 'qdroid-t004-late-writer-registration-barrier-'),
  );
  const releasePath = join(barrierDirectory, 'release');
  let worker: ChildProcessWithoutNullStreams | undefined;
  let recoveryWriter: ProcessIdentity | undefined;
  let recoveryWriterPgid: number | undefined;
  let completed = false;

  try {
    const bootstrap = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    await bootstrap.recoverAbandoned();
    const { journal, journalFile } = await writeReceiptBackedDeadJournal(ownerStorePath);

    worker = startDelayedRecoveryMutationWorker(
      requiredImage(),
      ownerStorePath,
      'writer-registration',
      releasePath,
    );
    await waitForWorkerStdoutLine(worker, 'mutation-started');
    await waitForWorkerStdoutLine(worker, 'recovery-returned');

    const secondOwner = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    await assert.rejects(
      secondOwner.recoverAbandoned(),
      /Another sandbox recovery owner is already active/,
    );

    await writeFile(releasePath, 'release\n', { mode: 0o600 });
    await waitForWorkerStdoutLine(worker, 'mutation-settled');
    assert.equal(await waitForChildExit(worker, 15_000), true);

    const registeredJournal = await readJournal(journalFile);
    recoveryWriter = registeredJournal.recoveryWriter;
    recoveryWriterPgid = registeredJournal.recoveryWriterPgid;
    assert.notEqual(recoveryWriter, undefined);
    assert.notEqual(recoveryWriterPgid, undefined);
    await waitForProcessExit(recoveryWriter as ProcessIdentity);
    await waitForProcessGroupExit(recoveryWriterPgid as number);

    const settledRecovery = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    assert.deepEqual(await settledRecovery.recoverAbandoned(), {
      recoveredRecords: 1,
      unresolvedRecordCount: 0,
      unresolvedRecords: [],
      unresolvedRecordsTruncated: false,
    });
    await assert.rejects(readFile(journalFile, 'utf8'), /ENOENT/);
    await assert.rejects(
      readFile(creationReceiptPath(ownerStorePath, journal.sessionId), 'utf8'),
      /ENOENT/,
    );
    completed = true;
  } finally {
    await terminateTaskOwnedChild(worker);
    await rm(barrierDirectory, { force: true, recursive: true });
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('an explicit recovery resumes a journal directory sync that failed after unlink', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-retirement-directory-sync-'));
  const dockerDirectory = await mkdtemp(
    join(tmpdir(), 'qdroid-t004-retirement-directory-sync-docker-'),
  );
  const dockerPath = join(dockerDirectory, 'docker');
  const dockerLogPath = join(dockerDirectory, 'docker.log');
  const originalPath = process.env.PATH;
  let failAfterUnlink = true;
  let completed = false;

  try {
    const bootstrap = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    await bootstrap.recoverAbandoned();
    const { journal, journalFile } = await writeReceiptBackedDeadJournal(ownerStorePath);
    await writeFile(
      dockerPath,
      `#!/bin/sh
printf '%s\\n' "$1" >> "$QDROID_TEST_LOG"
if [ "$1" = inspect ]; then
  printf '%s\\n' "Error: No such object: $4" >&2
fi
exit 1
`,
      { mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    process.env.PATH = `${dockerDirectory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_LOG = dockerLogPath;

    const backend = new OciSandboxBackend({
      image: requiredImage(),
      ownerStorePath,
      trustedTestHooks: {
        afterExecutionJournalUnlinkBeforeDirectorySync: async () => {
          if (!failAfterUnlink) {
            return;
          }
          failAfterUnlink = false;
          throw new Error('trusted directory sync failure after journal unlink');
        },
      },
    });

    assert.deepEqual(await backend.recoverAbandoned(), {
      recoveredRecords: 0,
      unresolvedRecordCount: 1,
      unresolvedRecords: [{ record: `${journal.sessionId}.json`, status: 'docker-unknown' }],
      unresolvedRecordsTruncated: false,
    });
    await assert.rejects(readFile(journalFile, 'utf8'), /ENOENT/);
    await assert.doesNotReject(
      readFile(creationReceiptPath(ownerStorePath, journal.sessionId), 'utf8'),
    );

    assert.deepEqual(await backend.recoverAbandoned(), {
      recoveredRecords: 1,
      unresolvedRecordCount: 0,
      unresolvedRecords: [],
      unresolvedRecordsTruncated: false,
    });
    await assert.rejects(
      readFile(creationReceiptPath(ownerStorePath, journal.sessionId), 'utf8'),
      /ENOENT/,
    );
    assert.deepEqual((await readFile(dockerLogPath, 'utf8')).trim().split('\n'), ['inspect']);
    completed = true;
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    delete process.env.QDROID_TEST_LOG;
    await rm(dockerDirectory, { force: true, recursive: true });
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('an explicit recovery resumes a receipt directory sync that failed after unlink', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-receipt-directory-sync-'));
  const dockerDirectory = await mkdtemp(
    join(tmpdir(), 'qdroid-t004-receipt-directory-sync-docker-'),
  );
  const dockerPath = join(dockerDirectory, 'docker');
  const dockerLogPath = join(dockerDirectory, 'docker.log');
  const originalPath = process.env.PATH;
  let failAfterReceiptUnlink = true;
  let completed = false;

  try {
    const bootstrap = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    await bootstrap.recoverAbandoned();
    const { journal, journalFile } = await writeReceiptBackedDeadJournal(ownerStorePath);
    await writeFile(
      dockerPath,
      `#!/bin/sh
printf '%s\\n' "$1" >> "$QDROID_TEST_LOG"
if [ "$1" = inspect ]; then
  printf '%s\\n' "Error: No such object: $4" >&2
fi
exit 1
`,
      { mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    process.env.PATH = `${dockerDirectory}:${originalPath ?? ''}`;
    process.env.QDROID_TEST_LOG = dockerLogPath;

    const backend = new OciSandboxBackend({
      image: requiredImage(),
      ownerStorePath,
      trustedTestHooks: {
        afterExecutionReceiptUnlinkBeforeDirectorySync: async () => {
          if (!failAfterReceiptUnlink) {
            return;
          }
          failAfterReceiptUnlink = false;
          throw new Error('trusted directory sync failure after receipt unlink');
        },
      },
    });

    assert.deepEqual(await backend.recoverAbandoned(), {
      recoveredRecords: 0,
      unresolvedRecordCount: 1,
      unresolvedRecords: [{ record: `${journal.sessionId}.json`, status: 'docker-unknown' }],
      unresolvedRecordsTruncated: false,
    });
    await assert.rejects(readFile(journalFile, 'utf8'), /ENOENT/);
    await assert.rejects(
      readFile(creationReceiptPath(ownerStorePath, journal.sessionId), 'utf8'),
      /ENOENT/,
    );

    assert.deepEqual(await backend.recoverAbandoned(), {
      recoveredRecords: 1,
      unresolvedRecordCount: 0,
      unresolvedRecords: [],
      unresolvedRecordsTruncated: false,
    });
    assert.deepEqual((await readFile(dockerLogPath, 'utf8')).trim().split('\n'), ['inspect']);
    completed = true;
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    delete process.env.QDROID_TEST_LOG;
    await rm(dockerDirectory, { force: true, recursive: true });
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('a late journal unlink keeps the lease exclusive until its directory sync settles', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-late-journal-unlink-'));
  const barrierDirectory = await mkdtemp(
    join(tmpdir(), 'qdroid-t004-late-journal-unlink-barrier-'),
  );
  const dockerDirectory = await mkdtemp(join(tmpdir(), 'qdroid-t004-late-journal-unlink-docker-'));
  const dockerPath = join(dockerDirectory, 'docker');
  const dockerLogPath = join(dockerDirectory, 'docker.log');
  const releasePath = join(barrierDirectory, 'release');
  const convergencePath = join(barrierDirectory, 'converge');
  const originalPath = process.env.PATH;
  let worker: ChildProcessWithoutNullStreams | undefined;
  let completed = false;

  try {
    const bootstrap = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    await bootstrap.recoverAbandoned();
    const { journal, journalFile } = await writeReceiptBackedDeadJournal(ownerStorePath);
    await writeFile(
      dockerPath,
      `#!/bin/sh
printf '%s\\n' "$1" >> "$QDROID_TEST_LOG"
if [ "$1" = inspect ]; then
  printf '%s\\n' "Error: No such object: $4" >&2
fi
exit 1
`,
      { mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    const environment = {
      ...process.env,
      PATH: `${dockerDirectory}:${originalPath ?? ''}`,
      QDROID_TEST_LOG: dockerLogPath,
    };

    worker = startDelayedRecoveryMutationWorker(
      requiredImage(),
      ownerStorePath,
      'retire-journal',
      releasePath,
      environment,
      convergencePath,
    );
    await waitForWorkerStdoutLine(worker, 'mutation-started');
    await assert.rejects(readFile(journalFile, 'utf8'), /ENOENT/);
    await assert.doesNotReject(
      readFile(creationReceiptPath(ownerStorePath, journal.sessionId), 'utf8'),
    );
    await waitForWorkerStdoutLine(worker, 'recovery-returned');

    const secondOwner = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    await assert.rejects(
      secondOwner.recoverAbandoned(),
      /Another sandbox recovery owner is already active/,
    );
    assert.deepEqual((await readFile(dockerLogPath, 'utf8')).trim().split('\n'), ['inspect']);

    await writeFile(releasePath, 'release\n', { mode: 0o600 });
    await waitForWorkerStdoutLine(worker, 'mutation-settled');

    const settledRecovery = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    assert.deepEqual(await settledRecovery.recoverAbandoned(), {
      // The original owner still holds the cleanup proof needed to retire the
      // receipt. A fresh backend must leave that orphaned proof untouched.
      recoveredRecords: 0,
      unresolvedRecordCount: 0,
      unresolvedRecords: [],
      unresolvedRecordsTruncated: false,
    });
    await assert.rejects(readFile(journalFile, 'utf8'), /ENOENT/);
    await assert.doesNotReject(
      readFile(creationReceiptPath(ownerStorePath, journal.sessionId), 'utf8'),
    );
    assert.deepEqual((await readFile(dockerLogPath, 'utf8')).trim().split('\n'), ['inspect']);

    const convergence = waitForWorkerStdoutLine(
      worker,
      'late-retirement-convergence:{"recoveredRecords":1,"unresolvedRecordCount":0,"unresolvedRecords":[],"unresolvedRecordsTruncated":false}',
    );
    await writeFile(convergencePath, 'converge\n', { mode: 0o600 });
    await convergence;
    assert.equal(await waitForChildExit(worker, 15_000), true);
    await assert.rejects(
      readFile(creationReceiptPath(ownerStorePath, journal.sessionId), 'utf8'),
      /ENOENT/,
    );
    completed = true;
  } finally {
    await terminateTaskOwnedChild(worker);
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    delete process.env.QDROID_TEST_LOG;
    await rm(dockerDirectory, { force: true, recursive: true });
    await rm(barrierDirectory, { force: true, recursive: true });
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('fresh recovery removes a manager-owned network fixture while a separate manager peer stays live', async () => {
  const fixtureOwnerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-network-manager-crash-'));
  const peerOwnerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-network-manager-peer-'));
  let fixtureWorker: NetworkFixtureCrashWorker | undefined;
  let peer: HeartbeatPeerWorker | undefined;
  let fixtureCompleted = false;
  let peerCompleted = false;

  try {
    peer = await startHeartbeatPeer(requiredImage(), peerOwnerStorePath);
    await peer.heartbeat('network-manager-before-fixture-crash');

    fixtureWorker = await startNetworkFixtureCrashWorker(requiredImage(), fixtureOwnerStorePath);
    const journal = await waitForNetworkFixtureJournal(
      fixtureOwnerStorePath,
      fixtureWorker.networkFixtureBarrier.sessionId,
    );
    assertNetworkFixtureBarrierMatchesJournal(fixtureWorker.networkFixtureBarrier, journal);
    assert.notEqual(
      journal.parent.pid,
      peer.worker.pid,
      'The held peer must belong to a separate surviving manager process.',
    );
    await peer.heartbeat('network-manager-before-manager-sigkill');

    await killWorker(fixtureWorker, journal.parent);
    await waitForProcessExit(journal.controller);
    await waitForProcessGroupExit(journal.controllerPgid);
    await waitForNetworkFixtureAbsence(journal.interfaceName);

    const recovery = new OciSandboxBackend({
      image: requiredImage(),
      ownerStorePath: fixtureOwnerStorePath,
    });
    const report = await recovery.recoverAbandoned();
    assert.deepEqual(report, {
      recoveredRecords: 1,
      unresolvedRecordCount: 0,
      unresolvedRecords: [],
      unresolvedRecordsTruncated: false,
    });
    await assert.rejects(
      readFile(networkFixtureJournalPath(fixtureOwnerStorePath, journal), 'utf8'),
      /ENOENT/,
    );

    await peer.heartbeat('network-manager-after-fresh-recovery');
    const peerStop = await peer.stop();
    assert.deepEqual(peerStop.cleanup, { cleanupConfirmed: true, status: 'confirmed' });
    assert.equal(peerStop.completion.cleanupConfirmed, true);
    assert.equal(peerStop.completion.reason, 'stopped');
    peerCompleted = true;
    fixtureCompleted = true;
  } finally {
    await stopHeartbeatPeerOrTerminate(peer);
    await terminateTaskOwnedChild(fixtureWorker);
    await finalizeOwnerStore(peerOwnerStorePath, peerCompleted);
    await finalizeOwnerStore(fixtureOwnerStorePath, fixtureCompleted);
  }
});

test('fresh recovery removes an exact network fixture after controller and manager SIGKILL while a peer stays live', async () => {
  const fixtureOwnerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-network-both-crash-'));
  const peerOwnerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-network-both-peer-'));
  let fixtureWorker: NetworkFixtureCrashWorker | undefined;
  let peer: HeartbeatPeerWorker | undefined;
  let fixtureCompleted = false;
  let peerCompleted = false;

  try {
    peer = await startHeartbeatPeer(requiredImage(), peerOwnerStorePath);
    await peer.heartbeat('network-both-before-fixture-crash');

    fixtureWorker = await startNetworkFixtureCrashWorker(requiredImage(), fixtureOwnerStorePath);
    const journal = await waitForNetworkFixtureJournal(
      fixtureOwnerStorePath,
      fixtureWorker.networkFixtureBarrier.sessionId,
    );
    assertNetworkFixtureBarrierMatchesJournal(fixtureWorker.networkFixtureBarrier, journal);
    assert.notEqual(
      journal.parent.pid,
      peer.worker.pid,
      'The held peer must belong to a separate surviving manager process.',
    );
    await peer.heartbeat('network-both-before-controller-sigkill');

    await killExactProcess(journal.controller);
    await waitForProcessGroupExit(journal.controllerPgid);
    await assertNetworkFixturePresent(journal);
    await killWorker(fixtureWorker, journal.parent);

    const recovery = new OciSandboxBackend({
      image: requiredImage(),
      ownerStorePath: fixtureOwnerStorePath,
    });
    const report = await recovery.recoverAbandoned();
    assert.deepEqual(report, {
      recoveredRecords: 1,
      unresolvedRecordCount: 0,
      unresolvedRecords: [],
      unresolvedRecordsTruncated: false,
    });
    await waitForNetworkFixtureAbsence(journal.interfaceName);
    await assert.rejects(
      readFile(networkFixtureJournalPath(fixtureOwnerStorePath, journal), 'utf8'),
      /ENOENT/,
    );

    await peer.heartbeat('network-both-after-fresh-recovery');
    const peerStop = await peer.stop();
    assert.deepEqual(peerStop.cleanup, { cleanupConfirmed: true, status: 'confirmed' });
    assert.equal(peerStop.completion.cleanupConfirmed, true);
    assert.equal(peerStop.completion.reason, 'stopped');
    peerCompleted = true;
    fixtureCompleted = true;
  } finally {
    await stopHeartbeatPeerOrTerminate(peer);
    await terminateTaskOwnedChild(fixtureWorker);
    await finalizeOwnerStore(peerOwnerStorePath, peerCompleted);
    await finalizeOwnerStore(fixtureOwnerStorePath, fixtureCompleted);
  }
});

test('a late network recovery record write retains the SQLite lease until its raw mutation settles', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-network-recovery-lease-'));
  const releasePath = join(ownerStorePath, 'release-network-registration');
  let fixtureWorker: NetworkFixtureCrashWorker | undefined;
  let firstRecovery: ChildProcessWithoutNullStreams | undefined;
  let completed = false;

  try {
    fixtureWorker = await startNetworkFixtureCrashWorker(requiredImage(), ownerStorePath);
    const journal = await waitForNetworkFixtureJournal(
      ownerStorePath,
      fixtureWorker.networkFixtureBarrier.sessionId,
    );
    await killWorker(fixtureWorker, journal.parent);
    await waitForProcessExit(journal.controller);
    await waitForProcessGroupExit(journal.controllerPgid);

    firstRecovery = startRecoveryLockWorker(
      requiredImage(),
      ownerStorePath,
      process.env,
      'after-network-writer-registration',
      releasePath,
    );
    await waitForWorkerStdoutLine(firstRecovery, `network-writer-registered:${journal.sessionId}`);

    const competingBeforeTimeout = startRecoveryLockWorker(
      requiredImage(),
      ownerStorePath,
      process.env,
    );
    const competingBeforeTimeoutResult = await waitForWorkerExit(competingBeforeTimeout, 5_000);
    assert.notEqual(competingBeforeTimeoutResult.exitCode, 0);
    assert.match(
      competingBeforeTimeoutResult.stderr,
      /Another sandbox recovery owner is already active/,
    );

    await waitForWorkerStdoutLine(firstRecovery, 'recovery-complete');
    const competingAfterBoundedResult = await waitForWorkerExit(
      startRecoveryLockWorker(requiredImage(), ownerStorePath, process.env),
      5_000,
    );
    assert.notEqual(competingAfterBoundedResult.exitCode, 0);
    assert.match(
      competingAfterBoundedResult.stderr,
      /Another sandbox recovery owner is already active/,
    );

    await writeFile(releasePath, 'release\n', { mode: 0o600 });
    const firstRecoveryResult = await waitForWorkerExit(firstRecovery, 15_000);
    assert.equal(firstRecoveryResult.exitCode, 0, firstRecoveryResult.stderr);

    const settledRecovery = await waitForWorkerExit(
      startRecoveryLockWorker(requiredImage(), ownerStorePath, process.env),
      15_000,
    );
    assert.equal(settledRecovery.exitCode, 0, settledRecovery.stderr);
    await assert.rejects(
      readFile(networkFixtureJournalPath(ownerStorePath, journal), 'utf8'),
      /ENOENT/,
    );
    completed = true;
  } finally {
    await terminateTaskOwnedChild(firstRecovery);
    await terminateTaskOwnedChild(fixtureWorker);
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('stop fences executions during qualification and durable-intent startup windows', async () => {
  for (const [mode, phase] of [
    ['stop-before-qualification', 'before-qualification'],
    ['stop-before-intent-persistence', 'before-intent-persistence'],
  ] as const) {
    const ownerStorePath = await mkdtemp(join(tmpdir(), `qdroid-t004-${mode}-`));
    let worker: StopFenceWorker | undefined;
    let completed = false;

    try {
      worker = await startStopFenceWorker(requiredImage(), ownerStorePath, mode, phase);
      const result = await worker.stop();
      assert.deepEqual(result.cleanup, { cleanupConfirmed: true, status: 'confirmed' });
      assert.equal(result.executeRejected, true);
      assert.deepEqual(
        (await readdir(ownerStorePath)).filter(isExecutionJournalName),
        [],
        'A stopped startup must not leave an executable cleanup journal behind.',
      );
      completed = true;
    } finally {
      await terminateTaskOwnedChild(worker?.worker);
      await finalizeOwnerStore(ownerStorePath, completed);
    }
  }
});

test('a closed guardian IPC does not confirm a pre-intent cleanup before its process group exits', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-closed-guardian-stop-'));
  const releasePath = join(ownerStorePath, 'release-closed-guardian');
  let worker: StopFenceWorker | undefined;
  let completed = false;

  try {
    worker = await startStopFenceWorker(
      requiredImage(),
      ownerStorePath,
      'stop-before-intent-closed-guardian',
      'before-intent-persistence',
      releasePath,
    );
    const firstStop = await worker.stop();
    assert.deepEqual(firstStop.cleanup, { cleanupConfirmed: false, status: 'unknown' });
    assert.equal(firstStop.executeRejected, true);

    await writeFile(releasePath, 'release\n', { mode: 0o600 });
    assert.deepEqual(await worker.retry(), { cleanupConfirmed: true, status: 'confirmed' });
    assert.equal(await waitForChildExit(worker.worker, 15_000), true);
    assert.deepEqual(
      (await readdir(ownerStorePath)).filter(isExecutionJournalName),
      [],
      'A no-intent retry must release only after the recorded guardian group exits.',
    );
    completed = true;
  } finally {
    await writeFile(releasePath, 'release\n', { mode: 0o600 }).catch(() => undefined);
    await terminateTaskOwnedChild(worker?.worker);
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('stop cannot let a delayed create-authorization rename revive an execution journal', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-stop-before-auth-rename-'));
  let worker: StopFenceWorker | undefined;
  let completed = false;

  try {
    worker = await startStopFenceWorker(
      requiredImage(),
      ownerStorePath,
      'stop-before-authorization-rename',
      'before-authorization-rename',
    );
    const stopped = await worker.stop();
    assert.deepEqual(stopped.cleanup, { cleanupConfirmed: false, status: 'unknown' });
    assert.equal(stopped.executeRejected, true);
    assert.equal(await waitForChildExit(worker.worker, 15_000), true);

    const journal = await waitForJournal(ownerStorePath);
    assert.equal(journal.version, 3);
    assert.equal(journal.creationAuthorization, 'possibly-submitted');
    await assert.doesNotReject(readFile(journalPath(ownerStorePath, journal), 'utf8'));

    const recovery = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    assert.deepEqual(await recovery.recoverAbandoned(), {
      recoveredRecords: 0,
      unresolvedRecordCount: 1,
      unresolvedRecords: [{ record: `${journal.sessionId}.json`, status: 'creation-unknown' }],
      unresolvedRecordsTruncated: false,
    });
    await assert.doesNotReject(readFile(journalPath(ownerStorePath, journal), 'utf8'));
    completed = true;
  } finally {
    await terminateTaskOwnedChild(worker?.worker);
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('a real create without a durable receipt remains unresolved while an independent peer stays live', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-receipt-write-failure-'));
  const peerOwnerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-receipt-write-peer-'));
  let worker: CrashWorker | undefined;
  let peer: HeartbeatPeerWorker | undefined;
  let targetCompleted = false;
  let peerCompleted = false;

  try {
    peer = await startHeartbeatPeer(requiredImage(), peerOwnerStorePath);
    await peer.heartbeat('receipt-write-before-target');

    worker = await startCrashWorker(
      requiredImage(),
      ownerStorePath,
      'create-receipt-write-failure',
    );
    assert.equal(await waitForChildExit(worker, 15_000), true);
    const journal = await waitForJournal(ownerStorePath);
    assert.equal(journal.version, 3);
    assert.equal(journal.creationAuthorization, 'possibly-submitted');
    await assert.doesNotReject(readFile(journalPath(ownerStorePath, journal), 'utf8'));
    await assert.rejects(readFile(creationReceiptPath(ownerStorePath, journal.sessionId), 'utf8'));
    await waitForContainerPresence(journal.containerName);

    const recovery = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    assert.deepEqual(await recovery.recoverAbandoned(), {
      recoveredRecords: 0,
      unresolvedRecordCount: 1,
      unresolvedRecords: [{ record: `${journal.sessionId}.json`, status: 'creation-unknown' }],
      unresolvedRecordsTruncated: false,
    });
    await peer.heartbeat('receipt-write-after-target-recovery');

    const removal = await docker(['rm', '--force', journal.containerName]);
    assert.equal(
      removal.exitCode,
      0,
      'The test cleanup must remove only its exact owned container.',
    );
    await waitForContainerAbsence(journal.containerName);
    targetCompleted = true;

    const peerStop = await peer.stop();
    assert.deepEqual(peerStop.cleanup, { cleanupConfirmed: true, status: 'confirmed' });
    assert.equal(peerStop.completion.cleanupConfirmed, true);
    peerCompleted = true;
  } finally {
    await stopHeartbeatPeerOrTerminate(peer);
    await terminateTaskOwnedChild(worker);
    await finalizeOwnerStore(peerOwnerStorePath, peerCompleted);
    await finalizeOwnerStore(ownerStorePath, targetCompleted);
  }
});

test('intent-write failures retire only the target while the same trusted manager keeps its peer live', async () => {
  for (const mode of [
    'intent-before-write-failure-peer',
    'intent-after-write-failure-peer',
  ] as const) {
    const ownerStorePath = await mkdtemp(join(tmpdir(), `qdroid-t004-${mode}-`));
    let peer: HeartbeatPeerWorker | undefined;
    let completed = false;

    try {
      peer = await startHeartbeatPeer(requiredImage(), ownerStorePath, mode);
      assert.equal(peer.intentRejected, true);
      await peer.heartbeat('before-intent-failure-peer-stop');
      await peer.heartbeat('after-intent-failure-peer-stop');

      const journals = await waitForJournals(ownerStorePath, 1);
      assert.equal(
        journals.length,
        1,
        'Only the held peer may retain an active cleanup journal after the target failure.',
      );

      const stopped = await peer.stop();
      assert.deepEqual(stopped.cleanup, { cleanupConfirmed: true, status: 'confirmed' });
      assert.equal(stopped.completion.cleanupConfirmed, true);
      assert.equal(stopped.completion.reason, 'stopped');
      assert.deepEqual((await readdir(ownerStorePath)).filter(isExecutionJournalName), []);
      completed = true;
    } finally {
      await stopHeartbeatPeerOrTerminate(peer);
      await finalizeOwnerStore(ownerStorePath, completed);
    }
  }
});

test('ordinary heartbeat peer reports readiness and serves a heartbeat before explicit cleanup', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-heartbeat-peer-'));
  let peer: HeartbeatPeerWorker | undefined;
  let completed = false;

  try {
    peer = await startHeartbeatPeer(requiredImage(), ownerStorePath);
    await peer.heartbeat('ordinary-peer-ready-and-live');

    const stopped = await peer.stop();
    assert.deepEqual(stopped.cleanup, { cleanupConfirmed: true, status: 'confirmed' });
    assert.equal(stopped.completion.cleanupConfirmed, true);
    assert.equal(stopped.completion.reason, 'stopped');
    assert.deepEqual((await readdir(ownerStorePath)).filter(isExecutionJournalName), []);
    completed = true;
  } finally {
    await stopHeartbeatPeerOrTerminate(peer);
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('fresh recovery removes a receipt-backed target before its container ID persists while a separate manager peer stays live', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-intent-gap-'));
  let worker: CrashWorker | undefined;
  let heartbeatPeer: HeartbeatPeerWorker | undefined;
  let completed = false;

  try {
    worker = await startCrashWorker(requiredImage(), ownerStorePath, 'created-before-id');
    const barrier = worker.t004Ready.barrier;
    assert.notEqual(barrier, undefined, 'The fixture did not reach the create-before-ID barrier.');
    heartbeatPeer = await startHeartbeatPeer(requiredImage(), ownerStorePath);

    const journals = await waitForJournals(ownerStorePath, 2);
    const targetJournal = journals.find((journal) => journal.sessionId === barrier?.sessionId);
    const peerJournal = journals.find((journal) => journal.sessionId !== barrier?.sessionId);
    assert.notEqual(
      targetJournal,
      undefined,
      'The barrier did not identify an owned target journal.',
    );
    assert.notEqual(peerJournal, undefined, 'The fixture did not create the held live peer.');

    const target = targetJournal as CleanupJournal;
    const peer = peerJournal as CleanupJournal;
    assert.notEqual(
      target.parent.pid,
      peer.parent.pid,
      'The held peer must have its own still-live manager process.',
    );
    assert.equal(
      target.containerId,
      undefined,
      'The target must not persist its container ID before the crash barrier.',
    );
    assert.equal(target.version, 3);
    assert.equal(target.creationAuthorization, 'possibly-submitted');
    await assert.doesNotReject(
      readFile(creationReceiptPath(ownerStorePath, target.sessionId), 'utf8'),
      'The target must persist its create-success receipt before the container-ID barrier.',
    );
    assert.match(
      barrier?.containerId ?? '',
      /^[a-f0-9]{64}$/i,
      'The barrier must run after Docker created the exact target container.',
    );
    await heartbeatPeer.heartbeat('before-manager-crash');

    killProcess(target.guardian.pid);
    await killWorker(worker, target.parent);
    await waitForProcessExit(target.guardian);

    const recovery = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    const report = await recovery.recoverAbandoned();
    assert.equal(report.recoveredRecords, 1);
    assert.equal(report.unresolvedRecordCount, 1);
    assert.equal(report.unresolvedRecordsTruncated, false);
    assert.deepEqual(report.unresolvedRecords, [
      { record: `${peer.sessionId}.json`, status: 'guardian-live' },
    ]);
    await waitForContainerAbsence(target.containerName);
    await waitForContainerPresence(peer.containerName);
    await heartbeatPeer.heartbeat('after-manager-recovery');
    const peerStop = await heartbeatPeer.stop();
    assert.deepEqual(peerStop.cleanup, { cleanupConfirmed: true, status: 'confirmed' });
    assert.equal(peerStop.completion.cleanupConfirmed, true);
    assert.equal(peerStop.completion.reason, 'stopped');
    await waitForContainerAbsence(peer.containerName);
    completed = true;
  } finally {
    await stopHeartbeatPeerOrTerminate(heartbeatPeer);
    await terminateTaskOwnedChild(worker);
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

test('fresh recovery serializes exact orphan cleanup and preserves future or forged records', async () => {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-recovery-crash-'));
  let worker: CrashWorker | undefined;
  let completed = false;

  try {
    worker = await startCrashWorker(requiredImage(), ownerStorePath, 'created-before-id');
    const barrier = worker.t004Ready.barrier;
    if (barrier === undefined) {
      throw new Error('The orphan-recovery fixture did not reach the create-before-ID barrier.');
    }

    const journal = await waitForJournal(ownerStorePath);
    const journalFile = journalPath(ownerStorePath, journal);
    assert.equal(
      barrier.sessionId,
      journal.sessionId,
      'The create-before-ID barrier must identify the exact journal session.',
    );
    assert.match(
      barrier.containerId,
      /^[a-f0-9]{64}$/i,
      'The create-before-ID barrier must expose the real Docker container ID.',
    );
    assert.equal(
      journal.containerId,
      undefined,
      'The real create-before-ID fixture must not persist a container ID before the crash.',
    );
    assert.equal(journal.version, 3);
    assert.equal(journal.creationAuthorization, 'possibly-submitted');
    await assert.doesNotReject(
      readFile(creationReceiptPath(ownerStorePath, journal.sessionId), 'utf8'),
      'The real target must retain its durable create receipt before the crash.',
    );

    await killExactProcess(journal.guardian);
    assert.equal(
      worker.pid,
      journal.parent.pid,
      'The journal must identify the task-owned manager process.',
    );
    assert.equal(await readProcessStart(journal.parent.pid), journal.parent.start);
    killProcess(journal.parent.pid);
    assert.equal(
      await waitForChildExit(worker, 15_000),
      true,
      'The task-owned manager must exit before fresh recovery begins.',
    );

    const intent = await readJournal(journalFile);
    assert.equal(
      intent.containerId,
      undefined,
      'The dead original writers must leave the real journal in the create-intent form.',
    );
    await assert.doesNotReject(
      readFile(creationReceiptPath(ownerStorePath, journal.sessionId), 'utf8'),
      'The real create receipt must survive until recovery retires the journal.',
    );

    const targetInspection = await docker(['inspect', journal.containerName]);
    assert.equal(
      targetInspection.exitCode,
      0,
      'The exact real target must remain present before either fresh recovery starts.',
    );
    const inspectedTargets = JSON.parse(targetInspection.stdout) as unknown;
    assert.ok(Array.isArray(inspectedTargets));
    assert.equal(inspectedTargets.length, 1);
    const inspectedTarget = inspectedTargets[0];
    assert.ok(isRecord(inspectedTarget));
    assert.equal(inspectedTarget.Id, barrier.containerId);
    assert.equal(inspectedTarget.Name, `/${journal.containerName}`);
    assert.equal(inspectedTarget.Image, journal.imageId);
    assert.ok(isRecord(inspectedTarget.Config));
    assert.ok(isRecord(inspectedTarget.Config.Labels));
    for (const [label, value] of Object.entries(journal.labels)) {
      assert.equal(
        inspectedTarget.Config.Labels[label],
        value,
        `The real target label ${label} must remain bound to its original journal.`,
      );
    }

    const futureRecord = `${randomUUID()}.json`;
    const forgedRecord = `${randomUUID()}.json`;
    const futurePath = join(ownerStorePath, futureRecord);
    const forgedPath = join(ownerStorePath, forgedRecord);
    await writeFile(futurePath, JSON.stringify({ version: 4 }), { mode: 0o600 });
    await writeFile(forgedPath, JSON.stringify({ ...intent, authenticationTag: '0'.repeat(64) }), {
      mode: 0o600,
    });
    await chmod(futurePath, 0o600);
    await chmod(forgedPath, 0o600);

    const firstRecovery = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    const secondRecovery = new OciSandboxBackend({ image: requiredImage(), ownerStorePath });
    const recoveryAttempts = await Promise.allSettled([
      firstRecovery.recoverAbandoned(),
      secondRecovery.recoverAbandoned(),
    ]);

    assert.ok(
      recoveryAttempts.some((attempt) => attempt.status === 'fulfilled'),
      'At least one recovery owner must finish the exact cleanup.',
    );
    await waitForContainerAbsence(journal.containerName);
    await assert.rejects(readFile(journalFile, 'utf8'), /ENOENT/);
    await assert.doesNotReject(readFile(futurePath, 'utf8'));
    await assert.doesNotReject(readFile(forgedPath, 'utf8'));
    const completedRecovery = recoveryAttempts.find(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof firstRecovery.recoverAbandoned>>
      > => attempt.status === 'fulfilled' && attempt.value.recoveredRecords === 1,
    );
    assert.notEqual(completedRecovery, undefined);
    assert.equal(completedRecovery?.value.unresolvedRecordCount, 2);
    assert.equal(completedRecovery?.value.unresolvedRecordsTruncated, false);
    const expectedInvalidRecords = [forgedRecord, futureRecord]
      .sort()
      .map((record) => ({ record, status: 'invalid' }));
    assert.deepEqual(completedRecovery?.value.unresolvedRecords, expectedInvalidRecords);
    completed = true;
  } finally {
    await terminateTaskOwnedChild(worker);
    await finalizeOwnerStore(ownerStorePath, completed);
  }
});

function requiredImage(): string {
  assert.notEqual(image, undefined, 'QDROID_T004_IMAGE is required for T004 Linux qualification.');
  return image as string;
}

async function startNetworkFixtureCrashWorker(
  imageValue: string,
  ownerStorePath: string,
): Promise<NetworkFixtureCrashWorker> {
  const worker = spawn(
    process.execPath,
    [networkFixtureCrashWorkerPath, imageValue, ownerStorePath],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ) as NetworkFixtureCrashWorker;
  const stderr: Buffer[] = [];
  worker.stderr.on('data', (chunk: Buffer) => {
    if (Buffer.concat(stderr).byteLength < 65_536) {
      stderr.push(chunk);
    }
  });

  try {
    worker.networkFixtureBarrier = await new Promise<NetworkFixtureBarrier>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => {
        finish(
          new Error(
            `The network fixture crash worker did not become ready: ${Buffer.concat(stderr).toString('utf8')}`,
          ),
        );
      }, 60_000);
      const finish = (error?: Error, barrier?: NetworkFixtureBarrier): void => {
        clearTimeout(timeout);
        worker.stdout.off('data', onOutput);
        worker.off('error', onError);
        worker.off('exit', onExit);
        if (error === undefined && barrier !== undefined) {
          resolve(barrier);
        } else {
          reject(error ?? new Error('The network fixture crash worker returned no barrier.'));
        }
      };
      const onError = (error: Error): void => finish(error);
      const onExit = (): void =>
        finish(
          new Error(
            `The network fixture crash worker exited before readiness: ${Buffer.concat(stderr).toString('utf8')}`,
          ),
        );
      const onOutput = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        const newline = output.indexOf('\n');
        if (newline === -1) {
          return;
        }
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error('The network fixture crash worker returned malformed readiness JSON.'));
          return;
        }
        if (!isRecord(message) || !isNetworkFixtureBarrier(message.barrier)) {
          finish(
            new Error('The network fixture crash worker returned an invalid fixture barrier.'),
          );
          return;
        }
        finish(undefined, message.barrier);
      };
      worker.stdout.on('data', onOutput);
      worker.once('error', onError);
      worker.once('exit', onExit);
    });
  } catch (error) {
    await terminateTaskOwnedChild(worker);
    throw error;
  }

  return worker;
}

async function startCrashWorker(
  imageValue: string,
  ownerStorePath: string,
  mode?: 'create-receipt-write-failure' | 'created-before-id',
): Promise<CrashWorker> {
  const worker = spawn(
    process.execPath,
    [workerPath, imageValue, ownerStorePath, ...(mode === undefined ? [] : [mode])],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  ) as CrashWorker;
  const stderr: Buffer[] = [];
  worker.stderr.on('data', (chunk: Buffer) => {
    if (Buffer.concat(stderr).byteLength < 65_536) {
      stderr.push(chunk);
    }
  });

  let ready: CrashWorkerReady;
  try {
    ready = await new Promise<CrashWorkerReady>((resolve, reject) => {
      let output = '';
      const observed: CrashWorkerReady = {};
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `The crash worker did not become ready: ${Buffer.concat(stderr).toString('utf8')}`,
          ),
        );
      }, 60_000);
      const finish = (error?: Error): void => {
        clearTimeout(timeout);
        worker.stdout.off('data', onOutput);
        worker.off('error', onError);
        worker.off('exit', onExit);
        if (error === undefined) {
          resolve(observed);
        } else {
          reject(error);
        }
      };
      const onError = (error: Error): void => finish(error);
      const onExit = (): void =>
        finish(
          new Error(
            `The crash worker exited before readiness: ${Buffer.concat(stderr).toString('utf8')}`,
          ),
        );
      const onOutput = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        for (;;) {
          const newline = output.indexOf('\n');
          if (newline === -1) {
            return;
          }
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          try {
            const message: unknown = JSON.parse(line);
            if (!isRecord(message)) {
              finish(new Error('The crash worker returned malformed readiness JSON.'));
              return;
            }
            if (
              message.phase === 'created-before-id' &&
              typeof message.containerId === 'string' &&
              typeof message.sessionId === 'string'
            ) {
              observed.barrier = { containerId: message.containerId, sessionId: message.sessionId };
              continue;
            }
            if (message.phase === 'create-receipt-write-failure') {
              continue;
            }
            if (message.ready === true) {
              finish();
              return;
            }
            finish(new Error('The crash worker returned an invalid readiness message.'));
            return;
          } catch {
            finish(new Error('The crash worker returned malformed readiness JSON.'));
            return;
          }
        }
      };
      worker.stdout.on('data', onOutput);
      worker.once('error', onError);
      worker.once('exit', onExit);
    });
  } catch (error) {
    await terminateTaskOwnedChild(worker);
    throw error;
  }
  worker.t004Ready = ready;
  return worker;
}

async function startHeartbeatPeer(
  imageValue: string,
  ownerStorePath: string,
  mode:
    | 'heartbeat-peer'
    | 'intent-after-write-failure-peer'
    | 'intent-before-write-failure-peer' = 'heartbeat-peer',
): Promise<HeartbeatPeerWorker> {
  const worker = spawn(process.execPath, [workerPath, imageValue, ownerStorePath, mode], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  const heartbeatWaiters = new Map<
    string,
    { reject: (error: Error) => void; resolve: () => void }
  >();
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveStop:
    | ((result: {
        cleanup: { cleanupConfirmed: boolean; status: string };
        completion: { cleanupConfirmed: boolean; reason: string };
      }) => void)
    | undefined;
  let rejectStop: ((error: Error) => void) | undefined;
  let output = '';
  let ready = false;
  let intentRejected = mode === 'heartbeat-peer';
  let peerRunningBeforeIntentFailure = mode === 'heartbeat-peer';
  let stopRequested = false;
  const expectedFailurePhase =
    mode === 'intent-before-write-failure-peer'
      ? 'intent-before-write-failure'
      : mode === 'intent-after-write-failure-peer'
        ? 'intent-after-write-failure'
        : undefined;
  let observedFailurePhase = expectedFailurePhase === undefined;

  worker.stderr.on('data', (chunk: Buffer) => {
    if (Buffer.concat(stderr).byteLength < 65_536) {
      stderr.push(chunk);
    }
  });
  worker.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
    for (;;) {
      const newline = output.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        rejectPeerWaiters(
          heartbeatWaiters,
          new Error('The heartbeat peer returned malformed control JSON.'),
        );
        rejectReady?.(new Error('The heartbeat peer returned malformed control JSON.'));
        rejectStop?.(new Error('The heartbeat peer returned malformed control JSON.'));
        return;
      }
      if (!isRecord(message)) {
        rejectPeerWaiters(
          heartbeatWaiters,
          new Error('The heartbeat peer returned invalid control JSON.'),
        );
        rejectReady?.(new Error('The heartbeat peer returned invalid control JSON.'));
        rejectStop?.(new Error('The heartbeat peer returned invalid control JSON.'));
        return;
      }
      if (message.phase === 'peer-running-before-intent-failure') {
        peerRunningBeforeIntentFailure = true;
        continue;
      }
      if (expectedFailurePhase !== undefined && message.phase === expectedFailurePhase) {
        observedFailurePhase = true;
        continue;
      }
      if (message.intentRejected === true) {
        intentRejected = true;
        continue;
      }
      if (message.ready === true) {
        if (!observedFailurePhase || !intentRejected || !peerRunningBeforeIntentFailure) {
          const error = new Error(
            'The intent-failure peer became ready before the target failure.',
          );
          rejectPeerWaiters(heartbeatWaiters, error);
          rejectReady?.(error);
          rejectStop?.(error);
          return;
        }
        ready = true;
        resolveReady?.();
        continue;
      }
      if (typeof message.heartbeat === 'string') {
        const waiter = heartbeatWaiters.get(message.heartbeat);
        heartbeatWaiters.delete(message.heartbeat);
        waiter?.resolve();
        continue;
      }
      if (
        isRecord(message.cleanup) &&
        isRecord(message.completion) &&
        typeof message.cleanup.cleanupConfirmed === 'boolean' &&
        typeof message.cleanup.status === 'string' &&
        typeof message.completion.cleanupConfirmed === 'boolean' &&
        typeof message.completion.reason === 'string'
      ) {
        resolveStop?.({
          cleanup: {
            cleanupConfirmed: message.cleanup.cleanupConfirmed,
            status: message.cleanup.status,
          },
          completion: {
            cleanupConfirmed: message.completion.cleanupConfirmed,
            reason: message.completion.reason,
          },
        });
        continue;
      }
      const error = new Error('The heartbeat peer returned an unexpected control message.');
      rejectPeerWaiters(heartbeatWaiters, error);
      rejectReady?.(error);
      rejectStop?.(error);
    }
  });

  const failed = (error: Error): void => {
    rejectPeerWaiters(heartbeatWaiters, error);
    rejectReady?.(error);
    rejectStop?.(error);
  };
  worker.once('error', failed);
  worker.once('exit', () => {
    if (!stopRequested) {
      failed(new Error(`The heartbeat peer exited: ${Buffer.concat(stderr).toString('utf8')}`));
    }
  });

  await new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    const timeout = setTimeout(() => {
      if (worker.pid !== undefined) {
        worker.kill('SIGKILL');
      }
      reject(
        new Error(
          `The heartbeat peer did not become ready: ${Buffer.concat(stderr).toString('utf8')}`,
        ),
      );
    }, 60_000);
    const settle = (action: () => void): void => {
      clearTimeout(timeout);
      action();
    };
    resolveReady = () => settle(resolve);
    rejectReady = (error) => settle(() => reject(error));
    if (ready) {
      resolveReady();
    }
  });

  return {
    intentRejected,
    heartbeat: async (token: string): Promise<void> => {
      if (heartbeatWaiters.has(token)) {
        throw new Error('The heartbeat peer already has a pending token.');
      }
      const acknowledgment = new Promise<void>((resolve, reject) => {
        heartbeatWaiters.set(token, { reject, resolve });
      });
      worker.stdin.write(`heartbeat:${token}\n`);
      await waitWithin(acknowledgment, 5_000, 'The heartbeat peer did not acknowledge its token.');
    },
    stop: async () => {
      if (stopRequested) {
        throw new Error('The heartbeat peer was already stopped.');
      }
      stopRequested = true;
      const stopped = new Promise<{
        cleanup: { cleanupConfirmed: boolean; status: string };
        completion: { cleanupConfirmed: boolean; reason: string };
      }>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });
      worker.stdin.write('stop\n');
      const result = await waitWithin(
        stopped,
        15_000,
        'The heartbeat peer did not confirm its explicit cleanup.',
      );
      worker.stdin.end();
      return result;
    },
    worker,
  };
}

async function startStopFenceWorker(
  imageValue: string,
  ownerStorePath: string,
  mode:
    | 'stop-before-authorization-rename'
    | 'stop-before-intent-closed-guardian'
    | 'stop-before-intent-persistence'
    | 'stop-before-qualification',
  expectedPhase:
    | 'before-authorization-rename'
    | 'before-intent-persistence'
    | 'before-qualification',
  closedGuardianReleasePath?: string,
): Promise<StopFenceWorker> {
  const worker = spawn(process.execPath, [workerPath, imageValue, ownerStorePath, mode], {
    env: {
      ...process.env,
      ...(closedGuardianReleasePath === undefined
        ? {}
        : { QDROID_T004_CLOSED_GUARDIAN_RELEASE: closedGuardianReleasePath }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  let output = '';
  let phaseReached = false;
  let startupFailure: Error | undefined;
  let cleanup: { cleanupConfirmed: boolean; status: string } | undefined;
  let resolveStop:
    | ((result: {
        cleanup: { cleanupConfirmed: boolean; status: string };
        executeRejected: boolean;
      }) => void)
    | undefined;
  let rejectStop: ((error: Error) => void) | undefined;
  let resolveRetry: ((result: { cleanupConfirmed: boolean; status: string }) => void) | undefined;
  let rejectRetry: ((error: Error) => void) | undefined;

  worker.stderr.on('data', (chunk: Buffer) => {
    if (Buffer.concat(stderr).byteLength < 65_536) {
      stderr.push(chunk);
    }
  });
  worker.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
    for (;;) {
      const newline = output.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        rejectStop?.(new Error('The stop-fence worker returned malformed control JSON.'));
        return;
      }
      if (!isRecord(message)) {
        rejectStop?.(new Error('The stop-fence worker returned invalid control JSON.'));
        return;
      }
      if (expectedPhase !== undefined && message.phase === expectedPhase) {
        phaseReached = true;
        continue;
      }
      if (
        isRecord(message.cleanup) &&
        typeof message.cleanup.cleanupConfirmed === 'boolean' &&
        typeof message.cleanup.status === 'string'
      ) {
        cleanup = {
          cleanupConfirmed: message.cleanup.cleanupConfirmed,
          status: message.cleanup.status,
        };
        continue;
      }
      if (message.executeRejected === true && cleanup !== undefined) {
        resolveStop?.({ cleanup, executeRejected: true });
        continue;
      }
      if (
        isRecord(message.retryCleanup) &&
        typeof message.retryCleanup.cleanupConfirmed === 'boolean' &&
        typeof message.retryCleanup.status === 'string'
      ) {
        const result = {
          cleanupConfirmed: message.retryCleanup.cleanupConfirmed,
          status: message.retryCleanup.status,
        };
        resolveRetry?.(result);
        continue;
      }
      rejectStop?.(new Error('The stop-fence worker returned an unexpected control message.'));
    }
  });
  const failure = (error: Error): void => {
    startupFailure = error;
    rejectStop?.(error);
    rejectRetry?.(error);
  };
  worker.once('error', failure);
  worker.once('exit', () => {
    failure(new Error(`The stop-fence worker exited: ${Buffer.concat(stderr).toString('utf8')}`));
  });

  await waitForCondition(
    () => {
      if (startupFailure !== undefined) {
        throw startupFailure;
      }
      return phaseReached;
    },
    60_000,
    `The stop-fence worker did not reach ${expectedPhase}: ${Buffer.concat(stderr).toString('utf8')}`,
  );

  return {
    stop: async () => {
      const stopped = new Promise<{
        cleanup: { cleanupConfirmed: boolean; status: string };
        executeRejected: boolean;
      }>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });
      worker.stdin.write('stop\n');
      const result = await waitWithin(
        stopped,
        15_000,
        'The stop-fence worker did not finish its bounded cleanup.',
      );
      if (closedGuardianReleasePath === undefined) {
        worker.stdin.end();
      }
      return result;
    },
    retry: async () => {
      if (closedGuardianReleasePath === undefined) {
        throw new Error('The stop-fence worker was not configured for a trusted cleanup retry.');
      }
      const retry = new Promise<{ cleanupConfirmed: boolean; status: string }>(
        (resolve, reject) => {
          resolveRetry = resolve;
          rejectRetry = reject;
        },
      );
      worker.stdin.write('retry\n');
      const result = await waitWithin(
        retry,
        15_000,
        'The stop-fence worker did not complete its trusted cleanup retry.',
      );
      worker.stdin.end();
      return result;
    },
    worker,
  };
}

function rejectPeerWaiters(
  waiters: ReadonlyMap<string, { reject: (error: Error) => void }>,
  error: Error,
): void {
  for (const waiter of waiters.values()) {
    waiter.reject(error);
  }
}

async function waitWithin<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await delay(25);
  }
  throw new Error(message);
}

async function waitForJournal(ownerStorePath: string): Promise<CleanupJournal> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const entries = (await readdir(ownerStorePath)).filter(isExecutionJournalName);
    if (entries.length === 1) {
      return readJournal(join(ownerStorePath, entries[0] as string));
    }
    await delay(25);
  }
  throw new Error('The crash worker did not persist exactly one cleanup journal.');
}

function isExecutionJournalName(entry: string): boolean {
  return /^[a-f0-9-]{36}\.json$/i.test(entry);
}

async function waitForJournals(
  ownerStorePath: string,
  expectedCount: number,
): Promise<CleanupJournal[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const entries = (await readdir(ownerStorePath)).filter(isExecutionJournalName);
    if (entries.length === expectedCount) {
      return Promise.all(entries.map((entry) => readJournal(join(ownerStorePath, entry))));
    }
    await delay(25);
  }
  throw new Error(`The crash worker did not persist ${expectedCount} cleanup journals.`);
}

async function waitForNetworkFixtureJournal(
  ownerStorePath: string,
  sessionId: string,
): Promise<NetworkFixtureJournal> {
  const path = join(ownerStorePath, `.network-fixture-${sessionId}.json`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const source = await readFile(path, 'utf8').catch(() => undefined);
    if (source !== undefined) {
      const value = JSON.parse(source) as unknown;
      if (isNetworkFixtureJournal(value)) {
        return value;
      }
      throw new Error('The network fixture crash worker persisted an invalid cleanup record.');
    }
    await delay(25);
  }
  throw new Error('The network fixture crash worker did not persist its cleanup record.');
}

function networkFixtureJournalPath(ownerStorePath: string, journal: NetworkFixtureJournal): string {
  return join(ownerStorePath, `.network-fixture-${journal.sessionId}.json`);
}

function assertNetworkFixtureBarrierMatchesJournal(
  barrier: NetworkFixtureBarrier,
  journal: NetworkFixtureJournal,
): void {
  assert.equal(barrier.sessionId, journal.sessionId);
  assert.equal(barrier.interfaceName, journal.interfaceName);
  assert.equal(barrier.marker, journal.marker);
  assert.equal(barrier.controllerPid, journal.controller.pid);
  assert.equal(barrier.controllerPgid, journal.controllerPgid);
}

function isNetworkFixtureBarrier(value: unknown): value is NetworkFixtureBarrier {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.sessionId === 'string' &&
    /^[a-f0-9-]{36}$/i.test(value.sessionId) &&
    typeof value.interfaceName === 'string' &&
    /^qd4[a-f0-9]{10}$/.test(value.interfaceName) &&
    typeof value.marker === 'string' &&
    /^02(?::[a-f0-9]{2}){5}$/i.test(value.marker) &&
    Number.isSafeInteger(value.controllerPid) &&
    (value.controllerPid as number) > 0 &&
    Number.isSafeInteger(value.controllerPgid) &&
    (value.controllerPgid as number) > 0
  );
}

function isNetworkFixtureJournal(value: unknown): value is NetworkFixtureJournal {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.sessionId === 'string' &&
    /^[a-f0-9-]{36}$/i.test(value.sessionId) &&
    typeof value.interfaceName === 'string' &&
    /^qd4[a-f0-9]{10}$/.test(value.interfaceName) &&
    typeof value.marker === 'string' &&
    /^02(?::[a-f0-9]{2}){5}$/i.test(value.marker) &&
    isProcessIdentity(value.parent) &&
    isProcessIdentity(value.controller) &&
    Number.isSafeInteger(value.controllerPgid) &&
    (value.controllerPgid as number) > 0
  );
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.pid) &&
    typeof value.start === 'string' &&
    /^\d+$/.test(value.start)
  );
}

async function readJournal(path: string): Promise<CleanupJournal> {
  return JSON.parse(await readFile(path, 'utf8')) as CleanupJournal;
}

function journalPath(ownerStorePath: string, journal: CleanupJournal): string {
  return join(ownerStorePath, `${journal.sessionId}.json`);
}

function creationReceiptPath(ownerStorePath: string, sessionId: string): string {
  return join(ownerStorePath, `.create-receipt-${sessionId}.json`);
}

function journalPayload(
  journal: Omit<CleanupJournal, 'authenticationTag'>,
): Omit<CleanupJournal, 'authenticationTag'> {
  return {
    ...(journal.containerId === undefined ? {} : { containerId: journal.containerId }),
    containerName: journal.containerName,
    ...(journal.version === 3
      ? {
          creationAuthorization: journal.creationAuthorization,
          guardianPgid: journal.guardianPgid,
          ...(journal.recoveryWriter === undefined
            ? {}
            : {
                recoveryWriter: journal.recoveryWriter,
                recoveryWriterPgid: journal.recoveryWriterPgid,
              }),
        }
      : {}),
    guardian: journal.guardian,
    hostBootId: journal.hostBootId,
    imageId: journal.imageId,
    labels: journal.labels,
    ownerId: journal.ownerId,
    parent: journal.parent,
    profileDigest: journal.profileDigest,
    profileId: journal.profileId,
    sessionId: journal.sessionId,
    version: journal.version,
  };
}

async function killWorker(
  worker: ChildProcessWithoutNullStreams,
  identity: ProcessIdentity,
): Promise<void> {
  assert.equal(
    worker.pid,
    identity.pid,
    'The journal must identify the task-owned manager process.',
  );
  assert.equal(await readProcessStart(identity.pid), identity.start);
  killProcess(identity.pid);
  await new Promise<void>((resolve) => {
    worker.once('exit', () => resolve());
  });
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    throw new Error(`The task-owned process ${pid} could not be SIGKILLed: ${String(error)}`);
  }
}

async function killExactProcess(identity: ProcessIdentity): Promise<void> {
  assert.notEqual(
    identity.start,
    null,
    'The task-owned process must have a readable start identity.',
  );
  assert.equal(await readProcessStart(identity.pid), identity.start);
  killProcess(identity.pid);
  await waitForProcessExit(identity);
}

async function terminateProcessGroupIfExactMember(
  identity: ProcessIdentity,
  processGroup: number,
): Promise<void> {
  if (identity.start === null || (await readProcessStart(identity.pid)) !== identity.start) {
    return;
  }
  if ((await readProcessGroupId(identity.pid)) !== processGroup) {
    return;
  }
  try {
    process.kill(-processGroup, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
  await waitForProcessGroupExit(processGroup).catch(() => undefined);
}

async function waitForProcessExit(identity: ProcessIdentity): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await readProcessStart(identity.pid)) !== identity.start) {
      return;
    }
    await delay(25);
  }
  throw new Error(
    `The task-owned process ${identity.pid} did not exit within its cleanup deadline.`,
  );
}

async function waitForProcessGroupExit(processGroup: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroup, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return;
      }
      throw error;
    }
    await delay(25);
  }
  throw new Error(`The task-owned controller process group ${processGroup} did not exit.`);
}

async function waitForNetworkFixtureAbsence(interfaceName: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const inspection = await trustedIp(['-o', 'link', 'show', 'dev', interfaceName]);
    if (isExactNetworkFixtureAbsence(inspection, interfaceName)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`The task-owned network fixture ${interfaceName} still exists after cleanup.`);
}

async function assertNetworkFixturePresent(journal: NetworkFixtureJournal): Promise<void> {
  const [summary, detailed] = await Promise.all([
    trustedIp(['-o', 'link', 'show', 'dev', journal.interfaceName]),
    trustedIp(['-d', 'link', 'show', 'dev', journal.interfaceName]),
  ]);
  assert.equal(
    summary.exitCode,
    0,
    'The exact fixture disappeared before recovery could verify it.',
  );
  assert.match(summary.stdout, new RegExp(`\\blink/ether\\s+${journal.marker}\\b`, 'i'));
  assert.equal(detailed.exitCode, 0, 'The exact fixture detail could not be inspected.');
  assert.match(detailed.stdout, /\bdummy\b/i);
}

function isExactNetworkFixtureAbsence(
  result: { exitCode: number; stderr: string; stdout: string },
  interfaceName: string,
): boolean {
  return (
    result.exitCode !== 0 &&
    result.stdout.trim() === '' &&
    result.stderr.trim() === `Device "${interfaceName}" does not exist.`
  );
}

async function trustedIp(
  argumentsValue: string[],
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = spawn('sudo', ['-n', 'ip', ...argumentsValue], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('The trusted ip inspection exceeded its bounded test deadline.'));
    }, 10_000);
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

async function waitForLogLine(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const contents = await readFile(path, 'utf8').catch(() => '');
    if (contents.split('\n').includes(expected)) {
      return;
    }
    await delay(25);
  }

  throw new Error(`The recovery lock fixture did not record ${expected}.`);
}

async function waitForContainerAbsence(containerName: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await docker(['inspect', containerName])).exitCode !== 0) {
      return;
    }
    await delay(50);
  }
  throw new Error(`The task-owned container ${containerName} still exists after cleanup.`);
}

async function waitForContainerPresence(containerName: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await docker(['inspect', containerName])).exitCode === 0) {
      return;
    }
    await delay(50);
  }
  throw new Error(`The held peer container ${containerName} did not remain live after recovery.`);
}

async function docker(argumentsValue: string[]): Promise<{ exitCode: number; stdout: string }> {
  const child = spawn('docker', argumentsValue, { stdio: ['ignore', 'pipe', 'pipe'] });
  const output: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    if (Buffer.concat(output).byteLength < 65_536) {
      output.push(chunk);
    }
  });
  child.stderr.resume();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Docker ${argumentsValue[0] ?? 'command'} exceeded its test deadline.`));
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(output).toString('utf8') });
    });
  });
}

async function readProcessStart(pid: number): Promise<string | null> {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
    const closeParenthesis = contents.lastIndexOf(')');
    const fields = contents.slice(closeParenthesis + 2).split(' ');
    const start = fields[19];
    return start === undefined || !/^\d+$/.test(start) ? null : start;
  } catch {
    return null;
  }
}

async function readProcessGroupId(pid: number): Promise<number | null> {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
    const closeParenthesis = contents.lastIndexOf(')');
    const fields = contents.slice(closeParenthesis + 2).split(' ');
    const processGroup = fields[2];
    return processGroup !== undefined && /^\d+$/.test(processGroup)
      ? Number.parseInt(processGroup, 10)
      : null;
  } catch {
    return null;
  }
}

async function finalizeOwnerStore(ownerStorePath: string, completed: boolean): Promise<void> {
  if (!completed) {
    process.stderr.write(`T004 owner store preserved for crash recovery: ${ownerStorePath}\n`);
    return;
  }

  await rm(ownerStorePath, { force: true, recursive: true });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

import assert from 'node:assert/strict';
import { spawn, fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { OciSandboxBackend } from '../../../packages/runtime-oci/src/backend.js';

const fixedAddresses = [
  '10.23.45.1/24',
  '169.254.77.1/24',
  '169.254.169.253/32',
  'fd42:515d:4::1/64',
] as const;

interface ControllerCompletion {
  cleanupConfirmed: boolean;
  cleanupUncertain: boolean;
}

interface CleanupEvidence {
  confirmed: boolean;
  detail: string;
}

test(
  'the trusted network controller keeps its post-sudo command in the controller group and confirms exact cleanup',
  { skip: process.platform !== 'linux' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qdroid-t004-network-controller-linux-'));
    const releasePath = join(directory, 'release');
    const privilegedPidPath = join(directory, 'privileged.pid');
    const privilegedParentPidPath = join(directory, 'privileged-parent.pid');
    const sudoPath = join(directory, 'sudo');
    const rootHelperPath = join(directory, 'trusted-ip-helper');
    const workerPath = fileURLToPath(
      new URL('../../../packages/runtime-oci/src/profile-network-controller.js', import.meta.url),
    );
    const interfaceName = `qd4${randomBytes(5).toString('hex')}`;
    const marker = markerFromRandomBytes(randomBytes(5));
    const originalPath = process.env.PATH;
    let controller: ChildProcess | undefined;
    let controllerProcessGroup: number | undefined;
    let controllerCompletion: ControllerCompletion | undefined;
    let completed = false;
    let retainEvidence = false;

    try {
      await assertFixtureAddressesAvailable();
      await assertFixtureAbsent(interfaceName);
      await writePrivilegedCommandHelpers({
        rootHelperPath,
        sudoPath,
      });
      process.env.PATH = `${directory}:${originalPath ?? ''}`;
      controller = fork(workerPath, [], {
        detached: true,
        env: {
          ...process.env,
          QDROID_NETWORK_TEST_ROOT_HELPER: rootHelperPath,
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      assert.notEqual(controller.pid, undefined);
      controllerProcessGroup = await readProcessGroupId(controller.pid as number);

      const created = waitForControllerMessage(controller, 'created');
      await sendControllerMessage(controller, { interfaceName, marker, type: 'start' });

      const privilegedPid = parseProcessId(
        await readFileWithin(privilegedPidPath, 5_000),
        'The post-sudo trusted helper did not expose its PID.',
      );
      const privilegedParentPid = parseProcessId(
        await readFileWithin(privilegedParentPidPath, 5_000),
        'The post-sudo trusted helper did not expose its parent PID.',
      );
      await assertPostSudoCommandIdentity({
        controllerProcessGroup,
        helperPath: rootHelperPath,
        privilegedParentPid,
        privilegedPid,
      });

      await writeFile(releasePath, 'release\n', { mode: 0o600 });
      await created;

      const finished = waitForControllerMessage(controller, 'finished');
      await sendControllerMessage(controller, { type: 'stop' });
      const cleanup = await finished;
      controllerCompletion = cleanup;
      assert.equal(cleanup.cleanupConfirmed, true);
      assert.equal(cleanup.cleanupUncertain, false);
      await waitForChildExit(controller, 5_000);
      await assertFixtureAbsent(interfaceName);
      await assertProcessGroupAbsent(controllerProcessGroup);
      completed = true;
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }

      if (!completed && controller !== undefined) {
        await writeFile(releasePath, 'release\n', { mode: 0o600 }).catch(() => undefined);
        const cleanup = await stopControllerOrRetainEvidence({
          controller,
          controllerCompletion,
          controllerProcessGroup,
          interfaceName,
        });
        retainEvidence = !cleanup.confirmed;
        if (retainEvidence) {
          process.stderr.write(
            `T004 network fixture evidence retained at ${directory}: ${cleanup.detail}\n`,
          );
        }
      }

      if (!retainEvidence) {
        await rm(directory, { force: true, recursive: true });
      }
    }
  },
);

test(
  'the post-sudo test helper expires before creating a fixture when its parent never releases it',
  { skip: process.platform !== 'linux' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qdroid-t004-network-helper-timeout-'));
    const sudoPath = join(directory, 'sudo');
    const rootHelperPath = join(directory, 'trusted-ip-helper');
    const interfaceName = `qd4${randomBytes(5).toString('hex')}`;
    const marker = markerFromRandomBytes(randomBytes(5));

    try {
      await assertFixtureAbsent(interfaceName);
      await writePrivilegedCommandHelpers({ rootHelperPath, sudoPath });
      const result = await runCommand(
        sudoPath,
        ['-n', 'ip', 'link', 'add', interfaceName, 'address', marker, 'type', 'dummy'],
        {
          environment: {
            ...process.env,
            QDROID_NETWORK_TEST_ROOT_HELPER: rootHelperPath,
          },
        },
      );
      assert.equal(result.exitCode, 97);
      assert.equal(
        await readFile(join(directory, 'privileged-error'), 'utf8'),
        'release-timeout\n',
      );
      await assertFixtureAbsent(interfaceName);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test(
  'controller loss during fixture disposal fails the tuple after exact cleanup recovery',
  { skip: process.platform !== 'linux' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qdroid-t004-network-dispose-loss-'));
    const ownerStorePath = join(directory, 'owner-store');
    const backend = new OciSandboxBackend({
      image: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownerStorePath,
    });
    const fixtureFactory = backend as unknown as {
      createTrustedProfileNetworkFixture(): Promise<{
        dispose(): Promise<void>;
      }>;
    };
    let controllerPid: number | undefined;
    let interfaceName: string | undefined;
    let retainEvidence = false;

    try {
      await assertFixtureAddressesAvailable();
      const fixture = await fixtureFactory.createTrustedProfileNetworkFixture();
      const records = (await readdir(ownerStorePath)).filter((entry) =>
        entry.startsWith('.network-fixture-'),
      );
      assert.equal(records.length, 1, 'The fixture did not persist its exact cleanup record.');

      const record = JSON.parse(
        await readFile(join(ownerStorePath, records[0] as string), 'utf8'),
      ) as {
        controller: { pid: number };
        interfaceName: string;
      };
      controllerPid = record.controller.pid;
      interfaceName = record.interfaceName;
      process.kill(controllerPid, 'SIGKILL');
      await waitForExactPidExit(controllerPid);

      await assert.rejects(
        fixture.dispose(),
        /network fixture controller|network fixture cleanup/i,
        'Cleanup recovery must not turn controller loss into a successful tuple.',
      );
      await assertFixtureAbsent(interfaceName);
      assert.equal(
        (await readdir(ownerStorePath)).filter((entry) => entry.startsWith('.network-fixture-'))
          .length,
        0,
      );
    } finally {
      const report = await backend.recoverAbandoned().catch(() => undefined);
      const recordCount = await readdir(ownerStorePath)
        .then((entries) => entries.filter((entry) => entry.startsWith('.network-fixture-')).length)
        .catch(() => 1);
      const fixtureGone =
        interfaceName === undefined
          ? true
          : await assertFixtureAbsent(interfaceName)
              .then(() => true)
              .catch(() => false);
      retainEvidence = report?.unresolvedRecordCount !== 0 || recordCount !== 0 || !fixtureGone;
      if (retainEvidence) {
        process.stderr.write(
          `T004 retained controller-loss fixture evidence at ${directory}: ${JSON.stringify({
            controllerPid: controllerPid ?? null,
            fixtureGone,
            recordCount,
            report,
          })}\n`,
        );
      } else {
        await rm(directory, { force: true, recursive: true });
      }
    }
  },
);

function markerFromRandomBytes(bytes: Buffer): string {
  return `02:${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(':')}`;
}

async function writePrivilegedCommandHelpers(options: {
  rootHelperPath: string;
  sudoPath: string;
}): Promise<void> {
  const sudoWrapper = `#!/bin/sh
if [ "$1" != "-n" ] || [ "$2" != "ip" ]; then
  exit 95
fi
exec /usr/bin/sudo -n "$QDROID_NETWORK_TEST_ROOT_HELPER" "$@"
`;
  const rootHelper = `#!/bin/sh
if [ "$1" != "-n" ] || [ "$2" != "ip" ]; then
  exit 96
fi
helper_directory=$(dirname "$0")
if [ "$3" = "link" ] && [ "$4" = "add" ]; then
  printf '%s\\n' "$$" > "$helper_directory/privileged.pid"
  printf '%s\\n' "$PPID" > "$helper_directory/privileged-parent.pid"
  attempts=0
  while [ ! -f "$helper_directory/release" ] && [ "$attempts" -lt 250 ]; do
    sleep 0.02
    attempts=$((attempts + 1))
  done
  if [ ! -f "$helper_directory/release" ]; then
    printf '%s\\n' 'release-timeout' > "$helper_directory/privileged-error"
    exit 97
  fi
fi
shift 2
exec /usr/sbin/ip "$@"
`;
  await writeFile(options.sudoPath, sudoWrapper, { mode: 0o700 });
  await writeFile(options.rootHelperPath, rootHelper, { mode: 0o700 });
  await chmod(options.sudoPath, 0o700);
  await chmod(options.rootHelperPath, 0o700);
}

async function assertPostSudoCommandIdentity(options: {
  controllerProcessGroup: number;
  helperPath: string;
  privilegedParentPid: number;
  privilegedPid: number;
}): Promise<void> {
  const status = await readFile(`/proc/${options.privilegedPid}/status`, 'utf8');
  const commandLine = await readFile(`/proc/${options.privilegedPid}/cmdline`, 'utf8');
  const helperName = options.helperPath.split('/').at(-1);
  assert.match(
    status,
    /^Uid:\s+0\s+0\s+0\s+0$/m,
    'The helper was not running after sudo elevation.',
  );
  assert.equal(
    commandLine.includes(helperName ?? ''),
    true,
    'The observed post-sudo command was not the fixed trusted helper.',
  );
  assert.equal(
    await readProcessGroupId(options.privilegedPid),
    options.controllerProcessGroup,
    'The elevated fixed ip command left the dedicated controller process group.',
  );
  assert.equal(
    await readProcessGroupId(options.privilegedParentPid),
    options.controllerProcessGroup,
    'The sudo monitor or parent command left the dedicated controller process group.',
  );
}

async function assertFixtureAddressesAvailable(): Promise<void> {
  const addresses = await runCommand('/usr/bin/sudo', ['-n', 'ip', '-o', 'address', 'show']);
  assert.equal(
    addresses.exitCode,
    0,
    'The controlled network fixture prerequisites are unavailable.',
  );
  for (const address of fixedAddresses) {
    assert.equal(
      addresses.stdout.includes(address),
      false,
      `The controlled address is in use: ${address}`,
    );
  }
}

async function assertFixtureAbsent(interfaceName: string): Promise<void> {
  const result = await runCommand('/usr/bin/sudo', [
    '-n',
    'ip',
    '-o',
    'link',
    'show',
    'dev',
    interfaceName,
  ]);
  assert.equal(
    isConfirmedFixtureAbsence(result, interfaceName),
    true,
    'The controller left its exact task-owned link behind.',
  );
}

function isConfirmedFixtureAbsence(
  result: { exitCode: number; stderr: string; stdout: string },
  interfaceName: string,
): boolean {
  if (result.exitCode === 0 || result.stdout.trim() !== '') {
    return false;
  }

  return result.stderr.trim() === `Device "${interfaceName}" does not exist.`;
}

async function sendControllerMessage(
  controller: ChildProcess,
  message: Record<string, string>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    controller.send?.(message, (error) => {
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
): Promise<ControllerCompletion> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(new Error('The trusted network controller did not return its expected message.'));
    }, 10_000);
    const finish = (error?: Error, result?: ControllerCompletion): void => {
      clearTimeout(timeout);
      controller.off('message', onMessage);
      controller.off('error', onError);
      controller.off('exit', onExit);
      if (error === undefined && result !== undefined) {
        resolve(result);
      } else {
        reject(error ?? new Error('The trusted network controller returned no result.'));
      }
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (): void =>
      finish(new Error('The trusted network controller exited before its expected message.'));
    const onMessage = (message: unknown): void => {
      if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        finish(new Error('The trusted network controller returned malformed IPC.'));
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
        finish(new Error('The trusted network controller omitted cleanup evidence.'));
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

function parseProcessId(value: string, message: string): number {
  const pid = Number.parseInt(value.trim(), 10);
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error(message);
  }
  return pid;
}

async function waitForExactPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return;
      }
      throw error;
    }
    await delay(20);
  }
  throw new Error(`The exact controller PID ${pid} did not exit after SIGKILL.`);
}

async function readFileWithin(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const contents = await readFile(path, 'utf8').catch(() => undefined);
    if (contents !== undefined) {
      return contents;
    }
    await delay(20);
  }
  throw new Error(`The post-sudo trusted helper did not expose its identity receipt: ${path}`);
}

async function readProcessGroupId(pid: number): Promise<number> {
  const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  const closeParenthesis = contents.lastIndexOf(')');
  const fields = contents.slice(closeParenthesis + 2).split(' ');
  const processGroup = Number.parseInt(fields[2] ?? '', 10);
  if (closeParenthesis < 0 || !Number.isSafeInteger(processGroup) || processGroup < 1) {
    throw new Error(`The process group for ${pid} is unavailable.`);
  }
  return processGroup;
}

async function waitForChildExit(controller: ChildProcess, timeoutMs: number): Promise<void> {
  if (controller.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('The trusted network controller did not exit after cleanup.'));
    }, timeoutMs);
    controller.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    controller.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function assertProcessGroupAbsent(processGroup: number): Promise<void> {
  try {
    process.kill(-processGroup, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return;
    }
    throw error;
  }
  throw new Error(`The exact controller process group ${processGroup} still exists.`);
}

async function stopControllerOrRetainEvidence(options: {
  controller: ChildProcess | undefined;
  controllerCompletion: ControllerCompletion | undefined;
  controllerProcessGroup: number | undefined;
  interfaceName: string;
}): Promise<CleanupEvidence> {
  const { controller, controllerCompletion, controllerProcessGroup, interfaceName } = options;
  if (controller === undefined) {
    return { confirmed: true, detail: 'No controller was started.' };
  }

  const finished =
    controllerCompletion === undefined && controller.exitCode === null
      ? waitForControllerMessage(controller, 'finished').catch(() => undefined)
      : Promise.resolve(undefined);
  await sendControllerMessage(controller, { type: 'stop' }).catch(() => undefined);
  const completion = controllerCompletion ?? (await finished);
  const controllerExited = await waitForChildExit(controller, 5_000)
    .then(() => true)
    .catch(() => false);
  const fixtureAbsent = await assertFixtureAbsent(interfaceName)
    .then(() => true)
    .catch(() => false);
  const groupAbsent =
    controllerProcessGroup === undefined
      ? true
      : await assertProcessGroupAbsent(controllerProcessGroup)
          .then(() => true)
          .catch(() => false);
  const confirmed =
    completion?.cleanupConfirmed === true &&
    completion.cleanupUncertain === false &&
    controllerExited &&
    fixtureAbsent &&
    groupAbsent;
  const detail = JSON.stringify({
    completion,
    controllerExited,
    fixtureAbsent,
    groupAbsent,
    interfaceName,
    processGroup: controllerProcessGroup ?? null,
  });
  return { confirmed, detail };
}

async function runCommand(
  executable: string,
  argumentsValue: string[],
  options: { environment?: NodeJS.ProcessEnv } = {},
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = spawn(executable, argumentsValue, {
    ...(options.environment === undefined ? {} : { env: options.environment }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`The trusted command exceeded its deadline: ${executable}`));
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

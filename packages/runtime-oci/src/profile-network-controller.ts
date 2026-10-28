import { spawn } from 'node:child_process';

const COMMAND_DEADLINE_MS = 5_000;
const FIXTURE_ADDRESSES = Object.freeze([
  '10.23.45.1/24',
  '169.254.77.1/24',
  '169.254.169.253/32',
  'fd42:515d:4::1/64',
]);

interface StartMessage {
  interfaceName: string;
  marker: string;
  type: 'start';
}

interface CleanupMessage {
  interfaceName: string;
  marker: string;
  type: 'cleanup';
}

interface StopMessage {
  type: 'stop';
}

type ControllerMessage = CleanupMessage | StartMessage | StopMessage;

interface CommandResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

let fixture: { interfaceName: string; marker: string } | undefined;
let finished = false;
let startRequested = false;
let lifecycle = Promise.resolve();

process.on('message', (message: unknown) => {
  enqueueLifecycleOperation(() => handleMessage(message));
});
process.on('disconnect', () => {
  enqueueLifecycleOperation(() => finish(true, 'The trusted fixture parent disconnected.'));
});

send({ type: 'ready' });

function enqueueLifecycleOperation(operation: () => Promise<void>): void {
  lifecycle = lifecycle.then(operation).catch(async (error: unknown) => {
    await finish(
      false,
      error instanceof Error ? error.message : 'Network fixture controller failed.',
    );
  });
}

async function handleMessage(message: unknown): Promise<void> {
  if (!isControllerMessage(message) || finished) {
    return;
  }

  if (message.type === 'stop') {
    await finish(true);
    return;
  }

  if (startRequested) {
    await finish(false, 'The trusted fixture controller received a duplicate start request.');
    return;
  }

  startRequested = true;
  fixture = { interfaceName: message.interfaceName, marker: message.marker };
  if (message.type === 'cleanup') {
    const cleanup = await cleanupOwnedFixture(fixture);
    finished = true;
    send({
      cleanupConfirmed: cleanup.confirmed && !cleanup.uncertain,
      cleanupUncertain: cleanup.uncertain,
      error:
        cleanup.confirmed && !cleanup.uncertain
          ? undefined
          : 'The trusted fixture controller could not confirm cleanup.',
      type: 'finished',
    });
    process.disconnect?.();
    return;
  }

  const creation = await createFixture(fixture);
  if (creation !== undefined) {
    await finish(creation.cleanupEligible, creation.error, creation.uncertain);
    return;
  }

  send({ type: 'created' });
}

async function createFixture(target: {
  interfaceName: string;
  marker: string;
}): Promise<{ cleanupEligible: boolean; error: string; uncertain: boolean } | undefined> {
  const commands: ReadonlyArray<readonly string[]> = [
    ['link', 'add', target.interfaceName, 'address', target.marker, 'type', 'dummy'],
    ...FIXTURE_ADDRESSES.map((address) => ['address', 'add', address, 'dev', target.interfaceName]),
    ['link', 'set', 'dev', target.interfaceName, 'up'],
  ];

  for (const argumentsValue of commands) {
    const result = await runTrustedIp(argumentsValue);
    if (result.exitCode !== 0) {
      return {
        cleanupEligible: !result.timedOut,
        error: 'The trusted fixture controller could not create the synthetic interface.',
        uncertain: result.timedOut,
      };
    }
  }

  return undefined;
}

async function finish(
  attemptCleanup: boolean,
  error?: string,
  priorCommandUncertain = false,
): Promise<void> {
  if (finished) {
    return;
  }

  finished = true;
  let cleanupConfirmed = fixture === undefined;
  let cleanupUncertain = priorCommandUncertain;
  if (fixture !== undefined && attemptCleanup && !priorCommandUncertain) {
    const cleanup = await cleanupOwnedFixture(fixture);
    cleanupConfirmed = cleanup.confirmed;
    cleanupUncertain = cleanup.uncertain;
  }

  send({
    cleanupConfirmed,
    cleanupUncertain,
    error,
    type: 'finished',
  });
  process.disconnect?.();
}

async function runTrustedIp(argumentsValue: readonly string[]): Promise<CommandResult> {
  const child = spawn('sudo', ['-n', 'ip', ...argumentsValue], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    if (Buffer.concat(stdout).byteLength < 16 * 1024) {
      stdout.push(chunk);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (Buffer.concat(stderr).byteLength < 16 * 1024) {
      stderr.push(chunk);
    }
  });

  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // The command can exit between the deadline and the signal request.
      }

      // A descendant can retain the command's output pipe after the direct
      // sudo child is gone. The parent must not wait forever for that pipe:
      // cleanup remains unconfirmed and the durable record remains available
      // to recovery, which verifies the original controller group first.
      child.stdout.destroy();
      child.stderr.destroy();
      finish({
        exitCode: null,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
        timedOut: true,
      });
    }, COMMAND_DEADLINE_MS);
    child.once('error', () => {
      finish({
        exitCode: null,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
        timedOut: true,
      });
    });
    child.once('close', (exitCode) => {
      finish({
        exitCode,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
        timedOut,
      });
    });
  });
}

async function cleanupOwnedFixture(target: {
  interfaceName: string;
  marker: string;
}): Promise<{ confirmed: boolean; uncertain: boolean }> {
  const inspected = await runTrustedIp(['-o', 'link', 'show', 'dev', target.interfaceName]);
  if (inspected.exitCode !== 0) {
    return {
      confirmed: isConfirmedFixtureAbsence(inspected, target.interfaceName),
      uncertain: inspected.timedOut,
    };
  }

  const markerPattern = new RegExp(`\\blink/ether\\s+${target.marker}\\b`, 'i');
  if (!markerPattern.test(inspected.stdout)) {
    return { confirmed: false, uncertain: false };
  }

  const detailed = await runTrustedIp(['-d', 'link', 'show', 'dev', target.interfaceName]);
  if (detailed.exitCode !== 0) {
    return {
      confirmed: false,
      uncertain: detailed.timedOut,
    };
  }
  if (!/\bdummy\b/i.test(detailed.stdout)) {
    return { confirmed: false, uncertain: false };
  }

  const deleted = await runTrustedIp(['link', 'delete', target.interfaceName]);
  if (deleted.exitCode === 0) {
    return { confirmed: true, uncertain: false };
  }

  const afterDelete = await runTrustedIp(['-o', 'link', 'show', 'dev', target.interfaceName]);
  const uncertain = deleted.timedOut || afterDelete.timedOut;
  return {
    confirmed: !uncertain && isConfirmedFixtureAbsence(afterDelete, target.interfaceName),
    uncertain,
  };
}

function isConfirmedFixtureAbsence(result: CommandResult, interfaceName: string): boolean {
  if (result.exitCode === 0 || result.timedOut || result.stdout.trim() !== '') {
    return false;
  }

  const quotedName = interfaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Device \\\"${quotedName}\\\" does not exist`, 'i').test(result.stderr.trim());
}

function isControllerMessage(value: unknown): value is ControllerMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const message = value as Record<string, unknown>;
  if (message.type === 'stop') {
    return Object.keys(message).length === 1;
  }

  return (
    (message.type === 'start' || message.type === 'cleanup') &&
    Object.keys(message).length === 3 &&
    typeof message.interfaceName === 'string' &&
    /^qd4[a-f0-9]{10}$/.test(message.interfaceName) &&
    typeof message.marker === 'string' &&
    /^02(?::[a-f0-9]{2}){5}$/i.test(message.marker)
  );
}

function send(message: Record<string, unknown>): void {
  if (process.connected) {
    process.send?.(message);
  }
}

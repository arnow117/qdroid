import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Readable } from 'node:stream';

type StopReason = 'completed' | 'deadline' | 'output-limit' | 'stopped';

const DOCKER_COMMAND_DEADLINE_MS = 10_000;
const MAX_DOCKER_COMMAND_OUTPUT_BYTES = 65_536;
const MAX_OUTPUT_CREDIT_BYTES = 65_536;
const MAX_OUTPUT_CHUNK_BYTES = 16_384;

interface StartMessage {
  containerName: string;
  creationReceipt?: CreationReceiptMessage;
  deadlineMs: number;
  dockerArguments: unknown;
  maxOutputBytes: number;
  ownership?: OwnedContainerMessage;
  type: 'start';
}

interface OwnedContainerMessage {
  imageId: string;
  labels: Record<string, string>;
}

interface CleanupMessage {
  containerName: string;
  imageId: string;
  knownContainerId?: string;
  labels: Record<string, string>;
  type: 'cleanup';
}

interface CreationReceiptMessage {
  guardianBootId: string;
  guardianPid: number;
  guardianStart: string;
  key: Uint8Array;
  path: string;
  sessionId: string;
}

interface OutputCreditMessage {
  byteLength: number;
  sequence: number;
  type: 'output-credit';
}

let attached: ChildProcessWithoutNullStreams | undefined;
let containerName: string | undefined;
let ownedContainerId: string | undefined;
let lifecycleMode: 'idle' | 'starting' | 'owned' | 'running' | 'cleanup' = 'idle';
let deadline: NodeJS.Timeout | undefined;
let finished = false;
let inputClosed = false;
let inputCloseRequested = false;
let deliveredOutputBytes = 0;
let stdoutBytes = 0;
let stdoutDeliveredBytes = 0;
let stderrBytes = 0;
let stderrDeliveredBytes = 0;
let stopReason: StopReason = 'completed';

let messageQueue = Promise.resolve();
let inputQueue = Promise.resolve();
let disconnectRequested = false;
let availableOutputCreditBytes = MAX_OUTPUT_CREDIT_BYTES;
let nextOutputSequence = 1;
let outputLimitBytes = 0;
const outstandingOutputCredits = new Map<number, number>();

process.on('message', (message: unknown) => {
  if (isOutputCreditMessage(message)) {
    acceptOutputCredit(message);
    return;
  }

  if (isOutputCreditType(message)) {
    void finish('stopped', 'The guardian received an invalid output-credit frame.');
    return;
  }

  messageQueue = messageQueue
    .then(() => handleMessage(message))
    .catch((error: unknown) =>
      finish('stopped', error instanceof Error ? error.message : 'The guardian failed.'),
    );
});

process.on('disconnect', () => {
  disconnectRequested = true;
  messageQueue = messageQueue.then(
    () => finish('stopped'),
    () => finish('stopped'),
  );
  void messageQueue.catch(() => undefined);
});

async function handleMessage(message: unknown): Promise<void> {
  if (!isRecord(message) || typeof message.type !== 'string') {
    throw new Error('Invalid guardian command.');
  }

  if (
    message.type === 'start' &&
    typeof message.containerName === 'string' &&
    typeof message.deadlineMs === 'number' &&
    Array.isArray(message.dockerArguments) &&
    typeof message.maxOutputBytes === 'number'
  ) {
    await start(message as unknown as StartMessage);
    return;
  }

  if (message.type === 'cleanup') {
    await cleanupOwnedContainer(message as unknown as CleanupMessage);
    return;
  }

  if (message.type === 'input' && typeof message.id === 'string' && isByteChunk(message.chunk)) {
    enqueueInput(message.id, message.chunk);
    return;
  }

  if (message.type === 'close-input') {
    closeInput();
    return;
  }

  if (
    message.type === 'stop' &&
    (message.reason === undefined ||
      message.reason === 'stopped' ||
      message.reason === 'output-limit' ||
      message.reason === 'deadline')
  ) {
    await finish(message.reason === undefined ? 'stopped' : message.reason);
    return;
  }

  throw new Error('Invalid guardian command.');
}

async function start(message: StartMessage): Promise<void> {
  if (
    attached !== undefined ||
    containerName !== undefined ||
    !Array.isArray(message.dockerArguments)
  ) {
    throw new Error('The guardian was started more than once.');
  }

  if (
    !isSafeContainerName(message.containerName) ||
    !Number.isSafeInteger(message.deadlineMs) ||
    message.deadlineMs < 1 ||
    !Number.isSafeInteger(message.maxOutputBytes) ||
    message.maxOutputBytes < 1 ||
    !message.dockerArguments.every((argument) => typeof argument === 'string') ||
    (message.ownership !== undefined && !isValidOwnedContainerMessage(message.ownership))
  ) {
    throw new Error('The guardian received an invalid trusted container specification.');
  }

  containerName = message.containerName;
  lifecycleMode = 'starting';
  const dockerArguments = message.dockerArguments;
  const created = await runDocker([
    'create',
    '--pull=never',
    '--name',
    containerName,
    ...dockerArguments,
  ]);

  if (!created.commandCompleted || created.exitCode !== 0) {
    throw new Error('The guardian could not create its task-owned container.');
  }
  const createdContainerId = created.stdout.trim();
  if (message.ownership !== undefined && !isContainerId(createdContainerId)) {
    throw new Error('The guardian create response did not contain an exact container ID.');
  }

  if (message.creationReceipt !== undefined) {
    await writeCreationReceipt(message.creationReceipt, containerName);
  }

  if (disconnectRequested || finished) {
    await finish('stopped');
    return;
  }

  const inspectFormat =
    message.ownership === undefined
      ? '{{.Id}}'
      : '{{.Id}} {{.Image}} {{index .Config.Labels "io.qdroid.owner"}} {{index .Config.Labels "io.qdroid.profile"}} {{index .Config.Labels "io.qdroid.session"}}';
  const inspected = await runDocker(['inspect', '--format', inspectFormat, containerName]);

  const [inspectedId, inspectedImage, inspectedOwner, inspectedProfile, inspectedSession] =
    inspected.stdout.trim().split(' ');
  const ownershipMatches =
    message.ownership === undefined ||
    (inspectedImage === message.ownership.imageId &&
      inspectedOwner === message.ownership.labels['io.qdroid.owner'] &&
      inspectedProfile === message.ownership.labels['io.qdroid.profile'] &&
      inspectedSession === message.ownership.labels['io.qdroid.session']);
  if (
    !inspected.commandCompleted ||
    inspected.exitCode !== 0 ||
    inspectedId === undefined ||
    !isContainerId(inspectedId) ||
    !ownershipMatches ||
    (message.ownership !== undefined && inspectedId !== createdContainerId)
  ) {
    throw new Error('The guardian could not identify its task-owned container.');
  }
  ownedContainerId = inspectedId;
  lifecycleMode = 'owned';

  if (disconnectRequested || finished) {
    await finish('stopped');
    return;
  }

  attached = spawn('docker', ['start', '--attach', '--interactive', ownedContainerId], {
    // Docker clients inherit the guardian's journaled process group. Recovery
    // will not retire a journal until that complete group has exited.
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  lifecycleMode = 'running';
  outputLimitBytes = message.maxOutputBytes;
  attached.stdout.pause();
  attached.stderr.pause();
  attached.stdout.on('readable', () => drainAvailableOutput('stdout', attached?.stdout));
  attached.stderr.on('readable', () => drainAvailableOutput('stderr', attached?.stderr));
  attached.stdin.on('error', () => {
    inputClosed = true;
  });
  attached.once('close', (exitCode) => {
    void finish('completed', undefined, exitCode);
  });
  send({ containerId: ownedContainerId, type: 'created' });
  deadline = setTimeout(() => {
    void finish('deadline');
  }, message.deadlineMs);
  drainAllAvailableOutput();
}

async function cleanupOwnedContainer(message: CleanupMessage): Promise<void> {
  if (lifecycleMode !== 'idle' || !isValidCleanupMessage(message)) {
    throw new Error('The guardian received an invalid cleanup-only specification.');
  }

  lifecycleMode = 'cleanup';
  const inspected = await runDocker([
    'inspect',
    '--format',
    '{{.Id}} {{.Image}} {{index .Config.Labels "io.qdroid.owner"}} {{index .Config.Labels "io.qdroid.profile"}} {{index .Config.Labels "io.qdroid.session"}}',
    message.containerName,
  ]);
  if (!inspected.commandCompleted) {
    sendCleanupCompletion(false, null, 'The cleanup-only inspect command did not terminate.');
    return;
  }
  if (isExactContainerAbsence(inspected, message.containerName)) {
    sendCleanupCompletion(true, null);
    return;
  }
  if (inspected.exitCode !== 0) {
    sendCleanupCompletion(false, null, 'The cleanup-only inspect command was uncertain.');
    return;
  }

  const [containerId, imageId, ownerId, profileDigest, sessionId] = inspected.stdout
    .trim()
    .split(' ');
  if (
    containerId === undefined ||
    !isContainerId(containerId) ||
    imageId !== message.imageId ||
    ownerId !== message.labels['io.qdroid.owner'] ||
    profileDigest !== message.labels['io.qdroid.profile'] ||
    sessionId !== message.labels['io.qdroid.session'] ||
    (message.knownContainerId !== undefined && containerId !== message.knownContainerId)
  ) {
    sendCleanupCompletion(
      false,
      null,
      'The cleanup-only inspect result did not match the trusted record.',
    );
    return;
  }

  const removed = await runDocker(['rm', '--force', containerId]);
  if (!removed.commandCompleted || removed.exitCode !== 0) {
    sendCleanupCompletion(false, null, 'The cleanup-only removal command was uncertain.');
    return;
  }

  const absent = await runDocker(['inspect', '--format', '{{.Id}}', message.containerName]);
  if (!absent.commandCompleted || !isExactContainerAbsence(absent, message.containerName)) {
    sendCleanupCompletion(false, null, 'The cleanup-only removal could not confirm exact absence.');
    return;
  }
  sendCleanupCompletion(true, null);
}

function enqueueInput(id: string, chunk: Uint8Array): void {
  if (inputCloseRequested || inputClosed || finished) {
    send({ error: 'The sandbox input stream is closed.', id, type: 'input-result' });
    return;
  }

  inputQueue = inputQueue
    .then(() => writeInput(id, chunk))
    .catch(() => {
      send({ error: 'The sandbox input stream rejected the write.', id, type: 'input-result' });
    });
}

async function writeInput(id: string, chunk: Uint8Array): Promise<void> {
  if (attached === undefined || inputClosed || finished) {
    send({ error: 'The sandbox input stream is closed.', id, type: 'input-result' });
    return;
  }

  await new Promise<void>((resolve) => {
    attached?.stdin.write(chunk, (error) => {
      if (error === null || error === undefined) {
        send({ id, type: 'input-result' });
      } else {
        inputClosed = true;
        send({ error: 'The sandbox input stream rejected the write.', id, type: 'input-result' });
      }
      resolve();
    });
  });
}

function closeInput(immediately = false): void {
  if (attached === undefined || inputClosed || inputCloseRequested) {
    return;
  }

  inputCloseRequested = true;
  const close = (): void => {
    if (attached === undefined || inputClosed) {
      return;
    }

    inputClosed = true;
    attached.stdin.end();
  };

  if (immediately) {
    close();
    return;
  }

  void inputQueue.then(close, close);
}

async function finish(
  reason: StopReason,
  errorMessage?: string,
  reportedExitCode?: number | null,
): Promise<void> {
  if (finished) {
    return;
  }

  finished = true;
  stopReason = reason;
  if (deadline !== undefined) {
    clearTimeout(deadline);
  }
  closeInput(true);

  if (lifecycleMode === 'idle' || lifecycleMode === 'cleanup' || ownedContainerId === undefined) {
    sendCompletion(false, null, errorMessage);
    return;
  }

  if (attached !== undefined && reason !== 'completed') {
    await stopAttachedProcess();
    await runDocker(['stop', '--time', '1', ownedContainerId]);
  }

  const inspect = await runDocker([
    'inspect',
    '--format',
    '{{.State.Running}} {{.State.ExitCode}}',
    ownedContainerId,
  ]);
  const [running, inspectedExitCode] = inspect.stdout.trim().split(' ');
  const parsedExitCode = Number.parseInt(inspectedExitCode ?? '', 10);
  const removed = await runDocker(['rm', '--force', ownedContainerId]);
  const cleanupConfirmed = inspect.exitCode === 0 && running === 'false' && removed.exitCode === 0;
  const exitCode = Number.isSafeInteger(parsedExitCode)
    ? parsedExitCode
    : (reportedExitCode ?? null);

  sendCompletion(cleanupConfirmed, exitCode, errorMessage);
}

function sendCleanupCompletion(
  cleanupConfirmed: boolean,
  exitCode: number | null,
  errorMessage?: string,
): void {
  // A cleanup-only result must become terminal before its IPC callback
  // disconnects. Otherwise the disconnect handler could call run-mode finish
  // and remove a same-named object that failed the exact ownership check.
  finished = true;
  sendCompletion(cleanupConfirmed, exitCode, errorMessage);
}

async function stopAttachedProcess(): Promise<void> {
  if (attached === undefined || attached.pid === undefined) {
    return;
  }

  try {
    // The attached CLI shares the guardian's recorded group. Do not signal a
    // negative PID here: that would terminate this guardian before it can
    // persist the bounded cleanup result.
    attached.kill('SIGKILL');
  } catch {
    attached.kill('SIGKILL');
  }

  // A wrapper may leave descendants holding inherited stdio after its direct
  // Docker client dies. The guardian must still publish a bounded unknown
  // outcome; the recorded process group prevents later recovery from treating
  // those descendants as gone.
  attached.stdin.destroy();
  attached.stdout.destroy();
  attached.stderr.destroy();
  attached.unref();
}

function sendCompletion(
  cleanupConfirmed: boolean,
  exitCode: number | null,
  errorMessage?: string,
): void {
  const message = {
    completion: {
      cleanupConfirmed,
      exitCode,
      reason: stopReason,
      stderrBytes,
      stderrDeliveredBytes,
      stdoutBytes,
      stdoutDeliveredBytes,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    },
    type: 'closed',
  };

  if (!process.connected) {
    return;
  }

  process.send?.(message, undefined, undefined, () => {
    if (process.connected) {
      process.disconnect();
    }
  });
}

async function runDocker(
  argumentsValue: string[],
): Promise<{ commandCompleted: boolean; exitCode: number; stderr: string; stdout: string }> {
  const child = spawn('docker', argumentsValue, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let outputLimited = false;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk, () => {
      outputLimited = true;
    });
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk, () => {
      outputLimited = true;
    });
  });

  const result = await new Promise<{ commandCompleted: boolean; exitCode: number }>((resolve) => {
    let settled = false;
    const finish = (code: number, commandCompleted: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ commandCompleted, exitCode: code });
    };
    const terminate = (): void => {
      try {
        // Docker commands intentionally share the guardian's registered
        // process group. Killing that group from within would kill the
        // guardian too, so an incomplete child remains conservative evidence.
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        return;
      } catch {
        // Docker may have exited before the bounded command deadline.
      }
      child.kill('SIGKILL');
    };
    const timeout = setTimeout(() => {
      terminate();
      finish(1, false);
    }, DOCKER_COMMAND_DEADLINE_MS);
    child.once('error', () => finish(1, false));
    child.once('close', (code) => finish(outputLimited ? 1 : (code ?? 1), true));
  });

  if (outputLimited) {
    return { ...result, exitCode: 1, stderr, stdout: `${stdout}${stderr}` };
  }
  return { ...result, stderr, stdout };
}

async function writeCreationReceipt(
  receipt: CreationReceiptMessage,
  expectedContainerName: string,
): Promise<void> {
  if (
    !isCreationReceiptMessage(receipt) ||
    receipt.guardianPid !== process.pid ||
    !isSafeContainerName(expectedContainerName)
  ) {
    throw new Error('The guardian received an invalid creation receipt target.');
  }

  const payload = {
    containerName: expectedContainerName,
    guardian: { pid: receipt.guardianPid, start: receipt.guardianStart },
    hostBootId: receipt.guardianBootId,
    sessionId: receipt.sessionId,
    version: 1,
  };
  const authenticationTag = createHmac('sha256', Buffer.from(receipt.key))
    .update(JSON.stringify(payload))
    .digest('hex');
  await writeAtomicJson(receipt.path, { ...payload, authenticationTag });
}

function isCreationReceiptMessage(value: CreationReceiptMessage): boolean {
  return (
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    typeof value.sessionId === 'string' &&
    /^[a-f0-9-]{36}$/i.test(value.sessionId) &&
    typeof value.guardianBootId === 'string' &&
    /^[a-f0-9-]{36}$/i.test(value.guardianBootId) &&
    Number.isSafeInteger(value.guardianPid) &&
    value.guardianPid > 0 &&
    typeof value.guardianStart === 'string' &&
    /^\d+$/.test(value.guardianStart) &&
    value.key instanceof Uint8Array &&
    value.key.byteLength === 32
  );
}

function isValidCleanupMessage(value: CleanupMessage): boolean {
  return (
    isSafeContainerName(value.containerName) &&
    /^sha256:[a-f0-9]{64}$/i.test(value.imageId) &&
    (value.knownContainerId === undefined || isContainerId(value.knownContainerId)) &&
    isRecord(value.labels) &&
    Object.keys(value.labels).length === 3 &&
    typeof value.labels['io.qdroid.owner'] === 'string' &&
    typeof value.labels['io.qdroid.profile'] === 'string' &&
    typeof value.labels['io.qdroid.session'] === 'string'
  );
}

function isValidOwnedContainerMessage(value: OwnedContainerMessage): boolean {
  return (
    /^sha256:[a-f0-9]{64}$/i.test(value.imageId) &&
    isRecord(value.labels) &&
    Object.keys(value.labels).length === 3 &&
    typeof value.labels['io.qdroid.owner'] === 'string' &&
    typeof value.labels['io.qdroid.profile'] === 'string' &&
    typeof value.labels['io.qdroid.session'] === 'string'
  );
}

function isContainerId(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function isExactContainerAbsence(
  result: { commandCompleted: boolean; exitCode: number; stderr: string },
  expectedName: string,
): boolean {
  if (!result.commandCompleted || result.exitCode === 0) {
    return false;
  }
  const message = result.stderr.trim();
  return [
    `Error: No such object: ${expectedName}`,
    `error: no such object: ${expectedName}`,
  ].includes(message);
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isByteChunk(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isSafeContainerName(value: string): boolean {
  return /^qdroid-t004-[a-z0-9-]{1,100}$/.test(value);
}

function send(message: Record<string, unknown>): void {
  if (process.connected) {
    process.send?.(message);
  }
}

function drainAllAvailableOutput(): void {
  if (attached === undefined || finished) {
    return;
  }

  drainAvailableOutput('stdout', attached.stdout);
  drainAvailableOutput('stderr', attached.stderr);
}

function drainAvailableOutput(stream: 'stderr' | 'stdout', source: Readable | undefined): void {
  if (source === undefined || finished) {
    return;
  }

  for (;;) {
    if (finished) {
      return;
    }

    const availableSourceBytes = source.readableLength;
    if (availableSourceBytes <= 0) {
      // A Readable reaches its end state through read(), including the case
      // where its final payload was consumed before EOF arrived. This zero-byte
      // read cannot consume workload bytes or credit, but lets Node advance
      // that terminal state even when the shared credit window is exhausted.
      source.read(0);
      return;
    }

    const remainingAggregateBytes = outputLimitBytes - deliveredOutputBytes;
    if (remainingAggregateBytes === 0) {
      const excess = source.read(1) as Buffer | null;
      if (excess === null) {
        return;
      }

      observeOutput(stream, excess.byteLength);
      void finish('output-limit');
      return;
    }

    if (availableOutputCreditBytes === 0) {
      return;
    }

    const requestedBytes = Math.min(
      MAX_OUTPUT_CHUNK_BYTES,
      availableOutputCreditBytes,
      remainingAggregateBytes,
    );
    const chunk = source.read(Math.min(requestedBytes, availableSourceBytes)) as Buffer | null;
    if (chunk === null) {
      return;
    }

    if (chunk.byteLength === 0 || chunk.byteLength > requestedBytes) {
      void finish('stopped', 'The attached process returned an invalid output chunk.');
      return;
    }

    observeOutput(stream, chunk.byteLength);
    if (!sendOutput(stream, chunk)) {
      return;
    }
  }
}

function observeOutput(stream: 'stderr' | 'stdout', byteLength: number): void {
  if (stream === 'stdout') {
    stdoutBytes += byteLength;
    return;
  }

  stderrBytes += byteLength;
}

function sendOutput(stream: 'stderr' | 'stdout', chunk: Buffer): boolean {
  if (!process.connected || finished) {
    return false;
  }

  if (
    chunk.byteLength === 0 ||
    chunk.byteLength > MAX_OUTPUT_CHUNK_BYTES ||
    chunk.byteLength > availableOutputCreditBytes ||
    nextOutputSequence > Number.MAX_SAFE_INTEGER
  ) {
    void finish('stopped', 'The guardian could not allocate bounded output credit.');
    return false;
  }

  const sequence = nextOutputSequence;
  nextOutputSequence += 1;
  availableOutputCreditBytes -= chunk.byteLength;
  outstandingOutputCredits.set(sequence, chunk.byteLength);
  deliveredOutputBytes += chunk.byteLength;
  if (stream === 'stdout') {
    stdoutDeliveredBytes += chunk.byteLength;
  } else {
    stderrDeliveredBytes += chunk.byteLength;
  }

  process.send?.({ chunk, sequence, stream, type: 'output' }, undefined, undefined, (error) => {
    if (error !== null && error !== undefined && !finished) {
      void finish('stopped', 'The guardian could not deliver output to its parent.');
    }
  });
  return true;
}

function acceptOutputCredit(message: OutputCreditMessage): void {
  if (finished) {
    return;
  }

  const expectedByteLength = outstandingOutputCredits.get(message.sequence);
  if (expectedByteLength === undefined || expectedByteLength !== message.byteLength) {
    void finish('stopped', 'The guardian received an unknown or repeated output credit.');
    return;
  }

  outstandingOutputCredits.delete(message.sequence);
  availableOutputCreditBytes += message.byteLength;
  if (availableOutputCreditBytes > MAX_OUTPUT_CREDIT_BYTES) {
    void finish('stopped', 'The guardian output-credit window exceeded its bound.');
    return;
  }

  drainAllAvailableOutput();
}

function isOutputCreditType(value: unknown): value is { type: 'output-credit' } {
  return isRecord(value) && value.type === 'output-credit';
}

function isOutputCreditMessage(value: unknown): value is OutputCreditMessage {
  return (
    isRecord(value) &&
    value.type === 'output-credit' &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    typeof value.byteLength === 'number' &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength > 0 &&
    value.byteLength <= MAX_OUTPUT_CHUNK_BYTES
  );
}

function appendBounded(current: string, chunk: Buffer, onLimit: () => void): string {
  const remaining = MAX_DOCKER_COMMAND_OUTPUT_BYTES - Buffer.byteLength(current);
  if (remaining <= 0) {
    onLimit();
    return current;
  }

  if (chunk.byteLength > remaining) {
    onLimit();
    return `${current}${chunk.subarray(0, remaining).toString('utf8')}`;
  }

  return `${current}${chunk.toString('utf8')}`;
}

import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const GUARDIAN_READY_DEADLINE_MS = 10_000;
const MAX_PENDING_INPUT_BYTES = 1_048_576;
const MAX_OUTPUT_CREDIT_BYTES = 65_536;
const MAX_OUTPUT_CHUNK_BYTES = 16_384;
const MAX_TRUSTED_WORKER_STDERR_BYTES = 4_096;

export type GuardianStopReason = 'completed' | 'deadline' | 'output-limit' | 'stopped';

export interface GuardianLaunchSpec {
  containerName: string;
  /**
   * A parent-authenticated proof target for a successful Docker create. This
   * is private IPC between the trusted backend and guardian; workload
   * processes never receive it.
   */
  creationReceipt?: GuardianCreationReceiptSpec;
  dockerArguments: readonly string[];
  deadlineMs: number;
  maxOutputBytes: number;
  ownership?: GuardianOwnedContainerSpec;
}

export interface GuardianCreationReceiptSpec {
  guardianBootId: string;
  guardianPid: number;
  guardianStart: string;
  key: Uint8Array;
  path: string;
  sessionId: string;
}

export interface GuardianOwnedContainerSpec {
  imageId: string;
  labels: Readonly<Record<string, string>>;
}

export interface GuardianCleanupSpec {
  containerName: string;
  imageId: string;
  knownContainerId?: string;
  labels: Readonly<Record<string, string>>;
}

export interface GuardianCompletion {
  cleanupConfirmed: boolean;
  exitCode: number | null;
  reason: GuardianStopReason;
  stderrBytes: number;
  stderrDeliveredBytes: number;
  stdoutBytes: number;
  stdoutDeliveredBytes: number;
}

interface GuardianMessage {
  type: string;
}

interface GuardianCreatedMessage extends GuardianMessage {
  containerId: string;
  type: 'created';
}

interface GuardianOutputMessage extends GuardianMessage {
  chunk: Uint8Array;
  sequence: number;
  stream: 'stderr' | 'stdout';
  type: 'output';
}

interface GuardianInputResultMessage extends GuardianMessage {
  error?: string;
  id: string;
  type: 'input-result';
}

interface GuardianClosedMessage extends GuardianMessage {
  completion: GuardianCompletion;
  type: 'closed';
}

export interface SandboxGuardianClientOptions {
  /**
   * Trusted test harnesses may supply an alternate guardian program. Product
   * callers always use the colocated lifecycle guardian.
   */
  workerPath?: string;
}

export interface GuardianClientEvents {
  created: [containerId: string];
  exited: [code: number | null, signal: NodeJS.Signals | null];
  output: [stream: 'stderr' | 'stdout', chunk: Uint8Array, acknowledgeConsumption: () => void];
}

/**
 * A trusted parent-side controller for one lifecycle guardian. Its IPC protocol
 * only carries lifecycle controls and raw workload bytes; it never interprets
 * workload output as management input.
 */
export class SandboxGuardianClient extends EventEmitter<GuardianClientEvents> {
  private readonly child: ChildProcess;
  private readonly pendingWrites = new Map<
    string,
    {
      byteLength: number;
      reject: (error: Error) => void;
      resolve: () => void;
    }
  >();
  private closed = false;
  private createdReceived = false;
  private lifecycleCommandIssued = false;
  private idleExitRequested = false;
  private failureError: Error | undefined;
  private pendingInputBytes = 0;
  private pendingOutputCreditBytes = 0;
  private readonly pendingOutputCredits = new Map<number, number>();
  private readonly startupStderrChunks: Buffer[] = [];
  private startupStderrBytes = 0;
  private readonly created: Promise<string>;
  private rejectCreated: ((error: Error) => void) | undefined;
  private resolveCreated: ((containerId: string) => void) | undefined;
  private resolveCompletion: ((completion: GuardianCompletion) => void) | undefined;
  private rejectCompletion: ((error: Error) => void) | undefined;

  public readonly completion: Promise<GuardianCompletion>;

  public constructor(options: SandboxGuardianClientOptions = {}) {
    super();
    const workerPath =
      options.workerPath ?? fileURLToPath(new URL('./guardian-worker.js', import.meta.url));
    this.child = fork(workerPath, [], {
      detached: true,
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.completion = new Promise<GuardianCompletion>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    this.created = new Promise<string>((resolve, reject) => {
      this.resolveCreated = resolve;
      this.rejectCreated = reject;
    });

    // A guardian may be stopped or exit before start() begins waiting for its
    // input-ready message. Observe both internal promises immediately so that
    // an early lifecycle failure cannot become an unhandled rejection. The
    // original promises remain rejected for the later public start/completion
    // caller.
    void this.created.catch(() => undefined);
    void this.completion.catch(() => undefined);

    this.child.stderr?.on('data', (chunk: Buffer) => this.captureStartupStderr(chunk));
    this.child.on('message', (message: unknown) => this.handleMessage(message));
    this.child.once('disconnect', () => {
      this.handleFailure(
        new Error('The sandbox guardian IPC channel disconnected before cleanup.'),
      );
    });
    this.child.once('exit', (code, signal) => this.handleExit(code, signal));
    this.child.once('error', () =>
      this.handleFailure(new Error('The sandbox guardian worker could not start.')),
    );
  }

  public get pid(): number | undefined {
    return this.child.pid;
  }

  public async start(spec: GuardianLaunchSpec): Promise<void> {
    this.lifecycleCommandIssued = true;
    await this.send({ ...spec, type: 'start' });
    await this.waitForCreated();
  }

  /**
   * Starts the worker in cleanup-only mode. It has no create/start/attach
   * operation and accepts only the exact journaled object identity.
   */
  public async cleanup(spec: GuardianCleanupSpec): Promise<GuardianCompletion> {
    this.lifecycleCommandIssued = true;
    await this.send({ ...spec, type: 'cleanup' });
    return this.completion;
  }

  /**
   * Requests that only this forked worker exit before it has received any
   * lifecycle command. Recovery uses the private IPC disconnect rather than
   * deriving a signal target from persisted process identifiers. The worker's
   * idle disconnect path has no Docker side effects.
   */
  public requestIdleWorkerExit(): boolean {
    if (
      this.lifecycleCommandIssued ||
      this.idleExitRequested ||
      this.closed ||
      !this.child.connected ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    ) {
      return false;
    }

    this.idleExitRequested = true;
    try {
      this.child.disconnect();
      return true;
    } catch {
      return false;
    }
  }

  public async writeInput(chunk: Uint8Array): Promise<void> {
    if (this.closed) {
      throw new Error('The sandbox guardian is no longer available for input.');
    }

    const nextPendingInputBytes = this.pendingInputBytes + chunk.byteLength;
    if (chunk.byteLength === 0 || nextPendingInputBytes > MAX_PENDING_INPUT_BYTES) {
      throw new Error('The sandbox guardian input queue is full.');
    }

    const id = randomUUID();
    const completion = new Promise<void>((resolve, reject) => {
      this.pendingWrites.set(id, { byteLength: chunk.byteLength, reject, resolve });
    });
    this.pendingInputBytes = nextPendingInputBytes;

    try {
      await this.send({ chunk: Buffer.from(chunk), id, type: 'input' });
    } catch (error) {
      const pending = this.pendingWrites.get(id);
      this.pendingWrites.delete(id);
      this.pendingInputBytes -= pending?.byteLength ?? 0;
      throw error;
    }

    return completion;
  }

  public async closeInput(): Promise<void> {
    if (this.closed) {
      throw new Error('The sandbox guardian is no longer available for input.');
    }

    await this.send({ type: 'close-input' });
  }

  public async stop(reason: GuardianStopReason = 'stopped'): Promise<void> {
    if (this.closed) {
      return;
    }

    await this.send({ reason, type: 'stop' });
  }

  private async send(message: Record<string, unknown>): Promise<void> {
    if (!this.child.connected || this.closed) {
      throw new Error('The sandbox guardian IPC channel is unavailable.');
    }

    await new Promise<void>((resolve, reject) => {
      this.child.send(message, (error) => {
        if (error === null || error === undefined) {
          resolve();
          return;
        }

        reject(error);
      });
    });
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message) || typeof message.type !== 'string') {
      this.handleFailure(new Error('The sandbox guardian returned an invalid IPC message.'));
      return;
    }

    if (message.type === 'created' && typeof message.containerId === 'string') {
      this.createdReceived = true;
      this.resolveCreated?.(message.containerId);
      this.emit('created', message.containerId);
      return;
    }

    if (
      message.type === 'output' &&
      (message.stream === 'stdout' || message.stream === 'stderr') &&
      isByteChunk(message.chunk) &&
      isOutputSequence(message.sequence)
    ) {
      if (this.closed) {
        this.handleFailure(
          new Error('The sandbox guardian sent output after its terminal result.'),
        );
        return;
      }

      const sequence = message.sequence;
      const byteLength = message.chunk.byteLength;
      const nextPendingOutputCreditBytes = this.pendingOutputCreditBytes + byteLength;
      if (
        byteLength === 0 ||
        byteLength > MAX_OUTPUT_CHUNK_BYTES ||
        this.pendingOutputCredits.has(sequence) ||
        nextPendingOutputCreditBytes > MAX_OUTPUT_CREDIT_BYTES
      ) {
        this.handleFailure(new Error('The sandbox guardian sent an invalid output-credit frame.'));
        return;
      }

      this.pendingOutputCredits.set(sequence, byteLength);
      this.pendingOutputCreditBytes = nextPendingOutputCreditBytes;
      this.emit('output', message.stream, message.chunk, () => {
        this.returnOutputCredit(sequence, byteLength);
      });
      return;
    }

    if (message.type === 'input-result' && typeof message.id === 'string') {
      const pending = this.pendingWrites.get(message.id);
      this.pendingWrites.delete(message.id);

      if (pending !== undefined) {
        this.pendingInputBytes -= pending.byteLength;
        if (typeof message.error === 'string') {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve();
        }
      }
      return;
    }

    if (message.type === 'closed' && isGuardianCompletion(message.completion)) {
      this.closed = true;
      if (!this.createdReceived) {
        this.rejectCreated?.(new Error('The sandbox guardian closed before accepting input.'));
      }
      this.rejectPendingWrites(new Error('The sandbox input stream is closed.'));
      this.resolveCompletion?.(message.completion);
      return;
    }

    this.handleFailure(new Error('The sandbox guardian returned an invalid IPC message.'));
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('exited', code, signal);

    if (!this.closed) {
      this.handleFailure(this.workerExitError(code, signal));
      return;
    }

    this.appendWorkerExitDiagnostic(code, signal);
  }

  private handleFailure(error: Error): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.failureError = error;
    this.rejectCreated?.(error);
    this.rejectPendingWrites(error);
    this.rejectCompletion?.(error);
  }

  private captureStartupStderr(chunk: Buffer): void {
    const remaining = MAX_TRUSTED_WORKER_STDERR_BYTES - this.startupStderrBytes;
    if (remaining > 0) {
      const captured = Buffer.from(chunk.subarray(0, remaining));
      this.startupStderrChunks.push(captured);
      this.startupStderrBytes += captured.byteLength;
    }
  }

  private workerExitError(code: number | null, signal: NodeJS.Signals | null): Error {
    return new Error(
      `The sandbox guardian exited before reporting cleanup (${formatTrustedWorkerExit(code, signal)}).${this.startupStderrSuffix()}`,
    );
  }

  private appendWorkerExitDiagnostic(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.failureError === undefined) {
      return;
    }

    const detail = `[trusted guardian worker ${formatTrustedWorkerExit(code, signal)}${this.startupStderrSuffix()}]`;
    if (!this.failureError.message.includes('[trusted guardian worker ')) {
      this.failureError.message = `${this.failureError.message} ${detail}`;
    }
  }

  private startupStderrSuffix(): string {
    const captured = Buffer.concat(this.startupStderrChunks).toString('utf8');
    const sanitized = sanitizeTrustedWorkerStderr(captured);
    return sanitized === '' ? '' : ` stderr: ${sanitized}`;
  }

  private returnOutputCredit(sequence: number, byteLength: number): void {
    const expectedByteLength = this.pendingOutputCredits.get(sequence);

    if (expectedByteLength === undefined || expectedByteLength !== byteLength) {
      return;
    }

    this.pendingOutputCredits.delete(sequence);
    this.pendingOutputCreditBytes -= byteLength;

    // A terminal message is intentionally independent of stream consumption.
    // The backend can still drain queued bytes, but a late acknowledgement must
    // not reopen a completed guardian's output window.
    if (this.closed) {
      return;
    }

    void this.send({ byteLength, sequence, type: 'output-credit' }).catch((error: unknown) => {
      const failure =
        error instanceof Error ? error : new Error('The sandbox output credit could not be sent.');
      this.handleFailure(failure);
    });
  }

  private async waitForCreated(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.created,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error('The sandbox guardian did not become input-ready before its deadline.'),
            );
          }, GUARDIAN_READY_DEADLINE_MS);
        }),
      ]);
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error('The sandbox guardian failed to start.');
      this.handleFailure(failure);
      if (this.child.connected) {
        this.child.disconnect();
      }
      throw failure;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private rejectPendingWrites(error: Error): void {
    for (const pending of this.pendingWrites.values()) {
      pending.reject(error);
    }
    this.pendingWrites.clear();
    this.pendingInputBytes = 0;
  }
}

function formatTrustedWorkerExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`;
}

function sanitizeTrustedWorkerStderr(stderr: string): string {
  return stderr
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/(?:^|\s)[A-Za-z_][A-Za-z0-9_]{0,63}=(?:"[^"]*"|'[^']*'|\S+)/g, ' [redacted]')
    .replace(/(?:file|https?):\/\/\S+/g, '[uri]')
    .replace(/(?:^|\s)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+/g, ' [path]')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isByteChunk(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isOutputSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isGuardianCompletion(value: unknown): value is GuardianCompletion {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.cleanupConfirmed === 'boolean' &&
    (typeof value.exitCode === 'number' || value.exitCode === null) &&
    (value.reason === 'completed' ||
      value.reason === 'deadline' ||
      value.reason === 'output-limit' ||
      value.reason === 'stopped') &&
    typeof value.stderrBytes === 'number' &&
    typeof value.stderrDeliveredBytes === 'number' &&
    typeof value.stdoutBytes === 'number' &&
    typeof value.stdoutDeliveredBytes === 'number'
  );
}

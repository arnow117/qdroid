import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  fork,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createSocket, type Socket as DatagramSocket } from 'node:dgram';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  SandboxBackend,
  SandboxCleanupEvidence,
  SandboxExecutionCompletion,
  SandboxExecutionHandle,
  SandboxExecutionRequest,
  SandboxIdentityBinding,
  SandboxInstance,
  SandboxProfileId,
  SandboxQualification,
} from '../../contracts/src/index.js';
import { SandboxGuardianClient } from '../../supervisor/src/index.js';
import {
  DockerSandboxManager,
  type QualificationEvidence,
  type QualificationIoMount,
} from './index.js';
import {
  PROFILE_CPU_PROBE_DEADLINE_MS,
  PROFILE_CPU_PROBE_SOURCE,
  PROFILE_IO_DEVICE_MAJOR_MINOR,
  PROFILE_IO_PROBE_DEADLINE_MS,
  PROFILE_IO_PROBE_FILE_BYTES,
  PROFILE_IO_MIN_DURATION_MS,
  PROFILE_IO_PROBE_SOURCE,
  PROFILE_NETWORK_PROBE_DEADLINE_MS,
  PROFILE_NETWORK_PROBE_SOURCE,
  SANDBOX_PROFILE_CATALOG,
  type OfflineSandboxProfile,
} from '../../supervisor/src/fixed-probe-catalog.js';
import { verifyManagedProfileTuple } from './profile-qualification.js';
import type { RuntimeResourceOps } from './resource-ops.js';

const CATALOG_VERSION = 'qdroid.t004.profile-catalog/v1';
const LEGACY_CLEANUP_JOURNAL_VERSION = 2;
const CLEANUP_JOURNAL_VERSION = 3;
const CREATE_RECEIPT_VERSION = 1;
const CREATE_RECEIPT_PREFIX = '.create-receipt-';
const JOURNAL_KEY_FILE = '.journal-key';
const QUALIFICATION_SUITE_VERSION = 'qdroid.t004.qualification/v4';
const RECOVERY_LOCK_DATABASE_FILE = '.recovery-lock.sqlite';
const RECOVERY_LOCK_SCHEMA_VERSION = 1;
const RECOVERY_LOCK_BUSY_TIMEOUT_MS = 1_000;
const MAX_RECOVERY_REPORT_RECORDS = 64;
const NETWORK_FIXTURE_RECORD_PREFIX = '.network-fixture-';
const NETWORK_FIXTURE_LEGACY_RECORD_VERSION = 1;
const NETWORK_FIXTURE_RECOVERY_WRITER_RECORD_VERSION = 2;
const NETWORK_FIXTURE_RECORD_VERSION = 3;
const NETWORK_FIXTURE_COMMAND_DEADLINE_MS = 10_000;
const NETWORK_FIXTURE_CONTROLLER_LIFECYCLE_DEADLINE_MS = 10_000;
const NETWORK_FIXTURE_STARTUP_DIAGNOSTIC_BYTES = 4_096;
const NETWORK_FIXTURE_KIND = 'qdroid.profile-network-dummy/v1';
const STOP_CLEANUP_DEADLINE_MS = 10_000;
const CLEANUP_DEADLINE_ERROR = 'The sandbox cleanup did not settle before its deadline.';
const RUNTIME_COMPONENT_PATHS = [
  '/usr/local/bin/containerd-shim-runsc-v1',
  '/usr/local/bin/gvisor-bin/gvisor_sentry',
  '/usr/local/bin/gvisor-bin/gvisor-sentry-prewarmer',
  '/usr/local/bin/gvisor-bin/runsc-fd-parking',
  '/usr/local/bin/gvisor-bin/runsc-metric-server',
] as const;
const MAX_BUFFERED_STREAM_BYTES = 65_536;
const MAX_INPUT_CHUNK_BYTES = 65_536;
const MAX_EXECUTABLE_BYTES = 512;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 4_096;
const MAX_ENVIRONMENT_ENTRIES = 24;
const MAX_ENVIRONMENT_VALUE_BYTES = 4_096;
export { SANDBOX_PROFILE_CATALOG };
export type { OfflineSandboxProfile };

interface TrustedQualification extends SandboxQualification {
  readonly hostFingerprint: string;
}

interface TrustedSandbox extends SandboxInstance {
  readonly profileId: SandboxProfileId;
}

interface ActiveExecution {
  completion: Promise<SandboxExecutionCompletion> | undefined;
  guardian: SandboxGuardianClient;
  inputBytes: number;
  journal: SerializedJournalUpdates;
  journalPath: string;
  stderr: AsyncByteStream;
  stdout: AsyncByteStream;
}

interface StartingExecution {
  cleanup: Promise<SandboxCleanupEvidence> | undefined;
  guardian: SandboxGuardianClient | undefined;
  guardianIdentity: ProcessIdentity | undefined;
  guardianPgid: number | undefined;
  journal: SerializedJournalUpdates | undefined;
  intentPersisted: boolean;
  intentWriteStarted: boolean;
  intentWriteSettled: boolean;
  intentWrite: Promise<void> | undefined;
  journalPath: string | undefined;
  reservationHeld: boolean;
  settle: Promise<SandboxCleanupEvidence>;
  settleCleanup: (evidence: SandboxCleanupEvidence) => void;
  stopRequested: boolean;
}

interface RuntimeFingerprintFacts {
  architecture: string;
  dockerVersion: string;
  runtimeArguments: readonly string[];
  runtimeBinaryDigest: string;
  runtimeComponentDigests: Record<string, string>;
  runtimeConfiguration: string;
  runtimePath: string;
  runtimeVersion: string;
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
  profileId: SandboxProfileId;
  recoveryWriter?: ProcessIdentity;
  recoveryWriterPgid?: number;
  sessionId: string;
  version: typeof LEGACY_CLEANUP_JOURNAL_VERSION | typeof CLEANUP_JOURNAL_VERSION;
}

type CleanupJournalIntent = Omit<CleanupJournal, 'authenticationTag'>;

interface CreateReceipt {
  authenticationTag: string;
  containerName: string;
  guardian: ProcessIdentity;
  hostBootId: string;
  sessionId: string;
  version: typeof CREATE_RECEIPT_VERSION;
}

type CreateReceiptIntent = Omit<CreateReceipt, 'authenticationTag'>;

interface NetworkFixtureCleanupRecord {
  addresses: readonly string[];
  authenticationTag: string;
  controller: ProcessIdentity;
  controllerPgid: number;
  hostBootId: string;
  interfaceName: string;
  kind: typeof NETWORK_FIXTURE_KIND;
  marker: string;
  parent: ProcessIdentity;
  qualificationOperation?: NetworkFixtureQualificationOperation;
  recoveryWriter?: ProcessIdentity;
  recoveryWriterPgid?: number;
  sessionId: string;
  version:
    | typeof NETWORK_FIXTURE_LEGACY_RECORD_VERSION
    | typeof NETWORK_FIXTURE_RECOVERY_WRITER_RECORD_VERSION
    | typeof NETWORK_FIXTURE_RECORD_VERSION;
}

type NetworkFixtureCleanupIntent = Omit<NetworkFixtureCleanupRecord, 'authenticationTag'>;

interface NetworkFixtureQualificationOperation {
  containerId?: string;
  containerName: string;
  imageId: string;
  labels: QualificationContainerLabels;
  profileDigest: string;
  state: 'created' | 'possibly-submitted';
}

interface NetworkFixtureRetirement {
  consumed: boolean;
  durable: boolean;
  mutation: Promise<void> | undefined;
  sessionId: string;
  unlinked: boolean;
}

interface QualificationContainerLabels {
  'io.qdroid.owner': 'qualification';
  'io.qdroid.profile': string;
  'io.qdroid.session': string;
}

interface ProcessIdentity {
  pid: number;
  start: string | null;
}

interface RecoveryLockLease {
  database: DatabaseSync;
  mutations: RecoveryLeaseMutations;
  releaseScheduled: boolean;
}

interface LateExecutionRetirement {
  cleanupProven: true;
  journal: CleanupJournal;
  journalPath: string;
  journalDurable: boolean;
  journalMutation: Promise<void> | undefined;
  journalUnlinked: boolean;
  receiptMayBeMissing: boolean;
  receiptDurable: boolean;
  receiptMutation: Promise<void> | undefined;
  receiptUnlinked: boolean;
  sandbox?: SandboxInstance;
}

/**
 * Owns persistent filesystem mutations started while a SQLite recovery lease
 * is active. A timeout cannot cancel rename, unlink, or directory fsync, so
 * the lease remains exclusive until every mutation that did start settles.
 */
class RecoveryLeaseMutations {
  private closed = false;
  private readonly failures: Error[] = [];
  private pending = 0;
  private resolveSettled: (() => void) | undefined;
  private readonly settled = new Promise<void>((resolve) => {
    this.resolveSettled = resolve;
  });

  public get hasPending(): boolean {
    return this.pending > 0;
  }

  public start<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new Error('The sandbox recovery lease is closed to new persistent mutations.'),
      );
    }

    let mutation: Promise<T>;
    try {
      mutation = operation();
    } catch (error) {
      return Promise.reject(error);
    }

    this.pending += 1;
    void mutation.then(
      () => this.finishMutation(),
      (error: unknown) => {
        this.failures.push(asError(error, 'A persistent sandbox recovery mutation failed.'));
        this.finishMutation();
      },
    );
    return mutation;
  }

  public close(): Promise<void> {
    this.closed = true;
    if (this.pending === 0) {
      this.resolveSettled?.();
    }
    return this.settled;
  }

  private finishMutation(): void {
    this.pending -= 1;
    if (this.closed && this.pending === 0) {
      this.resolveSettled?.();
    }
  }
}

/**
 * Serializes the authenticated records owned by one profile-network fixture.
 *
 * Filesystem rename and fsync are not cancellable.  A caller may reach its
 * bounded lifecycle deadline while a mutation is still running, so this owner
 * keeps the raw mutation observed and blocks all later fixture effects until
 * it settles.  Sealing stops a controller-loss or disposal path from adding a
 * later record update after its terminal decision.
 */
class NetworkFixtureMutations {
  private active = true;
  private sealed = false;
  private pending = 0;
  private serial: Promise<void> = Promise.resolve();

  public get isBlocking(): boolean {
    return this.active;
  }

  public get hasPending(): boolean {
    return this.pending > 0;
  }

  public seal(): void {
    this.sealed = true;
  }

  public release(): void {
    if (this.pending !== 0) {
      throw new Error('The network fixture still owns a persistent mutation.');
    }
    this.active = false;
  }

  public start<T>(deadline: number, operation: () => Promise<T>): PersistentMutation<T> {
    if (this.sealed || Date.now() >= deadline) {
      throw new Error('The trusted profile network fixture mutation is no longer authorized.');
    }

    this.pending += 1;
    const mutation = this.serial.then(async () => {
      if (this.sealed || Date.now() >= deadline) {
        throw new Error('The trusted profile network fixture mutation is no longer authorized.');
      }
      return operation();
    });
    this.serial = mutation.then(
      () => this.finishMutation(),
      () => this.finishMutation(),
    );
    const result = withinCleanupDeadlineAt(mutation, deadline);
    void result.catch(() => undefined);
    return { mutation, result };
  }

  /**
   * A fixture may persist facts from an already-authorized exact cleanup. It
   * is serialized after every earlier mutation and never authorizes a
   * workload create or start. A sealed fixture needs this lane after a
   * supervision loss, and an otherwise healthy fixture needs it after a
   * workload start failure.
   */
  public persistCleanupFact<T>(
    deadline: number,
    operation: () => Promise<T>,
  ): PersistentMutation<T> {
    if (!this.active || Date.now() >= deadline) {
      throw new Error('The trusted profile network fixture cannot persist a cleanup fact.');
    }

    this.pending += 1;
    const mutation = this.serial.then(async () => {
      if (Date.now() >= deadline) {
        throw new Error('The trusted profile network fixture cleanup timed out.');
      }
      return operation();
    });
    this.serial = mutation.then(
      () => this.finishMutation(),
      () => this.finishMutation(),
    );
    const result = withinCleanupDeadlineAt(mutation, deadline);
    void result.catch(() => undefined);
    return { mutation, result };
  }

  /**
   * Terminal record retirement uses the same sealed-only lane as a cleanup
   * fact. Keeping it separate makes callers state when they are removing the
   * authenticated record rather than merely recording a confirmed removal.
   */
  public retire<T>(deadline: number, operation: () => Promise<T>): PersistentMutation<T> {
    return this.persistCleanupFact(deadline, operation);
  }

  public async waitForSettled(deadline: number): Promise<void> {
    await withinCleanupDeadlineAt(this.serial, deadline);
  }

  private finishMutation(): void {
    this.pending -= 1;
  }
}

interface DockerCommandResult {
  /** False means the command deadline expired before its process group closed. */
  commandCompleted?: boolean;
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface SandboxRecoveryRecord {
  record: string;
  status: SandboxRecoveryRecordStatus;
}

export type SandboxRecoveryRecordStatus =
  | 'container-mismatch'
  | 'creation-unknown'
  | 'control-group-live'
  | 'docker-unknown'
  | 'guardian-live'
  | 'host-identity-mismatch'
  | 'invalid'
  | 'network-controller-live'
  | 'network-control-group-live'
  | 'network-mismatch'
  | 'network-qualification-unknown'
  | 'network-unknown'
  | 'network-recovery-writer-live'
  | 'network-recovery-writer-group-live'
  | 'parent-live'
  | 'recovery-writer-group-live'
  | 'recovery-writer-live'
  | 'remove-failed'
  | 'recovered';

export interface SandboxRecoveryReport {
  recoveredRecords: number;
  unresolvedRecordCount: number;
  unresolvedRecords: readonly SandboxRecoveryRecord[];
  unresolvedRecordsTruncated: boolean;
}

/**
 * Trusted fixture-only lifecycle hooks. They are intentionally absent from the
 * workload contract and let Linux crash tests stop at a durable lifecycle edge.
 */
export interface OciSandboxBackendTrustedTestHooks {
  beforeExecuteQualification?(): Promise<void>;
  beforeJournalIntentPersist?(details: { containerName: string; sessionId: string }): Promise<void>;
  afterJournalIntentPersist?(details: { containerName: string; sessionId: string }): Promise<void>;
  beforeJournalCreationAuthorizationRename?(details: {
    containerName: string;
    sessionId: string;
  }): Promise<void>;
  guardianWorkerPath?(): string;
  afterExecutionJournalRetired?(details: { sessionId: string }): Promise<void>;
  afterExecutionJournalUnlinkBeforeDirectorySync?(details: { sessionId: string }): Promise<void>;
  afterExecutionReceiptUnlinkBeforeDirectorySync?(details: { sessionId: string }): Promise<void>;
  afterIdleRecoveryWriterExit?(details: { sessionId: string; exited: boolean }): Promise<void>;
  afterTimedOutRecoveryLeaseReleased?(): Promise<void>;
  beforeRecoveryWriterPersist?(details: { sessionId: string }): Promise<void>;
  beforeRecoveryLockLeaseReturn?(): Promise<void>;
  beforeJournalContainerIdPersist?(details: {
    containerId: string;
    sessionId: string;
  }): Promise<void>;
  beforeNetworkFixtureIdentityRead?(details: {
    controllerPid: number;
    interfaceName: string;
    marker: string;
    sessionId: string;
  }): Promise<void>;
  beforeNetworkFixtureIntentPersist?(details: {
    controllerPid: number;
    interfaceName: string;
    marker: string;
    sessionId: string;
  }): Promise<void>;
  afterNetworkFixtureIntentRename?(details: {
    controllerPid: number;
    interfaceName: string;
    marker: string;
    sessionId: string;
  }): Promise<void>;
  afterNetworkFixtureCreated?(details: {
    controllerPid: number;
    controllerPgid: number;
    interfaceName: string;
    marker: string;
    sessionId: string;
  }): Promise<void>;
  afterNetworkFixtureQualificationOperationRename?(details: {
    operation: 'created' | 'possibly-submitted' | 'removed';
    sessionId: string;
  }): Promise<void>;
  afterNetworkFixtureRecoveryWriterRename?(details: { sessionId: string }): Promise<void>;
  afterNetworkFixtureRecordUnlinkBeforeDirectorySync?(details: {
    sessionId: string;
  }): Promise<void>;
  forkNetworkFixtureController?(workerPath: string): ChildProcess;
}

export interface OciSandboxBackendOptions {
  image: string;
  ownerStorePath: string;
  /** Private installer-owned resources; ordinary T002/T003 callers omit it. */
  resources?: RuntimeResourceOps;
  trustedTestHooks?: OciSandboxBackendTrustedTestHooks;
}

/**
 * Serializes one execution's journal updates with terminal retirement. Once a
 * terminal path starts, queued and resumed updates become no-ops, so a delayed
 * durable rename cannot recreate a record after confirmed cleanup.
 */
export class SerializedJournalUpdates {
  private closing = false;
  private failure: Error | undefined;
  private pending: Promise<void> = Promise.resolve();

  public get failed(): Error | undefined {
    return this.failure;
  }

  public get isClosing(): boolean {
    return this.closing;
  }

  public enqueue(update: () => Promise<void>): Promise<boolean> {
    const queued = this.pending.then(async () => {
      if (this.closing) {
        return false;
      }

      await update();
      return true;
    });
    this.pending = queued.then(
      () => undefined,
      (error: unknown) => {
        this.failure ??= asError(error, 'The sandbox cleanup journal could not be updated.');
      },
    );
    return queued;
  }

  public async finish(): Promise<void> {
    this.closing = true;
    await this.pending;
  }

  public async waitForPendingUpdate(): Promise<void> {
    await this.pending;
  }
}

function createStartingExecution(): StartingExecution {
  let settleCleanup: (evidence: SandboxCleanupEvidence) => void = () => undefined;
  const settle = new Promise<SandboxCleanupEvidence>((resolve) => {
    settleCleanup = resolve;
  });
  return {
    cleanup: undefined,
    guardian: undefined,
    guardianIdentity: undefined,
    guardianPgid: undefined,
    journal: undefined,
    intentPersisted: false,
    intentWriteStarted: false,
    intentWriteSettled: false,
    intentWrite: undefined,
    journalPath: undefined,
    reservationHeld: false,
    settle,
    settleCleanup,
    stopRequested: false,
  };
}

function confirmedCleanup(): SandboxCleanupEvidence {
  return Object.freeze({ cleanupConfirmed: true, status: 'confirmed' });
}

function pendingCleanup(): SandboxCleanupEvidence {
  return Object.freeze({ cleanupConfirmed: false, status: 'pending' });
}

function unknownCleanup(): SandboxCleanupEvidence {
  return Object.freeze({ cleanupConfirmed: false, status: 'unknown' });
}

/**
 * An async byte stream with one trusted consumer and an explicit memory bound.
 * A producer that overruns the queue receives false and must stop its task.
 */
export class AsyncByteStream implements AsyncIterable<Uint8Array> {
  private readonly chunks: Array<{
    chunk: Uint8Array;
    onConsumed: (() => void) | undefined;
  }> = [];
  private readonly waiting: Array<{
    reject: (error: Error) => void;
    resolve: (result: IteratorResult<Uint8Array>) => void;
  }> = [];
  private bufferedBytes = 0;
  private consumed = false;
  private ended = false;
  private failure: Error | undefined;

  public constructor(private readonly maxBufferedBytes: number) {}

  public get overflowed(): boolean {
    return this.bufferedBytes > this.maxBufferedBytes;
  }

  public push(chunk: Uint8Array, onConsumed?: () => void): boolean {
    if (this.ended) {
      return false;
    }

    const copy = Buffer.from(chunk);
    const waiter = this.waiting.shift();

    if (waiter !== undefined) {
      onConsumed?.();
      waiter.resolve({ done: false, value: copy });
      return true;
    }

    this.bufferedBytes += copy.byteLength;
    if (this.bufferedBytes > this.maxBufferedBytes) {
      return false;
    }

    this.chunks.push({ chunk: copy, onConsumed });
    return true;
  }

  public end(): void {
    if (this.ended) {
      return;
    }

    this.ended = true;
    this.settleWaiting();
  }

  public fail(error: Error): void {
    if (this.ended) {
      return;
    }

    this.failure = error;
    this.ended = true;
    this.settleWaiting();
  }

  public [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.consumed) {
      throw new Error('A sandbox byte stream allows only a single consumer.');
    }

    this.consumed = true;
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const buffered = this.chunks.shift();

        if (buffered !== undefined) {
          this.bufferedBytes -= buffered.chunk.byteLength;
          buffered.onConsumed?.();
          return { done: false, value: buffered.chunk };
        }

        if (this.failure !== undefined) {
          throw this.failure;
        }

        if (this.ended) {
          return { done: true, value: undefined };
        }

        return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
          this.waiting.push({ reject, resolve });
        });
      },
    };
  }

  private settleWaiting(): void {
    for (const waiter of this.waiting.splice(0)) {
      if (this.failure !== undefined) {
        waiter.reject(this.failure);
      } else {
        waiter.resolve({ done: true, value: undefined });
      }
    }
  }
}

export function parseSandboxProfile(profileId: string): OfflineSandboxProfile {
  const profile = SANDBOX_PROFILE_CATALOG[profileId as SandboxProfileId];

  if (profile === undefined) {
    throw new Error('The requested sandbox profile is unsupported.');
  }

  return profile;
}

/**
 * Trusted OCI backend. The legacy fixed manager remains available for T002/T003;
 * this backend establishes reusable opaque qualification, sandbox, and exec
 * handles for the offline T004 profile catalog.
 */
export class OciSandboxBackend implements SandboxBackend {
  private activeSandboxCount = 0;
  private readonly activeExecutions = new WeakMap<object, ActiveExecution>();
  private readonly qualifications = new WeakMap<object, TrustedQualification>();
  private readonly sandboxes = new WeakMap<
    object,
    {
      identity: SandboxIdentityBinding;
      qualification: TrustedQualification;
    }
  >();
  private readonly ownerId = randomUUID();
  private readonly reservations = new WeakMap<object, number>();
  private readonly startingExecutions = new WeakMap<object, StartingExecution>();
  private readonly pendingCleanup = new WeakMap<object, string>();
  private readonly retiredSandboxes = new WeakSet<object>();
  private readonly lateExecutionRetirements = new Map<string, LateExecutionRetirement>();
  private readonly networkFixtureMutations = new Map<string, NetworkFixtureMutations>();
  private readonly networkFixtureRetirements = new Map<string, NetworkFixtureRetirement>();
  private journalKey: Buffer | undefined;
  private legacyManager: DockerSandboxManager | undefined;
  private legacyQualification: Promise<QualificationEvidence> | undefined;
  private reservedMemoryMiB = 0;

  public constructor(private readonly options: OciSandboxBackendOptions) {
    if (!isImmutableImageReference(options.image)) {
      throw new Error('A sandbox backend requires a local immutable sha256 image ID.');
    }
  }

  public async qualify(profileId: SandboxProfileId): Promise<SandboxQualification> {
    const profile = parseSandboxProfile(profileId);
    // An executable package install injects a session owner. It must never
    // reach the legacy/profile helpers until every effect they create is
    // managed by that owner; otherwise those helpers would spawn raw Docker,
    // file, socket, and control resources outside the BuildSession.
    this.options.resources?.assertQualificationReady();
    await this.ensureOwnerStore();
    await this.assertNoPendingNetworkFixtureQualification();

    // The established fixed-profile suite proves the shared runtime's hostile
    // network and descendant-cleanup controls. The profile tuple suite below
    // independently starts workloads under this exact profile and verifies its
    // effective limits and negative controls.
    this.legacyManager ??= new DockerSandboxManager({
      image: this.options.image,
      ...(this.options.resources === undefined ? {} : { resources: this.options.resources }),
    });
    this.legacyQualification ??= this.legacyManager.qualify();
    const legacyEvidence = await this.legacyQualification;
    await this.legacyManager.assertQualificationCurrent(legacyEvidence);
    const imageId = await inspectImageId(this.options.image, this.options.resources);
    const fingerprintBeforeProbes = await currentHostFingerprint(
      profile,
      imageId,
      this.options.resources,
    );
    await verifyProfileTuple(
      profile,
      imageId,
      this.legacyManager,
      () => this.createTrustedProfileNetworkFixture(),
      this.options.resources,
    );
    await this.legacyManager.assertQualificationCurrent(legacyEvidence);
    const hostFingerprint = await currentHostFingerprint(profile, imageId, this.options.resources);
    if (hostFingerprint !== fingerprintBeforeProbes) {
      throw new Error('The sandbox host tuple changed while qualification probes were running.');
    }
    const qualification: TrustedQualification = Object.freeze({
      fingerprint: digestJson({
        catalog: CATALOG_VERSION,
        legacy: legacyEvidence.fingerprint,
        profile: profileDigest(profile),
        suite: QUALIFICATION_SUITE_VERSION,
        tuple: hostFingerprint,
      }),
      hostFingerprint,
      imageId,
      profileDigest: profileDigest(profile),
      profileId,
    });

    this.qualifications.set(qualification, qualification);
    return qualification;
  }

  public async create(
    qualification: SandboxQualification,
    identity: SandboxIdentityBinding,
  ): Promise<SandboxInstance> {
    const trustedQualification = await this.assertQualification(qualification);
    validateIdentity(identity);
    if (identity.bootId !== (await readTrustedBootId())) {
      throw new Error('The supervised sandbox identity does not match the current host boot.');
    }
    const sandbox: TrustedSandbox = Object.freeze({
      id: `sandbox-${randomUUID()}`,
      profileId: trustedQualification.profileId,
    });
    this.sandboxes.set(sandbox, { identity: { ...identity }, qualification: trustedQualification });
    return sandbox;
  }

  public async execute(
    sandbox: SandboxInstance,
    request: SandboxExecutionRequest,
  ): Promise<SandboxExecutionHandle> {
    const initialSandboxState = this.sandboxes.get(sandbox);

    if (initialSandboxState === undefined) {
      throw new Error('The sandbox handle is not owned by this backend.');
    }
    if (
      this.retiredSandboxes.has(sandbox) ||
      this.activeExecutions.has(sandbox) ||
      this.startingExecutions.has(sandbox)
    ) {
      throw new Error('The sandbox session cannot start another execution.');
    }

    const starting = createStartingExecution();
    this.startingExecutions.set(sandbox, starting);
    let guardian: SandboxGuardianClient | undefined;
    try {
      await this.options.trustedTestHooks?.beforeExecuteQualification?.();
      const qualification = await this.assertQualification(initialSandboxState.qualification);
      if (starting.stopRequested || this.retiredSandboxes.has(sandbox)) {
        await this.cleanupStartupAfterFence(sandbox, starting);
        throw new Error('The sandbox session was stopped before execution startup completed.');
      }
      validateExecutionRequest(request, qualification.profileId);
      const profile = parseSandboxProfile(qualification.profileId);

      // Qualification is asynchronous. Recheck immediately before the first
      // reservation so a concurrent execution or a stop cannot regain this
      // session's execution authority while qualification was in flight.
      if (
        this.sandboxes.get(sandbox) !== initialSandboxState ||
        this.activeExecutions.has(sandbox) ||
        this.reservations.has(sandbox) ||
        starting.stopRequested ||
        this.retiredSandboxes.has(sandbox)
      ) {
        await this.cleanupStartupAfterFence(sandbox, starting);
        throw new Error('The sandbox session cannot start another execution.');
      }

      this.reserveSandbox(sandbox, profile.limits.memoryMiB);
      starting.reservationHeld = true;
      const sessionId = randomUUID();
      const containerName = `qdroid-t004-${sessionId}`;
      guardian = new SandboxGuardianClient(
        this.options.trustedTestHooks?.guardianWorkerPath === undefined
          ? undefined
          : { workerPath: this.options.trustedTestHooks.guardianWorkerPath() },
      );
      starting.guardian = guardian;
      // Completion is also observed by the returned handle below. Attach this
      // immediate sink so a guardian crash during startup cannot become an
      // unhandled rejection before the handle is returned to its trusted caller.
      void guardian.completion.catch(() => undefined);

      const [guardianIdentity, guardianPgid, hostBootId, parentIdentity] = await Promise.all([
        processIdentity(guardian.pid),
        guardian.pid === undefined ? Promise.resolve(-1) : readProcessGroupId(guardian.pid),
        readTrustedBootId(),
        processIdentity(process.pid),
      ]);
      if (
        !isKnownProcessIdentity(guardianIdentity) ||
        typeof guardianIdentity.start !== 'string' ||
        guardianPgid < 1
      ) {
        throw new Error(
          'The sandbox guardian identity is unavailable before create authorization.',
        );
      }
      starting.guardianIdentity = guardianIdentity;
      starting.guardianPgid = guardianPgid;
      if (starting.stopRequested || this.retiredSandboxes.has(sandbox)) {
        await this.cleanupStartupAfterFence(sandbox, starting);
        throw new Error('The sandbox session was stopped before its cleanup intent was written.');
      }

      const intendedJournalPath = this.journalPathFor(sessionId);
      const creationReceiptPath = this.creationReceiptPathFor(sessionId);
      const journal = new SerializedJournalUpdates();
      starting.journalPath = intendedJournalPath;
      starting.journal = journal;
      const intent: CleanupJournalIntent = {
        containerName,
        creationAuthorization: 'not-authorized',
        guardian: guardianIdentity,
        guardianPgid,
        hostBootId,
        imageId: qualification.imageId,
        labels: {
          'io.qdroid.owner': this.ownerId,
          'io.qdroid.profile': qualification.profileDigest,
          'io.qdroid.session': sessionId,
        },
        ownerId: this.ownerId,
        parent: parentIdentity,
        profileDigest: qualification.profileDigest,
        profileId: qualification.profileId,
        sessionId,
        version: CLEANUP_JOURNAL_VERSION,
      };
      await this.options.trustedTestHooks?.beforeJournalIntentPersist?.({
        containerName,
        sessionId,
      });
      if (starting.stopRequested || this.retiredSandboxes.has(sandbox)) {
        await this.cleanupStartupAfterFence(sandbox, starting);
        throw new Error('The sandbox session was stopped before its cleanup intent was persisted.');
      }
      starting.intentWrite = journal
        .enqueue(async () => {
          starting.intentWriteStarted = true;
          await this.writeIntent(intendedJournalPath, intent);
          await this.options.trustedTestHooks?.afterJournalIntentPersist?.({
            containerName,
            sessionId,
          });
        })
        .then(
          (written) => {
            if (!written) {
              throw new Error(
                'The sandbox cleanup journal was closed before its intent persisted.',
              );
            }
            starting.intentPersisted = true;
            starting.intentWriteSettled = true;
          },
          (error: unknown) => {
            starting.intentWriteSettled = true;
            throw error;
          },
        );
      // The durable write may have reached rename before an error is reported.
      // Register its exact path before awaiting it so a stop can retry
      // cleanup-only recovery after that uncertain result settles.
      this.pendingCleanup.set(sandbox, intendedJournalPath);
      void starting.intentWrite.catch(() => undefined);
      await starting.intentWrite;
      if (starting.stopRequested || this.retiredSandboxes.has(sandbox)) {
        await this.cleanupStartupAfterFence(sandbox, starting);
        throw new Error('The sandbox session was stopped before its guardian started.');
      }
      this.pendingCleanup.set(sandbox, intendedJournalPath);

      // A sent IPC command does not prove the Docker daemon did nothing. The
      // durable state transition precedes the first guardian start message so
      // loss at any later point remains fail-closed until a guardian-owned
      // success receipt is available.
      const authorizationWritten = await journal.enqueue(async () => {
        await this.updateJournalCreationAuthorization(
          intendedJournalPath,
          'possibly-submitted',
          async () => {
            await this.options.trustedTestHooks?.beforeJournalCreationAuthorizationRename?.({
              containerName,
              sessionId,
            });
          },
        );
      });
      if (!authorizationWritten) {
        throw new Error('The sandbox cleanup journal was closed before create authorization.');
      }
      if (starting.stopRequested || this.retiredSandboxes.has(sandbox)) {
        await this.cleanupStartupAfterFence(sandbox, starting);
        throw new Error('The sandbox session was stopped before create authorization.');
      }

      const stdout = new AsyncByteStream(MAX_BUFFERED_STREAM_BYTES);
      const stderr = new AsyncByteStream(MAX_BUFFERED_STREAM_BYTES);
      const active: ActiveExecution = {
        completion: undefined,
        guardian,
        inputBytes: 0,
        journal,
        journalPath: intendedJournalPath,
        stderr,
        stdout,
      };
      this.activeExecutions.set(sandbox, active);

      guardian.on('created', (containerId) => {
        const containerIdUpdate = journal.enqueue(async () => {
          await this.options.trustedTestHooks?.beforeJournalContainerIdPersist?.({
            containerId,
            sessionId,
          });
          if (journal.isClosing) {
            return;
          }
          const currentJournal = parseCleanupJournal(await readFile(intendedJournalPath, 'utf8'));
          if (
            !this.isAuthenticJournal(currentJournal) ||
            !(await this.hasAuthenticCreateReceipt(currentJournal))
          ) {
            throw new Error('The guardian created event lacked a durable trusted receipt.');
          }
          await this.updateJournalContainerId(intendedJournalPath, containerId);
        });
        // The serialized state retains this error for completion/recovery.
        // Observe the immediate promise too, so an event-driven update cannot
        // surface as an unhandled rejection before that lifecycle path runs.
        void containerIdUpdate.catch(() => undefined);
        void journal.waitForPendingUpdate().then(() => {
          if (journal.failed !== undefined) {
            this.retireSandbox(sandbox);
            void guardian?.stop('stopped').catch(() => undefined);
          }
        });
      });
      guardian.on('output', (stream, chunk, acknowledgeConsumption) => {
        const target = stream === 'stdout' ? stdout : stderr;
        if (!target.push(chunk, acknowledgeConsumption)) {
          void guardian?.stop('output-limit');
        }
      });
      const completion = guardian.completion.then(
        async (result): Promise<SandboxExecutionCompletion> => {
          stdout.end();
          stderr.end();
          this.activeExecutions.delete(sandbox);
          if (result.cleanupConfirmed) {
            const cleanupConfirmed = await this.confirmCleanup(
              sandbox,
              intendedJournalPath,
              journal,
            );
            if (!cleanupConfirmed) {
              return { ...result, cleanupConfirmed: false };
            }
          } else {
            await journal.finish();
            this.retireSandbox(sandbox);
          }
          return result;
        },
        async (error: Error): Promise<SandboxExecutionCompletion> => {
          stdout.fail(error);
          stderr.fail(error);
          this.activeExecutions.delete(sandbox);
          this.retireSandbox(sandbox);
          await journal.finish();
          const cleanupConfirmed = await this.recoverAndRelease(sandbox, intendedJournalPath, true);
          return {
            cleanupConfirmed,
            exitCode: null,
            reason: 'guardian-lost',
            stderrBytes: 0,
            stderrDeliveredBytes: 0,
            stdoutBytes: 0,
            stdoutDeliveredBytes: 0,
          };
        },
      );
      active.completion = completion;
      this.startingExecutions.delete(sandbox);
      starting.settleCleanup(confirmedCleanup());

      try {
        await guardian.start({
          containerName,
          creationReceipt: {
            guardianBootId: hostBootId,
            guardianPid: guardianIdentity.pid,
            guardianStart: guardianIdentity.start,
            key: this.requireJournalKey(),
            path: creationReceiptPath,
            sessionId,
          },
          deadlineMs: profile.limits.deadlineMs,
          dockerArguments: dockerArgumentsFor(profile, qualification.imageId, request, {
            'io.qdroid.owner': this.ownerId,
            'io.qdroid.profile': qualification.profileDigest,
            'io.qdroid.session': sessionId,
          }),
          maxOutputBytes: profile.limits.maxOutputBytes,
          ownership: {
            imageId: qualification.imageId,
            labels: {
              'io.qdroid.owner': this.ownerId,
              'io.qdroid.profile': qualification.profileDigest,
              'io.qdroid.session': sessionId,
            },
          },
        });
      } catch (error) {
        this.retireSandbox(sandbox);
        await this.stopGuardianAndAwait(guardian, 'stopped').catch(() => undefined);
        await journal.finish();
        await this.recoverAndRelease(sandbox, intendedJournalPath, true);
        throw error;
      }

      if (this.retiredSandboxes.has(sandbox)) {
        await completion;
        throw new Error('The sandbox session was stopped while its guardian was starting.');
      }

      return {
        closeInput: () => guardian?.closeInput() ?? Promise.reject(new Error('Guardian missing.')),
        completion,
        stderr,
        stdout,
        writeInput: async (chunk) => {
          const nextInputBytes = active.inputBytes + chunk.byteLength;
          if (
            chunk.byteLength === 0 ||
            chunk.byteLength > MAX_INPUT_CHUNK_BYTES ||
            nextInputBytes > profile.limits.maxInputBytes ||
            this.retiredSandboxes.has(sandbox) ||
            active.guardian !== guardian
          ) {
            throw new Error('The sandbox input chunk exceeds the qualified limit.');
          }
          active.inputBytes = nextInputBytes;
          await guardian.writeInput(chunk);
        },
      };
    } catch (error) {
      if (this.startingExecutions.get(sandbox) === starting) {
        // A concurrent stop already owns startup cleanup. In particular, an
        // unknown first cleanup must remain available for an explicit trusted
        // stop retry; this execute rejection must not silently start another
        // deadline window for the same still-live guardian.
        const evidence = await this.cleanupStartupAfterFence(sandbox, starting);
        starting.settleCleanup(evidence);
        if (evidence.cleanupConfirmed) {
          this.startingExecutions.delete(sandbox);
        }
      }
      throw error;
    }
  }

  public async stop(sandbox: SandboxInstance): Promise<SandboxCleanupEvidence> {
    if (this.sandboxes.get(sandbox) === undefined) {
      throw new Error('The sandbox handle is not owned by this backend.');
    }

    // Fence the handle before awaiting any lifecycle state. A delayed execute
    // must observe this marker before it reserves or starts another container.
    this.retireSandbox(sandbox);
    const starting = this.startingExecutions.get(sandbox);
    if (starting !== undefined) {
      starting.stopRequested = true;
      return (
        (await this.cleanupStartingExecution(sandbox, starting).catch(() => undefined)) ??
        pendingCleanup()
      );
    }

    const active = this.activeExecutions.get(sandbox);

    if (active === undefined) {
      const journalPath = this.pendingCleanup.get(sandbox);
      if (journalPath !== undefined) {
        const recovered = await this.recoverAndRelease(sandbox, journalPath, true);
        return recovered ? confirmedCleanup() : unknownCleanup();
      }
      return this.reservations.has(sandbox) ? unknownCleanup() : confirmedCleanup();
    }

    const completion = active.completion;
    if (completion === undefined) {
      return pendingCleanup();
    }

    let result: SandboxExecutionCompletion;
    try {
      result = await this.stopGuardianAndAwait(active.guardian, 'stopped', completion);
    } catch {
      const recovered = await this.recoverAndRelease(sandbox, active.journalPath, true);
      return recovered ? confirmedCleanup() : unknownCleanup();
    }
    if (result.cleanupConfirmed && !this.reservations.has(sandbox)) {
      return confirmedCleanup();
    }

    const recovered = await this.recoverAndRelease(sandbox, active.journalPath, true);
    return recovered ? confirmedCleanup() : unknownCleanup();
  }

  public async recoverAbandoned(): Promise<SandboxRecoveryReport> {
    await this.ensureOwnerStore();
    const lease = await acquireRecoveryLock(this.options.ownerStorePath);
    if (lease === undefined) {
      throw new Error('Another sandbox recovery owner is already active.');
    }

    try {
      let recoveredRecords = 0;
      const unresolvedRecords: SandboxRecoveryRecord[] = [];
      let unresolvedRecordCount = 0;
      for (const retirement of this.lateExecutionRetirements.values()) {
        const outcome = await this.resumeLateExecutionRetirement(retirement.journalPath, lease);
        if (outcome === undefined) {
          continue;
        }

        if (outcome.status === 'recovered') {
          recoveredRecords += 1;
        } else {
          unresolvedRecordCount += 1;
          if (unresolvedRecords.length < MAX_RECOVERY_REPORT_RECORDS) {
            unresolvedRecords.push({
              record: `${retirement.journal.sessionId}.json`,
              status: outcome.status,
            });
          }
        }

        if (lease.mutations.hasPending || outcome.status !== 'recovered') {
          // A late retirement belongs to the original execution. Do not move
          // on to another record until that exact outcome is settled.
          break;
        }
      }

      if (unresolvedRecordCount === 0 && !lease.mutations.hasPending) {
        // A network record can be unlinked before its directory fsync settles.
        // Its exact in-memory retirement is therefore authoritative for this
        // backend instance even when readdir can no longer find the file.
        for (const [path, retirement] of this.networkFixtureRetirements) {
          if (retirement.consumed) {
            continue;
          }

          const outcome = await this.recoverNetworkFixtureRecord(path, false, lease);
          if (outcome.status === 'recovered') {
            recoveredRecords += 1;
          } else {
            unresolvedRecordCount += 1;
            if (unresolvedRecords.length < MAX_RECOVERY_REPORT_RECORDS) {
              unresolvedRecords.push({
                record: `${NETWORK_FIXTURE_RECORD_PREFIX}${retirement.sessionId}.json`,
                status: outcome.status,
              });
            }
          }

          if (lease.mutations.hasPending || outcome.status !== 'recovered') {
            // This retirement owns an exact raw mutation. Do not scan another
            // record until it is settled or explicitly reported as unresolved.
            break;
          }
        }
      }

      if (unresolvedRecordCount === 0 && !lease.mutations.hasPending) {
        // A successful late retirement can unlink its journal while this
        // recovery call is still running. Read the directory only after that
        // phase so we do not report the execution we just retired as a new
        // missing/invalid record.
        const ownerStoreEntries = (await readdir(this.options.ownerStorePath)).sort();
        for (const entry of ownerStoreEntries) {
          let outcome: { status: SandboxRecoveryRecordStatus } | undefined;
          if (isNetworkFixtureRecordName(entry)) {
            outcome = await this.recoverNetworkFixtureRecord(
              join(this.options.ownerStorePath, entry),
              false,
              lease,
            );
          } else if (isExecutionJournalName(entry)) {
            outcome = await this.recoverOwnedJournal(
              join(this.options.ownerStorePath, entry),
              false,
              lease,
            );
          }

          if (outcome !== undefined) {
            if (outcome.status === 'recovered') {
              recoveredRecords += 1;
            } else {
              unresolvedRecordCount += 1;
              if (unresolvedRecords.length < MAX_RECOVERY_REPORT_RECORDS) {
                unresolvedRecords.push({ record: entry, status: outcome.status });
              }
            }
          }

          if (lease.mutations.hasPending) {
            // A timed persistent mutation retains this SQLite transaction after
            // this report returns. Do not advance to another record while that
            // mutation can still rename or unlink the current one.
            break;
          }
        }
      }

      return Object.freeze({
        recoveredRecords,
        unresolvedRecordCount,
        unresolvedRecords: Object.freeze(unresolvedRecords),
        unresolvedRecordsTruncated: unresolvedRecordCount > unresolvedRecords.length,
      });
    } finally {
      await releaseRecoveryLock(lease);
    }
  }

  private async assertQualification(
    qualification: SandboxQualification,
  ): Promise<TrustedQualification> {
    const trustedQualification = this.qualifications.get(qualification);

    if (trustedQualification === undefined || qualification !== trustedQualification) {
      throw new Error('The sandbox qualification handle is not trusted.');
    }

    const profile = parseSandboxProfile(trustedQualification.profileId);
    const current = await currentHostFingerprint(
      profile,
      trustedQualification.imageId,
      this.options.resources,
    );
    if (current !== trustedQualification.hostFingerprint) {
      throw new Error('The sandbox qualification is stale for the current host tuple.');
    }

    return trustedQualification;
  }

  /**
   * Qualification must never begin a legacy or profile probe while an earlier
   * network fixture still owns a record or a non-cancellable record mutation.
   * A caller can use explicit recovery to resolve that evidence; a new public
   * qualification cannot silently overlap it.
   */
  private async assertNoPendingNetworkFixtureQualification(): Promise<void> {
    for (const mutations of this.networkFixtureMutations.values()) {
      if (mutations.isBlocking) {
        throw new Error('A trusted profile network fixture still has unresolved cleanup evidence.');
      }
    }

    const pendingRecords = (await readdir(this.options.ownerStorePath)).filter(
      isNetworkFixtureRecordName,
    );
    if (pendingRecords.length > 0) {
      throw new Error('A trusted profile network fixture still has unresolved cleanup evidence.');
    }
  }

  private async createTrustedProfileNetworkFixture(): Promise<TrustedProfileNetworkFixture> {
    await this.ensureOwnerStore();
    await this.assertNoPendingNetworkFixtureQualification();

    const sessionId = randomUUID();
    const interfaceName = `qd4${randomBytes(5).toString('hex')}`;
    const marker = formatNetworkFixtureMarker(randomBytes(5));
    await assertTrustedProfileNetworkFixturePrerequisites(interfaceName);
    const path = this.networkFixtureRecordPath(sessionId);
    const controller = new ProfileNetworkFixtureController(
      this.options.trustedTestHooks?.forkNetworkFixtureController,
    );
    const mutations = new NetworkFixtureMutations();
    this.networkFixtureMutations.set(path, mutations);
    const fixtureDetails = {
      controllerPid: controller.pid,
      interfaceName,
      marker,
      sessionId,
    };
    // A controller loss fences both queued and future record updates before a
    // workload continuation can consume a late filesystem result.
    void controller.failure.catch(() => {
      mutations.seal();
    });
    let currentRecord: NetworkFixtureCleanupIntent | undefined;
    let intentWriteStarted = false;
    let controllerPgid: number | undefined;
    let terminalDispose: { failure: Error | undefined } | undefined;

    const persistRecord = async (
      nextRecord: NetworkFixtureCleanupIntent,
      afterRename?: () => Promise<void>,
      cleanupOnly = false,
    ): Promise<void> => {
      const deadline = Date.now() + NETWORK_FIXTURE_CONTROLLER_LIFECYCLE_DEADLINE_MS;
      const writeRecord = async (): Promise<void> => {
        await this.writeAuthenticatedNetworkFixtureRecord(path, nextRecord, afterRename);
        currentRecord = nextRecord;
      };
      const persistentWrite = cleanupOnly
        ? mutations.persistCleanupFact(deadline, writeRecord)
        : mutations.start(deadline, writeRecord);
      await persistentWrite.result;
    };

    try {
      await controller.waitUntilReady();
      await this.options.trustedTestHooks?.beforeNetworkFixtureIdentityRead?.(fixtureDetails);
      const [controllerIdentity, observedControllerPgid, hostBootId, parent] = await Promise.all([
        processIdentity(controller.pid),
        readProcessGroupId(controller.pid),
        readTrustedBootId(),
        processIdentity(process.pid),
      ]);
      if (!isKnownProcessIdentity(controllerIdentity)) {
        throw new Error('The trusted profile network fixture controller identity is unavailable.');
      }
      controllerPgid = observedControllerPgid;
      const intent: NetworkFixtureCleanupIntent = {
        addresses: networkFixtureAddresses(),
        controller: controllerIdentity,
        controllerPgid: observedControllerPgid,
        hostBootId,
        interfaceName,
        kind: NETWORK_FIXTURE_KIND,
        marker,
        parent,
        sessionId,
        version: NETWORK_FIXTURE_RECORD_VERSION,
      };
      await this.options.trustedTestHooks?.beforeNetworkFixtureIntentPersist?.(fixtureDetails);
      intentWriteStarted = true;
      await persistRecord(intent, async () => {
        await this.options.trustedTestHooks?.afterNetworkFixtureIntentRename?.(fixtureDetails);
      });
      await controller.start(interfaceName, marker);
      await this.options.trustedTestHooks?.afterNetworkFixtureCreated?.({
        ...fixtureDetails,
        controllerPgid: observedControllerPgid,
      });
    } catch (error) {
      mutations.seal();
      const completion = await controller.stop().catch(() => undefined);
      const controllerExited =
        controllerPgid === undefined
          ? false
          : await waitForProcessGroupExit(controllerPgid).catch(() => false);
      const deadline = Date.now() + NETWORK_FIXTURE_CONTROLLER_LIFECYCLE_DEADLINE_MS;
      const mutationsSettled = await mutations
        .waitForSettled(deadline)
        .then(() => true)
        .catch(() => false);

      if (
        !intentWriteStarted &&
        mutationsSettled &&
        completion?.cleanupConfirmed === true &&
        (controllerPgid === undefined || controllerExited)
      ) {
        mutations.release();
        this.networkFixtureMutations.delete(path);
      }
      const failure = asError(error, 'The trusted profile network fixture did not start.');
      const controllerFailure = controller.failureReason;
      if (controllerFailure !== undefined && controllerFailure !== failure) {
        failure.message = `${failure.message} Controller diagnostic: ${controllerFailure.message}`;
      }
      throw failure;
    }

    return {
      assertHealthy: () => controller.assertHealthy(),
      dispose: async (): Promise<void> => {
        if (terminalDispose !== undefined) {
          if (terminalDispose.failure !== undefined) {
            throw terminalDispose.failure;
          }
          return;
        }

        const completedRetirement = this.networkFixtureRetirements.get(path);
        if (completedRetirement?.consumed === true) {
          const failure = controller.failureReason;
          terminalDispose = { failure };
          this.forgetNetworkFixtureRetirement(path, sessionId);
          if (failure !== undefined) {
            throw failure;
          }
          return;
        }
        if (completedRetirement?.durable === true) {
          this.consumeNetworkFixtureRetirement(path, sessionId, mutations);
          terminalDispose = { failure: undefined };
          this.forgetNetworkFixtureRetirement(path, sessionId);
          return;
        }
        mutations.seal();

        const deadline = Date.now() + NETWORK_FIXTURE_CONTROLLER_LIFECYCLE_DEADLINE_MS;
        const mutationsSettled = await mutations
          .waitForSettled(deadline)
          .then(() => true)
          .catch(() => false);

        let supervisionFailure = controller.failureReason;
        const completion = await controller.stop().catch((error: unknown) => {
          supervisionFailure ??= asError(
            error,
            'The trusted profile network fixture controller did not stop.',
          );
          return undefined;
        });
        supervisionFailure ??= controller.failureReason;
        const controllerExited =
          controllerPgid === undefined
            ? false
            : await waitForProcessGroupExit(controllerPgid).catch(() => false);
        if (
          completion?.cleanupConfirmed === true &&
          completion.cleanupUncertain !== true &&
          controllerExited
        ) {
          if (!mutationsSettled) {
            throw new Error(
              'The trusted profile network fixture still owns a persistent mutation.',
            );
          }
          if (currentRecord?.qualificationOperation !== undefined) {
            throw new Error(
              'The trusted profile network fixture has an unresolved qualification container create.',
            );
          }
          await this.advanceNetworkFixtureRetirement(path, sessionId, mutations, deadline);
          this.consumeNetworkFixtureRetirement(path, sessionId, mutations);
          terminalDispose = { failure: supervisionFailure };
          this.forgetNetworkFixtureRetirement(path, sessionId);
          if (supervisionFailure !== undefined) {
            throw supervisionFailure;
          }
          return;
        }

        if (!mutationsSettled) {
          throw new Error('The trusted profile network fixture cleanup is unconfirmed.');
        }

        const recovered = await this.recoverNetworkFixtureRecord(path, true);
        if (recovered.status !== 'recovered') {
          throw new Error('The trusted profile network fixture cleanup is unconfirmed.');
        }
        await mutations.waitForSettled(deadline);
        terminalDispose = { failure: supervisionFailure };
        this.forgetNetworkFixtureRetirement(path, sessionId);
        if (supervisionFailure !== undefined) {
          throw supervisionFailure;
        }
      },
      failure: controller.failure,
      runQualificationWorkload: async (profile, imageId, argv, signal): Promise<string> => {
        if (currentRecord === undefined) {
          throw new Error('The trusted profile network fixture has no persistent intent.');
        }

        const updateQualificationOperation = async (
          qualificationOperation: NetworkFixtureQualificationOperation | undefined,
          exactContainerRemoved: boolean,
        ): Promise<void> => {
          const existingRecord = currentRecord;
          if (existingRecord === undefined) {
            throw new Error('The trusted profile network fixture has no persistent intent.');
          }
          const { qualificationOperation: _previousOperation, ...recordWithoutOperation } =
            existingRecord;
          const nextRecord: NetworkFixtureCleanupIntent =
            qualificationOperation === undefined
              ? recordWithoutOperation
              : { ...recordWithoutOperation, qualificationOperation };
          await persistRecord(
            nextRecord,
            async () => {
              await this.options.trustedTestHooks?.afterNetworkFixtureQualificationOperationRename?.(
                {
                  operation: qualificationOperation?.state ?? 'removed',
                  sessionId,
                },
              );
            },
            qualificationOperation === undefined && exactContainerRemoved,
          );
        };

        return runTrackedProfileWorkload(profile, imageId, argv, signal, {
          beforeCreate: async (operation) => {
            await updateQualificationOperation(operation, false);
          },
          confirmCreated: async (operation) => {
            await updateQualificationOperation(operation, false);
          },
          confirmRemoved: async (exactContainerRemoved) => {
            await updateQualificationOperation(undefined, exactContainerRemoved);
          },
        });
      },
    };
  }

  private networkFixtureRecordPath(sessionId: string): string {
    return join(this.options.ownerStorePath, `${NETWORK_FIXTURE_RECORD_PREFIX}${sessionId}.json`);
  }

  private networkFixtureMutationOwner(path: string): NetworkFixtureMutations {
    const existing = this.networkFixtureMutations.get(path);
    if (existing !== undefined) {
      return existing;
    }

    const mutations = new NetworkFixtureMutations();
    this.networkFixtureMutations.set(path, mutations);
    return mutations;
  }

  private networkFixtureRetirementOwner(path: string, sessionId: string): NetworkFixtureRetirement {
    const existing = this.networkFixtureRetirements.get(path);
    if (existing !== undefined) {
      if (existing.sessionId !== sessionId) {
        throw new Error('The trusted profile network fixture retirement identity does not match.');
      }
      return existing;
    }

    const retirement: NetworkFixtureRetirement = {
      consumed: false,
      durable: false,
      mutation: undefined,
      sessionId,
      unlinked: false,
    };
    this.networkFixtureRetirements.set(path, retirement);
    return retirement;
  }

  /**
   * A durable unlink is two steps: unlink followed by directory fsync. Keep
   * that exact session-bound stage in memory so a later explicit cleanup can
   * finish a late unlink rather than treating a missing file as proof.
   */
  private async advanceNetworkFixtureRetirement(
    path: string,
    sessionId: string,
    mutations: NetworkFixtureMutations,
    deadline: number,
    lease?: RecoveryLockLease,
  ): Promise<void> {
    const retirement = this.networkFixtureRetirementOwner(path, sessionId);
    if (retirement.durable) {
      return;
    }

    if (retirement.mutation !== undefined) {
      await withinCleanupDeadlineAt(retirement.mutation, deadline);
      if (retirement.durable) {
        return;
      }
    }

    const retireRecord = retirement.unlinked
      ? () => syncContainingDirectory(path)
      : () =>
          unlinkDurably(path, false, async () => {
            retirement.unlinked = true;
            await this.options.trustedTestHooks?.afterNetworkFixtureRecordUnlinkBeforeDirectorySync?.(
              {
                sessionId,
              },
            );
          });
    const mutation = mutations.retire(deadline, () => {
      if (lease === undefined) {
        return retireRecord();
      }
      return startPersistentMutationBeforeDeadline(lease, deadline, retireRecord).mutation;
    }).mutation;
    retirement.mutation = mutation;
    void mutation.then(
      () => {
        retirement.durable = true;
        retirement.mutation = undefined;
      },
      () => {
        retirement.mutation = undefined;
      },
    );

    await withinCleanupDeadlineAt(mutation, deadline);
    if (!retirement.durable) {
      throw new Error('The trusted profile network fixture retirement is incomplete.');
    }
  }

  private consumeNetworkFixtureRetirement(
    path: string,
    sessionId: string,
    mutations: NetworkFixtureMutations,
  ): void {
    const retirement = this.networkFixtureRetirements.get(path);
    if (retirement === undefined || retirement.sessionId !== sessionId || !retirement.durable) {
      throw new Error('The trusted profile network fixture retirement is incomplete.');
    }

    if (retirement.consumed) {
      return;
    }

    mutations.release();
    this.networkFixtureMutations.delete(path);
    retirement.consumed = true;
  }

  private forgetNetworkFixtureRetirement(path: string, sessionId: string): void {
    const retirement = this.networkFixtureRetirements.get(path);
    if (retirement !== undefined && retirement.sessionId === sessionId && retirement.consumed) {
      this.networkFixtureRetirements.delete(path);
    }
  }

  private async recoverNetworkFixtureRecord(
    path: string,
    allowLiveParent: boolean,
    existingLease?: RecoveryLockLease,
  ): Promise<{ status: SandboxRecoveryRecordStatus }> {
    if (existingLease !== undefined) {
      return this.recoverNetworkFixtureRecordWithLease(path, allowLiveParent, existingLease);
    }

    const lease = await acquireRecoveryLock(this.options.ownerStorePath);
    if (lease === undefined) {
      return { status: 'network-unknown' };
    }

    try {
      return await this.recoverNetworkFixtureRecordWithLease(path, allowLiveParent, lease);
    } finally {
      await releaseRecoveryLock(lease);
    }
  }

  private async recoverNetworkFixtureRecordWithLease(
    path: string,
    allowLiveParent: boolean,
    lease: RecoveryLockLease,
  ): Promise<{ status: SandboxRecoveryRecordStatus }> {
    const pendingRetirement = this.networkFixtureRetirements.get(path);
    if (pendingRetirement !== undefined) {
      if (pendingRetirement.consumed) {
        return { status: 'recovered' };
      }
      const mutations = this.networkFixtureMutationOwner(path);
      const deadline = Date.now() + NETWORK_FIXTURE_CONTROLLER_LIFECYCLE_DEADLINE_MS;
      try {
        await this.advanceNetworkFixtureRetirement(
          path,
          pendingRetirement.sessionId,
          mutations,
          deadline,
          lease,
        );
        this.consumeNetworkFixtureRetirement(path, pendingRetirement.sessionId, mutations);
        return { status: 'recovered' };
      } catch {
        return { status: 'network-unknown' };
      }
    }

    let record: NetworkFixtureCleanupRecord;
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
        return { status: 'invalid' };
      }
      record = parseNetworkFixtureCleanupRecord(await readFile(path, 'utf8'));
      if (!this.isAuthenticNetworkFixtureRecord(record)) {
        return { status: 'invalid' };
      }
    } catch {
      return { status: 'invalid' };
    }

    if (record.hostBootId !== (await readTrustedBootId())) {
      return { status: 'host-identity-mismatch' };
    }
    try {
      if (await isLiveProcess(record.controller)) {
        return { status: 'network-controller-live' };
      }
      if (await isLiveProcessGroup(record.controllerPgid)) {
        return { status: 'network-control-group-live' };
      }
    } catch {
      // The controller group could still contain a late privileged command.
      // Do not reclaim its authenticated record when /proc cannot establish
      // that the original group has actually exited.
      return { status: 'network-unknown' };
    }
    try {
      const currentParent = await processIdentity(process.pid);
      const parentMatchesCurrentProcess =
        record.parent.pid === currentParent.pid && record.parent.start === currentParent.start;
      if (allowLiveParent && !parentMatchesCurrentProcess) {
        return { status: 'parent-live' };
      }
      if (!allowLiveParent && (await isLiveProcess(record.parent))) {
        return { status: 'parent-live' };
      }
    } catch {
      return { status: 'network-unknown' };
    }

    if (record.recoveryWriter !== undefined && record.recoveryWriterPgid !== undefined) {
      try {
        if (await isLiveProcess(record.recoveryWriter)) {
          return { status: 'network-recovery-writer-live' };
        }
        if (await isLiveProcessGroup(record.recoveryWriterPgid)) {
          return { status: 'network-recovery-writer-group-live' };
        }
      } catch {
        return { status: 'network-unknown' };
      }
    }

    return this.recoverNetworkFixtureWithWriter(path, record, lease);
  }

  private async recoverNetworkFixtureWithWriter(
    path: string,
    record: NetworkFixtureCleanupRecord,
    lease: RecoveryLockLease,
  ): Promise<{ status: SandboxRecoveryRecordStatus }> {
    let writer: ProfileNetworkFixtureController | undefined;
    let writerPgid: number | undefined;
    const deadline = Date.now() + NETWORK_FIXTURE_CONTROLLER_LIFECYCLE_DEADLINE_MS;
    const mutations = this.networkFixtureMutationOwner(path);
    // Recovery is cleanup-only.  It may add a writer receipt or retire an
    // authenticated record, but it cannot authorize a new qualification
    // workload after this point.
    mutations.seal();

    try {
      writer = new ProfileNetworkFixtureController(
        this.options.trustedTestHooks?.forkNetworkFixtureController,
      );
      const [writerIdentity, observedWriterPgid, writerBootId] = await Promise.all([
        processIdentity(writer.pid),
        readProcessGroupId(writer.pid),
        readTrustedBootId(),
      ]);
      if (!isKnownProcessIdentity(writerIdentity) || writerBootId !== record.hostBootId) {
        throw new Error('The trusted profile network recovery writer identity is unavailable.');
      }

      writerPgid = observedWriterPgid;
      const { authenticationTag: _authenticationTag, ...existingIntent } = record;
      const upgradedIntent: NetworkFixtureCleanupIntent = {
        ...existingIntent,
        recoveryWriter: writerIdentity,
        recoveryWriterPgid: observedWriterPgid,
        version: NETWORK_FIXTURE_RECORD_VERSION,
      };
      const registration = mutations.retire(deadline, () => {
        const persistentWrite = startPersistentMutationBeforeDeadline(lease, deadline, () =>
          this.writeAuthenticatedNetworkFixtureRecord(path, upgradedIntent, async () => {
            await this.options.trustedTestHooks?.afterNetworkFixtureRecoveryWriterRename?.({
              sessionId: record.sessionId,
            });
          }),
        );
        return persistentWrite.mutation;
      });
      await registration.result;

      if (Date.now() >= deadline) {
        throw new Error('The trusted profile network fixture cleanup timed out.');
      }
      const completion = await writer.cleanup(record.interfaceName, record.marker);
      const writerExited = await waitForProcessGroupExit(observedWriterPgid);
      if (!writerExited) {
        return { status: 'network-recovery-writer-group-live' };
      }
      if (completion.cleanupConfirmed && !completion.cleanupUncertain) {
        if (record.qualificationOperation !== undefined) {
          // The cleanup-only writer has proved that this exact dummy fixture
          // is gone, but it has no authority to decide whether a prior Docker
          // create might still materialize. Keep the authenticated record and
          // its occupancy until the original qualification operation has a
          // separate exact resolution.
          return { status: 'network-qualification-unknown' };
        }
        await this.advanceNetworkFixtureRetirement(
          path,
          record.sessionId,
          mutations,
          deadline,
          lease,
        );
        this.consumeNetworkFixtureRetirement(path, record.sessionId, mutations);
        return { status: 'recovered' };
      }
      return { status: 'network-unknown' };
    } catch {
      if (writer !== undefined) {
        await writer.stop().catch(() => undefined);
        if (writerPgid !== undefined) {
          await waitForProcessGroupExit(writerPgid).catch(() => false);
        }
      }
      return { status: 'network-unknown' };
    }
  }

  private isAuthenticNetworkFixtureRecord(record: NetworkFixtureCleanupRecord): boolean {
    const expected = this.networkFixtureAuthenticationTag(record);
    const provided = Buffer.from(record.authenticationTag, 'hex');
    const expectedBytes = Buffer.from(expected, 'hex');
    return (
      provided.byteLength === expectedBytes.byteLength && timingSafeEqual(provided, expectedBytes)
    );
  }

  private networkFixtureAuthenticationTag(record: NetworkFixtureCleanupIntent): string {
    if (this.journalKey === undefined) {
      throw new Error('The cleanup journal key is unavailable.');
    }
    return createHmac('sha256', this.journalKey)
      .update(JSON.stringify(networkFixtureCleanupPayload(record)))
      .digest('hex');
  }

  private async writeAuthenticatedNetworkFixtureRecord(
    path: string,
    record: NetworkFixtureCleanupIntent,
    afterRename?: () => Promise<void>,
  ): Promise<void> {
    await writeAtomicJson(
      path,
      {
        ...record,
        authenticationTag: this.networkFixtureAuthenticationTag(record),
      },
      undefined,
      afterRename,
    );
  }

  private reserveSandbox(sandbox: SandboxInstance, memoryMiB: number): void {
    const nextCount = this.activeSandboxCount + 1;
    const nextMemoryMiB = this.reservedMemoryMiB + memoryMiB;

    if (nextCount > 2 || nextMemoryMiB > 1536) {
      throw new Error('The trusted sandbox manager has no remaining qualified resource budget.');
    }

    this.activeSandboxCount = nextCount;
    this.reservedMemoryMiB = nextMemoryMiB;
    this.reservations.set(sandbox, memoryMiB);
  }

  private releaseSandbox(sandbox: SandboxInstance): void {
    const memoryMiB = this.reservations.get(sandbox);
    if (memoryMiB === undefined) {
      return;
    }

    this.activeSandboxCount -= 1;
    this.reservedMemoryMiB -= memoryMiB;
    this.reservations.delete(sandbox);
  }

  private retireSandbox(sandbox: SandboxInstance): void {
    this.retiredSandboxes.add(sandbox);
  }

  private async ensureOwnerStore(): Promise<void> {
    await mkdir(this.options.ownerStorePath, { mode: 0o700, recursive: true });
    await chmod(this.options.ownerStorePath, 0o700);
    const metadata = await stat(this.options.ownerStorePath);
    if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
      throw new Error('The sandbox cleanup store must be a private 0700 directory.');
    }
    this.journalKey ??= await readOrCreateJournalKey(this.options.ownerStorePath);
  }

  private journalPathFor(sessionId: string): string {
    return join(this.options.ownerStorePath, `${sessionId}.json`);
  }

  private creationReceiptPathFor(sessionId: string): string {
    return join(this.options.ownerStorePath, `${CREATE_RECEIPT_PREFIX}${sessionId}.json`);
  }

  private requireJournalKey(): Buffer {
    if (this.journalKey === undefined) {
      throw new Error('The cleanup journal key is unavailable.');
    }
    return Buffer.from(this.journalKey);
  }

  private async writeIntent(path: string, journal: CleanupJournalIntent): Promise<void> {
    await this.writeAuthenticatedJournal(path, journal);
  }

  private async updateJournalContainerId(path: string, containerId: string): Promise<void> {
    const journal = parseCleanupJournal(await readFile(path, 'utf8'));
    if (!this.isAuthenticJournal(journal)) {
      throw new Error('The cleanup journal authentication tag is invalid.');
    }
    const { authenticationTag: _authenticationTag, ...intent } = journal;
    await this.writeAuthenticatedJournal(path, { ...intent, containerId });
  }

  private async updateJournalCreationAuthorization(
    path: string,
    creationAuthorization: 'not-authorized' | 'possibly-submitted',
    beforeRename?: () => Promise<void>,
  ): Promise<void> {
    const journal = parseCleanupJournal(await readFile(path, 'utf8'));
    if (journal.version !== CLEANUP_JOURNAL_VERSION || !this.isAuthenticJournal(journal)) {
      throw new Error('The cleanup journal cannot authorize this create request.');
    }
    const { authenticationTag: _authenticationTag, ...intent } = journal;
    await this.writeAuthenticatedJournal(path, { ...intent, creationAuthorization }, beforeRename);
  }

  private async abortStartingExecution(
    sandbox: SandboxInstance,
    guardian: SandboxGuardianClient,
    guardianIdentity: ProcessIdentity | undefined,
    guardianPgid: number | undefined,
    journalPath?: string,
    journalMayBeAbsent = false,
    cleanupDeadline = Date.now() + STOP_CLEANUP_DEADLINE_MS,
  ): Promise<SandboxCleanupEvidence> {
    try {
      await this.stopGuardianAndAwait(guardian, 'stopped', guardian.completion, cleanupDeadline);
      if (
        guardianIdentity === undefined ||
        guardianPgid === undefined ||
        !(await waitForGuardianAndGroupExitAt(guardianIdentity, guardianPgid, cleanupDeadline))
      ) {
        this.retireSandbox(sandbox);
        return unknownCleanup();
      }
    } catch {
      this.retireSandbox(sandbox);
      return unknownCleanup();
    }

    if (journalPath === undefined) {
      this.releaseSandbox(sandbox);
      return confirmedCleanup();
    }

    try {
      const journalIsDefinitelyMissing =
        journalMayBeAbsent &&
        (await invokeWithinCleanupDeadlineAt(cleanupDeadline, () =>
          isDefinitelyMissingPath(journalPath),
        ));
      if (journalIsDefinitelyMissing) {
        this.pendingCleanup.delete(sandbox);
        this.releaseSandbox(sandbox);
        return confirmedCleanup();
      }

      const recovered = await this.recoverAndRelease(sandbox, journalPath, true, cleanupDeadline);
      if (recovered) {
        return confirmedCleanup();
      }
    } catch {
      // The initial stop owns one absolute deadline. A read, SQLite lease, or
      // retirement that outlives it keeps the record and reservation for an
      // explicit later recovery rather than beginning another cleanup window.
    }

    this.retireSandbox(sandbox);
    return unknownCleanup();
  }

  private cleanupStartingExecution(
    sandbox: SandboxInstance,
    starting: StartingExecution,
  ): Promise<SandboxCleanupEvidence> {
    if (starting.cleanup !== undefined) {
      return starting.cleanup;
    }

    const cleanup = (async (): Promise<SandboxCleanupEvidence> => {
      const cleanupDeadline = Date.now() + STOP_CLEANUP_DEADLINE_MS;
      const guardian = starting.guardian;
      if (guardian === undefined) {
        if (starting.reservationHeld || this.reservations.has(sandbox)) {
          this.releaseSandbox(sandbox);
          starting.reservationHeld = false;
        }
        return confirmedCleanup();
      }

      let journalSettled = true;
      if (starting.journal !== undefined) {
        try {
          await withinCleanupDeadlineAt(starting.journal.finish(), cleanupDeadline);
        } catch {
          journalSettled = false;
        }
      }

      if (!journalSettled) {
        await this.stopGuardianAndAwait(
          guardian,
          'stopped',
          guardian.completion,
          cleanupDeadline,
        ).catch(() => undefined);
        this.retireSandbox(sandbox);
        return unknownCleanup();
      }

      const evidence = await this.abortStartingExecution(
        sandbox,
        guardian,
        starting.guardianIdentity,
        starting.guardianPgid,
        starting.journalPath,
        !starting.intentWriteStarted,
        cleanupDeadline,
      );
      if (evidence.cleanupConfirmed) {
        starting.reservationHeld = false;
      } else {
        this.retireSandbox(sandbox);
      }
      return evidence;
    })();
    starting.cleanup = cleanup;
    void cleanup.then(
      (evidence) => {
        starting.settleCleanup(evidence);
        if (!evidence.cleanupConfirmed) {
          starting.cleanup = undefined;
        }
      },
      () => {
        starting.settleCleanup(unknownCleanup());
        starting.cleanup = undefined;
      },
    );
    return cleanup;
  }

  private async cleanupStartupAfterFence(
    sandbox: SandboxInstance,
    starting: StartingExecution,
  ): Promise<SandboxCleanupEvidence> {
    if (starting.stopRequested) {
      return starting.settle;
    }

    return this.cleanupStartingExecution(sandbox, starting);
  }

  private async stopGuardianAndAwait(
    guardian: SandboxGuardianClient,
    reason: 'output-limit' | 'stopped',
    completion: Promise<SandboxExecutionCompletion> = guardian.completion,
    cleanupDeadline = Date.now() + STOP_CLEANUP_DEADLINE_MS,
  ): Promise<SandboxExecutionCompletion> {
    return withinCleanupDeadlineAt(
      (async () => {
        await guardian.stop(reason);
        return completion;
      })(),
      cleanupDeadline,
    );
  }

  private async confirmCleanup(
    sandbox: SandboxInstance,
    journalPath: string,
    journal: SerializedJournalUpdates,
  ): Promise<boolean> {
    await journal.finish();
    if (journal.failed !== undefined) {
      this.retireSandbox(sandbox);
      return false;
    }

    try {
      const durableJournal = parseCleanupJournal(await readFile(journalPath, 'utf8'));
      if (
        durableJournal.version !== CLEANUP_JOURNAL_VERSION ||
        durableJournal.guardianPgid === undefined ||
        !(await waitForRecordedProcessExit(durableJournal.guardian))
      ) {
        this.retireSandbox(sandbox);
        return false;
      }
    } catch {
      this.retireSandbox(sandbox);
      return false;
    }

    // A closed IPC message is not enough to retire a create journal. The
    // guardian may have sent it before its inherited Docker clients leave the
    // recorded group. Recovery re-reads the durable record under the SQLite
    // lease and requires either not-authorized proof or a valid create receipt.
    const outcome = await this.withRecoveryLock(async (lease) =>
      this.recoverOwnedJournal(journalPath, true, lease, sandbox),
    );
    if (outcome?.status === 'recovered') {
      this.pendingCleanup.delete(sandbox);
      this.releaseSandbox(sandbox);
      return true;
    }
    this.retireSandbox(sandbox);
    return false;
  }

  private async recoverAndRelease(
    sandbox: SandboxInstance,
    journalPath: string,
    allowLiveParent: boolean,
    deadline = Date.now() + STOP_CLEANUP_DEADLINE_MS,
  ): Promise<boolean> {
    let outcome: { status: SandboxRecoveryRecordStatus } | undefined;
    try {
      outcome = await this.withRecoveryLock(
        async (lease) =>
          this.recoverOwnedJournal(journalPath, allowLiveParent, lease, sandbox, deadline),
        deadline,
      );
    } catch {
      return false;
    }
    if (outcome?.status === 'recovered') {
      this.pendingCleanup.delete(sandbox);
      this.releaseSandbox(sandbox);
    }
    return outcome?.status === 'recovered';
  }

  private async withRecoveryLock<T>(
    action: (lease: RecoveryLockLease) => Promise<T>,
    deadline?: number,
  ): Promise<T | undefined> {
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error(CLEANUP_DEADLINE_ERROR);
    }

    const acquisition = acquireRecoveryLock(
      this.options.ownerStorePath,
      this.options.trustedTestHooks?.beforeRecoveryLockLeaseReturn,
    );
    let deadlineClosed = false;
    const lateAcquisitionRelease = acquisition.then(async (lateLease) => {
      if (lateLease === undefined || !deadlineClosed) {
        return;
      }

      // A deadline can settle before chmod/stat complete inside acquisition.
      // The resulting SQLite transaction is owned only by this observer: it
      // releases the exact lease and never enters recovery, Docker, or journal
      // retirement work after the original caller has returned unknown.
      await releaseRecoveryLock(lateLease);
      await this.options.trustedTestHooks?.afterTimedOutRecoveryLeaseReleased?.();
    });
    void lateAcquisitionRelease.catch(() => undefined);

    let lease: RecoveryLockLease | undefined;
    try {
      lease =
        deadline === undefined
          ? await acquisition
          : await withinCleanupDeadlineAt(acquisition, deadline);
    } catch (error) {
      if (deadline !== undefined && isCleanupDeadlineError(error)) {
        deadlineClosed = true;
      }
      throw error;
    }
    if (lease === undefined) {
      return undefined;
    }

    try {
      return await action(lease);
    } finally {
      await releaseRecoveryLock(lease);
    }
  }

  private async recoverOwnedJournal(
    path: string,
    allowLiveParent: boolean,
    lease: RecoveryLockLease,
    sandbox?: SandboxInstance,
    deadline = Date.now() + STOP_CLEANUP_DEADLINE_MS,
  ): Promise<{ status: SandboxRecoveryRecordStatus }> {
    const lateRetirement = await this.resumeLateExecutionRetirement(path, lease, deadline);
    if (lateRetirement !== undefined) {
      return lateRetirement;
    }

    let journal: CleanupJournal;
    try {
      journal = await invokeWithinCleanupDeadlineAt(deadline, async () => {
        const metadata = await stat(path);
        if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
          throw new Error('The sandbox cleanup journal metadata is invalid.');
        }
        const parsed = parseCleanupJournal(await readFile(path, 'utf8'));
        if (!this.isAuthenticJournal(parsed)) {
          throw new Error('The sandbox cleanup journal authentication tag is invalid.');
        }
        return parsed;
      });
    } catch (error) {
      if (isCleanupDeadlineError(error)) {
        return { status: 'docker-unknown' };
      }
      // A damaged, future, or forged record remains fail-closed for manual review.
      return { status: 'invalid' };
    }

    let currentBootId: string;
    try {
      currentBootId = await invokeWithinCleanupDeadlineAt(deadline, () => readTrustedBootId());
    } catch {
      return { status: 'docker-unknown' };
    }
    if (journal.hostBootId !== currentBootId) {
      return { status: 'host-identity-mismatch' };
    }

    // A v2 record authenticated a different payload and did not retain the
    // guardian process group, create authorization state, or success proof.
    // It remains visible to a trusted operator rather than being upgraded by
    // inference and accidentally authorizing a late Docker effect.
    if (journal.version !== CLEANUP_JOURNAL_VERSION) {
      return { status: 'creation-unknown' };
    }

    try {
      if (await invokeWithinCleanupDeadlineAt(deadline, () => isLiveProcess(journal.guardian))) {
        return { status: 'guardian-live' };
      }

      if (allowLiveParent) {
        const currentParent = await invokeWithinCleanupDeadlineAt(deadline, () =>
          processIdentity(process.pid),
        );
        if (
          journal.ownerId !== this.ownerId ||
          journal.parent.pid !== currentParent.pid ||
          journal.parent.start !== currentParent.start
        ) {
          return { status: 'parent-live' };
        }
      } else if (
        await invokeWithinCleanupDeadlineAt(deadline, () => isLiveProcess(journal.parent))
      ) {
        return { status: 'parent-live' };
      }
    } catch {
      return { status: 'docker-unknown' };
    }

    if (journal.recoveryWriter !== undefined && journal.recoveryWriterPgid !== undefined) {
      try {
        if (
          await invokeWithinCleanupDeadlineAt(deadline, () =>
            isLiveProcess(journal.recoveryWriter as ProcessIdentity),
          )
        ) {
          return { status: 'recovery-writer-live' };
        }
        if (
          await invokeWithinCleanupDeadlineAt(deadline, () =>
            isLiveProcessGroup(journal.recoveryWriterPgid as number),
          )
        ) {
          return { status: 'recovery-writer-group-live' };
        }
      } catch {
        return { status: 'docker-unknown' };
      }
    }

    if (journal.creationAuthorization === 'not-authorized') {
      if (
        journal.guardianPgid === undefined ||
        (await invokeWithinCleanupDeadlineAt(deadline, () =>
          isLiveProcessGroup(journal.guardianPgid as number),
        ))
      ) {
        return { status: 'control-group-live' };
      }
      return this.retireJournalAfterConfirmedNoCreate(path, journal, lease, sandbox, deadline);
    }

    const hasCreateReceipt = await this.hasAuthenticCreateReceipt(journal, deadline);
    if (!hasCreateReceipt) {
      // A possibly-submitted request lacks durable proof of a completed Docker
      // create. Do not kill its still-live client group or infer daemon
      // cancellation from a temporary absence; retain the evidence until a
      // trusted operator can establish the request's terminal outcome.
      try {
        if (journal.guardianPgid !== undefined) {
          await invokeWithinCleanupDeadlineAt(deadline, () =>
            isLiveProcessGroup(journal.guardianPgid as number),
          );
        }
      } catch {
        return { status: 'docker-unknown' };
      }
      return { status: 'creation-unknown' };
    }

    // A numeric process-group ID can be reused after the recorded guardian
    // exits. It is evidence to observe after exact container removal, never
    // authority to signal an arbitrary current group.
    return this.recoverOwnedJournalWithWriter(path, journal, lease, sandbox, deadline);
  }

  private async retireJournalAfterConfirmedNoCreate(
    path: string,
    journal: CleanupJournal,
    lease: RecoveryLockLease,
    sandbox?: SandboxInstance,
    deadline = Date.now() + STOP_CLEANUP_DEADLINE_MS,
  ): Promise<{ status: SandboxRecoveryRecordStatus }> {
    try {
      await this.retireExecutionJournal(path, journal, true, lease, deadline, sandbox);
      return { status: 'recovered' };
    } catch {
      return { status: 'docker-unknown' };
    }
  }

  private async recoverOwnedJournalWithWriter(
    path: string,
    journal: CleanupJournal,
    lease: RecoveryLockLease,
    sandbox?: SandboxInstance,
    cleanupDeadline = Date.now() + STOP_CLEANUP_DEADLINE_MS,
  ): Promise<{ status: SandboxRecoveryRecordStatus }> {
    let writer: SandboxGuardianClient | undefined;
    let writerPgid: number | undefined;
    try {
      if (Date.now() >= cleanupDeadline) {
        return { status: 'docker-unknown' };
      }
      const cleanupWriter = new SandboxGuardianClient(
        this.options.trustedTestHooks?.guardianWorkerPath === undefined
          ? undefined
          : { workerPath: this.options.trustedTestHooks.guardianWorkerPath() },
      );
      writer = cleanupWriter;
      const [observedWriterIdentity, observedWriterPgid, writerBootId] =
        await invokeWithinCleanupDeadlineAt(cleanupDeadline, () =>
          Promise.all([
            processIdentity(cleanupWriter.pid),
            cleanupWriter.pid === undefined
              ? Promise.resolve(-1)
              : readProcessGroupId(cleanupWriter.pid),
            readTrustedBootId(),
          ]),
        );
      if (
        !isKnownProcessIdentity(observedWriterIdentity) ||
        observedWriterIdentity.start === null ||
        observedWriterPgid < 1 ||
        writerBootId !== journal.hostBootId
      ) {
        throw new Error('The cleanup-only guardian identity is unavailable.');
      }

      writerPgid = observedWriterPgid;
      const { authenticationTag: _authenticationTag, ...intent } = journal;
      const writerRegistration = startPersistentMutationBeforeDeadline(lease, cleanupDeadline, () =>
        this.writeAuthenticatedJournal(
          path,
          {
            ...intent,
            recoveryWriter: observedWriterIdentity,
            recoveryWriterPgid: observedWriterPgid,
          },
          async () => {
            await this.options.trustedTestHooks?.beforeRecoveryWriterPersist?.({
              sessionId: journal.sessionId,
            });
          },
        ),
      );
      try {
        await writerRegistration.result;
      } catch {
        // No cleanup IPC has been sent before registration completes. Once its
        // non-cancellable rename settles, only this exact, start-verified idle
        // worker may be terminated; a stale numeric process group is never
        // used as termination authority.
        this.scheduleIdleRecoveryWriterTermination(
          cleanupWriter,
          observedWriterIdentity,
          observedWriterPgid,
          journal.sessionId,
          writerRegistration.mutation,
        );
        return { status: 'docker-unknown' };
      }

      let completion: Awaited<ReturnType<SandboxGuardianClient['cleanup']>>;
      try {
        completion = await invokeWithinCleanupDeadlineAt(cleanupDeadline, () =>
          cleanupWriter.cleanup({
            containerName: journal.containerName,
            imageId: journal.imageId,
            labels: journal.labels,
            ...(journal.containerId === undefined ? {} : { knownContainerId: journal.containerId }),
          }),
        );
      } catch {
        await invokeWithinCleanupDeadlineAt(cleanupDeadline, () =>
          cleanupWriter.stop('stopped'),
        ).catch(() => undefined);
        const writerExited = await waitForProcessGroupExitAt(
          observedWriterPgid,
          cleanupDeadline,
        ).catch(() => false);
        return {
          status: writerExited ? 'docker-unknown' : 'recovery-writer-group-live',
        };
      }

      const [guardianGroupExited, writerGroupExited] = await invokeWithinCleanupDeadlineAt(
        cleanupDeadline,
        () =>
          Promise.all([
            waitForProcessGroupExitAt(journal.guardianPgid as number, cleanupDeadline),
            waitForProcessGroupExitAt(observedWriterPgid, cleanupDeadline),
          ]),
      ).catch(() => [false, false] as const);
      if (!guardianGroupExited) {
        return { status: 'control-group-live' };
      }
      if (!writerGroupExited) {
        return { status: 'recovery-writer-group-live' };
      }
      if (!completion.cleanupConfirmed) {
        return { status: 'remove-failed' };
      }

      // Keep the create proof until the execution journal has been removed
      // and its parent directory has been flushed. A crash between these two
      // operations leaves an inert receipt instead of an executable journal
      // that has lost its evidence of a completed create.
      await this.retireExecutionJournal(path, journal, false, lease, cleanupDeadline, sandbox);
      return { status: 'recovered' };
    } catch {
      if (writer !== undefined) {
        const existingWriter = writer;
        await invokeWithinCleanupDeadlineAt(cleanupDeadline, () =>
          existingWriter.stop('stopped'),
        ).catch(() => undefined);
      }
      if (writerPgid !== undefined) {
        await waitForProcessGroupExitAt(writerPgid, cleanupDeadline).catch(() => false);
      }
      return { status: 'docker-unknown' };
    }
  }

  private async retireExecutionJournal(
    path: string,
    journal: CleanupJournal,
    receiptMayBeMissing: boolean,
    lease: RecoveryLockLease,
    deadline: number,
    sandbox?: SandboxInstance,
  ): Promise<void> {
    const retirement = this.getOrCreateLateExecutionRetirement(
      path,
      journal,
      receiptMayBeMissing,
      sandbox,
    );

    try {
      await this.advanceExecutionRetirement(retirement, lease, deadline);
      this.lateExecutionRetirements.delete(path);
    } catch (error) {
      // The durable cleanup proof remains associated with this exact execution
      // until an explicit later recovery observes every started persistence
      // step. A deadline never authorizes background retirement steps.
      this.lateExecutionRetirements.set(path, retirement);
      throw error;
    }
  }

  private async resumeLateExecutionRetirement(
    path: string,
    lease: RecoveryLockLease,
    deadline = Date.now() + STOP_CLEANUP_DEADLINE_MS,
  ): Promise<{ status: SandboxRecoveryRecordStatus } | undefined> {
    const retirement = this.lateExecutionRetirements.get(path);
    if (retirement === undefined) {
      return undefined;
    }

    try {
      await this.advanceExecutionRetirement(retirement, lease, deadline);
      this.consumeLateExecutionRetirement(path, retirement);
      return { status: 'recovered' };
    } catch {
      return { status: 'docker-unknown' };
    }
  }

  private getOrCreateLateExecutionRetirement(
    path: string,
    journal: CleanupJournal,
    receiptMayBeMissing: boolean,
    sandbox: SandboxInstance | undefined,
  ): LateExecutionRetirement {
    const existing = this.lateExecutionRetirements.get(path);
    if (existing !== undefined) {
      if (existing.sandbox === undefined && sandbox !== undefined) {
        existing.sandbox = sandbox;
      }
      return existing;
    }

    const retirement: LateExecutionRetirement = {
      cleanupProven: true,
      journal,
      journalPath: path,
      journalDurable: false,
      journalMutation: undefined,
      journalUnlinked: false,
      receiptMayBeMissing,
      receiptDurable: false,
      receiptMutation: undefined,
      receiptUnlinked: false,
      ...(sandbox === undefined ? {} : { sandbox }),
    };
    this.lateExecutionRetirements.set(path, retirement);
    return retirement;
  }

  private async advanceExecutionRetirement(
    retirement: LateExecutionRetirement,
    lease: RecoveryLockLease,
    deadline: number,
  ): Promise<void> {
    if (!retirement.cleanupProven) {
      throw new Error('The sandbox execution has no trusted cleanup proof.');
    }

    if (!retirement.journalDurable) {
      await this.advanceRetirementJournal(retirement, lease, deadline);
      await invokeWithinCleanupDeadlineAt(deadline, async () => {
        await this.options.trustedTestHooks?.afterExecutionJournalRetired?.({
          sessionId: retirement.journal.sessionId,
        });
      });
    }

    if (!retirement.receiptDurable) {
      if (
        !retirement.receiptMayBeMissing &&
        !retirement.receiptUnlinked &&
        !(await this.hasAuthenticCreateReceipt(retirement.journal, deadline))
      ) {
        throw new Error('The sandbox create receipt is unavailable for retirement.');
      }
      await this.advanceRetirementReceipt(retirement, lease, deadline);
    }
  }

  private async advanceRetirementJournal(
    retirement: LateExecutionRetirement,
    lease: RecoveryLockLease,
    deadline: number,
  ): Promise<void> {
    if (retirement.journalMutation !== undefined) {
      await invokeWithinCleanupDeadlineAt(
        deadline,
        () => retirement.journalMutation as Promise<void>,
      );
      return;
    }

    if (retirement.journalUnlinked) {
      this.beginJournalDirectorySync(retirement, lease, deadline);
    } else {
      this.beginJournalUnlink(retirement, lease, deadline);
    }

    await invokeWithinCleanupDeadlineAt(
      deadline,
      () => retirement.journalMutation as Promise<void>,
    );
  }

  private beginJournalUnlink(
    retirement: LateExecutionRetirement,
    lease: RecoveryLockLease,
    deadline: number,
  ): void {
    const mutation = startPersistentMutationBeforeDeadline(lease, deadline, () =>
      unlinkDurably(retirement.journalPath, false, async () => {
        retirement.journalUnlinked = true;
        await this.options.trustedTestHooks?.afterExecutionJournalUnlinkBeforeDirectorySync?.({
          sessionId: retirement.journal.sessionId,
        });
      }),
    ).mutation;
    retirement.journalMutation = mutation;
    void mutation.then(
      () => {
        retirement.journalDurable = true;
        retirement.journalMutation = undefined;
      },
      () => {
        retirement.journalMutation = undefined;
      },
    );
  }

  private beginJournalDirectorySync(
    retirement: LateExecutionRetirement,
    lease: RecoveryLockLease,
    deadline: number,
  ): void {
    const mutation = startPersistentMutationBeforeDeadline(lease, deadline, () =>
      syncContainingDirectory(retirement.journalPath),
    ).mutation;
    retirement.journalMutation = mutation;
    void mutation.then(
      () => {
        retirement.journalDurable = true;
        retirement.journalMutation = undefined;
      },
      () => {
        retirement.journalMutation = undefined;
      },
    );
  }

  private async advanceRetirementReceipt(
    retirement: LateExecutionRetirement,
    lease: RecoveryLockLease,
    deadline: number,
  ): Promise<void> {
    if (retirement.receiptMutation !== undefined) {
      await invokeWithinCleanupDeadlineAt(
        deadline,
        () => retirement.receiptMutation as Promise<void>,
      );
      return;
    }

    if (retirement.receiptUnlinked) {
      this.beginReceiptDirectorySync(retirement, lease, deadline);
    } else {
      this.beginReceiptUnlink(retirement, lease, deadline);
    }

    await invokeWithinCleanupDeadlineAt(
      deadline,
      () => retirement.receiptMutation as Promise<void>,
    );
  }

  private beginReceiptUnlink(
    retirement: LateExecutionRetirement,
    lease: RecoveryLockLease,
    deadline: number,
  ): void {
    const receiptPath = this.creationReceiptPathFor(retirement.journal.sessionId);
    const mutation = startPersistentMutationBeforeDeadline(lease, deadline, () =>
      unlinkDurably(receiptPath, retirement.receiptMayBeMissing, async () => {
        retirement.receiptUnlinked = true;
        await this.options.trustedTestHooks?.afterExecutionReceiptUnlinkBeforeDirectorySync?.({
          sessionId: retirement.journal.sessionId,
        });
      }),
    ).mutation;
    retirement.receiptMutation = mutation;
    void mutation.then(
      () => {
        retirement.receiptDurable = true;
        retirement.receiptMutation = undefined;
      },
      () => {
        retirement.receiptMutation = undefined;
      },
    );
  }

  private beginReceiptDirectorySync(
    retirement: LateExecutionRetirement,
    lease: RecoveryLockLease,
    deadline: number,
  ): void {
    const receiptPath = this.creationReceiptPathFor(retirement.journal.sessionId);
    const mutation = startPersistentMutationBeforeDeadline(lease, deadline, () =>
      syncContainingDirectory(receiptPath),
    ).mutation;
    retirement.receiptMutation = mutation;
    void mutation.then(
      () => {
        retirement.receiptDurable = true;
        retirement.receiptMutation = undefined;
      },
      () => {
        retirement.receiptMutation = undefined;
      },
    );
  }

  private consumeLateExecutionRetirement(path: string, retirement: LateExecutionRetirement): void {
    const sandbox = retirement.sandbox;
    if (sandbox !== undefined) {
      // A successful late retirement is still bound to the original handle.
      // Retire it before returning its reservation so it cannot regain
      // execution authority during an explicit recovery call.
      this.retireSandbox(sandbox);
      this.pendingCleanup.delete(sandbox);
      this.releaseSandbox(sandbox);
    }
    this.lateExecutionRetirements.delete(path);
  }

  private scheduleIdleRecoveryWriterTermination(
    writerClient: SandboxGuardianClient,
    writer: ProcessIdentity,
    writerPgid: number,
    sessionId: string,
    registration: Promise<void>,
  ): void {
    void registration
      .then(
        () => this.terminateIdleRecoveryWriter(writerClient, writer, writerPgid, sessionId),
        () => this.terminateIdleRecoveryWriter(writerClient, writer, writerPgid, sessionId),
      )
      .catch(() => undefined);
  }

  private async terminateIdleRecoveryWriter(
    writerClient: SandboxGuardianClient,
    writer: ProcessIdentity,
    writerPgid: number,
    sessionId: string,
  ): Promise<void> {
    let exited = false;
    try {
      if (!(await isLiveProcess(writer))) {
        exited = !(await isLiveProcessGroup(writerPgid));
      } else {
        // The client still owns the exact ChildProcess created for this idle
        // writer. Its private IPC disconnect asks only that worker to leave
        // its no-Docker idle state; no persisted PID or process group gains
        // termination authority.
        writerClient.requestIdleWorkerExit();

        const deadline = Date.now() + STOP_CLEANUP_DEADLINE_MS;
        const processExited = await waitForRecordedProcessExitAt(writer, deadline);
        const groupExited = await waitForProcessGroupExitAt(writerPgid, deadline);
        exited = processExited && groupExited;
      }
    } catch {
      exited = false;
    }

    try {
      await this.options.trustedTestHooks?.afterIdleRecoveryWriterExit?.({ sessionId, exited });
    } catch {
      // Trusted test diagnostics cannot alter cleanup ownership.
    }
  }

  private isAuthenticJournal(journal: CleanupJournal): boolean {
    const expected = this.journalAuthenticationTag(journal);
    const provided = Buffer.from(journal.authenticationTag, 'hex');
    const expectedBytes = Buffer.from(expected, 'hex');
    return (
      provided.byteLength === expectedBytes.byteLength && timingSafeEqual(provided, expectedBytes)
    );
  }

  private async hasAuthenticCreateReceipt(
    journal: CleanupJournal,
    deadline?: number,
  ): Promise<boolean> {
    if (journal.version !== CLEANUP_JOURNAL_VERSION) {
      return false;
    }
    try {
      const path = this.creationReceiptPathFor(journal.sessionId);
      const receipt =
        deadline === undefined
          ? await this.readAuthenticCreateReceipt(path)
          : await invokeWithinCleanupDeadlineAt(deadline, () =>
              this.readAuthenticCreateReceipt(path),
            );
      if (receipt === undefined) {
        return false;
      }
      if (!this.isAuthenticCreateReceipt(receipt)) {
        return false;
      }
      return (
        receipt.sessionId === journal.sessionId &&
        receipt.containerName === journal.containerName &&
        receipt.hostBootId === journal.hostBootId &&
        receipt.guardian.pid === journal.guardian.pid &&
        receipt.guardian.start === journal.guardian.start
      );
    } catch {
      return false;
    }
  }

  private async readAuthenticCreateReceipt(path: string): Promise<CreateReceipt | undefined> {
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      return undefined;
    }
    return parseCreateReceipt(await readFile(path, 'utf8'));
  }

  private isAuthenticCreateReceipt(receipt: CreateReceipt): boolean {
    if (this.journalKey === undefined) {
      return false;
    }
    const expected = createHmac('sha256', this.journalKey)
      .update(JSON.stringify(createReceiptPayload(receipt)))
      .digest('hex');
    const provided = Buffer.from(receipt.authenticationTag, 'hex');
    const expectedBytes = Buffer.from(expected, 'hex');
    return (
      provided.byteLength === expectedBytes.byteLength && timingSafeEqual(provided, expectedBytes)
    );
  }

  private journalAuthenticationTag(journal: CleanupJournalIntent | CleanupJournal): string {
    if (this.journalKey === undefined) {
      throw new Error('The cleanup journal key is unavailable.');
    }
    return createHmac('sha256', this.journalKey)
      .update(JSON.stringify(cleanupJournalPayload(journal)))
      .digest('hex');
  }

  private async writeAuthenticatedJournal(
    path: string,
    journal: CleanupJournalIntent,
    beforeRename?: () => Promise<void>,
  ): Promise<void> {
    await writeAtomicJson(
      path,
      {
        ...journal,
        authenticationTag: this.journalAuthenticationTag(journal),
      },
      beforeRename,
    );
  }
}

function dockerArgumentsFor(
  profile: OfflineSandboxProfile,
  imageId: string,
  request: SandboxExecutionRequest,
  labels: Record<string, string>,
  qualificationIoMount?: QualificationIoMount,
): string[] {
  return [
    '--runtime',
    profile.runtime,
    '--network',
    profile.network,
    '--log-driver',
    'none',
    '--interactive',
    '--read-only',
    '--user',
    '65532:65532',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    `${profile.limits.memoryMiB}m`,
    '--memory-swap',
    `${profile.limits.memoryMiB}m`,
    '--cpus',
    `${profile.limits.cpu}`,
    '--pids-limit',
    `${profile.limits.hostPids}`,
    '--ulimit',
    `nproc=${profile.limits.guestNproc}:${profile.limits.guestNproc}`,
    '--ulimit',
    'core=0:0',
    '--device-read-bps',
    `/dev/vdb:${profile.limits.ioBytesPerSecond}`,
    '--device-write-bps',
    `/dev/vdb:${profile.limits.ioBytesPerSecond}`,
    '--tmpfs',
    `/tmp:rw,noexec,nosuid,nodev,size=${profile.limits.scratchMiB}m`,
    ...(qualificationIoMount === undefined
      ? []
      : [
          '--mount',
          `type=bind,src=${qualificationIoMount.sourcePath},dst=${qualificationIoMount.targetPath},readonly,bind-propagation=rprivate`,
        ]),
    '--shm-size',
    `${profile.limits.sharedMemoryMiB}m`,
    '--workdir',
    request.cwd,
    ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    ...Object.entries(request.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--entrypoint',
    request.executable,
    imageId,
    ...request.argv,
  ];
}

async function verifyProfileTuple(
  profile: OfflineSandboxProfile,
  imageId: string,
  legacyManager: DockerSandboxManager,
  createNetworkFixture: () => Promise<TrustedProfileNetworkFixture>,
  resources?: RuntimeResourceOps,
): Promise<void> {
  if (resources !== undefined) {
    await verifyManagedProfileTuple(profile, imageId, resources);
    return;
  }

  const controls = await runProfileWorkload(profile, imageId, [
    '-e',
    [
      "const fs = require('fs');",
      "let rootError = '';",
      "try { fs.writeFileSync('/opt/qdroid/root-write-control/t004-root-write', 'x'); } catch (error) { rootError = error.code; }",
      "const status = fs.readFileSync('/proc/self/status', 'utf8');",
      'process.stdout.write(JSON.stringify({',
      'nonRoot: process.getuid() !== 0 && process.getgid() !== 0,',
      'noNewPrivileges: /^NoNewPrivs:\\s*1$/m.test(status),',
      "rootReadOnly: rootError === 'EROFS'",
      '}));',
    ].join(' '),
  ]);
  const parsedControls = parseQualificationJson(controls, 'negative controls');
  if (
    parsedControls.nonRoot !== true ||
    parsedControls.noNewPrivileges !== true ||
    parsedControls.rootReadOnly !== true
  ) {
    throw new Error('The requested profile tuple did not enforce its negative controls.');
  }

  await verifyProfileHostBoundaries(profile, imageId);
  await verifyProfileNetworkIsolation(profile, imageId, createNetworkFixture);

  await verifyEffectiveProfileCgroup(profile, imageId);
  await verifyProfileCpuUsage(profile, imageId);
  await verifyProfileIoUsage(profile, imageId, legacyManager);

  const scratch = await runProfileWorkload(profile, imageId, [
    '-e',
    [
      "const fs = require('fs');",
      "const fd = fs.openSync('/tmp/t004-scratch-limit', 'w');",
      'let enospc = false;',
      `const block = Buffer.alloc(${1024 * 1024}, 7);`,
      `try { for (let index = 0; index < ${profile.limits.scratchMiB + 16}; index += 1) { fs.writeSync(fd, block); } }`,
      "catch (error) { enospc = error.code === 'ENOSPC'; }",
      'finally { fs.closeSync(fd); }',
      'process.stdout.write(JSON.stringify({ enospc }));',
    ].join(' '),
  ]);
  if (parseQualificationJson(scratch, 'scratch limit').enospc !== true) {
    throw new Error('The requested profile tuple did not enforce its scratch limit.');
  }

  const sharedMemory = await runProfileWorkload(profile, imageId, [
    '-e',
    [
      "const fs = require('fs');",
      'const path = `/dev/shm/t004-shared-memory-${process.pid}`;',
      "const fd = fs.openSync(path, 'w');",
      'let enospc = false;',
      `const block = Buffer.alloc(${1024 * 1024}, 9);`,
      `try { for (let index = 0; index < ${profile.limits.sharedMemoryMiB + 16}; index += 1) { fs.writeSync(fd, block); } }`,
      "catch (error) { enospc = error.code === 'ENOSPC'; }",
      'finally { fs.closeSync(fd); fs.rmSync(path, { force: true }); }',
      'process.stdout.write(JSON.stringify({ enospc }));',
    ].join(' '),
  ]);
  if (parseQualificationJson(sharedMemory, 'shared-memory limit').enospc !== true) {
    throw new Error('The requested profile tuple did not enforce its shared-memory limit.');
  }

  const pids = await runProfileWorkload(profile, imageId, ['/opt/qdroid/probe.mjs', 'pids']);
  if (parseQualificationJson(pids, 'PID limit').forkDenied !== true) {
    throw new Error('The requested profile tuple did not enforce its guest PID limit.');
  }

  await verifyMemoryLimit(profile, imageId);
}

async function verifyProfileHostBoundaries(
  profile: OfflineSandboxProfile,
  imageId: string,
): Promise<void> {
  const boundaryRoot = await mkdtemp(join(tmpdir(), 'qdroid-t004-boundary-'));
  const crossAppPath = join(boundaryRoot, 'cross-app-canary');
  const trustedStorePath = join(boundaryRoot, 'trusted-store-canary');
  const processSecret = randomBytes(24).toString('hex');
  const secretProcess = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
    detached: process.platform !== 'win32',
    env: { ...process.env, QDROID_T004_PROCESS_SECRET: processSecret },
    stdio: 'ignore',
  });

  try {
    if (secretProcess.pid === undefined) {
      throw new Error('The profile boundary control process did not start.');
    }
    await writeFile(crossAppPath, 'cross-app-canary', { mode: 0o600 });
    await writeFile(trustedStorePath, 'trusted-store-canary', { mode: 0o600 });
    const [crossAppControl, trustedStoreControl, processEnvironment, device, dockerSocket] =
      await Promise.all([
        readFile(crossAppPath, 'utf8'),
        readFile(trustedStorePath, 'utf8'),
        readFile(`/proc/${secretProcess.pid}/environ`),
        stat('/dev/vdb'),
        stat('/var/run/docker.sock'),
      ]);
    if (
      crossAppControl !== 'cross-app-canary' ||
      trustedStoreControl !== 'trusted-store-canary' ||
      !processEnvironment.includes(processSecret) ||
      !device.isBlockDevice() ||
      !dockerSocket.isSocket()
    ) {
      throw new Error('The trusted profile boundary controls were not available to the host.');
    }

    const boundaries = await runProfileWorkload(profile, imageId, [
      '-e',
      [
        "const fs = require('fs');",
        'const readFails = (path) => { try { fs.readFileSync(path); return false; } catch { return true; } };',
        'const openFails = (path) => { try { const fd = fs.openSync(path, "r"); fs.closeSync(fd); return false; } catch { return true; } };',
        'const [crossAppPath, trustedStorePath, hostPid] = process.argv.slice(1);',
        'process.stdout.write(JSON.stringify({',
        'crossAppUnreadable: readFails(crossAppPath),',
        'trustedStoreUnreadable: readFails(trustedStorePath),',
        'hostProcessSecretUnreadable: readFails(`/proc/${hostPid}/environ`),',
        'hostPidHidden: !fs.existsSync(`/proc/${hostPid}`),',
        'controlledDeviceUnreadable: openFails("/dev/vdb"),',
        'dockerSocketUnreadable: openFails("/var/run/docker.sock")',
        '}));',
      ].join(' '),
      crossAppPath,
      trustedStorePath,
      String(secretProcess.pid),
    ]);
    const parsed = parseQualificationJson(boundaries, 'host boundary controls');
    if (
      parsed.crossAppUnreadable !== true ||
      parsed.trustedStoreUnreadable !== true ||
      parsed.hostProcessSecretUnreadable !== true ||
      parsed.hostPidHidden !== true ||
      parsed.controlledDeviceUnreadable !== true ||
      parsed.dockerSocketUnreadable !== true
    ) {
      throw new Error('The requested profile exposed a host boundary control.');
    }
  } finally {
    if (secretProcess.pid !== undefined) {
      try {
        if (process.platform !== 'win32') {
          process.kill(-secretProcess.pid, 'SIGKILL');
        } else {
          secretProcess.kill('SIGKILL');
        }
      } catch {
        // The owned control process may have exited while the probe was completing.
      }
    }
    await rm(boundaryRoot, { force: true, recursive: true });
  }
}

async function verifyProfileNetworkIsolation(
  profile: OfflineSandboxProfile,
  imageId: string,
  createNetworkFixture: () => Promise<TrustedProfileNetworkFixture>,
): Promise<void> {
  const controls = await createProfileNetworkControls(createNetworkFixture);
  let probeFailure: Error | undefined;
  try {
    controls.assertFixtureHealthy();
    await runOwnedProfileNetworkOperation(
      (signal) => controls.assertHostPositiveControls(signal),
      controls.fixtureFailure,
    );
    controls.assertFixtureHealthy();
    controls.resetReceipts();
    const output = await runOwnedProfileNetworkOperation(
      (signal) =>
        controls.runQualificationWorkload(
          profile,
          imageId,
          ['-e', PROFILE_NETWORK_PROBE_SOURCE, JSON.stringify(controls.targets)],
          signal,
        ),
      controls.fixtureFailure,
    );
    controls.assertFixtureHealthy();
    const result = parseQualificationJson(output, 'network isolation');
    if (
      result.tcpBlocked !== true ||
      result.dnsBlocked !== true ||
      result.udpAttemptsCompleted !== true ||
      !controls.hasNoProfileReceipts()
    ) {
      throw new Error('The requested profile tuple did not block controlled network paths.');
    }
  } catch (error) {
    probeFailure = asError(error, 'The requested profile network probe failed.');
  }

  let cleanupFailure: Error | undefined;
  try {
    await controls.dispose();
    // A controller can be lost during asynchronous disposal. A successful
    // cleanup-only recovery releases the resource but cannot make this tuple
    // eligible for qualification again.
    controls.assertFixtureHealthy();
  } catch (error) {
    cleanupFailure = asError(error, 'The trusted profile network fixture cleanup failed.');
  }

  if (probeFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [probeFailure, cleanupFailure],
      'The requested profile network probe and cleanup both failed.',
    );
  }
  if (probeFailure !== undefined) {
    throw probeFailure;
  }
  if (cleanupFailure !== undefined) {
    throw cleanupFailure;
  }
}

type ProfileNetworkAddressFamily = 'ipv4' | 'ipv6';
type ProfileNetworkCategory = 'link-local' | 'loopback' | 'metadata-class' | 'private' | 'ula';

interface ProfileNetworkTargetDefinition {
  category: ProfileNetworkCategory;
  cidr?: string;
  family: ProfileNetworkAddressFamily;
  host: string;
}

interface ProfileNetworkTarget extends ProfileNetworkTargetDefinition {
  dnsPort: number;
  tcpPort: number;
  udpPort: number;
}

interface ProfileNetworkControl {
  dns: DatagramSocket;
  dnsReceipts: number;
  target: ProfileNetworkTarget;
  tcp: Server;
  tcpReceipts: number;
  udp: DatagramSocket;
  udpReceipts: number;
}

interface ProfileNetworkControls {
  assertFixtureHealthy(): void;
  assertHostPositiveControls(signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
  fixtureFailure: Promise<never>;
  hasNoProfileReceipts(): boolean;
  resetReceipts(): void;
  runQualificationWorkload(
    profile: OfflineSandboxProfile,
    imageId: string,
    argv: readonly string[],
    signal: AbortSignal,
  ): Promise<string>;
  targets: readonly ProfileNetworkTarget[];
}

const PROFILE_NETWORK_TARGET_DEFINITIONS: readonly ProfileNetworkTargetDefinition[] = Object.freeze(
  [
    Object.freeze({ category: 'loopback', family: 'ipv4', host: '127.0.0.1' }),
    Object.freeze({
      category: 'private',
      cidr: '10.23.45.1/24',
      family: 'ipv4',
      host: '10.23.45.1',
    }),
    Object.freeze({
      category: 'link-local',
      cidr: '169.254.77.1/24',
      family: 'ipv4',
      host: '169.254.77.1',
    }),
    // This address is installed only on the task-owned dummy interface below.
    // It is a synthetic metadata-class target, never an external metadata service.
    Object.freeze({
      category: 'metadata-class',
      cidr: '169.254.169.253/32',
      family: 'ipv4',
      host: '169.254.169.253',
    }),
    Object.freeze({
      category: 'ula',
      cidr: 'fd42:515d:4::1/64',
      family: 'ipv6',
      host: 'fd42:515d:4::1',
    }),
  ],
);

async function createProfileNetworkControls(
  createNetworkFixture: () => Promise<TrustedProfileNetworkFixture>,
): Promise<ProfileNetworkControls> {
  const fixture = await createNetworkFixture();
  const controls: ProfileNetworkControl[] = [];

  try {
    for (const definition of PROFILE_NETWORK_TARGET_DEFINITIONS) {
      controls.push(await createProfileNetworkControl(definition));
    }

    return {
      assertFixtureHealthy: (): void => fixture.assertHealthy(),
      assertHostPositiveControls: async (signal: AbortSignal): Promise<void> => {
        for (const control of controls) {
          throwIfProfileNetworkOperationAborted(signal);
          await Promise.all([
            connectProfileTcpControl(control.target.host, control.target.tcpPort, signal),
            sendProfileUdpControl(
              control.target.host,
              control.target.udpPort,
              control.target.family,
              signal,
            ),
            sendProfileDnsControl(
              control.target.host,
              control.target.dnsPort,
              control.target.family,
              signal,
            ),
          ]);
          await waitForProfileNetworkReceipts(
            () =>
              control.tcpReceipts === 1 && control.udpReceipts === 1 && control.dnsReceipts === 1,
            signal,
          );
        }
      },
      dispose: async (): Promise<void> => {
        const disposal = await Promise.allSettled(controls.map(disposeProfileNetworkControl));
        const fixtureError = await fixture.dispose().then(
          () => undefined,
          (error: unknown) => asError(error, 'The trusted profile network fixture cleanup failed.'),
        );
        const controlError = disposal.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        )?.reason;

        if (fixtureError !== undefined) {
          throw fixtureError;
        }
        if (controlError !== undefined) {
          throw asError(controlError, 'The trusted profile network control cleanup failed.');
        }
      },
      fixtureFailure: fixture.failure,
      hasNoProfileReceipts: () =>
        controls.every(
          (control) =>
            control.tcpReceipts === 0 && control.udpReceipts === 0 && control.dnsReceipts === 0,
        ),
      resetReceipts: () => {
        for (const control of controls) {
          control.tcpReceipts = 0;
          control.udpReceipts = 0;
          control.dnsReceipts = 0;
        }
      },
      runQualificationWorkload: (profile, imageId, argv, signal) =>
        fixture.runQualificationWorkload(profile, imageId, argv, signal),
      targets: Object.freeze(controls.map((control) => Object.freeze({ ...control.target }))),
    };
  } catch (error) {
    const primaryFailure = asError(error, 'The trusted profile network controls failed to start.');
    const controlDisposal = await Promise.allSettled(controls.map(disposeProfileNetworkControl));
    const fixtureFailure = await fixture.dispose().then(
      () => undefined,
      (cleanupError: unknown) =>
        asError(cleanupError, 'The trusted profile network fixture cleanup failed.'),
    );
    const controlFailure = controlDisposal.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )?.reason;
    if (fixtureFailure !== undefined || controlFailure !== undefined) {
      throw new AggregateError(
        [
          primaryFailure,
          ...(fixtureFailure === undefined ? [] : [fixtureFailure]),
          ...(controlFailure === undefined
            ? []
            : [asError(controlFailure, 'The trusted profile network control cleanup failed.')]),
        ],
        'The trusted profile network controls failed and cleanup is unconfirmed.',
      );
    }
    throw primaryFailure;
  }
}

async function createProfileNetworkControl(
  definition: ProfileNetworkTargetDefinition,
): Promise<ProfileNetworkControl> {
  let control: ProfileNetworkControl;
  const tcp = createServer((socket) => {
    control.tcpReceipts += 1;
    socket.end();
  });
  const udp = createSocket(definition.family === 'ipv6' ? 'udp6' : 'udp4');
  const dns = createSocket(definition.family === 'ipv6' ? 'udp6' : 'udp4');
  control = {
    dns,
    dnsReceipts: 0,
    target: {
      ...definition,
      dnsPort: 0,
      tcpPort: 0,
      udpPort: 0,
    },
    tcp,
    tcpReceipts: 0,
    udp,
    udpReceipts: 0,
  };
  udp.on('message', () => {
    control.udpReceipts += 1;
  });
  dns.on('message', () => {
    control.dnsReceipts += 1;
  });

  try {
    const [tcpPort, udpPort, dnsPort] = await Promise.all([
      listenProfileTcpControl(tcp, definition.host),
      bindProfileUdpControl(udp, definition.host),
      bindProfileUdpControl(dns, definition.host),
    ]);
    control.target = {
      ...control.target,
      dnsPort,
      tcpPort,
      udpPort,
    };
    return control;
  } catch (error) {
    await disposeProfileNetworkControl(control).catch(() => undefined);
    throw error;
  }
}

async function disposeProfileNetworkControl(control: ProfileNetworkControl): Promise<void> {
  await Promise.all([
    closeProfileTcpControl(control.tcp),
    closeProfileUdpControl(control.udp),
    closeProfileUdpControl(control.dns),
  ]);
}

interface TrustedProfileNetworkFixture {
  assertHealthy(): void;
  dispose(): Promise<void>;
  failure: Promise<never>;
  runQualificationWorkload(
    profile: OfflineSandboxProfile,
    imageId: string,
    argv: readonly string[],
    signal: AbortSignal,
  ): Promise<string>;
}

interface NetworkFixtureControllerCompletion {
  cleanupConfirmed: boolean;
  cleanupUncertain: boolean;
}

export function forkTrustedProfileNetworkFixtureController(workerPath: string): ChildProcess {
  return fork(workerPath, [], {
    detached: process.platform !== 'win32',
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
}

export class ProfileNetworkFixtureController {
  public readonly completion: Promise<NetworkFixtureControllerCompletion>;
  public readonly failure: Promise<never>;
  public readonly pid: number;

  private readonly child: ChildProcess;
  private readonly created: Promise<void>;
  private readonly ready: Promise<void>;
  private complete = false;
  private createdConfirmed = false;
  private failureError: Error | undefined;
  private readonly startupStderrChunks: Buffer[] = [];
  private startupStderrBytes = 0;
  private rejectCreated: (error: Error) => void = () => undefined;
  private rejectFailure: (error: Error) => void = () => undefined;
  private rejectReady: (error: Error) => void = () => undefined;
  private resolveCompletion: (result: NetworkFixtureControllerCompletion) => void = () => undefined;
  private resolveCreated: () => void = () => undefined;
  private resolveReady: () => void = () => undefined;

  public constructor(
    forkController: ((workerPath: string) => ChildProcess) | undefined = undefined,
  ) {
    const workerPath = fileURLToPath(new URL('./profile-network-controller.js', import.meta.url));
    this.child =
      forkController?.(workerPath) ?? forkTrustedProfileNetworkFixtureController(workerPath);
    this.created = new Promise<void>((resolve, reject) => {
      this.resolveCreated = resolve;
      this.rejectCreated = reject;
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.completion = new Promise<NetworkFixtureControllerCompletion>((resolve) => {
      this.resolveCompletion = resolve;
    });
    this.failure = new Promise<never>((_resolve, reject) => {
      this.rejectFailure = reject;
    });
    // A controller can fail while its parent is persisting the intent. Keep
    // both promises observed until the lifecycle path awaits their result.
    void this.created.catch(() => undefined);
    void this.ready.catch(() => undefined);
    void this.completion.catch(() => undefined);
    void this.failure.catch(() => undefined);

    this.child.stderr?.on('data', (chunk: Buffer) => this.captureStartupStderr(chunk));
    this.child.on('message', (message: unknown) => this.receive(message));
    this.child.once('error', () =>
      this.fail(new Error('The network fixture controller worker could not start.')),
    );
    this.child.once('disconnect', () =>
      this.fail(new Error('The network fixture controller disconnected.')),
    );
    this.child.once('exit', (code, signal) => {
      if (this.complete) {
        this.appendWorkerExitDiagnostic(code, signal);
        return;
      }
      this.fail(this.workerExitError(code, signal));
    });

    if (this.child.pid === undefined) {
      const error = new Error(
        'The trusted profile network fixture controller did not expose a PID.',
      );
      this.fail(error);
      throw error;
    }
    this.pid = this.child.pid;
  }

  public async start(interfaceName: string, marker: string): Promise<void> {
    await this.withinLifecycleDeadline(
      this.send({ interfaceName, marker, type: 'start' }),
      'start request',
    );
    await this.withinLifecycleDeadline(this.created, 'creation confirmation');
  }

  public async waitUntilReady(): Promise<void> {
    await this.withinLifecycleDeadline(this.ready, 'startup readiness');
  }

  public async stop(): Promise<NetworkFixtureControllerCompletion> {
    if (!this.complete) {
      await this.withinLifecycleDeadline(this.send({ type: 'stop' }), 'stop request').catch(
        () => undefined,
      );
    }
    return this.withinLifecycleDeadline(this.completion, 'cleanup confirmation');
  }

  public async cleanup(
    interfaceName: string,
    marker: string,
  ): Promise<NetworkFixtureControllerCompletion> {
    await this.withinLifecycleDeadline(
      this.send({ interfaceName, marker, type: 'cleanup' }),
      'cleanup request',
    );
    return this.withinLifecycleDeadline(this.completion, 'cleanup confirmation');
  }

  public assertHealthy(): void {
    if (this.failureError !== undefined) {
      throw this.failureError;
    }
  }

  public get failureReason(): Error | undefined {
    return this.failureError;
  }

  private receive(message: unknown): void {
    if (!isRecord(message) || this.complete) {
      return;
    }
    if (message.type === 'ready' && Object.keys(message).length === 1) {
      this.resolveReady();
      return;
    }
    if (message.type === 'created' && Object.keys(message).length === 1) {
      this.createdConfirmed = true;
      this.resolveCreated();
      return;
    }
    if (
      message.type === 'finished' &&
      typeof message.cleanupConfirmed === 'boolean' &&
      typeof message.cleanupUncertain === 'boolean' &&
      (message.error === undefined || typeof message.error === 'string')
    ) {
      this.complete = true;
      const completion = {
        cleanupConfirmed: message.cleanupConfirmed,
        cleanupUncertain: message.cleanupUncertain,
      };
      this.resolveCompletion(completion);
      if (
        !this.createdConfirmed ||
        !completion.cleanupConfirmed ||
        completion.cleanupUncertain ||
        typeof message.error === 'string'
      ) {
        const error = new Error(
          typeof message.error === 'string'
            ? message.error
            : 'The network fixture controller did not confirm cleanup.',
        );
        this.rejectCreated(error);
        this.recordFailure(error);
      }
    }
  }

  private fail(error: Error): void {
    if (this.complete) {
      return;
    }
    this.complete = true;
    this.rejectReady(error);
    this.rejectCreated(error);
    this.recordFailure(error);
    this.resolveCompletion({ cleanupConfirmed: false, cleanupUncertain: true });
  }

  private recordFailure(error: Error): void {
    if (this.failureError !== undefined) {
      return;
    }
    this.failureError = error;
    this.rejectFailure(error);
  }

  private captureStartupStderr(chunk: Buffer): void {
    const remaining = NETWORK_FIXTURE_STARTUP_DIAGNOSTIC_BYTES - this.startupStderrBytes;
    if (remaining > 0) {
      const captured = Buffer.from(chunk.subarray(0, remaining));
      this.startupStderrChunks.push(captured);
      this.startupStderrBytes += captured.byteLength;
    }
  }

  private workerExitError(code: number | null, signal: NodeJS.Signals | null): Error {
    return new Error(
      `The network fixture controller exited before cleanup was confirmed (${formatNetworkFixtureWorkerExit(code, signal)}).${this.startupStderrSuffix()}`,
    );
  }

  private appendWorkerExitDiagnostic(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.failureError === undefined) {
      return;
    }

    const detail = `[trusted network fixture worker ${formatNetworkFixtureWorkerExit(code, signal)}${this.startupStderrSuffix()}]`;
    if (!this.failureError.message.includes('[trusted network fixture worker ')) {
      this.failureError.message = `${this.failureError.message} ${detail}`;
    }
  }

  private startupStderrSuffix(): string {
    const captured = Buffer.concat(this.startupStderrChunks).toString('utf8');
    const sanitized = sanitizeNetworkFixtureWorkerStderr(captured);
    return sanitized === '' ? '' : ` stderr: ${sanitized}`;
  }

  private async send(message: Record<string, unknown>): Promise<void> {
    if (!this.child.connected) {
      throw new Error('The network fixture controller IPC channel is unavailable.');
    }
    await new Promise<void>((resolve, reject) => {
      this.child.send(message, (error) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  private async withinLifecycleDeadline<T>(operation: Promise<T>, activity: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(
          new Error(
            `The network fixture controller did not return its ${activity} within the trusted deadline.`,
          ),
        );
      }, NETWORK_FIXTURE_CONTROLLER_LIFECYCLE_DEADLINE_MS);
      operation.then(
        (value) => {
          clearTimeout(deadline);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(deadline);
          reject(error);
        },
      );
    });
  }
}

function formatNetworkFixtureWorkerExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  return signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`;
}

function sanitizeNetworkFixtureWorkerStderr(stderr: string): string {
  return stderr
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/(?:^|\s)[A-Za-z_][A-Za-z0-9_]{0,63}=(?:"[^"]*"|'[^']*'|\S+)/g, ' [redacted]')
    .replace(/(?:file|https?):\/\/\S+/g, '[uri]')
    .replace(/(?:^|\s)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+/g, ' [path]')
    .replace(/\s+/g, ' ')
    .trim();
}

function networkFixtureAddresses(): readonly string[] {
  return Object.freeze(
    PROFILE_NETWORK_TARGET_DEFINITIONS.flatMap((target) =>
      target.cidr === undefined ? [] : [target.cidr],
    ),
  );
}

function formatNetworkFixtureMarker(bytes: Buffer): string {
  if (bytes.byteLength !== 5) {
    throw new Error('The trusted profile network fixture marker is invalid.');
  }
  return `02:${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join(':')}`;
}

async function listenProfileTcpControl(server: Server, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port: 0 }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string' || address.port < 1) {
    throw new Error('The trusted profile TCP control did not bind a port.');
  }
  return address.port;
}

async function bindProfileUdpControl(socket: DatagramSocket, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ address: host, port: 0 }, () => {
      socket.off('error', reject);
      resolve();
    });
  });
  const address = socket.address();
  if (typeof address === 'string' || address.port < 1) {
    throw new Error('The trusted profile UDP control did not bind a port.');
  }
  return address.port;
}

async function connectProfileTcpControl(
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfProfileNetworkOperationAborted(signal);
  const socket = connect({ host, port });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.off('error', onError);
      socket.off('connect', onConnect);
      signal.removeEventListener('abort', onAbort);
      if (error === undefined) {
        resolve();
      } else {
        socket.destroy();
        reject(error);
      }
    };
    const onError = (error: Error): void => finish(error);
    const onConnect = (): void => {
      socket.end();
      finish(undefined);
    };
    const onAbort = (): void => finish(profileNetworkOperationAbortError(signal));

    socket.once('error', onError);
    socket.once('connect', onConnect);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function sendProfileUdpControl(
  host: string,
  port: number,
  family: ProfileNetworkAddressFamily,
  signal: AbortSignal,
): Promise<void> {
  const socket = createSocket(family === 'ipv6' ? 'udp6' : 'udp4');
  try {
    throwIfProfileNetworkOperationAborted(signal);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };
      const onAbort = (): void => finish(profileNetworkOperationAbortError(signal));
      socket.send(Buffer.from([0x71]), port, host, (error) => {
        if (error === null || error === undefined) {
          finish(undefined);
        } else {
          finish(error);
        }
      });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  } finally {
    socket.close();
  }
}

async function sendProfileDnsControl(
  host: string,
  port: number,
  family: ProfileNetworkAddressFamily,
  signal: AbortSignal,
): Promise<void> {
  const socket = createSocket(family === 'ipv6' ? 'udp6' : 'udp4');
  const query = Buffer.from([
    0x71,
    0x04,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x08,
    ...Buffer.from('metadata', 'ascii'),
    0x06,
    ...Buffer.from('qdroid', 'ascii'),
    0x07,
    ...Buffer.from('invalid', 'ascii'),
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
  ]);
  try {
    throwIfProfileNetworkOperationAborted(signal);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };
      const onAbort = (): void => finish(profileNetworkOperationAbortError(signal));
      socket.send(query, port, host, (error) => {
        if (error === null || error === undefined) {
          finish(undefined);
        } else {
          finish(error);
        }
      });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  } finally {
    socket.close();
  }
}

async function waitForProfileNetworkReceipts(
  condition: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + PROFILE_NETWORK_PROBE_DEADLINE_MS;
  while (Date.now() < deadline) {
    throwIfProfileNetworkOperationAborted(signal);
    if (condition()) {
      return;
    }
    await delay(10);
  }
  throw new Error('The trusted profile network controls did not receive their positive probes.');
}

/**
 * Trusted qualification helper. It remains outside the workload contract and
 * is exported only so host-boundary regressions can exercise the same
 * cancellation and error-preservation path used by profile qualification.
 */
export async function runOwnedProfileNetworkOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  fixtureFailure: Promise<never>,
): Promise<T> {
  const cancellation = new AbortController();
  let fixtureError: Error | undefined;
  const observedFixtureFailure = fixtureFailure.catch((error: unknown): never => {
    fixtureError = asError(error, 'The trusted profile network fixture was lost.');
    cancellation.abort(fixtureError);
    throw fixtureError;
  });
  // A probe can finish before a later controller loss. Keep the rejection
  // observed so terminal disposal, rather than an unowned Promise, reports it.
  void observedFixtureFailure.catch(() => undefined);

  const ownedOperation = operation(cancellation.signal);
  try {
    return await Promise.race([ownedOperation, observedFixtureFailure]);
  } catch (error) {
    if (!cancellation.signal.aborted) {
      cancellation.abort(error);
    }
    const primaryFailure =
      fixtureError ?? asError(error, 'The trusted profile network operation failed.');
    const operationFailure = await ownedOperation.then(
      () => undefined,
      (operationError: unknown) =>
        asError(operationError, 'The trusted profile network operation cleanup failed.'),
    );
    const independentFailures =
      operationFailure === undefined
        ? []
        : flattenIndependentProfileNetworkFailures(operationFailure, primaryFailure);

    if (independentFailures.length === 0) {
      throw primaryFailure;
    }

    throw new AggregateError(
      [primaryFailure, ...independentFailures],
      'The trusted profile network operation failed and cleanup is unconfirmed.',
    );
  }
}

function flattenIndependentProfileNetworkFailures(
  operationFailure: Error,
  primaryFailure: Error,
): Error[] {
  const failures =
    operationFailure instanceof AggregateError
      ? [...operationFailure.errors].map((failure) =>
          asError(failure, 'The trusted profile network operation cleanup failed.'),
        )
      : [operationFailure];

  return failures.filter(
    (failure) =>
      failure !== primaryFailure &&
      !(failure.name === primaryFailure.name && failure.message === primaryFailure.message),
  );
}

function throwIfProfileNetworkOperationAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw profileNetworkOperationAbortError(signal);
  }
}

function profileNetworkOperationAbortError(signal: AbortSignal): Error {
  return asError(signal.reason, 'The trusted profile network operation was cancelled.');
}

async function closeProfileTcpControl(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function closeProfileUdpControl(socket: DatagramSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Trusted qualification helper. It is exported only for host-boundary
 * regression tests; workload callers never receive this capability.
 */
export async function runProfileWorkload(
  profile: OfflineSandboxProfile,
  imageId: string,
  argv: readonly string[],
  qualificationIoMount?: QualificationIoMount,
  signal?: AbortSignal,
): Promise<string> {
  return runProfileWorkloadInternal(profile, imageId, argv, qualificationIoMount, signal);
}

interface TrackedProfileWorkload {
  beforeCreate(operation: NetworkFixtureQualificationOperation): Promise<void>;
  confirmCreated(operation: NetworkFixtureQualificationOperation): Promise<void>;
  confirmRemoved(exactContainerRemoved: boolean): Promise<void>;
}

interface QualifiedProfileContainer {
  id: string;
}

async function runTrackedProfileWorkload(
  profile: OfflineSandboxProfile,
  imageId: string,
  argv: readonly string[],
  signal: AbortSignal,
  tracker: TrackedProfileWorkload,
): Promise<string> {
  return runProfileWorkloadInternal(profile, imageId, argv, undefined, signal, tracker);
}

async function runProfileWorkloadInternal(
  profile: OfflineSandboxProfile,
  imageId: string,
  argv: readonly string[],
  qualificationIoMount: QualificationIoMount | undefined,
  signal: AbortSignal | undefined,
  tracker: TrackedProfileWorkload | undefined = undefined,
): Promise<string> {
  const name = `qdroid-t004-${randomUUID()}`;
  const labels = qualificationContainerLabels(profile);
  let trackedContainer: QualifiedProfileContainer | undefined;
  let trackerPrepared = false;
  let createAttempted = false;
  let cleanupAuthorized = false;
  let primaryFailure: Error | undefined;

  try {
    throwIfQualificationOperationAborted(signal);
    if (tracker !== undefined) {
      await tracker.beforeCreate({
        containerName: name,
        imageId,
        labels,
        profileDigest: profileDigest(profile),
        state: 'possibly-submitted',
      });
      trackerPrepared = true;
    }
    throwIfQualificationOperationAborted(signal);

    createAttempted = true;
    trackedContainer = await createQualifiedProfileContainer(
      profile,
      imageId,
      name,
      argv,
      qualificationIoMount,
      signal,
      labels,
      tracker !== undefined,
    );
    if (tracker !== undefined) {
      if (trackedContainer === undefined) {
        throw new Error('The tracked profile workload did not return an exact container identity.');
      }
      // The create response and immutable inspect binding authorize cleanup by
      // this exact ID even when controller loss seals the subsequent record
      // update.  Do not leave a late successful create behind merely because
      // its confirmation write is no longer allowed.
      cleanupAuthorized = true;
      await tracker.confirmCreated({
        containerId: trackedContainer.id,
        containerName: name,
        imageId,
        labels,
        profileDigest: profileDigest(profile),
        state: 'created',
      });
    }
    cleanupAuthorized = true;

    throwIfQualificationOperationAborted(signal);
    const target = trackedContainer?.id ?? name;
    const started = await runDocker(['start', '--attach', target], { signal });
    throwIfQualificationOperationAborted(signal);
    if (started.exitCode !== 0) {
      throw new Error('The requested profile workload did not complete successfully.');
    }
    return started.stdout;
  } catch (error) {
    primaryFailure = signal?.aborted
      ? profileNetworkOperationAbortError(signal)
      : asError(error, 'The requested profile workload failed.');
  } finally {
    let cleanupFailure: Error | undefined;
    if (cleanupAuthorized) {
      const target = trackedContainer?.id ?? name;
      try {
        await removeQualificationContainer(target);
        if (tracker !== undefined) {
          await tracker.confirmRemoved(true);
        }
      } catch (error) {
        cleanupFailure = asError(error, 'The requested profile workload cleanup failed.');
      }
    } else if (tracker !== undefined && trackerPrepared && !createAttempted) {
      cleanupFailure = await tracker.confirmRemoved(false).then(
        () => undefined,
        (error: unknown) =>
          asError(error, 'The tracked profile workload did not clear its unsubmitted intent.'),
      );
    } else if (tracker === undefined) {
      cleanupFailure = await removeQualificationContainer(name).then(
        () => undefined,
        (error: unknown) => asError(error, 'The requested profile workload cleanup failed.'),
      );
    }

    if (primaryFailure !== undefined && cleanupFailure !== undefined) {
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        'The requested profile workload and cleanup both failed.',
      );
    }
    if (primaryFailure !== undefined) {
      throw primaryFailure;
    }
    if (cleanupFailure !== undefined) {
      throw cleanupFailure;
    }
  }

  throw new Error('The trusted profile workload ended without a result.');
}

async function createQualifiedProfileContainer(
  profile: OfflineSandboxProfile,
  imageId: string,
  name: string,
  argv: readonly string[],
  qualificationIoMount?: QualificationIoMount,
  signal?: AbortSignal,
  labels: QualificationContainerLabels = qualificationContainerLabels(profile),
  requireExactBinding = false,
): Promise<QualifiedProfileContainer | undefined> {
  const request: SandboxExecutionRequest = {
    argv,
    cwd: '/tmp',
    environment: { LANG: 'C.UTF-8' },
    executable: '/usr/local/bin/node',
  };

  try {
    throwIfQualificationOperationAborted(signal);
    const createSignal = requireExactBinding ? undefined : signal;
    const created = await runDocker(
      [
        'create',
        '--name',
        name,
        ...dockerArgumentsFor(profile, imageId, request, { ...labels }, qualificationIoMount),
      ],
      { signal: createSignal },
    );
    if (created.commandCompleted === false || created.exitCode !== 0) {
      throw new Error('The requested profile tuple could not create a container.');
    }
    const createdContainerId = requireExactBinding
      ? dockerCreateResponseContainerId(created)
      : undefined;
    const inspected = await runDocker(['inspect', name], { signal: createSignal });
    if (!matchesQualifiedProfile(inspected, profile, qualificationIoMount)) {
      throw new Error('The requested profile tuple did not materialize its trusted configuration.');
    }
    if (!requireExactBinding) {
      throwIfQualificationOperationAborted(signal);
      return undefined;
    }
    if (createdContainerId === undefined) {
      throw new Error('The tracked profile workload did not return an exact create response ID.');
    }

    const containerId = qualifiedProfileContainerId(inspected, imageId, labels, createdContainerId);
    if (containerId === undefined) {
      throw new Error(
        'The tracked profile workload did not materialize its exact trusted binding.',
      );
    }
    return { id: containerId };
  } catch (error) {
    const primaryFailure = asError(error, 'The requested profile tuple failed to materialize.');
    if (requireExactBinding) {
      throw primaryFailure;
    }
    try {
      // Docker may report a nonzero create after it has already allocated the
      // exact name. Always make the bounded, name-specific cleanup observation
      // before returning the qualification failure.
      await removeQualificationContainer(name);
    } catch (cleanupError) {
      throw new AggregateError(
        [primaryFailure, asError(cleanupError, 'The qualification container cleanup failed.')],
        'The requested profile tuple failed and its owned container cleanup is unconfirmed.',
      );
    }
    throw primaryFailure;
  }
}

function qualificationContainerLabels(
  profile: OfflineSandboxProfile,
): QualificationContainerLabels {
  return {
    'io.qdroid.owner': 'qualification',
    'io.qdroid.profile': profileDigest(profile),
    'io.qdroid.session': randomUUID(),
  };
}

function qualifiedProfileContainerId(
  inspected: { exitCode: number; stdout: string },
  imageId: string,
  labels: QualificationContainerLabels,
  expectedId: string,
): string | undefined {
  if (inspected.exitCode !== 0) {
    return undefined;
  }
  try {
    const value = JSON.parse(inspected.stdout) as unknown;
    if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
      return undefined;
    }
    const container = value[0];
    const containerLabels =
      isRecord(container.Config) && isRecord(container.Config.Labels)
        ? container.Config.Labels
        : undefined;
    if (
      typeof container.Id !== 'string' ||
      !isContainerId(container.Id) ||
      container.Id !== expectedId ||
      container.Image !== imageId ||
      containerLabels?.['io.qdroid.owner'] !== labels['io.qdroid.owner'] ||
      containerLabels?.['io.qdroid.profile'] !== labels['io.qdroid.profile'] ||
      containerLabels?.['io.qdroid.session'] !== labels['io.qdroid.session']
    ) {
      return undefined;
    }
    return container.Id;
  } catch {
    return undefined;
  }
}

function dockerCreateResponseContainerId(result: DockerCommandResult): string | undefined {
  if (result.commandCompleted === false || result.exitCode !== 0) {
    return undefined;
  }
  const containerId = result.stdout.trim();
  return isContainerId(containerId) ? containerId : undefined;
}

function throwIfQualificationOperationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw profileNetworkOperationAbortError(signal);
  }
}

function matchesQualifiedProfile(
  inspected: { exitCode: number; stdout: string },
  profile: OfflineSandboxProfile,
  qualificationIoMount?: QualificationIoMount,
): boolean {
  if (inspected.exitCode !== 0) {
    return false;
  }

  let container: unknown;
  try {
    container = JSON.parse(inspected.stdout);
  } catch {
    return false;
  }
  if (!Array.isArray(container) || container.length !== 1 || !isRecord(container[0])) {
    return false;
  }
  const value = container[0];
  const hostConfig = isRecord(value.HostConfig) ? value.HostConfig : undefined;
  const config = isRecord(value.Config) ? value.Config : undefined;
  const mounts = value.Mounts;
  const securityOptions = hostConfig?.SecurityOpt;
  const droppedCapabilities = hostConfig?.CapDrop;
  const hasExpectedMount =
    qualificationIoMount === undefined
      ? Array.isArray(mounts) && mounts.length === 0
      : Array.isArray(mounts) &&
        mounts.length === 1 &&
        isRecord(mounts[0]) &&
        mounts[0].Type === 'bind' &&
        mounts[0].Source === qualificationIoMount.sourcePath &&
        mounts[0].Destination === qualificationIoMount.targetPath &&
        mounts[0].RW === false &&
        mounts[0].Propagation === 'rprivate';
  return (
    hasExpectedMount &&
    hostConfig?.ReadonlyRootfs === true &&
    hostConfig?.NetworkMode === 'none' &&
    hostConfig.Memory === profile.limits.memoryMiB * 1024 * 1024 &&
    hostConfig.MemorySwap === profile.limits.memoryMiB * 1024 * 1024 &&
    hostConfig.NanoCpus === profile.limits.cpu * 1_000_000_000 &&
    hostConfig.PidsLimit === profile.limits.hostPids &&
    hostConfig.ShmSize === profile.limits.sharedMemoryMiB * 1024 * 1024 &&
    Array.isArray(securityOptions) &&
    securityOptions.includes('no-new-privileges') &&
    Array.isArray(droppedCapabilities) &&
    droppedCapabilities.includes('ALL') &&
    config?.User === '65532:65532'
  );
}

async function verifyEffectiveProfileCgroup(
  profile: OfflineSandboxProfile,
  imageId: string,
): Promise<void> {
  const name = `qdroid-t004-${randomUUID()}`;
  await createQualifiedProfileContainer(profile, imageId, name, [
    '-e',
    'setInterval(() => {}, 1_000)',
  ]);
  try {
    const started = await runDocker(['start', name]);
    if (started.exitCode !== 0) {
      throw new Error('The requested profile cgroup probe could not start.');
    }

    const limits = await readEffectiveCgroupLimits(name);
    const expectedMemory = `${profile.limits.memoryMiB * 1024 * 1024}`;
    const expectedCpu = '100000 100000';
    const expectedPids = `${profile.limits.hostPids}`;
    const expectedIo = `${profile.limits.ioBytesPerSecond}`;
    if (
      limits.memory !== expectedMemory ||
      limits.cpu !== expectedCpu ||
      limits.pids !== expectedPids ||
      !limits.io.includes(`rbps=${expectedIo}`) ||
      !limits.io.includes(`wbps=${expectedIo}`)
    ) {
      throw new Error('The requested profile cgroup limits do not match its qualified envelope.');
    }
  } finally {
    await removeQualificationContainer(name);
  }
}

async function verifyProfileCpuUsage(
  profile: OfflineSandboxProfile,
  imageId: string,
): Promise<void> {
  const name = `qdroid-t004-${randomUUID()}`;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveResult: (() => void) | undefined;
  let rejectResult: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completedProbe = new Promise<void>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // These promises can reject before the normal deadline wait is installed.
  // Observe that edge immediately without changing the error seen by the later
  // trusted qualification flow.
  void ready.catch(() => undefined);
  void completedProbe.catch(() => undefined);

  let attached: ChildProcessWithoutNullStreams | undefined;
  let attachedClosed: Promise<void> | undefined;
  let inputObservation: ProfileProbeInputObservation | undefined;
  let output = '';
  let primaryFailure: Error | undefined;

  try {
    await createQualifiedProfileContainer(profile, imageId, name, ['-e', PROFILE_CPU_PROBE_SOURCE]);
    attached = spawn('docker', ['start', '--attach', '--interactive', name], {
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    inputObservation = observeProfileProbeInput(attached.stdin, (failure) => {
      rejectReady?.(failure);
      rejectResult?.(failure);
    });
    attachedClosed = waitForAttachedProfileProbe(attached);
    void attachedClosed.catch((error: unknown) => {
      const failure = asError(error, 'The profile CPU probe attach process failed.');
      rejectReady?.(failure);
      rejectResult?.(failure);
    });
    attached.stderr.resume();
    attached.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const lines = output.split('\n');
      output = lines.pop() ?? '';

      for (const line of lines) {
        if (line === 'ready') {
          resolveReady?.();
          continue;
        }
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!isRecord(parsed) || parsed.completed !== true) {
            throw new Error('The profile CPU probe returned an invalid result.');
          }
          resolveResult?.();
        } catch (error) {
          rejectResult?.(asError(error, 'The profile CPU probe returned invalid JSON.'));
        }
      }
    });

    await withinProfileCpuDeadline(ready, 'The profile CPU probe did not become ready.');
    const beforeIdentity = await readQualifiedProfileCgroupIdentity(name);
    const before = await readProfileCpuStat(beforeIdentity.cgroupPath);
    const startedAt = process.hrtime.bigint();
    await writeProfileProbeInput(attached.stdin, 'start\n');
    throwObservedProfileProbeInputFailure(inputObservation);
    await withinProfileCpuDeadline(
      completedProbe,
      'The profile CPU probe did not complete its useful computation.',
    );
    throwObservedProfileProbeInputFailure(inputObservation);
    const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
    const afterIdentity = await readQualifiedProfileCgroupIdentity(name);
    const after = await readProfileCpuStat(afterIdentity.cgroupPath);

    if (
      beforeIdentity.pid !== afterIdentity.pid ||
      beforeIdentity.processStart !== afterIdentity.processStart ||
      beforeIdentity.cgroupPath !== afterIdentity.cgroupPath
    ) {
      throw new Error('The profile CPU probe changed process or cgroup identity.');
    }

    const cpuMaximum = await readFile(
      join('/sys/fs/cgroup', beforeIdentity.cgroupPath, 'cpu.max'),
      'utf8',
    );
    const expectedCpuMaximum = `${Math.round(profile.limits.cpu * 100_000)} 100000`;
    const usageMicros = checkedProfileCpuDelta(after.usageMicros, before.usageMicros);
    const elapsedMicros = Number(elapsedNanoseconds) / 1_000;
    const hostCpuToWallRatio = usageMicros / elapsedMicros;
    if (
      cpuMaximum.trim() !== expectedCpuMaximum ||
      usageMicros <= 0 ||
      !Number.isFinite(hostCpuToWallRatio) ||
      hostCpuToWallRatio > profile.limits.cpu + 0.1
    ) {
      throw new Error('The requested profile did not retain its host CPU resource envelope.');
    }

    await writeProfileProbeInput(attached.stdin, 'release\n');
    throwObservedProfileProbeInputFailure(inputObservation);
    await withinProfileCpuDeadline(
      attachedClosed,
      'The profile CPU probe did not exit after trusted release.',
    );
  } catch (error) {
    primaryFailure = asError(error, 'The profile CPU probe failed.');
    rejectReady?.(primaryFailure);
    rejectResult?.(primaryFailure);
  } finally {
    const cleanupFailure = await cleanupAttachedProfileProbe(
      name,
      attached,
      attachedClosed,
      PROFILE_CPU_PROBE_DEADLINE_MS,
      'The profile CPU probe did not stop before cleanup.',
    );
    inputObservation?.detach();
    primaryFailure = combineQualificationFailures(primaryFailure, cleanupFailure);
  }

  if (primaryFailure !== undefined) {
    throw primaryFailure;
  }
}

async function verifyProfileIoUsage(
  profile: OfflineSandboxProfile,
  imageId: string,
  legacyManager: DockerSandboxManager,
): Promise<void> {
  const mount = await legacyManager.createTrustedQualificationIoMount();
  const name = `qdroid-t004-${randomUUID()}`;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveResult: ((result: { code: number | null; elapsedMs: number }) => void) | undefined;
  let rejectResult: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completedProbe = new Promise<{ code: number | null; elapsedMs: number }>(
    (resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    },
  );
  void ready.catch(() => undefined);
  void completedProbe.catch(() => undefined);

  let attached: ChildProcessWithoutNullStreams | undefined;
  let attachedClosed: Promise<void> | undefined;
  let inputObservation: ProfileProbeInputObservation | undefined;
  let output = '';
  let primaryFailure: Error | undefined;

  try {
    await createQualifiedProfileContainer(
      profile,
      imageId,
      name,
      ['-e', PROFILE_IO_PROBE_SOURCE],
      mount,
    );
    attached = spawn('docker', ['start', '--attach', '--interactive', name], {
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    inputObservation = observeProfileProbeInput(attached.stdin, (failure) => {
      rejectReady?.(failure);
      rejectResult?.(failure);
    });
    attachedClosed = waitForAttachedProfileProbe(attached);
    void attachedClosed.catch((error: unknown) => {
      const failure = asError(error, 'The profile I/O probe attach process failed.');
      rejectReady?.(failure);
      rejectResult?.(failure);
    });
    attached.stderr.resume();
    attached.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const lines = output.split('\n');
      output = lines.pop() ?? '';

      for (const line of lines) {
        if (line === 'ready') {
          resolveReady?.();
          continue;
        }

        try {
          const parsed = JSON.parse(line) as unknown;
          if (
            !isRecord(parsed) ||
            (typeof parsed.code !== 'number' && parsed.code !== null) ||
            typeof parsed.elapsedMs !== 'number' ||
            !Number.isFinite(parsed.elapsedMs)
          ) {
            throw new Error('The profile I/O probe returned an invalid result.');
          }
          resolveResult?.({ code: parsed.code, elapsedMs: parsed.elapsedMs });
        } catch (error) {
          rejectResult?.(asError(error, 'The profile I/O probe returned invalid JSON.'));
        }
      }
    });

    await withinProfileIoDeadline(ready, 'The profile I/O probe did not become ready.');
    const beforeIdentity = await readQualifiedProfileCgroupIdentity(name);
    const before = await readProfileIoStat(beforeIdentity.cgroupPath, 'before-read');
    await writeProfileProbeInput(attached.stdin, 'read\n');
    throwObservedProfileProbeInputFailure(inputObservation);
    const result = await withinProfileIoDeadline(
      completedProbe,
      'The profile I/O probe did not complete its bounded read.',
    );
    throwObservedProfileProbeInputFailure(inputObservation);
    const afterIdentity = await readQualifiedProfileCgroupIdentity(name);
    const after = await readProfileIoStat(afterIdentity.cgroupPath, 'after-read');

    if (
      beforeIdentity.pid !== afterIdentity.pid ||
      beforeIdentity.processStart !== afterIdentity.processStart ||
      beforeIdentity.cgroupPath !== afterIdentity.cgroupPath
    ) {
      throw new Error('The profile I/O probe changed process or cgroup identity.');
    }

    const observedReadBytes = checkedProfileIoDelta(after.readBytes, before.readBytes);
    if (
      result.code !== 0 ||
      result.elapsedMs < PROFILE_IO_MIN_DURATION_MS ||
      observedReadBytes < PROFILE_IO_PROBE_FILE_BYTES ||
      after.readBytesPerSecond !== profile.limits.ioBytesPerSecond ||
      after.writeBytesPerSecond !== profile.limits.ioBytesPerSecond
    ) {
      throw new Error('The requested profile did not enforce its effective I/O envelope.');
    }

    await writeProfileProbeInput(attached.stdin, 'release\n');
    throwObservedProfileProbeInputFailure(inputObservation);
    await withinProfileIoDeadline(
      attachedClosed,
      'The profile I/O probe did not exit after trusted release.',
    );
  } catch (error) {
    primaryFailure = asError(error, 'The profile I/O probe failed.');
    rejectReady?.(primaryFailure);
    rejectResult?.(primaryFailure);
  } finally {
    const cleanupFailure = await cleanupAttachedProfileProbe(
      name,
      attached,
      attachedClosed,
      PROFILE_IO_PROBE_DEADLINE_MS,
      'The profile I/O probe did not stop before cleanup.',
    );
    inputObservation?.detach();
    primaryFailure = combineQualificationFailures(primaryFailure, cleanupFailure);

    // A mount can be disposed only after the exact task-owned container is
    // confirmed absent. Retaining it on unknown cleanup preserves evidence and
    // prevents unlinking a file a live container might still reference.
    if (cleanupFailure === undefined) {
      try {
        await mount.dispose();
      } catch (error) {
        if (primaryFailure === undefined) {
          primaryFailure = asError(error, 'The profile I/O fixture cleanup failed.');
        }
      }
    }
  }

  if (primaryFailure !== undefined) {
    throw primaryFailure;
  }
}

interface QualifiedProfileCgroupIdentity {
  cgroupPath: string;
  pid: number;
  processStart: string;
}

interface ProfileCpuStat {
  usageMicros: number;
}

interface ProfileIoStat {
  readBytes: number;
  readBytesPerSecond: number;
  writeBytesPerSecond: number;
}

async function readQualifiedProfileCgroupIdentity(
  name: string,
): Promise<QualifiedProfileCgroupIdentity> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const inspected = await runDocker([
      'inspect',
      '--format',
      '{{.State.Pid}} {{.State.Running}}',
      name,
    ]);
    const [pidValue, running] = inspected.stdout.trim().split(' ');
    const pid = Number.parseInt(pidValue ?? '', 10);
    if (inspected.exitCode === 0 && running === 'true' && Number.isSafeInteger(pid) && pid > 0) {
      const [processStart, cgroup] = await Promise.all([
        readProfileProcessStart(pid),
        readFile(`/proc/${pid}/cgroup`, 'utf8'),
      ]);
      const cgroupPath = readProfileCgroupPath(cgroup);
      return { cgroupPath, pid, processStart };
    }
    await delay(25);
  }
  throw new Error('The requested profile CPU probe did not expose a live cgroup identity.');
}

async function readProfileCpuStat(cgroupPath: string): Promise<ProfileCpuStat> {
  const contents = await readFile(join('/sys/fs/cgroup', cgroupPath, 'cpu.stat'), 'utf8');
  const usageLine = contents.split('\n').find((line) => line.startsWith('usage_usec '));
  const usageValue = usageLine?.slice('usage_usec '.length).trim();
  if (usageValue === undefined || !/^\d+$/.test(usageValue)) {
    throw new Error('The requested profile CPU cgroup statistics are invalid.');
  }
  const usageMicros = Number.parseInt(usageValue, 10);
  if (!Number.isSafeInteger(usageMicros)) {
    throw new Error('The requested profile CPU cgroup counter is unsafe.');
  }
  return { usageMicros };
}

type ProfileIoStatPhase = 'after-read' | 'before-read';

async function readProfileIoStat(
  cgroupPath: string,
  phase: ProfileIoStatPhase,
): Promise<ProfileIoStat> {
  const directory = join('/sys/fs/cgroup', cgroupPath);
  const [maximum, statistics] = await Promise.all([
    readFile(join(directory, 'io.max'), 'utf8'),
    readFile(join(directory, 'io.stat'), 'utf8'),
  ]);
  const maximumFields = parseProfileIoFields(maximum, 'io.max');
  const statisticFields = parseProfileIoFields(statistics, 'io.stat');
  const readBytesPerSecond = parseProfileIoCounter(maximumFields.rbps, 'io.max rbps');
  const writeBytesPerSecond = parseProfileIoCounter(maximumFields.wbps, 'io.max wbps');
  const readBytes = parseProfileIoReadBytes(statisticFields, phase);
  return { readBytes, readBytesPerSecond, writeBytesPerSecond };
}

export function parseProfileIoFields(contents: string, source: string): Record<string, string> {
  const line = contents
    .split('\n')
    .find((candidate) => candidate.startsWith(`${PROFILE_IO_DEVICE_MAJOR_MINOR} `));
  if (line === undefined) {
    throw new Error(`The profile ${source} did not contain the fixed I/O device.`);
  }

  const fields = Object.create(null) as Record<string, string>;
  for (const token of line.trim().split(/\s+/).slice(1)) {
    const separator = token.indexOf('=');
    const fieldName = token.slice(0, separator);
    const fieldValue = token.slice(separator + 1);
    if (separator <= 0 || separator === token.length - 1 || Object.hasOwn(fields, fieldName)) {
      throw new Error(`The profile ${source} contained an invalid I/O field.`);
    }
    fields[fieldName] = fieldValue;
  }
  return fields;
}

export function parseProfileIoReadBytes(
  fields: Record<string, string>,
  phase: ProfileIoStatPhase,
): number {
  if (phase === 'before-read' && Object.keys(fields).length === 0) {
    return 0;
  }
  return parseProfileIoCounter(fields.rbytes, 'io.stat rbytes');
}

function parseProfileIoCounter(value: string | undefined, source: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`The profile ${source} counter is invalid.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`The profile ${source} counter is unsafe.`);
  }
  return parsed;
}

function checkedProfileIoDelta(after: number, before: number): number {
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(before) || after < before) {
    throw new Error('The profile I/O counter regressed.');
  }
  return after - before;
}

function readProfileCgroupPath(contents: string): string {
  const entry = contents.split('\n').find((line) => line.startsWith('0::'));
  const path = entry?.slice('0::'.length);
  if (path === undefined || !path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    throw new Error('The requested profile CPU cgroup path is invalid.');
  }
  return path.slice(1);
}

async function readProfileProcessStart(pid: number): Promise<string> {
  const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  const closeParenthesis = contents.lastIndexOf(')');
  const start = contents.slice(closeParenthesis + 2).split(' ')[19];
  if (closeParenthesis < 0 || start === undefined || !/^\d+$/.test(start)) {
    throw new Error('The requested profile CPU process identity is invalid.');
  }
  return start;
}

function checkedProfileCpuDelta(after: number, before: number): number {
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(before) || after < before) {
    throw new Error('The requested profile CPU counter regressed.');
  }
  return after - before;
}

export interface ProfileProbeInputObservation {
  readonly failure: Error | undefined;
  detach(): void;
}

/**
 * Keeps an error listener on a qualification attach stream until that stream
 * closes. Docker can report EPIPE after a write callback has already run, so
 * a callback alone cannot establish that the trusted probe still accepts input.
 */
export function observeProfileProbeInput(
  input: NodeJS.WritableStream,
  onFailure?: (failure: Error) => void,
): ProfileProbeInputObservation {
  let detached = false;
  let failure: Error | undefined;

  const detach = (): void => {
    if (detached) {
      return;
    }

    detached = true;
    input.off('error', onError);
    input.off('close', onClose);
  };
  const onError = (error: Error): void => {
    failure ??= asError(error, 'The profile probe input stream failed.');
    onFailure?.(failure);
  };
  const onClose = (): void => {
    detach();
  };

  input.on('error', onError);
  input.once('close', onClose);

  return {
    get failure(): Error | undefined {
      return failure;
    },
    detach,
  };
}

function throwObservedProfileProbeInputFailure(
  observation: ProfileProbeInputObservation | undefined,
): void {
  if (observation?.failure !== undefined) {
    throw observation.failure;
  }
}

function writeProfileProbeInput(input: NodeJS.WritableStream, chunk: string): Promise<void> {
  if (!input.writable) {
    return Promise.reject(new Error('The profile probe input stream is unavailable.'));
  }
  return new Promise((resolve, reject) => {
    input.write(chunk, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function waitForAttachedProfileProbe(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error('The profile CPU probe attach process did not exit successfully.'));
      }
    });
  });
}

function terminateAttachedProfileProbe(child: ChildProcessWithoutNullStreams | undefined): void {
  if (child === undefined || child.pid === undefined || child.exitCode !== null) {
    return;
  }

  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
  } catch {
    // The owned attach process may have exited while cleanup was beginning.
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // The exact owned attach process may have exited while cleanup was beginning.
  }
}

function combineQualificationFailures(
  primaryFailure: Error | undefined,
  cleanupFailure: Error | undefined,
): Error | undefined {
  if (cleanupFailure === undefined) {
    return primaryFailure;
  }
  if (primaryFailure === undefined) {
    return cleanupFailure;
  }
  return new AggregateError(
    [primaryFailure, cleanupFailure],
    'The profile qualification failed and its cleanup is unconfirmed.',
  );
}

async function cleanupAttachedProfileProbe(
  name: string,
  attached: ChildProcessWithoutNullStreams | undefined,
  attachedClosed: Promise<void> | undefined,
  deadlineMs: number,
  closeTimeoutMessage: string,
): Promise<Error | undefined> {
  // Initiate termination before the container operation, then use Docker's
  // exact owned name to force removal. Never wait indefinitely for the attach
  // client before that cleanup attempt.
  terminateAttachedProfileProbe(attached);

  let cleanupFailure: Error | undefined;
  try {
    await removeQualificationContainer(name);
  } catch (error) {
    cleanupFailure = asError(error, 'The qualification container cleanup failed.');
  }

  if (attachedClosed !== undefined) {
    try {
      await waitForAttachedProfileProbeTermination(attachedClosed, deadlineMs, closeTimeoutMessage);
    } catch (error) {
      cleanupFailure ??= asError(error, 'The profile probe attach process did not close.');
    }
  }

  return cleanupFailure;
}

async function waitForAttachedProfileProbeTermination(
  attachedClosed: Promise<void>,
  deadlineMs: number,
  timeoutMessage: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      // A nonzero close is expected after forced cleanup. The immediate sink
      // above records it for the normal qualification flow; this branch only
      // establishes that the client cannot keep cleanup open indefinitely.
      attachedClosed.catch(() => undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function withinProfileCpuDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), PROFILE_CPU_PROBE_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function withinProfileIoDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), PROFILE_IO_PROBE_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function readEffectiveCgroupLimits(name: string): Promise<{
  cpu: string;
  io: string;
  memory: string;
  pids: string;
}> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const inspected = await runDocker([
      'inspect',
      '--format',
      '{{.State.Pid}} {{.State.Running}}',
      name,
    ]);
    const [pidValue, running] = inspected.stdout.trim().split(' ');
    const pid = Number.parseInt(pidValue ?? '', 10);
    if (inspected.exitCode === 0 && running === 'true' && Number.isSafeInteger(pid) && pid > 0) {
      const cgroup = await readFile(`/proc/${pid}/cgroup`, 'utf8');
      const path = cgroup
        .split('\n')
        .map((line) => line.split(':'))
        .find((fields) => fields[0] === '0' && fields[1] === '')?.[2];
      if (path !== undefined && path.startsWith('/')) {
        const directory = `/sys/fs/cgroup${path}`;
        const [cpu, io, memory, pids] = await Promise.all([
          readFile(join(directory, 'cpu.max'), 'utf8'),
          readFile(join(directory, 'io.max'), 'utf8'),
          readFile(join(directory, 'memory.max'), 'utf8'),
          readFile(join(directory, 'pids.max'), 'utf8'),
        ]);
        return {
          cpu: cpu.trim(),
          io: io.trim(),
          memory: memory.trim(),
          pids: pids.trim(),
        };
      }
    }
    await delay(50);
  }
  throw new Error('The requested profile did not expose a trusted cgroup-v2 path.');
}

async function verifyMemoryLimit(profile: OfflineSandboxProfile, imageId: string): Promise<void> {
  const name = `qdroid-t004-${randomUUID()}`;
  const allocationMiB = profile.limits.memoryMiB + 96;
  const script = [
    'const blocks = [];',
    `for (let index = 0; index < ${allocationMiB}; index += 1) {`,
    '  const block = Buffer.allocUnsafe(1024 * 1024);',
    '  for (let offset = 0; offset < block.length; offset += 4096) { block[offset] = index; }',
    '  blocks.push(block);',
    '}',
    "process.stdout.write('memory-limit-missed');",
  ].join(' ');
  await createQualifiedProfileContainer(profile, imageId, name, ['-e', script]);
  try {
    const started = await runDocker(['start', name]);
    if (started.exitCode !== 0) {
      throw new Error('The requested profile memory probe could not start.');
    }
    const oomKilled = await waitForMemoryOom(name);
    if (!oomKilled) {
      throw new Error('The requested profile did not enforce its memory limit.');
    }
  } finally {
    await removeQualificationContainer(name);
  }
}

async function waitForMemoryOom(name: string): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const inspected = await runDocker([
      'inspect',
      '--format',
      '{{.State.Running}} {{.State.OOMKilled}}',
      name,
    ]);
    const [running, oomKilled] = inspected.stdout.trim().split(' ');
    if (inspected.exitCode === 0 && running === 'false') {
      return oomKilled === 'true';
    }
    await delay(100);
  }
  throw new Error('The requested profile memory probe exceeded its deadline.');
}

async function removeQualificationContainer(name: string): Promise<void> {
  const removed = await runDocker(['rm', '--force', name]);
  if (removed.commandCompleted === false) {
    throw new Error(
      'The qualification container removal command did not exit before its deadline.',
    );
  }
  if (removed.exitCode === 0 || isConfirmedContainerAbsence(removed, name)) {
    return;
  }

  // A timed-out or malformed remove result is never treated as absence. Ask
  // Docker only about the exact task-owned name before declaring cleanup
  // unconfirmed.
  const inspected = await runDocker(['inspect', name]);
  if (inspected.commandCompleted === false) {
    throw new Error(
      'The qualification container inspection command did not exit before its deadline.',
    );
  }
  if (isConfirmedContainerAbsence(inspected, name)) {
    return;
  }

  throw new Error('The qualification container could not be removed.');
}

function parseQualificationJson(output: string, subject: string): Record<string, unknown> {
  try {
    const value = JSON.parse(output) as unknown;
    if (isRecord(value)) {
      return value;
    }
  } catch {
    // Report the fixed trusted subject instead of workload-controlled output.
  }
  throw new Error(`The requested profile ${subject} result is invalid.`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function withinCleanupDeadline<T>(promise: Promise<T>): Promise<T> {
  return withinCleanupDeadlineAt(promise, Date.now() + STOP_CLEANUP_DEADLINE_MS);
}

async function invokeWithinCleanupDeadlineAt<T>(
  deadline: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (Date.now() >= deadline) {
    throw new Error(CLEANUP_DEADLINE_ERROR);
  }
  return withinCleanupDeadlineAt(operation(), deadline);
}

interface PersistentMutation<T> {
  mutation: Promise<T>;
  result: Promise<T>;
}

function startPersistentMutationBeforeDeadline<T>(
  lease: RecoveryLockLease,
  deadline: number,
  operation: () => Promise<T>,
): PersistentMutation<T> {
  if (Date.now() >= deadline) {
    throw new Error(CLEANUP_DEADLINE_ERROR);
  }
  const mutation = lease.mutations.start(operation);
  const result = withinCleanupDeadlineAt(mutation, deadline);
  // Some callers retain the raw mutation so they can distinguish a timed
  // persistence operation from its eventual result. Keep the bounded view
  // observed as well; its timeout must not become an unhandled rejection.
  void result.catch(() => undefined);
  return { mutation, result };
}

async function withinCleanupDeadlineAt<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remainingMilliseconds = deadline - Date.now();
  if (remainingMilliseconds <= 0) {
    throw new Error(CLEANUP_DEADLINE_ERROR);
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(CLEANUP_DEADLINE_ERROR)), remainingMilliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function isCleanupDeadlineError(error: unknown): boolean {
  return error instanceof Error && error.message === CLEANUP_DEADLINE_ERROR;
}

async function currentHostFingerprint(
  profile: OfflineSandboxProfile,
  imageId: string,
  resources?: RuntimeResourceOps,
): Promise<string> {
  const [boot, image, kernel, runtime] = await Promise.all([
    readTrustedBootId(),
    inspectImageId(imageId, resources),
    runFixedNative(resources, { kind: 'kernel-release' }, () => runCommand('uname', ['-r'])),
    collectRuntimeFingerprintFacts(resources),
  ]);
  if (kernel.exitCode !== 0 || image !== imageId) {
    throw new Error('The trusted sandbox host fingerprint is unavailable.');
  }
  return digestJson({
    boot,
    catalog: CATALOG_VERSION,
    image,
    kernel: kernel.stdout.trim(),
    profile: profileDigest(profile),
    runtime,
    suite: QUALIFICATION_SUITE_VERSION,
  });
}

async function collectRuntimeFingerprintFacts(
  resources?: RuntimeResourceOps,
): Promise<RuntimeFingerprintFacts> {
  const [architecture, dockerVersion, runtimes] = await Promise.all([
    runFixedNative(resources, { kind: 'machine-architecture' }, () => runCommand('uname', ['-m'])),
    runFixedNative(resources, { kind: 'docker-server-version' }, () =>
      runDocker(['version', '--format', '{{.Server.Version}}']),
    ),
    runFixedNative(resources, { kind: 'docker-runtime-info' }, () =>
      runDocker(['info', '--format', '{{json .Runtimes}}']),
    ),
  ]);
  if (architecture.exitCode !== 0 || dockerVersion.exitCode !== 0 || runtimes.exitCode !== 0) {
    throw new Error('The qualified sandbox runtime facts are unavailable.');
  }

  let runtime: unknown;
  try {
    runtime = (JSON.parse(runtimes.stdout) as Record<string, unknown>)['qdroid-runsc'];
  } catch {
    throw new Error('The configured sandbox runtime report is invalid.');
  }
  if (
    !isRecord(runtime) ||
    typeof runtime.path !== 'string' ||
    !Array.isArray(runtime.runtimeArgs) ||
    !runtime.runtimeArgs.every((argument) => typeof argument === 'string')
  ) {
    throw new Error('The configured sandbox runtime is incomplete.');
  }
  const runtimePath = runtime.path;
  const runtimeArguments = runtime.runtimeArgs;

  const [runtimeVersion, runtimeComponentDigests] = await Promise.all([
    runFixedNative(resources, { kind: 'runtime-version', path: runtimePath }, () =>
      runCommand(runtimePath, ['--version']),
    ),
    collectRuntimeComponentDigests(runtimePath, resources),
  ]);
  const runtimeBinaryDigest = runtimeComponentDigests[runtimePath];
  if (
    runtimeVersion.exitCode !== 0 ||
    runtimeBinaryDigest === undefined ||
    !/^[a-f0-9]{64}$/i.test(runtimeBinaryDigest)
  ) {
    throw new Error('The configured sandbox runtime binary cannot be qualified.');
  }

  return {
    architecture: architecture.stdout.trim(),
    dockerVersion: dockerVersion.stdout.trim(),
    runtimeArguments: [...runtimeArguments],
    runtimeBinaryDigest,
    runtimeComponentDigests,
    runtimeConfiguration: JSON.stringify(runtime),
    runtimePath,
    runtimeVersion: runtimeVersion.stdout.trim(),
  };
}

async function inspectImageId(image: string, resources?: RuntimeResourceOps): Promise<string> {
  const inspected = await runFixedNative(resources, { imageId: image, kind: 'image-id' }, () =>
    runDocker(['image', 'inspect', '--format', '{{.Id}}', image]),
  );
  const imageId = inspected.stdout.trim();
  if (inspected.exitCode !== 0 || !isImmutableImageReference(imageId)) {
    throw new Error('The sandbox image is not an available immutable local image ID.');
  }
  return imageId;
}

function validateIdentity(identity: SandboxIdentityBinding): void {
  for (const value of Object.values(identity)) {
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) {
      throw new Error('The supervised sandbox identity is invalid.');
    }
  }
  if (!Number.isSafeInteger(identity.epoch) || identity.epoch < 1) {
    throw new Error('The supervised sandbox identity epoch is invalid.');
  }
}

function validateExecutionRequest(
  request: SandboxExecutionRequest,
  profileId: SandboxProfileId,
): void {
  if (
    (profileId !== 'tool-offline' &&
      profileId !== 'build-restricted' &&
      profileId !== 'render-offline') ||
    !isAbsolutePath(request.executable) ||
    Buffer.byteLength(request.executable) > MAX_EXECUTABLE_BYTES ||
    !isAbsolutePath(request.cwd) ||
    request.argv.length > MAX_ARGUMENTS ||
    !request.argv.every((argument) => isBoundedArgument(argument))
  ) {
    throw new Error('The trusted sandbox execution request is invalid.');
  }

  const environment = Object.entries(request.environment);
  if (
    environment.length > MAX_ENVIRONMENT_ENTRIES ||
    !environment.every(
      ([key, value]) =>
        /^(LANG|LC_ALL|TZ|QDROID_[A-Z0-9_]+)$/.test(key) &&
        !value.includes('\0') &&
        Buffer.byteLength(value) <= MAX_ENVIRONMENT_VALUE_BYTES,
    )
  ) {
    throw new Error('The trusted sandbox environment is invalid.');
  }
}

function parseCleanupJournal(source: string): CleanupJournal {
  const value = JSON.parse(source) as unknown;
  if (
    !isRecord(value) ||
    (value.version !== LEGACY_CLEANUP_JOURNAL_VERSION && value.version !== CLEANUP_JOURNAL_VERSION)
  ) {
    throw new Error('The cleanup journal version is unsupported.');
  }
  if (
    !isSafeSessionId(value.sessionId) ||
    !isSafeContainerName(value.containerName) ||
    typeof value.authenticationTag !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.authenticationTag) ||
    !isRecord(value.labels) ||
    Object.keys(value.labels).length !== 3 ||
    !isProcessIdentity(value.parent) ||
    !isProcessIdentity(value.guardian) ||
    typeof value.imageId !== 'string' ||
    !isImmutableImageReference(value.imageId) ||
    typeof value.ownerId !== 'string' ||
    typeof value.hostBootId !== 'string' ||
    typeof value.profileDigest !== 'string' ||
    value.labels['io.qdroid.owner'] !== value.ownerId ||
    value.labels['io.qdroid.profile'] !== value.profileDigest ||
    value.labels['io.qdroid.session'] !== value.sessionId ||
    (value.profileId !== 'tool-offline' &&
      value.profileId !== 'build-restricted' &&
      value.profileId !== 'render-offline') ||
    (value.containerId !== undefined &&
      (typeof value.containerId !== 'string' || !isContainerId(value.containerId))) ||
    (value.version === CLEANUP_JOURNAL_VERSION &&
      (!isKnownProcessIdentity(value.guardian) ||
        !Number.isSafeInteger(value.guardianPgid) ||
        (value.guardianPgid as number) < 1 ||
        (value.creationAuthorization !== 'not-authorized' &&
          value.creationAuthorization !== 'possibly-submitted') ||
        (value.recoveryWriter === undefined && value.recoveryWriterPgid !== undefined) ||
        (value.recoveryWriter !== undefined && value.recoveryWriterPgid === undefined) ||
        (value.recoveryWriter !== undefined &&
          (!isKnownProcessIdentity(value.recoveryWriter) ||
            !Number.isSafeInteger(value.recoveryWriterPgid) ||
            (value.recoveryWriterPgid as number) < 1)))) ||
    (value.version === LEGACY_CLEANUP_JOURNAL_VERSION &&
      (value.guardianPgid !== undefined ||
        value.creationAuthorization !== undefined ||
        value.recoveryWriter !== undefined ||
        value.recoveryWriterPgid !== undefined))
  ) {
    throw new Error('The cleanup journal is invalid.');
  }
  return value as unknown as CleanupJournal;
}

function cleanupJournalPayload(journal: CleanupJournalIntent): CleanupJournalIntent {
  return {
    ...(journal.containerId === undefined ? {} : { containerId: journal.containerId }),
    containerName: journal.containerName,
    ...(journal.version === CLEANUP_JOURNAL_VERSION
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

function parseCreateReceipt(source: string): CreateReceipt {
  const value = JSON.parse(source) as unknown;
  if (
    !isRecord(value) ||
    value.version !== CREATE_RECEIPT_VERSION ||
    !isSafeSessionId(value.sessionId) ||
    !isSafeContainerName(value.containerName) ||
    !isKnownProcessIdentity(value.guardian) ||
    typeof value.hostBootId !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(value.hostBootId) ||
    typeof value.authenticationTag !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.authenticationTag)
  ) {
    throw new Error('The create receipt is invalid.');
  }
  return value as unknown as CreateReceipt;
}

function createReceiptPayload(receipt: CreateReceiptIntent | CreateReceipt): CreateReceiptIntent {
  return {
    containerName: receipt.containerName,
    guardian: receipt.guardian,
    hostBootId: receipt.hostBootId,
    sessionId: receipt.sessionId,
    version: receipt.version,
  };
}

function networkFixtureCleanupPayload(
  record: NetworkFixtureCleanupIntent,
): NetworkFixtureCleanupIntent {
  const payload: NetworkFixtureCleanupIntent = {
    addresses: [...record.addresses],
    controller: record.controller,
    controllerPgid: record.controllerPgid,
    hostBootId: record.hostBootId,
    interfaceName: record.interfaceName,
    kind: record.kind,
    marker: record.marker,
    parent: record.parent,
    sessionId: record.sessionId,
    version: record.version,
  };
  if (
    record.version === NETWORK_FIXTURE_RECOVERY_WRITER_RECORD_VERSION ||
    record.version === NETWORK_FIXTURE_RECORD_VERSION
  ) {
    return {
      ...payload,
      ...(record.recoveryWriter === undefined ? {} : { recoveryWriter: record.recoveryWriter }),
      ...(record.recoveryWriterPgid === undefined
        ? {}
        : { recoveryWriterPgid: record.recoveryWriterPgid }),
      ...(record.qualificationOperation === undefined
        ? {}
        : {
            qualificationOperation: networkFixtureQualificationOperationPayload(
              record.qualificationOperation,
            ),
          }),
    };
  }
  return payload;
}

function networkFixtureQualificationOperationPayload(
  operation: NetworkFixtureQualificationOperation,
): NetworkFixtureQualificationOperation {
  return {
    ...(operation.containerId === undefined ? {} : { containerId: operation.containerId }),
    containerName: operation.containerName,
    imageId: operation.imageId,
    labels: {
      'io.qdroid.owner': operation.labels['io.qdroid.owner'],
      'io.qdroid.profile': operation.labels['io.qdroid.profile'],
      'io.qdroid.session': operation.labels['io.qdroid.session'],
    },
    profileDigest: operation.profileDigest,
    state: operation.state,
  };
}

function parseNetworkFixtureCleanupRecord(source: string): NetworkFixtureCleanupRecord {
  const value = JSON.parse(source) as unknown;
  const expectedAddresses = networkFixtureAddresses();
  const isLegacyRecord =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version === NETWORK_FIXTURE_LEGACY_RECORD_VERSION;
  const hasValidRecoveryWriter =
    isRecord(value) &&
    ((value.recoveryWriter === undefined && value.recoveryWriterPgid === undefined) ||
      (isKnownProcessIdentity(value.recoveryWriter) &&
        Number.isSafeInteger(value.recoveryWriterPgid) &&
        (value.recoveryWriterPgid as number) > 0));
  const hasValidQualificationOperation =
    isRecord(value) &&
    (value.qualificationOperation === undefined ||
      isNetworkFixtureQualificationOperation(value.qualificationOperation));
  if (
    !isRecord(value) ||
    (value.version !== NETWORK_FIXTURE_LEGACY_RECORD_VERSION &&
      value.version !== NETWORK_FIXTURE_RECOVERY_WRITER_RECORD_VERSION &&
      value.version !== NETWORK_FIXTURE_RECORD_VERSION) ||
    value.kind !== NETWORK_FIXTURE_KIND ||
    typeof value.authenticationTag !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.authenticationTag) ||
    !isSafeSessionId(value.sessionId) ||
    typeof value.interfaceName !== 'string' ||
    !/^qd4[a-f0-9]{10}$/.test(value.interfaceName) ||
    typeof value.marker !== 'string' ||
    !/^02(?::[a-f0-9]{2}){5}$/i.test(value.marker) ||
    !isProcessIdentity(value.parent) ||
    !isProcessIdentity(value.controller) ||
    !Number.isSafeInteger(value.controllerPgid) ||
    (value.controllerPgid as number) < 1 ||
    typeof value.hostBootId !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(value.hostBootId) ||
    !Array.isArray(value.addresses) ||
    value.addresses.length !== expectedAddresses.length ||
    !value.addresses.every(
      (address, index) => typeof address === 'string' && address === expectedAddresses[index],
    ) ||
    !hasValidRecoveryWriter ||
    !hasValidQualificationOperation ||
    (isLegacyRecord &&
      (value.recoveryWriter !== undefined ||
        value.recoveryWriterPgid !== undefined ||
        value.qualificationOperation !== undefined)) ||
    (value.version === NETWORK_FIXTURE_RECOVERY_WRITER_RECORD_VERSION &&
      value.qualificationOperation !== undefined)
  ) {
    throw new Error('The network fixture cleanup record is invalid.');
  }

  return value as unknown as NetworkFixtureCleanupRecord;
}

function isNetworkFixtureQualificationOperation(
  value: unknown,
): value is NetworkFixtureQualificationOperation {
  if (!isRecord(value)) {
    return false;
  }
  const labels = value.labels;
  const imageId = value.imageId;
  const containerId = value.containerId;
  const profileDigestValue = value.profileDigest;
  const hasExactLabels =
    isRecord(labels) &&
    labels['io.qdroid.owner'] === 'qualification' &&
    typeof labels['io.qdroid.profile'] === 'string' &&
    /^[a-f0-9]{64}$/i.test(labels['io.qdroid.profile']) &&
    typeof labels['io.qdroid.session'] === 'string' &&
    isSafeSessionId(labels['io.qdroid.session']);
  return (
    isSafeContainerName(value.containerName) &&
    typeof imageId === 'string' &&
    isImmutableImageReference(imageId) &&
    typeof profileDigestValue === 'string' &&
    /^[a-f0-9]{64}$/i.test(profileDigestValue) &&
    hasExactLabels &&
    labels['io.qdroid.profile'] === profileDigestValue &&
    (value.state === 'possibly-submitted' || value.state === 'created') &&
    (containerId === undefined || (typeof containerId === 'string' && isContainerId(containerId)))
  );
}

function isNetworkFixtureRecordName(entry: string): boolean {
  return new RegExp(
    `^${NETWORK_FIXTURE_RECORD_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-f0-9-]{36}\\.json$`,
    'i',
  ).test(entry);
}

function isExecutionJournalName(entry: string): boolean {
  return /^[a-f0-9-]{36}\.json$/i.test(entry);
}

async function writeAtomicJson(
  path: string,
  value: unknown,
  beforeRename?: () => Promise<void>,
  afterRename?: () => Promise<void>,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(value)}\n`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(serialized, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await beforeRename?.();
  await rename(temporary, path);
  await afterRename?.();
  const directory = await open(join(path, '..'), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function unlinkDurably(
  path: string,
  allowMissing = false,
  afterUnlinkBeforeDirectorySync?: () => Promise<void>,
): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  await afterUnlinkBeforeDirectorySync?.();
  await syncContainingDirectory(path);
}

async function syncContainingDirectory(path: string): Promise<void> {
  const directory = await open(join(path, '..'), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function isDefinitelyMissingPath(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function readOrCreateJournalKey(ownerStorePath: string): Promise<Buffer> {
  const path = join(ownerStorePath, JOURNAL_KEY_FILE);
  try {
    const file = await open(path, 'wx', 0o600);
    try {
      const key = randomBytes(32);
      await file.writeFile(key);
      await file.sync();
      return key;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  const metadata = await stat(path);
  const key = await readFile(path);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || key.byteLength !== 32) {
    throw new Error('The sandbox cleanup journal key is invalid.');
  }
  return key;
}

async function processIdentity(pid: number | undefined): Promise<ProcessIdentity> {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid < 1) {
    return { pid: -1, start: null };
  }
  return { pid, start: await readProcessStart(pid) };
}

async function readTrustedBootId(): Promise<string> {
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (!/^[a-f0-9-]{36}$/i.test(bootId)) {
    throw new Error('The sandbox host boot identity is invalid.');
  }
  return bootId;
}

async function isLiveProcess(identity: ProcessIdentity): Promise<boolean> {
  if (identity.pid < 1) {
    return false;
  }
  const current = await readProcessStart(identity.pid);
  return current !== null && current === identity.start;
}

async function readProcessGroupId(pid: number): Promise<number> {
  const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  const parsed = parseObservedProcessGroupId(contents);
  if (parsed < 1) {
    throw new Error('The trusted process group identity is invalid.');
  }
  return parsed;
}

/**
 * Parses the process-group field observed in a Linux /proc/<pid>/stat record.
 *
 * The process group of a newly-created trusted controller must be positive,
 * but the process table also includes kernel workers in process group zero.
 * Readers that enumerate every process must accept those records and simply
 * skip them when looking for a positive controller group.
 */
export function parseObservedProcessGroupId(contents: string): number {
  const closeParenthesis = contents.lastIndexOf(')');
  const processGroup = contents.slice(closeParenthesis + 2).split(' ')[2];
  const parsed = Number.parseInt(processGroup ?? '', 10);
  if (closeParenthesis < 0 || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('The observed process group identity is invalid.');
  }
  return parsed;
}

async function isLiveProcessGroup(processGroupId: number): Promise<boolean> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) {
    throw new Error('The trusted process group identity is invalid.');
  }
  const entries = await readdir('/proc');
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number.parseInt(entry, 10);
    try {
      const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
      const observedProcessGroupId = parseObservedProcessGroupId(contents);
      if (observedProcessGroupId === 0) {
        continue;
      }
      if (observedProcessGroupId === processGroupId) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A process can exit between directory enumeration and identity read.
        continue;
      }
      throw error;
    }
  }
  return false;
}

async function waitForProcessGroupExit(processGroupId: number): Promise<boolean> {
  return waitForProcessGroupExitAt(
    processGroupId,
    Date.now() + NETWORK_FIXTURE_CONTROLLER_LIFECYCLE_DEADLINE_MS,
  );
}

async function waitForProcessGroupExitAt(
  processGroupId: number,
  deadline: number,
): Promise<boolean> {
  for (;;) {
    if (!(await isLiveProcessGroup(processGroupId))) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(25);
  }
}

async function waitForRecordedProcessExit(identity: ProcessIdentity): Promise<boolean> {
  return waitForRecordedProcessExitAt(identity, Date.now() + STOP_CLEANUP_DEADLINE_MS);
}

async function waitForRecordedProcessExitAt(
  identity: ProcessIdentity,
  deadline: number,
): Promise<boolean> {
  for (;;) {
    if (!(await isLiveProcess(identity))) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(25);
  }
}

async function waitForGuardianAndGroupExitAt(
  guardian: ProcessIdentity,
  guardianPgid: number,
  deadline: number,
): Promise<boolean> {
  if (!isKnownProcessIdentity(guardian) || guardianPgid < 1) {
    return false;
  }

  const [guardianExited, groupExited] = await Promise.all([
    waitForRecordedProcessExitAt(guardian, deadline),
    waitForProcessGroupExitAt(guardianPgid, deadline),
  ]);
  return guardianExited && groupExited;
}

async function assertTrustedProfileNetworkFixturePrerequisites(
  interfaceName: string,
): Promise<void> {
  const [addresses, links] = await Promise.all([
    runCommand('ip', ['-o', 'address', 'show']),
    runCommand('ip', ['-o', 'link', 'show']),
  ]);
  if (addresses.exitCode !== 0 || links.exitCode !== 0) {
    throw new Error('The trusted profile network fixture prerequisites are unavailable.');
  }

  const addressTokens = new Set(addresses.stdout.split(/\s+/));
  if (networkFixtureAddresses().some((address) => addressTokens.has(address))) {
    throw new Error('A trusted profile network fixture address is already in use.');
  }
  if (links.stdout.includes(`: ${interfaceName}:`)) {
    throw new Error('A trusted profile network fixture interface is already in use.');
  }
}

export function parseTrustedProcessStart(contents: string): string {
  const closeParenthesis = contents.lastIndexOf(')');
  if (closeParenthesis < 0) {
    throw new Error('The trusted process start identity is invalid.');
  }

  const fields = contents.slice(closeParenthesis + 2).split(' ');
  const start = fields[19];
  if (start === undefined || !/^\d+$/.test(start)) {
    throw new Error('The trusted process start identity is invalid.');
  }

  return start;
}

async function readProcessStart(pid: number): Promise<string | null> {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
    return parseTrustedProcessStart(contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function acquireRecoveryLock(
  ownerStorePath: string,
  beforeLeaseReturn?: () => Promise<void>,
): Promise<RecoveryLockLease | undefined> {
  const path = join(ownerStorePath, RECOVERY_LOCK_DATABASE_FILE);
  const database = new DatabaseSync(path);

  try {
    database.exec(`PRAGMA busy_timeout = ${RECOVERY_LOCK_BUSY_TIMEOUT_MS}`);
    database.exec('PRAGMA trusted_schema = OFF');
    try {
      database.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      if (isSqliteBusy(error)) {
        database.close();
        return undefined;
      }
      throw error;
    }
    try {
      initializeOrValidateRecoveryLockDatabase(database);
      database.exec('COMMIT');
    } catch (error) {
      rollbackTransaction(database);
      throw error;
    }

    await chmod(path, 0o600);
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error('The sandbox recovery lock database must be a private regular file.');
    }

    try {
      database.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if (isSqliteBusy(error)) {
        database.close();
        return undefined;
      }
      throw error;
    }

    // The caller owns the lease only after this function returns it. A trusted
    // test can pause at that boundary to prove a deadline loser releases the
    // exact SQLite transaction without starting recovery work.
    await beforeLeaseReturn?.();

    return {
      database,
      mutations: new RecoveryLeaseMutations(),
      releaseScheduled: false,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

function initializeOrValidateRecoveryLockDatabase(database: DatabaseSync): void {
  const schema = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recovery_lock'")
    .get() as { sql?: unknown } | undefined;

  if (schema === undefined) {
    database.exec(
      'CREATE TABLE recovery_lock (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL CHECK (schema_version = 1)) STRICT',
    );
    database.exec(
      `INSERT INTO recovery_lock (id, schema_version) VALUES (1, ${RECOVERY_LOCK_SCHEMA_VERSION})`,
    );
    database.exec(`PRAGMA user_version = ${RECOVERY_LOCK_SCHEMA_VERSION}`);
  }

  const expectedSchema =
    'CREATE TABLE recovery_lock (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL CHECK (schema_version = 1)) STRICT';
  const actualSchema = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recovery_lock'")
    .get() as { sql?: unknown } | undefined;
  const version = database.prepare('PRAGMA user_version').get() as
    | { user_version?: unknown }
    | undefined;
  const rows = database
    .prepare('SELECT id, schema_version FROM recovery_lock ORDER BY id')
    .all() as Array<{ id?: unknown; schema_version?: unknown }>;

  const isExpectedDatabase =
    actualSchema?.sql === expectedSchema &&
    version?.user_version === RECOVERY_LOCK_SCHEMA_VERSION &&
    rows.length === 1 &&
    rows[0]?.id === 1 &&
    rows[0]?.schema_version === RECOVERY_LOCK_SCHEMA_VERSION;
  if (!isExpectedDatabase) {
    throw new Error('The sandbox recovery lock database has an unsupported schema.');
  }
}

function isSqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error && /SQLITE_BUSY|database is locked|database is busy/i.test(error.message)
  );
}

function rollbackTransaction(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // The transaction may already be gone after a failed BEGIN/COMMIT.
  }
}

async function releaseRecoveryLock(lease: RecoveryLockLease): Promise<void> {
  if (lease.releaseScheduled) {
    return;
  }
  lease.releaseScheduled = true;

  const mutationsSettled = lease.mutations.close();
  if (lease.mutations.hasPending) {
    // Do not await this from the bounded recovery API. The SQLite transaction
    // remains open until a non-cancellable filesystem mutation has actually
    // settled, so another owner cannot race a late rename or unlink.
    void mutationsSettled
      .then(async () => {
        await releaseRecoveryLockDatabase(lease);
      })
      .catch(() => undefined);
    return;
  }

  await releaseRecoveryLockDatabase(lease);
}

async function releaseRecoveryLockDatabase(lease: RecoveryLockLease): Promise<void> {
  try {
    rollbackTransaction(lease.database);
  } finally {
    lease.database.close();
  }
}

export function isConfirmedContainerAbsence(
  result: DockerCommandResult,
  containerName: string,
): boolean {
  if (result.commandCompleted === false) {
    return false;
  }
  const knownAbsenceMessages = new Set([
    `Error response from daemon: No such container: ${containerName}`,
    `Error: No such object: ${containerName}`,
    `error: no such object: ${containerName}`,
  ]);
  return (
    result.exitCode !== 0 &&
    result.stdout.trim() === '' &&
    knownAbsenceMessages.has(result.stderr.trim())
  );
}

async function collectRuntimeComponentDigests(
  runtimePath: string,
  resources?: RuntimeResourceOps,
): Promise<Record<string, string>> {
  const paths = [...new Set([runtimePath, ...RUNTIME_COMPONENT_PATHS])];
  const entries = await Promise.all(
    paths.map(async (path) => {
      const checksum = await runFixedNative(
        resources,
        { kind: 'runtime-component-sha256', path },
        () => runCommand('sha256sum', [path]),
      );
      const digest = checksum.stdout.trim().split(/\s+/)[0];
      if (checksum.exitCode !== 0 || digest === undefined || !/^[a-f0-9]{64}$/i.test(digest)) {
        throw new Error('A required sandbox runtime component cannot be qualified.');
      }
      return [path, digest] as const;
    }),
  );

  return Object.fromEntries(entries);
}

interface TrustedCommandOptions {
  signal?: AbortSignal | undefined;
}

async function runFixedNative(
  resources: RuntimeResourceOps | undefined,
  intent: import('./resource-ops.js').FixedNativeIntent,
  fallback: () => Promise<DockerCommandResult>,
): Promise<DockerCommandResult> {
  if (resources === undefined) {
    return fallback();
  }

  const owned = await resources.native(intent);
  const result = await owned.completion;
  if (!result.cleanupConfirmed) {
    throw new Error('A managed trusted native command has unresolved cleanup.');
  }
  return {
    commandCompleted: true,
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

async function runDocker(
  argumentsValue: string[],
  options: TrustedCommandOptions = {},
): Promise<DockerCommandResult> {
  return runCommand('docker', argumentsValue, options);
}

async function runCommand(
  command: string,
  argumentsValue: string[],
  options: TrustedCommandOptions = {},
): Promise<DockerCommandResult> {
  if (options.signal?.aborted) {
    return {
      commandCompleted: false,
      exitCode: 1,
      stderr: 'The trusted command was cancelled before it could start.',
      stdout: '',
    };
  }
  const child = spawn(command, argumentsValue, {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let outputLimited = false;
  child.stdout.on('data', (chunk: Buffer) => {
    const remaining = 65_536 - Buffer.byteLength(stdout);
    if (remaining <= 0) {
      outputLimited = true;
      return;
    }
    if (chunk.byteLength > remaining) {
      outputLimited = true;
      stdout += chunk.subarray(0, remaining).toString('utf8');
      return;
    }
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const remaining = 65_536 - Buffer.byteLength(stderr);
    if (remaining <= 0) {
      outputLimited = true;
      return;
    }
    if (chunk.byteLength > remaining) {
      outputLimited = true;
      stderr += chunk.subarray(0, remaining).toString('utf8');
      return;
    }
    stderr += chunk.toString('utf8');
  });
  const result = await new Promise<Pick<DockerCommandResult, 'commandCompleted' | 'exitCode'>>(
    (resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const finish = (exitCode: number, commandCompleted: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        options.signal?.removeEventListener('abort', terminate);
        resolve({ commandCompleted, exitCode });
      };
      const terminate = (): void => {
        try {
          if (process.platform !== 'win32' && child.pid !== undefined) {
            process.kill(-child.pid, 'SIGKILL');
            return;
          }
        } catch {
          // The bounded command may have exited immediately before termination.
        }
        child.kill('SIGKILL');
      };
      timeout = setTimeout(() => {
        terminate();
        finish(1, false);
      }, 10_000);
      options.signal?.addEventListener('abort', terminate, { once: true });
      child.once('error', () => finish(1, false));
      child.once('close', (code) => finish(outputLimited ? 1 : (code ?? 1), true));
    },
  );
  return { ...result, stderr, stdout };
}

function profileDigest(profile: OfflineSandboxProfile): string {
  return digestJson(profile);
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage);
}

function isImmutableImageReference(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/i.test(value);
}

function isContainerId(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function isSafeContainerName(value: unknown): value is string {
  return typeof value === 'string' && /^qdroid-t004-[a-z0-9-]{1,100}$/.test(value);
}

function isSafeSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  return (
    isRecord(value) &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    (typeof value.start === 'string' || value.start === null)
  );
}

function isKnownProcessIdentity(value: unknown): value is ProcessIdentity {
  return (
    isProcessIdentity(value) &&
    value.pid > 0 &&
    typeof value.start === 'string' &&
    /^\d+$/.test(value.start)
  );
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') && !value.includes('\0');
}

function isBoundedArgument(value: string): boolean {
  return !value.includes('\0') && Buffer.byteLength(value) <= MAX_ARGUMENT_BYTES;
}

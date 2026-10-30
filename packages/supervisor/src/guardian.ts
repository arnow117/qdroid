import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import type { FixedProfileProbeSelector } from './fixed-probe-catalog.js';
import type { SandboxProfileId } from '../../contracts/src/index.js';

const GUARDIAN_READY_DEADLINE_MS = 10_000;
const BOUNDARY_OPERATION_DEADLINE_MS = 10_000;
const MAX_PENDING_INPUT_BYTES = 1_048_576;
const MAX_OUTPUT_CREDIT_BYTES = 65_536;
const MAX_OUTPUT_CHUNK_BYTES = 16_384;
const MAX_TRUSTED_WORKER_STDERR_BYTES = 4_096;

/** Private protocol marker for the closed fixed-probe lifecycle only. */
export const FIXED_PROBE_PROTOCOL = 'qdroid.fixed-probe/v1';
/** Private protocol marker for the fixed managed-assembly lifecycle only. */
export const FIXED_ASSEMBLY_PROTOCOL = 'qdroid.fixed-assembly/v1';
/**
 * Private protocol marker for the fixed host-boundary control keeper.  It is
 * deliberately distinct from fixed-probe/v1 so an older worker rejects the
 * boundary binding instead of silently treating it as an ordinary probe.
 */
export const FIXED_BOUNDARY_CONTROL_PROTOCOL = 'qdroid.fixed-boundary-control/v1';
/** Private protocol marker for the one fixed negative boundary probe. */
export const FIXED_BOUNDARY_PROBE_PROTOCOL = 'qdroid.fixed-boundary-probe/v1';
/** Private protocol marker for one fixed network-control keeper. */
export const FIXED_NETWORK_CONTROL_PROTOCOL = 'qdroid.fixed-network-control/v1';

export type GuardianStopReason = 'completed' | 'deadline' | 'output-limit' | 'stopped';

/**
 * Fixed host facts used by the trusted OCI qualifier. This is deliberately a
 * closed list: the guardian is never a relay for a caller supplied executable,
 * argument vector, path, or Docker format string.
 */
export type GuardianNativeIntent =
  | { readonly kind: 'docker-runtime-info' }
  | { readonly kind: 'docker-server-version' }
  | { readonly imageId: string; readonly kind: 'image-id' | 'legacy-image-inspect' }
  | { readonly kind: 'kernel-release' }
  | { readonly kind: 'legacy-io-device-number' }
  | { readonly kind: 'legacy-io-root-parent' }
  | { readonly kind: 'legacy-io-root-source' }
  | { readonly kind: 'legacy-io-cache-drop'; readonly path: string }
  | { readonly kind: 'legacy-storage-parent' | 'legacy-storage-source' }
  | { readonly kind: 'machine-architecture' }
  | {
      readonly kind:
        | 'legacy-runtime-component-sha256'
        | 'legacy-runtime-version'
        | 'runtime-component-sha256'
        | 'runtime-version';
      readonly path: string;
    };

export interface GuardianNativeSpec {
  deadlineMs: number;
  intent: GuardianNativeIntent;
  maxOutputBytes: number;
}

/**
 * A fixed container operation used by trusted qualification only. The union
 * deliberately names the operation instead of accepting an executable,
 * command line, mount, format string, or Docker option from its caller.
 */
export type GuardianProbeProgram =
  | 'descendants'
  | 'memory'
  | 'output-limit'
  | 'pids'
  | 'scratch-read'
  | 'scratch-write'
  | 'scratch-limit';

/**
 * Every fixed probe command is selected by trusted code. The union has no
 * executable, argument, host-path, or Docker-option escape hatch.
 */
export type GuardianProbeIntent =
  | { readonly kind: 'legacy-fixed-configuration' }
  | {
      readonly kind: 'legacy-fixed-filesystem';
      readonly paths: Readonly<{
        canary: string;
        secret: string;
        store: string;
      }>;
    }
  | { readonly kind: 'legacy-fixed-program'; readonly program: GuardianProbeProgram }
  | {
      readonly kind: 'profile-fixed-program';
      readonly profileId: SandboxProfileId;
      readonly selector: Exclude<FixedProfileProbeSelector, 'host-boundary' | 'network'>;
      /** Present only for the session-owned fixed I/O fixture. */
      readonly sourcePath?: string;
    };

export interface GuardianBoundaryProbeIntent {
  readonly childPid: number;
  readonly childStart: string;
  readonly controlReceiptAuthenticationTag: string;
  readonly controlResourceId: string;
  readonly crossAppPath: string;
  readonly kind: 'profile-boundary-program';
  readonly profileId: SandboxProfileId;
  readonly trustedStorePath: string;
}

export interface GuardianProbeSpec {
  /**
   * Present only after the fixed boundary keeper has acknowledged the exact
   * already-configured probe guardian.  It is private guardian IPC, never
   * package-controlled input.
   */
  readonly boundaryAuthorization?: GuardianBoundaryProbeAuthorization;
  containerName: string;
  deadlineMs: number;
  imageId: string;
  intent: GuardianProbeIntent | GuardianBoundaryProbeIntent;
  maxOutputBytes: number;
  ownership: GuardianOwnedContainerSpec;
  protocol: typeof FIXED_PROBE_PROTOCOL | typeof FIXED_BOUNDARY_PROBE_PROTOCOL;
}

export interface GuardianBoundaryProbeAuthorization {
  readonly controlResourceId: string;
  readonly dependencyAuthenticationTag: string;
  readonly resourceId: string;
}

/**
 * The boundary probe is configured before the keeper registers it.  The
 * worker writes an authenticated configured receipt and accepts no Docker
 * lifecycle operation at this stage.
 */
export interface GuardianBoundaryProbeConfiguration {
  readonly bootId: string;
  readonly configurationReceiptPath: string;
  /** Exact O_EXCL proof of the original Docker create result. */
  readonly creationReceiptPath: string;
  readonly controlReceiptAuthenticationTag: string;
  readonly controlResourceId: string;
  readonly guardianPid: number;
  readonly guardianStart: string;
  readonly journalKey: Uint8Array;
  readonly ownerId: string;
  readonly probe: GuardianProbeSpec;
  readonly resourceId: string;
  readonly sessionId: string;
  readonly terminalReceiptPath: string;
}

export interface GuardianBoundaryProbeConfigured {
  readonly configurationAuthenticationTag: string;
}

/**
 * The host paths are derived from this BuildSession's private fixture root.
 * They are private IPC facts rather than package-facing inputs.
 */
export interface GuardianBoundaryControlSpec {
  readonly bootId: string;
  readonly fixtureRoot: string;
  readonly journalKey: Uint8Array;
  readonly keeperPid: number;
  readonly keeperStart: string;
  readonly ownerId: string;
  readonly protocol: typeof FIXED_BOUNDARY_CONTROL_PROTOCOL;
  readonly receiptPath: string;
  readonly resourceId: string;
  readonly sessionId: string;
}

export interface GuardianBoundaryControlCreated {
  readonly childPid: number;
  readonly childStart: string;
  readonly receiptAuthenticationTag: string;
}

export interface GuardianBoundaryDependencySpec {
  readonly configurationAuthenticationTag: string;
  readonly configurationReceiptPath: string;
  readonly containerName: string;
  readonly guardianGroupId: number;
  readonly guardianPid: number;
  readonly guardianStart: string;
  readonly imageId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly protocol: typeof FIXED_BOUNDARY_CONTROL_PROTOCOL;
  readonly resourceId: string;
  readonly terminalReceiptPath: string;
}

export interface GuardianBoundaryDependencyRegistration {
  readonly authenticationTag: string;
  readonly resourceId: string;
}

export interface GuardianNetworkTarget {
  readonly family: 'ipv4' | 'ipv6';
  readonly host: string;
  readonly name: 'dns' | 'tcp' | 'udp';
  readonly port: number;
}

export interface GuardianNetworkControlSpec {
  readonly bootId: string;
  readonly fixtureRoot: string;
  readonly interfaceMarker?: string;
  readonly interfaceName?: string;
  readonly journalKey: Uint8Array;
  readonly keeperGroupId: number;
  readonly keeperPid: number;
  readonly keeperStart: string;
  readonly kind: 'legacy' | 'profile';
  readonly ownerId: string;
  readonly protocol: typeof FIXED_NETWORK_CONTROL_PROTOCOL;
  readonly receiptPath: string;
  readonly resourceId: string;
  readonly sessionId: string;
  readonly terminalReceiptPath: string;
}

export interface GuardianNetworkControlCreated {
  readonly receiptAuthenticationTag: string;
  readonly targets: readonly GuardianNetworkTarget[];
}

export interface GuardianLegacyNetworkReceiptSnapshot {
  readonly settled: boolean;
  readonly tcpIpv4: boolean;
  readonly tcpIpv6: boolean;
  readonly udpDns: boolean;
  readonly udpIpv4: boolean;
}

export interface GuardianProfileNetworkReceiptSnapshot
  extends GuardianLegacyNetworkReceiptSnapshot {
  readonly udpIpv6: boolean;
}

export type GuardianNetworkReceiptSnapshot =
  | GuardianLegacyNetworkReceiptSnapshot
  | GuardianProfileNetworkReceiptSnapshot;

/**
 * A closed, stopped-container assembly recipe. Every identity and host path is
 * derived by the managed resource owner from already sealed material. The
 * guardian still validates the narrow shape before it creates anything.
 */
export interface GuardianAssemblySpec {
  readonly bootId: string;
  readonly buildOutputDirectory?: string;
  readonly candidateId: string;
  /** Exact O_EXCL receipt path for the first immutable result from Docker commit. */
  readonly commitReceiptPath: string;
  readonly containerName: string;
  /** Exact O_EXCL receipt path for the keeper's inspected create result. */
  readonly creationReceiptPath: string;
  readonly deadlineMs: number;
  readonly journalKey: Uint8Array;
  readonly materialDigest: string;
  readonly ownerId: string;
  readonly packageDirectory: string;
  readonly packageDigest: string;
  readonly platform: string;
  readonly protocol: typeof FIXED_ASSEMBLY_PROTOCOL;
  readonly purpose: 'builder' | 'runtime';
  readonly resourceId: string;
  readonly sessionId: string;
  readonly sourceImage: string;
  readonly templateDirectory: string;
  readonly terminalReceiptPath: string;
}

export interface GuardianAssemblyCreated {
  readonly containerId: string;
}

export interface GuardianAssemblyCommitted {
  readonly commitReceiptAuthenticationTag: string;
  readonly imageId: string;
}

export type GuardianProbeQuery =
  | 'configuration'
  | 'container-state'
  | 'guest-descendants'
  | 'live-cgroup';

export interface GuardianProbeBinding {
  containerId: string;
  imageId: string;
  labels: Readonly<Record<string, string>>;
}

export interface GuardianProbeCgroupSnapshot {
  cpu: Readonly<{
    counters: Readonly<{
      nrPeriods: number;
      nrThrottled: number;
      usageMicros: number;
    }>;
    periodMicros: number;
    quotaMicros: number;
  }>;
  identity: Readonly<{
    key: string;
    processId: number;
    processStart: string;
  }>;
  io: Readonly<{
    deviceMajorMinor: '253:16';
    counters: Readonly<{
      readBytes: number;
      readBytesPerSecond: number;
      writeBytesPerSecond: number;
    }>;
  }>;
  memoryCurrentBytes: number;
  memoryMaximumBytes: number;
  pidsCurrent: number;
  pidsMaximum: number;
}

export interface GuardianProbeDescendantObservation {
  attempts: number;
  observedChild: Readonly<{ pid: number; ppid: number }> | null;
  observerCommandExitCode: number | null;
  observerExcluded: boolean;
  observerPid: number | null;
  processes: readonly Readonly<{ pid: number; ppid: number }>[];
}

export type GuardianProbeInspection =
  | {
      binding: GuardianProbeBinding;
      fixedProfileVerified: boolean;
      kind: 'configuration';
    }
  | {
      binding: GuardianProbeBinding;
      exitCode: number | null;
      kind: 'container-state';
      oomKilled: boolean;
      state: 'created' | 'exited' | 'running' | 'unknown';
    }
  | {
      binding: GuardianProbeBinding;
      cgroup: GuardianProbeCgroupSnapshot;
      kind: 'live-cgroup';
    }
  | {
      binding: GuardianProbeBinding;
      kind: 'guest-descendants';
      observation: GuardianProbeDescendantObservation;
    };

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
  errorMessage?: string;
  exitCode: number | null;
  reason: GuardianStopReason;
  stderrBytes: number;
  stderrDeliveredBytes: number;
  stdoutBytes: number;
  stdoutDeliveredBytes: number;
}

/**
 * A fixed probe command can finish while its stopped container remains
 * available for the mandatory state/OOM inspection. This result therefore
 * describes only the command group, not final container removal.
 */
export interface GuardianProbeCommandCompletion {
  cleanupConfirmed: boolean;
  errorMessage?: string;
  exitCode: number | null;
  reason: GuardianStopReason;
  stderrBytes: number;
  stdoutBytes: number;
}

interface GuardianMessage {
  type: string;
}

interface GuardianCreatedMessage extends GuardianMessage {
  containerId: string;
  protocol?: typeof FIXED_PROBE_PROTOCOL | typeof FIXED_BOUNDARY_PROBE_PROTOCOL;
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

interface GuardianProbeInspectionMessage extends GuardianMessage {
  id: string;
  inspection?: GuardianProbeInspection;
  error?: string;
  protocol: typeof FIXED_PROBE_PROTOCOL | typeof FIXED_BOUNDARY_PROBE_PROTOCOL;
  type: 'probe-inspection';
}

interface GuardianProbeStartedMessage extends GuardianMessage {
  protocol: typeof FIXED_PROBE_PROTOCOL | typeof FIXED_BOUNDARY_PROBE_PROTOCOL;
  type: 'probe-started';
}

interface GuardianProbeCommandCompletionMessage extends GuardianMessage {
  completion: GuardianProbeCommandCompletion;
  protocol: typeof FIXED_PROBE_PROTOCOL | typeof FIXED_BOUNDARY_PROBE_PROTOCOL;
  type: 'probe-command-completed';
}

interface GuardianAssemblyCreatedMessage extends GuardianMessage {
  containerId: string;
  protocol: typeof FIXED_ASSEMBLY_PROTOCOL;
  type: 'assembly-created';
}

interface GuardianAssemblyCopiedMessage extends GuardianMessage {
  protocol: typeof FIXED_ASSEMBLY_PROTOCOL;
  type: 'assembly-copied';
}

interface GuardianAssemblyCommittedMessage extends GuardianMessage {
  commitReceiptAuthenticationTag: string;
  imageId: string;
  protocol: typeof FIXED_ASSEMBLY_PROTOCOL;
  type: 'assembly-committed';
}

interface GuardianBoundaryCreatedMessage extends GuardianMessage {
  childPid: number;
  childStart: string;
  protocol: typeof FIXED_BOUNDARY_CONTROL_PROTOCOL;
  receiptAuthenticationTag: string;
  type: 'boundary-created';
}

interface GuardianBoundaryResultMessage extends GuardianMessage {
  authenticationTag?: string;
  error?: string;
  id: string;
  protocol: typeof FIXED_BOUNDARY_CONTROL_PROTOCOL;
  type: 'boundary-result';
}

interface GuardianBoundaryProbeConfiguredMessage extends GuardianMessage {
  configurationAuthenticationTag: string;
  protocol: typeof FIXED_BOUNDARY_PROBE_PROTOCOL;
  type: 'boundary-probe-configured';
}

interface GuardianNetworkCreatedMessage extends GuardianMessage {
  receiptAuthenticationTag: string;
  targets: readonly GuardianNetworkTarget[];
  protocol: typeof FIXED_NETWORK_CONTROL_PROTOCOL;
  type: 'network-created';
}

interface GuardianNetworkResultMessage extends GuardianMessage {
  error?: string;
  id: string;
  protocol: typeof FIXED_NETWORK_CONTROL_PROTOCOL;
  snapshot?: GuardianNetworkReceiptSnapshot;
  type: 'network-result';
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
  private readonly pendingProbeInspections = new Map<
    string,
    {
      reject: (error: Error) => void;
      resolve: (inspection: GuardianProbeInspection) => void;
    }
  >();
  private readonly pendingBoundaryOperations = new Map<
    string,
    {
      reject: (error: Error) => void;
      resolve: (authenticationTag: string | undefined) => void;
    }
  >();
  private readonly probeStarted: Promise<void>;
  private readonly assemblyCreated: Promise<GuardianAssemblyCreated>;
  private readonly assemblyCopied: Promise<void>;
  private readonly assemblyCommitted: Promise<GuardianAssemblyCommitted>;
  private readonly boundaryCreated: Promise<GuardianBoundaryControlCreated>;
  private readonly boundaryProbeConfigured: Promise<GuardianBoundaryProbeConfigured>;
  private readonly networkCreated: Promise<GuardianNetworkControlCreated>;
  private assemblyRequested = false;
  private assemblyCreatedReceived = false;
  private assemblyCopiedReceived = false;
  private assemblyCommittedReceived = false;
  private rejectAssemblyCreated: ((error: Error) => void) | undefined;
  private rejectAssemblyCopied: ((error: Error) => void) | undefined;
  private rejectAssemblyCommitted: ((error: Error) => void) | undefined;
  private resolveAssemblyCreated: ((created: GuardianAssemblyCreated) => void) | undefined;
  private resolveAssemblyCopied: (() => void) | undefined;
  private resolveAssemblyCommitted: ((committed: GuardianAssemblyCommitted) => void) | undefined;
  private rejectBoundaryCreated: ((error: Error) => void) | undefined;
  private rejectBoundaryProbeConfigured: ((error: Error) => void) | undefined;
  private resolveBoundaryCreated: ((created: GuardianBoundaryControlCreated) => void) | undefined;
  private resolveBoundaryProbeConfigured:
    | ((configured: GuardianBoundaryProbeConfigured) => void)
    | undefined;
  private rejectNetworkCreated: ((error: Error) => void) | undefined;
  private resolveNetworkCreated: ((created: GuardianNetworkControlCreated) => void) | undefined;
  private fixedProbeCommandCompleted = false;
  private fixedProbeRemoving = false;
  private fixedProbeStartIssued = false;
  private fixedProbeStarted = false;
  private rejectProbeCommandCompletion: ((error: Error) => void) | undefined;
  private rejectProbeStarted: ((error: Error) => void) | undefined;
  private resolveProbeCommandCompletion:
    | ((completion: GuardianProbeCommandCompletion) => void)
    | undefined;
  private resolveProbeStarted: (() => void) | undefined;
  private closed = false;
  private createdReceived = false;
  private lifecycleCommandIssued = false;
  private nativeStartRequested = false;
  private fixedProbeRequested = false;
  private fixedProbeProtocol: typeof FIXED_PROBE_PROTOCOL | typeof FIXED_BOUNDARY_PROBE_PROTOCOL =
    FIXED_PROBE_PROTOCOL;
  private boundaryControlRequested = false;
  private boundaryCreatedReceived = false;
  private boundaryProbeConfigurationRequested = false;
  private boundaryProbeConfiguredReceived = false;
  private networkControlRequested = false;
  private networkCreatedReceived = false;
  private readonly pendingNetworkOperations = new Map<
    string,
    {
      reject: (error: Error) => void;
      resolve: (snapshot: GuardianNetworkReceiptSnapshot | undefined) => void;
    }
  >();
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
  /** Resolves once the fixed command group, rather than its container, settles. */
  public readonly probeCommandCompletion: Promise<GuardianProbeCommandCompletion>;

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
    this.probeCommandCompletion = new Promise<GuardianProbeCommandCompletion>((resolve, reject) => {
      this.resolveProbeCommandCompletion = resolve;
      this.rejectProbeCommandCompletion = reject;
    });
    this.probeStarted = new Promise<void>((resolve, reject) => {
      this.resolveProbeStarted = resolve;
      this.rejectProbeStarted = reject;
    });
    this.assemblyCreated = new Promise<GuardianAssemblyCreated>((resolve, reject) => {
      this.resolveAssemblyCreated = resolve;
      this.rejectAssemblyCreated = reject;
    });
    this.assemblyCopied = new Promise<void>((resolve, reject) => {
      this.resolveAssemblyCopied = resolve;
      this.rejectAssemblyCopied = reject;
    });
    this.assemblyCommitted = new Promise<GuardianAssemblyCommitted>((resolve, reject) => {
      this.resolveAssemblyCommitted = resolve;
      this.rejectAssemblyCommitted = reject;
    });
    this.boundaryCreated = new Promise<GuardianBoundaryControlCreated>((resolve, reject) => {
      this.resolveBoundaryCreated = resolve;
      this.rejectBoundaryCreated = reject;
    });
    this.boundaryProbeConfigured = new Promise<GuardianBoundaryProbeConfigured>(
      (resolve, reject) => {
        this.resolveBoundaryProbeConfigured = resolve;
        this.rejectBoundaryProbeConfigured = reject;
      },
    );

    this.networkCreated = new Promise<GuardianNetworkControlCreated>((resolve, reject) => {
      this.resolveNetworkCreated = resolve;
      this.rejectNetworkCreated = reject;
    });

    // A guardian may be stopped or exit before start() begins waiting for its
    // input-ready message. Observe both internal promises immediately so that
    // an early lifecycle failure cannot become an unhandled rejection. The
    // original promises remain rejected for the later public start/completion
    // caller.
    void this.created.catch(() => undefined);
    void this.completion.catch(() => undefined);
    void this.probeCommandCompletion.catch(() => undefined);
    void this.probeStarted.catch(() => undefined);
    void this.assemblyCreated.catch(() => undefined);
    void this.assemblyCopied.catch(() => undefined);
    void this.assemblyCommitted.catch(() => undefined);
    void this.boundaryCreated.catch(() => undefined);
    void this.boundaryProbeConfigured.catch(() => undefined);
    void this.networkCreated.catch(() => undefined);

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
   * Runs one closed, trusted host-fact operation under this guardian. Native
   * commands have no stdin; output still uses the same bounded credit window
   * as normal container execution.
   */
  public async startNative(spec: GuardianNativeSpec): Promise<void> {
    this.lifecycleCommandIssued = true;
    this.nativeStartRequested = true;
    await this.send({ ...spec, type: 'native' });
    await this.waitForCreated();
  }

  /**
   * Starts the one private boundary keeper after ResourceOps has persisted the
   * guardian identity and provider acknowledgement. This has no Docker effect.
   */
  public async createBoundaryControl(
    spec: GuardianBoundaryControlSpec,
  ): Promise<GuardianBoundaryControlCreated> {
    if (this.closed || this.lifecycleCommandIssued || this.boundaryControlRequested) {
      throw new Error('The sandbox guardian is not available for boundary control creation.');
    }
    this.boundaryControlRequested = true;
    this.lifecycleCommandIssued = true;
    return this.sendAndObserveBoundaryOperation(
      { ...spec, type: 'boundary-create' },
      this.boundaryCreated,
      'boundary control creation',
    );
  }

  /**
   * Durably configures the one host-boundary probe before the boundary keeper
   * registers its dependency.  This closed operation has no Docker effect.
   */
  public async configureBoundaryProbe(
    spec: GuardianBoundaryProbeConfiguration,
  ): Promise<GuardianBoundaryProbeConfigured> {
    if (
      this.closed ||
      this.lifecycleCommandIssued ||
      this.boundaryProbeConfigurationRequested ||
      spec.probe.protocol !== FIXED_BOUNDARY_PROBE_PROTOCOL
    ) {
      throw new Error('The sandbox guardian is not available for boundary probe configuration.');
    }

    this.boundaryProbeConfigurationRequested = true;
    this.lifecycleCommandIssued = true;
    return this.sendAndObserveBoundaryOperation(
      { ...spec, type: 'boundary-probe-configure' },
      this.boundaryProbeConfigured,
      'boundary probe configuration',
    );
  }

  /**
   * Starts one fixed listener keeper. The keeper receives only code-owned
   * kind and identity facts, and it cannot accept caller-selected endpoints.
   */
  public async createNetworkControl(
    spec: GuardianNetworkControlSpec,
  ): Promise<GuardianNetworkControlCreated> {
    if (
      this.closed ||
      this.lifecycleCommandIssued ||
      this.networkControlRequested ||
      spec.protocol !== FIXED_NETWORK_CONTROL_PROTOCOL
    ) {
      throw new Error('The sandbox guardian is not available for network control creation.');
    }

    this.networkControlRequested = true;
    this.lifecycleCommandIssued = true;
    return this.sendAndObserveBoundaryOperation(
      { ...spec, type: 'network-create' },
      this.networkCreated,
      'network control creation',
    );
  }

  public async assertNetworkControls(): Promise<void> {
    await this.requestNetworkOperation('network-assert');
  }

  public async assertNetworkPositiveControls(): Promise<void> {
    await this.requestNetworkOperation('network-positive');
  }

  public async resetNetworkReceipts(): Promise<void> {
    await this.requestNetworkOperation('network-reset');
  }

  public async snapshotNetworkReceipts(): Promise<GuardianNetworkReceiptSnapshot> {
    const snapshot = await this.requestNetworkOperation('network-snapshot');
    if (snapshot === undefined) {
      throw new Error('The network keeper did not return a receipt snapshot.');
    }
    return snapshot;
  }

  /** Performs only the fixed canary, process, device, and socket checks. */
  public async assertBoundaryControls(): Promise<void> {
    await this.requestBoundaryOperation('boundary-assert');
  }

  /**
   * Durably registers one already-configured probe guardian before its Docker
   * create authorization. The worker rejects any lifecycle other than its one
   * private boundary keeper.
   */
  public async registerBoundaryDependency(
    spec: GuardianBoundaryDependencySpec,
  ): Promise<GuardianBoundaryDependencyRegistration> {
    const authenticationTag = await this.requestBoundaryOperation('boundary-register', spec);
    if (authenticationTag === undefined) {
      throw new Error('The boundary keeper did not authenticate its dependency registration.');
    }
    return Object.freeze({ authenticationTag, resourceId: spec.resourceId });
  }

  /** Retires only a previously authenticated, exact dependency. */
  public async releaseBoundaryDependency(
    resourceId: string,
    authenticationTag: string,
  ): Promise<void> {
    await this.requestBoundaryOperation('boundary-release', { authenticationTag, resourceId });
  }

  /**
   * Creates a stopped fixed qualification container. Its exact inspected
   * identity becomes observable before any probe process starts.
   */
  public async createProbe(spec: GuardianProbeSpec): Promise<string> {
    if (spec.protocol !== FIXED_PROBE_PROTOCOL && spec.protocol !== FIXED_BOUNDARY_PROBE_PROTOCOL) {
      throw new Error('The fixed probe protocol is unsupported.');
    }

    if (
      spec.protocol === FIXED_BOUNDARY_PROBE_PROTOCOL &&
      (!this.boundaryProbeConfigurationRequested ||
        !this.boundaryProbeConfiguredReceived ||
        spec.boundaryAuthorization === undefined)
    ) {
      throw new Error('The fixed boundary probe has not completed its configured keeper binding.');
    }

    if (spec.protocol === FIXED_PROBE_PROTOCOL && spec.boundaryAuthorization !== undefined) {
      throw new Error('The ordinary fixed probe cannot carry a boundary authorization.');
    }

    this.lifecycleCommandIssued = true;
    this.fixedProbeRequested = true;
    this.fixedProbeProtocol = spec.protocol;
    return this.sendAndObserveBoundaryOperation(
      { ...spec, type: 'probe-create' },
      this.created,
      'fixed probe creation',
    );
  }

  /**
   * Arms a keeper with one immutable copy-only recipe and returns only after
   * Docker has created and re-inspected the exact stopped container.
   */
  public async startAssembly(spec: GuardianAssemblySpec): Promise<GuardianAssemblyCreated> {
    if (spec.protocol !== FIXED_ASSEMBLY_PROTOCOL || this.assemblyRequested) {
      throw new Error('The fixed managed assembly protocol is unsupported.');
    }

    this.lifecycleCommandIssued = true;
    this.assemblyRequested = true;
    await this.send({ ...spec, type: 'assembly-start' });
    return this.assemblyCreated;
  }

  /** Proceeds from durable create proof to the closed template/source copy phase. */
  public async copyAssembly(): Promise<void> {
    if (!this.assemblyRequested || this.closed || !this.assemblyCreatedReceived) {
      throw new Error('The fixed managed assembly is not ready for copying.');
    }
    await this.send({ protocol: FIXED_ASSEMBLY_PROTOCOL, type: 'assembly-copy' });
    return this.assemblyCopied;
  }

  /** Proceeds from durable copy proof to the closed fixed-label commit phase. */
  public async commitAssembly(): Promise<GuardianAssemblyCommitted> {
    if (!this.assemblyRequested || this.closed || !this.assemblyCopiedReceived) {
      throw new Error('The fixed managed assembly is not ready for commit.');
    }
    await this.send({ protocol: FIXED_ASSEMBLY_PROTOCOL, type: 'assembly-commit' });
    return this.assemblyCommitted;
  }

  /**
   * Requests exact temporary-resource cleanup. A parent IPC disconnect takes
   * this same cleanup-only path without any later create, copy, or commit.
   */
  public async cleanupAssembly(): Promise<GuardianCompletion> {
    if (!this.assemblyRequested || this.closed) {
      throw new Error('The fixed managed assembly is not active.');
    }
    await this.send({ protocol: FIXED_ASSEMBLY_PROTOCOL, type: 'assembly-cleanup' });
    return this.completion;
  }

  /**
   * Runs one closed inspection against the fixed container already created by
   * createProbe(). The caller cannot provide Docker formatting or object IDs.
   */
  public async inspectProbe(query: GuardianProbeQuery): Promise<GuardianProbeInspection> {
    if (this.closed || this.fixedProbeRemoving) {
      throw new Error('The sandbox guardian is no longer available for inspection.');
    }

    const id = randomUUID();
    const inspection = new Promise<GuardianProbeInspection>((resolve, reject) => {
      this.pendingProbeInspections.set(id, { reject, resolve });
    });

    try {
      await this.send({ id, protocol: this.fixedProbeProtocol, query, type: 'probe-inspect' });
    } catch (error) {
      this.pendingProbeInspections.delete(id);
      throw error;
    }

    return inspection;
  }

  /**
   * Starts only the command bound to the already-created fixed probe.
   * Configuration probes have no start phase and are rejected by the worker.
   */
  public async startProbe(): Promise<void> {
    if (this.closed || this.fixedProbeRemoving) {
      throw new Error('The sandbox guardian is no longer available for input.');
    }
    if (this.fixedProbeStartIssued) {
      throw new Error('The fixed probe command was already started.');
    }

    this.fixedProbeStartIssued = true;
    return this.sendAndObserveBoundaryOperation(
      { protocol: this.fixedProbeProtocol, type: 'probe-start' },
      this.probeStarted,
      'fixed probe start',
    );
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
    if (this.closed || (this.fixedProbeRequested && this.fixedProbeRemoving)) {
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

  private async requestNetworkOperation(
    type: 'network-assert' | 'network-positive' | 'network-reset' | 'network-snapshot',
  ): Promise<GuardianNetworkReceiptSnapshot | undefined> {
    if (!this.networkControlRequested || this.closed) {
      throw new Error('The sandbox guardian network keeper is unavailable.');
    }

    const id = randomUUID();
    const result = new Promise<GuardianNetworkReceiptSnapshot | undefined>((resolve, reject) => {
      this.pendingNetworkOperations.set(id, { reject, resolve });
    });

    return this.sendAndObserveBoundaryOperation(
      { id, protocol: FIXED_NETWORK_CONTROL_PROTOCOL, type },
      result,
      `network ${type}`,
      () => this.pendingNetworkOperations.delete(id),
    );
  }

  private async sendAndObserveBoundaryOperation<T>(
    message: Record<string, unknown>,
    operation: Promise<T>,
    description: string,
    onSendFailure?: () => void,
  ): Promise<T> {
    const deadline = Date.now() + BOUNDARY_OPERATION_DEADLINE_MS;
    try {
      await this.awaitBoundaryObservation(this.send(message), description, deadline);
    } catch (error) {
      onSendFailure?.();
      throw error;
    }
    return this.awaitBoundaryObservation(operation, description, deadline);
  }

  private async awaitBoundaryObservation<T>(
    operation: Promise<T>,
    description: string,
    deadline = Date.now() + BOUNDARY_OPERATION_DEADLINE_MS,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Error(
      `The sandbox guardian ${description} did not settle before its deadline.`,
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      const remaining = deadline - Date.now();
      timer = setTimeout(() => reject(timedOut), Math.max(0, remaining));
    });

    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (error === timedOut) {
        this.handleFailure(timedOut);
        if (this.child.connected) {
          this.child.disconnect();
        }
      }
      throw error;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  public async closeInput(): Promise<void> {
    if (this.closed || (this.fixedProbeRequested && this.fixedProbeRemoving)) {
      throw new Error('The sandbox guardian is no longer available for input.');
    }

    await this.send({ type: 'close-input' });
  }

  public async stop(reason: GuardianStopReason = 'stopped'): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.fixedProbeRequested) {
      if (this.fixedProbeRemoving) {
        return;
      }
      this.fixedProbeRemoving = true;
    }

    await this.send({ reason, type: 'stop' });
  }

  private async requestBoundaryOperation(
    type: 'boundary-assert' | 'boundary-register' | 'boundary-release',
    fields: object = {},
  ): Promise<string | undefined> {
    if (this.closed || !this.boundaryControlRequested) {
      throw new Error('The sandbox boundary keeper is unavailable.');
    }
    const id = randomUUID();
    const completion = new Promise<string | undefined>((resolve, reject) => {
      this.pendingBoundaryOperations.set(id, { reject, resolve });
    });
    return this.sendAndObserveBoundaryOperation(
      { ...fields, id, protocol: FIXED_BOUNDARY_CONTROL_PROTOCOL, type },
      completion,
      `boundary ${type}`,
      () => this.pendingBoundaryOperations.delete(id),
    );
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

    if (isGuardianCreatedMessage(message)) {
      if (this.fixedProbeRequested && message.protocol !== this.fixedProbeProtocol) {
        this.handleFailure(new Error('The fixed probe guardian returned an unsupported protocol.'));
        return;
      }
      this.createdReceived = true;
      this.resolveCreated?.(message.containerId);
      this.emit('created', message.containerId);
      return;
    }

    if (isGuardianBoundaryCreatedMessage(message)) {
      if (!this.boundaryControlRequested || this.boundaryCreatedReceived) {
        this.handleFailure(
          new Error('The sandbox guardian returned an unexpected boundary create.'),
        );
        return;
      }
      this.boundaryCreatedReceived = true;
      this.resolveBoundaryCreated?.(
        Object.freeze({
          childPid: message.childPid,
          childStart: message.childStart,
          receiptAuthenticationTag: message.receiptAuthenticationTag,
        }),
      );
      return;
    }

    if (isGuardianBoundaryProbeConfiguredMessage(message)) {
      if (!this.boundaryProbeConfigurationRequested || this.boundaryProbeConfiguredReceived) {
        this.handleFailure(
          new Error('The sandbox guardian returned an unexpected boundary probe configuration.'),
        );
        return;
      }
      this.boundaryProbeConfiguredReceived = true;
      this.resolveBoundaryProbeConfigured?.(
        Object.freeze({ configurationAuthenticationTag: message.configurationAuthenticationTag }),
      );
      return;
    }

    if (isGuardianBoundaryResultMessage(message)) {
      const pending = this.pendingBoundaryOperations.get(message.id);
      this.pendingBoundaryOperations.delete(message.id);
      if (pending !== undefined) {
        if (message.error !== undefined) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.authenticationTag);
        }
      }
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

    if (isGuardianProbeInspectionMessage(message)) {
      const pending = this.pendingProbeInspections.get(message.id);
      this.pendingProbeInspections.delete(message.id);
      if (pending !== undefined) {
        if (message.error !== undefined) {
          pending.reject(new Error(message.error));
        } else if (message.inspection !== undefined) {
          pending.resolve(message.inspection);
        } else {
          pending.reject(new Error('The sandbox guardian returned an invalid probe inspection.'));
        }
      }
      return;
    }

    if (isGuardianProbeStartedMessage(message)) {
      if (
        !this.fixedProbeRequested ||
        this.fixedProbeStarted ||
        message.protocol !== this.fixedProbeProtocol
      ) {
        this.handleFailure(new Error('The sandbox guardian returned an invalid probe start.'));
        return;
      }
      this.fixedProbeStarted = true;
      this.resolveProbeStarted?.();
      return;
    }

    if (isGuardianProbeCommandCompletionMessage(message)) {
      if (
        !this.fixedProbeRequested ||
        !this.fixedProbeStarted ||
        this.fixedProbeCommandCompleted ||
        message.protocol !== this.fixedProbeProtocol
      ) {
        this.handleFailure(
          new Error('The sandbox guardian returned a command result before fixed-probe start.'),
        );
        return;
      }
      this.fixedProbeCommandCompleted = true;
      this.resolveProbeCommandCompletion?.(message.completion);
      return;
    }

    if (isGuardianNetworkCreatedMessage(message)) {
      if (!this.networkControlRequested || this.networkCreatedReceived) {
        this.handleFailure(
          new Error('The sandbox guardian returned an invalid network control create.'),
        );
        return;
      }
      this.networkCreatedReceived = true;
      this.resolveNetworkCreated?.(
        Object.freeze({
          receiptAuthenticationTag: message.receiptAuthenticationTag,
          targets: Object.freeze(message.targets.map((target) => Object.freeze({ ...target }))),
        }),
      );
      return;
    }

    if (isGuardianNetworkResultMessage(message)) {
      const pending = this.pendingNetworkOperations.get(message.id);
      if (pending === undefined) {
        this.handleFailure(new Error('The sandbox guardian returned an unknown network result.'));
        return;
      }
      this.pendingNetworkOperations.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.snapshot);
      }
      return;
    }

    if (isGuardianAssemblyCreatedMessage(message)) {
      if (!this.assemblyRequested || this.assemblyCreatedReceived) {
        this.handleFailure(
          new Error('The sandbox guardian returned an invalid managed assembly create.'),
        );
        return;
      }
      this.assemblyCreatedReceived = true;
      this.resolveAssemblyCreated?.(Object.freeze({ containerId: message.containerId }));
      return;
    }

    if (isGuardianAssemblyCopiedMessage(message)) {
      if (!this.assemblyRequested || !this.assemblyCreatedReceived || this.assemblyCopiedReceived) {
        this.handleFailure(
          new Error('The sandbox guardian returned an invalid managed assembly copy.'),
        );
        return;
      }
      this.assemblyCopiedReceived = true;
      this.resolveAssemblyCopied?.();
      return;
    }

    if (isGuardianAssemblyCommittedMessage(message)) {
      if (
        !this.assemblyRequested ||
        !this.assemblyCopiedReceived ||
        this.assemblyCommittedReceived
      ) {
        this.handleFailure(
          new Error('The sandbox guardian returned an invalid managed assembly commit.'),
        );
        return;
      }
      this.assemblyCommittedReceived = true;
      this.resolveAssemblyCommitted?.(
        Object.freeze({
          commitReceiptAuthenticationTag: message.commitReceiptAuthenticationTag,
          imageId: message.imageId,
        }),
      );
      return;
    }

    if (message.type === 'closed' && isGuardianCompletion(message.completion)) {
      this.closed = true;
      const terminalError = guardianTerminalError(message.completion);
      if (!this.createdReceived) {
        this.rejectCreated?.(
          terminalError ??
            new Error(
              this.nativeStartRequested
                ? 'The sandbox guardian rejected its fixed native operation.'
                : 'The sandbox guardian closed before accepting input.',
            ),
        );
      }
      if (this.fixedProbeRequested && !this.fixedProbeStarted) {
        this.rejectProbeStarted?.(
          terminalError ??
            new Error('The sandbox guardian closed before starting its fixed probe command.'),
        );
      }
      if (this.fixedProbeRequested && !this.fixedProbeCommandCompleted) {
        this.rejectProbeCommandCompletion?.(
          terminalError ??
            new Error('The sandbox guardian closed before completing its fixed probe command.'),
        );
      }
      if (this.assemblyRequested && !this.assemblyCreatedReceived) {
        this.rejectAssemblyCreated?.(
          terminalError ??
            new Error(
              'The sandbox guardian closed before creating its managed assembly container.',
            ),
        );
      }
      if (this.assemblyRequested && !this.assemblyCopiedReceived) {
        this.rejectAssemblyCopied?.(
          terminalError ??
            new Error('The sandbox guardian closed before copying its managed assembly material.'),
        );
      }
      if (this.assemblyRequested && !this.assemblyCommittedReceived) {
        this.rejectAssemblyCommitted?.(
          terminalError ??
            new Error('The sandbox guardian closed before committing its managed assembly image.'),
        );
      }
      if (this.boundaryControlRequested && !this.boundaryCreatedReceived) {
        this.rejectBoundaryCreated?.(
          terminalError ??
            new Error('The sandbox guardian closed before creating its boundary control.'),
        );
      }
      if (this.boundaryProbeConfigurationRequested && !this.boundaryProbeConfiguredReceived) {
        this.rejectBoundaryProbeConfigured?.(
          terminalError ??
            new Error('The sandbox guardian closed before configuring its boundary probe.'),
        );
      }
      if (this.networkControlRequested && !this.networkCreatedReceived) {
        this.rejectNetworkCreated?.(
          terminalError ??
            new Error('The sandbox guardian closed before creating its network control.'),
        );
      }
      this.rejectPendingWrites(new Error('The sandbox input stream is closed.'));
      this.rejectPendingProbeInspections(new Error('The sandbox guardian is closed.'));
      this.rejectPendingBoundaryOperations(new Error('The sandbox boundary keeper is closed.'));
      this.rejectPendingNetworkOperations(new Error('The sandbox network keeper is closed.'));
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
    this.rejectProbeStarted?.(error);
    this.rejectProbeCommandCompletion?.(error);
    this.rejectAssemblyCreated?.(error);
    this.rejectAssemblyCopied?.(error);
    this.rejectAssemblyCommitted?.(error);
    this.rejectBoundaryCreated?.(error);
    this.rejectBoundaryProbeConfigured?.(error);
    this.rejectNetworkCreated?.(error);
    this.rejectPendingWrites(error);
    this.rejectPendingProbeInspections(error);
    this.rejectPendingBoundaryOperations(error);
    this.rejectPendingNetworkOperations(error);
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

  private async waitForCreated(): Promise<string> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
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

  private rejectPendingProbeInspections(error: Error): void {
    for (const pending of this.pendingProbeInspections.values()) {
      pending.reject(error);
    }
    this.pendingProbeInspections.clear();
  }

  private rejectPendingNetworkOperations(error: Error): void {
    for (const pending of this.pendingNetworkOperations.values()) {
      pending.reject(error);
    }
    this.pendingNetworkOperations.clear();
  }

  private rejectPendingBoundaryOperations(error: Error): void {
    for (const pending of this.pendingBoundaryOperations.values()) {
      pending.reject(error);
    }
    this.pendingBoundaryOperations.clear();
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

function isGuardianNetworkCreatedMessage(value: unknown): value is GuardianNetworkCreatedMessage {
  return (
    isRecord(value) &&
    value.type === 'network-created' &&
    value.protocol === FIXED_NETWORK_CONTROL_PROTOCOL &&
    typeof value.receiptAuthenticationTag === 'string' &&
    Array.isArray(value.targets) &&
    value.targets.every(isGuardianNetworkTarget)
  );
}

function isGuardianNetworkResultMessage(value: unknown): value is GuardianNetworkResultMessage {
  return (
    isRecord(value) &&
    value.type === 'network-result' &&
    value.protocol === FIXED_NETWORK_CONTROL_PROTOCOL &&
    typeof value.id === 'string' &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.snapshot === undefined || isGuardianNetworkReceiptSnapshot(value.snapshot))
  );
}

function isGuardianNetworkTarget(value: unknown): value is GuardianNetworkTarget {
  return (
    isRecord(value) &&
    (value.family === 'ipv4' || value.family === 'ipv6') &&
    typeof value.host === 'string' &&
    (value.name === 'dns' || value.name === 'tcp' || value.name === 'udp') &&
    typeof value.port === 'number' &&
    Number.isSafeInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65_535
  );
}

function isGuardianNetworkReceiptSnapshot(value: unknown): value is GuardianNetworkReceiptSnapshot {
  return (
    isRecord(value) &&
    typeof value.settled === 'boolean' &&
    typeof value.tcpIpv4 === 'boolean' &&
    typeof value.tcpIpv6 === 'boolean' &&
    typeof value.udpDns === 'boolean' &&
    typeof value.udpIpv4 === 'boolean' &&
    (value.udpIpv6 === undefined || typeof value.udpIpv6 === 'boolean')
  );
}

function isGuardianCompletion(value: unknown): value is GuardianCompletion {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.cleanupConfirmed === 'boolean' &&
    (value.errorMessage === undefined || typeof value.errorMessage === 'string') &&
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

function guardianTerminalError(completion: GuardianCompletion): Error | undefined {
  const message = completion.errorMessage?.trim();
  return message === undefined || message === '' ? undefined : new Error(message);
}

function isGuardianProbeInspectionMessage(value: unknown): value is GuardianProbeInspectionMessage {
  if (
    !isRecord(value) ||
    value.type !== 'probe-inspection' ||
    typeof value.id !== 'string' ||
    (value.protocol !== FIXED_PROBE_PROTOCOL && value.protocol !== FIXED_BOUNDARY_PROBE_PROTOCOL)
  ) {
    return false;
  }

  return (
    (value.error === undefined || typeof value.error === 'string') &&
    (value.inspection === undefined || isGuardianProbeInspection(value.inspection))
  );
}

function isGuardianProbeStartedMessage(value: unknown): value is GuardianProbeStartedMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    (value.protocol === FIXED_PROBE_PROTOCOL || value.protocol === FIXED_BOUNDARY_PROBE_PROTOCOL) &&
    value.type === 'probe-started'
  );
}

function isGuardianProbeCommandCompletionMessage(
  value: unknown,
): value is GuardianProbeCommandCompletionMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    (value.protocol === FIXED_PROBE_PROTOCOL || value.protocol === FIXED_BOUNDARY_PROBE_PROTOCOL) &&
    value.type === 'probe-command-completed' &&
    isGuardianProbeCommandCompletion(value.completion)
  );
}

function isGuardianAssemblyCreatedMessage(value: unknown): value is GuardianAssemblyCreatedMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.protocol === FIXED_ASSEMBLY_PROTOCOL &&
    value.type === 'assembly-created' &&
    typeof value.containerId === 'string' &&
    /^[a-f0-9]{64}$/i.test(value.containerId)
  );
}

function isGuardianAssemblyCopiedMessage(value: unknown): value is GuardianAssemblyCopiedMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.protocol === FIXED_ASSEMBLY_PROTOCOL &&
    value.type === 'assembly-copied'
  );
}

function isGuardianAssemblyCommittedMessage(
  value: unknown,
): value is GuardianAssemblyCommittedMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    value.protocol === FIXED_ASSEMBLY_PROTOCOL &&
    value.type === 'assembly-committed' &&
    typeof value.commitReceiptAuthenticationTag === 'string' &&
    /^[a-f0-9]{64}$/i.test(value.commitReceiptAuthenticationTag) &&
    typeof value.imageId === 'string' &&
    /^sha256:[a-f0-9]{64}$/i.test(value.imageId)
  );
}

function isGuardianBoundaryCreatedMessage(value: unknown): value is GuardianBoundaryCreatedMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 5 &&
    value.type === 'boundary-created' &&
    value.protocol === FIXED_BOUNDARY_CONTROL_PROTOCOL &&
    typeof value.childPid === 'number' &&
    Number.isSafeInteger(value.childPid) &&
    value.childPid > 0 &&
    typeof value.childStart === 'string' &&
    /^\d+$/.test(value.childStart) &&
    typeof value.receiptAuthenticationTag === 'string' &&
    /^[a-f0-9]{64}$/i.test(value.receiptAuthenticationTag)
  );
}

function isGuardianBoundaryProbeConfiguredMessage(
  value: unknown,
): value is GuardianBoundaryProbeConfiguredMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.type === 'boundary-probe-configured' &&
    value.protocol === FIXED_BOUNDARY_PROBE_PROTOCOL &&
    typeof value.configurationAuthenticationTag === 'string' &&
    /^[a-f0-9]{64}$/i.test(value.configurationAuthenticationTag)
  );
}

function isGuardianBoundaryResultMessage(value: unknown): value is GuardianBoundaryResultMessage {
  if (
    !isRecord(value) ||
    value.type !== 'boundary-result' ||
    value.protocol !== FIXED_BOUNDARY_CONTROL_PROTOCOL ||
    typeof value.id !== 'string'
  ) {
    return false;
  }

  const keys = Object.keys(value);
  if (keys.length === 3) {
    return true;
  }
  if (keys.length !== 4) {
    return false;
  }
  if ('error' in value) {
    return typeof value.error === 'string';
  }
  return (
    typeof value.authenticationTag === 'string' && /^[a-f0-9]{64}$/i.test(value.authenticationTag)
  );
}

function isGuardianProbeCommandCompletion(value: unknown): value is GuardianProbeCommandCompletion {
  return (
    isRecord(value) &&
    (Object.keys(value).length === 5 || Object.keys(value).length === 6) &&
    typeof value.cleanupConfirmed === 'boolean' &&
    (value.errorMessage === undefined || typeof value.errorMessage === 'string') &&
    (value.exitCode === null ||
      (typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode))) &&
    (value.reason === 'completed' ||
      value.reason === 'deadline' ||
      value.reason === 'output-limit' ||
      value.reason === 'stopped') &&
    typeof value.stderrBytes === 'number' &&
    Number.isSafeInteger(value.stderrBytes) &&
    value.stderrBytes >= 0 &&
    typeof value.stdoutBytes === 'number' &&
    Number.isSafeInteger(value.stdoutBytes) &&
    value.stdoutBytes >= 0
  );
}

function isGuardianCreatedMessage(value: unknown): value is GuardianCreatedMessage {
  return (
    isRecord(value) &&
    value.type === 'created' &&
    typeof value.containerId === 'string' &&
    (value.protocol === undefined ||
      value.protocol === FIXED_PROBE_PROTOCOL ||
      value.protocol === FIXED_BOUNDARY_PROBE_PROTOCOL)
  );
}

function isGuardianProbeInspection(value: unknown): value is GuardianProbeInspection {
  if (!isRecord(value) || !isGuardianProbeBinding(value.binding)) {
    return false;
  }

  if (value.kind === 'configuration') {
    return typeof value.fixedProfileVerified === 'boolean';
  }

  if (value.kind === 'container-state') {
    return (
      (value.exitCode === null || typeof value.exitCode === 'number') &&
      typeof value.oomKilled === 'boolean' &&
      (value.state === 'created' ||
        value.state === 'exited' ||
        value.state === 'running' ||
        value.state === 'unknown')
    );
  }

  if (value.kind === 'live-cgroup') {
    return isGuardianProbeCgroupSnapshot(value.cgroup);
  }

  return (
    value.kind === 'guest-descendants' && isGuardianProbeDescendantObservation(value.observation)
  );
}

function isGuardianProbeCgroupSnapshot(value: unknown): value is GuardianProbeCgroupSnapshot {
  if (
    !isRecord(value) ||
    !isRecord(value.cpu) ||
    !isRecord(value.identity) ||
    !isRecord(value.io)
  ) {
    return false;
  }
  const cpuCounters = isRecord(value.cpu.counters) ? value.cpu.counters : undefined;
  const ioCounters = isRecord(value.io.counters) ? value.io.counters : undefined;
  const numbers = [
    value.cpu.periodMicros,
    value.cpu.quotaMicros,
    value.identity.processId,
    value.io.counters === undefined ? undefined : ioCounters?.readBytes,
    value.io.counters === undefined ? undefined : ioCounters?.readBytesPerSecond,
    value.io.counters === undefined ? undefined : ioCounters?.writeBytesPerSecond,
    value.memoryCurrentBytes,
    value.memoryMaximumBytes,
    value.pidsCurrent,
    value.pidsMaximum,
    cpuCounters?.nrPeriods,
    cpuCounters?.nrThrottled,
    cpuCounters?.usageMicros,
  ];
  return (
    typeof value.identity.key === 'string' &&
    /^[a-f0-9]{64}$/i.test(value.identity.key) &&
    typeof value.identity.processStart === 'string' &&
    /^\d+$/.test(value.identity.processStart) &&
    value.io.deviceMajorMinor === '253:16' &&
    numbers.every(
      (number) => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0,
    )
  );
}

function isGuardianProbeDescendantObservation(
  value: unknown,
): value is GuardianProbeDescendantObservation {
  if (!isRecord(value) || !Array.isArray(value.processes) || value.processes.length > 256) {
    return false;
  }
  const validProcess = (process: unknown): boolean =>
    isRecord(process) &&
    typeof process.pid === 'number' &&
    Number.isSafeInteger(process.pid) &&
    process.pid > 0 &&
    typeof process.ppid === 'number' &&
    Number.isSafeInteger(process.ppid) &&
    process.ppid >= 0;
  return (
    typeof value.attempts === 'number' &&
    Number.isSafeInteger(value.attempts) &&
    value.attempts >= 0 &&
    (value.observedChild === null || validProcess(value.observedChild)) &&
    (value.observerCommandExitCode === null ||
      (typeof value.observerCommandExitCode === 'number' &&
        Number.isSafeInteger(value.observerCommandExitCode))) &&
    typeof value.observerExcluded === 'boolean' &&
    (value.observerPid === null ||
      (typeof value.observerPid === 'number' &&
        Number.isSafeInteger(value.observerPid) &&
        value.observerPid > 0)) &&
    value.processes.every(validProcess)
  );
}

function isGuardianProbeBinding(value: unknown): value is GuardianProbeBinding {
  if (!isRecord(value) || typeof value.containerId !== 'string') {
    return false;
  }

  const { imageId, labels } = value;
  return (
    typeof imageId === 'string' &&
    /^sha256:[a-f0-9]{64}$/i.test(imageId) &&
    isRecord(labels) &&
    Object.values(labels).every((label) => typeof label === 'string')
  );
}

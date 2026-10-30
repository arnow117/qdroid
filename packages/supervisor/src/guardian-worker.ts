import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createSocket, type Socket as DatagramSocket } from 'node:dgram';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { type Readable } from 'node:stream';

import type { SandboxProfileId } from '../../contracts/src/index.js';
import {
  PROFILE_IO_PROBE_SOURCE,
  SANDBOX_PROFILE_CATALOG,
  fixedProfileProgram,
  isFixedProfileProbeSelector,
} from './fixed-probe-catalog.js';
import {
  FIXED_PROFILE_NETWORK_TARGETS,
  fixedProfileNetworkAddresses,
  type FixedNetworkAddressFamily,
} from './fixed-network-catalog.js';
import type { FixedProfileProbeSelector } from './fixed-probe-catalog.js';

type StopReason = 'completed' | 'deadline' | 'output-limit' | 'stopped';

const DOCKER_COMMAND_DEADLINE_MS = 10_000;
const DOCKER_COMMAND_CLOSE_GRACE_MS = 1_000;
const FIXED_PROBE_START_POLL_MS = 25;
const FIXED_PROBE_START_READY_WAIT_MS = 1_000;
const RAW_WRITER_SETTLEMENT_WAIT_MS = 1_000;
const MAX_DOCKER_COMMAND_OUTPUT_BYTES = 65_536;
const MAX_OUTPUT_CREDIT_BYTES = 65_536;
const MAX_OUTPUT_CHUNK_BYTES = 16_384;
const FIXED_PROBE_PROTOCOL = 'qdroid.fixed-probe/v1';
const FIXED_ASSEMBLY_PROTOCOL = 'qdroid.fixed-assembly/v1';
const FIXED_BOUNDARY_CONTROL_PROTOCOL = 'qdroid.fixed-boundary-control/v1';
const FIXED_BOUNDARY_PROBE_PROTOCOL = 'qdroid.fixed-boundary-probe/v1';
const FIXED_NETWORK_CONTROL_PROTOCOL = 'qdroid.fixed-network-control/v1';
const NETWORK_OPERATION_DEADLINE_MS = 5_000;
const NETWORK_RECEIPT_SETTLEMENT_MS = 150;

interface StartMessage {
  containerName: string;
  creationReceipt?: CreationReceiptMessage;
  deadlineMs: number;
  dockerArguments: unknown;
  maxOutputBytes: number;
  ownership?: OwnedContainerMessage;
  type: 'start';
}

type NativeIntentMessage =
  | { kind: 'docker-runtime-info' }
  | { kind: 'docker-server-version' }
  | { imageId: string; kind: 'image-id' | 'legacy-image-inspect' }
  | { kind: 'kernel-release' }
  | { kind: 'legacy-io-device-number' }
  | { kind: 'legacy-io-root-parent' }
  | { kind: 'legacy-io-root-source' }
  | { kind: 'legacy-io-cache-drop'; path: string }
  | { kind: 'legacy-storage-parent' | 'legacy-storage-source' }
  | { kind: 'machine-architecture' }
  | {
      kind:
        | 'legacy-runtime-component-sha256'
        | 'legacy-runtime-version'
        | 'runtime-component-sha256'
        | 'runtime-version';
      path: string;
    };

interface NativeMessage {
  deadlineMs: number;
  intent: NativeIntentMessage;
  maxOutputBytes: number;
  type: 'native';
}

/**
 * This union is intentionally separate from StartMessage. A qualification
 * caller can select only a named, code-owned operation; it cannot reuse the
 * guardian's general container start transport with an arbitrary command.
 */
type ProbeProgramMessage =
  | 'descendants'
  | 'memory'
  | 'output-limit'
  | 'pids'
  | 'scratch-read'
  | 'scratch-write'
  | 'scratch-limit';

type ProbeIntentMessage =
  | { kind: 'legacy-fixed-configuration' }
  | {
      kind: 'legacy-fixed-filesystem';
      paths: { canary: string; secret: string; store: string };
    }
  | { kind: 'legacy-fixed-program'; program: ProbeProgramMessage }
  | {
      kind: 'profile-fixed-program';
      profileId: SandboxProfileId;
      selector: Exclude<FixedProfileProbeSelector, 'host-boundary' | 'network'>;
      sourcePath?: string;
    };

interface BoundaryProbeIntentMessage {
  childPid: number;
  childStart: string;
  controlReceiptAuthenticationTag: string;
  controlResourceId: string;
  crossAppPath: string;
  kind: 'profile-boundary-program';
  profileId: SandboxProfileId;
  trustedStorePath: string;
}

interface BoundaryCreateMessage {
  bootId: string;
  fixtureRoot: string;
  journalKey: Uint8Array;
  keeperPid: number;
  keeperStart: string;
  ownerId: string;
  protocol: typeof FIXED_BOUNDARY_CONTROL_PROTOCOL;
  receiptPath: string;
  resourceId: string;
  sessionId: string;
  type: 'boundary-create';
}

interface BoundaryAssertMessage {
  id: string;
  protocol: typeof FIXED_BOUNDARY_CONTROL_PROTOCOL;
  type: 'boundary-assert';
}

interface BoundaryRegisterMessage {
  configurationAuthenticationTag: string;
  configurationReceiptPath: string;
  containerName: string;
  guardianGroupId: number;
  guardianPid: number;
  guardianStart: string;
  id: string;
  imageId: string;
  labels: Record<string, string>;
  protocol: typeof FIXED_BOUNDARY_CONTROL_PROTOCOL;
  resourceId: string;
  terminalReceiptPath: string;
  type: 'boundary-register';
}

interface BoundaryProbeConfigureMessage {
  bootId: string;
  configurationReceiptPath: string;
  creationReceiptPath: string;
  controlReceiptAuthenticationTag: string;
  controlResourceId: string;
  guardianPid: number;
  guardianStart: string;
  journalKey: Uint8Array;
  ownerId: string;
  probe: Omit<ProbeCreateMessage, 'type'>;
  resourceId: string;
  sessionId: string;
  terminalReceiptPath: string;
  type: 'boundary-probe-configure';
}

interface BoundaryReleaseMessage {
  authenticationTag: string;
  id: string;
  protocol: typeof FIXED_BOUNDARY_CONTROL_PROTOCOL;
  resourceId: string;
  type: 'boundary-release';
}

interface NetworkCreateMessage {
  bootId: string;
  fixtureRoot: string;
  interfaceMarker?: string;
  interfaceName?: string;
  journalKey: Uint8Array;
  keeperGroupId: number;
  keeperPid: number;
  keeperStart: string;
  kind: 'legacy' | 'profile';
  ownerId: string;
  protocol: typeof FIXED_NETWORK_CONTROL_PROTOCOL;
  receiptPath: string;
  resourceId: string;
  sessionId: string;
  terminalReceiptPath: string;
  type: 'network-create';
}

interface NetworkOperationMessage {
  id: string;
  protocol: typeof FIXED_NETWORK_CONTROL_PROTOCOL;
  type: 'network-assert' | 'network-positive' | 'network-reset' | 'network-snapshot';
}

interface ProbeCreateMessage {
  boundaryAuthorization?: {
    controlResourceId: string;
    dependencyAuthenticationTag: string;
    resourceId: string;
  };
  containerName: string;
  deadlineMs: number;
  imageId: string;
  intent: ProbeIntentMessage | BoundaryProbeIntentMessage;
  maxOutputBytes: number;
  ownership: OwnedContainerMessage;
  protocol: typeof FIXED_PROBE_PROTOCOL | typeof FIXED_BOUNDARY_PROBE_PROTOCOL;
  type: 'probe-create';
}

interface ProbeInspectMessage {
  id: string;
  protocol: typeof FIXED_PROBE_PROTOCOL | typeof FIXED_BOUNDARY_PROBE_PROTOCOL;
  query: 'configuration' | 'container-state' | 'guest-descendants' | 'live-cgroup';
  type: 'probe-inspect';
}

interface ProbeStartMessage {
  protocol: typeof FIXED_PROBE_PROTOCOL | typeof FIXED_BOUNDARY_PROBE_PROTOCOL;
  type: 'probe-start';
}

interface AssemblyStartMessage {
  bootId: string;
  buildOutputDirectory?: string;
  candidateId: string;
  commitReceiptPath: string;
  containerName: string;
  creationReceiptPath: string;
  deadlineMs: number;
  journalKey: Uint8Array;
  materialDigest: string;
  ownerId: string;
  packageDirectory: string;
  packageDigest: string;
  platform: string;
  protocol: typeof FIXED_ASSEMBLY_PROTOCOL;
  purpose: 'builder' | 'runtime';
  resourceId: string;
  sessionId: string;
  sourceImage: string;
  templateDirectory: string;
  terminalReceiptPath: string;
  type: 'assembly-start';
}

interface AssemblyAdvanceMessage {
  protocol: typeof FIXED_ASSEMBLY_PROTOCOL;
  type: 'assembly-cleanup' | 'assembly-commit' | 'assembly-copy';
}

interface AssemblyState {
  readonly bootId: string;
  readonly buildOutputDirectory?: string;
  readonly candidateId: string;
  readonly commitReceiptPath: string;
  commitReceiptAuthenticationTag?: string;
  readonly containerName: string;
  readonly creationReceiptPath: string;
  creationReceiptAuthenticationTag?: string;
  readonly journalKey: Buffer;
  readonly materialDigest: string;
  readonly ownerId: string;
  readonly packageDirectory: string;
  readonly packageDigest: string;
  readonly platform: string;
  readonly purpose: 'builder' | 'runtime';
  readonly resourceId: string;
  readonly sessionId: string;
  readonly sourceImage: string;
  readonly templateDirectory: string;
  readonly terminalReceiptPath: string;
  commitStarted: boolean;
  commitSettled: boolean;
  containerId?: string;
  copyStarted: boolean;
  copySettled: boolean;
  imageId?: string;
  readonly pendingRawWriters: Set<Promise<void>>;
  readonly templateDirectories: AssemblyTemplateDirectory[];
  templateRemoved: boolean;
}

interface AssemblyTemplateDirectory {
  readonly entries: readonly string[];
  readonly file: FileHandle;
  readonly mode: number;
  readonly path: string;
}

interface DockerCommandResult {
  readonly commandCompleted: boolean;
  readonly exitCode: number;
  readonly rawWriterClosed: Promise<void>;
  readonly rawWriterSettled: boolean;
  readonly stderr: string;
  readonly stdout: string;
}

interface ProbeBindingMessage {
  containerId: string;
  imageId: string;
  labels: Record<string, string>;
}

type ProbeInspectionMessage =
  | {
      binding: ProbeBindingMessage;
      fixedProfileVerified: boolean;
      kind: 'configuration';
    }
  | {
      binding: ProbeBindingMessage;
      exitCode: number | null;
      kind: 'container-state';
      oomKilled: boolean;
      state: 'created' | 'exited' | 'running' | 'unknown';
    }
  | {
      binding: ProbeBindingMessage;
      cgroup: ProbeCgroupSnapshotMessage;
      kind: 'live-cgroup';
    }
  | {
      binding: ProbeBindingMessage;
      kind: 'guest-descendants';
      observation: ProbeDescendantObservationMessage;
    };

interface ProbeCgroupSnapshotMessage {
  cpu: {
    counters: { nrPeriods: number; nrThrottled: number; usageMicros: number };
    periodMicros: number;
    quotaMicros: number;
  };
  identity: { key: string; processId: number; processStart: string };
  io: {
    deviceMajorMinor: '253:16';
    counters: {
      readBytes: number;
      readBytesPerSecond: number;
      writeBytesPerSecond: number;
    };
  };
  memoryCurrentBytes: number;
  memoryMaximumBytes: number;
  pidsCurrent: number;
  pidsMaximum: number;
}

interface ProbeDescendantObservationMessage {
  attempts: number;
  observedChild: { pid: number; ppid: number } | null;
  observerCommandExitCode: number | null;
  observerExcluded: boolean;
  observerPid: number | null;
  processes: Array<{ pid: number; ppid: number }>;
}

interface OwnedContainerMessage {
  imageId: string;
  labels: Record<string, string>;
}

interface BoundaryRetainedFile {
  readonly contents: string;
  readonly file: FileHandle;
  readonly name: 'cross-app-canary' | 'trusted-store-canary';
  readonly path: string;
}

interface BoundaryControlState {
  readonly child: import('node:child_process').ChildProcess;
  readonly childPid: number;
  readonly childStart: string;
  readonly dependencies: Map<string, BoundaryDependency>;
  readonly directory: string;
  readonly directoryHandle: FileHandle;
  expectedChildShutdown: boolean;
  healthError: string | undefined;
  readonly parentHandle: FileHandle;
  readonly receiptAuthenticationTag: string;
  readonly spec: BoundaryCreateMessage;
  readonly files: readonly BoundaryRetainedFile[];
  readonly secret: string;
}

interface BoundaryDependency {
  readonly authenticationTag: string;
  readonly configurationAuthenticationTag: string;
  readonly configurationReceiptPath: string;
  readonly containerName: string;
  readonly guardian: Readonly<{
    readonly groupId: number;
    readonly pid: number;
    readonly start: string;
  }>;
  readonly imageId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly receiptPath: string;
  readonly terminalReceiptPath: string;
}

interface NetworkControlTarget {
  readonly family: FixedNetworkAddressFamily;
  readonly host: string;
  readonly name: 'dns' | 'tcp' | 'udp';
  readonly port: number;
}

interface NetworkEndpoint {
  readonly family: FixedNetworkAddressFamily;
  readonly host: string;
  readonly name: 'dns' | 'tcp' | 'udp';
  port: number;
  readonly socket: DatagramSocket | Server;
}

type NetworkReceiptSnapshot =
  | {
      readonly settled: boolean;
      readonly tcpIpv4: boolean;
      readonly tcpIpv6: boolean;
      readonly udpDns: boolean;
      readonly udpIpv4: boolean;
    }
  | {
      readonly settled: boolean;
      readonly tcpIpv4: boolean;
      readonly tcpIpv6: boolean;
      readonly udpDns: boolean;
      readonly udpIpv4: boolean;
      readonly udpIpv6: boolean;
    };

interface NetworkControlState {
  readonly acceptedSockets: Set<Socket>;
  readonly clientSockets: Set<DatagramSocket | Socket>;
  closing: boolean;
  constructionWork?: Promise<void>;
  readonly endpoints: NetworkEndpoint[];
  readonly interfaceMarker?: string;
  readonly interfaceName?: string;
  interfaceIfIndex?: number;
  interfaceCreated: boolean;
  readonly pendingRawWriters: Set<Promise<void>>;
  readonly pendingSocketClosures: Set<Promise<void>>;
  receiptAuthenticationTag?: string;
  readonly receiptCounts: Map<string, number>;
  readonly spec: NetworkCreateMessage;
  readonly targets: readonly NetworkControlTarget[];
  activePositiveOperations: Set<Promise<void>>;
  healthError: string | undefined;
  measurementStarted: boolean;
  positiveCompleted: boolean;
  snapshotSealed: boolean;
  snapshot?: NetworkReceiptSnapshot;
  snapshotWork?: Promise<NetworkReceiptSnapshot>;
  tcpIpv4Receipts: number;
  tcpIpv6Receipts: number;
  udpDnsReceipts: number;
  udpIpv4Receipts: number;
  udpIpv6Receipts: number;
}

interface NetworkCommandResult {
  readonly completed: boolean;
  readonly error?: Error;
  readonly exitCode: number;
  readonly rawWriterClosed: Promise<void>;
  readonly rawWriterSettled: boolean;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut?: boolean;
}

interface BoundaryProbeConfigurationState {
  authorizationRecorded: boolean;
  createSubmitted: boolean;
  createReceiptAuthenticationTag?: string;
  createResult?: Readonly<{
    readonly commandCompleted: boolean;
    readonly containerId: string;
    readonly exitCode: number;
  }>;
  firstExecutionReceiptAuthenticationTag?: string;
  firstExecutionOutcome?: BoundaryProbeFirstExecutionOutcome;
  firstExecutionPersistenceError?: unknown;
  readonly configurationAuthenticationTag: string;
  readonly message: BoundaryProbeConfigureMessage;
  readonly pendingRawWriters: Set<Promise<void>>;
}

type BoundaryProbeFirstExecutionOutcome =
  | Readonly<{ readonly kind: 'never-started' }>
  | Readonly<{
      readonly errorMessage: string | null;
      readonly exitCode: number | null;
      readonly kind: 'command';
      readonly reason: StopReason;
    }>;

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
let probeIntent: ProbeIntentMessage | BoundaryProbeIntentMessage | undefined;
let probeOwnership: OwnedContainerMessage | undefined;
let fixedProbeProtocol: typeof FIXED_PROBE_PROTOCOL | typeof FIXED_BOUNDARY_PROBE_PROTOCOL =
  FIXED_PROBE_PROTOCOL;
let lifecycleMode:
  | 'idle'
  | 'starting'
  | 'owned'
  | 'running'
  | 'native'
  | 'cleanup'
  | 'probe-command-completed'
  | 'probe-created'
  | 'probe-running'
  | 'assembly-creating'
  | 'assembly-created'
  | 'assembly-copying'
  | 'assembly-copied'
  | 'assembly-committing'
  | 'assembly-committed'
  | 'assembly-cleanup'
  | 'boundary-creating'
  | 'boundary-active'
  | 'boundary-probe-configured'
  | 'network-creating'
  | 'network-active' = 'idle';
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
let fixedProbeCleanup: Promise<void> | undefined;
let probeCommandTerminal: Promise<void> | undefined;
let fixedProbeCommandFailures: unknown[] = [];
let fixedProbeDeadlineMs: number | undefined;
let assembly: AssemblyState | undefined;
let assemblyCleanup: Promise<void> | undefined;
let assemblyPhaseWork: Promise<void> | undefined;
let boundaryControl: BoundaryControlState | undefined;
let networkControl: NetworkControlState | undefined;
let boundaryProbeConfiguration: BoundaryProbeConfigurationState | undefined;
let boundaryProbeConfigurationPhase: Promise<void> | undefined;
let boundaryProbeConfigurationSealed = false;
let fixedProbeCreationPhase: Promise<void> | undefined;
let fixedProbeCreationSealed = false;
let networkConstructionPhase: Promise<void> | undefined;
let networkConstructionSealed = false;
let networkCleanupWork: Promise<void> | undefined;
let boundaryConstructionSealed = false;
let boundaryConstructionSettled = false;
let boundaryConstructionCompletion: Promise<void> | undefined;
let boundaryParentLossRetry: NodeJS.Timeout | undefined;

let messageQueue = Promise.resolve();
let inputQueue = Promise.resolve();
let disconnectRequested = false;
let availableOutputCreditBytes = MAX_OUTPUT_CREDIT_BYTES;
let nextOutputSequence = 1;
let outputLimitBytes = 0;
const outstandingOutputCredits = new Map<number, number>();
const probeCgroupIdentityKey = randomUUID();

process.on('message', (message: unknown) => {
  if (isOutputCreditMessage(message)) {
    acceptOutputCredit(message);
    return;
  }

  if (isOutputCreditType(message)) {
    void finish('stopped', 'The guardian received an invalid output-credit frame.');
    return;
  }

  if (isStopMessage(message)) {
    // A stop request must close the assembly admission boundary immediately.
    // It cannot wait behind a held Docker writer in messageQueue, because the
    // writer's completion could otherwise authorize later copy commands.
    sealBoundaryConstruction();
    boundaryProbeConfigurationSealed = boundaryProbeConfigurationPhase !== undefined;
    fixedProbeCreationSealed = fixedProbeCreationPhase !== undefined;
    networkConstructionSealed = networkConstructionPhase !== undefined;
    void finish(message.reason ?? 'stopped');
    return;
  }

  messageQueue = messageQueue
    .then(() => handleMessage(message))
    .catch((error: unknown) =>
      finish('stopped', formatGuardianError(error, 'The guardian failed.')),
    );
});

process.on('disconnect', () => {
  disconnectRequested = true;
  sealBoundaryConstruction();
  boundaryProbeConfigurationSealed = boundaryProbeConfigurationPhase !== undefined;
  fixedProbeCreationSealed = fixedProbeCreationPhase !== undefined;
  networkConstructionSealed = networkConstructionPhase !== undefined;
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

  if (message.type === 'native') {
    await startNative(message as unknown as NativeMessage);
    return;
  }

  if (message.type === 'boundary-create') {
    await createBoundaryControl(message as unknown as BoundaryCreateMessage);
    return;
  }

  if (message.type === 'boundary-probe-configure') {
    const phase = configureBoundaryProbe(message as unknown as BoundaryProbeConfigureMessage);
    boundaryProbeConfigurationPhase = phase;
    try {
      await phase;
    } finally {
      if (boundaryProbeConfigurationPhase === phase) {
        boundaryProbeConfigurationPhase = undefined;
      }
    }
    return;
  }

  if (message.type === 'network-create') {
    const phase = createNetworkControl(message as unknown as NetworkCreateMessage);
    if (networkControl !== undefined) {
      networkControl.constructionWork = phase;
    }
    networkConstructionPhase = phase;
    try {
      await phase;
    } finally {
      if (networkConstructionPhase === phase) {
        networkConstructionPhase = undefined;
      }
    }
    return;
  }

  if (
    message.type === 'network-assert' ||
    message.type === 'network-positive' ||
    message.type === 'network-reset' ||
    message.type === 'network-snapshot'
  ) {
    await handleNetworkOperation(message as unknown as NetworkOperationMessage);
    return;
  }

  if (
    message.type === 'boundary-assert' ||
    message.type === 'boundary-register' ||
    message.type === 'boundary-release'
  ) {
    await handleBoundaryOperation(
      message as unknown as
        | BoundaryAssertMessage
        | BoundaryRegisterMessage
        | BoundaryReleaseMessage,
    );
    return;
  }

  if (message.type === 'probe-create') {
    const phase = createFixedProbe(message as unknown as ProbeCreateMessage);
    fixedProbeCreationPhase = phase;
    try {
      await phase;
    } finally {
      if (fixedProbeCreationPhase === phase) {
        fixedProbeCreationPhase = undefined;
      }
    }
    return;
  }

  if (message.type === 'probe-inspect') {
    await inspectFixedProbe(message as unknown as ProbeInspectMessage);
    return;
  }

  if (message.type === 'probe-start') {
    await startFixedProbe(message as unknown as ProbeStartMessage);
    return;
  }

  if (message.type === 'assembly-start') {
    await runAssemblyPhase(() => startAssembly(message as unknown as AssemblyStartMessage));
    return;
  }

  if (
    message.type === 'assembly-copy' ||
    message.type === 'assembly-commit' ||
    message.type === 'assembly-cleanup'
  ) {
    await runAssemblyPhase(() => advanceAssembly(message as unknown as AssemblyAdvanceMessage));
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

async function startNative(message: NativeMessage): Promise<void> {
  if (lifecycleMode !== 'idle' || !isValidNativeMessage(message)) {
    throw new Error('The guardian received an invalid fixed native operation.');
  }

  const invocation = nativeInvocation(message.intent);
  if (invocation === undefined) {
    throw new Error('The guardian received an unsupported fixed native operation.');
  }

  lifecycleMode = 'native';
  outputLimitBytes = message.maxOutputBytes;
  attached = spawn(invocation.command, invocation.arguments, {
    // The command is a direct child of the guardian's recorded group. The
    // provider records the guardian identity before authorizing this start.
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const native = attached;
  const failNative = (): void => {
    void finish('stopped', 'The fixed native operation could not settle.');
  };
  native.once('error', failNative);
  native.stdin.once('error', failNative);
  native.stdout.once('error', failNative);
  native.stderr.once('error', failNative);
  native.stdin.end();
  native.stdout.pause();
  native.stderr.pause();
  native.stdout.on('readable', () => drainAvailableOutput('stdout', native.stdout));
  native.stderr.on('readable', () => drainAvailableOutput('stderr', native.stderr));
  native.once('close', (exitCode) => {
    void finish('completed', undefined, exitCode);
  });
  send({ containerId: 'native', type: 'created' });
  deadline = setTimeout(() => {
    void finish('deadline');
  }, message.deadlineMs);
  drainAllAvailableOutput();
}

async function createBoundaryControl(message: BoundaryCreateMessage): Promise<void> {
  if (lifecycleMode !== 'idle' || !isValidBoundaryCreateMessage(message)) {
    throw new Error('The guardian received an invalid fixed boundary control creation.');
  }
  if (
    message.keeperPid !== process.pid ||
    (await readProbeProcessStart(process.pid)) !== message.keeperStart
  ) {
    throw new Error('The fixed boundary keeper identity did not match its durable record.');
  }

  lifecycleMode = 'boundary-creating';
  boundaryConstructionSealed = false;
  boundaryConstructionSettled = false;
  let resolveConstruction: (() => void) | undefined;
  boundaryConstructionCompletion = new Promise<void>((resolve) => {
    resolveConstruction = resolve;
  });

  let parentHandle: FileHandle | undefined;
  let directoryHandle: FileHandle | undefined;
  const files: BoundaryRetainedFile[] = [];
  let child: import('node:child_process').ChildProcess | undefined;
  let childFailure: Error | undefined;
  let state: BoundaryControlState | undefined;

  try {
    assertBoundaryConstructionOpen();
    parentHandle = await open(
      message.fixtureRoot,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    assertBoundaryConstructionOpen();
    await assertPrivateBoundaryDirectory(message.fixtureRoot, parentHandle, 0o700);
    assertBoundaryConstructionOpen();
    const directory = join(message.fixtureRoot, message.resourceId);
    await mkdir(directory, { mode: 0o700 });
    assertBoundaryConstructionOpen();
    await syncDirectory(message.fixtureRoot);
    assertBoundaryConstructionOpen();

    directoryHandle = await open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    assertBoundaryConstructionOpen();
    await assertPrivateBoundaryDirectory(directory, directoryHandle, 0o700);

    const crossAppFile = await createBoundaryFile(
      directory,
      'cross-app-canary',
      'qdroid-cross-app-canary',
    );
    files.push(crossAppFile);
    assertBoundaryConstructionOpen();
    const trustedStoreFile = await createBoundaryFile(
      directory,
      'trusted-store-canary',
      'qdroid-trusted-store-canary',
    );
    files.push(trustedStoreFile);
    assertBoundaryConstructionOpen();
    await syncDirectory(directory);
    assertBoundaryConstructionOpen();

    const secret = randomUUID().replace(/-/g, '');
    assertBoundaryConstructionOpen();
    const secretChild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
      detached: false,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        QDROID_T005_BOUNDARY_SECRET: secret,
      },
      stdio: 'ignore',
    });
    child = secretChild;
    const latchChildFailure = (error: Error): void => {
      childFailure ??= error;
      if (state !== undefined && !state.expectedChildShutdown) {
        state.healthError ??= error.message;
      }
    };
    const childSpawned = new Promise<void>((resolve, reject) => {
      secretChild.once('spawn', resolve);
      secretChild.once('error', (error) => {
        const failure =
          error instanceof Error
            ? error
            : new Error('The fixed boundary secret child emitted a non-Error spawn failure.');
        latchChildFailure(failure);
        reject(failure);
      });
    });
    secretChild.once('exit', () => {
      latchChildFailure(new Error('The fixed boundary secret child exited unexpectedly.'));
    });
    await childSpawned;
    if (secretChild.pid === undefined) {
      throw (
        childFailure ?? new Error('The fixed boundary secret child did not provide an identity.')
      );
    }
    const childPid = secretChild.pid;
    const childStart = await readProbeProcessStart(childPid);
    await assertOriginalBoundaryChildAlive(secretChild, childPid, childStart, childFailure);
    assertBoundaryConstructionOpen();

    const directoryStatus = await directoryHandle.stat();
    const [crossAppStatus, trustedStoreStatus] = await Promise.all([
      crossAppFile.file.stat(),
      trustedStoreFile.file.stat(),
    ]);
    await assertOriginalBoundaryChildAlive(secretChild, childPid, childStart, childFailure);
    assertBoundaryConstructionOpen();

    const receiptPayload = {
      bootId: message.bootId,
      child: { pid: childPid, start: childStart },
      fixture: {
        crossApp: {
          dev: crossAppStatus.dev,
          ino: crossAppStatus.ino,
          name: 'cross-app-canary',
        },
        directory: { dev: directoryStatus.dev, ino: directoryStatus.ino },
        trustedStore: {
          dev: trustedStoreStatus.dev,
          ino: trustedStoreStatus.ino,
          name: 'trusted-store-canary',
        },
      },
      keeper: {
        groupId: message.keeperPid,
        pid: message.keeperPid,
        start: message.keeperStart,
      },
      ownerId: message.ownerId,
      protocol: FIXED_BOUNDARY_CONTROL_PROTOCOL,
      resourceId: message.resourceId,
      sessionId: message.sessionId,
      version: 1,
    };
    const receiptAuthenticationTag = boundaryReceiptAuthenticationTag(
      'qdroid.boundary-control-created/v1',
      message.journalKey,
      receiptPayload,
    );
    await writeAtomicJson(message.receiptPath, {
      ...receiptPayload,
      authenticationTag: receiptAuthenticationTag,
    });
    await assertOriginalBoundaryChildAlive(secretChild, childPid, childStart, childFailure);
    assertBoundaryConstructionOpen();

    state = {
      child: secretChild,
      childPid,
      childStart,
      dependencies: new Map(),
      directory,
      directoryHandle,
      expectedChildShutdown: false,
      healthError: childFailure?.message,
      parentHandle,
      receiptAuthenticationTag,
      spec: message,
      files: Object.freeze([...files]),
      secret,
    };
    if (state.healthError !== undefined) {
      throw new Error(state.healthError);
    }
    assertBoundaryConstructionOpen();
    boundaryControl = state;
    lifecycleMode = 'boundary-active';
    send({
      childPid,
      childStart,
      protocol: FIXED_BOUNDARY_CONTROL_PROTOCOL,
      receiptAuthenticationTag,
      type: 'boundary-created',
    });
  } catch (error) {
    const cleanupFailures = await cleanupUnacknowledgedBoundary(
      parentHandle,
      join(message.fixtureRoot, message.resourceId),
      directoryHandle,
      files,
      child,
    );
    boundaryConstructionSettled = true;
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Fixed boundary control creation failed and cleanup also failed.',
      );
    }
    throw error;
  } finally {
    boundaryConstructionSettled = true;
    resolveConstruction?.();
  }
}

async function assertOriginalBoundaryChildAlive(
  child: import('node:child_process').ChildProcess,
  childPid: number,
  childStart: string,
  childFailure: Error | undefined,
): Promise<void> {
  if (childFailure !== undefined || child.exitCode !== null || child.signalCode !== null) {
    throw (
      childFailure ?? new Error('The fixed boundary secret child exited before acknowledgement.')
    );
  }
  if ((await readProbeProcessStart(childPid)) !== childStart) {
    throw new Error('The fixed boundary secret child no longer has its original identity.');
  }
}

async function createNetworkControl(message: NetworkCreateMessage): Promise<void> {
  if (lifecycleMode !== 'idle' || !isValidNetworkCreateMessage(message)) {
    throw new Error('The guardian received an invalid fixed network control creation.');
  }
  if (disconnectRequested || finished) {
    throw new Error('The fixed network control was sealed before creation.');
  }

  const endpoints: NetworkEndpoint[] = [];
  const targets: NetworkControlTarget[] = [];
  const state: NetworkControlState = {
    acceptedSockets: new Set(),
    clientSockets: new Set(),
    closing: false,
    endpoints,
    ...(message.interfaceMarker === undefined ? {} : { interfaceMarker: message.interfaceMarker }),
    ...(message.interfaceName === undefined ? {} : { interfaceName: message.interfaceName }),
    interfaceCreated: false,
    pendingRawWriters: new Set(),
    pendingSocketClosures: new Set(),
    receiptCounts: new Map(),
    spec: message,
    targets,
    activePositiveOperations: new Set(),
    healthError: undefined,
    measurementStarted: false,
    positiveCompleted: false,
    snapshotSealed: false,
    tcpIpv4Receipts: 0,
    tcpIpv6Receipts: 0,
    udpDnsReceipts: 0,
    udpIpv4Receipts: 0,
    udpIpv6Receipts: 0,
  };

  networkControl = state;
  lifecycleMode = 'network-creating';

  try {
    const keeperStart = await readProcessStart(process.pid);
    if (keeperStart !== message.keeperStart) {
      throw new Error('The network keeper identity no longer matches its recorded start time.');
    }
    assertNetworkConstructionOpen(state);

    if (message.kind === 'profile') {
      await createProfileNetworkInterface(state);
      assertNetworkConstructionOpen(state);
    }

    const listeners = networkListenerDefinitions(message.kind);
    for (const listener of listeners) {
      assertNetworkConstructionOpen(state);
      const endpoint = await createNetworkEndpoint(state, listener);
      assertNetworkConstructionOpen(state);
      targets.push({
        family: endpoint.family,
        host: endpoint.host,
        name: endpoint.name,
        port: endpoint.port,
      });
    }

    const payload = networkCreationReceiptPayload(state);
    const receiptAuthenticationTag = boundaryReceiptAuthenticationTag(
      'qdroid.fixed-network-control-created/v1',
      message.journalKey,
      payload,
    );
    await writePrivateNetworkReceipt(message.receiptPath, {
      ...payload,
      authenticationTag: receiptAuthenticationTag,
    });
    state.receiptAuthenticationTag = receiptAuthenticationTag;
    assertNetworkConstructionOpen(state);
    lifecycleMode = 'network-active';
    send({
      protocol: FIXED_NETWORK_CONTROL_PROTOCOL,
      receiptAuthenticationTag,
      targets,
      type: 'network-created',
    });
  } catch (error) {
    latchNetworkHealth(state, error);
    throw error;
  }
}

async function handleNetworkOperation(message: NetworkOperationMessage): Promise<void> {
  if (!isValidNetworkOperationMessage(message)) {
    throw new Error('The guardian received an invalid fixed network control operation.');
  }

  const state = networkControl;
  if (state === undefined || lifecycleMode !== 'network-active' || finished || state.closing) {
    sendNetworkResult(message.id, undefined, 'The fixed network keeper is unavailable.');
    return;
  }

  try {
    if (message.type === 'network-assert') {
      await assertNetworkControls(state);
      sendNetworkResult(message.id);
      return;
    }

    if (message.type === 'network-positive') {
      await runNetworkPositiveControls(state);
      sendNetworkResult(message.id);
      return;
    }

    if (message.type === 'network-reset') {
      await resetNetworkReceipts(state);
      sendNetworkResult(message.id);
      return;
    }

    const snapshot = await snapshotNetworkReceipts(state);
    sendNetworkResult(message.id, snapshot);
  } catch (error) {
    if (networkOperationMayHavePerformedWork(state, message)) {
      latchNetworkHealth(state, error);
    }
    sendNetworkResult(
      message.id,
      undefined,
      formatGuardianError(error, 'The fixed network keeper failed.'),
    );
  }
}

function networkOperationMayHavePerformedWork(
  state: NetworkControlState,
  message: NetworkOperationMessage,
): boolean {
  if (message.type === 'network-positive') {
    return !state.positiveCompleted && !state.measurementStarted && !state.snapshotSealed;
  }
  if (message.type === 'network-reset') {
    return state.positiveCompleted && !state.measurementStarted && !state.snapshotSealed;
  }
  if (message.type === 'network-snapshot') {
    return state.measurementStarted;
  }
  return true;
}

function sendNetworkResult(
  id: string,
  snapshot?: {
    readonly settled: boolean;
    readonly tcpIpv4: boolean;
    readonly tcpIpv6: boolean;
    readonly udpDns: boolean;
    readonly udpIpv4: boolean;
    readonly udpIpv6?: boolean;
  },
  error?: string,
): void {
  send({
    ...(error === undefined ? {} : { error }),
    id,
    protocol: FIXED_NETWORK_CONTROL_PROTOCOL,
    ...(snapshot === undefined ? {} : { snapshot }),
    type: 'network-result',
  });
}

function networkListenerDefinitions(kind: NetworkCreateMessage['kind']): readonly Readonly<{
  family: FixedNetworkAddressFamily;
  host: string;
  name: NetworkControlTarget['name'];
}>[] {
  if (kind === 'legacy') {
    const host = findNonLoopbackIpv4Address();
    return Object.freeze([
      Object.freeze({ family: 'ipv4', host, name: 'tcp' }),
      Object.freeze({ family: 'ipv4', host, name: 'udp' }),
      Object.freeze({ family: 'ipv4', host, name: 'dns' }),
      Object.freeze({ family: 'ipv6', host: '::1', name: 'tcp' }),
    ]);
  }

  return Object.freeze(
    FIXED_PROFILE_NETWORK_TARGETS.flatMap((target) =>
      (['tcp', 'udp', 'dns'] as const).map((name) =>
        Object.freeze({ family: target.family, host: target.host, name }),
      ),
    ),
  );
}

function findNonLoopbackIpv4Address(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  throw new Error('The fixed legacy network controls could not identify a non-loopback IPv4 host.');
}

async function createNetworkEndpoint(
  state: NetworkControlState,
  definition: Readonly<{
    family: FixedNetworkAddressFamily;
    host: string;
    name: NetworkControlTarget['name'];
  }>,
): Promise<NetworkEndpoint> {
  if (definition.name === 'tcp') {
    const server = createServer((socket) => {
      state.acceptedSockets.add(socket);
      socket.once('close', () => state.acceptedSockets.delete(socket));
      trackNetworkSocketClosure(state, socket);
      socket.once('error', (error) => latchNetworkHealth(state, error));
      recordNetworkReceipt(state, definition);
      socket.end();
    });
    const endpoint: NetworkEndpoint = { ...definition, port: 0, socket: server };
    server.on('error', (error) => latchNetworkHealth(state, error));
    state.endpoints.push(endpoint);
    await listenNetworkServer(server, endpoint);
    return endpoint;
  }

  const socket = createSocket(definition.family === 'ipv4' ? 'udp4' : 'udp6');
  const endpoint: NetworkEndpoint = { ...definition, port: 0, socket };
  socket.on('error', (error) => latchNetworkHealth(state, error));
  socket.on('message', () => recordNetworkReceipt(state, definition));
  state.endpoints.push(endpoint);
  await bindNetworkSocket(socket, endpoint);
  return endpoint;
}

async function listenNetworkServer(server: Server, endpoint: NetworkEndpoint): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      server.off('error', fail);
      reject(error);
    };
    server.once('error', fail);
    server.listen({ host: endpoint.host, ipv6Only: endpoint.family === 'ipv6', port: 0 }, () => {
      server.off('error', fail);
      const address = server.address();
      if (address === null || typeof address === 'string' || address.port < 1) {
        reject(new Error('The fixed network TCP listener did not bind an ephemeral port.'));
        return;
      }
      endpoint.port = address.port;
      resolve();
    });
  });
}

async function bindNetworkSocket(socket: DatagramSocket, endpoint: NetworkEndpoint): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      socket.off('error', fail);
      reject(error);
    };
    socket.once('error', fail);
    socket.bind({ address: endpoint.host, port: 0 }, () => {
      socket.off('error', fail);
      const address = socket.address();
      if (typeof address === 'string' || address.port < 1) {
        reject(new Error('The fixed network UDP listener did not bind an ephemeral port.'));
        return;
      }
      endpoint.port = address.port;
      resolve();
    });
  });
}

function assertNetworkControlOpen(state: NetworkControlState): void {
  if (disconnectRequested || finished || state.closing) {
    throw new Error('The fixed network keeper was sealed before the operation settled.');
  }
  if (state.healthError !== undefined) {
    throw new Error(state.healthError);
  }
}

function assertNetworkConstructionOpen(state: NetworkControlState): void {
  if (
    lifecycleMode !== 'network-creating' ||
    networkConstructionSealed ||
    disconnectRequested ||
    finished ||
    state.closing
  ) {
    throw new Error('The fixed network keeper creation was sealed before completion.');
  }
  if (state.healthError !== undefined) {
    throw new Error(state.healthError);
  }
}

async function assertNetworkControls(state: NetworkControlState): Promise<void> {
  assertNetworkControlOpen(state);
  for (const endpoint of state.endpoints) {
    const address = endpoint.socket.address();
    if (
      address === null ||
      typeof address === 'string' ||
      address.port !== endpoint.port ||
      endpoint.port < 1
    ) {
      throw new Error(
        'The fixed network listener identity no longer matches its retained receipt.',
      );
    }
  }
  if (state.spec.kind === 'profile') {
    await assertProfileNetworkInterface(state);
  }
  assertNetworkControlOpen(state);
}

async function runNetworkPositiveControls(state: NetworkControlState): Promise<void> {
  assertNetworkControlOpen(state);
  if (state.positiveCompleted || state.measurementStarted || state.snapshotSealed) {
    throw new Error('The fixed network keeper no longer permits positive controls.');
  }

  const operation = (async () => {
    for (const target of state.targets) {
      assertNetworkControlOpen(state);
      const before = networkReceiptCount(state, target);
      if (target.name === 'tcp') {
        await connectNetworkControl(state, target);
      } else {
        await sendNetworkDatagram(state, target);
      }
      await waitForNetworkReceipt(state, target, before);
    }
  })();
  state.activePositiveOperations.add(operation);
  try {
    await operation;
    state.positiveCompleted = true;
  } finally {
    state.activePositiveOperations.delete(operation);
  }
}

async function connectNetworkControl(
  state: NetworkControlState,
  target: NetworkControlTarget,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({
      family: target.family === 'ipv4' ? 4 : 6,
      host: target.host,
      port: target.port,
    });
    const closed = trackNetworkSocketClosure(state, socket, true);
    let connected = false;
    let failure: Error | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      failure ??= new Error('The fixed TCP control did not settle.');
      socket.destroy();
    }, NETWORK_OPERATION_DEADLINE_MS);
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (failure === undefined && connected) {
        resolve();
      } else {
        reject(
          failure ?? new Error('The fixed TCP control closed before establishing its connection.'),
        );
      }
    };
    socket.once('error', (error) => {
      failure ??= error;
      socket.destroy();
    });
    socket.once('connect', () => {
      connected = true;
      socket.end();
    });
    socket.once('close', (hadError) => {
      if (hadError) {
        failure ??= new Error('The fixed TCP control closed with an error.');
      }
      finish();
    });
    void closed.then(finish, finish);
  });
}

async function sendNetworkDatagram(
  state: NetworkControlState,
  target: NetworkControlTarget,
): Promise<void> {
  const socket = createSocket(target.family === 'ipv4' ? 'udp4' : 'udp6');
  const closed = trackNetworkSocketClosure(state, socket, true);
  const payload =
    target.name === 'dns' ? fixedDnsControlPacket() : Buffer.from('qdroid-fixed-network');
  await new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      failure ??= new Error('The fixed UDP control did not settle.');
      closeNetworkClientSocket(socket);
    }, NETWORK_OPERATION_DEADLINE_MS);
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (failure === undefined) {
        resolve();
      } else {
        reject(failure);
      }
    };
    socket.once('error', (error) => {
      failure ??= error;
      closeNetworkClientSocket(socket);
    });
    socket.send(payload, target.port, target.host, (error) => {
      if (error !== null && error !== undefined) {
        failure ??= error;
      }
      closeNetworkClientSocket(socket);
    });
    void closed.then(finish, finish);
  });
}

function trackNetworkSocketClosure(
  state: NetworkControlState,
  socket: DatagramSocket | Socket,
  client = false,
): Promise<void> {
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  state.pendingSocketClosures.add(closed);
  if (client) {
    state.clientSockets.add(socket);
  }
  socket.once('close', () => {
    state.pendingSocketClosures.delete(closed);
    state.clientSockets.delete(socket);
    resolveClosed?.();
  });
  return closed;
}

function closeNetworkClientSocket(socket: DatagramSocket | Socket): void {
  if ('destroy' in socket) {
    socket.destroy();
    return;
  }
  try {
    socket.close();
  } catch {
    // The descriptor can close between a send callback and explicit cleanup.
  }
}

function fixedDnsControlPacket(): Buffer {
  return Buffer.from([0x71, 0x64, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

async function waitForNetworkReceipt(
  state: NetworkControlState,
  target: NetworkControlTarget,
  before: number,
): Promise<void> {
  const deadlineAt = Date.now() + NETWORK_OPERATION_DEADLINE_MS;
  while (Date.now() < deadlineAt) {
    assertNetworkControlOpen(state);
    if (networkReceiptCount(state, target) > before) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The fixed network listener did not observe its positive control.');
}

function recordNetworkReceipt(
  state: NetworkControlState,
  target: Readonly<Pick<NetworkControlTarget, 'family' | 'host' | 'name'>>,
): void {
  const key = networkTargetKey(target);
  state.receiptCounts.set(key, (state.receiptCounts.get(key) ?? 0) + 1);
  if (target.name === 'tcp') {
    if (target.family === 'ipv4') {
      state.tcpIpv4Receipts += 1;
    } else {
      state.tcpIpv6Receipts += 1;
    }
    return;
  }
  if (target.name === 'dns') {
    state.udpDnsReceipts += 1;
    return;
  }
  if (target.family === 'ipv4') {
    state.udpIpv4Receipts += 1;
  } else {
    state.udpIpv6Receipts += 1;
  }
}

function networkReceiptCount(
  state: NetworkControlState,
  target: Readonly<Pick<NetworkControlTarget, 'family' | 'host' | 'name'>>,
): number {
  return state.receiptCounts.get(networkTargetKey(target)) ?? 0;
}

function networkTargetKey(
  target: Readonly<Pick<NetworkControlTarget, 'family' | 'host' | 'name'>>,
): string {
  return `${target.family}\0${target.host}\0${target.name}`;
}

async function resetNetworkReceipts(state: NetworkControlState): Promise<void> {
  assertNetworkControlOpen(state);
  if (!state.positiveCompleted || state.measurementStarted || state.snapshotSealed) {
    throw new Error('The fixed network keeper cannot reset its receipt epoch.');
  }
  await Promise.all([...state.activePositiveOperations]);
  if (!(await waitForNetworkSocketClosures(state))) {
    throw new Error('The fixed network clients did not settle before the receipt reset.');
  }
  assertNetworkControlOpen(state);
  state.receiptCounts.clear();
  state.tcpIpv4Receipts = 0;
  state.tcpIpv6Receipts = 0;
  state.udpDnsReceipts = 0;
  state.udpIpv4Receipts = 0;
  state.udpIpv6Receipts = 0;
  state.measurementStarted = true;
}

async function snapshotNetworkReceipts(
  state: NetworkControlState,
): Promise<NetworkReceiptSnapshot> {
  assertNetworkControlOpen(state);
  if (!state.measurementStarted) {
    throw new Error('The fixed network keeper has not entered its measurement epoch.');
  }
  if (state.snapshot !== undefined) {
    return state.snapshot;
  }
  if (state.snapshotWork !== undefined) {
    const cached = await state.snapshotWork;
    assertNetworkControlOpen(state);
    return cached;
  }

  const snapshotWork = (async (): Promise<NetworkReceiptSnapshot> => {
    await Promise.all([...state.activePositiveOperations]);
    if (!(await waitForNetworkSocketClosures(state))) {
      throw new Error('The fixed network clients did not settle before the receipt snapshot.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, NETWORK_RECEIPT_SETTLEMENT_MS));
    assertNetworkControlOpen(state);
    const common = Object.freeze({
      settled: true,
      tcpIpv4: state.tcpIpv4Receipts > 0,
      tcpIpv6: state.tcpIpv6Receipts > 0,
      udpDns: state.udpDnsReceipts > 0,
      udpIpv4: state.udpIpv4Receipts > 0,
    });
    const snapshot =
      state.spec.kind === 'legacy'
        ? common
        : Object.freeze({ ...common, udpIpv6: state.udpIpv6Receipts > 0 });
    state.snapshot = snapshot;
    state.snapshotSealed = true;
    return snapshot;
  })();
  state.snapshotWork = snapshotWork;
  try {
    const snapshot = await snapshotWork;
    assertNetworkControlOpen(state);
    return snapshot;
  } finally {
    if (state.snapshotWork === snapshotWork && state.snapshot === undefined) {
      delete state.snapshotWork;
    }
  }
}

function latchNetworkHealth(state: NetworkControlState, error: unknown): void {
  if (state.healthError !== undefined) {
    return;
  }
  state.healthError = formatGuardianError(error, 'The fixed network keeper failed.');
}

async function createProfileNetworkInterface(state: NetworkControlState): Promise<void> {
  const name = state.interfaceName;
  const marker = state.interfaceMarker;
  if (name === undefined || marker === undefined) {
    throw new Error('The profile network keeper does not have a fixed interface identity.');
  }

  assertNetworkConstructionOpen(state);
  const linkAdded = await runNetworkIp(state, [
    'link',
    'add',
    name,
    'address',
    marker,
    'type',
    'dummy',
  ]);
  if (!linkAdded.completed || !linkAdded.rawWriterSettled || linkAdded.exitCode !== 0) {
    throwNetworkIpFailure(
      'The fixed profile network interface writer did not settle successfully.',
      linkAdded,
    );
  }
  // This records a completed privileged effect before a concurrent stop can
  // fence later listener work.  It grants cleanup responsibility only.
  state.interfaceCreated = true;
  assertNetworkConstructionOpen(state);
  for (const address of fixedProfileNetworkAddresses()) {
    await runRequiredNetworkIp(state, ['address', 'add', address, 'dev', name]);
    assertNetworkConstructionOpen(state);
  }
  await runRequiredNetworkIp(state, ['link', 'set', 'dev', name, 'up']);
  assertNetworkConstructionOpen(state);
  await assertProfileNetworkInterface(state);
  assertNetworkConstructionOpen(state);
}

async function assertProfileNetworkInterface(state: NetworkControlState): Promise<void> {
  const name = state.interfaceName;
  const marker = state.interfaceMarker;
  if (!state.interfaceCreated || name === undefined || marker === undefined) {
    throw new Error('The profile network keeper has no retained interface proof.');
  }

  const link = await runNetworkIp(state, ['-o', 'link', 'show', 'dev', name]);
  if (!link.completed || !link.rawWriterSettled || link.exitCode !== 0) {
    throwNetworkIpFailure('The fixed profile network interface could not be inspected.', link);
  }
  const ifIndex = profileNetworkInterfaceIndex(link.stdout, name);
  if (state.interfaceIfIndex === undefined) {
    state.interfaceIfIndex = ifIndex;
  } else if (state.interfaceIfIndex !== ifIndex) {
    throw new Error('The fixed profile network interface no longer has its recorded index.');
  }
  const markerPattern = new RegExp(`\\blink/ether\\s+${escapeRegularExpression(marker)}\\b`, 'i');
  if (!markerPattern.test(link.stdout)) {
    throw new Error('The fixed profile network interface no longer has its recorded marker.');
  }

  const detail = await runNetworkIp(state, ['-d', 'link', 'show', 'dev', name]);
  if (
    !detail.completed ||
    !detail.rawWriterSettled ||
    detail.exitCode !== 0 ||
    !/\bdummy\b/i.test(detail.stdout)
  ) {
    throwNetworkIpFailure(
      'The fixed profile network interface no longer has its recorded type.',
      detail,
    );
  }

  const addresses = await runNetworkIp(state, ['-o', 'address', 'show', 'dev', name]);
  if (!addresses.completed || !addresses.rawWriterSettled || addresses.exitCode !== 0) {
    throwNetworkIpFailure(
      'The fixed profile network interface addresses could not be inspected.',
      addresses,
    );
  }
  for (const address of fixedProfileNetworkAddresses()) {
    if (!addresses.stdout.includes(address)) {
      throw new Error('The fixed profile network interface lost a required address.');
    }
  }
}

function profileNetworkInterfaceIndex(output: string, name: string): number {
  const match = new RegExp(
    String.raw`^([1-9][0-9]*):\s+${escapeRegularExpression(name)}(?:@[^:]+)?:`,
    'm',
  ).exec(output);
  if (match === null) {
    throw new Error('The fixed profile network interface did not report a stable index.');
  }
  const indexText = match[1];
  if (indexText === undefined) {
    throw new Error('The fixed profile network interface did not report a usable index.');
  }
  return Number.parseInt(indexText, 10);
}

async function runRequiredNetworkIp(
  state: NetworkControlState,
  argumentsValue: readonly string[],
): Promise<void> {
  assertNetworkControlOpen(state);
  const result = await runNetworkIp(state, argumentsValue);
  if (!result.completed || !result.rawWriterSettled || result.exitCode !== 0) {
    throwNetworkIpFailure(
      'The fixed profile network interface writer did not settle successfully.',
      result,
    );
  }
  assertNetworkControlOpen(state);
}

function retainNetworkRawWriter(state: NetworkControlState, result: NetworkCommandResult): void {
  if (result.rawWriterSettled) {
    return;
  }
  const writer = result.rawWriterClosed;
  state.pendingRawWriters.add(writer);
  void writer.then(
    () => state.pendingRawWriters.delete(writer),
    () => state.pendingRawWriters.delete(writer),
  );
}

async function runNetworkIp(
  state: NetworkControlState,
  argumentsValue: readonly string[],
): Promise<NetworkCommandResult> {
  const child = spawn('sudo', ['-n', 'ip', ...argumentsValue], {
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

  let resolveRawWriterClosed: (() => void) | undefined;
  const rawWriterClosed = new Promise<void>((resolve) => {
    resolveRawWriterClosed = resolve;
  });
  retainNetworkRawWriter(state, {
    completed: false,
    exitCode: 1,
    rawWriterClosed,
    rawWriterSettled: false,
    stderr: '',
    stdout: '',
  });
  let spawnError: Error | undefined;
  let timedOut = false;
  const settled = await new Promise<{
    completed: boolean;
    exitCode: number;
    rawWriterSettled: boolean;
  }>((resolve) => {
    let finishedCommand = false;
    let commandDeadline: NodeJS.Timeout | undefined;
    let closeDeadline: NodeJS.Timeout | undefined;
    const finish = (completed: boolean, exitCode: number, rawWriterSettled: boolean): void => {
      if (finishedCommand) {
        return;
      }
      finishedCommand = true;
      if (commandDeadline !== undefined) {
        clearTimeout(commandDeadline);
      }
      if (closeDeadline !== undefined) {
        clearTimeout(closeDeadline);
      }
      resolve({ completed, exitCode, rawWriterSettled });
    };
    commandDeadline = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // The direct sudo child can exit while the bounded deadline is firing.
      }
      closeDeadline = setTimeout(() => finish(false, 1, false), DOCKER_COMMAND_CLOSE_GRACE_MS);
    }, NETWORK_OPERATION_DEADLINE_MS);
    child.once('error', (error) => {
      spawnError = error;
      finish(false, 1, false);
    });
    child.once('close', (code) => {
      resolveRawWriterClosed?.();
      finish(true, outputLimited ? 1 : (code ?? 1), true);
    });
  });

  return {
    ...settled,
    rawWriterClosed,
    ...(spawnError === undefined ? {} : { error: spawnError }),
    stderr,
    stdout,
    ...(timedOut ? { timedOut } : {}),
  };
}

function throwNetworkIpFailure(message: string, result: NetworkCommandResult): never {
  const diagnostics = [
    `${message} exit=${result.exitCode} completed=${result.completed} rawWriterSettled=${result.rawWriterSettled}.`,
    ...(result.stderr.length === 0 ? [] : [`stderr: ${result.stderr}`]),
    ...(result.timedOut === true ? ['The fixed profile network interface command timed out.'] : []),
  ];
  const primary = new Error(diagnostics.join(' '));
  if (result.error === undefined) {
    throw primary;
  }
  throw new AggregateError(
    [primary, result.error],
    'The fixed profile network interface command also reported a spawn error.',
  );
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanupNetworkControl(
  reason: StopReason,
  errorMessage: string | undefined,
): Promise<void> {
  if (networkCleanupWork !== undefined) {
    return networkCleanupWork;
  }

  networkCleanupWork = cleanupNetworkControlOnce(reason, errorMessage);
  return networkCleanupWork;
}

async function cleanupNetworkControlOnce(
  reason: StopReason,
  errorMessage: string | undefined,
): Promise<void> {
  if (finished) {
    return;
  }
  const state = networkControl;
  if (state === undefined) {
    finished = true;
    stopReason = reason;
    sendCompletion(false, null, errorMessage ?? 'The fixed network control was not constructed.');
    return;
  }

  state.closing = true;
  stopReason = reason;
  if (deadline !== undefined) {
    clearTimeout(deadline);
    deadline = undefined;
  }

  const failures: unknown[] = [];
  const healthFailure = state.healthError === undefined ? undefined : new Error(state.healthError);
  try {
    await Promise.all([...state.activePositiveOperations]);
  } catch (error) {
    failures.push(error);
  }
  for (const socket of state.clientSockets) {
    try {
      closeNetworkClientSocket(socket);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const socket of state.acceptedSockets) {
    try {
      socket.destroy();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const endpoint of [...state.endpoints].reverse()) {
    try {
      await closeNetworkEndpoint(endpoint);
    } catch (error) {
      failures.push(error);
    }
  }

  const socketsSettled = await waitForNetworkSocketClosures(state);
  if (!socketsSettled) {
    failures.push(new Error('A fixed network client or accepted socket did not settle.'));
  }

  const rawWritersSettled = await waitForNetworkRawWriters(state);
  if (!rawWritersSettled) {
    failures.push(new Error('A fixed profile network interface writer did not settle.'));
  }
  if (state.interfaceCreated && socketsSettled && rawWritersSettled) {
    try {
      await removeProfileNetworkInterface(state);
    } catch (error) {
      failures.push(error);
    }
  }

  let terminalFailure: unknown;
  if (failures.length === 0 && state.receiptAuthenticationTag !== undefined) {
    try {
      const payload = {
        cleanup: {
          endpointsClosed: true,
          interfaceRemoved: !state.interfaceCreated,
          rawWritersSettled: true,
        },
        createdReceiptAuthenticationTag: state.receiptAuthenticationTag,
        keeper: {
          groupId: state.spec.keeperGroupId,
          pid: state.spec.keeperPid,
          start: state.spec.keeperStart,
        },
        kind: state.spec.kind,
        ownerId: state.spec.ownerId,
        protocol: FIXED_NETWORK_CONTROL_PROTOCOL,
        resourceId: state.spec.resourceId,
        sessionId: state.spec.sessionId,
        status: 'cleaned',
        version: 1,
      };
      const authenticationTag = boundaryReceiptAuthenticationTag(
        'qdroid.fixed-network-control-terminal/v1',
        state.spec.journalKey,
        payload,
      );
      await writePrivateNetworkReceipt(state.spec.terminalReceiptPath, {
        ...payload,
        authenticationTag,
      });
    } catch (error) {
      terminalFailure = error;
    }
  }

  finished = true;
  const cleanupConfirmed = failures.length === 0 && terminalFailure === undefined;
  const cleanupFailures = [
    ...failures,
    ...(terminalFailure === undefined ? [] : [terminalFailure]),
    ...(healthFailure === undefined ? [] : [healthFailure]),
  ];
  const cleanupFailure =
    cleanupFailures.length === 0
      ? undefined
      : new AggregateError(cleanupFailures, 'Fixed network control cleanup failed.');
  sendCompletion(cleanupConfirmed, null, combineAssemblyErrors(errorMessage, cleanupFailure));
}

async function closeNetworkEndpoint(endpoint: NetworkEndpoint): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    endpoint.socket.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function waitForNetworkRawWriters(state: NetworkControlState): Promise<boolean> {
  if (state.pendingRawWriters.size === 0) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), RAW_WRITER_SETTLEMENT_WAIT_MS);
    void Promise.allSettled([...state.pendingRawWriters]).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForNetworkSocketClosures(state: NetworkControlState): Promise<boolean> {
  if (state.pendingSocketClosures.size === 0) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), RAW_WRITER_SETTLEMENT_WAIT_MS);
    void Promise.allSettled([...state.pendingSocketClosures]).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function removeProfileNetworkInterface(state: NetworkControlState): Promise<void> {
  await assertProfileNetworkInterface(state);
  const name = state.interfaceName;
  if (name === undefined) {
    throw new Error('The profile network keeper lost its interface name before cleanup.');
  }
  const deleted = await runNetworkIp(state, ['link', 'delete', name]);
  if (!deleted.completed || !deleted.rawWriterSettled || deleted.exitCode !== 0) {
    throwNetworkIpFailure('The fixed profile network interface could not be removed.', deleted);
  }
  state.interfaceCreated = false;
}

function networkCreationReceiptPayload(state: NetworkControlState): Record<string, unknown> {
  return {
    bootId: state.spec.bootId,
    interface:
      state.spec.kind === 'profile'
        ? {
            addresses: fixedProfileNetworkAddresses(),
            ifIndex: state.interfaceIfIndex,
            marker: state.interfaceMarker,
            name: state.interfaceName,
            type: 'dummy',
          }
        : null,
    keeper: {
      groupId: state.spec.keeperGroupId,
      pid: state.spec.keeperPid,
      start: state.spec.keeperStart,
    },
    kind: state.spec.kind,
    ownerId: state.spec.ownerId,
    protocol: FIXED_NETWORK_CONTROL_PROTOCOL,
    resourceId: state.spec.resourceId,
    sessionId: state.spec.sessionId,
    targets: state.targets,
    version: 1,
  };
}

async function writePrivateNetworkReceipt(path: string, value: unknown): Promise<void> {
  const file = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  const failures: unknown[] = [];
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await file.sync();
  } catch (error) {
    failures.push(error);
  }
  try {
    await file.close();
  } catch (error) {
    failures.push(error);
  }
  throwAssemblyFailures(failures, 'The fixed network receipt write did not settle.');
  await syncDirectory(dirname(path));
}

function isValidNetworkCreateMessage(value: unknown): value is NetworkCreateMessage {
  if (!isRecord(value) || value.type !== 'network-create') {
    return false;
  }
  const profile = value.kind === 'profile';
  const expectedInterface =
    profile && typeof value.resourceId === 'string'
      ? fixedNetworkInterface(value.resourceId)
      : undefined;
  if (!hasExactKeys(value, profile ? NETWORK_PROFILE_CREATE_KEYS : NETWORK_LEGACY_CREATE_KEYS)) {
    return false;
  }

  const resourceId = value.resourceId;
  const fixtureRoot = value.fixtureRoot;
  return (
    value.protocol === FIXED_NETWORK_CONTROL_PROTOCOL &&
    (value.kind === 'legacy' || value.kind === 'profile') &&
    isUuid(value.bootId) &&
    typeof fixtureRoot === 'string' &&
    isAbsoluteTrustedPath(fixtureRoot) &&
    fixtureRoot.endsWith(`/runtime-sessions/${value.sessionId}/fixtures`) &&
    value.journalKey instanceof Uint8Array &&
    value.journalKey.byteLength === 32 &&
    Number.isSafeInteger(value.keeperGroupId) &&
    value.keeperGroupId === process.pid &&
    value.keeperPid === process.pid &&
    typeof value.keeperStart === 'string' &&
    /^\d+$/.test(value.keeperStart) &&
    typeof value.ownerId === 'string' &&
    /^[A-Za-z0-9_.-]{1,120}$/.test(value.ownerId) &&
    typeof resourceId === 'string' &&
    /^network-[0-9a-f-]{36}$/i.test(resourceId) &&
    typeof value.sessionId === 'string' &&
    isCandidateId(value.sessionId) &&
    typeof value.receiptPath === 'string' &&
    dirname(value.receiptPath) === dirname(fixtureRoot) &&
    basename(value.receiptPath) === `${resourceId}.network-created.json` &&
    typeof value.terminalReceiptPath === 'string' &&
    dirname(value.terminalReceiptPath) === dirname(fixtureRoot) &&
    basename(value.terminalReceiptPath) === `${resourceId}.network-terminal.json` &&
    (!profile ||
      (typeof value.interfaceName === 'string' &&
        value.interfaceName === expectedInterface?.interfaceName &&
        typeof value.interfaceMarker === 'string' &&
        value.interfaceMarker === expectedInterface?.interfaceMarker))
  );
}

function fixedNetworkInterface(resourceId: string): Readonly<{
  interfaceMarker: string;
  interfaceName: string;
}> {
  const digest = createHash('sha256')
    .update('qdroid.fixed-network-interface/v1')
    .update('\0')
    .update(resourceId)
    .digest('hex');
  const markerBytes = [
    digest.slice(10, 12),
    digest.slice(12, 14),
    digest.slice(14, 16),
    digest.slice(16, 18),
    digest.slice(18, 20),
  ];
  return Object.freeze({
    interfaceMarker: `02:${markerBytes.join(':')}`,
    interfaceName: `qd5${digest.slice(0, 10)}`,
  });
}

function isValidNetworkOperationMessage(value: unknown): value is NetworkOperationMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'protocol', 'type']) &&
    typeof value.id === 'string' &&
    isUuid(value.id) &&
    value.protocol === FIXED_NETWORK_CONTROL_PROTOCOL &&
    (value.type === 'network-assert' ||
      value.type === 'network-positive' ||
      value.type === 'network-reset' ||
      value.type === 'network-snapshot')
  );
}

const NETWORK_LEGACY_CREATE_KEYS = [
  'bootId',
  'fixtureRoot',
  'journalKey',
  'keeperGroupId',
  'keeperPid',
  'keeperStart',
  'kind',
  'ownerId',
  'protocol',
  'receiptPath',
  'resourceId',
  'sessionId',
  'terminalReceiptPath',
  'type',
];

const NETWORK_PROFILE_CREATE_KEYS = [
  ...NETWORK_LEGACY_CREATE_KEYS,
  'interfaceMarker',
  'interfaceName',
];

function sealBoundaryConstruction(): void {
  if (lifecycleMode === 'boundary-creating') {
    boundaryConstructionSealed = true;
  }
}

function assertBoundaryConstructionOpen(): void {
  if (
    lifecycleMode !== 'boundary-creating' ||
    boundaryConstructionSealed ||
    disconnectRequested ||
    finished
  ) {
    throw new Error('The fixed boundary control creation was sealed before completion.');
  }
}

async function handleBoundaryOperation(
  message: BoundaryAssertMessage | BoundaryRegisterMessage | BoundaryReleaseMessage,
): Promise<void> {
  const state = boundaryControl;
  if (state === undefined || lifecycleMode !== 'boundary-active') {
    throw new Error('The fixed boundary keeper is unavailable.');
  }

  try {
    if (isValidBoundaryAssertMessage(message)) {
      await assertBoundaryControls(state);
      sendBoundaryResult(message.id);
      return;
    }

    if (isValidBoundaryRegisterMessage(message)) {
      await assertBoundaryControls(state);
      const authenticationTag = await registerBoundaryDependency(state, message);
      sendBoundaryResult(message.id, authenticationTag);
      return;
    }

    if (isValidBoundaryReleaseMessage(message)) {
      await releaseBoundaryDependency(state, message);
      sendBoundaryResult(message.id);
      return;
    }

    throw new Error('The fixed boundary keeper received an invalid operation.');
  } catch (error) {
    const messageText = formatGuardianError(error, 'The fixed boundary keeper failed.');
    state.healthError ??= messageText;
    sendBoundaryResult(message.id, undefined, messageText);
  }
}

function sendBoundaryResult(id: string, authenticationTag?: string, error?: string): void {
  send({
    ...(authenticationTag === undefined ? {} : { authenticationTag }),
    ...(error === undefined ? {} : { error }),
    id,
    protocol: FIXED_BOUNDARY_CONTROL_PROTOCOL,
    type: 'boundary-result',
  });
}

async function createBoundaryFile(
  directory: string,
  name: BoundaryRetainedFile['name'],
  contents: string,
): Promise<BoundaryRetainedFile> {
  const path = join(directory, name);
  const file = await open(
    path,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(contents, 'utf8');
    await file.sync();
    const status = await file.stat();
    if (!status.isFile() || (status.mode & 0o777) !== 0o600 || status.size !== contents.length) {
      throw new Error('The fixed boundary canary did not retain its private file identity.');
    }
    return Object.freeze({ contents, file, name, path });
  } catch (error) {
    const failures = [error];
    try {
      await file.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    throw new AggregateError(failures, 'The fixed boundary canary could not be created safely.');
  }
}

async function assertBoundaryControls(state: BoundaryControlState): Promise<void> {
  if (state.healthError !== undefined) {
    throw new Error(state.healthError);
  }
  await assertPrivateBoundaryDirectory(state.spec.fixtureRoot, state.parentHandle, 0o700);
  await assertPrivateBoundaryDirectory(state.directory, state.directoryHandle, 0o700);

  const entries = await readdir(state.directory);
  const expectedEntries = state.files.map((file) => file.name).sort();
  if (
    entries.length !== expectedEntries.length ||
    entries.sort().some((entry, index) => entry !== expectedEntries[index])
  ) {
    throw new Error('The fixed boundary directory contains an unexpected entry.');
  }

  for (const file of state.files) {
    await assertBoundaryFile(file);
  }

  const currentChildStart = await readProbeProcessStart(state.childPid);
  if (currentChildStart !== state.childStart) {
    throw new Error('The fixed boundary secret child identity changed.');
  }
  const environment = await readFile(`/proc/${state.childPid}/environ`);
  if (!environment.includes(`QDROID_T005_BOUNDARY_SECRET=${state.secret}`)) {
    throw new Error('The fixed boundary secret child no longer exposes its original secret.');
  }

  const [device, dockerSocket] = await Promise.all([
    stat('/dev/vdb'),
    stat('/var/run/docker.sock'),
  ]);
  if (!device.isBlockDevice() || !dockerSocket.isSocket()) {
    throw new Error('The fixed boundary positive host controls are unavailable.');
  }
}

async function assertPrivateBoundaryDirectory(
  path: string,
  handle: FileHandle,
  expectedMode: number,
): Promise<void> {
  const [link, current, held] = await Promise.all([lstat(path), stat(path), handle.stat()]);
  if (
    link.isSymbolicLink() ||
    !current.isDirectory() ||
    !held.isDirectory() ||
    (current.mode & 0o777) !== expectedMode ||
    (held.mode & 0o777) !== expectedMode ||
    !matchesBoundaryIdentity(current, held)
  ) {
    throw new Error('The fixed boundary directory identity changed.');
  }
}

async function assertBoundaryFile(file: BoundaryRetainedFile): Promise<void> {
  const [link, current, held] = await Promise.all([
    lstat(file.path),
    stat(file.path),
    file.file.stat(),
  ]);
  if (
    link.isSymbolicLink() ||
    !current.isFile() ||
    !held.isFile() ||
    (current.mode & 0o777) !== 0o600 ||
    (held.mode & 0o777) !== 0o600 ||
    !matchesBoundaryIdentity(current, held) ||
    current.size !== Buffer.byteLength(file.contents)
  ) {
    throw new Error('The fixed boundary canary identity changed.');
  }
  const contents = Buffer.alloc(Buffer.byteLength(file.contents));
  const result = await file.file.read(contents, 0, contents.byteLength, 0);
  if (result.bytesRead !== contents.byteLength || contents.toString('utf8') !== file.contents) {
    throw new Error('The fixed boundary canary contents changed.');
  }
}

function matchesBoundaryIdentity(
  current: Readonly<{ dev: number; ino: number }>,
  held: Readonly<{ dev: number; ino: number }>,
): boolean {
  return current.dev === held.dev && current.ino === held.ino;
}

async function registerBoundaryDependency(
  state: BoundaryControlState,
  message: BoundaryRegisterMessage,
): Promise<string> {
  if (state.dependencies.has(message.resourceId)) {
    throw new Error('The fixed boundary probe dependency was already registered.');
  }
  if (!(await hasAuthenticatedBoundaryProbeConfiguration(state, message))) {
    throw new Error('The fixed boundary probe was not durably configured for this keeper.');
  }
  const payload = {
    boundaryReceiptAuthenticationTag: state.receiptAuthenticationTag,
    configurationAuthenticationTag: message.configurationAuthenticationTag,
    containerName: message.containerName,
    guardian: {
      groupId: message.guardianGroupId,
      pid: message.guardianPid,
      start: message.guardianStart,
    },
    imageId: message.imageId,
    labels: message.labels,
    ownerId: state.spec.ownerId,
    protocol: FIXED_BOUNDARY_CONTROL_PROTOCOL,
    resourceId: message.resourceId,
    sessionId: state.spec.sessionId,
    terminalReceiptPath: message.terminalReceiptPath,
    version: 1,
  };
  const authenticationTag = boundaryReceiptAuthenticationTag(
    'qdroid.boundary-dependency/v1',
    state.spec.journalKey,
    payload,
  );
  const receiptPath = join(
    dirname(state.spec.fixtureRoot),
    `${state.spec.resourceId}.${message.resourceId}.boundary-dependency.json`,
  );
  await writeAtomicJson(receiptPath, { ...payload, authenticationTag });
  state.dependencies.set(
    message.resourceId,
    Object.freeze({
      authenticationTag,
      configurationAuthenticationTag: message.configurationAuthenticationTag,
      configurationReceiptPath: message.configurationReceiptPath,
      containerName: message.containerName,
      guardian: Object.freeze({
        groupId: message.guardianGroupId,
        pid: message.guardianPid,
        start: message.guardianStart,
      }),
      imageId: message.imageId,
      labels: Object.freeze({ ...message.labels }),
      receiptPath,
      terminalReceiptPath: message.terminalReceiptPath,
    }),
  );
  return authenticationTag;
}

async function hasAuthenticatedBoundaryProbeConfiguration(
  state: BoundaryControlState,
  message: BoundaryRegisterMessage,
): Promise<boolean> {
  const parsed = await readPrivateBoundaryReceipt(message.configurationReceiptPath);
  const crossAppCanary = state.files.find((file) => file.name === 'cross-app-canary');
  const trustedStoreCanary = state.files.find((file) => file.name === 'trusted-store-canary');
  const expectedConfigurationPath = join(
    dirname(state.spec.fixtureRoot),
    `${message.resourceId}.boundary-configured.json`,
  );
  const expectedCreationPath = join(
    dirname(state.spec.fixtureRoot),
    `${message.resourceId}.boundary-created.json`,
  );
  const expectedTerminalPath = join(
    dirname(state.spec.fixtureRoot),
    `${message.resourceId}.boundary-terminal.json`,
  );
  if (
    parsed === undefined ||
    crossAppCanary === undefined ||
    trustedStoreCanary === undefined ||
    !hasExactKeys(parsed, [
      'authenticationTag',
      'bootId',
      'containerName',
      'controlReceiptAuthenticationTag',
      'controlResourceId',
      'creationReceiptPath',
      'guardian',
      'imageId',
      'intent',
      'labels',
      'ownerId',
      'protocol',
      'resourceId',
      'sessionId',
      'terminalReceiptPath',
      'version',
    ]) ||
    parsed.bootId !== state.spec.bootId ||
    parsed.controlReceiptAuthenticationTag !== state.receiptAuthenticationTag ||
    parsed.controlResourceId !== state.spec.resourceId ||
    parsed.creationReceiptPath !== expectedCreationPath ||
    parsed.containerName !== message.containerName ||
    parsed.imageId !== message.imageId ||
    !sameBoundaryLabels(parsed.labels, message.labels) ||
    parsed.ownerId !== state.spec.ownerId ||
    parsed.protocol !== FIXED_BOUNDARY_PROBE_PROTOCOL ||
    parsed.resourceId !== message.resourceId ||
    parsed.sessionId !== state.spec.sessionId ||
    parsed.terminalReceiptPath !== expectedTerminalPath ||
    message.configurationReceiptPath !== expectedConfigurationPath ||
    message.terminalReceiptPath !== expectedTerminalPath ||
    parsed.version !== 1 ||
    !isRecord(parsed.guardian) ||
    !hasExactKeys(parsed.guardian, ['groupId', 'pid', 'start']) ||
    parsed.guardian.groupId !== message.guardianGroupId ||
    parsed.guardian.pid !== message.guardianPid ||
    parsed.guardian.start !== message.guardianStart ||
    !matchesBoundaryProbeIntentForControl(
      parsed.intent,
      state,
      crossAppCanary.path,
      trustedStoreCanary.path,
    ) ||
    !isRecord(parsed.labels) ||
    typeof parsed.authenticationTag !== 'string'
  ) {
    return false;
  }

  const payload = {
    bootId: parsed.bootId,
    controlReceiptAuthenticationTag: parsed.controlReceiptAuthenticationTag,
    controlResourceId: parsed.controlResourceId,
    creationReceiptPath: parsed.creationReceiptPath,
    guardian: parsed.guardian,
    imageId: parsed.imageId,
    intent: parsed.intent,
    labels: parsed.labels,
    ownerId: parsed.ownerId,
    protocol: parsed.protocol,
    resourceId: parsed.resourceId,
    sessionId: parsed.sessionId,
    containerName: parsed.containerName,
    terminalReceiptPath: parsed.terminalReceiptPath,
    version: parsed.version,
  };
  const expected = boundaryReceiptAuthenticationTag(
    'qdroid.boundary-probe-configured/v1',
    state.spec.journalKey,
    payload,
  );
  return (
    timingSafeHexEqual(parsed.authenticationTag, expected) &&
    timingSafeHexEqual(message.configurationAuthenticationTag, expected)
  );
}

function matchesBoundaryProbeIntentForControl(
  value: unknown,
  state: BoundaryControlState,
  crossAppPath: string,
  trustedStorePath: string,
): value is BoundaryProbeIntentMessage {
  return (
    isValidBoundaryProbeIntent(value) &&
    value.childPid === state.childPid &&
    value.childStart === state.childStart &&
    value.controlReceiptAuthenticationTag === state.receiptAuthenticationTag &&
    value.controlResourceId === state.spec.resourceId &&
    value.crossAppPath === crossAppPath &&
    value.trustedStorePath === trustedStorePath
  );
}

async function readPrivateBoundaryReceipt(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  let file: FileHandle | undefined;
  try {
    const link = await lstat(path);
    if (link.isSymbolicLink() || !link.isFile() || (link.mode & 0o777) !== 0o600) {
      return undefined;
    }
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const held = await file.stat();
    if (!held.isFile() || (held.mode & 0o777) !== 0o600 || !matchesBoundaryIdentity(link, held)) {
      return undefined;
    }
    const bytes = await file.readFile();
    await file.sync();
    const after = await lstat(path);
    if (!matchesBoundaryIdentity(link, after)) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    if (file !== undefined) {
      try {
        await file.close();
      } catch {
        return undefined;
      }
    }
  }
}

async function releaseBoundaryDependency(
  state: BoundaryControlState,
  message: BoundaryReleaseMessage,
): Promise<void> {
  await retireBoundaryDependency(state, message.resourceId, message.authenticationTag);
}

async function retireBoundaryDependency(
  state: BoundaryControlState,
  resourceId: string,
  authenticationTag: string,
): Promise<void> {
  const dependency = state.dependencies.get(resourceId);
  if (dependency === undefined || dependency.authenticationTag !== authenticationTag) {
    throw new Error('The fixed boundary probe dependency is not owned by this keeper.');
  }
  if (!(await hasConfirmedBoundaryDependencyCleanup(state, resourceId, dependency))) {
    throw new Error('The fixed boundary probe dependency has not proved original cleanup.');
  }

  const terminalPayload = {
    boundaryReceiptAuthenticationTag: state.receiptAuthenticationTag,
    dependency: {
      authenticationTag: dependency.authenticationTag,
      containerName: dependency.containerName,
      guardian: dependency.guardian,
      imageId: dependency.imageId,
      labels: dependency.labels,
      receiptPath: dependency.receiptPath,
    },
    ownerId: state.spec.ownerId,
    protocol: FIXED_BOUNDARY_CONTROL_PROTOCOL,
    resourceId,
    schema: 'qdroid.boundary-dependency-terminal/v1',
    sessionId: state.spec.sessionId,
    status: 'cleaned',
    version: 1,
  };
  const terminalAuthenticationTag = boundaryReceiptAuthenticationTag(
    'qdroid.boundary-dependency-terminal/v1',
    state.spec.journalKey,
    terminalPayload,
  );
  const terminalPath = join(
    dirname(state.spec.fixtureRoot),
    `${state.spec.resourceId}.${resourceId}.boundary-dependency-terminal.json`,
  );
  await writeAtomicJson(terminalPath, {
    ...terminalPayload,
    authenticationTag: terminalAuthenticationTag,
  });
  state.dependencies.delete(resourceId);
}

async function hasConfirmedBoundaryDependencyCleanup(
  state: BoundaryControlState,
  resourceId: string,
  dependency: BoundaryDependency,
): Promise<boolean> {
  return (
    (await hasAuthenticatedBoundaryProbeTerminal(state, resourceId, dependency)) &&
    isProcessGroupAbsent(dependency.guardian.groupId)
  );
}

async function hasAuthenticatedBoundaryProbeTerminal(
  state: BoundaryControlState,
  resourceId: string,
  dependency: BoundaryDependency,
): Promise<boolean> {
  const parsed = await readPrivateBoundaryReceipt(dependency.terminalReceiptPath);
  if (
    parsed === undefined ||
    parsed.schema !== 'qdroid.boundary-probe-terminal/v1' ||
    parsed.resourceId !== resourceId ||
    parsed.ownerId !== state.spec.ownerId ||
    parsed.sessionId !== state.spec.sessionId ||
    parsed.controlResourceId !== state.spec.resourceId ||
    parsed.controlReceiptAuthenticationTag !== state.receiptAuthenticationTag ||
    parsed.configurationAuthenticationTag !== dependency.configurationAuthenticationTag ||
    parsed.version !== 1 ||
    !isRecord(parsed.guardian) ||
    !hasExactKeys(parsed.guardian, ['groupId', 'pid', 'start']) ||
    parsed.guardian.groupId !== dependency.guardian.groupId ||
    parsed.guardian.pid !== dependency.guardian.pid ||
    parsed.guardian.start !== dependency.guardian.start ||
    typeof parsed.authenticationTag !== 'string'
  ) {
    return false;
  }

  if (parsed.status === 'no-create') {
    if (
      !hasExactKeys(parsed, [
        'authenticationTag',
        'configurationAuthenticationTag',
        'controlReceiptAuthenticationTag',
        'controlResourceId',
        'guardian',
        'ownerId',
        'resourceId',
        'schema',
        'sessionId',
        'status',
        'version',
      ])
    ) {
      return false;
    }
  } else if (parsed.status === 'created-cleaned') {
    if (
      !hasExactKeys(parsed, [
        'authenticationTag',
        'configurationAuthenticationTag',
        'containerId',
        'controlReceiptAuthenticationTag',
        'controlResourceId',
        'creationReceipt',
        'executionReceipt',
        'guardian',
        'ownerId',
        'raw',
        'resourceId',
        'schema',
        'sessionId',
        'status',
        'version',
      ]) ||
      typeof parsed.containerId !== 'string' ||
      !isContainerId(parsed.containerId) ||
      !isRecord(parsed.creationReceipt) ||
      !hasExactKeys(parsed.creationReceipt, ['authenticationTag', 'path']) ||
      parsed.creationReceipt.path !==
        join(dirname(state.spec.fixtureRoot), `${resourceId}.boundary-created.json`) ||
      typeof parsed.creationReceipt.authenticationTag !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(parsed.creationReceipt.authenticationTag) ||
      !isRecord(parsed.executionReceipt) ||
      !hasExactKeys(parsed.executionReceipt, ['authenticationTag', 'path']) ||
      parsed.executionReceipt.path !== `${parsed.creationReceipt.path}.execution` ||
      typeof parsed.executionReceipt.authenticationTag !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(parsed.executionReceipt.authenticationTag) ||
      !isRecord(parsed.raw) ||
      !hasExactKeys(parsed.raw, [
        'createCommandCompleted',
        'createExitCode',
        'removeCommandCompleted',
        'removeExitCode',
      ]) ||
      parsed.raw.createCommandCompleted !== true ||
      parsed.raw.createExitCode !== 0 ||
      parsed.raw.removeCommandCompleted !== true ||
      parsed.raw.removeExitCode !== 0
    ) {
      return false;
    }
    if (
      !(await hasAuthenticatedBoundaryProbeCreation(
        state,
        resourceId,
        dependency,
        parsed.containerId,
        parsed.creationReceipt.authenticationTag,
        parsed.raw,
      ))
    ) {
      return false;
    }
    if (
      !(await hasAuthenticatedBoundaryProbeFirstExecution(
        state,
        resourceId,
        dependency,
        parsed.containerId,
        parsed.creationReceipt,
        parsed.executionReceipt.authenticationTag,
      ))
    ) {
      return false;
    }
  } else {
    return false;
  }

  const { authenticationTag, ...payload } = parsed;
  const expected = boundaryReceiptAuthenticationTag(
    'qdroid.boundary-probe-terminal/v1',
    state.spec.journalKey,
    payload,
  );
  return timingSafeHexEqual(authenticationTag, expected);
}

async function hasAuthenticatedBoundaryProbeCreation(
  state: BoundaryControlState,
  resourceId: string,
  dependency: BoundaryDependency,
  containerId: string,
  authenticationTag: string,
  raw: Record<string, unknown>,
): Promise<boolean> {
  const path = join(dirname(state.spec.fixtureRoot), `${resourceId}.boundary-created.json`);
  const parsed = await readPrivateBoundaryReceipt(path);
  if (
    parsed === undefined ||
    !hasExactKeys(parsed, [
      'authenticationTag',
      'configurationAuthenticationTag',
      'container',
      'controlReceiptAuthenticationTag',
      'controlResourceId',
      'firstCreate',
      'guardian',
      'ownerId',
      'resourceId',
      'schema',
      'sessionId',
      'version',
    ]) ||
    parsed.authenticationTag !== authenticationTag ||
    parsed.configurationAuthenticationTag !== dependency.configurationAuthenticationTag ||
    parsed.controlReceiptAuthenticationTag !== state.receiptAuthenticationTag ||
    parsed.controlResourceId !== state.spec.resourceId ||
    !isRecord(parsed.container) ||
    !hasExactKeys(parsed.container, ['id', 'name']) ||
    parsed.container.id !== containerId ||
    parsed.container.name !== dependency.containerName ||
    !isRecord(parsed.firstCreate) ||
    !hasExactKeys(parsed.firstCreate, ['commandCompleted', 'exitCode']) ||
    parsed.firstCreate.commandCompleted !== true ||
    parsed.firstCreate.exitCode !== 0 ||
    raw.createCommandCompleted !== parsed.firstCreate.commandCompleted ||
    raw.createExitCode !== parsed.firstCreate.exitCode ||
    !isRecord(parsed.guardian) ||
    !hasExactKeys(parsed.guardian, ['groupId', 'pid', 'start']) ||
    parsed.guardian.groupId !== dependency.guardian.groupId ||
    parsed.guardian.pid !== dependency.guardian.pid ||
    parsed.guardian.start !== dependency.guardian.start ||
    parsed.ownerId !== state.spec.ownerId ||
    parsed.resourceId !== resourceId ||
    parsed.schema !== 'qdroid.boundary-probe-created/v1' ||
    parsed.sessionId !== state.spec.sessionId ||
    parsed.version !== 1
  ) {
    return false;
  }

  const { authenticationTag: receiptAuthenticationTag, ...payload } = parsed;
  const expected = boundaryReceiptAuthenticationTag(
    'qdroid.boundary-probe-created/v1',
    state.spec.journalKey,
    payload,
  );
  return timingSafeHexEqual(receiptAuthenticationTag, expected);
}

async function hasAuthenticatedBoundaryProbeFirstExecution(
  state: BoundaryControlState,
  resourceId: string,
  dependency: BoundaryDependency,
  containerId: string,
  creationReceipt: Record<string, unknown>,
  authenticationTag: string,
): Promise<boolean> {
  const creationPath = join(dirname(state.spec.fixtureRoot), `${resourceId}.boundary-created.json`);
  const parsed = await readPrivateBoundaryReceipt(`${creationPath}.execution`);
  if (
    parsed === undefined ||
    !hasExactKeys(parsed, [
      'authenticationTag',
      'configurationAuthenticationTag',
      'container',
      'controlReceiptAuthenticationTag',
      'controlResourceId',
      'creationReceipt',
      'guardian',
      'outcome',
      'ownerId',
      'resourceId',
      'schema',
      'sessionId',
      'version',
    ]) ||
    parsed.authenticationTag !== authenticationTag ||
    parsed.configurationAuthenticationTag !== dependency.configurationAuthenticationTag ||
    parsed.controlReceiptAuthenticationTag !== state.receiptAuthenticationTag ||
    parsed.controlResourceId !== state.spec.resourceId ||
    !isRecord(parsed.container) ||
    !hasExactKeys(parsed.container, ['id', 'name']) ||
    parsed.container.id !== containerId ||
    parsed.container.name !== dependency.containerName ||
    !isRecord(parsed.creationReceipt) ||
    !hasExactKeys(parsed.creationReceipt, ['authenticationTag', 'path']) ||
    parsed.creationReceipt.path !== creationPath ||
    parsed.creationReceipt.authenticationTag !== creationReceipt.authenticationTag ||
    !isRecord(parsed.guardian) ||
    !hasExactKeys(parsed.guardian, ['groupId', 'pid', 'start']) ||
    parsed.guardian.groupId !== dependency.guardian.groupId ||
    parsed.guardian.pid !== dependency.guardian.pid ||
    parsed.guardian.start !== dependency.guardian.start ||
    !isValidBoundaryProbeFirstExecutionOutcome(parsed.outcome) ||
    parsed.ownerId !== state.spec.ownerId ||
    parsed.resourceId !== resourceId ||
    parsed.schema !== 'qdroid.boundary-probe-first-execution/v1' ||
    parsed.sessionId !== state.spec.sessionId ||
    parsed.version !== 1
  ) {
    return false;
  }

  const { authenticationTag: receiptAuthenticationTag, ...payload } = parsed;
  const expected = boundaryReceiptAuthenticationTag(
    'qdroid.boundary-probe-first-execution/v1',
    state.spec.journalKey,
    payload,
  );
  return timingSafeHexEqual(receiptAuthenticationTag, expected);
}

function isValidBoundaryProbeFirstExecutionOutcome(
  value: unknown,
): value is BoundaryProbeFirstExecutionOutcome {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return false;
  }
  if (value.kind === 'never-started') {
    return hasExactKeys(value, ['kind']);
  }
  return (
    value.kind === 'command' &&
    hasExactKeys(value, ['errorMessage', 'exitCode', 'kind', 'reason']) &&
    (value.errorMessage === null || typeof value.errorMessage === 'string') &&
    (value.exitCode === null ||
      (typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode))) &&
    (value.reason === 'completed' ||
      value.reason === 'deadline' ||
      value.reason === 'output-limit' ||
      value.reason === 'stopped')
  );
}

async function readAuthenticatedBoundaryResourceJournal(
  state: BoundaryControlState,
  path: string,
): Promise<Readonly<{ resources: readonly unknown[] }> | undefined> {
  let file: FileHandle | undefined;
  try {
    const link = await lstat(path);
    if (link.isSymbolicLink() || !link.isFile() || (link.mode & 0o777) !== 0o600) {
      return undefined;
    }
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const held = await file.stat();
    if (
      !held.isFile() ||
      (held.mode & 0o777) !== 0o600 ||
      held.dev !== link.dev ||
      held.ino !== link.ino
    ) {
      return undefined;
    }
    const bytes = await file.readFile();
    await file.sync();
    const after = await lstat(path);
    if (after.dev !== link.dev || after.ino !== link.ino) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !isRecord(parsed) ||
      parsed.ownerId !== state.spec.ownerId ||
      parsed.sessionId !== state.spec.sessionId ||
      parsed.version !== 2 ||
      !Array.isArray(parsed.resources) ||
      typeof parsed.authenticationTag !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(parsed.authenticationTag)
    ) {
      return undefined;
    }
    const payload = {
      ownerId: parsed.ownerId,
      resources: parsed.resources,
      schema: 'qdroid.managed-resource-journal/v2',
      sessionId: parsed.sessionId,
      version: parsed.version,
    };
    const expected = createHmac('sha256', Buffer.from(state.spec.journalKey))
      .update(JSON.stringify(payload))
      .digest('hex');
    const expectedBytes = Buffer.from(expected, 'hex');
    const actualBytes = Buffer.from(parsed.authenticationTag, 'hex');
    if (
      actualBytes.byteLength !== expectedBytes.byteLength ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      return undefined;
    }
    return Object.freeze({ resources: Object.freeze([...parsed.resources]) });
  } catch {
    return undefined;
  } finally {
    if (file !== undefined) {
      try {
        await file.close();
      } catch {
        return undefined;
      }
    }
  }
}

function sameBoundaryLabels(value: unknown, expected: Readonly<Record<string, string>>): boolean {
  if (!isRecord(value) || Object.keys(value).length !== Object.keys(expected).length) {
    return false;
  }
  return Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function isProcessGroupAbsent(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return false;
  } catch (error) {
    return isMissingProcessGroup(error);
  }
}

async function createFixedProbe(message: ProbeCreateMessage): Promise<void> {
  const isBoundaryProbe = message.protocol === FIXED_BOUNDARY_PROBE_PROTOCOL;
  const configured = boundaryProbeConfiguration;
  const expectedLifecycle = isBoundaryProbe ? 'boundary-probe-configured' : 'idle';
  if (lifecycleMode !== expectedLifecycle || !isValidProbeCreateMessage(message)) {
    throw new Error('The guardian received an invalid fixed probe creation.');
  }

  if (isBoundaryProbe) {
    fixedProbeCreationSealed = false;
    const authorization = message.boundaryAuthorization;
    if (
      configured === undefined ||
      authorization === undefined ||
      configured.createSubmitted ||
      !matchesConfiguredBoundaryProbe(configured, message) ||
      !verifyBoundaryProbeAuthorization(configured, authorization)
    ) {
      throw new Error(
        'The boundary probe create authorization did not match its configured keeper binding.',
      );
    }
    configured.authorizationRecorded = true;
    await writeBoundaryProbeAuthorizationReceipt(configured, authorization);
    assertFixedProbeCreationOpen(configured);
    configured.createSubmitted = true;
  }

  const definition = fixedProbeDefinition(message.intent, message.ownership);
  if (definition === undefined) {
    throw new Error('The guardian received an unsupported fixed probe operation.');
  }

  containerName = message.containerName;
  probeIntent = message.intent;
  probeOwnership = message.ownership;
  fixedProbeProtocol = message.protocol;
  lifecycleMode = 'starting';
  outputLimitBytes = message.maxOutputBytes;
  fixedProbeDeadlineMs = message.deadlineMs;

  if (isBoundaryProbe && configured !== undefined) {
    assertFixedProbeCreationOpen(configured);
  }

  const created = await runDocker([
    'create',
    '--pull=never',
    '--name',
    containerName,
    ...definition.createArguments,
    message.imageId,
    ...definition.workloadArguments,
  ]);
  if (isBoundaryProbe && configured !== undefined) {
    retainBoundaryRawWriter(configured, created);
  }
  if (
    !created.commandCompleted ||
    created.exitCode !== 0 ||
    !isContainerId(created.stdout.trim())
  ) {
    throw new Error('The guardian could not create its fixed probe container.');
  }
  const createdContainerId = created.stdout.trim();

  if (isBoundaryProbe && configured !== undefined) {
    const createResult = Object.freeze({
      commandCompleted: created.commandCompleted,
      containerId: createdContainerId,
      exitCode: created.exitCode,
    });
    // This is an observed Docker result, not a new effect.  Retain it before
    // checking a concurrent stop fence so the original guardian can perform
    // exact cleanup if the parent disconnected while create was in flight.
    configured.createResult = createResult;
    const createReceiptAuthenticationTag = await writeBoundaryProbeCreationReceipt(
      configured,
      createResult,
    );
    configured.createReceiptAuthenticationTag = createReceiptAuthenticationTag;
    // A durably recorded Docker create result is sufficient for the original
    // guardian to perform exact cleanup if the following inspection is held
    // or fails after a parent stop fence.  It is not a business-success
    // acknowledgement and is never sent to the parent from this branch.
    ownedContainerId = createdContainerId;
  }

  const binding = await inspectOwnedProbeBinding(
    containerName,
    message.ownership,
    createdContainerId,
  );
  if (binding === undefined) {
    throw new Error('The guardian could not identify its fixed probe container.');
  }

  // `inspect` is the matching observation needed to clean an already-created
  // container.  Keep its exact identity before testing the stop fence.
  ownedContainerId = binding.containerId;
  lifecycleMode = 'probe-created';
  if (isBoundaryProbe && configured !== undefined) {
    assertFixedProbeCreationOpen(configured);
  }
  send({ containerId: ownedContainerId, protocol: fixedProbeProtocol, type: 'created' });
  if (message.intent.kind === 'legacy-fixed-configuration') {
    deadline = setTimeout(() => {
      void finish('deadline');
    }, message.deadlineMs);
  }
}

async function configureBoundaryProbe(message: BoundaryProbeConfigureMessage): Promise<void> {
  if (lifecycleMode !== 'idle' || !isValidBoundaryProbeConfigureMessage(message)) {
    throw new Error('The guardian received an invalid boundary probe configuration.');
  }
  if (
    message.guardianPid !== process.pid ||
    (await readProbeProcessStart(process.pid)) !== message.guardianStart
  ) {
    throw new Error(
      'The configured boundary probe guardian identity did not match its durable record.',
    );
  }
  boundaryProbeConfigurationSealed = false;
  assertBoundaryProbeConfigurationOpen();

  const payload = boundaryProbeConfigurationPayload(message);
  const configurationAuthenticationTag = boundaryReceiptAuthenticationTag(
    'qdroid.boundary-probe-configured/v1',
    message.journalKey,
    payload,
  );
  await writeAtomicJson(message.configurationReceiptPath, {
    ...payload,
    authenticationTag: configurationAuthenticationTag,
  });
  boundaryProbeConfiguration = {
    authorizationRecorded: false,
    configurationAuthenticationTag,
    createSubmitted: false,
    message,
    pendingRawWriters: new Set(),
  };
  lifecycleMode = 'boundary-probe-configured';

  // A durable configured receipt is already a cleanup obligation.  Capture it
  // before fencing parent loss so finish can write the matching no-create
  // terminal instead of treating this guardian as an idle worker.
  assertBoundaryProbeConfigurationOpen();
  send({
    configurationAuthenticationTag,
    protocol: FIXED_BOUNDARY_PROBE_PROTOCOL,
    type: 'boundary-probe-configured',
  });
}

function assertBoundaryProbeConfigurationOpen(): void {
  if (boundaryProbeConfigurationSealed || disconnectRequested || finished) {
    throw new Error('The configured boundary probe was sealed before configuration settled.');
  }
}

function assertFixedProbeCreationOpen(configured: BoundaryProbeConfigurationState): void {
  if (
    boundaryProbeConfiguration !== configured ||
    fixedProbeCreationSealed ||
    disconnectRequested ||
    finished
  ) {
    throw new Error('The configured boundary probe was sealed before Docker creation settled.');
  }
}

function boundaryProbeConfigurationPayload(message: BoundaryProbeConfigureMessage): object {
  const probe = message.probe;
  return {
    bootId: message.bootId,
    controlReceiptAuthenticationTag: message.controlReceiptAuthenticationTag,
    controlResourceId: message.controlResourceId,
    creationReceiptPath: message.creationReceiptPath,
    guardian: {
      groupId: message.guardianPid,
      pid: message.guardianPid,
      start: message.guardianStart,
    },
    imageId: probe.imageId,
    intent: probe.intent,
    labels: probe.ownership.labels,
    ownerId: message.ownerId,
    protocol: FIXED_BOUNDARY_PROBE_PROTOCOL,
    resourceId: message.resourceId,
    sessionId: message.sessionId,
    containerName: probe.containerName,
    terminalReceiptPath: message.terminalReceiptPath,
    version: 1,
  };
}

function matchesConfiguredBoundaryProbe(
  configured: BoundaryProbeConfigurationState,
  message: ProbeCreateMessage,
): boolean {
  const expected = configured.message.probe;
  return (
    message.protocol === FIXED_BOUNDARY_PROBE_PROTOCOL &&
    message.containerName === expected.containerName &&
    message.deadlineMs === expected.deadlineMs &&
    message.imageId === expected.imageId &&
    message.maxOutputBytes === expected.maxOutputBytes &&
    JSON.stringify(message.intent) === JSON.stringify(expected.intent) &&
    JSON.stringify(message.ownership) === JSON.stringify(expected.ownership)
  );
}

function verifyBoundaryProbeAuthorization(
  configured: BoundaryProbeConfigurationState,
  authorization: ProbeCreateMessage['boundaryAuthorization'],
): boolean {
  if (authorization === undefined) {
    return false;
  }
  const message = configured.message;
  if (
    authorization.controlResourceId !== message.controlResourceId ||
    authorization.resourceId !== message.resourceId
  ) {
    return false;
  }
  const payload = boundaryDependencyPayload(message, configured.configurationAuthenticationTag);
  const expected = boundaryReceiptAuthenticationTag(
    'qdroid.boundary-dependency/v1',
    message.journalKey,
    payload,
  );
  return timingSafeHexEqual(authorization.dependencyAuthenticationTag, expected);
}

function boundaryDependencyPayload(
  message: BoundaryProbeConfigureMessage,
  configurationAuthenticationTag: string,
): object {
  return {
    boundaryReceiptAuthenticationTag: message.controlReceiptAuthenticationTag,
    configurationAuthenticationTag,
    containerName: message.probe.containerName,
    guardian: {
      groupId: message.guardianPid,
      pid: message.guardianPid,
      start: message.guardianStart,
    },
    imageId: message.probe.imageId,
    labels: message.probe.ownership.labels,
    ownerId: message.ownerId,
    protocol: FIXED_BOUNDARY_CONTROL_PROTOCOL,
    resourceId: message.resourceId,
    sessionId: message.sessionId,
    terminalReceiptPath: message.terminalReceiptPath,
    version: 1,
  };
}

async function writeBoundaryProbeCreationReceipt(
  configured: BoundaryProbeConfigurationState,
  createResult: Readonly<{
    readonly commandCompleted: boolean;
    readonly containerId: string;
    readonly exitCode: number;
  }>,
): Promise<string> {
  const message = configured.message;
  const payload = {
    configurationAuthenticationTag: configured.configurationAuthenticationTag,
    container: {
      id: createResult.containerId,
      name: message.probe.containerName,
    },
    controlReceiptAuthenticationTag: message.controlReceiptAuthenticationTag,
    controlResourceId: message.controlResourceId,
    firstCreate: {
      commandCompleted: createResult.commandCompleted,
      exitCode: createResult.exitCode,
    },
    guardian: {
      groupId: message.guardianPid,
      pid: message.guardianPid,
      start: message.guardianStart,
    },
    ownerId: message.ownerId,
    resourceId: message.resourceId,
    schema: 'qdroid.boundary-probe-created/v1',
    sessionId: message.sessionId,
    version: 1,
  };
  const authenticationTag = boundaryReceiptAuthenticationTag(
    'qdroid.boundary-probe-created/v1',
    message.journalKey,
    payload,
  );
  await writeAtomicJson(message.creationReceiptPath, { ...payload, authenticationTag });
  return authenticationTag;
}

async function recordBoundaryProbeFirstExecution(
  configured: BoundaryProbeConfigurationState,
  containerId: string,
  outcome: BoundaryProbeFirstExecutionOutcome,
): Promise<void> {
  if (configured.firstExecutionOutcome !== undefined) {
    if (JSON.stringify(configured.firstExecutionOutcome) !== JSON.stringify(outcome)) {
      throw new Error('The boundary probe attempted to replace its immutable first execution.');
    }
    if (configured.firstExecutionReceiptAuthenticationTag !== undefined) {
      return;
    }
    if (configured.firstExecutionPersistenceError !== undefined) {
      throw configured.firstExecutionPersistenceError;
    }
    throw new Error('The boundary probe first execution was observed without a durable receipt.');
  }

  // This is the original observed result.  Never defer this assignment until
  // the fallible receipt write: cleanup must retain this exact outcome even
  // when write, sync, or close fails.
  configured.firstExecutionOutcome = outcome;

  if (configured.firstExecutionReceiptAuthenticationTag !== undefined) {
    return;
  }

  const message = configured.message;
  const creationReceiptAuthenticationTag = configured.createReceiptAuthenticationTag;
  const createResult = configured.createResult;
  if (
    creationReceiptAuthenticationTag === undefined ||
    createResult?.containerId !== containerId ||
    createResult.commandCompleted !== true ||
    createResult.exitCode !== 0
  ) {
    throw new Error(
      'The boundary probe lacks an authenticated create result for its first execution.',
    );
  }

  const payload = {
    configurationAuthenticationTag: configured.configurationAuthenticationTag,
    container: { id: containerId, name: message.probe.containerName },
    creationReceipt: {
      authenticationTag: creationReceiptAuthenticationTag,
      path: message.creationReceiptPath,
    },
    controlReceiptAuthenticationTag: message.controlReceiptAuthenticationTag,
    controlResourceId: message.controlResourceId,
    guardian: {
      groupId: message.guardianPid,
      pid: message.guardianPid,
      start: message.guardianStart,
    },
    outcome,
    ownerId: message.ownerId,
    resourceId: message.resourceId,
    schema: 'qdroid.boundary-probe-first-execution/v1',
    sessionId: message.sessionId,
    version: 1,
  };
  const authenticationTag = boundaryReceiptAuthenticationTag(
    'qdroid.boundary-probe-first-execution/v1',
    message.journalKey,
    payload,
  );
  try {
    await writeAtomicJson(`${message.creationReceiptPath}.execution`, {
      ...payload,
      authenticationTag,
    });
    configured.firstExecutionReceiptAuthenticationTag = authenticationTag;
  } catch (error) {
    configured.firstExecutionPersistenceError ??= error;
    throw configured.firstExecutionPersistenceError;
  }
}

async function writeBoundaryProbeAuthorizationReceipt(
  configured: BoundaryProbeConfigurationState,
  authorization: NonNullable<ProbeCreateMessage['boundaryAuthorization']>,
): Promise<void> {
  const message = configured.message;
  const path = `${message.configurationReceiptPath}.authorized`;
  const payload = {
    configurationAuthenticationTag: configured.configurationAuthenticationTag,
    controlResourceId: authorization.controlResourceId,
    dependencyAuthenticationTag: authorization.dependencyAuthenticationTag,
    ownerId: message.ownerId,
    resourceId: authorization.resourceId,
    schema: 'qdroid.boundary-probe-authorized/v1',
    sessionId: message.sessionId,
    version: 1,
  };
  const authenticationTag = boundaryReceiptAuthenticationTag(
    'qdroid.boundary-probe-authorized/v1',
    message.journalKey,
    payload,
  );
  await writeAtomicJson(path, { ...payload, authenticationTag });
}

function retainBoundaryRawWriter(
  configured: BoundaryProbeConfigurationState,
  result: DockerCommandResult,
): void {
  if (result.rawWriterSettled) {
    return;
  }
  const writer = result.rawWriterClosed;
  configured.pendingRawWriters.add(writer);
  const retained = setInterval(() => undefined, 1_000);
  void writer.then(
    () => {
      configured.pendingRawWriters.delete(writer);
      clearInterval(retained);
    },
    () => {
      configured.pendingRawWriters.delete(writer);
      clearInterval(retained);
    },
  );
}

async function waitForBoundaryRawWriters(
  configured: BoundaryProbeConfigurationState,
): Promise<boolean> {
  if (configured.pendingRawWriters.size === 0) {
    return true;
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.all([...configured.pendingRawWriters]).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), RAW_WRITER_SETTLEMENT_WAIT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function inspectFixedProbe(message: ProbeInspectMessage): Promise<void> {
  if (
    !isValidProbeInspectMessage(message) ||
    message.protocol !== fixedProbeProtocol ||
    (lifecycleMode !== 'probe-created' &&
      lifecycleMode !== 'probe-running' &&
      lifecycleMode !== 'probe-command-completed')
  ) {
    throw new Error('The guardian received an invalid fixed probe inspection.');
  }
  if (containerName === undefined || ownedContainerId === undefined || probeIntent === undefined) {
    throw new Error('The fixed probe container identity is unavailable.');
  }

  try {
    const inspection = await inspectProbe(
      message.query,
      containerName,
      ownedContainerId,
      probeIntent,
      probeOwnership,
    );
    send({ id: message.id, inspection, protocol: fixedProbeProtocol, type: 'probe-inspection' });
  } catch (error) {
    const messageText = formatGuardianError(error, 'The fixed probe inspection failed.');
    send({
      error: messageText,
      id: message.id,
      protocol: fixedProbeProtocol,
      type: 'probe-inspection',
    });
  }
}

async function startFixedProbe(message: ProbeStartMessage): Promise<void> {
  if (
    !isValidProbeStartMessage(message) ||
    message.protocol !== fixedProbeProtocol ||
    lifecycleMode !== 'probe-created' ||
    probeIntent === undefined
  ) {
    throw new Error('The guardian received an invalid fixed probe start.');
  }

  // A configuration probe is intentionally stopped-only. The separate
  // create/inspect lifecycle makes the profile verification observable before
  // any guest process can execute.
  if (probeIntent.kind === 'legacy-fixed-configuration') {
    throw new Error('The fixed configuration probe has no start phase.');
  }

  if (ownedContainerId === undefined) {
    throw new Error('The fixed probe container identity is unavailable.');
  }

  lifecycleMode = 'probe-running';
  attached = spawn('docker', ['start', '--attach', '--interactive', ownedContainerId], {
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  attached.stdout.pause();
  attached.stderr.pause();
  attached.stdout.on('readable', () => drainAvailableOutput('stdout', attached?.stdout));
  attached.stderr.on('readable', () => drainAvailableOutput('stderr', attached?.stderr));
  attached.stdin.on('error', () => {
    inputClosed = true;
  });
  attached.once('error', () => {
    void completeFixedProbeCommand('stopped', 'The fixed probe command could not start.');
  });
  attached.once('close', (exitCode) => {
    void completeFixedProbeCommand('completed', undefined, exitCode);
  });
  if (fixedProbeDeadlineMs === undefined) {
    throw new Error('The fixed probe command deadline is unavailable.');
  }
  deadline = setTimeout(() => {
    void completeFixedProbeCommand('deadline');
  }, fixedProbeDeadlineMs);
  drainAllAvailableOutput();

  send({ protocol: fixedProbeProtocol, type: 'probe-started' });
}

async function startAssembly(message: AssemblyStartMessage): Promise<void> {
  if (lifecycleMode !== 'idle' || !isValidAssemblyStartMessage(message)) {
    throw new Error('The guardian received an invalid fixed managed assembly request.');
  }

  const state: AssemblyState = {
    bootId: message.bootId,
    ...(message.buildOutputDirectory === undefined
      ? {}
      : { buildOutputDirectory: message.buildOutputDirectory }),
    candidateId: message.candidateId,
    commitReceiptPath: message.commitReceiptPath,
    containerName: message.containerName,
    creationReceiptPath: message.creationReceiptPath,
    journalKey: Buffer.from(message.journalKey),
    materialDigest: message.materialDigest,
    ownerId: message.ownerId,
    packageDirectory: message.packageDirectory,
    packageDigest: message.packageDigest,
    platform: message.platform,
    purpose: message.purpose,
    resourceId: message.resourceId,
    sessionId: message.sessionId,
    sourceImage: message.sourceImage,
    templateDirectory: message.templateDirectory,
    terminalReceiptPath: message.terminalReceiptPath,
    commitStarted: false,
    commitSettled: false,
    copyStarted: false,
    copySettled: false,
    templateDirectories: [],
    templateRemoved: false,
    pendingRawWriters: new Set(),
  };
  assembly = state;
  containerName = state.containerName;
  lifecycleMode = 'assembly-creating';
  deadline = setTimeout(() => {
    void finish('deadline', 'The fixed managed assembly exceeded its admission deadline.');
  }, message.deadlineMs);

  await createAssemblyTemplate(state);
  await assertAssemblyStillActive();

  const created = await runAssemblyDocker(state, [
    'create',
    '--pull=never',
    '--name',
    state.containerName,
    '--label',
    `io.qdroid.assembly.owner=${state.ownerId}`,
    '--label',
    `io.qdroid.assembly.session=${state.sessionId}`,
    '--label',
    `io.qdroid.assembly.resource=${state.resourceId}`,
    '--label',
    `io.qdroid.assembly.candidate=${state.candidateId}`,
    '--label',
    `io.qdroid.assembly.purpose=${state.purpose}`,
    state.sourceImage,
  ]);
  if (
    !created.commandCompleted ||
    created.exitCode !== 0 ||
    !isContainerId(created.stdout.trim())
  ) {
    throw new Error('The guardian could not create the fixed managed assembly container.');
  }
  state.containerId = created.stdout.trim();
  ownedContainerId = state.containerId;

  const ownershipMatches = await assemblyContainerMatches(state, state.containerId);
  if (!ownershipMatches) {
    throw new Error('The guardian could not bind the managed assembly container identity.');
  }
  state.creationReceiptAuthenticationTag = await writeAssemblyCreationReceipt(state);
  await assertAssemblyStillActive();
  lifecycleMode = 'assembly-created';
  send({
    containerId: state.containerId,
    protocol: FIXED_ASSEMBLY_PROTOCOL,
    type: 'assembly-created',
  });
}

async function runAssemblyPhase(operation: () => Promise<void>): Promise<void> {
  if (assemblyPhaseWork !== undefined) {
    throw new Error('The managed assembly already has an unsettled writer phase.');
  }
  const phase = operation();
  assemblyPhaseWork = phase;
  try {
    await phase;
  } finally {
    if (assemblyPhaseWork === phase) {
      assemblyPhaseWork = undefined;
    }
  }
}

async function advanceAssembly(message: AssemblyAdvanceMessage): Promise<void> {
  if (!isValidAssemblyAdvanceMessage(message) || assembly === undefined) {
    throw new Error('The guardian received an invalid fixed managed assembly phase.');
  }

  if (message.type === 'assembly-copy') {
    if (lifecycleMode !== 'assembly-created') {
      throw new Error('The managed assembly copy phase is unavailable.');
    }
    await copyAssemblyMaterial(assembly);
    await assertAssemblyStillActive();
    lifecycleMode = 'assembly-copied';
    send({ protocol: FIXED_ASSEMBLY_PROTOCOL, type: 'assembly-copied' });
    return;
  }

  if (message.type === 'assembly-commit') {
    if (lifecycleMode !== 'assembly-copied') {
      throw new Error('The managed assembly commit phase is unavailable.');
    }
    const imageId = await commitAssemblyImage(assembly);
    const commitReceiptAuthenticationTag = assembly.commitReceiptAuthenticationTag;
    if (commitReceiptAuthenticationTag === undefined) {
      throw new Error('The managed assembly commit result is missing its durable receipt.');
    }
    await assertAssemblyStillActive();
    lifecycleMode = 'assembly-committed';
    send({
      commitReceiptAuthenticationTag,
      imageId,
      protocol: FIXED_ASSEMBLY_PROTOCOL,
      type: 'assembly-committed',
    });
    return;
  }

  if (lifecycleMode !== 'assembly-committed') {
    throw new Error('The managed assembly cleanup phase is unavailable.');
  }
  await cleanupFixedAssembly('completed');
}

async function createAssemblyTemplate(state: AssemblyState): Promise<void> {
  await mkdir(state.templateDirectory, { mode: 0o700 });
  await syncDirectory(dirname(state.templateDirectory));

  try {
    const packageRoot = join(
      state.templateDirectory,
      'opt',
      'qdroid',
      'packages',
      state.packageDigest,
    );
    const directories = [
      { entries: ['opt'], mode: 0o700, path: state.templateDirectory },
      { entries: ['qdroid'], mode: 0o755, path: join(state.templateDirectory, 'opt') },
      {
        entries: ['packages'],
        mode: 0o755,
        path: join(state.templateDirectory, 'opt', 'qdroid'),
      },
      {
        entries: [state.packageDigest],
        mode: 0o755,
        path: join(state.templateDirectory, 'opt', 'qdroid', 'packages'),
      },
      { entries: ['generated', 'source'], mode: 0o755, path: packageRoot },
      { entries: [], mode: 0o755, path: join(packageRoot, 'source') },
      { entries: [], mode: 0o755, path: join(packageRoot, 'generated') },
    ] as const;

    for (const directory of directories) {
      if (directory.path !== state.templateDirectory) {
        await mkdir(directory.path, { mode: 0o700 });
        await syncDirectory(dirname(directory.path));
      }
      await retainAssemblyTemplateDirectory(
        state,
        directory.path,
        directory.entries,
        directory.mode,
      );
      const retainedDirectory = state.templateDirectories.at(-1);
      if (retainedDirectory === undefined) {
        throw new Error('The managed assembly template directory was not retained.');
      }
      await retainedDirectory.file.sync();
    }
  } catch (error) {
    try {
      const removed = await removeAssemblyTemplate(state);
      if (!removed) {
        throw new Error('The managed assembly template could not be removed after setup failed.');
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Managed assembly template setup and cleanup both failed.',
      );
    }
    throw error;
  }
}

async function retainAssemblyTemplateDirectory(
  state: AssemblyState,
  path: string,
  entries: readonly string[],
  mode: number,
): Promise<void> {
  const file = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await file.chmod(mode);
    const status = await file.stat();
    if (!status.isDirectory() || (status.mode & 0o777) !== mode) {
      throw new Error('The fixed managed assembly template directory has an unexpected mode.');
    }
    state.templateDirectories.push(
      Object.freeze({ entries: Object.freeze([...entries]), file, mode, path }),
    );
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

async function copyAssemblyMaterial(state: AssemblyState): Promise<void> {
  if (state.containerId === undefined || state.templateDirectories.length === 0) {
    throw new Error('The fixed managed assembly lost its template or container identity.');
  }

  await assertAssemblyStillActive();
  lifecycleMode = 'assembly-copying';
  state.copyStarted = true;
  await assertPrivateAssemblyMaterialDirectory(
    state.packageDirectory,
    state.packageDigest,
    'content',
  );
  if (state.buildOutputDirectory !== undefined) {
    await assertPrivateAssemblyMaterialDirectory(
      state.buildOutputDirectory,
      state.packageDigest,
      'generated',
    );
  }

  await assertDockerAssemblySuccess(
    await runAssemblyDocker(state, [
      'cp',
      `${state.templateDirectory}/opt/.`,
      `${state.containerId}:/opt`,
    ]),
    'The guardian could not materialize the fixed managed assembly template.',
  );
  // A disconnected parent can still require cleanup of the completed copy,
  // but it cannot authorize template removal or any later source copy.
  await assertAssemblyStillActive();
  if (!(await removeAssemblyTemplate(state))) {
    throw new Error('The guardian could not confirm managed assembly template cleanup.');
  }

  const sourceTarget = `/opt/qdroid/packages/${state.packageDigest}/source`;
  await assertAssemblyStillActive();
  await assertDockerAssemblySuccess(
    await runAssemblyDocker(state, [
      'cp',
      `${state.packageDirectory}/.`,
      `${state.containerId}:${sourceTarget}`,
    ]),
    'The guardian could not copy frozen package material.',
  );
  if (state.buildOutputDirectory !== undefined) {
    const generatedTarget = `/opt/qdroid/packages/${state.packageDigest}/generated`;
    await assertAssemblyStillActive();
    await assertDockerAssemblySuccess(
      await runAssemblyDocker(state, [
        'cp',
        `${state.buildOutputDirectory}/.`,
        `${state.containerId}:${generatedTarget}`,
      ]),
      'The guardian could not copy frozen generated material.',
    );
  }
  await assertAssemblyStillActive();
  state.copySettled = true;
}

async function commitAssemblyImage(state: AssemblyState): Promise<string> {
  if (state.containerId === undefined) {
    throw new Error('The fixed managed assembly lost its exact container identity.');
  }

  await assertAssemblyStillActive();
  lifecycleMode = 'assembly-committing';
  state.commitStarted = true;
  const committed = await runAssemblyDocker(state, [
    'commit',
    '--pause=false',
    '--change',
    `LABEL io.qdroid.assembly.material=${state.materialDigest}`,
    '--change',
    `LABEL io.qdroid.assembly.package=${state.packageDigest}`,
    '--change',
    `LABEL io.qdroid.assembly.purpose=${state.purpose}`,
    '--change',
    `LABEL io.qdroid.assembly.source=${state.sourceImage}`,
    '--change',
    `LABEL io.qdroid.assembly.platform=${state.platform}`,
    '--change',
    'LABEL io.qdroid.assembly.owner=',
    '--change',
    'LABEL io.qdroid.assembly.session=',
    '--change',
    'LABEL io.qdroid.assembly.resource=',
    '--change',
    'LABEL io.qdroid.assembly.candidate=',
    state.containerId,
  ]);
  if (!committed.commandCompleted || committed.exitCode !== 0) {
    throw new Error('The guardian could not commit the fixed managed assembly image.');
  }
  const imageId = canonicalImageId(committed.stdout) ?? canonicalImageId(committed.stderr);
  if (imageId === undefined) {
    throw new Error('The guardian did not return an immutable managed assembly image ID.');
  }
  // Docker has already committed this immutable result. Record it before any
  // inspection, IPC response, or cleanup decision so a later failure cannot
  // erase the only observed result or authorize a second commit.
  state.imageId = imageId;
  state.commitReceiptAuthenticationTag = await writeAssemblyCommitReceipt(state, imageId);

  await assertAssemblyStillActive();
  const inspected = await runAssemblyDocker(state, [
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    imageId,
  ]);
  if (
    !inspected.commandCompleted ||
    inspected.exitCode !== 0 ||
    inspected.stdout.trim() !== imageId
  ) {
    throw new Error('The guardian could not inspect its committed managed assembly image.');
  }
  state.commitSettled = true;
  return imageId;
}

async function assertAssemblyStillActive(): Promise<void> {
  if (disconnectRequested || finished) {
    throw new Error('The managed assembly parent disconnected before the phase settled.');
  }
}

async function assertPrivateAssemblyMaterialDirectory(
  path: string,
  packageDigest: string,
  kind: 'content' | 'generated',
): Promise<void> {
  const status = await lstat(path);
  const expectedSuffix =
    kind === 'content'
      ? `/content/${packageDigest}`
      : new RegExp(`/generated/${packageDigest}/[a-f0-9]{64}$`);
  const suffixMatches =
    typeof expectedSuffix === 'string' ? path.endsWith(expectedSuffix) : expectedSuffix.test(path);
  if (
    !suffixMatches ||
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    (status.mode & 0o022) !== 0
  ) {
    throw new Error('The managed assembly material directory is not a frozen trusted tree.');
  }
}

async function assemblyContainerMatches(
  state: AssemblyState,
  containerId: string,
): Promise<boolean> {
  const inspected = await runAssemblyDocker(state, [
    'inspect',
    '--format',
    '{{.Id}} {{.Image}} {{index .Config.Labels "io.qdroid.assembly.owner"}} {{index .Config.Labels "io.qdroid.assembly.session"}} {{index .Config.Labels "io.qdroid.assembly.resource"}} {{index .Config.Labels "io.qdroid.assembly.candidate"}} {{index .Config.Labels "io.qdroid.assembly.purpose"}}',
    state.containerName,
  ]);
  if (!inspected.commandCompleted || inspected.exitCode !== 0) {
    return false;
  }
  const [id, image, owner, session, resource, candidate, purpose] = inspected.stdout
    .trim()
    .split(' ');
  return (
    id === containerId &&
    image === state.sourceImage &&
    owner === state.ownerId &&
    session === state.sessionId &&
    resource === state.resourceId &&
    candidate === state.candidateId &&
    purpose === state.purpose
  );
}

async function removeAssemblyTemplate(state: AssemblyState): Promise<boolean> {
  if (state.templateRemoved) {
    return true;
  }
  if (state.templateDirectories.length === 0) {
    return false;
  }
  if (!(await assemblyTemplateTreeMatches(state))) {
    return false;
  }

  for (const directory of [...state.templateDirectories].reverse()) {
    const current = await lstat(directory.path).catch(() => undefined);
    const held = await directory.file.stat().catch(() => undefined);
    if (
      current === undefined ||
      held === undefined ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !held.isDirectory() ||
      current.dev !== held.dev ||
      current.ino !== held.ino ||
      (held.mode & 0o777) !== directory.mode
    ) {
      return false;
    }
    await rmdir(directory.path);
    await syncDirectory(dirname(directory.path));
    await directory.file.close();
    state.templateDirectories.splice(state.templateDirectories.indexOf(directory), 1);
  }

  state.templateRemoved = true;
  return true;
}

async function assemblyTemplateTreeMatches(state: AssemblyState): Promise<boolean> {
  for (const directory of state.templateDirectories) {
    const [held, current, entries] = await Promise.all([
      directory.file.stat().catch(() => undefined),
      lstat(directory.path).catch(() => undefined),
      readdir(directory.path, { withFileTypes: true }).catch(() => undefined),
    ]);
    if (
      held === undefined ||
      current === undefined ||
      entries === undefined ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !held.isDirectory() ||
      current.dev !== held.dev ||
      current.ino !== held.ino ||
      (held.mode & 0o777) !== directory.mode
    ) {
      return false;
    }
    const expectedEntries = [...directory.entries].sort();
    const actualEntries = entries.map((entry) => entry.name).sort();
    if (
      actualEntries.length !== expectedEntries.length ||
      actualEntries.some((entry, index) => entry !== expectedEntries[index]) ||
      entries.some((entry) => entry.isSymbolicLink() || !entry.isDirectory())
    ) {
      return false;
    }
  }
  return true;
}

async function cleanupFixedAssembly(reason: StopReason, errorMessage?: string): Promise<void> {
  if (assemblyCleanup !== undefined) {
    return assemblyCleanup;
  }

  assemblyCleanup = (async () => {
    const state = assembly;
    finished = true;
    lifecycleMode = 'assembly-cleanup';
    stopReason = reason;
    if (deadline !== undefined) {
      clearTimeout(deadline);
      deadline = undefined;
    }

    const failures: unknown[] = [];
    let containerRemoved = state?.containerId === undefined;
    let templateRemoved = state === undefined || state.templateRemoved;
    const writerSettlementTimedOut =
      state !== undefined && !(await waitForAssemblyRawWriters(state));
    const missingCreationReceipt =
      state !== undefined && state.creationReceiptAuthenticationTag === undefined;
    const missingCommitReceipt =
      state !== undefined &&
      state.commitStarted &&
      state.commitReceiptAuthenticationTag === undefined;
    if (missingCreationReceipt) {
      failures.push(
        new Error(
          'The managed assembly create result has no durable keeper-authenticated receipt.',
        ),
      );
    } else if (missingCommitReceipt) {
      failures.push(
        new Error(
          'The managed assembly commit result has no durable keeper-authenticated receipt.',
        ),
      );
    } else if (writerSettlementTimedOut) {
      failures.push(
        new Error(
          'A managed assembly Docker writer did not close after its bounded termination deadline.',
        ),
      );
      // Keep the original directory descriptors and pathname evidence until
      // the real raw writers report close. Their eventual close only releases
      // this keeper's retained descriptor; it never authorizes a late delete.
      retainAssemblyRawWriterExclusion(state);
    } else if (state !== undefined && state.containerId !== undefined) {
      try {
        containerRemoved = await removeAssemblyContainer(state);
      } catch (error) {
        failures.push(error);
      }
    }
    if (
      !missingCreationReceipt &&
      !missingCommitReceipt &&
      !writerSettlementTimedOut &&
      state !== undefined &&
      !state.templateRemoved
    ) {
      try {
        templateRemoved = await removeAssemblyTemplate(state);
      } catch (error) {
        failures.push(error);
      }
    }

    let terminalWritten = false;
    const terminalErrors = [
      ...(errorMessage === undefined ? [] : [errorMessage]),
      ...failures.map((error) => (error instanceof Error ? error.message : String(error))),
    ];
    if (state !== undefined) {
      try {
        await writeAssemblyTerminalReceipt(
          state,
          {
            containerRemoved,
            templateRemoved,
          },
          terminalErrors,
        );
        terminalWritten = true;
      } catch (error) {
        failures.push(error);
      }
    }
    const cleanupConfirmed =
      state !== undefined &&
      containerRemoved &&
      templateRemoved &&
      !missingCommitReceipt &&
      terminalWritten &&
      failures.length === 0;
    const detail = [
      ...(errorMessage === undefined ? [] : [errorMessage]),
      ...failures.map((error) => (error instanceof Error ? error.message : String(error))),
    ].join(' ');
    sendCompletion(cleanupConfirmed, null, detail === '' ? undefined : detail);
  })();
  return assemblyCleanup;
}

async function removeAssemblyContainer(state: AssemblyState): Promise<boolean> {
  if (
    state.containerId === undefined ||
    !(await assemblyContainerMatches(state, state.containerId))
  ) {
    return false;
  }
  const removed = await runAssemblyDocker(state, ['rm', '--force', state.containerId]);
  if (!removed.commandCompleted || removed.exitCode !== 0) {
    return false;
  }
  const absent = await runAssemblyDocker(state, [
    'inspect',
    '--format',
    '{{.Id}}',
    state.containerName,
  ]);
  return absent.commandCompleted && isExactContainerAbsence(absent, state.containerName);
}

async function writeAssemblyCreationReceipt(state: AssemblyState): Promise<string> {
  if (state.containerId === undefined) {
    throw new Error('The managed assembly has no container ID to authenticate.');
  }
  const processStart = await readProcessStart(process.pid);
  const payload = {
    bootId: state.bootId,
    container: {
      id: state.containerId,
      name: state.containerName,
      sourceImage: state.sourceImage,
    },
    keeper: { groupId: process.pid, pid: process.pid, processStart },
    labels: {
      candidateId: state.candidateId,
      ownerId: state.ownerId,
      purpose: state.purpose,
      resourceId: state.resourceId,
      sessionId: state.sessionId,
    },
    resourceId: state.resourceId,
    schema: 'qdroid.assembly-keeper-create/v1',
    sessionId: state.sessionId,
    version: 1,
  };
  const authenticationTag = createHmac('sha256', state.journalKey)
    .update(JSON.stringify(payload))
    .digest('hex');
  const receipt = Buffer.from(`${JSON.stringify({ ...payload, authenticationTag })}\n`, 'utf8');
  await writePrivateAssemblyReceipt(state.creationReceiptPath, receipt);
  return authenticationTag;
}

async function writeAssemblyCommitReceipt(state: AssemblyState, imageId: string): Promise<string> {
  if (state.containerId === undefined || state.creationReceiptAuthenticationTag === undefined) {
    throw new Error('The managed assembly commit has no authenticated create result.');
  }

  const processStart = await readProcessStart(process.pid);
  const keeper = { groupId: process.pid, pid: process.pid, processStart };
  const payload = {
    bootId: state.bootId,
    container: {
      id: state.containerId,
      name: state.containerName,
      sourceImage: state.sourceImage,
    },
    creationReceipt: {
      authenticationTag: state.creationReceiptAuthenticationTag,
      path: state.creationReceiptPath,
    },
    imageId,
    keeper,
    labels: {
      candidateId: state.candidateId,
      ownerId: state.ownerId,
      purpose: state.purpose,
      resourceId: state.resourceId,
      sessionId: state.sessionId,
    },
    ownerId: state.ownerId,
    resourceId: state.resourceId,
    schema: 'qdroid.assembly-keeper-commit/v1',
    sessionId: state.sessionId,
    version: 1,
  };
  const authenticationTag = createHmac('sha256', state.journalKey)
    .update(JSON.stringify(payload))
    .digest('hex');
  const receipt = Buffer.from(`${JSON.stringify({ ...payload, authenticationTag })}\n`, 'utf8');
  await writePrivateAssemblyReceipt(state.commitReceiptPath, receipt);
  return authenticationTag;
}

async function writeAssemblyTerminalReceipt(
  state: AssemblyState,
  cleanup: Readonly<{ containerRemoved: boolean; templateRemoved: boolean }>,
  errors: readonly string[],
): Promise<void> {
  const processStart = await readProcessStart(process.pid);
  const keeper = { groupId: process.pid, pid: process.pid, processStart };
  const payload = {
    bootId: state.bootId,
    cleanup,
    commitReceipt: {
      authenticationTag: state.commitReceiptAuthenticationTag ?? null,
      path: state.commitReceiptPath,
    },
    creationReceipt: {
      authenticationTag: state.creationReceiptAuthenticationTag ?? null,
      path: state.creationReceiptPath,
    },
    dependencies: {
      commit: {
        containerId: state.containerId ?? null,
        resourceId: state.resourceId,
        settled: state.commitStarted ? state.commitSettled : null,
        writer: keeper,
      },
      copy: {
        containerId: state.containerId ?? null,
        resourceId: state.resourceId,
        settled: state.copyStarted ? state.copySettled : null,
        writer: keeper,
      },
    },
    errors: [...errors],
    imageId: state.imageId ?? null,
    keeper,
    ownerId: state.ownerId,
    resourceId: state.resourceId,
    schema: 'qdroid.assembly-keeper-terminal/v1',
    sessionId: state.sessionId,
    version: 1,
  };
  const authenticationTag = createHmac('sha256', state.journalKey)
    .update(JSON.stringify(payload))
    .digest('hex');
  const receipt = Buffer.from(`${JSON.stringify({ ...payload, authenticationTag })}\n`, 'utf8');
  await writePrivateAssemblyReceipt(state.terminalReceiptPath, receipt);
}

async function writePrivateAssemblyReceipt(path: string, receipt: Buffer): Promise<void> {
  const file = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  const failures: unknown[] = [];
  try {
    await file.writeFile(receipt);
  } catch (error) {
    failures.push(error);
  }
  try {
    await file.sync();
  } catch (error) {
    failures.push(error);
  }
  try {
    await file.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await syncDirectory(dirname(path));
  } catch (error) {
    failures.push(error);
  }
  throwAssemblyFailures(failures, 'Managed assembly receipt persistence failed.');
}

async function readProcessStart(pid: number): Promise<string> {
  const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  const closeParenthesis = contents.lastIndexOf(')');
  const start = contents.slice(closeParenthesis + 2).split(' ')[19];
  if (closeParenthesis < 0 || start === undefined || !/^\d+$/.test(start)) {
    throw new Error('The assembly keeper process identity is invalid.');
  }
  return start;
}

function canonicalImageId(value: string): string | undefined {
  const match = value.trim().match(/sha256:[a-f0-9]{64}/i);
  return match?.[0]?.toLowerCase();
}

async function assertDockerAssemblySuccess(
  result: { commandCompleted: boolean; exitCode: number },
  message: string,
): Promise<void> {
  if (!result.commandCompleted || result.exitCode !== 0) {
    throw new Error(message);
  }
}

async function runAssemblyDocker(
  state: AssemblyState,
  argumentsValue: string[],
): Promise<DockerCommandResult> {
  const result = await runDocker(argumentsValue);
  if (!result.rawWriterSettled) {
    const rawWriter = result.rawWriterClosed;
    state.pendingRawWriters.add(rawWriter);
    void rawWriter.then(
      () => state.pendingRawWriters.delete(rawWriter),
      () => state.pendingRawWriters.delete(rawWriter),
    );
  }
  return result;
}

async function waitForAssemblyRawWriters(state: AssemblyState): Promise<boolean> {
  if (state.pendingRawWriters.size === 0) {
    return true;
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.all([...state.pendingRawWriters]).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), RAW_WRITER_SETTLEMENT_WAIT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function retainAssemblyRawWriterExclusion(state: AssemblyState): void {
  const pendingWriters = [...state.pendingRawWriters];
  if (pendingWriters.length === 0) {
    return;
  }
  const retained = setInterval(() => undefined, 1_000);
  void Promise.all(pendingWriters).then(
    () => clearInterval(retained),
    () => clearInterval(retained),
  );
}

function fixedProbeDefinition(
  intent: ProbeIntentMessage | BoundaryProbeIntentMessage,
  ownership: OwnedContainerMessage,
):
  | {
      readonly createArguments: readonly string[];
      readonly workloadArguments: readonly string[];
    }
  | undefined {
  const createArguments = fixedProbeProfileArguments(ownership);
  if (intent.kind === 'legacy-fixed-configuration') {
    return { createArguments, workloadArguments: [] };
  }

  if (intent.kind === 'legacy-fixed-filesystem') {
    return {
      createArguments: [...createArguments, '--entrypoint', '/usr/local/bin/node'],
      workloadArguments: [
        '/opt/qdroid/probe.mjs',
        'filesystem',
        intent.paths.canary,
        intent.paths.secret,
        intent.paths.store,
      ],
    };
  }

  if (intent.kind === 'profile-fixed-program') {
    const program =
      intent.selector === 'io'
        ? (['-e', PROFILE_IO_PROBE_SOURCE] as const)
        : fixedProfileProgram(intent.selector);
    if (program === undefined || (intent.selector === 'io' && intent.sourcePath === undefined)) {
      return undefined;
    }
    const fixtureMount =
      intent.selector === 'io'
        ? ['--mount', `type=bind,src=${intent.sourcePath},dst=/opt/qdroid/io-probe.bin,readonly`]
        : [];
    return {
      createArguments: [
        ...fixedProfileTupleArguments(ownership, intent.profileId),
        ...fixtureMount,
        '--entrypoint',
        '/usr/local/bin/node',
      ],
      workloadArguments: program,
    };
  }

  if (intent.kind === 'profile-boundary-program') {
    return {
      createArguments: [
        ...fixedProfileTupleArguments(ownership, intent.profileId),
        '--entrypoint',
        '/usr/local/bin/node',
      ],
      workloadArguments: fixedBoundaryProbeProgram(intent),
    };
  }

  const program = fixedProbeProgramArguments(intent.program);
  if (program === undefined) {
    return undefined;
  }

  return {
    createArguments: [...createArguments, ...program.entrypointArguments],
    workloadArguments: program.workloadArguments,
  };
}

function fixedBoundaryProbeProgram(intent: BoundaryProbeIntentMessage): readonly ['-e', string] {
  const hostFacts = JSON.stringify({
    childPid: intent.childPid,
    crossAppPath: intent.crossAppPath,
    trustedStorePath: intent.trustedStorePath,
  });
  return [
    '-e',
    [
      "const fs = require('fs');",
      `const hostFacts = ${hostFacts};`,
      'const readFails = (path) => { try { fs.readFileSync(path); return false; } catch { return true; } };',
      'const openFails = (path) => { try { const fd = fs.openSync(path, "r"); fs.closeSync(fd); return false; } catch { return true; } };',
      'process.stdout.write(JSON.stringify({',
      'crossAppUnreadable: readFails(hostFacts.crossAppPath),',
      'trustedStoreUnreadable: readFails(hostFacts.trustedStorePath),',
      'hostProcessSecretUnreadable: readFails(`/proc/${hostFacts.childPid}/environ`),',
      'hostPidHidden: !fs.existsSync(`/proc/${hostFacts.childPid}`),',
      "controlledDeviceUnreadable: openFails('/dev/vdb'),",
      "dockerSocketUnreadable: openFails('/var/run/docker.sock')",
      '}));',
    ].join(' '),
  ];
}

function fixedProbeProfileArguments(ownership: OwnedContainerMessage): readonly string[] {
  return [
    '--runtime',
    'qdroid-runsc',
    '--network',
    'none',
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
    '512m',
    '--memory-swap',
    '512m',
    '--cpus',
    '0.5',
    '--pids-limit',
    '256',
    '--ulimit',
    'nproc=32:32',
    '--ulimit',
    'core=0:0',
    '--device-read-bps',
    '/dev/vdb:1048576',
    '--device-write-bps',
    '/dev/vdb:1048576',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--label',
    `io.qdroid.owner=${ownership.labels['io.qdroid.owner']}`,
    '--label',
    `io.qdroid.profile=${ownership.labels['io.qdroid.profile']}`,
    '--label',
    `io.qdroid.session=${ownership.labels['io.qdroid.session']}`,
  ];
}

function fixedProfileTupleArguments(
  ownership: OwnedContainerMessage,
  profileId: SandboxProfileId,
): readonly string[] {
  const profile = SANDBOX_PROFILE_CATALOG[profileId];
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
    '--shm-size',
    `${profile.limits.sharedMemoryMiB}m`,
    '--workdir',
    '/tmp',
    '--label',
    `io.qdroid.owner=${ownership.labels['io.qdroid.owner']}`,
    '--label',
    `io.qdroid.profile=${ownership.labels['io.qdroid.profile']}`,
    '--label',
    `io.qdroid.session=${ownership.labels['io.qdroid.session']}`,
  ];
}

function fixedProbeProgramArguments(program: ProbeProgramMessage):
  | {
      readonly entrypointArguments: readonly string[];
      readonly workloadArguments: readonly string[];
    }
  | undefined {
  switch (program) {
    case 'scratch-write':
      return fixedNodeProbeArguments(['scratch-write', 'isolation-marker']);
    case 'scratch-read':
      return fixedNodeProbeArguments(['scratch-read', 'isolation-marker']);
    case 'pids':
      return fixedNodeProbeArguments(['pids']);
    case 'scratch-limit':
      return fixedNodeProbeArguments(['scratch-enospc']);
    case 'memory':
      return fixedNodeProbeArguments(['memory']);
    case 'output-limit':
      return { entrypointArguments: [], workloadArguments: ['spam-output'] };
    case 'descendants':
      return { entrypointArguments: [], workloadArguments: ['hold-child'] };
  }
}

function fixedNodeProbeArguments(programArguments: readonly string[]): {
  readonly entrypointArguments: readonly string[];
  readonly workloadArguments: readonly string[];
} {
  return {
    entrypointArguments: ['--entrypoint', '/usr/local/bin/node'],
    workloadArguments: ['/opt/qdroid/probe.mjs', ...programArguments],
  };
}

async function inspectOwnedProbeBinding(
  name: string,
  ownership: OwnedContainerMessage,
  expectedContainerId: string,
): Promise<ProbeBindingMessage | undefined> {
  const inspected = await runDocker(['inspect', name]);
  const container = parseSingleDockerObject(inspected);
  if (container === undefined || !matchesOwnedProbe(container, ownership, expectedContainerId)) {
    return undefined;
  }

  return probeBindingFromContainer(container);
}

/**
 * The fixed-probe start acknowledgement records responsibility for the
 * attached Docker command. Docker may still report an owned container as
 * `created` while that command starts it. Only a live-cgroup inspection needs
 * a host PID, so it performs this bounded exact-identity wait immediately
 * before it reads cgroup files.
 */
async function waitForLiveFixedProbe(
  expectedContainerId: string,
  ownership: OwnedContainerMessage | undefined,
  deadlineAt: number,
): Promise<LiveFixedProbeObservation> {
  if (containerName === undefined || ownership === undefined) {
    throw new Error('The fixed probe ownership binding is unavailable during live inspection.');
  }

  while (true) {
    const observation = await inspectLiveFixedProbe(expectedContainerId, ownership, deadlineAt);
    if (observation !== undefined) {
      return observation;
    }

    await waitForFixedProbeStartPoll();
    assertLiveFixedProbeObservationIsCurrent(deadlineAt);
  }
}

interface LiveFixedProbeObservation {
  readonly binding: ProbeBindingMessage;
  readonly container: Record<string, unknown>;
  readonly processId: number;
}

/**
 * Observes one exact owned container at one instant. The checks on both sides
 * of Docker inspection prevent an in-flight result from becoming a successful
 * cgroup capability after cancellation, terminal command completion, or the
 * bounded observation deadline.
 */
async function inspectLiveFixedProbe(
  expectedContainerId: string,
  ownership: OwnedContainerMessage,
  deadlineAt: number,
): Promise<LiveFixedProbeObservation | undefined> {
  if (containerName === undefined) {
    throw new Error('The fixed probe ownership binding is unavailable during live inspection.');
  }
  assertLiveFixedProbeObservationIsCurrent(deadlineAt);

  const inspected = await runDocker(['inspect', containerName]);
  assertLiveFixedProbeObservationIsCurrent(deadlineAt);

  const container = parseSingleDockerObject(inspected);
  if (container === undefined || !matchesOwnedProbe(container, ownership, expectedContainerId)) {
    throw new Error('The fixed probe identity no longer matches its trusted record.');
  }

  const state = isRecord(container.State) ? container.State : undefined;
  if (state?.Running === true && isPositiveInteger(state.Pid)) {
    const binding = probeBindingFromContainer(container);
    if (binding === undefined) {
      throw new Error('The fixed probe did not expose an exact container identity.');
    }
    assertLiveFixedProbeObservationIsCurrent(deadlineAt);
    return { binding, container, processId: state.Pid };
  }

  if (!isPendingLiveFixedProbeState(state)) {
    throw new Error('The fixed probe exited before live cgroup inspection became available.');
  }

  assertLiveFixedProbeObservationIsCurrent(deadlineAt);
  return undefined;
}

function assertLiveFixedProbeObservationIsCurrent(deadlineAt: number): void {
  if (probeCommandTerminal !== undefined || lifecycleMode !== 'probe-running') {
    throw new Error('The fixed probe stopped before live cgroup inspection became available.');
  }
  if (Date.now() >= deadlineAt) {
    throw new Error('The fixed probe did not expose a live container process in time.');
  }
}

function waitForFixedProbeStartPoll(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, FIXED_PROBE_START_POLL_MS);
  });
}

function isPendingLiveFixedProbeState(state: Record<string, unknown> | undefined): boolean {
  if (state === undefined) {
    return false;
  }

  const status = state.Status;
  if (status === 'created' || status === 'restarting') {
    return state.Running !== true;
  }

  // Docker has accepted the start but has not yet published the host PID.
  // This remains pending only while it explicitly reports a running state.
  return status === 'running' && state.Running === true && !isPositiveInteger(state.Pid);
}

async function inspectProbe(
  query: ProbeInspectMessage['query'],
  name: string,
  expectedContainerId: string,
  intent: ProbeIntentMessage | BoundaryProbeIntentMessage,
  ownership: OwnedContainerMessage | undefined,
): Promise<ProbeInspectionMessage> {
  if (ownership === undefined) {
    throw new Error('The fixed probe ownership binding is unavailable.');
  }

  if (query === 'live-cgroup') {
    if (intent.kind !== 'profile-fixed-program' && intent.kind !== 'profile-boundary-program') {
      throw new Error('The fixed probe does not authorize a live cgroup inspection.');
    }
    const deadlineAt = Date.now() + FIXED_PROBE_START_READY_WAIT_MS;
    const observation = await waitForLiveFixedProbe(expectedContainerId, ownership, deadlineAt);
    const cgroup = await readOwnedProbeCgroup(
      observation.container,
      observation.binding.containerId,
    );
    const confirmation = await inspectLiveFixedProbe(expectedContainerId, ownership, deadlineAt);
    if (
      confirmation === undefined ||
      confirmation.binding.containerId !== observation.binding.containerId ||
      confirmation.processId !== observation.processId
    ) {
      throw new Error(
        'The fixed probe changed before its live cgroup observation could be returned.',
      );
    }
    return {
      binding: observation.binding,
      cgroup,
      kind: 'live-cgroup',
    };
  }

  const inspected = await runDocker(['inspect', name]);
  const container = parseSingleDockerObject(inspected);
  if (container === undefined || !matchesOwnedProbe(container, ownership, expectedContainerId)) {
    throw new Error('The fixed probe identity no longer matches its trusted record.');
  }

  const binding = probeBindingFromContainer(container);
  if (binding === undefined) {
    throw new Error('The fixed probe did not expose an exact container identity.');
  }

  if (query === 'configuration') {
    return {
      binding,
      fixedProfileVerified:
        intent.kind === 'profile-fixed-program'
          ? matchesFixedProfileTuple(container, intent.profileId, intent.sourcePath)
          : intent.kind === 'profile-boundary-program'
            ? matchesFixedBoundaryProfileTuple(container, intent)
            : matchesFixedLegacyProfile(container),
      kind: 'configuration',
    };
  }

  if (query === 'guest-descendants') {
    if (intent.kind !== 'legacy-fixed-program' || intent.program !== 'descendants') {
      throw new Error('The fixed probe does not authorize a descendant inspection.');
    }
    return {
      binding,
      kind: 'guest-descendants',
      observation: await observeOwnedProbeDescendants(name),
    };
  }

  const state = isRecord(container.State) ? container.State : undefined;
  const running = state?.Running;
  const status = state?.Status;
  const exitCode = state?.ExitCode;
  const oomKilled = state?.OOMKilled;
  const parsedExitCode =
    typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? exitCode : null;
  return {
    binding,
    exitCode: parsedExitCode,
    kind: 'container-state',
    oomKilled: oomKilled === true,
    state:
      status === 'created'
        ? 'created'
        : running === true
          ? 'running'
          : running === false
            ? 'exited'
            : 'unknown',
  };
}

async function readOwnedProbeCgroup(
  container: Record<string, unknown>,
  containerId: string,
): Promise<ProbeCgroupSnapshotMessage> {
  const state = isRecord(container.State) ? container.State : undefined;
  const processId = state?.Pid;
  if (state?.Running !== true || !isPositiveInteger(processId)) {
    throw new Error('The fixed probe does not have a live container process.');
  }

  const [processStart, cgroupPath] = await Promise.all([
    readProbeProcessStart(processId),
    readOwnedCgroupPath(processId),
  ]);
  const cgroupDirectory = join('/sys/fs/cgroup', cgroupPath);
  const [
    cpuMaximum,
    cpuStatistics,
    ioMaximum,
    ioStatistics,
    memoryCurrent,
    memoryMaximum,
    pidsCurrent,
    pidsMaximum,
  ] = await Promise.all([
    readFile(join(cgroupDirectory, 'cpu.max'), 'utf8'),
    readFile(join(cgroupDirectory, 'cpu.stat'), 'utf8'),
    readFile(join(cgroupDirectory, 'io.max'), 'utf8'),
    readFile(join(cgroupDirectory, 'io.stat'), 'utf8'),
    readFile(join(cgroupDirectory, 'memory.current'), 'utf8'),
    readFile(join(cgroupDirectory, 'memory.max'), 'utf8'),
    readFile(join(cgroupDirectory, 'pids.current'), 'utf8'),
    readFile(join(cgroupDirectory, 'pids.max'), 'utf8'),
  ]);

  const [quotaMicros, periodMicros] = parseCgroupCpuMaximum(cpuMaximum);
  const cpuCounters = parseCgroupCpuStatistics(cpuStatistics);
  const ioMaximumFields = parseCgroupDeviceFields(ioMaximum, 'io.max', true);
  const ioStatisticsFields = parseCgroupDeviceFields(ioStatistics, 'io.stat', false);
  const readBytes =
    ioStatisticsFields.rbytes === undefined
      ? 0
      : parseCgroupUnsigned(ioStatisticsFields.rbytes, 'io.stat rbytes');
  const identityKey = createHmac('sha256', probeCgroupIdentityKey)
    .update(`${containerId}\n${processId}\n${processStart}\n${cgroupPath}`)
    .digest('hex');

  return {
    cpu: {
      counters: cpuCounters,
      periodMicros,
      quotaMicros,
    },
    identity: { key: identityKey, processId, processStart },
    io: {
      deviceMajorMinor: '253:16',
      counters: {
        readBytes,
        readBytesPerSecond: parseCgroupUnsigned(ioMaximumFields.rbps, 'io.max rbps'),
        writeBytesPerSecond: parseCgroupUnsigned(ioMaximumFields.wbps, 'io.max wbps'),
      },
    },
    memoryCurrentBytes: parseCgroupUnsigned(memoryCurrent.trim(), 'memory.current'),
    memoryMaximumBytes: parseCgroupUnsigned(memoryMaximum.trim(), 'memory.max'),
    pidsCurrent: parseCgroupUnsigned(pidsCurrent.trim(), 'pids.current'),
    pidsMaximum: parseCgroupUnsigned(pidsMaximum.trim(), 'pids.max'),
  };
}

async function observeOwnedProbeDescendants(
  name: string,
): Promise<ProbeDescendantObservationMessage> {
  const observed = await runDocker([
    'exec',
    '--user',
    '65532:65532',
    name,
    '/usr/local/bin/node',
    '/opt/qdroid/probe.mjs',
    'process-table',
  ]);
  if (!observed.commandCompleted || observed.rawWriterSettled !== true) {
    throw new Error('The fixed descendant observer did not settle.');
  }
  if (observed.exitCode !== 0) {
    return {
      attempts: 1,
      observedChild: null,
      observerCommandExitCode: observed.exitCode,
      observerExcluded: false,
      observerPid: null,
      processes: [],
    };
  }

  const observation = parseGuestProcessObservation(observed.stdout);
  const observedChild = observation.processes.find(
    (entry) => entry.pid > 1 && entry.ppid === 1 && entry.pid !== observation.observerPid,
  );
  return {
    attempts: 1,
    observedChild: observedChild ?? null,
    observerCommandExitCode: observed.exitCode,
    observerExcluded: true,
    observerPid: observation.observerPid,
    processes: observation.processes,
  };
}

async function readOwnedCgroupPath(processId: number): Promise<string> {
  const contents = await readFile(`/proc/${processId}/cgroup`, 'utf8');
  const line = contents.split('\n').find((candidate) => candidate.startsWith('0::'));
  const path = line?.slice('0::'.length);
  if (
    path === undefined ||
    !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]*$/.test(path) ||
    path.includes('..') ||
    path.includes('\\')
  ) {
    throw new Error('The fixed probe cgroup path is invalid.');
  }
  return path.slice(1);
}

async function readProbeProcessStart(processId: number): Promise<string> {
  const contents = await readFile(`/proc/${processId}/stat`, 'utf8');
  const closeParenthesis = contents.lastIndexOf(')');
  const start = contents.slice(closeParenthesis + 2).split(' ')[19];
  if (closeParenthesis < 0 || start === undefined || !/^\d+$/.test(start)) {
    throw new Error('The fixed probe process identity is invalid.');
  }
  return start;
}

function parseCgroupCpuMaximum(contents: string): readonly [number, number] {
  const [quota, period, extra] = contents.trim().split(/\s+/);
  if (quota === undefined || period === undefined || extra !== undefined) {
    throw new Error('The fixed probe cpu.max value is invalid.');
  }
  return [
    parseCgroupUnsigned(quota, 'cpu.max quota'),
    parseCgroupUnsigned(period, 'cpu.max period'),
  ];
}

function parseCgroupCpuStatistics(contents: string): {
  nrPeriods: number;
  nrThrottled: number;
  usageMicros: number;
} {
  const values = new Map<string, number>();
  for (const line of contents.trim().split('\n')) {
    const [name, value, extra] = line.trim().split(/\s+/);
    if (name === undefined || value === undefined || extra !== undefined || values.has(name)) {
      throw new Error('The fixed probe cpu.stat value is invalid.');
    }
    values.set(name, parseCgroupUnsigned(value, `cpu.stat ${name}`));
  }
  const usageMicros = values.get('usage_usec');
  const nrPeriods = values.get('nr_periods');
  const nrThrottled = values.get('nr_throttled');
  if (usageMicros === undefined || nrPeriods === undefined || nrThrottled === undefined) {
    throw new Error('The fixed probe cpu.stat value is incomplete.');
  }
  return { nrPeriods, nrThrottled, usageMicros };
}

function parseCgroupDeviceFields(
  contents: string,
  source: 'io.max' | 'io.stat',
  required: boolean,
): Record<string, string> {
  const line = contents.split('\n').find((candidate) => candidate.startsWith('253:16 '));
  if (line === undefined) {
    if (!required) {
      return Object.create(null) as Record<string, string>;
    }
    throw new Error(`The fixed probe ${source} value omits the fixed I/O device.`);
  }

  const fields = Object.create(null) as Record<string, string>;
  for (const token of line.trim().split(/\s+/).slice(1)) {
    const separator = token.indexOf('=');
    const name = token.slice(0, separator);
    const value = token.slice(separator + 1);
    if (separator <= 0 || separator === token.length - 1 || Object.hasOwn(fields, name)) {
      throw new Error(`The fixed probe ${source} field is invalid.`);
    }
    fields[name] = value;
  }
  return fields;
}

function parseCgroupUnsigned(value: string | undefined, source: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`The fixed probe ${source} value is invalid.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`The fixed probe ${source} value is unsafe.`);
  }
  return parsed;
}

function parseGuestProcessObservation(stdout: string): {
  observerPid: number;
  processes: Array<{ pid: number; ppid: number }>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('The fixed descendant observer returned invalid JSON.');
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ['observerPid', 'processes'])) {
    throw new Error('The fixed descendant observer returned an invalid shape.');
  }
  if (
    !isPositiveInteger(parsed.observerPid) ||
    !Array.isArray(parsed.processes) ||
    parsed.processes.length > 256
  ) {
    throw new Error('The fixed descendant observer returned invalid process bounds.');
  }
  const processIds = new Set<number>();
  const processes = parsed.processes.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ['pid', 'ppid'])) {
      throw new Error('The fixed descendant observer returned an invalid process entry.');
    }
    if (
      !isPositiveInteger(entry.pid) ||
      !isNonNegativeInteger(entry.ppid) ||
      processIds.has(entry.pid)
    ) {
      throw new Error('The fixed descendant observer returned an invalid process table.');
    }
    processIds.add(entry.pid);
    return { pid: entry.pid, ppid: entry.ppid };
  });
  if (!processIds.has(parsed.observerPid)) {
    throw new Error('The fixed descendant observer did not include itself.');
  }
  return { observerPid: parsed.observerPid, processes };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function boundaryReceiptAuthenticationTag(
  domain: string,
  journalKey: Uint8Array,
  payload: unknown,
): string {
  return createHmac('sha256', Buffer.from(journalKey))
    .update(domain)
    .update('\0')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function timingSafeHexEqual(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) {
    return false;
  }
  const actualBytes = Buffer.from(actual, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
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

  let phaseError: string | undefined;
  if (boundaryProbeConfigurationPhase !== undefined) {
    boundaryProbeConfigurationSealed = true;
    try {
      await boundaryProbeConfigurationPhase;
    } catch (error) {
      phaseError = combineAssemblyErrors(phaseError, error);
    }
  }
  if (fixedProbeCreationPhase !== undefined) {
    fixedProbeCreationSealed = true;
    try {
      await fixedProbeCreationPhase;
    } catch (error) {
      phaseError = combineAssemblyErrors(phaseError, error);
    }
  }
  if (networkConstructionPhase !== undefined) {
    networkConstructionSealed = true;
    try {
      await networkConstructionPhase;
    } catch (error) {
      phaseError = combineAssemblyErrors(phaseError, error);
    }
  }
  errorMessage = combineAssemblyErrors(errorMessage, phaseError);

  if (isFixedProbeLifecycle(lifecycleMode)) {
    if (lifecycleMode === 'probe-running' && (reason === 'deadline' || reason === 'output-limit')) {
      await completeFixedProbeCommand(reason, errorMessage, reportedExitCode);
      return;
    }
    await cleanupFixedProbe(reason, errorMessage, reportedExitCode);
    return;
  }

  if (lifecycleMode === 'boundary-creating' || lifecycleMode === 'boundary-active') {
    await cleanupBoundaryControl(reason, errorMessage);
    return;
  }

  if (lifecycleMode === 'boundary-probe-configured') {
    await finishConfiguredBoundaryProbe(reason, errorMessage);
    return;
  }

  if (
    lifecycleMode === 'starting' &&
    fixedProbeCreationSealed &&
    boundaryProbeConfiguration !== undefined
  ) {
    if (ownedContainerId !== undefined) {
      lifecycleMode = 'probe-created';
      await cleanupFixedProbe(reason, errorMessage, reportedExitCode);
      return;
    }
    const rawWritersSettled = await waitForBoundaryRawWriters(boundaryProbeConfiguration);
    finished = true;
    sendCompletion(
      false,
      null,
      combineAssemblyErrors(
        errorMessage,
        rawWritersSettled
          ? 'The configured boundary probe creation was sealed before acknowledgement.'
          : 'The configured boundary probe writer did not settle after creation was sealed.',
      ),
    );
    return;
  }

  if (lifecycleMode === 'network-creating' || lifecycleMode === 'network-active') {
    await cleanupNetworkControl(reason, errorMessage);
    return;
  }

  if (isFixedAssemblyLifecycle(lifecycleMode)) {
    const phase = assemblyPhaseWork;
    finished = true;
    stopReason = reason;
    if (deadline !== undefined) {
      clearTimeout(deadline);
      deadline = undefined;
    }
    let phaseFailure: unknown;
    if (phase !== undefined) {
      try {
        await phase;
      } catch (error) {
        phaseFailure = error;
      }
    }
    await cleanupFixedAssembly(reason, combineAssemblyErrors(errorMessage, phaseFailure));
    return;
  }

  finished = true;
  stopReason = reason;
  if (deadline !== undefined) {
    clearTimeout(deadline);
  }
  closeInput(true);

  if (lifecycleMode === 'native') {
    if (reason !== 'completed') {
      await stopAttachedProcess();
      // A timeout or explicit cancellation does not prove the complete native
      // process group has settled. The durable resource record stays retained
      // for recovery instead of reporting a false cleanup confirmation.
      sendCompletion(false, reportedExitCode ?? null, errorMessage);
      return;
    }

    sendCompletion(true, reportedExitCode ?? null, errorMessage);
    return;
  }

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

async function finishConfiguredBoundaryProbe(
  _reason: StopReason,
  errorMessage: string | undefined,
): Promise<void> {
  const configured = boundaryProbeConfiguration;
  finished = true;
  if (configured === undefined || configured.createSubmitted || configured.authorizationRecorded) {
    sendCompletion(
      false,
      null,
      combineAssemblyErrors(
        errorMessage,
        'The configured boundary probe could have submitted Docker creation.',
      ),
    );
    return;
  }

  const message = configured.message;
  const payload = {
    configurationAuthenticationTag: configured.configurationAuthenticationTag,
    controlReceiptAuthenticationTag: message.controlReceiptAuthenticationTag,
    controlResourceId: message.controlResourceId,
    guardian: {
      groupId: message.guardianPid,
      pid: message.guardianPid,
      start: message.guardianStart,
    },
    ownerId: message.ownerId,
    resourceId: message.resourceId,
    schema: 'qdroid.boundary-probe-terminal/v1',
    sessionId: message.sessionId,
    status: 'no-create',
    version: 1,
  };
  const authenticationTag = boundaryReceiptAuthenticationTag(
    'qdroid.boundary-probe-terminal/v1',
    message.journalKey,
    payload,
  );
  try {
    await writeAtomicJson(message.terminalReceiptPath, { ...payload, authenticationTag });
    sendCompletion(true, null, errorMessage);
  } catch (error) {
    sendCompletion(false, null, combineAssemblyErrors(errorMessage, error));
  }
}

/**
 * Records a fixed executable command result without removing its container.
 * Qualification consumes this immutable result, then performs a separate
 * exact stop-and-remove operation after its inspections have completed.
 */
function completeFixedProbeCommand(
  reason: StopReason,
  errorMessage?: string,
  reportedExitCode?: number | null,
): Promise<void> {
  if (probeCommandTerminal !== undefined) {
    return probeCommandTerminal;
  }
  if (finished || lifecycleMode !== 'probe-running') {
    return Promise.resolve();
  }

  probeCommandTerminal = (async () => {
    const commandFailures: unknown[] = [];
    stopReason = reason;
    if (deadline !== undefined) {
      clearTimeout(deadline);
      deadline = undefined;
    }
    closeInput(true);

    if (ownedContainerId === undefined) {
      lifecycleMode = 'probe-command-completed';
      sendProbeCommandCompletion(false, reportedExitCode ?? null, errorMessage);
      return;
    }

    const configured = boundaryProbeConfiguration;

    if (reason !== 'completed') {
      await stopAttachedProcess();
      const stopped = await runDocker(['stop', '--time', '1', ownedContainerId]);
      if (fixedProbeProtocol === FIXED_BOUNDARY_PROBE_PROTOCOL && configured !== undefined) {
        retainBoundaryRawWriter(configured, stopped);
      }
      collectFixedProbeDockerCommandFailure('stop', stopped, commandFailures);
    }

    const inspected = await runDocker([
      'inspect',
      '--format',
      '{{.State.Running}} {{.State.ExitCode}}',
      ownedContainerId,
    ]);
    if (fixedProbeProtocol === FIXED_BOUNDARY_PROBE_PROTOCOL && configured !== undefined) {
      retainBoundaryRawWriter(configured, inspected);
    }
    collectFixedProbeDockerCommandFailure('inspect', inspected, commandFailures);
    const [, exitCodeValue] = inspected.stdout.trim().split(' ');
    const parsedExitCode = Number.parseInt(exitCodeValue ?? '', 10);
    const exitCode = Number.isSafeInteger(parsedExitCode)
      ? parsedExitCode
      : (reportedExitCode ?? null);

    let firstExecutionError: unknown;
    if (fixedProbeProtocol === FIXED_BOUNDARY_PROBE_PROTOCOL && configured !== undefined) {
      try {
        await recordBoundaryProbeFirstExecution(
          configured,
          ownedContainerId,
          Object.freeze({
            errorMessage: errorMessage ?? null,
            exitCode,
            kind: 'command',
            reason,
          }),
        );
      } catch (error) {
        firstExecutionError = error;
      }
    }

    lifecycleMode = 'probe-command-completed';
    fixedProbeCommandFailures = commandFailures;
    // The Docker attach client and any guest descendants share the guardian's
    // process group. A stopped container alone cannot prove that group has
    // settled, so command completion preserves the original result but leaves
    // cleanup confirmation for the final exact stop-and-remove operation.
    const retainedFailures = [
      ...commandFailures,
      ...(firstExecutionError === undefined ? [] : [firstExecutionError]),
    ];
    const retainedFailure =
      retainedFailures.length === 0
        ? undefined
        : new AggregateError(retainedFailures, 'Fixed probe command retained failures.');
    sendProbeCommandCompletion(
      false,
      exitCode,
      combineAssemblyErrors(errorMessage, retainedFailure),
    );
  })();
  return probeCommandTerminal;
}

function cleanupFixedProbe(
  reason: StopReason,
  errorMessage?: string,
  reportedExitCode?: number | null,
): Promise<void> {
  if (fixedProbeCleanup !== undefined) {
    return fixedProbeCleanup;
  }

  fixedProbeCleanup = (async () => {
    const cleanupFailures: unknown[] = [];
    if (lifecycleMode === 'probe-running') {
      try {
        await completeFixedProbeCommand(reason, errorMessage, reportedExitCode);
      } catch (error) {
        cleanupFailures.push(error);
      }
    } else if (probeCommandTerminal !== undefined) {
      try {
        await probeCommandTerminal;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }

    // Command completion records its own bounded Docker outcomes only when
    // the terminal operation settles. Cleanup can race with that operation,
    // so snapshot the retained outcomes after its join rather than before it.
    cleanupFailures.push(...fixedProbeCommandFailures);

    if (probeCommandTerminal === undefined) {
      stopReason = reason;
    }
    finished = true;
    lifecycleMode = 'cleanup';
    if (deadline !== undefined) {
      clearTimeout(deadline);
      deadline = undefined;
    }
    closeInput(true);

    if (ownedContainerId === undefined) {
      sendCompletion(
        false,
        reportedExitCode ?? null,
        combineAssemblyErrors(errorMessage, new AggregateError(cleanupFailures)),
      );
      return;
    }

    if (attached !== undefined && probeCommandTerminal === undefined) {
      try {
        await stopAttachedProcess();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }

    const configured = boundaryProbeConfiguration;
    if (
      probeCommandTerminal === undefined &&
      fixedProbeProtocol === FIXED_BOUNDARY_PROBE_PROTOCOL &&
      configured !== undefined
    ) {
      try {
        await recordBoundaryProbeFirstExecution(
          configured,
          ownedContainerId,
          Object.freeze({ kind: 'never-started' }),
        );
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    let inspected: DockerCommandResult | undefined;
    try {
      inspected = await runDocker([
        'inspect',
        '--format',
        '{{.State.Running}} {{.State.ExitCode}}',
        ownedContainerId,
      ]);
      if (fixedProbeProtocol === FIXED_BOUNDARY_PROBE_PROTOCOL && configured !== undefined) {
        retainBoundaryRawWriter(configured, inspected);
      }
      collectFixedProbeDockerCommandFailure('inspect', inspected, cleanupFailures);
    } catch (error) {
      cleanupFailures.push(error);
    }
    const [running, exitCodeValue] = inspected?.stdout.trim().split(' ') ?? [];
    const parsedExitCode = Number.parseInt(exitCodeValue ?? '', 10);

    if (inspected?.commandCompleted && inspected.exitCode === 0 && running === 'true') {
      try {
        const stopped = await runDocker(['stop', '--time', '1', ownedContainerId]);
        if (fixedProbeProtocol === FIXED_BOUNDARY_PROBE_PROTOCOL && configured !== undefined) {
          retainBoundaryRawWriter(configured, stopped);
        }
        collectFixedProbeDockerCommandFailure('stop', stopped, cleanupFailures);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }

    let removed: DockerCommandResult | undefined;
    try {
      removed = await runDocker(['rm', '--force', ownedContainerId]);
      if (fixedProbeProtocol === FIXED_BOUNDARY_PROBE_PROTOCOL && configured !== undefined) {
        retainBoundaryRawWriter(configured, removed);
      }
      collectFixedProbeDockerCommandFailure('remove', removed, cleanupFailures);
    } catch (error) {
      cleanupFailures.push(error);
    }
    let cleanupConfirmed =
      cleanupFailures.length === 0 &&
      inspected?.commandCompleted === true &&
      inspected.exitCode === 0 &&
      (running === 'false' || removed?.commandCompleted === true) &&
      removed?.commandCompleted === true &&
      removed.exitCode === 0;
    const exitCode = Number.isSafeInteger(parsedExitCode)
      ? parsedExitCode
      : (reportedExitCode ?? null);
    let terminalError: unknown;
    if (fixedProbeProtocol === FIXED_BOUNDARY_PROBE_PROTOCOL && configured !== undefined) {
      try {
        if (!(await waitForBoundaryRawWriters(configured))) {
          throw new Error('The boundary probe Docker writer did not settle before terminal proof.');
        }
      } catch (error) {
        cleanupFailures.push(error);
        cleanupConfirmed = false;
      }
    }
    if (
      cleanupConfirmed &&
      fixedProbeProtocol === FIXED_BOUNDARY_PROBE_PROTOCOL &&
      configured !== undefined &&
      removed !== undefined
    ) {
      try {
        await writeCreatedBoundaryProbeTerminal(configured, ownedContainerId, removed);
      } catch (error) {
        cleanupConfirmed = false;
        terminalError = error;
      }
    }
    const independentFailures = [
      ...cleanupFailures,
      ...(configured?.firstExecutionPersistenceError === undefined ||
      cleanupFailures.includes(configured.firstExecutionPersistenceError)
        ? []
        : [configured.firstExecutionPersistenceError]),
      ...(terminalError === undefined ? [] : [terminalError]),
    ];
    sendCompletion(
      cleanupConfirmed,
      exitCode,
      combineAssemblyErrors(
        errorMessage,
        independentFailures.length === 0
          ? undefined
          : new AggregateError(independentFailures, 'Fixed probe cleanup retained failures.'),
      ),
    );
  })();
  return fixedProbeCleanup;
}

async function writeCreatedBoundaryProbeTerminal(
  configured: BoundaryProbeConfigurationState,
  containerId: string,
  removed: DockerCommandResult,
): Promise<void> {
  const message = configured.message;
  const createResult = configured.createResult;
  const createReceiptAuthenticationTag = configured.createReceiptAuthenticationTag;
  const firstExecutionReceiptAuthenticationTag = configured.firstExecutionReceiptAuthenticationTag;
  const firstExecutionOutcome = configured.firstExecutionOutcome;
  if (
    createResult?.commandCompleted !== true ||
    createResult.exitCode !== 0 ||
    createResult.containerId !== containerId ||
    createReceiptAuthenticationTag === undefined ||
    firstExecutionReceiptAuthenticationTag === undefined ||
    firstExecutionOutcome === undefined
  ) {
    throw new Error('The boundary probe lacks an authenticated successful Docker create result.');
  }
  const payload = {
    configurationAuthenticationTag: configured.configurationAuthenticationTag,
    creationReceipt: {
      authenticationTag: createReceiptAuthenticationTag,
      path: message.creationReceiptPath,
    },
    controlReceiptAuthenticationTag: message.controlReceiptAuthenticationTag,
    controlResourceId: message.controlResourceId,
    guardian: {
      groupId: message.guardianPid,
      pid: message.guardianPid,
      start: message.guardianStart,
    },
    executionReceipt: {
      authenticationTag: firstExecutionReceiptAuthenticationTag,
      path: `${message.creationReceiptPath}.execution`,
    },
    ownerId: message.ownerId,
    raw: {
      createCommandCompleted: createResult.commandCompleted,
      createExitCode: createResult.exitCode,
      removeCommandCompleted: removed.commandCompleted,
      removeExitCode: removed.exitCode,
    },
    resourceId: message.resourceId,
    schema: 'qdroid.boundary-probe-terminal/v1',
    sessionId: message.sessionId,
    status: 'created-cleaned',
    containerId,
    version: 1,
  };
  const authenticationTag = boundaryReceiptAuthenticationTag(
    'qdroid.boundary-probe-terminal/v1',
    message.journalKey,
    payload,
  );
  await writeAtomicJson(message.terminalReceiptPath, { ...payload, authenticationTag });
}

function isFixedProbeLifecycle(value: typeof lifecycleMode): boolean {
  return (
    value === 'probe-created' || value === 'probe-running' || value === 'probe-command-completed'
  );
}

function isFixedAssemblyLifecycle(value: typeof lifecycleMode): boolean {
  return (
    value === 'assembly-creating' ||
    value === 'assembly-created' ||
    value === 'assembly-copying' ||
    value === 'assembly-copied' ||
    value === 'assembly-committing' ||
    value === 'assembly-committed'
  );
}

async function cleanupBoundaryControl(
  reason: StopReason,
  errorMessage: string | undefined,
): Promise<void> {
  if (finished) {
    return;
  }
  stopReason = reason;
  if (deadline !== undefined) {
    clearTimeout(deadline);
    deadline = undefined;
  }

  const state = boundaryControl;
  if (state === undefined) {
    sealBoundaryConstruction();
    if (!boundaryConstructionSettled && boundaryConstructionCompletion !== undefined) {
      await boundaryConstructionCompletion;
    }
    const settledState = boundaryControl;
    if (settledState !== undefined) {
      await cleanupBoundaryControl(reason, errorMessage);
      return;
    }
    finished = true;
    sendCompletion(false, null, errorMessage ?? 'The boundary control creation did not settle.');
    return;
  }
  lifecycleMode = 'cleanup';
  if (state.dependencies.size > 0) {
    if (disconnectRequested) {
      scheduleBoundaryParentLossCleanup(reason, errorMessage);
      return;
    }
    finished = true;
    sendCompletion(
      false,
      null,
      combineAssemblyErrors(
        errorMessage,
        'The boundary keeper still has an unretired dependent probe.',
      ),
    );
    return;
  }

  finished = true;

  const failures: unknown[] = [];
  if (state.healthError !== undefined) {
    failures.push(new Error(state.healthError));
  }
  try {
    await assertBoundaryControls(state);
  } catch (error) {
    failures.push(error);
  }

  state.expectedChildShutdown = true;
  try {
    state.child.kill('SIGTERM');
  } catch (error) {
    failures.push(error);
  }
  if (!(await waitForBoundaryChildExit(state.child, 1_000))) {
    failures.push(new Error('The fixed boundary secret child did not exit before cleanup.'));
  }

  let mayDeleteOwnedFiles = failures.length === 0;
  if (mayDeleteOwnedFiles) {
    try {
      await assertPrivateBoundaryDirectory(state.spec.fixtureRoot, state.parentHandle, 0o700);
      await assertPrivateBoundaryDirectory(state.directory, state.directoryHandle, 0o700);
    } catch (error) {
      failures.push(error);
      mayDeleteOwnedFiles = false;
    }
  }
  for (const file of [...state.files].reverse()) {
    if (mayDeleteOwnedFiles) {
      try {
        await assertBoundaryFile(file);
        await rm(file.path, { force: false });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await file.file.close();
    } catch (error) {
      failures.push(error);
    }
  }

  if (mayDeleteOwnedFiles && failures.length === 0) {
    try {
      await assertPrivateBoundaryDirectory(state.spec.fixtureRoot, state.parentHandle, 0o700);
      await assertPrivateBoundaryDirectory(state.directory, state.directoryHandle, 0o700);
      const entries = await readdir(state.directory);
      if (entries.length !== 0) {
        throw new Error('The fixed boundary directory retained an unknown entry during cleanup.');
      }
      await assertPrivateBoundaryDirectory(state.directory, state.directoryHandle, 0o700);
      await rmdir(state.directory);
      await syncDirectory(state.spec.fixtureRoot);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await state.directoryHandle.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await state.parentHandle.close();
  } catch (error) {
    failures.push(error);
  }

  let terminalFailure: unknown;
  if (failures.length === 0) {
    try {
      const terminalPath = join(
        dirname(state.spec.fixtureRoot),
        `${state.spec.resourceId}.boundary-terminal.json`,
      );
      const payload = {
        boundaryReceiptAuthenticationTag: state.receiptAuthenticationTag,
        bootId: state.spec.bootId,
        child: { pid: state.childPid, start: state.childStart },
        cleanup: {
          canariesRemoved: true,
          childExited: true,
          dependenciesRetired: state.dependencies.size === 0,
          directoryRemoved: true,
        },
        keeper: {
          groupId: state.spec.keeperPid,
          pid: state.spec.keeperPid,
          start: state.spec.keeperStart,
        },
        ownerId: state.spec.ownerId,
        protocol: FIXED_BOUNDARY_CONTROL_PROTOCOL,
        resourceId: state.spec.resourceId,
        schema: 'qdroid.boundary-keeper-terminal/v1',
        sessionId: state.spec.sessionId,
        status: 'cleaned',
        version: 1,
      };
      const authenticationTag = boundaryReceiptAuthenticationTag(
        'qdroid.boundary-control-terminal/v1',
        state.spec.journalKey,
        payload,
      );
      await writeAtomicJson(terminalPath, { ...payload, authenticationTag });
    } catch (error) {
      terminalFailure = error;
    }
  }

  const combined = combineAssemblyErrors(
    errorMessage,
    failures.length === 0 && terminalFailure === undefined
      ? undefined
      : new AggregateError(
          [...failures, ...(terminalFailure === undefined ? [] : [terminalFailure])],
          'Fixed boundary control cleanup failed.',
        ),
  );
  sendCompletion(failures.length === 0 && terminalFailure === undefined, null, combined);
}

function scheduleBoundaryParentLossCleanup(
  reason: StopReason,
  errorMessage: string | undefined,
): void {
  if (boundaryParentLossRetry !== undefined || finished) {
    return;
  }

  const retry = async (): Promise<void> => {
    boundaryParentLossRetry = undefined;
    const state = boundaryControl;
    if (state === undefined || finished) {
      return;
    }

    try {
      for (const [resourceId, dependency] of [...state.dependencies]) {
        await retireBoundaryDependency(state, resourceId, dependency.authenticationTag);
      }
    } catch {
      boundaryParentLossRetry = setTimeout(() => {
        void retry();
      }, 250);
      return;
    }

    await cleanupBoundaryControl(reason, errorMessage);
  };

  void retry();
}

async function waitForBoundaryChildExit(
  child: import('node:child_process').ChildProcess,
  deadlineMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), deadlineMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function cleanupUnacknowledgedBoundary(
  parentHandle: FileHandle | undefined,
  directory: string,
  directoryHandle: FileHandle | undefined,
  files: readonly BoundaryRetainedFile[],
  child: import('node:child_process').ChildProcess | undefined,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  if (child !== undefined) {
    try {
      child.kill('SIGTERM');
      if (!(await waitForBoundaryChildExit(child, 1_000))) {
        throw new Error('The unacknowledged boundary secret child did not exit.');
      }
    } catch (error) {
      failures.push(error);
    }
  }

  let mayDeleteOwnedFiles = failures.length === 0;
  if (mayDeleteOwnedFiles) {
    try {
      if (parentHandle === undefined || directoryHandle === undefined) {
        throw new Error('The unacknowledged boundary directory lacks its original descriptors.');
      }
      await assertPrivateBoundaryDirectory(dirname(directory), parentHandle, 0o700);
      await assertPrivateBoundaryDirectory(directory, directoryHandle, 0o700);
    } catch (error) {
      failures.push(error);
      mayDeleteOwnedFiles = false;
    }
  }
  for (const file of [...files].reverse()) {
    if (mayDeleteOwnedFiles) {
      try {
        await assertBoundaryFile(file);
        await rm(file.path, { force: false });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await file.file.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (directoryHandle !== undefined && mayDeleteOwnedFiles && failures.length === 0) {
    try {
      if (parentHandle === undefined) {
        throw new Error('The unacknowledged boundary directory lost its original parent handle.');
      }
      await assertPrivateBoundaryDirectory(dirname(directory), parentHandle, 0o700);
      await assertPrivateBoundaryDirectory(directory, directoryHandle, 0o700);
      const entries = await readdir(directory);
      if (entries.length !== 0) {
        throw new Error('The unacknowledged boundary directory retained an unknown entry.');
      }
      await rmdir(directory);
    } catch (error) {
      failures.push(error);
    }
  }
  if (directoryHandle !== undefined) {
    try {
      await directoryHandle.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (parentHandle !== undefined) {
    try {
      await parentHandle.close();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
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

function sendProbeCommandCompletion(
  cleanupConfirmed: boolean,
  exitCode: number | null,
  errorMessage?: string,
): void {
  const completion = {
    cleanupConfirmed,
    exitCode,
    reason: stopReason,
    stderrBytes,
    stdoutBytes,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };

  if (process.connected) {
    process.send?.({
      completion,
      protocol: fixedProbeProtocol,
      type: 'probe-command-completed',
    });
  }
}

async function runDocker(argumentsValue: string[]): Promise<DockerCommandResult> {
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

  let resolveRawWriterClosed: (() => void) | undefined;
  const rawWriterClosed = new Promise<void>((resolve) => {
    resolveRawWriterClosed = resolve;
  });
  const result = await new Promise<{
    commandCompleted: boolean;
    exitCode: number;
    rawWriterSettled: boolean;
  }>((resolve) => {
    let settled = false;
    let commandDeadline: NodeJS.Timeout | undefined;
    let closeDeadline: NodeJS.Timeout | undefined;
    const finish = (code: number, commandCompleted: boolean, rawWriterSettled: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (commandDeadline !== undefined) {
        clearTimeout(commandDeadline);
      }
      if (closeDeadline !== undefined) {
        clearTimeout(closeDeadline);
      }
      resolve({ commandCompleted, exitCode: code, rawWriterSettled });
    };
    const terminate = (): void => {
      try {
        // Docker commands share the guardian's registered process group.
        // Never kill that group here: it would kill the keeper that owns the
        // held template descriptors. The raw child's `close` remains the
        // only proof that this writer has stopped using those materials.
        child.kill('SIGKILL');
        return;
      } catch {
        // Docker may have exited before the bounded command deadline.
      }
      child.kill('SIGKILL');
    };
    commandDeadline = setTimeout(() => {
      terminate();
      closeDeadline = setTimeout(() => {
        finish(1, false, false);
      }, DOCKER_COMMAND_CLOSE_GRACE_MS);
    }, DOCKER_COMMAND_DEADLINE_MS);
    child.once('error', () => {
      resolveRawWriterClosed?.();
      finish(1, false, true);
    });
    child.once('close', (code) => {
      resolveRawWriterClosed?.();
      finish(outputLimited ? 1 : (code ?? 1), true, true);
    });
  });

  if (outputLimited) {
    return {
      ...result,
      exitCode: 1,
      rawWriterClosed,
      stderr,
      stdout: `${stdout}${stderr}`,
    };
  }
  return { ...result, rawWriterClosed, stderr, stdout };
}

function collectFixedProbeDockerCommandFailure(
  operation: 'inspect' | 'remove' | 'stop',
  result: DockerCommandResult,
  failures: unknown[],
): void {
  if (result.commandCompleted && result.exitCode === 0 && result.rawWriterSettled) {
    return;
  }

  const details = [
    `exit code ${result.exitCode}`,
    ...(result.commandCompleted ? [] : ['command did not complete before its bounded deadline']),
    ...(result.rawWriterSettled ? [] : ['raw Docker writer did not settle']),
    ...(result.stderr.trim() === '' ? [] : [`stderr: ${result.stderr.trim()}`]),
  ];
  failures.push(new Error(`The fixed probe Docker ${operation} failed (${details.join('; ')}).`));
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

function isValidOwnedContainerMessage(value: unknown): value is OwnedContainerMessage {
  return (
    isRecord(value) &&
    typeof value.imageId === 'string' &&
    /^sha256:[a-f0-9]{64}$/i.test(value.imageId) &&
    isRecord(value.labels) &&
    Object.keys(value.labels).length === 3 &&
    typeof value.labels['io.qdroid.owner'] === 'string' &&
    typeof value.labels['io.qdroid.profile'] === 'string' &&
    typeof value.labels['io.qdroid.session'] === 'string'
  );
}

function isValidNativeMessage(value: NativeMessage): boolean {
  return (
    Number.isSafeInteger(value.deadlineMs) &&
    value.deadlineMs > 0 &&
    Number.isSafeInteger(value.maxOutputBytes) &&
    value.maxOutputBytes > 0 &&
    value.maxOutputBytes <= MAX_DOCKER_COMMAND_OUTPUT_BYTES &&
    isValidNativeIntent(value.intent)
  );
}

function isValidAssemblyStartMessage(value: unknown): value is AssemblyStartMessage {
  if (
    !isRecord(value) ||
    (Object.keys(value).length !== 20 && Object.keys(value).length !== 21) ||
    value.type !== 'assembly-start'
  ) {
    return false;
  }
  const {
    bootId,
    buildOutputDirectory,
    candidateId,
    commitReceiptPath,
    containerName,
    creationReceiptPath,
    deadlineMs,
    journalKey,
    materialDigest,
    ownerId,
    packageDirectory,
    packageDigest,
    platform,
    protocol,
    purpose,
    resourceId,
    sessionId,
    sourceImage,
    templateDirectory,
    terminalReceiptPath,
  } = value;
  if (
    typeof containerName !== 'string' ||
    typeof resourceId !== 'string' ||
    typeof deadlineMs !== 'number' ||
    typeof sourceImage !== 'string'
  ) {
    return false;
  }
  return (
    protocol === FIXED_ASSEMBLY_PROTOCOL &&
    isUuid(bootId) &&
    isCandidateId(candidateId) &&
    isSafeAssemblyContainerName(containerName) &&
    containerName.endsWith(resourceId.slice(9)) &&
    Number.isSafeInteger(deadlineMs) &&
    deadlineMs >= 1 &&
    deadlineMs <= 120_000 &&
    journalKey instanceof Uint8Array &&
    journalKey.byteLength === 32 &&
    isSha256(materialDigest) &&
    isSafeAssemblyOwnerId(ownerId) &&
    isSha256(packageDigest) &&
    (platform === 'linux/amd64' || platform === 'linux/arm64') &&
    (purpose === 'builder' || purpose === 'runtime') &&
    isSafeAssemblyResourceId(resourceId) &&
    sessionId === candidateId &&
    isImageId(sourceImage) &&
    isTrustedAssemblyPackageDirectory(packageDirectory, packageDigest) &&
    (buildOutputDirectory === undefined ||
      isTrustedAssemblyGeneratedDirectory(buildOutputDirectory, packageDigest)) &&
    isTrustedAssemblyTemplateDirectory(templateDirectory, sessionId, resourceId) &&
    isTrustedAssemblyCommitReceiptPath(commitReceiptPath, templateDirectory, resourceId) &&
    isTrustedAssemblyCreationReceiptPath(creationReceiptPath, templateDirectory, resourceId) &&
    isTrustedAssemblyTerminalReceiptPath(terminalReceiptPath, templateDirectory, resourceId)
  );
}

function isValidAssemblyAdvanceMessage(value: unknown): value is AssemblyAdvanceMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.protocol === FIXED_ASSEMBLY_PROTOCOL &&
    (value.type === 'assembly-copy' ||
      value.type === 'assembly-commit' ||
      value.type === 'assembly-cleanup')
  );
}

function isTrustedAssemblyPackageDirectory(value: unknown, packageDigest: unknown): boolean {
  return (
    typeof value === 'string' &&
    typeof packageDigest === 'string' &&
    isSha256(packageDigest) &&
    isAbsoluteTrustedPath(value) &&
    value.endsWith(`/content/${packageDigest}`)
  );
}

function isTrustedAssemblyGeneratedDirectory(value: unknown, packageDigest: unknown): boolean {
  return (
    typeof value === 'string' &&
    typeof packageDigest === 'string' &&
    isSha256(packageDigest) &&
    isAbsoluteTrustedPath(value) &&
    new RegExp(`/generated/${packageDigest}/[a-f0-9]{64}$`).test(value)
  );
}

function isTrustedAssemblyTemplateDirectory(
  value: unknown,
  sessionId: unknown,
  resourceId: unknown,
): boolean {
  return (
    typeof value === 'string' &&
    typeof sessionId === 'string' &&
    typeof resourceId === 'string' &&
    isAbsoluteTrustedPath(value) &&
    value.endsWith(`/runtime-sessions/${sessionId}/assembly-template-${resourceId.slice(9)}`)
  );
}

function isTrustedAssemblyTerminalReceiptPath(
  value: unknown,
  templateDirectory: unknown,
  resourceId: unknown,
): boolean {
  if (
    typeof value !== 'string' ||
    typeof templateDirectory !== 'string' ||
    typeof resourceId !== 'string' ||
    !isAbsoluteTrustedPath(value)
  ) {
    return false;
  }
  return (
    dirname(value) === dirname(templateDirectory) &&
    basename(value) === `${resourceId}.assembly-terminal.json`
  );
}

function isTrustedAssemblyCreationReceiptPath(
  value: unknown,
  templateDirectory: unknown,
  resourceId: unknown,
): boolean {
  if (
    typeof value !== 'string' ||
    typeof templateDirectory !== 'string' ||
    typeof resourceId !== 'string' ||
    !isAbsoluteTrustedPath(value)
  ) {
    return false;
  }
  return (
    dirname(value) === dirname(templateDirectory) &&
    basename(value) === `${resourceId}.assembly-created.json`
  );
}

function isTrustedAssemblyCommitReceiptPath(
  value: unknown,
  templateDirectory: unknown,
  resourceId: unknown,
): boolean {
  if (
    typeof value !== 'string' ||
    typeof templateDirectory !== 'string' ||
    typeof resourceId !== 'string' ||
    !isAbsoluteTrustedPath(value)
  ) {
    return false;
  }
  return (
    dirname(value) === dirname(templateDirectory) &&
    basename(value) === `${resourceId}.assembly-committed.json`
  );
}

function isAbsoluteTrustedPath(value: string): boolean {
  return (
    value.startsWith('/') &&
    !value.includes('\0') &&
    !value.includes('/../') &&
    !value.endsWith('/..')
  );
}

function isSafeAssemblyContainerName(value: unknown): boolean {
  return typeof value === 'string' && /^qdroid-t005-assembly-[0-9a-f-]{36}$/.test(value);
}

function isSafeAssemblyOwnerId(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(value);
}

function isSafeAssemblyResourceId(value: unknown): boolean {
  return typeof value === 'string' && /^assembly-[0-9a-f-]{36}$/.test(value);
}

function isCandidateId(value: unknown): boolean {
  return typeof value === 'string' && /^(?:candidate|reuse)-[0-9a-f-]{36}$/.test(value);
}

function isUuid(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isSha256(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function isValidNativeIntent(value: NativeIntentMessage): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return false;
  }

  if (
    value.kind === 'docker-runtime-info' ||
    value.kind === 'docker-server-version' ||
    value.kind === 'kernel-release' ||
    value.kind === 'legacy-io-device-number' ||
    value.kind === 'legacy-io-root-parent' ||
    value.kind === 'legacy-io-root-source' ||
    value.kind === 'legacy-storage-parent' ||
    value.kind === 'legacy-storage-source' ||
    value.kind === 'machine-architecture'
  ) {
    return Object.keys(value).length === 1;
  }

  if (value.kind === 'image-id' || value.kind === 'legacy-image-inspect') {
    return (
      Object.keys(value).length === 2 &&
      typeof value.imageId === 'string' &&
      isImageId(value.imageId)
    );
  }

  if (value.kind === 'legacy-io-cache-drop') {
    return (
      Object.keys(value).length === 2 &&
      typeof value.path === 'string' &&
      isTrustedIoFixturePath(value.path)
    );
  }

  return (
    (value.kind === 'legacy-runtime-component-sha256' ||
      value.kind === 'legacy-runtime-version' ||
      value.kind === 'runtime-component-sha256' ||
      value.kind === 'runtime-version') &&
    Object.keys(value).length === 2 &&
    typeof value.path === 'string' &&
    isTrustedRuntimeComponent(value.path)
  );
}

function isValidProbeCreateMessage(value: unknown): value is ProbeCreateMessage {
  if (!isRecord(value) || value.type !== 'probe-create') {
    return false;
  }

  const {
    boundaryAuthorization,
    containerName,
    deadlineMs,
    imageId,
    intent,
    maxOutputBytes,
    ownership,
  } = value;
  const isBoundaryProbe = value.protocol === FIXED_BOUNDARY_PROBE_PROTOCOL;
  return (
    Object.keys(value).length === (isBoundaryProbe ? 9 : 8) &&
    typeof containerName === 'string' &&
    isSafeContainerName(containerName) &&
    typeof imageId === 'string' &&
    isImageId(imageId) &&
    typeof deadlineMs === 'number' &&
    Number.isSafeInteger(deadlineMs) &&
    deadlineMs > 0 &&
    typeof maxOutputBytes === 'number' &&
    Number.isSafeInteger(maxOutputBytes) &&
    maxOutputBytes > 0 &&
    maxOutputBytes <= MAX_DOCKER_COMMAND_OUTPUT_BYTES &&
    ((value.protocol === FIXED_PROBE_PROTOCOL &&
      boundaryAuthorization === undefined &&
      isValidProbeIntent(intent)) ||
      (value.protocol === FIXED_BOUNDARY_PROBE_PROTOCOL &&
        isValidBoundaryProbeIntent(intent) &&
        isValidBoundaryProbeAuthorization(boundaryAuthorization))) &&
    isValidOwnedContainerMessage(ownership)
  );
}

function isValidBoundaryProbeAuthorization(
  value: unknown,
): value is NonNullable<ProbeCreateMessage['boundaryAuthorization']> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['controlResourceId', 'dependencyAuthenticationTag', 'resourceId']) &&
    typeof value.controlResourceId === 'string' &&
    /^boundary-[0-9a-f-]{36}$/i.test(value.controlResourceId) &&
    typeof value.resourceId === 'string' &&
    /^probe-[0-9a-f-]{36}$/i.test(value.resourceId) &&
    typeof value.dependencyAuthenticationTag === 'string' &&
    /^[a-f0-9]{64}$/i.test(value.dependencyAuthenticationTag)
  );
}

function isValidBoundaryProbeIntent(value: unknown): value is BoundaryProbeIntentMessage {
  if (!isRecord(value) || Object.keys(value).length !== 8) {
    return false;
  }
  if (
    value.kind !== 'profile-boundary-program' ||
    !isSandboxProfileId(value.profileId) ||
    typeof value.controlResourceId !== 'string' ||
    !/^boundary-[0-9a-f-]{36}$/i.test(value.controlResourceId) ||
    typeof value.controlReceiptAuthenticationTag !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.controlReceiptAuthenticationTag) ||
    !isPositiveInteger(value.childPid) ||
    typeof value.childStart !== 'string' ||
    !/^\d+$/.test(value.childStart) ||
    typeof value.crossAppPath !== 'string' ||
    typeof value.trustedStorePath !== 'string'
  ) {
    return false;
  }
  return (
    isTrustedBoundaryCanaryPath(value.crossAppPath, 'cross-app-canary') &&
    isTrustedBoundaryCanaryPath(value.trustedStorePath, 'trusted-store-canary') &&
    dirname(value.crossAppPath) === dirname(value.trustedStorePath)
  );
}

function isSandboxProfileId(value: unknown): value is SandboxProfileId {
  return (
    typeof value === 'string' &&
    (value === 'build-restricted' || value === 'render-offline' || value === 'tool-offline')
  );
}

function isValidProbeIntent(value: unknown): value is ProbeIntentMessage {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return false;
  }

  if (value.kind === 'legacy-fixed-configuration') {
    return Object.keys(value).length === 1;
  }

  if (value.kind === 'legacy-fixed-filesystem') {
    return (
      Object.keys(value).length === 2 &&
      isRecord(value.paths) &&
      Object.keys(value.paths).length === 3 &&
      isTrustedHostInputPath(value.paths.canary, 'canary') &&
      isTrustedHostInputPath(value.paths.secret, 'secret') &&
      isTrustedHostInputPath(value.paths.store, 'store')
    );
  }

  if (value.kind === 'profile-fixed-program') {
    const selectorIsIo = value.selector === 'io';
    return (
      Object.keys(value).length === (selectorIsIo ? 4 : 3) &&
      isSandboxProfileId(value.profileId) &&
      isFixedProfileProbeSelector(value.selector) &&
      value.selector !== 'host-boundary' &&
      value.selector !== 'network' &&
      (selectorIsIo
        ? typeof value.sourcePath === 'string' && isTrustedIoFixturePath(value.sourcePath)
        : value.sourcePath === undefined)
    );
  }

  return (
    value.kind === 'legacy-fixed-program' &&
    Object.keys(value).length === 2 &&
    typeof value.program === 'string' &&
    isFixedProbeProgram(value.program)
  );
}

function isTrustedHostInputPath(value: unknown, name: 'canary' | 'secret' | 'store'): boolean {
  return (
    typeof value === 'string' &&
    !value.includes('/../') &&
    !value.endsWith('/..') &&
    /^\/[A-Za-z0-9._/-]+\/fixtures\/fixture-[0-9a-f-]{36}\/(canary|secret|store)$/.test(value) &&
    value.endsWith(`/${name}`)
  );
}

function isFixedProbeProgram(value: string): value is ProbeProgramMessage {
  return (
    value === 'descendants' ||
    value === 'memory' ||
    value === 'output-limit' ||
    value === 'pids' ||
    value === 'scratch-read' ||
    value === 'scratch-write' ||
    value === 'scratch-limit'
  );
}

function isValidProbeInspectMessage(value: unknown): value is ProbeInspectMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    value.type === 'probe-inspect' &&
    (value.protocol === FIXED_PROBE_PROTOCOL || value.protocol === FIXED_BOUNDARY_PROBE_PROTOCOL) &&
    typeof value.id === 'string' &&
    /^[a-f0-9-]{36}$/i.test(value.id) &&
    (value.query === 'configuration' ||
      value.query === 'container-state' ||
      value.query === 'guest-descendants' ||
      value.query === 'live-cgroup')
  );
}

function isValidProbeStartMessage(value: unknown): value is ProbeStartMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.type === 'probe-start' &&
    (value.protocol === FIXED_PROBE_PROTOCOL || value.protocol === FIXED_BOUNDARY_PROBE_PROTOCOL)
  );
}

function isValidBoundaryCreateMessage(value: unknown): value is BoundaryCreateMessage {
  if (!isRecord(value) || Object.keys(value).length !== 11) {
    return false;
  }
  return (
    value.type === 'boundary-create' &&
    value.protocol === FIXED_BOUNDARY_CONTROL_PROTOCOL &&
    isUuid(value.bootId) &&
    typeof value.fixtureRoot === 'string' &&
    typeof value.receiptPath === 'string' &&
    typeof value.ownerId === 'string' &&
    /^[A-Za-z0-9_.-]{1,120}$/.test(value.ownerId) &&
    typeof value.sessionId === 'string' &&
    isCandidateId(value.sessionId) &&
    typeof value.resourceId === 'string' &&
    /^boundary-[0-9a-f-]{36}$/i.test(value.resourceId) &&
    isPositiveInteger(value.keeperPid) &&
    typeof value.keeperStart === 'string' &&
    /^\d+$/.test(value.keeperStart) &&
    value.journalKey instanceof Uint8Array &&
    value.journalKey.byteLength === 32 &&
    isAbsoluteTrustedPath(value.fixtureRoot) &&
    value.fixtureRoot.endsWith(`/runtime-sessions/${value.sessionId}/fixtures`) &&
    isAbsoluteTrustedPath(value.receiptPath) &&
    dirname(value.receiptPath) === dirname(value.fixtureRoot) &&
    basename(value.receiptPath) === `${value.resourceId}.boundary-created.json`
  );
}

function isValidBoundaryAssertMessage(value: unknown): value is BoundaryAssertMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.type === 'boundary-assert' &&
    value.protocol === FIXED_BOUNDARY_CONTROL_PROTOCOL &&
    typeof value.id === 'string' &&
    isUuid(value.id)
  );
}

function isValidBoundaryRegisterMessage(value: unknown): value is BoundaryRegisterMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 13 &&
    value.type === 'boundary-register' &&
    value.protocol === FIXED_BOUNDARY_CONTROL_PROTOCOL &&
    typeof value.id === 'string' &&
    isUuid(value.id) &&
    typeof value.resourceId === 'string' &&
    /^probe-[0-9a-f-]{36}$/i.test(value.resourceId) &&
    typeof value.containerName === 'string' &&
    isSafeContainerName(value.containerName) &&
    isPositiveInteger(value.guardianGroupId) &&
    isPositiveInteger(value.guardianPid) &&
    typeof value.guardianStart === 'string' &&
    /^\d+$/.test(value.guardianStart) &&
    typeof value.imageId === 'string' &&
    isImageId(value.imageId) &&
    isRecord(value.labels) &&
    isValidOwnedContainerMessage({ imageId: value.imageId, labels: value.labels }) &&
    isSandboxProfileId(value.labels['io.qdroid.profile']) &&
    typeof value.configurationAuthenticationTag === 'string' &&
    /^[a-f0-9]{64}$/i.test(value.configurationAuthenticationTag) &&
    isTrustedBoundaryProbeReceiptPath(
      value.configurationReceiptPath,
      value.resourceId,
      'boundary-configured.json',
    ) &&
    isTrustedBoundaryProbeReceiptPath(
      value.terminalReceiptPath,
      value.resourceId,
      'boundary-terminal.json',
    )
  );
}

function isValidBoundaryProbeConfigureMessage(
  value: unknown,
): value is BoundaryProbeConfigureMessage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'bootId',
      'configurationReceiptPath',
      'creationReceiptPath',
      'controlReceiptAuthenticationTag',
      'controlResourceId',
      'guardianPid',
      'guardianStart',
      'journalKey',
      'ownerId',
      'probe',
      'resourceId',
      'sessionId',
      'terminalReceiptPath',
      'type',
    ]) ||
    value.type !== 'boundary-probe-configure' ||
    !isUuid(value.bootId) ||
    typeof value.ownerId !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,120}$/.test(value.ownerId) ||
    typeof value.sessionId !== 'string' ||
    !isCandidateId(value.sessionId) ||
    typeof value.controlResourceId !== 'string' ||
    !/^boundary-[0-9a-f-]{36}$/i.test(value.controlResourceId) ||
    typeof value.resourceId !== 'string' ||
    !/^probe-[0-9a-f-]{36}$/i.test(value.resourceId) ||
    !isPositiveInteger(value.guardianPid) ||
    typeof value.guardianStart !== 'string' ||
    !/^\d+$/.test(value.guardianStart) ||
    !(value.journalKey instanceof Uint8Array) ||
    value.journalKey.byteLength !== 32 ||
    typeof value.controlReceiptAuthenticationTag !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.controlReceiptAuthenticationTag) ||
    !isRecord(value.probe)
  ) {
    return false;
  }

  const probe = value.probe;
  if (
    !(
      hasExactKeys(probe, [
        'containerName',
        'deadlineMs',
        'imageId',
        'intent',
        'maxOutputBytes',
        'ownership',
        'protocol',
      ]) &&
      probe.protocol === FIXED_BOUNDARY_PROBE_PROTOCOL &&
      typeof probe.containerName === 'string' &&
      isSafeContainerName(probe.containerName) &&
      typeof probe.deadlineMs === 'number' &&
      Number.isSafeInteger(probe.deadlineMs) &&
      probe.deadlineMs > 0 &&
      typeof probe.imageId === 'string' &&
      isImageId(probe.imageId) &&
      typeof probe.maxOutputBytes === 'number' &&
      Number.isSafeInteger(probe.maxOutputBytes) &&
      probe.maxOutputBytes > 0 &&
      probe.maxOutputBytes <= MAX_DOCKER_COMMAND_OUTPUT_BYTES &&
      isValidBoundaryProbeIntent(probe.intent) &&
      isValidOwnedContainerMessage(probe.ownership)
    )
  ) {
    return false;
  }

  const fixtureDirectory = dirname(dirname(probe.intent.crossAppPath));
  const resourceDirectory = dirname(fixtureDirectory);
  return (
    fixtureDirectory.endsWith(`/runtime-sessions/${value.sessionId}/fixtures`) &&
    probe.intent.controlResourceId === value.controlResourceId &&
    probe.intent.controlReceiptAuthenticationTag === value.controlReceiptAuthenticationTag &&
    probe.ownership.imageId === probe.imageId &&
    probe.ownership.labels['io.qdroid.owner'] === value.ownerId &&
    probe.ownership.labels['io.qdroid.profile'] === probe.intent.profileId &&
    probe.ownership.labels['io.qdroid.session'] === value.sessionId &&
    probe.intent.trustedStorePath ===
      join(fixtureDirectory, value.controlResourceId, 'trusted-store-canary') &&
    probe.intent.crossAppPath ===
      join(fixtureDirectory, value.controlResourceId, 'cross-app-canary') &&
    value.configurationReceiptPath ===
      join(resourceDirectory, `${value.resourceId}.boundary-configured.json`) &&
    value.creationReceiptPath ===
      join(resourceDirectory, `${value.resourceId}.boundary-created.json`) &&
    value.terminalReceiptPath ===
      join(resourceDirectory, `${value.resourceId}.boundary-terminal.json`)
  );
}

function isTrustedBoundaryProbeReceiptPath(
  value: unknown,
  resourceId: unknown,
  suffix: string,
): value is string {
  return (
    typeof value === 'string' &&
    typeof resourceId === 'string' &&
    /^probe-[0-9a-f-]{36}$/i.test(resourceId) &&
    isAbsoluteTrustedPath(value) &&
    new RegExp(`/runtime-sessions/candidate-[0-9a-f-]{36}/${resourceId}\\.${suffix}$`).test(value)
  );
}

function isValidBoundaryReleaseMessage(value: unknown): value is BoundaryReleaseMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 5 &&
    value.type === 'boundary-release' &&
    value.protocol === FIXED_BOUNDARY_CONTROL_PROTOCOL &&
    typeof value.id === 'string' &&
    isUuid(value.id) &&
    typeof value.resourceId === 'string' &&
    /^probe-[0-9a-f-]{36}$/i.test(value.resourceId) &&
    typeof value.authenticationTag === 'string' &&
    /^[a-f0-9]{64}$/i.test(value.authenticationTag)
  );
}

function isTrustedBoundaryCanaryPath(value: string, name: BoundaryRetainedFile['name']): boolean {
  return (
    isAbsoluteTrustedPath(value) &&
    new RegExp(`/fixtures/boundary-[0-9a-f-]{36}/${name}$`).test(value)
  );
}

function nativeInvocation(
  intent: NativeIntentMessage,
): { arguments: readonly string[]; command: string } | undefined {
  switch (intent.kind) {
    case 'docker-runtime-info':
      return { command: 'docker', arguments: ['info', '--format', '{{json .Runtimes}}'] };
    case 'docker-server-version':
      return { command: 'docker', arguments: ['version', '--format', '{{.Server.Version}}'] };
    case 'image-id':
      return {
        command: 'docker',
        arguments: ['image', 'inspect', '--format', '{{.Id}}', intent.imageId],
      };
    case 'legacy-image-inspect':
      return { command: 'docker', arguments: ['image', 'inspect', intent.imageId] };
    case 'kernel-release':
      return { command: 'uname', arguments: ['-r'] };
    case 'legacy-io-device-number':
      return { command: 'stat', arguments: ['-Lc', '%t:%T', '/dev/vdb'] };
    case 'legacy-io-root-parent':
      return { command: 'lsblk', arguments: ['-no', 'PKNAME', '/dev/vdb1'] };
    case 'legacy-io-root-source':
      return {
        command: 'findmnt',
        arguments: ['-no', 'SOURCE', '--target', '/mnt/lima-colima-qdroid-t002/qdroid-t002-io'],
      };
    case 'legacy-io-cache-drop':
      return {
        command: 'dd',
        arguments: [`if=${intent.path}`, 'iflag=nocache', 'count=0', 'status=none'],
      };
    case 'legacy-storage-parent':
      return { command: 'lsblk', arguments: ['-no', 'PKNAME', '/dev/vdb1'] };
    case 'legacy-storage-source':
      return { command: 'findmnt', arguments: ['-no', 'SOURCE', '/var/lib/docker'] };
    case 'machine-architecture':
      return { command: 'uname', arguments: ['-m'] };
    case 'legacy-runtime-component-sha256':
    case 'runtime-component-sha256':
      return { command: 'sha256sum', arguments: [intent.path] };
    case 'legacy-runtime-version':
    case 'runtime-version':
      return { command: intent.path, arguments: ['--version'] };
  }
}

function parseSingleDockerObject(result: {
  commandCompleted: boolean;
  exitCode: number;
  stdout: string;
}): Record<string, unknown> | undefined {
  if (!result.commandCompleted || result.exitCode !== 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) && parsed.length === 1 && isRecord(parsed[0])
      ? parsed[0]
      : undefined;
  } catch {
    return undefined;
  }
}

function probeBindingFromContainer(
  container: Record<string, unknown>,
): ProbeBindingMessage | undefined {
  const config = isRecord(container.Config) ? container.Config : undefined;
  const labels = isRecord(config?.Labels) ? config.Labels : undefined;
  if (
    typeof container.Id !== 'string' ||
    !isContainerId(container.Id) ||
    typeof container.Image !== 'string' ||
    !isImageId(container.Image) ||
    labels === undefined ||
    !Object.values(labels).every((value) => typeof value === 'string')
  ) {
    return undefined;
  }

  return {
    containerId: container.Id,
    imageId: container.Image,
    labels: labels as Record<string, string>,
  };
}

function matchesOwnedProbe(
  container: Record<string, unknown>,
  ownership: OwnedContainerMessage,
  expectedContainerId: string,
): boolean {
  const binding = probeBindingFromContainer(container);
  if (binding === undefined || binding.containerId !== expectedContainerId) {
    return false;
  }

  return (
    binding.imageId === ownership.imageId &&
    binding.labels['io.qdroid.owner'] === ownership.labels['io.qdroid.owner'] &&
    binding.labels['io.qdroid.profile'] === ownership.labels['io.qdroid.profile'] &&
    binding.labels['io.qdroid.session'] === ownership.labels['io.qdroid.session']
  );
}

function matchesFixedLegacyProfile(container: Record<string, unknown>): boolean {
  const config = isRecord(container.Config) ? container.Config : undefined;
  const hostConfig = isRecord(container.HostConfig) ? container.HostConfig : undefined;
  if (config === undefined || hostConfig === undefined) {
    return false;
  }

  const logConfig = isRecord(hostConfig.LogConfig) ? hostConfig.LogConfig : undefined;
  const ulimits = hostConfig.Ulimits;
  const tmpfs = hostConfig.Tmpfs;
  const mounts = container.Mounts;
  const capDrop = hostConfig.CapDrop;
  const securityOptions = hostConfig.SecurityOpt;

  const hasNprocLimit =
    Array.isArray(ulimits) &&
    ulimits.some(
      (limit) =>
        isRecord(limit) && limit.Name === 'nproc' && limit.Hard === 32 && limit.Soft === 32,
    );
  const hasTmpfs =
    isRecord(tmpfs) && typeof tmpfs['/tmp'] === 'string' && hasRequiredTmpfsOptions(tmpfs['/tmp']);

  return (
    config.OpenStdin === true &&
    config.Tty === false &&
    config.User === '65532:65532' &&
    hostConfig.Runtime === 'qdroid-runsc' &&
    hostConfig.NetworkMode === 'none' &&
    hostConfig.ReadonlyRootfs === true &&
    hostConfig.Memory === 512 * 1024 * 1024 &&
    hostConfig.MemorySwap === 512 * 1024 * 1024 &&
    hostConfig.NanoCpus === 500_000_000 &&
    hostConfig.PidsLimit === 256 &&
    hostConfig.ShmSize === 64 * 1024 * 1024 &&
    logConfig?.Type === 'none' &&
    Array.isArray(mounts) &&
    mounts.length === 0 &&
    (hostConfig.Binds === null || hostConfig.Binds === undefined) &&
    Array.isArray(capDrop) &&
    capDrop.length === 1 &&
    capDrop[0] === 'ALL' &&
    Array.isArray(securityOptions) &&
    securityOptions.includes('no-new-privileges') &&
    hasNprocLimit &&
    hasTmpfs &&
    hasFixedIoRate(hostConfig.BlkioDeviceReadBps) &&
    hasFixedIoRate(hostConfig.BlkioDeviceWriteBps)
  );
}

function matchesFixedProfileTuple(
  container: Record<string, unknown>,
  profileId: SandboxProfileId,
  ioSourcePath: string | undefined,
  matchesMounts: (mounts: unknown) => boolean = (mounts) =>
    matchesFixedProfileMounts(mounts, ioSourcePath),
): boolean {
  const profile = SANDBOX_PROFILE_CATALOG[profileId];
  const config = isRecord(container.Config) ? container.Config : undefined;
  const hostConfig = isRecord(container.HostConfig) ? container.HostConfig : undefined;
  if (config === undefined || hostConfig === undefined) {
    return false;
  }

  const logConfig = isRecord(hostConfig.LogConfig) ? hostConfig.LogConfig : undefined;
  const ulimits = hostConfig.Ulimits;
  const tmpfs = hostConfig.Tmpfs;
  const mounts = container.Mounts;
  const capDrop = hostConfig.CapDrop;
  const securityOptions = hostConfig.SecurityOpt;
  const hasNprocLimit =
    Array.isArray(ulimits) &&
    ulimits.some(
      (limit) =>
        isRecord(limit) &&
        limit.Name === 'nproc' &&
        limit.Hard === profile.limits.guestNproc &&
        limit.Soft === profile.limits.guestNproc,
    );
  const requiredTmpfs = `rw,noexec,nosuid,nodev,size=${profile.limits.scratchMiB}m`;
  const hasTmpfs =
    isRecord(tmpfs) &&
    typeof tmpfs['/tmp'] === 'string' &&
    hasRequiredTmpfsOptions(tmpfs['/tmp'], requiredTmpfs);
  const memoryBytes = profile.limits.memoryMiB * 1024 * 1024;
  const sharedMemoryBytes = profile.limits.sharedMemoryMiB * 1024 * 1024;

  return (
    config.OpenStdin === true &&
    config.Tty === false &&
    config.User === '65532:65532' &&
    hostConfig.Runtime === profile.runtime &&
    hostConfig.NetworkMode === profile.network &&
    hostConfig.ReadonlyRootfs === profile.readOnlyRoot &&
    hostConfig.Memory === memoryBytes &&
    hostConfig.MemorySwap === memoryBytes &&
    hostConfig.NanoCpus === Math.round(profile.limits.cpu * 1_000_000_000) &&
    hostConfig.PidsLimit === profile.limits.hostPids &&
    hostConfig.ShmSize === sharedMemoryBytes &&
    hostConfig.LogConfig !== undefined &&
    logConfig?.Type === 'none' &&
    matchesMounts(mounts) &&
    (hostConfig.Binds === null || hostConfig.Binds === undefined) &&
    Array.isArray(capDrop) &&
    capDrop.length === 1 &&
    capDrop[0] === 'ALL' &&
    Array.isArray(securityOptions) &&
    securityOptions.includes('no-new-privileges') &&
    hasNprocLimit &&
    hasTmpfs &&
    hasProfileIoRate(hostConfig.BlkioDeviceReadBps, profile.limits.ioBytesPerSecond) &&
    hasProfileIoRate(hostConfig.BlkioDeviceWriteBps, profile.limits.ioBytesPerSecond)
  );
}

function matchesFixedBoundaryProfileTuple(
  container: Record<string, unknown>,
  intent: BoundaryProbeIntentMessage,
): boolean {
  return matchesFixedProfileTuple(container, intent.profileId, undefined);
}

function matchesFixedProfileMounts(value: unknown, ioSourcePath: string | undefined): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  if (ioSourcePath === undefined) {
    return value.length === 0;
  }
  return (
    value.length === 1 &&
    isRecord(value[0]) &&
    value[0].Type === 'bind' &&
    value[0].Source === ioSourcePath &&
    value[0].Destination === '/opt/qdroid/io-probe.bin' &&
    value[0].RW === false
  );
}

function hasRequiredTmpfsOptions(
  value: string,
  expected: string = 'rw,noexec,nosuid,nodev,size=16m',
): boolean {
  const options = new Set(value.split(','));
  return expected.split(',').every((option) => options.has(option));
}

function hasFixedIoRate(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    isRecord(value[0]) &&
    value[0].Path === '/dev/vdb' &&
    value[0].Rate === 1_048_576
  );
}

function hasProfileIoRate(value: unknown, expectedRate: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    isRecord(value[0]) &&
    value[0].Path === '/dev/vdb' &&
    value[0].Rate === expectedRate
  );
}

function isImageId(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/i.test(value);
}

function isTrustedRuntimeComponent(path: string): boolean {
  return new Set([
    '/usr/local/bin/containerd-shim-runsc-v1',
    '/usr/local/bin/gvisor-bin/gvisor_sentry',
    '/usr/local/bin/gvisor-bin/gvisor-sentry-prewarmer',
    '/usr/local/bin/gvisor-bin/runsc-fd-parking',
    '/usr/local/bin/gvisor-bin/runsc-metric-server',
    '/usr/local/bin/runsc',
  ]).has(path);
}

function isTrustedIoFixturePath(path: string): boolean {
  return /^\/mnt\/lima-colima-qdroid-t002\/qdroid-t002-io\/io-[0-9a-f-]{36}\.bin$/.test(path);
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

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isMissingProcessGroup(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  const failures: unknown[] = [];
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await file.sync();
  } catch (error) {
    failures.push(error);
  }
  try {
    await file.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throwAssemblyFailures(failures, 'Managed atomic record write did not settle.');
  }

  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  const failures: unknown[] = [];
  try {
    await directory.sync();
  } catch (error) {
    failures.push(error);
  }
  try {
    await directory.close();
  } catch (error) {
    failures.push(error);
  }
  throwAssemblyFailures(failures, 'Managed assembly directory synchronization failed.');
}

function combineAssemblyErrors(
  original: string | undefined,
  additional: unknown,
): string | undefined {
  const messages = [
    ...(original === undefined || original === '' ? [] : [original]),
    ...errorMessages(additional),
  ];
  return messages.length === 0 ? undefined : messages.join(' ');
}

function errorMessages(error: unknown): readonly string[] {
  if (error === undefined) {
    return [];
  }
  if (error instanceof AggregateError) {
    const nested = error.errors.flatMap((cause) => errorMessages(cause));
    return error.message === '' ? nested : [error.message, ...nested];
  }
  if (error instanceof Error) {
    return error.message === '' ? [error.name] : [error.message];
  }
  return [String(error)];
}

function formatGuardianError(error: unknown, fallback: string): string {
  const messages = errorMessages(error).filter((message) => message !== '');
  return messages.length === 0 ? fallback : messages.join(' ');
}

function throwAssemblyFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 0) {
    return;
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  throw new AggregateError(failures, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isByteChunk(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isSafeContainerName(value: string): boolean {
  return /^qdroid-t00[45]-[a-z0-9-]{1,100}$/.test(value);
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

function isStopMessage(
  value: unknown,
): value is { readonly reason?: 'deadline' | 'output-limit' | 'stopped'; readonly type: 'stop' } {
  return (
    isRecord(value) &&
    value.type === 'stop' &&
    (value.reason === undefined ||
      value.reason === 'deadline' ||
      value.reason === 'output-limit' ||
      value.reason === 'stopped')
  );
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

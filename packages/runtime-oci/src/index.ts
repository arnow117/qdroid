import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { chmod, lstat, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { createServer, connect, type Server } from 'node:net';
import { createSocket, type Socket as DatagramSocket } from 'node:dgram';
import { join } from 'node:path';

import type { JsonRpcResponse } from '../../contracts/src/index.js';
import {
  BoundedStdioSession,
  readTrustedLinuxBootId,
  type SupervisedChannel,
} from '../../supervisor/src/index.js';

export const T002_PROFILE_ID = 'qdroid.t002.readonly-sim/v1';
export const T002_BASE_IMAGE =
  'ubuntu@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956';
export const T002_NODE_IMAGE =
  'node@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203';
export const T002_RUNSC_SHA256 = 'c771292129c7ff96e83c5074485e3d33cfc938652dc70682bb792a66842d4de2';
export const T002_RUNSC_SENTRY_SHA256 =
  '79f406de247333489ad3e1bdc5c936ede9bbe1eb1b36a315b601bc782c56aa16';
export const T002_QUALIFICATION_SUITE_VERSION = 'qdroid.t002.qualifier/v1';

const MAX_STDIO_FRAME_BYTES = 8_192;
const MAX_WORKLOAD_OUTPUT_BYTES = 65_536;
const WORKLOAD_DEADLINE_MS = 5_000;
const TRUSTED_COMMAND_DEADLINE_MS = 10_000;
const ATTACH_TERMINATION_GRACE_MS = 1_000;
const MAX_CAPTURED_DIAGNOSTIC_BYTES = 4_096;
const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const MAX_GUEST_PROCESS_ENTRIES = 64;
const NETWORK_CONTROL_DEADLINE_MS = 500;
const IO_BYTES_PER_SECOND = 1_048_576;
const IO_DEVICE = '/dev/vdb';
const IO_DEVICE_MAJOR_MINOR = '253:16';
const IO_QUALIFICATION_ROOT = '/mnt/lima-colima-qdroid-t002/qdroid-t002-io';
const IO_QUALIFICATION_CONTAINER_PATH = '/opt/qdroid/io-probe.bin';
const IO_QUALIFICATION_FILE_BYTES = 16 * 1024 * 1024;
const MIN_IO_PROBE_DURATION_MS = 12_000;
const GVISOR_COMPONENT_PATHS = [
  '/usr/local/bin/containerd-shim-runsc-v1',
  '/usr/local/bin/gvisor-bin/gvisor_sentry',
  '/usr/local/bin/gvisor-bin/gvisor-sentry-prewarmer',
  '/usr/local/bin/gvisor-bin/runsc-fd-parking',
  '/usr/local/bin/gvisor-bin/runsc-metric-server',
] as const;

export interface FixedSandboxProfile {
  capDrop: 'ALL';
  cpus: number;
  deadlineMs: number;
  guestNproc: number;
  hostPids: number;
  ioBytesPerSecond: number;
  ioDevice: string;
  maxOutputBytes: number;
  memoryMiB: number;
  network: 'none';
  readOnlyRoot: true;
  runtime: 'qdroid-runsc';
  sharedMemoryMiB: number;
  scratchMiB: number;
  user: '65532:65532';
}

export const FIXED_READONLY_PROFILE: FixedSandboxProfile = Object.freeze({
  capDrop: 'ALL',
  cpus: 0.5,
  deadlineMs: WORKLOAD_DEADLINE_MS,
  guestNproc: 32,
  hostPids: 256,
  ioBytesPerSecond: IO_BYTES_PER_SECOND,
  ioDevice: IO_DEVICE,
  maxOutputBytes: MAX_WORKLOAD_OUTPUT_BYTES,
  memoryMiB: 512,
  network: 'none',
  readOnlyRoot: true,
  runtime: 'qdroid-runsc',
  sharedMemoryMiB: 64,
  scratchMiB: 16,
  user: '65532:65532',
});

export type WorkloadMode =
  | 'admission-allow'
  | 'admission-cancel-first'
  | 'admission-forged-authority'
  | 'admission-ungranted'
  | 'allow'
  | 'deny'
  | 'duplicate-key'
  | 'forged-authority'
  | 'hold-child'
  | 'none'
  | 'spam-output'
  | 'unsupported-method';

type DockerSocketAccessStatus = 'missing' | 'permission-denied' | 'refused';
type ProbeValue = boolean | number | string;
type NetworkControlName = 'dnsUdp' | 'ipv6Tcp' | 'tcpIpv4' | 'udpIpv4';

export type NetworkControlReceipts = Record<NetworkControlName, boolean>;

export function hasAllNetworkControlReceipts(receipts: NetworkControlReceipts): boolean {
  return receipts.dnsUdp && receipts.ipv6Tcp && receipts.tcpIpv4 && receipts.udpIpv4;
}

export interface TcpControlSocket extends EventEmitter {
  destroy(): unknown;
  end(): unknown;
}

export type TcpConnector = (port: number, host: string) => TcpControlSocket;

export interface QualificationHostFacts {
  architecture: string;
  bootId: string;
  dockerStorageDevice: string;
  dockerVersion: string;
  kernelRelease: string;
  runtimePath: string;
  runtimeComponents: Record<string, string>;
  runtimeVersion: string;
}

export interface QualificationProbes {
  descendantCleanup: {
    confirmed: boolean;
    descendantsObserved: boolean;
    observation: DescendantObservation;
  };
  filesystem: {
    canaryUnreadable: boolean;
    canaryUnmodified: boolean;
    dockerSocketUnreadable: boolean;
    dockerSocketStatus: DockerSocketAccessStatus;
    hostCanaryUnchanged: boolean;
    noNewPrivileges: boolean;
    nonRoot: boolean;
    privateScratch: boolean;
    readOnlyRoot: boolean;
    rootMountReadOnly: boolean;
    syntheticSecretUnreadable: boolean;
    trustedStoreUnreadable: boolean;
    zeroEffectiveCapabilities: boolean;
  };
  io: {
    cgroupCpuPeriodMicros: number;
    cgroupCpuQuotaMicros: number;
    cgroupHostPidsLimit: number;
    cgroupReadBytesObserved: number;
    cgroupReadLimitBytesPerSecond: number;
    elapsedMs: number;
    qualificationSyntheticFileBytes: number;
  };
  memory: {
    oomKilled: boolean;
  };
  network: {
    controlTargetReachable: boolean;
    controlTargetReceipts: NetworkControlReceipts;
    controlTargetReceivedPackets: number;
  };
  outputLimit: {
    enforced: boolean;
  };
  pids: {
    forkDenied: boolean;
  };
  scratch: {
    enospc: boolean;
  };
  deadline: {
    enforced: boolean;
  };
  cpu: {
    cpuToWallRatio: number;
  };
}

export interface QualificationEvidence {
  fingerprint: string;
  host: QualificationHostFacts;
  imageId: string;
  probes: QualificationProbes;
  profile: FixedSandboxProfile;
  suiteVersion: typeof T002_QUALIFICATION_SUITE_VERSION;
}

export interface BoundSandboxHandle {
  readonly binding: {
    bootId: string;
    channelId: string;
    epoch: number;
    instanceId: string;
  };
  readonly id: string;
}

export interface WorkloadExecution {
  cleanupConfirmed: boolean;
  exitCode: number;
  responses: JsonRpcResponse[];
  stderr: string;
  stopReason: 'completed' | 'deadline' | 'output-limit';
  workloadReceivedResponse: boolean;
}

export interface DescendantObservation {
  attempts: number;
  lastExecExitCode: number | null;
  lastObservedChild: {
    pid: number;
    ppid: number;
  } | null;
  lastObserverPid: number | null;
  observerExcluded: boolean;
  observed: boolean;
}

export interface DockerSandboxManagerOptions {
  image: string;
}

interface DockerRuntimeInfo {
  path: string;
  runtimeArgs: string[];
}

interface FingerprintFacts {
  dockerVersion: string;
  host: QualificationHostFacts;
  imageId: string;
  profile: FixedSandboxProfile;
  suiteVersion: typeof T002_QUALIFICATION_SUITE_VERSION;
}

interface RunningProcessResult {
  cleanupConfirmed: boolean;
  descendantObservation: DescendantObservation;
  descendantsObserved: boolean;
  exitCode: number | null;
  outputLimited: boolean;
  stderr: string;
  stopReason: 'completed' | 'deadline' | 'output-limit';
  stdout: string;
}

interface QualificationReadOnlyMount {
  sourcePath: string;
  targetPath: string;
}

interface QualificationIoFile extends QualificationReadOnlyMount {
  dispose(): Promise<void>;
}

/**
 * Owns the fixed Docker argv profile. No caller can supply an image command,
 * mount, device, runtime, or network override through this API.
 */
export class DockerSandboxManager {
  private readonly qualifiedEvidence = new WeakMap<object, string>();
  private readonly qualifiedImages = new WeakMap<object, string>();
  private readonly liveSandboxes = new WeakMap<object, string>();

  public constructor(private readonly options: DockerSandboxManagerOptions) {}

  public async qualify(): Promise<QualificationEvidence> {
    const facts = await this.collectFingerprintFacts();
    const probes = await this.runQualificationProbes(facts.imageId);
    const fingerprint = digestJson(facts);
    const evidence: QualificationEvidence = Object.freeze({
      fingerprint,
      host: facts.host,
      imageId: facts.imageId,
      probes,
      profile: FIXED_READONLY_PROFILE,
      suiteVersion: T002_QUALIFICATION_SUITE_VERSION,
    });

    this.qualifiedEvidence.set(evidence, fingerprint);
    this.qualifiedImages.set(evidence, facts.imageId);
    return evidence;
  }

  public async createSandbox(
    qualification: QualificationEvidence,
    channel: SupervisedChannel,
  ): Promise<BoundSandboxHandle> {
    await this.assertQualified(qualification);
    const binding = channel.trustedBinding;
    const handle: BoundSandboxHandle = Object.freeze({
      binding: {
        bootId: binding.bootId,
        channelId: binding.channelId,
        epoch: binding.epoch,
        instanceId: binding.instanceId,
      },
      id: `sandbox-${randomUUID()}`,
    });

    this.liveSandboxes.set(handle, qualification.fingerprint);
    return handle;
  }

  public async runWorkload(
    qualification: QualificationEvidence,
    sandbox: BoundSandboxHandle,
    channel: SupervisedChannel,
    mode: WorkloadMode,
  ): Promise<WorkloadExecution> {
    await this.assertQualified(qualification);
    this.assertBoundSandbox(sandbox, qualification, channel);
    const image = this.qualifiedImages.get(qualification);

    if (image === undefined) {
      throw new Error('The qualified image handle is not trusted.');
    }

    const session = new BoundedStdioSession(channel, {
      maxFrameBytes: MAX_STDIO_FRAME_BYTES,
      maxTotalBytes: MAX_WORKLOAD_OUTPUT_BYTES,
    });
    const responses: JsonRpcResponse[] = [];
    const result = await this.runStreamingContainer(
      `workload-${randomUUID()}`,
      [mode],
      (chunk, stdin) => {
        session.accept(chunk);

        for (const response of session.drainResponses()) {
          responses.push(response);
          stdin.write(`${JSON.stringify(response)}\n`);
        }
      },
      WORKLOAD_DEADLINE_MS,
      MAX_WORKLOAD_OUTPUT_BYTES,
      false,
      {},
      image,
    );

    if (!result.cleanupConfirmed) {
      throw new Error('The fixed-profile workload cleanup could not be confirmed.');
    }

    if (result.stopReason !== 'completed' || result.exitCode !== 0) {
      throw new Error('The fixed-profile workload did not complete successfully.');
    }

    const expectedResponseConfirmation = `final-response-confirmed=${finalResponseRequestId(mode)}`;
    const workloadReceivedResponse = result.stderr
      .split(/\r?\n/)
      .includes(expectedResponseConfirmation);

    if (!workloadReceivedResponse) {
      throw new Error(
        'The workload did not confirm that it consumed its final supervisor response.',
      );
    }

    session.end();

    for (const response of session.drainResponses()) {
      responses.push(response);
    }

    return {
      cleanupConfirmed: result.cleanupConfirmed,
      exitCode: result.exitCode,
      responses,
      stderr: result.stderr,
      stopReason: result.stopReason,
      workloadReceivedResponse,
    };
  }

  private async assertQualified(qualification: QualificationEvidence): Promise<void> {
    const expectedFingerprint = this.qualifiedEvidence.get(qualification);

    if (expectedFingerprint === undefined) {
      throw new Error('The sandbox qualification handle is not trusted.');
    }

    const currentFingerprint = digestJson(await this.collectFingerprintFacts());

    if (
      currentFingerprint !== expectedFingerprint ||
      qualification.fingerprint !== expectedFingerprint
    ) {
      throw new Error('The qualified runtime fingerprint no longer matches the current host.');
    }
  }

  private assertBoundSandbox(
    sandbox: BoundSandboxHandle,
    qualification: QualificationEvidence,
    channel: SupervisedChannel,
  ): void {
    if (this.liveSandboxes.get(sandbox) !== qualification.fingerprint) {
      throw new Error('The sandbox handle is not trusted.');
    }

    const binding = channel.trustedBinding;
    const matchesChannel =
      binding.bootId === sandbox.binding.bootId &&
      binding.channelId === sandbox.binding.channelId &&
      binding.epoch === sandbox.binding.epoch &&
      binding.instanceId === sandbox.binding.instanceId;

    if (!matchesChannel) {
      throw new Error('The sandbox handle does not match the supervised channel.');
    }
  }

  private async collectFingerprintFacts(): Promise<FingerprintFacts> {
    const hostBootId = await readTrustedLinuxBootId();
    const [kernelRelease, architecture, dockerVersion, runtimeInfo, image, dockerStorageDevice] =
      await Promise.all([
        runCommand('uname', ['-r']),
        runCommand('uname', ['-m']),
        runDocker(['version', '--format', '{{.Server.Version}}']),
        this.readRuntimeInfo(),
        this.readImageInfo(),
        this.readDockerStorageDevice(),
      ]);
    const runtimeVersion = await runCommand(runtimeInfo.path, ['--version']);
    const runtimeComponents = await this.readRuntimeComponents(runtimeInfo.path);

    if (
      runtimeInfo.runtimeArgs.length !== 2 ||
      runtimeInfo.runtimeArgs[0] !== '--platform=systrap' ||
      runtimeInfo.runtimeArgs[1] !== '--network=none'
    ) {
      throw new Error('The qdroid-runsc runtime arguments do not match the fixed profile.');
    }

    if (runtimeComponents[runtimeInfo.path] !== T002_RUNSC_SHA256) {
      throw new Error('The qdroid-runsc binary checksum does not match the qualified runtime.');
    }

    if (runtimeComponents['/usr/local/bin/gvisor-bin/gvisor_sentry'] !== T002_RUNSC_SENTRY_SHA256) {
      throw new Error('The qdroid-runsc sentry checksum does not match the qualified runtime.');
    }

    if (
      image.architecture !== 'arm64' ||
      image.os !== 'linux' ||
      image.labels['io.qdroid.base-image'] !== T002_BASE_IMAGE ||
      image.labels['io.qdroid.node-image'] !== T002_NODE_IMAGE ||
      image.labels['io.qdroid.profile'] !== T002_PROFILE_ID
    ) {
      throw new Error('The final fixture image does not match the fixed T002 image contract.');
    }

    if (dockerStorageDevice !== FIXED_READONLY_PROFILE.ioDevice) {
      throw new Error('Docker storage does not use the fixed T002 I/O device.');
    }

    const host: QualificationHostFacts = {
      architecture: architecture.stdout.trim(),
      bootId: hostBootId,
      dockerStorageDevice,
      dockerVersion: dockerVersion.stdout.trim(),
      kernelRelease: kernelRelease.stdout.trim(),
      runtimePath: runtimeInfo.path,
      runtimeComponents,
      runtimeVersion: runtimeVersion.stdout.trim(),
    };

    return {
      dockerVersion: dockerVersion.stdout.trim(),
      host,
      imageId: image.id,
      profile: FIXED_READONLY_PROFILE,
      suiteVersion: T002_QUALIFICATION_SUITE_VERSION,
    };
  }

  private async readRuntimeInfo(): Promise<DockerRuntimeInfo> {
    const result = await runDocker(['info', '--format', '{{json .Runtimes}}']);
    const runtimes = JSON.parse(result.stdout) as Record<string, unknown>;
    const candidate = runtimes['qdroid-runsc'];

    if (
      !isRecord(candidate) ||
      typeof candidate.path !== 'string' ||
      !Array.isArray(candidate.runtimeArgs)
    ) {
      throw new Error('The required qdroid-runsc runtime is unavailable.');
    }

    if (!candidate.runtimeArgs.every((argument) => typeof argument === 'string')) {
      throw new Error('The qdroid-runsc runtime arguments are invalid.');
    }

    return {
      path: candidate.path,
      runtimeArgs: candidate.runtimeArgs,
    };
  }

  private async readDockerStorageDevice(): Promise<string> {
    const source = await runCommand('findmnt', ['-no', 'SOURCE', '/var/lib/docker']);
    const sourceDevice = source.stdout.trim().split('[')[0];

    if (source.exitCode !== 0 || sourceDevice !== '/dev/vdb1') {
      throw new Error('Docker storage is not on the fixed T002 backing partition.');
    }

    const parent = await runCommand('lsblk', ['-no', 'PKNAME', '/dev/vdb1']);

    if (parent.exitCode !== 0 || parent.stdout.trim() !== 'vdb') {
      throw new Error('Docker storage does not map to the fixed T002 I/O device.');
    }

    return `/dev/${parent.stdout.trim()}`;
  }

  private async readRuntimeComponents(runtimePath: string): Promise<Record<string, string>> {
    const componentPaths = [runtimePath, ...GVISOR_COMPONENT_PATHS];
    const checksums = await Promise.all(
      componentPaths.map(async (componentPath) => {
        const checksum = await runCommand('sha256sum', [componentPath]);

        if (checksum.exitCode !== 0) {
          throw new Error('A required qdroid-runsc runtime component is unavailable.');
        }

        const digest = checksum.stdout.trim().split(/\s+/)[0];

        if (digest === undefined || !/^[0-9a-f]{64}$/i.test(digest)) {
          throw new Error('A required qdroid-runsc runtime component has an invalid checksum.');
        }

        return [componentPath, digest] as const;
      }),
    );

    return Object.fromEntries(checksums);
  }

  private async readImageInfo(): Promise<{
    architecture: string;
    id: string;
    labels: Record<string, string>;
    os: string;
  }> {
    const result = await runDocker(['image', 'inspect', this.options.image]);
    const parsed = JSON.parse(result.stdout) as unknown;

    if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
      throw new Error('The final fixture image could not be inspected.');
    }

    const image = parsed[0];
    const config = isRecord(image.Config) ? image.Config : undefined;
    const labels = isRecord(config?.Labels) ? config.Labels : undefined;

    if (
      typeof image.Id !== 'string' ||
      typeof image.Os !== 'string' ||
      typeof image.Architecture !== 'string' ||
      labels === undefined ||
      !Object.values(labels).every((value) => typeof value === 'string')
    ) {
      throw new Error('The final fixture image metadata is invalid.');
    }

    return {
      architecture: image.Architecture,
      id: image.Id,
      labels: labels as Record<string, string>,
      os: image.Os,
    };
  }

  /**
   * The manager owns every Docker argument, but qualification also inspects a
   * created container. This catches a Docker/runtime translation that does not
   * materialize the intended profile.
   */
  private async inspectFixedContainerProfile(image: string): Promise<void> {
    const name = `profile-${randomUUID()}`;
    await this.createTaskContainer(
      name,
      ['create', '--name', name, ...this.fixedDockerArguments(), image],
      'The fixed-profile container could not be created.',
    );

    try {
      const inspected = await runDocker(['inspect', name]);
      const container = parseSingleDockerObject(
        inspected,
        'The fixed profile could not be inspected.',
      );
      const config = isRecord(container.Config) ? container.Config : undefined;
      const hostConfig = isRecord(container.HostConfig) ? container.HostConfig : undefined;

      if (
        config === undefined ||
        hostConfig === undefined ||
        !matchesFixedProfile(config, hostConfig, container)
      ) {
        throw new Error('The created container does not match the fixed sandbox profile.');
      }
    } finally {
      await this.removeContainer(name);
    }
  }

  private async removeContainer(name: string): Promise<void> {
    const removed = await runDocker(['rm', '--force', name]);

    if (removed.exitCode !== 0) {
      throw new Error('The fixed-profile container could not be removed.');
    }
  }

  private async createTaskContainer(
    name: string,
    argumentsValue: string[],
    failureMessage: string,
  ): Promise<void> {
    let failure: Error | undefined;

    try {
      const created = await runDocker(argumentsValue);

      if (created.exitCode === 0) {
        return;
      }

      failure = new Error(failureMessage);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(failureMessage);
    }

    try {
      await this.removeContainer(name);
    } catch {
      throw new Error(`${failureMessage} The task-owned container cleanup could not be confirmed.`);
    }

    throw failure;
  }

  private async runQualificationProbes(image: string): Promise<QualificationProbes> {
    const canaryPath = `/tmp/qdroid-t002-canary-${randomUUID()}`;
    const secretPath = `/tmp/qdroid-t002-secret-${randomUUID()}`;
    const storePath = `/tmp/qdroid-t002-store-${randomUUID()}`;
    const canaryContents = 'qdroid-synthetic-canary';
    const secretContents = 'qdroid-synthetic-secret';
    const storeContents = 'qdroid-trusted-store';
    await writeFile(canaryPath, canaryContents, { mode: 0o644 });
    await chmod(canaryPath, 0o644);
    await writeFile(secretPath, secretContents, { mode: 0o600 });
    await chmod(secretPath, 0o600);
    await writeFile(storePath, storeContents, { mode: 0o600 });
    await chmod(storePath, 0o600);

    const hostInputsAreReadable =
      (await readFile(canaryPath, 'utf8')) === canaryContents &&
      (await readFile(secretPath, 'utf8')) === secretContents &&
      (await readFile(storePath, 'utf8')) === storeContents;

    if (!hostInputsAreReadable) {
      throw new Error('The host qualification inputs could not be read before qualification.');
    }

    try {
      await this.inspectFixedContainerProfile(image);
      const filesystem = await this.runJsonProbe(
        'filesystem',
        [canaryPath, secretPath, storePath],
        image,
      );
      const hostCanaryUnchanged =
        (await readFile(canaryPath, 'utf8')) === canaryContents &&
        (await readFile(secretPath, 'utf8')) === secretContents &&
        (await readFile(storePath, 'utf8')) === storeContents;
      const scratchFirst = await this.runJsonProbe('scratch-write', ['isolation-marker'], image);
      const scratchSecond = await this.runJsonProbe('scratch-read', ['isolation-marker'], image);
      const network = await this.runNetworkProbe(image);
      const cpu = await this.runJsonProbe('cpu', [], image);
      const pids = await this.runJsonProbe('pids', [], image);
      const scratch = await this.runJsonProbe('scratch-enospc', [], image);
      const memory = await this.runMemoryProbe(image);
      const outputLimit = await this.runOutputLimitProbe(image);
      const descendantCleanup = await this.runDescendantCleanupProbe(image);
      const io = await this.runIoProbe(image);
      const cpuToWallRatio = readNumber(cpu, 'cpuToWallRatio');
      const dockerSocketStatus = readString(filesystem, 'dockerSocketStatus');
      const dockerSocketUnreadable = isDockerSocketUnavailable(dockerSocketStatus);
      const pidsForkDenied = readBoolean(pids, 'forkDenied');
      const scratchEnospc = readBoolean(scratch, 'enospc');

      if (
        readBoolean(filesystem, 'nonRoot') !== true ||
        readBoolean(filesystem, 'readOnlyRoot') !== true ||
        readBoolean(filesystem, 'rootMountReadOnly') !== true ||
        readBoolean(filesystem, 'canaryUnreadable') !== true ||
        readBoolean(filesystem, 'canaryWriteAttempted') !== true ||
        hostCanaryUnchanged !== true ||
        dockerSocketUnreadable !== true ||
        readBoolean(filesystem, 'syntheticSecretUnreadable') !== true ||
        readBoolean(filesystem, 'trustedStoreUnreadable') !== true ||
        readBoolean(filesystem, 'readableControlReadFails') !== false ||
        readBoolean(filesystem, 'syntheticSocketReachable') !== true ||
        readBoolean(filesystem, 'capEff') !== true ||
        readBoolean(filesystem, 'noNewPrivileges') !== true ||
        readBoolean(scratchFirst, 'wrote') !== true ||
        readBoolean(scratchSecond, 'present') !== false ||
        network.controlTargetReachable !== true ||
        network.controlTargetReceivedPackets !== 0 ||
        cpuToWallRatio > 0.8 ||
        pidsForkDenied !== true ||
        scratchEnospc !== true ||
        memory.oomKilled !== true ||
        outputLimit.enforced !== true ||
        descendantCleanup.confirmed !== true ||
        descendantCleanup.descendantsObserved !== true ||
        io.cgroupCpuQuotaMicros !== 50_000 ||
        io.cgroupCpuPeriodMicros !== 100_000 ||
        io.cgroupHostPidsLimit !== FIXED_READONLY_PROFILE.hostPids ||
        io.cgroupReadBytesObserved <= 0 ||
        io.elapsedMs < MIN_IO_PROBE_DURATION_MS
      ) {
        const probeSummary = {
          canaryUnreadable: readBoolean(filesystem, 'canaryUnreadable'),
          canaryWriteAttempted: readBoolean(filesystem, 'canaryWriteAttempted'),
          cpuToWallRatio,
          descendantCleanupConfirmed: descendantCleanup.confirmed,
          descendantObservation: descendantCleanup.observation,
          descendantsObserved: descendantCleanup.descendantsObserved,
          dockerSocketStatus,
          dockerSocketUnreadable,
          hostCanaryUnchanged,
          cgroupCpuPeriodMicros: io.cgroupCpuPeriodMicros,
          cgroupCpuQuotaMicros: io.cgroupCpuQuotaMicros,
          cgroupHostPidsLimit: io.cgroupHostPidsLimit,
          ioReadBytesObserved: io.cgroupReadBytesObserved,
          ioElapsedMs: io.elapsedMs,
          memoryOomKilled: memory.oomKilled,
          networkReceivedPackets: network.controlTargetReceivedPackets,
          networkControlReceipts: network.controlTargetReceipts,
          noNewPrivileges: readBoolean(filesystem, 'noNewPrivileges'),
          nonRoot: readBoolean(filesystem, 'nonRoot'),
          outputLimitEnforced: outputLimit.enforced,
          pidsForkDenied,
          readOnlyRoot: readBoolean(filesystem, 'readOnlyRoot'),
          readableControlReadFails: readBoolean(filesystem, 'readableControlReadFails'),
          rootMountReadOnly: readBoolean(filesystem, 'rootMountReadOnly'),
          scratchEnospc,
          scratchIsPrivate:
            readBoolean(scratchFirst, 'wrote') === true &&
            readBoolean(scratchSecond, 'present') === false,
          syntheticSecretUnreadable: readBoolean(filesystem, 'syntheticSecretUnreadable'),
          trustedStoreUnreadable: readBoolean(filesystem, 'trustedStoreUnreadable'),
          syntheticSocketReachable: readBoolean(filesystem, 'syntheticSocketReachable'),
          zeroEffectiveCapabilities: readBoolean(filesystem, 'capEff'),
        };

        throw new Error(
          `One or more fixed-profile qualification probes did not pass: ${JSON.stringify(probeSummary)}`,
        );
      }

      return {
        cpu: {
          cpuToWallRatio,
        },
        deadline: {
          enforced: descendantCleanup.stopReason === 'deadline',
        },
        descendantCleanup,
        filesystem: {
          canaryUnreadable: readBoolean(filesystem, 'canaryUnreadable'),
          canaryUnmodified: hostCanaryUnchanged,
          dockerSocketStatus: asDockerSocketAccessStatus(dockerSocketStatus),
          dockerSocketUnreadable,
          hostCanaryUnchanged,
          noNewPrivileges: readBoolean(filesystem, 'noNewPrivileges'),
          nonRoot: readBoolean(filesystem, 'nonRoot'),
          privateScratch:
            readBoolean(scratchFirst, 'wrote') === true &&
            readBoolean(scratchSecond, 'present') === false,
          readOnlyRoot: readBoolean(filesystem, 'readOnlyRoot'),
          rootMountReadOnly: readBoolean(filesystem, 'rootMountReadOnly'),
          syntheticSecretUnreadable: readBoolean(filesystem, 'syntheticSecretUnreadable'),
          trustedStoreUnreadable: readBoolean(filesystem, 'trustedStoreUnreadable'),
          zeroEffectiveCapabilities: readBoolean(filesystem, 'capEff'),
        },
        io,
        memory,
        network,
        outputLimit,
        pids: {
          forkDenied: pidsForkDenied,
        },
        scratch: {
          enospc: scratchEnospc,
        },
      };
    } finally {
      await Promise.all([
        rm(canaryPath, { force: true }),
        rm(secretPath, { force: true }),
        rm(storePath, { force: true }),
      ]);
    }
  }

  private async runJsonProbe(
    mode: string,
    argumentsValue: string[],
    image: string,
  ): Promise<Record<string, ProbeValue>> {
    const result = await this.runStreamingContainer(
      `probe-${randomUUID()}`,
      ['/opt/qdroid/probe.mjs', mode, ...argumentsValue],
      () => undefined,
      10_000,
      MAX_STDIO_FRAME_BYTES,
      false,
      {
        entrypoint: '/usr/local/bin/node',
      },
      image,
    );

    if (result.stopReason !== 'completed' || result.exitCode !== 0) {
      throw new Error(`The ${mode} probe did not complete successfully.`);
    }

    const parsed = JSON.parse(result.stdout) as unknown;

    if (!isRecord(parsed)) {
      throw new Error(`The ${mode} probe did not return a JSON object.`);
    }

    return parsed as Record<string, ProbeValue>;
  }

  private async runMemoryProbe(image: string): Promise<{ oomKilled: boolean }> {
    const name = `memory-${randomUUID()}`;
    await this.createTaskContainer(
      name,
      [
        'create',
        '--name',
        name,
        ...this.fixedDockerArguments(),
        '--entrypoint',
        '/usr/local/bin/node',
        image,
        '/opt/qdroid/probe.mjs',
        'memory',
      ],
      'The memory probe container could not be created.',
    );

    try {
      const result = await this.attachToContainer(
        name,
        () => undefined,
        10_000,
        MAX_STDIO_FRAME_BYTES,
        false,
      );
      const inspected = await runDocker(['inspect', name, '--format', '{{.State.OOMKilled}}']);

      return {
        oomKilled: inspected.stdout.trim() === 'true' && result.exitCode === 137,
      };
    } finally {
      await this.removeContainer(name);
    }
  }

  private async runNetworkProbe(image: string): Promise<{
    controlTargetReachable: boolean;
    controlTargetReceipts: NetworkControlReceipts;
    controlTargetReceivedPackets: number;
  }> {
    const target = await SyntheticNetworkTarget.create();

    try {
      const probe = await this.runJsonProbe(
        'network',
        [JSON.stringify(target.connectionInfo)],
        image,
      );
      await target.waitForSettling();

      if (probe.attempted !== 4) {
        throw new Error('The network probe did not attempt every fixed control target.');
      }

      return {
        controlTargetReachable: target.reachable,
        controlTargetReceipts: target.controlReceipts,
        controlTargetReceivedPackets: target.receivedPackets,
      };
    } finally {
      await target.close();
    }
  }

  private async createQualificationIoFile(): Promise<QualificationIoFile> {
    const root = await this.verifyQualificationIoRoot();
    const sourcePath = join(root, `io-${randomUUID()}.bin`);
    const file = await open(sourcePath, 'wx', 0o644);
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);

    try {
      for (let written = 0; written < IO_QUALIFICATION_FILE_BYTES; written += chunk.byteLength) {
        const result = await file.write(chunk, 0, chunk.byteLength, null);

        if (result.bytesWritten !== chunk.byteLength) {
          throw new Error('The synthetic I/O qualification file was written partially.');
        }
      }

      await file.sync();
    } catch (error) {
      await file.close();
      await rm(sourcePath, { force: true });
      throw error;
    }

    await file.close();

    try {
      await this.verifyQualificationIoFile(sourcePath, root);
      const cacheDrop = await runCommand('dd', [
        `if=${sourcePath}`,
        'iflag=nocache',
        'count=0',
        'status=none',
      ]);

      if (cacheDrop.exitCode !== 0) {
        throw new Error('The synthetic I/O qualification file cache request did not complete.');
      }
    } catch (error) {
      await rm(sourcePath, { force: true });
      throw error;
    }

    return {
      dispose: async () => {
        await this.verifyQualificationIoFile(sourcePath, root);
        await rm(sourcePath);
      },
      sourcePath,
      targetPath: IO_QUALIFICATION_CONTAINER_PATH,
    };
  }

  private async verifyQualificationIoRoot(): Promise<string> {
    const rootLink = await lstat(IO_QUALIFICATION_ROOT);
    const root = await realpath(IO_QUALIFICATION_ROOT);
    const rootStatus = await stat(root);
    const { gid: currentGid, uid: currentUid } = currentProcessIds();

    if (
      root !== IO_QUALIFICATION_ROOT ||
      rootLink.isSymbolicLink() ||
      !rootStatus.isDirectory() ||
      rootStatus.uid !== currentUid ||
      rootStatus.gid !== currentGid ||
      (rootStatus.mode & 0o777) !== 0o700
    ) {
      throw new Error(
        'The synthetic I/O qualification root is not a private broker-owned directory.',
      );
    }

    const source = await runCommand('findmnt', ['-no', 'SOURCE', '--target', root]);
    const sourceDevice = source.stdout.trim().split('[')[0];

    if (source.exitCode !== 0 || sourceDevice !== '/dev/vdb1') {
      throw new Error(
        'The synthetic I/O qualification root is not on the fixed backing partition.',
      );
    }

    const parent = await runCommand('lsblk', ['-no', 'PKNAME', sourceDevice]);
    const deviceNumber = await runCommand('stat', ['-Lc', '%t:%T', IO_DEVICE]);

    if (
      parent.exitCode !== 0 ||
      parent.stdout.trim() !== 'vdb' ||
      deviceNumber.exitCode !== 0 ||
      deviceNumber.stdout.trim().toLowerCase() !== 'fd:10'
    ) {
      throw new Error('The synthetic I/O qualification root does not map to the fixed I/O device.');
    }

    return root;
  }

  private async verifyQualificationIoFile(sourcePath: string, root: string): Promise<void> {
    const fileLink = await lstat(sourcePath);
    const resolvedPath = await realpath(sourcePath);
    const fileStatus = await stat(resolvedPath);
    const { gid: currentGid, uid: currentUid } = currentProcessIds();

    if (
      !resolvedPath.startsWith(`${root}/`) ||
      fileLink.isSymbolicLink() ||
      !fileStatus.isFile() ||
      fileStatus.uid !== currentUid ||
      fileStatus.gid !== currentGid ||
      (fileStatus.mode & 0o777) !== 0o644 ||
      fileStatus.size !== IO_QUALIFICATION_FILE_BYTES ||
      fileStatus.blocks * 512 < IO_QUALIFICATION_FILE_BYTES
    ) {
      throw new Error(
        'The synthetic I/O qualification file is not a private non-sparse regular file.',
      );
    }
  }

  private async runIoProbe(image: string): Promise<QualificationProbes['io']> {
    const name = `io-${randomUUID()}`;
    const ioFile = await this.createQualificationIoFile();
    const startedAt = Date.now();
    const phases = {
      baselineCapture: false,
      baselineCaptureResolved: false,
      readCapture: false,
      readCommandSent: false,
      readComplete: false,
      ready: false,
    };
    let baselineCapture:
      | Promise<{
          cpuMaximum: string;
          maximum: string;
          pidsMaximum: string;
          statistics: string;
        }>
      | undefined;
    let readCapture:
      | Promise<{
          cpuMaximum: string;
          maximum: string;
          pidsMaximum: string;
          statistics: string;
        }>
      | undefined;
    let elapsedMs: number | undefined;
    let baselineError: Error | undefined;
    let stdoutBuffer = '';

    try {
      const result = await this.runStreamingContainer(
        name,
        ['/opt/qdroid/probe.mjs', 'io'],
        (chunk, stdin) => {
          stdoutBuffer += chunk.toString('utf8');

          for (;;) {
            const newline = stdoutBuffer.indexOf('\n');

            if (newline === -1) {
              break;
            }

            const line = stdoutBuffer.slice(0, newline);
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            const probe = JSON.parse(line) as unknown;

            if (!isRecord(probe) || typeof probe.phase !== 'string') {
              throw new Error('The fixed-profile I/O probe returned an invalid status frame.');
            }

            if (probe.phase === 'ready') {
              phases.ready = true;

              if (baselineCapture !== undefined) {
                throw new Error('The fixed-profile I/O probe reported more than one ready state.');
              }

              phases.baselineCapture = true;
              baselineCapture = this.readContainerIoCgroup(name, 1_000);
              void baselineCapture
                .then(() => {
                  stdin.write('read\n');
                  phases.baselineCaptureResolved = true;
                  phases.readCommandSent = true;
                })
                .catch((error: unknown) => {
                  baselineError =
                    error instanceof Error ? error : new Error('I/O baseline failed.');
                  stdin.end();
                });
              continue;
            }

            if (probe.phase !== 'read-complete' || readCapture !== undefined) {
              throw new Error(
                'The fixed-profile I/O probe did not report one completed direct read.',
              );
            }

            const readCompletion = probe as Record<string, ProbeValue>;
            phases.readComplete = true;
            elapsedMs = readNumber(readCompletion, 'elapsedMs');
            phases.readCapture = true;
            readCapture = this.readContainerIoCgroup(name, 1_000);
            void readCapture.catch(() => undefined);
          }
        },
        25_000,
        MAX_STDIO_FRAME_BYTES,
        false,
        {
          entrypoint: '/usr/local/bin/node',
          qualificationReadOnlyMount: ioFile,
        },
        image,
      );

      if (baselineError !== undefined) {
        throw new Error(
          `${baselineError.message}: ` +
            `${formatIoProbeDiagnostic(result, phases, elapsedMs, Date.now() - startedAt)}`,
        );
      }

      if (result.stopReason !== 'completed' || result.exitCode !== 0) {
        throw new Error(
          `The fixed-profile I/O probe did not complete successfully: ` +
            `${formatIoProbeDiagnostic(result, phases, elapsedMs, Date.now() - startedAt)}`,
        );
      }

      if (elapsedMs === undefined || baselineCapture === undefined || readCapture === undefined) {
        throw new Error(
          `The fixed-profile I/O probe did not provide live read-completion evidence: ` +
            `${formatIoProbeDiagnostic(result, phases, elapsedMs, Date.now() - startedAt)}`,
        );
      }

      const [baseline, readComplete] = await Promise.all([baselineCapture, readCapture]);
      const cgroupReadLimitBytesPerSecond = readCgroupRate(readComplete.maximum, 'rbps');
      const cgroupWriteLimitBytesPerSecond = readCgroupRate(readComplete.maximum, 'wbps');
      const baselineReadBytes = readCgroupReadBytesOrZero(baseline.statistics);
      const cgroupReadBytesObserved = readCgroupReadBytes(readComplete.statistics);
      const cgroupReadBytesDelta = cgroupReadBytesObserved - baselineReadBytes;
      const [cgroupCpuQuotaMicros, cgroupCpuPeriodMicros] = readCpuMaximum(readComplete.cpuMaximum);
      const cgroupHostPidsLimit = readPidsMaximum(readComplete.pidsMaximum);

      if (
        cgroupReadLimitBytesPerSecond !== FIXED_READONLY_PROFILE.ioBytesPerSecond ||
        cgroupWriteLimitBytesPerSecond !== FIXED_READONLY_PROFILE.ioBytesPerSecond ||
        cgroupCpuQuotaMicros !== 50_000 ||
        cgroupCpuPeriodMicros !== 100_000 ||
        cgroupHostPidsLimit !== FIXED_READONLY_PROFILE.hostPids ||
        cgroupReadBytesDelta < IO_QUALIFICATION_FILE_BYTES
      ) {
        throw new Error(
          `The actual cgroup resource controls do not match the fixed profile: ` +
            `${formatIoProbeDiagnostic(result, phases, elapsedMs, Date.now() - startedAt)}`,
        );
      }

      return {
        cgroupCpuPeriodMicros,
        cgroupCpuQuotaMicros,
        cgroupHostPidsLimit,
        cgroupReadBytesObserved: cgroupReadBytesDelta,
        cgroupReadLimitBytesPerSecond,
        elapsedMs,
        qualificationSyntheticFileBytes: IO_QUALIFICATION_FILE_BYTES,
      };
    } finally {
      await ioFile.dispose();
    }
  }

  private async readContainerIoCgroup(
    name: string,
    timeoutMs: number,
  ): Promise<{
    cpuMaximum: string;
    maximum: string;
    pidsMaximum: string;
    statistics: string;
  }> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const inspected = await runDocker([
        'inspect',
        name,
        '--format',
        '{{.State.Pid}} {{.State.Running}}',
      ]);
      const [pidValue, running] = inspected.stdout.trim().split(' ');
      const pid = Number.parseInt(pidValue ?? '', 10);

      if (inspected.exitCode === 0 && running === 'true' && Number.isSafeInteger(pid) && pid > 0) {
        const cgroupContents = await readFile(`/proc/${pid}/cgroup`, 'utf8');
        const cgroupPath = cgroupContents
          .split('\n')
          .map((line) => line.split(':'))
          .find((fields) => fields[0] === '0' && fields[1] === '')?.[2];

        if (cgroupPath !== undefined && /^\/docker\/[0-9a-f]+$/i.test(cgroupPath)) {
          const cgroupDirectory = `/sys/fs/cgroup${cgroupPath}`;
          const [maximum, statistics, cpuMaximum, pidsMaximum] = await Promise.all([
            readFile(`${cgroupDirectory}/io.max`, 'utf8'),
            readFile(`${cgroupDirectory}/io.stat`, 'utf8'),
            readFile(`${cgroupDirectory}/cpu.max`, 'utf8'),
            readFile(`${cgroupDirectory}/pids.max`, 'utf8'),
          ]);

          return { cpuMaximum, maximum, pidsMaximum, statistics };
        }
      }

      await delay(100);
    }

    throw new Error('The fixed-profile I/O probe did not expose a trusted cgroup-v2 path.');
  }

  private async waitForContainerExit(name: string, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const inspected = await runDocker([
        'inspect',
        name,
        '--format',
        '{{.State.Running}} {{.State.ExitCode}}',
      ]);
      const [running, exitCodeValue] = inspected.stdout.trim().split(' ');

      if (inspected.exitCode === 0 && running === 'false') {
        const exitCode = Number.parseInt(exitCodeValue ?? '', 10);

        if (Number.isSafeInteger(exitCode)) {
          return exitCode;
        }
      }

      await delay(100);
    }

    await runDocker(['stop', '--time', '1', name]);
    throw new Error('The fixed-profile I/O probe exceeded its deadline.');
  }

  private async runOutputLimitProbe(image: string): Promise<{ enforced: boolean }> {
    const result = await this.runStreamingContainer(
      `output-${randomUUID()}`,
      ['spam-output'],
      () => undefined,
      WORKLOAD_DEADLINE_MS,
      MAX_WORKLOAD_OUTPUT_BYTES,
      false,
      {},
      image,
    );

    return {
      enforced: result.stopReason === 'output-limit' && result.cleanupConfirmed,
    };
  }

  private async runDescendantCleanupProbe(image: string): Promise<{
    confirmed: boolean;
    descendantsObserved: boolean;
    observation: DescendantObservation;
    stopReason: 'completed' | 'deadline' | 'output-limit';
  }> {
    const result = await this.runStreamingContainer(
      `descendant-${randomUUID()}`,
      ['hold-child'],
      () => undefined,
      2_000,
      MAX_WORKLOAD_OUTPUT_BYTES,
      true,
      {},
      image,
    );

    return {
      confirmed: result.cleanupConfirmed && result.stopReason === 'deadline',
      descendantsObserved: result.descendantsObserved,
      observation: result.descendantObservation,
      stopReason: result.stopReason,
    };
  }

  private async runStreamingContainer(
    name: string,
    workloadArguments: string[],
    onStdout: (chunk: Buffer, stdin: NodeJS.WritableStream) => void,
    deadlineMs: number,
    maxOutputBytes: number,
    observeDescendants: boolean,
    options: {
      entrypoint?: string;
      qualificationReadOnlyMount?: QualificationReadOnlyMount;
    } = {},
    image = this.options.image,
  ): Promise<RunningProcessResult> {
    const entrypointArguments =
      options.entrypoint === undefined ? [] : ['--entrypoint', options.entrypoint];
    const qualificationMountArguments =
      options.qualificationReadOnlyMount === undefined
        ? []
        : [
            '--mount',
            [
              'type=bind',
              `src=${options.qualificationReadOnlyMount.sourcePath}`,
              `dst=${options.qualificationReadOnlyMount.targetPath}`,
              'readonly',
              'bind-propagation=rprivate',
            ].join(','),
          ];
    await this.createTaskContainer(
      name,
      [
        'create',
        '--name',
        name,
        ...this.fixedDockerArguments(),
        '--label',
        `io.qdroid.sandbox=${name}`,
        ...entrypointArguments,
        ...qualificationMountArguments,
        image,
        ...workloadArguments,
      ],
      'The fixed-profile workload container could not be created.',
    );

    let result: RunningProcessResult | undefined;

    try {
      if (options.qualificationReadOnlyMount !== undefined) {
        await this.verifyQualificationReadOnlyMount(name, options.qualificationReadOnlyMount);
      }

      result = await this.attachToContainer(
        name,
        onStdout,
        deadlineMs,
        maxOutputBytes,
        observeDescendants,
      );
    } finally {
      const removed = await runDocker(['rm', '--force', name]);

      if (removed.exitCode !== 0) {
        if (result === undefined) {
          throw new Error('The fixed-profile workload container could not be removed.');
        }

        result.cleanupConfirmed = false;
      }
    }

    if (result === undefined) {
      throw new Error('The fixed-profile workload did not produce a result.');
    }

    return result;
  }

  private async verifyQualificationReadOnlyMount(
    name: string,
    expected: QualificationReadOnlyMount,
  ): Promise<void> {
    const inspected = await runDocker(['inspect', name]);
    const container = parseSingleDockerObject(
      inspected,
      'The synthetic I/O qualification mount could not be inspected.',
    );
    const mounts = container.Mounts;

    if (!Array.isArray(mounts) || mounts.length !== 1 || !isRecord(mounts[0])) {
      throw new Error('The synthetic I/O qualification mount is not the only container mount.');
    }

    const mount = mounts[0];

    if (
      mount.Type !== 'bind' ||
      mount.Source !== expected.sourcePath ||
      mount.Destination !== expected.targetPath ||
      mount.RW !== false ||
      mount.Propagation !== 'rprivate'
    ) {
      throw new Error(
        'The synthetic I/O qualification mount does not match the fixed readonly form.',
      );
    }
  }

  private async attachToContainer(
    name: string,
    onStdout: (chunk: Buffer, stdin: NodeJS.WritableStream) => void,
    deadlineMs: number,
    maxOutputBytes: number,
    observeDescendants: boolean,
  ): Promise<RunningProcessResult> {
    const deadlineAt = Date.now() + deadlineMs;
    let outputBytes = 0;
    let stderr = '';
    let stdout = '';
    let stopReason: RunningProcessResult['stopReason'] = 'completed';
    let outputLimited = false;
    let stopPromise: Promise<void> | undefined;
    let notifyStopCompletion: ((stop: Promise<void>) => void) | undefined;
    let callbackFailure: unknown;
    const attached = spawn('docker', ['start', '--attach', '--interactive', name], {
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const processClosed = waitForProcessClose(attached);
    let attachClosed = false;
    void processClosed.then(
      () => {
        attachClosed = true;
      },
      () => {
        attachClosed = true;
      },
    );
    void processClosed.catch(() => undefined);
    const stopCompleted = new Promise<void>((resolve, reject) => {
      notifyStopCompletion = (stop) => {
        void stop.then(resolve, reject);
      };
    });
    void stopCompleted.catch(() => undefined);
    const terminateAttachedProcess = (): void => {
      try {
        if (process.platform !== 'win32' && attached.pid !== undefined) {
          process.kill(-attached.pid, 'SIGKILL');
          return;
        }
      } catch {
        // The attach process may have exited while Docker stop was returning.
      }

      attached.kill('SIGKILL');
    };
    const requestStop = (reason: RunningProcessResult['stopReason']): Promise<void> => {
      if (stopPromise !== undefined) {
        return stopPromise;
      }

      stopReason = reason;
      outputLimited = reason === 'output-limit';
      stopPromise = (async () => {
        let stopFailure: Error | undefined;

        try {
          const stopped = await runDocker(['stop', '--time', '1', name]);

          if (stopped.exitCode !== 0) {
            stopFailure = new Error('The fixed-profile workload container could not be stopped.');
          }
        } catch (error) {
          stopFailure = error instanceof Error ? error : new Error('Docker stop did not complete.');
        } finally {
          terminateAttachedProcess();
          await waitForProcessCloseWithin(processClosed, ATTACH_TERMINATION_GRACE_MS);
        }

        if (stopFailure !== undefined) {
          throw stopFailure;
        }
      })();
      notifyStopCompletion?.(stopPromise);
      return stopPromise;
    };
    const requestStopWithoutUnhandledRejection = (
      reason: RunningProcessResult['stopReason'],
    ): void => {
      void requestStop(reason).catch(() => undefined);
    };
    const remainingDeadlineMs = Math.max(0, deadlineAt - Date.now());
    const deadline = setTimeout(() => {
      requestStopWithoutUnhandledRejection('deadline');
    }, remainingDeadlineMs);

    attached.stdin.on('error', (error) => {
      if (callbackFailure === undefined) {
        callbackFailure = error;
      }

      requestStopWithoutUnhandledRejection('deadline');
    });

    attached.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;

      if (outputBytes > maxOutputBytes) {
        requestStopWithoutUnhandledRejection('output-limit');
        return;
      }

      stdout = appendBounded(stdout, chunk);

      try {
        onStdout(chunk, attached.stdin);
      } catch (error) {
        callbackFailure = error;
        requestStopWithoutUnhandledRejection('deadline');
      }
    });
    attached.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;

      if (outputBytes > maxOutputBytes) {
        requestStopWithoutUnhandledRejection('output-limit');
        return;
      }

      stderr = appendBounded(stderr, chunk);
    });

    try {
      const descendantObservation = observeDescendants
        ? await this.observeDescendants(name, deadlineAt, () => attachClosed)
        : emptyDescendantObservation();
      await Promise.race([processClosed, stopCompleted]);
      await stopPromise;

      if (callbackFailure !== undefined) {
        throw callbackFailure;
      }

      const inspected = await runDocker([
        'inspect',
        name,
        '--format',
        '{{.State.Running}} {{.State.ExitCode}}',
      ]);
      const [running, exitCodeValue] = inspected.stdout.trim().split(' ');
      const exitCode = Number.parseInt(exitCodeValue ?? '', 10);

      return {
        cleanupConfirmed: inspected.exitCode === 0 && running === 'false',
        descendantObservation,
        descendantsObserved: descendantObservation.observed,
        exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
        outputLimited,
        stderr,
        stopReason,
        stdout,
      };
    } finally {
      clearTimeout(deadline);
      const inspected = await runDocker(['inspect', name, '--format', '{{.State.Running}}']);

      if (inspected.exitCode === 0 && inspected.stdout.trim() === 'true') {
        await requestStop('deadline');
      }
    }
  }

  private async observeDescendants(
    name: string,
    deadlineAt: number,
    isAttachClosed: () => boolean,
  ): Promise<DescendantObservation> {
    let attempts = 0;
    let lastExecExitCode: number | null = null;
    let lastObservedChild: DescendantObservation['lastObservedChild'] = null;
    let lastObserverPid: number | null = null;
    let observerExcluded = false;

    while (Date.now() < deadlineAt && !isAttachClosed()) {
      const remainingDeadlineMs = deadlineAt - Date.now();
      const observer = await runDocker(
        [
          'exec',
          '--user',
          FIXED_READONLY_PROFILE.user,
          name,
          '/usr/local/bin/node',
          '/opt/qdroid/probe.mjs',
          'process-table',
        ],
        {
          maxOutputBytes: MAX_STDIO_FRAME_BYTES,
          timeoutMs: remainingDeadlineMs,
        },
      );
      attempts += 1;
      lastExecExitCode = observer.exitCode;

      if (observer.outputLimited) {
        throw new Error('The fixed-profile descendant observer exceeded its output limit.');
      }

      if (observer.exitCode === 0) {
        const observation = parseGuestProcessObservation(observer.stdout);
        lastObserverPid = observation.observerPid;
        const child = observation.processes.find(
          (process) =>
            process.pid > 1 && process.ppid === 1 && process.pid !== observation.observerPid,
        );
        observerExcluded = true;
        lastObservedChild = child ?? null;

        if (child !== undefined) {
          return {
            attempts,
            lastExecExitCode,
            lastObservedChild,
            lastObserverPid,
            observerExcluded,
            observed: true,
          };
        }
      }

      const remainingDelayMs = deadlineAt - Date.now();

      if (remainingDelayMs > 0 && !isAttachClosed()) {
        await delay(Math.min(50, remainingDelayMs));
      }
    }

    return {
      attempts,
      lastExecExitCode,
      lastObservedChild,
      lastObserverPid,
      observerExcluded,
      observed: false,
    };
  }

  private fixedDockerArguments(): string[] {
    return [
      '--runtime',
      FIXED_READONLY_PROFILE.runtime,
      '--network',
      FIXED_READONLY_PROFILE.network,
      '--log-driver',
      'none',
      '--interactive',
      '--read-only',
      '--user',
      FIXED_READONLY_PROFILE.user,
      '--cap-drop',
      FIXED_READONLY_PROFILE.capDrop,
      '--security-opt',
      'no-new-privileges',
      '--memory',
      `${FIXED_READONLY_PROFILE.memoryMiB}m`,
      '--memory-swap',
      `${FIXED_READONLY_PROFILE.memoryMiB}m`,
      '--cpus',
      `${FIXED_READONLY_PROFILE.cpus}`,
      '--pids-limit',
      `${FIXED_READONLY_PROFILE.hostPids}`,
      '--ulimit',
      `nproc=${FIXED_READONLY_PROFILE.guestNproc}:${FIXED_READONLY_PROFILE.guestNproc}`,
      '--ulimit',
      'core=0:0',
      '--device-read-bps',
      `${FIXED_READONLY_PROFILE.ioDevice}:${FIXED_READONLY_PROFILE.ioBytesPerSecond}`,
      '--device-write-bps',
      `${FIXED_READONLY_PROFILE.ioDevice}:${FIXED_READONLY_PROFILE.ioBytesPerSecond}`,
      '--tmpfs',
      `/tmp:rw,noexec,nosuid,nodev,size=${FIXED_READONLY_PROFILE.scratchMiB}m`,
    ];
  }
}

function finalResponseRequestId(
  mode: WorkloadMode,
): 'cancel' | 'duplicate-key' | 'invoke' | 'unsupported' {
  if (mode === 'admission-cancel-first') {
    return 'cancel';
  }

  if (mode === 'duplicate-key') {
    return 'duplicate-key';
  }

  if (mode === 'unsupported-method') {
    return 'unsupported';
  }

  return 'invoke';
}

function emptyDescendantObservation(): DescendantObservation {
  return {
    attempts: 0,
    lastExecExitCode: null,
    lastObservedChild: null,
    lastObserverPid: null,
    observerExcluded: false,
    observed: false,
  };
}

function parseGuestProcessObservation(stdout: string): {
  observerPid: number;
  processes: Array<{ pid: number; ppid: number }>;
} {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('The fixed-profile descendant observer did not return valid JSON.');
  }

  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ['observerPid', 'processes'])) {
    throw new Error('The fixed-profile descendant observer returned an invalid JSON shape.');
  }

  const { observerPid, processes } = parsed;

  if (
    !isPositiveProcessId(observerPid) ||
    !Array.isArray(processes) ||
    processes.length > MAX_GUEST_PROCESS_ENTRIES
  ) {
    throw new Error('The fixed-profile descendant observer returned invalid process bounds.');
  }

  const seenPids = new Set<number>();
  const parsedProcesses = processes.map((process) => {
    if (!isRecord(process) || !hasOnlyKeys(process, ['pid', 'ppid'])) {
      throw new Error('The fixed-profile descendant observer returned an invalid process entry.');
    }

    const { pid, ppid } = process;

    if (!isPositiveProcessId(pid) || !isProcessParentId(ppid) || seenPids.has(pid)) {
      throw new Error('The fixed-profile descendant observer returned an invalid process table.');
    }

    seenPids.add(pid);
    return { pid, ppid };
  });

  if (!seenPids.has(observerPid)) {
    throw new Error('The fixed-profile descendant observer did not include itself.');
  }

  return {
    observerPid,
    processes: parsedProcesses,
  };
}

function hasOnlyKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function isPositiveProcessId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isProcessParentId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function formatIoProbeDiagnostic(
  result: RunningProcessResult,
  phases: {
    baselineCapture: boolean;
    baselineCaptureResolved: boolean;
    readCapture: boolean;
    readCommandSent: boolean;
    readComplete: boolean;
    ready: boolean;
  },
  guestReadElapsedMs: number | undefined,
  hostElapsedMs: number,
): string {
  const stdoutPhases = result.stdout
    .split(/\r?\n/)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;

        if (isRecord(value) && typeof value.phase === 'string') {
          return [value.phase];
        }
      } catch {
        // The full stdout remains bounded by the streaming limit. Diagnostics
        // only preserve recognized phase names.
      }

      return [];
    })
    .join(',');

  return JSON.stringify({
    cleanupConfirmed: result.cleanupConfirmed,
    exitCode: result.exitCode,
    guestReadElapsedMs,
    hostElapsedMs,
    phases,
    stderr: boundedSingleLine(result.stderr, 512),
    stdoutPhases: boundedSingleLine(stdoutPhases, 512),
    stopReason: result.stopReason,
  });
}

function boundedSingleLine(value: string, maxBytes: number): string {
  const singleLine = value.replace(/[\r\n]+/g, ' ');
  return Buffer.from(singleLine, 'utf8').subarray(0, maxBytes).toString('utf8');
}

class SyntheticNetworkTarget {
  private readonly received: Record<NetworkControlName, number> = {
    dnsUdp: 0,
    ipv6Tcp: 0,
    tcpIpv4: 0,
    udpIpv4: 0,
  };
  private readonly controls: NetworkControlReceipts = {
    dnsUdp: false,
    ipv6Tcp: false,
    tcpIpv4: false,
    udpIpv4: false,
  };
  private readonly tcpServer: Server;
  private readonly udpServer: DatagramSocket;
  private readonly dnsServer: DatagramSocket;
  private readonly ipv6Server: Server;
  private constructor(
    private readonly address: string,
    tcpServer: Server,
    udpServer: DatagramSocket,
    dnsServer: DatagramSocket,
    ipv6Server: Server,
    private readonly tcpPort: number,
    private readonly udpPort: number,
    private readonly dnsPort: number,
    private readonly ipv6Port: number,
  ) {
    this.tcpServer = tcpServer;
    this.udpServer = udpServer;
    this.dnsServer = dnsServer;
    this.ipv6Server = ipv6Server;
  }

  public static async create(): Promise<SyntheticNetworkTarget> {
    const address = findNonLoopbackIpv4();
    const tcpServer = createServer((socket) => socket.end());
    const udpServer = createSocket('udp4');
    const dnsServer = createSocket('udp4');
    const ipv6Server = createServer((socket) => socket.end());
    try {
      const tcpPort = await listenTcp(tcpServer, address);
      const udpPort = await bindUdp(udpServer, address);
      const dnsPort = await bindUdp(dnsServer, address);
      const ipv6Port = await listenTcp(ipv6Server, '::1');
      const target = new SyntheticNetworkTarget(
        address,
        tcpServer,
        udpServer,
        dnsServer,
        ipv6Server,
        tcpPort,
        udpPort,
        dnsPort,
        ipv6Port,
      );

      target.observeReceipts();
      await target.verifyBrokerControls();
      target.resetReceivedPackets();
      return target;
    } catch (error) {
      await Promise.allSettled([
        closeTcp(tcpServer),
        closeUdp(udpServer),
        closeUdp(dnsServer),
        closeTcp(ipv6Server),
      ]);
      throw error;
    }
  }

  public get connectionInfo(): Record<string, number | string> {
    return {
      dnsPort: this.dnsPort,
      host: this.address,
      ipv6Port: this.ipv6Port,
      tcpPort: this.tcpPort,
      udpPort: this.udpPort,
    };
  }

  public get reachable(): boolean {
    return hasAllNetworkControlReceipts(this.controls);
  }

  public get controlReceipts(): NetworkControlReceipts {
    return { ...this.controls };
  }

  public get receivedPackets(): number {
    return Object.values(this.received).reduce((total, received) => total + received, 0);
  }

  public async waitForSettling(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150);
    });
  }

  public async close(): Promise<void> {
    await Promise.all([
      closeTcp(this.tcpServer),
      closeUdp(this.udpServer),
      closeUdp(this.dnsServer),
      closeTcp(this.ipv6Server),
    ]);
  }

  private observeReceipts(): void {
    this.tcpServer.on('connection', () => {
      this.received.tcpIpv4 += 1;
    });
    this.udpServer.on('message', () => {
      this.received.udpIpv4 += 1;
    });
    this.dnsServer.on('message', () => {
      this.received.dnsUdp += 1;
    });
    this.ipv6Server.on('connection', () => {
      this.received.ipv6Tcp += 1;
    });
  }

  private async verifyBrokerControls(): Promise<void> {
    await this.verifyControl('tcpIpv4', () => connectTcp(this.address, this.tcpPort));
    await this.verifyControl('udpIpv4', () =>
      sendUdp(this.address, this.udpPort, udpControlPacket()),
    );
    await this.verifyControl('dnsUdp', () =>
      sendUdp(this.address, this.dnsPort, dnsControlPacket()),
    );
    await this.verifyControl('ipv6Tcp', () => connectTcp('::1', this.ipv6Port));
  }

  private async verifyControl(
    control: NetworkControlName,
    send: () => Promise<void>,
  ): Promise<void> {
    const receivedBefore = this.received[control];
    await send();

    const received = await waitForCondition(
      () => this.received[control] > receivedBefore,
      NETWORK_CONTROL_DEADLINE_MS,
    );

    if (!received) {
      throw new Error(`The synthetic ${control} control target is not reachable from the broker.`);
    }

    this.controls[control] = true;
  }

  private resetReceivedPackets(): void {
    this.received.dnsUdp = 0;
    this.received.ipv6Tcp = 0;
    this.received.tcpIpv4 = 0;
    this.received.udpIpv4 = 0;
  }
}

async function runDocker(
  argumentsValue: string[],
  options: {
    maxOutputBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<{ exitCode: number; outputLimited: boolean; stderr: string; stdout: string }> {
  return runCommand('docker', argumentsValue, options);
}

async function runCommand(
  command: string,
  argumentsValue: string[],
  options: {
    maxOutputBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<{ exitCode: number; outputLimited: boolean; stderr: string; stdout: string }> {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? TRUSTED_COMMAND_DEADLINE_MS;

  return new Promise((resolve) => {
    const process = spawn(command, argumentsValue, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let finished = false;
    let stdout = '';
    let stderr = '';
    let outputLimited = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (exitCode: number, processError?: Error): void => {
      if (finished) {
        return;
      }

      finished = true;
      if (deadline !== undefined) {
        clearTimeout(deadline);
      }
      resolve({
        exitCode,
        outputLimited,
        stderr: processError === undefined ? stderr : `${stderr}${processError.message}`,
        stdout,
      });
    };

    process.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) + chunk.byteLength > maxOutputBytes) {
        outputLimited = true;
      }

      stdout = appendBounded(stdout, chunk, maxOutputBytes);
    });
    process.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) + chunk.byteLength > maxOutputBytes) {
        outputLimited = true;
      }

      stderr = appendBounded(stderr, chunk, maxOutputBytes);
    });
    process.once('error', (error) => {
      finish(1, error);
    });
    process.once('close', (exitCode) => {
      finish(exitCode ?? 1);
    });
    deadline = setTimeout(() => {
      process.kill('SIGKILL');
      finish(1, new Error('The trusted command exceeded its deadline.'));
    }, timeoutMs);
  });
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function currentProcessIds(): { gid: number; uid: number } {
  if (process.getuid === undefined || process.getgid === undefined) {
    throw new Error('The Linux qualification broker must expose a Unix uid and gid.');
  }

  return {
    gid: process.getgid(),
    uid: process.getuid(),
  };
}

function findNonLoopbackIpv4(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }

  throw new Error('The trusted Linux broker has no non-loopback IPv4 control address.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSingleDockerObject(
  result: { exitCode: number; stdout: string },
  message: string,
): Record<string, unknown> {
  if (result.exitCode !== 0) {
    throw new Error(message);
  }

  const parsed = JSON.parse(result.stdout) as unknown;

  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error(message);
  }

  return parsed[0];
}

function matchesFixedProfile(
  config: Record<string, unknown>,
  hostConfig: Record<string, unknown>,
  container: Record<string, unknown>,
): boolean {
  const mounts = container.Mounts;
  const capDrop = hostConfig.CapDrop;
  const securityOptions = hostConfig.SecurityOpt;
  const ulimits = hostConfig.Ulimits;
  const tmpfs = hostConfig.Tmpfs;
  const logConfig = isRecord(hostConfig.LogConfig) ? hostConfig.LogConfig : undefined;
  const hasNoMounts = Array.isArray(mounts) && mounts.length === 0;
  const hasNoBinds = hostConfig.Binds === null || hostConfig.Binds === undefined;
  const hasCapDropAll = Array.isArray(capDrop) && capDrop.length === 1 && capDrop[0] === 'ALL';
  const hasNoNewPrivileges =
    Array.isArray(securityOptions) && securityOptions.includes('no-new-privileges');
  const hasNprocLimit =
    Array.isArray(ulimits) &&
    ulimits.some(
      (limit) =>
        isRecord(limit) && limit.Name === 'nproc' && limit.Hard === 32 && limit.Soft === 32,
    );

  return (
    config.OpenStdin === true &&
    config.Tty === false &&
    config.User === FIXED_READONLY_PROFILE.user &&
    hostConfig.Runtime === FIXED_READONLY_PROFILE.runtime &&
    hostConfig.NetworkMode === FIXED_READONLY_PROFILE.network &&
    hostConfig.ReadonlyRootfs === FIXED_READONLY_PROFILE.readOnlyRoot &&
    hostConfig.Memory === FIXED_READONLY_PROFILE.memoryMiB * 1024 * 1024 &&
    hostConfig.MemorySwap === FIXED_READONLY_PROFILE.memoryMiB * 1024 * 1024 &&
    hostConfig.NanoCpus === FIXED_READONLY_PROFILE.cpus * 1_000_000_000 &&
    hostConfig.PidsLimit === FIXED_READONLY_PROFILE.hostPids &&
    hostConfig.ShmSize === FIXED_READONLY_PROFILE.sharedMemoryMiB * 1024 * 1024 &&
    logConfig?.Type === 'none' &&
    hasNoMounts &&
    hasNoBinds &&
    hasCapDropAll &&
    hasNoNewPrivileges &&
    hasNprocLimit &&
    hasFixedTmpfs(tmpfs) &&
    hasFixedIoRate(hostConfig.BlkioDeviceReadBps) &&
    hasFixedIoRate(hostConfig.BlkioDeviceWriteBps)
  );
}

function hasFixedTmpfs(value: unknown): boolean {
  if (!isRecord(value) || typeof value['/tmp'] !== 'string') {
    return false;
  }

  const options = new Set(value['/tmp'].split(','));

  return (
    options.has('rw') &&
    options.has('noexec') &&
    options.has('nosuid') &&
    options.has('nodev') &&
    options.has(`size=${FIXED_READONLY_PROFILE.scratchMiB}m`)
  );
}

function hasFixedIoRate(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    isRecord(value[0]) &&
    value[0].Path === FIXED_READONLY_PROFILE.ioDevice &&
    value[0].Rate === FIXED_READONLY_PROFILE.ioBytesPerSecond
  );
}

function readCgroupRate(contents: string, metric: 'rbps' | 'wbps'): number {
  const fields = readCgroupDeviceFields(contents);
  const value = fields[metric];

  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error('The cgroup I/O rate does not contain the fixed device limit.');
  }

  return Number.parseInt(value, 10);
}

function readCgroupReadBytes(contents: string): number {
  const fields = readCgroupDeviceFields(contents);
  const value = fields.rbytes;

  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error('The cgroup I/O statistics do not contain observed read bytes.');
  }

  return Number.parseInt(value, 10);
}

function readCgroupReadBytesOrZero(contents: string): number {
  const fields = readCgroupDeviceFields(contents);
  const value = fields.rbytes;

  if (value === undefined) {
    return 0;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error('The cgroup I/O statistics contain an invalid read-byte count.');
  }

  return Number.parseInt(value, 10);
}

function readCpuMaximum(contents: string): [number, number] {
  const [quotaValue, periodValue] = contents.trim().split(/\s+/);

  if (
    quotaValue === undefined ||
    periodValue === undefined ||
    !/^\d+$/.test(quotaValue) ||
    !/^\d+$/.test(periodValue)
  ) {
    throw new Error('The cgroup CPU limit does not contain a fixed quota and period.');
  }

  return [Number.parseInt(quotaValue, 10), Number.parseInt(periodValue, 10)];
}

function readPidsMaximum(contents: string): number {
  const value = contents.trim();

  if (!/^\d+$/.test(value)) {
    throw new Error('The cgroup PID limit does not contain a fixed value.');
  }

  return Number.parseInt(value, 10);
}

function readCgroupDeviceFields(contents: string): Record<string, string> {
  const line = contents
    .split('\n')
    .find((candidate) => candidate.startsWith(`${IO_DEVICE_MAJOR_MINOR} `));

  if (line === undefined) {
    throw new Error('The fixed I/O device is absent from the container cgroup evidence.');
  }

  return Object.fromEntries(
    line
      .split(' ')
      .slice(1)
      .map((field) => field.split('='))
      .filter((field): field is [string, string] => field.length === 2),
  );
}

function readBoolean(record: Record<string, ProbeValue>, key: string): boolean {
  const value = record[key];

  if (typeof value !== 'boolean') {
    throw new Error(`The qualification probe did not provide boolean ${key}.`);
  }

  return value;
}

function readNumber(record: Record<string, ProbeValue>, key: string): number {
  const value = record[key];

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`The qualification probe did not provide numeric ${key}.`);
  }

  return value;
}

function readString(record: Record<string, ProbeValue>, key: string): string {
  const value = record[key];

  if (typeof value !== 'string') {
    throw new Error(`The qualification probe did not provide string ${key}.`);
  }

  return value;
}

function isDockerSocketUnavailable(value: string): value is DockerSocketAccessStatus {
  return value === 'missing' || value === 'permission-denied' || value === 'refused';
}

function asDockerSocketAccessStatus(value: string): DockerSocketAccessStatus {
  if (!isDockerSocketUnavailable(value)) {
    throw new Error('The Docker socket probe did not report a confirmed inaccessible state.');
  }

  return value;
}

async function listenTcp(server: Server, host: string): Promise<number> {
  server.listen(0, host);
  await waitForEventWithin(
    server,
    'listening',
    NETWORK_CONTROL_DEADLINE_MS,
    'The TCP control target did not start within its deadline.',
  );
  const address = server.address();

  if (typeof address === 'string' || address === null) {
    throw new Error('The TCP control target did not receive a TCP port.');
  }

  return address.port;
}

async function bindUdp(socket: DatagramSocket, host: string): Promise<number> {
  socket.bind(0, host);
  await waitForEventWithin(
    socket,
    'listening',
    NETWORK_CONTROL_DEADLINE_MS,
    'The UDP control target did not start within its deadline.',
  );
  return socket.address().port;
}

export async function connectTcp(
  host: string,
  port: number,
  options: {
    connector?: TcpConnector;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const connector = options.connector ?? createTcpConnection;
  const timeoutMs = options.timeoutMs ?? NETWORK_CONTROL_DEADLINE_MS;
  const socket = connector(port, host);

  try {
    await waitForEventWithin(
      socket,
      'connect',
      timeoutMs,
      'The TCP control connection did not complete within its deadline.',
    );
  } catch (error) {
    cancelPendingTcpConnection(socket);
    throw error;
  }

  socket.end();
}

function createTcpConnection(port: number, host: string): TcpControlSocket {
  return connect(port, host);
}

function cancelPendingTcpConnection(socket: TcpControlSocket): void {
  try {
    socket.destroy();
  } catch {
    // The deadline or connection failure remains the actionable result.
  }
}

async function sendUdp(host: string, port: number, message: Buffer): Promise<void> {
  const socket = createSocket('udp4');

  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error('The UDP control datagram did not send within its deadline.'));
      }, NETWORK_CONTROL_DEADLINE_MS);

      socket.send(message, port, host, (error) => {
        clearTimeout(deadline);

        if (error !== null) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  } finally {
    await closeUdp(socket);
  }
}

function udpControlPacket(): Buffer {
  return Buffer.from('qdroid-network-udp-control/v1');
}

function dnsControlPacket(): Buffer {
  return Buffer.from([
    0x00,
    0x01,
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
    0x06,
    ...Buffer.from('qdroid'),
    0x07,
    ...Buffer.from('invalid'),
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
  ]);
}

async function closeTcp(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  const closed = waitForEventWithin(
    server,
    'close',
    NETWORK_CONTROL_DEADLINE_MS,
    'The TCP control target did not close within its deadline.',
  );
  server.close();
  await closed;
}

async function closeUdp(socket: DatagramSocket): Promise<void> {
  try {
    socket.address();
  } catch (error) {
    if (isDgramNotRunningError(error)) {
      return;
    }

    throw error;
  }

  const closed = waitForEventWithin(
    socket,
    'close',
    NETWORK_CONTROL_DEADLINE_MS,
    'The UDP control target did not close within its deadline.',
  );

  socket.close();
  await closed;
}

async function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }

    await delay(Math.min(10, deadline - Date.now()));
  }

  return condition();
}

async function waitForEventWithin(
  target: EventEmitter,
  event: string,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      once(target, event),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function isDgramNotRunningError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING';
}

function appendBounded(
  value: string,
  chunk: Buffer,
  limit = MAX_CAPTURED_DIAGNOSTIC_BYTES,
): string {
  const remaining = limit - Buffer.byteLength(value);

  if (remaining <= 0) {
    return value;
  }

  return value + chunk.subarray(0, remaining).toString('utf8');
}

async function waitForProcessClose(process: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.once('error', reject);
    process.once('close', () => {
      resolve();
    });
  });
}

async function waitForProcessCloseWithin(
  processClosed: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      processClosed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('The Docker attach process did not terminate after stop.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function delay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

import type { SandboxProfileId } from '../../contracts/src/index.js';
import {
  PROFILE_CPU_PROBE_DEADLINE_MS,
  PROFILE_IO_DEVICE_MAJOR_MINOR,
  PROFILE_IO_PROBE_DEADLINE_MS,
  PROFILE_IO_PROBE_FILE_BYTES,
  PROFILE_IO_MIN_DURATION_MS,
  SANDBOX_PROFILE_CATALOG,
  type OfflineSandboxProfile,
} from '../../supervisor/src/fixed-probe-catalog.js';
import type {
  LegacyIoFixture,
  OwnedBoundaryControl,
  OwnedProbe,
  OwnedProbeExecution,
  OwnedProfileNetworkControls,
  ProbeCgroupSnapshot,
  ProfileProbeSelection,
  ResourceCleanupEvidence,
  RuntimeResourceOps,
} from './resource-ops.js';

/**
 * The installer-only path must use ResourceOps for every profile-tuple effect.
 * It stays out of the public runtime barrel. Contract tests import this private
 * module directly so production and test use the same qualifier logic.
 */
export async function verifyManagedProfileTupleForTest(
  profileId: SandboxProfileId,
  imageId: string,
  resources: RuntimeResourceOps,
): Promise<void> {
  const profile = SANDBOX_PROFILE_CATALOG[profileId];
  if (profile === undefined) {
    throw new Error('The requested sandbox profile is not supported.');
  }
  await verifyManagedProfileTuple(profile, imageId, resources);
}

interface ManagedProbeCleanupState {
  cleanupConfirmed: boolean;
  cleanupRequested: boolean;
  onCleanupRequested?: () => void;
  prepared: boolean;
}

interface StartedManagedProfileProbe {
  readonly execution: OwnedProbeExecution;
}

const MANAGED_PROBE_OUTPUT_BYTES = 64 * 1024;
const MANAGED_PROBE_SETTLEMENT_OBSERVATION_MS = 100;
const MAX_MANAGED_PROBE_PHASE_DIAGNOSTICS = 3;

export async function verifyManagedProfileTuple(
  profile: OfflineSandboxProfile,
  imageId: string,
  resources: RuntimeResourceOps,
): Promise<void> {
  const controls = await runManagedProfileProbeText(resources, profile, imageId, {
    kind: 'controls',
  });
  assertProfileNegativeControls(parseQualificationJson(controls, 'negative controls'));

  await verifyManagedProfileHostBoundaries(resources, profile, imageId);
  await verifyManagedProfileNetworkIsolation(resources, profile, imageId);
  await verifyManagedEffectiveProfileCgroup(resources, profile, imageId);
  await verifyManagedProfileCpuUsage(resources, profile, imageId);
  await verifyManagedProfileIoUsage(resources, profile, imageId);

  const scratch = await runManagedProfileProbeText(resources, profile, imageId, {
    kind: 'scratch-limit',
  });
  if (parseQualificationJson(scratch, 'scratch limit').enospc !== true) {
    throw new Error('The requested profile tuple did not enforce its scratch limit.');
  }

  const sharedMemory = await runManagedProfileProbeText(resources, profile, imageId, {
    kind: 'shared-memory-limit',
  });
  if (parseQualificationJson(sharedMemory, 'shared-memory limit').enospc !== true) {
    throw new Error('The requested profile tuple did not enforce its shared-memory limit.');
  }

  const pids = await runManagedProfileProbeText(resources, profile, imageId, { kind: 'pids' });
  if (parseQualificationJson(pids, 'PID limit').forkDenied !== true) {
    throw new Error('The requested profile tuple did not enforce its guest PID limit.');
  }

  await verifyManagedMemoryLimit(resources, profile, imageId);
}

function assertProfileNegativeControls(result: Record<string, unknown>): void {
  if (result.nonRoot !== true || result.noNewPrivileges !== true || result.rootReadOnly !== true) {
    throw new Error('The requested profile tuple did not enforce its negative controls.');
  }
}

async function verifyManagedProfileHostBoundaries(
  resources: RuntimeResourceOps,
  profile: OfflineSandboxProfile,
  imageId: string,
): Promise<void> {
  const boundary = await resources.createBoundaryControl();
  const probeCleanup = { cleanupConfirmed: false, cleanupRequested: false, prepared: false };
  let primaryFailure: Error | undefined;

  try {
    await boundary.assertPositiveControls();
    const output = await runManagedProfileProbeText(
      resources,
      profile,
      imageId,
      { boundary, kind: 'host-boundary' },
      probeCleanup,
    );
    assertProfileBoundaryControls(parseQualificationJson(output, 'host boundary controls'));
  } catch (error) {
    primaryFailure = asError(error, 'The requested profile host-boundary probe failed.');
  }

  const cleanupFailure = await disposeManagedDependentControl(
    boundary,
    probeCleanup,
    'The trusted profile boundary control cleanup failed.',
  );
  throwManagedQualificationFailures(
    primaryFailure,
    cleanupFailure,
    'The requested profile host-boundary probe and cleanup both failed.',
  );
}

function assertProfileBoundaryControls(result: Record<string, unknown>): void {
  if (
    result.crossAppUnreadable !== true ||
    result.trustedStoreUnreadable !== true ||
    result.hostProcessSecretUnreadable !== true ||
    result.hostPidHidden !== true ||
    result.controlledDeviceUnreadable !== true ||
    result.dockerSocketUnreadable !== true
  ) {
    throw new Error('The requested profile exposed a host boundary control.');
  }
}

async function verifyManagedProfileNetworkIsolation(
  resources: RuntimeResourceOps,
  profile: OfflineSandboxProfile,
  imageId: string,
): Promise<void> {
  const controls = await resources.createNetworkControls('profile');
  const probeCleanup = { cleanupConfirmed: false, cleanupRequested: false, prepared: false };
  let primaryFailure: Error | undefined;

  try {
    await controls.assertHealthy();
    await controls.assertPositiveControls();
    await controls.assertHealthy();
    await controls.resetReceipts();

    const output = await runManagedProfileProbeText(
      resources,
      profile,
      imageId,
      { controls, kind: 'network' },
      probeCleanup,
    );
    await controls.assertHealthy();
    const receipts = await controls.snapshot();
    if (
      receipts.settled !== true ||
      receipts.tcpIpv4 !== false ||
      receipts.tcpIpv6 !== false ||
      receipts.udpDns !== false ||
      receipts.udpIpv4 !== false ||
      receipts.udpIpv6 !== false
    ) {
      throw new Error('The requested profile network controls received an unexpected receipt.');
    }

    const result = parseQualificationJson(output, 'network isolation');
    if (
      result.tcpBlocked !== true ||
      result.dnsBlocked !== true ||
      result.udpAttemptsCompleted !== true
    ) {
      throw new Error('The requested profile tuple did not block controlled network paths.');
    }
  } catch (error) {
    primaryFailure = asError(error, 'The requested profile network probe failed.');
  }

  const cleanupFailure = await disposeManagedDependentControl(
    controls,
    probeCleanup,
    'The trusted profile network fixture cleanup failed.',
    async () => controls.assertHealthy(),
  );
  throwManagedQualificationFailures(
    primaryFailure,
    cleanupFailure,
    'The requested profile network probe and cleanup both failed.',
  );
}

async function verifyManagedEffectiveProfileCgroup(
  resources: RuntimeResourceOps,
  profile: OfflineSandboxProfile,
  imageId: string,
): Promise<void> {
  const probeCleanup = { cleanupConfirmed: false, cleanupRequested: false, prepared: false };
  let completion: Promise<Awaited<OwnedProbeExecution['completion']>> | undefined;
  let completionBeforeCleanup: Awaited<OwnedProbeExecution['completion']> | undefined;
  let completionResult: Awaited<OwnedProbeExecution['completion']> | undefined;
  let settlement: ManagedProbeSettlementObservation | undefined;
  let primaryFailure: Error | undefined;

  try {
    await withManagedProfileProbe(
      resources,
      profile,
      imageId,
      { kind: 'cgroup-limits' },
      probeCleanup,
      async (probe) => {
        const started = await startManagedProfileProbe(probe, imageId);
        completion = started.execution.completion;
        void completion.then(
          (result) => {
            completionResult = result;
            if (!probeCleanup.cleanupRequested) {
              completionBeforeCleanup = result;
            }
          },
          () => undefined,
        );
        const stdout = consumeManagedProbeStream(started.execution.stdout);
        const stderr = consumeManagedProbeStream(started.execution.stderr);
        settlement = observeManagedProbeSettlements([
          {
            failureMessage: 'The profile cgroup probe command failed.',
            promise: completion,
          },
          {
            failureMessage: 'The profile cgroup probe stdout stream failed.',
            promise: stdout,
          },
          {
            failureMessage: 'The profile cgroup probe stderr stream failed.',
            promise: stderr,
          },
        ]);
        await started.execution.closeInput();

        const snapshot = await inspectManagedLiveCgroup(probe, imageId);
        assertManagedProfileCgroupLimits(snapshot, profile);
      },
    );

    if (completion === undefined || settlement === undefined) {
      throw new Error('The profile cgroup probe did not start its managed command.');
    }
  } catch (error) {
    primaryFailure = asError(error, 'The profile cgroup probe failed.');
  }

  const settlementResult = await settlement?.waitForBoundedSettlement();
  if (primaryFailure === undefined && settlementResult !== undefined && !settlementResult.settled) {
    primaryFailure = new Error(
      'The profile cgroup probe streams did not settle after confirmed owned cleanup.',
    );
  }
  if (
    primaryFailure === undefined &&
    completionResult === undefined &&
    settlementResult?.failures.length === 0
  ) {
    primaryFailure = new Error('The profile cgroup probe did not settle after owned cleanup.');
  }
  if (
    primaryFailure === undefined &&
    completionResult !== undefined &&
    (completionBeforeCleanup !== undefined ||
      !probeCleanup.cleanupRequested ||
      !completionResult.cleanupConfirmed ||
      completionResult.reason !== 'stopped')
  ) {
    primaryFailure = new Error('The profile cgroup probe did not remain live until owned cleanup.');
  }
  throwManagedQualificationFailures(
    primaryFailure,
    undefined,
    'The profile cgroup probe and stream verification both failed.',
    ...(settlementResult?.failures ?? []),
  );
}

function assertManagedProfileCgroupLimits(
  snapshot: ProbeCgroupSnapshot,
  profile: OfflineSandboxProfile,
): void {
  assertManagedCgroupIdentity(snapshot);
  const expectedMemory = profile.limits.memoryMiB * 1024 * 1024;
  const expectedCpuQuota = Math.round(profile.limits.cpu * 100_000);
  if (
    snapshot.memoryMaximumBytes !== expectedMemory ||
    snapshot.pidsMaximum !== profile.limits.hostPids ||
    snapshot.cpu.periodMicros !== 100_000 ||
    snapshot.cpu.quotaMicros !== expectedCpuQuota ||
    snapshot.io.deviceMajorMinor !== PROFILE_IO_DEVICE_MAJOR_MINOR ||
    snapshot.io.counters.readBytesPerSecond !== profile.limits.ioBytesPerSecond ||
    snapshot.io.counters.writeBytesPerSecond !== profile.limits.ioBytesPerSecond
  ) {
    throw new Error('The requested profile cgroup limits do not match its qualified envelope.');
  }
}

async function verifyManagedProfileCpuUsage(
  resources: RuntimeResourceOps,
  profile: OfflineSandboxProfile,
  imageId: string,
): Promise<void> {
  let phase: ManagedProbePhase | undefined;
  const probeCleanup = {
    cleanupConfirmed: false,
    cleanupRequested: false,
    onCleanupRequested: (): void => phase?.markCleanupRequested(),
    prepared: false,
  };
  let settlement: ManagedProbeSettlementObservation | undefined;
  let primaryFailure: Error | undefined;

  try {
    await withManagedProfileProbe(
      resources,
      profile,
      imageId,
      { kind: 'cpu' },
      probeCleanup,
      async (probe) => {
        const started = await startManagedProfileProbe(probe, imageId);
        const probePhase = createManagedProbePhase();
        phase = probePhase;
        const ready = createManagedProbeSignal('The profile CPU probe did not become ready.');
        const completed = createManagedProbeSignal(
          'The profile CPU probe did not complete its useful computation.',
        );
        const stdout = observeManagedProfileLines(started.execution.stdout, (line) => {
          if (line === 'ready') {
            ready.resolve();
            return;
          }
          try {
            const result = JSON.parse(line) as unknown;
            if (!isRecord(result) || result.completed !== true) {
              throw new Error('The profile CPU probe returned an invalid result.');
            }
            completed.resolve();
          } catch (error) {
            const failure = asError(error, 'The profile CPU probe returned invalid JSON.');
            probePhase.reportParserDiagnostic(failure);
            ready.reject(failure);
            completed.reject(failure);
          }
        });
        const stderr = consumeManagedProbeStream(started.execution.stderr);
        settlement = observeManagedProbeSettlements([
          {
            failureMessage: 'The profile CPU probe stdout stream failed.',
            promise: stdout,
          },
          {
            failureMessage: 'The profile CPU probe stderr stream failed.',
            promise: stderr,
          },
        ]);
        observeManagedProfileOutput(stdout, probePhase, ready, completed);
        observeManagedProfileReaderFailure(stderr, probePhase, ready, completed);
        observeManagedProfileCompletion(started.execution.completion, probePhase, ready, completed);

        await withinProfileCpuDeadline(
          ready.promise,
          'The profile CPU probe did not become ready.',
        );
        probePhase.throwIfReported();
        const before = await inspectManagedLiveCgroup(probe, imageId);
        const startedAt = process.hrtime.bigint();
        await started.execution.command('start');
        await withinProfileCpuDeadline(
          completed.promise,
          'The profile CPU probe did not complete its useful computation.',
        );
        probePhase.throwIfReported();
        const after = await inspectManagedLiveCgroup(probe, imageId);
        const elapsedMicros = Number(process.hrtime.bigint() - startedAt) / 1_000;
        assertManagedProfileCpuUsage(before, after, profile, elapsedMicros);

        probePhase.throwIfReported();
        probePhase.markReleaseRequested();
        await started.execution.command('release');
        await started.execution.closeInput();
        const commandCompletion = await withinProfileCpuDeadline(
          started.execution.completion,
          'The profile CPU probe did not exit after trusted release.',
        );
        assertManagedSuccessfulProbeCompletion(commandCompletion, 'profile CPU probe');
        await Promise.all([stdout, stderr]);
        probePhase.throwIfReported();
      },
    );
  } catch (error) {
    primaryFailure = asError(error, 'The profile CPU probe failed.');
  }

  const settlementResult = await settlement?.waitForBoundedSettlement();
  if (primaryFailure === undefined && settlementResult !== undefined && !settlementResult.settled) {
    primaryFailure = new Error('The profile CPU probe streams did not settle after owned cleanup.');
  }
  throwManagedQualificationFailures(
    primaryFailure,
    undefined,
    'The profile CPU probe and stream verification both failed.',
    ...(phase?.failures ?? []),
    ...(settlementResult?.failures ?? []),
  );
}

function assertManagedProfileCpuUsage(
  before: ProbeCgroupSnapshot,
  after: ProbeCgroupSnapshot,
  profile: OfflineSandboxProfile,
  elapsedMicros: number,
): void {
  assertSameManagedCgroupIdentity(
    before,
    after,
    'The profile CPU probe changed process or cgroup identity.',
  );
  assertManagedCgroupIdentity(before);
  assertManagedCgroupIdentity(after);
  const expectedQuota = Math.round(profile.limits.cpu * 100_000);
  const usageMicros = checkedProfileCpuDelta(
    after.cpu.counters.usageMicros,
    before.cpu.counters.usageMicros,
  );
  const hostCpuToWallRatio = usageMicros / elapsedMicros;
  if (
    before.cpu.periodMicros !== 100_000 ||
    after.cpu.periodMicros !== 100_000 ||
    before.cpu.quotaMicros !== expectedQuota ||
    after.cpu.quotaMicros !== expectedQuota ||
    usageMicros <= 0 ||
    !Number.isFinite(hostCpuToWallRatio) ||
    hostCpuToWallRatio > profile.limits.cpu + 0.1
  ) {
    throw new Error('The requested profile did not retain its host CPU resource envelope.');
  }
}

async function verifyManagedProfileIoUsage(
  resources: RuntimeResourceOps,
  profile: OfflineSandboxProfile,
  imageId: string,
): Promise<void> {
  const fixture = await resources.createFixture({ kind: 'legacy-io-file' });
  let phase: ManagedProbePhase | undefined;
  const probeCleanup = {
    cleanupConfirmed: false,
    cleanupRequested: false,
    onCleanupRequested: (): void => phase?.markCleanupRequested(),
    prepared: false,
  };
  let primaryFailure: Error | undefined;
  let settlement: ManagedProbeSettlementObservation | undefined;

  try {
    await withManagedProfileProbe(
      resources,
      profile,
      imageId,
      { fixture, kind: 'io' },
      probeCleanup,
      async (probe) => {
        const started = await startManagedProfileProbe(probe, imageId);
        const probePhase = createManagedProbePhase();
        phase = probePhase;
        const ready = createManagedProbeSignal('The profile I/O probe did not become ready.');
        let result: { code: number | null; elapsedMs: number } | undefined;
        const completed = createManagedProbeSignal(
          'The profile I/O probe did not complete its bounded read.',
        );
        const stdout = observeManagedProfileLines(started.execution.stdout, (line) => {
          if (line === 'ready') {
            ready.resolve();
            return;
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
            result = { code: parsed.code, elapsedMs: parsed.elapsedMs };
            completed.resolve();
          } catch (error) {
            const failure = asError(error, 'The profile I/O probe returned invalid JSON.');
            probePhase.reportParserDiagnostic(failure);
            ready.reject(failure);
            completed.reject(failure);
          }
        });
        const stderr = consumeManagedProbeStream(started.execution.stderr);
        settlement = observeManagedProbeSettlements([
          {
            failureMessage: 'The profile I/O probe stdout stream failed.',
            promise: stdout,
          },
          {
            failureMessage: 'The profile I/O probe stderr stream failed.',
            promise: stderr,
          },
        ]);
        observeManagedProfileOutput(stdout, probePhase, ready, completed);
        observeManagedProfileReaderFailure(stderr, probePhase, ready, completed);
        observeManagedProfileCompletion(started.execution.completion, probePhase, ready, completed);

        await withinProfileIoDeadline(ready.promise, 'The profile I/O probe did not become ready.');
        probePhase.throwIfReported();
        const before = await inspectManagedLiveCgroup(probe, imageId);
        await started.execution.command('read');
        await withinProfileIoDeadline(
          completed.promise,
          'The profile I/O probe did not complete its bounded read.',
        );
        probePhase.throwIfReported();
        const after = await inspectManagedLiveCgroup(probe, imageId);
        assertManagedProfileIoUsage(before, after, profile, result);

        probePhase.throwIfReported();
        probePhase.markReleaseRequested();
        await started.execution.command('release');
        await started.execution.closeInput();
        const commandCompletion = await withinProfileIoDeadline(
          started.execution.completion,
          'The profile I/O probe did not exit after trusted release.',
        );
        assertManagedSuccessfulProbeCompletion(commandCompletion, 'profile I/O probe');
        await Promise.all([stdout, stderr]);
        probePhase.throwIfReported();
      },
    );
  } catch (error) {
    primaryFailure = asError(error, 'The profile I/O probe failed.');
  }

  const settlementResult = await settlement?.waitForBoundedSettlement();
  if (primaryFailure === undefined && settlementResult !== undefined && !settlementResult.settled) {
    primaryFailure = new Error('The profile I/O probe streams did not settle after owned cleanup.');
  }
  const fixtureCleanupFailure = await disposeManagedDependentControl(
    fixture,
    probeCleanup,
    'The profile I/O fixture cleanup failed.',
  );
  throwManagedQualificationFailures(
    primaryFailure,
    fixtureCleanupFailure,
    'The profile I/O probe and fixture cleanup both failed.',
    ...(phase?.failures ?? []),
    ...(settlementResult?.failures ?? []),
  );
}

function assertManagedProfileIoUsage(
  before: ProbeCgroupSnapshot,
  after: ProbeCgroupSnapshot,
  profile: OfflineSandboxProfile,
  result: { code: number | null; elapsedMs: number } | undefined,
): void {
  assertSameManagedCgroupIdentity(
    before,
    after,
    'The profile I/O probe changed process or cgroup identity.',
  );
  assertManagedCgroupIdentity(before);
  assertManagedCgroupIdentity(after);
  const observedReadBytes = checkedProfileIoDelta(
    after.io.counters.readBytes,
    before.io.counters.readBytes,
  );
  if (
    result === undefined ||
    result.code !== 0 ||
    result.elapsedMs < PROFILE_IO_MIN_DURATION_MS ||
    before.io.deviceMajorMinor !== PROFILE_IO_DEVICE_MAJOR_MINOR ||
    after.io.deviceMajorMinor !== PROFILE_IO_DEVICE_MAJOR_MINOR ||
    observedReadBytes < PROFILE_IO_PROBE_FILE_BYTES ||
    after.io.counters.readBytesPerSecond !== profile.limits.ioBytesPerSecond ||
    after.io.counters.writeBytesPerSecond !== profile.limits.ioBytesPerSecond
  ) {
    throw new Error('The requested profile did not enforce its effective I/O envelope.');
  }
}

async function verifyManagedMemoryLimit(
  resources: RuntimeResourceOps,
  profile: OfflineSandboxProfile,
  imageId: string,
): Promise<void> {
  let settlement: ManagedProbeSettlementObservation | undefined;
  let primaryFailure: Error | undefined;

  try {
    await withManagedProfileProbe(
      resources,
      profile,
      imageId,
      { kind: 'memory' },
      undefined,
      async (probe) => {
        const started = await startManagedProfileProbe(probe, imageId);
        const stdout = consumeManagedProbeStream(started.execution.stdout);
        const stderr = consumeManagedProbeStream(started.execution.stderr);
        settlement = observeManagedProbeSettlements([
          {
            failureMessage: 'The profile memory probe stdout stream failed.',
            promise: stdout,
          },
          {
            failureMessage: 'The profile memory probe stderr stream failed.',
            promise: stderr,
          },
        ]);
        const completion = await closeManagedProbeInputAndAwaitCompletion(
          started.execution,
          settlement,
          'profile memory probe',
        );
        assertManagedMemoryProbeCompletion(completion);
        const streamSettlement = await settlement.waitForSettlement();
        throwManagedQualificationFailures(
          undefined,
          undefined,
          'The profile memory probe stream verification failed.',
          ...streamSettlement.failures,
        );

        const inspection = await probe.inspect({ kind: 'container-state' });
        assertManagedProbeBinding(inspection.binding, imageId);
        if (
          inspection.kind !== 'container-state' ||
          inspection.state !== 'exited' ||
          inspection.oomKilled !== true
        ) {
          throw new Error('The requested profile did not enforce its memory limit.');
        }
      },
    );
  } catch (error) {
    primaryFailure = asError(error, 'The profile memory probe failed.');
  }

  const settlementResult = await settlement?.waitForBoundedSettlement();
  if (primaryFailure === undefined && settlementResult !== undefined && !settlementResult.settled) {
    primaryFailure = new Error(
      'The profile memory probe streams did not settle after owned cleanup.',
    );
  }
  throwManagedQualificationFailures(
    primaryFailure,
    undefined,
    'The profile memory probe and stream verification both failed.',
    ...(settlementResult?.failures ?? []),
  );
}

function assertManagedMemoryProbeCompletion(
  completion: Awaited<OwnedProbeExecution['completion']>,
): void {
  if (!completion.cleanupConfirmed || completion.reason !== 'completed') {
    throw new Error('The profile memory probe did not reach its expected terminal observation.');
  }
}

async function runManagedProfileProbeText(
  resources: RuntimeResourceOps,
  profile: OfflineSandboxProfile,
  imageId: string,
  selection: ProfileProbeSelection,
  cleanupState: ManagedProbeCleanupState | undefined = undefined,
): Promise<string> {
  let settlement: ManagedProbeSettlementObservation | undefined;
  let primaryFailure: Error | undefined;
  let output: string | undefined;

  try {
    output = await withManagedProfileProbe(
      resources,
      profile,
      imageId,
      selection,
      cleanupState,
      async (probe) => {
        const started = await startManagedProfileProbe(probe, imageId);
        const stdout = consumeManagedProbeStream(started.execution.stdout);
        const stderr = consumeManagedProbeStream(started.execution.stderr);
        settlement = observeManagedProbeSettlements([
          {
            failureMessage: `The profile ${selection.kind} probe stdout stream failed.`,
            promise: stdout,
          },
          {
            failureMessage: `The profile ${selection.kind} probe stderr stream failed.`,
            promise: stderr,
          },
        ]);
        const completion = await closeManagedProbeInputAndAwaitCompletion(
          started.execution,
          settlement,
          `profile ${selection.kind} probe`,
        );
        assertManagedSuccessfulProbeCompletion(completion, `profile ${selection.kind} probe`);
        const streamSettlement = await settlement.waitForSettlement();
        throwManagedQualificationFailures(
          undefined,
          undefined,
          `The profile ${selection.kind} probe stream verification failed.`,
          ...streamSettlement.failures,
        );
        return stdout;
      },
    );
  } catch (error) {
    primaryFailure = asError(error, `The profile ${selection.kind} probe failed.`);
  }

  const settlementResult = await settlement?.waitForBoundedSettlement();
  if (primaryFailure === undefined && settlementResult !== undefined && !settlementResult.settled) {
    primaryFailure = new Error(
      `The profile ${selection.kind} probe streams did not settle after owned cleanup.`,
    );
  }
  throwManagedQualificationFailures(
    primaryFailure,
    undefined,
    `The profile ${selection.kind} probe and stream verification both failed.`,
    ...(settlementResult?.failures ?? []),
  );
  return output as string;
}

async function withManagedProfileProbe<T>(
  resources: RuntimeResourceOps,
  profile: OfflineSandboxProfile,
  imageId: string,
  selection: ProfileProbeSelection,
  cleanupState: ManagedProbeCleanupState | undefined,
  operation: (probe: OwnedProbe) => Promise<T>,
): Promise<T> {
  let probe: OwnedProbe | undefined;
  let value: T | undefined;
  let primaryFailure: Error | undefined;

  try {
    probe = await resources.prepareProbe({
      imageId,
      kind: 'profile-tuple',
      profileId: profile.id,
      selection,
    });
    if (cleanupState !== undefined) {
      cleanupState.prepared = true;
    }
    value = await operation(probe);
  } catch (error) {
    primaryFailure = asError(error, `The managed profile ${selection.kind} probe failed.`);
  }

  let cleanupFailure: Error | undefined;
  if (probe !== undefined) {
    try {
      if (cleanupState !== undefined) {
        cleanupState.cleanupRequested = true;
        cleanupState.onCleanupRequested?.();
      }
      const evidence = await probe.stopAndRemove();
      if (evidence.cleanupConfirmed && evidence.status === 'confirmed') {
        if (cleanupState !== undefined) {
          cleanupState.cleanupConfirmed = true;
        }
      } else {
        cleanupFailure = new Error(
          `The managed profile ${selection.kind} probe cleanup was not confirmed.`,
        );
      }
    } catch (error) {
      cleanupFailure = asError(
        error,
        `The managed profile ${selection.kind} probe cleanup failed.`,
      );
    }
  }

  throwManagedQualificationFailures(
    primaryFailure,
    cleanupFailure,
    `The managed profile ${selection.kind} probe and cleanup both failed.`,
  );
  return value as T;
}

async function startManagedProfileProbe(
  probe: OwnedProbe,
  imageId: string,
): Promise<StartedManagedProfileProbe> {
  await probe.create();
  const inspection = await probe.inspect({ kind: 'configuration' });
  assertManagedProbeBinding(inspection.binding, imageId);
  if (inspection.kind !== 'configuration' || inspection.fixedProfileVerified !== true) {
    throw new Error('The managed profile probe did not return its trusted configuration proof.');
  }
  const execution = await probe.start();
  return { execution };
}

async function consumeManagedProbeStream(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > MANAGED_PROBE_OUTPUT_BYTES) {
      throw new Error('The managed profile probe exceeded its bounded output allowance.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function inspectManagedLiveCgroup(
  probe: OwnedProbe,
  imageId: string,
): Promise<ProbeCgroupSnapshot> {
  const inspection = await probe.inspect({ kind: 'live-cgroup' });
  assertManagedProbeBinding(inspection.binding, imageId);
  if (inspection.kind !== 'live-cgroup') {
    throw new Error('The managed profile probe did not return a live cgroup snapshot.');
  }
  return inspection.cgroup;
}

function assertManagedProbeBinding(
  binding: Readonly<{ fullId: string; imageId: string; labels: Readonly<Record<string, string>> }>,
  imageId: string,
): void {
  if (
    !isContainerId(binding.fullId) ||
    binding.imageId !== imageId ||
    Object.keys(binding.labels).length === 0
  ) {
    throw new Error(
      'The managed profile probe inspection did not retain its exact container binding.',
    );
  }
}

function assertManagedCgroupIdentity(snapshot: ProbeCgroupSnapshot): void {
  const { identity } = snapshot;
  const counters = snapshot.cpu.counters;
  const ioCounters = snapshot.io.counters;
  if (
    identity.key.length === 0 ||
    !Number.isSafeInteger(identity.processId) ||
    identity.processId <= 0 ||
    !/^\d+$/.test(identity.processStart) ||
    !Number.isSafeInteger(counters.nrPeriods) ||
    !Number.isSafeInteger(counters.nrThrottled) ||
    !Number.isSafeInteger(counters.usageMicros) ||
    !Number.isSafeInteger(ioCounters.readBytes) ||
    !Number.isSafeInteger(ioCounters.readBytesPerSecond) ||
    !Number.isSafeInteger(ioCounters.writeBytesPerSecond) ||
    counters.nrPeriods < 0 ||
    counters.nrThrottled < 0 ||
    counters.usageMicros < 0 ||
    ioCounters.readBytes < 0 ||
    ioCounters.readBytesPerSecond < 0 ||
    ioCounters.writeBytesPerSecond < 0 ||
    !Number.isSafeInteger(snapshot.memoryCurrentBytes) ||
    !Number.isSafeInteger(snapshot.memoryMaximumBytes) ||
    !Number.isSafeInteger(snapshot.pidsCurrent) ||
    !Number.isSafeInteger(snapshot.pidsMaximum) ||
    snapshot.memoryCurrentBytes < 0 ||
    snapshot.memoryMaximumBytes <= 0 ||
    snapshot.pidsCurrent < 0 ||
    snapshot.pidsMaximum <= 0
  ) {
    throw new Error('The managed profile cgroup snapshot is invalid.');
  }
}

function assertSameManagedCgroupIdentity(
  before: ProbeCgroupSnapshot,
  after: ProbeCgroupSnapshot,
  message: string,
): void {
  if (
    before.identity.key !== after.identity.key ||
    before.identity.processId !== after.identity.processId ||
    before.identity.processStart !== after.identity.processStart
  ) {
    throw new Error(message);
  }
}

function assertManagedSuccessfulProbeCompletion(
  completion: Awaited<OwnedProbeExecution['completion']>,
  subject: string,
): void {
  if (
    !completion.cleanupConfirmed ||
    completion.reason !== 'completed' ||
    completion.exitCode !== 0
  ) {
    throw new Error(`The ${subject} did not complete successfully.`);
  }
}

function createManagedProbeSignal(message: string): {
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
} {
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    reject: (error) => reject?.(error),
    resolve: () => resolve?.(),
  };
}

interface ManagedProbePhase {
  readonly failures: readonly Error[];
  markCleanupRequested(): void;
  markReleaseRequested(): void;
  reportParserDiagnostic(error: Error): void;
  reportTerminalFailure(error: Error): void;
  throwIfReported(): void;
  readonly terminationRequested: boolean;
}

function createManagedProbePhase(): ManagedProbePhase {
  const parserDiagnostics = createManagedFailureCollector({
    maximumDistinctDiagnostics: MAX_MANAGED_PROBE_PHASE_DIAGNOSTICS,
  });
  const terminalFailures = createManagedFailureCollector();
  let terminationRequested = false;
  return {
    get failures(): readonly Error[] {
      const failures = createManagedFailureCollector();
      for (const failure of parserDiagnostics.failures) {
        failures.report(failure);
      }
      for (const failure of terminalFailures.failures) {
        failures.report(failure);
      }
      return failures.failures;
    },
    markCleanupRequested: (): void => {
      terminationRequested = true;
    },
    markReleaseRequested: (): void => {
      terminationRequested = true;
    },
    reportParserDiagnostic: (error: Error): void => {
      parserDiagnostics.report(error);
    },
    reportTerminalFailure: (error: Error): void => {
      terminalFailures.report(error);
    },
    get terminationRequested(): boolean {
      return terminationRequested;
    },
    throwIfReported: (): void => {
      throwManagedFailureCollector(
        createManagedFailureCollectorFrom(parserDiagnostics.failures, terminalFailures.failures),
        'The managed profile probe reported one or more phase failures.',
      );
    },
  };
}

function createManagedFailureCollectorFrom(
  ...failureLists: readonly (readonly Error[])[]
): ManagedFailureCollector {
  const collector = createManagedFailureCollector();
  for (const failures of failureLists) {
    for (const failure of failures) {
      collector.report(failure);
    }
  }
  return collector;
}

interface ManagedFailureCollector {
  readonly failures: readonly Error[];
  report(error: Error): void;
}

function createManagedFailureCollector(
  options: Readonly<{ maximumDistinctDiagnostics?: number }> = {},
): ManagedFailureCollector {
  const failures: Error[] = [];
  const diagnosticKeys = new Set<string>();
  return {
    get failures(): readonly Error[] {
      return failures;
    },
    report: (error: Error): void => {
      if (failures.includes(error)) {
        return;
      }
      if (options.maximumDistinctDiagnostics !== undefined) {
        const diagnosticKey = `${error.name}:${error.message}`;
        if (
          diagnosticKeys.has(diagnosticKey) ||
          diagnosticKeys.size >= options.maximumDistinctDiagnostics
        ) {
          return;
        }
        diagnosticKeys.add(diagnosticKey);
      }
      failures.push(error);
    },
  };
}

function appendManagedFailure(
  collector: ManagedFailureCollector,
  failure: Error | undefined,
): void {
  if (failure === undefined) {
    return;
  }
  if (failure instanceof AggregateError) {
    for (const nestedFailure of failure.errors) {
      appendManagedFailure(
        collector,
        asError(nestedFailure, 'The managed profile probe reported an unknown failure.'),
      );
    }
    return;
  }
  collector.report(failure);
}

function throwManagedFailureCollector(collector: ManagedFailureCollector, message: string): void {
  if (collector.failures.length === 0) {
    return;
  }
  if (collector.failures.length === 1) {
    throw collector.failures[0];
  }
  throw new AggregateError(collector.failures, message);
}

interface ManagedProbeSettlementObservation {
  readonly firstFailure: Promise<never>;
  waitForBoundedSettlement(): Promise<ManagedProbeSettlementResult>;
  waitForSettlement(): Promise<ManagedProbeSettlementResult>;
}

interface ManagedProbeSettlementResult {
  readonly failures: readonly Error[];
  readonly settled: boolean;
}

interface ObservedManagedProbePromise {
  readonly failureMessage: string;
  readonly promise: Promise<unknown>;
}

function observeManagedProbeSettlements(
  promises: readonly ObservedManagedProbePromise[],
): ManagedProbeSettlementObservation {
  const failures = createManagedFailureCollector();
  let rejectFirstFailure: ((error: Error) => void) | undefined;
  const firstFailure = new Promise<never>((_resolve, reject) => {
    rejectFirstFailure = reject;
  });
  void firstFailure.catch(() => undefined);

  let resolveSettled: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  let remaining = promises.length;

  const settle = (): void => {
    remaining -= 1;
    if (remaining === 0) {
      resolveSettled?.();
    }
  };

  if (remaining === 0) {
    resolveSettled?.();
  }

  for (const observed of promises) {
    void observed.promise.then(
      () => settle(),
      (error: unknown) => {
        const failure = asError(error, observed.failureMessage);
        failures.report(failure);
        rejectFirstFailure?.(failure);
        settle();
      },
    );
  }

  return {
    firstFailure,
    waitForBoundedSettlement: async (): Promise<ManagedProbeSettlementResult> => {
      const observationDeadline = new Promise<false>((resolve) => {
        setTimeout(resolve, MANAGED_PROBE_SETTLEMENT_OBSERVATION_MS);
      });
      const settledBeforeDeadline = await Promise.race([
        settled.then(() => true),
        observationDeadline,
      ]);
      return {
        failures: failures.failures,
        settled: settledBeforeDeadline,
      };
    },
    waitForSettlement: async (): Promise<ManagedProbeSettlementResult> => {
      await settled;
      return {
        failures: failures.failures,
        settled: true,
      };
    },
  };
}

async function observeManagedProfileLines(
  stream: AsyncIterable<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  let buffered = Buffer.alloc(0);
  let byteLength = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    if (
      byteLength + bytes.byteLength > MANAGED_PROBE_OUTPUT_BYTES ||
      buffered.byteLength + bytes.byteLength > MANAGED_PROBE_OUTPUT_BYTES
    ) {
      throw new Error('The managed profile probe exceeded its bounded output allowance.');
    }
    byteLength += bytes.byteLength;
    buffered = Buffer.concat([buffered, bytes]);
    let newlineIndex = buffered.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const line = buffered.subarray(0, newlineIndex);
      if (line.byteLength > MANAGED_PROBE_OUTPUT_BYTES) {
        throw new Error('The managed profile probe exceeded its bounded output allowance.');
      }
      onLine(line.toString('utf8'));
      buffered = buffered.subarray(newlineIndex + 1);
      newlineIndex = buffered.indexOf(0x0a);
    }
  }
  if (buffered.byteLength > 0) {
    onLine(buffered.toString('utf8'));
  }
}

function observeManagedProfileOutput(
  operation: Promise<unknown>,
  phase: ManagedProbePhase,
  ready: ReturnType<typeof createManagedProbeSignal>,
  completed: ReturnType<typeof createManagedProbeSignal>,
): void {
  void operation.then(
    () => {
      if (!phase.terminationRequested) {
        const failure = new Error(
          'The managed profile probe stream ended before its required result.',
        );
        phase.reportTerminalFailure(failure);
        ready.reject(failure);
        completed.reject(failure);
      }
    },
    (error: unknown) => {
      const failure = asError(error, 'The managed profile probe stream failed.');
      phase.reportTerminalFailure(failure);
      ready.reject(failure);
      completed.reject(failure);
    },
  );
}

function observeManagedProfileReaderFailure(
  operation: Promise<unknown>,
  phase: ManagedProbePhase,
  ready: ReturnType<typeof createManagedProbeSignal>,
  completed: ReturnType<typeof createManagedProbeSignal>,
): void {
  void operation.catch((error: unknown) => {
    const failure = asError(error, 'The managed profile probe stream failed.');
    phase.reportTerminalFailure(failure);
    ready.reject(failure);
    completed.reject(failure);
  });
}

function observeManagedProfileCompletion(
  completion: OwnedProbeExecution['completion'],
  phase: ManagedProbePhase,
  ready: ReturnType<typeof createManagedProbeSignal>,
  completed: ReturnType<typeof createManagedProbeSignal>,
): void {
  void completion.then(
    (result) => {
      if (!phase.terminationRequested) {
        const failure = new Error(
          `The managed profile probe completed before its required phase (${result.reason}).`,
        );
        phase.reportTerminalFailure(failure);
        ready.reject(failure);
        completed.reject(failure);
      }
    },
    (error: unknown) => {
      const failure = asError(error, 'The managed profile probe command failed.');
      phase.reportTerminalFailure(failure);
      ready.reject(failure);
      completed.reject(failure);
    },
  );
}

async function waitForManagedProbeCompletion(
  completion: OwnedProbeExecution['completion'],
  settlement: ManagedProbeSettlementObservation,
): Promise<Awaited<OwnedProbeExecution['completion']>> {
  return Promise.race([completion, settlement.firstFailure]);
}

async function closeManagedProbeInputAndAwaitCompletion(
  execution: OwnedProbeExecution,
  settlement: ManagedProbeSettlementObservation,
  subject: string,
): Promise<Awaited<OwnedProbeExecution['completion']>> {
  try {
    await execution.closeInput();
    return await waitForManagedProbeCompletion(execution.completion, settlement);
  } catch (error) {
    const primaryFailure = asError(error, `The ${subject} input or completion failed.`);
    const readerSettlement = await settlement.waitForBoundedSettlement();
    throwManagedQualificationFailures(
      primaryFailure,
      undefined,
      `The ${subject} input, completion, and stream verification failed.`,
      ...readerSettlement.failures,
    );
    throw primaryFailure;
  }
}

async function disposeManagedDependentControl(
  control: Pick<OwnedBoundaryControl, 'dispose'> | LegacyIoFixture | OwnedProfileNetworkControls,
  probeCleanup: ManagedProbeCleanupState,
  message: string,
  afterDispose: (() => Promise<void>) | undefined = undefined,
): Promise<Error | undefined> {
  if (probeCleanup.prepared && !probeCleanup.cleanupConfirmed) {
    return new Error(
      'A managed profile probe has unresolved cleanup; its dependent control is retained.',
    );
  }
  try {
    const evidence: ResourceCleanupEvidence = await control.dispose();
    if (!evidence.cleanupConfirmed || evidence.status !== 'confirmed') {
      throw new Error(message);
    }
    await afterDispose?.();
    return undefined;
  } catch (error) {
    return asError(error, message);
  }
}

function throwManagedQualificationFailures(
  primaryFailure: Error | undefined,
  cleanupFailure: Error | undefined,
  message: string,
  ...additionalFailures: readonly Error[]
): void {
  const failures = createManagedFailureCollector();
  appendManagedFailure(failures, primaryFailure);
  appendManagedFailure(failures, cleanupFailure);
  for (const failure of additionalFailures) {
    appendManagedFailure(failures, failure);
  }
  throwManagedFailureCollector(failures, message);
}

function checkedProfileIoDelta(after: number, before: number): number {
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(before) || after < before) {
    throw new Error('The profile I/O counter regressed.');
  }
  return after - before;
}

function checkedProfileCpuDelta(after: number, before: number): number {
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(before) || after < before) {
    throw new Error('The profile CPU counter regressed.');
  }
  return after - before;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage);
}

function isContainerId(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

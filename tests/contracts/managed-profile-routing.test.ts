import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyManagedProfileTupleForTest } from '../../packages/runtime-oci/src/profile-qualification.js';
import type {
  BoundedProbeInspection,
  LegacyHostInputFixture,
  LegacyIoFixture,
  OwnedFixture,
  OwnedLegacyNetworkControls,
  OwnedProbe,
  OwnedProbeExecution,
  OwnedProfileNetworkControls,
  ProbeCgroupSnapshot,
  ProbeNetworkReceiptSnapshot,
  ProfileProbeSelection,
  ResourceCleanupEvidence,
  RuntimeResourceOps,
  TrustedProbeRecipe,
} from '../../packages/runtime-oci/src/resource-ops.js';

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const CONTAINER_ID = 'b'.repeat(64);

test('managed profile qualification routes every tuple selector through owned opaque resources', async () => {
  const fixture = createManagedResources();

  await verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources);

  assert.deepEqual(fixture.selections, [
    'controls',
    'host-boundary',
    'network',
    'cgroup-limits',
    'cpu',
    'io',
    'scratch-limit',
    'shared-memory-limit',
    'pids',
    'memory',
  ]);
  assert.equal(fixture.nativeCalls, 0);
  assert.ok(fixture.events.indexOf('network:positive') < fixture.events.indexOf('network:reset'));
  assert.ok(
    fixture.events.indexOf('network:reset') < fixture.events.indexOf('probe:network:create'),
  );
  assert.ok(
    fixture.events.indexOf('probe:network:remove') < fixture.events.indexOf('network:dispose'),
  );
  assert.ok(fixture.events.indexOf('probe:io:remove') < fixture.events.indexOf('fixture:dispose'));
  assert.equal(fixture.boundaryDisposed, true);
  assert.equal(fixture.networkDisposed, true);
  assert.equal(fixture.fixtureDisposed, true);
});

test('managed profile qualification rejects invalid cgroup evidence without a raw fallback', async () => {
  const fixture = createManagedResources({ invalidCgroupLimit: true });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    /cgroup limits do not match/,
  );

  assert.equal(fixture.nativeCalls, 0);
  assert.ok(fixture.events.includes('probe:cgroup-limits:remove'));
  assert.equal(fixture.events.includes('probe:cpu:create'), false);
});

test('managed profile qualification rejects a latched network-control failure before its probe', async () => {
  const fixture = createManagedResources({ networkHealthFailure: true });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /network probe and cleanup both failed/);
      return true;
    },
  );

  assert.equal(fixture.nativeCalls, 0);
  assert.equal(fixture.selections.includes('network'), false);
  assert.equal(fixture.networkDisposed, true);
});

test('managed profile qualification retains a failed probe dependency when input ends early', async () => {
  const fixture = createManagedResources({ ioEarlyInputFailure: true, ioCleanupUnknown: true });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /profile I\/O probe and fixture cleanup both failed/);
      return true;
    },
  );

  assert.equal(fixture.nativeCalls, 0);
  assert.ok(fixture.events.includes('probe:io:remove'));
  assert.equal(fixture.fixtureDisposed, false);
});

test('managed profile qualification rejects an incomplete IPv6 UDP receipt snapshot', async () => {
  const fixture = createManagedResources({ networkReceiptMissingIpv6: true });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    /network controls received an unexpected receipt/,
  );

  assert.equal(fixture.networkDisposed, true);
  assert.equal(fixture.events.includes('probe:cgroup-limits:create'), false);
});

test('managed profile qualification rejects a cgroup probe that completes before owned cleanup', async () => {
  const fixture = createManagedResources({ cgroupCompletesEarly: true });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    /did not remain live until owned cleanup/,
  );

  assert.ok(fixture.events.includes('probe:cgroup-limits:remove'));
  assert.equal(fixture.events.includes('probe:cpu:create'), false);
});

test('managed profile qualification bounds cgroup stream observation after unknown cleanup', async () => {
  const fixture = createManagedResources({ cgroupCleanupUnknownWithHeldStreams: true });
  const startedAt = Date.now();

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    /cleanup was not confirmed/,
  );

  assert.ok(Date.now() - startedAt < 1_000);
  assert.ok(fixture.events.includes('probe:cgroup-limits:remove'));
  assert.equal(fixture.events.includes('probe:cpu:create'), false);
});

test('managed profile qualification rejects held cgroup streams after confirmed cleanup', async () => {
  const fixture = createManagedResources({ cgroupCleanupConfirmedWithHeldStreams: true });
  const startedAt = Date.now();

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    /streams did not settle after confirmed owned cleanup/,
  );

  assert.ok(Date.now() - startedAt < 1_000);
  assert.ok(fixture.events.includes('probe:cgroup-limits:remove'));
  assert.equal(fixture.events.includes('probe:cpu:create'), false);
});

test('managed profile qualification preserves an early reader failure when input closing rejects', async () => {
  const fixture = createManagedResources({ closeInputRejectsAfterReaderFailure: true });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      const messages = aggregateErrorMessages(error);
      assert.ok(messages.some((message) => /immediate stderr reader failure/.test(message)));
      assert.ok(messages.some((message) => /input close rejected/.test(message)));
      return true;
    },
  );

  assert.equal(fixture.selections.includes('host-boundary'), false);
});

test('managed profile qualification requires the memory OOM terminal state', async () => {
  const fixture = createManagedResources({ memoryDidNotOom: true });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    /did not enforce its memory limit/,
  );
});

test('managed profile qualification retains a post-result CPU reader failure before release', async () => {
  const fixture = createManagedResources({ cpuInvalidOutputAfterResult: true });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    /CPU probe returned an invalid result/,
  );

  assert.equal(fixture.events.includes('probe:cpu:command:release'), false);
});

test('managed profile qualification retains distinct CPU result, reader, and cleanup failures', async () => {
  const fixture = createManagedResources({
    cpuCleanupFailure: true,
    cpuIndependentStderrFailure: true,
    cpuInvalidOutputAfterResult: true,
  });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      const messages = aggregateErrorMessages(error);
      assert.deepEqual([...messages].sort(), [
        'CPU cleanup failed',
        'The profile CPU probe returned an invalid result.',
        'independent CPU stderr failure',
      ]);
      return true;
    },
  );

  assert.equal(fixture.events.includes('probe:cpu:command:release'), false);
});

test('managed profile qualification retains late CPU phase and completion failures after command failure', async () => {
  const fixture = createManagedResources({
    cpuCompletionRejectsDuringCleanup: true,
    cpuStartFailsBeforeLateInvalidOutput: true,
  });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual([...aggregateErrorMessages(error)].sort(), [
        'CPU start command failed',
        'The profile CPU probe returned an invalid result.',
        'independent CPU completion failure',
      ]);
      return true;
    },
  );

  assert.equal(fixture.events.includes('probe:cpu:command:release'), false);
});

test('managed profile qualification retains completion failure after capped CPU parser diagnostics', async () => {
  const fixture = createManagedResources({
    cpuThreeParserDiagnosticsThenCompletionFailure: true,
  });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      const messages = aggregateErrorMessages(error);
      assert.ok(messages.includes('CPU start command failed'));
      assert.ok(messages.includes('independent CPU completion failure'));
      assert.equal(
        messages.filter((message) => /JSON|Unexpected|Expected/.test(message)).length,
        3,
      );
      return true;
    },
  );

  assert.equal(fixture.events.includes('probe:cpu:command:release'), false);
});

test('managed profile qualification preserves cleanup after repeated CPU phase diagnostics', async () => {
  const fixture = createManagedResources({
    cpuCleanupFailure: true,
    cpuRepeatedInvalidResults: 8,
  });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual([...aggregateErrorMessages(error)].sort(), [
        'CPU cleanup failed',
        'The profile CPU probe returned an invalid result.',
      ]);
      return true;
    },
  );
});

test('managed profile qualification retains late I/O phase and completion failures after command failure', async () => {
  const fixture = createManagedResources({
    ioCompletionRejectsDuringCleanup: true,
    ioReadFailsBeforeLateInvalidOutput: true,
  });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual([...aggregateErrorMessages(error)].sort(), [
        'I/O read command failed',
        'The profile I/O probe returned an invalid result.',
        'independent I/O completion failure',
      ]);
      return true;
    },
  );

  assert.equal(fixture.events.includes('probe:io:command:release'), false);
  assert.equal(fixture.fixtureDisposed, true);
});

test('managed profile qualification rejects an oversized unterminated CPU line', async () => {
  const fixture = createManagedResources({ cpuOversizedOutput: true });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    /exceeded its bounded output allowance/,
  );

  assert.equal(fixture.events.includes('probe:cpu:command:start'), false);
});

test('managed profile qualification rejects I/O stdout EOF before trusted release', async () => {
  const fixture = createManagedResources({ ioOutputEndsBeforeRelease: true });

  await assert.rejects(
    verifyManagedProfileTupleForTest('tool-offline', IMAGE_ID, fixture.resources),
    /stream ended before its required result/,
  );

  assert.equal(fixture.events.includes('probe:io:command:release'), false);
  assert.equal(fixture.fixtureDisposed, true);
});

interface ResourceOptions {
  readonly cgroupCompletesEarly?: boolean;
  readonly cgroupCleanupConfirmedWithHeldStreams?: boolean;
  readonly cgroupCleanupUnknownWithHeldStreams?: boolean;
  readonly closeInputRejectsAfterReaderFailure?: boolean;
  readonly cpuCleanupFailure?: boolean;
  readonly cpuCompletionRejectsDuringCleanup?: boolean;
  readonly cpuIndependentStderrFailure?: boolean;
  readonly cpuInvalidOutputAfterResult?: boolean;
  readonly cpuOversizedOutput?: boolean;
  readonly cpuRepeatedInvalidResults?: number;
  readonly cpuStartFailsBeforeLateInvalidOutput?: boolean;
  readonly cpuThreeParserDiagnosticsThenCompletionFailure?: boolean;
  readonly invalidCgroupLimit?: boolean;
  readonly ioCleanupUnknown?: boolean;
  readonly ioCompletionRejectsDuringCleanup?: boolean;
  readonly ioEarlyInputFailure?: boolean;
  readonly ioOutputEndsBeforeRelease?: boolean;
  readonly ioReadFailsBeforeLateInvalidOutput?: boolean;
  readonly memoryDidNotOom?: boolean;
  readonly networkHealthFailure?: boolean;
  readonly networkReceiptMissingIpv6?: boolean;
}

function aggregateErrorMessages(error: AggregateError): readonly string[] {
  const messages: string[] = [];
  for (const entry of error.errors) {
    if (entry instanceof AggregateError) {
      messages.push(...aggregateErrorMessages(entry));
      continue;
    }
    if (entry instanceof Error) {
      messages.push(entry.message);
    }
  }
  return messages;
}

function createManagedResources(options: ResourceOptions = {}): {
  readonly boundaryDisposed: boolean;
  readonly events: string[];
  readonly fixtureDisposed: boolean;
  readonly nativeCalls: number;
  readonly networkDisposed: boolean;
  readonly resources: RuntimeResourceOps;
  readonly selections: string[];
} {
  const state = {
    boundary: undefined as { readonly id: 'boundary' } | undefined,
    boundaryDisposed: false,
    events: [] as string[],
    fixture: undefined as { readonly id: 'fixture' } | undefined,
    fixtureDisposed: false,
    nativeCalls: 0,
    network: undefined as { readonly id: 'network' } | undefined,
    networkDisposed: false,
    selections: [] as string[],
  };

  const boundary = {
    assertPositiveControls: async (): Promise<void> => {
      state.events.push('boundary:positive');
    },
    dispose: async (): Promise<ResourceCleanupEvidence> => {
      state.events.push('boundary:dispose');
      state.boundaryDisposed = true;
      return confirmedCleanup();
    },
    id: 'boundary' as const,
  };
  state.boundary = boundary;

  const network = {
    assertHealthy: async (): Promise<void> => {
      state.events.push('network:healthy');
      if (options.networkHealthFailure) {
        throw new Error('network controls are unhealthy');
      }
    },
    assertPositiveControls: async (): Promise<void> => {
      state.events.push('network:positive');
    },
    dispose: async (): Promise<ResourceCleanupEvidence> => {
      state.events.push('network:dispose');
      state.networkDisposed = true;
      return confirmedCleanup();
    },
    id: 'network' as const,
    resetReceipts: async (): Promise<void> => {
      state.events.push('network:reset');
    },
    snapshot: async (): Promise<ProbeNetworkReceiptSnapshot> => {
      if (options.networkReceiptMissingIpv6) {
        return {
          settled: true,
          tcpIpv4: false,
          tcpIpv6: false,
          udpDns: false,
          udpIpv4: false,
          udpIpv6: undefined,
        } as unknown as ProbeNetworkReceiptSnapshot;
      }
      return {
        settled: true,
        tcpIpv4: false,
        tcpIpv6: false,
        udpDns: false,
        udpIpv4: false,
        udpIpv6: false,
      };
    },
  };
  state.network = network;

  const ioFixture = {
    dispose: async (): Promise<ResourceCleanupEvidence> => {
      state.events.push('fixture:dispose');
      state.fixtureDisposed = true;
      return confirmedCleanup();
    },
    id: 'fixture' as const,
    kind: 'legacy-io-file' as const,
    sourcePath: '/private/fixture',
    targetPath: '/opt/qdroid/io-probe.bin',
  };
  state.fixture = ioFixture;

  function createFixture(_recipe: {
    readonly kind: 'legacy-host-inputs';
  }): Promise<LegacyHostInputFixture>;
  function createFixture(_recipe: { readonly kind: 'legacy-io-file' }): Promise<LegacyIoFixture>;
  async function createFixture(recipe: {
    readonly kind: 'legacy-host-inputs' | 'legacy-io-file';
  }): Promise<OwnedFixture> {
    if (recipe.kind !== 'legacy-io-file') {
      return unavailable();
    }
    return ioFixture;
  }

  function createNetworkControls(kind: 'legacy'): Promise<OwnedLegacyNetworkControls>;
  function createNetworkControls(kind: 'profile'): Promise<OwnedProfileNetworkControls>;
  async function createNetworkControls(
    kind: 'legacy' | 'profile',
  ): Promise<OwnedLegacyNetworkControls | OwnedProfileNetworkControls> {
    if (kind !== 'profile') {
      return unavailable();
    }
    return network;
  }

  const resources = {
    assembleFixed: async (): Promise<never> => unavailable(),
    assertQualificationReady: (): void => undefined,
    createBoundaryControl: async () => boundary,
    createFixture,
    createNetworkControls,
    native: async () => {
      state.nativeCalls += 1;
      return unavailable();
    },
    prepareProbe: async (recipe: TrustedProbeRecipe): Promise<OwnedProbe> => {
      assert.equal(recipe.kind, 'profile-tuple');
      assert.equal(recipe.imageId, IMAGE_ID);
      assert.equal(recipe.profileId, 'tool-offline');
      const selection = recipe.selection;
      state.selections.push(selection.kind);
      if (selection.kind === 'host-boundary') {
        assert.equal(selection.boundary, boundary);
      }
      if (selection.kind === 'network') {
        assert.equal(selection.controls, network);
      }
      if (selection.kind === 'io') {
        assert.equal(selection.fixture, ioFixture);
      }
      return new ControlledProfileProbe(selection, state.events, options);
    },
    verifySealedFixed: async (): Promise<never> => unavailable(),
  } satisfies RuntimeResourceOps;

  return {
    get boundaryDisposed(): boolean {
      return state.boundaryDisposed;
    },
    events: state.events,
    get fixtureDisposed(): boolean {
      return state.fixtureDisposed;
    },
    get nativeCalls(): number {
      return state.nativeCalls;
    },
    get networkDisposed(): boolean {
      return state.networkDisposed;
    },
    resources,
    selections: state.selections,
  };
}

class ControlledProfileProbe implements OwnedProbe {
  private readonly completion = deferred<{
    readonly cleanupConfirmed: boolean;
    readonly exitCode: number | null;
    readonly reason: 'completed' | 'stopped';
    readonly stderrBytes: number;
    readonly stdoutBytes: number;
  }>();
  private readonly stderr = new ByteQueue();
  private readonly stdout = new ByteQueue();
  private phase: 'created' | 'started' | 'removed' = 'created';
  private configurationInspected = false;
  private cpuStarted = false;
  private readObserved = false;
  private started = false;

  public constructor(
    private readonly selection: ProfileProbeSelection,
    private readonly events: string[],
    private readonly options: ResourceOptions,
  ) {}

  public async create(): Promise<void> {
    assert.equal(this.phase, 'created');
    this.events.push(`probe:${this.selection.kind}:create`);
  }

  public async inspect(query: { readonly kind: string }): Promise<BoundedProbeInspection> {
    assert.notEqual(this.phase, 'removed');
    const binding = Object.freeze({
      fullId: CONTAINER_ID,
      imageId: IMAGE_ID,
      labels: Object.freeze({ 'io.qdroid.profile': 'tool-offline' }),
    });
    if (query.kind === 'configuration') {
      this.events.push(`probe:${this.selection.kind}:inspect:configuration`);
      this.configurationInspected = true;
      return { binding, fixedProfileVerified: true, kind: 'configuration' };
    }
    if (query.kind === 'container-state') {
      return {
        binding,
        exitCode: 137,
        kind: 'container-state',
        oomKilled: !this.options.memoryDidNotOom,
        state: 'exited',
      };
    }
    assert.equal(query.kind, 'live-cgroup');
    return {
      binding,
      cgroup: cgroupSnapshot(
        this.selection.kind,
        this.cpuStarted || this.readObserved,
        this.options.invalidCgroupLimit,
      ),
      kind: 'live-cgroup',
    };
  }

  public async start(): Promise<OwnedProbeExecution> {
    assert.equal(this.phase, 'created');
    assert.equal(this.configurationInspected, true);
    this.phase = 'started';
    this.started = true;
    this.events.push(`probe:${this.selection.kind}:start`);
    if (this.selection.kind === 'cpu' && this.options.cpuOversizedOutput) {
      this.stdout.push('x'.repeat(65_537));
    } else if (this.selection.kind === 'cpu' || this.selection.kind === 'io') {
      this.stdout.push('ready\n');
    } else if (this.selection.kind === 'cgroup-limits') {
      if (this.options.cgroupCompletesEarly) {
        this.complete('completed', 0);
      }
    } else if (this.selection.kind === 'memory') {
      this.complete('completed', 137);
    } else {
      this.stdout.push(`${selectionOutput(this.selection.kind)}\n`);
      if (this.options.closeInputRejectsAfterReaderFailure && this.selection.kind === 'controls') {
        this.stderr.fail(new Error('immediate stderr reader failure'));
      }
      this.complete('completed', 0);
    }
    return {
      closeInput: async (): Promise<void> => {
        this.events.push(`probe:${this.selection.kind}:close-input`);
        if (
          this.options.closeInputRejectsAfterReaderFailure &&
          this.selection.kind === 'controls'
        ) {
          await delay(20);
          throw new Error('input close rejected');
        }
      },
      command: async (phase): Promise<void> => {
        this.events.push(`probe:${this.selection.kind}:command:${phase}`);
        if (this.selection.kind === 'cpu' && phase === 'start') {
          this.cpuStarted = true;
          if (this.options.cpuThreeParserDiagnosticsThenCompletionFailure) {
            setTimeout(() => {
              this.stdout.push('{\n');
              this.stdout.push('[\n');
              this.stdout.push('invalid\n');
            }, 10);
            setTimeout(
              () => this.completion.reject(new Error('independent CPU completion failure')),
              20,
            );
            throw new Error('CPU start command failed');
          }
          if (this.options.cpuStartFailsBeforeLateInvalidOutput) {
            setTimeout(() => this.stdout.push('{"completed":false}\n'), 10);
            if (this.options.cpuCompletionRejectsDuringCleanup) {
              setTimeout(
                () => this.completion.reject(new Error('independent CPU completion failure')),
                20,
              );
            }
            throw new Error('CPU start command failed');
          }
          await delay(20);
          this.stdout.push('{"completed":true}\n');
          if (this.options.cpuInvalidOutputAfterResult) {
            this.stdout.push('{"completed":false}\n');
          }
          for (let index = 0; index < (this.options.cpuRepeatedInvalidResults ?? 0); index += 1) {
            this.stdout.push('{"completed":false}\n');
          }
          if (this.options.cpuIndependentStderrFailure) {
            this.stderr.fail(new Error('independent CPU stderr failure'));
          }
          return;
        }
        if (this.selection.kind === 'cpu' && phase === 'release') {
          this.complete('completed', 0);
          return;
        }
        if (this.selection.kind === 'io' && phase === 'read') {
          if (this.options.ioEarlyInputFailure) {
            throw new Error('EPIPE');
          }
          if (this.options.ioReadFailsBeforeLateInvalidOutput) {
            setTimeout(() => this.stdout.push('{"code":"invalid","elapsedMs":12000}\n'), 10);
            if (this.options.ioCompletionRejectsDuringCleanup) {
              setTimeout(
                () => this.completion.reject(new Error('independent I/O completion failure')),
                20,
              );
            }
            throw new Error('I/O read command failed');
          }
          this.readObserved = true;
          this.stdout.push('{"code":0,"elapsedMs":12000}\n');
          if (this.options.ioOutputEndsBeforeRelease) {
            this.stdout.close();
          }
          return;
        }
        if (this.selection.kind === 'io' && phase === 'release') {
          this.complete('completed', 0);
          return;
        }
        throw new Error(`unexpected ${this.selection.kind} ${phase} command`);
      },
      completion: this.completion.promise,
      stderr: this.stderr,
      stdout: this.stdout,
      stop: async (): Promise<ResourceCleanupEvidence> => confirmedCleanup(),
    };
  }

  public async stopAndRemove(): Promise<ResourceCleanupEvidence> {
    assert.notEqual(this.phase, 'removed');
    this.phase = 'removed';
    this.events.push(`probe:${this.selection.kind}:remove`);
    const cgroupStreamsRemainHeld =
      this.selection.kind === 'cgroup-limits' &&
      (this.options.cgroupCleanupConfirmedWithHeldStreams ||
        this.options.cgroupCleanupUnknownWithHeldStreams);
    const cgroupCleanupIsUnknown =
      this.options.cgroupCleanupUnknownWithHeldStreams && this.selection.kind === 'cgroup-limits';
    if (this.options.cpuCleanupFailure && this.selection.kind === 'cpu') {
      throw new Error('CPU cleanup failed');
    }
    if (
      (this.options.cpuStartFailsBeforeLateInvalidOutput ||
        this.options.cpuThreeParserDiagnosticsThenCompletionFailure) &&
      this.selection.kind === 'cpu'
    ) {
      await delay(30);
    }
    if (
      this.options.cgroupCleanupConfirmedWithHeldStreams &&
      this.selection.kind === 'cgroup-limits'
    ) {
      this.settleCompletion('stopped', 0);
    } else if (this.options.ioReadFailsBeforeLateInvalidOutput && this.selection.kind === 'io') {
      await delay(30);
    }
    if (this.started && !cgroupStreamsRemainHeld) {
      this.complete(this.selection.kind === 'cgroup-limits' ? 'stopped' : 'completed', 0);
    }
    if (cgroupCleanupIsUnknown || (this.options.ioCleanupUnknown && this.selection.kind === 'io')) {
      return { cleanupConfirmed: false, status: 'unknown' };
    }
    return confirmedCleanup();
  }

  private complete(reason: 'completed' | 'stopped', exitCode: number): void {
    this.stdout.close();
    this.stderr.close();
    this.settleCompletion(reason, exitCode);
  }

  private settleCompletion(reason: 'completed' | 'stopped', exitCode: number): void {
    this.completion.resolve({
      cleanupConfirmed: true,
      exitCode,
      reason,
      stderrBytes: 0,
      stdoutBytes: 0,
    });
  }
}

function cgroupSnapshot(
  selection: ProfileProbeSelection['kind'],
  readObserved: boolean,
  invalidCgroupLimit: boolean | undefined,
): ProbeCgroupSnapshot {
  const isToolProfile = true;
  const memoryMaximumBytes = invalidCgroupLimit ? 1 : 768 * 1024 * 1024;
  return {
    cpu: {
      counters: {
        nrPeriods: 3,
        nrThrottled: 0,
        usageMicros: selection === 'cpu' && readObserved ? 10_000 : 1,
      },
      periodMicros: 100_000,
      quotaMicros: 100_000,
    },
    identity: {
      key: isToolProfile ? 'opaque-cgroup' : 'unused',
      processId: 42,
      processStart: '1234',
    },
    io: {
      counters: {
        readBytes: selection === 'io' && readObserved ? 16 * 1024 * 1024 : 0,
        readBytesPerSecond: 1_048_576,
        writeBytesPerSecond: 1_048_576,
      },
      deviceMajorMinor: '253:16',
    },
    memoryCurrentBytes: 1,
    memoryMaximumBytes,
    pidsCurrent: 1,
    pidsMaximum: 256,
  };
}

function selectionOutput(selection: ProfileProbeSelection['kind']): string {
  switch (selection) {
    case 'controls':
      return '{"nonRoot":true,"noNewPrivileges":true,"rootReadOnly":true}';
    case 'host-boundary':
      return '{"crossAppUnreadable":true,"trustedStoreUnreadable":true,"hostProcessSecretUnreadable":true,"hostPidHidden":true,"controlledDeviceUnreadable":true,"dockerSocketUnreadable":true}';
    case 'network':
      return '{"tcpBlocked":true,"dnsBlocked":true,"udpAttemptsCompleted":true}';
    case 'pids':
      return '{"forkDenied":true}';
    case 'scratch-limit':
    case 'shared-memory-limit':
      return '{"enospc":true}';
    default:
      throw new Error(`unexpected synchronous selector ${selection}`);
  }
}

function confirmedCleanup(): ResourceCleanupEvidence {
  return { cleanupConfirmed: true, status: 'confirmed' };
}

function unavailable(): never {
  throw new Error('This mock path must not use an unmanaged operation.');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: T) => void;
} {
  let reject: ((error: Error) => void) | undefined;
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    promise,
    reject: (error) => reject?.(error),
    resolve: (value) => resolve?.(value),
  };
}

class ByteQueue implements AsyncIterable<Uint8Array> {
  private closed = false;
  private failure: Error | undefined;
  private readonly values: Buffer[] = [];
  private readonly waiters: Array<{
    readonly reject: (error: Error) => void;
    readonly resolve: (result: IteratorResult<Uint8Array>) => void;
  }> = [];

  public push(value: string): void {
    const bytes = Buffer.from(value, 'utf8');
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: bytes });
      return;
    }
    this.values.push(bytes);
  }

  public close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined });
    }
  }

  public fail(error: Error): void {
    this.failure = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const value = this.values.shift();
        if (value !== undefined) {
          return { done: false, value };
        }
        if (this.failure !== undefined) {
          throw this.failure;
        }
        if (this.closed) {
          return { done: true, value: undefined };
        }
        return new Promise((resolve, reject) => this.waiters.push({ reject, resolve }));
      },
    };
  }
}

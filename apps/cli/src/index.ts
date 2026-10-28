import { createTrustedFixtureDriver } from '../../../fixtures/readonly-sim/src/driver.js';
import { runSandboxBackendLinuxSuite } from '../../../fixtures/host-boundary/src/backend-suite.js';
import { runLinuxReadonlyFixtureSuite } from '../../../fixtures/readonly-sim/src/linux-broker.js';
import { createAdmissionFixture } from '../../../fixtures/admission/src/driver.js';
import {
  ADMISSION_FEATURE,
  COUNTER_SIM_CAPABILITY,
  COUNTER_SIM_RESOURCE,
  COUNTER_SIM_SCHEMA_VERSION,
  type JsonRpcResponse,
  type JsonValue,
} from '../../../packages/contracts/src/index.js';

const [command, ...argumentsValue] = process.argv.slice(2);

await main();

async function main(): Promise<void> {
  if (command === 'demo') {
    const grantMode = parseGrantMode(argumentsValue);

    if (grantMode === undefined) {
      writeUsage();
      process.exitCode = 1;
      return;
    }

    runDemo(grantMode);
    return;
  }

  if (command === 'linux-demo') {
    const image = parseLinuxImage(argumentsValue);

    if (image === undefined) {
      writeUsage();
      process.exitCode = 1;
      return;
    }

    try {
      const suite = await runLinuxReadonlyFixtureSuite({ image });
      console.log(
        JSON.stringify(
          {
            executionScope:
              'fixed ARM64 Linux reference fixture; this is not T1 or general package qualification',
            suite,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error('Linux fixture qualification or execution failed.');
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'admission-demo') {
    const mode = parseAdmissionMode(argumentsValue);

    if (mode === undefined) {
      writeUsage();
      process.exitCode = 1;
      return;
    }

    await runAdmissionDemo(mode);
    return;
  }

  if (command === 'sandbox-demo') {
    const image = parseLinuxImage(argumentsValue);

    if (image === undefined) {
      writeUsage();
      process.exitCode = 1;
      return;
    }

    try {
      const suite = await runSandboxBackendLinuxSuite(image);
      console.log(
        JSON.stringify(
          {
            executionScope:
              'fixed ARM64 Linux offline sandbox profiles; this is not T1, Chromium, or package-fetch qualification',
            suite,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(sandboxDemoFailureDiagnostic(error));
      process.exitCode = 1;
    }
    return;
  }

  writeUsage();
  process.exitCode = 1;
}

function sandboxDemoFailureDiagnostic(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('T004 Linux suite failed during ')) {
    return error.message;
  }
  return 'Linux sandbox backend qualification or execution failed.';
}

async function runAdmissionDemo(
  mode: 'allow' | 'cancel-first' | 'forged' | 'recovery' | 'ungranted',
): Promise<void> {
  const fixture = createAdmissionFixture(
    mode === 'recovery' ? { observationDeadlineMs: 5, observationMode: 'accepted' } : {},
  );

  try {
    const initialize = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'initialize-admission',
      method: 'runtime.initialize',
      params: {
        protocolVersion: 'qdroid.rpc/v0.1',
        requiredFeatures: [ADMISSION_FEATURE],
      },
    });
    if (mode === 'allow' || mode === 'cancel-first' || mode === 'forged' || mode === 'recovery') {
      fixture.applyGrant({
        effect: 'allow',
        expiresAt: Date.now() + 60_000,
        maxAmount: 10,
        remainingUses: 1,
      });
    }

    const invocationParams: Record<string, JsonValue> = {
      arguments: { amount: 1, counterId: COUNTER_SIM_RESOURCE },
      capability: COUNTER_SIM_CAPABILITY,
      idempotencyKey: `cli-${mode}`,
      schemaVersion: COUNTER_SIM_SCHEMA_VERSION,
    };
    if (mode === 'forged') {
      invocationParams.principal = 'caller-supplied-authority';
    }
    const invocation = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'invoke-admission',
      method: 'capabilities.invoke',
      params: invocationParams,
    });
    const taskId = responseTaskId(invocation);
    const finalTask =
      taskId === undefined
        ? undefined
        : mode === 'allow'
          ? fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, taskId)
          : mode === 'cancel-first'
            ? fixture.channel.request({
                jsonrpc: '2.0',
                id: 'cancel-admission',
                method: 'tasks.cancel',
                params: { reason: 'CLI cancellation fixture', taskId },
              })
            : mode === 'recovery'
              ? await reconcileAcceptedFixture(fixture, taskId)
              : undefined;

    console.log(
      JSON.stringify(
        {
          executionScope:
            'trusted local admission fixture; use USE-002 for Linux sandbox execution',
          finalTask,
          initialize,
          invocation,
          mode,
          provider: {
            attempts: fixture.counter.attemptCount,
            effects: fixture.counter.effectCount,
            value: fixture.counter.counterValue(),
          },
          recovery: {
            instruction:
              'For QD_OUTCOME_UNKNOWN, call tasks.get then trusted reconciliation; do not reuse the key to resend.',
          },
        },
        null,
        2,
      ),
    );
  } finally {
    fixture.close();
  }
}

function runDemo(grantMode: 'allow' | 'deny' | 'none'): void {
  const fixture = createTrustedFixtureDriver({ grantMode });

  try {
    const initialize = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'initialize',
      method: 'runtime.initialize',
      params: {
        protocolVersion: 'qdroid.rpc/v0.1',
        requiredFeatures: [],
      },
    });
    const invocation = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'read-status',
      method: 'capabilities.invoke',
      params: {
        arguments: {},
        capability: 'sim.status.read/v1',
        schemaVersion: 'qdroid.capability.sim.status.read/v1',
      },
    });

    console.log(
      JSON.stringify(
        {
          audit: fixture.audit(),
          executionScope: 'trusted host fixture only; this is not a Linux sandbox qualification',
          grantMode,
          initialize,
          invocation,
          simulatorOperationCount: fixture.simulator.operationCount,
        },
        null,
        2,
      ),
    );
  } finally {
    fixture.close();
  }
}

function parseGrantMode(argumentsValue: string[]): 'allow' | 'deny' | 'none' | undefined {
  if (argumentsValue.length === 0) {
    return 'allow';
  }

  if (argumentsValue.length !== 2 || argumentsValue[0] !== '--fixture') {
    return undefined;
  }

  const value = argumentsValue[1];

  return value === 'allow' || value === 'deny' || value === 'none' ? value : undefined;
}

function parseLinuxImage(argumentsValue: string[]): string | undefined {
  if (argumentsValue.length !== 2 || argumentsValue[0] !== '--image') {
    return undefined;
  }

  const image = argumentsValue[1];

  return image === undefined || image.length === 0 || image.length > 300 ? undefined : image;
}

function parseAdmissionMode(
  argumentsValue: string[],
): 'allow' | 'cancel-first' | 'forged' | 'recovery' | 'ungranted' | undefined {
  if (argumentsValue.length === 0) {
    return 'allow';
  }
  if (argumentsValue.length !== 2 || argumentsValue[0] !== '--fixture') {
    return undefined;
  }
  const mode = argumentsValue[1];
  return mode === 'allow' ||
    mode === 'cancel-first' ||
    mode === 'forged' ||
    mode === 'recovery' ||
    mode === 'ungranted'
    ? mode
    : undefined;
}

async function reconcileAcceptedFixture(
  fixture: ReturnType<typeof createAdmissionFixture>,
  taskId: string,
): Promise<{
  afterAuthoritativeQuery: unknown;
  attemptsAfterUnknown: number;
  effectsAfterUnknown: number;
  unknown: unknown;
}> {
  const dispatched = fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, taskId);
  await new Promise((resolve) => setTimeout(resolve, 15));
  const unknown = fixture.core.reconcileCounterTask(fixture.channel.trustedBinding, taskId);
  const attemptsAfterUnknown = fixture.counter.attemptCount;
  const effectsAfterUnknown = fixture.counter.effectCount;
  fixture.counter.completeAccepted(unknown.admissionId, unknown.providerEpoch);
  const afterAuthoritativeQuery = fixture.core.reconcileCounterTask(
    fixture.channel.trustedBinding,
    taskId,
  );

  return {
    afterAuthoritativeQuery,
    attemptsAfterUnknown,
    effectsAfterUnknown,
    unknown: { dispatched, state: unknown.state },
  };
}

function responseTaskId(response: JsonRpcResponse): string | undefined {
  if ('error' in response) {
    return undefined;
  }
  const task = (response.result as { task?: { taskId?: unknown } }).task;
  return typeof task?.taskId === 'string' ? task.taskId : undefined;
}

function writeUsage(): void {
  console.error('Usage: qdroid demo [--fixture allow|deny|none]');
  console.error(
    '       qdroid admission-demo [--fixture allow|cancel-first|forged|recovery|ungranted]',
  );
  console.error('       qdroid linux-demo --image <qualified-fixture-image>');
  console.error('       qdroid sandbox-demo --image <qualified-fixture-image>');
}

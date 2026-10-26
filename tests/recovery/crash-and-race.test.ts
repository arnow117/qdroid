import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createAdmissionFixture } from '../../fixtures/admission/src/driver.js';
import {
  ADMISSION_FEATURE,
  COUNTER_SIM_CAPABILITY,
  COUNTER_SIM_RESOURCE,
  COUNTER_SIM_SCHEMA_VERSION,
  type JsonRpcResponse,
} from '../../packages/contracts/src/index.js';

const crashWorker = resolve('dist/fixtures/admission/src/crash-worker.js');
const raceWorker = resolve('dist/fixtures/admission/src/race-worker.js');

test('two independent Node processes precheck separate tasks but only one consumes a one-use budget', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qdroid-race-'));
  const fixture = createAdmissionFixture({
    counterDatabasePath: join(directory, 'provider.sqlite'),
    policyDatabasePath: join(directory, 'policy.sqlite'),
  });
  const workers: ChildProcess[] = [];

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const leftTask = queue(fixture, 'budget-race-left', 1);
    const rightTask = queue(fixture, 'budget-race-right', 1);
    const readyDirectory = join(directory, 'ready');
    const releasePath = join(directory, 'release');
    const sharedArguments = [
      join(directory, 'policy.sqlite'),
      join(directory, 'provider.sqlite'),
      JSON.stringify(fixture.channel.trustedBinding),
      readyDirectory,
      releasePath,
    ];
    mkdirSync(readyDirectory);
    const left = child(raceWorker, [
      ...sharedArguments.slice(0, 3),
      taskId(leftTask),
      ...sharedArguments.slice(3),
    ]);
    const right = child(raceWorker, [
      ...sharedArguments.slice(0, 3),
      taskId(rightTask),
      ...sharedArguments.slice(3),
    ]);
    workers.push(left, right);

    await waitFor(
      () => readdirSync(readyDirectory).filter((entry) => entry.endsWith('.ready')).length === 2,
      'both independent workers to precheck the one-use budget',
    );
    writeFileSync(releasePath, 'commit');
    const exits = await Promise.all([waitForExit(left), waitForExit(right)]);
    for (const exit of exits) {
      assert.equal(exit.code, 0);
      assert.equal(exit.signal, null);
    }

    const states = [
      fixture.policy.getCounterTask(fixture.channel.trustedBinding, taskId(leftTask)).state,
      fixture.policy.getCounterTask(fixture.channel.trustedBinding, taskId(rightTask)).state,
    ].sort();
    assert.deepEqual(states, ['rejected', 'succeeded']);
    assert.equal(fixture.counter.attemptCount, 1);
    assert.equal(fixture.counter.effectCount, 1);
    assert.equal(fixture.counter.counterValue(), 1);
  } finally {
    await Promise.all(workers.map((worker) => stopChild(worker)));
    fixture.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test('two independent Node processes replay one task without a second provider attempt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qdroid-replay-'));
  const fixture = createAdmissionFixture({
    counterDatabasePath: join(directory, 'provider.sqlite'),
    policyDatabasePath: join(directory, 'policy.sqlite'),
  });
  const workers: ChildProcess[] = [];

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const queued = queue(fixture, 'same-task-replay', 1);
    const readyDirectory = join(directory, 'ready');
    const releasePath = join(directory, 'release');
    const sharedArguments = [
      join(directory, 'policy.sqlite'),
      join(directory, 'provider.sqlite'),
      JSON.stringify(fixture.channel.trustedBinding),
      taskId(queued),
      readyDirectory,
      releasePath,
    ];
    mkdirSync(readyDirectory);
    const left = child(raceWorker, sharedArguments);
    const right = child(raceWorker, sharedArguments);
    workers.push(left, right);

    await waitFor(
      () => readdirSync(readyDirectory).filter((entry) => entry.endsWith('.ready')).length === 2,
      'both independent workers to precheck one replayed task',
    );
    writeFileSync(releasePath, 'commit');
    const exits = await Promise.all([waitForExit(left), waitForExit(right)]);
    for (const exit of exits) {
      assert.equal(exit.code, 0);
      assert.equal(exit.signal, null);
    }

    assert.equal(
      fixture.policy.getCounterTask(fixture.channel.trustedBinding, taskId(queued)).state,
      'succeeded',
    );
    assert.equal(fixture.counter.attemptCount, 1);
    assert.equal(fixture.counter.effectCount, 1);
  } finally {
    await Promise.all(workers.map((worker) => stopChild(worker)));
    fixture.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test('independent cancellation and approved dispatch prechecks race without a second outcome', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qdroid-cancel-dispatch-race-'));
  const fixture = createAdmissionFixture({
    counterDatabasePath: join(directory, 'provider.sqlite'),
    policyDatabasePath: join(directory, 'policy.sqlite'),
  });
  const workers: ChildProcess[] = [];

  try {
    initialize(fixture);
    fixture.applyGrant({ ...allowGrant(1), requiresApproval: true });
    const queued = queue(fixture, 'approval-cancel-dispatch-race', 1);
    const queuedTask = fixture.policy.getCounterTask(
      fixture.channel.trustedBinding,
      taskId(queued),
    );
    fixture.applyApproval({
      capability: COUNTER_SIM_CAPABILITY,
      digest: queuedTask.requestDigest,
      expiresAt: Date.now() + 60_000,
      resourceId: COUNTER_SIM_RESOURCE,
      taskId: queuedTask.taskId,
    });
    const readyDirectory = join(directory, 'ready');
    const releasePath = join(directory, 'release');
    const sharedArguments = [
      join(directory, 'policy.sqlite'),
      join(directory, 'provider.sqlite'),
      JSON.stringify(fixture.channel.trustedBinding),
      taskId(queued),
      readyDirectory,
      releasePath,
    ];
    mkdirSync(readyDirectory);
    const dispatch = child(raceWorker, sharedArguments);
    const cancel = child(raceWorker, [...sharedArguments, 'cancel']);
    workers.push(dispatch, cancel);

    await waitFor(
      () => readdirSync(readyDirectory).filter((entry) => entry.endsWith('.ready')).length === 2,
      'the dispatch and cancellation workers to precheck before release',
    );
    writeFileSync(releasePath, 'release');
    const exits = await Promise.all([waitForExit(dispatch), waitForExit(cancel)]);
    for (const exit of exits) {
      assert.equal(exit.code, 0);
      assert.equal(exit.signal, null);
    }

    const finalTask = fixture.policy.getCounterTask(fixture.channel.trustedBinding, taskId(queued));
    assert.ok(finalTask.state === 'canceled' || finalTask.state === 'succeeded');
    assert.equal(fixture.counter.attemptCount, finalTask.state === 'succeeded' ? 1 : 0);
    assert.equal(fixture.counter.effectCount, finalTask.state === 'succeeded' ? 1 : 0);
  } finally {
    await Promise.all(workers.map((worker) => stopChild(worker)));
    fixture.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

for (const scenario of [
  { durableEffects: 0, effects: 1, phase: 'before-commit', resultingState: 'succeeded' },
  {
    durableEffects: 0,
    effects: 0,
    phase: 'after-commit-before-send',
    resultingState: 'unknown',
  },
  {
    durableEffects: 1,
    effects: 1,
    phase: 'after-effect-before-result',
    resultingState: 'succeeded',
  },
  { durableEffects: 1, effects: 1, phase: 'after-persisted-result', resultingState: 'succeeded' },
] as const) {
  test(`SIGKILL ${scenario.phase} preserves durable evidence without automatic replay`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qdroid-crash-'));
    const fixture = createAdmissionFixture({
      counterDatabasePath: join(directory, 'provider.sqlite'),
      policyDatabasePath: join(directory, 'policy.sqlite'),
    });
    let worker: ChildProcess | undefined;

    try {
      initialize(fixture);
      fixture.applyGrant(allowGrant(1));
      const queued = queue(fixture, `crash-${scenario.phase}`, 1);
      worker = child(crashWorker, [
        scenario.phase,
        join(directory, 'policy.sqlite'),
        join(directory, 'provider.sqlite'),
        JSON.stringify(fixture.channel.trustedBinding),
        taskId(queued),
        join(directory, 'crash-report.json'),
      ]);
      const reportPath = join(directory, 'crash-report.json');
      await waitFor(() => existsSync(reportPath), `crash report for ${scenario.phase}`);
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { sessionId?: string };

      assert.equal(worker.exitCode, null, `worker exited before the ${scenario.phase} kill point`);
      assert.equal(
        worker.signalCode,
        null,
        `worker exited before the ${scenario.phase} kill point`,
      );
      const workerClosed = waitForExit(worker);
      assert.equal(worker.kill('SIGKILL'), true);
      const workerExit = await workerClosed;
      assert.equal(workerExit.signal, 'SIGKILL');

      if (report.sessionId !== undefined) {
        fixture.core.recoverAfterConfirmedExecutorExit(
          fixture.channel.trustedBinding,
          report.sessionId,
        );
      }

      const current = fixture.policy.getCounterTask(fixture.channel.trustedBinding, taskId(queued));
      const expectedRecoveredState =
        scenario.phase === 'before-commit'
          ? 'queued'
          : scenario.phase === 'after-persisted-result'
            ? 'succeeded'
            : 'unknown';
      assert.equal(current.state, expectedRecoveredState);
      assert.equal(fixture.counter.attemptCount, scenario.durableEffects);
      assert.equal(fixture.counter.effectCount, scenario.durableEffects);

      if (scenario.phase !== 'before-commit') {
        const budgetProbe = queue(fixture, `budget-retained-${scenario.phase}`, 1);
        const rejected = fixture.core.dispatchQueuedCounterTask(
          fixture.channel.trustedBinding,
          taskId(budgetProbe),
        );
        assert.equal(rejected.state, 'rejected');
        assert.equal(fixture.counter.effectCount, scenario.effects);
      }

      const recovered =
        current.state === 'queued'
          ? fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, taskId(queued))
          : current.state === 'unknown'
            ? fixture.core.reconcileCounterTask(fixture.channel.trustedBinding, taskId(queued))
            : current;

      assert.equal(recovered.state, scenario.resultingState);
      assert.equal(fixture.counter.effectCount, scenario.effects);
      const afterRepeat = fixture.core.dispatchQueuedCounterTask(
        fixture.channel.trustedBinding,
        taskId(queued),
      );
      assert.equal(afterRepeat.state, scenario.resultingState);
      assert.equal(fixture.counter.effectCount, scenario.effects);
    } finally {
      if (worker !== undefined) {
        await stopChild(worker);
      }
      fixture.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });
}

function child(script: string, argumentsValue: string[]): ChildProcess {
  return spawn(process.execPath, [script, ...argumentsValue], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for worker ${child.pid ?? 'unknown'} to exit.`));
    }, 2_000);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = waitForExit(child);
    child.kill('SIGKILL');
    await exited;
  }
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function allowGrant(remainingUses: number) {
  return {
    effect: 'allow' as const,
    expiresAt: Date.now() + 60_000,
    maxAmount: 10,
    remainingUses,
  };
}

function initialize(fixture: ReturnType<typeof createAdmissionFixture>): void {
  const response = fixture.channel.request({
    jsonrpc: '2.0',
    id: 'initialize',
    method: 'runtime.initialize',
    params: { protocolVersion: 'qdroid.rpc/v0.1', requiredFeatures: [ADMISSION_FEATURE] },
  });
  assert.ok('result' in response);
}

function queue(
  fixture: ReturnType<typeof createAdmissionFixture>,
  idempotencyKey: string,
  amount: number,
): JsonRpcResponse {
  const response = fixture.channel.request({
    jsonrpc: '2.0',
    id: `invoke-${idempotencyKey}`,
    method: 'capabilities.invoke',
    params: {
      arguments: { amount, counterId: COUNTER_SIM_RESOURCE },
      capability: COUNTER_SIM_CAPABILITY,
      idempotencyKey,
      schemaVersion: COUNTER_SIM_SCHEMA_VERSION,
    },
  });
  assert.ok('result' in response);
  return response;
}

function taskId(response: JsonRpcResponse): string {
  assert.ok('result' in response);
  const task = (response.result as { task?: { taskId?: unknown } }).task;
  assert.equal(typeof task?.taskId, 'string');
  return task?.taskId as string;
}

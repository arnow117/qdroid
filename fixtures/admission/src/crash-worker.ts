import {
  PersistentCounterSimulator,
  ReferenceSimulator,
} from '../../../adapters/reference-simulator/src/index.js';
import { RuntimeCore } from '../../../packages/core/src/index.js';
import { PolicyAuthority } from '../../../packages/policy/src/index.js';
import type { BoundWorkloadIdentity } from '../../../packages/supervisor/src/index.js';
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';

type CrashPhase =
  | 'after-commit-before-send'
  | 'after-effect-before-result'
  | 'after-persisted-result'
  | 'before-commit';

const [phaseValue, policyPath, providerPath, serializedIdentity, taskId, reportPath] =
  process.argv.slice(2);
const phase = phaseValue as CrashPhase;

if (
  !isPhase(phase) ||
  policyPath === undefined ||
  providerPath === undefined ||
  serializedIdentity === undefined ||
  taskId === undefined ||
  reportPath === undefined
) {
  throw new Error('The crash worker arguments are invalid.');
}

const identity = JSON.parse(serializedIdentity) as BoundWorkloadIdentity;
const policy = new PolicyAuthority(policyPath);
const provider = new PersistentCounterSimulator({ databasePath: providerPath });
const core = new RuntimeCore({
  counterProvider: provider,
  policy,
  provider: new ReferenceSimulator(),
});

if (phase === 'before-commit') {
  report({ phase });
  await waitUntilKilled();
}

const sessionId = policy.acquireTrustedExecutorSession(identity);

if (phase === 'after-commit-before-send') {
  policy.commitCounterDispatch(identity, taskId, sessionId);
  report({ phase, sessionId });
  await waitUntilKilled();
}

if (phase === 'after-effect-before-result') {
  const dispatch = policy.commitCounterDispatch(identity, taskId, sessionId);
  const task = policy.getCounterTask(identity, taskId);
  if (dispatch.decision !== 'fresh') {
    throw new Error('The crash worker did not receive a fresh dispatch permission.');
  }
  provider.invoke({
    admissionId: task.admissionId,
    amount: task.amount,
    counterId: task.counterId,
    providerEpoch: task.providerEpoch,
    taskId: task.taskId,
  });
  report({ phase, sessionId });
  await waitUntilKilled();
}

core.dispatchQueuedCounterTask(identity, taskId);
report({ phase, sessionId });
await waitUntilKilled();

function report(value: Record<string, string>): void {
  if (reportPath === undefined) {
    throw new Error('The crash worker report path is missing.');
  }

  const temporaryPath = `${reportPath}.${process.pid}.tmp`;
  const descriptor = openSync(temporaryPath, 'wx', 0o600);
  let writeFailure: unknown;

  try {
    writeFileSync(descriptor, JSON.stringify(value), 'utf8');
    fsyncSync(descriptor);
  } catch (error) {
    writeFailure = error;
    throw error;
  } finally {
    try {
      closeSync(descriptor);
    } catch (closeError) {
      if (writeFailure === undefined) {
        throw closeError;
      }
      throw new AggregateError(
        [writeFailure, closeError],
        'The crash worker could not write and close its report marker.',
      );
    }
  }

  renameSync(temporaryPath, reportPath);
}

function waitUntilKilled(): Promise<never> {
  return new Promise(() => {
    setInterval(() => undefined, 1_000);
  });
}

function isPhase(value: string | undefined): value is CrashPhase {
  return (
    value === 'before-commit' ||
    value === 'after-commit-before-send' ||
    value === 'after-effect-before-result' ||
    value === 'after-persisted-result'
  );
}

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAdmissionFixture } from '../../fixtures/admission/src/driver.js';
import {
  ADMISSION_FEATURE,
  COUNTER_SIM_CAPABILITY,
  COUNTER_SIM_RESOURCE,
  COUNTER_SIM_SCHEMA_VERSION,
  type JsonRpcResponse,
} from '../../packages/contracts/src/index.js';

test('admission queues once, commits a budget once, and does not redeliver duplicate work', () => {
  const fixture = createAdmissionFixture();

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const queued = invokeCounter(fixture, 'same-key', 2);
    const duplicate = invokeCounter(fixture, 'same-key', 2);

    assert.equal(taskId(queued), taskId(duplicate));
    assert.equal(fixture.counter.attemptCount, 0);
    assert.equal(
      fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, taskId(queued)).state,
      'succeeded',
    );
    assert.equal(fixture.counter.attemptCount, 1);
    assert.equal(fixture.counter.effectCount, 1);
    assert.equal(fixture.counter.counterValue(), 2);

    const repeatedDispatch = fixture.core.dispatchQueuedCounterTask(
      fixture.channel.trustedBinding,
      taskId(queued),
    );
    assert.equal(repeatedDispatch.state, 'succeeded');
    assert.equal(fixture.counter.attemptCount, 1);
    assert.equal(errorCode(invokeCounterRaw(fixture, 'same-key', 3)), 'QD_IDEMPOTENCY_CONFLICT');
  } finally {
    fixture.close();
  }
});

test('admission initialization requires a live trusted binding while legacy initialization remains compatible', () => {
  const unbound = createAdmissionFixture({ registerContext: false });
  const bound = createAdmissionFixture();

  try {
    assert.equal(
      errorCode(
        unbound.channel.request({
          jsonrpc: '2.0',
          id: 'unbound-admission',
          method: 'runtime.initialize',
          params: { protocolVersion: 'qdroid.rpc/v0.1', requiredFeatures: [ADMISSION_FEATURE] },
        }),
      ),
      'QD_STALE_CONTEXT',
    );
    const legacy = unbound.channel.request({
      jsonrpc: '2.0',
      id: 'unbound-legacy',
      method: 'runtime.initialize',
      params: { protocolVersion: 'qdroid.rpc/v0.1', requiredFeatures: [] },
    });
    assert.ok('result' in legacy);

    const current = bound.channel.trustedBinding;
    assert.equal(
      errorCode(
        bound.core.handle(
          { ...current, channelId: 'obsolete-channel' },
          {
            jsonrpc: '2.0',
            id: 'old-channel-admission',
            method: 'runtime.initialize',
            params: { protocolVersion: 'qdroid.rpc/v0.1', requiredFeatures: [ADMISSION_FEATURE] },
          },
        ),
      ),
      'QD_STALE_CONTEXT',
    );
    bound.policy.registerTrustedCounterContext({
      identity: current,
      leaseExpiresAt: Date.now() - 1,
      profileGeneration: 1,
      providerEpoch: 1,
      providerId: 'reference-counter',
    });
    assert.equal(
      errorCode(
        bound.channel.request({
          jsonrpc: '2.0',
          id: 'expired-admission',
          method: 'runtime.initialize',
          params: { protocolVersion: 'qdroid.rpc/v0.1', requiredFeatures: [ADMISSION_FEATURE] },
        }),
      ),
      'QD_STALE_CONTEXT',
    );
  } finally {
    unbound.close();
    bound.close();
  }
});

test('admission capability discovery exposes only live allowed counter descriptors', () => {
  const fixture = createAdmissionFixture();

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const listed = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'list-counter',
      method: 'capabilities.list',
      params: { capabilityPrefix: 'sim.counter' },
    });
    assert.deepEqual('result' in listed && listed.result, {
      capabilities: [
        {
          capability: COUNTER_SIM_CAPABILITY,
          schemaVersion: COUNTER_SIM_SCHEMA_VERSION,
        },
      ],
    });

    fixture.applyGrant({ ...allowGrant(1), effect: 'deny' });
    const denied = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'list-counter-denied',
      method: 'capabilities.list',
      params: {},
    });
    assert.deepEqual('result' in denied && denied.result, { capabilities: [] });

    const legacy = createAdmissionFixture();
    try {
      legacy.applyGrant(allowGrant(1));
      const legacyInitialized = legacy.channel.request({
        jsonrpc: '2.0',
        id: 'legacy-list-init',
        method: 'runtime.initialize',
        params: { protocolVersion: 'qdroid.rpc/v0.1', requiredFeatures: [] },
      });
      assert.ok('result' in legacyInitialized);
      const legacyList = legacy.channel.request({
        jsonrpc: '2.0',
        id: 'legacy-list',
        method: 'capabilities.list',
        params: {},
      });
      assert.deepEqual('result' in legacyList && legacyList.result, { capabilities: [] });
    } finally {
      legacy.close();
    }
  } finally {
    fixture.close();
  }
});

test('queued cancellation wins before dispatch and consumes neither budget nor provider effect', () => {
  const fixture = createAdmissionFixture();

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const queued = invokeCounter(fixture, 'cancel-before', 1);
    const canceled = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'cancel',
      method: 'tasks.cancel',
      params: { reason: 'operator requested cancellation', taskId: taskId(queued) },
    });

    assert.equal(responseTask(canceled).state, 'canceled');
    assert.equal(
      fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, taskId(queued)).state,
      'canceled',
    );
    assert.equal(fixture.counter.attemptCount, 0);
    assert.equal(fixture.counter.effectCount, 0);
  } finally {
    fixture.close();
  }
});

test('accepted delivery remains dispatched until an authoritative terminal observation', () => {
  const fixture = createAdmissionFixture({ observationMode: 'accepted' });

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const queued = invokeCounter(fixture, 'cancel-after', 1);
    const dispatched = fixture.core.dispatchQueuedCounterTask(
      fixture.channel.trustedBinding,
      taskId(queued),
    );
    assert.equal(dispatched.state, 'dispatched');

    const canceled = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'cancel',
      method: 'tasks.cancel',
      params: { reason: 'operator requested cancellation', taskId: taskId(queued) },
    });
    assert.equal(responseTask(canceled).state, 'canceled');
    assert.equal(fixture.counter.effectCount, 0);

    const reconciled = fixture.core.reconcileCounterTask(
      fixture.channel.trustedBinding,
      taskId(queued),
    );
    assert.equal(reconciled.state, 'canceled');
  } finally {
    fixture.close();
  }
});

test('an accepted provider observation becomes unknown after its persisted finite deadline', async () => {
  const fixture = createAdmissionFixture({ observationDeadlineMs: 5, observationMode: 'accepted' });

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const queued = invokeCounter(fixture, 'accepted-deadline', 1);
    const dispatched = fixture.core.dispatchQueuedCounterTask(
      fixture.channel.trustedBinding,
      taskId(queued),
    );
    assert.equal(dispatched.state, 'dispatched');

    await new Promise((resolve) => setTimeout(resolve, 15));
    const expired = fixture.core.reconcileCounterTask(
      fixture.channel.trustedBinding,
      taskId(queued),
    );
    assert.equal(expired.state, 'unknown');
    assert.equal(fixture.counter.attemptCount, 1);
    assert.equal(fixture.counter.effectCount, 0);
  } finally {
    fixture.close();
  }
});

test('an unknown accepted task reconciles the original provider operation without a new attempt', async () => {
  const fixture = createAdmissionFixture({ observationDeadlineMs: 5, observationMode: 'accepted' });

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const queued = invokeCounter(fixture, 'accepted-reconcile', 1);
    const taskIdValue = taskId(queued);
    const dispatched = fixture.core.dispatchQueuedCounterTask(
      fixture.channel.trustedBinding,
      taskIdValue,
    );
    assert.equal(dispatched.state, 'dispatched');
    await new Promise((resolve) => setTimeout(resolve, 15));

    const unknown = fixture.core.reconcileCounterTask(fixture.channel.trustedBinding, taskIdValue);
    assert.equal(unknown.state, 'unknown');
    assert.equal(fixture.counter.attemptCount, 1);
    assert.equal(fixture.counter.effectCount, 0);

    fixture.counter.completeAccepted(unknown.admissionId, unknown.providerEpoch);
    const reconciled = fixture.core.reconcileCounterTask(
      fixture.channel.trustedBinding,
      taskIdValue,
    );
    assert.equal(reconciled.state, 'succeeded');
    assert.equal(fixture.counter.attemptCount, 1);
    assert.equal(fixture.counter.effectCount, 1);
  } finally {
    fixture.close();
  }
});

test('unsupported observation becomes unknown without a new send right or refund', () => {
  const fixture = createAdmissionFixture({ observationMode: 'unsupported' });

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const queued = invokeCounter(fixture, 'unsupported-observation', 1);
    const unknown = fixture.core.dispatchQueuedCounterTask(
      fixture.channel.trustedBinding,
      taskId(queued),
    );

    assert.equal(unknown.state, 'unknown');
    assert.equal(fixture.counter.attemptCount, 1);
    assert.equal(fixture.counter.effectCount, 0);
    assert.equal(
      fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, taskId(queued)).state,
      'unknown',
    );
    assert.equal(fixture.counter.attemptCount, 1);
  } finally {
    fixture.close();
  }
});

test('approval and a real SQLite COMMIT rejection prevent provider invocation', () => {
  const fixture = createAdmissionFixture();

  try {
    initialize(fixture);
    fixture.applyGrant({ ...allowGrant(1), requiresApproval: true });
    const queued = invokeCounter(fixture, 'approval', 1);

    assert.throws(
      () => fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, taskId(queued)),
      (error: unknown) => error instanceof Error && /Permission denied/.test(error.message),
    );
    assert.equal(fixture.counter.attemptCount, 0);

    fixture.applyApproval({
      capability: COUNTER_SIM_CAPABILITY,
      digest: fixture.policy.getCounterTask(fixture.channel.trustedBinding, taskId(queued))
        .requestDigest,
      expiresAt: Date.now() + 60_000,
      resourceId: COUNTER_SIM_RESOURCE,
      taskId: taskId(queued),
    });
    fixture.policy.rejectNextCommitForTests();
    assert.throws(() =>
      fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, taskId(queued)),
    );
    assert.equal(fixture.counter.attemptCount, 0);
    assert.equal(
      fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, taskId(queued)).state,
      'succeeded',
    );
    assert.equal(fixture.counter.attemptCount, 1);
  } finally {
    fixture.close();
  }
});

test('policy generation changes reject queued work before provider invocation', () => {
  const fixture = createAdmissionFixture();

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const queued = invokeCounter(fixture, 'revoke-before-dispatch', 1);
    fixture.policy.setTrustedInstallationPolicy(fixture.channel.trustedBinding.installationId, {
      hostAllowed: true,
      installationAllowed: false,
    });

    assert.equal(
      fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, taskId(queued)).state,
      'rejected',
    );
    assert.equal(fixture.counter.attemptCount, 0);
  } finally {
    fixture.close();
  }
});

test('queued work is bound to its original provider and profile context before a fresh dispatch', () => {
  const fixture = createAdmissionFixture();

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const queued = invokeCounter(fixture, 'original-context', 1);
    const identity = fixture.channel.trustedBinding;
    fixture.policy.registerTrustedCounterContext({
      identity,
      leaseExpiresAt: Date.now() + 60_000,
      profileGeneration: 2,
      providerEpoch: 2,
      providerId: 'reference-counter-v2',
    });

    assert.equal(
      fixture.core.dispatchQueuedCounterTask(identity, taskId(queued)).state,
      'rejected',
    );
    assert.equal(fixture.counter.attemptCount, 0);
    assert.equal(fixture.counter.effectCount, 0);
  } finally {
    fixture.close();
  }
});

test('trusted context replacement fences old identity and provider/profile generations', () => {
  const fixture = createAdmissionFixture();

  try {
    const current = fixture.channel.trustedBinding;
    const context = {
      leaseExpiresAt: Date.now() + 60_000,
      profileGeneration: 1,
      providerEpoch: 1,
      providerId: 'reference-counter',
    };
    assert.throws(() =>
      fixture.policy.registerTrustedCounterContext({
        ...context,
        identity: { ...current, channelId: 'forged-channel' },
      }),
    );

    const nextIdentity = {
      ...current,
      bootId: 'next-boot',
      channelId: 'next-channel',
      epoch: current.epoch + 1,
    };
    fixture.policy.registerTrustedCounterContext({
      ...context,
      identity: nextIdentity,
      profileGeneration: 2,
      providerEpoch: 2,
      providerId: 'reference-counter-v2',
    });
    assert.throws(() => fixture.policy.acquireTrustedExecutorSession(current));
    fixture.policy.registerTrustedCounterContext({
      ...context,
      identity: nextIdentity,
      leaseExpiresAt: Date.now() + 120_000,
      profileGeneration: 2,
      providerEpoch: 2,
      providerId: 'reference-counter-v2',
    });
    assert.throws(() =>
      fixture.policy.registerTrustedCounterContext({ ...context, identity: current }),
    );
    assert.throws(() =>
      fixture.policy.registerTrustedCounterContext({
        ...context,
        identity: nextIdentity,
        profileGeneration: 1,
        providerEpoch: 2,
        providerId: 'reference-counter-v2',
      }),
    );
    assert.throws(() =>
      fixture.policy.registerTrustedCounterContext({
        ...context,
        identity: nextIdentity,
        profileGeneration: 2,
        providerEpoch: 1,
        providerId: 'reference-counter-v2',
      }),
    );
  } finally {
    fixture.close();
  }
});

test('task access is limited to the current installation, instance, boot, channel, and epoch', () => {
  const fixture = createAdmissionFixture();

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const ownedTaskId = taskId(invokeCounter(fixture, 'task-owner-scope', 1));
    const owner = fixture.channel.trustedBinding;
    const otherOwner = {
      ...owner,
      channelId: 'other-owner-channel',
      instanceId: 'other-owner-instance',
    };
    fixture.policy.registerTrustedCounterContext({
      identity: otherOwner,
      leaseExpiresAt: Date.now() + 60_000,
      profileGeneration: 1,
      providerEpoch: 1,
      providerId: 'reference-counter',
    });
    assert.throws(() => fixture.policy.getCounterTask(otherOwner, ownedTaskId));

    const replacement = {
      ...owner,
      bootId: 'replacement-boot',
      channelId: 'replacement-channel',
      epoch: owner.epoch + 1,
    };
    fixture.policy.registerTrustedCounterContext({
      identity: replacement,
      leaseExpiresAt: Date.now() + 60_000,
      profileGeneration: 1,
      providerEpoch: 1,
      providerId: 'reference-counter',
    });
    assert.throws(() => fixture.policy.getCounterTask(owner, ownedTaskId));
  } finally {
    fixture.close();
  }
});

test('a provider epoch change permits historical reconciliation but rejects a fresh send', () => {
  const fixture = createAdmissionFixture({ observationMode: 'accepted' });

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(2));
    const historicalTaskId = taskId(invokeCounter(fixture, 'historical-provider-epoch', 1));
    assert.equal(
      fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, historicalTaskId)
        .state,
      'dispatched',
    );
    const freshTaskId = taskId(invokeCounter(fixture, 'new-provider-epoch', 1));
    fixture.policy.registerTrustedCounterContext({
      identity: fixture.channel.trustedBinding,
      leaseExpiresAt: Date.now() + 60_000,
      profileGeneration: 2,
      providerEpoch: 2,
      providerId: 'reference-counter-v2',
    });

    assert.equal(
      fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, freshTaskId).state,
      'rejected',
    );
    const historical = fixture.policy.getCounterTask(
      fixture.channel.trustedBinding,
      historicalTaskId,
    );
    fixture.counter.completeAccepted(historical.admissionId, historical.providerEpoch);
    assert.equal(
      fixture.core.reconcileCounterTask(fixture.channel.trustedBinding, historicalTaskId).state,
      'succeeded',
    );
    assert.equal(fixture.counter.attemptCount, 1);
  } finally {
    fixture.close();
  }
});

test('provider observations bind admission and operation evidence with monotonic versions', () => {
  const fixture = createAdmissionFixture({ observationMode: 'accepted' });

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(2));
    const first = invokeCounter(fixture, 'observation-first', 1);
    const second = invokeCounter(fixture, 'observation-second', 1);
    const firstTaskId = taskId(first);
    const secondTaskId = taskId(second);
    const dispatched = fixture.core.dispatchQueuedCounterTask(
      fixture.channel.trustedBinding,
      firstTaskId,
    );
    assert.equal(dispatched.state, 'dispatched');

    const current = fixture.policy.getCounterTask(fixture.channel.trustedBinding, firstTaskId);
    const observation = fixture.counter.observe(current.admissionId, current.providerEpoch);
    const sessionId = fixture.policy.acquireTrustedExecutorSession(fixture.channel.trustedBinding);
    const duplicate = fixture.policy.recordProviderObservation(
      fixture.channel.trustedBinding,
      firstTaskId,
      sessionId,
      observation,
      'provider-reconcile',
    );
    assert.equal(duplicate.state, 'dispatched');
    assert.equal(duplicate.stateVersion, dispatched.stateVersion);

    const crossTask = fixture.policy.recordProviderObservation(
      fixture.channel.trustedBinding,
      secondTaskId,
      sessionId,
      observation,
      'provider-reconcile',
    );
    assert.equal(crossTask.state, 'queued');
    assert.ok(
      fixture.policy
        .readCounterHistory(fixture.channel.trustedBinding, secondTaskId)
        .some((record) => record.event === 'observation-rejected'),
    );
  } finally {
    fixture.close();
  }
});

test('a replacement executor can cancel and repeatedly query historical provider truth after fencing', () => {
  const fixture = createAdmissionFixture({ observationMode: 'accepted' });

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(2));
    const cancelTaskId = taskId(invokeCounter(fixture, 'recovered-cancel', 1));
    fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, cancelTaskId);
    const oldSession = fixture.policy.acquireTrustedExecutorSession(fixture.channel.trustedBinding);
    fixture.core.recoverAfterConfirmedExecutorExit(fixture.channel.trustedBinding, oldSession);

    const canceled = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'recovered-cancel',
      method: 'tasks.cancel',
      params: { reason: 'replacement executor cancellation', taskId: cancelTaskId },
    });
    assert.equal(responseTask(canceled).state, 'canceled');

    const queryTaskId = taskId(invokeCounter(fixture, 'recovered-query', 1));
    fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, queryTaskId);
    const queryOldSession = fixture.policy.acquireTrustedExecutorSession(
      fixture.channel.trustedBinding,
    );
    fixture.core.recoverAfterConfirmedExecutorExit(fixture.channel.trustedBinding, queryOldSession);
    const unknown = fixture.policy.getCounterTask(fixture.channel.trustedBinding, queryTaskId);
    fixture.counter.completeAccepted(unknown.admissionId, unknown.providerEpoch);
    const reconciled = fixture.core.reconcileCounterTask(
      fixture.channel.trustedBinding,
      queryTaskId,
    );
    assert.equal(reconciled.state, 'succeeded');
    assert.equal(
      fixture.core.reconcileCounterTask(fixture.channel.trustedBinding, queryTaskId).state,
      'succeeded',
    );
    assert.throws(() =>
      fixture.policy.recordProviderObservation(
        fixture.channel.trustedBinding,
        queryTaskId,
        queryOldSession,
        fixture.counter.observe(reconciled.admissionId, reconciled.providerEpoch),
        'provider-reconcile',
      ),
    );
  } finally {
    fixture.close();
  }
});

test('a provider cancellation journal failure becomes unknown with the original task ID', () => {
  const fixture = createAdmissionFixture({ observationMode: 'accepted' });

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const queued = invokeCounter(fixture, 'cancel-journal-failure', 1);
    const taskIdValue = taskId(queued);
    const dispatched = fixture.core.dispatchQueuedCounterTask(
      fixture.channel.trustedBinding,
      taskIdValue,
    );
    fixture.policy.rejectNextOutcomePersistenceForTests();

    const response = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'cancel-journal-failure',
      method: 'tasks.cancel',
      params: { reason: 'persisted cancellation fault', taskId: taskIdValue },
    });
    assert.equal(errorCode(response), 'QD_OUTCOME_UNKNOWN');
    assert.equal('error' in response && response.error.data.taskId, taskIdValue);
    assert.equal(
      fixture.counter.observe(dispatched.admissionId, dispatched.providerEpoch).terminal,
      'stopped',
    );
    assert.equal(
      fixture.policy.getCounterTask(fixture.channel.trustedBinding, taskIdValue).state,
      'unknown',
    );
  } finally {
    fixture.close();
  }
});

test('approvals bind one exact task and are consumed only by its fresh dispatch', () => {
  const fixture = createAdmissionFixture();

  try {
    initialize(fixture);
    fixture.applyGrant({ ...allowGrant(2), requiresApproval: true });
    const first = invokeCounter(fixture, 'approval-first', 1);
    const second = invokeCounter(fixture, 'approval-second', 2);
    const firstTask = fixture.policy.getCounterTask(fixture.channel.trustedBinding, taskId(first));
    const firstApproval = {
      capability: COUNTER_SIM_CAPABILITY as typeof COUNTER_SIM_CAPABILITY,
      digest: firstTask.requestDigest,
      expiresAt: Date.now() + 60_000,
      resourceId: COUNTER_SIM_RESOURCE as typeof COUNTER_SIM_RESOURCE,
      taskId: firstTask.taskId,
    };
    const secondTask = fixture.policy.getCounterTask(
      fixture.channel.trustedBinding,
      taskId(second),
    );
    assert.throws(() => fixture.applyApproval({ ...firstApproval, digest: 'wrong-digest' }));
    assert.throws(() => fixture.applyApproval({ ...firstApproval, expiresAt: Date.now() - 1 }));
    assert.throws(() =>
      fixture.applyApproval({
        ...firstApproval,
        capability: 'wrong-capability' as typeof COUNTER_SIM_CAPABILITY,
      }),
    );
    assert.throws(() =>
      fixture.applyApproval({
        ...firstApproval,
        resourceId: 'wrong-resource' as typeof COUNTER_SIM_RESOURCE,
      }),
    );
    assert.throws(() =>
      fixture.applyApproval({
        ...firstApproval,
        digest: firstTask.requestDigest,
        taskId: secondTask.taskId,
      }),
    );
    assert.throws(() =>
      fixture.policy.applyTrustedApproval({
        ...firstApproval,
        installationId: fixture.channel.trustedBinding.installationId,
        subjectInstanceId: 'other-instance',
      }),
    );
    fixture.applyApproval(firstApproval);

    assert.equal(
      fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, firstTask.taskId)
        .state,
      'succeeded',
    );
    assert.equal(fixture.counter.effectCount, 1);
    assert.equal(
      fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, firstTask.taskId)
        .state,
      'succeeded',
    );
    assert.equal(fixture.counter.effectCount, 1);
    assert.throws(() =>
      fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, taskId(second)),
    );
    assert.equal(fixture.counter.effectCount, 1);

    fixture.applyApproval({
      capability: COUNTER_SIM_CAPABILITY,
      digest: secondTask.requestDigest,
      expiresAt: Date.now() + 60_000,
      resourceId: COUNTER_SIM_RESOURCE,
      taskId: secondTask.taskId,
    });
    assert.equal(
      fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, secondTask.taskId)
        .state,
      'succeeded',
    );
    assert.equal(fixture.counter.effectCount, 2);
  } finally {
    fixture.close();
  }
});

test('a SQLite busy authority rejects before any provider attempt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qdroid-busy-'));
  const policyDatabasePath = join(directory, 'policy.sqlite');
  const counterDatabasePath = join(directory, 'counter.sqlite');
  const fixture = createAdmissionFixture({ counterDatabasePath, policyDatabasePath });
  const blocker = new DatabaseSync(policyDatabasePath);

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    const queued = invokeCounter(fixture, 'sqlite-busy', 1);
    blocker.exec('BEGIN IMMEDIATE');
    assert.throws(() =>
      fixture.core.dispatchQueuedCounterTask(fixture.channel.trustedBinding, taskId(queued)),
    );
    assert.equal(fixture.counter.attemptCount, 0);
  } finally {
    try {
      blocker.exec('ROLLBACK');
    } catch {
      // The assertion can fail before the transaction becomes active.
    }
    blocker.close();
    fixture.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test('provider truth wins when completion, cancellation, and delayed observations arrive in reverse order', () => {
  const fixture = createAdmissionFixture({ observationMode: 'accepted' });

  try {
    initialize(fixture);
    fixture.applyGrant(allowGrant(3));

    const completedFirstId = taskId(invokeCounter(fixture, 'complete-before-cancel', 1));
    const completedFirst = fixture.core.dispatchQueuedCounterTask(
      fixture.channel.trustedBinding,
      completedFirstId,
    );
    fixture.counter.completeAccepted(completedFirst.admissionId, completedFirst.providerEpoch);
    assert.equal(
      fixture.core.reconcileCounterTask(fixture.channel.trustedBinding, completedFirstId).state,
      'succeeded',
    );
    const cancelAfterCompletion = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'cancel-after-complete',
      method: 'tasks.cancel',
      params: { reason: 'too late', taskId: completedFirstId },
    });
    assert.equal(responseTask(cancelAfterCompletion).state, 'succeeded');

    const stoppedFirstId = taskId(invokeCounter(fixture, 'stop-before-complete', 1));
    const stoppedFirst = fixture.core.dispatchQueuedCounterTask(
      fixture.channel.trustedBinding,
      stoppedFirstId,
    );
    const stopResponse = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'stop-before-complete',
      method: 'tasks.cancel',
      params: { reason: 'stop now', taskId: stoppedFirstId },
    });
    assert.equal(responseTask(stopResponse).state, 'canceled');
    assert.throws(() =>
      fixture.counter.completeAccepted(stoppedFirst.admissionId, stoppedFirst.providerEpoch),
    );

    const reverseId = taskId(invokeCounter(fixture, 'reverse-observation', 1));
    const accepted = fixture.core.dispatchQueuedCounterTask(
      fixture.channel.trustedBinding,
      reverseId,
    );
    const acceptedObservation = fixture.counter.observe(
      accepted.admissionId,
      accepted.providerEpoch,
    );
    fixture.counter.completeAccepted(accepted.admissionId, accepted.providerEpoch);
    assert.equal(
      fixture.core.reconcileCounterTask(fixture.channel.trustedBinding, reverseId).state,
      'succeeded',
    );
    const sessionId = fixture.policy.acquireTrustedExecutorSession(fixture.channel.trustedBinding);
    assert.equal(
      fixture.policy.recordProviderObservation(
        fixture.channel.trustedBinding,
        reverseId,
        sessionId,
        acceptedObservation,
        'provider-reconcile',
      ).state,
      'succeeded',
    );
  } finally {
    fixture.close();
  }
});

test('legacy readonly requests reject an idempotency key and malformed surrogate keys reject before queueing', () => {
  const fixture = createAdmissionFixture();

  try {
    const legacyInitialize = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'legacy-initialize',
      method: 'runtime.initialize',
      params: { protocolVersion: 'qdroid.rpc/v0.1', requiredFeatures: [] },
    });
    assert.ok('result' in legacyInitialize);
    const legacyResponse = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'legacy-readonly',
      method: 'capabilities.invoke',
      params: {
        arguments: {},
        capability: 'sim.status.read/v1',
        idempotencyKey: 'must-not-be-silent',
        schemaVersion: 'qdroid.capability.sim.status.read/v1',
      },
    });
    assert.equal(errorCode(legacyResponse), 'QD_VALIDATION_FAILED');

    initialize(fixture);
    fixture.applyGrant(allowGrant(1));
    assert.equal(errorCode(invokeCounterRaw(fixture, '\ud800', 1)), 'QD_VALIDATION_FAILED');
    assert.ok('result' in invokeCounterRaw(fixture, 'valid-😀', 1));
  } finally {
    fixture.close();
  }
});

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

function invokeCounter(
  fixture: ReturnType<typeof createAdmissionFixture>,
  idempotencyKey: string,
  amount: number,
): JsonRpcResponse {
  const response = invokeCounterRaw(fixture, idempotencyKey, amount);
  assert.ok('result' in response);
  return response;
}

function invokeCounterRaw(
  fixture: ReturnType<typeof createAdmissionFixture>,
  idempotencyKey: string,
  amount: number,
): JsonRpcResponse {
  return fixture.channel.request({
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
}

function responseTask(response: JsonRpcResponse): Record<string, unknown> {
  assert.ok('result' in response);
  assert.ok(response.result !== null && typeof response.result === 'object');
  const task = (response.result as { task?: unknown }).task;
  assert.ok(task !== null && typeof task === 'object');
  return task as Record<string, unknown>;
}

function taskId(response: JsonRpcResponse): string {
  const value = responseTask(response).taskId;
  assert.equal(typeof value, 'string');
  return value as string;
}

function errorCode(response: JsonRpcResponse): string | undefined {
  return 'error' in response ? response.error.data.code : undefined;
}

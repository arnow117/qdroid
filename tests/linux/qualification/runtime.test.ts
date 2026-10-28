import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runLateRetirementReservationRecovery,
  runRecoveryLockAcquisitionDeadline,
  runSandboxBackendLinuxSuite,
  runStartupCleanupDeadlineRecovery,
} from '../../../fixtures/host-boundary/src/backend-suite.js';

const image = process.env.QDROID_T004_IMAGE;

test('each offline profile receives an opaque qualification and a guardian-backed execution lifecycle', async () => {
  assert.notEqual(image, undefined, 'QDROID_T004_IMAGE is required for T004 Linux qualification.');

  const result = await runSandboxBackendLinuxSuite(image as string);

  assert.deepEqual(result.profiles, ['tool-offline', 'build-restricted', 'render-offline']);
  assert.equal(result.binaryRoundTrip, true);
  assert.equal(result.deadlineAndPeerSurvived, true);
  assert.equal(result.guardianCrashPeerSurvived, true);
  assert.equal(result.outputLimitAndPeerSurvived, true);
  assert.equal(result.resourceBudgetEnforced, true);
  assert.equal(result.singleExecutionEnforced, true);
  assert.equal(result.stoppedCleanupConfirmed, true);
  assert.equal(result.peerSurvivedStop, true);
});

test('an explicit late-retirement recovery frees only its original sandbox reservation', async () => {
  assert.notEqual(image, undefined, 'QDROID_T004_IMAGE is required for T004 Linux qualification.');

  const result = await runLateRetirementReservationRecovery(image as string);

  assert.equal(result.lateRecoveryReleasedReservation, true);
  assert.equal(result.lateRecoveryRetiredJournal, true);
  assert.equal(result.oldHandleRetired, true);
  assert.equal(result.peerSurvived, true);
  assert.equal(result.replacementCompleted, true);
  assert.equal(result.repeatedRecoveryIdempotent, true);
});

test('a startup cleanup cannot extend its first deadline through trailing recovery', async () => {
  assert.notEqual(image, undefined, 'QDROID_T004_IMAGE is required for T004 Linux qualification.');

  const result = await runStartupCleanupDeadlineRecovery(image as string);

  assert.equal(result.firstStopBoundedAndUnknown, true);
  assert.equal(result.lateRetirementHeldExclusiveLease, true);
  assert.equal(result.oldHandleRetired, true);
  assert.equal(result.peerSurvived, true);
  assert.equal(result.retryReleasedOnlyTargetReservation, true);
});

test('a timed-out recovery-lock acquisition releases without starting recovery', async () => {
  assert.notEqual(image, undefined, 'QDROID_T004_IMAGE is required for T004 Linux qualification.');

  const result = await runRecoveryLockAcquisitionDeadline(image as string);

  assert.equal(result.firstStopBoundedAndUnknown, true);
  assert.equal(result.lateLeaseHeldExclusiveLock, true);
  assert.equal(result.lateLeaseReleasedWithoutRecovery, true);
  assert.equal(result.oldHandleRetired, true);
  assert.equal(result.peerSurvived, true);
  assert.equal(result.retryReleasedOnlyTargetReservation, true);
});

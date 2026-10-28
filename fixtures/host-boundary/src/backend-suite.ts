import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  SandboxCleanupEvidence,
  SandboxExecutionCompletion,
  SandboxExecutionHandle,
  SandboxInstance,
} from '../../../packages/contracts/src/index.js';
import { OciSandboxBackend } from '../../../packages/runtime-oci/src/backend.js';
import { createLinuxSupervisor } from '../../../packages/supervisor/src/index.js';

export interface SandboxBackendLinuxSuiteResult {
  binaryRoundTrip: boolean;
  deadlineAndPeerSurvived: boolean;
  guardianCrashPeerSurvived: boolean;
  outputLimitAndPeerSurvived: boolean;
  peerSurvivedStop: boolean;
  profiles: string[];
  resourceBudgetEnforced: boolean;
  singleExecutionEnforced: boolean;
  stoppedCleanupConfirmed: boolean;
}

export interface LateRetirementReservationRecoveryResult {
  lateRecoveryReleasedReservation: boolean;
  lateRecoveryRetiredJournal: boolean;
  oldHandleRetired: boolean;
  peerSurvived: boolean;
  replacementCompleted: boolean;
  repeatedRecoveryIdempotent: boolean;
}

export interface StartupCleanupDeadlineRecoveryResult {
  firstStopBoundedAndUnknown: boolean;
  lateRetirementHeldExclusiveLease: boolean;
  oldHandleRetired: boolean;
  peerSurvived: boolean;
  retryReleasedOnlyTargetReservation: boolean;
}

export interface RecoveryLockAcquisitionDeadlineResult {
  firstStopBoundedAndUnknown: boolean;
  lateLeaseHeldExclusiveLock: boolean;
  lateLeaseReleasedWithoutRecovery: boolean;
  oldHandleRetired: boolean;
  peerSurvived: boolean;
  retryReleasedOnlyTargetReservation: boolean;
}

type SandboxStop = (sandbox: SandboxInstance) => Promise<SandboxCleanupEvidence>;

export interface CompletedExecutionCleanup {
  completion: SandboxExecutionCompletion;
  finalCleanup: SandboxCleanupEvidence;
  initialCleanupConfirmed: boolean;
}

/**
 * Creates the fixture's exact-one-stop boundary for a sandbox handle. The
 * production backend remains responsible for idempotent cleanup; the fixture
 * uses this boundary to catch an accidental second stop in its own scenario
 * composition instead of silently retrying it.
 */
export function createExactlyOnceSandboxStopper(stop: SandboxStop): SandboxStop {
  const stoppedSandboxes = new Set<SandboxInstance>();

  return async (sandbox: SandboxInstance): Promise<SandboxCleanupEvidence> => {
    if (stoppedSandboxes.has(sandbox)) {
      throw new Error('The fixture attempted a duplicate explicit sandbox stop.');
    }

    stoppedSandboxes.add(sandbox);
    const cleanup = await stop(sandbox);
    assertConfirmedCleanup(cleanup);
    return cleanup;
  };
}

/**
 * Preserves the terminal execution result and separately obtains the owning
 * manager's final cleanup evidence. A completion is not rewritten when its
 * initial cleanup was unknown. The final stop is intentionally one-shot: an
 * unconfirmed result blocks the current fixture phase instead of retrying.
 */
export async function completeExecutionAndConfirmCleanup(
  stop: SandboxStop,
  sandbox: SandboxInstance,
  completionPromise: Promise<SandboxExecutionCompletion>,
): Promise<CompletedExecutionCleanup> {
  let completion: SandboxExecutionCompletion;

  try {
    completion = await completionPromise;
  } catch (completionError) {
    try {
      const finalCleanup = await stop(sandbox);
      assertConfirmedCleanup(finalCleanup);
    } catch (cleanupError) {
      throw new AggregateError(
        [completionError, cleanupError],
        'The execution failed and its final cleanup was not confirmed.',
      );
    }

    throw completionError;
  }

  const finalCleanup = await stop(sandbox);
  assertConfirmedCleanup(finalCleanup);

  return {
    completion,
    finalCleanup,
    initialCleanupConfirmed: completion.cleanupConfirmed,
  };
}

export async function runSandboxBackendLinuxSuite(
  image: string,
): Promise<SandboxBackendLinuxSuiteResult> {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-owner-'));
  const backend = new OciSandboxBackend({ image, ownerStorePath });
  const stopExactlyOnce = createExactlyOnceSandboxStopper((sandbox) => backend.stop(sandbox));
  const supervisor = await createLinuxSupervisor(() => {
    throw new Error('This boundary fixture does not route workload RPC.');
  });
  const channel = supervisor.createBoundChannel({ installationId: 't004-linux-fixture' });
  const profiles: string[] = [];
  const subresults: Record<string, boolean | number> = { completedProfiles: 0 };
  let buildQualification: Awaited<ReturnType<OciSandboxBackend['qualify']>> | undefined;
  let completed = false;
  let phase = 'profile-lifecycle';

  try {
    for (const profileId of ['tool-offline', 'build-restricted', 'render-offline'] as const) {
      const qualification = await backend.qualify(profileId);
      const sandbox = await backend.create(qualification, channel.trustedBinding);
      const execution = await backend.execute(sandbox, nodeExecution('process.stdout.write("ok")'));
      const output = await readAll(execution.stdout);
      const completedExecution = await completeExecutionAndConfirmCleanup(
        stopExactlyOnce,
        sandbox,
        execution.completion,
      );
      const { completion } = completedExecution;

      if (
        Buffer.from(output).toString('utf8') !== 'ok' ||
        completion.reason !== 'completed' ||
        completion.exitCode !== 0
      ) {
        throw new Error(`The ${profileId} execution did not complete cleanly.`);
      }

      profiles.push(profileId);
      subresults.completedProfiles = profiles.length;
      const profileInitialCleanupCount =
        (subresults.profileInitialCleanupConfirmed as number | undefined) ?? 0;
      subresults.profileInitialCleanupConfirmed =
        profileInitialCleanupCount + Number(completedExecution.initialCleanupConfirmed);
      if (profileId === 'build-restricted') {
        buildQualification = qualification;
      }
    }

    phase = 'binary-transport';
    const qualification = await backend.qualify('tool-offline');
    const echoSandbox = await backend.create(qualification, channel.trustedBinding);
    const echo = await backend.execute(
      echoSandbox,
      nodeExecution('process.stdin.on("data", (chunk) => process.stdout.write(chunk))'),
    );
    const binary = Buffer.from([0, 255, 17, 0]);
    await echo.writeInput(binary);
    await echo.closeInput();
    const echoed = await readAll(echo.stdout);
    const completedEcho = await completeExecutionAndConfirmCleanup(
      stopExactlyOnce,
      echoSandbox,
      echo.completion,
    );
    const { completion: echoCompletion } = completedEcho;
    const binaryRoundTrip =
      Buffer.compare(Buffer.from(echoed), binary) === 0 &&
      echoCompletion.reason === 'completed' &&
      echoCompletion.exitCode === 0;
    subresults.binaryRoundTrip = binaryRoundTrip;
    subresults.binaryInitialCleanupConfirmed = completedEcho.initialCleanupConfirmed;

    phase = 'stop-peer';
    const stoppedSandbox = await backend.create(qualification, channel.trustedBinding);
    const peerSandbox = await backend.create(qualification, channel.trustedBinding);
    const stopped = await backend.execute(
      stoppedSandbox,
      nodeExecution('setInterval(() => {}, 1_000)'),
    );
    const peer = await backend.execute(peerSandbox, heartbeatExecution());
    const stoppedPeer = createHeartbeatPeer(peer);
    const stoppedPeerBefore = await stoppedPeer.heartbeat('stop-before');
    const stoppedCleanup = await stopExactlyOnce(stoppedSandbox);
    const stoppedCompletion = await stopped.completion;
    const stoppedPeerAfter = await stoppedPeer.heartbeat('stop-after');
    const stoppedPeerCleanup = await stopExactlyOnce(peerSandbox);
    const peerCompletion = await peer.completion;
    const peerSurvivedStop =
      stoppedPeerBefore &&
      stoppedPeerAfter &&
      stoppedPeerCleanup.cleanupConfirmed &&
      stoppedPeerCleanup.status === 'confirmed' &&
      peerCompletion.cleanupConfirmed &&
      peerCompletion.reason === 'stopped';
    subresults.peerSurvivedStop = peerSurvivedStop;

    phase = 'output-limit-peer';
    const outputSandbox = await backend.create(qualification, channel.trustedBinding);
    const outputPeerSandbox = await backend.create(qualification, channel.trustedBinding);
    const outputPeer = await backend.execute(outputPeerSandbox, heartbeatExecution());
    const outputHeartbeat = createHeartbeatPeer(outputPeer);
    const outputPeerBefore = await outputHeartbeat.heartbeat('output-before');
    const outputLimited = await backend.execute(
      outputSandbox,
      nodeExecution(`process.stdout.write(Buffer.alloc(${17 * 1024 * 1024}, 7))`),
    );
    const outputBytes = readAll(outputLimited.stdout);
    const completedOutput = await completeExecutionAndConfirmCleanup(
      stopExactlyOnce,
      outputSandbox,
      outputLimited.completion,
    );
    const { completion: outputCompletion } = completedOutput;
    const observedOutput = await outputBytes;
    const outputPeerAfter = await outputHeartbeat.heartbeat('output-after');
    const outputPeerCleanup = await stopExactlyOnce(outputPeerSandbox);
    const outputPeerCompletion = await outputPeer.completion;
    const outputLimitAndPeerSurvived =
      outputCompletion.reason === 'output-limit' &&
      observedOutput.byteLength === 16 * 1024 * 1024 &&
      outputCompletion.stdoutDeliveredBytes === 16 * 1024 * 1024 &&
      outputPeerBefore &&
      outputPeerAfter &&
      outputPeerCleanup.cleanupConfirmed &&
      outputPeerCleanup.status === 'confirmed' &&
      outputPeerCompletion.cleanupConfirmed &&
      outputPeerCompletion.reason === 'stopped';
    subresults.outputLimitAndPeerSurvived = outputLimitAndPeerSurvived;
    subresults.outputInitialCleanupConfirmed = completedOutput.initialCleanupConfirmed;

    phase = 'deadline-peer';
    const deadlineSandbox = await backend.create(qualification, channel.trustedBinding);
    const deadlinePeerSandbox = await backend.create(qualification, channel.trustedBinding);
    const deadlineLimited = await backend.execute(
      deadlineSandbox,
      nodeExecution('setInterval(() => undefined, 1_000)'),
    );
    await delay(60_000);
    const deadlinePeer = await backend.execute(deadlinePeerSandbox, heartbeatExecution());
    const deadlineHeartbeat = createHeartbeatPeer(deadlinePeer);
    const deadlinePeerBefore = await deadlineHeartbeat.heartbeat('deadline-before');
    const completedDeadline = await completeExecutionAndConfirmCleanup(
      stopExactlyOnce,
      deadlineSandbox,
      deadlineLimited.completion,
    );
    const { completion: deadlineCompletion } = completedDeadline;
    const deadlinePeerAfter = await deadlineHeartbeat.heartbeat('deadline-after');
    const deadlinePeerCleanup = await stopExactlyOnce(deadlinePeerSandbox);
    const deadlinePeerCompletion = await deadlinePeer.completion;
    const deadlineAndPeerSurvived =
      deadlineCompletion.reason === 'deadline' &&
      deadlinePeerBefore &&
      deadlinePeerAfter &&
      deadlinePeerCleanup.cleanupConfirmed &&
      deadlinePeerCleanup.status === 'confirmed' &&
      deadlinePeerCompletion.cleanupConfirmed &&
      deadlinePeerCompletion.reason === 'stopped';
    subresults.deadlineAndPeerSurvived = deadlineAndPeerSurvived;
    subresults.deadlineInitialCleanupConfirmed = completedDeadline.initialCleanupConfirmed;

    phase = 'resource-budget';
    if (buildQualification === undefined) {
      throw new Error('The build profile qualification was not available for budget enforcement.');
    }
    const budgetFirst = await backend.create(buildQualification, channel.trustedBinding);
    const budgetSecond = await backend.create(buildQualification, channel.trustedBinding);
    const budgetExecution = await backend.execute(
      budgetFirst,
      nodeExecution('setInterval(() => {}, 1_000)'),
    );
    const budgetRejected = await backend
      .execute(budgetSecond, nodeExecution('process.stdout.write("must-not-run")'))
      .then(
        () => false,
        (error: unknown) => error instanceof Error && error.message.includes('resource budget'),
      );
    const budgetCleanup = await stopExactlyOnce(budgetFirst);
    const budgetCompletion = await budgetExecution.completion;
    const resourceBudgetEnforced =
      budgetRejected &&
      budgetCleanup.cleanupConfirmed &&
      budgetCleanup.status === 'confirmed' &&
      budgetCompletion.cleanupConfirmed;
    subresults.resourceBudgetEnforced = resourceBudgetEnforced;

    phase = 'single-execution';
    const singleSandbox = await backend.create(qualification, channel.trustedBinding);
    const concurrentExecutions = await Promise.allSettled([
      backend.execute(singleSandbox, nodeExecution('setInterval(() => {}, 1_000)')),
      backend.execute(singleSandbox, nodeExecution('setInterval(() => {}, 1_000)')),
    ]);
    const fulfilledExecutions = concurrentExecutions.filter(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<OciSandboxBackend['execute']>>> =>
        result.status === 'fulfilled',
    );
    const [singleExecution] = fulfilledExecutions;
    let singleCleanupConfirmed = true;
    if (singleExecution !== undefined) {
      const singleCleanup = await stopExactlyOnce(singleSandbox);
      singleCleanupConfirmed =
        singleCleanup.cleanupConfirmed && singleCleanup.status === 'confirmed';
      await singleExecution.value.completion;
    }
    const singleExecutionEnforced =
      fulfilledExecutions.length === 1 &&
      concurrentExecutions.some((result) => result.status === 'rejected') &&
      singleCleanupConfirmed;
    subresults.singleExecutionEnforced = singleExecutionEnforced;

    phase = 'guardian-crash-peer';
    const journalsBeforeGuardianCrash = new Set(await journalNames(ownerStorePath));
    const lostSandbox = await backend.create(qualification, channel.trustedBinding);
    const peerSandboxAfterCrash = await backend.create(qualification, channel.trustedBinding);
    const lostExecution = await backend.execute(
      lostSandbox,
      nodeExecution('setInterval(() => {}, 1_000)'),
    );
    const lostGuardian = await waitForTaskGuardian(ownerStorePath, journalsBeforeGuardianCrash);
    const peerAfterCrash = await backend.execute(peerSandboxAfterCrash, heartbeatExecution());
    const crashHeartbeat = createHeartbeatPeer(peerAfterCrash);
    const crashPeerBefore = await crashHeartbeat.heartbeat('crash-before');
    process.kill(lostGuardian, 'SIGKILL');
    const completedLostExecution = await completeExecutionAndConfirmCleanup(
      stopExactlyOnce,
      lostSandbox,
      lostExecution.completion,
    );
    const { completion: lostCompletion } = completedLostExecution;
    const crashPeerAfter = await crashHeartbeat.heartbeat('crash-after');
    const crashPeerCleanup = await stopExactlyOnce(peerSandboxAfterCrash);
    const peerAfterCrashCompletion = await peerAfterCrash.completion;
    const retiredRejected = await backend
      .execute(lostSandbox, nodeExecution('process.stdout.write("must-not-rerun")'))
      .then(
        () => false,
        () => true,
      );

    const guardianCrashPeerSurvived =
      lostCompletion.reason === 'guardian-lost' &&
      crashPeerBefore &&
      crashPeerAfter &&
      crashPeerCleanup.cleanupConfirmed &&
      crashPeerCleanup.status === 'confirmed' &&
      peerAfterCrashCompletion.cleanupConfirmed &&
      peerAfterCrashCompletion.reason === 'stopped' &&
      retiredRejected;
    subresults.guardianCrashPeerSurvived = guardianCrashPeerSurvived;
    subresults.guardianLostInitialCleanupConfirmed = completedLostExecution.initialCleanupConfirmed;

    const stoppedCleanupConfirmed =
      stoppedCleanup.cleanupConfirmed &&
      stoppedCleanup.status === 'confirmed' &&
      stoppedCompletion.cleanupConfirmed;
    subresults.stoppedCleanupConfirmed = stoppedCleanupConfirmed;

    const result: SandboxBackendLinuxSuiteResult = {
      binaryRoundTrip,
      deadlineAndPeerSurvived,
      guardianCrashPeerSurvived,
      outputLimitAndPeerSurvived,
      peerSurvivedStop,
      profiles,
      resourceBudgetEnforced,
      singleExecutionEnforced,
      stoppedCleanupConfirmed,
    };

    if (
      !result.binaryRoundTrip ||
      !result.deadlineAndPeerSurvived ||
      !result.guardianCrashPeerSurvived ||
      !result.outputLimitAndPeerSurvived ||
      !result.peerSurvivedStop ||
      !result.resourceBudgetEnforced ||
      !result.singleExecutionEnforced ||
      !result.stoppedCleanupConfirmed ||
      result.profiles.length !== 3
    ) {
      throw new Error(`T004 Linux suite assertions failed: ${JSON.stringify(result)}`);
    }

    completed = true;
    return result;
  } catch (error) {
    throw createSandboxBackendLinuxSuiteFailure(phase, subresults, error);
  } finally {
    if (completed) {
      await removeOwnerStore(ownerStorePath);
    } else {
      process.stderr.write(`T004 owner store preserved for cleanup recovery: ${ownerStorePath}\n`);
    }
  }
}

export function formatSandboxBackendLinuxSuiteFailure(
  phase: string,
  subresults: Readonly<Record<string, boolean | number>>,
  error: unknown,
): string {
  const errorType = error instanceof Error ? error.name : typeof error;
  const diagnostic = JSON.stringify({ errorType, phase, subresults });
  return `T004 Linux suite failed during ${phase}: ${diagnostic.slice(0, 1_024)}`;
}

export function createSandboxBackendLinuxSuiteFailure(
  phase: string,
  subresults: Readonly<Record<string, boolean | number>>,
  error: unknown,
): Error {
  return new Error(formatSandboxBackendLinuxSuiteFailure(phase, subresults, error), {
    cause: error,
  });
}

/**
 * Exercises a real execution whose terminal create-receipt directory sync
 * crosses the bounded cleanup deadline. The same manager must later consume
 * its own durable late result, release only that reservation, and keep its
 * peer live.
 */
export async function runLateRetirementReservationRecovery(
  image: string,
): Promise<LateRetirementReservationRecoveryResult> {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-late-retirement-reservation-'));
  let releaseReceiptDirectorySync: (() => void) | undefined;
  let markReceiptDirectorySyncStarted: (() => void) | undefined;
  const receiptDirectorySyncRelease = new Promise<void>((resolve) => {
    releaseReceiptDirectorySync = resolve;
  });
  const receiptDirectorySyncStarted = new Promise<void>((resolve) => {
    markReceiptDirectorySyncStarted = resolve;
  });
  let failTargetReceiptDirectorySync = true;
  const backend = new OciSandboxBackend({
    image,
    ownerStorePath,
    trustedTestHooks: {
      afterExecutionReceiptUnlinkBeforeDirectorySync: async () => {
        if (!failTargetReceiptDirectorySync) {
          return;
        }
        failTargetReceiptDirectorySync = false;
        markReceiptDirectorySyncStarted?.();
        await receiptDirectorySyncRelease;
        throw new Error('Trusted receipt directory sync failed after receipt unlink.');
      },
    },
  });
  const supervisor = await createLinuxSupervisor(() => {
    throw new Error('This boundary fixture does not route workload RPC.');
  });
  const channel = supervisor.createBoundChannel({ installationId: 't004-late-retirement' });
  let completed = false;

  try {
    const qualification = await backend.qualify('tool-offline');
    const targetSandbox = await backend.create(qualification, channel.trustedBinding);
    const peerSandbox = await backend.create(qualification, channel.trustedBinding);
    const target = await backend.execute(
      targetSandbox,
      nodeExecution('setInterval(() => undefined, 1_000)'),
    );
    const targetJournalNames = new Set(await journalNames(ownerStorePath));
    if (targetJournalNames.size !== 1) {
      throw new Error('The late-retirement target did not create one trusted execution journal.');
    }
    const peer = await backend.execute(peerSandbox, heartbeatExecution());
    const journalNamesWithPeer = await journalNames(ownerStorePath);
    const peerJournalNames = journalNamesWithPeer.filter(
      (journalName) => !targetJournalNames.has(journalName),
    );
    if (peerJournalNames.length !== 1 || journalNamesWithPeer.length !== 2) {
      throw new Error('The late-retirement peer did not create one distinct trusted journal.');
    }
    const peerJournalName = peerJournalNames[0] as string;
    const peerHeartbeat = createHeartbeatPeer(peer);

    const peerBefore = await peerHeartbeat.heartbeat('late-retirement-before');
    const stop = backend.stop(targetSandbox);
    await receiptDirectorySyncStarted;
    const stopEvidence = await stop;
    releaseReceiptDirectorySync?.();

    await delay(100);
    const recovery = await backend.recoverAbandoned();
    const journalsAfterLateRecovery = await journalNames(ownerStorePath);
    const oldHandleRetired = await backend
      .execute(targetSandbox, nodeExecution('process.stdout.write("must-not-rerun")'))
      .then(
        () => false,
        () => true,
      );
    const peerAfter = await peerHeartbeat.heartbeat('late-retirement-after');
    const repeatedStop = await backend.stop(targetSandbox);
    const repeatedRecovery = await backend.recoverAbandoned();

    const replacementSandbox = await backend.create(qualification, channel.trustedBinding);
    const replacement = await backend.execute(
      replacementSandbox,
      nodeExecution('process.stdout.write("replacement")'),
    );
    const replacementOutput = await readAll(replacement.stdout);
    const replacementCompletion = await replacement.completion;
    const replacementCleanup = await backend.stop(replacementSandbox);
    const peerCleanup = await backend.stop(peerSandbox);
    const peerCompletion = await peer.completion;
    const peerRetirementRecovery = await backend.recoverAbandoned();

    const result: LateRetirementReservationRecoveryResult = {
      lateRecoveryReleasedReservation:
        stopEvidence.cleanupConfirmed === false &&
        stopEvidence.status === 'unknown' &&
        recovery.recoveredRecords === 1 &&
        recovery.unresolvedRecordCount === 1 &&
        recovery.unresolvedRecordsTruncated === false &&
        recovery.unresolvedRecords.length === 1 &&
        recovery.unresolvedRecords[0]?.record === peerJournalName &&
        recovery.unresolvedRecords[0]?.status === 'guardian-live',
      lateRecoveryRetiredJournal:
        journalsAfterLateRecovery.length === 1 && journalsAfterLateRecovery[0] === peerJournalName,
      oldHandleRetired,
      peerSurvived:
        peerBefore &&
        peerAfter &&
        peerCleanup.cleanupConfirmed &&
        peerCleanup.status === 'confirmed' &&
        peerCompletion.cleanupConfirmed &&
        peerCompletion.reason === 'stopped' &&
        peerRetirementRecovery.recoveredRecords === 0 &&
        peerRetirementRecovery.unresolvedRecordCount === 0 &&
        peerRetirementRecovery.unresolvedRecords.length === 0 &&
        peerRetirementRecovery.unresolvedRecordsTruncated === false,
      replacementCompleted:
        Buffer.from(replacementOutput).toString('utf8') === 'replacement' &&
        replacementCompletion.reason === 'completed' &&
        replacementCompletion.exitCode === 0 &&
        replacementCleanup.cleanupConfirmed &&
        replacementCleanup.status === 'confirmed',
      repeatedRecoveryIdempotent:
        repeatedStop.cleanupConfirmed &&
        repeatedStop.status === 'confirmed' &&
        repeatedRecovery.recoveredRecords === 0 &&
        repeatedRecovery.unresolvedRecordCount === 1 &&
        repeatedRecovery.unresolvedRecordsTruncated === false &&
        repeatedRecovery.unresolvedRecords.length === 1 &&
        repeatedRecovery.unresolvedRecords[0]?.record === peerJournalName &&
        repeatedRecovery.unresolvedRecords[0]?.status === 'guardian-live',
    };

    if (
      !result.lateRecoveryReleasedReservation ||
      !result.lateRecoveryRetiredJournal ||
      !result.oldHandleRetired ||
      !result.peerSurvived ||
      !result.replacementCompleted ||
      !result.repeatedRecoveryIdempotent
    ) {
      throw new Error(
        `Late retirement reservation assertions failed: ${JSON.stringify({
          ...result,
          peerRetirementRecovery,
          recovery,
          repeatedRecovery,
          repeatedStop,
          stopEvidence,
          peerBefore,
          peerAfter,
          peerCleanup,
          peerCompletion,
          replacementOutput: Buffer.from(replacementOutput).toString('utf8'),
          replacementCompletion,
          replacementCleanup,
        })}`,
      );
    }

    completed = true;
    return result;
  } finally {
    releaseReceiptDirectorySync?.();
    if (completed) {
      await removeOwnerStore(ownerStorePath);
    } else {
      process.stderr.write(
        `T004 owner store preserved for late-retirement recovery: ${ownerStorePath}\n`,
      );
    }
  }
}

/**
 * A startup stop has one absolute cleanup deadline even when its durable
 * journal is nearly settled. A later exact retry may consume the same
 * execution's completed retirement, but it cannot reuse that deadline or
 * release a peer reservation.
 */
export async function runStartupCleanupDeadlineRecovery(
  image: string,
): Promise<StartupCleanupDeadlineRecoveryResult> {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-startup-cleanup-deadline-'));
  let releaseTargetIntent: (() => void) | undefined;
  let markTargetIntentStarted: (() => void) | undefined;
  let releaseTargetRetirement: (() => void) | undefined;
  let markTargetRetirementStarted: (() => void) | undefined;
  const targetIntentRelease = new Promise<void>((resolve) => {
    releaseTargetIntent = resolve;
  });
  const targetIntentStarted = new Promise<void>((resolve) => {
    markTargetIntentStarted = resolve;
  });
  const targetRetirementRelease = new Promise<void>((resolve) => {
    releaseTargetRetirement = resolve;
  });
  const targetRetirementStarted = new Promise<void>((resolve) => {
    markTargetRetirementStarted = resolve;
  });
  let intentCount = 0;
  let targetSessionId: string | undefined;
  let completed = false;

  const backend = new OciSandboxBackend({
    image,
    ownerStorePath,
    trustedTestHooks: {
      afterExecutionJournalUnlinkBeforeDirectorySync: async ({ sessionId }) => {
        if (sessionId !== targetSessionId) {
          return;
        }
        markTargetRetirementStarted?.();
        await targetRetirementRelease;
      },
      afterJournalIntentPersist: async ({ sessionId }) => {
        intentCount += 1;
        if (intentCount !== 2) {
          return;
        }
        targetSessionId = sessionId;
        markTargetIntentStarted?.();
        await targetIntentRelease;
      },
    },
  });
  const supervisor = await createLinuxSupervisor(() => {
    throw new Error('This boundary fixture does not route workload RPC.');
  });
  const channel = supervisor.createBoundChannel({
    installationId: 't004-startup-cleanup-deadline',
  });

  try {
    const qualification = await backend.qualify('tool-offline');
    const peerSandbox = await backend.create(qualification, channel.trustedBinding);
    const targetSandbox = await backend.create(qualification, channel.trustedBinding);
    const replacementSandbox = await backend.create(qualification, channel.trustedBinding);

    const peer = await backend.execute(peerSandbox, heartbeatExecution());
    const peerHeartbeat = createHeartbeatPeer(peer);
    const peerBefore = await peerHeartbeat.heartbeat('startup-deadline-before');

    const targetRejected = backend
      .execute(targetSandbox, nodeExecution('process.stdout.write("must-not-run")'))
      .then(
        () => false,
        () => true,
      );
    await targetIntentStarted;

    const stopStartedAt = performance.now();
    const firstStop = backend.stop(targetSandbox);
    await delay(7_500);
    releaseTargetIntent?.();
    await targetRetirementStarted;

    const firstStopEvidence = await firstStop;
    const firstStopElapsedMilliseconds = performance.now() - stopStartedAt;
    const targetWasRejected = await targetRejected;
    const blockedReplacement = await backend
      .execute(replacementSandbox, nodeExecution('process.stdout.write("must-not-run")'))
      .then(
        () => false,
        (error: unknown) => error instanceof Error && error.message.includes('resource budget'),
      );
    const recoveryRejectedWhileMutationPending = await backend.recoverAbandoned().then(
      () => false,
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('Another sandbox recovery owner is already active'),
    );
    const peerDuringPending = await peerHeartbeat.heartbeat('startup-deadline-pending');

    releaseTargetRetirement?.();
    const retryCleanup = await backend.stop(targetSandbox);
    const oldHandleRetired = await backend
      .execute(targetSandbox, nodeExecution('process.stdout.write("must-not-rerun")'))
      .then(
        () => false,
        () => true,
      );
    const peerAfterRetry = await peerHeartbeat.heartbeat('startup-deadline-after-retry');

    const replacement = await backend.execute(
      replacementSandbox,
      nodeExecution('process.stdout.write("replacement")'),
    );
    const replacementOutput = await readAll(replacement.stdout);
    const replacementCompletion = await replacement.completion;
    const replacementCleanup = await backend.stop(replacementSandbox);
    const peerCleanup = await backend.stop(peerSandbox);
    const peerCompletion = await peer.completion;
    const finalRecovery = await backend.recoverAbandoned();

    const result: StartupCleanupDeadlineRecoveryResult = {
      firstStopBoundedAndUnknown:
        firstStopEvidence.cleanupConfirmed === false &&
        firstStopEvidence.status === 'unknown' &&
        firstStopElapsedMilliseconds < 15_000 &&
        targetWasRejected,
      lateRetirementHeldExclusiveLease: recoveryRejectedWhileMutationPending && blockedReplacement,
      oldHandleRetired,
      peerSurvived:
        peerBefore &&
        peerDuringPending &&
        peerAfterRetry &&
        peerCleanup.cleanupConfirmed &&
        peerCleanup.status === 'confirmed' &&
        peerCompletion.cleanupConfirmed &&
        peerCompletion.reason === 'stopped',
      retryReleasedOnlyTargetReservation:
        retryCleanup.cleanupConfirmed &&
        retryCleanup.status === 'confirmed' &&
        Buffer.from(replacementOutput).toString('utf8') === 'replacement' &&
        replacementCompletion.reason === 'completed' &&
        replacementCompletion.exitCode === 0 &&
        replacementCleanup.cleanupConfirmed &&
        replacementCleanup.status === 'confirmed' &&
        finalRecovery.recoveredRecords === 0 &&
        finalRecovery.unresolvedRecordCount === 0 &&
        finalRecovery.unresolvedRecords.length === 0 &&
        finalRecovery.unresolvedRecordsTruncated === false,
    };

    if (
      !result.firstStopBoundedAndUnknown ||
      !result.lateRetirementHeldExclusiveLease ||
      !result.oldHandleRetired ||
      !result.peerSurvived ||
      !result.retryReleasedOnlyTargetReservation
    ) {
      throw new Error(
        `Startup cleanup deadline assertions failed: ${JSON.stringify({
          ...result,
          blockedReplacement,
          finalRecovery,
          firstStopElapsedMilliseconds,
          firstStopEvidence,
          peerAfterRetry,
          peerBefore,
          peerCleanup,
          peerCompletion,
          peerDuringPending,
          recoveryRejectedWhileMutationPending,
          replacementCleanup,
          replacementCompletion,
          replacementOutput: Buffer.from(replacementOutput).toString('utf8'),
          retryCleanup,
          targetWasRejected,
        })}`,
      );
    }

    completed = true;
    return result;
  } finally {
    releaseTargetIntent?.();
    releaseTargetRetirement?.();
    if (completed) {
      await removeOwnerStore(ownerStorePath);
    } else {
      process.stderr.write(
        `T004 owner store preserved for startup cleanup deadline recovery: ${ownerStorePath}\n`,
      );
    }
  }
}

/**
 * The SQLite transaction can be acquired before the bounded startup cleanup
 * returns. If that acquisition finishes after the deadline, it must release
 * only its exact lease. It cannot enter recovery after the original caller
 * has already reported unknown cleanup.
 */
export async function runRecoveryLockAcquisitionDeadline(
  image: string,
): Promise<RecoveryLockAcquisitionDeadlineResult> {
  const ownerStorePath = await mkdtemp(join(tmpdir(), 'qdroid-t004-recovery-lock-acquisition-'));
  let releaseTargetIntent: (() => void) | undefined;
  let markTargetIntentStarted: (() => void) | undefined;
  let releaseAcquisition: (() => void) | undefined;
  let markAcquisitionStarted: (() => void) | undefined;
  let markLateLeaseReleased: (() => void) | undefined;
  const targetIntentRelease = new Promise<void>((resolve) => {
    releaseTargetIntent = resolve;
  });
  const targetIntentStarted = new Promise<void>((resolve) => {
    markTargetIntentStarted = resolve;
  });
  const acquisitionRelease = new Promise<void>((resolve) => {
    releaseAcquisition = resolve;
  });
  const acquisitionStarted = new Promise<void>((resolve) => {
    markAcquisitionStarted = resolve;
  });
  const lateLeaseReleased = new Promise<void>((resolve) => {
    markLateLeaseReleased = resolve;
  });
  let blockFirstAcquisition = true;
  let intentCount = 0;
  let targetSessionId: string | undefined;
  let completed = false;

  const backend = new OciSandboxBackend({
    image,
    ownerStorePath,
    trustedTestHooks: {
      afterJournalIntentPersist: async ({ sessionId }) => {
        intentCount += 1;
        if (intentCount !== 2) {
          return;
        }
        targetSessionId = sessionId;
        markTargetIntentStarted?.();
        await targetIntentRelease;
      },
      afterTimedOutRecoveryLeaseReleased: async () => {
        markLateLeaseReleased?.();
      },
      beforeRecoveryLockLeaseReturn: async () => {
        if (!blockFirstAcquisition) {
          return;
        }
        blockFirstAcquisition = false;
        markAcquisitionStarted?.();
        await acquisitionRelease;
      },
    },
  });
  const supervisor = await createLinuxSupervisor(() => {
    throw new Error('This boundary fixture does not route workload RPC.');
  });
  const channel = supervisor.createBoundChannel({
    installationId: 't004-recovery-lock-acquisition',
  });

  try {
    const qualification = await backend.qualify('tool-offline');
    const peerSandbox = await backend.create(qualification, channel.trustedBinding);
    const targetSandbox = await backend.create(qualification, channel.trustedBinding);
    const replacementSandbox = await backend.create(qualification, channel.trustedBinding);

    const peer = await backend.execute(peerSandbox, heartbeatExecution());
    const peerHeartbeat = createHeartbeatPeer(peer);
    const peerBefore = await peerHeartbeat.heartbeat('recovery-lock-before');

    const targetRejected = backend
      .execute(targetSandbox, nodeExecution('process.stdout.write("must-not-run")'))
      .then(
        () => false,
        () => true,
      );
    await targetIntentStarted;

    const stopStartedAt = performance.now();
    const firstStop = backend.stop(targetSandbox);
    releaseTargetIntent?.();
    await acquisitionStarted;

    const replacementRejectedWhileLeasePending = await backend
      .execute(replacementSandbox, nodeExecution('process.stdout.write("must-not-run")'))
      .then(
        () => false,
        (error: unknown) => error instanceof Error && error.message.includes('resource budget'),
      );
    const recoveryRejectedWhileLeasePending = await backend.recoverAbandoned().then(
      () => false,
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('Another sandbox recovery owner is already active'),
    );
    const peerDuringPending = await peerHeartbeat.heartbeat('recovery-lock-pending');

    const firstStopEvidence = await firstStop;
    const firstStopElapsedMilliseconds = performance.now() - stopStartedAt;
    const targetWasRejected = await targetRejected;
    const journalsBeforeLateLeaseRelease = await journalNames(ownerStorePath);
    const targetJournalName = targetSessionId === undefined ? undefined : `${targetSessionId}.json`;

    releaseAcquisition?.();
    await lateLeaseReleased;
    const journalsAfterLateLeaseRelease = await journalNames(ownerStorePath);
    const peerAfterLateLeaseRelease = await peerHeartbeat.heartbeat(
      'recovery-lock-after-late-lease',
    );

    const retryCleanup = await backend.stop(targetSandbox);
    const oldHandleRetired = await backend
      .execute(targetSandbox, nodeExecution('process.stdout.write("must-not-rerun")'))
      .then(
        () => false,
        () => true,
      );
    const peerAfterRetry = await peerHeartbeat.heartbeat('recovery-lock-after-retry');

    const replacement = await backend.execute(
      replacementSandbox,
      nodeExecution('process.stdout.write("replacement")'),
    );
    const replacementOutput = await readAll(replacement.stdout);
    const replacementCompletion = await replacement.completion;
    const replacementCleanup = await backend.stop(replacementSandbox);
    const peerCleanup = await backend.stop(peerSandbox);
    const peerCompletion = await peer.completion;
    const finalRecovery = await backend.recoverAbandoned();

    const result: RecoveryLockAcquisitionDeadlineResult = {
      firstStopBoundedAndUnknown:
        firstStopEvidence.cleanupConfirmed === false &&
        firstStopEvidence.status === 'unknown' &&
        firstStopElapsedMilliseconds < 15_000 &&
        targetWasRejected,
      lateLeaseHeldExclusiveLock:
        recoveryRejectedWhileLeasePending && replacementRejectedWhileLeasePending,
      lateLeaseReleasedWithoutRecovery:
        targetJournalName !== undefined &&
        journalsBeforeLateLeaseRelease.includes(targetJournalName) &&
        journalsAfterLateLeaseRelease.includes(targetJournalName),
      oldHandleRetired,
      peerSurvived:
        peerBefore &&
        peerDuringPending &&
        peerAfterLateLeaseRelease &&
        peerAfterRetry &&
        peerCleanup.cleanupConfirmed &&
        peerCleanup.status === 'confirmed' &&
        peerCompletion.cleanupConfirmed &&
        peerCompletion.reason === 'stopped',
      retryReleasedOnlyTargetReservation:
        retryCleanup.cleanupConfirmed &&
        retryCleanup.status === 'confirmed' &&
        Buffer.from(replacementOutput).toString('utf8') === 'replacement' &&
        replacementCompletion.reason === 'completed' &&
        replacementCompletion.exitCode === 0 &&
        replacementCleanup.cleanupConfirmed &&
        replacementCleanup.status === 'confirmed' &&
        finalRecovery.recoveredRecords === 0 &&
        finalRecovery.unresolvedRecordCount === 0 &&
        finalRecovery.unresolvedRecords.length === 0 &&
        finalRecovery.unresolvedRecordsTruncated === false,
    };

    if (
      !result.firstStopBoundedAndUnknown ||
      !result.lateLeaseHeldExclusiveLock ||
      !result.lateLeaseReleasedWithoutRecovery ||
      !result.oldHandleRetired ||
      !result.peerSurvived ||
      !result.retryReleasedOnlyTargetReservation
    ) {
      throw new Error(
        `Recovery-lock acquisition deadline assertions failed: ${JSON.stringify({
          ...result,
          finalRecovery,
          firstStopElapsedMilliseconds,
          firstStopEvidence,
          journalsAfterLateLeaseRelease,
          journalsBeforeLateLeaseRelease,
          peerAfterLateLeaseRelease,
          peerAfterRetry,
          peerBefore,
          peerCleanup,
          peerCompletion,
          peerDuringPending,
          recoveryRejectedWhileLeasePending,
          replacementCleanup,
          replacementCompletion,
          replacementOutput: Buffer.from(replacementOutput).toString('utf8'),
          replacementRejectedWhileLeasePending,
          retryCleanup,
          targetJournalName,
          targetWasRejected,
        })}`,
      );
    }

    completed = true;
    return result;
  } finally {
    releaseTargetIntent?.();
    releaseAcquisition?.();
    if (completed) {
      await removeOwnerStore(ownerStorePath);
    } else {
      process.stderr.write(
        `T004 owner store preserved for recovery-lock acquisition: ${ownerStorePath}\n`,
      );
    }
  }
}

function nodeExecution(source: string): {
  argv: string[];
  cwd: string;
  environment: Record<string, string>;
  executable: string;
} {
  return {
    argv: ['-e', source],
    cwd: '/tmp',
    environment: { LANG: 'C.UTF-8' },
    executable: '/usr/local/bin/node',
  };
}

function assertConfirmedCleanup(cleanup: SandboxCleanupEvidence): void {
  if (cleanup.status !== 'confirmed' || !cleanup.cleanupConfirmed) {
    throw new Error('The completed execution final cleanup was not confirmed.');
  }
}

function heartbeatExecution(): {
  argv: string[];
  cwd: string;
  environment: Record<string, string>;
  executable: string;
} {
  return nodeExecution(
    [
      'let buffered = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => {',
      '  buffered += chunk;',
      '  for (;;) {',
      '    const newline = buffered.indexOf("\\n");',
      '    if (newline === -1) { break; }',
      '    const command = buffered.slice(0, newline);',
      '    buffered = buffered.slice(newline + 1);',
      '    if (command === "exit") { process.exit(0); }',
      '    process.stdout.write(`${command}\\n`);',
      '  }',
      '});',
    ].join('\n'),
  );
}

function createHeartbeatPeer(execution: SandboxExecutionHandle): {
  heartbeat(token: string): Promise<boolean>;
} {
  const output = execution.stdout[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);

  return {
    heartbeat: async (token: string): Promise<boolean> => {
      const expected = `${token}\n`;
      await execution.writeInput(Buffer.from(expected));

      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline !== -1) {
          const received = buffered.subarray(0, newline + 1).toString('utf8');
          buffered = buffered.subarray(newline + 1);
          return received === expected;
        }

        const next = await output.next();
        if (next.done) {
          throw new Error('The heartbeat peer ended before returning its token.');
        }
        buffered = Buffer.concat([buffered, next.value]);
      }
    },
  };
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function journalNames(ownerStorePath: string): Promise<string[]> {
  return (await readdir(ownerStorePath)).filter((entry) => /^[a-f0-9-]{36}\.json$/i.test(entry));
}

async function waitForTaskGuardian(
  ownerStorePath: string,
  journalsBefore: ReadonlySet<string>,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    for (const entry of await journalNames(ownerStorePath)) {
      if (journalsBefore.has(entry)) {
        continue;
      }

      const journal = await readTaskJournal(join(ownerStorePath, entry));
      if (journal === undefined) {
        continue;
      }

      const currentStart = await readProcessStart(journal.guardian.pid);
      if (currentStart !== null && currentStart === journal.guardian.start) {
        return journal.guardian.pid;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error('The task-owned guardian was not present with its journaled process identity.');
}

async function readTaskJournal(
  path: string,
): Promise<{ guardian: { pid: number; start: string } } | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(value) || !isRecord(value.guardian)) {
      return undefined;
    }
    const pid = value.guardian.pid;
    const start = value.guardian.start;
    if (
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      typeof start !== 'string' ||
      !/^\d+$/.test(start)
    ) {
      return undefined;
    }
    return { guardian: { pid, start } };
  } catch {
    return undefined;
  }
}

async function readProcessStart(pid: number): Promise<string | null> {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
    const closeParenthesis = contents.lastIndexOf(')');
    const fields = contents.slice(closeParenthesis + 2).split(' ');
    const start = fields[19];
    return start === undefined || !/^\d+$/.test(start) ? null : start;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function removeOwnerStore(ownerStorePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await rm(ownerStorePath, { force: true, recursive: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || Date.now() >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }
}

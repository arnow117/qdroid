import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  canonicalJson,
  ContractError,
  COUNTER_SIM_CAPABILITY,
  COUNTER_SIM_RESOURCE,
  COUNTER_SIM_SCHEMA_VERSION,
  type CounterAddArguments,
  type JsonValue,
  READONLY_SIM_CAPABILITY,
} from '../../contracts/src/index.js';
import type { BoundWorkloadIdentity } from '../../supervisor/src/index.js';

const SCHEMA_VERSION = 4;
const COUNTER_DIGEST_SCHEMA = 'qdroid.counter.digest/v1';
const DEFAULT_OBSERVATION_DEADLINE_MS = 5_000;

type GrantEffect = 'allow' | 'deny';
type LegacyState = 'rejected' | 'admitted' | 'succeeded' | 'unknown';
export type CounterTaskState =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'unknown'
  | 'rejected';

interface LegacyGrantRow {
  effect: GrantEffect;
  generation: number;
  grant_id: string;
}

interface LegacyTaskRow {
  admission_id: string;
  result_json: string | null;
  state: LegacyState;
  task_id: string;
}

interface CounterTaskRow {
  admission_id: string;
  amount: number;
  bound_boot_id: string;
  bound_channel_id: string;
  bound_epoch: number;
  cancel_requested: number;
  counter_id: string;
  executor_session_id: string | null;
  installation_id: string;
  instance_id: string;
  policy_generation: number;
  profile_generation: number;
  provider_observation_version: number;
  provider_operation_id: string | null;
  provider_epoch: number;
  provider_id: string;
  request_digest: string;
  result_json: string | null;
  state: CounterTaskState;
  state_version: number;
  observation_deadline_at: number | null;
  task_id: string;
}

interface CounterGrantRow {
  effect: GrantEffect;
  grant_id: string;
  max_amount: number;
  remaining_uses: number;
  requires_approval: number;
}

interface ContextRow {
  boot_id: string;
  channel_id: string;
  epoch: number;
  lease_expires_at: number;
  profile_generation: number;
  provider_epoch: number;
  provider_id: string;
}

export interface OperatorFixtureGrant {
  capability: typeof READONLY_SIM_CAPABILITY;
  effect: GrantEffect;
  installationId: string;
  subjectInstanceId: string;
}

export interface OperatorCounterGrant {
  effect: GrantEffect;
  expiresAt: number;
  installationId: string;
  maxAmount: number;
  remainingUses: number;
  requiresApproval?: boolean;
  resourceId?: typeof COUNTER_SIM_RESOURCE;
  subjectInstanceId: string;
}

export interface TrustedCounterContext {
  identity: BoundWorkloadIdentity;
  leaseExpiresAt: number;
  profileGeneration: number;
  providerEpoch: number;
  providerId: string;
}

export interface CounterApproval {
  capability: typeof COUNTER_SIM_CAPABILITY;
  digest: string;
  expiresAt: number;
  installationId: string;
  resourceId: typeof COUNTER_SIM_RESOURCE;
  subjectInstanceId: string;
  taskId: string;
}

export interface ReadonlyAdmission {
  admissionId: string;
  grantId: string;
  requestDigest: string;
  taskId: string;
}

export interface ScopedTask {
  admissionId: string;
  result: JsonValue | null;
  state: LegacyState;
  taskId: string;
}

export interface CounterTask {
  admissionId: string;
  amount: number;
  cancelRequested: boolean;
  counterId: typeof COUNTER_SIM_RESOURCE;
  providerEpoch: number;
  providerId: string;
  requestDigest: string;
  result: JsonValue | null;
  state: CounterTaskState;
  stateVersion: number;
  taskId: string;
}

export interface CounterDispatch {
  admissionId: string;
  decision: 'canceled' | 'denied' | 'existing' | 'fresh';
  taskId: string;
}

export interface ProviderObservation {
  admissionId: string;
  observationVersion: number;
  operationId?: string;
  providerEpoch: number;
  result?: JsonValue;
  terminal: 'accepted' | 'completed' | 'failed' | 'stopped' | 'unsupported';
}

export interface SanitizedAuditRecord {
  admissionId: string | null;
  grantId: string | null;
  instanceId: string;
  outcome: string;
  requestDigest: string;
  taskId: string | null;
}

export interface AdmissionHistoryRecord {
  event: string;
  source: string;
  stateVersion: number;
  taskId: string;
}

export interface PolicyAuthorityOptions {
  observationDeadlineMs?: number;
}

/** Owns the local SQLite transaction that admits, cancels, and accounts for work. */
export class PolicyAuthority {
  private readonly database: DatabaseSync;
  private failNextCommit = false;
  private failNextOutcomePersistence = false;
  private readonly observationDeadlineMs: number;

  public constructor(
    private readonly databasePath: string,
    options: PolicyAuthorityOptions = {},
  ) {
    this.observationDeadlineMs = options.observationDeadlineMs ?? DEFAULT_OBSERVATION_DEADLINE_MS;
    this.database = new DatabaseSync(databasePath);
    try {
      this.database.exec('PRAGMA journal_mode = WAL');
      this.database.exec('PRAGMA synchronous = FULL');
      this.database.exec('PRAGMA foreign_keys = ON');
      this.database.exec('PRAGMA busy_timeout = 250');
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  public applyOperatorFixtureGrant(grant: OperatorFixtureGrant): string {
    const grantId = `grant-${randomUUID()}`;
    const generation = this.nextLegacyGeneration(grant.installationId);
    this.database
      .prepare(
        `INSERT INTO fixture_grants
         (grant_id, installation_id, subject_instance_id, capability, effect, generation, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        grantId,
        grant.installationId,
        grant.subjectInstanceId,
        grant.capability,
        grant.effect,
        generation,
      );
    return grantId;
  }

  public listAllowedCapabilities(identity: BoundWorkloadIdentity): string[] {
    const grant = this.currentLegacyGrant(
      identity.installationId,
      identity.instanceId,
      READONLY_SIM_CAPABILITY,
    );
    return grant?.effect === 'allow' ? [READONLY_SIM_CAPABILITY] : [];
  }

  /** Validates the trusted binding required before negotiating admission work. */
  public validateAdmissionContext(identity: BoundWorkloadIdentity): void {
    this.transaction(() => {
      this.liveContext(identity);
    });
  }

  /** Lists the single counter capability only when the current live policy permits it. */
  public listAllowedCounterCapabilities(identity: BoundWorkloadIdentity): string[] {
    return this.transaction(() => {
      const context = this.liveContext(identity);
      const policy = this.policy(identity.installationId);
      if (
        policy.host_allowed !== 1 ||
        policy.installation_allowed !== 1 ||
        context.provider_id === ''
      ) {
        return [];
      }
      const grants = this.database
        .prepare(
          `SELECT effect, max_amount, remaining_uses
           FROM counter_grants
           WHERE installation_id = ? AND subject_instance_id = ? AND capability = ?
             AND resource_id = ? AND active = 1 AND expires_at > ?`,
        )
        .all(
          identity.installationId,
          identity.instanceId,
          COUNTER_SIM_CAPABILITY,
          COUNTER_SIM_RESOURCE,
          Date.now(),
        ) as Array<{ effect: GrantEffect; max_amount: number; remaining_uses: number }>;
      const allows = grants.filter((grant) => grant.effect === 'allow');
      const denyExists = grants.some((grant) => grant.effect === 'deny');
      const allConstraintsPermitMinimumRequest = allows.every(
        (grant) => grant.max_amount >= 1 && grant.remaining_uses > 0,
      );
      return !denyExists && allows.length > 0 && allConstraintsPermitMinimumRequest
        ? [COUNTER_SIM_CAPABILITY]
        : [];
    });
  }

  public admitReadonlyInvocation(
    identity: BoundWorkloadIdentity,
    argumentsValue: Record<string, JsonValue>,
  ): ReadonlyAdmission {
    const requestDigest = digestReadonly(argumentsValue);
    const admissionId = `admission-${randomUUID()}`;
    const taskId = `task-${randomUUID()}`;
    const decision = this.transaction(() => {
      const grant = this.currentLegacyGrant(
        identity.installationId,
        identity.instanceId,
        READONLY_SIM_CAPABILITY,
      );
      const state: LegacyState = grant?.effect === 'allow' ? 'admitted' : 'rejected';
      this.database
        .prepare(
          `INSERT INTO admissions
           (admission_id, task_id, installation_id, instance_id, capability, request_digest,
            input_scope, policy_generation, grant_id, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          admissionId,
          taskId,
          identity.installationId,
          identity.instanceId,
          READONLY_SIM_CAPABILITY,
          requestDigest,
          READONLY_SIM_CAPABILITY,
          grant?.generation ?? 0,
          grant?.grant_id ?? null,
          state,
        );
      this.writeAudit({
        admissionId,
        grantId: grant?.grant_id ?? null,
        instanceId: identity.instanceId,
        outcome: state,
        requestDigest,
        taskId,
      });
      return { grant, state };
    });

    if (decision.state !== 'admitted' || decision.grant === undefined) {
      throw denied();
    }

    return { admissionId, grantId: decision.grant.grant_id, requestDigest, taskId };
  }

  public recordReadonlyOutcome(admission: ReadonlyAdmission, result: JsonValue): void {
    this.recordReadonlyState(admission, 'succeeded', canonicalJson(result));
  }

  public recordUnknownOutcome(admission: ReadonlyAdmission): void {
    this.recordReadonlyState(admission, 'unknown', null);
  }

  public getTask(identity: BoundWorkloadIdentity, taskId: string): ScopedTask {
    const row = this.database
      .prepare(
        `SELECT admission_id, task_id, state, result_json FROM admissions
         WHERE task_id = ? AND instance_id = ?`,
      )
      .get(taskId, identity.instanceId) as LegacyTaskRow | undefined;
    if (row === undefined) {
      throw denied();
    }
    return {
      admissionId: row.admission_id,
      result: row.result_json === null ? null : (JSON.parse(row.result_json) as JsonValue),
      state: row.state,
      taskId: row.task_id,
    };
  }

  public registerTrustedCounterContext(context: TrustedCounterContext): void {
    this.transaction(() => {
      const { identity } = context;
      const previous = this.context(identity.installationId, identity.instanceId);
      if (previous !== undefined) {
        const sameEpoch = identity.epoch === previous.epoch;
        const differentIdentity =
          identity.bootId !== previous.boot_id || identity.channelId !== previous.channel_id;
        const trustedContextRegressed =
          context.providerEpoch < previous.provider_epoch ||
          context.profileGeneration < previous.profile_generation;
        if (
          identity.epoch < previous.epoch ||
          (sameEpoch && differentIdentity) ||
          trustedContextRegressed
        ) {
          throw stale();
        }
      }
      this.database
        .prepare(
          `INSERT INTO installation_policies
           (installation_id, policy_generation, host_allowed, installation_allowed)
           VALUES (?, 1, 1, 1)
           ON CONFLICT(installation_id) DO NOTHING`,
        )
        .run(identity.installationId);
      this.database
        .prepare(
          `INSERT INTO trusted_counter_contexts
           (installation_id, instance_id, boot_id, channel_id, epoch, lease_expires_at,
            provider_id, provider_epoch, profile_generation)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(installation_id, instance_id) DO UPDATE SET
             boot_id = excluded.boot_id,
             channel_id = excluded.channel_id,
             epoch = excluded.epoch,
             lease_expires_at = excluded.lease_expires_at,
             provider_id = excluded.provider_id,
             provider_epoch = excluded.provider_epoch,
             profile_generation = excluded.profile_generation`,
        )
        .run(
          identity.installationId,
          identity.instanceId,
          identity.bootId,
          identity.channelId,
          identity.epoch,
          context.leaseExpiresAt,
          context.providerId,
          context.providerEpoch,
          context.profileGeneration,
        );
    });
  }

  public applyCounterGrant(grant: OperatorCounterGrant): string {
    if (
      !Number.isInteger(grant.maxAmount) ||
      grant.maxAmount < 1 ||
      grant.maxAmount > 10 ||
      !Number.isInteger(grant.remainingUses) ||
      grant.remainingUses < 0
    ) {
      throw new Error('The trusted counter grant constraints are invalid.');
    }

    return this.transaction(() => {
      const policy = this.policy(grant.installationId);
      const generation = policy.policy_generation + 1;
      const grantId = `counter-grant-${randomUUID()}`;
      this.database
        .prepare('UPDATE installation_policies SET policy_generation = ? WHERE installation_id = ?')
        .run(generation, grant.installationId);
      this.database
        .prepare(
          `INSERT INTO counter_grants
           (grant_id, installation_id, subject_instance_id, capability, resource_id, effect,
            max_amount, remaining_uses, requires_approval, expires_at, generation, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          grantId,
          grant.installationId,
          grant.subjectInstanceId,
          COUNTER_SIM_CAPABILITY,
          grant.resourceId ?? COUNTER_SIM_RESOURCE,
          grant.effect,
          grant.maxAmount,
          grant.remainingUses,
          grant.requiresApproval === true ? 1 : 0,
          grant.expiresAt,
          generation,
        );
      return grantId;
    });
  }

  public setTrustedInstallationPolicy(
    installationId: string,
    controls: { hostAllowed: boolean; installationAllowed: boolean },
  ): number {
    return this.transaction(() => {
      const current = this.policy(installationId);
      const generation = current.policy_generation + 1;
      this.database
        .prepare(
          `UPDATE installation_policies
           SET policy_generation = ?, host_allowed = ?, installation_allowed = ?
           WHERE installation_id = ?`,
        )
        .run(
          generation,
          controls.hostAllowed ? 1 : 0,
          controls.installationAllowed ? 1 : 0,
          installationId,
        );
      return generation;
    });
  }

  public enqueueCounterTask(
    identity: BoundWorkloadIdentity,
    input: CounterAddArguments,
    idempotencyKey: string,
  ): CounterTask {
    const requestDigest = digestCounter(input);
    return this.transaction(() => {
      const context = this.liveContext(identity);
      const existing = this.database
        .prepare(
          `SELECT * FROM counter_tasks
           WHERE installation_id = ? AND instance_id = ? AND idempotency_key = ?`,
        )
        .get(identity.installationId, identity.instanceId, idempotencyKey) as
        | CounterTaskRow
        | undefined;
      if (existing !== undefined) {
        if (existing.request_digest !== requestDigest) {
          throw new ContractError(
            'QD_IDEMPOTENCY_CONFLICT',
            'The idempotency key is already bound to a different request.',
            -32011,
          );
        }
        return counterTask(existing);
      }

      const evaluation = this.evaluate(identity, input, context, false);
      const taskId = `counter-task-${randomUUID()}`;
      const admissionId = `counter-admission-${randomUUID()}`;
      this.database
        .prepare(
          `INSERT INTO counter_tasks
           (task_id, admission_id, installation_id, instance_id, idempotency_key, request_digest,
            counter_id, amount, provider_id, provider_epoch, profile_generation, policy_generation,
            bound_boot_id, bound_channel_id, bound_epoch, state, state_version, cancel_requested,
            provider_observation_version, result_json, executor_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, 0, -1, NULL, NULL)`,
        )
        .run(
          taskId,
          admissionId,
          identity.installationId,
          identity.instanceId,
          idempotencyKey,
          requestDigest,
          input.counterId,
          input.amount,
          context.provider_id,
          context.provider_epoch,
          context.profile_generation,
          evaluation.policyGeneration,
          identity.bootId,
          identity.channelId,
          identity.epoch,
        );
      this.history(taskId, 1, 'queued', 'trusted-enqueue');
      return {
        admissionId,
        amount: input.amount,
        cancelRequested: false,
        counterId: input.counterId,
        providerEpoch: context.provider_epoch,
        providerId: context.provider_id,
        requestDigest,
        result: null,
        state: 'queued',
        stateVersion: 1,
        taskId,
      };
    });
  }

  public applyTrustedApproval(approval: CounterApproval): string {
    return this.transaction(() => {
      const task = this.taskById(approval.taskId);
      if (
        approval.capability !== COUNTER_SIM_CAPABILITY ||
        task.installation_id !== approval.installationId ||
        task.instance_id !== approval.subjectInstanceId ||
        task.request_digest !== approval.digest ||
        task.counter_id !== approval.resourceId ||
        approval.expiresAt <= Date.now()
      ) {
        throw new Error('The trusted approval does not match its task binding.');
      }
      const approvalId = `counter-approval-${randomUUID()}`;
      this.database
        .prepare(
          `INSERT INTO counter_approvals
           (approval_id, task_id, installation_id, subject_instance_id, capability, resource_id,
            request_digest, expires_at, used)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          approvalId,
          approval.taskId,
          approval.installationId,
          approval.subjectInstanceId,
          approval.capability,
          approval.resourceId,
          approval.digest,
          approval.expiresAt,
        );
      return approvalId;
    });
  }

  public requestCancellation(
    identity: BoundWorkloadIdentity,
    taskId: string,
    reason: string,
  ): CounterTask {
    return this.transaction(() => {
      this.liveContext(identity);
      const task = this.scopedTask(identity, taskId);
      if (task.state === 'queued') {
        return this.transition(task, 'canceled', 'cancel-before-dispatch', {
          cancelReason: reason,
          cancelRequested: true,
        });
      }
      if (!task.cancel_requested && !terminal(task.state)) {
        return this.transition(task, task.state, 'cancel-requested', {
          cancelReason: reason,
          cancelRequested: true,
          source: 'public-task-cancel',
        });
      }
      return counterTask(this.scopedTask(identity, taskId));
    });
  }

  public acquireTrustedExecutorSession(identity: BoundWorkloadIdentity): string {
    return this.transaction(() => {
      this.liveContext(identity);
      const existing = this.database
        .prepare(
          `SELECT session_id FROM executor_sessions
           WHERE installation_id = ? AND instance_id = ? AND active = 1
           ORDER BY generation DESC LIMIT 1`,
        )
        .get(identity.installationId, identity.instanceId) as { session_id: string } | undefined;
      if (existing !== undefined) {
        return existing.session_id;
      }
      const next = this.database
        .prepare(
          `SELECT COALESCE(MAX(generation), 0) AS generation FROM executor_sessions
           WHERE installation_id = ? AND instance_id = ?`,
        )
        .get(identity.installationId, identity.instanceId) as { generation: number };
      const sessionId = `executor-${randomUUID()}`;
      this.database
        .prepare(
          `INSERT INTO executor_sessions
           (session_id, installation_id, instance_id, generation, active)
           VALUES (?, ?, ?, ?, 1)`,
        )
        .run(sessionId, identity.installationId, identity.instanceId, next.generation + 1);
      return sessionId;
    });
  }

  public commitCounterDispatch(
    identity: BoundWorkloadIdentity,
    taskId: string,
    sessionId: string,
  ): CounterDispatch {
    return this.transaction(() => {
      const context = this.liveContext(identity);
      const task = this.scopedTask(identity, taskId);
      if (task.state !== 'queued') {
        return { admissionId: task.admission_id, decision: 'existing', taskId: task.task_id };
      }
      this.liveSession(task, sessionId);
      if (task.cancel_requested) {
        const canceled = this.transition(task, 'canceled', 'cancel-before-dispatch');
        return { admissionId: canceled.admissionId, decision: 'canceled', taskId: canceled.taskId };
      }
      if (!this.matchesOriginalDispatchContext(task, identity, context)) {
        const rejected = this.transition(task, 'rejected', 'stale-dispatch-context');
        return { admissionId: rejected.admissionId, decision: 'denied', taskId: rejected.taskId };
      }

      let grants: CounterGrantRow[];
      try {
        const evaluation = this.evaluate(identity, this.inputFor(task), context, true);
        if (evaluation.policyGeneration !== task.policy_generation) {
          const rejected = this.transition(task, 'rejected', 'stale-policy-generation');
          return { admissionId: rejected.admissionId, decision: 'denied', taskId: rejected.taskId };
        }
        grants = evaluation.allowGrants;
      } catch (error) {
        if (error instanceof ContractError) {
          const rejected = this.transition(task, 'rejected', 'dispatch-policy-denied');
          return { admissionId: rejected.admissionId, decision: 'denied', taskId: rejected.taskId };
        }
        throw error;
      }

      for (const grant of grants) {
        const result = this.database
          .prepare(
            `UPDATE counter_grants SET remaining_uses = remaining_uses - 1
             WHERE grant_id = ? AND remaining_uses > 0`,
          )
          .run(grant.grant_id) as { changes: number };
        if (result.changes !== 1) {
          const rejected = this.transition(task, 'rejected', 'counter-budget-exhausted');
          return { admissionId: rejected.admissionId, decision: 'denied', taskId: rejected.taskId };
        }
      }
      this.consumeApproval(task);
      const version = task.state_version + 1;
      this.database
        .prepare(
          `INSERT INTO counter_dispatches
           (admission_id, task_id, executor_session_id, provider_id, provider_epoch, request_digest, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          task.admission_id,
          task.task_id,
          sessionId,
          task.provider_id,
          task.provider_epoch,
          task.request_digest,
        );
      this.database
        .prepare(
          `UPDATE counter_tasks
           SET state = 'dispatched', state_version = ?, executor_session_id = ?,
               observation_deadline_at = ?
           WHERE task_id = ? AND state = 'queued'`,
        )
        .run(version, sessionId, Date.now() + this.observationDeadlineMs, task.task_id);
      this.history(task.task_id, version, 'dispatch-committed', 'trusted-executor');
      this.commitFault();
      return { admissionId: task.admission_id, decision: 'fresh', taskId: task.task_id };
    });
  }

  public recordProviderObservation(
    identity: BoundWorkloadIdentity,
    taskId: string,
    sessionId: string,
    observation: ProviderObservation,
    source: 'provider-cancel' | 'provider-invoke' | 'provider-reconcile',
  ): CounterTask {
    return this.transaction(() => {
      this.liveContext(identity);
      const task = this.scopedTask(identity, taskId);
      this.liveSession(task, sessionId, source !== 'provider-invoke');
      if (
        task.admission_id !== observation.admissionId ||
        task.provider_epoch !== observation.providerEpoch ||
        (observation.operationId !== undefined &&
          task.provider_operation_id !== null &&
          task.provider_operation_id !== observation.operationId)
      ) {
        this.history(task.task_id, task.state_version, 'observation-rejected', source);
        return counterTask(task);
      }
      if (this.failNextOutcomePersistence) {
        this.failNextOutcomePersistence = false;
        throw new Error('Injected post-dispatch persistence failure.');
      }
      if (observation.observationVersion < task.provider_observation_version) {
        this.history(task.task_id, task.state_version, 'observation-stale', source);
        return counterTask(task);
      }
      if (
        observation.observationVersion === task.provider_observation_version &&
        observation.terminal === 'accepted' &&
        task.state === 'dispatched' &&
        task.observation_deadline_at !== null &&
        task.observation_deadline_at <= Date.now()
      ) {
        return this.transition(task, 'unknown', 'provider-observation-deadline', {
          providerObservation: observation,
          source,
        });
      }
      if (observation.observationVersion === task.provider_observation_version) {
        this.history(
          task.task_id,
          task.state_version,
          this.matchesRecordedObservation(task, observation)
            ? 'observation-duplicate'
            : 'observation-conflict',
          source,
        );
        return counterTask(task);
      }
      if (observation.operationId === undefined && observation.terminal !== 'unsupported') {
        this.history(task.task_id, task.state_version, 'observation-rejected', source);
        return counterTask(task);
      }
      if (terminal(task.state)) {
        const incoming = observationState(observation.terminal);
        if (incoming !== task.state) {
          this.history(task.task_id, task.state_version, 'terminal-conflict', source);
          return counterTask(task);
        }
        return this.transition(task, task.state, 'provider-terminal-observation', {
          providerObservation: observation,
          source,
        });
      }
      switch (observation.terminal) {
        case 'accepted':
          if (task.state !== 'dispatched') {
            this.history(task.task_id, task.state_version, 'observation-conflict', source);
            return counterTask(task);
          }
          if (task.observation_deadline_at !== null && task.observation_deadline_at <= Date.now()) {
            return this.transition(task, 'unknown', 'provider-observation-deadline', {
              providerObservation: observation,
              source,
            });
          }
          return this.transition(task, 'dispatched', 'provider-accepted', {
            providerObservation: observation,
            source,
          });
        case 'completed':
          return this.transition(task, 'succeeded', 'provider-completed', {
            providerObservation: observation,
            result: observation.result ?? null,
            source,
          });
        case 'failed':
          return this.transition(task, 'failed', 'provider-failed', {
            providerObservation: observation,
            result: observation.result ?? null,
            source,
          });
        case 'stopped':
          return this.transition(task, 'canceled', 'provider-stopped', {
            providerObservation: observation,
            source,
          });
        case 'unsupported':
          return this.transition(task, 'unknown', 'provider-observation-unsupported', {
            providerObservation: observation,
            source,
          });
      }
    });
  }

  public markObservationDeadlineUnknown(
    identity: BoundWorkloadIdentity,
    taskId: string,
    sessionId: string,
  ): CounterTask {
    return this.transaction(() => {
      this.liveContext(identity);
      const task = this.scopedTask(identity, taskId);
      this.liveSession(task, sessionId);
      return terminal(task.state)
        ? counterTask(task)
        : this.transition(task, 'unknown', 'provider-observation-deadline');
    });
  }

  public recoverAfterConfirmedExecutorExit(
    identity: BoundWorkloadIdentity,
    sessionId: string,
  ): CounterTask[] {
    return this.transaction(() => {
      this.liveContext(identity);
      const session = this.database
        .prepare(
          `SELECT active FROM executor_sessions
           WHERE session_id = ? AND installation_id = ? AND instance_id = ?`,
        )
        .get(sessionId, identity.installationId, identity.instanceId) as
        | { active: number }
        | undefined;
      if (session?.active !== 1) {
        throw stale();
      }
      this.database
        .prepare('UPDATE executor_sessions SET active = 0 WHERE session_id = ?')
        .run(sessionId);
      const tasks = this.database
        .prepare(
          `SELECT * FROM counter_tasks
           WHERE installation_id = ? AND instance_id = ? AND executor_session_id = ?
             AND state IN ('dispatched', 'running')`,
        )
        .all(
          identity.installationId,
          identity.instanceId,
          sessionId,
        ) as unknown as CounterTaskRow[];
      return tasks.map((task) => this.transition(task, 'unknown', 'executor-exit-ambiguous'));
    });
  }

  public getCounterTask(identity: BoundWorkloadIdentity, taskId: string): CounterTask {
    return this.transaction(() => {
      this.liveContext(identity);
      return counterTask(this.scopedTask(identity, taskId));
    });
  }

  public readCounterHistory(
    identity: BoundWorkloadIdentity,
    taskId: string,
  ): AdmissionHistoryRecord[] {
    return this.transaction(() => {
      this.liveContext(identity);
      this.scopedTask(identity, taskId);
      const rows = this.database
        .prepare(
          `SELECT task_id, state_version, event, source FROM counter_history
           WHERE task_id = ? ORDER BY history_id`,
        )
        .all(taskId) as Array<{
        event: string;
        source: string;
        state_version: number;
        task_id: string;
      }>;
      return rows.map((row) => ({
        event: row.event,
        source: row.source,
        stateVersion: row.state_version,
        taskId: row.task_id,
      }));
    });
  }

  /** Forces an actual SQLite COMMIT failure with a deferred foreign key. */
  public rejectNextCommitForTests(): void {
    this.failNextCommit = true;
  }

  public rejectNextOutcomePersistenceForTests(): void {
    this.failNextOutcomePersistence = true;
  }

  public readSanitizedAudit(): SanitizedAuditRecord[] {
    const rows = this.database
      .prepare(
        `SELECT admission_id, grant_id, instance_id, outcome, request_digest, task_id
         FROM audit_records ORDER BY rowid`,
      )
      .all() as Array<{
      admission_id: string | null;
      grant_id: string | null;
      instance_id: string;
      outcome: string;
      request_digest: string;
      task_id: string | null;
    }>;
    return rows.map((row) => ({
      admissionId: row.admission_id,
      grantId: row.grant_id,
      instanceId: row.instance_id,
      outcome: row.outcome,
      requestDigest: row.request_digest,
      taskId: row.task_id,
    }));
  }

  public close(): void {
    this.database.close();
  }

  private migrate(): void {
    const tables = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { count: number };
    const version = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > SCHEMA_VERSION) {
      throw new Error('The policy database uses a newer unsupported schema version.');
    }
    if (version.user_version === SCHEMA_VERSION) {
      return;
    }
    if (
      tables.count > 0 &&
      version.user_version < SCHEMA_VERSION &&
      this.databasePath !== ':memory:'
    ) {
      const backup = `${this.databasePath}.schema-${version.user_version}.backup.sqlite`;
      if (!existsSync(backup)) {
        this.database.exec(`VACUUM INTO ${sqlString(backup)}`);
      }
    }
    this.transaction(() => {
      this.database.exec(legacySchema());
      this.database.exec(admissionSchema());
      this.ensureCounterTaskColumns();
      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private recordReadonlyState(
    admission: ReadonlyAdmission,
    state: Extract<LegacyState, 'succeeded' | 'unknown'>,
    result: string | null,
  ): void {
    this.transaction(() => {
      const record = this.database
        .prepare('SELECT state, instance_id FROM admissions WHERE admission_id = ?')
        .get(admission.admissionId) as { instance_id: string; state: LegacyState } | undefined;
      if (record?.state !== 'admitted') {
        throw stale();
      }
      this.database
        .prepare('UPDATE admissions SET state = ?, result_json = ? WHERE admission_id = ?')
        .run(state, result, admission.admissionId);
      this.writeAudit({
        admissionId: admission.admissionId,
        grantId: admission.grantId,
        instanceId: record.instance_id,
        outcome: state,
        requestDigest: admission.requestDigest,
        taskId: admission.taskId,
      });
    });
  }

  private currentLegacyGrant(
    installationId: string,
    instanceId: string,
    capability: string,
  ): LegacyGrantRow | undefined {
    return this.database
      .prepare(
        `SELECT grant_id, effect, generation FROM fixture_grants
         WHERE installation_id = ? AND subject_instance_id = ? AND capability = ? AND active = 1
         ORDER BY CASE effect WHEN 'deny' THEN 0 ELSE 1 END, generation DESC LIMIT 1`,
      )
      .get(installationId, instanceId, capability) as LegacyGrantRow | undefined;
  }

  private nextLegacyGeneration(installationId: string): number {
    const row = this.database
      .prepare(
        'SELECT COALESCE(MAX(generation), 0) AS generation FROM fixture_grants WHERE installation_id = ?',
      )
      .get(installationId) as { generation: number };
    return row.generation + 1;
  }

  private writeAudit(record: SanitizedAuditRecord): void {
    this.database
      .prepare(
        `INSERT INTO audit_records
         (audit_id, instance_id, grant_id, request_digest, admission_id, task_id, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `audit-${randomUUID()}`,
        record.instanceId,
        record.grantId,
        record.requestDigest,
        record.admissionId,
        record.taskId,
        record.outcome,
      );
  }

  private context(installationId: string, instanceId: string): ContextRow | undefined {
    return this.database
      .prepare(
        `SELECT boot_id, channel_id, epoch, lease_expires_at, provider_id, provider_epoch,
                profile_generation
         FROM trusted_counter_contexts WHERE installation_id = ? AND instance_id = ?`,
      )
      .get(installationId, instanceId) as ContextRow | undefined;
  }

  private liveContext(identity: BoundWorkloadIdentity): ContextRow {
    const context = this.context(identity.installationId, identity.instanceId);
    if (
      context === undefined ||
      context.boot_id !== identity.bootId ||
      context.channel_id !== identity.channelId ||
      context.epoch !== identity.epoch ||
      context.lease_expires_at <= Date.now()
    ) {
      throw stale();
    }
    return context;
  }

  private policy(installationId: string): {
    host_allowed: number;
    installation_allowed: number;
    policy_generation: number;
  } {
    const row = this.database
      .prepare(
        `SELECT policy_generation, host_allowed, installation_allowed FROM installation_policies
         WHERE installation_id = ?`,
      )
      .get(installationId) as
      | { host_allowed: number; installation_allowed: number; policy_generation: number }
      | undefined;
    if (row === undefined) {
      throw stale();
    }
    return row;
  }

  private evaluate(
    identity: BoundWorkloadIdentity,
    input: CounterAddArguments,
    context: ContextRow,
    needBudget: boolean,
  ): { allowGrants: CounterGrantRow[]; policyGeneration: number } {
    const policy = this.policy(identity.installationId);
    if (
      policy.host_allowed !== 1 ||
      policy.installation_allowed !== 1 ||
      context.provider_id === ''
    ) {
      throw denied();
    }
    const grants = this.database
      .prepare(
        `SELECT grant_id, effect, max_amount, remaining_uses, requires_approval
         FROM counter_grants
         WHERE installation_id = ? AND subject_instance_id = ? AND capability = ? AND resource_id = ?
           AND active = 1 AND expires_at > ? ORDER BY generation`,
      )
      .all(
        identity.installationId,
        identity.instanceId,
        COUNTER_SIM_CAPABILITY,
        input.counterId,
        Date.now(),
      ) as unknown as CounterGrantRow[];
    const allows = grants.filter((grant) => grant.effect === 'allow');
    const denyExists = grants.some((grant) => grant.effect === 'deny');
    const constraintsFit = allows.every(
      (grant) => input.amount <= grant.max_amount && (!needBudget || grant.remaining_uses > 0),
    );
    if (denyExists || allows.length === 0 || !constraintsFit) {
      throw denied();
    }
    return { allowGrants: allows, policyGeneration: policy.policy_generation };
  }

  private taskById(taskId: string): CounterTaskRow {
    const task = this.database
      .prepare('SELECT * FROM counter_tasks WHERE task_id = ?')
      .get(taskId) as CounterTaskRow | undefined;
    if (task === undefined) {
      throw new Error('The trusted task record is missing.');
    }
    return task;
  }

  private scopedTask(identity: BoundWorkloadIdentity, taskId: string): CounterTaskRow {
    const task = this.database
      .prepare(
        `SELECT * FROM counter_tasks
         WHERE task_id = ? AND installation_id = ? AND instance_id = ?`,
      )
      .get(taskId, identity.installationId, identity.instanceId) as CounterTaskRow | undefined;
    if (task === undefined) {
      throw denied();
    }
    return task;
  }

  private inputFor(task: CounterTaskRow): CounterAddArguments {
    return { amount: task.amount, counterId: COUNTER_SIM_RESOURCE };
  }

  private matchesOriginalDispatchContext(
    task: CounterTaskRow,
    identity: BoundWorkloadIdentity,
    context: ContextRow,
  ): boolean {
    return (
      task.bound_boot_id === identity.bootId &&
      task.bound_channel_id === identity.channelId &&
      task.bound_epoch === identity.epoch &&
      task.provider_id === context.provider_id &&
      task.provider_epoch === context.provider_epoch &&
      task.profile_generation === context.profile_generation
    );
  }

  private matchesRecordedObservation(
    task: CounterTaskRow,
    observation: ProviderObservation,
  ): boolean {
    const observedState = observationState(observation.terminal);
    if (observation.terminal === 'accepted') {
      return task.state === 'dispatched';
    }
    if (observation.terminal === 'unsupported') {
      return task.state === 'unknown';
    }
    return observedState !== undefined && task.state === observedState;
  }

  private liveSession(
    task: CounterTaskRow,
    sessionId: string,
    allowFencedPredecessor = false,
  ): void {
    const row = this.database
      .prepare(
        `SELECT active FROM executor_sessions
         WHERE session_id = ? AND installation_id = ? AND instance_id = ?`,
      )
      .get(sessionId, task.installation_id, task.instance_id) as { active: number } | undefined;
    const ownsTask = task.executor_session_id === null || task.executor_session_id === sessionId;
    if (row?.active !== 1 || (!ownsTask && !allowFencedPredecessor)) {
      throw stale();
    }
  }

  private consumeApproval(task: CounterTaskRow): void {
    const required = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM counter_grants
         WHERE installation_id = ? AND subject_instance_id = ? AND capability = ? AND resource_id = ?
           AND active = 1 AND expires_at > ? AND requires_approval = 1`,
      )
      .get(
        task.installation_id,
        task.instance_id,
        COUNTER_SIM_CAPABILITY,
        task.counter_id,
        Date.now(),
      ) as { count: number };
    if (required.count === 0) {
      return;
    }
    const approval = this.database
      .prepare(
        `SELECT approval_id FROM counter_approvals
         WHERE task_id = ? AND installation_id = ? AND subject_instance_id = ? AND capability = ?
           AND resource_id = ? AND request_digest = ? AND expires_at > ? AND used = 0 LIMIT 1`,
      )
      .get(
        task.task_id,
        task.installation_id,
        task.instance_id,
        COUNTER_SIM_CAPABILITY,
        task.counter_id,
        task.request_digest,
        Date.now(),
      ) as { approval_id: string } | undefined;
    if (approval === undefined) {
      throw denied();
    }
    const update = this.database
      .prepare('UPDATE counter_approvals SET used = 1 WHERE approval_id = ? AND used = 0')
      .run(approval.approval_id) as { changes: number };
    if (update.changes !== 1) {
      throw denied();
    }
  }

  private transition(
    task: CounterTaskRow,
    state: CounterTaskState,
    event: string,
    options: {
      cancelReason?: string;
      cancelRequested?: boolean;
      providerObservation?: ProviderObservation;
      result?: JsonValue | null;
      source?: string;
    } = {},
  ): CounterTask {
    const resultJson =
      options.result === undefined ? task.result_json : canonicalJson(options.result);
    const cancelRequested =
      options.cancelRequested === undefined
        ? task.cancel_requested
        : options.cancelRequested
          ? 1
          : 0;
    const providerObservationVersion =
      options.providerObservation === undefined
        ? task.provider_observation_version
        : options.providerObservation.observationVersion;
    const providerOperationId =
      options.providerObservation === undefined
        ? task.provider_operation_id
        : (options.providerObservation.operationId ?? task.provider_operation_id);
    const version = task.state_version + 1;
    const update = this.database
      .prepare(
        `UPDATE counter_tasks
         SET state = ?, state_version = ?, result_json = ?, cancel_requested = ?, cancel_reason = ?,
             provider_observation_version = ?, provider_operation_id = ?
         WHERE task_id = ? AND state_version = ?`,
      )
      .run(
        state,
        version,
        resultJson,
        cancelRequested,
        options.cancelReason ?? null,
        providerObservationVersion,
        providerOperationId,
        task.task_id,
        task.state_version,
      ) as { changes: number };
    if (update.changes !== 1) {
      throw stale();
    }
    this.history(task.task_id, version, event, options.source ?? 'policy-authority');
    return {
      admissionId: task.admission_id,
      amount: task.amount,
      cancelRequested: cancelRequested === 1,
      counterId: COUNTER_SIM_RESOURCE,
      providerEpoch: task.provider_epoch,
      providerId: task.provider_id,
      requestDigest: task.request_digest,
      result: resultJson === null ? null : (JSON.parse(resultJson) as JsonValue),
      state,
      stateVersion: version,
      taskId: task.task_id,
    };
  }

  private history(taskId: string, stateVersion: number, event: string, source: string): void {
    this.database
      .prepare(
        `INSERT INTO counter_history (history_id, task_id, state_version, event, source)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(`history-${randomUUID()}`, taskId, stateVersion, event, source);
  }

  private ensureCounterTaskColumns(): void {
    const columns = this.database.prepare('PRAGMA table_info(counter_tasks)').all() as Array<{
      name: string;
    }>;
    const existing = new Set(columns.map((column) => column.name));
    const additions = [
      ['bound_boot_id', "TEXT NOT NULL DEFAULT ''"],
      ['bound_channel_id', "TEXT NOT NULL DEFAULT ''"],
      ['bound_epoch', 'INTEGER NOT NULL DEFAULT -1'],
      ['provider_observation_version', 'INTEGER NOT NULL DEFAULT -1'],
      ['provider_operation_id', 'TEXT'],
      ['observation_deadline_at', 'INTEGER'],
    ] as const;
    for (const [name, definition] of additions) {
      if (!existing.has(name)) {
        this.database.exec(`ALTER TABLE counter_tasks ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  private commitFault(): void {
    if (!this.failNextCommit) {
      return;
    }
    this.failNextCommit = false;
    this.database
      .prepare('INSERT INTO counter_commit_guards (guard_id, task_id) VALUES (?, ?)')
      .run(`commit-fault-${randomUUID()}`, `missing-task-${randomUUID()}`);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // A failed COMMIT can already have closed the transaction.
      }
      throw error;
    }
  }
}

function digestReadonly(argumentsValue: Record<string, JsonValue>): string {
  return createHash('sha256')
    .update(canonicalJson({ arguments: argumentsValue, capability: READONLY_SIM_CAPABILITY }))
    .digest('hex');
}

function digestCounter(input: CounterAddArguments): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        arguments: { amount: input.amount, counterId: input.counterId },
        capability: COUNTER_SIM_CAPABILITY,
        digestSchema: COUNTER_DIGEST_SCHEMA,
        provider: 'reference-counter/v1',
        resource: COUNTER_SIM_RESOURCE,
        schemaVersion: COUNTER_SIM_SCHEMA_VERSION,
      }),
    )
    .digest('hex');
}

function counterTask(row: CounterTaskRow): CounterTask {
  return {
    admissionId: row.admission_id,
    amount: row.amount,
    cancelRequested: row.cancel_requested === 1,
    counterId: COUNTER_SIM_RESOURCE,
    providerEpoch: row.provider_epoch,
    providerId: row.provider_id,
    requestDigest: row.request_digest,
    result: row.result_json === null ? null : (JSON.parse(row.result_json) as JsonValue),
    state: row.state,
    stateVersion: row.state_version,
    taskId: row.task_id,
  };
}

function terminal(state: CounterTaskState): boolean {
  return (
    state === 'succeeded' || state === 'failed' || state === 'canceled' || state === 'rejected'
  );
}

function observationState(
  terminalState: ProviderObservation['terminal'],
): CounterTaskState | undefined {
  if (terminalState === 'completed') {
    return 'succeeded';
  }
  if (terminalState === 'failed') {
    return 'failed';
  }
  if (terminalState === 'stopped') {
    return 'canceled';
  }
  return undefined;
}

function denied(): ContractError {
  return new ContractError('QD_PERMISSION_DENIED', 'Permission denied.', -32001);
}

function stale(): ContractError {
  return new ContractError('QD_STALE_CONTEXT', 'Execution context is no longer current.', -32003);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function legacySchema(): string {
  return `
    CREATE TABLE IF NOT EXISTS fixture_grants (
      grant_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      subject_instance_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
      generation INTEGER NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS admissions (
      admission_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      installation_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      input_scope TEXT NOT NULL,
      policy_generation INTEGER NOT NULL,
      grant_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('rejected', 'admitted', 'succeeded', 'unknown')),
      result_json TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS audit_records (
      audit_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      grant_id TEXT,
      request_digest TEXT NOT NULL,
      admission_id TEXT,
      task_id TEXT,
      outcome TEXT NOT NULL
    ) STRICT;
  `;
}

function admissionSchema(): string {
  return `
    CREATE TABLE IF NOT EXISTS installation_policies (
      installation_id TEXT PRIMARY KEY,
      policy_generation INTEGER NOT NULL,
      host_allowed INTEGER NOT NULL CHECK (host_allowed IN (0, 1)),
      installation_allowed INTEGER NOT NULL CHECK (installation_allowed IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS trusted_counter_contexts (
      installation_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      boot_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      lease_expires_at INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      provider_epoch INTEGER NOT NULL,
      profile_generation INTEGER NOT NULL,
      PRIMARY KEY (installation_id, instance_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS counter_grants (
      grant_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      subject_instance_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
      max_amount INTEGER NOT NULL CHECK (max_amount BETWEEN 1 AND 10),
      remaining_uses INTEGER NOT NULL CHECK (remaining_uses >= 0),
      requires_approval INTEGER NOT NULL CHECK (requires_approval IN (0, 1)),
      expires_at INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS counter_tasks (
      task_id TEXT PRIMARY KEY,
      admission_id TEXT NOT NULL UNIQUE,
      installation_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      counter_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 10),
      provider_id TEXT NOT NULL,
      provider_epoch INTEGER NOT NULL,
      profile_generation INTEGER NOT NULL,
      policy_generation INTEGER NOT NULL,
      bound_boot_id TEXT NOT NULL,
      bound_channel_id TEXT NOT NULL,
      bound_epoch INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'dispatched', 'running', 'succeeded', 'failed', 'canceled', 'unknown', 'rejected')),
      state_version INTEGER NOT NULL,
      cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
      cancel_reason TEXT,
      provider_observation_version INTEGER NOT NULL DEFAULT -1,
      provider_operation_id TEXT,
      observation_deadline_at INTEGER,
      result_json TEXT,
      executor_session_id TEXT,
      UNIQUE (installation_id, instance_id, idempotency_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS counter_approvals (
      approval_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      subject_instance_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL CHECK (used IN (0, 1)),
      FOREIGN KEY (task_id) REFERENCES counter_tasks(task_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS executor_sessions (
      session_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS counter_dispatches (
      admission_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      executor_session_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_epoch INTEGER NOT NULL,
      request_digest TEXT NOT NULL,
      sent_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES counter_tasks(task_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS counter_history (
      history_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      state_version INTEGER NOT NULL,
      event TEXT NOT NULL,
      source TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES counter_tasks(task_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS counter_commit_guards (
      guard_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES counter_tasks(task_id) DEFERRABLE INITIALLY DEFERRED
    ) STRICT;
  `;
}

import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  canonicalJson,
  ContractError,
  type JsonValue,
  READONLY_SIM_CAPABILITY,
} from '../../contracts/src/index.js';
import type { BoundWorkloadIdentity } from '../../supervisor/src/index.js';

type GrantEffect = 'allow' | 'deny';
type AdmissionState = 'rejected' | 'admitted' | 'succeeded' | 'unknown';

interface GrantRow {
  grant_id: string;
  effect: GrantEffect;
  generation: number;
}

interface TaskRow {
  admission_id: string;
  task_id: string;
  state: AdmissionState;
  result_json: string | null;
}

export interface OperatorFixtureGrant {
  installationId: string;
  subjectInstanceId: string;
  capability: typeof READONLY_SIM_CAPABILITY;
  effect: GrantEffect;
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
  state: AdmissionState;
  taskId: string;
}

export interface SanitizedAuditRecord {
  admissionId: string | null;
  grantId: string | null;
  instanceId: string;
  outcome: string;
  requestDigest: string;
  taskId: string | null;
}

export class PolicyAuthority {
  private readonly database: DatabaseSync;

  public constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = FULL');
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec(`
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
    `);
  }

  public applyOperatorFixtureGrant(grant: OperatorFixtureGrant): string {
    const grantId = `grant-${randomUUID()}`;
    const generation = this.nextPolicyGeneration(grant.installationId);

    this.database
      .prepare(
        `
          INSERT INTO fixture_grants (
            grant_id,
            installation_id,
            subject_instance_id,
            capability,
            effect,
            generation,
            active
          ) VALUES (?, ?, ?, ?, ?, ?, 1)
        `,
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
    const row = this.currentGrant(
      identity.installationId,
      identity.instanceId,
      READONLY_SIM_CAPABILITY,
    );

    return row?.effect === 'allow' ? [READONLY_SIM_CAPABILITY] : [];
  }

  public admitReadonlyInvocation(
    identity: BoundWorkloadIdentity,
    argumentsValue: Record<string, JsonValue>,
  ): ReadonlyAdmission {
    const requestDigest = digestRequest(READONLY_SIM_CAPABILITY, argumentsValue);
    const admissionId = `admission-${randomUUID()}`;
    const taskId = `task-${randomUUID()}`;
    const decision = this.runInTransaction(() => {
      const grant = this.currentGrant(
        identity.installationId,
        identity.instanceId,
        READONLY_SIM_CAPABILITY,
      );
      const state: AdmissionState = grant?.effect === 'allow' ? 'admitted' : 'rejected';
      const outcome = state === 'admitted' ? 'admitted' : 'rejected';
      const generation = grant?.generation ?? 0;

      this.database
        .prepare(
          `
            INSERT INTO admissions (
              admission_id,
              task_id,
              installation_id,
              instance_id,
              capability,
              request_digest,
              input_scope,
              policy_generation,
              grant_id,
              state
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          admissionId,
          taskId,
          identity.installationId,
          identity.instanceId,
          READONLY_SIM_CAPABILITY,
          requestDigest,
          READONLY_SIM_CAPABILITY,
          generation,
          grant?.grant_id ?? null,
          state,
        );

      this.writeAudit({
        admissionId,
        grantId: grant?.grant_id ?? null,
        instanceId: identity.instanceId,
        outcome,
        requestDigest,
        taskId,
      });

      return {
        grant,
        state,
      };
    });

    if (decision.state !== 'admitted' || decision.grant === undefined) {
      throw new ContractError('QD_PERMISSION_DENIED', 'Permission denied.', -32001);
    }

    return {
      admissionId,
      grantId: decision.grant.grant_id,
      requestDigest,
      taskId,
    };
  }

  public recordReadonlyOutcome(admission: ReadonlyAdmission, result: JsonValue): void {
    this.runInTransaction(() => {
      const serializedResult = canonicalJson(result);
      const existing = this.database
        .prepare('SELECT state FROM admissions WHERE admission_id = ?')
        .get(admission.admissionId) as { state: AdmissionState } | undefined;

      if (existing?.state !== 'admitted') {
        throw new ContractError(
          'QD_STALE_CONTEXT',
          'Execution context is no longer current.',
          -32003,
        );
      }

      this.database
        .prepare('UPDATE admissions SET state = ?, result_json = ? WHERE admission_id = ?')
        .run('succeeded', serializedResult, admission.admissionId);

      const admissionRow = this.database
        .prepare('SELECT instance_id FROM admissions WHERE admission_id = ?')
        .get(admission.admissionId) as { instance_id: string } | undefined;

      if (admissionRow === undefined) {
        throw new ContractError(
          'QD_STALE_CONTEXT',
          'Execution context is no longer current.',
          -32003,
        );
      }

      this.writeAudit({
        admissionId: admission.admissionId,
        grantId: admission.grantId,
        instanceId: admissionRow.instance_id,
        outcome: 'succeeded',
        requestDigest: admission.requestDigest,
        taskId: admission.taskId,
      });
    });
  }

  public recordUnknownOutcome(admission: ReadonlyAdmission): void {
    this.runInTransaction(() => {
      const existing = this.database
        .prepare('SELECT state FROM admissions WHERE admission_id = ?')
        .get(admission.admissionId) as { state: AdmissionState } | undefined;

      if (existing?.state !== 'admitted') {
        throw new ContractError(
          'QD_STALE_CONTEXT',
          'Execution context is no longer current.',
          -32003,
        );
      }

      this.database
        .prepare('UPDATE admissions SET state = ?, result_json = NULL WHERE admission_id = ?')
        .run('unknown', admission.admissionId);

      const admissionRow = this.database
        .prepare('SELECT instance_id FROM admissions WHERE admission_id = ?')
        .get(admission.admissionId) as { instance_id: string } | undefined;

      if (admissionRow === undefined) {
        throw new ContractError(
          'QD_STALE_CONTEXT',
          'Execution context is no longer current.',
          -32003,
        );
      }

      this.writeAudit({
        admissionId: admission.admissionId,
        grantId: admission.grantId,
        instanceId: admissionRow.instance_id,
        outcome: 'unknown',
        requestDigest: admission.requestDigest,
        taskId: admission.taskId,
      });
    });
  }

  public getTask(identity: BoundWorkloadIdentity, taskId: string): ScopedTask {
    const row = this.database
      .prepare(
        `
          SELECT admission_id, task_id, state, result_json
          FROM admissions
          WHERE task_id = ? AND instance_id = ?
        `,
      )
      .get(taskId, identity.instanceId) as TaskRow | undefined;

    if (row === undefined) {
      throw new ContractError('QD_PERMISSION_DENIED', 'Permission denied.', -32001);
    }

    return {
      admissionId: row.admission_id,
      result: row.result_json === null ? null : (JSON.parse(row.result_json) as JsonValue),
      state: row.state,
      taskId: row.task_id,
    };
  }

  public readSanitizedAudit(): SanitizedAuditRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT admission_id, grant_id, instance_id, outcome, request_digest, task_id
          FROM audit_records
          ORDER BY rowid
        `,
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

  private currentGrant(
    installationId: string,
    subjectInstanceId: string,
    capability: string,
  ): GrantRow | undefined {
    return this.database
      .prepare(
        `
          SELECT grant_id, effect, generation
          FROM fixture_grants
          WHERE installation_id = ? AND subject_instance_id = ? AND capability = ? AND active = 1
          ORDER BY CASE effect WHEN 'deny' THEN 0 ELSE 1 END, generation DESC
          LIMIT 1
        `,
      )
      .get(installationId, subjectInstanceId, capability) as GrantRow | undefined;
  }

  private nextPolicyGeneration(installationId: string): number {
    const row = this.database
      .prepare(
        'SELECT COALESCE(MAX(generation), 0) AS generation FROM fixture_grants WHERE installation_id = ?',
      )
      .get(installationId) as { generation: number };

    return row.generation + 1;
  }

  private runInTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private writeAudit(record: SanitizedAuditRecord): void {
    this.database
      .prepare(
        `
          INSERT INTO audit_records (
            audit_id,
            instance_id,
            grant_id,
            request_digest,
            admission_id,
            task_id,
            outcome
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
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
}

function digestRequest(capability: string, argumentsValue: Record<string, JsonValue>): string {
  const canonicalRequest = canonicalJson({
    arguments: argumentsValue,
    capability,
  });

  return createHash('sha256').update(canonicalRequest).digest('hex');
}

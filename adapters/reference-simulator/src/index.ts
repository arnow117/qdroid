import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type {
  CounterCapabilityProvider,
  CounterProviderObservation,
  CounterProviderRequest,
  JsonValue,
  ReadonlyCapabilityProvider,
  ReadonlySimulatorResult,
} from '../../../packages/contracts/src/index.js';

export class ReferenceSimulator implements ReadonlyCapabilityProvider {
  private readonly calls: string[] = [];

  public readStatus(): ReadonlySimulatorResult {
    this.calls.push('sim.status.read/v1');

    return {
      mode: 'idle',
      source: 'reference-simulator',
      temperatureC: 21.5,
    };
  }

  public get operationCount(): number {
    return this.calls.length;
  }
}

export type CounterObservationMode = 'accepted' | 'complete' | 'unsupported';

export interface PersistentCounterSimulatorOptions {
  databasePath: string;
  observationMode?: CounterObservationMode;
}

/**
 * A synthetic downstream provider deliberately does not deduplicate requests.
 * Each invoke persists an independent attempt and effect so admission bugs are
 * visible in tests rather than hidden by a provider idempotency shortcut.
 */
export class PersistentCounterSimulator implements CounterCapabilityProvider {
  private readonly database: DatabaseSync;
  private readonly observationMode: CounterObservationMode;

  public constructor(options: PersistentCounterSimulatorOptions) {
    this.database = new DatabaseSync(options.databasePath);
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = FULL');
    this.database.exec('PRAGMA foreign_keys = ON');
    this.observationMode = options.observationMode ?? 'complete';
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS counter_provider_attempts (
        attempt_id TEXT PRIMARY KEY,
        admission_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        provider_epoch INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS counter_provider_operations (
        operation_id TEXT PRIMARY KEY,
        admission_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        provider_epoch INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        terminal TEXT NOT NULL CHECK (terminal IN ('accepted', 'completed', 'failed', 'stopped', 'unsupported')),
        observation_version INTEGER NOT NULL,
        result_json TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS counter_provider_effects (
        effect_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        admission_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        FOREIGN KEY (operation_id) REFERENCES counter_provider_operations(operation_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS counter_provider_values (
        counter_id TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) STRICT;
    `);
  }

  public invoke(request: CounterProviderRequest): CounterProviderObservation {
    return this.transaction(() => {
      const operationId = `counter-operation-${randomUUID()}`;
      const terminal =
        this.observationMode === 'unsupported'
          ? 'unsupported'
          : this.observationMode === 'accepted'
            ? 'accepted'
            : 'completed';
      const result =
        terminal === 'completed'
          ? {
              amount: request.amount,
              counterId: request.counterId,
              source: 'persistent-reference-simulator',
            }
          : null;

      this.database
        .prepare(
          `INSERT INTO counter_provider_attempts
           (attempt_id, admission_id, task_id, provider_epoch)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          `counter-attempt-${randomUUID()}`,
          request.admissionId,
          request.taskId,
          request.providerEpoch,
        );
      this.database
        .prepare(
          `INSERT INTO counter_provider_operations
           (operation_id, admission_id, task_id, provider_epoch, amount, terminal, observation_version, result_json)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          operationId,
          request.admissionId,
          request.taskId,
          request.providerEpoch,
          request.amount,
          terminal,
          result === null ? null : JSON.stringify(result),
        );

      if (terminal === 'completed') {
        this.database
          .prepare(
            `INSERT INTO counter_provider_effects (effect_id, operation_id, admission_id, amount)
             VALUES (?, ?, ?, ?)`,
          )
          .run(`counter-effect-${randomUUID()}`, operationId, request.admissionId, request.amount);
        this.database
          .prepare(
            `INSERT INTO counter_provider_values (counter_id, value) VALUES (?, ?)
             ON CONFLICT(counter_id) DO UPDATE SET value = value + excluded.value`,
          )
          .run(request.counterId, request.amount);
      }

      return {
        admissionId: request.admissionId,
        observationVersion: 1,
        operationId,
        providerEpoch: request.providerEpoch,
        ...(result === null ? {} : { result }),
        terminal,
      };
    });
  }

  public cancel(admissionId: string, providerEpoch: number): CounterProviderObservation {
    return this.transaction(() => {
      const operation = this.latest(admissionId, providerEpoch);

      if (operation === undefined) {
        return { admissionId, observationVersion: 0, providerEpoch, terminal: 'unsupported' };
      }

      if (operation.terminal === 'accepted') {
        const version = operation.observation_version + 1;
        this.database
          .prepare(
            `UPDATE counter_provider_operations
             SET terminal = 'stopped', observation_version = ?
             WHERE operation_id = ? AND terminal = 'accepted'`,
          )
          .run(version, operation.operation_id);
        return {
          admissionId,
          observationVersion: version,
          operationId: operation.operation_id,
          providerEpoch,
          terminal: 'stopped',
        };
      }

      return observation(operation);
    });
  }

  public observe(admissionId: string, providerEpoch: number): CounterProviderObservation {
    const operation = this.latest(admissionId, providerEpoch);
    return operation === undefined
      ? { admissionId, observationVersion: 0, providerEpoch, terminal: 'unsupported' }
      : observation(operation);
  }

  /** Trusted test-fixture control: the same persisted provider operation finishes later. */
  public completeAccepted(admissionId: string, providerEpoch: number): CounterProviderObservation {
    return this.transaction(() => {
      const operation = this.latest(admissionId, providerEpoch);
      if (operation === undefined || operation.terminal !== 'accepted') {
        throw new Error('The provider operation is not awaiting completion.');
      }
      const observationVersion = operation.observation_version + 1;
      const result = {
        amount: operation.amount,
        counterId: 'counter.default',
        source: 'persistent-reference-simulator',
      };
      this.database
        .prepare(
          `UPDATE counter_provider_operations
           SET terminal = 'completed', observation_version = ?, result_json = ?
           WHERE operation_id = ? AND terminal = 'accepted'`,
        )
        .run(observationVersion, JSON.stringify(result), operation.operation_id);
      this.database
        .prepare(
          `INSERT INTO counter_provider_effects (effect_id, operation_id, admission_id, amount)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          `counter-effect-${randomUUID()}`,
          operation.operation_id,
          admissionId,
          operation.amount,
        );
      this.database
        .prepare(
          `INSERT INTO counter_provider_values (counter_id, value) VALUES (?, ?)
           ON CONFLICT(counter_id) DO UPDATE SET value = value + excluded.value`,
        )
        .run('counter.default', operation.amount);
      return {
        admissionId,
        observationVersion,
        operationId: operation.operation_id,
        providerEpoch,
        result,
        terminal: 'completed',
      };
    });
  }

  public get attemptCount(): number {
    return this.count('counter_provider_attempts');
  }

  public get effectCount(): number {
    return this.count('counter_provider_effects');
  }

  public counterValue(counterId = 'counter.default'): number {
    const row = this.database
      .prepare('SELECT value FROM counter_provider_values WHERE counter_id = ?')
      .get(counterId) as { value: number } | undefined;
    return row?.value ?? 0;
  }

  public close(): void {
    this.database.close();
  }

  private latest(
    admissionId: string,
    providerEpoch: number,
  ):
    | {
        admission_id: string;
        amount: number;
        observation_version: number;
        operation_id: string;
        provider_epoch: number;
        result_json: string | null;
        terminal: CounterProviderObservation['terminal'];
      }
    | undefined {
    return this.database
      .prepare(
        `SELECT operation_id, admission_id, amount, provider_epoch, terminal, observation_version, result_json
         FROM counter_provider_operations
         WHERE admission_id = ? AND provider_epoch = ?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(admissionId, providerEpoch) as
      | {
          observation_version: number;
          admission_id: string;
          amount: number;
          operation_id: string;
          provider_epoch: number;
          result_json: string | null;
          terminal: CounterProviderObservation['terminal'];
        }
      | undefined;
  }

  private count(table: 'counter_provider_attempts' | 'counter_provider_effects'): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      const value = operation();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function observation(operation: {
  admission_id: string;
  amount: number;
  observation_version: number;
  operation_id: string;
  provider_epoch: number;
  result_json: string | null;
  terminal: CounterProviderObservation['terminal'];
}): CounterProviderObservation {
  return {
    admissionId: operation.admission_id,
    observationVersion: operation.observation_version,
    operationId: operation.operation_id,
    providerEpoch: operation.provider_epoch,
    ...(operation.result_json === null
      ? {}
      : { result: JSON.parse(operation.result_json) as JsonValue }),
    terminal: operation.terminal,
  };
}

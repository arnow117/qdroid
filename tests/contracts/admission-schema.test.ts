import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { PolicyAuthority } from '../../packages/policy/src/index.js';

test('nonempty legacy grant, task, and history rows survive a backed-up additive migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qdroid-policy-migration-'));
  const databasePath = join(directory, 'policy.sqlite');
  const legacy = new DatabaseSync(databasePath);

  try {
    legacy.exec(legacySchema());
    legacy
      .prepare(
        `INSERT INTO fixture_grants
       (grant_id, installation_id, subject_instance_id, capability, effect, generation, active)
       VALUES ('legacy-grant', 'legacy-installation', 'legacy-instance', 'sim.status.read/v1', 'allow', 1, 1)`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO admissions
         (admission_id, task_id, installation_id, instance_id, capability, request_digest,
          input_scope, policy_generation, grant_id, state, result_json)
         VALUES ('legacy-readonly-admission', 'legacy-readonly-task', 'legacy-installation',
          'legacy-instance', 'sim.status.read/v1', 'legacy-readonly-digest', 'sim.status.read/v1',
          1, 'legacy-grant', 'succeeded', '{"mode":"idle","source":"legacy"}')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO audit_records
         (audit_id, instance_id, grant_id, request_digest, admission_id, task_id, outcome)
         VALUES ('legacy-audit', 'legacy-instance', 'legacy-grant', 'legacy-readonly-digest',
          'legacy-readonly-admission', 'legacy-readonly-task', 'succeeded')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO counter_tasks
       (task_id, admission_id, installation_id, instance_id, idempotency_key, request_digest,
        counter_id, amount, provider_id, provider_epoch, profile_generation, policy_generation,
        state, state_version, cancel_requested, result_json, executor_session_id)
       VALUES ('legacy-task', 'legacy-admission', 'legacy-installation', 'legacy-instance',
        'legacy-key', 'legacy-digest', 'counter.default', 1, 'reference-counter', 1, 1, 1,
        'succeeded', 3, 0, '{"amount":1}', NULL)`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO counter_history (history_id, task_id, state_version, event, source)
         VALUES ('legacy-history', 'legacy-task', 3, 'provider-completed', 'legacy-provider')`,
      )
      .run();
    legacy.close();

    const policy = new PolicyAuthority(databasePath);
    policy.close();

    const backupPath = `${databasePath}.schema-0.backup.sqlite`;
    assert.equal(existsSync(backupPath), true);
    const backup = new DatabaseSync(backupPath);
    assert.deepEqual(
      normalizedRows(backup.prepare('SELECT grant_id, installation_id FROM fixture_grants').all()),
      [{ grant_id: 'legacy-grant', installation_id: 'legacy-installation' }],
    );
    assert.deepEqual(
      normalizedRows(
        backup.prepare('SELECT task_id, state, state_version FROM counter_tasks').all(),
      ),
      [{ state: 'succeeded', state_version: 3, task_id: 'legacy-task' }],
    );
    assert.deepEqual(
      normalizedRows(backup.prepare('SELECT history_id, event FROM counter_history').all()),
      [{ event: 'provider-completed', history_id: 'legacy-history' }],
    );
    assert.deepEqual(
      normalizedRows(
        backup
          .prepare(
            `SELECT admission_id, task_id, state, result_json
             FROM admissions WHERE admission_id = 'legacy-readonly-admission'`,
          )
          .all(),
      ),
      [
        {
          admission_id: 'legacy-readonly-admission',
          result_json: '{"mode":"idle","source":"legacy"}',
          state: 'succeeded',
          task_id: 'legacy-readonly-task',
        },
      ],
    );
    assert.deepEqual(
      normalizedRows(backup.prepare('SELECT audit_id, outcome FROM audit_records').all()),
      [{ audit_id: 'legacy-audit', outcome: 'succeeded' }],
    );
    backup.close();

    const migrated = new DatabaseSync(databasePath);
    const columns = migrated.prepare('PRAGMA table_info(counter_tasks)').all() as Array<{
      name: string;
    }>;
    assert.ok(columns.some((column) => column.name === 'bound_boot_id'));
    assert.ok(columns.some((column) => column.name === 'provider_observation_version'));
    assert.deepEqual(
      normalizedRows(
        migrated
          .prepare(
            `SELECT task_id, state, state_version, bound_boot_id, provider_observation_version
             FROM counter_tasks WHERE task_id = 'legacy-task'`,
          )
          .all(),
      ),
      [
        {
          bound_boot_id: '',
          provider_observation_version: -1,
          state: 'succeeded',
          state_version: 3,
          task_id: 'legacy-task',
        },
      ],
    );
    assert.deepEqual(
      normalizedRows(migrated.prepare('SELECT history_id, task_id FROM counter_history').all()),
      [{ history_id: 'legacy-history', task_id: 'legacy-task' }],
    );
    assert.deepEqual(
      normalizedRows(
        migrated
          .prepare(
            `SELECT admission_id, task_id, state, result_json
             FROM admissions WHERE admission_id = 'legacy-readonly-admission'`,
          )
          .all(),
      ),
      [
        {
          admission_id: 'legacy-readonly-admission',
          result_json: '{"mode":"idle","source":"legacy"}',
          state: 'succeeded',
          task_id: 'legacy-readonly-task',
        },
      ],
    );
    assert.deepEqual(
      normalizedRows(migrated.prepare('SELECT audit_id, outcome FROM audit_records').all()),
      [{ audit_id: 'legacy-audit', outcome: 'succeeded' }],
    );
    migrated.close();
  } finally {
    closeQuietly(legacy);
    rmSync(directory, { force: true, recursive: true });
  }
});

test('a failed migration rolls back its schema version and a corrected database reopens cleanly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qdroid-policy-migration-rollback-'));
  const databasePath = join(directory, 'policy.sqlite');
  const broken = new DatabaseSync(databasePath);

  try {
    broken.exec("CREATE VIEW counter_tasks AS SELECT 'not-a-table' AS task_id");
    broken.close();

    assert.throws(() => new PolicyAuthority(databasePath), /view/);
    const afterFailure = new DatabaseSync(databasePath);
    assert.equal(
      (afterFailure.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      0,
    );
    assert.equal(
      (
        afterFailure
          .prepare("SELECT type FROM sqlite_master WHERE name = 'counter_tasks'")
          .get() as { type: string }
      ).type,
      'view',
    );
    afterFailure.exec('DROP VIEW counter_tasks');
    afterFailure.close();

    const repaired = new PolicyAuthority(databasePath);
    repaired.close();
    const reopened = new DatabaseSync(databasePath);
    assert.equal(
      (reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      4,
    );
    reopened.close();
  } finally {
    closeQuietly(broken);
    rmSync(directory, { force: true, recursive: true });
  }
});

test('a newer policy schema version is rejected without changing the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qdroid-policy-future-'));
  const databasePath = join(directory, 'policy.sqlite');
  const database = new DatabaseSync(databasePath);

  try {
    database.exec('PRAGMA user_version = 99');
    database.close();
    assert.throws(() => new PolicyAuthority(databasePath), /newer unsupported schema version/);
    const unchanged = new DatabaseSync(databasePath);
    assert.equal(
      (unchanged.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      99,
    );
    unchanged.close();
  } finally {
    closeQuietly(database);
    rmSync(directory, { force: true, recursive: true });
  }
});

function legacySchema(): string {
  return `
    CREATE TABLE fixture_grants (
      grant_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      subject_instance_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      effect TEXT NOT NULL,
      generation INTEGER NOT NULL,
      active INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE admissions (
      admission_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      installation_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      input_scope TEXT NOT NULL,
      policy_generation INTEGER NOT NULL,
      grant_id TEXT,
      state TEXT NOT NULL,
      result_json TEXT
    ) STRICT;
    CREATE TABLE audit_records (
      audit_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      grant_id TEXT,
      request_digest TEXT NOT NULL,
      admission_id TEXT,
      task_id TEXT,
      outcome TEXT NOT NULL
    ) STRICT;
    CREATE TABLE counter_tasks (
      task_id TEXT PRIMARY KEY,
      admission_id TEXT NOT NULL UNIQUE,
      installation_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      counter_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      provider_epoch INTEGER NOT NULL,
      profile_generation INTEGER NOT NULL,
      policy_generation INTEGER NOT NULL,
      state TEXT NOT NULL,
      state_version INTEGER NOT NULL,
      cancel_requested INTEGER NOT NULL,
      cancel_reason TEXT,
      result_json TEXT,
      executor_session_id TEXT,
      UNIQUE (installation_id, instance_id, idempotency_key)
    ) STRICT;
    CREATE TABLE counter_history (
      history_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      state_version INTEGER NOT NULL,
      event TEXT NOT NULL,
      source TEXT NOT NULL
    ) STRICT;
  `;
}

function closeQuietly(database: DatabaseSync): void {
  try {
    database.close();
  } catch {
    // Test cleanup also handles databases that were already closed.
  }
}

function normalizedRows(rows: unknown[]): Array<Record<string, unknown>> {
  return rows.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>)));
}

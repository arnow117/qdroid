import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createTrustedFixtureDriver } from '../../fixtures/readonly-sim/src/driver.js';
import type { JsonValue, ReadonlyCapabilityProvider } from '../../packages/contracts/src/index.js';
import { PolicyAuthority } from '../../packages/policy/src/index.js';
import type { SupervisedChannel } from '../../packages/supervisor/src/index.js';

test('a trusted fixture grant permits the read-only simulator capability', () => {
  const fixture = createTrustedFixtureDriver({ grantMode: 'allow' });

  initialize(fixture.channel);

  const listed = fixture.channel.request({
    jsonrpc: '2.0',
    id: 'list',
    method: 'capabilities.list',
    params: {},
  });
  assert.deepEqual(listed, {
    jsonrpc: '2.0',
    id: 'list',
    result: {
      capabilities: [
        {
          capability: 'sim.status.read/v1',
          schemaVersion: 'qdroid.capability.sim.status.read/v1',
        },
      ],
    },
  });

  const response = invokeReadonlyCapability(fixture.channel);
  const invocationResult = responseResult(response);
  const task = recordValue(invocationResult.task);
  const simulatorResult = recordValue(invocationResult.result);

  assert.equal(fixture.simulator.operationCount, 1);
  assert.equal(simulatorResult.source, 'reference-simulator');
  assert.equal(task.state, 'succeeded');

  const taskResponse = fixture.channel.request({
    jsonrpc: '2.0',
    id: 'task',
    method: 'tasks.get',
    params: {
      taskId: task.taskId,
    },
  });
  const queriedTask = recordValue(responseResult(taskResponse).task);
  assert.equal(queriedTask.state, 'succeeded');
  assert.equal(recordValue(queriedTask.result).mode, 'idle');

  const audit = fixture.audit();
  assert.equal(audit.length, 2);
  assert.deepEqual(
    audit.map((record) => record.outcome),
    ['admitted', 'succeeded'],
  );
  assert.equal(audit[0]?.instanceId, audit[1]?.instanceId);
  assert.equal(audit[0]?.grantId, audit[1]?.grantId);
  assert.equal(audit[0]?.admissionId, audit[1]?.admissionId);
  assert.equal(audit[0]?.taskId, audit[1]?.taskId);
  assert.match(audit[0]?.requestDigest ?? '', /^[a-f0-9]{64}$/);

  const databasePath = fixture.databasePath;
  fixture.close();

  const reopenedPolicy = new PolicyAuthority(databasePath);
  assert.equal(reopenedPolicy.readSanitizedAudit().length, 2);
  reopenedPolicy.close();
});

test('missing and explicitly denied fixture grants reject before simulator execution', () => {
  for (const grantMode of ['none', 'deny'] as const) {
    const fixture = createTrustedFixtureDriver({ grantMode });
    initialize(fixture.channel);

    const response = invokeReadonlyCapability(fixture.channel);

    assert.equal(errorCode(response), 'QD_PERMISSION_DENIED');
    assert.equal(fixture.simulator.operationCount, 0);
    assert.equal(fixture.audit().at(-1)?.outcome, 'rejected');
    fixture.close();
  }
});

test('any active explicit deny takes precedence over an allow in either grant order', () => {
  for (const grantOrder of [
    ['allow', 'deny'],
    ['deny', 'allow'],
  ] as const) {
    const fixture = createTrustedFixtureDriver({ grantMode: 'none' });

    for (const grantMode of grantOrder) {
      fixture.applyTrustedGrant(grantMode);
    }

    initialize(fixture.channel);

    const listed = fixture.channel.request({
      jsonrpc: '2.0',
      id: `list-${grantOrder.join('-')}`,
      method: 'capabilities.list',
      params: {},
    });
    assert.deepEqual(responseResult(listed), { capabilities: [] });

    const response = invokeReadonlyCapability(fixture.channel);
    assert.equal(errorCode(response), 'QD_PERMISSION_DENIED');
    assert.equal(fixture.simulator.operationCount, 0);
    fixture.close();
  }
});

test('identity-like request fields cannot forge a grant or cross a supervisor channel binding', () => {
  const fixture = createTrustedFixtureDriver({ grantMode: 'allow' });
  initialize(fixture.channel);

  for (const forgedField of ['principal', 'grantId', 'ticket', 'instanceId']) {
    const response = fixture.channel.request({
      jsonrpc: '2.0',
      id: `forged-${forgedField}`,
      method: 'capabilities.invoke',
      params: {
        arguments: {},
        capability: 'sim.status.read/v1',
        [forgedField]: 'forged-value',
        schemaVersion: 'qdroid.capability.sim.status.read/v1',
      },
    });

    assert.equal(errorCode(response), 'QD_VALIDATION_FAILED');
    assert.equal(fixture.simulator.operationCount, 0);
  }

  const unprivilegedChannel = fixture.createUnprivilegedChannel();
  initialize(unprivilegedChannel);
  const crossInstanceResponse = invokeReadonlyCapability(unprivilegedChannel);

  assert.equal(errorCode(crossInstanceResponse), 'QD_PERMISSION_DENIED');
  assert.equal(fixture.simulator.operationCount, 0);
  fixture.close();
});

test('invalid schemas, incompatible versions, and unsupported required features have no side effects', () => {
  const fixture = createTrustedFixtureDriver({ grantMode: 'allow' });

  const incompatibleProtocol = fixture.channel.request({
    jsonrpc: '2.0',
    id: 'incompatible-protocol',
    method: 'runtime.initialize',
    params: {
      protocolVersion: 'qdroid.rpc/v9',
      requiredFeatures: [],
    },
  });
  assert.equal(errorCode(incompatibleProtocol), 'QD_INCOMPATIBLE_VERSION');

  const missingRequiredField = fixture.channel.request({
    jsonrpc: '2.0',
    id: 'missing-required-field',
    method: 'runtime.initialize',
    params: {
      protocolVersion: 'qdroid.rpc/v0.1',
    },
  });
  assert.equal(errorCode(missingRequiredField), 'QD_VALIDATION_FAILED');

  const unsupportedFeature = fixture.channel.request({
    jsonrpc: '2.0',
    id: 'unsupported-feature',
    method: 'runtime.initialize',
    params: {
      protocolVersion: 'qdroid.rpc/v0.1',
      requiredFeatures: ['requires-linux-sandbox'],
    },
  });
  assert.equal(errorCode(unsupportedFeature), 'QD_INCOMPATIBLE_VERSION');

  initialize(fixture.channel);

  const unsupportedSchema = fixture.channel.request({
    jsonrpc: '2.0',
    id: 'unsupported-schema',
    method: 'capabilities.invoke',
    params: {
      arguments: {},
      capability: 'sim.status.read/v1',
      schemaVersion: 'qdroid.capability.sim.status.read/v2',
    },
  });
  assert.equal(errorCode(unsupportedSchema), 'QD_UNSUPPORTED_CAPABILITY');

  const invalidArguments = fixture.channel.request({
    jsonrpc: '2.0',
    id: 'invalid-arguments',
    method: 'capabilities.invoke',
    params: {
      arguments: {
        unsupported: true,
      },
      capability: 'sim.status.read/v1',
      schemaVersion: 'qdroid.capability.sim.status.read/v1',
    },
  });
  assert.equal(errorCode(invalidArguments), 'QD_VALIDATION_FAILED');

  const unsupportedMethod = fixture.channel.request({
    jsonrpc: '2.0',
    id: 'unsupported-method',
    method: 'grant.create',
    params: {},
  });
  assert.equal(errorCode(unsupportedMethod), 'QD_UNSUPPORTED_CAPABILITY');
  assert.equal(fixture.simulator.operationCount, 0);
  fixture.close();
});

test('a provider failure after admission becomes a durable unknown outcome', () => {
  const provider = new FailingReadonlyProvider();
  const fixture = createTrustedFixtureDriver({
    grantMode: 'allow',
    provider,
  });
  initialize(fixture.channel);

  const response = invokeReadonlyCapability(fixture.channel);

  assert.equal(errorCode(response), 'QD_OUTCOME_UNKNOWN');
  assert.equal(errorRecovery(response), 'manual-reconcile');
  assert.equal(provider.calls, 1);
  assert.doesNotMatch(JSON.stringify(response), /simulated provider failure/);

  const taskId = errorTaskId(response);
  const task = fixture.channel.request({
    jsonrpc: '2.0',
    id: 'unknown-provider-task',
    method: 'tasks.get',
    params: { taskId },
  });
  assert.equal(recordValue(responseResult(task).task).state, 'unknown');
  assert.deepEqual(
    fixture.audit().map((record) => record.outcome),
    ['admitted', 'unknown'],
  );
  fixture.close();
});

test('a result-journal failure after a provider call becomes a durable unknown outcome', () => {
  const fixture = createTrustedFixtureDriver({ grantMode: 'allow' });
  const database = new DatabaseSync(fixture.databasePath);
  database.exec(`
    CREATE TRIGGER reject_successful_result_journal
    BEFORE UPDATE OF state ON admissions
    WHEN NEW.state = 'succeeded'
    BEGIN
      SELECT RAISE(ABORT, 'simulated result journal failure');
    END;
  `);
  initialize(fixture.channel);

  const response = invokeReadonlyCapability(fixture.channel);

  assert.equal(errorCode(response), 'QD_OUTCOME_UNKNOWN');
  assert.equal(errorRecovery(response), 'manual-reconcile');
  assert.equal(fixture.simulator.operationCount, 1);

  const taskId = errorTaskId(response);
  const task = fixture.channel.request({
    jsonrpc: '2.0',
    id: 'unknown-journal-task',
    method: 'tasks.get',
    params: { taskId },
  });
  assert.equal(recordValue(responseResult(task).task).state, 'unknown');
  assert.deepEqual(
    fixture.audit().map((record) => record.outcome),
    ['admitted', 'unknown'],
  );
  database.close();
  fixture.close();
});

test('an admission persistence failure rejects before provider execution', () => {
  const fixture = createTrustedFixtureDriver({ grantMode: 'allow' });
  const database = new DatabaseSync(fixture.databasePath);
  database.exec(`
    CREATE TRIGGER reject_admission_persistence
    BEFORE INSERT ON admissions
    BEGIN
      SELECT RAISE(ABORT, 'simulated admission persistence failure');
    END;
  `);
  initialize(fixture.channel);

  const response = invokeReadonlyCapability(fixture.channel);

  assert.equal(errorCode(response), 'QD_PROVIDER_UNAVAILABLE');
  assert.equal(errorRecovery(response), 'retry-safe');
  assert.equal(fixture.simulator.operationCount, 0);
  assert.doesNotMatch(JSON.stringify(response), /simulated admission persistence failure/);
  database.close();
  fixture.close();
});

function initialize(channel: SupervisedChannel): void {
  const response = channel.request({
    jsonrpc: '2.0',
    id: 'initialize',
    method: 'runtime.initialize',
    params: {
      protocolVersion: 'qdroid.rpc/v0.1',
      requiredFeatures: [],
    },
  });

  assert.ok('result' in response);
}

function invokeReadonlyCapability(channel: SupervisedChannel) {
  return channel.request({
    jsonrpc: '2.0',
    id: 'invoke',
    method: 'capabilities.invoke',
    params: {
      arguments: {},
      capability: 'sim.status.read/v1',
      schemaVersion: 'qdroid.capability.sim.status.read/v1',
    },
  });
}

function errorCode(response: ReturnType<SupervisedChannel['request']>): string | undefined {
  return 'error' in response ? response.error.data.code : undefined;
}

function errorRecovery(response: ReturnType<SupervisedChannel['request']>): string | undefined {
  return 'error' in response ? response.error.data.recovery : undefined;
}

function errorTaskId(response: ReturnType<SupervisedChannel['request']>): string {
  assert.ok('error' in response);
  const taskId = response.error.data.taskId;
  assert.equal(typeof taskId, 'string');

  if (taskId === undefined) {
    throw new Error('Expected an outcome-unknown task identifier.');
  }

  return taskId;
}

function responseResult(
  response: ReturnType<SupervisedChannel['request']>,
): Record<string, JsonValue> {
  assert.ok('result' in response);
  return recordValue(response.result);
}

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  assert.equal(typeof value, 'object');
  return value as Record<string, JsonValue>;
}

class FailingReadonlyProvider implements ReadonlyCapabilityProvider {
  public calls = 0;

  public readStatus(): never {
    this.calls += 1;
    throw new Error('simulated provider failure');
  }
}

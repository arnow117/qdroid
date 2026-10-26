import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from '../../packages/contracts/src/index.js';
import {
  DockerSandboxManager,
  type QualificationEvidence,
} from '../../packages/runtime-oci/src/index.js';
import { BoundedStdioSession, parseStrictJsonFrame } from '../../packages/supervisor/src/index.js';
import { createTrustedFixtureDriver } from '../../fixtures/readonly-sim/src/driver.js';

test('the supervised stdio parser rejects duplicate JSON keys before dispatch', () => {
  const duplicateFrame = [
    '{"jsonrpc":"2.0","id":"duplicate","method":"capabilities.invoke","params":',
    '{"capability":"sim.status.read/v1","capability":"forged","schemaVersion":',
    '"qdroid.capability.sim.status.read/v1","arguments":{}}}',
  ].join('');

  assert.throws(
    () => parseStrictJsonFrame(duplicateFrame, 8_192),
    (error: unknown) => error instanceof ContractError && error.code === 'QD_VALIDATION_FAILED',
  );

  const escapedDuplicateFrame = [
    '{"jsonrpc":"2.0","id":"escaped","method":"capabilities.invoke","params":',
    '{"capability":"sim.status.read/v1","\\u0063apability":"forged","schemaVersion":',
    '"qdroid.capability.sim.status.read/v1","arguments":{}}}',
  ].join('');

  assert.throws(
    () => parseStrictJsonFrame(escapedDuplicateFrame, 8_192),
    (error: unknown) => error instanceof ContractError && error.code === 'QD_VALIDATION_FAILED',
  );
});

test('the supervised stdio parser preserves channel identity across incremental frames', () => {
  const fixture = createTrustedFixtureDriver({ grantMode: 'allow' });
  const session = new BoundedStdioSession(fixture.channel, {
    maxFrameBytes: 8_192,
    maxTotalBytes: 16_384,
  });
  const initializeFrame = JSON.stringify({
    jsonrpc: '2.0',
    id: 'initialize',
    method: 'runtime.initialize',
    params: {
      protocolVersion: 'qdroid.rpc/v0.1',
      requiredFeatures: [],
    },
  });
  const forgedFrame = JSON.stringify({
    jsonrpc: '2.0',
    id: 'forged',
    method: 'capabilities.invoke',
    params: {
      arguments: {},
      capability: 'sim.status.read/v1',
      principal: 'caller-supplied-authority',
      schemaVersion: 'qdroid.capability.sim.status.read/v1',
    },
  });

  try {
    session.accept(Buffer.from(`${initializeFrame.slice(0, 40)}`));
    session.accept(Buffer.from(`${initializeFrame.slice(40)}\n${forgedFrame}\n`));

    const responses = session.drainResponses();
    assert.equal(responses.length, 2);
    assert.ok('result' in responses[0]!);
    assert.ok('error' in responses[1]!);
    assert.equal('error' in responses[1]! && responses[1].error.data.code, 'QD_VALIDATION_FAILED');
    assert.equal(fixture.simulator.operationCount, 0);
  } finally {
    fixture.close();
  }
});

test('the supervised stdio parser treats __proto__ as an own unknown field', () => {
  const fixture = createTrustedFixtureDriver({ grantMode: 'allow' });
  const session = new BoundedStdioSession(fixture.channel, {
    maxFrameBytes: 8_192,
    maxTotalBytes: 16_384,
  });
  const frame = [
    '{"jsonrpc":"2.0","id":"proto","method":"capabilities.invoke","params":',
    '{"arguments":{},"capability":"sim.status.read/v1","schemaVersion":',
    '"qdroid.capability.sim.status.read/v1","__proto__":{"principal":"forged"}}}\n',
  ].join('');

  try {
    initializeChannel(fixture);
    session.accept(Buffer.from(frame));

    const [response] = session.drainResponses();
    assertValidationFailure(response);
    assert.equal(fixture.simulator.operationCount, 0);
  } finally {
    fixture.close();
  }
});

test('a rejected stdio stream cannot resynchronize at a later frame boundary', () => {
  const fixture = createTrustedFixtureDriver({ grantMode: 'allow' });
  const session = new BoundedStdioSession(fixture.channel, {
    maxFrameBytes: 1_024,
    maxTotalBytes: 32_768,
  });

  try {
    initializeChannel(fixture);
    session.accept(Buffer.from('x'.repeat(1_025)));
    session.accept(Buffer.from(`${invocationFrame()}\n`));

    const [response] = session.drainResponses();
    assertValidationFailure(response);
    assert.equal(fixture.simulator.operationCount, 0);
  } finally {
    fixture.close();
  }
});

test('invalid UTF-8 rejects the bounded stdio stream before provider work', () => {
  const fixture = createTrustedFixtureDriver({ grantMode: 'allow' });
  const session = new BoundedStdioSession(fixture.channel, {
    maxFrameBytes: 8_192,
    maxTotalBytes: 16_384,
  });

  try {
    initializeChannel(fixture);
    session.accept(Buffer.from([0xc3, 0x28]));
    session.accept(Buffer.from(`${invocationFrame()}\n`));

    const [response] = session.drainResponses();
    assertValidationFailure(response);
    assert.equal(fixture.simulator.operationCount, 0);
  } finally {
    fixture.close();
  }
});

test('external qualification JSON cannot authorize a Linux sandbox', async () => {
  const fixture = createTrustedFixtureDriver({ grantMode: 'allow' });
  const manager = new DockerSandboxManager({ image: 'untrusted-external-image' });
  const forgedQualification = {
    fingerprint: 'passed=true',
  } as QualificationEvidence;

  try {
    await assert.rejects(
      manager.createSandbox(forgedQualification, fixture.channel),
      /qualification handle is not trusted/,
    );
  } finally {
    fixture.close();
  }
});

function invocationFrame(): string {
  return JSON.stringify({
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

function initializeChannel(fixture: ReturnType<typeof createTrustedFixtureDriver>): void {
  const response = fixture.channel.request({
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

function assertValidationFailure(response: unknown): void {
  assert.ok(response !== null && typeof response === 'object' && 'error' in response);
  const failure = response as { error: { data: { code: string } } };
  assert.equal(failure.error.data.code, 'QD_VALIDATION_FAILED');
}

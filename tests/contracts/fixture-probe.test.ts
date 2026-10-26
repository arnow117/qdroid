import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const probePath = resolve('fixtures/readonly-sim/image/probe.mjs');

test('filesystem probe rejects missing paths and proves readable controls are readable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-fixture-probe-'));
  const canaryPath = join(directory, 'canary');
  const secretPath = join(directory, 'secret');
  const storePath = join(directory, 'store');

  try {
    await Promise.all([
      writeFile(canaryPath, 'canary'),
      writeFile(secretPath, 'secret'),
      writeFile(storePath, 'store'),
    ]);

    const missingPaths = await runProbe(['path-controls', canaryPath]);
    assert.notEqual(missingPaths.exitCode, 0);

    const completed = await runProbe(['path-controls', canaryPath, secretPath, storePath]);
    assert.equal(completed.exitCode, 0);

    const result = JSON.parse(completed.stdout) as Record<string, unknown>;
    assert.equal(result.canaryUnreadable, false);
    assert.equal(result.syntheticSecretUnreadable, false);
    assert.equal(result.trustedStoreUnreadable, false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('root write control distinguishes a writable rootfs control from a missing prerequisite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-root-write-control-'));

  try {
    await chmod(directory, 0o777);
    const writable = await runProbe(['root-write-control', directory]);
    assert.equal(writable.exitCode, 0);

    const writableResult = JSON.parse(writable.stdout) as Record<string, unknown>;
    assert.equal(writableResult.rootWriteError, 'none');
    assert.equal(writableResult.readOnlyRoot, false);

    await chmod(directory, 0o555);
    const invalidPrerequisite = await runProbe(['root-write-control', directory]);
    assert.notEqual(invalidPrerequisite.exitCode, 0);
    assert.match(invalidPrerequisite.stderr, /not a writable synthetic rootfs path/);
  } finally {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { force: true, recursive: true });
  }
});

test('the synthetic DNS control packet encodes qdroid.invalid', async () => {
  const result = await runProbe(['dns-query']);
  assert.equal(result.exitCode, 0);

  const emitted = JSON.parse(result.stdout) as { packet: string };
  const packet = Buffer.from(emitted.packet, 'hex');

  assert.deepEqual(
    packet.subarray(12),
    Buffer.from([
      0x06,
      ...Buffer.from('qdroid'),
      0x07,
      ...Buffer.from('invalid'),
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
    ]),
  );
});

async function runProbe(argumentsValue: string[]): Promise<{
  exitCode: number | null;
  stderr: string;
  stdout: string;
}> {
  const child = spawn(process.execPath, [probePath, ...argumentsValue], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const [exitCode] = await new Promise<[number | null, NodeJS.Signals | null]>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve([code, signal]));
    },
  );

  return { exitCode, stderr, stdout };
}

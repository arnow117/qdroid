import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import test from 'node:test';

interface IoHandshakeModule {
  releaseIoInput(input: NodeJS.ReadableStream): void;
  waitForIoStart(input: NodeJS.ReadableStream): Promise<void>;
}

const moduleUrl = pathToFileURL(resolve('fixtures/readonly-sim/image/io-handshake.mjs')).href;

async function loadHandshake(): Promise<IoHandshakeModule> {
  return (await import(moduleUrl)) as IoHandshakeModule;
}

test('the I/O handshake settles successfully after a legal read command', async () => {
  const input = new PassThrough();
  const handshake = await loadHandshake();
  const started = handshake.waitForIoStart(input);

  input.end('read\n');

  await started;
});

test('the I/O handshake rejects EOF and invalid commands without losing either event', async () => {
  const handshake = await loadHandshake();
  const eofInput = new PassThrough();
  const invalidInput = new PassThrough();
  const eof = handshake.waitForIoStart(eofInput);
  const invalid = handshake.waitForIoStart(invalidInput);

  eofInput.end();
  invalidInput.end('stop\n');

  await assert.rejects(eof, /did not receive a read command/);
  await assert.rejects(invalid, /invalid command/);
});

test('the I/O probe lifecycle closes a writable command pipe after one read', async () => {
  const result = await runIoLifecycleFixture('read');

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
});

test('the I/O probe lifecycle rejects an invalid command without waiting for pipe EOF', async () => {
  const result = await runIoLifecycleFixture('stop');

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /invalid command/);
});

async function runIoLifecycleFixture(command: string): Promise<{
  exitCode: number | null;
  stderr: string;
}> {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'qdroid-io-lifecycle-'));
  const fixturePath = join(fixtureDirectory, 'lifecycle.mjs');
  const fixtureSource = `
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { releaseIoInput, waitForIoStart } from '${moduleUrl}';

try {
  await waitForIoStart(process.stdin);
} finally {
  releaseIoInput(process.stdin);
}

const reader = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
await once(reader, 'close');
`;
  await writeFile(fixturePath, fixtureSource);
  const child = spawn(process.execPath, [fixturePath], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  try {
    child.stdin.write(`${command}\n`);
    const [exitCode] = (await once(child, 'close')) as [number | null];

    return { exitCode, stderr };
  } finally {
    child.kill('SIGKILL');
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
}

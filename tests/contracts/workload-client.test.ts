import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const workloadClientPath = resolve('fixtures/readonly-sim/image/workload-client.mjs');

test('the normal workload receives responses and exits after closing its input', async () => {
  const child = spawn(process.execPath, [workloadClientPath, 'allow'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const requests: Array<{ id?: string }> = [];
  let stderr = '';
  let stdoutBuffer = '';

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');

    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');

      if (newline === -1) {
        break;
      }

      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      const request = JSON.parse(line) as { id?: string };
      requests.push(request);
      child.stdin.write(`${JSON.stringify({ id: request.id, jsonrpc: '2.0', result: {} })}\n`);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  try {
    const exitCode = await exitsWithin(child, 1_000);
    assert.equal(exitCode, 0);
    assert.deepEqual(
      requests.map((request) => request.id),
      ['initialize', 'invoke'],
    );
    assert.match(stderr, /response-received=initialize/);
    assert.match(stderr, /response-received=invoke/);
    assert.match(stderr, /final-response-confirmed=invoke/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('the workload rejects a final response that does not match its invocation', async () => {
  const child = spawn(process.execPath, [workloadClientPath, 'allow'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let requestCount = 0;
  let stderr = '';
  let stdoutBuffer = '';

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');

    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');

      if (newline === -1) {
        break;
      }

      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      const request = JSON.parse(line) as { id?: string };
      requestCount += 1;
      const responseId = requestCount === 1 ? request.id : 'other-request';
      child.stdin.write(`${JSON.stringify({ id: responseId, jsonrpc: '2.0', result: {} })}\n`);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  try {
    const exitCode = await exitsWithin(child, 1_000);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /did not match request invoke/);
    assert.doesNotMatch(stderr, /final-response-confirmed=invoke/);
  } finally {
    child.kill('SIGKILL');
  }
});

async function exitsWithin(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number | null> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode) => resolve(exitCode));
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('The workload did not exit after receiving its responses.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

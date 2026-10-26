import { spawn } from 'node:child_process';
import readline from 'node:readline';

const [mode = 'allow'] = process.argv.slice(2);
const input = readline.createInterface({
  crlfDelay: Infinity,
  input: process.stdin,
});
const responses = [];

input.on('line', (line) => {
  responses.push(line);
});

if (mode === 'spam-output') {
  process.stdout.write('x'.repeat(70_000));
} else if (mode === 'hold-child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000);'], {
    stdio: 'ignore',
  });
  process.stderr.write(`child=${child.pid}\n`);
  setInterval(() => {}, 1_000);
} else {
  const admissionMode = mode.startsWith('admission-');
  await request({
    jsonrpc: '2.0',
    id: 'initialize',
    method: 'runtime.initialize',
    params: {
      protocolVersion: 'qdroid.rpc/v0.1',
      requiredFeatures: admissionMode ? ['qdroid.admission/v1'] : [],
    },
  });

  if (admissionMode) {
    const params = {
      arguments: { amount: 1, counterId: 'counter.default' },
      capability: 'sim.counter.add/v1',
      idempotencyKey: `linux-${mode}`,
      schemaVersion: 'qdroid.capability.sim.counter.add/v1',
    };

    if (mode === 'admission-forged-authority') {
      params.principal = 'caller-supplied-authority';
    }

    const invocation = await request(
      {
        jsonrpc: '2.0',
        id: 'invoke',
        method: 'capabilities.invoke',
        params,
      },
      mode !== 'admission-cancel-first',
    );

    if (mode === 'admission-cancel-first') {
      const taskId = invocation?.result?.task?.taskId;
      if (typeof taskId !== 'string') {
        throw new Error('The admission invocation did not return a task handle for cancellation.');
      }
      await request({
        jsonrpc: '2.0',
        id: 'cancel',
        method: 'tasks.cancel',
        params: { reason: 'sandbox cancellation fixture', taskId },
      });
    }
  } else if (mode === 'duplicate-key') {
    process.stdout.write(
      '{"jsonrpc":"2.0","id":"duplicate","method":"capabilities.invoke","params":' +
        '{"capability":"sim.status.read/v1","capability":"forged","schemaVersion":' +
        '"qdroid.capability.sim.status.read/v1","arguments":{}}}\n',
    );
    confirmDuplicateKeyResponse(await nextResponse());
    confirmFinalResponse('duplicate-key');
  } else if (mode === 'unsupported-method') {
    await request({
      jsonrpc: '2.0',
      id: 'unsupported',
      method: 'grant.create',
      params: {},
    });
  } else {
    const params = {
      arguments: {},
      capability: 'sim.status.read/v1',
      schemaVersion: 'qdroid.capability.sim.status.read/v1',
    };

    if (mode === 'forged-authority') {
      params.principal = 'caller-supplied-authority';
    }

    await request({
      jsonrpc: '2.0',
      id: 'invoke',
      method: 'capabilities.invoke',
      params,
    });
  }
}

async function request(message, isFinal = true) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
  const response = await nextResponse();
  assertResponseMatchesRequest(message.id, response);
  process.stderr.write(`response-received=${message.id}\n`);

  if (message.id !== 'initialize' && isFinal) {
    confirmFinalResponse(message.id);
  }

  return response;
}

async function nextResponse() {
  while (responses.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const response = responses.shift();

  try {
    return JSON.parse(response);
  } catch {
    throw new Error('The supervisor response was not valid JSON.');
  }
}

function assertResponseMatchesRequest(expectedId, response) {
  if (
    response === null ||
    typeof response !== 'object' ||
    response.jsonrpc !== '2.0' ||
    response.id !== expectedId ||
    (!Object.hasOwn(response, 'result') && !Object.hasOwn(response, 'error'))
  ) {
    throw new Error(`The supervisor response did not match request ${expectedId}.`);
  }
}

function confirmDuplicateKeyResponse(response) {
  if (
    response === null ||
    typeof response !== 'object' ||
    response.jsonrpc !== '2.0' ||
    response.id !== null ||
    response.error?.data?.code !== 'QD_VALIDATION_FAILED'
  ) {
    throw new Error('The supervisor response did not report the duplicate-key validation failure.');
  }
}

function confirmFinalResponse(requestId) {
  process.stderr.write(`final-response-confirmed=${requestId}\n`);
}

if (mode !== 'spam-output' && mode !== 'hold-child') {
  input.close();
}

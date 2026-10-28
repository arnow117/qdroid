import { existsSync } from 'node:fs';

const releasePath = process.env.QDROID_T004_CLOSED_GUARDIAN_RELEASE;

if (releasePath === undefined || releasePath === '') {
  throw new Error('The closed guardian fixture requires a trusted release path.');
}

let closed = false;

process.on('message', (message: unknown) => {
  if (message === null || typeof message !== 'object') {
    return;
  }

  const record = message as { type?: unknown };
  if (record.type !== 'stop' || closed) {
    return;
  }

  closed = true;
  process.send?.({
    completion: {
      cleanupConfirmed: true,
      exitCode: 0,
      reason: 'stopped',
      stderrBytes: 0,
      stderrDeliveredBytes: 0,
      stdoutBytes: 0,
      stdoutDeliveredBytes: 0,
    },
    type: 'closed',
  });
});

const releaseTimer = setInterval(() => {
  if (existsSync(releasePath)) {
    clearInterval(releaseTimer);
    process.exit(0);
  }
}, 25);

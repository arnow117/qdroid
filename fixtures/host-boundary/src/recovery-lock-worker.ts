import { access } from 'node:fs/promises';

import { OciSandboxBackend } from '../../../packages/runtime-oci/src/backend.js';

async function main(): Promise<void> {
  const [image, ownerStorePath, mode, releasePath] = process.argv.slice(2);
  if (image === undefined || ownerStorePath === undefined) {
    throw new Error('The recovery-lock worker requires an image and private owner store path.');
  }

  const backend = new OciSandboxBackend({
    image,
    ownerStorePath,
    trustedTestHooks: {
      ...(mode === 'after-journal-retired'
        ? {
            afterExecutionJournalRetired: async ({ sessionId }) => {
              process.stdout.write(`journal-retired:${sessionId}\n`);
              await new Promise<void>(() => undefined);
            },
          }
        : {}),
      ...(mode === 'after-network-writer-registration'
        ? {
            afterNetworkFixtureRecoveryWriterRename: async ({ sessionId }) => {
              if (releasePath === undefined) {
                throw new Error('The network recovery writer requires a release path.');
              }
              process.stdout.write(`network-writer-registered:${sessionId}\n`);
              await waitForRelease(releasePath);
            },
          }
        : {}),
    },
  });
  await backend.recoverAbandoned();
  process.stdout.write('recovery-complete\n');
}

async function waitForRelease(path: string): Promise<void> {
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

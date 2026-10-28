import { existsSync } from 'node:fs';

import { OciSandboxBackend } from '../../../packages/runtime-oci/src/backend.js';

type MutationMode = 'retire-journal' | 'writer-registration';

async function main(): Promise<void> {
  const [image, ownerStorePath, modeValue, releasePath, convergencePath] = process.argv.slice(2);
  if (
    image === undefined ||
    ownerStorePath === undefined ||
    releasePath === undefined ||
    (modeValue !== 'retire-journal' && modeValue !== 'writer-registration')
  ) {
    throw new Error(
      'The delayed recovery worker requires an image, owner store, mutation mode, and release path.',
    );
  }

  const mode: MutationMode = modeValue;
  let resolveMutationSettled: () => void = () => undefined;
  const mutationSettled = new Promise<void>((resolve) => {
    resolveMutationSettled = resolve;
  });
  let resolveIdleWriterExit: (() => void) | undefined;
  const idleWriterExit = new Promise<void>((resolve) => {
    resolveIdleWriterExit = resolve;
  });
  const waitForRelease = async (): Promise<void> => {
    process.stdout.write('mutation-started\n');
    while (!existsSync(releasePath)) {
      await delay(25);
    }
    resolveMutationSettled();
  };
  const waitForConvergence = async (): Promise<void> => {
    if (convergencePath === undefined) {
      return;
    }
    while (!existsSync(convergencePath)) {
      await delay(25);
    }
  };

  const backend = new OciSandboxBackend({
    image,
    ownerStorePath,
    trustedTestHooks: {
      ...(mode === 'retire-journal'
        ? { afterExecutionJournalUnlinkBeforeDirectorySync: waitForRelease }
        : {}),
      ...(mode === 'writer-registration' ? { beforeRecoveryWriterPersist: waitForRelease } : {}),
      ...(mode === 'writer-registration'
        ? {
            guardianWorkerPath: () =>
              new URL('./stalled-cleanup-guardian.js', import.meta.url).pathname,
            afterIdleRecoveryWriterExit: async ({ exited }: { exited: boolean }) => {
              if (!exited) {
                throw new Error(
                  'The idle recovery writer did not exit after its late registration.',
                );
              }
              resolveIdleWriterExit?.();
            },
          }
        : {}),
    },
  });

  const report = await backend.recoverAbandoned();
  process.stdout.write(`recovery-report:${JSON.stringify(report)}\n`);
  process.stdout.write('recovery-returned\n');
  await mutationSettled;
  if (mode === 'writer-registration') {
    await idleWriterExit;
  }
  // Let the recovery lease observe the settled mutation and close its SQLite
  // transaction before the fixture process exits.
  await delay(50);
  await new Promise<void>((resolve) => {
    process.stdout.write('mutation-settled\n', () => {
      resolve();
    });
  });
  if (mode === 'retire-journal') {
    await waitForConvergence();
    const convergence = await backend.recoverAbandoned();
    process.stdout.write(`late-retirement-convergence:${JSON.stringify(convergence)}\n`);
  }
  process.exit(0);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

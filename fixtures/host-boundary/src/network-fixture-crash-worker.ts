import { OciSandboxBackend } from '../../../packages/runtime-oci/src/backend.js';

interface NetworkFixtureBarrier {
  controllerPgid: number;
  controllerPid: number;
  interfaceName: string;
  marker: string;
  sessionId: string;
}

async function main(): Promise<void> {
  const [image, ownerStorePath] = process.argv.slice(2);
  if (image === undefined || ownerStorePath === undefined) {
    throw new Error(
      'The network fixture crash worker requires an image and a private owner store.',
    );
  }

  const neverReleaseBarrier = new Promise<void>(() => undefined);
  const keepAlive = setInterval(() => undefined, 1_000);
  const backend = new OciSandboxBackend({
    image,
    ownerStorePath,
    trustedTestHooks: {
      afterNetworkFixtureCreated: async (details) => {
        const barrier: NetworkFixtureBarrier = {
          controllerPgid: details.controllerPgid,
          controllerPid: details.controllerPid,
          interfaceName: details.interfaceName,
          marker: details.marker,
          sessionId: details.sessionId,
        };
        process.stdout.write(`${JSON.stringify({ barrier })}\n`);
        await neverReleaseBarrier;
      },
    },
  });

  try {
    await backend.qualify('tool-offline');
    throw new Error('The network fixture crash worker passed its trusted crash barrier.');
  } finally {
    clearInterval(keepAlive);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

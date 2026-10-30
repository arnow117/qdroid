import { createHash } from 'node:crypto';

import {
  PackageInstaller,
  type PackageSource,
} from '../../../packages/package-runtime/src/index.js';

const installerRoot = requiredEnvironment('QDROID_PUBLICATION_CRASH_ROOT');
const sourceId = requiredEnvironment('QDROID_PUBLICATION_CRASH_SOURCE_ID');
const bundle = Buffer.from(requiredEnvironment('QDROID_PUBLICATION_CRASH_BUNDLE'), 'base64');
const pauseMode = process.env.QDROID_PUBLICATION_CRASH_PAUSE_MODE ?? 'crash';
if (pauseMode !== 'crash' && pauseMode !== 'release') {
  throw new Error('The publication crash fixture pause mode is unsupported.');
}
const source: PackageSource = {
  expectedSha256: createHash('sha256').update(bundle).digest('hex'),
  id: sourceId,
  maxBytes: bundle.byteLength,
  read: async () => Buffer.from(bundle),
};

const installer = new PackageInstaller({
  installerRoot,
  ownerId: 'operator-example',
  publicationTestHooks: {
    afterContentRename: async () => {
      if (pauseMode === 'release') {
        process.stdout.write('renamed\n');
        await waitForParentChannelClose();
        return;
      }

      // A bare unresolved Promise does not keep Node's event loop alive. Keep
      // one real handle while paused, but release it when the parent channel
      // closes so an orphaned fixture cannot retain the authority forever.
      const keepAlive = setInterval(() => undefined, 1_000);
      process.stdout.write('renamed\n');
      try {
        await waitForParentChannelClose();
      } finally {
        clearInterval(keepAlive);
      }
      throw new Error('The publication crash fixture lost its parent channel before SIGKILL.');
    },
  },
  runtimeCatalog: new Map(),
  sources: new Map([[source.id, source]]),
  supportedEngineVersion: '0.1.0',
});

try {
  await installer.install({ sourceId: source.id, target: 'content-only' });
  if (pauseMode === 'crash') {
    process.stderr.write('The crash publisher unexpectedly completed.\n');
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required publication crash fixture environment: ${name}`);
  }
  return value;
}

async function waitForParentChannelClose(): Promise<void> {
  process.stdin.resume();
  await new Promise<void>((resolve, reject) => {
    process.stdin.once('close', resolve);
    process.stdin.once('end', resolve);
    process.stdin.once('error', reject);
  });
}

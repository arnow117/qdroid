import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;

export interface PreparedReferenceNodeState {
  readonly installerRoot: string;
  readonly ownerStorePath: string;
  readonly root: string;
}

/**
 * A direct fixture-test seam for filesystem synchronization failures. It is not
 * available through the CLI or package input.
 */
export interface ReferenceNodeDirectorySynchronizer {
  open(path: string): Promise<ReferenceNodeDirectoryHandle>;
}

export interface ReferenceNodeDirectoryHandle {
  close(): Promise<void>;
  stat(): Promise<Stats>;
  sync(): Promise<void>;
}

export interface PrepareReferenceNodeStateOptions {
  readonly directorySynchronizer?: ReferenceNodeDirectorySynchronizer;
}

const nativeDirectorySynchronizer: ReferenceNodeDirectorySynchronizer = Object.freeze({
  open: async (path: string) =>
    open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW),
});

/**
 * Creates or verifies all code-owned reference-node state directories before
 * PackageInstaller or the OCI runtime receives their paths. Existing entries
 * must already be private, user-owned directories; this function never repairs
 * or replaces them.
 */
export async function preparePrivateReferenceNodeState(
  root: string,
  expectedUid: number,
  options: PrepareReferenceNodeStateOptions = {},
): Promise<PreparedReferenceNodeState> {
  const installerRoot = join(root, 'installer');
  const ownerStorePath = join(root, 'owner-store');
  const synchronizer = options.directorySynchronizer ?? nativeDirectorySynchronizer;

  const rootState = await inspectPrivateDirectory(root, expectedUid, 'reference-node root');
  if (rootState === 'missing') {
    await createPrivateDirectory(root, expectedUid, 'reference-node root');
  }

  // Validate all preexisting child entries before creating either child. A
  // refusal therefore does not write the other state subtree.
  const [installerState, ownerStoreState] = await Promise.all([
    inspectPrivateDirectory(installerRoot, expectedUid, 'installer root'),
    inspectPrivateDirectory(ownerStorePath, expectedUid, 'owner-store root'),
  ]);
  if (installerState === 'missing') {
    await createPrivateDirectory(installerRoot, expectedUid, 'installer root');
  }
  if (ownerStoreState === 'missing') {
    await createPrivateDirectory(ownerStorePath, expectedUid, 'owner-store root');
  }

  const synchronizationFailures: unknown[] = [];
  await collectFailure(synchronizationFailures, () =>
    synchronizePrivateDirectoryAndParent(root, expectedUid, 'reference-node root', synchronizer),
  );
  await collectFailure(synchronizationFailures, () =>
    synchronizePrivateDirectoryAndParent(
      installerRoot,
      expectedUid,
      'installer root',
      synchronizer,
    ),
  );
  await collectFailure(synchronizationFailures, () =>
    synchronizePrivateDirectoryAndParent(
      ownerStorePath,
      expectedUid,
      'owner-store root',
      synchronizer,
    ),
  );
  throwCollectedFailures(
    synchronizationFailures,
    'The reference-node state directories could not be synchronized before use.',
  );

  return Object.freeze({ installerRoot, ownerStorePath, root });
}

async function inspectPrivateDirectory(
  path: string,
  expectedUid: number,
  label: string,
): Promise<'missing' | 'present'> {
  try {
    const status = await lstat(path);
    assertPrivateDirectory(status, expectedUid, label);
    return 'present';
  } catch (error) {
    if (isNotFoundError(error)) {
      return 'missing';
    }
    throw error;
  }
}

async function createPrivateDirectory(
  path: string,
  expectedUid: number,
  label: string,
): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }

  const status = await lstat(path);
  assertPrivateDirectory(status, expectedUid, label);
}

async function synchronizePrivateDirectoryAndParent(
  path: string,
  expectedUid: number,
  label: string,
  synchronizer: ReferenceNodeDirectorySynchronizer,
): Promise<void> {
  const failures: unknown[] = [];
  await collectFailure(failures, () =>
    synchronizePrivateDirectory(path, expectedUid, label, synchronizer),
  );
  await collectFailure(failures, () => synchronizeDirectory(dirname(path), synchronizer));
  throwCollectedFailures(
    failures,
    `The ${label} and its parent could not be synchronized before use.`,
  );
}

async function synchronizePrivateDirectory(
  path: string,
  expectedUid: number,
  label: string,
  synchronizer: ReferenceNodeDirectorySynchronizer,
): Promise<void> {
  const handle = await synchronizer.open(path);
  const failures: unknown[] = [];
  let validated = false;

  await collectFailure(failures, async () => {
    const status = await handle.stat();
    assertPrivateDirectory(status, expectedUid, label);
    validated = true;
  });
  if (validated) {
    await collectFailure(failures, () => handle.sync());
  }
  await collectFailure(failures, () => handle.close());

  throwCollectedFailures(failures, `The ${label} could not be synchronized before use.`);
}

async function synchronizeDirectory(
  path: string,
  synchronizer: ReferenceNodeDirectorySynchronizer,
): Promise<void> {
  const handle = await synchronizer.open(path);
  const failures: unknown[] = [];
  await collectFailure(failures, () => handle.sync());
  await collectFailure(failures, () => handle.close());
  throwCollectedFailures(failures, 'A reference-node parent directory could not be synchronized.');
}

async function collectFailure(failures: unknown[], operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}

function throwCollectedFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 0) {
    return;
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  throw new AggregateError(failures, message);
}

function assertPrivateDirectory(status: Stats, expectedUid: number, label: string): void {
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`The ${label} is not a directory.`);
  }
  if (status.uid !== expectedUid) {
    throw new Error(`The ${label} is not owned by the trusted user.`);
  }
  if ((status.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error(`The ${label} does not have the required private mode.`);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

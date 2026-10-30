import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { readTrustedLinuxBootId } from '../../supervisor/src/index.js';
import type {
  BuildSessionOperation,
  BuildSessionOwner,
  BuildSessionOwnerIdentity,
  BuildSessionRecovery,
  BuildSessionRecoveryResult,
  SessionBoundRuntime,
  TrustedBuildExecutor,
  TrustedImageAssembler,
  TrustedRuntimeFactory,
} from '../../package-runtime/src/index.js';
import {
  assertActiveBuildSessionOwner,
  beginBuildSessionRuntimeInitialization,
  isVerifiedBuildSessionOwner,
  readBuildSessionRecovery,
} from '../../package-runtime/src/index.js';

import { OciOfflineBuildExecutor } from './build-executor.js';
import { ManagedImageAssembler } from './assembler.js';
import {
  ManagedRuntimeResourceOps,
  type ManagedRuntimeResourceOpsOptions,
  type RuntimeResourceOps,
} from './resource-ops.js';

interface CloseableRuntimeResourceOps extends RuntimeResourceOps {
  close(): Promise<void>;
}

interface RuntimeInitialization {
  readonly operation: BuildSessionOperation;
  readonly settled: Promise<void>;
  finish(): void;
  resources?: CloseableRuntimeResourceOps;
}

export interface SessionRuntimeComponents {
  readonly buildExecutor: TrustedBuildExecutor;
  readonly imageAssembler: TrustedImageAssembler;
}

export interface OciSessionBoundRuntimeFactoryOptions {
  /** The configured T004 owner store, never derived from a package. */
  readonly ownerStorePath: string;
  /**
   * Image assembly is supplied by the trusted OCI integration. It receives
   * the same session-bound resource owner as the T004 build backend.
   */
  readonly createImageAssembler?: (
    resources: RuntimeResourceOps,
    owner: BuildSessionOwner,
  ) => TrustedImageAssembler;
  /** Test seam for closed resource ownership; production uses the durable owner. */
  readonly createResources?: (
    options: ManagedRuntimeResourceOpsOptions,
  ) => Promise<CloseableRuntimeResourceOps>;
  /** Test seam for the T004 executor constructor. */
  readonly createBuildExecutor?: (
    resources: RuntimeResourceOps,
    owner: BuildSessionOwner,
  ) => TrustedBuildExecutor;
  /** Test seam for the trusted host boot reading routine. */
  readonly readBootId?: () => Promise<string>;
}

/**
 * Creates exactly one runtime adapter for one host-created BuildSession. The
 * package runtime invokes this only while its BuildAuthority transaction and
 * durable session record are live. No package-controlled value selects a
 * resource store, backend, or command transport.
 */
export class OciSessionBoundRuntimeFactory implements TrustedRuntimeFactory {
  private readonly createResources: NonNullable<
    OciSessionBoundRuntimeFactoryOptions['createResources']
  >;
  private readonly createBuildExecutor: NonNullable<
    OciSessionBoundRuntimeFactoryOptions['createBuildExecutor']
  >;
  private readonly createImageAssembler: NonNullable<
    OciSessionBoundRuntimeFactoryOptions['createImageAssembler']
  >;
  private readonly readBootId: () => Promise<string>;
  private readonly usesProductionResources: boolean;
  /**
   * This map retains handles only so a failed caller can settle effects that
   * were already created. Admission itself is enforced by the BuildSession
   * registry, shared by all factory instances.
   */
  private readonly initializations = new WeakMap<BuildSessionOwner, RuntimeInitialization>();

  public constructor(private readonly options: OciSessionBoundRuntimeFactoryOptions) {
    this.createResources = options.createResources ?? ManagedRuntimeResourceOps.create;
    this.createBuildExecutor =
      options.createBuildExecutor ??
      ((resources) =>
        new OciOfflineBuildExecutor({
          ownerStorePath: options.ownerStorePath,
          resources,
        }));
    this.createImageAssembler =
      options.createImageAssembler ??
      ((resources, owner) => new ManagedImageAssembler({ owner, resources }));
    this.readBootId = options.readBootId ?? readTrustedLinuxBootId;
    this.usesProductionResources = options.createResources === undefined;
  }

  public async captureOwnerIdentity(): Promise<BuildSessionOwnerIdentity> {
    if (!this.usesProductionResources || this.options.readBootId !== undefined) {
      return Object.freeze({ kind: 'synthetic-unverified' });
    }
    if (process.platform !== 'linux') {
      throw new Error('The production OCI runtime requires a trusted Linux installer identity.');
    }
    const [bootId, processStart] = await Promise.all([
      this.readBootId(),
      readLinuxProcessStart(process.pid),
    ]);
    return Object.freeze({
      bootId,
      kind: 'linux-verified',
      pid: process.pid,
      processStart,
    });
  }

  public async recoverSession(recovery: BuildSessionRecovery): Promise<BuildSessionRecoveryResult> {
    const details = readBuildSessionRecovery(recovery);
    if (details.identity.kind !== 'linux-verified' || process.platform !== 'linux') {
      return Object.freeze({ status: 'unknown' });
    }
    const currentBootId = await this.readBootId();
    if (currentBootId !== details.identity.bootId) {
      return Object.freeze({ status: 'unknown' });
    }
    const ownerState = await inspectLinuxProcessIdentity(
      details.identity.pid,
      details.identity.processStart,
    );
    if (ownerState === 'alive') {
      return Object.freeze({ status: 'pending' });
    }
    if (ownerState === 'unknown') {
      return Object.freeze({ status: 'unknown' });
    }
    if (details.journalPath !== undefined) {
      if (details.terminalAuthenticationTag === undefined) {
        return Object.freeze({ status: 'unknown' });
      }
      return Object.freeze({
        cleanupReceiptTag: details.terminalAuthenticationTag,
        status: 'confirmed',
      });
    }
    if (!(await isProvenPreProviderRuntimeStore(details))) {
      return Object.freeze({ status: 'unknown' });
    }
    const cleanupReceiptTag = createHash('sha256')
      .update(
        JSON.stringify({
          candidateId: details.candidateId,
          ownerBootId: details.identity.bootId,
          ownerPid: details.identity.pid,
          ownerProcessStart: details.identity.processStart,
          sessionId: details.sessionId,
          state: 'pre-provider-owner-dead',
        }),
      )
      .digest('hex');
    return Object.freeze({ cleanupReceiptTag, status: 'confirmed' });
  }

  public async create(owner: BuildSessionOwner): Promise<SessionBoundRuntime> {
    if (this.usesProductionResources && !isVerifiedBuildSessionOwner(owner)) {
      throw new Error('The production OCI runtime requires a verified Linux BuildSession owner.');
    }
    const initialization = createRuntimeInitialization(owner);
    this.initializations.set(owner, initialization);
    try {
      const bootId = await this.readBootId();
      assertActiveBuildSessionOwner(owner);
      const resources = await this.createResources({
        bootId,
        ownerId: owner.ownerId,
        owner,
        resourceDirectory: owner.privateStateDirectory,
        sessionId: owner.sessionId,
      });
      initialization.resources = resources;
      assertActiveBuildSessionOwner(owner);
      const components = Object.freeze({
        buildExecutor: this.createBuildExecutor(resources, owner),
        imageAssembler: this.createImageAssembler(resources, owner),
      });

      if (components.buildExecutor.managesResources !== true) {
        throw new Error('The session-bound OCI runtime lacks managed resource ownership.');
      }

      assertActiveBuildSessionOwner(owner);
      initialization.finish();
      initialization.operation.settle();
      return Object.freeze({
        ...components,
        close: async () => {
          await resources.close();
          this.initializations.delete(owner);
        },
      });
    } catch (error) {
      // The package runtime will call settleFailedCreate while the same
      // BuildAuthority owner is still live. Do not hide a close failure or
      // infer that a missing runtime handle means no owned effect occurred.
      initialization.finish();
      throw error;
    }
  }

  public async settleFailedCreate(owner: BuildSessionOwner): Promise<void> {
    const initialization = this.initializations.get(owner);
    if (initialization === undefined) {
      throw new Error('The failed runtime factory did not retain initialization ownership.');
    }
    await initialization.settled;
    try {
      if (initialization.resources === undefined) {
        throw new Error('The failed runtime factory did not retain a closeable resource owner.');
      }
      await initialization.resources.close();
      this.initializations.delete(owner);
    } finally {
      initialization.operation.settle();
    }
  }
}

/**
 * A v2 pre-provider intent names one fixed runtime store before it gives a
 * provider any effect authority. A dead installer can be retired only when
 * that exact store has no evidence of a provider journal, fixture, writer, or
 * other side effect. This deliberately never searches a different store or
 * repairs an ambiguous one.
 */
async function isProvenPreProviderRuntimeStore(
  details: ReturnType<typeof readBuildSessionRecovery>,
): Promise<boolean> {
  if (
    details.sessionId !== details.candidateId ||
    basename(details.privateStateDirectory) !== details.candidateId ||
    basename(dirname(details.privateStateDirectory)) !== 'runtime-sessions'
  ) {
    return false;
  }

  const runtimeSessionsDirectory = dirname(details.privateStateDirectory);
  const authorityDirectory = dirname(runtimeSessionsDirectory);
  if (basename(authorityDirectory) !== 'build-authority') {
    return false;
  }

  const authorityBefore = await inspectPrivateDirectory(authorityDirectory);
  if (authorityBefore === undefined) {
    return false;
  }

  const runtimeSessionsBefore = await inspectPrivateDirectory(runtimeSessionsDirectory);
  if (runtimeSessionsBefore === undefined) {
    if (
      !(await isMissingPath(runtimeSessionsDirectory)) ||
      !(await isMissingPath(details.privateStateDirectory))
    ) {
      return false;
    }
    return (
      (await matchesPrivateDirectory(authorityDirectory, authorityBefore)) &&
      (await isMissingPath(runtimeSessionsDirectory))
    );
  }

  const storeBefore = await inspectPrivateDirectory(details.privateStateDirectory);
  if (storeBefore === undefined) {
    if (!(await isMissingPath(details.privateStateDirectory))) {
      return false;
    }
    return (
      (await matchesPrivateDirectory(authorityDirectory, authorityBefore)) &&
      (await matchesPrivateDirectory(runtimeSessionsDirectory, runtimeSessionsBefore))
    );
  }

  let entries;
  try {
    entries = await readdir(details.privateStateDirectory, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length !== 0) {
    return false;
  }

  return (
    (await matchesPrivateDirectory(authorityDirectory, authorityBefore)) &&
    (await matchesPrivateDirectory(runtimeSessionsDirectory, runtimeSessionsBefore)) &&
    (await matchesPrivateDirectory(details.privateStateDirectory, storeBefore))
  );
}

interface PrivateDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

async function inspectPrivateDirectory(
  path: string,
): Promise<PrivateDirectoryIdentity | undefined> {
  let before;
  try {
    before = await lstat(path);
  } catch {
    return undefined;
  }
  if (before.isSymbolicLink() || !before.isDirectory() || (before.mode & 0o077) !== 0) {
    return undefined;
  }

  let descriptor;
  try {
    descriptor = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch {
    return undefined;
  }
  try {
    const opened = await descriptor.stat();
    if (
      !opened.isDirectory() ||
      (opened.mode & 0o077) !== 0 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    try {
      await descriptor.close();
    } catch {
      return undefined;
    }
  }

  try {
    const after = await lstat(path);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      (after.mode & 0o077) !== 0 ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return Object.freeze({ dev: before.dev, ino: before.ino });
}

async function matchesPrivateDirectory(
  path: string,
  expected: PrivateDirectoryIdentity,
): Promise<boolean> {
  const actual = await inspectPrivateDirectory(path);
  return actual?.dev === expected.dev && actual.ino === expected.ino;
}

async function isMissingPath(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return isNotFoundError(error);
  }
}

async function inspectLinuxProcessIdentity(
  pid: number,
  expectedStart: string,
): Promise<'alive' | 'dead' | 'unknown'> {
  let contents: string;
  try {
    contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return 'dead';
    }
    return 'unknown';
  }
  try {
    const actualStart = processStartFromProcStat(contents);
    return actualStart === expectedStart ? 'alive' : 'dead';
  } catch {
    return 'unknown';
  }
}

async function readLinuxProcessStart(pid: number): Promise<string> {
  const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  return processStartFromProcStat(contents);
}

function processStartFromProcStat(contents: string): string {
  const closeParenthesis = contents.lastIndexOf(')');
  const start = contents.slice(closeParenthesis + 2).split(' ')[19];
  if (closeParenthesis < 0 || start === undefined || !/^\d+$/.test(start)) {
    throw new Error('The trusted Linux installer process identity is invalid.');
  }
  return start;
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function createRuntimeInitialization(owner: BuildSessionOwner): RuntimeInitialization {
  const operation = beginBuildSessionRuntimeInitialization(owner);
  let finish: (() => void) | undefined;
  let finished = false;
  const settled = new Promise<void>((resolve) => {
    finish = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };
  });

  return {
    finish: () => finish?.(),
    operation,
    settled,
  };
}

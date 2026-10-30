import { randomUUID } from 'node:crypto';

import type {
  SandboxBackend,
  SandboxCleanupEvidence,
  SandboxExecutionHandle,
  SandboxIdentityBinding,
} from '../../contracts/src/index.js';
import { readTrustedLinuxBootId } from '../../supervisor/src/index.js';
import type {
  BuildExecutionRequest,
  BuildExecutionResult,
  TrustedBuildExecutor,
} from '../../package-runtime/src/index.js';

import { OciSandboxBackend } from './backend.js';
import type { RuntimeResourceOps } from './resource-ops.js';

export interface OciOfflineBuildExecutorOptions {
  readonly createBackend?: (input: OciOfflineBuildExecutorBackendInput) => SandboxBackend;
  readonly createIdentity?: (candidateId: string) => Promise<SandboxIdentityBinding>;
  readonly ownerStorePath: string;
  readonly resources: RuntimeResourceOps;
}

export interface OciOfflineBuildExecutorBackendInput {
  readonly image: string;
  readonly ownerStorePath: string;
  readonly resources: RuntimeResourceOps;
}

/**
 * Production adapter for the package installer. It deliberately reuses the
 * accepted T004 backend instead of constructing a second Docker sandbox.
 */
export class OciOfflineBuildExecutor implements TrustedBuildExecutor {
  public readonly managesResources = true as const;

  private readonly createBackend: (input: OciOfflineBuildExecutorBackendInput) => SandboxBackend;
  private readonly createIdentity: (candidateId: string) => Promise<SandboxIdentityBinding>;

  public constructor(private readonly options: OciOfflineBuildExecutorOptions) {
    this.createBackend =
      options.createBackend ??
      ((input) =>
        new OciSandboxBackend({
          image: input.image,
          ownerStorePath: input.ownerStorePath,
          resources: input.resources,
        }));
    this.createIdentity = options.createIdentity ?? createBuildIdentity;
  }

  public async execute(request: BuildExecutionRequest): Promise<BuildExecutionResult> {
    const executable = request.argv[0];
    if (executable === undefined || !executable.startsWith('/')) {
      throw new Error('The trusted build executor requires an absolute executable.');
    }

    const backend = this.createBackend({
      image: request.builderImage,
      ownerStorePath: this.options.ownerStorePath,
      resources: this.options.resources,
    });
    const qualification = await backend.qualify(request.profile);
    const identity = await this.createIdentity(request.candidateId);
    const sandbox = await backend.create(qualification, identity);

    let handle: SandboxExecutionHandle;
    try {
      handle = await backend.execute(sandbox, {
        argv: request.argv.slice(1),
        cwd: request.cwd,
        environment: request.environment,
        executable,
      });
    } catch (error) {
      const cleanup = await backend.stop(sandbox).catch(() => unknownCleanup());
      if (!cleanup.cleanupConfirmed) {
        throw new Error('The qualified build sandbox could not confirm startup cleanup.', {
          cause: error,
        });
      }
      throw error;
    }

    try {
      await handle.closeInput();
    } catch (error) {
      const cleanup = await backend.stop(sandbox).catch(() => unknownCleanup());
      if (!cleanup.cleanupConfirmed) {
        throw new Error('The offline build input could not close and cleanup is unresolved.', {
          cause: error,
        });
      }
      throw new Error('The offline build input could not close.', { cause: error });
    }

    return Object.freeze({
      cancel: async () => {
        const cleanup = await backend.stop(sandbox);
        if (!cleanup.cleanupConfirmed) {
          throw new Error('The offline build sandbox cleanup is unresolved.');
        }
      },
      completion: handle.completion.then((completion) => ({
        cleanupConfirmed: completion.cleanupConfirmed,
        exitCode: completion.exitCode,
        reason: completion.reason,
      })),
      stderr: handle.stderr,
      stdout: handle.stdout,
    });
  }
}

async function createBuildIdentity(candidateId: string): Promise<SandboxIdentityBinding> {
  const bootId = await readTrustedLinuxBootId();
  const nonce = randomUUID();
  return Object.freeze({
    bootId,
    channelId: `package-build-${nonce}`,
    epoch: 1,
    installationId: `package-installation-${candidateId}`,
    instanceId: `package-build-${nonce}`,
  });
}

function unknownCleanup(): SandboxCleanupEvidence {
  return Object.freeze({ cleanupConfirmed: false, status: 'unknown' });
}

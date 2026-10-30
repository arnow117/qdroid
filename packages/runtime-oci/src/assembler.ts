import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  BuildSessionOwner,
  ImageAssemblyRequest,
  ImageAssemblyResult,
  PreparedAssemblyInput,
  PreparedSealedImageVerification,
  SealedImageVerification,
  TrustedImageAssembler,
} from '../../package-runtime/src/index.js';
import {
  assertActiveBuildSessionOwner,
  preparedAssemblyInputFor,
  preparedSealedImageVerificationFor,
} from '../../package-runtime/src/index.js';

import {
  hasOnlyInertImageConfiguration,
  type DockerImageConfiguration,
} from './image-configuration.js';
import type { RuntimeResourceOps } from './resource-ops.js';

export interface DockerCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type DockerCommandRunner = (argv: readonly string[]) => Promise<DockerCommandResult>;

export interface DockerImageAssemblerOptions {
  readonly run?: DockerCommandRunner;
}

export interface ManagedImageAssemblerOptions {
  readonly owner: BuildSessionOwner;
  readonly resources: RuntimeResourceOps;
}

interface DockerImageInspection {
  readonly Architecture?: string;
  readonly Config?: DockerImageConfiguration;
  readonly Id?: string;
  readonly Os?: string;
}

interface DockerAssemblyReceipt {
  readonly assembler: 'qdroid.fixed-copy-commit/v1';
  readonly baseImage: string;
  readonly candidateId: string;
  readonly finalImageId: string;
  readonly packageDigest: string;
  readonly platform: string;
  readonly purpose: 'builder' | 'runtime';
}

/**
 * The package installer can only invoke this trusted fixed-template adapter.
 * It never exposes Docker flags, host paths, Dockerfiles, or arbitrary image
 * selection to package data.
 */
export class DockerImageAssembler implements TrustedImageAssembler {
  private readonly run: DockerCommandRunner;

  public constructor(options: DockerImageAssemblerOptions = {}) {
    this.run = options.run ?? runDockerCommand;
  }

  public async assemble(request: ImageAssemblyRequest): Promise<ImageAssemblyResult> {
    const sourceImage =
      request.purpose === 'builder' ? request.base.builderImage : request.base.baseImage;
    const base = await this.inspectTrustedBase(request, sourceImage);
    const containerName = `qdroid-package-assembly-${randomUUID()}`;
    let created = false;
    let finalImageId: string | undefined;
    let template: AssemblyTemplate | undefined;

    try {
      await assertDockerSuccess(
        this.run([
          'create',
          '--pull=never',
          '--name',
          containerName,
          '--label',
          `io.qdroid.assembly.candidate=${request.candidateId}`,
          '--label',
          `io.qdroid.assembly.package=${request.packageDigest}`,
          base.Id,
        ]),
        'The trusted image assembler could not create its stopped container.',
      );
      created = true;

      template = await createAssemblyTemplate(request.packageDigest);
      await this.copyTemplate(containerName, template);
      template = undefined;

      const sourceTarget = `/opt/qdroid/packages/${request.packageDigest}/source`;
      await assertDockerSuccess(
        this.run(['cp', `${request.packageDirectory}/.`, `${containerName}:${sourceTarget}`]),
        'The trusted image assembler could not copy frozen package content.',
      );
      if (request.buildOutputDirectory !== undefined) {
        const generatedTarget = `/opt/qdroid/packages/${request.packageDigest}/generated`;
        await assertDockerSuccess(
          this.run([
            'cp',
            `${request.buildOutputDirectory}/.`,
            `${containerName}:${generatedTarget}`,
          ]),
          'The trusted image assembler could not copy validated generated files.',
        );
      }

      const commit = await this.run([
        'commit',
        '--pause=false',
        '--change',
        `LABEL io.qdroid.package.digest=${request.packageDigest}`,
        '--change',
        `LABEL io.qdroid.package.source=${sourceImage}`,
        '--change',
        `LABEL io.qdroid.package.purpose=${request.purpose}`,
        containerName,
      ]);
      if (commit.exitCode !== 0) {
        throw new Error('The trusted image assembler could not commit its fixed image.');
      }
      finalImageId = canonicalImageId(commit.stdout) ?? canonicalImageId(commit.stderr);
      if (finalImageId === undefined) {
        throw new Error('The trusted image assembler did not return an immutable image ID.');
      }
      await this.inspectFinalImage(finalImageId, request);
      const cleanupConfirmed = await this.removeStoppedContainer(containerName);
      created = false;
      if (!cleanupConfirmed) {
        throw new Error(
          'The trusted image assembler could not confirm temporary container cleanup.',
        );
      }

      return Object.freeze({
        cleanupConfirmed: true,
        imageId: finalImageId,
        receipt: Object.freeze({
          assembler: 'qdroid.fixed-copy-commit/v1',
          baseImage: sourceImage,
          candidateId: request.candidateId,
          finalImageId,
          packageDigest: request.packageDigest,
          platform: request.base.platform,
          purpose: request.purpose,
        }),
      });
    } finally {
      if (template !== undefined) {
        await removeAssemblyTemplate(template).catch(() => false);
      }
      if (created) {
        await this.removeStoppedContainer(containerName).catch(() => false);
      }
      // A sealed final image is intentionally retained. Another candidate may
      // share it or publish it after this candidate fails.
      void finalImageId;
    }
  }

  public async verifySealed(request: SealedImageVerification): Promise<void> {
    const receipt = readAssemblyReceipt(request.receipt);
    const expectedBase =
      request.purpose === 'builder' ? request.base.builderImage : request.base.baseImage;
    if (
      receipt.baseImage !== expectedBase ||
      receipt.finalImageId !== request.imageId ||
      receipt.packageDigest !== request.packageDigest ||
      receipt.platform !== request.base.platform ||
      receipt.purpose !== request.purpose
    ) {
      throw new Error('The sealed image receipt does not match the trusted installation record.');
    }

    const inspection = await inspectImage(this.run, request.imageId);
    const labels = inspection.Config.Labels;
    if (
      inspection.Id !== request.imageId ||
      inspection.Os !== 'linux' ||
      inspection.Architecture !== request.base.platform.split('/')[1] ||
      !hasOnlyInertImageConfiguration(inspection.Config) ||
      labels?.['io.qdroid.package.digest'] !== request.packageDigest ||
      labels['io.qdroid.package.source'] !== expectedBase ||
      labels['io.qdroid.package.purpose'] !== request.purpose
    ) {
      throw new Error('The retained immutable image no longer matches its sealed trusted receipt.');
    }
  }

  private async inspectTrustedBase(
    request: ImageAssemblyRequest,
    sourceImage: string,
  ): Promise<Required<DockerImageInspection>> {
    const inspection = await inspectImage(this.run, sourceImage);
    if (
      inspection.Id !== sourceImage ||
      inspection.Os !== 'linux' ||
      inspection.Architecture !== request.base.platform.split('/')[1] ||
      !hasOnlyInertImageConfiguration(inspection.Config)
    ) {
      throw new Error(
        'The trusted runtime catalog base does not match its approved immutable configuration.',
      );
    }
    return inspection;
  }

  private async inspectFinalImage(imageId: string, request: ImageAssemblyRequest): Promise<void> {
    const inspection = await inspectImage(this.run, imageId);
    if (
      inspection.Id !== imageId ||
      inspection.Os !== 'linux' ||
      inspection.Architecture !== request.base.platform.split('/')[1] ||
      !hasOnlyInertImageConfiguration(inspection.Config)
    ) {
      throw new Error('The trusted image assembler produced an unsupported immutable image.');
    }
  }

  private async removeStoppedContainer(containerName: string): Promise<boolean> {
    const removed = await this.run(['rm', '--force', containerName]);
    return removed.exitCode === 0;
  }

  private async copyTemplate(containerName: string, template: AssemblyTemplate): Promise<void> {
    try {
      await assertDockerSuccess(
        this.run(['cp', `${template.directory}/opt/.`, `${containerName}:/opt`]),
        'The trusted image assembler could not materialize its fixed package directories.',
      );
    } finally {
      const removed = await removeAssemblyTemplate(template);
      if (!removed) {
        throw new Error('The trusted image assembler could not clean up its copy-only template.');
      }
    }
  }
}

/**
 * Production image assembly accepts only an object identity that
 * PackageInstaller registered for this exact BuildSession. The provider owns
 * every Docker and filesystem mutation; this adapter never falls back to the
 * generic command runner or temporary-template helper.
 */
export class ManagedImageAssembler implements TrustedImageAssembler {
  private readonly owner: BuildSessionOwner;
  private readonly resources: RuntimeResourceOps;

  public constructor(options: ManagedImageAssemblerOptions) {
    assertActiveBuildSessionOwner(options.owner);
    this.owner = options.owner;
    this.resources = options.resources;
  }

  public assemble(request: ImageAssemblyRequest): Promise<ImageAssemblyResult> {
    const input: PreparedAssemblyInput = preparedAssemblyInputFor(this.owner, request);
    return this.resources.assembleFixed(input);
  }

  public verifySealed(request: SealedImageVerification): Promise<void> {
    const input: PreparedSealedImageVerification = preparedSealedImageVerificationFor(
      this.owner,
      request,
    );
    return this.resources.verifySealedFixed(input);
  }
}

function readAssemblyReceipt(value: Readonly<Record<string, unknown>>): DockerAssemblyReceipt {
  if (
    value.assembler !== 'qdroid.fixed-copy-commit/v1' ||
    typeof value.baseImage !== 'string' ||
    typeof value.candidateId !== 'string' ||
    typeof value.finalImageId !== 'string' ||
    typeof value.packageDigest !== 'string' ||
    typeof value.platform !== 'string' ||
    (value.purpose !== 'builder' && value.purpose !== 'runtime')
  ) {
    throw new Error('The sealed image receipt has an unsupported format.');
  }
  return Object.freeze({
    assembler: value.assembler,
    baseImage: value.baseImage,
    candidateId: value.candidateId,
    finalImageId: value.finalImageId,
    packageDigest: value.packageDigest,
    platform: value.platform,
    purpose: value.purpose,
  });
}

interface AssemblyTemplate {
  readonly directory: string;
}

async function createAssemblyTemplate(packageDigest: string): Promise<AssemblyTemplate> {
  const directory = await mkdtemp(join(tmpdir(), 'qdroid-assembly-template-'));
  try {
    const packageDirectory = join(directory, 'opt', 'qdroid', 'packages', packageDigest);
    await mkdir(packageDirectory, { mode: 0o755, recursive: true });
    return Object.freeze({ directory });
  } catch (error) {
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

async function removeAssemblyTemplate(template: AssemblyTemplate): Promise<boolean> {
  try {
    await rm(template.directory, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}

function canonicalImageId(output: string): string | undefined {
  const matches = output.match(/(?:sha256:)?[0-9a-f]{64}/gi) ?? [];
  if (matches.length !== 1) return undefined;

  const value = matches[0]!;
  const digest = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return `sha256:${digest.toLowerCase()}`;
}

async function inspectImage(
  run: DockerCommandRunner,
  image: string,
): Promise<Required<DockerImageInspection>> {
  const result = await run(['image', 'inspect', '--format', '{{json .}}', image]);
  if (result.exitCode !== 0)
    throw new Error('The trusted runtime catalog image is unavailable locally.');
  let inspection: DockerImageInspection;
  try {
    inspection = JSON.parse(result.stdout) as DockerImageInspection;
  } catch {
    throw new Error('Docker returned an invalid trusted image inspection result.');
  }
  if (
    typeof inspection.Id !== 'string' ||
    typeof inspection.Os !== 'string' ||
    typeof inspection.Architecture !== 'string' ||
    inspection.Config === undefined
  ) {
    throw new Error('Docker returned an incomplete trusted image inspection result.');
  }
  return inspection as Required<DockerImageInspection>;
}

async function assertDockerSuccess(
  result: Promise<DockerCommandResult>,
  message: string,
): Promise<void> {
  const completed = await result;
  if (completed.exitCode !== 0) throw new Error(message);
}

function runDockerCommand(argv: readonly string[]): Promise<DockerCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? -1, stderr, stdout });
    });
  });
}

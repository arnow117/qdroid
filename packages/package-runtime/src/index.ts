import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  unlink,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { satisfies, valid } from 'semver';

import { parseStrictJsonBytes, type JsonValue } from '../../contracts/src/index.js';
import {
  INSTALL_ARCHIVE_LIMITS,
  readFrozenBundle,
  readFrozenUstar,
  type FrozenArchive,
  type FrozenArchiveEntry,
} from './archive.js';

export const PACKAGE_MANIFEST_SCHEMA = 'qdroid.plugin/v0.1';
export const PACKAGE_GRAPH_MANIFEST_SCHEMA = 'qdroid.plugin/v0.2';
export const SOURCE_LOCK_SCHEMA = 'qdroid.lock/v0.1';
export const GRAPH_SOURCE_LOCK_SCHEMA = 'qdroid.lock/v0.2';
export const BUILD_OUTPUT_SCHEMA = 'qdroid.build/stdout-ustar-v1';
export const PREPARED_GRAPH_ASSEMBLY_SCHEMA = 'qdroid.prepared-graph-assembly/v1';

const MAX_BUILD_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_BUILD_OUTPUT_FILES = 256;
const MAX_DEPENDENCY_DEPTH = 8;
const MAX_DEPENDENCY_PACKAGES = 32;
const MAX_GRAPH_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_GRAPH_TRANSPORT_BYTES = 64 * 1024 * 1024;
const GRAPH_RESOLUTION_DEADLINE_MS = 30_000;
const GRAPH_SOURCE_READ_DEADLINE_MS = 5_000;
const MAX_METADATA_BYTES = 256 * 1024;
const REGISTRY_SCHEMA = 'qdroid.package-registry/v3';
const PREVIOUS_REGISTRY_SCHEMA = 'qdroid.package-registry/v2';
const BUILD_AUTHORITY_SCHEMA = 'qdroid.build-authority/v1';
const CONTENT_PUBLICATION_SCHEMA = 'qdroid.content-publication/v1';
const CONTENT_PUBLICATION_ADMISSION_MS = 10_000;
const RESOURCE_JOURNAL_KEY_FILE = '.resource-journal-key';
const BUILD_SESSION_INTENT_SCHEMA = 'qdroid.build-session-intent/v2';
const BUILD_SESSION_PROVIDER_READY_SCHEMA = 'qdroid.build-session-provider-ready/v1';
const BUILD_SESSION_PROVIDER_TERMINAL_SCHEMA = 'qdroid.build-session-provider-terminal/v1';
const BUILD_SESSION_RETIREMENT_SCHEMA = 'qdroid.build-session-retirement/v1';
const BUILD_SESSION_INTENT_DOMAIN = 'qdroid.build-session-intent/v2';
const BUILD_SESSION_PROVIDER_READY_DOMAIN = 'qdroid.build-session-provider-ready/v1';
const BUILD_SESSION_PROVIDER_TERMINAL_DOMAIN = 'qdroid.build-session-provider-terminal/v1';
const BUILD_SESSION_RETIREMENT_DOMAIN = 'qdroid.build-session-retirement/v1';
const MAX_PENDING_BUILD_SESSIONS = 32;
const GRAPH_COPY_TEMPLATE_SCHEMA = 'qdroid.graph-copy-template/v1';
const GRAPH_COPY_TEMPLATE_DIGEST = sha256(Buffer.from(GRAPH_COPY_TEMPLATE_SCHEMA));
const CANONICAL_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type InstallTarget = 'content-only' | 'linux/amd64' | 'linux/arm64';
export type PackageKind = 'application' | 'renderer' | 'tool';

/**
 * A trusted source can cooperate with the graph resolver's fixed byte and
 * deadline limits. The source catalog remains the only authority that chooses
 * an implementation; package metadata cannot supply a transport endpoint.
 */
export interface PackageSourceReadRequest {
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

export interface PackageSource {
  readonly expectedSha256: string;
  readonly id: string;
  readonly maxBytes: number;
  read(request?: PackageSourceReadRequest): Promise<Uint8Array>;
}

export interface TrustedImageCatalogEntry {
  readonly abi: string;
  readonly baseImage: string;
  readonly builderImage: string;
  readonly features: readonly string[];
  readonly id: string;
  readonly platform: Exclude<InstallTarget, 'content-only'>;
  readonly profile: 'build-restricted' | 'render-offline' | 'tool-offline';
  readonly templateDigest: string;
  readonly toolchainDigest: string;
}

export interface ImageAssemblyRequest {
  readonly base: TrustedImageCatalogEntry;
  readonly buildOutputDirectory?: string;
  readonly candidateId: string;
  /**
   * Internal sealed-material identity. The generic fixture adapter does not
   * require it, but the production adapter only accepts registered requests
   * that carry the complete immutable material binding.
   */
  readonly generatedOutputDigest?: string;
  /**
   * Versioned, installer-created graph material for the v0.2 graph branch.
   * Runtime adapters must obtain it through the opaque prepared-input lookup,
   * never by trusting a structurally similar caller object.
   */
  readonly graph?: PreparedGraphAssemblyMaterial;
  readonly packageDirectory: string;
  readonly packageDigest: string;
  readonly purpose: 'builder' | 'runtime';
  readonly resolvedLockDigest?: string;
  readonly sourceInventoryDigest?: string;
}

export interface ImageAssemblyResult {
  readonly cleanupConfirmed: boolean;
  readonly imageId: string;
  readonly receipt: Readonly<Record<string, JsonValue>>;
}

/** Trusted runtime adapter port. Package data cannot obtain this dependency. */
export interface TrustedImageAssembler {
  assemble(request: ImageAssemblyRequest): Promise<ImageAssemblyResult>;
  verifySealed(request: SealedImageVerification): Promise<void>;
}

/** A read-only verification request for a retained immutable image receipt. */
export interface SealedImageVerification {
  readonly base: TrustedImageCatalogEntry;
  readonly buildOutputDirectory?: string;
  readonly candidateId?: string;
  readonly generatedOutputDigest?: string;
  readonly graph?: PreparedGraphAssemblyMaterial;
  readonly imageId: string;
  readonly packageDirectory?: string;
  readonly packageDigest: string;
  readonly purpose: 'builder' | 'runtime';
  readonly receipt: Readonly<Record<string, JsonValue>>;
  readonly resolvedLockDigest?: string;
  readonly sourceInventoryDigest?: string;
}

const preparedAssemblyInput: unique symbol = Symbol('preparedAssemblyInput');
const preparedSealedImageVerification: unique symbol = Symbol('preparedSealedImageVerification');

/**
 * An identity-only capability registered by PackageInstaller after it has
 * checked the retained source, lock, and generated material. Production OCI
 * adapters can look it up, but no caller can create or register one.
 */
export interface PreparedAssemblyInput {
  readonly [preparedAssemblyInput]: true;
}

/** Identity-only capability for an already sealed immutable image receipt. */
export interface PreparedSealedImageVerification {
  readonly [preparedSealedImageVerification]: true;
}

/**
 * Trusted OCI adapters receive this data only after an identity lookup. It is
 * deliberately not a registration API and cannot authorize caller-provided
 * paths or digests.
 */
export interface PreparedAssemblyMaterial {
  readonly assemblyTemplateDigest: string;
  readonly assemblyToolchainDigest: string;
  readonly base: TrustedImageCatalogEntry;
  readonly buildOutputDirectory?: string;
  readonly candidateId: string;
  readonly generatedOutputDigest?: string;
  readonly graph?: PreparedGraphAssemblyMaterial;
  readonly materialDigest: string;
  readonly packageDirectory: string;
  readonly packageDigest: string;
  readonly purpose: 'builder' | 'runtime';
  readonly resolvedLockDigest: string;
  readonly sourceInventoryDigest: string;
}

export interface PreparedSealedImageMaterial extends PreparedAssemblyMaterial {
  readonly imageId: string;
  readonly receipt: Readonly<Record<string, JsonValue>>;
}

/** A fixed retained member reference, owned by PackageInstaller. */
export interface PreparedGraphNodeMaterial {
  readonly buildOutputDirectory?: string;
  readonly generatedOutputDigest?: string;
  readonly packageDigest: string;
  readonly packageDirectory: string;
  readonly sourceInventoryDigest: string;
}

/**
 * Opaque graph layout data carried only by registered assembler requests.
 * `graphMaterialDigest` is present solely for final runtime assembly after
 * the complete child-build closure has been durably sealed.
 */
export interface PreparedGraphAssemblyMaterial {
  readonly graphInputDigest: string;
  readonly graphMaterialDigest?: string;
  readonly graphTemplateDigest: string;
  readonly nodes: readonly PreparedGraphNodeMaterial[];
  readonly resolvedMapping: readonly Readonly<{
    name: string;
    packageDigest: string;
    version: string;
  }>[];
  readonly rootPackageDigest: string;
  readonly schema: typeof PREPARED_GRAPH_ASSEMBLY_SCHEMA;
  readonly stepNodePackageDigest: string;
}

export interface BuildExecutionRequest {
  readonly argv: readonly string[];
  readonly builderImage: string;
  readonly candidateId: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly packageDirectory: string;
  readonly packageDigest: string;
  readonly profile: 'build-restricted';
  readonly runtime: TrustedImageCatalogEntry;
}

export interface BuildExecutionResult {
  readonly completion: Promise<BuildExecutionCompletion>;
  cancel?(): Promise<void>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly stdout: AsyncIterable<Uint8Array>;
}

export interface BuildExecutionCompletion {
  readonly cleanupConfirmed: boolean;
  readonly exitCode: number | null;
  readonly reason: 'completed' | 'deadline' | 'guardian-lost' | 'output-limit' | 'stopped';
}

/** A narrow production build adapter; it has no workload-controlled exec surface. */
export interface TrustedBuildExecutor {
  /** Proves this adapter was constructed with the continuous managed resource owner. */
  readonly managesResources: true;
  execute(request: BuildExecutionRequest): Promise<BuildExecutionResult>;
}

/**
 * Opaque, host-created ownership for one BuildAuthority session. It exposes
 * only immutable identity and a private state directory to trusted runtime
 * adapters; package data never receives an instance of this type.
 */
export interface BuildSessionOwner {
  readonly candidateId: string;
  /**
   * The installer identity is sampled by trusted code before a runtime
   * provider can create any native resource. Synthetic factories retain an
   * explicit unverified marker, which is never recovery authority.
   */
  readonly identity: BuildSessionOwnerIdentity;
  readonly ownerId: string;
  readonly packageDigest: string;
  readonly privateStateDirectory: string;
  readonly sessionId: string;
}

export type BuildSessionOwnerIdentity =
  | Readonly<{
      readonly bootId: string;
      readonly kind: 'linux-verified';
      readonly pid: number;
      readonly processStart: string;
    }>
  | Readonly<{
      readonly kind: 'synthetic-unverified';
    }>;

export interface BuildSessionRecovery {
  /** Opaque BuildAuthority recovery capability; package data cannot create it. */
  readonly __buildSessionRecoveryBrand: unique symbol;
}

export type BuildSessionRecoveryResult =
  | Readonly<{
      readonly cleanupReceiptTag: string;
      readonly status: 'confirmed';
    }>
  | Readonly<{
      readonly status: 'pending' | 'unknown';
    }>;

export interface BuildSessionRecoveryDetails {
  readonly candidateId: string;
  readonly identity: BuildSessionOwnerIdentity;
  readonly journalAuthenticationTag?: string;
  readonly journalPath?: string;
  readonly ownerId: string;
  readonly packageDigest: string;
  readonly privateStateDirectory: string;
  readonly sessionId: string;
  readonly terminalAuthenticationTag?: string;
}

type BuildSessionOwnerState = 'active' | 'closing' | 'releasing' | 'released';

type ProviderJournalState = 'unacknowledged' | 'acknowledging' | 'acknowledged' | 'failed';
type ProviderTerminalState = 'unrecorded' | 'recording' | 'recorded' | 'failed';

interface RegisteredBuildSessionOwner {
  acknowledgeProviderJournal(authenticationTag: string): Promise<void>;
  recordProviderTerminal(journalAuthenticationTag: string): Promise<void>;
  readonly pendingOperations: Set<Promise<void>>;
  providerJournalAuthenticationTag?: string;
  providerJournalState: ProviderJournalState;
  providerTerminalState: ProviderTerminalState;
  resourceProviderInitialization: 'unclaimed' | 'claimed';
  readonly resourceJournalKey: Buffer;
  runtimeInitialization: 'unclaimed' | 'claimed';
  state: BuildSessionOwnerState;
}

/**
 * A narrowly scoped lease for one already-authorized raw operation. Runtime
 * adapters obtain it before their first filesystem, guardian, or Docker
 * effect and settle it only after the raw operation has reached a terminal
 * fact. It intentionally exposes neither a process transport nor authority
 * internals.
 */
export interface BuildSessionOperation {
  settle(): void;
}

const registeredBuildSessionOwners = new WeakMap<BuildSessionOwner, RegisteredBuildSessionOwner>();
const registeredBuildSessionRecoveries = new WeakMap<
  BuildSessionRecovery,
  BuildSessionRecoveryDetails
>();

interface RegisteredPreparedAssembly {
  readonly graph?: RegisteredPreparedGraphAssembly;
  readonly installerRoot: string;
  readonly material: PreparedAssemblyMaterial;
  readonly owner: BuildSessionOwner;
  prepared?: PreparedAssemblyInput;
  readonly sourceEntries: readonly FrozenArchiveEntry[];
}

interface RegisteredPreparedGraphNode {
  readonly material: PreparedGraphNodeMaterial;
  readonly sourceEntries: readonly FrozenArchiveEntry[];
}

interface RegisteredPreparedGraphAssembly {
  readonly material: PreparedGraphAssemblyMaterial;
  readonly nodes: readonly RegisteredPreparedGraphNode[];
}

interface RegisteredPreparedSealedImageVerification {
  readonly graph?: RegisteredPreparedGraphAssembly;
  readonly material: PreparedSealedImageMaterial;
  readonly owner: BuildSessionOwner;
  prepared?: PreparedSealedImageVerification;
}

const registeredAssemblyRequests = new WeakMap<ImageAssemblyRequest, RegisteredPreparedAssembly>();
const registeredPreparedAssemblyInputs = new WeakMap<
  PreparedAssemblyInput,
  RegisteredPreparedAssembly
>();
const registeredSealedImageVerifications = new WeakMap<
  SealedImageVerification,
  RegisteredPreparedSealedImageVerification
>();
const registeredPreparedSealedImageVerifications = new WeakMap<
  PreparedSealedImageVerification,
  RegisteredPreparedSealedImageVerification
>();

function registerPreparedAssemblyRequest(
  owner: BuildSessionOwner,
  request: ImageAssemblyRequest,
  sourceEntries: readonly FrozenArchiveEntry[],
  installerRoot: string,
  graph?: RegisteredPreparedGraphAssembly,
): void {
  assertActiveBuildSessionOwner(owner);
  if (registeredAssemblyRequests.has(request)) {
    throw new Error('The trusted image assembly request is already registered.');
  }
  const material = readAssemblyMaterial(request);
  if (
    (graph === undefined) !== (material.graph === undefined) ||
    (graph !== undefined && canonicalJson(graph.material) !== canonicalJson(material.graph))
  ) {
    throw new Error('The graph assembly request does not match installer-registered material.');
  }
  registeredAssemblyRequests.set(request, {
    ...(graph === undefined ? {} : { graph }),
    installerRoot,
    material,
    owner,
    sourceEntries: Object.freeze([...sourceEntries]),
  });
}

function registerPreparedSealedImageVerification(
  owner: BuildSessionOwner,
  request: SealedImageVerification,
  graph?: RegisteredPreparedGraphAssembly,
): void {
  assertActiveBuildSessionOwner(owner);
  if (registeredSealedImageVerifications.has(request)) {
    throw new Error('The trusted sealed image verification is already registered.');
  }
  const material = readSealedImageMaterial(request);
  if (
    (graph === undefined) !== (material.graph === undefined) ||
    (graph !== undefined && canonicalJson(graph.material) !== canonicalJson(material.graph))
  ) {
    throw new Error('The graph image verification does not match installer-registered material.');
  }
  registeredSealedImageVerifications.set(request, {
    ...(graph === undefined ? {} : { graph }),
    material,
    owner,
  });
}

/**
 * Looks up the only input that PackageInstaller registered for this exact
 * active owner and request object. This has no caller-controlled registration
 * path, so a structurally identical object cannot gain assembly authority.
 */
export function preparedAssemblyInputFor(
  owner: BuildSessionOwner,
  request: ImageAssemblyRequest,
): PreparedAssemblyInput {
  assertActiveBuildSessionOwner(owner);
  const registration = registeredAssemblyRequests.get(request);
  if (registration === undefined || registration.owner !== owner) {
    throw new Error('The image assembly request is not registered for this BuildSession owner.');
  }
  if (registration.prepared !== undefined) {
    if (registration.graph !== undefined) {
      throw new Error('The graph prepared assembly input has already been claimed.');
    }
    return registration.prepared;
  }

  const input = Object.freeze({ [preparedAssemblyInput]: true }) as PreparedAssemblyInput;
  registration.prepared = input;
  registeredPreparedAssemblyInputs.set(input, registration);
  return input;
}

/** Reads registered assembly material without accepting caller-supplied values. */
export function readPreparedAssemblyInput(
  owner: BuildSessionOwner,
  input: PreparedAssemblyInput,
): PreparedAssemblyMaterial {
  assertActiveBuildSessionOwner(owner);
  const registration = registeredPreparedAssemblyInputs.get(input);
  if (registration === undefined || registration.owner !== owner) {
    throw new Error('The prepared image assembly input is not owned by this BuildSession.');
  }
  return registration.material;
}

/**
 * Rechecks the installer-owned frozen source and optional generated trees
 * immediately before a managed provider may copy them. This performs no
 * registration and returns no filesystem mutation capability.
 */
export async function assertPreparedAssemblyMaterial(
  owner: BuildSessionOwner,
  input: PreparedAssemblyInput,
): Promise<PreparedAssemblyMaterial> {
  assertActiveBuildSessionOwner(owner);
  const registration = registeredPreparedAssemblyInputs.get(input);
  if (registration === undefined || registration.owner !== owner) {
    throw new Error('The prepared image assembly input is not owned by this BuildSession.');
  }

  const { installerRoot, material, sourceEntries } = registration;
  await assertInputInventory(
    `${material.packageDirectory}.input-inventory.json`,
    sourceEntries,
    material.packageDigest,
    installerRoot,
  );
  await assertMaterializedContent(
    material.packageDirectory,
    sourceEntries,
    material.packageDigest,
    installerRoot,
  );
  if (material.buildOutputDirectory !== undefined && material.generatedOutputDigest !== undefined) {
    await assertGeneratedOutput(
      material.buildOutputDirectory,
      `${material.buildOutputDirectory}.inventory.json`,
      material.packageDigest,
      material.generatedOutputDigest,
      installerRoot,
    );
  }
  if (registration.graph !== undefined) {
    await assertRegisteredPreparedGraph(registration.graph, installerRoot);
  }
  return material;
}

/** Looks up an existing-image verification capability registered by PackageInstaller. */
export function preparedSealedImageVerificationFor(
  owner: BuildSessionOwner,
  request: SealedImageVerification,
): PreparedSealedImageVerification {
  assertActiveBuildSessionOwner(owner);
  const registration = registeredSealedImageVerifications.get(request);
  if (registration === undefined || registration.owner !== owner) {
    throw new Error('The sealed image verification is not registered for this BuildSession owner.');
  }
  if (registration.prepared !== undefined) {
    if (registration.graph !== undefined) {
      throw new Error('The graph prepared image verification has already been claimed.');
    }
    return registration.prepared;
  }

  const verification = Object.freeze({
    [preparedSealedImageVerification]: true,
  }) as PreparedSealedImageVerification;
  registration.prepared = verification;
  registeredPreparedSealedImageVerifications.set(verification, registration);
  return verification;
}

/** Reads only installer-registered immutable-image verification material. */
export function readPreparedSealedImageVerification(
  owner: BuildSessionOwner,
  verification: PreparedSealedImageVerification,
): PreparedSealedImageMaterial {
  assertActiveBuildSessionOwner(owner);
  const registration = registeredPreparedSealedImageVerifications.get(verification);
  if (registration === undefined || registration.owner !== owner) {
    throw new Error('The prepared sealed image verification is not owned by this BuildSession.');
  }
  return registration.material;
}

function readAssemblyMaterial(request: ImageAssemblyRequest): PreparedAssemblyMaterial {
  if (
    request.sourceInventoryDigest === undefined ||
    request.resolvedLockDigest === undefined ||
    !isSha256(request.sourceInventoryDigest) ||
    !isSha256(request.resolvedLockDigest) ||
    (request.buildOutputDirectory === undefined) !==
      (request.generatedOutputDigest === undefined) ||
    (request.generatedOutputDigest !== undefined && !isSha256(request.generatedOutputDigest))
  ) {
    throw new Error('The image assembly request lacks complete sealed material identities.');
  }

  const material = Object.freeze({
    assemblyTemplateDigest: request.base.templateDigest,
    assemblyToolchainDigest: request.base.toolchainDigest,
    base: request.base,
    ...(request.buildOutputDirectory === undefined
      ? {}
      : { buildOutputDirectory: request.buildOutputDirectory }),
    candidateId: request.candidateId,
    ...(request.generatedOutputDigest === undefined
      ? {}
      : { generatedOutputDigest: request.generatedOutputDigest }),
    ...(request.graph === undefined
      ? {}
      : { graph: normalizePreparedGraphMaterial(request.graph) }),
    packageDirectory: request.packageDirectory,
    packageDigest: request.packageDigest,
    purpose: request.purpose,
    resolvedLockDigest: request.resolvedLockDigest,
    sourceInventoryDigest: request.sourceInventoryDigest,
  });
  return Object.freeze({
    ...material,
    materialDigest: digestJson({
      assemblyTemplateDigest: material.assemblyTemplateDigest,
      assemblyToolchainDigest: material.assemblyToolchainDigest,
      base: material.base,
      generatedOutputDigest: material.generatedOutputDigest ?? null,
      ...(material.graph === undefined
        ? {}
        : { graph: preparedGraphMaterialIdentity(material.graph) }),
      packageDigest: material.packageDigest,
      purpose: material.purpose,
      resolvedLockDigest: material.resolvedLockDigest,
      sourceInventoryDigest: material.sourceInventoryDigest,
    }),
  });
}

/**
 * Graph paths are verified through the private registration. They identify no
 * assembled image: only the immutable source/output identities, closure and
 * selected final seal participate in a material digest.
 */
function preparedGraphMaterialIdentity(
  graph: PreparedGraphAssemblyMaterial,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    graphInputDigest: graph.graphInputDigest,
    ...(graph.graphMaterialDigest === undefined
      ? {}
      : { graphMaterialDigest: graph.graphMaterialDigest }),
    graphTemplateDigest: graph.graphTemplateDigest,
    nodes: graph.nodes.map((node) =>
      Object.freeze({
        ...(node.generatedOutputDigest === undefined
          ? {}
          : { generatedOutputDigest: node.generatedOutputDigest }),
        packageDigest: node.packageDigest,
        sourceInventoryDigest: node.sourceInventoryDigest,
      }),
    ),
    resolvedMapping: graph.resolvedMapping,
    rootPackageDigest: graph.rootPackageDigest,
    schema: graph.schema,
    stepNodePackageDigest: graph.stepNodePackageDigest,
  });
}

function readSealedImageMaterial(request: SealedImageVerification): PreparedSealedImageMaterial {
  const resolvedLockDigest = request.resolvedLockDigest;
  const sourceInventoryDigest = request.sourceInventoryDigest;
  if (
    request.candidateId === undefined ||
    !/^(?:candidate|reuse)-[0-9a-f-]{36}$/.test(request.candidateId) ||
    resolvedLockDigest === undefined ||
    sourceInventoryDigest === undefined
  ) {
    throw new Error('The sealed image verification lacks its original candidate identity.');
  }
  const assembly = readAssemblyMaterial({
    base: request.base,
    ...(request.buildOutputDirectory === undefined
      ? {}
      : { buildOutputDirectory: request.buildOutputDirectory }),
    candidateId: request.candidateId,
    ...(request.generatedOutputDigest === undefined
      ? {}
      : { generatedOutputDigest: request.generatedOutputDigest }),
    ...(request.graph === undefined ? {} : { graph: request.graph }),
    packageDirectory: request.packageDirectory ?? '',
    packageDigest: request.packageDigest,
    purpose: request.purpose,
    resolvedLockDigest,
    sourceInventoryDigest,
  });
  if (assembly.packageDirectory.length === 0) {
    throw new Error('The sealed image verification lacks retained source material.');
  }
  return Object.freeze({
    ...assembly,
    imageId: request.imageId,
    receipt: request.receipt,
  });
}

function normalizePreparedGraphMaterial(
  graph: PreparedGraphAssemblyMaterial,
): PreparedGraphAssemblyMaterial {
  if (
    graph.schema !== PREPARED_GRAPH_ASSEMBLY_SCHEMA ||
    !isSha256(graph.graphInputDigest) ||
    !isSha256(graph.graphTemplateDigest) ||
    graph.graphTemplateDigest !== GRAPH_COPY_TEMPLATE_DIGEST ||
    !isSha256(graph.rootPackageDigest) ||
    !isSha256(graph.stepNodePackageDigest) ||
    (graph.graphMaterialDigest !== undefined && !isSha256(graph.graphMaterialDigest)) ||
    graph.nodes.length === 0
  ) {
    throw new Error('The graph assembly request lacks complete immutable graph identities.');
  }

  const nodes = graph.nodes.map((node) => {
    if (
      !isSha256(node.packageDigest) ||
      !isSha256(node.sourceInventoryDigest) ||
      !node.packageDirectory.startsWith('/') ||
      (node.buildOutputDirectory === undefined) !== (node.generatedOutputDigest === undefined) ||
      (node.generatedOutputDigest !== undefined && !isSha256(node.generatedOutputDigest))
    ) {
      throw new Error('The graph assembly request contains an invalid node material reference.');
    }
    return Object.freeze({ ...node });
  });
  const nodeDigests = nodes.map((node) => node.packageDigest);
  if (
    new Set(nodeDigests).size !== nodeDigests.length ||
    !nodeDigests.includes(graph.stepNodePackageDigest) ||
    (graph.graphMaterialDigest !== undefined && !nodeDigests.includes(graph.rootPackageDigest))
  ) {
    throw new Error('The graph assembly request node closure is not canonical.');
  }

  const resolvedMapping = graph.resolvedMapping.map((mapping) => {
    if (
      !mapping.name.match(/^[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)*$/) ||
      !CANONICAL_SEMVER.test(mapping.version) ||
      !nodeDigests.includes(mapping.packageDigest)
    ) {
      throw new Error('The graph assembly request contains an invalid resolved mapping.');
    }
    return Object.freeze({ ...mapping });
  });
  const mappingKeys = resolvedMapping.map(
    (mapping) => `${mapping.name}\u0000${mapping.version}\u0000${mapping.packageDigest}`,
  );
  if (
    new Set(mappingKeys).size !== mappingKeys.length ||
    !isSorted(mappingKeys, compareArchivePathsBytewise)
  ) {
    throw new Error('The graph assembly request resolved mapping is not canonical.');
  }

  return Object.freeze({
    graphInputDigest: graph.graphInputDigest,
    ...(graph.graphMaterialDigest === undefined
      ? {}
      : { graphMaterialDigest: graph.graphMaterialDigest }),
    graphTemplateDigest: graph.graphTemplateDigest,
    nodes: Object.freeze(nodes),
    resolvedMapping: Object.freeze(resolvedMapping),
    rootPackageDigest: graph.rootPackageDigest,
    schema: PREPARED_GRAPH_ASSEMBLY_SCHEMA,
    stepNodePackageDigest: graph.stepNodePackageDigest,
  });
}

async function assertRegisteredPreparedGraph(
  graph: RegisteredPreparedGraphAssembly,
  installerRoot: string,
): Promise<void> {
  if (graph.nodes.length !== graph.material.nodes.length) {
    throw new Error('The graph assembly registration is incomplete.');
  }
  for (const node of graph.nodes) {
    const expected = graph.material.nodes.find(
      (candidate) => candidate.packageDigest === node.material.packageDigest,
    );
    if (expected === undefined || canonicalJson(expected) !== canonicalJson(node.material)) {
      throw new Error('The graph assembly registration does not match its material closure.');
    }
    await assertInputInventory(
      `${node.material.packageDirectory}.input-inventory.json`,
      node.sourceEntries,
      node.material.packageDigest,
      installerRoot,
    );
    await assertMaterializedContent(
      node.material.packageDirectory,
      node.sourceEntries,
      node.material.packageDigest,
      installerRoot,
    );
    if (
      node.material.buildOutputDirectory !== undefined &&
      node.material.generatedOutputDigest !== undefined
    ) {
      await assertGeneratedOutput(
        node.material.buildOutputDirectory,
        `${node.material.buildOutputDirectory}.inventory.json`,
        node.material.packageDigest,
        node.material.generatedOutputDigest,
        installerRoot,
      );
    }
  }
}

/**
 * Rejects structurally identical, cached, forged, closing, and retired owner
 * objects. Only BuildAuthority creates registrations in product code.
 */
export function assertActiveBuildSessionOwner(owner: BuildSessionOwner): void {
  const registration = registeredBuildSessionOwners.get(owner);
  if (registration?.state !== 'active') {
    throw new Error('The BuildSession owner is not active for a trusted runtime operation.');
  }
}

/**
 * Returns a defensive copy of the journal key that BuildAuthority created in
 * its private authority directory. Resource providers may authenticate their
 * own records with it, but package data cannot discover or register a key.
 */
export function readBuildSessionResourceJournalKey(owner: BuildSessionOwner): Buffer {
  const registration = requireActiveBuildSessionRegistration(owner);
  return Buffer.from(registration.resourceJournalKey);
}

/**
 * Publishes the provider's initial authenticated resource journal. The
 * registered callback fixes the only permitted journal location before this
 * provider exists, so a runtime adapter cannot select an arbitrary recovery
 * path.
 */
export async function acknowledgeBuildSessionProviderJournal(
  owner: BuildSessionOwner,
  authenticationTag: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(authenticationTag)) {
    throw new Error('The managed resource journal authentication tag is invalid.');
  }
  const registration = requireActiveBuildSessionRegistration(owner);
  if (
    registration.resourceProviderInitialization !== 'claimed' ||
    registration.providerJournalState !== 'unacknowledged'
  ) {
    throw new Error('The managed resource provider journal is not available for acknowledgement.');
  }

  registration.providerJournalState = 'acknowledging';
  try {
    await registration.acknowledgeProviderJournal(authenticationTag);
    registration.providerJournalAuthenticationTag = authenticationTag;
    registration.providerJournalState = 'acknowledged';
  } catch (error) {
    registration.providerJournalState = 'failed';
    throw error;
  }
}

/**
 * Persists the provider's authenticated cleanup terminal after every owned
 * resource and retained fixture descriptor has reached a proved terminal
 * state. It is not a recovery API: only the original provider may call it
 * while its owner is active or sealed for cleanup. The write itself remains a
 * tracked cleanup operation through its complete durable settlement.
 */
export async function recordBuildSessionProviderTerminal(
  owner: BuildSessionOwner,
  journalAuthenticationTag: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(journalAuthenticationTag)) {
    throw new Error('The managed resource terminal authentication tag is invalid.');
  }
  const registration = requireProviderTerminalRegistration(owner, journalAuthenticationTag);
  const operation = beginBuildSessionCleanupOperation(owner);
  registration.providerTerminalState = 'recording';
  try {
    await registration.recordProviderTerminal(journalAuthenticationTag);
    registration.providerTerminalState = 'recorded';
  } catch (error) {
    registration.providerTerminalState = 'failed';
    throw error;
  } finally {
    operation.settle();
  }
}

/**
 * Returns the host-derived facts of an opaque stale session to the trusted
 * runtime recovery adapter. BuildAuthority registers this object only while
 * its physical SQLite transaction is held and removes it when that recovery
 * call returns.
 */
export function readBuildSessionRecovery(
  recovery: BuildSessionRecovery,
): BuildSessionRecoveryDetails {
  const details = registeredBuildSessionRecoveries.get(recovery);
  if (details === undefined) {
    throw new Error('The BuildSession recovery capability is unavailable.');
  }
  return Object.freeze({ ...details });
}

export function isVerifiedBuildSessionOwner(owner: BuildSessionOwner): boolean {
  return owner.identity.kind === 'linux-verified';
}

/** Begins a tracked raw operation before its first effect. */
export function beginBuildSessionOperation(owner: BuildSessionOwner): BuildSessionOperation {
  return beginRegisteredBuildSessionOperation(requireActiveBuildSessionRegistration(owner));
}

/**
 * Tracks the terminal cleanup of an effect that this owner recorded before it
 * was sealed. New creation is never allowed after sealing, but release must
 * still wait for exact cleanup and durable terminal facts.
 */
export function beginBuildSessionCleanupOperation(owner: BuildSessionOwner): BuildSessionOperation {
  const registration = registeredBuildSessionOwners.get(owner);
  if (
    registration === undefined ||
    (registration.state !== 'active' && registration.state !== 'closing')
  ) {
    throw new Error('The BuildSession owner is not available for trusted cleanup.');
  }
  return beginRegisteredBuildSessionOperation(registration);
}

/**
 * Reserves the one trusted runtime construction for this BuildSession and
 * tracks it as a raw operation from its first await until construction or
 * cleanup has settled. The opaque owner must already have been registered by
 * BuildAuthority; this is not a registration API.
 */
export function beginBuildSessionRuntimeInitialization(
  owner: BuildSessionOwner,
): BuildSessionOperation {
  const registration = requireActiveBuildSessionRegistration(owner);
  if (registration.runtimeInitialization === 'claimed') {
    throw new Error('The BuildSession already has a trusted runtime initialization.');
  }
  registration.runtimeInitialization = 'claimed';
  return beginRegisteredBuildSessionOperation(registration);
}

/**
 * Reserves the one root managed resource provider for this BuildSession.
 * Runtime adapters call this before creating its private directory or journal
 * so another provider instance cannot race it through a structural owner
 * clone or another factory object.
 */
export function beginBuildSessionResourceProviderInitialization(
  owner: BuildSessionOwner,
): BuildSessionOperation {
  const registration = requireActiveBuildSessionRegistration(owner);
  if (registration.resourceProviderInitialization === 'claimed') {
    throw new Error('The BuildSession already has a managed resource provider initialization.');
  }
  registration.resourceProviderInitialization = 'claimed';
  return beginRegisteredBuildSessionOperation(registration);
}

function requireActiveBuildSessionRegistration(
  owner: BuildSessionOwner,
): RegisteredBuildSessionOwner {
  assertActiveBuildSessionOwner(owner);
  const registration = registeredBuildSessionOwners.get(owner);
  if (registration === undefined) {
    throw new Error('The BuildSession owner registration is unavailable.');
  }
  return registration;
}

function requireProviderTerminalRegistration(
  owner: BuildSessionOwner,
  journalAuthenticationTag: string,
): RegisteredBuildSessionOwner {
  const registration = registeredBuildSessionOwners.get(owner);
  if (registration === undefined) {
    throw new Error('The BuildSession owner is not available for its original provider terminal.');
  }
  if (registration.state !== 'active' && registration.state !== 'closing') {
    throw new Error(
      'The BuildSession owner is not available for its original provider terminal: cleanup is no longer admitted.',
    );
  }
  if (registration.resourceProviderInitialization !== 'claimed') {
    throw new Error(
      'The BuildSession owner is not available for its original provider terminal: its resource provider was not claimed.',
    );
  }
  if (registration.providerJournalState !== 'acknowledged') {
    throw new Error(
      'The BuildSession owner is not available for its original provider terminal: its journal was not acknowledged.',
    );
  }
  if (registration.providerTerminalState !== 'unrecorded') {
    throw new Error(
      'The BuildSession owner is not available for its original provider terminal: its terminal was already attempted.',
    );
  }
  return registration;
}

function beginRegisteredBuildSessionOperation(
  registration: RegisteredBuildSessionOwner,
): BuildSessionOperation {
  let settled = false;
  let resolve: (() => void) | undefined;
  const pending = new Promise<void>((complete) => {
    resolve = complete;
  });
  registration.pendingOperations.add(pending);

  return Object.freeze({
    settle: () => {
      if (settled) {
        return;
      }
      settled = true;
      registration.pendingOperations.delete(pending);
      resolve?.();
    },
  });
}

function registerBuildSessionOwner(
  owner: BuildSessionOwner,
  resourceJournalKey: Buffer,
  acknowledgeProviderJournal: (authenticationTag: string) => Promise<void>,
  recordProviderTerminal: (journalAuthenticationTag: string) => Promise<void>,
): void {
  if (registeredBuildSessionOwners.has(owner)) {
    throw new Error('The BuildSession owner is already registered.');
  }
  if (resourceJournalKey.byteLength !== 32) {
    throw new Error('The BuildSession resource journal key is invalid.');
  }
  registeredBuildSessionOwners.set(owner, {
    acknowledgeProviderJournal,
    recordProviderTerminal,
    pendingOperations: new Set(),
    providerJournalState: 'unacknowledged',
    providerTerminalState: 'unrecorded',
    resourceProviderInitialization: 'unclaimed',
    resourceJournalKey: Buffer.from(resourceJournalKey),
    runtimeInitialization: 'unclaimed',
    state: 'active',
  });
}

function sealBuildSessionOwner(owner: BuildSessionOwner): void {
  const registration = registeredBuildSessionOwners.get(owner);
  if (
    registration === undefined ||
    (registration.state !== 'active' && registration.state !== 'closing')
  ) {
    throw new Error('The BuildSession owner is no longer registered.');
  }
  registration.state = 'closing';
}

async function releaseBuildSessionOwner(owner: BuildSessionOwner): Promise<void> {
  const registration = registeredBuildSessionOwners.get(owner);
  if (
    registration === undefined ||
    (registration.state !== 'active' && registration.state !== 'closing')
  ) {
    throw new Error('The BuildSession owner is no longer registered.');
  }
  sealBuildSessionOwner(owner);
  // Once release starts, an unregistered terminal write must not enter after
  // this operation snapshot. The already-admitted operations remain visible
  // and must settle before the owner can become released.
  registration.state = 'releasing';
  await Promise.allSettled([...registration.pendingOperations]);
  registration.state = 'released';
}

/**
 * One continuous trusted runtime bound to exactly one BuildSession. The
 * assembler and executor share its resource owner, and close proves their
 * persistent mutations and temporary effects have settled before retirement.
 */
export interface SessionBoundRuntime {
  readonly buildExecutor: TrustedBuildExecutor;
  readonly imageAssembler: TrustedImageAssembler;
  close(): Promise<void>;
}

/** Trusted dependency-injection port implemented by runtime-oci. */
export interface TrustedRuntimeFactory {
  /**
   * Samples the current installer identity before BuildAuthority writes a new
   * executable-session intent. Factories without this port stay compatible
   * with host tests, but receive an explicit synthetic-unverified owner.
   */
  captureOwnerIdentity?(): Promise<BuildSessionOwnerIdentity>;
  /**
   * Only an explicitly trusted test or production factory may accept v0.2
   * executable graph material. Absent and non-true values fail closed before
   * staging, SQLite, session, or factory effects.
   */
  readonly supportsGraphMaterialV1?: true;
  create(owner: BuildSessionOwner): Promise<SessionBoundRuntime>;
  /**
   * Observes one opaque stale session while BuildAuthority retains its SQLite
   * transaction. It has cleanup-only authority and cannot create a runtime.
   */
  recoverSession?(recovery: BuildSessionRecovery): Promise<BuildSessionRecoveryResult>;
  /**
   * Settles effects begun by `create` when no runtime handle was returned.
   * A failure leaves the durable BuildSession retained and is reported with
   * the original factory failure. A missing hook likewise retains the owner.
   */
  settleFailedCreate?(owner: BuildSessionOwner): Promise<void>;
}

export interface PackageInstallerOptions {
  readonly installerRoot: string;
  readonly ownerId: string;
  /**
   * Controlled test-only observation points for the content publication
   * protocol. Production callers do not receive a default implementation.
   */
  readonly publicationTestHooks?: PackageInstallerPublicationTestHooks;
  readonly runtimeFactory?: TrustedRuntimeFactory;
  readonly runtimeCatalog: ReadonlyMap<string, TrustedImageCatalogEntry>;
  readonly sources: ReadonlyMap<string, PackageSource>;
  readonly supportedEngineVersion: string;
}

/** @internal Test-only synchronization points for publication failure tests. */
export interface PackageInstallerPublicationTestHooks {
  readonly afterContentRename?: (destination: string) => Promise<void>;
  readonly afterAuthorityDatabaseClose?: (path: string) => Promise<void>;
  readonly afterAuthorityDatabaseSync?: (path: string) => Promise<void>;
  /** Test-only failure points around an immutable metadata descriptor. */
  readonly afterDurableWriteFileClose?: (path: string) => Promise<void>;
  readonly afterDurableWriteFileSync?: (path: string) => Promise<void>;
  readonly afterDurableWriteLink?: (path: string) => Promise<void>;
  readonly afterDurableWriteTemporaryUnlink?: (path: string) => Promise<void>;
  /** Test-only boundary after a journal-key file sync, before directory sync. */
  readonly afterResourceJournalKeyFileSync?: (path: string) => Promise<void>;
}

export interface InstallRequest {
  readonly sourceId: string;
  readonly target: InstallTarget;
}

export interface DisabledInstallationRecord {
  readonly buildInputDigest: string | null;
  readonly buildOutputDigest: string | null;
  readonly builderImageId: string | null;
  readonly builderReceiptPath: string | null;
  readonly contentDirectory: string;
  readonly generatedDirectory: string | null;
  readonly generatedInventoryPath: string | null;
  readonly graphMaterialDigest: string | null;
  readonly graphMaterialPath: string | null;
  readonly imageId: string | null;
  readonly inputInventoryPath: string;
  readonly installationId: string;
  readonly ownerId: string;
  readonly packageDigest: string;
  readonly packageName: string;
  readonly resolvedLockDigest: string | null;
  readonly resolvedLockPath: string | null;
  readonly runtimeReceiptPath: string | null;
  readonly status: 'installed-disabled';
  readonly target: InstallTarget;
  readonly version: string;
  readonly versionRecordId: string;
}

export interface InstallResult {
  readonly record: DisabledInstallationRecord;
  readonly reusedExisting: boolean;
}

interface PackageManifest {
  readonly assets: readonly string[];
  readonly build?: BuildDeclaration;
  readonly dependencies: readonly PackageDependency[];
  readonly engineCompatibility: string;
  readonly entrypoint?: { executable: string; type: 'command' | 'stdio-mcp' };
  readonly kind: PackageKind;
  readonly license: string;
  readonly name: string;
  readonly requestedCapabilities: readonly RequestedCapability[];
  readonly requestedResources: RequestedResources;
  readonly runtimeVariants: readonly RuntimeVariant[];
  readonly scenes: readonly string[];
  readonly skills: readonly string[];
  readonly schema: PackageManifestSchema;
  readonly version: string;
}

type PackageManifestSchema = typeof PACKAGE_MANIFEST_SCHEMA | typeof PACKAGE_GRAPH_MANIFEST_SCHEMA;

interface PackageDependency {
  readonly name: string;
  readonly sourceId: string;
  readonly version: string;
}

interface RuntimeVariant {
  readonly abi: string;
  readonly baseCatalogId: string;
  readonly image: string;
  readonly platform: Exclude<InstallTarget, 'content-only'>;
  readonly requiredFeatures: readonly string[];
  readonly requiredProfile: 'build-restricted' | 'render-offline' | 'tool-offline';
}

interface RequestedCapability {
  readonly id: string;
  readonly operations: readonly string[];
  readonly resourceSelector: ResourceSelector;
}

interface ResourceSelector {
  readonly ids?: readonly string[];
  readonly type: string;
}

interface RequestedResources {
  readonly deadlineMs: number;
  readonly memoryMiB: number;
  readonly outputBytes: number;
  readonly pids: number;
  readonly scratchMiB: number;
}

interface ResolvedRuntime {
  readonly catalog: TrustedImageCatalogEntry;
  readonly resolvedLockDigest: string;
  readonly variant: RuntimeVariant;
}

interface BuildDeclaration {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exports: readonly string[];
}

interface SourceLock {
  readonly dependencies: readonly PackageDependency[];
  readonly inputContentDigest: string;
  readonly schema: SourceLockSchema;
}

type SourceLockSchema = typeof SOURCE_LOCK_SCHEMA | typeof GRAPH_SOURCE_LOCK_SCHEMA;

interface Candidate {
  readonly archive: FrozenArchive;
  readonly dependencies: readonly PackageDependency[];
  readonly inputContentDigest: string;
  readonly manifest: PackageManifest;
  readonly packageDigest: string;
  readonly sourceId: string;
  readonly sourceLock: SourceLock;
  readonly transportDigest: string;
}

interface ResolvedPackageGraph {
  readonly digest: string;
  readonly nodes: readonly Candidate[];
  readonly root: Candidate;
}

interface ResolvedExecutableGraphRuntime {
  readonly nodes: ReadonlyMap<string, ResolvedRuntime | undefined>;
  readonly root: ResolvedRuntime;
  readonly resolvedLockDigest: string;
}

interface GraphNodeExecution {
  readonly candidate: Candidate;
  readonly generatedOutput?: SealedGeneratedOutput;
  readonly generatedOutputDigest?: string;
  readonly nodeBuilderImage?: ImageAssemblyResult;
  readonly nodeBuilderReceiptPath?: string;
}

interface RetainedGraphNodeExecution {
  readonly candidate: Candidate;
  readonly generatedDirectory?: string;
  readonly generatedInventoryPath?: string;
  readonly generatedOutputDigest?: string;
  readonly nodeBuilderImageId?: string;
  readonly nodeBuilderReceiptPath?: string;
}

interface RetainedExecutableGraphMaterial {
  readonly candidateId: string;
  readonly graphInputDigest: string;
  readonly graphMaterialDigest: string;
  readonly graphOutputDigest: string;
  readonly nodes: ReadonlyMap<string, RetainedGraphNodeExecution>;
}

interface SealedGeneratedOutput {
  readonly directory: string;
  readonly inventoryPath: string;
}

interface SealedGraphMaterial {
  readonly digest: string;
  readonly path: string;
}

interface BuildSessionIntent {
  readonly authenticationTag: string;
  readonly authorityKeyId: string;
  readonly candidateId: string;
  readonly createdAt: string;
  readonly identity: BuildSessionOwnerIdentity;
  readonly ownerId: string;
  readonly packageDigest: string;
  readonly phase: 'pre-provider';
  readonly runtimeStore: string;
  readonly schema: typeof BUILD_SESSION_INTENT_SCHEMA;
  readonly version: 2;
}

interface BuildSessionProviderReady {
  readonly authenticationTag: string;
  readonly candidateId: string;
  readonly intentAuthenticationTag: string;
  readonly journalAuthenticationTag: string;
  readonly journalRelativePath: string;
  readonly ownerId: string;
  readonly schema: typeof BUILD_SESSION_PROVIDER_READY_SCHEMA;
  readonly sessionId: string;
  readonly version: 1;
}

interface BuildSessionProviderTerminal {
  readonly authenticationTag: string;
  readonly candidateId: string;
  readonly intentAuthenticationTag: string;
  readonly journalAuthenticationTag: string;
  readonly ownerId: string;
  readonly providerReadyAuthenticationTag: string;
  readonly schema: typeof BUILD_SESSION_PROVIDER_TERMINAL_SCHEMA;
  readonly sessionId: string;
  readonly version: 1;
}

interface BuildSessionRetirement {
  readonly authenticationTag: string;
  readonly candidateId: string;
  readonly cleanupReceiptTag: string;
  readonly intentAuthenticationTag: string;
  readonly ownerId: string;
  /** The initial provider-journal binding remains durable evidence after cleanup. */
  readonly providerReadyAuthenticationTag: string | null;
  /** The original provider's cleanup terminal is retained instead of reconstructed. */
  readonly providerTerminalAuthenticationTag: string | null;
  readonly reason: 'current-owner' | 'recovery-confirmed';
  readonly retiredAt: string;
  readonly schema: typeof BUILD_SESSION_RETIREMENT_SCHEMA;
  readonly sessionId: string;
  readonly version: 1;
}

interface RegistryRow {
  build_input_digest: string | null;
  build_output_digest: string | null;
  builder_image_id: string | null;
  builder_receipt_path: string | null;
  content_directory: string;
  generated_directory: string | null;
  generated_inventory_path: string | null;
  graph_material_digest: string | null;
  graph_material_path: string | null;
  image_id: string | null;
  input_inventory_path: string;
  installation_id: string;
  owner_id: string;
  package_digest: string;
  package_name: string;
  resolved_lock_digest: string | null;
  resolved_lock_path: string | null;
  runtime_receipt_path: string | null;
  target: string;
  version: string;
  version_record_id: string;
}

interface PublicationResult {
  readonly inserted: boolean;
  readonly record: DisabledInstallationRecord;
}

export class PackageInstaller {
  private readonly buildAuthority: BuildAuthority;
  private readonly contentPublicationAuthority: ContentPublicationAuthority;
  private readonly registry: DisabledRegistry;
  private readonly unsettledGraphReads = new Set<Promise<unknown>>();

  public constructor(private readonly options: PackageInstallerOptions) {
    this.assertTrustedOptions();
    this.buildAuthority = new BuildAuthority(
      options.installerRoot,
      options.ownerId,
      options.publicationTestHooks,
      options.runtimeFactory,
    );
    this.contentPublicationAuthority = new ContentPublicationAuthority(
      options.installerRoot,
      options.publicationTestHooks,
    );
    this.registry = new DisabledRegistry(options.installerRoot, options.ownerId);
  }

  public async install(request: InstallRequest): Promise<InstallResult> {
    const graph = await this.resolvePackageGraph(request.sourceId);
    const isGraphInstallation = graph.root.manifest.schema === PACKAGE_GRAPH_MANIFEST_SCHEMA;
    if (isGraphInstallation && request.target !== 'content-only') {
      this.assertExecutableGraphFactoryCapability();
      return this.installExecutableGraph(request, graph);
    }
    const candidate = graph.root;
    const resolvedRuntime = this.selectVariant(candidate, request.target);
    if (isGraphInstallation) {
      this.assertContentOnlyGraph(graph);
    }
    const buildInputDigest =
      resolvedRuntime === undefined ? null : computeBuildInputDigest(candidate, resolvedRuntime);
    const candidateId = `candidate-${randomUUID()}`;
    const stagingDirectory = join(this.options.installerRoot, 'candidates', candidateId);
    const rootStagingDirectory = isGraphInstallation
      ? join(stagingDirectory, 'nodes', candidate.packageDigest)
      : stagingDirectory;
    const contentDirectory = join(this.options.installerRoot, 'content', candidate.packageDigest);
    let lease: BuildLease | undefined;
    let contentLease: ContentPublicationLease | undefined;
    let runtime: SessionBoundRuntime | undefined;
    let builderImage: ImageAssemblyResult | undefined;
    let builderReceiptPath: string | null = null;
    let generatedOutput: SealedGeneratedOutput | undefined;
    let graphMaterial: SealedGraphMaterial | undefined;
    let resolvedLockPath: string | null = null;
    let runtimeReceiptPath: string | null = null;
    let sealedImage: ImageAssemblyResult | undefined;
    let factoryCreationFailed = false;
    let installationResult: InstallResult | undefined;
    let primaryFailure: unknown;
    const releaseContentLease = async (): Promise<void> => {
      const activeLease = contentLease;
      contentLease = undefined;
      if (activeLease !== undefined) {
        await activeLease.release();
      }
    };
    try {
      contentLease = await this.contentPublicationAuthority.acquire();
      const existing = await this.registry.find(candidate.manifest, request.target);
      if (existing !== undefined) {
        this.assertExistingCompatible(existing, candidate.packageDigest, buildInputDigest);
        await assertInstalledContent(
          existing,
          candidate.archive.entries,
          this.options.installerRoot,
        );
        if (isGraphInstallation) {
          await assertGraphMaterial(existing, graph, this.options.installerRoot);
        }
        if (resolvedRuntime !== undefined) {
          await releaseContentLease();
        }
        if (resolvedRuntime !== undefined) {
          await this.verifyExistingExecutableMaterial(existing, candidate, resolvedRuntime);
        } else {
          await this.assertExistingRuntimeMaterial(existing, candidate, undefined);
        }
        installationResult = Object.freeze({ record: existing, reusedExisting: true });
      } else {
        await writeCandidateStaging(rootStagingDirectory, candidate.archive.entries);
        if (isGraphInstallation) {
          for (const node of graph.nodes) {
            if (node.packageDigest === candidate.packageDigest) {
              continue;
            }
            const nodeStagingDirectory = join(stagingDirectory, 'nodes', node.packageDigest);
            await writeCandidateStaging(nodeStagingDirectory, node.archive.entries);
            await sealCandidateContent(
              this.options.installerRoot,
              nodeStagingDirectory,
              join(this.options.installerRoot, 'content', node.packageDigest),
              node.archive,
              node.packageDigest,
              this.options.publicationTestHooks,
            );
          }
        }
        await sealCandidateContent(
          this.options.installerRoot,
          rootStagingDirectory,
          contentDirectory,
          candidate.archive,
          candidate.packageDigest,
          this.options.publicationTestHooks,
        );
        if (isGraphInstallation) {
          graphMaterial = await sealGraphMaterial(this.options.installerRoot, candidateId, graph);
          await assertSealedGraphMaterial(graphMaterial, graph, this.options.installerRoot);
        }
        if (resolvedRuntime !== undefined) {
          await releaseContentLease();
        }

        let buildOutputDirectory: string | undefined;
        let buildOutputDigest: string | null = null;
        if (resolvedRuntime !== undefined) {
          await assertInputInventory(
            `${contentDirectory}.input-inventory.json`,
            candidate.archive.entries,
            candidate.packageDigest,
            this.options.installerRoot,
          );
          await assertMaterializedContent(
            contentDirectory,
            candidate.archive.entries,
            candidate.packageDigest,
            this.options.installerRoot,
          );
          lease = await this.buildAuthority.acquire({
            candidateId,
            packageDigest: candidate.packageDigest,
          });
          try {
            runtime = await this.createSessionRuntime(lease.owner);
          } catch (error) {
            factoryCreationFailed = true;
            throw error;
          }
          resolvedLockPath = await sealResolvedLock(
            this.options.installerRoot,
            candidateId,
            candidate,
            resolvedRuntime,
          );
          await assertResolvedLock(
            resolvedLockPath,
            candidate,
            resolvedRuntime,
            this.options.installerRoot,
          );
          const build = candidate.manifest.build;
          if (build !== undefined) {
            builderImage = await this.assembleImage(
              runtime,
              lease.owner,
              resolvedRuntime,
              candidateId,
              contentDirectory,
              undefined,
              undefined,
              candidate.packageDigest,
              inventoryDigest(candidate.archive.entries),
              candidate.archive.entries,
              'builder',
            );
            if (!builderImage.cleanupConfirmed) {
              throw new Error('The trusted builder assembly cleanup was not confirmed.');
            }
            builderReceiptPath = await sealAssemblyReceipt(
              this.options.installerRoot,
              candidateId,
              builderImage,
              candidate.packageDigest,
              'builder',
            );
            let buildOutput: { archive: FrozenArchive; digest: string };
            try {
              buildOutput = await this.executeBuild(
                runtime,
                build,
                resolvedRuntime,
                candidateId,
                contentDirectory,
                builderImage.imageId,
                candidate.packageDigest,
              );
            } catch (error) {
              throw error;
            }
            buildOutputDigest = buildOutput.digest;
            generatedOutput = await sealGeneratedOutput(
              this.options.installerRoot,
              candidateId,
              stagingDirectory,
              candidate.packageDigest,
              buildOutput.digest,
              buildOutput.archive,
            );
            buildOutputDirectory = generatedOutput.directory;
            await assertGeneratedOutput(
              generatedOutput.directory,
              generatedOutput.inventoryPath,
              candidate.packageDigest,
              buildOutput.digest,
              this.options.installerRoot,
            );
          }
          sealedImage = await this.assembleImage(
            runtime,
            lease.owner,
            resolvedRuntime,
            candidateId,
            contentDirectory,
            buildOutputDirectory,
            buildOutputDigest ?? undefined,
            candidate.packageDigest,
            inventoryDigest(candidate.archive.entries),
            candidate.archive.entries,
            'runtime',
          );
          if (!sealedImage.cleanupConfirmed) {
            throw new Error('The trusted image assembly cleanup was not confirmed.');
          }
          runtimeReceiptPath = await sealAssemblyReceipt(
            this.options.installerRoot,
            candidateId,
            sealedImage,
            candidate.packageDigest,
            'runtime',
          );
        }

        const publication = await this.registry.publish({
          buildInputDigest,
          buildOutputDigest,
          builderImageId: builderImage?.imageId ?? null,
          builderReceiptPath,
          contentDirectory,
          generatedDirectory: generatedOutput?.directory ?? null,
          generatedInventoryPath: generatedOutput?.inventoryPath ?? null,
          graphMaterialDigest: graphMaterial?.digest ?? null,
          graphMaterialPath: graphMaterial?.path ?? null,
          imageId: sealedImage?.imageId ?? null,
          inputInventoryPath: `${contentDirectory}.input-inventory.json`,
          manifest: candidate.manifest,
          ownerId: this.options.ownerId,
          packageDigest: candidate.packageDigest,
          resolvedLockDigest: resolvedRuntime?.resolvedLockDigest ?? null,
          resolvedLockPath,
          runtimeReceiptPath,
          target: request.target,
        });
        const record = publication.record;
        await assertInstalledContent(record, candidate.archive.entries, this.options.installerRoot);
        if (isGraphInstallation) {
          await assertGraphMaterial(record, graph, this.options.installerRoot);
        }
        if (resolvedRuntime !== undefined) {
          if (runtime === undefined || lease === undefined) {
            throw new Error('The executable winner has no managed BuildSession runtime.');
          }
          await this.assertExistingRuntimeMaterial(
            record,
            candidate,
            resolvedRuntime,
            runtime,
            lease.owner,
          );
        }
        await releaseContentLease();
        installationResult = Object.freeze({ record, reusedExisting: !publication.inserted });
      }
    } catch (error) {
      primaryFailure = error;
    }

    const contentLeaseFailures: unknown[] = [];
    try {
      await releaseContentLease();
    } catch (error) {
      contentLeaseFailures.push(error);
    }

    const finalization =
      lease === undefined
        ? { failures: Object.freeze([]) as readonly unknown[], retired: true }
        : await this.finalizeManagedLease(
            lease,
            runtime,
            factoryCreationFailed,
            factoryCreationFailed ||
              primaryFailure === undefined ||
              primaryFailure instanceof ConfirmedBuildFailure,
          );
    let stagingFailure: unknown;
    if (finalization.retired) {
      try {
        await removeOwnedStaging(stagingDirectory);
      } catch (error) {
        stagingFailure = error;
      }
    }
    const cleanupFailures = Object.freeze([
      ...contentLeaseFailures,
      ...finalization.failures,
      ...(stagingFailure === undefined ? [] : [stagingFailure]),
    ]);
    throwIfFailures(primaryFailure, cleanupFailures);
    if (installationResult === undefined) {
      throw new Error('Package installation ended without a result or failure.');
    }
    return installationResult;
  }

  /**
   * The v0.2 graph path is intentionally separate from the v0.1 flow above.
   * It preserves the old content-only bytes and only enters this branch after
   * trusted constructor injection has explicitly opted into graph material.
   */
  private async installExecutableGraph(
    request: InstallRequest,
    graph: ResolvedPackageGraph,
  ): Promise<InstallResult> {
    const candidate = graph.root;
    const graphRuntime = this.resolveExecutableGraphRuntime(graph, request.target);
    const graphInputDigest = computeGraphBuildInputDigest(graph, graphRuntime);
    const candidateId = `candidate-${randomUUID()}`;
    const stagingDirectory = join(this.options.installerRoot, 'candidates', candidateId);
    const contentDirectory = join(this.options.installerRoot, 'content', candidate.packageDigest);
    let lease: BuildLease | undefined;
    let contentLease: ContentPublicationLease | undefined;
    let runtime: SessionBoundRuntime | undefined;
    let factoryCreationFailed = false;
    let installationResult: InstallResult | undefined;
    let primaryFailure: unknown;
    const releaseContentLease = async (): Promise<void> => {
      const activeLease = contentLease;
      contentLease = undefined;
      if (activeLease !== undefined) {
        await activeLease.release();
      }
    };

    try {
      contentLease = await this.contentPublicationAuthority.acquire();
      const existing = await this.registry.find(candidate.manifest, request.target);
      if (existing !== undefined) {
        this.assertExistingCompatible(existing, candidate.packageDigest, graphInputDigest);
        await assertInstalledContent(
          existing,
          candidate.archive.entries,
          this.options.installerRoot,
        );
        const retained = await assertExecutableGraphMaterial(
          existing,
          graph,
          graphRuntime,
          this.options.installerRoot,
        );
        await releaseContentLease();
        await this.verifyExistingExecutableGraphMaterial(existing, graph, graphRuntime, retained);
        installationResult = Object.freeze({ record: existing, reusedExisting: true });
      } else {
        await this.stageGraphSourceClosure(stagingDirectory, graph);
        await releaseContentLease();

        lease = await this.buildAuthority.acquire({
          candidateId,
          packageDigest: candidate.packageDigest,
        });
        try {
          runtime = await this.createSessionRuntime(lease.owner);
        } catch (error) {
          factoryCreationFailed = true;
          throw error;
        }

        const resolvedLockPath = await sealExecutableGraphResolvedLock(
          this.options.installerRoot,
          candidateId,
          graph,
          graphRuntime,
        );
        await assertExecutableGraphResolvedLock(
          resolvedLockPath,
          graph,
          graphRuntime,
          this.options.installerRoot,
        );

        const executions = new Map<string, GraphNodeExecution>();
        for (const node of graphDependencyFirstOrder(graph)) {
          const resolvedRuntime = graphRuntime.nodes.get(node.packageDigest);
          if (node.manifest.build === undefined) {
            executions.set(node.packageDigest, Object.freeze({ candidate: node }));
            continue;
          }
          if (resolvedRuntime === undefined || runtime === undefined || lease === undefined) {
            throw new Error('A declared graph build has no trusted runtime selection.');
          }

          const closure = graphDependencyFirstClosure(graph, node);
          const builderGraph = createPreparedGraphRegistration(
            this.options.installerRoot,
            graph,
            closure,
            executions,
            graphInputDigest,
            node,
          );
          const nodeDirectory = join(this.options.installerRoot, 'content', node.packageDigest);
          const builderImage = await this.assembleImage(
            runtime,
            lease.owner,
            resolvedRuntime,
            candidateId,
            nodeDirectory,
            undefined,
            undefined,
            node.packageDigest,
            inventoryDigest(node.archive.entries),
            node.archive.entries,
            'builder',
            builderGraph,
          );
          if (!builderImage.cleanupConfirmed) {
            throw new Error('The trusted graph builder assembly cleanup was not confirmed.');
          }
          const builderReceiptPath = await sealGraphAssemblyReceipt(
            this.options.installerRoot,
            candidateId,
            node.packageDigest,
            node.packageDigest === candidate.packageDigest,
            builderImage,
            'builder',
          );
          const buildOutput = await this.executeBuild(
            runtime,
            node.manifest.build,
            resolvedRuntime,
            candidateId,
            nodeDirectory,
            builderImage.imageId,
            node.packageDigest,
          );
          const generatedOutput = await sealGraphGeneratedOutput(
            this.options.installerRoot,
            candidateId,
            node.packageDigest,
            buildOutput.digest,
            buildOutput.archive,
          );
          await assertGeneratedOutput(
            generatedOutput.directory,
            generatedOutput.inventoryPath,
            node.packageDigest,
            buildOutput.digest,
            this.options.installerRoot,
          );
          executions.set(
            node.packageDigest,
            Object.freeze({
              candidate: node,
              generatedOutput,
              generatedOutputDigest: buildOutput.digest,
              nodeBuilderImage: builderImage,
              nodeBuilderReceiptPath: builderReceiptPath,
            }),
          );
        }

        const graphOutputDigest = computeGraphBuildOutputDigest(graph, executions);
        const graphMaterial = await sealExecutableGraphMaterial(
          this.options.installerRoot,
          candidateId,
          graph,
          graphRuntime,
          graphInputDigest,
          graphOutputDigest,
          executions,
        );
        const retained = await assertSealedExecutableGraphMaterial(
          graphMaterial,
          graph,
          graphRuntime,
          this.options.installerRoot,
        );
        const rootExecution = executions.get(candidate.packageDigest);
        if (rootExecution === undefined || runtime === undefined || lease === undefined) {
          throw new Error('The executable graph root has no completed retained material.');
        }
        const finalGraph = createPreparedGraphRegistration(
          this.options.installerRoot,
          graph,
          graphDependencyFirstOrder(graph),
          executions,
          graphInputDigest,
          candidate,
          graphMaterial.digest,
        );
        const sealedImage = await this.assembleImage(
          runtime,
          lease.owner,
          graphRuntime.root,
          candidateId,
          contentDirectory,
          rootExecution.generatedOutput?.directory,
          rootExecution.generatedOutputDigest,
          candidate.packageDigest,
          inventoryDigest(candidate.archive.entries),
          candidate.archive.entries,
          'runtime',
          finalGraph,
        );
        if (!sealedImage.cleanupConfirmed) {
          throw new Error('The trusted graph runtime assembly cleanup was not confirmed.');
        }
        const runtimeReceiptPath = await sealGraphAssemblyReceipt(
          this.options.installerRoot,
          candidateId,
          candidate.packageDigest,
          true,
          sealedImage,
          'runtime',
        );

        const publication = await this.registry.publish({
          buildInputDigest: graphInputDigest,
          buildOutputDigest: graphOutputDigest,
          builderImageId: rootExecution.nodeBuilderImage?.imageId ?? null,
          builderReceiptPath: rootExecution.nodeBuilderReceiptPath ?? null,
          contentDirectory,
          generatedDirectory: rootExecution.generatedOutput?.directory ?? null,
          generatedInventoryPath: rootExecution.generatedOutput?.inventoryPath ?? null,
          graphMaterialDigest: graphMaterial.digest,
          graphMaterialPath: graphMaterial.path,
          imageId: sealedImage.imageId,
          inputInventoryPath: `${contentDirectory}.input-inventory.json`,
          manifest: candidate.manifest,
          ownerId: this.options.ownerId,
          packageDigest: candidate.packageDigest,
          resolvedLockDigest: graphRuntime.resolvedLockDigest,
          resolvedLockPath,
          runtimeReceiptPath,
          target: request.target,
        });
        await assertInstalledContent(
          publication.record,
          candidate.archive.entries,
          this.options.installerRoot,
        );
        const committedRetained = await assertExecutableGraphMaterial(
          publication.record,
          graph,
          graphRuntime,
          this.options.installerRoot,
        );
        await this.assertExistingExecutableGraphMaterial(
          publication.record,
          graph,
          graphRuntime,
          committedRetained,
          runtime,
          lease.owner,
        );
        installationResult = Object.freeze({
          record: publication.record,
          reusedExisting: !publication.inserted,
        });
      }
    } catch (error) {
      primaryFailure = error;
    }

    const contentLeaseFailures: unknown[] = [];
    try {
      await releaseContentLease();
    } catch (error) {
      contentLeaseFailures.push(error);
    }
    const finalization =
      lease === undefined
        ? { failures: Object.freeze([]) as readonly unknown[], retired: true }
        : await this.finalizeManagedLease(
            lease,
            runtime,
            factoryCreationFailed,
            factoryCreationFailed ||
              primaryFailure === undefined ||
              primaryFailure instanceof ConfirmedBuildFailure,
          );
    let stagingFailure: unknown;
    if (finalization.retired) {
      try {
        await removeOwnedStaging(stagingDirectory);
      } catch (error) {
        stagingFailure = error;
      }
    }
    throwIfFailures(primaryFailure, [
      ...contentLeaseFailures,
      ...finalization.failures,
      ...(stagingFailure === undefined ? [] : [stagingFailure]),
    ]);
    if (installationResult === undefined) {
      throw new Error('Executable graph installation ended without a result or failure.');
    }
    return installationResult;
  }

  private assertExecutableGraphFactoryCapability(): void {
    if (this.options.runtimeFactory?.supportsGraphMaterialV1 !== true) {
      throw new Error(
        'Executable dependency graphs require a trusted graph-material runtime factory.',
      );
    }
  }

  private resolveExecutableGraphRuntime(
    graph: ResolvedPackageGraph,
    target: InstallTarget,
  ): ResolvedExecutableGraphRuntime {
    const root = this.selectVariant(graph.root, target);
    if (root === undefined) {
      throw new Error('An executable graph root requires a trusted runtime variant.');
    }
    const nodes = new Map<string, ResolvedRuntime | undefined>();
    for (const node of graph.nodes) {
      const isExecutable =
        node.manifest.build !== undefined ||
        node.manifest.entrypoint !== undefined ||
        node.manifest.runtimeVariants.length > 0;
      if (!isExecutable) {
        nodes.set(node.packageDigest, undefined);
        continue;
      }
      const resolved = this.selectVariant(node, target);
      if (resolved === undefined || !sameGraphCatalog(root.catalog, resolved.catalog)) {
        throw new Error('An executable graph member does not match the root trusted catalog.');
      }
      nodes.set(node.packageDigest, resolved);
    }
    return Object.freeze({
      nodes,
      root,
      resolvedLockDigest: computeExecutableGraphResolvedLockDigest(graph, root.catalog, target),
    });
  }

  private async stageGraphSourceClosure(
    stagingDirectory: string,
    graph: ResolvedPackageGraph,
  ): Promise<void> {
    for (const node of graph.nodes) {
      const nodeStagingDirectory = join(stagingDirectory, 'nodes', node.packageDigest);
      const contentDirectory = join(this.options.installerRoot, 'content', node.packageDigest);
      await writeCandidateStaging(nodeStagingDirectory, node.archive.entries);
      await sealCandidateContent(
        this.options.installerRoot,
        nodeStagingDirectory,
        contentDirectory,
        node.archive,
        node.packageDigest,
        this.options.publicationTestHooks,
      );
    }
  }

  private async verifyExistingExecutableGraphMaterial(
    existing: DisabledInstallationRecord,
    graph: ResolvedPackageGraph,
    graphRuntime: ResolvedExecutableGraphRuntime,
    retained: RetainedExecutableGraphMaterial,
  ): Promise<void> {
    const lease = await this.buildAuthority.acquire({
      candidateId: `reuse-${randomUUID()}`,
      packageDigest: graph.root.packageDigest,
    });
    let runtime: SessionBoundRuntime | undefined;
    let primaryFailure: unknown;
    let factoryCreationFailed = false;
    try {
      runtime = await this.createSessionRuntime(lease.owner);
      await this.assertExistingExecutableGraphMaterial(
        existing,
        graph,
        graphRuntime,
        retained,
        runtime,
        lease.owner,
      );
    } catch (error) {
      primaryFailure = error;
      factoryCreationFailed = runtime === undefined;
    }
    const finalization = await this.finalizeManagedLease(
      lease,
      runtime,
      factoryCreationFailed,
      primaryFailure === undefined || primaryFailure instanceof ConfirmedBuildFailure,
    );
    throwIfFailures(primaryFailure, finalization.failures);
  }

  private async assertExistingExecutableGraphMaterial(
    record: DisabledInstallationRecord,
    graph: ResolvedPackageGraph,
    graphRuntime: ResolvedExecutableGraphRuntime,
    retained: RetainedExecutableGraphMaterial,
    sessionRuntime?: SessionBoundRuntime,
    owner?: BuildSessionOwner,
  ): Promise<void> {
    const root = graph.root;
    const rootExecution = retained.nodes.get(root.packageDigest);
    if (
      rootExecution === undefined ||
      record.buildInputDigest !== retained.graphInputDigest ||
      record.buildOutputDigest !== retained.graphOutputDigest ||
      record.graphMaterialDigest !== retained.graphMaterialDigest ||
      record.imageId === null ||
      record.resolvedLockDigest !== graphRuntime.resolvedLockDigest ||
      record.resolvedLockPath === null ||
      record.runtimeReceiptPath === null ||
      record.builderImageId !== (rootExecution.nodeBuilderImageId ?? null) ||
      record.builderReceiptPath !== (rootExecution.nodeBuilderReceiptPath ?? null) ||
      record.generatedDirectory !== (rootExecution.generatedDirectory ?? null) ||
      record.generatedInventoryPath !== (rootExecution.generatedInventoryPath ?? null)
    ) {
      throw new Error('The committed executable graph record is missing or corrupt.');
    }
    const originalCandidateId = await assertExecutableGraphResolvedLock(
      record.resolvedLockPath,
      graph,
      graphRuntime,
      this.options.installerRoot,
    );
    if (originalCandidateId !== retained.candidateId) {
      throw new Error('The committed executable graph seals disagree on their candidate identity.');
    }

    const builderReceipts = new Map<string, SealedAssemblyReceipt>();
    for (const node of graphDependencyFirstOrder(graph)) {
      const nodeExecution = retained.nodes.get(node.packageDigest);
      if (nodeExecution === undefined) {
        throw new Error('The committed executable graph is missing a retained member.');
      }
      if (node.manifest.build === undefined) {
        if (
          nodeExecution.generatedDirectory !== undefined ||
          nodeExecution.generatedOutputDigest !== undefined ||
          nodeExecution.nodeBuilderImageId !== undefined ||
          nodeExecution.nodeBuilderReceiptPath !== undefined
        ) {
          throw new Error('The no-build graph member contains unexpected retained build material.');
        }
        continue;
      }
      if (
        nodeExecution.generatedDirectory === undefined ||
        nodeExecution.generatedInventoryPath === undefined ||
        nodeExecution.generatedOutputDigest === undefined ||
        nodeExecution.nodeBuilderImageId === undefined ||
        nodeExecution.nodeBuilderReceiptPath === undefined
      ) {
        throw new Error('The built graph member is missing retained build material.');
      }
      builderReceipts.set(
        node.packageDigest,
        await readGraphAssemblyReceipt(
          nodeExecution.nodeBuilderReceiptPath,
          originalCandidateId,
          node.packageDigest,
          node.packageDigest === root.packageDigest,
          nodeExecution.nodeBuilderImageId,
          'builder',
          this.options.installerRoot,
        ),
      );
    }
    const runtimeReceipt = await readGraphAssemblyReceipt(
      record.runtimeReceiptPath,
      originalCandidateId,
      root.packageDigest,
      true,
      record.imageId,
      'runtime',
      this.options.installerRoot,
    );

    if (sessionRuntime === undefined || owner === undefined) {
      throw new Error('Executable graph verification requires a managed BuildSession runtime.');
    }
    for (const node of graphDependencyFirstOrder(graph)) {
      if (node.manifest.build === undefined) {
        continue;
      }
      const nodeExecution = retained.nodes.get(node.packageDigest)!;
      const resolvedRuntime = graphRuntime.nodes.get(node.packageDigest);
      const receipt = builderReceipts.get(node.packageDigest);
      if (resolvedRuntime === undefined || receipt === undefined) {
        throw new Error('The built graph member lacks a trusted runtime or receipt.');
      }
      const builderGraph = createRetainedGraphRegistration(
        this.options.installerRoot,
        graph,
        graphDependencyFirstClosure(graph, node),
        retained,
        node,
        undefined,
        true,
      );
      await this.verifySealedImage(
        sessionRuntime,
        owner,
        receipt,
        nodeExecution.nodeBuilderImageId!,
        node.packageDigest,
        resolvedRuntime.catalog,
        join(this.options.installerRoot, 'content', node.packageDigest),
        null,
        null,
        resolvedRuntime.resolvedLockDigest,
        inventoryDigest(node.archive.entries),
        originalCandidateId,
        'builder',
        builderGraph,
      );
    }

    const finalGraph = createRetainedGraphRegistration(
      this.options.installerRoot,
      graph,
      graphDependencyFirstOrder(graph),
      retained,
      root,
      retained.graphMaterialDigest,
    );
    await this.verifySealedImage(
      sessionRuntime,
      owner,
      runtimeReceipt,
      record.imageId,
      root.packageDigest,
      graphRuntime.root.catalog,
      join(this.options.installerRoot, 'content', root.packageDigest),
      rootExecution.generatedDirectory ?? null,
      rootExecution.generatedOutputDigest ?? null,
      graphRuntime.root.resolvedLockDigest,
      inventoryDigest(root.archive.entries),
      originalCandidateId,
      'runtime',
      finalGraph,
    );
  }

  private async fetchAndValidate(
    sourceId: string,
    readRequest?: PackageSourceReadRequest,
  ): Promise<Candidate> {
    const source = this.options.sources.get(sourceId);
    if (source === undefined)
      throw new Error('The requested package source is not in the trusted catalog.');
    if (
      source.id !== sourceId ||
      !isSha256(source.expectedSha256) ||
      !Number.isSafeInteger(source.maxBytes) ||
      source.maxBytes <= 0 ||
      source.maxBytes > INSTALL_ARCHIVE_LIMITS.transportBytes
    ) {
      throw new Error('The trusted package source catalog entry is invalid.');
    }

    const transport = Buffer.from(await source.read(readRequest));
    if (transport.byteLength > source.maxBytes || sha256(transport) !== source.expectedSha256) {
      throw new Error('The package source does not match its trusted catalog digest or size.');
    }

    const archive = readFrozenBundle(transport);
    const manifestEntry = requireFile(archive, 'qdroid.plugin.json');
    const lockEntry = requireFile(archive, 'qdroid.lock.json');
    const manifest = parseManifest(manifestEntry.bytes, this.options.supportedEngineVersion);
    assertManifestReferences(archive, manifest);
    const inputContentDigest = inventoryDigest(
      archive.entries.filter((entry) => entry.path !== 'qdroid.lock.json'),
    );
    const sourceLock = parseSourceLock(lockEntry.bytes, inputContentDigest, manifest);
    const packageDigest = inventoryDigest(archive.entries);
    return Object.freeze({
      archive,
      dependencies: manifest.dependencies,
      inputContentDigest,
      manifest,
      packageDigest,
      sourceId,
      sourceLock,
      transportDigest: archive.transportDigest,
    });
  }

  /**
   * Resolves graph metadata before the installer creates a staging directory,
   * acquires a BuildAuthority lease, or initializes a runtime. A timed-out
   * source read remains observed in `unsettledGraphReads`; another resolver in
   * this installer cannot race it while a provider settles the aborted read.
   */
  private async resolvePackageGraph(rootSourceId: string): Promise<ResolvedPackageGraph> {
    if (this.unsettledGraphReads.size > 0) {
      throw new Error('A prior trusted package graph source read is still unsettled.');
    }

    const controller = new AbortController();
    const deadline = Date.now() + GRAPH_RESOLUTION_DEADLINE_MS;
    const candidatesByKey = new Map<string, Candidate>();
    const candidatesBySource = new Map<string, Candidate>();
    const resolvedSuffixDepths = new Map<string, number>();
    const activeKeys = new Set<string>();
    let transportBytes = 0;
    let expandedBytes = 0;

    const resolveNode = async (
      sourceId: string,
      expected: Pick<PackageDependency, 'name' | 'version'> | undefined,
      depth: number,
    ): Promise<Candidate> => {
      if (depth > MAX_DEPENDENCY_DEPTH) {
        throw new Error('The package dependency graph exceeds the maximum depth.');
      }

      const expectedKey = expected === undefined ? undefined : packageDependencyKey(expected);
      if (expectedKey !== undefined && activeKeys.has(expectedKey)) {
        throw new Error('The package dependency graph contains a cycle.');
      }

      const knownBySource = candidatesBySource.get(sourceId);
      if (knownBySource !== undefined) {
        verifyExpectedDependency(knownBySource, expected);
        assertResolvedGraphDepth(
          depth,
          knownBySource,
          resolvedSuffixDepths.get(packageDependencyKey(knownBySource.manifest)),
        );
        return knownBySource;
      }

      const knownByKey = expectedKey === undefined ? undefined : candidatesByKey.get(expectedKey);
      if (knownByKey !== undefined) {
        if (knownByKey.sourceId !== sourceId) {
          throw new Error(
            'The package dependency graph binds one logical package to multiple sources.',
          );
        }
        assertResolvedGraphDepth(
          depth,
          knownByKey,
          resolvedSuffixDepths.get(packageDependencyKey(knownByKey.manifest)),
        );
        return knownByKey;
      }

      if (candidatesByKey.size >= MAX_DEPENDENCY_PACKAGES) {
        throw new Error('The package dependency graph exceeds the package limit.');
      }

      const candidate = await this.fetchGraphCandidate(sourceId, controller, deadline);
      verifyExpectedDependency(candidate, expected);
      const key = packageDependencyKey(candidate.manifest);
      if (activeKeys.has(key)) {
        throw new Error('The package dependency graph contains a cycle.');
      }

      const existing = candidatesByKey.get(key);
      if (existing !== undefined) {
        if (
          existing.sourceId !== candidate.sourceId ||
          existing.transportDigest !== candidate.transportDigest ||
          existing.packageDigest !== candidate.packageDigest
        ) {
          throw new Error(
            'The package dependency graph binds one logical package to conflicting frozen content.',
          );
        }
        assertResolvedGraphDepth(
          depth,
          existing,
          resolvedSuffixDepths.get(packageDependencyKey(existing.manifest)),
        );
        candidatesBySource.set(sourceId, existing);
        return existing;
      }

      transportBytes += candidate.archive.transport.byteLength;
      expandedBytes += candidate.archive.expandedBytes;
      if (transportBytes > MAX_GRAPH_TRANSPORT_BYTES) {
        throw new Error('The package dependency graph exceeds the transport byte limit.');
      }
      if (expandedBytes > MAX_GRAPH_EXPANDED_BYTES) {
        throw new Error('The package dependency graph exceeds the expanded byte limit.');
      }

      candidatesByKey.set(key, candidate);
      candidatesBySource.set(sourceId, candidate);
      activeKeys.add(key);
      try {
        let maximumDependencySuffixDepth = 0;
        for (const dependency of [...candidate.dependencies].sort(comparePackageDependencies)) {
          const resolvedDependency = await resolveNode(dependency.sourceId, dependency, depth + 1);
          const dependencySuffixDepth = resolvedSuffixDepths.get(
            packageDependencyKey(resolvedDependency.manifest),
          );
          if (dependencySuffixDepth === undefined) {
            throw new Error('The package dependency graph contains an unresolved shared node.');
          }
          maximumDependencySuffixDepth = Math.max(
            maximumDependencySuffixDepth,
            dependencySuffixDepth + 1,
          );
        }
        resolvedSuffixDepths.set(key, maximumDependencySuffixDepth);
      } finally {
        activeKeys.delete(key);
      }
      return candidate;
    };

    try {
      const root = await resolveNode(rootSourceId, undefined, 0);
      assertGraphDeadline(
        deadline,
        'The package dependency graph resolution exceeded its deadline.',
      );
      const nodes = Object.freeze(
        [...candidatesByKey.values()].sort((left, right) =>
          comparePackageDependencies(left.manifest, right.manifest),
        ),
      );
      const resolvedGraph = Object.freeze({
        digest: digestJson({
          nodes: nodes.map((candidate) => graphNodeIdentity(candidate)),
          schema: 'qdroid.resolved-graph/v1',
        }),
        nodes,
        root,
      });
      assertGraphDeadline(
        deadline,
        'The package dependency graph resolution exceeded its deadline.',
      );
      return resolvedGraph;
    } catch (error) {
      controller.abort();
      throw error;
    }
  }

  private async fetchGraphCandidate(
    sourceId: string,
    controller: AbortController,
    graphDeadline: number,
  ): Promise<Candidate> {
    const source = this.options.sources.get(sourceId);
    if (source === undefined) {
      throw new Error('The requested package source is not in the trusted catalog.');
    }

    const sourceDeadline = Math.min(graphDeadline, Date.now() + GRAPH_SOURCE_READ_DEADLINE_MS);
    const remainingMs = sourceDeadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error('The package dependency graph resolution exceeded its deadline.');
    }
    const fetching = this.fetchAndValidate(
      sourceId,
      Object.freeze({
        maxBytes: Math.min(source.maxBytes, INSTALL_ARCHIVE_LIMITS.transportBytes),
        signal: controller.signal,
      }),
    ).then((candidate) => {
      assertGraphDeadline(sourceDeadline, 'The package graph source read exceeded its deadline.');
      assertGraphDeadline(
        graphDeadline,
        'The package dependency graph resolution exceeded its deadline.',
      );
      return candidate;
    });
    this.unsettledGraphReads.add(fetching);
    void fetching
      .finally(() => {
        this.unsettledGraphReads.delete(fetching);
      })
      .catch(() => undefined);

    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fetching,
        new Promise<Candidate>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('The package graph source read exceeded its deadline.'));
          }, remainingMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private selectVariant(candidate: Candidate, target: InstallTarget): ResolvedRuntime | undefined {
    const { manifest } = candidate;
    if (target === 'content-only') {
      if (
        manifest.build !== undefined ||
        manifest.runtimeVariants.length > 0 ||
        manifest.entrypoint !== undefined
      ) {
        throw new Error('An executable package cannot be installed into the content-only target.');
      }
      return undefined;
    }

    const matching = manifest.runtimeVariants.filter((variant) => variant.platform === target);
    if (matching.length !== 1)
      throw new Error('The package must declare exactly one compatible runtime variant.');
    const variant = matching[0]!;
    const catalog = this.options.runtimeCatalog.get(variant.baseCatalogId);
    if (
      catalog === undefined ||
      catalog.id !== variant.baseCatalogId ||
      catalog.baseImage !== variant.image ||
      catalog.platform !== target ||
      catalog.abi !== variant.abi ||
      catalog.profile !== variant.requiredProfile ||
      variant.requiredFeatures.some((feature) => !catalog.features.includes(feature))
    ) {
      throw new Error('The requested package runtime variant is not in the trusted catalog.');
    }
    if (manifest.entrypoint === undefined)
      throw new Error('An executable package requires an entrypoint.');
    const frozenCatalog = freezeCatalogSelection(catalog);
    return Object.freeze({
      catalog: frozenCatalog,
      resolvedLockDigest: computeResolvedLockDigest(candidate, variant, frozenCatalog),
      variant,
    });
  }

  private assertContentOnlyGraph(graph: ResolvedPackageGraph): void {
    for (const node of graph.nodes) {
      const manifest = node.manifest;
      if (
        manifest.build !== undefined ||
        manifest.entrypoint !== undefined ||
        manifest.runtimeVariants.length > 0
      ) {
        throw new Error(
          'A content-only dependency graph may not contain executable package material.',
        );
      }
    }
  }

  private async executeBuild(
    runtime: SessionBoundRuntime,
    build: BuildDeclaration,
    resolvedRuntime: ResolvedRuntime,
    candidateId: string,
    packageDirectory: string,
    builderImage: string,
    packageDigest: string,
  ): Promise<{ archive: FrozenArchive; digest: string }> {
    if (runtime.buildExecutor.managesResources !== true) {
      throw new Error('The trusted offline build executor lacks managed resource ownership.');
    }
    const result = await runtime.buildExecutor.execute({
      argv: build.argv,
      builderImage,
      candidateId,
      cwd: buildContainerWorkingDirectory(build.cwd, packageDigest),
      environment: Object.freeze({ LANG: 'C.UTF-8', TZ: 'UTC' }),
      packageDirectory,
      packageDigest,
      profile: 'build-restricted',
      runtime: resolvedRuntime.catalog,
    });
    let stdout: Buffer;
    let stderr: Buffer;
    let completion: BuildExecutionCompletion;
    try {
      [stdout, stderr, completion] = await Promise.all([
        collectBounded(result.stdout, MAX_BUILD_OUTPUT_BYTES),
        collectBounded(result.stderr, 64 * 1024),
        result.completion,
      ]);
    } catch (error) {
      const cleanupConfirmed = await settleFailedBuild(result);
      if (cleanupConfirmed) {
        throw new ConfirmedBuildFailure('The offline package build stream was invalid.', {
          cause: error,
        });
      }
      throw new Error('The offline package build stream failed before cleanup was confirmed.', {
        cause: error,
      });
    }
    void stderr;
    if (!completion.cleanupConfirmed) {
      throw new Error('The offline package build cleanup was not confirmed.');
    }
    if (completion.reason !== 'completed' || completion.exitCode !== 0) {
      throw new ConfirmedBuildFailure('The offline package build did not exit zero.');
    }

    try {
      const archive = readFrozenUstar(stdout, { requirePackageMetadata: false });
      const files = archive.entries.filter((entry) => entry.type === 'file');
      if (
        files.length > MAX_BUILD_OUTPUT_FILES ||
        archive.entries.some((entry) => entry.type !== 'file')
      ) {
        throw new Error(
          'The offline package build output must contain only bounded regular files.',
        );
      }
      const decodedBytes = files.reduce((total, entry) => total + entry.bytes.byteLength, 0);
      if (decodedBytes > MAX_BUILD_OUTPUT_BYTES) {
        throw new Error('The offline package build output exceeds the decoded 8 MiB file limit.');
      }
      const actualExports = files.map((entry) => entry.path).sort();
      const declaredExports = [...build.exports].sort();
      if (
        actualExports.length !== declaredExports.length ||
        actualExports.some((value, index) => value !== declaredExports[index])
      ) {
        throw new Error(
          'The offline package build output does not match its declared generated exports.',
        );
      }
      return Object.freeze({ archive, digest: inventoryDigest(archive.entries) });
    } catch (error) {
      throw new ConfirmedBuildFailure('The offline package build produced invalid output.', {
        cause: error,
      });
    }
  }

  private async assembleImage(
    runtime: SessionBoundRuntime,
    owner: BuildSessionOwner,
    resolvedRuntime: ResolvedRuntime,
    candidateId: string,
    packageDirectory: string,
    buildOutputDirectory: string | undefined,
    generatedOutputDigest: string | undefined,
    packageDigest: string,
    sourceInventoryDigest: string,
    sourceEntries: readonly FrozenArchiveEntry[],
    purpose: ImageAssemblyRequest['purpose'],
    graph?: RegisteredPreparedGraphAssembly,
  ): Promise<ImageAssemblyResult> {
    const request = Object.freeze({
      base: resolvedRuntime.catalog,
      ...(buildOutputDirectory === undefined ? {} : { buildOutputDirectory }),
      candidateId,
      ...(generatedOutputDigest === undefined ? {} : { generatedOutputDigest }),
      ...(graph === undefined ? {} : { graph: graph.material }),
      packageDirectory,
      packageDigest,
      purpose,
      resolvedLockDigest: resolvedRuntime.resolvedLockDigest,
      sourceInventoryDigest,
    });
    registerPreparedAssemblyRequest(
      owner,
      request,
      sourceEntries,
      this.options.installerRoot,
      graph,
    );
    return runtime.imageAssembler.assemble(request);
  }

  private assertExistingCompatible(
    existing: DisabledInstallationRecord,
    packageDigest: string,
    buildInputDigest: string | null,
  ): void {
    if (
      existing.packageDigest !== packageDigest ||
      existing.buildInputDigest !== buildInputDigest
    ) {
      throw new Error(
        'The immutable installation version is already bound to different package content.',
      );
    }
  }

  private async assertExistingRuntimeMaterial(
    record: DisabledInstallationRecord,
    candidate: Candidate,
    runtime: ResolvedRuntime | undefined,
    sessionRuntime?: SessionBoundRuntime,
    owner?: BuildSessionOwner,
  ): Promise<void> {
    if (runtime === undefined) {
      if (
        record.imageId !== null ||
        record.resolvedLockPath !== null ||
        record.runtimeReceiptPath !== null ||
        record.builderImageId !== null ||
        record.builderReceiptPath !== null ||
        record.generatedDirectory !== null ||
        record.generatedInventoryPath !== null
      ) {
        throw new Error('The content-only installation record contains executable material.');
      }
      return;
    }

    if (
      record.imageId === null ||
      record.resolvedLockPath === null ||
      record.runtimeReceiptPath === null
    ) {
      throw new Error('The committed executable installation is missing sealed runtime material.');
    }
    if (sessionRuntime === undefined || owner === undefined) {
      throw new Error('Executable material verification requires a managed BuildSession runtime.');
    }
    const originalCandidateId = await assertResolvedLock(
      record.resolvedLockPath,
      candidate,
      runtime,
      this.options.installerRoot,
    );
    const runtimeReceipt = await this.readOriginalSealedImageReceipt(
      record.runtimeReceiptPath,
      record.imageId,
      candidate.packageDigest,
      originalCandidateId,
      'runtime',
    );

    if (candidate.manifest.build === undefined) {
      if (
        record.buildOutputDigest !== null ||
        record.builderImageId !== null ||
        record.builderReceiptPath !== null ||
        record.generatedDirectory !== null ||
        record.generatedInventoryPath !== null
      ) {
        throw new Error('The no-build installation record contains unexpected generated material.');
      }
      await this.verifySealedImage(
        sessionRuntime,
        owner,
        runtimeReceipt,
        record.imageId,
        candidate.packageDigest,
        runtime.catalog,
        join(this.options.installerRoot, 'content', candidate.packageDigest),
        null,
        null,
        runtime.resolvedLockDigest,
        inventoryDigest(candidate.archive.entries),
        originalCandidateId,
        'runtime',
      );
      return;
    }

    if (
      record.buildOutputDigest === null ||
      record.builderImageId === null ||
      record.builderReceiptPath === null ||
      record.generatedDirectory === null ||
      record.generatedInventoryPath === null
    ) {
      throw new Error('The committed executable installation is missing sealed build material.');
    }
    await assertGeneratedOutput(
      record.generatedDirectory,
      record.generatedInventoryPath,
      candidate.packageDigest,
      record.buildOutputDigest,
      this.options.installerRoot,
    );
    const builderReceipt = await this.readOriginalSealedImageReceipt(
      record.builderReceiptPath,
      record.builderImageId,
      candidate.packageDigest,
      originalCandidateId,
      'builder',
    );

    // Every retained source, generated-output and receipt binding is checked
    // before the first managed provider call. A malformed builder receipt must
    // not grant the otherwise-valid runtime receipt a chance to inspect an
    // image, because that inspection itself is a privileged native operation.
    await this.verifySealedImage(
      sessionRuntime,
      owner,
      runtimeReceipt,
      record.imageId,
      candidate.packageDigest,
      runtime.catalog,
      join(this.options.installerRoot, 'content', candidate.packageDigest),
      record.generatedDirectory,
      record.buildOutputDigest,
      runtime.resolvedLockDigest,
      inventoryDigest(candidate.archive.entries),
      originalCandidateId,
      'runtime',
    );
    await this.verifySealedImage(
      sessionRuntime,
      owner,
      builderReceipt,
      record.builderImageId,
      candidate.packageDigest,
      runtime.catalog,
      join(this.options.installerRoot, 'content', candidate.packageDigest),
      null,
      null,
      runtime.resolvedLockDigest,
      inventoryDigest(candidate.archive.entries),
      originalCandidateId,
      'builder',
    );
  }

  private async verifySealedImage(
    runtime: SessionBoundRuntime,
    owner: BuildSessionOwner,
    sealedReceipt: SealedAssemblyReceipt,
    imageId: string,
    packageDigest: string,
    base: TrustedImageCatalogEntry,
    packageDirectory: string,
    buildOutputDirectory: string | null,
    generatedOutputDigest: string | null,
    resolvedLockDigest: string,
    sourceInventoryDigest: string,
    originalCandidateId: string,
    purpose: ImageAssemblyRequest['purpose'],
    graph?: RegisteredPreparedGraphAssembly,
  ): Promise<void> {
    const request = Object.freeze({
      base,
      ...(buildOutputDirectory === null ? {} : { buildOutputDirectory }),
      candidateId: originalCandidateId,
      ...(generatedOutputDigest === null ? {} : { generatedOutputDigest }),
      ...(graph === undefined ? {} : { graph: graph.material }),
      imageId,
      packageDirectory,
      packageDigest,
      purpose,
      receipt: sealedReceipt.receipt,
      resolvedLockDigest,
      sourceInventoryDigest,
    });
    registerPreparedSealedImageVerification(owner, request, graph);
    await runtime.imageAssembler.verifySealed(request);
  }

  private async readOriginalSealedImageReceipt(
    receiptPath: string,
    imageId: string,
    packageDigest: string,
    originalCandidateId: string,
    purpose: ImageAssemblyRequest['purpose'],
  ): Promise<SealedAssemblyReceipt> {
    const expectedReceiptPath = join(
      this.options.installerRoot,
      'seals',
      originalCandidateId,
      `${purpose}-image-receipt.json`,
    );
    const sealedReceipt = await readSealedAssemblyReceipt(
      receiptPath,
      imageId,
      packageDigest,
      purpose,
      this.options.installerRoot,
    );
    if (receiptPath !== expectedReceiptPath || sealedReceipt.candidateId !== originalCandidateId) {
      throw new Error('The committed immutable image receipt is not bound to its original seal.');
    }
    return sealedReceipt;
  }

  private assertTrustedOptions(): void {
    if (!this.options.ownerId.match(/^[a-zA-Z0-9_.-]{1,120}$/)) {
      throw new Error('The trusted installer owner identity is invalid.');
    }
    if (!this.options.installerRoot.startsWith('/')) {
      throw new Error('The trusted installer root must be an absolute configured path.');
    }
  }

  private async createSessionRuntime(owner: BuildSessionOwner): Promise<SessionBoundRuntime> {
    if (this.options.runtimeFactory === undefined) {
      throw new Error('Executable package installation requires a session-bound trusted runtime.');
    }
    const runtime = await this.options.runtimeFactory.create(owner);
    if (runtime.buildExecutor.managesResources !== true) {
      throw new Error('The session-bound runtime lacks managed resource ownership.');
    }
    return runtime;
  }

  private async verifyExistingExecutableMaterial(
    existing: DisabledInstallationRecord,
    candidate: Candidate,
    resolvedRuntime: ResolvedRuntime,
  ): Promise<void> {
    const lease = await this.buildAuthority.acquire({
      candidateId: `reuse-${randomUUID()}`,
      packageDigest: candidate.packageDigest,
    });
    let runtime: SessionBoundRuntime | undefined;
    let primaryFailure: unknown;
    let factoryCreationFailed = false;

    try {
      runtime = await this.createSessionRuntime(lease.owner);
      await this.assertExistingRuntimeMaterial(
        existing,
        candidate,
        resolvedRuntime,
        runtime,
        lease.owner,
      );
    } catch (error) {
      primaryFailure = error;
      factoryCreationFailed = runtime === undefined;
    }

    const finalization = await this.finalizeManagedLease(
      lease,
      runtime,
      factoryCreationFailed,
      primaryFailure === undefined || primaryFailure instanceof ConfirmedBuildFailure,
    );
    throwIfFailures(primaryFailure, finalization.failures);
  }

  private async settleFailedRuntimeFactory(owner: BuildSessionOwner): Promise<void> {
    const factory = this.options.runtimeFactory;
    if (factory?.settleFailedCreate === undefined) {
      throw new Error('The trusted runtime factory did not provide failed-create settlement.');
    }
    await factory.settleFailedCreate(owner);
  }

  private async finalizeManagedLease(
    lease: BuildLease,
    runtime: SessionBoundRuntime | undefined,
    factoryCreationFailed: boolean,
    primaryFailureIsKnown: boolean,
  ): Promise<{ readonly failures: readonly unknown[]; readonly retired: boolean }> {
    const failures: unknown[] = [];
    let cleanupConfirmed = false;
    let retired = false;
    try {
      lease.seal();
    } catch (error) {
      failures.push(error);
    }

    if (factoryCreationFailed) {
      try {
        await this.settleFailedRuntimeFactory(lease.owner);
        cleanupConfirmed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (runtime !== undefined) {
      try {
        await runtime.close();
        cleanupConfirmed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (cleanupConfirmed && (primaryFailureIsKnown || factoryCreationFailed)) {
      try {
        await lease.retire();
        retired = true;
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await lease.release();
    } catch (error) {
      failures.push(error);
      retired = false;
    }
    return Object.freeze({ failures: Object.freeze(failures), retired });
  }
}

function throwIfFailures(primaryFailure: unknown, cleanupFailures: readonly unknown[]): void {
  if (primaryFailure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      'Package installation failed and managed cleanup also failed.',
    );
  }
  if (primaryFailure !== undefined) {
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Managed runtime cleanup failed.');
  }
}

class BuildAuthority {
  public constructor(
    private readonly installerRoot: string,
    private readonly ownerId: string,
    private readonly publicationTestHooks: PackageInstallerPublicationTestHooks | undefined,
    private readonly runtimeFactory: TrustedRuntimeFactory | undefined,
  ) {}

  public async acquire(input: { candidateId: string; packageDigest: string }): Promise<BuildLease> {
    const authorityDirectory = join(this.installerRoot, 'build-authority');
    const sessionsDirectory = join(authorityDirectory, 'sessions');
    const providerReadyDirectory = join(authorityDirectory, 'provider-ready');
    const providerTerminalDirectory = join(authorityDirectory, 'provider-terminals');
    const retirementDirectory = join(authorityDirectory, 'retirements');
    await mkdir(sessionsDirectory, { mode: 0o700, recursive: true });
    await mkdir(providerReadyDirectory, { mode: 0o700, recursive: true });
    await mkdir(providerTerminalDirectory, { mode: 0o700, recursive: true });
    await mkdir(retirementDirectory, { mode: 0o700, recursive: true });
    await assertPrivateDirectory(authorityDirectory);
    await assertPrivateDirectory(sessionsDirectory);
    await assertPrivateDirectory(providerReadyDirectory);
    await assertPrivateDirectory(providerTerminalDirectory);
    await assertPrivateDirectory(retirementDirectory);
    const authorityPath = join(authorityDirectory, 'authority.sqlite');
    await createPrivateAuthorityDatabaseFile(
      authorityPath,
      authorityDirectory,
      this.publicationTestHooks,
    );
    const database = new DatabaseSync(authorityPath);
    let transactionOpen = false;
    try {
      database.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      initializeBuildAuthority(database);

      const pendingSessionPaths = await readPendingBuildSessionPaths(sessionsDirectory);
      const resourceJournalKey =
        pendingSessionPaths.length === 0
          ? await readOrCreateResourceJournalKey(authorityDirectory, this.publicationTestHooks)
          : await readExistingResourceJournalKey(authorityDirectory, this.publicationTestHooks);
      await this.recoverPendingSessions({
        authorityDirectory,
        publicationTestHooks: this.publicationTestHooks,
        providerReadyDirectory,
        providerTerminalDirectory,
        resourceJournalKey,
        retirementDirectory,
        sessionPaths: pendingSessionPaths,
        sessionsDirectory,
      });

      assertBuildSessionCandidateId(input.candidateId);
      const identity = await this.captureOwnerIdentity();
      const runtimeStore = `runtime-sessions/${input.candidateId}`;
      const runtimeStateDirectory = join(authorityDirectory, runtimeStore);
      const owner = Object.freeze({
        candidateId: input.candidateId,
        identity,
        ownerId: this.ownerId,
        packageDigest: input.packageDigest,
        privateStateDirectory: runtimeStateDirectory,
        sessionId: input.candidateId,
      });
      const intent = authenticateBuildSessionIntent(
        {
          authorityKeyId: buildSessionAuthorityKeyId(resourceJournalKey),
          candidateId: input.candidateId,
          createdAt: new Date().toISOString(),
          identity,
          ownerId: this.ownerId,
          packageDigest: input.packageDigest,
          phase: 'pre-provider',
          runtimeStore,
          schema: BUILD_SESSION_INTENT_SCHEMA,
          version: 2,
        },
        resourceJournalKey,
      );
      const sessionPath = join(sessionsDirectory, `${input.candidateId}.json`);
      const providerReadyPath = join(providerReadyDirectory, `${input.candidateId}.json`);
      const providerTerminalPath = join(providerTerminalDirectory, `${input.candidateId}.json`);
      const retirementPath = join(retirementDirectory, `${input.candidateId}.json`);
      await durableWrite(sessionPath, Buffer.from(canonicalJson(intent)));
      registerBuildSessionOwner(
        owner,
        resourceJournalKey,
        async (journalAuthenticationTag) => {
          const acknowledgement = authenticateBuildSessionProviderReady(
            {
              candidateId: intent.candidateId,
              intentAuthenticationTag: intent.authenticationTag,
              journalAuthenticationTag,
              journalRelativePath: join(
                runtimeStore,
                `${intent.candidateId}.native-resources.json`,
              ),
              ownerId: intent.ownerId,
              schema: BUILD_SESSION_PROVIDER_READY_SCHEMA,
              sessionId: intent.candidateId,
              version: 1,
            },
            resourceJournalKey,
          );
          await durableWrite(providerReadyPath, Buffer.from(canonicalJson(acknowledgement)));
        },
        async (journalAuthenticationTag) => {
          const providerReady = await readBuildSessionProviderReady(
            providerReadyPath,
            intent,
            resourceJournalKey,
          );
          if (providerReady === undefined) {
            throw new Error(
              'The managed provider cannot publish a terminal before journal acknowledgement.',
            );
          }
          const terminal = authenticateBuildSessionProviderTerminal(
            {
              candidateId: intent.candidateId,
              intentAuthenticationTag: intent.authenticationTag,
              journalAuthenticationTag,
              ownerId: intent.ownerId,
              providerReadyAuthenticationTag: providerReady.authenticationTag,
              schema: BUILD_SESSION_PROVIDER_TERMINAL_SCHEMA,
              sessionId: intent.candidateId,
              version: 1,
            },
            resourceJournalKey,
          );
          await durableWrite(
            providerTerminalPath,
            Buffer.from(canonicalJson(terminal)),
            0o600,
            this.publicationTestHooks,
          );
        },
      );
      return new BuildLease(
        database,
        sessionPath,
        providerReadyPath,
        providerTerminalPath,
        retirementPath,
        intent,
        resourceJournalKey,
        owner,
        this.publicationTestHooks,
      );
    } catch (primaryError) {
      const cleanupFailures: unknown[] = [];
      if (transactionOpen) {
        try {
          database.exec('ROLLBACK');
        } catch (rollbackError) {
          cleanupFailures.push(rollbackError);
        }
      }
      try {
        database.close();
      } catch (closeError) {
        cleanupFailures.push(closeError);
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [primaryError, ...cleanupFailures],
          'The trusted build authority acquisition failed during cleanup.',
        );
      }
      if (!transactionOpen && isSqliteBusy(primaryError)) {
        throw new Error(`The trusted build authority is already in use: ${String(primaryError)}`);
      }
      throw primaryError;
    }
  }

  private async captureOwnerIdentity(): Promise<BuildSessionOwnerIdentity> {
    const captured = await this.runtimeFactory?.captureOwnerIdentity?.();
    if (captured === undefined) {
      return Object.freeze({ kind: 'synthetic-unverified' });
    }
    return validateBuildSessionOwnerIdentity(captured);
  }

  private async recoverPendingSessions(input: {
    readonly authorityDirectory: string;
    readonly publicationTestHooks: PackageInstallerPublicationTestHooks | undefined;
    readonly providerReadyDirectory: string;
    readonly providerTerminalDirectory: string;
    readonly resourceJournalKey: Buffer;
    readonly retirementDirectory: string;
    readonly sessionPaths: readonly string[];
    readonly sessionsDirectory: string;
  }): Promise<void> {
    for (const sessionPath of input.sessionPaths) {
      const intent = await readBuildSessionIntent(sessionPath, input.resourceJournalKey);
      const expectedSessionPath = join(input.sessionsDirectory, `${intent.candidateId}.json`);
      if (sessionPath !== expectedSessionPath) {
        throw new Error(
          'A pending build-session filename is not bound to its authenticated intent.',
        );
      }

      const retirementPath = join(input.retirementDirectory, `${intent.candidateId}.json`);
      const retirement = await readBuildSessionRetirement(
        retirementPath,
        intent,
        input.resourceJournalKey,
      );
      if (retirement !== undefined) {
        await resynchronizeBuildSessionRetirement(retirementPath, retirement);
        await unlink(sessionPath);
        await syncDirectory(input.sessionsDirectory);
        continue;
      }

      if (intent.identity.kind !== 'linux-verified') {
        throw new Error(
          'A synthetic-unverified build-session intent cannot authorize fresh recovery.',
        );
      }

      const providerReadyPath = join(input.providerReadyDirectory, `${intent.candidateId}.json`);
      const providerReady = await readBuildSessionProviderReady(
        providerReadyPath,
        intent,
        input.resourceJournalKey,
      );
      const providerTerminalPath = join(
        input.providerTerminalDirectory,
        `${intent.candidateId}.json`,
      );
      const providerTerminal = await readBuildSessionProviderTerminal(
        providerTerminalPath,
        intent,
        providerReady,
        input.resourceJournalKey,
      );
      const recovery = createBuildSessionRecovery({
        candidateId: intent.candidateId,
        identity: intent.identity,
        ...(providerReady === undefined
          ? {}
          : {
              journalAuthenticationTag: providerReady.journalAuthenticationTag,
              journalPath: join(input.authorityDirectory, providerReady.journalRelativePath),
            }),
        ownerId: intent.ownerId,
        packageDigest: intent.packageDigest,
        privateStateDirectory: join(input.authorityDirectory, intent.runtimeStore),
        sessionId: intent.candidateId,
        ...(providerTerminal === undefined
          ? {}
          : { terminalAuthenticationTag: providerTerminal.authenticationTag }),
      });
      const runtimeFactory = this.runtimeFactory;
      if (runtimeFactory?.recoverSession === undefined) {
        releaseBuildSessionRecovery(recovery);
        throw new Error('A prior build session requires a trusted cleanup-only recovery adapter.');
      }

      let result: BuildSessionRecoveryResult;
      try {
        result = await runtimeFactory.recoverSession(recovery);
      } finally {
        releaseBuildSessionRecovery(recovery);
      }
      if (result.status !== 'confirmed') {
        throw new Error(
          `A prior build session remains ${result.status} and blocks a new build admission.`,
        );
      }
      if (!/^[a-f0-9]{64}$/.test(result.cleanupReceiptTag)) {
        throw new Error('The trusted cleanup-only recovery result lacks an authenticated receipt.');
      }
      await writeBuildSessionRetirement({
        cleanupReceiptTag: result.cleanupReceiptTag,
        intent,
        key: input.resourceJournalKey,
        path: retirementPath,
        providerReadyAuthenticationTag: providerReady?.authenticationTag ?? null,
        providerTerminalAuthenticationTag: providerTerminal?.authenticationTag ?? null,
        reason: 'recovery-confirmed',
        testHooks: input.publicationTestHooks,
      });
      await unlink(sessionPath);
      await syncDirectory(input.sessionsDirectory);
    }
  }
}

class ConfirmedBuildFailure extends Error {}

class BuildLease {
  private released = false;
  private releasePromise: Promise<void> | undefined;
  private retired = false;
  private sealed = false;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly sessionPath: string,
    private readonly providerReadyPath: string,
    private readonly providerTerminalPath: string,
    private readonly retirementPath: string,
    private readonly intent: BuildSessionIntent,
    private readonly resourceJournalKey: Buffer,
    public readonly owner: BuildSessionOwner,
    private readonly publicationTestHooks: PackageInstallerPublicationTestHooks | undefined,
  ) {}

  /**
   * Stops new runtime/provider admission before final cleanup begins. Existing
   * tracked operations remain visible to release() until their own terminal
   * facts and durable writes have settled.
   */
  public seal(): void {
    if (this.released) {
      throw new Error('The build authority lease is already released.');
    }
    if (this.sealed) {
      return;
    }
    sealBuildSessionOwner(this.owner);
    this.sealed = true;
  }

  public async retire(): Promise<void> {
    if (this.released) throw new Error('The build authority lease is already released.');
    this.seal();
    const providerReady = await readBuildSessionProviderReady(
      this.providerReadyPath,
      this.intent,
      this.resourceJournalKey,
    );
    const providerTerminal = await readBuildSessionProviderTerminal(
      this.providerTerminalPath,
      this.intent,
      providerReady,
      this.resourceJournalKey,
    );
    if (
      this.owner.identity.kind === 'linux-verified' &&
      (providerReady === undefined || providerTerminal === undefined)
    ) {
      throw new Error(
        'The verified BuildSession never durably acknowledged and terminated its managed provider.',
      );
    }
    await writeBuildSessionRetirement({
      cleanupReceiptTag: currentOwnerCleanupReceiptTag(this.intent, this.resourceJournalKey),
      intent: this.intent,
      key: this.resourceJournalKey,
      path: this.retirementPath,
      providerReadyAuthenticationTag: providerReady?.authenticationTag ?? null,
      providerTerminalAuthenticationTag: providerTerminal?.authenticationTag ?? null,
      reason: 'current-owner',
      testHooks: this.publicationTestHooks,
    });
    await unlink(this.sessionPath);
    await syncDirectory(dirname(this.sessionPath));
    this.retired = true;
  }

  public async release(): Promise<void> {
    if (this.releasePromise !== undefined) return this.releasePromise;
    this.releasePromise = this.releaseInternal();
    return this.releasePromise;
  }

  private async releaseInternal(): Promise<void> {
    if (this.released) return;
    const failures: unknown[] = [];
    try {
      // Seal admission and wait for all raw operations before the physical
      // lease can be dropped. A persisted session may intentionally survive a
      // failed cleanup, but no late operation may recreate ownership after
      // this point.
      this.seal();
      await releaseBuildSessionOwner(this.owner);
      if (this.retired) this.database.exec('COMMIT');
      else this.database.exec('ROLLBACK');
    } catch (error) {
      failures.push(error);
      try {
        this.database.exec('ROLLBACK');
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    try {
      this.database.close();
    } catch (closeError) {
      failures.push(closeError);
    } finally {
      this.released = true;
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'The trusted build authority lease could not release.');
    }
  }
}

class ContentPublicationAuthority {
  public constructor(
    private readonly installerRoot: string,
    private readonly publicationTestHooks: PackageInstallerPublicationTestHooks | undefined,
  ) {}

  public async acquire(): Promise<ContentPublicationLease> {
    const authorityDirectory = join(this.installerRoot, 'content-publication');
    const deadline = Date.now() + CONTENT_PUBLICATION_ADMISSION_MS;
    for (;;) {
      let database: DatabaseSync | undefined;
      let transactionOpen = false;
      let beginAttempted = false;
      try {
        await mkdir(authorityDirectory, { mode: 0o700, recursive: true });
        await assertPrivateDirectory(authorityDirectory);
        const authorityPath = join(authorityDirectory, 'authority.sqlite');
        await createPrivateAuthorityDatabaseFile(
          authorityPath,
          authorityDirectory,
          this.publicationTestHooks,
        );
        database = new DatabaseSync(authorityPath);
        await assertPrivateRegularFile(authorityPath);
        database.exec('PRAGMA busy_timeout = 0');
        beginAttempted = true;
        database.exec('BEGIN IMMEDIATE');
        transactionOpen = true;
        initializeContentPublicationAuthority(database);
        return new ContentPublicationLease(database);
      } catch (primaryError) {
        const cleanupFailures: unknown[] = [];
        if (database !== undefined) {
          if (transactionOpen) {
            try {
              database.exec('ROLLBACK');
            } catch (rollbackError) {
              cleanupFailures.push(rollbackError);
            }
          }
          try {
            database.close();
          } catch (closeError) {
            cleanupFailures.push(closeError);
          }
        }
        if (cleanupFailures.length > 0) {
          throw new AggregateError(
            [primaryError, ...cleanupFailures],
            'The trusted content publication authority acquisition failed during cleanup.',
          );
        }
        const retryableBusyBegin = beginAttempted && !transactionOpen && isSqliteBusy(primaryError);
        if (!retryableBusyBegin) {
          throw primaryError;
        }
        if (Date.now() >= deadline) {
          throw new Error('The trusted content publication authority admission timed out.', {
            cause: primaryError,
          });
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
}

class ContentPublicationLease {
  private releasePromise: Promise<void> | undefined;
  private released = false;

  public constructor(private readonly database: DatabaseSync) {}

  public async release(): Promise<void> {
    if (this.releasePromise !== undefined) {
      return this.releasePromise;
    }
    this.releasePromise = this.releaseInternal();
    return this.releasePromise;
  }

  private async releaseInternal(): Promise<void> {
    if (this.released) {
      return;
    }
    const failures: unknown[] = [];
    try {
      await this.commit();
    } catch (error) {
      failures.push(error);
      try {
        this.database.exec('ROLLBACK');
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    try {
      this.database.close();
    } catch (error) {
      failures.push(error);
    } finally {
      this.released = true;
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'The trusted content publication lease release failed.');
    }
  }

  private async commit(): Promise<void> {
    const deadline = Date.now() + CONTENT_PUBLICATION_ADMISSION_MS;
    for (;;) {
      try {
        this.database.exec('COMMIT');
        return;
      } catch (error) {
        if (!isSqliteBusy(error)) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new Error('The trusted content publication lease release timed out.', {
            cause: error,
          });
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
}

class DisabledRegistry {
  public constructor(
    private readonly installerRoot: string,
    private readonly ownerId: string,
  ) {}

  public async find(
    manifest: PackageManifest,
    target: InstallTarget,
  ): Promise<DisabledInstallationRecord | undefined> {
    const database = await this.open();
    try {
      const statement = database.prepare(
        'SELECT * FROM package_versions WHERE owner_id = ? AND package_name = ? AND target = ? AND version = ?',
      );
      const row = statement.get(this.ownerId, manifest.name, target, manifest.version) as
        | RegistryRow
        | undefined;
      return row === undefined ? undefined : toRecord(row);
    } finally {
      database.close();
    }
  }

  public async publish(input: {
    buildInputDigest: string | null;
    buildOutputDigest: string | null;
    builderImageId: string | null;
    builderReceiptPath: string | null;
    contentDirectory: string;
    generatedDirectory: string | null;
    generatedInventoryPath: string | null;
    graphMaterialDigest: string | null;
    graphMaterialPath: string | null;
    imageId: string | null;
    inputInventoryPath: string;
    manifest: PackageManifest;
    ownerId: string;
    packageDigest: string;
    resolvedLockDigest: string | null;
    resolvedLockPath: string | null;
    runtimeReceiptPath: string | null;
    target: InstallTarget;
  }): Promise<PublicationResult> {
    const database = await this.open();
    const installationId = installationIdentity(input.ownerId, input.manifest.name, input.target);
    const versionRecordId = versionRecordIdentity(installationId, input.manifest.version);
    try {
      database.exec('BEGIN IMMEDIATE');
      const existing = database
        .prepare(
          'SELECT * FROM package_versions WHERE owner_id = ? AND package_name = ? AND target = ? AND version = ?',
        )
        .get(input.ownerId, input.manifest.name, input.target, input.manifest.version) as
        | RegistryRow
        | undefined;
      if (existing !== undefined) {
        const record = toRecord(existing);
        if (
          record.packageDigest !== input.packageDigest ||
          record.buildInputDigest !== input.buildInputDigest ||
          record.buildOutputDigest !== input.buildOutputDigest ||
          record.resolvedLockDigest !== input.resolvedLockDigest
        ) {
          throw new Error(
            'The immutable installation version conflicts with an existing disabled record.',
          );
        }
        database.exec('COMMIT');
        return Object.freeze({ inserted: false, record });
      }

      database
        .prepare(
          `INSERT INTO package_versions (
            owner_id, package_name, target, version, package_digest, build_input_digest,
            build_output_digest, resolved_lock_digest, content_directory, image_id, installation_id,
            version_record_id, input_inventory_path, generated_directory, generated_inventory_path,
            builder_image_id, builder_receipt_path, runtime_receipt_path, resolved_lock_path,
            graph_material_path, graph_material_digest
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.ownerId,
          input.manifest.name,
          input.target,
          input.manifest.version,
          input.packageDigest,
          input.buildInputDigest,
          input.buildOutputDigest,
          input.resolvedLockDigest,
          input.contentDirectory,
          input.imageId,
          installationId,
          versionRecordId,
          input.inputInventoryPath,
          input.generatedDirectory,
          input.generatedInventoryPath,
          input.builderImageId,
          input.builderReceiptPath,
          input.runtimeReceiptPath,
          input.resolvedLockPath,
          input.graphMaterialPath,
          input.graphMaterialDigest,
        );
      database.exec('COMMIT');
      const record = Object.freeze({
        buildInputDigest: input.buildInputDigest,
        buildOutputDigest: input.buildOutputDigest,
        builderImageId: input.builderImageId,
        builderReceiptPath: input.builderReceiptPath,
        contentDirectory: input.contentDirectory,
        generatedDirectory: input.generatedDirectory,
        generatedInventoryPath: input.generatedInventoryPath,
        graphMaterialDigest: input.graphMaterialDigest,
        graphMaterialPath: input.graphMaterialPath,
        imageId: input.imageId,
        inputInventoryPath: input.inputInventoryPath,
        installationId,
        ownerId: input.ownerId,
        packageDigest: input.packageDigest,
        packageName: input.manifest.name,
        resolvedLockDigest: input.resolvedLockDigest,
        resolvedLockPath: input.resolvedLockPath,
        runtimeReceiptPath: input.runtimeReceiptPath,
        status: 'installed-disabled',
        target: input.target,
        version: input.manifest.version,
        versionRecordId,
      });
      return Object.freeze({ inserted: true, record });
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // The transaction can already have committed before a post-commit conversion error.
      }
      throw error;
    } finally {
      database.close();
    }
  }

  private async open(): Promise<DatabaseSync> {
    const registryDirectory = join(this.installerRoot, 'registry');
    await mkdir(registryDirectory, { mode: 0o700, recursive: true });
    await assertPrivateDirectory(registryDirectory);
    const database = new DatabaseSync(join(registryDirectory, 'registry.sqlite'));
    try {
      initializeRegistry(database);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
}

function parseManifest(bytes: Buffer, supportedEngineVersion: string): PackageManifest {
  const value = parseStrictJsonBytes(bytes, { maxBytes: MAX_METADATA_BYTES, maxDepth: 64 });
  const record = requireRecord(value, 'manifest');
  const schema = requireEnum(
    record.schema,
    [PACKAGE_MANIFEST_SCHEMA, PACKAGE_GRAPH_MANIFEST_SCHEMA] as const,
    'package manifest schema',
  );
  const allowedKeys = [
    'assets',
    'build',
    'dependencies',
    'engineCompatibility',
    'entrypoint',
    'kind',
    'license',
    'name',
    'requestedCapabilities',
    'requestedResources',
    'runtimeVariants',
    'scenes',
    'schema',
    'skills',
    'version',
  ];
  assertExactKeys(record, allowedKeys);
  if (schema === PACKAGE_MANIFEST_SCHEMA && record.dependencies !== undefined) {
    throw new Error('The v0.1 package manifest may not declare dependencies.');
  }
  const kind = requireEnum(
    record.kind,
    ['application', 'renderer', 'tool'] as const,
    'manifest kind',
  );
  const name = requirePackageName(record.name);
  const version = requireSemver(record.version, 'manifest version');
  const engineCompatibility = requireString(record.engineCompatibility, 'engineCompatibility');
  if (!satisfies(supportedEngineVersion, engineCompatibility, { includePrerelease: false })) {
    throw new Error('The package engine compatibility range does not include this host.');
  }
  const entrypoint =
    record.entrypoint === undefined ? undefined : parseEntrypoint(record.entrypoint);
  const runtimeVariants =
    record.runtimeVariants === undefined ? [] : parseRuntimeVariants(record.runtimeVariants);
  if (
    (kind === 'tool' || kind === 'renderer') &&
    (entrypoint === undefined || runtimeVariants.length === 0)
  ) {
    throw new Error(
      'Tool and renderer packages require an executable runtime variant and entrypoint.',
    );
  }
  return Object.freeze({
    assets: parsePathList(record.assets, 'assets'),
    ...(record.build === undefined ? {} : { build: parseBuild(record.build) }),
    dependencies:
      schema === PACKAGE_GRAPH_MANIFEST_SCHEMA
        ? record.dependencies === undefined
          ? Object.freeze([])
          : parsePackageDependencies(record.dependencies, 'manifest dependencies')
        : Object.freeze([]),
    engineCompatibility,
    ...(entrypoint === undefined ? {} : { entrypoint }),
    kind,
    license: parseLicense(record.license),
    name,
    requestedCapabilities: parseRequestedCapabilities(record.requestedCapabilities),
    requestedResources: parseRequestedResources(record.requestedResources),
    runtimeVariants,
    scenes: parsePathList(record.scenes, 'scenes'),
    schema,
    skills: parsePathList(record.skills, 'skills'),
    version,
  });
}

function parseSourceLock(
  bytes: Buffer,
  expectedInputContentDigest: string,
  manifest: PackageManifest,
): SourceLock {
  const value = parseStrictJsonBytes(bytes, { maxBytes: MAX_METADATA_BYTES, maxDepth: 64 });
  const record = requireRecord(value, 'source lock');
  const schema = requireEnum(
    record.schema,
    [SOURCE_LOCK_SCHEMA, GRAPH_SOURCE_LOCK_SCHEMA] as const,
    'source lock schema',
  );
  assertExactKeys(record, ['dependencies', 'inputContentDigest', 'schema']);
  if (
    (manifest.schema === PACKAGE_MANIFEST_SCHEMA && schema !== SOURCE_LOCK_SCHEMA) ||
    (manifest.schema === PACKAGE_GRAPH_MANIFEST_SCHEMA && schema !== GRAPH_SOURCE_LOCK_SCHEMA)
  ) {
    throw new Error('The source lock schema does not match the package manifest schema.');
  }
  if (schema === SOURCE_LOCK_SCHEMA && record.dependencies !== undefined) {
    throw new Error('The v0.1 source lock may not declare dependencies.');
  }
  const inputContentDigest = requireDigest(
    record.inputContentDigest,
    'source lock inputContentDigest',
  );
  if (inputContentDigest !== expectedInputContentDigest) {
    throw new Error('The source lock does not bind the frozen input content digest.');
  }
  const dependencies =
    schema === GRAPH_SOURCE_LOCK_SCHEMA
      ? parsePackageDependencies(record.dependencies, 'source lock dependencies', {
          requireCanonicalOrder: true,
        })
      : Object.freeze([]);
  const canonicalManifestDependencies = [...manifest.dependencies].sort(comparePackageDependencies);
  if (!dependenciesEqual(dependencies, canonicalManifestDependencies)) {
    throw new Error('The source lock dependencies do not match the package manifest.');
  }
  return Object.freeze({ dependencies, inputContentDigest, schema });
}

function parseEntrypoint(value: JsonValue): PackageManifest['entrypoint'] {
  const record = requireRecord(value, 'entrypoint');
  assertExactKeys(record, ['executable', 'type']);
  const executable = requireString(record.executable, 'entrypoint executable');
  if (!executable.startsWith('/') || executable.includes('..') || executable.includes('\\')) {
    throw new Error('The entrypoint executable must be an absolute image path.');
  }
  return Object.freeze({
    executable,
    type: requireEnum(record.type, ['command', 'stdio-mcp'] as const, 'entrypoint type'),
  });
}

function parseRuntimeVariants(value: JsonValue): readonly RuntimeVariant[] {
  const variants = parseJsonArray(value, 'runtimeVariants');
  return Object.freeze(
    variants.map((variant) => {
      const record = requireRecord(variant, 'runtime variant');
      assertExactKeys(record, [
        'abi',
        'baseCatalogId',
        'image',
        'platform',
        'requiredFeatures',
        'requiredProfile',
      ]);
      const platform = requireEnum(
        record.platform,
        ['linux/amd64', 'linux/arm64'] as const,
        'runtime platform',
      );
      return Object.freeze({
        abi: requireString(record.abi, 'runtime ABI'),
        baseCatalogId: requireString(record.baseCatalogId, 'runtime baseCatalogId'),
        image: requireImmutableImage(record.image),
        platform,
        requiredFeatures: parseStringArray(record.requiredFeatures, 'runtime requiredFeatures'),
        requiredProfile: requireEnum(
          record.requiredProfile,
          ['build-restricted', 'render-offline', 'tool-offline'] as const,
          'runtime requiredProfile',
        ),
      });
    }),
  );
}

function parseRequestedCapabilities(value: JsonValue | undefined): readonly RequestedCapability[] {
  const capabilityIds = new Set<string>();
  const capabilities = parseJsonArray(value, 'requestedCapabilities').map((item) => {
    const record = requireRecord(item, 'requested capability');
    assertExactKeys(record, ['id', 'operations', 'resourceSelector']);
    const id = requireString(record.id, 'requested capability id');
    if (capabilityIds.has(id)) {
      throw new Error('The requestedCapabilities contain duplicate capability IDs.');
    }
    capabilityIds.add(id);

    const operations = parseStringArray(record.operations, 'requested capability operations');
    if (operations.length === 0 || new Set(operations).size !== operations.length) {
      throw new Error('Each requested capability must declare unique operations.');
    }

    const selectorRecord = requireRecordValue(record.resourceSelector, 'resource selector');
    assertExactKeys(selectorRecord, ['ids', 'type']);
    const type = requireString(selectorRecord.type, 'resource selector type');
    const ids =
      selectorRecord.ids === undefined
        ? undefined
        : parseStringArray(selectorRecord.ids, 'resource selector ids');
    if (ids !== undefined && (ids.length === 0 || new Set(ids).size !== ids.length)) {
      throw new Error('The resource selector ids must be non-empty and unique.');
    }

    return Object.freeze({
      id,
      operations,
      resourceSelector: Object.freeze({
        ...(ids === undefined ? {} : { ids }),
        type,
      }),
    });
  });
  return Object.freeze(capabilities);
}

function parseRequestedResources(value: JsonValue | undefined): RequestedResources {
  const record = requireRecordValue(value, 'requestedResources');
  assertExactKeys(record, ['deadlineMs', 'memoryMiB', 'outputBytes', 'pids', 'scratchMiB']);
  return Object.freeze({
    deadlineMs: requirePositiveInteger(record.deadlineMs, 'requestedResources deadlineMs'),
    memoryMiB: requirePositiveInteger(record.memoryMiB, 'requestedResources memoryMiB'),
    outputBytes: requirePositiveInteger(record.outputBytes, 'requestedResources outputBytes'),
    pids: requirePositiveInteger(record.pids, 'requestedResources pids'),
    scratchMiB: requirePositiveInteger(record.scratchMiB, 'requestedResources scratchMiB'),
  });
}

function parseBuild(value: JsonValue): BuildDeclaration {
  const record = requireRecord(value, 'build');
  assertExactKeys(record, ['argv', 'cwd', 'exports', 'schema']);
  if (record.schema !== BUILD_OUTPUT_SCHEMA)
    throw new Error('The package build schema is unsupported.');
  const argv = parseStringArray(record.argv, 'build argv');
  if (
    argv.length === 0 ||
    argv.length > 64 ||
    argv.some((argument) => Buffer.byteLength(argument) > 4_096)
  ) {
    throw new Error('The package build argv is outside the trusted limit.');
  }
  const cwd = requireBuildWorkingDirectory(record.cwd);
  const exports = parsePathList(record.exports, 'build exports');
  if (exports.length === 0 || exports.some((entry) => !entry.startsWith('generated/'))) {
    throw new Error('The package build must declare non-empty generated/ exports.');
  }
  if (new Set(exports).size !== exports.length)
    throw new Error('The package build exports contain duplicate paths.');
  return Object.freeze({ argv, cwd, exports });
}

function assertManifestReferences(archive: FrozenArchive, manifest: PackageManifest): void {
  const entries = new Map(archive.entries.map((entry) => [entry.path, entry]));
  if (manifest.license.startsWith('LICENSES/') && entries.get(manifest.license)?.type !== 'file') {
    throw new Error(`The package manifest references a missing license file: ${manifest.license}`);
  }
  for (const path of [...manifest.assets, ...manifest.scenes]) {
    if (entries.get(path)?.type !== 'file')
      throw new Error(`The package manifest references a missing file: ${path}`);
  }
  for (const path of manifest.skills) {
    if (
      entries.get(path)?.type !== 'directory' ||
      entries.get(`${path}/SKILL.md`)?.type !== 'file'
    ) {
      throw new Error(`The package manifest references an invalid Skill directory: ${path}`);
    }
  }
  if (
    manifest.build !== undefined &&
    archive.entries.some(
      (entry) => entry.path === 'generated' || entry.path.startsWith('generated/'),
    )
  ) {
    throw new Error('Package source files may not occupy the reserved generated/ tree.');
  }
}

async function writeCandidateStaging(
  directory: string,
  entries: readonly FrozenArchiveEntry[],
): Promise<void> {
  await removeOwnedStaging(directory);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await writeArchive(directory, entries);
}

async function sealCandidateContent(
  installerRoot: string,
  directory: string,
  destination: string,
  archive: FrozenArchive,
  packageDigest: string,
  testHooks: PackageInstallerPublicationTestHooks | undefined,
): Promise<void> {
  const existing = await pathExists(destination);
  if (existing) {
    await adoptSealedCandidateContent(destination, archive, packageDigest, installerRoot);
    return;
  }

  await createPrivateDirectoryHierarchy(dirname(destination), installerRoot);
  try {
    // APFS requires the staged root to remain writable for its directory move.
    // Its children are frozen first; the destination has no reusable inventory
    // record until the root sealing and directory sync below have completed.
    await makeFrozenTreeReadOnly(directory, false);
    await syncFrozenTree(directory);
    await rename(directory, destination);
    await testHooks?.afterContentRename?.(destination);
    await chmod(destination, 0o555);
    await syncFrozenTree(destination);
    await syncDirectory(dirname(destination));
  } catch (error) {
    // The lease excludes cooperative publishers. Any failure after admission,
    // including an unexpected destination entry, leaves the original failure
    // and material in place for a later trusted investigation.
    throw error;
  }

  await writeInputInventory(installerRoot, destination, archive.entries, packageDigest);
  await writeMaterializedInventory(installerRoot, destination, archive.entries, packageDigest);
  await writeContentReadiness(installerRoot, destination, archive.entries, packageDigest);
}

/**
 * The content-publication authority excludes cooperative publishers until their
 * immutable tree and all three sealed sidecars have settled. A lease holder can
 * therefore only adopt a fully sealed canonical destination. It never repairs
 * an incomplete or corrupt tree.
 */
async function adoptSealedCandidateContent(
  destination: string,
  archive: FrozenArchive,
  packageDigest: string,
  installerRoot: string,
): Promise<void> {
  await assertInputInventory(
    `${destination}.input-inventory.json`,
    archive.entries,
    packageDigest,
    installerRoot,
  );
  await assertMaterializedContent(destination, archive.entries, packageDigest, installerRoot);
}

async function sealGeneratedOutput(
  installerRoot: string,
  candidateId: string,
  stagingDirectory: string,
  packageDigest: string,
  outputDigest: string,
  archive: FrozenArchive,
): Promise<SealedGeneratedOutput> {
  const stagingOutput = join(stagingDirectory, 'generated-output');
  const destination = join(installerRoot, 'generated', packageDigest, outputDigest);
  const inventoryPath = `${destination}.inventory.json`;
  const generatedEntries = archive.entries.map((entry) => {
    const path = entry.path.slice('generated/'.length);
    if (path.length === 0) {
      throw new Error('The validated generated archive contains an empty output path.');
    }
    return Object.freeze({ ...entry, path });
  });

  if (await pathExists(destination)) {
    await assertGeneratedOutput(
      destination,
      inventoryPath,
      packageDigest,
      outputDigest,
      installerRoot,
    );
    return Object.freeze({ directory: destination, inventoryPath });
  }

  await writeCandidateStaging(stagingOutput, generatedEntries);
  try {
    await sealFrozenTree(stagingOutput, destination, installerRoot);
  } catch (error) {
    const destinationExists = await pathExists(destination);
    if (!isDestinationExistsRace(error) && !destinationExists) {
      throw error;
    }
    await assertGeneratedOutput(
      destination,
      inventoryPath,
      packageDigest,
      outputDigest,
      installerRoot,
    );
    return Object.freeze({ directory: destination, inventoryPath });
  }

  const inventory = Buffer.from(
    canonicalJson({
      entries: frozenInventory(archive.entries),
      outputDigest,
      packageDigest,
      schema: 'qdroid.generated-inventory/v1',
    }),
  );
  await writeSealedFile(installerRoot, inventoryPath, inventory);

  return Object.freeze({ directory: destination, inventoryPath });
}

async function sealFrozenTree(
  source: string,
  destination: string,
  installerRoot: string,
): Promise<void> {
  await createPrivateDirectoryHierarchy(dirname(destination), installerRoot);
  await makeFrozenTreeReadOnly(source, false);
  await syncFrozenTree(source);
  await rename(source, destination);
  await chmod(destination, 0o555);
  await syncFrozenTree(destination);
  await syncDirectory(dirname(destination));
}

async function sealResolvedLock(
  installerRoot: string,
  candidateId: string,
  candidate: Candidate,
  runtime: ResolvedRuntime,
): Promise<string> {
  const path = join(installerRoot, 'seals', candidateId, 'resolved-lock.json');
  const payload = Buffer.from(
    canonicalJson({
      candidateId,
      packageDigest: candidate.packageDigest,
      resolvedLockDigest: runtime.resolvedLockDigest,
      schema: 'qdroid.resolved-lock/v1',
      selection: resolvedLockSelection(candidate, runtime.variant, runtime.catalog),
    }),
  );
  await writeSealedFile(installerRoot, path, payload);
  return path;
}

async function sealAssemblyReceipt(
  installerRoot: string,
  candidateId: string,
  result: ImageAssemblyResult,
  packageDigest: string,
  purpose: ImageAssemblyRequest['purpose'],
): Promise<string> {
  const path = join(installerRoot, 'seals', candidateId, `${purpose}-image-receipt.json`);
  const payload = Buffer.from(
    canonicalJson({
      candidateId,
      imageId: result.imageId,
      packageDigest,
      purpose,
      receipt: result.receipt,
      schema: 'qdroid.image-receipt/v1',
    }),
  );
  await writeSealedFile(installerRoot, path, payload);
  return path;
}

function graphMaterialNode(
  candidate: Candidate,
  installerRoot: string,
): Readonly<Record<string, unknown>> {
  const contentDirectory = join(installerRoot, 'content', candidate.packageDigest);
  return Object.freeze({
    contentDirectory,
    dependencies: [...candidate.dependencies].sort(comparePackageDependencies).map((dependency) =>
      Object.freeze({
        name: dependency.name,
        sourceId: dependency.sourceId,
        version: dependency.version,
      }),
    ),
    generatedDirectory: null,
    generatedInventoryPath: null,
    inputContentDigest: candidate.inputContentDigest,
    inputInventoryPath: `${contentDirectory}.input-inventory.json`,
    name: candidate.manifest.name,
    nodeBuilderImageId: null,
    nodeBuilderReceiptPath: null,
    packageDigest: candidate.packageDigest,
    sourceId: candidate.sourceId,
    transportDigest: candidate.transportDigest,
    version: candidate.manifest.version,
  });
}

function graphMaterialPayload(
  candidateId: string,
  graph: ResolvedPackageGraph,
  installerRoot: string,
): Buffer {
  return Buffer.from(
    canonicalJson({
      candidateId,
      graphDigest: graph.digest,
      nodes: graph.nodes.map((candidate) => graphMaterialNode(candidate, installerRoot)),
      rootPackageDigest: graph.root.packageDigest,
      schema: 'qdroid.graph-material/v1',
    }),
  );
}

async function sealGraphMaterial(
  installerRoot: string,
  candidateId: string,
  graph: ResolvedPackageGraph,
): Promise<SealedGraphMaterial> {
  const path = join(installerRoot, 'seals', candidateId, 'graph-material.json');
  const payload = graphMaterialPayload(candidateId, graph, installerRoot);
  if (payload.byteLength > MAX_METADATA_BYTES) {
    throw new Error('The sealed graph material exceeds the 256 KiB metadata limit.');
  }
  await writeSealedFile(installerRoot, path, payload);
  return Object.freeze({ digest: sha256(payload), path });
}

async function assertGraphMaterial(
  record: DisabledInstallationRecord,
  graph: ResolvedPackageGraph,
  installerRoot: string,
): Promise<void> {
  if (record.graphMaterialPath === null || record.graphMaterialDigest === null) {
    throw new Error('The committed graph installation is missing retained graph material.');
  }
  await assertSealedGraphMaterial(
    Object.freeze({ digest: record.graphMaterialDigest, path: record.graphMaterialPath }),
    graph,
    installerRoot,
  );
}

async function assertSealedGraphMaterial(
  material: SealedGraphMaterial,
  graph: ResolvedPackageGraph,
  installerRoot: string,
): Promise<void> {
  const sealed = await readSealedObject(material.path, 'graph material', installerRoot);
  const candidateId = requireGraphMaterialCandidateId(sealed.candidateId);
  const expectedPath = join(installerRoot, 'seals', candidateId, 'graph-material.json');
  const expectedPayload = graphMaterialPayload(candidateId, graph, installerRoot);
  const actualPayload = await readFrozenMetadata(material.path, 'graph material', installerRoot);
  if (
    material.path !== expectedPath ||
    actualPayload === undefined ||
    sha256(actualPayload) !== material.digest ||
    !actualPayload.equals(expectedPayload)
  ) {
    throw new Error('The committed graph material is missing or corrupt.');
  }

  for (const candidate of graph.nodes) {
    const contentDirectory = join(installerRoot, 'content', candidate.packageDigest);
    await assertInputInventory(
      `${contentDirectory}.input-inventory.json`,
      candidate.archive.entries,
      candidate.packageDigest,
      installerRoot,
    );
    await assertMaterializedContent(
      contentDirectory,
      candidate.archive.entries,
      candidate.packageDigest,
      installerRoot,
    );
  }
}

function sameGraphCatalog(
  left: TrustedImageCatalogEntry,
  right: TrustedImageCatalogEntry,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function computeExecutableGraphResolvedLockDigest(
  graph: ResolvedPackageGraph,
  catalog: TrustedImageCatalogEntry,
  target: InstallTarget,
): string {
  return digestJson({
    catalog,
    graphDigest: graph.digest,
    nodes: graph.nodes.map((node) => ({
      build: node.manifest.build ?? null,
      packageDigest: node.packageDigest,
      runtimeVariants: node.manifest.runtimeVariants,
    })),
    schema: 'qdroid.executable-graph-resolved-lock/v1',
    target,
  });
}

function computeGraphBuildInputDigest(
  graph: ResolvedPackageGraph,
  runtime: ResolvedExecutableGraphRuntime,
): string {
  return digestJson({
    graphDigest: graph.digest,
    resolvedLockDigest: runtime.resolvedLockDigest,
    schema: 'qdroid.graph-build-input/v1',
  });
}

function graphDependencyFirstOrder(graph: ResolvedPackageGraph): readonly Candidate[] {
  return graphDependencyFirstClosure(graph, graph.root);
}

function graphDependencyFirstClosure(
  graph: ResolvedPackageGraph,
  target: Candidate,
): readonly Candidate[] {
  const byLogicalKey = new Map(
    graph.nodes.map((candidate) => [packageDependencyKey(candidate.manifest), candidate]),
  );
  const visited = new Set<string>();
  const ordered: Candidate[] = [];
  const visit = (candidate: Candidate): void => {
    if (visited.has(candidate.packageDigest)) {
      return;
    }
    visited.add(candidate.packageDigest);
    for (const dependency of [...candidate.dependencies].sort(comparePackageDependencies)) {
      const dependencyCandidate = byLogicalKey.get(packageDependencyKey(dependency));
      if (
        dependencyCandidate === undefined ||
        dependencyCandidate.sourceId !== dependency.sourceId
      ) {
        throw new Error('The resolved graph dependency closure is incomplete.');
      }
      visit(dependencyCandidate);
    }
    ordered.push(candidate);
  };
  visit(target);
  return Object.freeze(ordered);
}

function createPreparedGraphRegistration(
  installerRoot: string,
  graph: ResolvedPackageGraph,
  closure: readonly Candidate[],
  executions: ReadonlyMap<string, GraphNodeExecution>,
  graphInputDigest: string,
  step: Candidate,
  graphMaterialDigest?: string,
): RegisteredPreparedGraphAssembly {
  const preparedNodes: PreparedGraphNodeMaterial[] = [];
  const registeredNodes: RegisteredPreparedGraphNode[] = [];
  for (const node of closure) {
    const execution = executions.get(node.packageDigest);
    const material = Object.freeze({
      ...(execution?.generatedOutput === undefined
        ? {}
        : { buildOutputDirectory: execution.generatedOutput.directory }),
      ...(execution?.generatedOutputDigest === undefined
        ? {}
        : { generatedOutputDigest: execution.generatedOutputDigest }),
      packageDigest: node.packageDigest,
      packageDirectory: join(installerRoot, 'content', node.packageDigest),
      sourceInventoryDigest: inventoryDigest(node.archive.entries),
    });
    preparedNodes.push(material);
    registeredNodes.push(
      Object.freeze({ material, sourceEntries: Object.freeze([...node.archive.entries]) }),
    );
  }
  const resolvedMapping = Object.freeze(
    closure
      .map((node) =>
        Object.freeze({
          name: node.manifest.name,
          packageDigest: node.packageDigest,
          version: node.manifest.version,
        }),
      )
      .sort(comparePreparedGraphMapping),
  );
  const material = normalizePreparedGraphMaterial({
    graphInputDigest,
    ...(graphMaterialDigest === undefined ? {} : { graphMaterialDigest }),
    graphTemplateDigest: GRAPH_COPY_TEMPLATE_DIGEST,
    nodes: Object.freeze(preparedNodes),
    resolvedMapping,
    rootPackageDigest: graph.root.packageDigest,
    schema: PREPARED_GRAPH_ASSEMBLY_SCHEMA,
    stepNodePackageDigest: step.packageDigest,
  });
  return Object.freeze({ material, nodes: Object.freeze(registeredNodes) });
}

function createRetainedGraphRegistration(
  installerRoot: string,
  graph: ResolvedPackageGraph,
  closure: readonly Candidate[],
  retained: RetainedExecutableGraphMaterial,
  step: Candidate,
  graphMaterialDigest?: string,
  excludeStepGeneratedOutput = false,
): RegisteredPreparedGraphAssembly {
  const executions = new Map<string, GraphNodeExecution>();
  for (const [packageDigest, execution] of retained.nodes) {
    const omitGeneratedOutput = excludeStepGeneratedOutput && packageDigest === step.packageDigest;
    executions.set(
      packageDigest,
      Object.freeze({
        candidate: execution.candidate,
        ...(omitGeneratedOutput ||
        execution.generatedDirectory === undefined ||
        execution.generatedInventoryPath === undefined
          ? {}
          : {
              generatedOutput: Object.freeze({
                directory: execution.generatedDirectory,
                inventoryPath: execution.generatedInventoryPath,
              }),
            }),
        ...(omitGeneratedOutput || execution.generatedOutputDigest === undefined
          ? {}
          : { generatedOutputDigest: execution.generatedOutputDigest }),
      }),
    );
  }
  return createPreparedGraphRegistration(
    installerRoot,
    graph,
    closure,
    executions,
    retained.graphInputDigest,
    step,
    graphMaterialDigest,
  );
}

function comparePreparedGraphMapping(
  left: Readonly<{ name: string; version: string }>,
  right: Readonly<{ name: string; version: string }>,
): number {
  return comparePackageDependencies(left, right);
}

function computeGraphBuildOutputDigest(
  graph: ResolvedPackageGraph,
  executions: ReadonlyMap<string, GraphNodeExecution>,
): string {
  return digestJson({
    nodes: graph.nodes.map((node) => ({
      generatedOutputDigest: executions.get(node.packageDigest)?.generatedOutputDigest ?? null,
      packageDigest: node.packageDigest,
    })),
    schema: 'qdroid.graph-build-output/v1',
  });
}

function computeRetainedGraphBuildOutputDigest(
  graph: ResolvedPackageGraph,
  executions: ReadonlyMap<string, RetainedGraphNodeExecution>,
): string {
  return digestJson({
    nodes: graph.nodes.map((node) => ({
      generatedOutputDigest: executions.get(node.packageDigest)?.generatedOutputDigest ?? null,
      packageDigest: node.packageDigest,
    })),
    schema: 'qdroid.graph-build-output/v1',
  });
}

async function sealGraphGeneratedOutput(
  installerRoot: string,
  candidateId: string,
  packageDigest: string,
  outputDigest: string,
  archive: FrozenArchive,
): Promise<SealedGeneratedOutput> {
  const stagingDirectory = join(
    installerRoot,
    'candidates',
    candidateId,
    'generated',
    packageDigest,
  );
  const destination = join(
    installerRoot,
    'generated',
    'graphs',
    candidateId,
    'nodes',
    packageDigest,
    outputDigest,
  );
  const inventoryPath = `${destination}.inventory.json`;
  const entries = archive.entries.map((entry) => {
    const path = entry.path.slice('generated/'.length);
    if (path.length === 0) {
      throw new Error('The validated graph build archive contains an empty output path.');
    }
    return Object.freeze({ ...entry, path });
  });
  if (await pathExists(destination)) {
    await assertGeneratedOutput(
      destination,
      inventoryPath,
      packageDigest,
      outputDigest,
      installerRoot,
    );
    return Object.freeze({ directory: destination, inventoryPath });
  }
  await writeCandidateStaging(stagingDirectory, entries);
  await sealFrozenTree(stagingDirectory, destination, installerRoot);
  await writeSealedFile(
    installerRoot,
    inventoryPath,
    Buffer.from(
      canonicalJson({
        entries: frozenInventory(archive.entries),
        outputDigest,
        packageDigest,
        schema: 'qdroid.generated-inventory/v1',
      }),
    ),
  );
  return Object.freeze({ directory: destination, inventoryPath });
}

async function sealGraphAssemblyReceipt(
  installerRoot: string,
  candidateId: string,
  packageDigest: string,
  rootMember: boolean,
  result: ImageAssemblyResult,
  purpose: ImageAssemblyRequest['purpose'],
): Promise<string> {
  const path = rootMember
    ? join(installerRoot, 'seals', candidateId, `${purpose}-image-receipt.json`)
    : join(
        installerRoot,
        'seals',
        candidateId,
        'nodes',
        packageDigest,
        `${purpose}-image-receipt.json`,
      );
  await writeSealedFile(
    installerRoot,
    path,
    Buffer.from(
      canonicalJson({
        candidateId,
        imageId: result.imageId,
        packageDigest,
        purpose,
        receipt: result.receipt,
        schema: 'qdroid.image-receipt/v1',
      }),
    ),
  );
  return path;
}

function executableGraphMaterialNode(
  candidate: Candidate,
  execution: GraphNodeExecution | undefined,
  installerRoot: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...graphMaterialNode(candidate, installerRoot),
    generatedDirectory: execution?.generatedOutput?.directory ?? null,
    generatedInventoryPath: execution?.generatedOutput?.inventoryPath ?? null,
    generatedOutputDigest: execution?.generatedOutputDigest ?? null,
    nodeBuilderImageId: execution?.nodeBuilderImage?.imageId ?? null,
    nodeBuilderReceiptPath: execution?.nodeBuilderReceiptPath ?? null,
  });
}

function executableGraphMaterialPayload(
  candidateId: string,
  graph: ResolvedPackageGraph,
  graphRuntime: ResolvedExecutableGraphRuntime,
  graphInputDigest: string,
  graphOutputDigest: string,
  executions: ReadonlyMap<string, GraphNodeExecution>,
  installerRoot: string,
): Buffer {
  return Buffer.from(
    canonicalJson({
      candidateId,
      execution: {
        graphBuildInputDigest: graphInputDigest,
        graphBuildOutputDigest: graphOutputDigest,
        graphCopyTemplateDigest: GRAPH_COPY_TEMPLATE_DIGEST,
        graphCopyTemplateSchema: GRAPH_COPY_TEMPLATE_SCHEMA,
        resolvedLockDigest: graphRuntime.resolvedLockDigest,
        schema: 'qdroid.graph-execution/v1',
      },
      graphDigest: graph.digest,
      nodes: graph.nodes.map((node) =>
        executableGraphMaterialNode(node, executions.get(node.packageDigest), installerRoot),
      ),
      rootPackageDigest: graph.root.packageDigest,
      schema: 'qdroid.graph-material/v1',
    }),
  );
}

async function sealExecutableGraphMaterial(
  installerRoot: string,
  candidateId: string,
  graph: ResolvedPackageGraph,
  graphRuntime: ResolvedExecutableGraphRuntime,
  graphInputDigest: string,
  graphOutputDigest: string,
  executions: ReadonlyMap<string, GraphNodeExecution>,
): Promise<SealedGraphMaterial> {
  const path = join(installerRoot, 'seals', candidateId, 'graph-material.json');
  const payload = executableGraphMaterialPayload(
    candidateId,
    graph,
    graphRuntime,
    graphInputDigest,
    graphOutputDigest,
    executions,
    installerRoot,
  );
  if (payload.byteLength > MAX_METADATA_BYTES) {
    throw new Error('The sealed executable graph material exceeds the 256 KiB metadata limit.');
  }
  await writeSealedFile(installerRoot, path, payload);
  return Object.freeze({ digest: sha256(payload), path });
}

async function assertExecutableGraphMaterial(
  record: DisabledInstallationRecord,
  graph: ResolvedPackageGraph,
  graphRuntime: ResolvedExecutableGraphRuntime,
  installerRoot: string,
): Promise<RetainedExecutableGraphMaterial> {
  if (record.graphMaterialPath === null || record.graphMaterialDigest === null) {
    throw new Error('The committed executable graph is missing retained graph material.');
  }
  const retained = await assertSealedExecutableGraphMaterial(
    Object.freeze({ digest: record.graphMaterialDigest, path: record.graphMaterialPath }),
    graph,
    graphRuntime,
    installerRoot,
  );
  if (
    record.buildInputDigest !== retained.graphInputDigest ||
    record.buildOutputDigest !== retained.graphOutputDigest ||
    record.resolvedLockDigest !== graphRuntime.resolvedLockDigest
  ) {
    throw new Error('The committed executable graph registry binding is missing or corrupt.');
  }
  return retained;
}

async function assertSealedExecutableGraphMaterial(
  material: SealedGraphMaterial,
  graph: ResolvedPackageGraph,
  graphRuntime: ResolvedExecutableGraphRuntime,
  installerRoot: string,
): Promise<RetainedExecutableGraphMaterial> {
  const sealed = await readSealedObject(material.path, 'executable graph material', installerRoot);
  assertExactKeys(sealed, [
    'candidateId',
    'execution',
    'graphDigest',
    'nodes',
    'rootPackageDigest',
    'schema',
  ]);
  const candidateId = requireGraphMaterialCandidateId(sealed.candidateId);
  const expectedPath = join(installerRoot, 'seals', candidateId, 'graph-material.json');
  const bytes = await readFrozenMetadata(material.path, 'executable graph material', installerRoot);
  if (
    material.path !== expectedPath ||
    bytes === undefined ||
    sha256(bytes) !== material.digest ||
    sealed.schema !== 'qdroid.graph-material/v1' ||
    sealed.graphDigest !== graph.digest ||
    sealed.rootPackageDigest !== graph.root.packageDigest ||
    !Array.isArray(sealed.nodes)
  ) {
    throw new Error('The committed executable graph material is missing or corrupt.');
  }
  const execution = requireRecordValue(sealed.execution, 'executable graph execution');
  assertExactKeys(execution, [
    'graphBuildInputDigest',
    'graphBuildOutputDigest',
    'graphCopyTemplateDigest',
    'graphCopyTemplateSchema',
    'resolvedLockDigest',
    'schema',
  ]);
  const graphInputDigest = requireDigest(
    execution.graphBuildInputDigest,
    'executable graph build-input digest',
  );
  const graphOutputDigest = requireDigest(
    execution.graphBuildOutputDigest,
    'executable graph build-output digest',
  );
  if (
    execution.schema !== 'qdroid.graph-execution/v1' ||
    execution.graphCopyTemplateSchema !== GRAPH_COPY_TEMPLATE_SCHEMA ||
    execution.graphCopyTemplateDigest !== GRAPH_COPY_TEMPLATE_DIGEST ||
    execution.resolvedLockDigest !== graphRuntime.resolvedLockDigest ||
    graphInputDigest !== computeGraphBuildInputDigest(graph, graphRuntime) ||
    sealed.nodes.length !== graph.nodes.length
  ) {
    throw new Error('The committed executable graph execution proof is missing or corrupt.');
  }

  const retainedNodes = new Map<string, RetainedGraphNodeExecution>();
  for (const candidate of graph.nodes) {
    const raw = sealed.nodes.find(
      (entry): entry is JsonValue =>
        isJsonRecord(entry) && entry.packageDigest === candidate.packageDigest,
    );
    if (raw === undefined) {
      throw new Error('The committed executable graph is missing a retained member.');
    }
    const node = requireRecord(raw, 'executable graph member');
    assertExactKeys(node, [
      'contentDirectory',
      'dependencies',
      'generatedDirectory',
      'generatedInventoryPath',
      'generatedOutputDigest',
      'inputContentDigest',
      'inputInventoryPath',
      'name',
      'nodeBuilderImageId',
      'nodeBuilderReceiptPath',
      'packageDigest',
      'sourceId',
      'transportDigest',
      'version',
    ]);
    const staticNode = graphMaterialNode(candidate, installerRoot);
    for (const key of [
      'contentDirectory',
      'dependencies',
      'inputContentDigest',
      'inputInventoryPath',
      'name',
      'packageDigest',
      'sourceId',
      'transportDigest',
      'version',
    ]) {
      if (canonicalJson(node[key]) !== canonicalJson(staticNode[key])) {
        throw new Error('The committed executable graph member source binding is corrupt.');
      }
    }
    const hasBuild = candidate.manifest.build !== undefined;
    const generatedDirectory = node.generatedDirectory;
    const generatedInventoryPath = node.generatedInventoryPath;
    const generatedOutputDigest = node.generatedOutputDigest;
    const nodeBuilderImageId = node.nodeBuilderImageId;
    const nodeBuilderReceiptPath = node.nodeBuilderReceiptPath;
    if (!hasBuild) {
      if (
        generatedDirectory !== null ||
        generatedInventoryPath !== null ||
        generatedOutputDigest !== null ||
        nodeBuilderImageId !== null ||
        nodeBuilderReceiptPath !== null
      ) {
        throw new Error(
          'The no-build graph member contains unexpected retained execution material.',
        );
      }
      retainedNodes.set(candidate.packageDigest, Object.freeze({ candidate }));
      continue;
    }
    if (
      typeof generatedDirectory !== 'string' ||
      typeof generatedInventoryPath !== 'string' ||
      !isSha256(String(generatedOutputDigest)) ||
      !isImmutableImageId(String(nodeBuilderImageId)) ||
      typeof nodeBuilderReceiptPath !== 'string'
    ) {
      throw new Error('The built graph member is missing retained execution material.');
    }
    const expectedGeneratedDirectory = join(
      installerRoot,
      'generated',
      'graphs',
      candidateId,
      'nodes',
      candidate.packageDigest,
      String(generatedOutputDigest),
    );
    const expectedReceiptPath =
      candidate.packageDigest === graph.root.packageDigest
        ? join(installerRoot, 'seals', candidateId, 'builder-image-receipt.json')
        : join(
            installerRoot,
            'seals',
            candidateId,
            'nodes',
            candidate.packageDigest,
            'builder-image-receipt.json',
          );
    if (
      generatedDirectory !== expectedGeneratedDirectory ||
      generatedInventoryPath !== `${expectedGeneratedDirectory}.inventory.json` ||
      nodeBuilderReceiptPath !== expectedReceiptPath
    ) {
      throw new Error('The retained graph member material is not at its canonical path.');
    }
    await assertGeneratedOutput(
      generatedDirectory,
      generatedInventoryPath,
      candidate.packageDigest,
      String(generatedOutputDigest),
      installerRoot,
    );
    retainedNodes.set(
      candidate.packageDigest,
      Object.freeze({
        candidate,
        generatedDirectory,
        generatedInventoryPath,
        generatedOutputDigest: String(generatedOutputDigest),
        nodeBuilderImageId: String(nodeBuilderImageId),
        nodeBuilderReceiptPath,
      }),
    );
  }
  if (
    computeRetainedGraphBuildOutputDigest(graph, retainedNodes) !== graphOutputDigest ||
    retainedNodes.size !== graph.nodes.length
  ) {
    throw new Error('The committed executable graph output identity is corrupt.');
  }
  for (const candidate of graph.nodes) {
    const contentDirectory = join(installerRoot, 'content', candidate.packageDigest);
    await assertInputInventory(
      `${contentDirectory}.input-inventory.json`,
      candidate.archive.entries,
      candidate.packageDigest,
      installerRoot,
    );
    await assertMaterializedContent(
      contentDirectory,
      candidate.archive.entries,
      candidate.packageDigest,
      installerRoot,
    );
  }
  return Object.freeze({
    candidateId,
    graphInputDigest,
    graphMaterialDigest: material.digest,
    graphOutputDigest,
    nodes: retainedNodes,
  });
}

async function sealExecutableGraphResolvedLock(
  installerRoot: string,
  candidateId: string,
  graph: ResolvedPackageGraph,
  runtime: ResolvedExecutableGraphRuntime,
): Promise<string> {
  const path = join(installerRoot, 'seals', candidateId, 'resolved-lock.json');
  await writeSealedFile(
    installerRoot,
    path,
    Buffer.from(
      canonicalJson({
        candidateId,
        graphDigest: graph.digest,
        resolvedLockDigest: runtime.resolvedLockDigest,
        schema: 'qdroid.executable-graph-resolved-lock/v1',
      }),
    ),
  );
  return path;
}

async function assertExecutableGraphResolvedLock(
  path: string,
  graph: ResolvedPackageGraph,
  runtime: ResolvedExecutableGraphRuntime,
  installerRoot: string,
): Promise<string> {
  const record = await readSealedObject(path, 'executable graph resolved lock', installerRoot);
  assertExactKeys(record, ['candidateId', 'graphDigest', 'resolvedLockDigest', 'schema']);
  const candidateId = requireGraphMaterialCandidateId(record.candidateId);
  if (
    path !== join(installerRoot, 'seals', candidateId, 'resolved-lock.json') ||
    record.schema !== 'qdroid.executable-graph-resolved-lock/v1' ||
    record.graphDigest !== graph.digest ||
    record.resolvedLockDigest !== runtime.resolvedLockDigest
  ) {
    throw new Error('The committed executable graph resolved lock is missing or corrupt.');
  }
  return candidateId;
}

async function readGraphAssemblyReceipt(
  path: string,
  candidateId: string,
  packageDigest: string,
  rootMember: boolean,
  imageId: string,
  purpose: ImageAssemblyRequest['purpose'],
  installerRoot: string,
): Promise<SealedAssemblyReceipt> {
  const expectedPath = rootMember
    ? join(installerRoot, 'seals', candidateId, `${purpose}-image-receipt.json`)
    : join(
        installerRoot,
        'seals',
        candidateId,
        'nodes',
        packageDigest,
        `${purpose}-image-receipt.json`,
      );
  if (path !== expectedPath) {
    throw new Error('The retained graph image receipt is not at its canonical seal path.');
  }
  const receipt = await readSealedAssemblyReceipt(
    path,
    imageId,
    packageDigest,
    purpose,
    installerRoot,
  );
  if (receipt.candidateId !== candidateId) {
    throw new Error('The retained graph image receipt is not bound to its original candidate.');
  }
  return receipt;
}

function requireGraphMaterialCandidateId(value: JsonValue | undefined): string {
  const candidateId = requireString(value, 'graph material candidateId');
  if (!/^candidate-[0-9a-f-]{36}$/.test(candidateId)) {
    throw new Error('The committed graph material candidate identity is invalid.');
  }
  return candidateId;
}

async function writeSealedFile(installerRoot: string, path: string, bytes: Buffer): Promise<void> {
  await createPrivateDirectoryHierarchy(dirname(path), installerRoot);
  try {
    await durableWrite(path, bytes, 0o444);
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    await assertExistingSealedFile(path, bytes, installerRoot);
  }
  await syncDirectory(dirname(path));
}

async function writeArchive(root: string, entries: readonly FrozenArchiveEntry[]): Promise<void> {
  const directories = new Set<string>();
  for (const entry of entries.filter((item) => item.type === 'directory')) {
    directories.add(entry.path);
    await mkdir(safeDestination(root, entry.path), { mode: 0o700, recursive: true });
  }
  for (const entry of entries.filter((item) => item.type === 'file')) {
    const destination = safeDestination(root, entry.path);
    addAncestorDirectories(directories, entry.path);
    await mkdir(dirname(destination), { mode: 0o700, recursive: true });
    const file = await open(
      destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_WRONLY,
      entry.executable ? 0o555 : 0o444,
    );
    try {
      // Creation modes are filtered by the caller's umask. Freeze the inode
      // explicitly before it can become part of a durable content tree.
      await file.chmod(entry.executable ? 0o555 : 0o444);
      await file.writeFile(entry.bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  for (const directory of [...directories].sort(compareArchivePathsByDepthDescending)) {
    await chmod(safeDestination(root, directory), 0o555);
  }
  await syncDirectory(root);
}

function addAncestorDirectories(directories: Set<string>, path: string): void {
  const components = path.split('/');
  components.pop();
  while (components.length > 0) {
    directories.add(components.join('/'));
    components.pop();
  }
}

function compareArchivePathsByDepthDescending(left: string, right: string): number {
  const depthDifference = right.split('/').length - left.split('/').length;
  return depthDifference === 0 ? compareArchivePathsBytewise(left, right) : depthDifference;
}

function safeDestination(root: string, archivePath: string): string {
  const destination = resolve(root, archivePath);
  if (relative(root, destination).startsWith('..'))
    throw new Error('The archive path escapes trusted staging.');
  return destination;
}

async function collectBounded(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > limit)
      throw new Error('The offline package build stream exceeds its configured limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function settleFailedBuild(result: BuildExecutionResult): Promise<boolean> {
  try {
    await result.cancel?.();
    const completion = await result.completion;
    return completion.cleanupConfirmed;
  } catch {
    return false;
  }
}

async function durableWrite(
  path: string,
  bytes: Buffer,
  mode = 0o600,
  testHooks?: PackageInstallerPublicationTestHooks,
): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const file = await open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    mode,
  );
  const filePersistenceFailures: unknown[] = [];
  try {
    // `open(..., mode)` is subject to umask. The temporary immutable inode
    // must have its exact final mode before its contents are synced and linked
    // into a reusable metadata path.
    await file.chmod(mode);
    await file.writeFile(bytes);
    await file.sync();
    await testHooks?.afterDurableWriteFileSync?.(temporary);
  } catch (error) {
    filePersistenceFailures.push(error);
  }
  try {
    await file.close();
    await testHooks?.afterDurableWriteFileClose?.(temporary);
  } catch (error) {
    filePersistenceFailures.push(error);
  }
  throwIfDurableWriteFailures(
    filePersistenceFailures,
    'The immutable metadata write could not synchronize and close its descriptor.',
  );

  const publicationFailures: unknown[] = [];
  try {
    // `rename` replaces an existing file. A publication candidate must never
    // replace another candidate's sealed input, so link the synced immutable
    // inode into its final name instead.
    await link(temporary, path);
    await testHooks?.afterDurableWriteLink?.(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    publicationFailures.push(error);
  }
  try {
    // If cleanup of the private staging inode fails, the writer reports that
    // failure. A later candidate may only adopt the final path after it has
    // independently validated and synced the immutable bytes.
    await unlink(temporary);
    await testHooks?.afterDurableWriteTemporaryUnlink?.(temporary);
  } catch (error) {
    publicationFailures.push(error);
  }
  throwIfDurableWriteFailures(
    publicationFailures,
    'The immutable metadata write could not link and settle its staging inode.',
  );
}

function throwIfDurableWriteFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, message);
  }
}

async function assertExistingSealedFile(
  path: string,
  expected: Buffer,
  installerRoot: string,
): Promise<void> {
  const metadata = await readFrozenMetadata(path, 'sealed metadata', installerRoot);
  if (metadata === undefined || !metadata.equals(expected)) {
    throw new Error('A sealed metadata path conflicts with different immutable bytes.');
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * `mkdir({ recursive: true })` can create several directory entries. Each
 * created entry is synced with its parent before any immutable file below it
 * becomes reusable by the registry.
 */
async function createPrivateDirectoryHierarchy(path: string, installerRoot: string): Promise<void> {
  const trustedRoot = resolve(installerRoot);
  let current = resolve(path);
  if (current !== trustedRoot && !current.startsWith(`${trustedRoot}/`)) {
    throw new Error('The private installation directory escapes the configured installer root.');
  }

  await mkdir(current, { mode: 0o700, recursive: true });
  for (;;) {
    await syncDirectory(current);
    const parent = dirname(current);
    await syncDirectory(parent);
    if (current === trustedRoot) {
      return;
    }
    current = parent;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, fsConstants.O_RDONLY);
  const failures: unknown[] = [];
  try {
    await directory.sync();
  } catch (error) {
    failures.push(error);
  }
  try {
    await directory.close();
  } catch (error) {
    failures.push(error);
  }
  throwIfDurableWriteFailures(
    failures,
    'The trusted private directory could not synchronize and close its descriptor.',
  );
}

async function assertInstalledContent(
  record: DisabledInstallationRecord,
  entries: readonly FrozenArchiveEntry[],
  installerRoot: string,
): Promise<void> {
  await assertInputInventory(
    record.inputInventoryPath,
    entries,
    record.packageDigest,
    installerRoot,
  );
  await assertMaterializedContent(
    record.contentDirectory,
    entries,
    record.packageDigest,
    installerRoot,
  );
}

interface MaterializedInventoryEntry {
  readonly executable: boolean;
  readonly path: string;
  readonly type: 'directory' | 'file';
}

async function assertMaterializedContent(
  directory: string,
  entries: readonly FrozenArchiveEntry[],
  packageDigest: string,
  installerRoot: string,
): Promise<void> {
  await assertContentReadiness(directory, entries, packageDigest, installerRoot);
  const expected = materializedInventory(entries);
  const expectedRecord = Buffer.from(
    canonicalJson({ entries: expected, packageDigest, schema: 'qdroid.materialized/v1' }),
  );
  const inventoryRecord = await readFrozenMetadata(
    `${directory}.inventory.json`,
    'materialized inventory',
    installerRoot,
  );
  if (inventoryRecord === undefined || !inventoryRecord.equals(expectedRecord)) {
    throw new Error('The committed disabled installation inventory is missing or corrupt.');
  }

  const actual = await collectMaterializedInventory(directory, installerRoot);
  if (actual.length !== expected.length) {
    throw new Error('The committed disabled installation content has unexpected entries.');
  }

  for (let index = 0; index < expected.length; index += 1) {
    const expectedEntry = expected[index]!;
    const actualEntry = actual[index]!;
    if (
      actualEntry.path !== expectedEntry.path ||
      actualEntry.type !== expectedEntry.type ||
      actualEntry.executable !== expectedEntry.executable
    ) {
      throw new Error('The committed disabled installation content does not match its inventory.');
    }
    if (expectedEntry.type === 'file') {
      const sourcePath = safeDestination(directory, expectedEntry.path);
      const expectedMode = expectedEntry.executable ? 0o555 : 0o444;
      const bytes = await readFrozenFile(sourcePath, 'content file', expectedMode, installerRoot);
      const source = entries.find(
        (entry) => entry.type === 'file' && entry.path === expectedEntry.path,
      );
      if (source === undefined || bytes === undefined || sha256(bytes) !== source.digest) {
        throw new Error('The sealed content file does not match the frozen inventory.');
      }
    }
  }
}

function materializedInventory(
  entries: readonly Pick<FrozenArchiveEntry, 'executable' | 'path' | 'type'>[],
): readonly MaterializedInventoryEntry[] {
  const inventory = new Map<string, MaterializedInventoryEntry>();
  for (const entry of entries) {
    if (entry.type === 'directory') {
      inventory.set(entry.path, { executable: true, path: entry.path, type: 'directory' });
    } else {
      inventory.set(entry.path, {
        executable: entry.executable,
        path: entry.path,
        type: 'file',
      });
    }
    const components = entry.path.split('/');
    components.pop();
    while (components.length > 0) {
      const path = components.join('/');
      inventory.set(path, { executable: true, path, type: 'directory' });
      components.pop();
    }
  }
  return Object.freeze(
    [...inventory.values()].sort((left, right) =>
      compareArchivePathsBytewise(left.path, right.path),
    ),
  );
}

async function writeMaterializedInventory(
  installerRoot: string,
  directory: string,
  entries: readonly FrozenArchiveEntry[],
  packageDigest: string,
): Promise<void> {
  const inventory = materializedInventory(entries);
  const payload = Buffer.from(
    canonicalJson({ entries: inventory, packageDigest, schema: 'qdroid.materialized/v1' }),
  );
  await writeSealedFile(installerRoot, `${directory}.inventory.json`, payload);
}

function contentReadinessPayload(
  entries: readonly FrozenArchiveEntry[],
  packageDigest: string,
): Buffer {
  const input = inputInventoryPayload(entries, packageDigest);
  const materialized = Buffer.from(
    canonicalJson({
      entries: materializedInventory(entries),
      packageDigest,
      schema: 'qdroid.materialized/v1',
    }),
  );
  return Buffer.from(
    canonicalJson({
      inputInventoryDigest: sha256(input),
      materializedInventoryDigest: sha256(materialized),
      packageDigest,
      schema: 'qdroid.content-ready/v1',
    }),
  );
}

async function writeContentReadiness(
  installerRoot: string,
  directory: string,
  entries: readonly FrozenArchiveEntry[],
  packageDigest: string,
): Promise<void> {
  await writeSealedFile(
    installerRoot,
    `${directory}.ready.json`,
    contentReadinessPayload(entries, packageDigest),
  );
}

async function assertContentReadiness(
  directory: string,
  entries: readonly FrozenArchiveEntry[],
  packageDigest: string,
  installerRoot: string,
): Promise<void> {
  const actual = await readFrozenMetadata(
    `${directory}.ready.json`,
    'content readiness',
    installerRoot,
  );
  const expected = contentReadinessPayload(entries, packageDigest);
  if (actual === undefined || !actual.equals(expected)) {
    throw new Error('The committed disabled installation is not fully sealed.');
  }
}

async function collectMaterializedInventory(
  root: string,
  installerRoot?: string,
): Promise<readonly MaterializedInventoryEntry[]> {
  const entries: MaterializedInventoryEntry[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    await syncDirectory(directory);
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const relativePath =
        relativeDirectory === '' ? child.name : `${relativeDirectory}/${child.name}`;
      const absolutePath = safeDestination(root, relativePath);
      const status = await lstat(absolutePath);
      if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) {
        throw new Error(
          'The committed disabled installation content contains an unsupported entry.',
        );
      }
      if (status.isDirectory()) {
        if ((status.mode & 0o777) !== 0o555) {
          throw new Error('The committed disabled installation directory mode is invalid.');
        }
        entries.push({ executable: true, path: relativePath, type: 'directory' });
        await visit(absolutePath, relativePath);
      } else {
        const executable = (status.mode & 0o111) !== 0;
        const expectedMode = executable ? 0o555 : 0o444;
        if ((status.mode & 0o777) !== expectedMode) {
          throw new Error('The committed disabled installation file mode is invalid.');
        }
        entries.push({ executable, path: relativePath, type: 'file' });
      }
    }
  };

  const rootStatus = await lstat(root).catch(() => undefined);
  if (
    rootStatus === undefined ||
    !rootStatus.isDirectory() ||
    (rootStatus.mode & 0o777) !== 0o555
  ) {
    throw new Error(
      'The committed disabled installation content is missing and cannot be rebuilt automatically.',
    );
  }
  await visit(root, '');
  if (installerRoot !== undefined) {
    await syncDirectoryChain(root, installerRoot);
  }
  return Object.freeze(
    entries.sort((left, right) => compareArchivePathsBytewise(left.path, right.path)),
  );
}

async function syncFrozenTree(path: string): Promise<void> {
  const status = await lstat(path);
  if (status.isDirectory()) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      await syncFrozenTree(join(path, entry.name));
    }
  }
  const descriptor = await open(path, fsConstants.O_RDONLY);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

function isDestinationExistsRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
  );
}

async function readPendingBuildSessionPaths(sessionsDirectory: string): Promise<readonly string[]> {
  const entries = await readdir(sessionsDirectory, { withFileTypes: true });
  if (entries.length > MAX_PENDING_BUILD_SESSIONS) {
    throw new Error('The trusted build authority has too many pending build-session records.');
  }

  const paths: string[] = [];
  for (const entry of entries) {
    const candidateId = entry.name.endsWith('.json') ? entry.name.slice(0, -'.json'.length) : '';
    if (!entry.isFile() || !isBuildSessionCandidateId(candidateId)) {
      throw new Error('The trusted build authority contains an unexpected pending-session entry.');
    }
    paths.push(join(sessionsDirectory, entry.name));
  }
  return Object.freeze(paths.sort());
}

function isBuildSessionCandidateId(value: string): boolean {
  return /^(?:candidate|reuse)-[0-9a-f-]{36}$/.test(value);
}

function assertBuildSessionCandidateId(value: string): void {
  if (!isBuildSessionCandidateId(value)) {
    throw new Error('The trusted build-session candidate identity is invalid.');
  }
}

async function readExistingResourceJournalKey(
  authorityDirectory: string,
  testHooks: PackageInstallerPublicationTestHooks | undefined,
): Promise<Buffer> {
  const path = join(authorityDirectory, RESOURCE_JOURNAL_KEY_FILE);
  try {
    return await readDurableResourceJournalKey(path, authorityDirectory, testHooks);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(
        'Pending build-session records cannot be recovered because their authority key is missing.',
      );
    }
    throw error;
  }
}

function buildSessionAuthorityKeyId(key: Buffer): string {
  return createHmac('sha256', key)
    .update(`${BUILD_SESSION_INTENT_DOMAIN}/authority-key-id`, 'utf8')
    .digest('hex');
}

function buildSessionAuthenticationTag(
  key: Buffer,
  domain: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  return createHmac('sha256', key)
    .update(`${domain}\n${canonicalJson(payload)}`, 'utf8')
    .digest('hex');
}

function hasMatchingAuthenticationTag(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actual)) {
    return false;
  }
  const actualBytes = Buffer.from(actual, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function buildSessionIntentPayload(
  intent: Omit<BuildSessionIntent, 'authenticationTag'>,
): Readonly<Record<string, unknown>> {
  return {
    authorityKeyId: intent.authorityKeyId,
    candidateId: intent.candidateId,
    createdAt: intent.createdAt,
    identity: intent.identity,
    ownerId: intent.ownerId,
    packageDigest: intent.packageDigest,
    phase: intent.phase,
    runtimeStore: intent.runtimeStore,
    schema: intent.schema,
    version: intent.version,
  };
}

function authenticateBuildSessionIntent(
  intent: Omit<BuildSessionIntent, 'authenticationTag'>,
  key: Buffer,
): BuildSessionIntent {
  return Object.freeze({
    ...intent,
    authenticationTag: buildSessionAuthenticationTag(
      key,
      BUILD_SESSION_INTENT_DOMAIN,
      buildSessionIntentPayload(intent),
    ),
  });
}

function buildSessionProviderReadyPayload(
  ready: Omit<BuildSessionProviderReady, 'authenticationTag'>,
): Readonly<Record<string, unknown>> {
  return {
    candidateId: ready.candidateId,
    intentAuthenticationTag: ready.intentAuthenticationTag,
    journalAuthenticationTag: ready.journalAuthenticationTag,
    journalRelativePath: ready.journalRelativePath,
    ownerId: ready.ownerId,
    schema: ready.schema,
    sessionId: ready.sessionId,
    version: ready.version,
  };
}

function authenticateBuildSessionProviderReady(
  ready: Omit<BuildSessionProviderReady, 'authenticationTag'>,
  key: Buffer,
): BuildSessionProviderReady {
  return Object.freeze({
    ...ready,
    authenticationTag: buildSessionAuthenticationTag(
      key,
      BUILD_SESSION_PROVIDER_READY_DOMAIN,
      buildSessionProviderReadyPayload(ready),
    ),
  });
}

function buildSessionProviderTerminalPayload(
  terminal: Omit<BuildSessionProviderTerminal, 'authenticationTag'>,
): Readonly<Record<string, unknown>> {
  return {
    candidateId: terminal.candidateId,
    intentAuthenticationTag: terminal.intentAuthenticationTag,
    journalAuthenticationTag: terminal.journalAuthenticationTag,
    ownerId: terminal.ownerId,
    providerReadyAuthenticationTag: terminal.providerReadyAuthenticationTag,
    schema: terminal.schema,
    sessionId: terminal.sessionId,
    version: terminal.version,
  };
}

function authenticateBuildSessionProviderTerminal(
  terminal: Omit<BuildSessionProviderTerminal, 'authenticationTag'>,
  key: Buffer,
): BuildSessionProviderTerminal {
  return Object.freeze({
    ...terminal,
    authenticationTag: buildSessionAuthenticationTag(
      key,
      BUILD_SESSION_PROVIDER_TERMINAL_DOMAIN,
      buildSessionProviderTerminalPayload(terminal),
    ),
  });
}

function buildSessionRetirementPayload(
  retirement: Omit<BuildSessionRetirement, 'authenticationTag'>,
): Readonly<Record<string, unknown>> {
  return {
    candidateId: retirement.candidateId,
    cleanupReceiptTag: retirement.cleanupReceiptTag,
    intentAuthenticationTag: retirement.intentAuthenticationTag,
    ownerId: retirement.ownerId,
    providerReadyAuthenticationTag: retirement.providerReadyAuthenticationTag,
    providerTerminalAuthenticationTag: retirement.providerTerminalAuthenticationTag,
    reason: retirement.reason,
    retiredAt: retirement.retiredAt,
    schema: retirement.schema,
    sessionId: retirement.sessionId,
    version: retirement.version,
  };
}

function authenticateBuildSessionRetirement(
  retirement: Omit<BuildSessionRetirement, 'authenticationTag'>,
  key: Buffer,
): BuildSessionRetirement {
  return Object.freeze({
    ...retirement,
    authenticationTag: buildSessionAuthenticationTag(
      key,
      BUILD_SESSION_RETIREMENT_DOMAIN,
      buildSessionRetirementPayload(retirement),
    ),
  });
}

async function readOptionalPrivateSessionValue(path: string): Promise<JsonValue | undefined> {
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
  if (status.isSymbolicLink() || !status.isFile() || (status.mode & 0o077) !== 0) {
    throw new Error('The trusted build-session evidence is not a private regular file.');
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_METADATA_BYTES) {
    throw new Error('The trusted build-session evidence exceeds its fixed size limit.');
  }
  return parseStrictJsonBytes(bytes, { maxBytes: MAX_METADATA_BYTES, maxDepth: 32 });
}

async function readBuildSessionIntent(path: string, key: Buffer): Promise<BuildSessionIntent> {
  const value = await readOptionalPrivateSessionValue(path);
  if (value === undefined) {
    throw new Error('The trusted build-session intent disappeared during recovery.');
  }
  const record = requireRecord(value, 'build-session intent');
  assertExactKeys(record, [
    'authenticationTag',
    'authorityKeyId',
    'candidateId',
    'createdAt',
    'identity',
    'ownerId',
    'packageDigest',
    'phase',
    'runtimeStore',
    'schema',
    'version',
  ]);
  const intent = {
    authenticationTag: requireString(record.authenticationTag, 'build-session authentication tag'),
    authorityKeyId: requireString(record.authorityKeyId, 'build-session authority key identity'),
    candidateId: requireString(record.candidateId, 'build-session candidate identity'),
    createdAt: requireString(record.createdAt, 'build-session creation time'),
    identity: parseBuildSessionOwnerIdentity(record.identity),
    ownerId: requireString(record.ownerId, 'build-session owner identity'),
    packageDigest: requireDigest(record.packageDigest, 'build-session package digest'),
    phase: requireEnum(record.phase, ['pre-provider'] as const, 'build-session phase'),
    runtimeStore: requireString(record.runtimeStore, 'build-session runtime store'),
    schema: requireEnum(
      record.schema,
      [BUILD_SESSION_INTENT_SCHEMA] as const,
      'build-session schema',
    ),
    version: requireNonNegativeInteger(record.version, 'build-session version'),
  } as const;
  if (
    intent.version !== 2 ||
    !isBuildSessionCandidateId(intent.candidateId) ||
    !/^[A-Za-z0-9_.-]{1,120}$/.test(intent.ownerId) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(intent.createdAt) ||
    intent.runtimeStore !== `runtime-sessions/${intent.candidateId}` ||
    intent.authorityKeyId !== buildSessionAuthorityKeyId(key)
  ) {
    throw new Error('The authenticated build-session intent has an invalid trusted shape.');
  }
  const authenticated = authenticateBuildSessionIntent(
    {
      authorityKeyId: intent.authorityKeyId,
      candidateId: intent.candidateId,
      createdAt: intent.createdAt,
      identity: intent.identity,
      ownerId: intent.ownerId,
      packageDigest: intent.packageDigest,
      phase: intent.phase,
      runtimeStore: intent.runtimeStore,
      schema: intent.schema,
      version: 2,
    },
    key,
  );
  if (!hasMatchingAuthenticationTag(intent.authenticationTag, authenticated.authenticationTag)) {
    throw new Error('The authenticated build-session intent has an invalid authentication tag.');
  }
  return Object.freeze({ ...authenticated, authenticationTag: intent.authenticationTag });
}

function parseBuildSessionOwnerIdentity(value: JsonValue | undefined): BuildSessionOwnerIdentity {
  const record = requireRecord(value as JsonValue, 'build-session owner identity');
  const kind = requireEnum(
    record.kind,
    ['linux-verified', 'synthetic-unverified'] as const,
    'build-session owner identity kind',
  );
  if (kind === 'synthetic-unverified') {
    assertExactKeys(record, ['kind']);
    return Object.freeze({ kind });
  }
  assertExactKeys(record, ['bootId', 'kind', 'pid', 'processStart']);
  return validateBuildSessionOwnerIdentity({
    bootId: requireString(record.bootId, 'build-session owner boot identity'),
    kind,
    pid: requirePositiveInteger(record.pid, 'build-session owner process identity'),
    processStart: requireString(record.processStart, 'build-session owner process start'),
  });
}

function validateBuildSessionOwnerIdentity(
  value: BuildSessionOwnerIdentity,
): BuildSessionOwnerIdentity {
  if (value.kind === 'synthetic-unverified') {
    return Object.freeze({ kind: 'synthetic-unverified' });
  }
  if (
    !/^[A-Za-z0-9-]{16,128}$/.test(value.bootId) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1 ||
    !/^\d{1,32}$/.test(value.processStart)
  ) {
    throw new Error('The trusted Linux build-session owner identity is invalid.');
  }
  return Object.freeze({
    bootId: value.bootId,
    kind: 'linux-verified',
    pid: value.pid,
    processStart: value.processStart,
  });
}

async function readBuildSessionProviderReady(
  path: string,
  intent: BuildSessionIntent,
  key: Buffer,
): Promise<BuildSessionProviderReady | undefined> {
  const value = await readOptionalPrivateSessionValue(path);
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value, 'build-session provider acknowledgement');
  assertExactKeys(record, [
    'authenticationTag',
    'candidateId',
    'intentAuthenticationTag',
    'journalAuthenticationTag',
    'journalRelativePath',
    'ownerId',
    'schema',
    'sessionId',
    'version',
  ]);
  const ready = {
    authenticationTag: requireString(record.authenticationTag, 'provider acknowledgement tag'),
    candidateId: requireString(record.candidateId, 'provider acknowledgement candidate'),
    intentAuthenticationTag: requireString(record.intentAuthenticationTag, 'provider intent tag'),
    journalAuthenticationTag: requireString(
      record.journalAuthenticationTag,
      'provider journal tag',
    ),
    journalRelativePath: requireString(record.journalRelativePath, 'provider journal path'),
    ownerId: requireString(record.ownerId, 'provider acknowledgement owner'),
    schema: requireEnum(
      record.schema,
      [BUILD_SESSION_PROVIDER_READY_SCHEMA] as const,
      'provider acknowledgement schema',
    ),
    sessionId: requireString(record.sessionId, 'provider acknowledgement session'),
    version: requireNonNegativeInteger(record.version, 'provider acknowledgement version'),
  } as const;
  const expectedJournalPath = join(
    intent.runtimeStore,
    `${intent.candidateId}.native-resources.json`,
  );
  if (
    ready.version !== 1 ||
    ready.candidateId !== intent.candidateId ||
    ready.sessionId !== intent.candidateId ||
    ready.ownerId !== intent.ownerId ||
    ready.intentAuthenticationTag !== intent.authenticationTag ||
    ready.journalRelativePath !== expectedJournalPath ||
    !/^[a-f0-9]{64}$/.test(ready.journalAuthenticationTag)
  ) {
    throw new Error('The build-session provider acknowledgement is not bound to its intent.');
  }
  const authenticated = authenticateBuildSessionProviderReady(
    {
      candidateId: ready.candidateId,
      intentAuthenticationTag: ready.intentAuthenticationTag,
      journalAuthenticationTag: ready.journalAuthenticationTag,
      journalRelativePath: ready.journalRelativePath,
      ownerId: ready.ownerId,
      schema: ready.schema,
      sessionId: ready.sessionId,
      version: 1,
    },
    key,
  );
  if (!hasMatchingAuthenticationTag(ready.authenticationTag, authenticated.authenticationTag)) {
    throw new Error(
      'The build-session provider acknowledgement has an invalid authentication tag.',
    );
  }
  return Object.freeze({ ...authenticated, authenticationTag: ready.authenticationTag });
}

async function readBuildSessionProviderTerminal(
  path: string,
  intent: BuildSessionIntent,
  providerReady: BuildSessionProviderReady | undefined,
  key: Buffer,
): Promise<BuildSessionProviderTerminal | undefined> {
  const value = await readOptionalPrivateSessionValue(path);
  if (value === undefined) {
    return undefined;
  }
  if (providerReady === undefined) {
    throw new Error('A provider terminal exists without its original journal acknowledgement.');
  }
  const record = requireRecord(value, 'build-session provider terminal');
  assertExactKeys(record, [
    'authenticationTag',
    'candidateId',
    'intentAuthenticationTag',
    'journalAuthenticationTag',
    'ownerId',
    'providerReadyAuthenticationTag',
    'schema',
    'sessionId',
    'version',
  ]);
  const terminal = {
    authenticationTag: requireString(record.authenticationTag, 'provider terminal tag'),
    candidateId: requireString(record.candidateId, 'provider terminal candidate'),
    intentAuthenticationTag: requireString(
      record.intentAuthenticationTag,
      'provider terminal intent tag',
    ),
    journalAuthenticationTag: requireString(
      record.journalAuthenticationTag,
      'provider terminal journal tag',
    ),
    ownerId: requireString(record.ownerId, 'provider terminal owner'),
    providerReadyAuthenticationTag: requireString(
      record.providerReadyAuthenticationTag,
      'provider terminal acknowledgement tag',
    ),
    schema: requireEnum(
      record.schema,
      [BUILD_SESSION_PROVIDER_TERMINAL_SCHEMA] as const,
      'provider terminal schema',
    ),
    sessionId: requireString(record.sessionId, 'provider terminal session'),
    version: requireNonNegativeInteger(record.version, 'provider terminal version'),
  } as const;
  if (
    terminal.version !== 1 ||
    terminal.candidateId !== intent.candidateId ||
    terminal.sessionId !== intent.candidateId ||
    terminal.ownerId !== intent.ownerId ||
    terminal.intentAuthenticationTag !== intent.authenticationTag ||
    terminal.providerReadyAuthenticationTag !== providerReady.authenticationTag ||
    !/^[a-f0-9]{64}$/.test(terminal.journalAuthenticationTag)
  ) {
    throw new Error('The build-session provider terminal is not bound to its original session.');
  }
  const authenticated = authenticateBuildSessionProviderTerminal(
    {
      candidateId: terminal.candidateId,
      intentAuthenticationTag: terminal.intentAuthenticationTag,
      journalAuthenticationTag: terminal.journalAuthenticationTag,
      ownerId: terminal.ownerId,
      providerReadyAuthenticationTag: terminal.providerReadyAuthenticationTag,
      schema: terminal.schema,
      sessionId: terminal.sessionId,
      version: 1,
    },
    key,
  );
  if (!hasMatchingAuthenticationTag(terminal.authenticationTag, authenticated.authenticationTag)) {
    throw new Error('The build-session provider terminal has an invalid authentication tag.');
  }
  return Object.freeze({ ...authenticated, authenticationTag: terminal.authenticationTag });
}

async function readBuildSessionRetirement(
  path: string,
  intent: BuildSessionIntent,
  key: Buffer,
): Promise<BuildSessionRetirement | undefined> {
  const value = await readOptionalPrivateSessionValue(path);
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value, 'build-session retirement receipt');
  assertExactKeys(record, [
    'authenticationTag',
    'candidateId',
    'cleanupReceiptTag',
    'intentAuthenticationTag',
    'ownerId',
    'providerReadyAuthenticationTag',
    'providerTerminalAuthenticationTag',
    'reason',
    'retiredAt',
    'schema',
    'sessionId',
    'version',
  ]);
  const retirement = {
    authenticationTag: requireString(record.authenticationTag, 'retirement authentication tag'),
    candidateId: requireString(record.candidateId, 'retirement candidate identity'),
    cleanupReceiptTag: requireString(record.cleanupReceiptTag, 'retirement cleanup receipt tag'),
    intentAuthenticationTag: requireString(record.intentAuthenticationTag, 'retirement intent tag'),
    ownerId: requireString(record.ownerId, 'retirement owner identity'),
    providerReadyAuthenticationTag:
      record.providerReadyAuthenticationTag === null
        ? null
        : requireString(
            record.providerReadyAuthenticationTag,
            'retirement provider acknowledgement tag',
          ),
    providerTerminalAuthenticationTag:
      record.providerTerminalAuthenticationTag === null
        ? null
        : requireString(
            record.providerTerminalAuthenticationTag,
            'retirement provider terminal tag',
          ),
    reason: requireEnum(
      record.reason,
      ['current-owner', 'recovery-confirmed'] as const,
      'retirement reason',
    ),
    retiredAt: requireString(record.retiredAt, 'retirement time'),
    schema: requireEnum(
      record.schema,
      [BUILD_SESSION_RETIREMENT_SCHEMA] as const,
      'retirement schema',
    ),
    sessionId: requireString(record.sessionId, 'retirement session identity'),
    version: requireNonNegativeInteger(record.version, 'retirement version'),
  } as const;
  if (
    retirement.version !== 1 ||
    retirement.candidateId !== intent.candidateId ||
    retirement.sessionId !== intent.candidateId ||
    retirement.ownerId !== intent.ownerId ||
    retirement.intentAuthenticationTag !== intent.authenticationTag ||
    !/^[a-f0-9]{64}$/.test(retirement.cleanupReceiptTag) ||
    (retirement.providerReadyAuthenticationTag !== null &&
      !/^[a-f0-9]{64}$/.test(retirement.providerReadyAuthenticationTag)) ||
    (retirement.providerTerminalAuthenticationTag !== null &&
      !/^[a-f0-9]{64}$/.test(retirement.providerTerminalAuthenticationTag))
  ) {
    throw new Error('The build-session retirement receipt is not bound to its intent.');
  }
  const authenticated = authenticateBuildSessionRetirement(
    {
      candidateId: retirement.candidateId,
      cleanupReceiptTag: retirement.cleanupReceiptTag,
      intentAuthenticationTag: retirement.intentAuthenticationTag,
      ownerId: retirement.ownerId,
      providerReadyAuthenticationTag: retirement.providerReadyAuthenticationTag,
      providerTerminalAuthenticationTag: retirement.providerTerminalAuthenticationTag,
      reason: retirement.reason,
      retiredAt: retirement.retiredAt,
      schema: retirement.schema,
      sessionId: retirement.sessionId,
      version: 1,
    },
    key,
  );
  if (
    !hasMatchingAuthenticationTag(retirement.authenticationTag, authenticated.authenticationTag)
  ) {
    throw new Error('The build-session retirement receipt has an invalid authentication tag.');
  }
  return Object.freeze({ ...authenticated, authenticationTag: retirement.authenticationTag });
}

async function writeBuildSessionRetirement(input: {
  readonly cleanupReceiptTag: string;
  readonly intent: BuildSessionIntent;
  readonly key: Buffer;
  readonly path: string;
  readonly providerReadyAuthenticationTag: string | null;
  readonly providerTerminalAuthenticationTag: string | null;
  readonly reason: BuildSessionRetirement['reason'];
  readonly testHooks: PackageInstallerPublicationTestHooks | undefined;
}): Promise<void> {
  const retirement = authenticateBuildSessionRetirement(
    {
      candidateId: input.intent.candidateId,
      cleanupReceiptTag: input.cleanupReceiptTag,
      intentAuthenticationTag: input.intent.authenticationTag,
      ownerId: input.intent.ownerId,
      providerReadyAuthenticationTag: input.providerReadyAuthenticationTag,
      providerTerminalAuthenticationTag: input.providerTerminalAuthenticationTag,
      reason: input.reason,
      retiredAt: new Date().toISOString(),
      schema: BUILD_SESSION_RETIREMENT_SCHEMA,
      sessionId: input.intent.candidateId,
      version: 1,
    },
    input.key,
  );
  await durableWrite(input.path, Buffer.from(canonicalJson(retirement)), 0o600, input.testHooks);
}

async function resynchronizeBuildSessionRetirement(
  path: string,
  retirement: BuildSessionRetirement,
): Promise<void> {
  const expected = Buffer.from(canonicalJson(retirement));
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o077) !== 0) {
    throw new Error('The retained build-session retirement receipt is not a private regular file.');
  }

  const descriptor = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const failures: unknown[] = [];
  try {
    const opened = await descriptor.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (opened.mode & 0o077) !== 0
    ) {
      throw new Error('The retained build-session retirement receipt changed while it was opened.');
    }
    const bytes = await descriptor.readFile();
    if (!bytes.equals(expected)) {
      throw new Error(
        'The retained build-session retirement receipt changed before it was resynchronized.',
      );
    }
    await descriptor.sync();
  } catch (error) {
    failures.push(error);
  }
  try {
    await descriptor.close();
  } catch (error) {
    failures.push(error);
  }
  throwIfDurableWriteFailures(
    failures,
    'The retained build-session retirement receipt could not synchronize and close its descriptor.',
  );

  const after = await lstat(path);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    (after.mode & 0o077) !== 0
  ) {
    throw new Error(
      'The retained build-session retirement receipt changed before directory synchronization.',
    );
  }
  await syncDirectory(dirname(path));
}

function currentOwnerCleanupReceiptTag(intent: BuildSessionIntent, key: Buffer): string {
  return buildSessionAuthenticationTag(key, `${BUILD_SESSION_RETIREMENT_DOMAIN}/current-owner`, {
    intentAuthenticationTag: intent.authenticationTag,
    sessionId: intent.candidateId,
  });
}

function createBuildSessionRecovery(details: BuildSessionRecoveryDetails): BuildSessionRecovery {
  const recovery = Object.freeze({
    __buildSessionRecoveryBrand: Symbol('build-session-recovery'),
  }) as unknown as BuildSessionRecovery;
  registeredBuildSessionRecoveries.set(recovery, Object.freeze({ ...details }));
  return recovery;
}

function releaseBuildSessionRecovery(recovery: BuildSessionRecovery): void {
  registeredBuildSessionRecoveries.delete(recovery);
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /database is (?:locked|busy)/i.test(error.message);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isDirectory() || (status.mode & 0o077) !== 0) {
    throw new Error('The trusted installer directory is not private.');
  }
}

async function createPrivateAuthorityDatabaseFile(
  path: string,
  authorityDirectory: string,
  testHooks: PackageInstallerPublicationTestHooks | undefined,
): Promise<void> {
  try {
    await assertPrivateRegularFile(path);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    let descriptor;
    try {
      descriptor = await open(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
    } catch (creationError) {
      if (!isAlreadyExistsError(creationError)) {
        throw creationError;
      }
      await assertPrivateRegularFile(path);
      return;
    }

    const persistenceFailures: unknown[] = [];
    try {
      await descriptor.sync();
      await testHooks?.afterAuthorityDatabaseSync?.(path);
    } catch (syncError) {
      persistenceFailures.push(syncError);
    }
    try {
      await descriptor.close();
      await testHooks?.afterAuthorityDatabaseClose?.(path);
    } catch (closeError) {
      persistenceFailures.push(closeError);
    }
    if (persistenceFailures.length === 1) {
      throw persistenceFailures[0];
    }
    if (persistenceFailures.length > 1) {
      throw new AggregateError(
        persistenceFailures,
        'The trusted authority database creation could not synchronize and close its file.',
      );
    }
    await syncDirectory(authorityDirectory);
  }
  await assertPrivateRegularFile(path);
}

async function assertPrivateRegularFile(path: string): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isFile() || (status.mode & 0o077) !== 0) {
    throw new Error('The trusted authority database is not a private regular file.');
  }
}

async function readOrCreateResourceJournalKey(
  authorityDirectory: string,
  testHooks: PackageInstallerPublicationTestHooks | undefined,
): Promise<Buffer> {
  const path = join(authorityDirectory, RESOURCE_JOURNAL_KEY_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await readDurableResourceJournalKey(path, authorityDirectory, testHooks);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    let descriptor;
    try {
      descriptor = await open(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        continue;
      }
      throw error;
    }

    const key = randomBytes(32);
    const persistenceFailures: unknown[] = [];
    try {
      await descriptor.chmod(0o600);
      await descriptor.writeFile(key);
      await descriptor.sync();
      await testHooks?.afterResourceJournalKeyFileSync?.(path);
    } catch (error) {
      persistenceFailures.push(error);
    }
    try {
      await descriptor.close();
    } catch (error) {
      persistenceFailures.push(error);
    }
    if (persistenceFailures.length === 1) {
      throw persistenceFailures[0];
    }
    if (persistenceFailures.length > 1) {
      throw new AggregateError(
        persistenceFailures,
        'Resource journal key persistence and descriptor close both failed.',
      );
    }
    await syncDirectory(authorityDirectory);
    // Reopen and resynchronize the existing inode before use. This avoids
    // treating the bytes written above as durable when a prior file or
    // directory synchronization failed after creation.
  }
  throw new Error('The trusted resource journal key could not be created or read.');
}

async function readDurableResourceJournalKey(
  path: string,
  authorityDirectory: string,
  testHooks: PackageInstallerPublicationTestHooks | undefined,
): Promise<Buffer> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o777) !== 0o600) {
    throw new Error('The trusted resource journal key is not a private regular file.');
  }

  const descriptor = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const failures: unknown[] = [];
  let key: Buffer | undefined;
  try {
    const opened = await descriptor.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (opened.mode & 0o777) !== 0o600
    ) {
      throw new Error('The trusted resource journal key changed while it was opened.');
    }
    key = await descriptor.readFile();
    if (key.byteLength !== 32) {
      throw new Error('The trusted resource journal key has an invalid length.');
    }
    await descriptor.sync();
    await testHooks?.afterResourceJournalKeyFileSync?.(path);
  } catch (error) {
    failures.push(error);
  }
  try {
    await descriptor.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'The trusted resource journal key could not synchronize and close its descriptor.',
    );
  }

  const after = await lstat(path);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    (after.mode & 0o777) !== 0o600
  ) {
    throw new Error('The trusted resource journal key changed before directory synchronization.');
  }
  await syncDirectory(authorityDirectory);
  return key as Buffer;
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function removeOwnedStaging(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    return;
  }

  await makeOwnedTreeWritable(path);
  await removeOwnedTree(path);
}

async function makeOwnedTreeWritable(path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isDirectory()) {
    await chmod(path, 0o600);
    return;
  }

  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    await makeOwnedTreeWritable(join(path, entry.name));
  }
}

async function removeOwnedTree(path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isDirectory()) {
    await unlink(path);
    return;
  }

  for (const entry of await readdir(path, { withFileTypes: true })) {
    await removeOwnedTree(join(path, entry.name));
  }
  try {
    await rmdir(path);
  } catch (error) {
    const [status, parentStatus] = await Promise.all([lstat(path), lstat(dirname(path))]);
    throw new Error(
      `The owned staging directory removal failed with directory ${status.mode & 0o777} and parent ${parentStatus.mode & 0o777}: ${String(error)}`,
    );
  }
}

async function makeFrozenTreeReadOnly(path: string, freezeRoot = true): Promise<void> {
  const status = await lstat(path);
  if (!status.isDirectory()) {
    await chmod(path, (status.mode & 0o111) === 0 ? 0o444 : 0o555);
    return;
  }

  for (const entry of await readdir(path, { withFileTypes: true })) {
    await makeFrozenTreeReadOnly(join(path, entry.name));
  }
  if (freezeRoot) {
    await chmod(path, 0o555);
  }
}

function initializeBuildAuthority(database: DatabaseSync): void {
  const schemaObjects = readUserSchemaObjects(database);
  if (schemaObjects.length === 0) {
    database.exec(`
      CREATE TABLE build_authority_metadata (
        schema_name TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL
      ) STRICT;
    `);
    database
      .prepare('INSERT INTO build_authority_metadata (schema_name, schema_version) VALUES (?, ?)')
      .run('schema', BUILD_AUTHORITY_SCHEMA);
    return;
  }

  const metadataObject = readSchemaObject(database, 'build_authority_metadata');
  if (schemaObjects.length !== 1 || metadataObject?.type !== 'table') {
    throw new Error('The build authority database schema is unsupported.');
  }

  const columns = database
    .prepare('PRAGMA table_info(build_authority_metadata)')
    .all() as unknown as readonly {
    name: string;
    pk: number;
    type: string;
  }[];
  const expectedColumns = [
    { name: 'schema_name', pk: 1, type: 'TEXT' },
    { name: 'schema_version', pk: 0, type: 'TEXT' },
  ];
  if (
    columns.length !== expectedColumns.length ||
    columns.some(
      (column, index) =>
        column.name !== expectedColumns[index]?.name ||
        column.type !== expectedColumns[index]?.type ||
        column.pk !== expectedColumns[index]?.pk,
    )
  ) {
    throw new Error('The build authority database schema is unsupported.');
  }

  const tables = database.prepare('PRAGMA table_list').all() as unknown as readonly {
    name: string;
    strict: number;
    type: string;
  }[];
  const metadataTable = tables.find(
    (table) => table.name === metadataObject.name && table.type === 'table',
  );
  if (metadataTable?.strict !== 1) {
    throw new Error('The build authority database schema is unsupported.');
  }

  const rows = database
    .prepare(
      'SELECT schema_name, schema_version FROM build_authority_metadata ORDER BY schema_name',
    )
    .all() as unknown as readonly { schema_name: string; schema_version: string }[];
  if (
    rows.length !== 1 ||
    rows[0]?.schema_name !== 'schema' ||
    rows[0]?.schema_version !== BUILD_AUTHORITY_SCHEMA
  ) {
    throw new Error('The build authority database schema is unsupported.');
  }
}

function initializeContentPublicationAuthority(database: DatabaseSync): void {
  const schemaObjects = readUserSchemaObjects(database);
  if (schemaObjects.length === 0) {
    database.exec(`
      CREATE TABLE content_publication_metadata (
        schema_name TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL
      ) STRICT;
    `);
    database
      .prepare(
        'INSERT INTO content_publication_metadata (schema_name, schema_version) VALUES (?, ?)',
      )
      .run('schema', CONTENT_PUBLICATION_SCHEMA);
    return;
  }
  const metadataObject = readSchemaObject(database, 'content_publication_metadata');
  if (schemaObjects.length !== 1 || metadataObject?.type !== 'table') {
    throw new Error('The content publication authority database schema is unsupported.');
  }

  const columns = database
    .prepare('PRAGMA table_info(content_publication_metadata)')
    .all() as unknown as readonly {
    name: string;
    pk: number;
    type: string;
  }[];
  const expectedColumns = [
    { name: 'schema_name', pk: 1, type: 'TEXT' },
    { name: 'schema_version', pk: 0, type: 'TEXT' },
  ];
  if (
    columns.length !== expectedColumns.length ||
    columns.some(
      (column, index) =>
        column.name !== expectedColumns[index]?.name ||
        column.type !== expectedColumns[index]?.type ||
        column.pk !== expectedColumns[index]?.pk,
    )
  ) {
    throw new Error('The content publication authority database schema is unsupported.');
  }

  const tables = database.prepare('PRAGMA table_list').all() as unknown as readonly {
    name: string;
    strict: number;
    type: string;
  }[];
  const metadataTable = tables.find(
    (table) => table.name === metadataObject.name && table.type === 'table',
  );
  if (metadataTable?.strict !== 1) {
    throw new Error('The content publication authority database schema is unsupported.');
  }

  const rows = database
    .prepare(
      'SELECT schema_name, schema_version FROM content_publication_metadata ORDER BY schema_name',
    )
    .all() as unknown as readonly { schema_name: string; schema_version: string }[];
  if (
    rows.length !== 1 ||
    rows[0]?.schema_name !== 'schema' ||
    rows[0]?.schema_version !== CONTENT_PUBLICATION_SCHEMA
  ) {
    throw new Error('The content publication authority database schema is unsupported.');
  }
}

function initializeRegistry(database: DatabaseSync): void {
  const schemaObjects = readUserSchemaObjects(database);
  const metadataObject = readSchemaObject(database, 'package_registry_metadata');
  const versionsObject = readSchemaObject(database, 'package_versions');
  if (schemaObjects.length === 0) {
    createRegistrySchema(database);
    return;
  }
  if (
    schemaObjects.length !== 2 ||
    metadataObject?.type !== 'table' ||
    versionsObject?.type !== 'table'
  ) {
    throw new Error('The package registry database schema is unsupported.');
  }

  const metadata = readRegistryMetadata(database);
  if (metadata === undefined) {
    throw new Error('The package registry database schema is unsupported.');
  }
  if (metadata.schema_version === REGISTRY_SCHEMA) {
    assertRegistryColumns(database, false);
    return;
  }
  if (metadata.schema_version !== PREVIOUS_REGISTRY_SCHEMA) {
    throw new Error('The package registry database schema is unsupported.');
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    const lockedMetadata = readRegistryMetadata(database);
    if (lockedMetadata?.schema_version !== PREVIOUS_REGISTRY_SCHEMA) {
      throw new Error('The package registry database schema changed during migration.');
    }
    assertRegistryColumns(database, true);
    database.exec(
      'ALTER TABLE package_versions ADD COLUMN graph_material_path TEXT;\n' +
        'ALTER TABLE package_versions ADD COLUMN graph_material_digest TEXT;',
    );
    const update = database
      .prepare(
        'UPDATE package_registry_metadata SET schema_version = ? WHERE schema_name = ? AND schema_version = ?',
      )
      .run(REGISTRY_SCHEMA, 'schema', PREVIOUS_REGISTRY_SCHEMA);
    if (update.changes !== 1) {
      throw new Error('The package registry database schema changed during migration.');
    }
    assertRegistryColumns(database, false);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function createRegistrySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS package_registry_metadata (
      schema_name TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS package_versions (
      owner_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      target TEXT NOT NULL,
      version TEXT NOT NULL,
      package_digest TEXT NOT NULL,
      build_input_digest TEXT,
      build_output_digest TEXT,
      resolved_lock_digest TEXT,
      content_directory TEXT NOT NULL,
      image_id TEXT,
      installation_id TEXT NOT NULL,
      version_record_id TEXT NOT NULL,
      input_inventory_path TEXT NOT NULL,
      generated_directory TEXT,
      generated_inventory_path TEXT,
      builder_image_id TEXT,
      builder_receipt_path TEXT,
      runtime_receipt_path TEXT,
      resolved_lock_path TEXT,
      graph_material_path TEXT,
      graph_material_digest TEXT,
      PRIMARY KEY (owner_id, package_name, target, version)
    ) STRICT;
  `);
  database
    .prepare('INSERT INTO package_registry_metadata (schema_name, schema_version) VALUES (?, ?)')
    .run('schema', REGISTRY_SCHEMA);
}

function readSchemaObject(
  database: DatabaseSync,
  name: string,
): { name: string; type: string } | undefined {
  // SQLite treats identifiers as ASCII case-insensitive. Looking up only the
  // canonical spelling would let an existing PACKAGE_VERSIONS-style object
  // evade the format check before CREATE TABLE IF NOT EXISTS sees it.
  const row = database
    .prepare('SELECT name, type FROM sqlite_master WHERE name = ? COLLATE NOCASE')
    .get(name) as { name: string; type: string } | undefined;
  return row;
}

function readUserSchemaObjects(database: DatabaseSync): readonly { name: string; type: string }[] {
  return database
    .prepare(
      "SELECT name, type FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_' ORDER BY name",
    )
    .all() as unknown as readonly { name: string; type: string }[];
}

function readRegistryMetadata(database: DatabaseSync): { schema_version: string } | undefined {
  return database
    .prepare('SELECT schema_version FROM package_registry_metadata WHERE schema_name = ?')
    .get('schema') as { schema_version: string } | undefined;
}

function assertRegistryColumns(database: DatabaseSync, legacyV2: boolean): void {
  const columns = database
    .prepare('PRAGMA table_info(package_versions)')
    .all() as unknown as readonly {
    name: string;
  }[];
  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = [
    'owner_id',
    'package_name',
    'target',
    'version',
    'package_digest',
    'build_input_digest',
    'build_output_digest',
    'resolved_lock_digest',
    'content_directory',
    'image_id',
    'installation_id',
    'version_record_id',
    'input_inventory_path',
    'generated_directory',
    'generated_inventory_path',
    'builder_image_id',
    'builder_receipt_path',
    'runtime_receipt_path',
    'resolved_lock_path',
  ];
  if (!legacyV2) {
    requiredColumns.push('graph_material_path', 'graph_material_digest');
  }
  if (requiredColumns.some((column) => !columnNames.has(column))) {
    throw new Error('The package registry database schema is unsupported.');
  }
  if (
    legacyV2 &&
    (columnNames.has('graph_material_path') || columnNames.has('graph_material_digest'))
  ) {
    throw new Error('The package registry database schema is unsupported.');
  }
}

function toRecord(row: RegistryRow): DisabledInstallationRecord {
  return Object.freeze({
    buildInputDigest: row.build_input_digest,
    buildOutputDigest: row.build_output_digest,
    builderImageId: row.builder_image_id,
    builderReceiptPath: row.builder_receipt_path,
    contentDirectory: row.content_directory,
    generatedDirectory: row.generated_directory,
    generatedInventoryPath: row.generated_inventory_path,
    graphMaterialDigest: row.graph_material_digest,
    graphMaterialPath: row.graph_material_path,
    imageId: row.image_id,
    inputInventoryPath: row.input_inventory_path,
    installationId: row.installation_id,
    ownerId: row.owner_id,
    packageDigest: row.package_digest,
    packageName: row.package_name,
    resolvedLockDigest: row.resolved_lock_digest,
    resolvedLockPath: row.resolved_lock_path,
    runtimeReceiptPath: row.runtime_receipt_path,
    status: 'installed-disabled',
    target: requireTarget(row.target),
    version: row.version,
    versionRecordId: row.version_record_id,
  });
}

function computeResolvedLockDigest(
  candidate: Candidate,
  variant: RuntimeVariant,
  catalog: TrustedImageCatalogEntry,
): string {
  return digestJson(resolvedLockSelection(candidate, variant, catalog));
}

function resolvedLockSelection(
  candidate: Candidate,
  variant: RuntimeVariant,
  catalog: TrustedImageCatalogEntry,
): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    abi: catalog.abi,
    baseImage: catalog.baseImage,
    builderImage: catalog.builderImage,
    catalogId: catalog.id,
    dependencies: [],
    features: [...catalog.features].sort(compareArchivePathsBytewise),
    platform: catalog.platform,
    profile: catalog.profile,
    sourceId: candidate.sourceId,
    sourceLock: candidate.sourceLock.inputContentDigest,
    templateDigest: catalog.templateDigest,
    toolchainDigest: catalog.toolchainDigest,
    variantFeatures: [...variant.requiredFeatures].sort(compareArchivePathsBytewise),
  });
}

function computeBuildInputDigest(candidate: Candidate, resolvedRuntime: ResolvedRuntime): string {
  return digestJson({
    build: candidate.manifest.build ?? null,
    packageDigest: candidate.packageDigest,
    resolvedLockDigest: resolvedRuntime.resolvedLockDigest,
    schema: 'qdroid.build-input/v1',
  });
}

export function inventoryDigest(entries: readonly FrozenArchiveEntry[]): string {
  return digestJson({
    schema: 'qdroid.inventory/v1',
    entries: frozenInventory(entries),
  });
}

interface FrozenInventoryEntry {
  readonly digest: string;
  readonly executable: boolean;
  readonly length: number;
  readonly path: string;
  readonly type: 'directory' | 'file';
}

function frozenInventory(entries: readonly FrozenArchiveEntry[]): readonly FrozenInventoryEntry[] {
  return Object.freeze(
    entries
      .map((entry) => ({
        digest: entry.digest,
        executable: entry.executable,
        length: entry.bytes.byteLength,
        path: entry.path,
        type: entry.type,
      }))
      .sort((left, right) => compareArchivePathsBytewise(left.path, right.path)),
  );
}

function inputInventoryPayload(
  entries: readonly FrozenArchiveEntry[],
  packageDigest: string,
): Buffer {
  return Buffer.from(
    canonicalJson({
      entries: frozenInventory(entries),
      packageDigest,
      schema: 'qdroid.input-inventory/v1',
    }),
  );
}

async function writeInputInventory(
  installerRoot: string,
  directory: string,
  entries: readonly FrozenArchiveEntry[],
  packageDigest: string,
): Promise<void> {
  await writeSealedFile(
    installerRoot,
    `${directory}.input-inventory.json`,
    inputInventoryPayload(entries, packageDigest),
  );
}

async function assertInputInventory(
  path: string,
  entries: readonly FrozenArchiveEntry[],
  packageDigest: string,
  installerRoot: string,
): Promise<void> {
  const actual = await readFrozenMetadata(path, 'input inventory', installerRoot);
  if (actual === undefined || !actual.equals(inputInventoryPayload(entries, packageDigest))) {
    throw new Error('The committed disabled installation input inventory is missing or corrupt.');
  }
}

async function assertResolvedLock(
  path: string,
  candidate: Candidate,
  runtime: ResolvedRuntime,
  installerRoot: string,
): Promise<string> {
  const record = await readSealedObject(path, 'resolved lock', installerRoot);
  assertExactKeys(record, [
    'candidateId',
    'packageDigest',
    'resolvedLockDigest',
    'schema',
    'selection',
  ]);
  if (
    record.schema !== 'qdroid.resolved-lock/v1' ||
    typeof record.candidateId !== 'string' ||
    !/^candidate-[0-9a-f-]{36}$/.test(record.candidateId) ||
    record.packageDigest !== candidate.packageDigest ||
    record.resolvedLockDigest !== runtime.resolvedLockDigest ||
    !isJsonRecord(record.selection) ||
    canonicalJson(record.selection) !==
      canonicalJson(resolvedLockSelection(candidate, runtime.variant, runtime.catalog))
  ) {
    throw new Error('The committed executable resolved lock is missing or corrupt.');
  }
  if (path !== join(installerRoot, 'seals', record.candidateId, 'resolved-lock.json')) {
    throw new Error('The committed executable resolved lock is not at its canonical seal path.');
  }
  return record.candidateId;
}

interface SealedAssemblyReceipt {
  readonly candidateId: string;
  readonly receipt: Readonly<Record<string, JsonValue>>;
}

async function readSealedAssemblyReceipt(
  path: string,
  imageId: string,
  packageDigest: string,
  purpose: ImageAssemblyRequest['purpose'],
  installerRoot: string,
): Promise<SealedAssemblyReceipt> {
  const record = await readSealedObject(path, 'image receipt', installerRoot);
  assertExactKeys(record, [
    'candidateId',
    'imageId',
    'packageDigest',
    'purpose',
    'receipt',
    'schema',
  ]);
  if (
    record.schema !== 'qdroid.image-receipt/v1' ||
    record.imageId !== imageId ||
    record.packageDigest !== packageDigest ||
    record.purpose !== purpose ||
    !isJsonRecord(record.receipt)
  ) {
    throw new Error('The committed immutable image receipt is missing or corrupt.');
  }
  if (
    typeof record.candidateId !== 'string' ||
    !/^candidate-[0-9a-f-]{36}$/.test(record.candidateId)
  ) {
    throw new Error('The committed immutable image receipt has an invalid candidate identity.');
  }
  return Object.freeze({
    candidateId: record.candidateId,
    receipt: Object.freeze({ ...record.receipt }),
  });
}

async function assertGeneratedOutput(
  directory: string,
  inventoryPath: string,
  packageDigest: string,
  outputDigest: string,
  installerRoot: string,
): Promise<void> {
  const record = await readSealedObject(inventoryPath, 'generated output inventory', installerRoot);
  assertExactKeys(record, ['entries', 'outputDigest', 'packageDigest', 'schema']);
  if (
    record.schema !== 'qdroid.generated-inventory/v1' ||
    record.packageDigest !== packageDigest ||
    record.outputDigest !== outputDigest ||
    !Array.isArray(record.entries)
  ) {
    throw new Error('The committed generated output inventory is missing or corrupt.');
  }

  const archiveEntries = record.entries.map(readFrozenInventoryEntry);
  if (
    archiveEntries.some((entry) => entry.type !== 'file' || !entry.path.startsWith('generated/')) ||
    inventoryDigestFromEntries(archiveEntries) !== outputDigest
  ) {
    throw new Error('The committed generated output inventory is invalid.');
  }

  const expected = archiveEntries.map((entry) =>
    Object.freeze({ ...entry, path: entry.path.slice('generated/'.length) }),
  );
  await assertFrozenFileTree(directory, expected, installerRoot);
}

async function assertFrozenFileTree(
  directory: string,
  files: readonly FrozenInventoryEntry[],
  installerRoot: string,
): Promise<void> {
  const actual = await collectMaterializedInventory(directory, installerRoot);
  const expected = materializedInventory(files);
  if (actual.length !== expected.length) {
    throw new Error('The committed generated output does not match its inventory.');
  }

  for (let index = 0; index < expected.length; index += 1) {
    const expectedEntry = expected[index]!;
    const actualEntry = actual[index]!;
    if (
      actualEntry.path !== expectedEntry.path ||
      actualEntry.type !== expectedEntry.type ||
      actualEntry.executable !== expectedEntry.executable
    ) {
      throw new Error('The committed generated output does not match its inventory.');
    }
  }

  for (const file of files) {
    const expectedMode = file.executable ? 0o555 : 0o444;
    const bytes = await readFrozenFile(
      safeDestination(directory, file.path),
      'generated file',
      expectedMode,
      installerRoot,
    );
    if (bytes === undefined || bytes.byteLength !== file.length || sha256(bytes) !== file.digest) {
      throw new Error('The sealed generated file does not match its inventory.');
    }
  }
}

async function readSealedObject(
  path: string,
  label: string,
  installerRoot: string,
): Promise<Readonly<Record<string, JsonValue>>> {
  const bytes = await readFrozenMetadata(path, label, installerRoot);
  if (bytes === undefined) {
    throw new Error(`The committed ${label} is missing and cannot be rebuilt automatically.`);
  }
  try {
    return Object.freeze({
      ...requireRecord(
        parseStrictJsonBytes(bytes, { maxBytes: MAX_METADATA_BYTES, maxDepth: 64 }),
        label,
      ),
    });
  } catch (error) {
    throw new Error(`The committed ${label} is corrupt.`, { cause: error });
  }
}

async function readFrozenMetadata(
  path: string,
  label: string,
  installerRoot: string,
): Promise<Buffer | undefined> {
  return readFrozenFile(path, `${label} metadata`, 0o444, installerRoot);
}

/**
 * Reads a sealed file through one no-follow descriptor, synchronizes that
 * descriptor and each trusted parent directory, then proves the pathname
 * still names the same inode. A visible immutable pathname is not treated as
 * a durable publication until this observer performs those steps itself.
 */
async function readFrozenFile(
  path: string,
  label: string,
  expectedMode: number,
  installerRoot: string,
): Promise<Buffer | undefined> {
  const maximumAttempts = 2;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const before = await lstat(path).catch((error: unknown) => {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    });
    if (before === undefined) {
      return undefined;
    }
    assertFrozenRegularFile(before, label, expectedMode);

    let file;
    try {
      file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (isNotFoundError(error)) {
        continue;
      }
      throw error;
    }

    try {
      const opened = await file.stat();
      assertFrozenRegularFile(opened, label, expectedMode);
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        continue;
      }
      const bytes = await file.readFile();
      await file.sync();
      await syncDirectoryChain(dirname(path), installerRoot);

      const after = await lstat(path).catch((error: unknown) => {
        if (isNotFoundError(error)) {
          return undefined;
        }
        throw error;
      });
      if (after === undefined) {
        continue;
      }
      assertFrozenRegularFile(after, label, expectedMode);
      if (after.dev === opened.dev && after.ino === opened.ino) {
        return bytes;
      }
    } finally {
      await file.close();
    }
  }
  throw new Error(`The committed ${label} changed while it was being synchronized.`);
}

function assertFrozenRegularFile(
  status: Awaited<ReturnType<typeof lstat>>,
  label: string,
  expectedMode: number,
): void {
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    (Number(status.mode) & 0o777) !== expectedMode
  ) {
    throw new Error(`The committed ${label} is not a sealed regular file.`);
  }
}

async function syncDirectoryChain(path: string, installerRoot: string): Promise<void> {
  const trustedRoot = resolve(installerRoot);
  let current = resolve(path);
  if (current !== trustedRoot && !current.startsWith(`${trustedRoot}/`)) {
    throw new Error('The sealed path escapes the configured installer root.');
  }
  for (;;) {
    await syncDirectory(current);
    if (current === trustedRoot) {
      return;
    }
    current = dirname(current);
  }
}

function readFrozenInventoryEntry(value: JsonValue): FrozenInventoryEntry {
  const record = requireRecord(value, 'generated inventory entry');
  assertExactKeys(record, ['digest', 'executable', 'length', 'path', 'type']);
  const type = requireEnum(record.type, ['directory', 'file'] as const, 'generated inventory type');
  const digest = requireString(record.digest, 'generated inventory digest');
  if (!isSha256(digest)) {
    throw new Error('The generated inventory digest is invalid.');
  }
  return Object.freeze({
    digest,
    executable: requireBoolean(record.executable, 'generated inventory executable'),
    length: requireNonNegativeInteger(record.length, 'generated inventory length'),
    path: requireRelativePath(record.path, 'generated inventory path'),
    type,
  });
}

function inventoryDigestFromEntries(entries: readonly FrozenInventoryEntry[]): string {
  return digestJson({ schema: 'qdroid.inventory/v1', entries });
}

function compareArchivePathsBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'));
}

function isSorted<T>(values: readonly T[], compare: (left: T, right: T) => number): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) <= 0);
}

function freezeCatalogSelection(catalog: TrustedImageCatalogEntry): TrustedImageCatalogEntry {
  if (
    !isImmutableImageId(catalog.baseImage) ||
    !isImmutableImageId(catalog.builderImage) ||
    !isSha256(catalog.templateDigest) ||
    !isSha256(catalog.toolchainDigest) ||
    !catalog.id.match(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/) ||
    catalog.features.some((feature) => feature.length === 0) ||
    new Set(catalog.features).size !== catalog.features.length
  ) {
    throw new Error('The trusted runtime catalog entry is malformed.');
  }
  return Object.freeze({
    ...catalog,
    features: Object.freeze([...catalog.features]),
  });
}

function installationIdentity(ownerId: string, name: string, target: InstallTarget): string {
  return `installation-${digestJson({ name, ownerId, target }).slice(0, 32)}`;
}

function versionRecordIdentity(installationId: string, version: string): string {
  return `version-${digestJson({ installationId, version }).slice(0, 32)}`;
}

function digestJson(value: JsonValue | Record<string, unknown>): string {
  return sha256(Buffer.from(canonicalJson(value)));
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('The trusted receipt cannot contain an unsupported value.');
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireFile(archive: FrozenArchive, path: string): FrozenArchiveEntry {
  const entry = archive.entries.find(
    (candidate) => candidate.path === path && candidate.type === 'file',
  );
  if (entry === undefined) throw new Error(`The package archive is missing ${path}.`);
  return entry;
}

function requireRecord(value: JsonValue, label: string): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new Error(`The ${label} must be an object.`);
  return value;
}

function requireRecordValue(
  value: JsonValue | undefined,
  label: string,
): Record<string, JsonValue> {
  if (value === undefined) {
    throw new Error(`The ${label} must be an object.`);
  }

  return requireRecord(value, label);
}

function assertExactKeys(
  record: Readonly<Record<string, JsonValue>>,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key)))
    throw new Error('The package metadata contains unknown fields.');
}

function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`The ${label} must be a non-empty string.`);
  return value;
}

function requireBoolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`The ${label} must be a boolean.`);
  return value;
}

function requireNonNegativeInteger(value: JsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The ${label} must be a non-negative safe integer.`);
  }
  return value;
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function requirePositiveInteger(value: JsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The ${label} must be a positive safe integer.`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: JsonValue | undefined,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T))
    throw new Error(`The ${label} is unsupported.`);
  return value as T;
}

function requirePackageName(value: JsonValue | undefined): string {
  const name = requireString(value, 'package name');
  if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/.test(name)) {
    throw new Error('The package name must be publisher-qualified.');
  }
  return name;
}

function requireSourceId(value: JsonValue | undefined): string {
  const sourceId = requireString(value, 'dependency sourceId');
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/.test(sourceId) ||
    sourceId.includes('//') ||
    sourceId.includes('..') ||
    sourceId.includes('\\')
  ) {
    throw new Error('The dependency sourceId is not a canonical trusted source identifier.');
  }
  return sourceId;
}

function requireSemver(value: JsonValue | undefined, label: string): string {
  const version = requireString(value, label);
  if (valid(version) === null || !CANONICAL_SEMVER.test(version)) {
    throw new Error(`The ${label} is not a canonical semantic version.`);
  }
  return version;
}

function parseLicense(value: JsonValue | undefined): string {
  const license = requireString(value, 'license');
  if (
    !['Apache-2.0', 'BSD-3-Clause', 'ISC', 'MIT'].includes(license) &&
    !license.startsWith('LICENSES/')
  ) {
    throw new Error('The package license is not in the first installer subset.');
  }
  if (license.startsWith('LICENSES/')) requireRelativePath(license, 'license file');
  return license;
}

function parseJsonArray(value: JsonValue | undefined, label: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`The ${label} must be an array.`);
  return Object.freeze([...value]);
}

function parseStringArray(value: JsonValue | undefined, label: string): readonly string[] {
  return Object.freeze(parseJsonArray(value, label).map((entry) => requireString(entry, label)));
}

function parsePathList(value: JsonValue | undefined, label: string): readonly string[] {
  const values = parseStringArray(value, label).map((entry) => requireRelativePath(entry, label));
  if (new Set(values).size !== values.length)
    throw new Error(`The ${label} contains duplicate paths.`);
  return Object.freeze(values);
}

function parsePackageDependencies(
  value: JsonValue | undefined,
  label: string,
  options: Readonly<{ requireCanonicalOrder: boolean }> = { requireCanonicalOrder: false },
): readonly PackageDependency[] {
  const values = parseJsonArray(value, label).map((entry) => {
    const record = requireRecord(entry, label);
    assertExactKeys(record, ['name', 'sourceId', 'version']);
    return Object.freeze({
      name: requirePackageName(record.name),
      sourceId: requireSourceId(record.sourceId),
      version: requireSemver(record.version, `${label} version`),
    });
  });

  const keys = new Set<string>();
  for (const dependency of values) {
    const key = packageDependencyKey(dependency);
    if (keys.has(key)) {
      throw new Error(`${label} contain duplicate logical package keys.`);
    }
    keys.add(key);
  }

  if (options.requireCanonicalOrder) {
    const canonical = [...values].sort(comparePackageDependencies);
    if (!dependenciesEqual(values, canonical)) {
      throw new Error(`${label} are not in canonical name/version order.`);
    }
  }

  return Object.freeze(values);
}

function dependenciesEqual(
  left: readonly PackageDependency[],
  right: readonly PackageDependency[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (dependency, index) =>
        dependency.name === right[index]?.name &&
        dependency.version === right[index]?.version &&
        dependency.sourceId === right[index]?.sourceId,
    )
  );
}

function comparePackageDependencies(
  left: Pick<PackageDependency, 'name' | 'version'>,
  right: Pick<PackageDependency, 'name' | 'version'>,
): number {
  return (
    compareArchivePathsBytewise(left.name, right.name) ||
    compareArchivePathsBytewise(left.version, right.version)
  );
}

function packageDependencyKey(dependency: Pick<PackageDependency, 'name' | 'version'>): string {
  return `${dependency.name}\u0000${dependency.version}`;
}

function verifyExpectedDependency(
  candidate: Candidate,
  expected: Pick<PackageDependency, 'name' | 'version'> | undefined,
): void {
  if (
    expected !== undefined &&
    (candidate.manifest.name !== expected.name || candidate.manifest.version !== expected.version)
  ) {
    throw new Error('A dependency source does not provide the declared package name and version.');
  }
}

function assertResolvedGraphDepth(
  depth: number,
  candidate: Candidate,
  suffixDepth: number | undefined,
): void {
  if (suffixDepth === undefined) {
    throw new Error('The package dependency graph reused a node before its dependencies settled.');
  }
  if (depth + suffixDepth > MAX_DEPENDENCY_DEPTH) {
    throw new Error('The package dependency graph exceeds the maximum depth.');
  }
}

function assertGraphDeadline(deadline: number, message: string): void {
  if (Date.now() > deadline) {
    throw new Error(message);
  }
}

function graphNodeIdentity(candidate: Candidate): Readonly<Record<string, unknown>> {
  return Object.freeze({
    dependencies: [...candidate.dependencies].sort(comparePackageDependencies).map((dependency) =>
      Object.freeze({
        name: dependency.name,
        sourceId: dependency.sourceId,
        version: dependency.version,
      }),
    ),
    inputContentDigest: candidate.inputContentDigest,
    name: candidate.manifest.name,
    packageDigest: candidate.packageDigest,
    sourceId: candidate.sourceId,
    transportDigest: candidate.transportDigest,
    version: candidate.manifest.version,
  });
}

function requireRelativePath(value: JsonValue | undefined, label: string): string {
  const path = requireString(value, label);
  if (
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) ||
    path.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error(`The ${label} must be a package-root-relative path.`);
  }
  return path;
}

function requireBuildWorkingDirectory(value: JsonValue | undefined): string {
  if (value === '.') {
    return value;
  }

  return requireRelativePath(value, 'build cwd');
}

function buildContainerWorkingDirectory(buildDirectory: string, packageDigest: string): string {
  const root = `/opt/qdroid/packages/${packageDigest}/source`;
  return buildDirectory === '.' ? root : `${root}/${buildDirectory}`;
}

function requireImmutableImage(value: JsonValue | undefined): string {
  const image = requireString(value, 'runtime image');
  if (!isImmutableImageId(image))
    throw new Error('The runtime image must be an immutable local sha256 ID.');
  return image;
}

function isImmutableImageId(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function requireDigest(value: JsonValue | undefined, label: string): string {
  const digest = requireString(value, label);
  if (!isSha256(digest)) throw new Error(`The ${label} must be a sha256 digest.`);
  return digest;
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function requireTarget(value: string): InstallTarget {
  if (value === 'content-only' || value === 'linux/amd64' || value === 'linux/arm64') return value;
  throw new Error('The installed registry record has an unsupported target.');
}

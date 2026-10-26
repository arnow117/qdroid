import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ReferenceSimulator } from '../../../adapters/reference-simulator/src/index.js';
import type { JsonRpcResponse } from '../../../packages/contracts/src/index.js';
import { RuntimeCore } from '../../../packages/core/src/index.js';
import {
  DockerSandboxManager,
  type QualificationEvidence,
  type WorkloadMode,
} from '../../../packages/runtime-oci/src/index.js';
import { PolicyAuthority } from '../../../packages/policy/src/index.js';
import { createLinuxSupervisor } from '../../../packages/supervisor/src/index.js';
import { trustedOperatorFixtureGrant, type FixtureGrantMode } from './operator-fixture.js';

export interface LinuxFixtureSuiteOptions {
  image: string;
}

export interface LinuxFixtureScenarioResult {
  binding: {
    bootId: string;
    channelId: string;
    epoch: number;
    instanceId: string;
  };
  errorCode: string | undefined;
  exitCode: number;
  simulatorOperationCount: number;
  stopReason: 'completed' | 'deadline' | 'output-limit';
  workloadReceivedResponse: boolean;
}

export interface LinuxFixtureSuiteResult {
  activeDeny: LinuxFixtureScenarioResult;
  allow: LinuxFixtureScenarioResult;
  deny: LinuxFixtureScenarioResult;
  duplicateKey: LinuxFixtureScenarioResult;
  forgedAuthority: LinuxFixtureScenarioResult;
  none: LinuxFixtureScenarioResult;
  qualification: QualificationEvidence;
  unsupportedMethod: LinuxFixtureScenarioResult;
}

/**
 * Runs the first real sandbox path. The policy store and reference simulator
 * remain in the Linux broker; only JSON-RPC frames cross into the workload.
 */
export async function runLinuxReadonlyFixtureSuite(
  options: LinuxFixtureSuiteOptions,
): Promise<LinuxFixtureSuiteResult> {
  const sandboxManager = new DockerSandboxManager({ image: options.image });
  const qualification = await sandboxManager.qualify();

  return {
    activeDeny: await runScenario(sandboxManager, qualification, ['allow', 'deny'], 'deny'),
    allow: await runScenario(sandboxManager, qualification, ['allow'], 'allow'),
    deny: await runScenario(sandboxManager, qualification, ['deny'], 'deny'),
    duplicateKey: await runScenario(sandboxManager, qualification, ['allow'], 'duplicate-key'),
    forgedAuthority: await runScenario(
      sandboxManager,
      qualification,
      ['allow'],
      'forged-authority',
    ),
    none: await runScenario(sandboxManager, qualification, [], 'none'),
    qualification,
    unsupportedMethod: await runScenario(
      sandboxManager,
      qualification,
      ['allow'],
      'unsupported-method',
    ),
  };
}

async function runScenario(
  sandboxManager: DockerSandboxManager,
  qualification: QualificationEvidence,
  grantModes: Exclude<FixtureGrantMode, 'none'>[],
  mode: WorkloadMode,
): Promise<LinuxFixtureScenarioResult> {
  const databaseDirectory = await mkdtemp(join(tmpdir(), 'qdroid-t002-policy-'));
  const databasePath = join(databaseDirectory, 'policy.sqlite');
  const policy = new PolicyAuthority(databasePath);
  const simulator = new ReferenceSimulator();
  const core = new RuntimeCore({ policy, provider: simulator });
  const supervisor = await createLinuxSupervisor((identity, request) =>
    core.handle(identity, request),
  );
  const installationId = `installation-${randomUUID()}`;
  const channel = supervisor.createBoundChannel({ installationId });

  try {
    for (const grantMode of grantModes) {
      const grant = trustedOperatorFixtureGrant(
        installationId,
        channel.trustedInstanceId,
        grantMode,
      );

      if (grant === undefined) {
        throw new Error('The Linux broker received an invalid trusted fixture grant.');
      }

      policy.applyOperatorFixtureGrant(grant);
    }

    const sandbox = await sandboxManager.createSandbox(qualification, channel);
    const execution = await sandboxManager.runWorkload(qualification, sandbox, channel, mode);
    const finalResponse = selectInvocationResponse(execution);

    return {
      binding: sandbox.binding,
      errorCode: responseErrorCode(finalResponse),
      exitCode: execution.exitCode,
      simulatorOperationCount: simulator.operationCount,
      stopReason: execution.stopReason,
      workloadReceivedResponse: execution.workloadReceivedResponse,
    };
  } finally {
    policy.close();
    await rm(databaseDirectory, { force: true, recursive: true });
  }
}

function selectInvocationResponse(execution: {
  cleanupConfirmed: boolean;
  exitCode: number;
  responses: JsonRpcResponse[];
  stderr: string;
  stopReason: string;
  workloadReceivedResponse: boolean;
}): JsonRpcResponse {
  const { responses } = execution;
  const invocation = responses.find(
    (response) => response.id === 'invoke' || response.id === 'unsupported',
  );

  if (invocation !== undefined) {
    return invocation;
  }

  const duplicateKeyFailure = responses.find(
    (response) =>
      response.id === null &&
      'error' in response &&
      response.error.data.code === 'QD_VALIDATION_FAILED',
  );

  if (duplicateKeyFailure === undefined) {
    const responseIds = responses.map((response) => String(response.id)).join(',');
    const stderr = execution.stderr.slice(0, 200).replace(/[\r\n]/g, ' ');
    throw new Error(
      `The workload did not receive an invocation response from the supervisor: ` +
        `stop=${execution.stopReason}, cleanup=${execution.cleanupConfirmed}, ` +
        `exit=${execution.exitCode}, received=${execution.workloadReceivedResponse}, ` +
        `responseIds=${responseIds}, stderr=${stderr}`,
    );
  }

  return duplicateKeyFailure;
}

function responseErrorCode(response: JsonRpcResponse): string | undefined {
  return 'error' in response ? response.error.data.code : undefined;
}

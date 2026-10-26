import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  PersistentCounterSimulator,
  ReferenceSimulator,
  type CounterObservationMode,
} from '../../../adapters/reference-simulator/src/index.js';
import { RuntimeCore } from '../../../packages/core/src/index.js';
import {
  PolicyAuthority,
  type CounterApproval,
  type OperatorCounterGrant,
} from '../../../packages/policy/src/index.js';
import { Supervisor, type SupervisedChannel } from '../../../packages/supervisor/src/index.js';

export interface AdmissionFixtureOptions {
  counterDatabasePath?: string;
  observationDeadlineMs?: number;
  observationMode?: CounterObservationMode;
  policyDatabasePath?: string;
  registerContext?: boolean;
}

export interface AdmissionFixture {
  applyApproval(approval: Omit<CounterApproval, 'installationId' | 'subjectInstanceId'>): string;
  applyGrant(grant: Omit<OperatorCounterGrant, 'installationId' | 'subjectInstanceId'>): string;
  channel: SupervisedChannel;
  close(): void;
  core: RuntimeCore;
  counter: PersistentCounterSimulator;
  policy: PolicyAuthority;
  rebindLease(epoch: number): void;
}

export function createAdmissionFixture(options: AdmissionFixtureOptions = {}): AdmissionFixture {
  const directory = mkdtempSync(join(tmpdir(), 'qdroid-admission-'));
  const policyDatabasePath = options.policyDatabasePath ?? join(directory, 'policy.sqlite');
  const counterDatabasePath = options.counterDatabasePath ?? join(directory, 'counter.sqlite');
  const policy = new PolicyAuthority(policyDatabasePath, {
    ...(options.observationDeadlineMs === undefined
      ? {}
      : { observationDeadlineMs: options.observationDeadlineMs }),
  });
  const counter = new PersistentCounterSimulator({
    databasePath: counterDatabasePath,
    ...(options.observationMode === undefined ? {} : { observationMode: options.observationMode }),
  });
  const core = new RuntimeCore({
    counterProvider: counter,
    policy,
    provider: new ReferenceSimulator(),
  });
  const supervisor = new Supervisor((identity, request) => core.handle(identity, request));
  const channel = supervisor.createBoundChannel({ installationId: `installation-${randomUUID()}` });

  const rebindLease = (epoch: number): void => {
    const identity = channel.trustedBinding;
    policy.registerTrustedCounterContext({
      identity: { ...identity, epoch },
      leaseExpiresAt: Date.now() + 60_000,
      profileGeneration: 1,
      providerEpoch: 1,
      providerId: 'reference-counter',
    });
  };

  if (options.registerContext !== false) {
    rebindLease(channel.trustedBinding.epoch);
  }

  return {
    applyApproval: (approval) =>
      policy.applyTrustedApproval({
        ...approval,
        installationId: channel.trustedBinding.installationId,
        subjectInstanceId: channel.trustedBinding.instanceId,
      }),
    applyGrant: (grant) =>
      policy.applyCounterGrant({
        ...grant,
        installationId: channel.trustedBinding.installationId,
        subjectInstanceId: channel.trustedBinding.instanceId,
      }),
    channel,
    close: () => {
      counter.close();
      policy.close();
      if (options.counterDatabasePath === undefined && options.policyDatabasePath === undefined) {
        rmSync(directory, { force: true, recursive: true });
      }
    },
    core,
    counter,
    policy,
    rebindLease,
  };
}

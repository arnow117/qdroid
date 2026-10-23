import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ReferenceSimulator } from '../../../adapters/reference-simulator/src/index.js';
import type { ReadonlyCapabilityProvider } from '../../../packages/contracts/src/index.js';
import { RuntimeCore } from '../../../packages/core/src/index.js';
import { PolicyAuthority, type SanitizedAuditRecord } from '../../../packages/policy/src/index.js';
import { Supervisor, type SupervisedChannel } from '../../../packages/supervisor/src/index.js';
import { trustedOperatorFixtureGrant, type FixtureGrantMode } from './operator-fixture.js';

export interface TrustedFixtureDriverOptions {
  databasePath?: string;
  grantMode: FixtureGrantMode;
  provider?: ReadonlyCapabilityProvider;
}

export interface TrustedFixtureDriver {
  audit(): SanitizedAuditRecord[];
  applyTrustedGrant(grantMode: Exclude<FixtureGrantMode, 'none'>): string;
  channel: SupervisedChannel;
  close(): void;
  createUnprivilegedChannel(): SupervisedChannel;
  databasePath: string;
  simulator: ReferenceSimulator;
}

export function createTrustedFixtureDriver(
  options: TrustedFixtureDriverOptions,
): TrustedFixtureDriver {
  const databasePath = options.databasePath ?? createFixtureDatabasePath();
  const installationId = `installation-${randomUUID()}`;
  const simulator = new ReferenceSimulator();
  const policy = new PolicyAuthority(databasePath);
  const provider = options.provider ?? simulator;
  const core = new RuntimeCore({ policy, provider });
  const supervisor = new Supervisor((identity, request) => core.handle(identity, request));
  const channel = supervisor.createBoundChannel({ installationId });
  const trustedGrant = trustedOperatorFixtureGrant(
    installationId,
    channel.trustedInstanceId,
    options.grantMode,
  );

  if (trustedGrant !== undefined) {
    policy.applyOperatorFixtureGrant(trustedGrant);
  }

  const applyTrustedGrant = (grantMode: Exclude<FixtureGrantMode, 'none'>): string => {
    const grant = trustedOperatorFixtureGrant(installationId, channel.trustedInstanceId, grantMode);

    if (grant === undefined) {
      throw new Error('A trusted fixture grant mode is required.');
    }

    return policy.applyOperatorFixtureGrant(grant);
  };

  return {
    audit: () => policy.readSanitizedAudit(),
    applyTrustedGrant,
    channel,
    close: () => policy.close(),
    createUnprivilegedChannel: () => supervisor.createBoundChannel({ installationId }),
    databasePath,
    simulator,
  };
}

function createFixtureDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qdroid-readonly-sim-'));
  mkdirSync(directory, { recursive: true });
  return join(directory, 'policy.sqlite');
}

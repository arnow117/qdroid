import type { OperatorFixtureGrant } from '../../../packages/policy/src/index.js';

export type FixtureGrantMode = 'allow' | 'deny' | 'none';

export function trustedOperatorFixtureGrant(
  installationId: string,
  subjectInstanceId: string,
  mode: FixtureGrantMode,
): OperatorFixtureGrant | undefined {
  if (mode === 'none') {
    return undefined;
  }

  return {
    capability: 'sim.status.read/v1',
    effect: mode,
    installationId,
    subjectInstanceId,
  };
}

import { createTrustedFixtureDriver } from '../../../fixtures/readonly-sim/src/driver.js';

const [command, ...argumentsValue] = process.argv.slice(2);

if (command !== 'demo') {
  writeUsage();
  process.exitCode = 1;
} else {
  const grantMode = parseGrantMode(argumentsValue);

  if (grantMode === undefined) {
    writeUsage();
    process.exitCode = 1;
  } else {
    runDemo(grantMode);
  }
}

function runDemo(grantMode: 'allow' | 'deny' | 'none'): void {
  const fixture = createTrustedFixtureDriver({ grantMode });

  try {
    const initialize = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'initialize',
      method: 'runtime.initialize',
      params: {
        protocolVersion: 'qdroid.rpc/v0.1',
        requiredFeatures: [],
      },
    });
    const invocation = fixture.channel.request({
      jsonrpc: '2.0',
      id: 'read-status',
      method: 'capabilities.invoke',
      params: {
        arguments: {},
        capability: 'sim.status.read/v1',
        schemaVersion: 'qdroid.capability.sim.status.read/v1',
      },
    });

    console.log(
      JSON.stringify(
        {
          audit: fixture.audit(),
          executionScope: 'trusted host fixture only; this is not a Linux sandbox qualification',
          grantMode,
          initialize,
          invocation,
          simulatorOperationCount: fixture.simulator.operationCount,
        },
        null,
        2,
      ),
    );
  } finally {
    fixture.close();
  }
}

function parseGrantMode(argumentsValue: string[]): 'allow' | 'deny' | 'none' | undefined {
  if (argumentsValue.length === 0) {
    return 'allow';
  }

  if (argumentsValue.length !== 2 || argumentsValue[0] !== '--fixture') {
    return undefined;
  }

  const value = argumentsValue[1];

  return value === 'allow' || value === 'deny' || value === 'none' ? value : undefined;
}

function writeUsage(): void {
  console.error('Usage: qdroid demo [--fixture allow|deny|none]');
}

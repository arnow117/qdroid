import { createTrustedFixtureDriver } from '../../../fixtures/readonly-sim/src/driver.js';
import { runLinuxReadonlyFixtureSuite } from '../../../fixtures/readonly-sim/src/linux-broker.js';

const [command, ...argumentsValue] = process.argv.slice(2);

await main();

async function main(): Promise<void> {
  if (command === 'demo') {
    const grantMode = parseGrantMode(argumentsValue);

    if (grantMode === undefined) {
      writeUsage();
      process.exitCode = 1;
      return;
    }

    runDemo(grantMode);
    return;
  }

  if (command === 'linux-demo') {
    const image = parseLinuxImage(argumentsValue);

    if (image === undefined) {
      writeUsage();
      process.exitCode = 1;
      return;
    }

    try {
      const suite = await runLinuxReadonlyFixtureSuite({ image });
      console.log(
        JSON.stringify(
          {
            executionScope:
              'fixed ARM64 Linux reference fixture; this is not T1 or general package qualification',
            suite,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error('Linux fixture qualification or execution failed.');
      process.exitCode = 1;
    }
    return;
  }

  writeUsage();
  process.exitCode = 1;
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

function parseLinuxImage(argumentsValue: string[]): string | undefined {
  if (argumentsValue.length !== 2 || argumentsValue[0] !== '--image') {
    return undefined;
  }

  const image = argumentsValue[1];

  return image === undefined || image.length === 0 || image.length > 300 ? undefined : image;
}

function writeUsage(): void {
  console.error('Usage: qdroid demo [--fixture allow|deny|none]');
  console.error('       qdroid linux-demo --image <qualified-fixture-image>');
}

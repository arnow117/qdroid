import type {
  ReadonlyCapabilityProvider,
  ReadonlySimulatorResult,
} from '../../../packages/contracts/src/index.js';

export class ReferenceSimulator implements ReadonlyCapabilityProvider {
  private readonly calls: string[] = [];

  public readStatus(): ReadonlySimulatorResult {
    this.calls.push('sim.status.read/v1');

    return {
      mode: 'idle',
      source: 'reference-simulator',
      temperatureC: 21.5,
    };
  }

  public get operationCount(): number {
    return this.calls.length;
  }
}

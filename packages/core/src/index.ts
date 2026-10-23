import {
  ContractError,
  parseCapabilityInvokeParams,
  parseCapabilityListParams,
  parseInitializeParams,
  parseJsonRpcRequest,
  parseTaskGetParams,
  PROTOCOL_VERSION,
  READONLY_SIM_CAPABILITY,
  READONLY_SIM_SCHEMA_VERSION,
  type ReadonlyCapabilityProvider,
  toJsonRpcFailure,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type JsonValue,
} from '../../contracts/src/index.js';
import { PolicyAuthority, type ReadonlyAdmission } from '../../policy/src/index.js';
import type { BoundWorkloadIdentity } from '../../supervisor/src/index.js';

interface RuntimeCoreOptions {
  policy: PolicyAuthority;
  provider: ReadonlyCapabilityProvider;
}

export class RuntimeCore {
  private readonly initializedChannels = new Set<string>();

  public constructor(private readonly options: RuntimeCoreOptions) {}

  public handle(identity: BoundWorkloadIdentity, input: unknown): JsonRpcResponse {
    let requestId: number | string | null = null;

    try {
      const request = parseJsonRpcRequest(input);
      requestId = request.id;

      switch (request.method) {
        case 'runtime.initialize':
          return this.initialize(identity, request.params, request.id);
        case 'capabilities.list':
          return this.listCapabilities(identity, request.params, request.id);
        case 'capabilities.invoke':
          return this.invokeCapability(identity, request.params, request.id);
        case 'tasks.get':
          return this.getTask(identity, request.params, request.id);
        default:
          throw new ContractError(
            'QD_UNSUPPORTED_CAPABILITY',
            'This method is not supported by the current runtime.',
            -32601,
          );
      }
    } catch (error) {
      if (error instanceof ContractError) {
        return toJsonRpcFailure(requestId, error);
      }

      return toJsonRpcFailure(
        requestId,
        new ContractError('QD_VALIDATION_FAILED', 'Invalid request parameters.'),
      );
    }
  }

  private initialize(
    identity: BoundWorkloadIdentity,
    params: Record<string, JsonValue>,
    requestId: number | string,
  ): JsonRpcSuccess {
    const initializeParams = parseInitializeParams(params);

    if (
      initializeParams.protocolVersion !== PROTOCOL_VERSION ||
      initializeParams.requiredFeatures.length > 0
    ) {
      throw new ContractError(
        'QD_INCOMPATIBLE_VERSION',
        'The requested protocol version or feature set is not supported.',
        -32002,
      );
    }

    this.initializedChannels.add(identity.channelId);

    return success(requestId, {
      instance: {
        bootId: identity.bootId,
        epoch: identity.epoch,
        instanceId: identity.instanceId,
      },
      protocolVersion: PROTOCOL_VERSION,
      supportedFeatures: [],
    });
  }

  private listCapabilities(
    identity: BoundWorkloadIdentity,
    params: Record<string, JsonValue>,
    requestId: number | string,
  ): JsonRpcSuccess {
    this.requireInitialized(identity);
    const listParams = parseCapabilityListParams(params);
    const allowedCapabilities = this.options.policy.listAllowedCapabilities(identity);
    const capabilities = allowedCapabilities
      .filter(
        (capability) =>
          listParams.capabilityPrefix === undefined ||
          capability.startsWith(listParams.capabilityPrefix),
      )
      .map((capability) => ({
        capability,
        schemaVersion: READONLY_SIM_SCHEMA_VERSION,
      }));

    return success(requestId, { capabilities });
  }

  private invokeCapability(
    identity: BoundWorkloadIdentity,
    params: Record<string, JsonValue>,
    requestId: number | string,
  ): JsonRpcSuccess {
    this.requireInitialized(identity);
    const invokeParams = parseCapabilityInvokeParams(params);

    if (
      invokeParams.capability !== READONLY_SIM_CAPABILITY ||
      invokeParams.schemaVersion !== READONLY_SIM_SCHEMA_VERSION
    ) {
      throw new ContractError(
        'QD_UNSUPPORTED_CAPABILITY',
        'The requested capability or schema is not supported.',
        -32004,
      );
    }

    if (Object.keys(invokeParams.arguments).length > 0) {
      throw new ContractError('QD_VALIDATION_FAILED', 'Invalid request parameters.');
    }

    const admission = this.admitReadonlyInvocation(identity, invokeParams.arguments);
    const simulatorResult = this.readSimulatorResult(admission);
    const result: JsonValue = {
      mode: simulatorResult.mode,
      source: simulatorResult.source,
      temperatureC: simulatorResult.temperatureC,
    };
    this.recordSimulatorResult(admission, result);

    return success(requestId, {
      result,
      task: {
        admissionId: admission.admissionId,
        state: 'succeeded',
        taskId: admission.taskId,
      },
    });
  }

  private getTask(
    identity: BoundWorkloadIdentity,
    params: Record<string, JsonValue>,
    requestId: number | string,
  ): JsonRpcSuccess {
    this.requireInitialized(identity);
    const taskParams = parseTaskGetParams(params);
    const task = this.options.policy.getTask(identity, taskParams.taskId);

    return success(requestId, {
      task: {
        admissionId: task.admissionId,
        result: task.result,
        state: task.state,
        taskId: task.taskId,
      },
    });
  }

  private requireInitialized(identity: BoundWorkloadIdentity): void {
    if (!this.initializedChannels.has(identity.channelId)) {
      throw new ContractError(
        'QD_STALE_CONTEXT',
        'Initialize the current channel before calling this method.',
        -32003,
      );
    }
  }

  private admitReadonlyInvocation(
    identity: BoundWorkloadIdentity,
    argumentsValue: Record<string, JsonValue>,
  ): ReadonlyAdmission {
    try {
      return this.options.policy.admitReadonlyInvocation(identity, argumentsValue);
    } catch (error) {
      if (error instanceof ContractError) {
        throw error;
      }

      throw new ContractError(
        'QD_PROVIDER_UNAVAILABLE',
        'Authorization service is unavailable.',
        -32009,
      );
    }
  }

  private readSimulatorResult(admission: ReadonlyAdmission) {
    try {
      return this.options.provider.readStatus();
    } catch {
      this.preserveUnknownOutcome(admission);
    }
  }

  private recordSimulatorResult(admission: ReadonlyAdmission, result: JsonValue): void {
    try {
      this.options.policy.recordReadonlyOutcome(admission, result);
    } catch {
      this.preserveUnknownOutcome(admission);
    }
  }

  private preserveUnknownOutcome(admission: ReadonlyAdmission): never {
    try {
      this.options.policy.recordUnknownOutcome(admission);
    } catch {
      // A second persistence fault cannot establish a result. The stable error still
      // prevents callers from treating the admission as a rejected input error.
    }

    throw new ContractError(
      'QD_OUTCOME_UNKNOWN',
      'The provider outcome is unknown. Reconcile before retrying.',
      -32010,
      'manual-reconcile',
      admission.taskId,
    );
  }
}

function success(id: number | string, result: JsonValue): JsonRpcSuccess {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

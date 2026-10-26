import {
  ADMISSION_FEATURE,
  ContractError,
  COUNTER_SIM_CAPABILITY,
  COUNTER_SIM_SCHEMA_VERSION,
  parseCapabilityInvokeParams,
  parseCapabilityListParams,
  parseCounterAddArguments,
  parseInitializeParams,
  parseJsonRpcRequest,
  parseTaskCancelParams,
  parseTaskGetParams,
  PROTOCOL_VERSION,
  READONLY_SIM_CAPABILITY,
  READONLY_SIM_SCHEMA_VERSION,
  type CounterCapabilityProvider,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type JsonValue,
  type ReadonlyCapabilityProvider,
  toJsonRpcFailure,
} from '../../contracts/src/index.js';
import {
  PolicyAuthority,
  type CounterTask,
  type ReadonlyAdmission,
} from '../../policy/src/index.js';
import type { BoundWorkloadIdentity } from '../../supervisor/src/index.js';

interface RuntimeCoreOptions {
  counterProvider?: CounterCapabilityProvider;
  policy: PolicyAuthority;
  provider: ReadonlyCapabilityProvider;
}

interface ChannelFeatures {
  admission: boolean;
}

/** Public JSON-RPC and trusted scheduler entry points share one PolicyAuthority. */
export class RuntimeCore {
  private readonly initializedChannels = new Map<string, ChannelFeatures>();

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
        case 'tasks.cancel':
          return this.cancelTask(identity, request.params, request.id);
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

  /** Trusted fixture/supervisor entry point. It never consumes public DTO authority. */
  public dispatchQueuedCounterTask(identity: BoundWorkloadIdentity, taskId: string): CounterTask {
    const provider = this.requireCounterProvider();
    const sessionId = this.options.policy.acquireTrustedExecutorSession(identity);
    const dispatch = this.options.policy.commitCounterDispatch(identity, taskId, sessionId);
    const task = this.options.policy.getCounterTask(identity, taskId);

    if (dispatch.decision !== 'fresh') {
      return task;
    }

    try {
      const observation = provider.invoke({
        admissionId: task.admissionId,
        amount: task.amount,
        counterId: task.counterId,
        providerEpoch: task.providerEpoch,
        taskId: task.taskId,
      });
      return this.options.policy.recordProviderObservation(
        identity,
        taskId,
        sessionId,
        observation,
        'provider-invoke',
      );
    } catch (error) {
      this.preserveUnknown(identity, taskId, sessionId);
      throw unknown(taskId, error);
    }
  }

  /** Trusted recovery only queries the historical provider record; it never invokes again. */
  public reconcileCounterTask(identity: BoundWorkloadIdentity, taskId: string): CounterTask {
    const provider = this.requireCounterProvider();
    const sessionId = this.options.policy.acquireTrustedExecutorSession(identity);
    const task = this.options.policy.getCounterTask(identity, taskId);

    try {
      const observation = provider.observe(task.admissionId, task.providerEpoch);
      return this.options.policy.recordProviderObservation(
        identity,
        taskId,
        sessionId,
        observation,
        'provider-reconcile',
      );
    } catch (error) {
      this.preserveUnknown(identity, taskId, sessionId);
      throw unknown(taskId, error);
    }
  }

  public markCounterObservationDeadline(
    identity: BoundWorkloadIdentity,
    taskId: string,
  ): CounterTask {
    const sessionId = this.options.policy.acquireTrustedExecutorSession(identity);
    return this.options.policy.markObservationDeadlineUnknown(identity, taskId, sessionId);
  }

  public recoverAfterConfirmedExecutorExit(
    identity: BoundWorkloadIdentity,
    sessionId: string,
  ): CounterTask[] {
    return this.options.policy.recoverAfterConfirmedExecutorExit(identity, sessionId);
  }

  private initialize(
    identity: BoundWorkloadIdentity,
    params: Record<string, JsonValue>,
    requestId: number | string,
  ): JsonRpcSuccess {
    const initialized = parseInitializeParams(params);
    const admission = initialized.requiredFeatures.includes(ADMISSION_FEATURE);
    const unknownFeature = initialized.requiredFeatures.some(
      (feature) => feature !== ADMISSION_FEATURE,
    );

    if (
      initialized.protocolVersion !== PROTOCOL_VERSION ||
      unknownFeature ||
      (admission && this.options.counterProvider === undefined)
    ) {
      throw new ContractError(
        'QD_INCOMPATIBLE_VERSION',
        'The requested protocol version or feature set is not supported.',
        -32002,
      );
    }

    if (admission) {
      this.options.policy.validateAdmissionContext(identity);
    }

    this.initializedChannels.set(identity.channelId, { admission });

    return success(requestId, {
      instance: {
        bootId: identity.bootId,
        epoch: identity.epoch,
        instanceId: identity.instanceId,
      },
      protocolVersion: PROTOCOL_VERSION,
      supportedFeatures: this.options.counterProvider === undefined ? [] : [ADMISSION_FEATURE],
    });
  }

  private listCapabilities(
    identity: BoundWorkloadIdentity,
    params: Record<string, JsonValue>,
    requestId: number | string,
  ): JsonRpcSuccess {
    const features = this.requireInitialized(identity);
    const list = parseCapabilityListParams(params);
    const readonlyCapabilities = this.options.policy
      .listAllowedCapabilities(identity)
      .filter(
        (capability) =>
          list.capabilityPrefix === undefined || capability.startsWith(list.capabilityPrefix),
      )
      .map((capability) => ({ capability, schemaVersion: READONLY_SIM_SCHEMA_VERSION }));
    const counterCapabilities = features.admission
      ? this.options.policy
          .listAllowedCounterCapabilities(identity)
          .filter(
            (capability) =>
              list.capabilityPrefix === undefined || capability.startsWith(list.capabilityPrefix),
          )
          .map((capability) => ({ capability, schemaVersion: COUNTER_SIM_SCHEMA_VERSION }))
      : [];
    const capabilities = [...readonlyCapabilities, ...counterCapabilities];
    return success(requestId, { capabilities });
  }

  private invokeCapability(
    identity: BoundWorkloadIdentity,
    params: Record<string, JsonValue>,
    requestId: number | string,
  ): JsonRpcSuccess {
    const features = this.requireInitialized(identity);
    const invocation = parseCapabilityInvokeParams(params);

    if (
      invocation.capability === READONLY_SIM_CAPABILITY &&
      invocation.schemaVersion === READONLY_SIM_SCHEMA_VERSION
    ) {
      if (invocation.idempotencyKey !== undefined || Object.keys(invocation.arguments).length > 0) {
        throw validation();
      }

      return this.invokeReadonly(identity, invocation.arguments, requestId);
    }

    if (
      invocation.capability !== COUNTER_SIM_CAPABILITY ||
      invocation.schemaVersion !== COUNTER_SIM_SCHEMA_VERSION
    ) {
      throw unsupported();
    }

    if (!features.admission || invocation.idempotencyKey === undefined) {
      throw new ContractError(
        'QD_INCOMPATIBLE_VERSION',
        'The admission feature must be negotiated before invoking this capability.',
        -32002,
      );
    }

    const input = parseCounterAddArguments(invocation.arguments);
    const task = this.options.policy.enqueueCounterTask(identity, input, invocation.idempotencyKey);

    return success(requestId, { task: taskHandle(task) });
  }

  private invokeReadonly(
    identity: BoundWorkloadIdentity,
    argumentsValue: Record<string, JsonValue>,
    requestId: number | string,
  ): JsonRpcSuccess {
    const admission = this.admitReadonly(identity, argumentsValue);

    try {
      const simulatorResult = this.options.provider.readStatus();
      const result: JsonValue = {
        mode: simulatorResult.mode,
        source: simulatorResult.source,
        temperatureC: simulatorResult.temperatureC,
      };
      this.options.policy.recordReadonlyOutcome(admission, result);
      return success(requestId, {
        result,
        task: {
          admissionId: admission.admissionId,
          state: 'succeeded',
          taskId: admission.taskId,
        },
      });
    } catch (error) {
      try {
        this.options.policy.recordUnknownOutcome(admission);
      } catch {
        // A second persistence error cannot establish a safe retry.
      }
      throw unknown(admission.taskId, error);
    }
  }

  private getTask(
    identity: BoundWorkloadIdentity,
    params: Record<string, JsonValue>,
    requestId: number | string,
  ): JsonRpcSuccess {
    const features = this.requireInitialized(identity);
    const taskParams = parseTaskGetParams(params);

    if (features.admission) {
      const task = this.options.policy.getCounterTask(identity, taskParams.taskId);
      return success(requestId, { task: taskHandle(task) });
    }

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

  private cancelTask(
    identity: BoundWorkloadIdentity,
    params: Record<string, JsonValue>,
    requestId: number | string,
  ): JsonRpcSuccess {
    const features = this.requireInitialized(identity);
    if (!features.admission) {
      throw unsupported();
    }
    const request = parseTaskCancelParams(params);
    const task = this.options.policy.requestCancellation(identity, request.taskId, request.reason);

    if (task.state === 'canceled') {
      return success(requestId, { task: taskHandle(task) });
    }

    const provider = this.requireCounterProvider();
    const sessionId = this.options.policy.acquireTrustedExecutorSession(identity);
    try {
      const observation = provider.cancel(task.admissionId, task.providerEpoch);
      const observed = this.options.policy.recordProviderObservation(
        identity,
        task.taskId,
        sessionId,
        observation,
        'provider-cancel',
      );
      return success(requestId, { task: taskHandle(observed) });
    } catch (error) {
      this.preserveUnknown(identity, task.taskId, sessionId);
      throw unknown(task.taskId, error);
    }
  }

  private requireInitialized(identity: BoundWorkloadIdentity): ChannelFeatures {
    const features = this.initializedChannels.get(identity.channelId);
    if (features === undefined) {
      throw stale();
    }
    return features;
  }

  private requireCounterProvider(): CounterCapabilityProvider {
    if (this.options.counterProvider === undefined) {
      throw unsupported();
    }
    return this.options.counterProvider;
  }

  private admitReadonly(
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

  private preserveUnknown(
    identity: BoundWorkloadIdentity,
    taskId: string,
    sessionId: string,
  ): void {
    try {
      this.options.policy.markObservationDeadlineUnknown(identity, taskId, sessionId);
    } catch {
      // Durable unknown evidence may be unavailable after a storage fault.
    }
  }
}

function taskHandle(task: CounterTask): JsonValue {
  return {
    admissionId: task.admissionId,
    cancelRequested: task.cancelRequested,
    result: task.result,
    state: task.state,
    stateVersion: task.stateVersion,
    taskId: task.taskId,
  };
}

function success(id: number | string, result: JsonValue): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function unsupported(): ContractError {
  return new ContractError(
    'QD_UNSUPPORTED_CAPABILITY',
    'The requested capability or schema is not supported.',
    -32004,
  );
}

function validation(): ContractError {
  return new ContractError('QD_VALIDATION_FAILED', 'Invalid request parameters.');
}

function stale(): ContractError {
  return new ContractError(
    'QD_STALE_CONTEXT',
    'Initialize the current channel before calling this method.',
    -32003,
  );
}

function unknown(taskId: string, _cause: unknown): ContractError {
  return new ContractError(
    'QD_OUTCOME_UNKNOWN',
    'The provider outcome is unknown. Reconcile before retrying.',
    -32010,
    'manual-reconcile',
    taskId,
  );
}

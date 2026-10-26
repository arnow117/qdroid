export const PROTOCOL_VERSION = 'qdroid.rpc/v0.1';
export const READONLY_SIM_CAPABILITY = 'sim.status.read/v1';
export const READONLY_SIM_SCHEMA_VERSION = 'qdroid.capability.sim.status.read/v1';
export const ADMISSION_FEATURE = 'qdroid.admission/v1';
export const COUNTER_SIM_CAPABILITY = 'sim.counter.add/v1';
export const COUNTER_SIM_SCHEMA_VERSION = 'qdroid.capability.sim.counter.add/v1';
export const COUNTER_SIM_RESOURCE = 'counter.default';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params: Record<string, JsonValue>;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string;
  result: JsonValue;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data: {
      code: DomainErrorCode;
      recovery: RecoveryClassification;
      taskId?: string;
    };
  };
}

export type JsonRpcResponse = JsonRpcFailure | JsonRpcSuccess;

export type DomainErrorCode =
  | 'QD_INCOMPATIBLE_VERSION'
  | 'QD_IDEMPOTENCY_CONFLICT'
  | 'QD_OUTCOME_UNKNOWN'
  | 'QD_PERMISSION_DENIED'
  | 'QD_PROVIDER_UNAVAILABLE'
  | 'QD_RESOURCE_LIMIT'
  | 'QD_STALE_CONTEXT'
  | 'QD_UNSUPPORTED_CAPABILITY'
  | 'QD_VALIDATION_FAILED';

export type RecoveryClassification =
  | 'correct-request'
  | 'do-not-retry'
  | 'manual-reconcile'
  | 're-establish-context'
  | 'retry-safe';

export class ContractError extends Error {
  public constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly rpcCode = -32602,
    public readonly recovery: RecoveryClassification = defaultRecovery(code),
    public readonly taskId?: string,
  ) {
    super(message);
  }
}

export interface InitializeParams {
  protocolVersion: string;
  requiredFeatures: string[];
}

export interface CapabilityListParams {
  capabilityPrefix?: string;
}

export interface CapabilityInvokeParams {
  capability: string;
  schemaVersion: string;
  arguments: Record<string, JsonValue>;
  idempotencyKey?: string;
}

export interface TaskGetParams {
  taskId: string;
}

export interface TaskCancelParams {
  reason: string;
  taskId: string;
}

export interface CounterAddArguments {
  amount: number;
  counterId: typeof COUNTER_SIM_RESOURCE;
}

export interface ReadonlySimulatorResult {
  mode: 'idle';
  source: 'reference-simulator';
  temperatureC: number;
}

export interface ReadonlyCapabilityProvider {
  readStatus(): ReadonlySimulatorResult;
}

export interface CounterProviderRequest {
  admissionId: string;
  amount: number;
  counterId: typeof COUNTER_SIM_RESOURCE;
  providerEpoch: number;
  taskId: string;
}

export interface CounterProviderObservation {
  admissionId: string;
  observationVersion: number;
  operationId?: string;
  providerEpoch: number;
  result?: JsonValue;
  terminal: 'accepted' | 'completed' | 'failed' | 'stopped' | 'unsupported';
}

export interface CounterCapabilityProvider {
  cancel(admissionId: string, providerEpoch: number): CounterProviderObservation;
  invoke(request: CounterProviderRequest): CounterProviderObservation;
  observe(admissionId: string, providerEpoch: number): CounterProviderObservation;
}

export function parseJsonRpcRequest(value: unknown): JsonRpcRequest {
  const record = requireRecord(value);
  requireExactKeys(
    record,
    ['jsonrpc', 'id', 'method', 'params'],
    ['jsonrpc', 'id', 'method', 'params'],
  );

  if (record.jsonrpc !== '2.0') {
    throw validationError();
  }

  const requestId = record.id;

  if (requestId === undefined || !isBoundedRequestId(requestId)) {
    throw validationError();
  }

  if (!isBoundedString(record.method, 120)) {
    throw validationError();
  }

  const params = requireRecord(record.params);

  return {
    jsonrpc: '2.0',
    id: requestId,
    method: record.method,
    params,
  };
}

export function parseInitializeParams(params: Record<string, JsonValue>): InitializeParams {
  requireExactKeys(
    params,
    ['protocolVersion', 'requiredFeatures'],
    ['protocolVersion', 'requiredFeatures'],
  );

  if (
    !isBoundedString(params.protocolVersion, 80) ||
    !isStringArray(params.requiredFeatures, 32, 80)
  ) {
    throw validationError();
  }

  return {
    protocolVersion: params.protocolVersion,
    requiredFeatures: params.requiredFeatures,
  };
}

export function parseCapabilityListParams(params: Record<string, JsonValue>): CapabilityListParams {
  requireExactKeys(params, ['capabilityPrefix'], []);

  if (params.capabilityPrefix !== undefined && !isBoundedString(params.capabilityPrefix, 120)) {
    throw validationError();
  }

  return params.capabilityPrefix === undefined
    ? {}
    : {
        capabilityPrefix: params.capabilityPrefix,
      };
}

export function parseCapabilityInvokeParams(
  params: Record<string, JsonValue>,
): CapabilityInvokeParams {
  requireExactKeys(
    params,
    ['capability', 'schemaVersion', 'arguments', 'idempotencyKey'],
    ['capability', 'schemaVersion', 'arguments'],
  );

  if (!isBoundedString(params.capability, 160) || !isBoundedString(params.schemaVersion, 160)) {
    throw validationError();
  }

  const argumentsValue = requireRecord(params.arguments);

  if (params.idempotencyKey !== undefined && !isBoundedUnicodeString(params.idempotencyKey, 128)) {
    throw validationError();
  }

  return {
    capability: params.capability,
    schemaVersion: params.schemaVersion,
    arguments: argumentsValue,
    ...(params.idempotencyKey === undefined ? {} : { idempotencyKey: params.idempotencyKey }),
  };
}

export function parseTaskGetParams(params: Record<string, JsonValue>): TaskGetParams {
  requireExactKeys(params, ['taskId'], ['taskId']);

  if (!isBoundedString(params.taskId, 160)) {
    throw validationError();
  }

  return {
    taskId: params.taskId,
  };
}

export function parseTaskCancelParams(params: Record<string, JsonValue>): TaskCancelParams {
  requireExactKeys(params, ['taskId', 'reason'], ['taskId', 'reason']);

  if (!isBoundedString(params.taskId, 160) || !isBoundedUnicodeString(params.reason, 256)) {
    throw validationError();
  }

  return {
    reason: params.reason,
    taskId: params.taskId,
  };
}

export function parseCounterAddArguments(value: Record<string, JsonValue>): CounterAddArguments {
  requireExactKeys(value, ['counterId', 'amount'], ['counterId', 'amount']);

  if (
    value.counterId !== COUNTER_SIM_RESOURCE ||
    typeof value.amount !== 'number' ||
    !Number.isInteger(value.amount) ||
    value.amount < 1 ||
    value.amount > 10
  ) {
    throw validationError();
  }

  return {
    amount: value.amount,
    counterId: COUNTER_SIM_RESOURCE,
  };
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw validationError();
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  const entries = keys.map((key) => {
    const entry = value[key];

    if (entry === undefined) {
      throw validationError();
    }

    return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
  });
  return `{${entries.join(',')}}`;
}

export function toJsonRpcFailure(id: number | string | null, error: ContractError): JsonRpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: error.rpcCode,
      message: error.message,
      data: {
        code: error.code,
        recovery: error.recovery,
        ...(error.taskId === undefined ? {} : { taskId: error.taskId }),
      },
    },
  };
}

export function validationError(): ContractError {
  return new ContractError('QD_VALIDATION_FAILED', 'Invalid request parameters.');
}

function defaultRecovery(code: DomainErrorCode): RecoveryClassification {
  switch (code) {
    case 'QD_OUTCOME_UNKNOWN':
      return 'manual-reconcile';
    case 'QD_PROVIDER_UNAVAILABLE':
      return 'retry-safe';
    case 'QD_STALE_CONTEXT':
      return 're-establish-context';
    case 'QD_VALIDATION_FAILED':
      return 'correct-request';
    case 'QD_INCOMPATIBLE_VERSION':
    case 'QD_IDEMPOTENCY_CONFLICT':
    case 'QD_PERMISSION_DENIED':
    case 'QD_RESOURCE_LIMIT':
    case 'QD_UNSUPPORTED_CAPABILITY':
      return 'do-not-retry';
  }
}

function requireRecord(value: unknown): Record<string, JsonValue> {
  if (!isRecord(value)) {
    throw validationError();
  }

  return value;
}

function requireExactKeys(
  record: Record<string, JsonValue>,
  allowed: string[],
  required: string[],
): void {
  const allowedKeys = new Set(allowed);
  const hasOnlyAllowedKeys = Object.keys(record).every((key) => allowedKeys.has(key));
  const hasRequiredKeys = required.every((key) => Object.hasOwn(record, key));

  if (!hasOnlyAllowedKeys || !hasRequiredKeys) {
    throw validationError();
  }
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedRequestId(value: JsonValue): value is number | string {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  return isBoundedString(value, 128);
}

function isBoundedString(value: JsonValue | undefined, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isBoundedUnicodeString(value: JsonValue | undefined, maxLength: number): value is string {
  return isBoundedString(value, maxLength) && !hasUnpairedSurrogate(value);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);

    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = value.charCodeAt(index + 1);

      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }

      index += 1;
      continue;
    }

    if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      return true;
    }
  }

  return false;
}

function isStringArray(
  value: JsonValue | undefined,
  maxEntries: number,
  maxStringLength: number,
): value is string[] {
  if (!Array.isArray(value) || value.length > maxEntries) {
    return false;
  }

  const entriesAreStrings = value.every(
    (entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= maxStringLength,
  );

  return entriesAreStrings && new Set(value).size === value.length;
}

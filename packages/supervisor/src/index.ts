import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  ContractError,
  toJsonRpcFailure,
  type JsonRpcResponse,
  type JsonValue,
} from '../../contracts/src/index.js';

export interface BoundWorkloadIdentity {
  installationId: string;
  instanceId: string;
  bootId: string;
  epoch: number;
  channelId: string;
}

export interface CreateBoundChannelOptions {
  installationId: string;
}

export interface SupervisorOptions {
  hostBootId?: string;
}

export interface StdioSessionLimits {
  maxFrameBytes: number;
  maxTotalBytes: number;
}

export type BoundRequestHandler = (
  identity: BoundWorkloadIdentity,
  request: unknown,
) => JsonRpcResponse;

export class Supervisor {
  private readonly hostBootId: string;

  public constructor(
    private readonly requestHandler: BoundRequestHandler,
    options: SupervisorOptions = {},
  ) {
    this.hostBootId = options.hostBootId ?? `boot-${randomUUID()}`;
  }

  public createBoundChannel(options: CreateBoundChannelOptions): SupervisedChannel {
    const identity: BoundWorkloadIdentity = {
      installationId: options.installationId,
      instanceId: `instance-${randomUUID()}`,
      bootId: this.hostBootId,
      epoch: 1,
      channelId: `channel-${randomUUID()}`,
    };

    return new SupervisedChannel(identity, this.requestHandler);
  }
}

export class SupervisedChannel {
  public constructor(
    private readonly identity: BoundWorkloadIdentity,
    private readonly requestHandler: BoundRequestHandler,
  ) {}

  public request(request: unknown): JsonRpcResponse {
    return this.requestHandler(this.identity, request);
  }

  public get trustedInstanceId(): string {
    return this.identity.instanceId;
  }

  public get trustedBinding(): Readonly<BoundWorkloadIdentity> {
    return this.identity;
  }
}

/**
 * Reads the Linux kernel boot ID from the trusted broker host. Workload input,
 * Docker labels, and application configuration are not identity sources.
 */
export async function createLinuxSupervisor(
  requestHandler: BoundRequestHandler,
): Promise<Supervisor> {
  const bootId = await readTrustedLinuxBootId();

  return new Supervisor(requestHandler, { hostBootId: bootId });
}

export async function readTrustedLinuxBootId(): Promise<string> {
  const contents = await readFile('/proc/sys/kernel/random/boot_id', 'utf8');
  const bootId = contents.trim();

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bootId)) {
    throw new Error('The trusted Linux host did not provide a valid boot identity.');
  }

  return bootId;
}

/**
 * Bounded, newline-delimited JSON-RPC transport for a supervisor-owned stdio
 * channel. It accepts JSON only after rejecting duplicate object keys.
 */
export class BoundedStdioSession {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly responses: JsonRpcResponse[] = [];
  private pending = '';
  private rejected = false;
  private totalBytes = 0;

  public constructor(
    private readonly channel: SupervisedChannel,
    private readonly limits: StdioSessionLimits,
  ) {}

  public accept(chunk: Uint8Array): void {
    if (this.rejected) {
      return;
    }

    this.totalBytes += chunk.byteLength;

    if (this.totalBytes > this.limits.maxTotalBytes) {
      this.rejectStream();
      return;
    }

    try {
      this.pending += this.decoder.decode(chunk, { stream: true });
    } catch {
      this.rejectStream();
      return;
    }

    this.consumeCompleteFrames();
  }

  public end(): void {
    if (this.rejected) {
      return;
    }

    try {
      this.pending += this.decoder.decode();
    } catch {
      this.rejectStream();
      return;
    }

    if (this.pending.length > 0) {
      this.rejectStream();
    }
  }

  public drainResponses(): JsonRpcResponse[] {
    const drained = [...this.responses];
    this.responses.length = 0;
    return drained;
  }

  public drainEncodedResponses(): string[] {
    return this.drainResponses().map((response) => `${JSON.stringify(response)}\n`);
  }

  private consumeCompleteFrames(): void {
    let separatorIndex = this.pending.indexOf('\n');

    while (separatorIndex >= 0) {
      const rawFrame = this.pending.slice(0, separatorIndex).replace(/\r$/, '');
      this.pending = this.pending.slice(separatorIndex + 1);
      this.handleFrame(rawFrame);
      separatorIndex = this.pending.indexOf('\n');
    }

    if (Buffer.byteLength(this.pending) > this.limits.maxFrameBytes) {
      this.rejectStream();
    }
  }

  private handleFrame(rawFrame: string): void {
    try {
      const request = parseStrictJsonFrame(rawFrame, this.limits.maxFrameBytes);
      this.responses.push(this.channel.request(request));
    } catch (error) {
      if (error instanceof ContractError) {
        this.responses.push(toJsonRpcFailure(null, error));
        return;
      }

      this.enqueueValidationFailure();
    }
  }

  private enqueueValidationFailure(): void {
    this.responses.push(
      toJsonRpcFailure(
        null,
        new ContractError('QD_VALIDATION_FAILED', 'Invalid request parameters.'),
      ),
    );
  }

  /**
   * A malformed, oversized, or non-UTF-8 stream cannot be resynchronized
   * safely. Reject the channel once so a suffix cannot become a new request.
   */
  private rejectStream(): void {
    if (this.rejected) {
      return;
    }

    this.rejected = true;
    this.pending = '';
    this.enqueueValidationFailure();
  }
}

export function parseStrictJsonFrame(rawFrame: string, maxFrameBytes: number): JsonValue {
  if (Buffer.byteLength(rawFrame) > maxFrameBytes) {
    throw validationFailure();
  }

  return new StrictJsonParser(rawFrame).parse();
}

class StrictJsonParser {
  private index = 0;

  public constructor(private readonly source: string) {}

  public parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();

    if (this.index !== this.source.length) {
      throw validationFailure();
    }

    return value;
  }

  private parseValue(): JsonValue {
    const character = this.source[this.index];

    if (character === '"') {
      return this.parseString();
    }

    if (character === '{') {
      return this.parseObject();
    }

    if (character === '[') {
      return this.parseArray();
    }

    if (character === 't' && this.consumeLiteral('true')) {
      return true;
    }

    if (character === 'f' && this.consumeLiteral('false')) {
      return false;
    }

    if (character === 'n' && this.consumeLiteral('null')) {
      return null;
    }

    if (character === '-' || (character !== undefined && /[0-9]/.test(character))) {
      return this.parseNumber();
    }

    throw validationFailure();
  }

  private parseObject(): { [key: string]: JsonValue } {
    this.expect('{');
    this.skipWhitespace();
    const record = Object.create(null) as { [key: string]: JsonValue };
    const keys = new Set<string>();

    if (this.source[this.index] === '}') {
      this.index += 1;
      return record;
    }

    while (true) {
      this.skipWhitespace();

      if (this.source[this.index] !== '"') {
        throw validationFailure();
      }

      const key = this.parseString();

      if (keys.has(key)) {
        throw validationFailure();
      }

      keys.add(key);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      record[key] = this.parseValue();
      this.skipWhitespace();

      if (this.source[this.index] === '}') {
        this.index += 1;
        return record;
      }

      this.expect(',');
    }
  }

  private parseArray(): JsonValue[] {
    this.expect('[');
    this.skipWhitespace();
    const entries: JsonValue[] = [];

    if (this.source[this.index] === ']') {
      this.index += 1;
      return entries;
    }

    while (true) {
      entries.push(this.parseValue());
      this.skipWhitespace();

      if (this.source[this.index] === ']') {
        this.index += 1;
        return entries;
      }

      this.expect(',');
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.expect('"');
    let value = '';

    while (this.index < this.source.length) {
      const character = this.source[this.index];

      if (character === '"') {
        this.index += 1;
        return value;
      }

      if (character === '\\') {
        this.index += 1;
        value += this.parseEscape();
        continue;
      }

      if (character === undefined || character.charCodeAt(0) < 0x20) {
        throw validationFailure();
      }

      value += character;
      this.index += 1;
    }

    throw validationFailure();
  }

  private parseEscape(): string {
    const character = this.source[this.index];
    this.index += 1;

    switch (character) {
      case '"':
      case '\\':
      case '/':
        return character;
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u':
        return this.parseUnicodeEscape();
      default:
        throw validationFailure();
    }
  }

  private parseUnicodeEscape(): string {
    const hex = this.source.slice(this.index, this.index + 4);

    if (!/^[0-9a-f]{4}$/i.test(hex)) {
      throw validationFailure();
    }

    this.index += 4;
    return String.fromCharCode(Number.parseInt(hex, 16));
  }

  private parseNumber(): number {
    const remaining = this.source.slice(this.index);
    const match = remaining.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);

    if (match === null) {
      throw validationFailure();
    }

    this.index += match[0].length;
    const value = Number(match[0]);

    if (!Number.isFinite(value)) {
      throw validationFailure();
    }

    return value;
  }

  private consumeLiteral(literal: string): boolean {
    if (!this.source.startsWith(literal, this.index)) {
      return false;
    }

    this.index += literal.length;
    return true;
  }

  private expect(expected: string): void {
    if (this.source[this.index] !== expected) {
      throw validationFailure();
    }

    this.index += 1;
  }

  private skipWhitespace(): void {
    while (/[\t\n\r ]/.test(this.source[this.index] ?? '')) {
      this.index += 1;
    }
  }
}

function validationFailure(): ContractError {
  return new ContractError('QD_VALIDATION_FAILED', 'Invalid request parameters.');
}

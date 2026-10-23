import { randomUUID } from 'node:crypto';

import type { JsonRpcRequest, JsonRpcResponse } from '../../contracts/src/index.js';

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

export type BoundRequestHandler = (
  identity: BoundWorkloadIdentity,
  request: unknown,
) => JsonRpcResponse;

export class Supervisor {
  public constructor(private readonly requestHandler: BoundRequestHandler) {}

  public createBoundChannel(options: CreateBoundChannelOptions): SupervisedChannel {
    const identity: BoundWorkloadIdentity = {
      installationId: options.installationId,
      instanceId: `instance-${randomUUID()}`,
      bootId: `boot-${randomUUID()}`,
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
}

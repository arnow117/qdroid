import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  connectTcp,
  hasAllNetworkControlReceipts,
  type NetworkControlReceipts,
} from '../../packages/runtime-oci/src/index.js';

class PendingTcpSocket extends EventEmitter {
  public endCalls = 0;
  public destroyCalls = 0;

  public constructor(private readonly destroyError?: Error) {
    super();
  }

  public end(): void {
    this.endCalls += 1;
  }

  public destroy(): void {
    this.destroyCalls += 1;

    if (this.destroyError !== undefined) {
      throw this.destroyError;
    }
  }
}

test('every synthetic network protocol requires its own positive broker receipt', () => {
  const allProtocols: NetworkControlReceipts = {
    dnsUdp: true,
    ipv6Tcp: true,
    tcpIpv4: true,
    udpIpv4: true,
  };

  assert.equal(hasAllNetworkControlReceipts(allProtocols), true);

  for (const protocol of Object.keys(allProtocols) as Array<keyof NetworkControlReceipts>) {
    const missingProtocol = { ...allProtocols, [protocol]: false };
    assert.equal(hasAllNetworkControlReceipts(missingProtocol), false);
  }
});

test('a pending TCP control connection is destroyed when its deadline expires', async () => {
  const socket = new PendingTcpSocket();

  await assert.rejects(
    connectTcp('127.0.0.1', 1, {
      connector: () => socket,
      timeoutMs: 5,
    }),
    /The TCP control connection did not complete within its deadline\./,
  );

  assert.equal(socket.destroyCalls, 1);
  assert.equal(socket.endCalls, 0);
});

test('a TCP cancellation failure does not replace its original deadline error', async () => {
  const socket = new PendingTcpSocket(new Error('socket cleanup failed'));

  await assert.rejects(
    connectTcp('127.0.0.1', 1, {
      connector: () => socket,
      timeoutMs: 5,
    }),
    /The TCP control connection did not complete within its deadline\./,
  );

  assert.equal(socket.destroyCalls, 1);
  assert.equal(socket.endCalls, 0);
});

test('a successful TCP control connection ends without destroying its socket', async () => {
  const socket = new PendingTcpSocket();

  await connectTcp('127.0.0.1', 1, {
    connector: () => {
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
    timeoutMs: 5,
  });

  assert.equal(socket.destroyCalls, 0);
  assert.equal(socket.endCalls, 1);
});

import type { LootSync, LootUpdate, ServerToClientEvents, ClientToServerEvents } from '@69-seconds/shared';
import type { Socket } from 'socket.io-client';
import { describe, expect, it, vi } from 'vitest';
import { SocketRoomClient } from './room-client.js';

type Handler = (...args: unknown[]) => void;

class FakeSocket {
  readonly handlers = new Map<string, Handler[]>();
  readonly io = { on: vi.fn() };
  connected = false;
  active = false;

  on(event: string, handler: Handler): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  off(): this {
    return this;
  }

  connect(): this {
    return this;
  }

  disconnect(): this {
    return this;
  }

  emitFromServer(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

const initialSync: LootSync = {
  sequence: 0,
  roomCode: 'ABC234',
  items: [{ id: 'loot-apples', catalogId: 'apples', position: { x: 100, y: 100 }, available: true }],
  carts: [{ id: 'cart-0', slot: 0, ownerPlayerId: 'player-1', itemIds: [] }],
  carriedCounts: [{ playerId: 'player-1', count: 0 }],
  carriedItemIds: [],
};

describe('SocketRoomClient gameplay synchronization', () => {
  it('replays a sync and subsequent updates that arrived before the game subscribed', () => {
    const socket = new FakeSocket();
    const client = new SocketRoomClient(socket as unknown as Socket<ServerToClientEvents, ClientToServerEvents>);
    const update: LootUpdate = {
      type: 'PICKED_UP',
      sequence: 1,
      roomCode: 'ABC234',
      playerId: 'player-1',
      itemId: 'loot-apples',
      carriedCount: 1,
    };

    socket.emitFromServer('loot:sync', initialSync);
    socket.emitFromServer('loot:update', update);

    const received: Array<LootSync | LootUpdate> = [];
    client.subscribeLootSync((sync) => received.push(sync));
    client.subscribeLootUpdates((nextUpdate) => received.push(nextUpdate));

    expect(received).toEqual([initialSync, update]);
  });
});

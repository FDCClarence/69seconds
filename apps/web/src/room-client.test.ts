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

  off(event: string, handler: Handler): this {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
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
  items: [{ id: 'loot-soup', catalogId: 'canned-soup', position: { x: 100, y: 100 }, available: true }],
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
      itemId: 'loot-soup',
      carriedCount: 1,
    };

    socket.emitFromServer('loot:sync', initialSync);
    socket.emitFromServer('loot:update', update);

    const received: Array<LootSync | LootUpdate> = [];
    client.subscribeLootSync((sync) => received.push(sync));
    client.subscribeLootUpdates((nextUpdate) => received.push(nextUpdate));

    expect(received).toEqual([initialSync, update]);
  });

  it('ignores duplicate updates and does not let an older sync discard newer cached state', () => {
    const socket = new FakeSocket();
    const client = new SocketRoomClient(socket as unknown as Socket<ServerToClientEvents, ClientToServerEvents>);
    const update: LootUpdate = {
      type: 'PICKED_UP', sequence: 3, roomCode: 'ABC234', playerId: 'player-1', itemId: 'loot-soup', carriedCount: 1,
    };

    socket.emitFromServer('loot:sync', { ...initialSync, sequence: 2 });
    socket.emitFromServer('loot:update', update);
    socket.emitFromServer('loot:update', update);
    socket.emitFromServer('loot:sync', { ...initialSync, sequence: 1, items: [] });

    const received: Array<LootSync | LootUpdate> = [];
    client.subscribeLootSync((sync) => received.push(sync));
    client.subscribeLootUpdates((nextUpdate) => received.push(nextUpdate));
    expect(received).toEqual([{ ...initialSync, sequence: 2 }, update]);
  });

  it('times out a stalled connection attempt and removes its temporary listeners', async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const client = new SocketRoomClient(socket as unknown as Socket<ServerToClientEvents, ClientToServerEvents>);
      const rejection = expect(client.createRoom()).rejects.toThrow('Could not connect to the room server');

      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      // The constructor's long-lived handlers remain; ensureConnected's handlers do not.
      expect(socket.handlers.get('connect')).toHaveLength(1);
      expect(socket.handlers.get('connect_error')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

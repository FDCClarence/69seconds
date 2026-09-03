import {
  SURVIVAL_CHARACTER_DEFAULTS,
  type LootSync,
  type LootUpdate,
  type ServerToClientEvents,
  type ClientToServerEvents,
  type SurvivalState,
} from '@69-seconds/shared';
import type { Socket } from 'socket.io-client';
import { describe, expect, it, vi } from 'vitest';
import { SocketRoomClient, type RoomClientError } from './room-client.js';

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

  it('accepts the committed survival state and rejects a malformed one', () => {
    const socket = new FakeSocket();
    const client = new SocketRoomClient(socket as unknown as Socket<ServerToClientEvents, ClientToServerEvents>);
    const state: SurvivalState = {
      stateId: 'survival:ABC234:71000',
      roomCode: 'ABC234',
      // The server's own day number, which the client forwards without touching.
      dayNumber: 1,
      startedAtMs: 71_000,
      households: [{
        playerId: 'player-1',
        displayName: 'Player 1',
        slot: 0,
        characters: [{
          id: 'player-1',
          displayName: 'Player 1',
          kind: 'MAIN',
          catalogId: null,
          isAlive: true,
          stats: SURVIVAL_CHARACTER_DEFAULTS.stats,
          dailyNutritionCost: 20,
          dailyHydrationCost: 20,
        }, {
          // A recruit with her own bigger tank, proving the client never assumes 100.
          id: 'loot-spot-01',
          displayName: 'Maya',
          kind: 'NPC',
          catalogId: 'maya',
          isAlive: true,
          stats: { ...SURVIVAL_CHARACTER_DEFAULTS.stats, health: { current: 100, max: 120 } },
          dailyNutritionCost: 20,
          dailyHydrationCost: 30,
        }],
        inventory: [{ id: 'loot-spot-02', catalogId: 'canned-soup', label: 'Canned Soup', category: 'food' }],
      }],
    };

    const received: SurvivalState[] = [];
    const errors: RoomClientError[] = [];
    client.subscribe({
      onRoom: () => {},
      onClosed: () => {},
      onConnection: () => {},
      onError: (error) => errors.push(error),
      onSurvivalState: (next) => received.push(next),
    });

    socket.emitFromServer('survival:state', state);
    expect(received).toEqual([state]);
    expect(errors).toEqual([]);

    // A stat above its own max could never come from the server, so it is
    // refused rather than rendered.
    socket.emitFromServer('survival:state', {
      ...state,
      households: [{
        ...state.households[0],
        characters: [{ ...state.households[0]!.characters[0], stats: {
          ...SURVIVAL_CHARACTER_DEFAULTS.stats,
          nutrition: { current: 200, max: 100 },
        } }],
      }],
    });
    expect(received).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'INVALID_PAYLOAD',
      message: 'Received an invalid survival state',
      retryable: true,
    });
  });
});

import {
  GAME,
  PLAYER_SPAWN_POSITIONS,
  type ClientToServerEvents,
  type InteractionRequest,
  type InteractionResult,
  type LootSync,
  type LootUpdate,
  type RoomCommandResult,
  type RoomPublicState,
  type ServerError,
  type ServerToClientEvents,
} from '@69-seconds/shared';
import { createServer, type Server as HttpServer } from 'node:http';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../db/schema.js';
import { attachSocketServer, type SocketServerHandle } from '../socket.js';

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const users = Array.from({ length: GAME.maxPlayers }, (_, index): UserRow => ({
  id: `00000000-0000-4000-8000-00000000010${index + 1}`,
  username: `looter${index + 1}`,
  email: `looter${index + 1}@example.com`,
  passwordHash: 'not-used',
  createdAt: new Date('2026-09-02T00:00:00.000Z'),
  updatedAt: new Date('2026-09-02T00:00:00.000Z'),
}));

const SPAWN_0 = PLAYER_SPAWN_POSITIONS[0]!;
const SPAWN_1 = PLAYER_SPAWN_POSITIONS[1]!;
/** Equidistant from slots 0 and 1, and inside the reach of both. */
const CONTESTED = { x: (SPAWN_0.x + SPAWN_1.x) / 2, y: (SPAWN_0.y + SPAWN_1.y) / 2 };

/**
 * One item sits on each spawn point, one sits between slots 0 and 1 so they can
 * genuinely race for it, and each cart is moved onto its owner's spawn. Every
 * player can therefore interact while standing still, which keeps the test about
 * server authority rather than about walking across the store.
 */
const lootSeam = {
  spawns: [
    ...PLAYER_SPAWN_POSITIONS.map((spawn, slot) => ({
      id: `loot-slot-${slot}`,
      catalogId: 'canned-soup' as const,
      x: spawn.x,
      y: spawn.y,
    })),
    { id: 'loot-contested', catalogId: 'bottled-water' as const, x: CONTESTED.x, y: CONTESTED.y },
  ],
  carts: PLAYER_SPAWN_POSITIONS.map((spawn, slot) => ({
    id: `cart-${slot}` as const,
    slot,
    label: `Cart ${slot + 1}`,
    x: spawn.x,
    y: spawn.y,
    width: 128,
    height: 72,
  })),
};

let requestCounter = 0;
function interaction(action: InteractionRequest['action'], targetId?: string): InteractionRequest {
  requestCounter += 1;
  return {
    requestId: `00000000-0000-4000-8000-${String(requestCounter).padStart(12, '0')}`,
    action,
    ...(targetId ? { targetId } : {}),
  };
}

function command(
  socket: TestClient,
  event: 'room:create' | 'room:join' | 'lobby:ready' | 'lobby:start',
  payload: Record<string, unknown>,
): Promise<RoomCommandResult> {
  return new Promise((resolve) => {
    (socket.emit as (name: string, body: Record<string, unknown>, callback: (result: RoomCommandResult) => void) => TestClient)(
      event,
      payload,
      resolve,
    );
  });
}

function requestInteraction(socket: TestClient, request: unknown): Promise<InteractionResult> {
  return new Promise((resolve) => {
    (socket.emit as (name: string, body: unknown, callback: (result: InteractionResult) => void) => TestClient)(
      'interaction:request',
      request,
      resolve,
    );
  });
}

function nextLootSync(socket: TestClient): Promise<LootSync> {
  return new Promise((resolve) => socket.once('loot:sync', resolve));
}

const LOOT_ITEM_COUNT = PLAYER_SPAWN_POSITIONS.length + 1;

function reasonOf(result: InteractionResult): string {
  return result.outcome === 'REJECTED' ? result.reason : result.outcome;
}

describe('authoritative loot over Socket.IO', () => {
  let httpServer: HttpServer;
  let sockets: SocketServerHandle;
  let origin: string;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    httpServer = createServer();
    const tokens = new Map(users.map((user, index) => [`token-${index + 1}`, user]));
    sockets = attachSocketServer(httpServer, {
      webOrigins: ['http://localhost:5173'],
      cookie: { name: '69s_session' },
      auth: { resolveSession: async (token) => tokens.get(token) ?? null },
      rooms: { reconnectGraceMs: 5_000, abandonedRoomTtlMs: 120_000, countdownDurationMs: 40 },
      loot: lootSeam,
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    await sockets.close();
    if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function newClient(index: number): TestClient {
    const socket: TestClient = createClient(origin, {
      autoConnect: false,
      transports: ['websocket'],
      extraHeaders: { Cookie: `69s_session=token-${index + 1}` },
      forceNew: true,
      reconnection: false,
    });
    clients.push(socket);
    return socket;
  }

  /** Reconnects and captures the sync the server emits during the handshake. */
  async function reconnect(index: number): Promise<{ socket: TestClient; sync: LootSync }> {
    const socket = newClient(index);
    const sync = nextLootSync(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    return { socket, sync: await sync };
  }

  async function connect(index: number): Promise<TestClient> {
    const socket: TestClient = createClient(origin, {
      autoConnect: false,
      transports: ['websocket'],
      extraHeaders: { Cookie: `69s_session=token-${index + 1}` },
      forceNew: true,
      reconnection: false,
    });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    return socket;
  }

  /** Brings a full room to LOOTING and returns each player's initial loot sync. */
  async function startMatch(playerCount = 2): Promise<{
    members: TestClient[];
    room: RoomPublicState;
    syncs: LootSync[];
  }> {
    const host = await connect(0);
    const created = await command(host, 'room:create', {});
    if (!created.ok || !created.room) throw new Error('Expected room creation to succeed');
    const members = [host];
    for (let index = 1; index < playerCount; index += 1) {
      const member = await connect(index);
      members.push(member);
      await command(member, 'room:join', { code: created.room.code });
    }
    for (const member of members) await command(member, 'lobby:ready', { ready: true });

    const syncPromises = members.map((member) => nextLootSync(member));
    const looting = members.map((member) => new Promise<RoomPublicState>((resolve) => {
      const listener = (room: RoomPublicState) => {
        if (room.phase !== 'LOOTING') return;
        member.off('lobby:state', listener);
        resolve(room);
      };
      member.on('lobby:state', listener);
    }));
    const started = await command(host, 'lobby:start', {});
    if (!started.ok || !started.room) throw new Error('Expected the match to start');
    const syncs = await Promise.all(syncPromises);
    const room = (await Promise.all(looting))[0]!;
    return { members, room, syncs };
  }

  it('hands each player the loot set with only their own inventory', async () => {
    const { room, syncs } = await startMatch(2);
    expect(room.phase).toBe('LOOTING');
    for (const [slot, sync] of syncs.entries()) {
      expect(sync.roomCode).toBe(room.code);
      expect(sync.items).toHaveLength(LOOT_ITEM_COUNT);
      expect(sync.carriedItemIds).toEqual([]);
      expect(sync.carts.find((cart) => cart.id === `cart-${slot}`)?.ownerPlayerId).toBe(users[slot]?.id);
      // The sync never carries another player's item IDs, only their counts.
      expect(sync.carriedCounts).toHaveLength(2);
    }
  }, 15_000);

  it('gives a contested item to exactly one racing client and removes it for both', async () => {
    const { members, room } = await startMatch(2);
    const contested = 'loot-contested';
    const updates: LootUpdate[] = [];
    members[1]?.on('loot:update', (update) => updates.push(update));

    // Both requests are in flight before either is resolved.
    const [first, second] = await Promise.all([
      requestInteraction(members[0]!, interaction('PICK_UP', contested)),
      requestInteraction(members[1]!, interaction('PICK_UP', contested)),
    ]);

    const outcomes = [reasonOf(first), reasonOf(second)].sort();
    expect(outcomes).toEqual(['ITEM_UNAVAILABLE', 'PICKED_UP'].sort());
    await new Promise((resolve) => setTimeout(resolve, 60));
    const pickups = updates.filter((update) => update.type === 'PICKED_UP' && update.itemId === contested);
    expect(pickups).toHaveLength(1);

    // A third attempt is refused, and a fresh sync agrees the item is gone.
    expect(reasonOf(await requestInteraction(members[1]!, interaction('PICK_UP', contested))))
      .toBe('ITEM_UNAVAILABLE');
    members[1]?.disconnect();
    const { sync: resync } = await reconnect(1);
    expect(resync.roomCode).toBe(room.code);
    expect(resync.items.find((item) => item.id === contested)?.available).toBe(false);
  }, 15_000);

  it('refuses a modified client that claims range, capacity, or another cart', async () => {
    const { members } = await startMatch(2);
    const host = members[0]!;

    // Slot 0 stands on its own spawn, so slot 1's item is two body widths away.
    expect(reasonOf(await requestInteraction(host, interaction('PICK_UP', 'loot-slot-2'))))
      .toBe('OUT_OF_RANGE');
    expect(reasonOf(await requestInteraction(host, interaction('DROP_OFF', 'cart-1'))))
      .toBe('NOT_YOUR_CART');
    expect(reasonOf(await requestInteraction(host, interaction('PICK_UP', 'loot-does-not-exist'))))
      .toBe('UNKNOWN_TARGET');

    const malformed = await new Promise<InteractionResult>((resolve) => {
      void requestInteraction(host, { requestId: 'not-a-uuid', action: 'PICK_UP' }).then(resolve);
    });
    expect(reasonOf(malformed)).toBe('INVALID_PAYLOAD');
  }, 15_000);

  it('reports a malformed interaction payload on the error channel as well', async () => {
    const { members } = await startMatch(1);
    const host = members[0]!;
    const error = new Promise<ServerError>((resolve) => host.once('game:error', resolve));
    void requestInteraction(host, { action: 'PICK_UP', targetId: 'loot-slot-0', outcome: 'PICKED_UP' });
    expect((await error).code).toBe('INVALID_PAYLOAD');
  }, 15_000);

  it('restores the exact carried inventory and cart after a reconnection', async () => {
    const { members, room } = await startMatch(2);
    const host = members[0]!;

    expect(reasonOf(await requestInteraction(host, interaction('PICK_UP', 'loot-slot-0')))).toBe('PICKED_UP');
    const deposit = await requestInteraction(host, interaction('DROP_OFF', 'cart-0'));
    expect(deposit).toMatchObject({ outcome: 'DEPOSITED', cartItemCount: 1 });

    host.disconnect();
    const { sync: restored } = await reconnect(0);
    expect(restored.roomCode).toBe(room.code);
    expect(restored.carriedItemIds).toEqual([]);
    expect(restored.carts.find((cart) => cart.id === 'cart-0')?.itemIds).toEqual(['loot-slot-0']);
    expect(restored.items.find((item) => item.id === 'loot-slot-0')?.available).toBe(false);
  }, 15_000);

  it('keeps four clients consistent through pickups, deposits, and replays', async () => {
    const { members, room } = await startMatch(GAME.maxPlayers);
    const observed = new Map<number, LootUpdate[]>();
    for (const [index, member] of members.entries()) {
      const seen: LootUpdate[] = [];
      observed.set(index, seen);
      member.on('loot:update', (update) => seen.push(update));
    }

    const pickups = await Promise.all(members.map((member, slot) =>
      requestInteraction(member, interaction('PICK_UP', `loot-slot-${slot}`))));
    expect(pickups.map(reasonOf)).toEqual(Array.from({ length: GAME.maxPlayers }, () => 'PICKED_UP'));

    const deposits = await Promise.all(members.map((member, slot) =>
      requestInteraction(member, interaction('DROP_OFF', `cart-${slot}`))));
    for (const deposit of deposits) expect(deposit).toMatchObject({ outcome: 'DEPOSITED', cartItemCount: 1 });

    // Replaying a committed deposit changes nothing and broadcasts nothing new.
    const replayed = await requestInteraction(members[0]!, {
      ...(deposits[0]!.outcome === 'DEPOSITED' ? { requestId: deposits[0]!.requestId } : {}),
      action: 'DROP_OFF',
      targetId: 'cart-0',
    });
    expect(replayed).toEqual(deposits[0]);

    await new Promise((resolve) => setTimeout(resolve, 80));
    for (const seen of observed.values()) {
      expect(seen.filter((update) => update.type === 'PICKED_UP')).toHaveLength(GAME.maxPlayers);
      expect(seen.filter((update) => update.type === 'DEPOSITED')).toHaveLength(GAME.maxPlayers);
    }
    members[1]?.disconnect();
    const { sync } = await reconnect(1);
    expect(sync.roomCode).toBe(room.code);
    // Only the untouched contested item is still on a shelf.
    expect(sync.items.filter((item) => item.available).map((item) => item.id)).toEqual(['loot-contested']);
    expect(sync.carts.flatMap((cart) => cart.itemIds)).toHaveLength(GAME.maxPlayers);
  }, 20_000);
});

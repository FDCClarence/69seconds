import {
  PLAYER_SPAWN_POSITIONS,
  SURVIVAL_CHARACTER_DEFAULTS,
  type ClientToServerEvents,
  type InteractionResult,
  type RoomCommandResult,
  type RoomPublicState,
  type ServerError,
  type ServerToClientEvents,
  type SurvivalConsumeResult,
  type SurvivalEndDayResult,
  type SurvivalState,
} from '@69-seconds/shared';
import { createServer, type Server as HttpServer } from 'node:http';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../db/schema.js';
import { attachSocketServer, type SocketServerHandle } from '../socket.js';

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const users = Array.from({ length: 2 }, (_, index): UserRow => ({
  id: `00000000-0000-4000-8000-00000000020${index + 1}`,
  username: `eater${index + 1}`,
  email: `eater${index + 1}@example.com`,
  passwordHash: 'not-used',
  createdAt: new Date('2026-09-02T00:00:00.000Z'),
  updatedAt: new Date('2026-09-02T00:00:00.000Z'),
}));

const SPAWN_0 = PLAYER_SPAWN_POSITIONS[0]!;
const SPAWN_1 = PLAYER_SPAWN_POSITIONS[1]!;

/**
 * Player 0 stands on a soup, a water, a meal, and a pistol; player 1 stands on
 * a soup of their own. Each cart sits on its owner's spawn, so both households
 * reach the survival day with real deposited inventory without anybody walking.
 */
const lootSeam = {
  spawns: [
    { id: 'loot-soup', catalogId: 'canned-soup', x: SPAWN_0.x, y: SPAWN_0.y },
    { id: 'loot-water', catalogId: 'bottled-water', x: SPAWN_0.x, y: SPAWN_0.y },
    { id: 'loot-mre', catalogId: 'microwave-meal', x: SPAWN_0.x, y: SPAWN_0.y },
    { id: 'loot-pistol', catalogId: 'pistol', x: SPAWN_0.x, y: SPAWN_0.y },
    { id: 'loot-their-soup', catalogId: 'canned-soup', x: SPAWN_1.x, y: SPAWN_1.y },
  ],
  npcSpawns: [],
  carts: [SPAWN_0, SPAWN_1].map((spawn, slot) => ({
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
function requestId(): string {
  requestCounter += 1;
  return `00000000-0000-4000-8000-${String(requestCounter).padStart(12, '0')}`;
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

function interact(socket: TestClient, action: string, targetId: string): Promise<InteractionResult> {
  return new Promise((resolve) => {
    (socket.emit as (name: string, body: unknown, callback: (result: InteractionResult) => void) => TestClient)(
      'interaction:request',
      { requestId: requestId(), action, targetId },
      resolve,
    );
  });
}

function consume(socket: TestClient, payload: Record<string, unknown>): Promise<SurvivalConsumeResult> {
  return new Promise((resolve) => {
    (socket.emit as (name: string, body: unknown, callback: (result: SurvivalConsumeResult) => void) => TestClient)(
      'survival:consume',
      payload,
      resolve,
    );
  });
}

function endDay(socket: TestClient): Promise<SurvivalEndDayResult> {
  return new Promise((resolve) => {
    (socket.emit as (name: string, body: unknown, callback: (result: SurvivalEndDayResult) => void) => TestClient)(
      'survival:end-day',
      {},
      resolve,
    );
  });
}

function nextLobbyState(socket: TestClient, predicate: (room: RoomPublicState) => boolean): Promise<RoomPublicState> {
  return new Promise((resolve) => {
    const listener = (room: RoomPublicState) => {
      if (!predicate(room)) return;
      socket.off('lobby:state', listener);
      resolve(room);
    };
    socket.on('lobby:state', listener);
  });
}

function nextSurvivalState(socket: TestClient, predicate: (state: SurvivalState) => boolean = () => true): Promise<SurvivalState> {
  return new Promise((resolve) => {
    const listener = (state: SurvivalState) => {
      if (!predicate(state)) return;
      socket.off('survival:state', listener);
      resolve(state);
    };
    socket.on('survival:state', listener);
  });
}

function householdOf(state: SurvivalState, playerId: string) {
  return state.households.find((household) => household.playerId === playerId)!;
}

function inventoryIds(state: SurvivalState, playerId: string): string[] {
  return householdOf(state, playerId).inventory.map((item) => item.id);
}

describe('authoritative survival feeding over Socket.IO', () => {
  let httpServer: HttpServer;
  let sockets: SocketServerHandle;
  let origin: string;
  let serverNowMs: number;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    serverNowMs = 1_000;
    httpServer = createServer();
    const tokens = new Map(users.map((user, index) => [`token-${index + 1}`, user]));
    sockets = attachSocketServer(httpServer, {
      webOrigins: ['http://localhost:5173'],
      cookie: { name: '69s_session' },
      auth: { resolveSession: async (token) => tokens.get(token) ?? null },
      rooms: {
        reconnectGraceMs: 60,
        abandonedRoomTtlMs: 120_000,
        countdownDurationMs: 10,
        now: () => serverNowMs,
      },
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

  /** Runs a whole looting match out and returns the two clients on open Day 1. */
  async function openedDay(): Promise<{ host: TestClient; second: TestClient; dayOne: SurvivalState }> {
    const host = await connect(0);
    const second = await connect(1);
    const created = await command(host, 'room:create', {});
    if (!created.ok || !created.room) throw new Error('Expected room creation success');
    await command(second, 'room:join', { code: created.room.code });
    await command(host, 'lobby:ready', { ready: true });
    await command(second, 'lobby:ready', { ready: true });

    const looting = nextLobbyState(host, (room) => room.phase === 'LOOTING');
    await command(host, 'lobby:start', {});
    serverNowMs = 1_010;
    const lootingDeadline = (await looting).phaseEndsAtMs!;

    for (const targetId of ['loot-soup', 'loot-water', 'loot-mre', 'loot-pistol']) {
      expect(await interact(host, 'PICK_UP', targetId)).toMatchObject({ outcome: 'PICKED_UP' });
    }
    expect(await interact(host, 'DROP_OFF', 'cart-0')).toMatchObject({ outcome: 'DEPOSITED' });
    expect(await interact(second, 'PICK_UP', 'loot-their-soup')).toMatchObject({ outcome: 'PICKED_UP' });
    expect(await interact(second, 'DROP_OFF', 'cart-1')).toMatchObject({ outcome: 'DEPOSITED' });

    const households = nextSurvivalState(host);
    serverNowMs = lootingDeadline;
    const dayOne = await households;
    expect(inventoryIds(dayOne, users[0]!.id))
      .toEqual(['loot-soup', 'loot-water', 'loot-mre', 'loot-pistol']);
    return { host, second, dayOne };
  }

  it('refuses a malformed intent, a forged owner, and another household\'s item or character', async () => {
    const { host, second, dayOne } = await openedDay();
    const errors: ServerError[] = [];
    host.on('game:error', (error) => errors.push(error));
    // Only a day the server actually replaced counts: the opening broadcast for
    // Day 1 may still be in flight to this second client.
    let broadcasts = 0;
    second.on('survival:state', (state) => {
      if (state.dayNumber === dayOne.dayNumber
        && householdOf(state, users[0]!.id).inventory.length === dayOne.households[0]!.inventory.length) return;
      broadcasts += 1;
    });

    // Anything beyond the intent itself is refused by the schema, so a claimed
    // result can never reach the authority in the first place.
    for (const forged of [
      { requestId: requestId(), itemId: 'loot-soup' },
      { requestId: requestId(), itemId: 'loot-soup', characterId: users[0]!.id, playerId: users[1]!.id },
      { requestId: requestId(), itemId: 'loot-soup', characterId: users[0]!.id, nutrition: { current: 100, max: 100 } },
      { requestId: 'not-a-uuid', itemId: 'loot-soup', characterId: users[0]!.id },
    ]) {
      expect(await consume(host, forged)).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PAYLOAD' });
    }

    // Their character and their soup are both out of reach, from either side.
    expect(await consume(host, { requestId: requestId(), itemId: 'loot-soup', characterId: users[1]!.id }))
      .toMatchObject({ outcome: 'REJECTED', reason: 'UNKNOWN_CHARACTER' });
    expect(await consume(second, { requestId: requestId(), itemId: 'loot-soup', characterId: users[1]!.id }))
      .toMatchObject({ outcome: 'REJECTED', reason: 'UNKNOWN_ITEM' });
    expect(await consume(host, { requestId: requestId(), itemId: 'loot-their-soup', characterId: users[0]!.id }))
      .toMatchObject({ outcome: 'REJECTED', reason: 'UNKNOWN_ITEM' });
    // A pistol is not food, and no rejection ever spends anything.
    expect(await consume(host, { requestId: requestId(), itemId: 'loot-pistol', characterId: users[0]!.id }))
      .toMatchObject({ outcome: 'REJECTED', reason: 'NOT_CONSUMABLE' });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(errors.map((error) => error.code)).toEqual(Array.from({ length: 4 }, () => 'INVALID_PAYLOAD'));
    // Nothing changed, so nothing was broadcast: not one of those rejections
    // produced a new committed day.
    expect(broadcasts).toBe(0);

    // The day that follows is built from the households as they still stand, so
    // it proves the rejections spent nothing rather than merely staying quiet.
    const dayTwoArrived = nextSurvivalState(host, (state) => state.dayNumber === dayOne.dayNumber + 1);
    serverNowMs = dayOne.startedAtMs + 1_000;
    await endDay(host);
    await endDay(second);
    const dayTwo = await dayTwoArrived;
    expect(inventoryIds(dayTwo, users[0]!.id)).toEqual(inventoryIds(dayOne, users[0]!.id));
    expect(inventoryIds(dayTwo, users[1]!.id)).toEqual(['loot-their-soup']);
    // Only the day's own costs moved a stat; no meal was ever served.
    expect(householdOf(dayTwo, users[0]!.id).characters[0]!.stats.nutrition).toEqual({
      current: 100 - SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost,
      max: 100,
    });
  });

  it('commits a feed, clamps it at the personal max, and broadcasts the day it produced', async () => {
    const { host, second, dayOne } = await openedDay();

    // One resolved day of the shared daily cost, so the soup has somewhere to go.
    const dayTwoArrived = nextSurvivalState(host, (state) => state.dayNumber === dayOne.dayNumber + 1);
    serverNowMs = dayOne.startedAtMs + 1_000;
    await endDay(host);
    await endDay(second);
    const dayTwo = await dayTwoArrived;
    const drained = householdOf(dayTwo, users[0]!.id).characters[0]!.stats;
    expect(drained.nutrition)
      .toEqual({ current: 100 - SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost, max: 100 });

    // The other household sees the change too, because the committed day is one
    // object the whole room shares.
    const broadcast = nextSurvivalState(second, (state) => state.dayNumber === dayTwo.dayNumber
      && householdOf(state, users[0]!.id).inventory.length === 3);
    const feedId = requestId();
    const result = await consume(host, { requestId: feedId, itemId: 'loot-soup', characterId: users[0]!.id });
    expect(result).toMatchObject({ outcome: 'CONSUMED', itemId: 'loot-soup', catalogId: 'canned-soup' });
    if (result.outcome !== 'CONSUMED') throw new Error('Expected a committed feed');
    // 80/100 plus a 50-point soup is 100/100, not 130/100.
    expect(result.character.stats.nutrition).toEqual({ current: 100, max: 100 });
    expect(result.inventory.map((item) => item.id)).toEqual(['loot-water', 'loot-mre', 'loot-pistol']);

    const seenByOthers = await broadcast;
    expect(householdOf(seenByOthers, users[0]!.id).characters[0]!.stats.nutrition)
      .toEqual({ current: 100, max: 100 });
    expect(inventoryIds(seenByOthers, users[0]!.id)).toEqual(['loot-water', 'loot-mre', 'loot-pistol']);

    // A duplicate delivery of the same request opens no second tin.
    let extraBroadcasts = 0;
    second.on('survival:state', () => { extraBroadcasts += 1; });
    const repeated = await consume(host, { requestId: feedId, itemId: 'loot-soup', characterId: users[0]!.id });
    expect(repeated).toEqual(result);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(extraBroadcasts).toBe(0);

    // And once this household has ended its day, feeding is closed for it alone.
    serverNowMs = dayTwo.startedAtMs + 1_000;
    expect(await endDay(host)).toMatchObject({ ok: true });
    expect(await consume(host, { requestId: requestId(), itemId: 'loot-water', characterId: users[0]!.id }))
      .toMatchObject({ outcome: 'REJECTED', reason: 'DAY_ALREADY_ENDED' });
    expect(await consume(second, { requestId: requestId(), itemId: 'loot-their-soup', characterId: users[1]!.id }))
      .toMatchObject({ outcome: 'CONSUMED' });
  });

  it('refuses feeding from a socket that is in no match at all', async () => {
    const stranger = await connect(0);
    expect(await consume(stranger, {
      requestId: requestId(),
      itemId: 'loot-soup',
      characterId: users[0]!.id,
    })).toMatchObject({ outcome: 'REJECTED', reason: 'NOT_IN_MATCH' });
  });
});

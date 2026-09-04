import {
  GAME,
  PLAYER_SPAWN_POSITIONS,
  type ClientToServerEvents,
  type RoomCommandResult,
  type RoomPublicState,
  type ServerToClientEvents,
  type SurvivalEndDayResult,
  type SurvivalReadinessState,
  type SurvivalState,
} from '@69-seconds/shared';
import { createServer, type Server as HttpServer } from 'node:http';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../db/schema.js';
import { attachSocketServer, type SocketServerHandle } from '../socket.js';

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const users = Array.from({ length: 2 }, (_, index): UserRow => ({
  id: `00000000-0000-4000-8000-00000000030${index + 1}`,
  username: `sleeper${index + 1}`,
  email: `sleeper${index + 1}@example.com`,
  passwordHash: 'not-used',
  createdAt: new Date('2026-09-02T00:00:00.000Z'),
  updatedAt: new Date('2026-09-02T00:00:00.000Z'),
}));

/** No loot and no people: this suite is about the day boundary, not the run. */
const lootSeam = {
  spawns: [],
  npcSpawns: [],
  carts: PLAYER_SPAWN_POSITIONS.slice(0, 2).map((spawn, slot) => ({
    id: `cart-${slot}` as const,
    slot,
    label: `Cart ${slot + 1}`,
    x: spawn.x,
    y: spawn.y,
    width: 128,
    height: 72,
  })),
};

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

function nextSurvivalState(socket: TestClient, predicate: (state: SurvivalState) => boolean): Promise<SurvivalState> {
  return new Promise((resolve) => {
    const listener = (state: SurvivalState) => {
      if (!predicate(state)) return;
      socket.off('survival:state', listener);
      resolve(state);
    };
    socket.on('survival:state', listener);
  });
}

describe('authoritative survival day rollover over Socket.IO', () => {
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

  /**
   * Runs the looting window out and returns both clients on the open Day 1,
   * along with the room state the buzzer published. The room broadcast and the
   * households arrive in the same tick, so both are awaited from listeners
   * attached before the clock is advanced.
   */
  async function openedDay(): Promise<{
    host: TestClient;
    second: TestClient;
    dayOne: SurvivalState;
    openingRoom: RoomPublicState;
  }> {
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

    const households = nextSurvivalState(host, () => true);
    const survivalRoom = nextLobbyState(host, (room) => room.phase === 'SURVIVAL');
    serverNowMs = lootingDeadline;
    const dayOne = await households;
    return { host, second, dayOne, openingRoom: await survivalRoom };
  }

  it('republishes the room deadline when a resolved day opens the next one', async () => {
    const { host, second, dayOne, openingRoom } = await openedDay();
    // The room state as every client has it while Day 1 is being played.
    expect(openingRoom.phaseEndsAtMs).toBe(dayOne.startedAtMs + GAME.survivalDurationMs);

    // Both households end early, which is what closes the day early.
    const rolledOver = nextLobbyState(second, (room) => room.phaseEndsAtMs !== openingRoom.phaseEndsAtMs);
    const dayTwoArrived = nextSurvivalState(second, (state) => state.dayNumber === dayOne.dayNumber + 1);
    const endedAtMs = dayOne.startedAtMs + 5_000;
    serverNowMs = endedAtMs;
    await endDay(host);
    await endDay(second);

    const dayTwo = await dayTwoArrived;
    const nextRoom = await rolledOver;
    // The phase never changed, but the deadline did: a client reading its day
    // countdown from the room would otherwise still be on Day 1's deadline for
    // the rest of the match, because survival emits no periodic snapshot.
    expect(nextRoom.phase).toBe('SURVIVAL');
    expect(dayTwo.startedAtMs).toBe(endedAtMs);
    expect(nextRoom.phaseEndsAtMs).toBe(endedAtMs + GAME.survivalDurationMs);
    // The clock the client measures that deadline against travels with it.
    expect(nextRoom.serverTimeMs).toBe(endedAtMs);
  });

  it('opens the new day with fresh readiness for every household', async () => {
    const { host, second, dayOne } = await openedDay();

    const readinessUpdates: SurvivalReadinessState[] = [];
    second.on('survival:readiness', (state) => readinessUpdates.push(state));
    const dayTwoArrived = nextSurvivalState(second, (state) => state.dayNumber === dayOne.dayNumber + 1);
    const endedAtMs = dayOne.startedAtMs + 5_000;
    serverNowMs = endedAtMs;
    await endDay(host);
    await endDay(second);
    await dayTwoArrived;
    await new Promise((resolve) => setTimeout(resolve, 80));

    const latest = readinessUpdates.at(-1)!;
    expect(latest.dayNumber).toBe(dayOne.dayNumber + 1);
    expect(latest.startedAtMs).toBe(endedAtMs);
    expect(latest.endsAtMs).toBe(endedAtMs + GAME.survivalDurationMs);
    expect(latest.activePlayerCount).toBe(2);
    expect(latest.players.every((player) => !player.hasEnded)).toBe(true);
  });
});

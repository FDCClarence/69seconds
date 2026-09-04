import {
  GAME,
  NETWORK,
  type ClientToServerEvents,
  type GameSnapshot,
  type InteractionResult,
  type MatchTally,
  type RoomCommandResult,
  type SurvivalState,
  type SurvivalEndDayResult,
  type SurvivalReadinessState,
  type RoomPublicState,
  type ServerToClientEvents,
  CLIENT_EVENTS,
  SURVIVAL,
  SURVIVAL_CHARACTER_DEFAULTS,
} from '@69-seconds/shared';
import { createServer, type Server as HttpServer } from 'node:http';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../db/schema.js';
import { digestSessionToken } from '../auth/service.js';
import { attachSocketServer, type SocketServerHandle } from '../socket.js';

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const users = Array.from({ length: 5 }, (_, index): UserRow => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  username: `player${index + 1}`,
  email: `player${index + 1}@example.com`,
  passwordHash: 'not-used',
  createdAt: new Date('2026-09-02T00:00:00.000Z'),
  updatedAt: new Date('2026-09-02T00:00:00.000Z'),
}));

function command(
  socket: TestClient,
  event: 'room:create' | 'room:join' | 'room:leave' | 'lobby:ready' | 'lobby:start',
  payload: Record<string, unknown>,
): Promise<RoomCommandResult> {
  return new Promise((resolve) => {
    // The union is deliberately localized here; each shared event has the same typed acknowledgement shape.
    (socket.emit as (name: string, body: Record<string, unknown>, callback: (result: RoomCommandResult) => void) => TestClient)(
      event,
      payload,
      resolve,
    );
  });
}

/** Resolves on the first `survival:readiness` broadcast the predicate accepts. */
function nextSurvivalReadiness(
  socket: TestClient,
  matches: (state: SurvivalReadinessState) => boolean,
): Promise<SurvivalReadinessState> {
  return new Promise((resolve) => {
    const listener = (state: SurvivalReadinessState) => {
      if (!matches(state)) return;
      socket.off('survival:readiness', listener);
      resolve(state);
    };
    socket.on('survival:readiness', listener);
  });
}

function endDay(socket: TestClient, payload: Record<string, unknown> = {}): Promise<SurvivalEndDayResult> {
  return new Promise((resolve) => {
    (socket.emit as unknown as (
      event: string,
      body: Record<string, unknown>,
      callback: (result: SurvivalEndDayResult) => void,
    ) => TestClient)('survival:end-day', payload, resolve);
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

describe('authenticated Socket.IO room lifecycle', () => {
  let httpServer: HttpServer;
  let sockets: SocketServerHandle;
  let origin: string;
  let serverNowMs: number;
  let invalidateSession: (token: string) => void;
  let expireSessionIn: (token: string, delayMs: number) => void;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    serverNowMs = 1_000;
    httpServer = createServer();
    const tokens = new Map(users.map((user, index) => [`token-${index + 1}`, user]));
    const expirations = new Map([...tokens.keys()].map((token) => [token, Date.now() + 60 * 60_000]));
    const invalidationListeners = new Set<(tokenDigest: string) => void>();
    invalidateSession = (token) => {
      tokens.delete(token);
      for (const listener of invalidationListeners) listener(digestSessionToken(token));
    };
    expireSessionIn = (token, delayMs) => expirations.set(token, Date.now() + delayMs);
    sockets = attachSocketServer(httpServer, {
      webOrigins: ['http://localhost:5173'],
      cookie: { name: '69s_session' },
      auth: {
        resolveSession: async (token) => tokens.get(token) ?? null,
        resolveSessionDetails: async (token) => {
          const user = tokens.get(token);
          const expiresAtMs = expirations.get(token);
          if (!user || expiresAtMs === undefined || expiresAtMs <= Date.now()) return null;
          return { user, expiresAt: new Date(expiresAtMs) };
        },
        onSessionInvalidated: (listener) => {
          invalidationListeners.add(listener);
          return () => { invalidationListeners.delete(listener); };
        },
      },
      rooms: {
        reconnectGraceMs: 60,
        abandonedRoomTtlMs: 120,
        countdownDurationMs: 10,
        now: () => serverNowMs,
      },
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

  it('supports one-to-four distinct players, reconnects without duplication, and enforces start authority', async () => {
    const host = await connect(0);
    (host.emit as unknown as (event: string, payload: unknown) => void)(
      'room:create',
      { clientClaimedHost: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const created = await command(host, 'room:create', {});
    expect(created.ok).toBe(true);
    if (!created.ok || !created.room) throw new Error('Expected room creation success');
    const code = created.room.code;
    expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{6}$/);

    const members = [host];
    for (let index = 1; index < 4; index += 1) {
      const member = await connect(index);
      members.push(member);
      const joined = await command(member, 'room:join', { code: code.toLowerCase() });
      expect(joined.ok && joined.room?.players).toHaveLength(index + 1);
    }

    const fifth = await connect(4);
    const full = await command(fifth, 'room:join', { code });
    expect(full).toMatchObject({ ok: false, error: { code: 'ROOM_FULL' } });
    const missing = await command(fifth, 'room:join', { code: 'ZZZZZZ' });
    expect(missing).toMatchObject({ ok: false, error: { code: 'ROOM_NOT_FOUND' } });
    const invalid = await command(fifth, 'room:join', { code: 'OOPS' });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });

    const reconnectingState = nextLobbyState(host, (room) =>
      room.players.some((player) => player.id === users[2]?.id && player.connectionState === 'RECONNECTING'));
    members[2]?.disconnect();
    await reconnectingState;
    const refreshed = await connect(2);
    const rejoined = await command(refreshed, 'room:join', { code });
    expect(rejoined.ok && rejoined.room?.players).toHaveLength(4);
    expect(rejoined.ok && rejoined.room?.players.filter((player) => player.id === users[2]?.id)).toHaveLength(1);

    const forbidden = await command(members[1]!, 'lobby:start', {});
    expect(forbidden).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const notReady = await command(host, 'lobby:start', {});
    expect(notReady).toMatchObject({ ok: false, error: { code: 'PLAYERS_NOT_READY' } });

    for (const member of [host, members[1]!, refreshed, members[3]!]) {
      const ready = await command(member, 'lobby:ready', { ready: true });
      expect(ready.ok).toBe(true);
    }
    const initialSnapshot = new Promise<GameSnapshot>((resolve) => host.once('state:snapshot', resolve));
    const started = await command(host, 'lobby:start', {});
    expect(started).toMatchObject({ ok: true, room: { phase: 'COUNTDOWN' } });
    const synchronized = await initialSnapshot;
    expect(synchronized).toMatchObject({ roomCode: code, phase: 'COUNTDOWN' });
    expect(new Set(synchronized.players.map((player) => `${player.position.x}:${player.position.y}`)).size).toBe(4);
    const lateJoin = await command(fifth, 'room:join', { code });
    expect(lateJoin).toMatchObject({ ok: false, error: { code: 'MATCH_ALREADY_STARTED' } });
  });

  it('rejects a socket without a valid authenticated session', async () => {
    const socket: TestClient = createClient(origin, {
      autoConnect: false,
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    clients.push(socket);
    const error = await new Promise<Error & { data?: { code?: string } }>((resolve) => {
      socket.once('connect_error', resolve);
      socket.connect();
    });
    expect(error.data?.code).toBe('UNAUTHENTICATED');
    expect(socket.connected).toBe(false);
  });

  it('rejects a valid cookie presented from an untrusted browser origin', async () => {
    const socket: TestClient = createClient(origin, {
      autoConnect: false,
      transports: ['websocket'],
      extraHeaders: {
        Cookie: '69s_session=token-1',
        Origin: 'https://attacker.example',
      },
      forceNew: true,
      reconnection: false,
    });
    clients.push(socket);
    await new Promise<Error>((resolve) => {
      socket.once('connect_error', resolve);
      socket.connect();
    });
    expect(socket.connected).toBe(false);
    expect(sockets.rooms.size).toBe(0);
  });

  it('disconnects sockets as soon as their authenticated session is revoked', async () => {
    const socket = await connect(0);
    const authenticationError = new Promise<string>((resolve) => {
      socket.once('game:error', (error) => resolve(error.code));
    });
    const disconnected = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
    invalidateSession('token-1');
    expect(await authenticationError).toBe('UNAUTHENTICATED');
    await disconnected;
    expect(socket.connected).toBe(false);

    const replacement: TestClient = createClient(origin, {
      autoConnect: false,
      transports: ['websocket'],
      extraHeaders: { Cookie: '69s_session=token-1' },
      forceNew: true,
      reconnection: false,
    });
    clients.push(replacement);
    const error = await new Promise<Error & { data?: { code?: string } }>((resolve) => {
      replacement.once('connect_error', resolve);
      replacement.connect();
    });
    expect(error.data?.code).toBe('UNAUTHENTICATED');
  });

  it('disconnects an established socket when its session reaches its expiry', async () => {
    expireSessionIn('token-1', 40);
    const socket = await connect(0);
    const disconnected = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
    await disconnected;
    expect(socket.connected).toBe(false);
  });

  it('bounds authenticated event floods and emits only one rate-limit warning per second', async () => {
    const socket = await connect(0);
    const errors: string[] = [];
    socket.on('game:error', (error) => errors.push(error.code));
    for (let sequence = 0; sequence < NETWORK.socketEventBurstCapacity; sequence += 1) {
      socket.emit('input:update', {
        sequence,
        clientTimeMs: sequence,
        movement: { up: false, down: false, left: false, right: true },
        sprint: false,
      });
    }

    const limited = await command(socket, 'room:create', {});
    expect(limited).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual(['RATE_LIMITED']);
    expect(sockets.rooms.size).toBe(0);
  });

  it('disconnects a client whose Socket.IO message exceeds the transport limit', async () => {
    const socket = await connect(0);
    const disconnected = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
    (socket.emit as unknown as (event: string, payload: unknown) => void)(
      'room:join',
      { code: 'A'.repeat(NETWORK.maxPayloadBytes + 1) },
    );
    await disconnected;
    expect(socket.connected).toBe(false);
  });

  it('keeps a disconnected host during grace, then migrates to the lowest remaining slot', async () => {
    const host = await connect(0);
    const created = await command(host, 'room:create', {});
    if (!created.ok || !created.room) throw new Error('Expected room creation success');
    const second = await connect(1);
    const third = await connect(2);
    await command(second, 'room:join', { code: created.room.code });
    await command(third, 'room:join', { code: created.room.code });

    const reconnectingState = nextLobbyState(second, (room) =>
      room.hostPlayerId === users[0]?.id
      && room.players.find((player) => player.id === users[0]?.id)?.connectionState === 'RECONNECTING');
    const migratedState = nextLobbyState(second, (room) => room.hostPlayerId === users[1]?.id);
    host.disconnect();
    const reconnecting = await reconnectingState;
    expect(reconnecting.hostPlayerId).toBe(users[0]?.id);
    const migrated = await migratedState;
    expect(migrated.players.find((player) => player.slot === 1)).toMatchObject({ isHost: true });
  });

  it('removes disconnected players after grace and closes an abandoned room', async () => {
    const host = await connect(0);
    const created = await command(host, 'room:create', {});
    expect(created.ok).toBe(true);
    expect(sockets.rooms.size).toBe(1);
    host.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(sockets.rooms.size).toBe(0);
  });

  it('opens a 120-second survival day, rejects delayed gameplay, and replays the looting result on reconnect', async () => {
    const host = await connect(0);
    const created = await command(host, 'room:create', {});
    if (!created.ok || !created.room) throw new Error('Expected room creation success');
    await command(host, 'lobby:ready', { ready: true });
    await command(host, 'lobby:start', {});

    const lootingState = nextLobbyState(host, (room) => room.phase === 'LOOTING');
    serverNowMs = 1_010;
    const looting = await lootingState;
    const deadline = 1_010 + GAME.lootingDurationMs;
    expect(looting.phaseEndsAtMs).toBe(deadline);

    let tallyEvents = 0;
    let householdEvents = 0;
    host.on('match:tally', () => { tallyEvents += 1; });
    host.on('survival:state', () => { householdEvents += 1; });
    const survivalState = nextLobbyState(host, (room) => room.phase === 'SURVIVAL');
    const firstTally = new Promise<MatchTally>((resolve) => host.once('match:tally', resolve));
    const firstHouseholds = new Promise<SurvivalState>((resolve) => host.once('survival:state', resolve));
    serverNowMs = deadline;
    // The day's deadline is server-owned and derived from the looting deadline.
    expect(await survivalState).toMatchObject({
      phase: 'SURVIVAL',
      phaseEndsAtMs: deadline + GAME.survivalDurationMs,
    });
    const result = await firstTally;
    expect(result).toMatchObject({
      roomCode: created.room.code,
      lootingStartedAtMs: 1_010,
      lootingEndedAtMs: deadline,
      durationMs: GAME.lootingDurationMs,
      totalItems: 0,
    });

    // The households arrive on the same authoritative transition, produced by the
    // server from that frozen result: one per player, everybody alive on the
    // shared defaults, and nothing recruited in this match.
    const households = await firstHouseholds;
    expect(households).toMatchObject({
      stateId: `survival:${result.resultId}`,
      roomCode: created.room.code,
      // The looting run happens before Day 1, so the day the buzzer opens is
      // Day 1, and it arrives on the wire rather than being counted client-side.
      dayNumber: SURVIVAL.firstDayNumber,
      startedAtMs: deadline,
    });
    expect(households.dayNumber).toBe(1);
    expect(households.households).toHaveLength(1);
    expect(households.households[0]).toMatchObject({ playerId: users[0]!.id, slot: 0, inventory: [] });
    expect(households.households[0]?.characters).toHaveLength(1);
    expect(households.households[0]?.characters[0]).toMatchObject({
      kind: 'MAIN',
      isAlive: true,
      catalogId: null,
      dailyNutritionCost: SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost,
      dailyHydrationCost: SURVIVAL_CHARACTER_DEFAULTS.dailyHydrationCost,
    });
    expect(households.households[0]?.characters[0]?.stats).toEqual(SURVIVAL_CHARACTER_DEFAULTS.stats);

    // There is no client event carrying survival state, so a modified client has
    // nothing to submit: emitting the server's own event name reaches no handler
    // and the committed households stay exactly as the server built them.
    expect(Object.values(CLIENT_EVENTS)).not.toContain('survival:state');
    expect(Object.values(CLIENT_EVENTS)).toContain('survival:end-day');
    (host.emit as (name: string, body: unknown) => unknown)('survival:state', {
      ...households,
      households: [{
        ...households.households[0],
        characters: [{
          ...households.households[0]?.characters[0],
          isAlive: false,
          stats: { ...households.households[0]?.characters[0]?.stats, health: { current: 9_000, max: 9_000 } },
        }],
      }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const lateInteraction = await new Promise<InteractionResult>((resolve) => {
      host.emit('interaction:request', {
        requestId: '00000000-0000-4000-8000-000000000301',
        action: 'INTERACT',
      }, resolve);
    });
    expect(lateInteraction).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PHASE' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tallyEvents).toBe(1);
    expect(householdEvents).toBe(1);

    host.disconnect();
    const refreshed: TestClient = createClient(origin, {
      autoConnect: false,
      transports: ['websocket'],
      extraHeaders: { Cookie: '69s_session=token-1' },
      forceNew: true,
      reconnection: false,
    });
    clients.push(refreshed);
    const replayed = new Promise<MatchTally>((resolve) => refreshed.once('match:tally', resolve));
    const replayedHouseholds = new Promise<SurvivalState>((resolve) => refreshed.once('survival:state', resolve));
    const connected = new Promise<void>((resolve, reject) => {
      refreshed.once('connect', resolve);
      refreshed.once('connect_error', reject);
    });
    refreshed.connect();
    await connected;
    expect(await replayed).toEqual(result);
    // Replayed verbatim, and untouched by what the client tried to send.
    expect(await replayedHouseholds).toEqual(households);
    expect(await command(refreshed, 'lobby:start', {}))
      .toMatchObject({ ok: false, error: { code: 'MATCH_ALREADY_STARTED' } });
  });

  it('authenticates End Day ownership, broadcasts changes once, and reaches all-ended early', async () => {
    const host = await connect(0);
    const second = await connect(1);
    const created = await command(host, 'room:create', {});
    if (!created.ok || !created.room) throw new Error('Expected room creation success');
    await command(second, 'room:join', { code: created.room.code });
    await command(host, 'lobby:ready', { ready: true });
    await command(second, 'lobby:ready', { ready: true });

    const lootingState = nextLobbyState(host, (room) => room.phase === 'LOOTING');
    await command(host, 'lobby:start', {});
    serverNowMs = 1_010;
    const looting = await lootingState;
    const lootingDeadline = looting.phaseEndsAtMs!;

    const initialReadiness = new Promise<SurvivalReadinessState>((resolve) => {
      host.once('survival:readiness', resolve);
    });
    serverNowMs = lootingDeadline;
    const initial = await initialReadiness;
    expect(initial).toMatchObject({ activePlayerCount: 2, allPlayersEnded: false });

    let changedBroadcasts = 0;
    host.on('survival:readiness', () => { changedBroadcasts += 1; });
    const forged = await endDay(host, { playerId: users[1]!.id });
    expect(forged).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    expect(changedBroadcasts).toBe(0);

    const hostChanged = new Promise<SurvivalReadinessState>((resolve) => {
      second.once('survival:readiness', resolve);
    });
    const hostEnded = await endDay(host);
    expect(hostEnded).toMatchObject({
      ok: true,
      readiness: { activePlayerCount: 1, allPlayersEnded: false },
    });
    expect((await hostChanged).players).toContainEqual(expect.objectContaining({
      playerId: users[0]!.id,
      hasEnded: true,
      endedBy: 'MANUAL',
    }));

    const repeated = await endDay(host);
    expect(repeated).toEqual(hostEnded);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(changedBroadcasts).toBe(1);

    // Both households finish half a minute into a 120-second day, so the day
    // they end is resolved early rather than at its deadline.
    const endedAtMs = initial.startedAtMs + 30_000;
    serverNowMs = endedAtMs;
    const nextDay = nextSurvivalReadiness(second, (state) => state.dayNumber === initial.dayNumber + 1);
    const allEnded = await endDay(second);
    expect(allEnded).toMatchObject({
      ok: true,
      readiness: { activePlayerCount: 0, allPlayersEnded: true },
    });
    expect(serverNowMs).toBeLessThan(initial.endsAtMs);
    // Nothing but the server's own tick opens the next day, and it opens where
    // the last household ended rather than where the deadline was.
    expect(await nextDay).toMatchObject({
      dayNumber: initial.dayNumber + 1,
      startedAtMs: endedAtMs,
      endsAtMs: endedAtMs + GAME.survivalDurationMs,
      activePlayerCount: 2,
      allPlayersEnded: false,
    });
  });

  it('resolves a timed-out survival day from the server clock alone', async () => {
    const host = await connect(0);
    const created = await command(host, 'room:create', {});
    if (!created.ok || !created.room) throw new Error('Expected room creation success');
    await command(host, 'lobby:ready', { ready: true });
    const lootingState = nextLobbyState(host, (room) => room.phase === 'LOOTING');
    await command(host, 'lobby:start', {});
    serverNowMs = 1_010;
    const looting = await lootingState;

    const initialReadiness = new Promise<SurvivalReadinessState>((resolve) => {
      host.once('survival:readiness', resolve);
    });
    const firstHouseholds = new Promise<SurvivalState>((resolve) => {
      host.once('survival:state', resolve);
    });
    serverNowMs = looting.phaseEndsAtMs!;
    const initial = await initialReadiness;
    const dayOne = await firstHouseholds;
    expect(dayOne.dayNumber).toBe(SURVIVAL.firstDayNumber);

    // The client sends nothing at all from here on: this household never ends
    // its day, so only the server's 120-second deadline can close it.
    const nextReadiness = nextSurvivalReadiness(host, (state) => state.dayNumber === dayOne.dayNumber + 1);
    const nextHouseholds = new Promise<SurvivalState>((resolve) => {
      const listener = (state: SurvivalState) => {
        if (state.dayNumber !== dayOne.dayNumber + 1) return;
        host.off('survival:state', listener);
        resolve(state);
      };
      host.on('survival:state', listener);
    });
    serverNowMs = initial.endsAtMs;

    // Every household is active again on a fresh day measured from the closed
    // day's authoritative deadline, with nobody carrying an ended day into it.
    expect(await nextReadiness).toMatchObject({
      dayNumber: SURVIVAL.firstDayNumber + 1,
      startedAtMs: initial.endsAtMs,
      endsAtMs: initial.endsAtMs + GAME.survivalDurationMs,
      activePlayerCount: 1,
      allPlayersEnded: false,
      players: [{ hasEnded: false, endedAtMs: null, endedBy: null }],
    });

    // The day that expired charged every character its own daily costs once,
    // and the drained numbers are what the clients are told to render.
    const resolved = await nextHouseholds;
    expect(resolved.stateId).toBe(dayOne.stateId);
    expect(resolved.startedAtMs).toBe(initial.endsAtMs);
    for (const [index, character] of resolved.households[0]!.characters.entries()) {
      const before = dayOne.households[0]!.characters[index]!;
      expect(character.stats.nutrition.current)
        .toBe(before.stats.nutrition.current - character.dailyNutritionCost);
      expect(character.stats.hydration.current)
        .toBe(before.stats.hydration.current - character.dailyHydrationCost);
      expect(character.dailyNutritionCost).toBe(SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost);
      expect(character.isAlive).toBe(true);
    }
  });
});

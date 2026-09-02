import type {
  ClientToServerEvents,
  RoomCommandResult,
  RoomPublicState,
  ServerToClientEvents,
} from '@69-seconds/shared';
import { createServer, type Server as HttpServer } from 'node:http';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../db/schema.js';
import { attachSocketServer, type SocketServerHandle } from '../socket.js';

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const users = Array.from({ length: 5 }, (_, index): UserRow => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
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
  const clients: TestClient[] = [];

  beforeEach(async () => {
    httpServer = createServer();
    const tokens = new Map(users.map((user, index) => [`token-${index + 1}`, user]));
    sockets = attachSocketServer(httpServer, {
      webOrigins: ['http://localhost:5173'],
      cookie: { name: '69s_session' },
      auth: {
        resolveSession: async (token) => tokens.get(token) ?? null,
      },
      rooms: { reconnectGraceMs: 60, abandonedRoomTtlMs: 120 },
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
    const started = await command(host, 'lobby:start', {});
    expect(started).toMatchObject({ ok: true, room: { phase: 'COUNTDOWN' } });
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
});

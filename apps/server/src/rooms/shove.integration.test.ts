import {
  GAME,
  PLAYER_SPAWN_POSITIONS,
  SHOVE,
  SPRINT,
  distanceBetween,
  type ClientToServerEvents,
  type GameSnapshot,
  type RoomCommandResult,
  type RoomPublicState,
  type ServerError,
  type ServerToClientEvents,
  type ShoveLanded,
  type ShoveRequest,
  type ShoveResult,
} from '@69-seconds/shared';
import { createServer, type Server as HttpServer } from 'node:http';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../db/schema.js';
import { attachSocketServer, type SocketServerHandle } from '../socket.js';

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const users = Array.from({ length: GAME.maxPlayers }, (_, index): UserRow => ({
  id: `00000000-0000-4000-8000-00000000020${index + 1}`,
  username: `shover${index + 1}`,
  email: `shover${index + 1}@example.com`,
  passwordHash: 'not-used',
  createdAt: new Date('2026-09-02T00:00:00.000Z'),
  updatedAt: new Date('2026-09-02T00:00:00.000Z'),
}));

const RIGHT = { up: false, down: false, left: false, right: true } as const;
const STILL = { up: false, down: false, left: false, right: false } as const;

let requestCounter = 0;
function shoveRequest(targetPlayerId?: string): ShoveRequest {
  requestCounter += 1;
  return {
    requestId: `00000000-0000-4000-8000-${String(requestCounter).padStart(12, '0')}`,
    ...(targetPlayerId ? { targetPlayerId } : {}),
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

function requestShove(socket: TestClient, request: unknown): Promise<ShoveResult> {
  return new Promise((resolve) => {
    (socket.emit as (name: string, body: unknown, callback: (result: ShoveResult) => void) => TestClient)(
      'shove:request',
      request,
      resolve,
    );
  });
}

function nextSnapshot(socket: TestClient): Promise<GameSnapshot> {
  return new Promise((resolve) => socket.once('state:snapshot', resolve));
}

function reasonOf(result: ShoveResult): string {
  return result.outcome === 'REJECTED' ? result.reason : result.outcome;
}

describe('authoritative shove over Socket.IO', () => {
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

  async function startMatch(playerCount = 2): Promise<{ members: TestClient[]; room: RoomPublicState }> {
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
    const room = (await Promise.all(looting))[0]!;
    return { members, room };
  }

  /**
   * Spawn slots sit further apart than the shove range, so the shover has to walk
   * in first. Holding an input also fixes the server-owned facing, and the final
   * idle input stops the drift that would carry the shover past its target.
   */
  async function closeIn(socket: TestClient, selfId: string, otherId: string): Promise<GameSnapshot> {
    let sequence = 0;
    const deadline = Date.now() + 5_000;
    const send = (movement: typeof RIGHT | typeof STILL) => socket.emit('input:update', {
      sequence: sequence++,
      clientTimeMs: Date.now(),
      movement,
      sprint: false,
    });
    while (Date.now() < deadline) {
      send(RIGHT);
      const snapshot = await nextSnapshot(socket);
      const self = snapshot.players.find((player) => player.id === selfId);
      const other = snapshot.players.find((player) => player.id === otherId);
      if (self && other && distanceBetween(self.position, other.position) <= SHOVE.rangePixels - 8) {
        send(STILL);
        return nextSnapshot(socket);
      }
    }
    throw new Error('The shover never closed to shove range');
  }

  it('rejects a malformed shove request and reports it on the error channel', async () => {
    const { members } = await startMatch(2);
    const errors: ServerError[] = [];
    members[0]!.on('game:error', (error) => errors.push(error));

    // A spoofed direction and a claimed outcome are both refused by the strict schema.
    const result = await requestShove(members[0]!, {
      requestId: '00000000-0000-4000-8000-000000009999',
      direction: { x: 1, y: 0 },
      outcome: 'LANDED',
    });
    expect(result).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_PAYLOAD' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(errors.map((error) => error.code)).toContain('INVALID_PAYLOAD');
  });

  it('lands a shove and broadcasts one result to every client in the room', async () => {
    const { members } = await startMatch(GAME.maxPlayers);
    const landings = members.map(() => [] as ShoveLanded[]);
    members.forEach((member, index) => member.on('shove:landed', (event) => landings[index]!.push(event)));

    await closeIn(members[0]!, users[0]!.id, users[1]!.id);
    const result = await requestShove(members[0]!, shoveRequest(users[1]!.id));
    expect(reasonOf(result)).toBe('LANDED');

    await new Promise((resolve) => setTimeout(resolve, 120));
    for (const received of landings) {
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        shoverPlayerId: users[0]!.id,
        targetPlayerId: users[1]!.id,
      });
    }
    // Everyone was told the same authoritative landing spot.
    const positions = landings.map((received) => JSON.stringify(received[0]!.targetPosition));
    expect(new Set(positions).size).toBe(1);
  });

  it('holds the shover to the cooldown after a landed shove', async () => {
    const { members } = await startMatch(2);
    await closeIn(members[0]!, users[0]!.id, users[1]!.id);
    const first = await requestShove(members[0]!, shoveRequest(users[1]!.id));
    expect(reasonOf(first)).toBe('LANDED');

    const immediate = await requestShove(members[0]!, shoveRequest(users[1]!.id));
    expect(immediate).toMatchObject({ outcome: 'REJECTED', reason: 'ON_COOLDOWN' });
    expect(immediate.cooldownEndsAtMs).toBeGreaterThan(Date.now());
    expect(immediate.cooldownEndsAtMs).toBe(first.cooldownEndsAtMs);
  });

  it('rate-limits a spammed burst instead of resolving all of it', async () => {
    const { members } = await startMatch(2);
    await closeIn(members[0]!, users[0]!.id, users[1]!.id);
    const burst = await Promise.all(
      Array.from({ length: SHOVE.burstCapacity + 4 }, () => requestShove(members[0]!, shoveRequest(users[1]!.id))),
    );

    const reasons = burst.map(reasonOf);
    expect(reasons.filter((reason) => reason === 'LANDED')).toHaveLength(1);
    expect(reasons).toContain('RATE_LIMITED');
  });

  it('replays a duplicate request instead of broadcasting a second shove', async () => {
    const { members } = await startMatch(2);
    const landings: ShoveLanded[] = [];
    members[1]!.on('shove:landed', (event) => landings.push(event));

    await closeIn(members[0]!, users[0]!.id, users[1]!.id);
    const duplicate = shoveRequest(users[1]!.id);
    const first = await requestShove(members[0]!, duplicate);
    const replay = await requestShove(members[0]!, duplicate);

    expect(reasonOf(first)).toBe('LANDED');
    expect(replay).toEqual(first);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(landings).toHaveLength(1);
  });

  it('refuses a shove from a player facing an empty aisle', async () => {
    const { members } = await startMatch(2);
    // Nobody has moved, so both players still face the carts with nobody there.
    const result = await requestShove(members[0]!, shoveRequest());
    expect(result).toMatchObject({ outcome: 'REJECTED', reason: 'NO_TARGET_IN_CONE' });
  });

  it('refuses a shove from a socket that is not in a match', async () => {
    const loner = await connect(0);
    const result = await requestShove(loner, shoveRequest());
    expect(result).toMatchObject({ outcome: 'REJECTED', reason: 'NOT_IN_MATCH' });
  });

  it('keeps every shoved position inside legal map geometry', async () => {
    const { members } = await startMatch(2);
    const snapshot = await closeIn(members[0]!, users[0]!.id, users[1]!.id);
    expect(snapshot.players).toHaveLength(2);
    await requestShove(members[0]!, shoveRequest(users[1]!.id));

    const settled = await nextSnapshot(members[0]!);
    for (const player of settled.players) {
      expect(player.position.x).toBeGreaterThanOrEqual(GAME.playerCollisionRadiusPixels);
      expect(player.position.x).toBeLessThanOrEqual(GAME.mapWidthPixels - GAME.playerCollisionRadiusPixels);
      expect(player.position.y).toBeGreaterThanOrEqual(GAME.playerCollisionRadiusPixels);
      expect(player.position.y).toBeLessThanOrEqual(GAME.mapHeightPixels - GAME.playerCollisionRadiusPixels);
    }
    expect(PLAYER_SPAWN_POSITIONS).toHaveLength(GAME.maxPlayers);
  });

  it('spends the sprint bar over the wire and never refills it on reconnect', async () => {
    const { members } = await startMatch(2);
    let sequence = 0;
    let stamina: number = SPRINT.staminaCapacity;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && stamina > SPRINT.staminaCapacity - 10) {
      members[0]!.emit('input:update', {
        sequence: sequence++,
        clientTimeMs: Date.now(),
        movement: RIGHT,
        sprint: true,
      });
      const snapshot = await nextSnapshot(members[0]!);
      stamina = snapshot.players.find((player) => player.id === users[0]!.id)!.stamina;
    }
    expect(stamina).toBeLessThan(SPRINT.staminaCapacity - 5);

    // Dropping the socket is the obvious way to try to cheat the resource.
    members[0]!.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const restored = await connect(0);
    const resumed = await nextSnapshot(restored);
    const self = resumed.players.find((player) => player.id === users[0]!.id)!;
    expect(self.stamina).toBeLessThan(SPRINT.staminaCapacity);
    expect(self.sprinting).toBe(false);
  });
});

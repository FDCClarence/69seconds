import {
  clientInputSchema,
  interactionRequestSchema,
  lobbyReadyRequestSchema,
  lobbyStartRequestSchema,
  roomCommandResultSchema,
  roomCreateRequestSchema,
  roomJoinRequestSchema,
  roomLeaveRequestSchema,
  interactionResultSchema,
  serverErrorSchema,
  shoveRequestSchema,
  type ClientToServerEvents,
  type InteractionRejectionReason,
  type InteractionResult,
  type InterServerEvents,
  type LootUpdate,
  type RoomCommandResult,
  type RoomPublicState,
  type ServerError,
  type ServerToClientEvents,
  type SocketData,
  NETWORK,
} from '@69-seconds/shared';
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { ZodType } from 'zod';
import { readSessionTokenFromCookieHeader, type SessionCookieConfig } from './auth/cookies.js';
import type { AuthService } from './auth/service.js';
import { REJECTION_MESSAGES, type LootAuthorityOptions } from './game/loot-authority.js';
import { AuthoritativeRoomSimulation } from './game/simulation.js';
import { RoomRegistry, RoomRegistryError, type RoomRegistryOptions } from './rooms/registry.js';

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export interface SocketServerOptions {
  webOrigins: string[];
  auth: Pick<AuthService, 'resolveSession'>;
  cookie: Pick<SessionCookieConfig, 'name'>;
  rooms?: Omit<RoomRegistryOptions, 'onEvent'>;
  /** Test seam for placing loot; production uses the shared store map. */
  loot?: LootAuthorityOptions;
}

export interface SocketServerHandle {
  io: GameServer;
  rooms: RoomRegistry;
  close(): Promise<void>;
}

function publicError(code: ServerError['code'], message: string, event: string, retryable = false): ServerError {
  return serverErrorSchema.parse({ code, message, event, retryable });
}

function invalidPayload(event: string): RoomCommandResult {
  return roomCommandResultSchema.parse({
    ok: false,
    error: publicError('INVALID_PAYLOAD', `Invalid payload for ${event}`, event),
  });
}

function commandFailure(error: unknown, event: string): RoomCommandResult {
  if (error instanceof RoomRegistryError) {
    return roomCommandResultSchema.parse({ ok: false, error: error.toPublic(event) });
  }
  console.error(error);
  return roomCommandResultSchema.parse({
    ok: false,
    error: publicError('INTERNAL_ERROR', 'An unexpected room error occurred', event, true),
  });
}

function isValid<T>(schema: ZodType<T>, payload: unknown): payload is T {
  return schema.safeParse(payload).success;
}

function reportInvalidGameplayPayload(socket: GameSocket, event: string): void {
  socket.emit('game:error', publicError('INVALID_PAYLOAD', `Invalid payload for ${event}`, event));
}

function reply(
  acknowledge: ((result: RoomCommandResult) => void) | undefined,
  result: RoomCommandResult,
): void {
  acknowledge?.(result);
}

/**
 * Transport-level rejection. Gameplay rejections come from the loot authority,
 * which is the only component allowed to read authoritative loot state.
 */
function interactionRejection(
  requestId: string,
  reason: InteractionRejectionReason,
  carriedItemIds: readonly string[] = [],
): InteractionResult {
  return interactionResultSchema.parse({
    outcome: 'REJECTED',
    requestId,
    reason,
    message: REJECTION_MESSAGES[reason],
    carriedItemIds: [...carriedItemIds],
  });
}

const FALLBACK_REQUEST_ID = '00000000-0000-4000-8000-000000000000';

function requestIdFrom(payload: unknown): string {
  const candidate = (payload as { requestId?: unknown } | null)?.requestId;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return typeof candidate === 'string' && uuid.test(candidate) ? candidate : FALLBACK_REQUEST_ID;
}

export function attachSocketServer(httpServer: HttpServer, options: SocketServerOptions): SocketServerHandle {
  const io: GameServer = new Server(httpServer, {
    cors: { origin: options.webOrigins, credentials: true },
  });
  const simulations = new Map<string, AuthoritativeRoomSimulation>();
  const rooms = new RoomRegistry({
    ...options.rooms,
    onEvent(event) {
      if (event.type === 'state') {
        const restocked = simulations.get(event.room.code)?.synchronizePlayers(event.room) ?? [];
        for (const update of restocked) io.to(event.room.code).emit('loot:update', update);
        io.to(event.room.code).emit('lobby:state', event.room);
      } else {
        simulations.delete(event.room.code);
        io.to(event.room.code).emit('room:closed', event.room);
      }
    },
  });
  /** `loot:sync` carries a private inventory, so it is addressed per socket. */
  function sendLootSync(room: RoomPublicState): void {
    const simulation = simulations.get(room.code);
    if (!simulation) return;
    for (const connected of io.sockets.sockets.values()) {
      const memberId = connected.data.playerId;
      if (!memberId || connected.data.roomCode !== room.code) continue;
      if (!room.players.some((player) => player.id === memberId)) continue;
      connected.emit('loot:sync', simulation.lootSyncFor(memberId));
    }
  }

  function sendLootSyncTo(socket: GameSocket, roomCode: string, playerId: string): void {
    const simulation = simulations.get(roomCode);
    if (!simulation) return;
    socket.emit('loot:sync', simulation.lootSyncFor(playerId));
  }

  function broadcastLootUpdate(roomCode: string, update: LootUpdate | null): void {
    if (update) io.to(roomCode).emit('loot:update', update);
  }

  const simulationTimer = setInterval(() => {
    const serverNowMs = Date.now();
    for (const simulation of simulations.values()) {
      const result = simulation.tick(serverNowMs);
      if (!result.snapshotDue && !result.phaseChanged) continue;
      const snapshot = simulation.snapshot(serverNowMs);
      const room = rooms.applySimulationSnapshot(snapshot);
      if (!room) {
        simulations.delete(simulation.roomCode);
        continue;
      }
      io.to(simulation.roomCode).emit('state:snapshot', snapshot);
      if (result.phaseChanged) io.to(simulation.roomCode).emit('lobby:state', room);
    }
  }, 1_000 / NETWORK.simulationTickRateHz);
  simulationTimer.unref?.();

  io.use(async (socket, next) => {
    const token = readSessionTokenFromCookieHeader(socket.handshake.headers.cookie, options.cookie);
    if (!token) {
      const error = new Error('Authentication is required') as Error & { data: ServerError };
      error.data = publicError('UNAUTHENTICATED', 'Authentication is required', 'connect');
      next(error);
      return;
    }
    try {
      const user = await options.auth.resolveSession(token);
      if (!user) {
        const error = new Error('Authentication is required') as Error & { data: ServerError };
        error.data = publicError('UNAUTHENTICATED', 'Authentication is required', 'connect');
        next(error);
        return;
      }
      socket.data.playerId = user.id;
      socket.data.playerUsername = user.username;
      socket.data.playerEmail = user.email;
      next();
    } catch (cause) {
      console.error(cause);
      const error = new Error('Could not verify the session') as Error & { data: ServerError };
      error.data = publicError('INTERNAL_ERROR', 'Could not verify the session', 'connect', true);
      next(error);
    }
  });

  io.on('connection', (socket) => {
    const playerId = socket.data.playerId;
    const playerUsername = socket.data.playerUsername;
    const playerEmail = socket.data.playerEmail;
    if (!playerId || !playerUsername || !playerEmail) {
      socket.disconnect(true);
      return;
    }
    const identity = { id: playerId, username: playerUsername, email: playerEmail };

    const recovered = rooms.reconnect(identity, socket.id);
    if (recovered) {
      simulations.get(recovered.code)?.resetInput(playerId, true);
      socket.data.roomCode = recovered.code;
      void Promise.resolve(socket.join(recovered.code))
        .then(() => {
          io.to(recovered.code).emit('lobby:state', recovered);
          sendLootSyncTo(socket, recovered.code, playerId);
        })
        .catch((error: unknown) => console.error(error));
    }

    socket.on('room:create', async (payload, acknowledge) => {
      if (!isValid(roomCreateRequestSchema, payload)) {
        reply(acknowledge, invalidPayload('room:create'));
        return;
      }
      try {
        const room = rooms.create(identity, socket.id);
        socket.data.roomCode = room.code;
        await socket.join(room.code);
        io.to(room.code).emit('lobby:state', room);
        reply(acknowledge, roomCommandResultSchema.parse({ ok: true, room }));
      } catch (error) {
        reply(acknowledge, commandFailure(error, 'room:create'));
      }
    });

    socket.on('room:join', async (payload, acknowledge) => {
      const parsed = roomJoinRequestSchema.safeParse(payload);
      if (!parsed.success) {
        reply(acknowledge, invalidPayload('room:join'));
        return;
      }
      try {
        const room = rooms.join(parsed.data.code, identity, socket.id);
        socket.data.roomCode = room.code;
        await socket.join(room.code);
        io.to(room.code).emit('lobby:state', room);
        reply(acknowledge, roomCommandResultSchema.parse({ ok: true, room }));
      } catch (error) {
        reply(acknowledge, commandFailure(error, 'room:join'));
      }
    });

    socket.on('room:leave', async (payload, acknowledge) => {
      if (!isValid(roomLeaveRequestSchema, payload)) {
        reply(acknowledge, invalidPayload('room:leave'));
        return;
      }
      const code = rooms.roomForPlayer(playerId);
      try {
        const room = rooms.leave(playerId);
        if (code) broadcastLootUpdate(code, simulations.get(code)?.removePlayer(playerId) ?? null);
        if (code) {
          for (const connectedSocket of io.sockets.sockets.values()) {
            if (connectedSocket.data.playerId !== playerId) continue;
            await connectedSocket.leave(code);
            delete connectedSocket.data.roomCode;
          }
        }
        if (room) io.to(room.code).emit('lobby:state', room);
        reply(acknowledge, roomCommandResultSchema.parse({ ok: true, room }));
      } catch (error) {
        reply(acknowledge, commandFailure(error, 'room:leave'));
      }
    });

    socket.on('lobby:ready', (payload, acknowledge) => {
      const parsed = lobbyReadyRequestSchema.safeParse(payload);
      if (!parsed.success) {
        reply(acknowledge, invalidPayload('lobby:ready'));
        return;
      }
      try {
        const room = rooms.setReady(playerId, parsed.data.ready);
        io.to(room.code).emit('lobby:state', room);
        reply(acknowledge, roomCommandResultSchema.parse({ ok: true, room }));
      } catch (error) {
        reply(acknowledge, commandFailure(error, 'lobby:ready'));
      }
    });

    socket.on('lobby:start', (payload, acknowledge) => {
      if (!isValid(lobbyStartRequestSchema, payload)) {
        reply(acknowledge, invalidPayload('lobby:start'));
        return;
      }
      try {
        const room = rooms.start(playerId);
        const simulation = new AuthoritativeRoomSimulation(room, options.loot ?? {});
        simulations.set(room.code, simulation);
        io.to(room.code).emit('lobby:state', room);
        io.to(room.code).emit('state:snapshot', simulation.snapshot(Date.now()));
        sendLootSync(room);
        reply(acknowledge, roomCommandResultSchema.parse({ ok: true, room }));
      } catch (error) {
        reply(acknowledge, commandFailure(error, 'lobby:start'));
      }
    });

    socket.on('input:update', (payload) => {
      const parsed = clientInputSchema.safeParse(payload);
      if (!parsed.success) {
        reportInvalidGameplayPayload(socket, 'input:update');
        return;
      }
      const code = rooms.roomForPlayer(playerId);
      if (!code) return;
      simulations.get(code)?.submitInput(playerId, parsed.data);
    });

    socket.on('interaction:request', (payload, acknowledge) => {
      const parsed = interactionRequestSchema.safeParse(payload);
      if (!parsed.success) {
        reportInvalidGameplayPayload(socket, 'interaction:request');
        acknowledge?.(interactionRejection(requestIdFrom(payload), 'INVALID_PAYLOAD'));
        return;
      }
      const code = rooms.roomForPlayer(playerId);
      const simulation = code ? simulations.get(code) : undefined;
      if (!code || !simulation) {
        acknowledge?.(interactionRejection(parsed.data.requestId, code ? 'INVALID_PHASE' : 'NOT_IN_MATCH'));
        return;
      }
      const resolution = simulation.resolveInteraction(playerId, parsed.data, Date.now());
      acknowledge?.(resolution.result);
      // A replayed request ID reports its original decision and changes nothing.
      broadcastLootUpdate(code, resolution.update);
    });

    socket.on('shove:request', (payload) => {
      if (!isValid(shoveRequestSchema, payload)) reportInvalidGameplayPayload(socket, 'shove:request');
    });

    socket.on('disconnect', () => {
      const code = rooms.roomForPlayer(playerId);
      if (code) simulations.get(code)?.resetInput(playerId, true);
      const room = rooms.disconnect(playerId, socket.id);
      if (room) io.to(room.code).emit('lobby:state', room);
    });
  });

  return {
    io,
    rooms,
    async close() {
      clearInterval(simulationTimer);
      simulations.clear();
      rooms.close();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

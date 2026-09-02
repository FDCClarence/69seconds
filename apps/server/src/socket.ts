import {
  clientInputSchema,
  interactionRequestSchema,
  lobbyReadyRequestSchema,
  lobbyStartRequestSchema,
  roomCommandResultSchema,
  roomCreateRequestSchema,
  roomJoinRequestSchema,
  roomLeaveRequestSchema,
  serverErrorSchema,
  shoveRequestSchema,
  type ClientToServerEvents,
  type InterServerEvents,
  type RoomCommandResult,
  type ServerError,
  type ServerToClientEvents,
  type SocketData,
} from '@69-seconds/shared';
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { ZodType } from 'zod';
import { readSessionTokenFromCookieHeader, type SessionCookieConfig } from './auth/cookies.js';
import type { AuthService } from './auth/service.js';
import { RoomRegistry, RoomRegistryError, type RoomRegistryOptions } from './rooms/registry.js';

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export interface SocketServerOptions {
  webOrigins: string[];
  auth: Pick<AuthService, 'resolveSession'>;
  cookie: Pick<SessionCookieConfig, 'name'>;
  rooms?: Omit<RoomRegistryOptions, 'onEvent'>;
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

export function attachSocketServer(httpServer: HttpServer, options: SocketServerOptions): SocketServerHandle {
  const io: GameServer = new Server(httpServer, {
    cors: { origin: options.webOrigins, credentials: true },
  });
  const rooms = new RoomRegistry({
    ...options.rooms,
    onEvent(event) {
      if (event.type === 'state') io.to(event.room.code).emit('lobby:state', event.room);
      else io.to(event.room.code).emit('room:closed', event.room);
    },
  });

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
    const playerEmail = socket.data.playerEmail;
    if (!playerId || !playerEmail) {
      socket.disconnect(true);
      return;
    }
    const identity = { id: playerId, email: playerEmail };

    const recovered = rooms.reconnect(identity, socket.id);
    if (recovered) {
      socket.data.roomCode = recovered.code;
      void Promise.resolve(socket.join(recovered.code))
        .then(() => io.to(recovered.code).emit('lobby:state', recovered))
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
        io.to(room.code).emit('lobby:state', room);
        reply(acknowledge, roomCommandResultSchema.parse({ ok: true, room }));
      } catch (error) {
        reply(acknowledge, commandFailure(error, 'lobby:start'));
      }
    });

    socket.on('input:update', (payload) => {
      if (!isValid(clientInputSchema, payload)) reportInvalidGameplayPayload(socket, 'input:update');
      // Valid input will enter the authoritative simulation in a later build step.
    });

    socket.on('interaction:request', (payload) => {
      if (!isValid(interactionRequestSchema, payload)) reportInvalidGameplayPayload(socket, 'interaction:request');
    });

    socket.on('shove:request', (payload) => {
      if (!isValid(shoveRequestSchema, payload)) reportInvalidGameplayPayload(socket, 'shove:request');
    });

    socket.on('disconnect', () => {
      const room = rooms.disconnect(playerId, socket.id);
      if (room) io.to(room.code).emit('lobby:state', room);
    });
  });

  return {
    io,
    rooms,
    async close() {
      rooms.close();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

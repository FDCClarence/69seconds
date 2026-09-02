import {
  clientInputSchema,
  interactionRequestSchema,
  serverErrorSchema,
  shoveRequestSchema,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SocketData,
} from '@69-seconds/shared';
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { ZodType } from 'zod';

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

function reportInvalidPayload(
  socket: GameSocket,
  event: string,
): void {
  socket.emit('game:error', serverErrorSchema.parse({
    code: 'INVALID_PAYLOAD',
    message: `Invalid payload for ${event}`,
    event,
    retryable: false,
  }));
}

function isValid<T>(schema: ZodType<T>, payload: unknown): payload is T {
  return schema.safeParse(payload).success;
}

export function attachSocketServer(httpServer: HttpServer, webOrigin: string): GameServer {
  const io: GameServer = new Server(httpServer, {
    cors: { origin: webOrigin, credentials: true },
  });

  io.on('connection', (socket) => {
    socket.on('input:update', (payload) => {
      if (!isValid(clientInputSchema, payload)) reportInvalidPayload(socket, 'input:update');
      // Valid input will enter the authoritative simulation in a later build step.
    });

    socket.on('interaction:request', (payload) => {
      if (!isValid(interactionRequestSchema, payload)) reportInvalidPayload(socket, 'interaction:request');
    });

    socket.on('shove:request', (payload) => {
      if (!isValid(shoveRequestSchema, payload)) reportInvalidPayload(socket, 'shove:request');
    });
  });

  return io;
}

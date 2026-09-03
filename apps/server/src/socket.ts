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
  shoveResultSchema,
  type ClientToServerEvents,
  type InteractionRejectionReason,
  type InteractionResult,
  type InterServerEvents,
  type LootUpdate,
  type ShoveRejectionReason,
  type ShoveResult,
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
import { digestSessionToken, type AuthService } from './auth/service.js';
import { REJECTION_MESSAGES, type LootAuthorityOptions } from './game/loot-authority.js';
import { AuthoritativeRoomSimulation } from './game/simulation.js';
import { SHOVE_REJECTION_MESSAGES, type ShoveAuthorityOptions } from './game/shove-authority.js';
import { RoomRegistry, RoomRegistryError, type RoomRegistryOptions } from './rooms/registry.js';

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export interface SocketServerOptions {
  webOrigins: string[];
  auth: Pick<AuthService, 'resolveSession'> & Partial<Pick<
    AuthService,
    'resolveSessionDetails' | 'onSessionInvalidated'
  >>;
  cookie: Pick<SessionCookieConfig, 'name'>;
  rooms?: Omit<RoomRegistryOptions, 'onEvent'>;
  /** Test seam for placing loot; production uses the shared store map. */
  loot?: LootAuthorityOptions;
  /** Test seam for shove geometry; production uses the shared store map. */
  shove?: ShoveAuthorityOptions;
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

/**
 * Transport-level shove rejection, used before a simulation is ever consulted.
 * A cooldown of zero is honest here: no shove has been committed to time from.
 */
function shoveRejection(requestId: string, reason: ShoveRejectionReason): ShoveResult {
  return shoveResultSchema.parse({
    outcome: 'REJECTED',
    requestId,
    reason,
    message: SHOVE_REJECTION_MESSAGES[reason],
    cooldownEndsAtMs: 0,
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
    // Socket.IO's CORS setting protects polling, but browsers can open a WebSocket
    // directly. Validate its Origin here as well to prevent cross-site socket use
    // with an ambient session cookie. Non-browser clients do not send Origin.
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, origin === undefined || options.webOrigins.includes(origin));
    },
    maxHttpBufferSize: NETWORK.maxPayloadBytes,
  });
  const authenticatedSessions = new Map<string, { tokenDigest: string; expiresAtMs: number | null }>();
  const sessionExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const simulations = new Map<string, AuthoritativeRoomSimulation>();
  const now = options.rooms?.now ?? Date.now;
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

  function sendTallyTo(socket: GameSocket, roomCode: string): void {
    const tally = simulations.get(roomCode)?.tally();
    if (tally) socket.emit('match:tally', tally);
  }

  function broadcastLootUpdate(roomCode: string, update: LootUpdate | null): void {
    if (update) io.to(roomCode).emit('loot:update', update);
  }

  const simulationTimer = setInterval(() => {
    const serverNowMs = now();
    for (const simulation of simulations.values()) {
      const result = simulation.tick(serverNowMs);
      if (!result.snapshotDue && !result.phaseChanged) continue;
      const snapshot = simulation.snapshot(serverNowMs);
      const room = rooms.applySimulationSnapshot(snapshot);
      if (!room) {
        simulations.delete(simulation.roomCode);
        continue;
      }
      // Superseded movement snapshots have no value to a slow client. Volatile
      // delivery prevents latency from turning into an unbounded reliable queue.
      io.to(simulation.roomCode).volatile.emit('state:snapshot', snapshot);
      if (result.phaseChanged) io.to(simulation.roomCode).emit('lobby:state', room);
      if (result.tallyCommitted) {
        const tally = simulation.tally();
        if (tally) io.to(simulation.roomCode).emit('match:tally', tally);
      }
    }
  }, 1_000 / NETWORK.simulationTickRateHz);
  simulationTimer.unref?.();

  const unsubscribeSessionInvalidation = options.auth.onSessionInvalidated?.((tokenDigest) => {
    for (const socket of io.sockets.sockets.values()) {
      if (authenticatedSessions.get(socket.id)?.tokenDigest !== tokenDigest) continue;
      socket.emit('game:error', publicError(
        'UNAUTHENTICATED',
        'Your session is no longer valid',
        'session',
      ));
      socket.disconnect(true);
    }
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
      const supportsSessionDetails = options.auth.resolveSessionDetails !== undefined;
      const details = supportsSessionDetails
        ? await options.auth.resolveSessionDetails!(token)
        : null;
      const user = supportsSessionDetails ? details?.user ?? null : await options.auth.resolveSession(token);
      if (!user) {
        const error = new Error('Authentication is required') as Error & { data: ServerError };
        error.data = publicError('UNAUTHENTICATED', 'Authentication is required', 'connect');
        next(error);
        return;
      }
      socket.data.playerId = user.id;
      socket.data.playerUsername = user.username;
      socket.data.playerEmail = user.email;
      authenticatedSessions.set(socket.id, {
        tokenDigest: digestSessionToken(token),
        expiresAtMs: details?.expiresAt.getTime() ?? null,
      });
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

    const scheduleSessionExpiry = (): void => {
      const expiresAtMs = authenticatedSessions.get(socket.id)?.expiresAtMs;
      if (expiresAtMs === null || expiresAtMs === undefined) return;
      const remainingMs = expiresAtMs - Date.now();
      if (remainingMs <= 0) {
        socket.emit('game:error', publicError(
          'UNAUTHENTICATED',
          'Your session has expired',
          'session',
        ));
        socket.disconnect(true);
        return;
      }
      // Node clamps longer timeouts to one millisecond. Re-arm long-lived
      // sessions in safe chunks so the default 30-day session does not expire early.
      const timer = setTimeout(scheduleSessionExpiry, Math.min(remainingMs, 2_147_000_000));
      timer.unref?.();
      sessionExpiryTimers.set(socket.id, timer);
    };
    scheduleSessionExpiry();

    let eventTokens: number = NETWORK.socketEventBurstCapacity;
    let eventTokensRefilledAtMs = now();
    let lastRateLimitNoticeAtMs = Number.NEGATIVE_INFINITY;
    socket.use((packet, next) => {
      const serverNowMs = now();
      const elapsedSeconds = Math.max(0, (serverNowMs - eventTokensRefilledAtMs) / 1_000);
      eventTokens = Math.min(
        NETWORK.socketEventBurstCapacity,
        eventTokens + elapsedSeconds * NETWORK.socketEventRefillPerSecond,
      );
      eventTokensRefilledAtMs = serverNowMs;
      if (eventTokens >= 1) {
        eventTokens -= 1;
        next();
        return;
      }

      const [event, payload, possibleAcknowledge] = packet as unknown as [string, unknown, unknown];
      const acknowledge = typeof possibleAcknowledge === 'function'
        ? possibleAcknowledge as (result: unknown) => void
        : undefined;
      if (event === 'interaction:request') {
        acknowledge?.(interactionRejection(requestIdFrom(payload), 'RATE_LIMITED'));
      } else if (event === 'shove:request') {
        acknowledge?.(shoveRejection(requestIdFrom(payload), 'RATE_LIMITED'));
      } else if (event !== 'input:update') {
        acknowledge?.(roomCommandResultSchema.parse({
          ok: false,
          error: publicError('RATE_LIMITED', 'Too many realtime requests', event, true),
        }));
      }
      // At most one warning per second, so rejection itself cannot amplify a flood.
      if (serverNowMs - lastRateLimitNoticeAtMs >= 1_000) {
        lastRateLimitNoticeAtMs = serverNowMs;
        socket.emit('game:error', publicError('RATE_LIMITED', 'Too many realtime requests', event, true));
      }
    });

    const recovered = rooms.reconnect(identity, socket.id);
    if (recovered) {
      const simulation = simulations.get(recovered.code);
      simulation?.resetInput(playerId, true);
      simulation?.synchronizePlayers(recovered);
      socket.data.roomCode = recovered.code;
      void Promise.resolve(socket.join(recovered.code))
        .then(() => {
          io.to(recovered.code).emit('lobby:state', recovered);
          // The frozen looting result is what a survival-phase client needs, and
          // the loot floor no longer exists once the day starts.
          if (recovered.phase === 'SURVIVAL' || recovered.phase === 'TALLY') {
            sendTallyTo(socket, recovered.code);
          } else {
            sendLootSyncTo(socket, recovered.code, playerId);
          }
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
        if (code && !room) simulations.delete(code);
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
        const simulation = new AuthoritativeRoomSimulation(room, options.loot ?? {}, options.shove ?? {});
        simulations.set(room.code, simulation);
        io.to(room.code).emit('lobby:state', room);
        io.to(room.code).emit('state:snapshot', simulation.snapshot(now()));
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
      simulations.get(code)?.submitInput(playerId, parsed.data, now());
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
      const resolution = simulation.resolveInteraction(playerId, parsed.data, now());
      acknowledge?.(resolution.result);
      // A replayed request ID reports its original decision and changes nothing.
      broadcastLootUpdate(code, resolution.update);
    });

    socket.on('shove:request', (payload, acknowledge) => {
      const parsed = shoveRequestSchema.safeParse(payload);
      if (!parsed.success) {
        reportInvalidGameplayPayload(socket, 'shove:request');
        acknowledge?.(shoveRejection(requestIdFrom(payload), 'INVALID_PAYLOAD'));
        return;
      }
      const code = rooms.roomForPlayer(playerId);
      const simulation = code ? simulations.get(code) : undefined;
      if (!code || !simulation) {
        acknowledge?.(shoveRejection(parsed.data.requestId, code ? 'INVALID_PHASE' : 'NOT_IN_MATCH'));
        return;
      }
      const resolution = simulation.resolveShove(playerId, parsed.data, now());
      acknowledge?.(resolution.result);
      // A replayed request ID reports its original decision and shoves nobody twice.
      if (resolution.landed) io.to(code).emit('shove:landed', resolution.landed);
    });

    socket.on('disconnect', () => {
      const expiryTimer = sessionExpiryTimers.get(socket.id);
      if (expiryTimer) clearTimeout(expiryTimer);
      sessionExpiryTimers.delete(socket.id);
      authenticatedSessions.delete(socket.id);
      const code = rooms.roomForPlayer(playerId);
      if (code) simulations.get(code)?.resetInput(playerId, true);
      const room = rooms.disconnect(playerId, socket.id);
      if (room) {
        simulations.get(room.code)?.synchronizePlayers(room);
        io.to(room.code).emit('lobby:state', room);
      }
    });
  });

  return {
    io,
    rooms,
    async close() {
      clearInterval(simulationTimer);
      unsubscribeSessionInvalidation?.();
      for (const timer of sessionExpiryTimers.values()) clearTimeout(timer);
      sessionExpiryTimers.clear();
      authenticatedSessions.clear();
      simulations.clear();
      rooms.close();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

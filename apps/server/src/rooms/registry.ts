import {
  GAME,
  PLAYER_SPAWN_POSITIONS,
  ROOM_CODE_ALPHABET,
  roomPublicStateSchema,
  serverErrorSchema,
  type GamePhase,
  type RoomClosed,
  type RoomPublicState,
  type ServerError,
  type ServerErrorCode,
  type GameSnapshot,
} from '@69-seconds/shared';
import { randomInt } from 'node:crypto';

export interface AuthenticatedRoomPlayer {
  id: string;
  username: string;
  email: string;
}

interface RoomPlayer extends AuthenticatedRoomPlayer {
  displayName: string;
  slot: number;
  isReady: boolean;
  position: { x: number; y: number };
  socketIds: Set<string>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
}

interface Room {
  code: string;
  phase: GamePhase;
  phaseEndsAtMs: number | null;
  hostPlayerId: string;
  players: Map<string, RoomPlayer>;
  lastActivityAtMs: number;
}

export type RoomRegistryEvent =
  | { type: 'state'; room: RoomPublicState }
  | { type: 'closed'; room: RoomClosed };

export interface RoomRegistryOptions {
  reconnectGraceMs?: number;
  abandonedRoomTtlMs?: number;
  countdownDurationMs?: number;
  now?: () => number;
  onEvent?: (event: RoomRegistryEvent) => void;
}

export class RoomRegistryError extends Error {
  constructor(
    readonly code: ServerErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'RoomRegistryError';
  }

  toPublic(event: string): ServerError {
    return serverErrorSchema.parse({
      code: this.code,
      message: this.message,
      event,
      retryable: this.retryable,
    });
  }
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly playerRooms = new Map<string, string>();
  private readonly reconnectGraceMs: number;
  private readonly abandonedRoomTtlMs: number;
  private readonly countdownDurationMs: number;
  private readonly now: () => number;
  private readonly onEvent: (event: RoomRegistryEvent) => void;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: RoomRegistryOptions = {}) {
    this.reconnectGraceMs = options.reconnectGraceMs ?? GAME.reconnectGraceMs;
    this.abandonedRoomTtlMs = options.abandonedRoomTtlMs ?? GAME.abandonedRoomTtlMs;
    this.countdownDurationMs = options.countdownDurationMs ?? GAME.countdownDurationMs;
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent ?? (() => undefined);
    const cleanupEveryMs = Math.max(50, Math.min(60_000, Math.floor(this.abandonedRoomTtlMs / 2)));
    this.cleanupTimer = setInterval(() => this.cleanupAbandonedRooms(), cleanupEveryMs);
    this.cleanupTimer.unref?.();
  }

  create(player: AuthenticatedRoomPlayer, socketId: string): RoomPublicState {
    if (this.playerRooms.has(player.id)) {
      throw new RoomRegistryError('ALREADY_IN_ROOM', 'Leave your current room before creating another');
    }

    const code = this.generateCode();
    const roomPlayer = this.newPlayer(player, socketId, 0);
    const room: Room = {
      code,
      phase: 'LOBBY',
      phaseEndsAtMs: null,
      hostPlayerId: player.id,
      players: new Map([[player.id, roomPlayer]]),
      lastActivityAtMs: this.now(),
    };
    this.rooms.set(code, room);
    this.playerRooms.set(player.id, code);
    return this.publicState(room);
  }

  join(code: string, player: AuthenticatedRoomPlayer, socketId: string): RoomPublicState {
    const currentCode = this.playerRooms.get(player.id);
    if (currentCode) {
      if (currentCode !== code) {
        throw new RoomRegistryError('ALREADY_IN_ROOM', 'Leave your current room before joining another');
      }
      const currentRoom = this.rooms.get(currentCode);
      const currentPlayer = currentRoom?.players.get(player.id);
      if (currentRoom && currentPlayer) {
        this.connectPlayer(currentRoom, currentPlayer, socketId);
        return this.publicState(currentRoom);
      }
      this.playerRooms.delete(player.id);
    }

    const room = this.rooms.get(code);
    if (!room) throw new RoomRegistryError('ROOM_NOT_FOUND', 'No room exists for that code');
    if (room.phase !== 'LOBBY') {
      throw new RoomRegistryError('MATCH_ALREADY_STARTED', 'That room has already started');
    }
    if (room.players.size >= GAME.maxPlayers) {
      throw new RoomRegistryError('ROOM_FULL', 'That room already has four players');
    }

    const slot = this.firstOpenSlot(room);
    room.players.set(player.id, this.newPlayer(player, socketId, slot));
    room.lastActivityAtMs = this.now();
    this.playerRooms.set(player.id, room.code);
    return this.publicState(room);
  }

  reconnect(player: AuthenticatedRoomPlayer, socketId: string): RoomPublicState | null {
    const code = this.playerRooms.get(player.id);
    if (!code) return null;
    const room = this.rooms.get(code);
    const roomPlayer = room?.players.get(player.id);
    if (!room || !roomPlayer) {
      this.playerRooms.delete(player.id);
      return null;
    }
    this.connectPlayer(room, roomPlayer, socketId);
    return this.publicState(room);
  }

  setReady(playerId: string, ready: boolean): RoomPublicState {
    const { room, player } = this.membership(playerId);
    if (room.phase !== 'LOBBY') {
      throw new RoomRegistryError('INVALID_PHASE', 'Ready status can only change in the lobby');
    }
    player.isReady = ready;
    room.lastActivityAtMs = this.now();
    return this.publicState(room);
  }

  start(playerId: string): RoomPublicState {
    const { room } = this.membership(playerId);
    if (room.phase !== 'LOBBY') {
      throw new RoomRegistryError('MATCH_ALREADY_STARTED', 'This room has already started');
    }
    if (room.hostPlayerId !== playerId) {
      throw new RoomRegistryError('FORBIDDEN', 'Only the current host can start the match');
    }
    const allConnectedAndReady = [...room.players.values()]
      .every((player) => player.socketIds.size > 0 && player.isReady);
    if (!allConnectedAndReady) {
      throw new RoomRegistryError(
        'PLAYERS_NOT_READY',
        'Every player, including the host, must be connected and ready',
      );
    }
    room.phase = 'COUNTDOWN';
    room.phaseEndsAtMs = this.now() + this.countdownDurationMs;
    for (const player of room.players.values()) {
      const spawn = PLAYER_SPAWN_POSITIONS[player.slot];
      if (!spawn) throw new Error(`Missing spawn for player slot ${player.slot}`);
      player.position = { ...spawn };
    }
    room.lastActivityAtMs = this.now();
    return this.publicState(room);
  }

  leave(playerId: string): RoomPublicState | null {
    const { room } = this.membership(playerId);
    return this.removePlayer(room, playerId, 'EMPTY', false);
  }

  disconnect(playerId: string, socketId: string): RoomPublicState | null {
    const code = this.playerRooms.get(playerId);
    const room = code ? this.rooms.get(code) : undefined;
    const player = room?.players.get(playerId);
    if (!room || !player) return null;

    player.socketIds.delete(socketId);
    room.lastActivityAtMs = this.now();
    if (player.socketIds.size > 0) return this.publicState(room);

    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
    player.disconnectTimer = setTimeout(() => {
      const activeRoom = this.rooms.get(room.code);
      const activePlayer = activeRoom?.players.get(playerId);
      if (!activeRoom || !activePlayer || activePlayer.socketIds.size > 0) return;
      const state = this.removePlayer(activeRoom, playerId, 'EMPTY', true);
      if (state) this.onEvent({ type: 'state', room: state });
    }, this.reconnectGraceMs);
    player.disconnectTimer.unref?.();
    return this.publicState(room);
  }

  roomForPlayer(playerId: string): string | undefined {
    return this.playerRooms.get(playerId);
  }

  applySimulationSnapshot(snapshot: GameSnapshot): RoomPublicState | null {
    const room = this.rooms.get(snapshot.roomCode);
    if (!room) return null;
    room.phase = snapshot.phase;
    room.phaseEndsAtMs = snapshot.phaseEndsAtMs;
    for (const state of snapshot.players) {
      const player = room.players.get(state.id);
      if (player) player.position = { ...state.position };
    }
    room.lastActivityAtMs = this.now();
    return this.publicState(room);
  }

  get size(): number {
    return this.rooms.size;
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    for (const room of this.rooms.values()) {
      for (const player of room.players.values()) {
        if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
      }
    }
    this.rooms.clear();
    this.playerRooms.clear();
  }

  private membership(playerId: string): { room: Room; player: RoomPlayer } {
    const code = this.playerRooms.get(playerId);
    const room = code ? this.rooms.get(code) : undefined;
    const player = room?.players.get(playerId);
    if (!room || !player) throw new RoomRegistryError('NOT_IN_ROOM', 'Join a room first');
    return { room, player };
  }

  private connectPlayer(room: Room, player: RoomPlayer, socketId: string): void {
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      delete player.disconnectTimer;
    }
    player.socketIds.add(socketId);
    room.lastActivityAtMs = this.now();
  }

  private removePlayer(
    room: Room,
    playerId: string,
    closeReason: RoomClosed['reason'],
    emitClose: boolean,
  ): RoomPublicState | null {
    const player = room.players.get(playerId);
    if (!player) return this.publicState(room);
    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
    room.players.delete(playerId);
    this.playerRooms.delete(playerId);

    if (room.players.size === 0) {
      this.rooms.delete(room.code);
      if (emitClose) this.onEvent({ type: 'closed', room: { code: room.code, reason: closeReason } });
      return null;
    }
    if (room.hostPlayerId === playerId) {
      const nextHost = [...room.players.values()].sort((left, right) => left.slot - right.slot)[0];
      if (!nextHost) throw new Error('Room host migration requires a remaining player');
      room.hostPlayerId = nextHost.id;
    }
    room.lastActivityAtMs = this.now();
    return this.publicState(room);
  }

  private cleanupAbandonedRooms(): void {
    const expiredBefore = this.now() - this.abandonedRoomTtlMs;
    for (const room of this.rooms.values()) {
      const abandoned = [...room.players.values()].every((player) => player.socketIds.size === 0);
      if (!abandoned || room.lastActivityAtMs > expiredBefore) continue;
      for (const player of room.players.values()) {
        if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
        this.playerRooms.delete(player.id);
      }
      this.rooms.delete(room.code);
      this.onEvent({ type: 'closed', room: { code: room.code, reason: 'EXPIRED' } });
    }
  }

  private newPlayer(player: AuthenticatedRoomPlayer, socketId: string, slot: number): RoomPlayer {
    return {
      ...player,
      displayName: player.username,
      slot,
      isReady: false,
      position: { x: 0, y: 0 },
      socketIds: new Set([socketId]),
    };
  }

  private firstOpenSlot(room: Room): number {
    const occupied = new Set([...room.players.values()].map((player) => player.slot));
    for (let slot = 0; slot < GAME.maxPlayers; slot += 1) {
      if (!occupied.has(slot)) return slot;
    }
    throw new RoomRegistryError('ROOM_FULL', 'That room already has four players');
  }

  private generateCode(): string {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      let code = '';
      for (let index = 0; index < GAME.roomCodeLength; index += 1) {
        code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new RoomRegistryError('INTERNAL_ERROR', 'Could not allocate a room code', true);
  }

  private publicState(room: Room): RoomPublicState {
    return roomPublicStateSchema.parse({
      code: room.code,
      phase: room.phase,
      hostPlayerId: room.hostPlayerId,
      players: [...room.players.values()]
        .sort((left, right) => left.slot - right.slot)
        .map((player) => ({
          id: player.id,
          displayName: player.displayName,
          slot: player.slot,
          isHost: player.id === room.hostPlayerId,
          isReady: player.isReady,
          isConnected: player.socketIds.size > 0,
          connectionState: player.socketIds.size > 0 ? 'CONNECTED' : 'RECONNECTING',
          position: player.position,
        })),
      serverTimeMs: this.now(),
      phaseEndsAtMs: room.phaseEndsAtMs,
    });
  }
}

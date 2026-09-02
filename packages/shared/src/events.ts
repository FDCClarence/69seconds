import type {
  ClientInput,
  GameSnapshot,
  InteractionRequest,
  InteractionResult,
  LobbyReadyRequest,
  LobbyStartRequest,
  RoomClosed,
  RoomCommandResult,
  RoomCreateRequest,
  RoomJoinRequest,
  RoomLeaveRequest,
  LootSync,
  LootUpdate,
  MatchTally,
  RoomPublicState,
  ServerError,
  ShoveRequest,
  ShoveLanded,
  ShoveResult,
} from './schemas.js';

export const CLIENT_EVENTS = {
  CREATE_ROOM: 'room:create',
  JOIN_ROOM: 'room:join',
  LEAVE_ROOM: 'room:leave',
  SET_READY: 'lobby:ready',
  START_MATCH: 'lobby:start',
  INPUT: 'input:update',
  INTERACT: 'interaction:request',
  SHOVE: 'shove:request',
} as const;

export const SERVER_EVENTS = {
  LOBBY_STATE: 'lobby:state',
  ROOM_CLOSED: 'room:closed',
  SNAPSHOT: 'state:snapshot',
  LOOT_SYNC: 'loot:sync',
  LOOT_UPDATE: 'loot:update',
  SHOVE_LANDED: 'shove:landed',
  MATCH_TALLY: 'match:tally',
  ERROR: 'game:error',
} as const;

export interface ClientToServerEvents {
  'room:create': (request: RoomCreateRequest, acknowledge: (result: RoomCommandResult) => void) => void;
  'room:join': (request: RoomJoinRequest, acknowledge: (result: RoomCommandResult) => void) => void;
  'room:leave': (request: RoomLeaveRequest, acknowledge: (result: RoomCommandResult) => void) => void;
  'lobby:ready': (request: LobbyReadyRequest, acknowledge: (result: RoomCommandResult) => void) => void;
  'lobby:start': (request: LobbyStartRequest, acknowledge: (result: RoomCommandResult) => void) => void;
  'input:update': (input: ClientInput) => void;
  'interaction:request': (request: InteractionRequest, acknowledge: (result: InteractionResult) => void) => void;
  'shove:request': (request: ShoveRequest, acknowledge: (result: ShoveResult) => void) => void;
}

export interface ServerToClientEvents {
  'lobby:state': (room: RoomPublicState) => void;
  'room:closed': (room: RoomClosed) => void;
  'state:snapshot': (snapshot: GameSnapshot) => void;
  /** Addressed to one socket: it contains that player's private carried inventory. */
  'loot:sync': (sync: LootSync) => void;
  /** Broadcast to the room: committed, public loot and cart changes only. */
  'loot:update': (update: LootUpdate) => void;
  /** Broadcast to the room: one committed shove, with the target's authoritative landing spot. */
  'shove:landed': (event: ShoveLanded) => void;
  /** Broadcast once at the deadline and replayed to a reconnecting room member. */
  'match:tally': (result: MatchTally) => void;
  'game:error': (error: ServerError) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

export interface SocketData {
  playerId?: string;
  playerUsername?: string;
  playerEmail?: string;
  roomCode?: string;
}

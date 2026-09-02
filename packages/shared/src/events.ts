import type {
  ClientInput,
  GameSnapshot,
  InteractionRequest,
  LobbyReadyRequest,
  LobbyStartRequest,
  RoomClosed,
  RoomCommandResult,
  RoomCreateRequest,
  RoomJoinRequest,
  RoomLeaveRequest,
  RoomPublicState,
  ServerError,
  ShoveRequest,
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
  ERROR: 'game:error',
} as const;

export interface ClientToServerEvents {
  'room:create': (request: RoomCreateRequest, acknowledge: (result: RoomCommandResult) => void) => void;
  'room:join': (request: RoomJoinRequest, acknowledge: (result: RoomCommandResult) => void) => void;
  'room:leave': (request: RoomLeaveRequest, acknowledge: (result: RoomCommandResult) => void) => void;
  'lobby:ready': (request: LobbyReadyRequest, acknowledge: (result: RoomCommandResult) => void) => void;
  'lobby:start': (request: LobbyStartRequest, acknowledge: (result: RoomCommandResult) => void) => void;
  'input:update': (input: ClientInput) => void;
  'interaction:request': (request: InteractionRequest) => void;
  'shove:request': (request: ShoveRequest) => void;
}

export interface ServerToClientEvents {
  'lobby:state': (room: RoomPublicState) => void;
  'room:closed': (room: RoomClosed) => void;
  'state:snapshot': (snapshot: GameSnapshot) => void;
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

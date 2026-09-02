import type {
  ClientInput,
  GameSnapshot,
  InteractionRequest,
  ServerError,
  ShoveRequest,
} from './schemas.js';

export const CLIENT_EVENTS = {
  INPUT: 'input:update',
  INTERACT: 'interaction:request',
  SHOVE: 'shove:request',
} as const;

export const SERVER_EVENTS = {
  SNAPSHOT: 'state:snapshot',
  ERROR: 'game:error',
} as const;

export interface ClientToServerEvents {
  'input:update': (input: ClientInput) => void;
  'interaction:request': (request: InteractionRequest) => void;
  'shove:request': (request: ShoveRequest) => void;
}

export interface ServerToClientEvents {
  'state:snapshot': (snapshot: GameSnapshot) => void;
  'game:error': (error: ServerError) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

export interface SocketData {
  playerId?: string;
  roomCode?: string;
}

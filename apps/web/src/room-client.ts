import {
  roomClosedSchema,
  roomCommandResultSchema,
  roomPublicStateSchema,
  serverErrorSchema,
  type ClientToServerEvents,
  type RoomClosed,
  type RoomPublicState,
  type ServerError,
  type ServerErrorCode,
  type ServerToClientEvents,
} from '@69-seconds/shared';
import { io, type Socket } from 'socket.io-client';

export type SocketConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';

export interface RoomClientListeners {
  onRoom(room: RoomPublicState): void;
  onClosed(room: RoomClosed): void;
  onConnection(state: SocketConnectionState): void;
  onError(error: RoomClientError): void;
}

export interface RoomClient {
  connect(): void;
  disconnect(): void;
  subscribe(listeners: RoomClientListeners): () => void;
  createRoom(): Promise<RoomPublicState>;
  joinRoom(code: string): Promise<RoomPublicState>;
  leaveRoom(): Promise<RoomPublicState | null>;
  setReady(ready: boolean): Promise<RoomPublicState>;
  startMatch(): Promise<RoomPublicState>;
}

export class RoomClientError extends Error {
  constructor(
    readonly code: ServerErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'RoomClientError';
  }
}

function serverUrl(): string {
  return (import.meta.env.VITE_SERVER_URL ?? '').replace(/\/$/, '');
}

export function createRoomClient(): RoomClient {
  return new SocketRoomClient(io(serverUrl(), {
    autoConnect: false,
    withCredentials: true,
  }));
}

class SocketRoomClient implements RoomClient {
  private readonly listeners = new Set<RoomClientListeners>();
  private connectionState: SocketConnectionState = 'DISCONNECTED';

  constructor(private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>) {
    socket.on('connect', () => this.publishConnection('CONNECTED'));
    socket.on('disconnect', (reason) => {
      this.publishConnection(reason === 'io client disconnect' ? 'DISCONNECTED' : 'RECONNECTING');
    });
    socket.on('connect_error', (error) => {
      const parsed = serverErrorSchema.safeParse((error as Error & { data?: unknown }).data);
      if (parsed.success) this.publishError(parsed.data);
      this.publishConnection(socket.active ? 'RECONNECTING' : 'DISCONNECTED');
    });
    socket.io.on('reconnect_attempt', () => this.publishConnection('RECONNECTING'));
    socket.on('lobby:state', (payload) => {
      const parsed = roomPublicStateSchema.safeParse(payload);
      if (!parsed.success) {
        this.publishError({ code: 'INVALID_PAYLOAD', message: 'Received invalid lobby state', retryable: true });
        return;
      }
      for (const listener of this.listeners) listener.onRoom(parsed.data);
    });
    socket.on('room:closed', (payload) => {
      const parsed = roomClosedSchema.safeParse(payload);
      if (!parsed.success) return;
      for (const listener of this.listeners) listener.onClosed(parsed.data);
    });
  }

  connect(): void {
    if (this.socket.connected || this.socket.active) return;
    this.publishConnection('CONNECTING');
    this.socket.connect();
  }

  disconnect(): void {
    this.socket.disconnect();
    this.publishConnection('DISCONNECTED');
  }

  subscribe(listeners: RoomClientListeners): () => void {
    this.listeners.add(listeners);
    listeners.onConnection(this.connectionState);
    return () => this.listeners.delete(listeners);
  }

  async createRoom(): Promise<RoomPublicState> {
    await this.ensureConnected();
    return this.requiredRoom(await this.emitCommand((acknowledge) => {
      this.socket.emit('room:create', {}, acknowledge);
    }));
  }

  async joinRoom(code: string): Promise<RoomPublicState> {
    await this.ensureConnected();
    return this.requiredRoom(await this.emitCommand((acknowledge) => {
      this.socket.emit('room:join', { code }, acknowledge);
    }));
  }

  async leaveRoom(): Promise<RoomPublicState | null> {
    await this.ensureConnected();
    return this.emitCommand((acknowledge) => {
      this.socket.emit('room:leave', {}, acknowledge);
    });
  }

  async setReady(ready: boolean): Promise<RoomPublicState> {
    await this.ensureConnected();
    return this.requiredRoom(await this.emitCommand((acknowledge) => {
      this.socket.emit('lobby:ready', { ready }, acknowledge);
    }));
  }

  async startMatch(): Promise<RoomPublicState> {
    await this.ensureConnected();
    return this.requiredRoom(await this.emitCommand((acknowledge) => {
      this.socket.emit('lobby:start', {}, acknowledge);
    }));
  }

  private ensureConnected(): Promise<void> {
    if (this.socket.connected) return Promise.resolve();
    this.connect();
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.socket.off('connect', onConnect);
        this.socket.off('connect_error', onError);
      };
      this.socket.on('connect', onConnect);
      this.socket.on('connect_error', onError);
    });
  }

  private emitCommand(
    emit: (acknowledge: (payload: unknown) => void) => void,
  ): Promise<RoomPublicState | null> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new RoomClientError('INTERNAL_ERROR', 'The room server did not respond', true));
      }, 5_000);
      emit((payload) => {
        window.clearTimeout(timeout);
        const parsed = roomCommandResultSchema.safeParse(payload);
        if (!parsed.success) {
          reject(new RoomClientError('INVALID_PAYLOAD', 'The room server returned an invalid response', true));
          return;
        }
        if (!parsed.data.ok) {
          reject(new RoomClientError(
            parsed.data.error.code,
            parsed.data.error.message,
            parsed.data.error.retryable,
          ));
          return;
        }
        resolve(parsed.data.room);
      });
    });
  }

  private requiredRoom(room: RoomPublicState | null): RoomPublicState {
    if (room) return room;
    throw new RoomClientError('INVALID_PAYLOAD', 'The room server omitted lobby state', true);
  }

  private publishConnection(state: SocketConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const listener of this.listeners) listener.onConnection(state);
  }

  private publishError(error: ServerError): void {
    const clientError = new RoomClientError(error.code, error.message, error.retryable);
    for (const listener of this.listeners) listener.onError(clientError);
  }
}

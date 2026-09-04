import {
  roomClosedSchema,
  gameSnapshotSchema,
  interactionResultSchema,
  matchTallySchema,
  lootSyncSchema,
  lootUpdateSchema,
  roomCommandResultSchema,
  roomPublicStateSchema,
  serverErrorSchema,
  shoveLandedSchema,
  shoveResultSchema,
  survivalStateSchema,
  survivalConsumeResultSchema,
  survivalEndDayResultSchema,
  survivalReadinessStateSchema,
  type ClientToServerEvents,
  type ClientInput,
  type GameSnapshot,
  type InteractionRequest,
  type InteractionResult,
  type LootSync,
  type LootUpdate,
  type MatchTally,
  type MovementInput,
  type RoomClosed,
  type RoomPublicState,
  type ServerError,
  type ServerErrorCode,
  type ServerToClientEvents,
  type ShoveLanded,
  type ShoveRequest,
  type ShoveResult,
  type SurvivalConsumeRequest,
  type SurvivalConsumeResult,
  type SurvivalState,
  type SurvivalReadinessState,
} from '@69-seconds/shared';
import { io, type Socket } from 'socket.io-client';

export type SocketConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';

export interface RoomClientListeners {
  onRoom(room: RoomPublicState): void;
  onClosed(room: RoomClosed): void;
  onConnection(state: SocketConnectionState): void;
  onError(error: RoomClientError): void;
  onResult?(result: MatchTally): void;
  /**
   * The day's households, exactly as the server committed them. Read-only: the
   * client has no event with which to send any of it back.
   */
  onSurvivalState?(state: SurvivalState): void;
  onSurvivalReadiness?(state: SurvivalReadinessState): void;
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
  sendInput?(movement: MovementInput, sprint: boolean): ClientInput | null;
  subscribeSnapshots?(listener: (snapshot: GameSnapshot) => void): () => void;
  requestInteraction?(request: InteractionRequest): Promise<InteractionResult>;
  requestShove?(request: ShoveRequest): Promise<ShoveResult>;
  subscribeLootSync?(listener: (sync: LootSync) => void): () => void;
  subscribeLootUpdates?(listener: (update: LootUpdate) => void): () => void;
  subscribeShoveLanded?(listener: (event: ShoveLanded) => void): () => void;
  endDay?(): Promise<SurvivalReadinessState>;
  /**
   * Feeding intent. It resolves with the server's decision — committed or
   * rejected — rather than throwing on a rejection, because a refused feed is a
   * gameplay answer the screen renders, not a transport failure.
   */
  consumeItem?(request: SurvivalConsumeRequest): Promise<SurvivalConsumeResult>;
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

export class SocketRoomClient implements RoomClient {
  private readonly listeners = new Set<RoomClientListeners>();
  private connectionState: SocketConnectionState = 'DISCONNECTED';
  private readonly snapshotListeners = new Set<(snapshot: GameSnapshot) => void>();
  private readonly lootSyncListeners = new Set<(sync: LootSync) => void>();
  private readonly lootUpdateListeners = new Set<(update: LootUpdate) => void>();
  private readonly shoveLandedListeners = new Set<(event: ShoveLanded) => void>();
  private latestLootSync: LootSync | null = null;
  private readonly lootUpdatesSinceSync: LootUpdate[] = [];
  private latestLootSequence = -1;
  private nextInputSequence = 0;

  constructor(private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>) {
    socket.on('connect', () => {
      this.nextInputSequence = 0;
      this.publishConnection('CONNECTED');
    });
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
    socket.on('state:snapshot', (payload) => {
      const parsed = gameSnapshotSchema.safeParse(payload);
      if (!parsed.success) {
        this.publishError({ code: 'INVALID_PAYLOAD', message: 'Received invalid game snapshot', retryable: true });
        return;
      }
      for (const listener of this.snapshotListeners) listener(parsed.data);
    });
    socket.on('loot:sync', (payload) => {
      const parsed = lootSyncSchema.safeParse(payload);
      if (!parsed.success) {
        this.publishError({ code: 'INVALID_PAYLOAD', message: 'Received invalid loot state', retryable: true });
        return;
      }
      if (parsed.data.sequence < this.latestLootSequence) return;
      this.latestLootSync = parsed.data;
      this.latestLootSequence = parsed.data.sequence;
      this.lootUpdatesSinceSync.splice(0, this.lootUpdatesSinceSync.length);
      for (const listener of this.lootSyncListeners) listener(parsed.data);
    });
    socket.on('loot:update', (payload) => {
      const parsed = lootUpdateSchema.safeParse(payload);
      if (!parsed.success) {
        this.publishError({ code: 'INVALID_PAYLOAD', message: 'Received invalid loot update', retryable: true });
        return;
      }
      if (parsed.data.sequence <= this.latestLootSequence) return;
      this.latestLootSequence = parsed.data.sequence;
      if (
        this.latestLootSync?.roomCode === parsed.data.roomCode
        && parsed.data.sequence > this.latestLootSync.sequence
        && !this.lootUpdatesSinceSync.some((update) => update.sequence === parsed.data.sequence)
      ) {
        this.lootUpdatesSinceSync.push(parsed.data);
      }
      for (const listener of this.lootUpdateListeners) listener(parsed.data);
    });
    socket.on('shove:landed', (payload) => {
      const parsed = shoveLandedSchema.safeParse(payload);
      if (!parsed.success) {
        this.publishError({ code: 'INVALID_PAYLOAD', message: 'Received an invalid shove result', retryable: true });
        return;
      }
      for (const listener of this.shoveLandedListeners) listener(parsed.data);
    });
    socket.on('match:tally', (payload) => {
      const parsed = matchTallySchema.safeParse(payload);
      if (!parsed.success) {
        this.publishError({ code: 'INVALID_PAYLOAD', message: 'Received an invalid match tally', retryable: true });
        return;
      }
      for (const listener of this.listeners) listener.onResult?.(parsed.data);
    });
    socket.on('survival:state', (payload) => {
      const parsed = survivalStateSchema.safeParse(payload);
      if (!parsed.success) {
        this.publishError({ code: 'INVALID_PAYLOAD', message: 'Received an invalid survival state', retryable: true });
        return;
      }
      for (const listener of this.listeners) listener.onSurvivalState?.(parsed.data);
    });
    socket.on('survival:readiness', (payload) => {
      const parsed = survivalReadinessStateSchema.safeParse(payload);
      if (!parsed.success) {
        this.publishError({ code: 'INVALID_PAYLOAD', message: 'Received invalid survival readiness', retryable: true });
        return;
      }
      for (const listener of this.listeners) listener.onSurvivalReadiness?.(parsed.data);
    });
  }

  connect(): void {
    if (this.socket.connected || this.socket.active) return;
    this.publishConnection('CONNECTING');
    this.socket.connect();
  }

  disconnect(): void {
    this.socket.disconnect();
    this.clearGameplayCache();
    this.publishConnection('DISCONNECTED');
  }

  subscribe(listeners: RoomClientListeners): () => void {
    this.listeners.add(listeners);
    listeners.onConnection(this.connectionState);
    return () => this.listeners.delete(listeners);
  }

  async createRoom(): Promise<RoomPublicState> {
    await this.ensureConnected();
    const room = this.requiredRoom(await this.emitCommand((acknowledge) => {
      this.socket.emit('room:create', {}, acknowledge);
    }));
    this.clearGameplayCache();
    return room;
  }

  async joinRoom(code: string): Promise<RoomPublicState> {
    await this.ensureConnected();
    const room = this.requiredRoom(await this.emitCommand((acknowledge) => {
      this.socket.emit('room:join', { code }, acknowledge);
    }));
    this.clearGameplayCache();
    return room;
  }

  async leaveRoom(): Promise<RoomPublicState | null> {
    await this.ensureConnected();
    const room = await this.emitCommand((acknowledge) => {
      this.socket.emit('room:leave', {}, acknowledge);
    });
    this.clearGameplayCache();
    return room;
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

  sendInput(movement: MovementInput, sprint: boolean): ClientInput | null {
    if (!this.socket.connected) return null;
    const input: ClientInput = {
      sequence: this.nextInputSequence++,
      clientTimeMs: Date.now(),
      movement,
      sprint,
    };
    this.socket.emit('input:update', input);
    return input;
  }

  subscribeSnapshots(listener: (snapshot: GameSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  subscribeLootSync(listener: (sync: LootSync) => void): () => void {
    this.lootSyncListeners.add(listener);
    if (this.latestLootSync) listener(this.latestLootSync);
    return () => this.lootSyncListeners.delete(listener);
  }

  subscribeLootUpdates(listener: (update: LootUpdate) => void): () => void {
    this.lootUpdateListeners.add(listener);
    for (const update of this.lootUpdatesSinceSync) listener(update);
    return () => this.lootUpdateListeners.delete(listener);
  }

  subscribeShoveLanded(listener: (event: ShoveLanded) => void): () => void {
    this.shoveLandedListeners.add(listener);
    return () => this.shoveLandedListeners.delete(listener);
  }

  /**
   * Sends an interaction intent and resolves with the server's decision. The
   * request ID lets the server replay a committed decision if this call is
   * retried, so a duplicate delivery can never double-apply.
   */
  requestInteraction(request: InteractionRequest): Promise<InteractionResult> {
    return new Promise((resolve, reject) => {
      if (!this.socket.connected) {
        reject(new RoomClientError('INTERNAL_ERROR', 'Not connected to the match server', true));
        return;
      }
      const timeout = window.setTimeout(() => {
        reject(new RoomClientError('INTERNAL_ERROR', 'The match server did not acknowledge the interaction', true));
      }, 5_000);
      this.socket.emit('interaction:request', request, (payload: unknown) => {
        window.clearTimeout(timeout);
        const parsed = interactionResultSchema.safeParse(payload);
        if (!parsed.success) {
          reject(new RoomClientError('INVALID_PAYLOAD', 'The match server returned an invalid interaction result', true));
          return;
        }
        resolve(parsed.data);
      });
    });
  }

  /**
   * Sends a shove intent. The payload carries no direction: the server aims from
   * the facing it derived from this player's movement inputs.
   */
  requestShove(request: ShoveRequest): Promise<ShoveResult> {
    return new Promise((resolve, reject) => {
      if (!this.socket.connected) {
        reject(new RoomClientError('INTERNAL_ERROR', 'Not connected to the match server', true));
        return;
      }
      const timeout = window.setTimeout(() => {
        reject(new RoomClientError('INTERNAL_ERROR', 'The match server did not acknowledge the shove', true));
      }, 5_000);
      this.socket.emit('shove:request', request, (payload: unknown) => {
        window.clearTimeout(timeout);
        const parsed = shoveResultSchema.safeParse(payload);
        if (!parsed.success) {
          reject(new RoomClientError('INVALID_PAYLOAD', 'The match server returned an invalid shove result', true));
          return;
        }
        resolve(parsed.data);
      });
    });
  }

  /** Sends only the local player's intent; identity and day are server-owned. */
  endDay(): Promise<SurvivalReadinessState> {
    return new Promise((resolve, reject) => {
      if (!this.socket.connected) {
        reject(new RoomClientError('INTERNAL_ERROR', 'Not connected to the match server', true));
        return;
      }
      const timeout = window.setTimeout(() => {
        reject(new RoomClientError('INTERNAL_ERROR', 'The match server did not acknowledge End Day', true));
      }, 5_000);
      this.socket.emit('survival:end-day', {}, (payload: unknown) => {
        window.clearTimeout(timeout);
        const parsed = survivalEndDayResultSchema.safeParse(payload);
        if (!parsed.success) {
          reject(new RoomClientError('INVALID_PAYLOAD', 'The match server returned invalid End Day state', true));
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
        resolve(parsed.data.readiness);
      });
    });
  }

  /**
   * Sends one feeding intent and returns the server's own decision. Only the
   * item and the character travel: what the item restores, and the stat maxima
   * it is clamped to, are the server's to read.
   *
   * A `REJECTED` outcome resolves rather than rejecting, so the screen can show
   * the server's reason. Only a broken transport rejects.
   */
  consumeItem(request: SurvivalConsumeRequest): Promise<SurvivalConsumeResult> {
    return new Promise((resolve, reject) => {
      if (!this.socket.connected) {
        reject(new RoomClientError('INTERNAL_ERROR', 'Not connected to the match server', true));
        return;
      }
      const timeout = window.setTimeout(() => {
        reject(new RoomClientError('INTERNAL_ERROR', 'The match server did not acknowledge the feed', true));
      }, 5_000);
      this.socket.emit('survival:consume', request, (payload: unknown) => {
        window.clearTimeout(timeout);
        const parsed = survivalConsumeResultSchema.safeParse(payload);
        if (!parsed.success) {
          reject(new RoomClientError('INVALID_PAYLOAD', 'The match server returned an invalid feed result', true));
          return;
        }
        resolve(parsed.data);
      });
    });
  }

  private ensureConnected(): Promise<void> {
    if (this.socket.connected) return Promise.resolve();
    this.connect();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new RoomClientError('INTERNAL_ERROR', 'Could not connect to the room server', true));
      }, 5_000);
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
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

  private clearGameplayCache(): void {
    this.latestLootSync = null;
    this.latestLootSequence = -1;
    this.lootUpdatesSinceSync.splice(0, this.lootUpdatesSinceSync.length);
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

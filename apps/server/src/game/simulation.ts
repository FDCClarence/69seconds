import {
  GAME,
  NETWORK,
  gameSnapshotSchema,
  simulatePlayerMovement,
  type ClientInput,
  type GamePhase,
  type GameSnapshot,
  type InteractionRequest,
  type LootSync,
  type LootUpdate,
  type RoomPublicState,
  type Vector2,
} from '@69-seconds/shared';
import { MatchLootAuthority, type InteractionResolution, type LootAuthorityOptions } from './loot-authority.js';

const IDLE_MOVEMENT = { up: false, down: false, left: false, right: false } as const;
const FIXED_DELTA_SECONDS = 1 / NETWORK.simulationTickRateHz;

interface SimulatedPlayer {
  id: string;
  slot: number;
  position: Vector2;
  currentInput: ClientInput;
  queuedInputs: ClientInput[];
  lastReceivedSequence: number;
  acknowledgedInputSequence: number;
}

export interface SimulationTickResult {
  phaseChanged: boolean;
  snapshotDue: boolean;
}

/** Deterministic room simulation. Wall time controls phases; movement always uses one fixed step. */
export class AuthoritativeRoomSimulation {
  readonly roomCode: string;
  private readonly players = new Map<string, SimulatedPlayer>();
  private readonly loot: MatchLootAuthority;
  private phase: GamePhase;
  private phaseEndsAtMs: number | null;
  private snapshotSequence = 0;
  private snapshotAccumulatorSeconds = 0;

  constructor(room: RoomPublicState, lootOptions: LootAuthorityOptions = {}) {
    this.roomCode = room.code;
    this.phase = room.phase;
    this.phaseEndsAtMs = room.phaseEndsAtMs;
    for (const player of room.players) {
      this.players.set(player.id, {
        id: player.id,
        slot: player.slot,
        position: { ...player.position },
        currentInput: this.idleInput(-1),
        queuedInputs: [],
        lastReceivedSequence: -1,
        acknowledgedInputSequence: -1,
      });
    }
    this.loot = new MatchLootAuthority(room.code, room.players, lootOptions);
  }

  submitInput(playerId: string, input: ClientInput): boolean {
    const player = this.players.get(playerId);
    if (!player || input.sequence <= player.lastReceivedSequence) return false;
    player.lastReceivedSequence = input.sequence;
    // Socket.IO preserves order. The cap bounds malicious backlog without increasing movement per tick.
    if (player.queuedInputs.length >= NETWORK.maxInputRateHz) player.queuedInputs.shift();
    player.queuedInputs.push(input);
    return true;
  }

  resetInput(playerId: string, resetSequence = false): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.queuedInputs = [];
    player.currentInput = this.idleInput(-1);
    if (resetSequence) {
      player.lastReceivedSequence = -1;
      player.acknowledgedInputSequence = -1;
    }
  }

  /** Returns the loot restocked from the departing player's hands, if any. */
  removePlayer(playerId: string): LootUpdate | null {
    this.players.delete(playerId);
    return this.loot.removePlayer(playerId);
  }

  synchronizePlayers(room: RoomPublicState): LootUpdate[] {
    const activeIds = new Set(room.players.map((player) => player.id));
    for (const playerId of this.players.keys()) {
      if (!activeIds.has(playerId)) this.players.delete(playerId);
    }
    for (const player of room.players) {
      const simulated = this.players.get(player.id);
      if (simulated) simulated.slot = player.slot;
    }
    return this.loot.synchronizePlayers(room.players);
  }

  /**
   * Interaction validation reuses this simulation's authoritative position and
   * phase, so a client can never widen its own reach or beat the deadline.
   */
  resolveInteraction(
    playerId: string,
    request: InteractionRequest,
    serverNowMs: number,
  ): InteractionResolution {
    const player = this.players.get(playerId);
    return this.loot.resolve({
      playerId,
      position: player ? { ...player.position } : { x: Number.NaN, y: Number.NaN },
      phase: this.phase,
      phaseEndsAtMs: this.phaseEndsAtMs,
      serverNowMs,
      request,
    });
  }

  lootSyncFor(playerId: string): LootSync {
    return this.loot.syncFor(playerId);
  }

  tick(serverNowMs: number): SimulationTickResult {
    let phaseChanged = false;
    if (this.phase === 'COUNTDOWN' && this.phaseEndsAtMs !== null && serverNowMs >= this.phaseEndsAtMs) {
      this.phase = 'LOOTING';
      this.phaseEndsAtMs = serverNowMs + GAME.lootingDurationMs;
      phaseChanged = true;
    }

    const movementAllowed = this.phase === 'LOOTING'
      && (this.phaseEndsAtMs === null || serverNowMs < this.phaseEndsAtMs);
    for (const player of this.players.values()) {
      const nextInput = player.queuedInputs.shift();
      if (nextInput) {
        player.currentInput = nextInput;
        player.acknowledgedInputSequence = nextInput.sequence;
      }
      if (movementAllowed) {
        player.position = simulatePlayerMovement(
          player.position,
          player.currentInput.movement,
          player.currentInput.sprint,
          FIXED_DELTA_SECONDS,
        );
      }
    }

    this.snapshotAccumulatorSeconds += FIXED_DELTA_SECONDS;
    const snapshotInterval = 1 / NETWORK.snapshotRateHz;
    const snapshotDue = this.snapshotAccumulatorSeconds + Number.EPSILON >= snapshotInterval;
    if (snapshotDue) this.snapshotAccumulatorSeconds -= snapshotInterval;
    return { phaseChanged, snapshotDue };
  }

  snapshot(serverNowMs: number): GameSnapshot {
    return gameSnapshotSchema.parse({
      sequence: this.snapshotSequence++,
      roomCode: this.roomCode,
      phase: this.phase,
      serverTimeMs: Math.max(0, Math.floor(serverNowMs)),
      phaseEndsAtMs: this.phaseEndsAtMs,
      players: [...this.players.values()].map((player) => ({
        id: player.id,
        position: player.position,
        sprinting: player.currentInput.sprint,
        acknowledgedInputSequence: player.acknowledgedInputSequence,
      })),
    });
  }

  private idleInput(sequence: number): ClientInput {
    return {
      sequence: Math.max(0, sequence),
      clientTimeMs: 0,
      movement: IDLE_MOVEMENT,
      sprint: false,
    };
  }
}

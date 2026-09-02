import {
  GAME,
  NETWORK,
  gameSnapshotSchema,
  initialSprintState,
  movementAxis,
  normalizeMovementVector,
  resolveSprint,
  simulatePlayerMovement,
  type ClientInput,
  type GamePhase,
  type GameSnapshot,
  type InteractionRequest,
  type LootSync,
  type LootUpdate,
  type RoomPublicState,
  type ShoveRequest,
  type SprintState,
  type Vector2,
} from '@69-seconds/shared';
import { MatchLootAuthority, type InteractionResolution, type LootAuthorityOptions } from './loot-authority.js';
import {
  MatchShoveAuthority,
  type ShoveAuthorityOptions,
  type ShoveResolution,
} from './shove-authority.js';

const IDLE_MOVEMENT = { up: false, down: false, left: false, right: false } as const;
const FIXED_DELTA_SECONDS = 1 / NETWORK.simulationTickRateHz;
/** Players spawn facing the carts, matching the client's initial 'south' pose. */
const INITIAL_FACING: Vector2 = { x: 0, y: 1 };

interface SimulatedPlayer {
  id: string;
  slot: number;
  position: Vector2;
  /** Last non-zero movement direction, which is what a shove is aimed along. */
  facing: Vector2;
  sprint: SprintState;
  /** The effective sprint applied this tick, not the Shift the client asked for. */
  sprinting: boolean;
  /** Server clock time until which this player's own movement input is ignored. */
  recoveringUntilMs: number;
  /** False while disconnected or reconnecting; such a player cannot shove or be shoved. */
  connected: boolean;
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
  private readonly shoves: MatchShoveAuthority;
  private phase: GamePhase;
  private phaseEndsAtMs: number | null;
  private snapshotSequence = 0;
  private snapshotAccumulatorSeconds = 0;

  constructor(
    room: RoomPublicState,
    lootOptions: LootAuthorityOptions = {},
    shoveOptions: ShoveAuthorityOptions = {},
  ) {
    this.roomCode = room.code;
    this.phase = room.phase;
    this.phaseEndsAtMs = room.phaseEndsAtMs;
    for (const player of room.players) {
      this.players.set(player.id, {
        id: player.id,
        slot: player.slot,
        position: { ...player.position },
        facing: { ...INITIAL_FACING },
        sprint: initialSprintState(),
        sprinting: false,
        recoveringUntilMs: 0,
        connected: player.isConnected,
        currentInput: this.idleInput(-1),
        queuedInputs: [],
        lastReceivedSequence: -1,
        acknowledgedInputSequence: -1,
      });
    }
    this.loot = new MatchLootAuthority(room.code, room.players, lootOptions);
    this.shoves = new MatchShoveAuthority(room.code, shoveOptions);
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

  /**
   * Clears held input without touching the sprint resource or a recovery window:
   * neither can be refreshed by dropping and restoring a socket.
   */
  resetInput(playerId: string, resetSequence = false): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.queuedInputs = [];
    player.currentInput = this.idleInput(-1);
    player.sprinting = false;
    if (resetSequence) {
      player.lastReceivedSequence = -1;
      player.acknowledgedInputSequence = -1;
    }
  }

  /** Returns the loot restocked from the departing player's hands, if any. */
  removePlayer(playerId: string): LootUpdate | null {
    this.players.delete(playerId);
    this.shoves.removePlayer(playerId);
    return this.loot.removePlayer(playerId);
  }

  synchronizePlayers(room: RoomPublicState): LootUpdate[] {
    const activeIds = new Set(room.players.map((player) => player.id));
    for (const playerId of this.players.keys()) {
      if (!activeIds.has(playerId)) this.players.delete(playerId);
    }
    for (const player of room.players) {
      const simulated = this.players.get(player.id);
      if (!simulated) continue;
      simulated.slot = player.slot;
      simulated.connected = player.isConnected;
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

  /**
   * Shove validation reuses this simulation's authoritative positions and its own
   * derived facing, so a client cannot aim from somewhere it is not or claim to
   * be facing somewhere it is not. A committed shove is applied here, inside the
   * same synchronous call, which is what serializes a mutual exchange.
   */
  resolveShove(playerId: string, request: ShoveRequest, serverNowMs: number): ShoveResolution {
    const resolution = this.shoves.resolve({
      shoverId: playerId,
      participants: [...this.players.values()].map((player) => ({
        id: player.id,
        position: { ...player.position },
        facing: { ...player.facing },
        recoveringUntilMs: player.recoveringUntilMs,
        eligible: player.connected,
      })),
      phase: this.phase,
      phaseEndsAtMs: this.phaseEndsAtMs,
      serverNowMs,
      request,
    });
    const effect = resolution.effect;
    if (effect) {
      const target = this.players.get(effect.targetPlayerId);
      if (target) {
        target.position = effect.position;
        target.recoveringUntilMs = effect.recoveryEndsAtMs;
      }
    }
    return resolution;
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
      // Inputs keep being consumed and acknowledged while recovering, so a shoved
      // client's reconciliation never stalls and no backlog builds up behind it.
      const nextInput = player.queuedInputs.shift();
      if (nextInput) {
        player.currentInput = nextInput;
        player.acknowledgedInputSequence = nextInput.sequence;
      }
      // Once the window closes nobody is sprinting any more, and the snapshot has
      // to say so or every client keeps animating the last pose it was sent.
      if (!movementAllowed) {
        player.sprinting = false;
        continue;
      }

      const recovering = serverNowMs < player.recoveringUntilMs;
      const axis = movementAxis(player.currentInput.movement);
      if (!recovering && (axis.x !== 0 || axis.y !== 0)) player.facing = normalizeMovementVector(axis);

      // A recovering player neither moves nor spends stamina, but does get it back.
      const resolved = resolveSprint(
        player.sprint,
        recovering ? IDLE_MOVEMENT : player.currentInput.movement,
        !recovering && player.currentInput.sprint,
        FIXED_DELTA_SECONDS,
      );
      player.sprint = resolved.state;
      player.sprinting = resolved.sprinting;
      if (recovering) continue;

      player.position = simulatePlayerMovement(
        player.position,
        player.currentInput.movement,
        resolved.sprinting,
        FIXED_DELTA_SECONDS,
      );
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
        sprinting: player.sprinting,
        // Rounded to keep the 20 Hz snapshot compact; the server keeps full precision.
        stamina: Math.round(player.sprint.stamina * 10) / 10,
        exhausted: player.sprint.exhausted,
        recoveringUntilMs: player.recoveringUntilMs > 0 ? player.recoveringUntilMs : null,
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

import {
  GAME,
  CARRYABLE_CATEGORIES,
  NETWORK,
  SURVIVAL,
  gameSnapshotSchema,
  initialSprintState,
  initializeSurvivalState,
  carryableEntry,
  matchTallySchema,
  movementAxis,
  normalizeMovementVector,
  resolveSprint,
  resolveSurvivalDay,
  simulatePlayerMovement,
  type ClientInput,
  type GamePhase,
  type GameSnapshot,
  type InteractionRequest,
  type LootSync,
  type LootUpdate,
  type MatchTally,
  type RoomPublicState,
  type ShoveRequest,
  type SprintState,
  type RandomSource,
  type SurvivalConsumeRequest,
  type SurvivalState,
  type SurvivalReadinessState,
  type Vector2,
} from '@69-seconds/shared';
import { MatchLootAuthority, type InteractionResolution, type LootAuthorityOptions } from './loot-authority.js';
import {
  MatchShoveAuthority,
  type ShoveAuthorityOptions,
  type ShoveResolution,
} from './shove-authority.js';
import {
  SurvivalConsumptionAuthority,
  type SurvivalConsumptionResolution,
} from './survival-consumption.js';
import { SurvivalReadinessAuthority } from './survival-readiness.js';

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
  /** Server receipt time; null is used only by deterministic tests that omit a clock. */
  lastInputReceivedAtMs: number | null;
}

interface MatchParticipant {
  id: string;
  displayName: string;
  slot: number;
}

export interface SimulationTickResult {
  phaseChanged: boolean;
  tallyCommitted: boolean;
  snapshotDue: boolean;
  readinessChanged: boolean;
  /**
   * A survival day resolved and the next one opened, so the committed
   * households changed as well as the readiness that tracks them.
   */
  survivalDayAdvanced: boolean;
}

export interface SurvivalDayOptions {
  /**
   * The source of the overnight death rolls, handed to the shared resolution
   * engine. Defaults to `Math.random`; a test passes a seeded or scripted one
   * so a night's outcome is a fact rather than a coin flip.
   */
  random?: RandomSource;
}

export type EndSurvivalDayResolution =
  | { accepted: true; changed: boolean; state: SurvivalReadinessState }
  | { accepted: false; reason: 'INVALID_PHASE' | 'NOT_ACTIVE_HOUSEHOLD' };

/** Deterministic room simulation. Wall time controls phases; movement always uses one fixed step. */
export class AuthoritativeRoomSimulation {
  readonly roomCode: string;
  private readonly players = new Map<string, SimulatedPlayer>();
  private readonly participants = new Map<string, MatchParticipant>();
  private readonly loot: MatchLootAuthority;
  private readonly shoves: MatchShoveAuthority;
  private phase: GamePhase;
  private phaseEndsAtMs: number | null;
  private lootingStartedAtMs: number | null = null;
  /** Server clock time the survival day opened; null until looting ends. */
  private survivalStartedAtMs: number | null = null;
  /**
   * Which survival day the room is on. Looting happens before Day 1, so the day
   * the buzzer opens is `SURVIVAL.firstDayNumber`.
   *
   * It lives here, beside the phase and the deadline, because advancing the day
   * is a server decision: end-of-day resolution moves this field and the
   * committed state together. No client message reaches it, and no client counts
   * days of its own — every client renders the number the committed state
   * carries.
   */
  private survivalDay: number = SURVIVAL.firstDayNumber;
  /**
   * The last day this room resolved, so resolution is provably once per day.
   * Resetting readiness already makes a second attempt impossible — every
   * household is active again the instant the next day opens — but the ledger
   * says so outright rather than leaving it to be re-derived.
   */
  private lastResolvedSurvivalDay: number | null = null;
  private committedTally: MatchTally | null = null;
  /** One household per player, produced at the buzzer; null until then. */
  private committedSurvivalState: SurvivalState | null = null;
  private readiness: SurvivalReadinessAuthority | null = null;
  /** Owns the committed feeding ledger, which outlives any single day. */
  private readonly consumption = new SurvivalConsumptionAuthority();
  /**
   * The room's source of overnight death rolls. Held here rather than passed
   * per call so one room draws from one stream for the whole match, which is
   * what makes a seeded room reproducible night after night.
   */
  private readonly survivalRandom: RandomSource;
  private snapshotSequence = 0;
  private snapshotAccumulatorSeconds = 0;

  constructor(
    room: RoomPublicState,
    lootOptions: LootAuthorityOptions = {},
    shoveOptions: ShoveAuthorityOptions = {},
    survivalOptions: SurvivalDayOptions = {},
  ) {
    this.survivalRandom = survivalOptions.random ?? Math.random;
    this.roomCode = room.code;
    this.phase = room.phase;
    this.phaseEndsAtMs = room.phaseEndsAtMs;
    for (const player of room.players) {
      this.participants.set(player.id, {
        id: player.id,
        displayName: player.displayName,
        slot: player.slot,
      });
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
        lastInputReceivedAtMs: null,
      });
    }
    this.loot = new MatchLootAuthority(room.code, room.players, lootOptions);
    this.shoves = new MatchShoveAuthority(room.code, shoveOptions);
  }

  submitInput(playerId: string, input: ClientInput, serverNowMs?: number): boolean {
    const player = this.players.get(playerId);
    if (!player || input.sequence <= player.lastReceivedSequence) return false;
    // Countdown input may be staged, but nothing at or beyond the looting deadline
    // is accepted into the queue even if the fixed-step timer has not fired yet.
    // Looting movement is over for good once the day begins, so survival rejects
    // input for the same reason a completed match does.
    if (this.phase === 'SURVIVAL' || this.phase === 'TALLY') return false;
    if (
      serverNowMs !== undefined
      && this.phase === 'LOOTING'
      && this.phaseEndsAtMs !== null
      && serverNowMs >= this.phaseEndsAtMs
    ) return false;
    player.lastReceivedSequence = input.sequence;
    player.lastInputReceivedAtMs = serverNowMs ?? null;
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
    player.lastInputReceivedAtMs = null;
    if (resetSequence) {
      player.lastReceivedSequence = -1;
      player.acknowledgedInputSequence = -1;
    }
  }

  /** Returns the loot restocked from the departing player's hands, if any. */
  removePlayer(playerId: string): LootUpdate | null {
    this.players.delete(playerId);
    this.shoves.removePlayer(playerId);
    this.consumption.forgetPlayer(playerId);
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

  tally(): MatchTally | null {
    return this.committedTally;
  }

  /**
   * The frozen survival state: one household per player, each with its main
   * character, that player's recruits, and that player's deposited items. Null
   * until the buzzer. Read-only — no client event can supply or amend any of it.
   */
  survivalState(): SurvivalState | null {
    return this.committedSurvivalState;
  }

  survivalReadiness(): SurvivalReadinessState | null {
    return this.readiness?.state() ?? null;
  }

  allPlayersEnded(): boolean {
    return this.readiness?.allPlayersEnded() ?? false;
  }

  /** The single gate later feeding/item handlers must pass before mutating a day. */
  canPerformSurvivalDayActions(playerId: string, serverNowMs: number): boolean {
    return this.phase === 'SURVIVAL'
      && (this.readiness?.canPerformDayActions(playerId, serverNowMs) ?? false);
  }

  /**
   * Records one household's End Day. It never resolves the day itself, even when
   * it is the last household to finish: resolution belongs to the tick that
   * follows, so a day is always closed by the server clock rather than inside
   * the request of whichever player happened to press the button last.
   */
  endSurvivalDay(playerId: string, serverNowMs: number): EndSurvivalDayResolution {
    if (this.phase !== 'SURVIVAL' || !this.readiness) {
      return { accepted: false, reason: 'INVALID_PHASE' };
    }
    if (!this.readiness.hasPlayer(playerId)) {
      return { accepted: false, reason: 'NOT_ACTIVE_HOUSEHOLD' };
    }
    const resolution = this.readiness.endManually(playerId, serverNowMs);
    return { accepted: true, ...resolution };
  }

  /**
   * Feeds one character one item out of the requesting household's own
   * inventory, and commits the result.
   *
   * The room supplies only the two things the shared engine cannot know — the
   * live day and whether this household may still act on it — and takes back a
   * whole new committed state. Every other restriction is the engine's, so
   * ownership, edibility, and the personal stat maxima are decided in one place
   * rather than being re-checked here. A rejected request changes nothing.
   */
  resolveSurvivalConsumption(
    playerId: string,
    request: SurvivalConsumeRequest,
    serverNowMs: number,
  ): SurvivalConsumptionResolution {
    const resolution = this.consumption.resolve({
      playerId,
      request,
      // Only an open survival day has a state to feed from; outside it there is
      // nothing to consume rather than something guarded.
      state: this.phase === 'SURVIVAL' ? this.committedSurvivalState : null,
      dayActionStatus: this.readiness?.dayActionStatus(playerId, serverNowMs) ?? 'NOT_A_HOUSEHOLD',
    });
    // The committed day only ever moves forward on a decision that succeeded.
    if (resolution.state) this.committedSurvivalState = resolution.state;
    return resolution;
  }

  /**
   * The authoritative survival day. It reads `SURVIVAL.firstDayNumber` before
   * and during the first day, and only end-of-day resolution ever moves it.
   */
  survivalDayNumber(): number {
    return this.survivalDay;
  }

  /**
   * The currently open survival day's window, which end-of-day resolution
   * replaces with the next day's. Null outside `SURVIVAL`; a client never
   * supplies either value.
   */
  survivalWindow(): { startedAtMs: number; endsAtMs: number } | null {
    if (this.phase !== 'SURVIVAL' || this.survivalStartedAtMs === null || this.phaseEndsAtMs === null) {
      return null;
    }
    return { startedAtMs: this.survivalStartedAtMs, endsAtMs: this.phaseEndsAtMs };
  }

  /**
   * Resolves the open survival day, exactly once, on the first tick that finds
   * every household finished with it — whether they all pressed End Day or the
   * 120-second deadline ended it for the stragglers.
   *
   * Resolution is one atomic step: the day's resource drain, the overnight death
   * rolls it leaves the household facing, the incremented day number, a fresh
   * authoritative window, and readiness reset for everybody all land together,
   * so no client ever observes a day that is over but unresolved. The phase deliberately stays `SURVIVAL` — the next day is the
   * same phase, freshly opened, not a new one.
   *
   * Returns true only when it actually advanced the day.
   */
  private resolveSurvivalDayIfEnded(serverNowMs: number): boolean {
    if (!this.readiness || !this.committedSurvivalState) return false;
    if (!this.readiness.allPlayersEnded()) return false;
    if (this.lastResolvedSurvivalDay === this.survivalDay) return false;
    const startedAtMs = this.committedSurvivalState.startedAtMs;
    const deadlineMs = startedAtMs + GAME.survivalDurationMs;
    // The earlier of now and the deadline, and never before the day opened:
    // ending early opens the next day early, while a late timer callback closes
    // the day it was supposed to close instead of stretching it — the same rule
    // the looting and countdown boundaries follow.
    const resolvedAtMs = Math.min(Math.max(Math.floor(serverNowMs), startedAtMs), deadlineMs);
    this.lastResolvedSurvivalDay = this.survivalDay;
    // Resolved from the committed state rather than rebuilt from the looting
    // result: the new day inherits the characters, inventories, and every stat
    // the households actually reached, with only the daily costs spent.
    this.committedSurvivalState = resolveSurvivalDay({
      state: this.committedSurvivalState,
      resolvedAtMs,
      // Who starved to death last night is decided here, once, by the server —
      // the same call that spends the day's costs, so no client ever sees the
      // drained numbers without the deaths they caused.
      random: this.survivalRandom,
    });
    // The engine owns the increment; the room follows its state rather than
    // counting a day of its own, so the two can never disagree.
    this.survivalDay = this.committedSurvivalState.dayNumber;
    this.survivalStartedAtMs = resolvedAtMs;
    this.phaseEndsAtMs = resolvedAtMs + GAME.survivalDurationMs;
    this.readiness.resetForDay({
      roomCode: this.roomCode,
      dayNumber: this.survivalDay,
      startedAtMs: resolvedAtMs,
      playerIds: this.committedSurvivalState.households.map((household) => household.playerId),
    });
    return true;
  }

  tick(serverNowMs: number): SimulationTickResult {
    let phaseChanged = false;
    let tallyCommitted = false;
    let readinessChanged = false;
    let survivalDayAdvanced = false;
    if (this.phase === 'COUNTDOWN' && this.phaseEndsAtMs !== null && serverNowMs >= this.phaseEndsAtMs) {
      const lootingStartedAtMs = this.phaseEndsAtMs;
      this.phase = 'LOOTING';
      this.lootingStartedAtMs = lootingStartedAtMs;
      this.phaseEndsAtMs = lootingStartedAtMs + GAME.lootingDurationMs;
      phaseChanged = true;
    }

    // This follows the countdown transition deliberately: a delayed timer can
    // catch up through both boundaries in one synchronous tick without opening
    // a late interaction window or emitting an intermediate stale phase.
    if (this.phase === 'LOOTING' && this.phaseEndsAtMs !== null && serverNowMs >= this.phaseEndsAtMs) {
      const lootingEndedAtMs = this.phaseEndsAtMs;
      this.phase = 'SURVIVAL';
      // The looting result is frozen at the buzzer exactly as before, because the
      // survival day is played from it: deposited items, recruited people, and
      // who was in the match all live in that one immutable object.
      this.committedTally = this.createTally(lootingEndedAtMs);
      // Households are derived here, from that frozen result, so the day's
      // starting characters are a server decision made once. A recruit becomes
      // one household member; ordinary loot stays deposited inventory. The day
      // it opens is Day 1 — the grocery run is what happens before Day 1 — and
      // it is passed in rather than assumed, so the end-of-day flow can later
      // open Day 2 through this same call.
      this.committedSurvivalState = initializeSurvivalState({
        result: this.committedTally,
        dayNumber: this.survivalDay,
      });
      this.survivalStartedAtMs = lootingEndedAtMs;
      // Derived from the authoritative looting deadline rather than from
      // `serverNowMs`, so a late timer callback shortens the day instead of
      // extending it — the same rule the looting deadline follows.
      this.phaseEndsAtMs = lootingEndedAtMs + GAME.survivalDurationMs;
      this.readiness = new SurvivalReadinessAuthority({
        roomCode: this.roomCode,
        dayNumber: this.survivalDay,
        startedAtMs: lootingEndedAtMs,
        playerIds: this.committedSurvivalState.households.map((household) => household.playerId),
      });
      phaseChanged = true;
      tallyCommitted = true;
    }

    // Readiness ends at the deadline, and a fully ended day resolves in the same
    // tick that observes it. Both halves run off the server clock, so a day
    // resolves whether the last household pressed End Day or never did, and no
    // client message can bring a day to an end or hold one open.
    if (this.phase === 'SURVIVAL' && this.readiness) {
      readinessChanged = this.readiness.endExpiredPlayers(serverNowMs).changed;
      survivalDayAdvanced = this.resolveSurvivalDayIfEnded(serverNowMs);
      // The day it advanced to carries fresh readiness for every household.
      if (survivalDayAdvanced) readinessChanged = true;
    }

    const movementAllowed = this.phase === 'LOOTING'
      && (this.phaseEndsAtMs === null || serverNowMs < this.phaseEndsAtMs);
    for (const player of this.players.values()) {
      const inputExpired = player.lastInputReceivedAtMs !== null
        && serverNowMs - player.lastInputReceivedAtMs >= NETWORK.inputIdleTimeoutMs;
      if (inputExpired) {
        player.queuedInputs = [];
        player.currentInput = this.idleInput(-1);
        player.sprinting = false;
        player.lastInputReceivedAtMs = null;
      }
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
    // One final snapshot is emitted because `phaseChanged` is true. Afterwards a
    // room past looting is event-driven: nothing moves in survival, so the single
    // phase/deadline pair a client needs for its countdown arrives once instead of
    // being re-sent 20 times a second.
    const snapshotDue = this.phase !== 'SURVIVAL' && this.phase !== 'TALLY'
      && this.snapshotAccumulatorSeconds + Number.EPSILON >= snapshotInterval;
    if (snapshotDue) this.snapshotAccumulatorSeconds -= snapshotInterval;
    return { phaseChanged, tallyCommitted, snapshotDue, readinessChanged, survivalDayAdvanced };
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

  private createTally(lootingEndedAtMs: number): MatchTally {
    if (this.committedTally) return this.committedTally;
    const lootingStartedAtMs = this.lootingStartedAtMs ?? lootingEndedAtMs - GAME.lootingDurationMs;
    const players = [...this.participants.values()]
      .sort((left, right) => left.slot - right.slot)
      .map((participant) => {
        const items = this.loot.depositedItemsForSlot(participant.slot).map((item) => {
          const catalog = carryableEntry(item.catalogId);
          return { id: item.id, catalogId: item.catalogId, label: catalog.label, category: catalog.category };
        });
        return {
          playerId: participant.id,
          displayName: participant.displayName,
          slot: participant.slot,
          isConnectedAtEnd: this.players.get(participant.id)?.connected ?? false,
          items,
          categoryTotals: CARRYABLE_CATEGORIES.map((category) => ({
            category,
            count: items.filter((item) => item.category === category).length,
          })).filter((total) => total.count > 0),
          totalItems: items.length,
        };
      });
    const parsed = matchTallySchema.parse({
      resultId: `${this.roomCode}:${lootingEndedAtMs}`,
      roomCode: this.roomCode,
      lootingStartedAtMs,
      lootingEndedAtMs,
      durationMs: GAME.lootingDurationMs,
      players,
      categoryTotals: CARRYABLE_CATEGORIES.map((category) => ({
        category,
        count: players.reduce(
          (count, player) => count + player.items.filter((item) => item.category === category).length,
          0,
        ),
      })).filter((total) => total.count > 0),
      totalItems: players.reduce((count, player) => count + player.totalItems, 0),
    });
    return deepFreezeTally(parsed);
  }
}

function deepFreezeTally(result: MatchTally): MatchTally {
  for (const player of result.players) {
    for (const item of player.items) Object.freeze(item);
    for (const total of player.categoryTotals) Object.freeze(total);
    Object.freeze(player.items);
    Object.freeze(player.categoryTotals);
    Object.freeze(player);
  }
  for (const total of result.categoryTotals) Object.freeze(total);
  Object.freeze(result.players);
  Object.freeze(result.categoryTotals);
  return Object.freeze(result);
}

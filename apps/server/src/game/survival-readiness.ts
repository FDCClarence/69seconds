import {
  GAME,
  survivalReadinessStateSchema,
  type SurvivalPlayerReadiness,
  type SurvivalReadinessState,
} from '@69-seconds/shared';

export interface OpenSurvivalReadinessDay {
  roomCode: string;
  dayNumber: number;
  startedAtMs: number;
  playerIds: readonly string[];
}

export interface ReadinessMutation {
  changed: boolean;
  state: SurvivalReadinessState;
}

/**
 * Authoritative, deterministic End Day state. It owns no timer: the room's
 * existing server tick supplies time, making timeout independent of clients.
 */
export class SurvivalReadinessAuthority {
  private day!: OpenSurvivalReadinessDay;
  private readonly players = new Map<string, SurvivalPlayerReadiness>();
  private currentState!: SurvivalReadinessState;

  constructor(day: OpenSurvivalReadinessDay) {
    this.resetForDay(day);
  }

  /** Future day advancement can call this after resolution; it advances nothing itself. */
  resetForDay(day: OpenSurvivalReadinessDay): SurvivalReadinessState {
    this.day = {
      ...day,
      playerIds: [...day.playerIds],
    };
    this.players.clear();
    for (const playerId of day.playerIds) {
      this.players.set(playerId, {
        playerId,
        hasEnded: false,
        endedAtMs: null,
        endedBy: null,
      });
    }
    this.currentState = this.buildState();
    return this.currentState;
  }

  hasPlayer(playerId: string): boolean {
    return this.players.has(playerId);
  }

  state(): SurvivalReadinessState {
    return this.currentState;
  }

  allPlayersEnded(): boolean {
    return this.currentState.allPlayersEnded;
  }

  canPerformDayActions(playerId: string, serverNowMs: number): boolean {
    const player = this.players.get(playerId);
    return player?.hasEnded === false && serverNowMs < this.endsAtMs();
  }

  endManually(playerId: string, serverNowMs: number): ReadinessMutation {
    if (!this.players.has(playerId)) return { changed: false, state: this.currentState };
    if (serverNowMs >= this.endsAtMs()) return this.endExpiredPlayers(serverNowMs);
    const player = this.players.get(playerId)!;
    if (player.hasEnded) return { changed: false, state: this.currentState };
    this.players.set(playerId, {
      playerId,
      hasEnded: true,
      endedAtMs: Math.max(this.day.startedAtMs, Math.floor(serverNowMs)),
      endedBy: 'MANUAL',
    });
    this.currentState = this.buildState();
    return { changed: true, state: this.currentState };
  }

  endExpiredPlayers(serverNowMs: number): ReadinessMutation {
    if (serverNowMs < this.endsAtMs() || this.currentState.allPlayersEnded) {
      return { changed: false, state: this.currentState };
    }
    let changed = false;
    for (const [playerId, player] of this.players) {
      if (player.hasEnded) continue;
      changed = true;
      this.players.set(playerId, {
        playerId,
        hasEnded: true,
        endedAtMs: this.endsAtMs(),
        endedBy: 'TIMEOUT',
      });
    }
    if (changed) this.currentState = this.buildState();
    return { changed, state: this.currentState };
  }

  private endsAtMs(): number {
    return this.day.startedAtMs + GAME.survivalDurationMs;
  }

  private buildState(): SurvivalReadinessState {
    const players = this.day.playerIds.map((playerId) => this.players.get(playerId)!);
    const activePlayerCount = players.filter((player) => !player.hasEnded).length;
    const parsed = survivalReadinessStateSchema.parse({
      roomCode: this.day.roomCode,
      dayNumber: this.day.dayNumber,
      startedAtMs: this.day.startedAtMs,
      endsAtMs: this.endsAtMs(),
      durationMs: GAME.survivalDurationMs,
      players,
      activePlayerCount,
      allPlayersEnded: activePlayerCount === 0,
    });
    for (const player of parsed.players) Object.freeze(player);
    Object.freeze(parsed.players);
    return Object.freeze(parsed);
  }
}

import { GAME } from '@69-seconds/shared';
import { describe, expect, it } from 'vitest';
import { SurvivalReadinessAuthority } from './survival-readiness.js';

const STARTED_AT_MS = 10_000;
const DEADLINE_MS = STARTED_AT_MS + GAME.survivalDurationMs;

function authority(playerIds: readonly string[] = ['player-1', 'player-2']) {
  return new SurvivalReadinessAuthority({
    roomCode: 'ABC234',
    dayNumber: 1,
    startedAtMs: STARTED_AT_MS,
    playerIds,
  });
}

describe('SurvivalReadinessAuthority', () => {
  it('manually ends only the authenticated household and locks its future day actions', () => {
    const readiness = authority();
    expect(readiness.canPerformDayActions('player-1', STARTED_AT_MS)).toBe(true);

    const ended = readiness.endManually('player-1', STARTED_AT_MS + 5_000);
    expect(ended.changed).toBe(true);
    expect(ended.state).toMatchObject({ activePlayerCount: 1, allPlayersEnded: false });
    expect(ended.state.players).toEqual([
      { playerId: 'player-1', hasEnded: true, endedAtMs: STARTED_AT_MS + 5_000, endedBy: 'MANUAL' },
      { playerId: 'player-2', hasEnded: false, endedAtMs: null, endedBy: null },
    ]);
    expect(readiness.canPerformDayActions('player-1', STARTED_AT_MS + 5_001)).toBe(false);
    expect(readiness.canPerformDayActions('player-2', STARTED_AT_MS + 5_001)).toBe(true);
  });

  it('makes repeated End Day requests idempotent', () => {
    const readiness = authority();
    const first = readiness.endManually('player-1', STARTED_AT_MS + 1_000);
    const repeated = readiness.endManually('player-1', STARTED_AT_MS + 9_000);
    expect(repeated.changed).toBe(false);
    expect(repeated.state).toBe(first.state);
    expect(repeated.state.players[0]).toMatchObject({
      endedAtMs: STARTED_AT_MS + 1_000,
      endedBy: 'MANUAL',
    });
  });

  it('auto-ends unfinished players at the deadline without double-ending manual players', () => {
    const readiness = authority();
    readiness.endManually('player-1', STARTED_AT_MS + 1_000);

    expect(readiness.endExpiredPlayers(DEADLINE_MS - 1).changed).toBe(false);
    const expired = readiness.endExpiredPlayers(DEADLINE_MS + 5_000);
    expect(expired.changed).toBe(true);
    expect(expired.state.players).toEqual([
      { playerId: 'player-1', hasEnded: true, endedAtMs: STARTED_AT_MS + 1_000, endedBy: 'MANUAL' },
      { playerId: 'player-2', hasEnded: true, endedAtMs: DEADLINE_MS, endedBy: 'TIMEOUT' },
    ]);
    expect(expired.state).toMatchObject({ activePlayerCount: 0, allPlayersEnded: true });
    expect(readiness.endExpiredPlayers(DEADLINE_MS + 10_000)).toEqual({
      changed: false,
      state: expired.state,
    });
  });

  it('reports all players ended immediately when the last player ends before 120 seconds', () => {
    const readiness = authority();
    readiness.endManually('player-1', STARTED_AT_MS + 100);
    const last = readiness.endManually('player-2', STARTED_AT_MS + 200);
    expect(last.changed).toBe(true);
    expect(last.state.allPlayersEnded).toBe(true);
    expect(last.state.activePlayerCount).toBe(0);
    expect(STARTED_AT_MS + 200).toBeLessThan(DEADLINE_MS);
  });

  it('resets readiness cleanly for a future day without advancing it itself', () => {
    const readiness = authority();
    readiness.endManually('player-1', STARTED_AT_MS + 100);
    readiness.endManually('player-2', STARTED_AT_MS + 200);

    const next = readiness.resetForDay({
      roomCode: 'ABC234',
      dayNumber: 2,
      startedAtMs: DEADLINE_MS,
      playerIds: ['player-1', 'player-2'],
    });
    expect(next).toMatchObject({
      dayNumber: 2,
      startedAtMs: DEADLINE_MS,
      endsAtMs: DEADLINE_MS + GAME.survivalDurationMs,
      activePlayerCount: 2,
      allPlayersEnded: false,
    });
    expect(next.players.every((player) => !player.hasEnded)).toBe(true);
  });
});

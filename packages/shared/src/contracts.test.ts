import { describe, expect, it } from 'vitest';
import {
  GAME,
  canCarryItem,
  clientInputSchema,
  loginRequestSchema,
  registerRequestSchema,
  gameSnapshotSchema,
  normalizeMovementVector,
  roomCodeSchema,
  roomCommandResultSchema,
} from './index.js';

describe('shared contracts', () => {
  it('accepts a valid authoritative snapshot', () => {
    const snapshot = gameSnapshotSchema.parse({
      sequence: 1,
      room: {
        code: 'ABC234',
        phase: 'LOBBY',
        hostPlayerId: 'player-1',
        players: [{
          id: 'player-1', displayName: 'Clerk', slot: 0, isHost: true,
          isReady: false, isConnected: true, position: { x: 0, y: 0 },
          connectionState: 'CONNECTED',
          carriedItemIds: [], depositedItemIds: [],
        }],
        serverTimeMs: 1_000,
        phaseEndsAtMs: null,
      },
      loot: [],
    });
    expect(snapshot.room.phase).toBe('LOBBY');
  });

  it('normalizes readable room codes and validates typed command results', () => {
    expect(roomCodeSchema.parse(' ab2cd3 ')).toBe('AB2CD3');
    expect(() => roomCodeSchema.parse('ABC10O')).toThrow();
    const result = roomCommandResultSchema.parse({
      ok: false,
      error: {
        code: 'ROOM_FULL',
        message: 'The room is full',
        event: 'room:join',
        retryable: false,
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects contradictory movement payload shapes', () => {
    expect(() => clientInputSchema.parse({ sequence: 1 })).toThrow();
  });

  it('enforces carry capacity and normalized movement', () => {
    expect(canCarryItem(GAME.maxCarriedItems)).toBe(false);
    expect(normalizeMovementVector({ x: 1, y: 1 }).x).toBeCloseTo(Math.SQRT1_2);
  });

  it('normalizes auth emails and strictly validates auth bodies', () => {
    expect(registerRequestSchema.parse({
      email: ' PLAYER@Example.COM ',
      password: 'a-long-password',
    }).email).toBe('player@example.com');
    expect(() => loginRequestSchema.parse({
      email: 'player@example.com',
      password: 'password',
      unexpected: true,
    })).toThrow();
  });
});

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
      roomCode: 'ABC234',
      phase: 'LOBBY',
      serverTimeMs: 1_000,
      phaseEndsAtMs: null,
      players: [{
        id: 'player-1', position: { x: 900, y: 600 }, sprinting: false,
        acknowledgedInputSequence: 4,
      }],
    });
    expect(snapshot.phase).toBe('LOBBY');
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
    expect(() => clientInputSchema.parse({
      sequence: 1,
      clientTimeMs: 1,
      movement: { up: false, down: false, left: false, right: true },
      sprint: false,
      position: { x: 999_999, y: 999_999 },
    })).toThrow();
  });

  it('enforces carry capacity and normalized movement', () => {
    expect(canCarryItem(GAME.maxCarriedItems)).toBe(false);
    expect(normalizeMovementVector({ x: 1, y: 1 }).x).toBeCloseTo(Math.SQRT1_2);
  });

  it('normalizes auth credentials and strictly validates auth bodies', () => {
    const registration = registerRequestSchema.parse({
      username: '  Cart_Goblin ',
      email: ' PLAYER@Example.COM ',
      password: 'a-long-password',
    });
    expect(registration).toMatchObject({ username: 'cart_goblin', email: 'player@example.com' });
    expect(registerRequestSchema.parse({
      username: 'easy',
      email: 'easy@example.com',
      password: 'password',
    })).toMatchObject({ username: 'easy', password: 'password' });
    expect(() => registerRequestSchema.parse({
      username: 'abc',
      email: 'player@example.com',
      password: 'password',
    })).toThrow();
    expect(() => registerRequestSchema.parse({
      username: 'player',
      email: 'player@example.com',
      password: 'short',
    })).toThrow();
    expect(() => registerRequestSchema.parse({
      username: 'no spaces',
      email: 'player@example.com',
      password: 'a-long-password',
    })).toThrow();
    expect(loginRequestSchema.parse({ identifier: ' Cart_Goblin ', password: 'password' }).identifier).toBe('cart_goblin');
    expect(() => loginRequestSchema.parse({
      identifier: 'player@example.com',
      password: 'password',
      unexpected: true,
    })).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import {
  GAME,
  canCarryItem,
  clientInputSchema,
  loginRequestSchema,
  matchTallySchema,
  registerRequestSchema,
  gameSnapshotSchema,
  interactionRequestSchema,
  interactionResultSchema,
  lootUpdateSchema,
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
        stamina: 100, exhausted: false, recoveringUntilMs: null,
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

  it('rejects an interaction request that claims its own outcome', () => {
    const requestId = '3f1c2c9a-5d2b-4a11-8f6e-9c0d1a2b3c4d';
    expect(interactionRequestSchema.parse({ requestId, action: 'INTERACT' }))
      .toEqual({ requestId, action: 'INTERACT' });
    expect(interactionRequestSchema.parse({ requestId, action: 'PICK_UP', targetId: 'loot-milk' }).targetId)
      .toBe('loot-milk');
    expect(() => interactionRequestSchema.parse({
      requestId,
      action: 'PICK_UP',
      targetId: 'loot-milk',
      outcome: 'PICKED_UP',
    })).toThrow();
    expect(() => interactionRequestSchema.parse({
      requestId,
      action: 'DROP_OFF',
      targetId: 'cart-0',
      carriedItemIds: ['loot-milk', 'loot-bread'],
    })).toThrow();
    expect(() => interactionRequestSchema.parse({ requestId: 'not-a-uuid', action: 'INTERACT' })).toThrow();
  });

  it('acknowledges every interaction with the requester\'s authoritative hands', () => {
    const requestId = '3f1c2c9a-5d2b-4a11-8f6e-9c0d1a2b3c4d';
    const rejected = interactionResultSchema.parse({
      outcome: 'REJECTED',
      requestId,
      reason: 'HANDS_FULL',
      message: 'Hands full',
      carriedItemIds: ['a', 'b', 'c', 'd'],
    });
    expect(rejected.carriedItemIds).toHaveLength(GAME.maxCarriedItems);
    expect(() => interactionResultSchema.parse({
      outcome: 'PICKED_UP',
      requestId,
      itemId: 'loot-milk',
      catalogId: 'bottled-water',
      carriedItemIds: ['a', 'b', 'c', 'd', 'e'],
    })).toThrow();
  });

  it('keeps broadcast loot updates free of private inventory contents', () => {
    const update = lootUpdateSchema.parse({
      type: 'PICKED_UP',
      sequence: 3,
      roomCode: 'ABC234',
      playerId: 'player-1',
      itemId: 'loot-milk',
      carriedCount: 2,
    });
    expect(update).not.toHaveProperty('carriedItemIds');
    expect(() => lootUpdateSchema.parse({
      type: 'PICKED_UP',
      sequence: 3,
      roomCode: 'ABC234',
      playerId: 'player-1',
      itemId: 'loot-milk',
      carriedCount: 2,
      carriedItemIds: ['loot-milk'],
    })).toThrow();
  });

  it('validates a complete server-owned tally and rejects a non-69-second result', () => {
    const tally = matchTallySchema.parse({
      resultId: 'ABC234:70000',
      roomCode: 'ABC234',
      lootingStartedAtMs: 1_000,
      lootingEndedAtMs: 70_000,
      durationMs: GAME.lootingDurationMs,
      totalItems: 1,
      categoryTotals: [{ category: 'food', count: 1 }],
      players: [{
        playerId: 'player-1',
        displayName: 'Player 1',
        slot: 0,
        isConnectedAtEnd: true,
        totalItems: 1,
        categoryTotals: [{ category: 'food', count: 1 }],
        items: [{ id: 'loot-water', catalogId: 'bottled-water', label: 'Bottled Water', category: 'food' }],
      }],
    });
    expect(tally.players[0]?.items[0]?.label).toBe('Bottled Water');
    expect(() => matchTallySchema.parse({ ...tally, durationMs: 68_000 })).toThrow();
    expect(() => matchTallySchema.parse({ ...tally, clientComputedWinner: 'player-1' })).toThrow();
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

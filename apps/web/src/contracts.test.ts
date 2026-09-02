import { GAME, clientInputSchema, type ClientInput } from '@69-seconds/shared';
import { describe, expect, it } from 'vitest';

describe('web workspace shared-contract consumption', () => {
  it('creates and runtime-validates client input', () => {
    const input: ClientInput = {
      sequence: 7,
      clientTimeMs: 690,
      movement: { up: false, down: false, left: true, right: false },
      sprint: true,
    };
    expect(clientInputSchema.parse(input)).toEqual(input);
    expect(GAME.lootingDurationMs).toBe(69_000);
  });
});

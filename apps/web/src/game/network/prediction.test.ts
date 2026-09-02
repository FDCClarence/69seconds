import { GAME, NETWORK, type ClientInput } from '@69-seconds/shared';
import { describe, expect, it } from 'vitest';
import { reconcilePredictedPosition } from './prediction.js';

const inputs: ClientInput[] = [0, 1, 2].map((sequence) => ({
  sequence,
  clientTimeMs: sequence,
  movement: { up: false, down: false, left: false, right: true },
  sprint: false,
}));

describe('local reconciliation', () => {
  it('drops acknowledged inputs and replays only remaining prediction steps', () => {
    const result = reconcilePredictedPosition({ x: 840, y: 550 }, inputs, 1, 'LOOTING');
    expect(result.pendingInputs.map((input) => input.sequence)).toEqual([2]);
    expect(result.position.x).toBeCloseTo(
      840 + GAME.walkSpeedPixelsPerSecond / NETWORK.simulationTickRateHz,
    );
  });
});

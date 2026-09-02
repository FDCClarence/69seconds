import { GAME, NETWORK, SPRINT, type ClientInput } from '@69-seconds/shared';
import { describe, expect, it } from 'vitest';
import { reconcilePredictedState } from './prediction.js';

function inputs(count: number, sprint = false): ClientInput[] {
  return Array.from({ length: count }, (_, sequence) => ({
    sequence,
    clientTimeMs: sequence,
    movement: { up: false, down: false, left: false, right: true },
    sprint,
  }));
}

const FULL = { position: { x: 840, y: 550 }, stamina: SPRINT.staminaCapacity, exhausted: false };
const STEP = 1 / NETWORK.simulationTickRateHz;

describe('local reconciliation', () => {
  it('drops acknowledged inputs and replays only remaining prediction steps', () => {
    const result = reconcilePredictedState(FULL, inputs(3), 1, 'LOOTING', false);
    expect(result.pendingInputs.map((input) => input.sequence)).toEqual([2]);
    expect(result.position.x).toBeCloseTo(840 + GAME.walkSpeedPixelsPerSecond * STEP);
  });

  it('replays the sprint resource alongside the position', () => {
    const result = reconcilePredictedState(FULL, inputs(2, true), -1, 'LOOTING', false);
    expect(result.position.x).toBeCloseTo(840 + GAME.sprintSpeedPixelsPerSecond * STEP * 2);
    expect(result.sprint.stamina).toBeCloseTo(SPRINT.staminaCapacity - SPRINT.drainPerSecond * STEP * 2);
  });

  /** Prediction must agree with the server about denying sprint on an empty bar. */
  it('predicts walking speed once the authoritative bar is latched', () => {
    const spent = { position: { x: 840, y: 550 }, stamina: 0, exhausted: true };
    const result = reconcilePredictedState(spent, inputs(1, true), -1, 'LOOTING', false);
    expect(result.position.x).toBeCloseTo(840 + GAME.walkSpeedPixelsPerSecond * STEP);
    expect(result.sprint.exhausted).toBe(true);
  });

  it('sits out prediction while the server is ignoring this player', () => {
    const result = reconcilePredictedState(FULL, inputs(3, true), -1, 'LOOTING', true);
    expect(result.position).toEqual(FULL.position);
    expect(result.sprint).toEqual({ stamina: SPRINT.staminaCapacity, exhausted: false });
    // The inputs stay pending, so the next free snapshot replays them.
    expect(result.pendingInputs).toHaveLength(3);
  });

  it('predicts nothing outside the looting phase', () => {
    const result = reconcilePredictedState(FULL, inputs(3), -1, 'COUNTDOWN', false);
    expect(result.position).toEqual(FULL.position);
  });
});

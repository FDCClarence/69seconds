import { describe, expect, it } from 'vitest';
import { GAME, movementAxis, movementVelocity, normalizeMovementVector } from './index.js';

describe('movement rules', () => {
  it('turns opposing or idle inputs into a zero vector', () => {
    expect(movementAxis({ up: true, down: true, left: false, right: false })).toEqual({ x: 0, y: 0 });
    expect(movementVelocity({ up: false, down: false, left: false, right: false }, false)).toEqual({ x: 0, y: 0 });
  });

  it('normalizes diagonals without changing their direction', () => {
    const direction = normalizeMovementVector({ x: 1, y: -1 });
    expect(direction.x).toBeCloseTo(Math.SQRT1_2);
    expect(direction.y).toBeCloseTo(-Math.SQRT1_2);
    expect(Math.hypot(direction.x, direction.y)).toBeCloseTo(1);
  });

  it('uses the configured walk speed on cardinal and diagonal input', () => {
    const cardinal = movementVelocity({ up: true, down: false, left: false, right: false }, false);
    const diagonal = movementVelocity({ up: true, down: false, left: false, right: true }, false);
    expect(Math.hypot(cardinal.x, cardinal.y)).toBeCloseTo(GAME.walkSpeedPixelsPerSecond);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(GAME.walkSpeedPixelsPerSecond);
  });

  it('uses the configured sprint speed while preserving normalization', () => {
    const sprint = movementVelocity({ up: false, down: true, left: true, right: false }, true);
    expect(Math.hypot(sprint.x, sprint.y)).toBeCloseTo(GAME.sprintSpeedPixelsPerSecond);
  });
});

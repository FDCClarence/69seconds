import { describe, expect, it } from 'vitest';
import { GAME, NETWORK, SPRINT } from './constants.js';
import { initialSprintState, resolveSprint, type MovementInput, type SprintState } from './rules.js';

const STEP = 1 / NETWORK.simulationTickRateHz;
const RUNNING: MovementInput = { up: false, down: false, left: false, right: true };
const STILL: MovementInput = { up: false, down: false, left: false, right: false };

/** Runs the shared resolver the way both the server tick and client prediction do. */
function run(state: SprintState, ticks: number, input: MovementInput, sprintHeld: boolean) {
  let current = state;
  let sprintingTicks = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    const resolved = resolveSprint(current, input, sprintHeld, STEP);
    current = resolved.state;
    if (resolved.sprinting) sprintingTicks += 1;
  }
  return { state: current, sprintingTicks };
}

/** Sprints from `state` until the bar latches, which is one uninterrupted burst. */
function runUntilExhausted(state: SprintState) {
  let current = state;
  let sprintingTicks = 0;
  while (!current.exhausted && sprintingTicks < NETWORK.simulationTickRateHz * 60) {
    const resolved = resolveSprint(current, RUNNING, true, STEP);
    current = resolved.state;
    if (resolved.sprinting) sprintingTicks += 1;
  }
  return { state: current, sprintingTicks };
}

describe('sprint stamina resource', () => {
  it('starts full and unlatched', () => {
    expect(initialSprintState()).toEqual({ stamina: SPRINT.staminaCapacity, exhausted: false });
  });

  it('spends the bar only while actually sprinting', () => {
    const held = resolveSprint(initialSprintState(), RUNNING, true, STEP);
    expect(held.sprinting).toBe(true);
    expect(held.state.stamina).toBeCloseTo(SPRINT.staminaCapacity - SPRINT.drainPerSecond * STEP);

    // Shift held while standing still is not sprinting, so the bar refills instead.
    const standing = resolveSprint({ stamina: 50, exhausted: false }, STILL, true, STEP);
    expect(standing.sprinting).toBe(false);
    expect(standing.state.stamina).toBeCloseTo(50 + SPRINT.refillPerSecond * STEP);

    const walking = resolveSprint({ stamina: 50, exhausted: false }, RUNNING, false, STEP);
    expect(walking.sprinting).toBe(false);
    expect(walking.state.stamina).toBeCloseTo(50 + SPRINT.refillPerSecond * STEP);
  });

  it('buys the documented sprint duration from a full bar', () => {
    const { sprintingTicks } = runUntilExhausted(initialSprintState());
    expect(sprintingTicks / NETWORK.simulationTickRateHz).toBeCloseTo(
      SPRINT.staminaCapacity / SPRINT.drainPerSecond,
      1,
    );
  });

  /**
   * Holding Shift for a whole match cannot sprint the whole match: the documented
   * budget is roughly 28 of the 69 seconds, which is the balance claim worth
   * guarding against an accidental rate change.
   */
  it('caps total sprint across a full 69 second match', () => {
    const matchTicks = Math.round((GAME.lootingDurationMs / 1_000) * NETWORK.simulationTickRateHz);
    const { sprintingTicks } = run(initialSprintState(), matchTicks, RUNNING, true);
    const sprintSeconds = sprintingTicks / NETWORK.simulationTickRateHz;
    expect(sprintSeconds).toBeGreaterThan(25);
    expect(sprintSeconds).toBeLessThan(32);
  });

  it('refills at half the drain rate, so the duty cycle is one third', () => {
    expect(SPRINT.refillPerSecond * 2).toBe(SPRINT.drainPerSecond);
    const { state } = run({ stamina: 0, exhausted: true }, NETWORK.simulationTickRateHz, RUNNING, true);
    expect(state.stamina).toBeCloseTo(SPRINT.refillPerSecond, 1);
  });

  it('latches exhaustion at zero and denies sprint until the re-engage floor', () => {
    expect(runUntilExhausted(initialSprintState()).state).toEqual({ stamina: 0, exhausted: true });

    // Just under the floor: the bar has stamina but sprint is still locked out.
    const belowFloor = resolveSprint(
      { stamina: SPRINT.reengageThresholdUnits - 1, exhausted: true },
      RUNNING,
      true,
      STEP,
    );
    expect(belowFloor.sprinting).toBe(false);
    expect(belowFloor.state.exhausted).toBe(true);

    const atFloor = resolveSprint(
      { stamina: SPRINT.reengageThresholdUnits, exhausted: true },
      RUNNING,
      true,
      STEP,
    );
    expect(atFloor.state.exhausted).toBe(false);
    // The latch clears on the step that reaches the floor; the next step may sprint.
    expect(resolveSprint(atFloor.state, RUNNING, true, STEP).sprinting).toBe(true);
  });

  it('recovers from empty to the re-engage floor in the documented walk', () => {
    let state: SprintState = { stamina: 0, exhausted: true };
    let ticks = 0;
    while (state.exhausted && ticks < NETWORK.simulationTickRateHz * 30) {
      state = resolveSprint(state, RUNNING, true, STEP).state;
      ticks += 1;
    }
    expect(ticks / NETWORK.simulationTickRateHz).toBeCloseTo(
      SPRINT.reengageThresholdUnits / SPRINT.refillPerSecond,
      1,
    );
  });

  it('never leaves the bar and rejects a non-advancing step', () => {
    const overfilled = run({ stamina: SPRINT.staminaCapacity, exhausted: false }, 60, STILL, false).state;
    expect(overfilled.stamina).toBe(SPRINT.staminaCapacity);

    // The step that runs the bar past empty clamps at zero rather than going negative.
    const drained = run({ stamina: 0.05, exhausted: false }, 1, RUNNING, true).state;
    expect(drained).toEqual({ stamina: 0, exhausted: true });

    const frozen = resolveSprint({ stamina: 40, exhausted: false }, RUNNING, true, 0);
    expect(frozen).toEqual({ state: { stamina: 40, exhausted: false }, sprinting: false });
    expect(resolveSprint({ stamina: 40, exhausted: false }, RUNNING, true, Number.NaN).state.stamina).toBe(40);
  });
});

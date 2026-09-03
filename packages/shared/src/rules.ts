import { canCarrySlots } from './carryable.js';
import { GAME, SHOVE, SPRINT } from './constants.js';
import {
  GROCERY_STORE_BOUNDS,
  GROCERY_STORE_COLLISION,
  SHOVE_OBSTACLES,
  type CollisionRectangle,
} from './map.js';
import type { GamePhase, Vector2 } from './schemas.js';

export function isGameplayActive(phase: GamePhase): boolean {
  return phase === 'LOOTING';
}

/**
 * Room for one more single-slot item. Hands are measured in carry slots rather
 * than items, because a carried person occupies all of them; see
 * {@link canCarrySlots} for the general rule.
 */
export function canCarryItem(usedSlots: number): boolean {
  return canCarrySlots(usedSlots, 1);
}

export function normalizeMovementVector(vector: Vector2): Vector2 {
  const magnitude = Math.hypot(vector.x, vector.y);
  if (magnitude === 0) return { x: 0, y: 0 };
  return { x: vector.x / magnitude, y: vector.y / magnitude };
}

export interface MovementInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export function movementAxis(input: MovementInput): Vector2 {
  return {
    x: Number(input.right) - Number(input.left),
    y: Number(input.down) - Number(input.up),
  };
}

export function movementVelocity(input: MovementInput, sprinting: boolean): Vector2 {
  const direction = normalizeMovementVector(movementAxis(input));
  const speed = sprinting ? GAME.sprintSpeedPixelsPerSecond : GAME.walkSpeedPixelsPerSecond;
  return { x: direction.x * speed, y: direction.y * speed };
}

function circleIntersectsRectangle(position: Vector2, radius: number, rectangle: CollisionRectangle): boolean {
  const nearestX = Math.max(rectangle.x - rectangle.width / 2, Math.min(position.x, rectangle.x + rectangle.width / 2));
  const nearestY = Math.max(rectangle.y - rectangle.height / 2, Math.min(position.y, rectangle.y + rectangle.height / 2));
  return Math.hypot(position.x - nearestX, position.y - nearestY) < radius;
}

export function isValidPlayerPosition(
  position: Vector2,
  collision: readonly CollisionRectangle[] = GROCERY_STORE_COLLISION,
): boolean {
  const radius = GAME.playerCollisionRadiusPixels;
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return false;
  if (position.x < radius || position.x > GROCERY_STORE_BOUNDS.width - radius) return false;
  if (position.y < radius || position.y > GROCERY_STORE_BOUNDS.height - radius) return false;
  return !collision.some((rectangle) => circleIntersectsRectangle(position, radius, rectangle));
}

/** Fixed-step movement. Axis separation permits sliding while never crossing shared collision geometry. */
export function simulatePlayerMovement(
  position: Vector2,
  input: MovementInput,
  sprinting: boolean,
  deltaSeconds: number,
  collision: readonly CollisionRectangle[] = GROCERY_STORE_COLLISION,
): Vector2 {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return { ...position };
  const velocity = movementVelocity(input, sprinting);
  const nextX = { x: position.x + velocity.x * deltaSeconds, y: position.y };
  const afterX = isValidPlayerPosition(nextX, collision) ? nextX : { ...position };
  const nextY = { x: afterX.x, y: afterX.y + velocity.y * deltaSeconds };
  return isValidPlayerPosition(nextY, collision) ? nextY : afterX;
}

export function remainingPhaseMs(serverNowMs: number, phaseEndsAtMs: number | null): number | null {
  if (phaseEndsAtMs === null) return null;
  return Math.max(0, phaseEndsAtMs - serverNowMs);
}

export function distanceBetween(from: Vector2, to: Vector2): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

export function isWithinInteractionRadius(from: Vector2, to: Vector2, radiusPixels: number): boolean {
  if (!Number.isFinite(from.x) || !Number.isFinite(from.y)) return false;
  if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) return false;
  return distanceBetween(from, to) <= radiusPixels;
}

/**
 * Liang-Barsky slab clipping for one rectangle. A segment that merely grazes a
 * shelf edge is treated as clear so a player standing flush against an aisle
 * end can still reach the item beside them.
 */
function segmentCrossesRectangle(from: Vector2, to: Vector2, rectangle: CollisionRectangle): boolean {
  const minimumX = rectangle.x - rectangle.width / 2;
  const maximumX = rectangle.x + rectangle.width / 2;
  const minimumY = rectangle.y - rectangle.height / 2;
  const maximumY = rectangle.y + rectangle.height / 2;
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  let entry = 0;
  let exit = 1;

  for (const [delta, origin, minimum, maximum] of [
    [deltaX, from.x, minimumX, maximumX],
    [deltaY, from.y, minimumY, maximumY],
  ] as const) {
    if (delta === 0) {
      if (origin <= minimum || origin >= maximum) return false;
      continue;
    }
    const first = (minimum - origin) / delta;
    const second = (maximum - origin) / delta;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (entry >= exit) return false;
  }
  return entry < exit;
}

/** Prevents reaching through a shelf to an item or cart on its far side. */
export function hasLineOfAccess(
  from: Vector2,
  to: Vector2,
  collision: readonly CollisionRectangle[] = GROCERY_STORE_COLLISION,
): boolean {
  return !collision.some((rectangle) => segmentCrossesRectangle(from, to, rectangle));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function isMoving(input: MovementInput): boolean {
  const axis = movementAxis(input);
  return axis.x !== 0 || axis.y !== 0;
}

/** Server-owned sprint resource. `exhausted` is a latch, so it cannot be derived from `stamina`. */
export interface SprintState {
  stamina: number;
  exhausted: boolean;
}

export function initialSprintState(): SprintState {
  return { stamina: SPRINT.staminaCapacity, exhausted: false };
}

/**
 * One fixed step of the sprint resource. Sprinting needs a held Shift, an actual
 * movement input, and a bar that is neither empty nor latched; every other case
 * refills. Shared so the client predicts exactly what the server will decide.
 */
export function resolveSprint(
  state: SprintState,
  input: MovementInput,
  sprintHeld: boolean,
  deltaSeconds: number,
): { state: SprintState; sprinting: boolean } {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
    return { state: { ...state }, sprinting: false };
  }
  const usable = !state.exhausted && state.stamina > 0;
  const sprinting = sprintHeld && usable && isMoving(input);
  const ratePerSecond = sprinting ? -SPRINT.drainPerSecond : SPRINT.refillPerSecond;
  const stamina = clamp(state.stamina + ratePerSecond * deltaSeconds, 0, SPRINT.staminaCapacity);
  // Emptying the bar latches exhaustion; only the re-engage floor clears it.
  const exhausted = stamina <= 0 || (state.exhausted && stamina < SPRINT.reengageThresholdUnits);
  return { state: { stamina, exhausted }, sprinting };
}

/** Cosine of the cone's half-angle, precomputed for the dot-product test below. */
const SHOVE_CONE_COSINE = Math.cos((SHOVE.coneHalfAngleDegrees * Math.PI) / 180);

/** True when `to` lies inside the arc `facing` points along. A zero-length facing never matches. */
export function isWithinFacingCone(from: Vector2, facing: Vector2, to: Vector2): boolean {
  const direction = normalizeMovementVector({ x: to.x - from.x, y: to.y - from.y });
  const unitFacing = normalizeMovementVector(facing);
  if (direction.x === 0 && direction.y === 0) return false;
  if (unitFacing.x === 0 && unitFacing.y === 0) return false;
  return direction.x * unitFacing.x + direction.y * unitFacing.y >= SHOVE_CONE_COSINE;
}

/**
 * Steps along `direction` and keeps the last position that is still legal, so a
 * shove can pin a player against a shelf but never push one through it. Returns
 * `from` unchanged when even the first step is blocked.
 */
export function sweepKnockback(
  from: Vector2,
  direction: Vector2,
  distancePixels: number,
  obstacles: readonly CollisionRectangle[] = SHOVE_OBSTACLES,
): Vector2 {
  const unit = normalizeMovementVector(direction);
  if (unit.x === 0 && unit.y === 0) return { ...from };
  if (!Number.isFinite(distancePixels) || distancePixels <= 0) return { ...from };
  // Someone already standing inside a cart gets pushed out rather than pinned there.
  const collision = isValidPlayerPosition(from, obstacles) ? obstacles : GROCERY_STORE_COLLISION;
  const steps = Math.ceil(distancePixels / SHOVE.knockbackStepPixels);
  let landed = { ...from };
  for (let step = 1; step <= steps; step += 1) {
    const travelled = Math.min(step * SHOVE.knockbackStepPixels, distancePixels);
    const candidate = { x: from.x + unit.x * travelled, y: from.y + unit.y * travelled };
    if (!isValidPlayerPosition(candidate, collision)) break;
    landed = candidate;
  }
  return landed;
}

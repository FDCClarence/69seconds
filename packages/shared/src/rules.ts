import { GAME } from './constants.js';
import { GROCERY_STORE_BOUNDS, GROCERY_STORE_COLLISION, type CollisionRectangle } from './map.js';
import type { GamePhase, Vector2 } from './schemas.js';

export function isGameplayActive(phase: GamePhase): boolean {
  return phase === 'LOOTING';
}

export function canCarryItem(currentItemCount: number): boolean {
  return Number.isInteger(currentItemCount) && currentItemCount >= 0 && currentItemCount < GAME.maxCarriedItems;
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

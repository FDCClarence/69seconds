import { GAME } from './constants.js';
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

export function remainingPhaseMs(serverNowMs: number, phaseEndsAtMs: number | null): number | null {
  if (phaseEndsAtMs === null) return null;
  return Math.max(0, phaseEndsAtMs - serverNowMs);
}

import type { Vector2 } from '@69-seconds/shared';

export type FacingDirection =
  | 'north'
  | 'northeast'
  | 'east'
  | 'southeast'
  | 'south'
  | 'southwest'
  | 'west'
  | 'northwest';

export type Locomotion = 'idle' | 'walk' | 'sprint';
export type PlayerAnimationState = `${Locomotion}_${FacingDirection}`;

const DIRECTIONS: FacingDirection[] = [
  'east', 'southeast', 'south', 'southwest',
  'west', 'northwest', 'north', 'northeast',
];

export function facingFromVelocity(velocity: Vector2, fallback: FacingDirection): FacingDirection {
  if (velocity.x === 0 && velocity.y === 0) return fallback;
  const octant = Math.round(Math.atan2(velocity.y, velocity.x) / (Math.PI / 4));
  return DIRECTIONS[(octant + 8) % 8] ?? fallback;
}

export function animationState(
  velocity: Vector2,
  sprinting: boolean,
  previousFacing: FacingDirection,
): PlayerAnimationState {
  const facing = facingFromVelocity(velocity, previousFacing);
  const locomotion: Locomotion = velocity.x === 0 && velocity.y === 0
    ? 'idle'
    : sprinting ? 'sprint' : 'walk';
  return `${locomotion}_${facing}`;
}

export function facingVector(facing: FacingDirection): Vector2 {
  const index = DIRECTIONS.indexOf(facing);
  const angle = index * Math.PI / 4;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

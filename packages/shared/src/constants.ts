export const GAME = {
  maxPlayers: 4,
  maxCarriedItems: 4,
  lootingDurationMs: 69_000,
  countdownDurationMs: 3_000,
  roomCodeLength: 6,
  reconnectGraceMs: 15_000,
  abandonedRoomTtlMs: 30 * 60_000,
  walkSpeedPixelsPerSecond: 150,
  sprintSpeedPixelsPerSecond: 235,
  playerCollisionRadiusPixels: 15,
  mapWidthPixels: 1_800,
  mapHeightPixels: 1_200,
} as const;

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const NETWORK = {
  simulationTickRateHz: 30,
  snapshotRateHz: 20,
  maxInputRateHz: 30,
  interpolationDelayMs: 100,
} as const;

/**
 * Authoritative interaction limits. Radii are validated against server-owned
 * positions, so a client may narrow its prompt but can never widen its reach.
 */
export const LOOT = {
  itemInteractionRadiusPixels: 64,
  cartInteractionRadiusPixels: 92,
  /** Token bucket sized for deliberate Space presses, not for held-key spam. */
  interactionBurstCapacity: 6,
  interactionRefillPerSecond: 6,
  /** Retained per player so a resent request ID replays its original decision. */
  interactionHistorySize: 32,
} as const;

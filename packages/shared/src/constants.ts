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
} as const;

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const NETWORK = {
  snapshotRateHz: 20,
  maxInputRateHz: 30,
} as const;

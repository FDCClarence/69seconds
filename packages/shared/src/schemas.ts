import { z } from 'zod';
import { GAME, SPRINT } from './constants.js';

export const gamePhaseSchema = z.enum(['LOBBY', 'COUNTDOWN', 'LOOTING', 'TALLY']);
export const playerConnectionStateSchema = z.enum(['CONNECTED', 'RECONNECTING']);
export const roomCodeSchema = z.string()
  .trim()
  .toUpperCase()
  .length(GAME.roomCodeLength)
  .regex(/^[A-HJ-KM-NP-Z2-9]+$/);

export const vector2Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const publicPlayerStateSchema = z.object({
  id: z.string().min(1).max(128),
  displayName: z.string().trim().min(1).max(32),
  slot: z.number().int().min(0).max(GAME.maxPlayers - 1),
  isHost: z.boolean(),
  isReady: z.boolean(),
  isConnected: z.boolean(),
  connectionState: playerConnectionStateSchema,
  position: vector2Schema,
});

export const roomPublicStateSchema = z.object({
  code: roomCodeSchema,
  phase: gamePhaseSchema,
  hostPlayerId: z.string().min(1),
  players: z.array(publicPlayerStateSchema).min(1).max(GAME.maxPlayers),
  serverTimeMs: z.number().int().nonnegative(),
  phaseEndsAtMs: z.number().int().nonnegative().nullable(),
});

const itemIdSchema = z.string().min(1).max(64);
const playerIdSchema = z.string().min(1).max(128);
export const cartIdSchema = z.string().regex(new RegExp(`^cart-[0-${GAME.maxPlayers - 1}]$`));

export const lootItemPublicStateSchema = z.strictObject({
  id: itemIdSchema,
  catalogId: z.string().min(1).max(64),
  position: vector2Schema,
  available: z.boolean(),
});

/** Cart contents are public: everyone can see what a physical cart holds. */
export const cartPublicStateSchema = z.strictObject({
  id: cartIdSchema,
  slot: z.number().int().min(0).max(GAME.maxPlayers - 1),
  ownerPlayerId: playerIdSchema.nullable(),
  itemIds: z.array(itemIdSchema),
});

/** Only the count of another player's carried items is public, never its contents. */
export const carriedCountSchema = z.strictObject({
  playerId: playerIdSchema,
  count: z.number().int().min(0).max(GAME.maxCarriedItems),
});

/**
 * Addressed to a single socket, because `carriedItemIds` is that recipient's own
 * private inventory. Sent on match start and after a reconnection.
 */
export const lootSyncSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  roomCode: roomCodeSchema,
  items: z.array(lootItemPublicStateSchema).max(256),
  carts: z.array(cartPublicStateSchema).max(GAME.maxPlayers),
  carriedCounts: z.array(carriedCountSchema).max(GAME.maxPlayers),
  carriedItemIds: z.array(itemIdSchema).max(GAME.maxCarriedItems),
});

/** Compact committed change broadcast to the room; it carries no private inventory. */
export const lootUpdateSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('PICKED_UP'),
    sequence: z.number().int().nonnegative(),
    roomCode: roomCodeSchema,
    playerId: playerIdSchema,
    itemId: itemIdSchema,
    carriedCount: z.number().int().min(0).max(GAME.maxCarriedItems),
  }),
  z.strictObject({
    type: z.literal('DEPOSITED'),
    sequence: z.number().int().nonnegative(),
    roomCode: roomCodeSchema,
    playerId: playerIdSchema,
    cartId: cartIdSchema,
    itemIds: z.array(itemIdSchema).min(1).max(GAME.maxCarriedItems),
    cartItemCount: z.number().int().nonnegative(),
    carriedCount: z.number().int().min(0).max(GAME.maxCarriedItems),
  }),
  z.strictObject({
    type: z.literal('RESTOCKED'),
    sequence: z.number().int().nonnegative(),
    roomCode: roomCodeSchema,
    playerId: playerIdSchema,
    itemIds: z.array(itemIdSchema).min(1).max(GAME.maxCarriedItems),
    carriedCount: z.literal(0),
  }),
]);

export const snapshotPlayerStateSchema = z.strictObject({
  id: z.string().min(1).max(128),
  position: vector2Schema,
  /** The effective sprint the server applied, not the Shift the client asked for. */
  sprinting: z.boolean(),
  stamina: z.number().min(0).max(SPRINT.staminaCapacity),
  /** Latched at an empty bar; sprint stays denied until the re-engage floor. */
  exhausted: z.boolean(),
  /** Server clock time until which this player's own input is ignored; null when free. */
  recoveringUntilMs: z.number().int().nonnegative().nullable(),
  acknowledgedInputSequence: z.number().int().min(-1),
});

export const gameSnapshotSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  roomCode: roomCodeSchema,
  phase: gamePhaseSchema,
  serverTimeMs: z.number().int().nonnegative(),
  phaseEndsAtMs: z.number().int().nonnegative().nullable(),
  players: z.array(snapshotPlayerStateSchema).min(1).max(GAME.maxPlayers),
});

export const clientInputSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  clientTimeMs: z.number().int().nonnegative(),
  movement: z.object({
    up: z.boolean(),
    down: z.boolean(),
    left: z.boolean(),
    right: z.boolean(),
  }),
  sprint: z.boolean(),
});

const requestIdSchema = z.string().uuid();

/**
 * Strict on purpose: a modified client cannot smuggle a claimed outcome, a
 * position, or an inventory alongside its intent. `targetId` is optional so
 * `INTERACT` can ask the server to choose the nearest valid target itself.
 */
export const interactionRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  action: z.enum(['INTERACT', 'PICK_UP', 'DROP_OFF']),
  targetId: z.string().min(1).max(128).optional(),
});

export const interactionRejectionReasonSchema = z.enum([
  'INVALID_PAYLOAD',
  'NOT_IN_MATCH',
  'INVALID_PHASE',
  'NO_NEARBY_TARGET',
  'OUT_OF_RANGE',
  'NO_LINE_OF_ACCESS',
  'UNKNOWN_TARGET',
  'ITEM_UNAVAILABLE',
  'HANDS_FULL',
  'NOT_YOUR_CART',
  'NOTHING_CARRIED',
  'RATE_LIMITED',
]);

/**
 * Every acknowledgement restates the requester's authoritative carried item IDs,
 * so an optimistic client can confirm or roll back from the ack alone.
 */
export const interactionResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('PICKED_UP'),
    requestId: requestIdSchema,
    itemId: itemIdSchema,
    catalogId: z.string().min(1).max(64),
    carriedItemIds: z.array(itemIdSchema).max(GAME.maxCarriedItems),
  }),
  z.strictObject({
    outcome: z.literal('DEPOSITED'),
    requestId: requestIdSchema,
    cartId: cartIdSchema,
    itemIds: z.array(itemIdSchema).min(1).max(GAME.maxCarriedItems),
    cartItemCount: z.number().int().nonnegative(),
    carriedItemIds: z.array(itemIdSchema).max(GAME.maxCarriedItems),
  }),
  z.strictObject({
    outcome: z.literal('REJECTED'),
    requestId: requestIdSchema,
    reason: interactionRejectionReasonSchema,
    message: z.string().min(1),
    carriedItemIds: z.array(itemIdSchema).max(GAME.maxCarriedItems),
  }),
]);

/**
 * Strict, and deliberately carries no direction: the server owns facing, derived
 * from the movement inputs it already validated, so there is no vector to spoof.
 * `targetPlayerId` is only a nomination, and omitting it asks the server to pick
 * the nearest eligible player inside the cone itself.
 */
export const shoveRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  targetPlayerId: playerIdSchema.optional(),
});

export const shoveRejectionReasonSchema = z.enum([
  'INVALID_PAYLOAD',
  'NOT_IN_MATCH',
  'INVALID_PHASE',
  'ON_COOLDOWN',
  'RECOVERING',
  'NO_TARGET_IN_CONE',
  'UNKNOWN_TARGET',
  'SELF_TARGET',
  'TARGET_UNAVAILABLE',
  'OUT_OF_RANGE',
  'OUT_OF_CONE',
  'NO_LINE_OF_ACCESS',
  'RATE_LIMITED',
]);

/**
 * Every acknowledgement restates the cooldown deadline, so the HUD can show the
 * wait without inferring it from a rejection reason.
 */
export const shoveResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('LANDED'),
    requestId: requestIdSchema,
    targetPlayerId: playerIdSchema,
    cooldownEndsAtMs: z.number().int().nonnegative(),
  }),
  z.strictObject({
    outcome: z.literal('REJECTED'),
    requestId: requestIdSchema,
    reason: shoveRejectionReasonSchema,
    message: z.string().min(1),
    cooldownEndsAtMs: z.number().int().nonnegative(),
  }),
]);

/**
 * Broadcast to the room after a committed shove, and the only trigger for shove
 * animation, sound, and HUD feedback. It carries the authoritative post-knockback
 * position so every client agrees on where the target ended up.
 */
export const shoveLandedSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  roomCode: roomCodeSchema,
  shoverPlayerId: playerIdSchema,
  targetPlayerId: playerIdSchema,
  /** Unit vector of the server-owned facing this shove resolved against. */
  direction: vector2Schema,
  targetPosition: vector2Schema,
  /** Actual distance applied, which is shorter than the configured push near geometry. */
  knockbackPixels: z.number().nonnegative(),
  recoveryEndsAtMs: z.number().int().nonnegative(),
});

export const roomCreateRequestSchema = z.strictObject({});
export const roomJoinRequestSchema = z.strictObject({ code: roomCodeSchema });
export const roomLeaveRequestSchema = z.strictObject({});
export const lobbyReadyRequestSchema = z.strictObject({ ready: z.boolean() });
export const lobbyStartRequestSchema = z.strictObject({});

export const serverErrorCodeSchema = z.enum([
  'INVALID_PAYLOAD',
  'UNAUTHENTICATED',
  'EMAIL_ALREADY_REGISTERED',
  'USERNAME_ALREADY_TAKEN',
  'INVALID_CREDENTIALS',
  'FORBIDDEN',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'MATCH_ALREADY_STARTED',
  'ALREADY_IN_ROOM',
  'NOT_IN_ROOM',
  'PLAYERS_NOT_READY',
  'INVALID_PHASE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
]);

export const serverErrorSchema = z.object({
  code: serverErrorCodeSchema,
  message: z.string().min(1),
  event: z.string().min(1).optional(),
  requestId: requestIdSchema.optional(),
  retryable: z.boolean(),
});

export const roomCommandResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), room: roomPublicStateSchema.nullable() }),
  z.object({ ok: z.literal(false), error: serverErrorSchema }),
]);

export const roomClosedSchema = z.object({
  code: roomCodeSchema,
  reason: z.enum(['EMPTY', 'EXPIRED']),
});

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('69-seconds-server'),
});

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const passwordSchema = z.string().min(8).max(128);

// Usernames are lowercased on the way in so uniqueness never depends on the database collation.
export const usernameSchema = z.string().trim().toLowerCase().min(4).max(24).regex(/^[a-z0-9_]+$/);

export const registerRequestSchema = z.strictObject({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
});

// Login accepts either the username or the email address in a single field.
export const loginRequestSchema = z.strictObject({
  identifier: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(128),
});

export const logoutRequestSchema = z.strictObject({});

export const publicUserSchema = z.object({
  id: z.string().uuid(),
  username: usernameSchema,
  email: emailSchema,
  createdAt: z.string().datetime(),
});

export const authResponseSchema = z.object({ user: publicUserSchema });
export const currentUserResponseSchema = z.object({ user: publicUserSchema });
export const logoutResponseSchema = z.object({ success: z.literal(true) });

export const apiErrorResponseSchema = z.object({
  error: serverErrorSchema.omit({ event: true, requestId: true }),
});

export type GamePhase = z.infer<typeof gamePhaseSchema>;
export type PlayerConnectionState = z.infer<typeof playerConnectionStateSchema>;
export type Vector2 = z.infer<typeof vector2Schema>;
export type PublicPlayerState = z.infer<typeof publicPlayerStateSchema>;
export type RoomPublicState = z.infer<typeof roomPublicStateSchema>;
export type LootItemPublicState = z.infer<typeof lootItemPublicStateSchema>;
export type CartPublicState = z.infer<typeof cartPublicStateSchema>;
export type CarriedCount = z.infer<typeof carriedCountSchema>;
export type LootSync = z.infer<typeof lootSyncSchema>;
export type LootUpdate = z.infer<typeof lootUpdateSchema>;
export type SnapshotPlayerState = z.infer<typeof snapshotPlayerStateSchema>;
export type GameSnapshot = z.infer<typeof gameSnapshotSchema>;
export type ClientInput = z.infer<typeof clientInputSchema>;
export type InteractionRequest = z.infer<typeof interactionRequestSchema>;
export type InteractionRejectionReason = z.infer<typeof interactionRejectionReasonSchema>;
export type InteractionResult = z.infer<typeof interactionResultSchema>;
export type ShoveRequest = z.infer<typeof shoveRequestSchema>;
export type ShoveRejectionReason = z.infer<typeof shoveRejectionReasonSchema>;
export type ShoveResult = z.infer<typeof shoveResultSchema>;
export type ShoveLanded = z.infer<typeof shoveLandedSchema>;
export type RoomCreateRequest = z.infer<typeof roomCreateRequestSchema>;
export type RoomJoinRequest = z.infer<typeof roomJoinRequestSchema>;
export type RoomLeaveRequest = z.infer<typeof roomLeaveRequestSchema>;
export type LobbyReadyRequest = z.infer<typeof lobbyReadyRequestSchema>;
export type LobbyStartRequest = z.infer<typeof lobbyStartRequestSchema>;
export type ServerErrorCode = z.infer<typeof serverErrorCodeSchema>;
export type ServerError = z.infer<typeof serverErrorSchema>;
export type RoomCommandResult = z.infer<typeof roomCommandResultSchema>;
export type RoomClosed = z.infer<typeof roomClosedSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

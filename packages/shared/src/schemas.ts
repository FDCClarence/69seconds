import { z } from 'zod';
import { GAME } from './constants.js';

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
  carriedItemIds: z.array(z.string().min(1)).max(GAME.maxCarriedItems),
  depositedItemIds: z.array(z.string().min(1)),
});

export const roomPublicStateSchema = z.object({
  code: roomCodeSchema,
  phase: gamePhaseSchema,
  hostPlayerId: z.string().min(1),
  players: z.array(publicPlayerStateSchema).min(1).max(GAME.maxPlayers),
  serverTimeMs: z.number().int().nonnegative(),
  phaseEndsAtMs: z.number().int().nonnegative().nullable(),
});

export const lootPublicStateSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1).max(64),
  position: vector2Schema,
  available: z.boolean(),
});

export const gameSnapshotSchema = z.object({
  sequence: z.number().int().nonnegative(),
  room: roomPublicStateSchema,
  loot: z.array(lootPublicStateSchema),
});

export const clientInputSchema = z.object({
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

export const interactionRequestSchema = z.object({
  requestId: requestIdSchema,
  targetId: z.string().min(1).max(128),
  action: z.enum(['INTERACT', 'PICK_UP', 'DROP_OFF']),
});

export const shoveRequestSchema = z.object({
  requestId: requestIdSchema,
  targetPlayerId: z.string().min(1).max(128).optional(),
  direction: vector2Schema,
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

export const passwordSchema = z.string().min(12).max(128);

export const registerRequestSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
});

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const logoutRequestSchema = z.strictObject({});

export const publicUserSchema = z.object({
  id: z.string().uuid(),
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
export type LootPublicState = z.infer<typeof lootPublicStateSchema>;
export type GameSnapshot = z.infer<typeof gameSnapshotSchema>;
export type ClientInput = z.infer<typeof clientInputSchema>;
export type InteractionRequest = z.infer<typeof interactionRequestSchema>;
export type ShoveRequest = z.infer<typeof shoveRequestSchema>;
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

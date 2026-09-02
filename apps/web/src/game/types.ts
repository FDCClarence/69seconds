/** Real gameplay actions a key press can request. */
export type GameAction = 'INTERACT' | 'SHOVE';

export interface CarryHudItem {
  id: string;
  label: string;
  shortLabel: string;
  color: string;
  /** True while this slot is an unacknowledged prediction. */
  pending: boolean;
}

export interface CarryHudState {
  carriedItems: readonly CarryHudItem[];
  depositedCount: number;
  synchronized: boolean;
}

/** Locally predicted sprint and shove readiness, corrected by every snapshot. */
export interface SprintHudState {
  /** Remaining stamina as a fraction of the full bar, 0 to 1. */
  fraction: number;
  sprinting: boolean;
  /** Latched at an empty bar; sprint stays denied until the re-engage floor. */
  exhausted: boolean;
  /** 0 while ready to shove, rising to 1 immediately after a landed shove. */
  shoveCooldownFraction: number;
  /** True while a shove has this player's own input frozen. */
  recovering: boolean;
}

/** Server-decided outcomes plus the purely local presentation notices. */
export type GameFeedbackKind =
  | 'PICKED_UP'
  | 'DEPOSITED'
  | InteractionRejectionReason
  | ShoveRejectionReason
  | 'SHOVE_LANDED'
  | 'SHOVE_TAKEN'
  | 'DESYNCHRONIZED';

export interface GameFeedback {
  kind: GameFeedbackKind;
  message: string;
}

export interface GroceryGameCallbacks {
  onFeedback?: (feedback: GameFeedback) => void;
  onInventoryChange?: (inventory: CarryHudState) => void;
  onSprintChange?: (sprint: SprintHudState) => void;
  onReady?: () => void;
  /** Stable room slot; the server derives assigned cart ownership from the same slot. */
  assignedCartSlot?: number;
  localPlayerId?: string;
  initialPhase?: GamePhase;
  roomCode?: string;
  initialPlayers?: readonly PublicPlayerState[];
  sendInput?: (movement: MovementInput, sprint: boolean) => ClientInput | null;
  subscribeSnapshots?: (listener: (snapshot: GameSnapshot) => void) => () => void;
  /** Requests an interaction and resolves with the server's authoritative decision. */
  requestInteraction?: (request: InteractionRequest) => Promise<InteractionResult>;
  /** Requests a shove and resolves with the server's authoritative decision. */
  requestShove?: (request: ShoveRequest) => Promise<ShoveResult>;
  subscribeLootSync?: (listener: (sync: LootSync) => void) => () => void;
  subscribeLootUpdates?: (listener: (update: LootUpdate) => void) => () => void;
  subscribeShoveLanded?: (listener: (event: ShoveLanded) => void) => () => void;
  onPhaseChange?: (phase: GamePhase) => void;
}

export interface DestroyableGame {
  destroy(removeCanvas: boolean): void;
}

export type GroceryGameFactory = (
  parent: HTMLElement,
  callbacks: GroceryGameCallbacks,
) => DestroyableGame;
import type {
  ClientInput,
  GamePhase,
  GameSnapshot,
  InteractionRejectionReason,
  InteractionRequest,
  InteractionResult,
  LootSync,
  LootUpdate,
  MovementInput,
  PublicPlayerState,
  ShoveLanded,
  ShoveRejectionReason,
  ShoveRequest,
  ShoveResult,
} from '@69-seconds/shared';

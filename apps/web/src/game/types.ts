export type DebugAction = 'SHOVE';

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

/** Server-decided outcomes plus the two purely local presentation notices. */
export type GameFeedbackKind =
  | 'PICKED_UP'
  | 'DEPOSITED'
  | InteractionRejectionReason
  | 'DESYNCHRONIZED'
  | 'SHOVE_DEBUG';

export interface GameFeedback {
  kind: GameFeedbackKind;
  message: string;
}

export interface GroceryGameCallbacks {
  onAction?: (action: DebugAction) => void;
  onFeedback?: (feedback: GameFeedback) => void;
  onInventoryChange?: (inventory: CarryHudState) => void;
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
  subscribeLootSync?: (listener: (sync: LootSync) => void) => () => void;
  subscribeLootUpdates?: (listener: (update: LootUpdate) => void) => () => void;
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
} from '@69-seconds/shared';

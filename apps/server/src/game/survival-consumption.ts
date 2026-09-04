import {
  SURVIVAL,
  consumeSurvivalItem,
  survivalConsumeResultSchema,
  type SurvivalConsumeRejectionReason,
  type SurvivalConsumeRequest,
  type SurvivalConsumeResult,
  type SurvivalState,
} from '@69-seconds/shared';

/** Why a household may act on the open day, as the End Day ledger sees it. */
export type SurvivalDayActionStatus = 'OPEN' | 'ALREADY_ENDED' | 'DAY_CLOSED' | 'NOT_A_HOUSEHOLD';

export const SURVIVAL_CONSUME_REJECTION_MESSAGES: Record<SurvivalConsumeRejectionReason, string> = {
  INVALID_PAYLOAD: 'That feeding request was malformed',
  NOT_IN_MATCH: 'You are not part of an active match',
  INVALID_PHASE: 'Feeding is closed outside an open survival day',
  DAY_ALREADY_ENDED: 'You have ended your day · feeding reopens tomorrow',
  NO_HOUSEHOLD: 'You do not own a household in this survival day',
  UNKNOWN_ITEM: 'That item is not in your inventory',
  NOT_CONSUMABLE: 'That is not food or water',
  UNKNOWN_CHARACTER: 'That person is not in your household',
  CHARACTER_DEAD: 'They are dead · the living eat first',
  RATE_LIMITED: 'Slow down · too many requests at once',
};

export interface SurvivalConsumptionContext {
  /** From the authenticated socket, never from the request body. */
  playerId: string;
  request: SurvivalConsumeRequest;
  /** The committed day, or null when this room has not opened one. */
  state: SurvivalState | null;
  /** The room's own answer to whether this household may act right now. */
  dayActionStatus: SurvivalDayActionStatus;
}

export interface SurvivalConsumptionResolution {
  result: SurvivalConsumeResult;
  /**
   * The next committed day, present only when this call actually changed one.
   * A rejection and a replay both leave it null, which is what makes "nothing
   * was consumed" and "nothing must be broadcast" the same condition.
   */
  state: SurvivalState | null;
  /** True when a duplicate request ID replayed an earlier committed decision. */
  replayed: boolean;
}

/**
 * Authoritative owner of survival feeding.
 *
 * The decision itself is the shared engine's — this class exists for the two
 * things a pure function cannot do: consult the room's live gates (is the day
 * open, has this household ended it) and remember which request IDs have
 * already been committed, so a resent request replays its original decision
 * rather than spending a second item.
 *
 * Every resolution runs to completion synchronously on the Node event loop, so
 * two racing feeds of one item are serialized and only the first can find it.
 */
export class SurvivalConsumptionAuthority {
  /** Committed decisions only, per player, keyed by request ID. */
  private readonly committed = new Map<string, Map<string, SurvivalConsumeResult>>();

  resolve(context: SurvivalConsumptionContext): SurvivalConsumptionResolution {
    const { playerId, request } = context;
    // Checked before every gate, so a duplicate delivery arriving after End Day
    // still reports what it originally did instead of being judged twice.
    const replayed = this.committed.get(playerId)?.get(request.requestId);
    if (replayed) return { result: replayed, state: null, replayed: true };

    if (!context.state) return this.reject(request, 'INVALID_PHASE');
    const gate = GATE_REJECTIONS[context.dayActionStatus];
    if (gate) return this.reject(request, gate);

    const outcome = consumeSurvivalItem({
      state: context.state,
      playerId,
      itemId: request.itemId,
      characterId: request.characterId,
    });
    // Nothing is spent and nothing is remembered on a rejection, so a legitimate
    // retry is judged on fresh state rather than replaying a refusal.
    if (!outcome.ok) return this.reject(request, outcome.reason);

    const result = survivalConsumeResultSchema.parse({
      outcome: 'CONSUMED',
      requestId: request.requestId,
      itemId: outcome.item.id,
      catalogId: outcome.item.catalogId,
      character: outcome.character,
      inventory: [...outcome.inventory],
    });
    this.rememberCommitted(playerId, result);
    return { result, state: outcome.state, replayed: false };
  }

  /** A departed household's ledger is dropped with them; nothing replays for a stranger. */
  forgetPlayer(playerId: string): void {
    this.committed.delete(playerId);
  }

  private rememberCommitted(playerId: string, result: SurvivalConsumeResult): void {
    const ledger = this.committed.get(playerId) ?? new Map<string, SurvivalConsumeResult>();
    ledger.set(result.requestId, result);
    while (ledger.size > SURVIVAL.consumptionHistorySize) {
      const oldest = ledger.keys().next();
      if (oldest.done) break;
      ledger.delete(oldest.value);
    }
    this.committed.set(playerId, ledger);
  }

  private reject(
    request: SurvivalConsumeRequest,
    reason: SurvivalConsumeRejectionReason,
  ): SurvivalConsumptionResolution {
    return {
      result: survivalConsumeResultSchema.parse({
        outcome: 'REJECTED',
        requestId: request.requestId,
        reason,
        message: SURVIVAL_CONSUME_REJECTION_MESSAGES[reason],
      }),
      state: null,
      replayed: false,
    };
  }
}

/** The one place a readiness status becomes a feeding rejection. `OPEN` is none. */
const GATE_REJECTIONS: Record<SurvivalDayActionStatus, SurvivalConsumeRejectionReason | null> = {
  OPEN: null,
  ALREADY_ENDED: 'DAY_ALREADY_ENDED',
  DAY_CLOSED: 'INVALID_PHASE',
  NOT_A_HOUSEHOLD: 'NO_HOUSEHOLD',
};

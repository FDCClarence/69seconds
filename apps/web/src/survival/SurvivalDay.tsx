import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SURVIVAL_STAT_KEYS,
  findSurvivalConsumable,
  isSurvivalConsumable,
  type PublicUser,
  type RoomPublicState,
  type SurvivalCharacter,
  type SurvivalInventoryItem,
  type SurvivalReadinessState,
  type SurvivalRestoreAmount,
  type SurvivalState,
  type SurvivalStatKey,
} from '@69-seconds/shared';
import { CarryableArtById } from '../carryable-art.js';
import { newRequestId } from '../request-id.js';
import { DayTransition } from './DayTransition.js';
import { RoomClientError, type RoomClient, type SocketConnectionState } from '../room-client.js';

/**
 * The two stats a day spends and a meal restores. They are shown as bars, with
 * the character's own daily cost beside them, because they are the only numbers
 * a player acts on today.
 */
const DAY_STAT_KEYS = ['nutrition', 'hydration'] as const satisfies readonly SurvivalStatKey[];

/** Everything else, shown compactly: nothing in the day moves these yet. */
const STANDING_STAT_KEYS = SURVIVAL_STAT_KEYS
  .filter((key) => key !== 'nutrition' && key !== 'hydration');

const STAT_LABELS: Record<SurvivalStatKey, string> = {
  health: 'Health',
  survival: 'Survival',
  morale: 'Morale',
  strength: 'Strength',
  nutrition: 'Nutrition',
  hydration: 'Hydration',
};

/** How often the day clock is re-rendered. The deadline itself is server-owned. */
const CLOCK_INTERVAL_MS = 250;

export interface SurvivalDayProps {
  room: RoomPublicState;
  /** The committed households. Null until the server's first `survival:state`. */
  state: SurvivalState | null;
  /** The day's mutable End Day state, which also carries its authoritative window. */
  readiness: SurvivalReadinessState | null;
  user: PublicUser;
  connection: SocketConnectionState;
  roomClient: RoomClient;
  onLeave: () => Promise<void>;
}

/**
 * The playable survival day.
 *
 * Every number on this screen is the server's: the day, the deadline, each
 * character's stats and daily costs, the household inventories, and who has
 * ended their day. The screen sends exactly two intents — feed this item to
 * this character, and end my day — and then renders whatever the server
 * broadcasts back. It computes no restoration, ends no day on its own, and
 * never advances the clock past the deadline the server published.
 */
export function SurvivalDay({
  room,
  state,
  readiness,
  user,
  connection,
  roomClient,
  onLeave,
}: SurvivalDayProps) {
  const household = state?.households.find((entry) => entry.playerId === user.id) ?? null;
  const others = state?.households.filter((entry) => entry.playerId !== user.id) ?? [];
  const remainingMs = useDayCountdown(readiness?.endsAtMs ?? null, room.serverTimeMs);
  const selfReadiness = readiness?.players.find((player) => player.playerId === user.id) ?? null;
  const endedCount = readiness ? readiness.players.length - readiness.activePlayerCount : 0;

  // Cleared whenever the day rolls over, so yesterday's outcome never reads as
  // something that just happened.
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  useEffect(() => {
    setFeedback(null);
    setBusy(false);
  }, [state?.dayNumber]);

  const livingCharacters = household?.characters.filter((character) => character.isAlive) ?? [];
  // Falls back to the first living character rather than holding a selection the
  // day no longer has: a recruit can die, and the day can roll over.
  const selected = livingCharacters.find((character) => character.id === selectedCharacterId)
    ?? livingCharacters[0]
    ?? null;

  const connected = connection === 'CONNECTED';
  const dayOpen = remainingMs === null || remainingMs > 0;
  const hasEnded = selfReadiness?.hasEnded ?? false;
  const canAct = connected && dayOpen && !hasEnded && !busy;

  async function feed(item: SurvivalInventoryItem) {
    if (!selected || !roomClient.consumeItem) return;
    setBusy(true);
    try {
      const result = await roomClient.consumeItem({
        requestId: newRequestId(),
        itemId: item.id,
        characterId: selected.id,
      });
      // The committed values arrive as a broadcast `survival:state`; only the
      // sentence describing what happened comes from the acknowledgement.
      setFeedback(result.outcome === 'CONSUMED'
        ? `Fed ${item.label} to ${selected.displayName}.`
        : result.message);
    } catch (cause) {
      setFeedback(survivalErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function endDay() {
    if (!roomClient.endDay) return;
    setBusy(true);
    try {
      await roomClient.endDay();
      setFeedback('Day ended. Waiting for the other households.');
    } catch (cause) {
      setFeedback(survivalErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return <main className="page survival-page">
    <div className="survival-shell">
      <header className="survival-header">
        <div>
          <p className="eyebrow">Room {room.code} · survival</p>
          <h1>Survival phase</h1>
          <p className="survival-subtitle">
            {state
              ? `Day ${state.dayNumber}. Feed your household, then end the day.`
              : 'The server has not published this day yet.'}
          </p>
        </div>
        <div className="survival-clock">
          {/* A timer announces nothing on its own; the readiness line below is
              what a screen reader is told about. */}
          <strong role="timer">{formatRemaining(remainingMs)}</strong>
          <span>{dayOpen ? 'left today' : 'resolving'}</span>
        </div>
      </header>

      {readiness && <p className="survival-readiness" aria-live="polite">
        {endedCount} of {readiness.players.length} household{readiness.players.length === 1 ? '' : 's'} ended
        {hasEnded ? ' · you have ended your day' : ''}
      </p>}

      {!household ? <div className="panel survival-loading">
        {/* Two different absences: the day has not arrived yet, or it arrived
            without a household for this player. */}
        <p>{state
          ? 'You do not own a household in this survival day.'
          : 'Waiting for the server’s households…'}</p>
      </div> : <>
        <section className="survival-house" aria-label="Your household">
          <header>
            <h2>Your household</h2>
            <p className="label">{household.characters.length} in the house</p>
          </header>
          <fieldset className="survival-characters" disabled={!canAct || !roomClient.consumeItem}>
            <legend className="sr-only">Choose who to feed</legend>
            {household.characters.map((character) => <CharacterCard
              key={character.id}
              character={character}
              selected={selected?.id === character.id}
              onSelect={() => setSelectedCharacterId(character.id)}
            />)}
          </fieldset>
        </section>

        <section className="survival-inventory" aria-label="Household inventory">
          <header>
            <h2>Supplies</h2>
            <p className="label">{household.inventory.length} item{household.inventory.length === 1 ? '' : 's'}</p>
          </header>
          {household.inventory.length === 0
            ? <p className="survival-empty">Nothing was banked before the buzzer.</p>
            : <ul>
              {groupInventory(household.inventory).map((group) => <li
                key={group.catalogId}
                className={group.edible ? undefined : 'is-inedible'}
              >
                <CarryableArtById catalogId={group.catalogId} label={group.label} className="survival-art" />
                <div>
                  <span>{group.label}</span>
                  <small>{group.edible ? describeEffect(group.catalogId) : 'Not edible'}</small>
                </div>
                {group.quantity > 1 && <strong className="survival-quantity">{group.quantity}x</strong>}
                {group.edible && <button
                  className="button survival-feed"
                  type="button"
                  disabled={!canAct || !selected || !roomClient.consumeItem}
                  aria-label={selected ? `Feed ${group.label} to ${selected.displayName}` : `Feed ${group.label}`}
                  onClick={() => void feed(group.item)}
                >
                  Feed
                </button>}
              </li>)}
            </ul>}
        </section>

        {others.length > 0 && <section className="survival-others" aria-label="Other households">
          <h2>Other households</h2>
          <ul>
            {others.map((other) => <li key={other.playerId}>
              <header>
                <span>Cart {other.slot + 1}</span>
                <h3>{other.displayName}</h3>
                <p className="label">
                  {readiness?.players.find((player) => player.playerId === other.playerId)?.hasEnded
                    ? 'Day ended'
                    : 'Still deciding'}
                </p>
              </header>
              <ul className="survival-other-characters">
                {other.characters.map((character) => <li key={character.id}>
                  <span>{character.displayName}</span>
                  <small>
                    {character.isAlive
                      ? `${describeStat(character, 'nutrition')} · ${describeStat(character, 'hydration')}`
                      : 'Dead'}
                  </small>
                </li>)}
              </ul>
              <p className="label">{other.inventory.length} item{other.inventory.length === 1 ? '' : 's'} left</p>
            </li>)}
          </ul>
        </section>}
      </>}

      {feedback && <p className="notice survival-feedback" aria-live="polite">{feedback}</p>}

      <footer className="survival-footer">
        <button
          className="button primary survival-end-day"
          type="button"
          disabled={!connected || !dayOpen || hasEnded || busy || !roomClient.endDay}
          onClick={() => void endDay()}
        >
          {hasEnded ? 'Day ended' : 'End day'}
        </button>
        <p className="settings-note">
          The day ends on the server’s clock whether or not everyone presses this.
        </p>
        <button className="link" type="button" disabled={busy} onClick={() => void onLeave()}>Leave room</button>
      </footer>
    </div>
    {/*
      Presentational only, exactly as before: the day's server-owned deadline is
      already running behind it and it tells the server nothing when it finishes.
    */}
    {state && <DayTransition dayNumber={state.dayNumber} stateId={state.stateId} />}
  </main>;
}

/**
 * The server's own sentence, preferred over a client-side translation: a refused
 * feed or End Day already comes back explaining itself ("you do not own an
 * active household in this survival day"), and restating it in the room-code
 * vocabulary would only make it vaguer.
 */
function survivalErrorMessage(error: unknown): string {
  if (error instanceof RoomClientError) return error.message;
  return 'The room connection dropped. Please try again.';
}

function CharacterCard({ character, selected, onSelect }: {
  character: SurvivalCharacter;
  selected: boolean;
  onSelect: () => void;
}) {
  return <label className={`survival-character${selected ? ' is-selected' : ''}${character.isAlive ? '' : ' is-dead'}`}>
    <input
      type="radio"
      name="survival-character"
      // Named for the person rather than for the whole card: the label's text
      // is a stat block, which would make a useless accessible name.
      aria-label={character.displayName}
      checked={selected}
      disabled={!character.isAlive}
      onChange={onSelect}
    />
    {character.catalogId
      ? <CarryableArtById catalogId={character.catalogId} label={character.displayName} className="survival-portrait" />
      : <b className="survival-portrait is-main">{character.displayName.slice(0, 1).toUpperCase()}</b>}
    <div className="survival-character-body">
      <header>
        <strong>{character.displayName}</strong>
        <span>{character.kind === 'MAIN' ? 'You' : 'Recruit'}{character.isAlive ? '' : ' · dead'}</span>
      </header>
      <div className="survival-bars">
        {DAY_STAT_KEYS.map((key) => <div key={key}>
          <span className="label">{STAT_LABELS[key]}</span>
          <div
            className={`survival-bar is-${key}`}
            role="meter"
            aria-label={`${character.displayName} ${STAT_LABELS[key]}`}
            aria-valuenow={character.stats[key].current}
            aria-valuemin={0}
            aria-valuemax={character.stats[key].max}
          >
            <i style={{ width: `${percentOf(character.stats[key])}%` }} />
          </div>
          <small>{describeStat(character, key)} · −{dailyCost(character, key)}/day</small>
        </div>)}
      </div>
      <p className="survival-standing">
        {STANDING_STAT_KEYS.map((key) => `${STAT_LABELS[key]} ${Math.round(character.stats[key].current)}`).join(' · ')}
      </p>
    </div>
  </label>;
}

/**
 * The remaining milliseconds of the server's day, or null when no deadline has
 * been published yet.
 *
 * The deadline is on the server's clock, so it is read against an estimate of
 * that clock rather than against `Date.now()` directly: the room's own
 * `serverTimeMs` anchors the estimate every time the server sends fresh state.
 * The result is clamped at zero — this hook never carries a day past its
 * deadline, and never ends one either.
 */
function useDayCountdown(endsAtMs: number | null, serverTimeMs: number): number | null {
  const clock = useRef({ serverTimeMs, receivedAtMs: Date.now() });
  useEffect(() => {
    clock.current = { serverTimeMs, receivedAtMs: Date.now() };
  }, [serverTimeMs]);

  const remaining = useCallback(() => {
    if (endsAtMs === null) return null;
    const estimatedServerNowMs = clock.current.serverTimeMs + (Date.now() - clock.current.receivedAtMs);
    return Math.max(0, endsAtMs - estimatedServerNowMs);
  }, [endsAtMs]);

  const [remainingMs, setRemainingMs] = useState<number | null>(remaining);
  useEffect(() => {
    setRemainingMs(remaining());
    if (endsAtMs === null) return undefined;
    const timer = window.setInterval(() => setRemainingMs(remaining()), CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [endsAtMs, remaining]);
  return remainingMs;
}

function formatRemaining(remainingMs: number | null): string {
  if (remainingMs === null) return '--:--';
  const totalSeconds = Math.ceil(remainingMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function percentOf(stat: { current: number; max: number }): number {
  if (stat.max <= 0) return 0;
  return Math.max(0, Math.min(100, (stat.current / stat.max) * 100));
}

function describeStat(character: SurvivalCharacter, key: SurvivalStatKey): string {
  const stat = character.stats[key];
  return `${Math.round(stat.current)}/${Math.round(stat.max)}`;
}

function dailyCost(character: SurvivalCharacter, key: (typeof DAY_STAT_KEYS)[number]): number {
  return key === 'nutrition' ? character.dailyNutritionCost : character.dailyHydrationCost;
}

/**
 * What one unit of an item restores, read from the shared consumable table so
 * the sentence and the server's decision come from the same data. `'MAX'` is
 * described rather than turned into a number, because two characters do not
 * share a maximum.
 */
function describeEffect(catalogId: string): string {
  const effect = findSurvivalConsumable(catalogId);
  if (!effect) return 'Not edible';
  const parts: string[] = [];
  for (const [key, amount] of Object.entries(effect) as [SurvivalStatKey, SurvivalRestoreAmount][]) {
    parts.push(amount === 'MAX' ? `Fills ${STAT_LABELS[key]}` : `+${amount} ${STAT_LABELS[key]}`);
  }
  return parts.join(' · ');
}

interface InventoryGroup {
  catalogId: string;
  label: string;
  quantity: number;
  edible: boolean;
  /** The instance a Feed press spends: items are individuals, not a count. */
  item: SurvivalInventoryItem;
}

/**
 * Groups a household's inventory for display while keeping one real instance
 * per group, because feeding spends a specific item id rather than a quantity.
 */
function groupInventory(inventory: readonly SurvivalInventoryItem[]): InventoryGroup[] {
  const groups = new Map<string, InventoryGroup>();
  for (const item of inventory) {
    const existing = groups.get(item.catalogId);
    if (existing) existing.quantity += 1;
    else {
      groups.set(item.catalogId, {
        catalogId: item.catalogId,
        label: item.label,
        quantity: 1,
        edible: isSurvivalConsumable(item.catalogId),
        item,
      });
    }
  }
  // Edible first: they are the only ones with an action on them today.
  return [...groups.values()].sort((left, right) => Number(right.edible) - Number(left.edible));
}

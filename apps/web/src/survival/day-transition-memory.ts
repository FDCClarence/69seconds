/**
 * A client-only note of the day transition this browser has already played, so a
 * remount — a re-render, a route change, or a reconnecting refresh — does not
 * replay an animation the player has already watched.
 *
 * This is presentation memory and nothing more. It is **not** game state: the
 * authoritative day lives on the server's survival state, nothing here is ever
 * sent anywhere, and losing it costs at most one extra fade. It deliberately
 * holds a single entry, keyed by the survival state it belongs to, so a new
 * match's Day 1 is a genuinely new day rather than one already seen.
 */

export interface DayTransitionRecord {
  /** The survival state's own id, so the note cannot outlive its match. */
  stateId: string;
  dayNumber: number;
  /**
   * When the transition started, on the client's own clock. A remount mid-fade
   * finishes the remaining time instead of starting over.
   */
  startedAtMs: number;
}

const STORAGE_KEY = '69s.survival-day-transition';

/**
 * The in-memory copy is authoritative for this page. `sessionStorage` only
 * carries the note across a reload, and every access is guarded because a
 * privacy mode can make it throw rather than merely return nothing.
 */
let cached: DayTransitionRecord | null = null;

function isRecord(value: unknown): value is DayTransitionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DayTransitionRecord>;
  return typeof candidate.stateId === 'string'
    && Number.isInteger(candidate.dayNumber)
    && Number.isFinite(candidate.startedAtMs);
}

/** The transition this browser last started, or null if it has played none. */
export function readDayTransition(): DayTransitionRecord | null {
  if (cached) return cached;
  try {
    const raw = window.sessionStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    cached = parsed;
    return parsed;
  } catch {
    return null;
  }
}

/** Records that this day's transition has started, replacing any earlier note. */
export function rememberDayTransition(record: DayTransitionRecord): void {
  cached = record;
  try {
    window.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // A full or blocked store only costs a replayed fade, so it is not an error.
  }
}

/**
 * Drops the note. The app needs no call: a note is scoped to one survival state,
 * so the next match's state replaces it. Tests, and a future explicit "leave
 * survival" path, use it.
 */
export function forgetDayTransitions(): void {
  cached = null;
  try {
    window.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to recover from: the in-memory copy is already cleared.
  }
}

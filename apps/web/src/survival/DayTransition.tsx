import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from '../prefers-reduced-motion.js';
import { readDayTransition, rememberDayTransition } from './day-transition-memory.js';

/**
 * How long the overlay stays up in total, fades included.
 *
 * Presentational only. The survival day's 120-second deadline is server-owned
 * and already running while this plays: the overlay never pauses it, never
 * delays the day, and never reports its own completion to anybody.
 */
export const DAY_TRANSITION_TOTAL_MS = 2_000;

export interface DayTransitionProps {
  /**
   * The day to announce, taken from the server's survival state. The component
   * renders whatever number it is given and derives none of its own — there is
   * no fallback to Day 1.
   */
  dayNumber: number;
  /**
   * The survival state's id. It scopes the "already seen" note to one match, so
   * remounting during the same day stays quiet while a new match's Day 1 still
   * gets its transition.
   */
  stateId: string;
}

/**
 * Fades to black, announces `Day #X`, then fades away to reveal the survival
 * screen underneath.
 *
 * It plays when this client genuinely observes a new day: entering survival, or
 * a day number that has changed. A remount during the same day finishes only
 * the time left rather than starting the fade over, and a remount after the
 * transition has finished shows nothing at all.
 */
export function DayTransition({ dayNumber, stateId }: DayTransitionProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [visibleDay, setVisibleDay] = useState<number | null>(null);

  useEffect(() => {
    const nowMs = Date.now();
    const seen = readDayTransition();
    const startedAtMs = seen?.stateId === stateId && seen.dayNumber === dayNumber
      ? seen.startedAtMs
      : null;
    if (startedAtMs === null) rememberDayTransition({ stateId, dayNumber, startedAtMs: nowMs });
    // A remount mid-fade resumes; a remount after the fade finished shows
    // nothing. Measuring elapsed time rather than counting mounts is what keeps
    // a reconnect from replaying a transition the player already watched.
    const elapsedMs = startedAtMs === null ? 0 : Math.max(0, nowMs - startedAtMs);
    if (elapsedMs >= DAY_TRANSITION_TOTAL_MS) {
      setVisibleDay(null);
      return undefined;
    }
    setVisibleDay(dayNumber);
    const timer = window.setTimeout(() => setVisibleDay(null), DAY_TRANSITION_TOTAL_MS - elapsedMs);
    return () => window.clearTimeout(timer);
  }, [dayNumber, stateId]);

  if (visibleDay === null) return null;
  return <div
    className={`day-transition${reducedMotion ? ' is-static' : ''}`}
    // Announced rather than alerted: it is an orientation cue, not a warning.
    role="status"
    data-day={visibleDay}
  >
    <strong className="day-transition-label">Day #{visibleDay}</strong>
  </div>;
}

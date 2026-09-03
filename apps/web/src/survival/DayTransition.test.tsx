import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DayTransition, DAY_TRANSITION_TOTAL_MS } from './DayTransition.js';
import { forgetDayTransitions, readDayTransition } from './day-transition-memory.js';

const STATE_ID = 'survival:ABC234:71000';

/** Reduced-motion answers false unless a test says otherwise. */
function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

function overlay(): HTMLElement | null {
  return document.querySelector('.day-transition');
}

beforeEach(() => {
  vi.useFakeTimers();
  stubReducedMotion(false);
  forgetDayTransitions();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  forgetDayTransitions();
});

describe('DayTransition', () => {
  it('announces the day it is given, and hardcodes no day of its own', () => {
    render(<DayTransition dayNumber={3} stateId={STATE_ID} />);
    expect(screen.getByRole('status').textContent).toBe('Day #3');
    expect(screen.queryByText('Day #1')).toBeNull();
    expect(overlay()?.dataset.day).toBe('3');
  });

  it('renders every day number the server could send, Day 1 included', () => {
    for (const dayNumber of [1, 2, 12]) {
      forgetDayTransitions();
      const view = render(<DayTransition dayNumber={dayNumber} stateId={`${STATE_ID}:${dayNumber}`} />);
      expect(screen.getByRole('status').textContent).toBe(`Day #${dayNumber}`);
      view.unmount();
    }
  });

  it('shows the overlay for about two seconds, then reveals the screen underneath', () => {
    render(<DayTransition dayNumber={1} stateId={STATE_ID} />);
    expect(overlay()).not.toBeNull();

    act(() => { vi.advanceTimersByTime(DAY_TRANSITION_TOTAL_MS - 1); });
    expect(overlay()).not.toBeNull();

    act(() => { vi.advanceTimersByTime(1); });
    expect(overlay()).toBeNull();
    expect(DAY_TRANSITION_TOTAL_MS).toBe(2_000);
  });

  it('plays again when the observed day number changes', () => {
    const view = render(<DayTransition dayNumber={1} stateId={STATE_ID} />);
    act(() => { vi.advanceTimersByTime(DAY_TRANSITION_TOTAL_MS); });
    expect(overlay()).toBeNull();

    view.rerender(<DayTransition dayNumber={2} stateId={STATE_ID} />);
    expect(screen.getByRole('status').textContent).toBe('Day #2');
    act(() => { vi.advanceTimersByTime(DAY_TRANSITION_TOTAL_MS); });
    expect(overlay()).toBeNull();
  });

  it('does not replay a finished day when the component remounts', () => {
    const first = render(<DayTransition dayNumber={1} stateId={STATE_ID} />);
    act(() => { vi.advanceTimersByTime(DAY_TRANSITION_TOTAL_MS); });
    first.unmount();

    // The same day, freshly mounted: a reconnect or a re-render must not make
    // the player watch the fade a second time.
    render(<DayTransition dayNumber={1} stateId={STATE_ID} />);
    expect(overlay()).toBeNull();
  });

  it('finishes only the time left when a remount interrupts the fade', () => {
    const first = render(<DayTransition dayNumber={1} stateId={STATE_ID} />);
    act(() => { vi.advanceTimersByTime(1_500); });
    first.unmount();

    render(<DayTransition dayNumber={1} stateId={STATE_ID} />);
    expect(overlay()).not.toBeNull();
    // 500 ms left of the original two seconds, not a fresh two seconds.
    act(() => { vi.advanceTimersByTime(500); });
    expect(overlay()).toBeNull();
  });

  it('treats a new match as a new day, even though it is Day 1 again', () => {
    const first = render(<DayTransition dayNumber={1} stateId={STATE_ID} />);
    act(() => { vi.advanceTimersByTime(DAY_TRANSITION_TOTAL_MS); });
    first.unmount();

    render(<DayTransition dayNumber={1} stateId="survival:ABC234:999000" />);
    expect(screen.getByRole('status').textContent).toBe('Day #1');
  });

  it('keeps the remembered day as a client-only note, never as game state', () => {
    render(<DayTransition dayNumber={5} stateId={STATE_ID} />);
    expect(readDayTransition()).toMatchObject({ stateId: STATE_ID, dayNumber: 5 });
    // It is presentation memory: dropping it costs one extra fade and nothing else.
    forgetDayTransitions();
    expect(readDayTransition()).toBeNull();
  });

  it('survives a browser that refuses session storage', () => {
    const failing = () => { throw new Error('storage blocked'); };
    vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(failing);
    vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(failing);

    render(<DayTransition dayNumber={2} stateId={STATE_ID} />);
    expect(screen.getByRole('status').textContent).toBe('Day #2');
    act(() => { vi.advanceTimersByTime(DAY_TRANSITION_TOTAL_MS); });
    expect(overlay()).toBeNull();
    vi.restoreAllMocks();
  });

  it('keeps the overlay and its text for reduced motion, dropping only the fade', () => {
    stubReducedMotion(true);
    render(<DayTransition dayNumber={4} stateId={STATE_ID} />);
    const element = overlay();
    expect(element?.classList.contains('is-static')).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Day #4');

    // Still a timed overlay, so a reduced-motion player sees the day and then
    // the screen underneath, without any animation.
    act(() => { vi.advanceTimersByTime(DAY_TRANSITION_TOTAL_MS); });
    expect(overlay()).toBeNull();
  });
});

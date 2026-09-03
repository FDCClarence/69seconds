import { useEffect, useState } from 'react';

/**
 * Tracks the operating system's reduced-motion preference, and keeps tracking it
 * while mounted so a change mid-session takes effect without a reload.
 *
 * Presentation reads this to drop an animation, never to change what is shown:
 * a reduced-motion player sees the same information, just without the movement.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return undefined;
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

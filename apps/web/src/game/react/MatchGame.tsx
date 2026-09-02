import { GAME, type GamePhase } from '@69-seconds/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DebugAction, GroceryGameFactory } from '../types.js';
import { mountGroceryGame } from './game-lifecycle.js';

export function MatchGame({
  phase,
  roomCode,
  onLeave,
  gameFactory,
}: {
  phase: GamePhase;
  roomCode: string;
  onLeave: () => Promise<void>;
  gameFactory: GroceryGameFactory | undefined;
}) {
  const gameHost = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [action, setAction] = useState<DebugAction | null>(null);
  const actionTimer = useRef<number | undefined>(undefined);

  const showAction = useCallback((nextAction: DebugAction) => {
    setAction(nextAction);
    window.clearTimeout(actionTimer.current);
    actionTimer.current = window.setTimeout(() => setAction(null), 700);
  }, []);

  useEffect(() => {
    const parent = gameHost.current;
    if (!parent) return undefined;
    setReady(false);
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const factory = gameFactory ?? (await import('../create-grocery-game.js')).createGroceryGame;
      if (cancelled) return;
      cleanup = mountGroceryGame(parent, factory, {
        onAction: showAction,
        onReady: () => setReady(true),
      });
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(actionTimer.current);
      cleanup?.();
    };
  }, [gameFactory, showAction]);

  return <main className="game-route">
    <div
      className="phaser-focus-frame"
      ref={gameHost}
      tabIndex={0}
      role="application"
      aria-label="69 Seconds grocery store prototype. Click or focus to control the player."
      onPointerDown={(event) => event.currentTarget.focus()}
      onBlur={() => gameHost.current?.dispatchEvent(new Event('game-input-blur'))}
    />
    <section className="game-hud" aria-label="Gameplay controls and carry slots">
      <div className="game-hud-topline">
        <div><span className="hud-label">Room</span><strong>{roomCode}</strong></div>
        <div className={`hud-status ${ready ? 'is-ready' : ''}`}><i />{ready ? 'Local prototype' : 'Loading scene'}</div>
        <div><span className="hud-label">Server phase</span><strong>{phase}</strong></div>
      </div>
      <div className="game-controls" aria-label="Controls">
        <span><kbd>WASD</kbd> move</span><span><kbd>Shift</kbd> sprint</span>
        <span><kbd>Space</kbd> interact</span><span><kbd>Ctrl</kbd> shove</span>
      </div>
      <div className="carry-hud"><span className="hud-label">Carry</span><ol aria-label={`${GAME.maxCarriedItems} empty carry slots`}>
        {Array.from({ length: GAME.maxCarriedItems }, (_, index) => <li key={index} aria-label={`Empty carry slot ${index + 1}`}><span>{index + 1}</span></li>)}
      </ol></div>
      <button type="button" className="hud-leave" onClick={() => void onLeave()}>Leave test</button>
    </section>
    <div className={`game-action-indicator ${action ? 'is-visible' : ''}`} role="status" aria-live="polite">
      {action === 'INTERACT' ? 'INTERACT HOOK' : action === 'SHOVE' ? 'SHOVE HOOK' : ''}
    </div>
    <p className="focus-hint">Click the store to capture controls · focus is released when you tab away</p>
  </main>;
}

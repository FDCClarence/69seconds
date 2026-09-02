import { GAME, type GamePhase } from '@69-seconds/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CarryHudState, GameFeedback, GroceryGameFactory } from '../types.js';
import { mountGroceryGame } from './game-lifecycle.js';

export function MatchGame({
  phase,
  roomCode,
  assignedCartSlot,
  onLeave,
  gameFactory,
}: {
  phase: GamePhase;
  roomCode: string;
  assignedCartSlot: number;
  onLeave: () => Promise<void>;
  gameFactory: GroceryGameFactory | undefined;
}) {
  const gameHost = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [feedback, setFeedback] = useState<GameFeedback | null>(null);
  const [inventory, setInventory] = useState<CarryHudState>({ carriedItems: [], depositedCount: 0 });
  const actionTimer = useRef<number | undefined>(undefined);

  const showFeedback = useCallback((nextFeedback: GameFeedback) => {
    setFeedback(nextFeedback);
    window.clearTimeout(actionTimer.current);
    actionTimer.current = window.setTimeout(() => setFeedback(null), 1_200);
  }, []);
  const showAction = useCallback(() => {
    showFeedback({ kind: 'SHOVE_DEBUG', message: 'SHOVE DEBUG HOOK' });
  }, [showFeedback]);

  useEffect(() => {
    const parent = gameHost.current;
    if (!parent) return undefined;
    setReady(false);
    setInventory({ carriedItems: [], depositedCount: 0 });
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const factory = gameFactory ?? (await import('../create-grocery-game.js')).createGroceryGame;
      if (cancelled) return;
      cleanup = mountGroceryGame(parent, factory, {
        onAction: showAction,
        onFeedback: showFeedback,
        onInventoryChange: setInventory,
        onReady: () => setReady(true),
        assignedCartSlot,
      });
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(actionTimer.current);
      cleanup?.();
    };
  }, [assignedCartSlot, gameFactory, showAction, showFeedback]);

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
        <span><kbd>Space</kbd> interact</span><span><kbd>R</kbd> reset</span><span><kbd>Ctrl</kbd> shove</span>
      </div>
      <div className="carry-hud"><span className="hud-label">Carry</span><ol aria-label={`${inventory.carriedItems.length} of ${GAME.maxCarriedItems} carry slots filled`}>
        {Array.from({ length: GAME.maxCarriedItems }, (_, index) => {
          const item = inventory.carriedItems[index];
          return <li key={index} className={item ? 'is-filled' : undefined} aria-label={item ? `${item.label} in carry slot ${index + 1}` : `Empty carry slot ${index + 1}`}>
            <span>{index + 1}</span>{item && <b style={{ backgroundColor: item.color }} title={item.label}>{item.shortLabel}</b>}
          </li>;
        })}
      </ol><span className="deposit-count" aria-label={`${inventory.depositedCount} items deposited`}>Cart {inventory.depositedCount}</span></div>
      <button type="button" className="hud-leave" onClick={() => void onLeave()}>Leave test</button>
    </section>
    <div className={`game-action-indicator ${feedback ? 'is-visible' : ''}`} role="status" aria-live="polite">
      {feedback?.message ?? ''}
    </div>
    <p className="focus-hint">Click the store to capture controls · focus is released when you tab away</p>
  </main>;
}

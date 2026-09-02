import { GAME, type RoomPublicState } from '@69-seconds/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CarryHudState, GameFeedback, GroceryGameFactory } from '../types.js';
import { mountGroceryGame } from './game-lifecycle.js';
import type { RoomClient } from '../../room-client.js';

export function MatchGame({
  room,
  localPlayerId,
  roomClient,
  onLeave,
  gameFactory,
}: {
  room: RoomPublicState;
  localPlayerId: string;
  roomClient: RoomClient;
  onLeave: () => Promise<void>;
  gameFactory: GroceryGameFactory | undefined;
}) {
  const gameHost = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [feedback, setFeedback] = useState<GameFeedback | null>(null);
  const [inventory, setInventory] = useState<CarryHudState>({ carriedItems: [], depositedCount: 0, synchronized: false });
  const [displayPhase, setDisplayPhase] = useState(room.phase);
  const [countdown, setCountdown] = useState<number | null>(null);
  const initialRoom = useRef(room);
  const actionTimer = useRef<number | undefined>(undefined);

  const showFeedback = useCallback((nextFeedback: GameFeedback) => {
    setFeedback(nextFeedback);
    window.clearTimeout(actionTimer.current);
    actionTimer.current = window.setTimeout(() => setFeedback(null), 1_200);
  }, []);
  const showAction = useCallback(() => {
    showFeedback({ kind: 'SHOVE_DEBUG', message: 'SHOVE DEBUG HOOK' });
  }, [showFeedback]);

  useEffect(() => setDisplayPhase(room.phase), [room.phase]);
  useEffect(() => {
    if (displayPhase !== 'COUNTDOWN' || room.phaseEndsAtMs === null) {
      setCountdown(null);
      return undefined;
    }
    const serverOffsetMs = room.serverTimeMs - Date.now();
    const refresh = () => setCountdown(Math.max(0, Math.ceil((room.phaseEndsAtMs! - (Date.now() + serverOffsetMs)) / 1_000)));
    refresh();
    const timer = window.setInterval(refresh, 100);
    return () => window.clearInterval(timer);
  }, [displayPhase, room.phaseEndsAtMs, room.serverTimeMs]);

  useEffect(() => {
    const parent = gameHost.current;
    if (!parent) return undefined;
    setReady(false);
    setInventory({ carriedItems: [], depositedCount: 0, synchronized: false });
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
        assignedCartSlot: initialRoom.current.players.find((player) => player.id === localPlayerId)?.slot ?? 0,
        localPlayerId,
        roomCode: initialRoom.current.code,
        initialPhase: initialRoom.current.phase,
        initialPlayers: initialRoom.current.players,
        sendInput: (movement, sprint) => roomClient.sendInput?.(movement, sprint) ?? null,
        subscribeSnapshots: (listener) => roomClient.subscribeSnapshots?.(listener) ?? (() => undefined),
        requestInteraction: (request) => roomClient.requestInteraction
          ? roomClient.requestInteraction(request)
          : Promise.reject(new Error('This room client cannot request interactions')),
        subscribeLootSync: (listener) => roomClient.subscribeLootSync?.(listener) ?? (() => undefined),
        subscribeLootUpdates: (listener) => roomClient.subscribeLootUpdates?.(listener) ?? (() => undefined),
        onPhaseChange: setDisplayPhase,
      });
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(actionTimer.current);
      cleanup?.();
    };
  }, [gameFactory, localPlayerId, roomClient, showAction, showFeedback]);

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
        <div><span className="hud-label">Room</span><strong>{room.code}</strong></div>
        <div className={`hud-status ${ready && inventory.synchronized ? 'is-ready' : ''}`}><i />{!ready ? 'Loading scene' : inventory.synchronized ? 'Loot synchronized' : 'Awaiting loot state'}</div>
        <div><span className="hud-label">Server phase</span><strong>{displayPhase}</strong></div>
      </div>
      <div className="game-controls" aria-label="Controls">
        <span><kbd>WASD</kbd> move</span><span><kbd>Shift</kbd> sprint</span>
        <span><kbd>Space</kbd> interact</span><span><kbd>Ctrl</kbd> shove</span>
      </div>
      <div className="carry-hud"><span className="hud-label">Carry</span><ol aria-label={`${inventory.carriedItems.length} of ${GAME.maxCarriedItems} carry slots filled`}>
        {Array.from({ length: GAME.maxCarriedItems }, (_, index) => {
          const item = inventory.carriedItems[index];
          const className = item ? `is-filled${item.pending ? ' is-pending' : ''}` : undefined;
          return <li key={index} className={className} aria-label={item ? `${item.label} in carry slot ${index + 1}${item.pending ? ', awaiting confirmation' : ''}` : `Empty carry slot ${index + 1}`}>
            <span>{index + 1}</span>{item && <b style={{ backgroundColor: item.color }} title={item.label}>{item.shortLabel}</b>}
          </li>;
        })}
      </ol><span className="deposit-count" aria-label={`${inventory.depositedCount} items deposited`}>Cart {inventory.depositedCount}</span></div>
      <button type="button" className="hud-leave" onClick={() => void onLeave()}>Leave test</button>
    </section>
    {displayPhase === 'COUNTDOWN' && <div className="countdown-overlay" role="timer" aria-label="Match countdown">
      <span>Get ready</span><strong>{countdown ?? '…'}</strong>
    </div>}
    <div className={`game-action-indicator ${feedback ? 'is-visible' : ''}`} role="status" aria-live="polite">
      {feedback?.message ?? ''}
    </div>
    <p className="focus-hint">Click the store to capture controls · focus is released when you tab away</p>
  </main>;
}

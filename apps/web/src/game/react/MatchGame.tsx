import { GAME, type RoomPublicState } from '@69-seconds/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CarryHudState, GameFeedback, GroceryGameFactory, SprintHudState } from '../types.js';
import { mountGroceryGame } from './game-lifecycle.js';
import type { RoomClient } from '../../room-client.js';

const READY_SPRINT: SprintHudState = {
  fraction: 1,
  sprinting: false,
  exhausted: false,
  shoveCooldownFraction: 0,
  recovering: false,
};

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
  const [sprint, setSprint] = useState<SprintHudState>(READY_SPRINT);
  const [displayPhase, setDisplayPhase] = useState(room.phase);
  const [phaseEndsAtMs, setPhaseEndsAtMs] = useState(room.phaseEndsAtMs);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const serverClock = useRef({ serverTimeMs: room.serverTimeMs, receivedAtMs: Date.now() });
  const initialRoom = useRef(room);
  const actionTimer = useRef<number | undefined>(undefined);

  const showFeedback = useCallback((nextFeedback: GameFeedback) => {
    setFeedback(nextFeedback);
    window.clearTimeout(actionTimer.current);
    actionTimer.current = window.setTimeout(() => setFeedback(null), 1_200);
  }, []);
  useEffect(() => {
    setDisplayPhase(room.phase);
    setPhaseEndsAtMs(room.phaseEndsAtMs);
    serverClock.current = { serverTimeMs: room.serverTimeMs, receivedAtMs: Date.now() };
  }, [room.phase, room.phaseEndsAtMs, room.serverTimeMs]);
  useEffect(() => roomClient.subscribeSnapshots?.((snapshot) => {
    serverClock.current = { serverTimeMs: snapshot.serverTimeMs, receivedAtMs: Date.now() };
    setDisplayPhase((current) => current === snapshot.phase ? current : snapshot.phase);
    setPhaseEndsAtMs((current) => current === snapshot.phaseEndsAtMs ? current : snapshot.phaseEndsAtMs);
  }), [roomClient]);
  useEffect(() => {
    if ((displayPhase !== 'COUNTDOWN' && displayPhase !== 'LOOTING') || phaseEndsAtMs === null) {
      setRemainingSeconds(null);
      return undefined;
    }
    const refresh = () => {
      const estimatedServerNowMs = serverClock.current.serverTimeMs + (Date.now() - serverClock.current.receivedAtMs);
      setRemainingSeconds(Math.max(0, Math.ceil((phaseEndsAtMs - estimatedServerNowMs) / 1_000)));
    };
    refresh();
    const timer = window.setInterval(refresh, 100);
    return () => window.clearInterval(timer);
  }, [displayPhase, phaseEndsAtMs]);

  useEffect(() => {
    const parent = gameHost.current;
    if (!parent) return undefined;
    setReady(false);
    setInventory({ carriedItems: [], depositedCount: 0, synchronized: false });
    setSprint(READY_SPRINT);
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const factory = gameFactory ?? (await import('../create-grocery-game.js')).createGroceryGame;
      if (cancelled) return;
      cleanup = mountGroceryGame(parent, factory, {
        onFeedback: showFeedback,
        onInventoryChange: setInventory,
        onSprintChange: setSprint,
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
        requestShove: (request) => roomClient.requestShove
          ? roomClient.requestShove(request)
          : Promise.reject(new Error('This room client cannot request shoves')),
        subscribeLootSync: (listener) => roomClient.subscribeLootSync?.(listener) ?? (() => undefined),
        subscribeLootUpdates: (listener) => roomClient.subscribeLootUpdates?.(listener) ?? (() => undefined),
        subscribeShoveLanded: (listener) => roomClient.subscribeShoveLanded?.(listener) ?? (() => undefined),
        onPhaseChange: setDisplayPhase,
      });
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(actionTimer.current);
      cleanup?.();
    };
  }, [gameFactory, localPlayerId, roomClient, showFeedback]);

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
        <div><span className="hud-label">Server phase</span><strong>{displayPhase}{displayPhase === 'LOOTING' && remainingSeconds !== null ? ` · ${formatMatchTime(remainingSeconds)}` : ''}</strong></div>
      </div>
      <div className="game-controls" aria-label="Controls">
        <span><kbd>WASD</kbd> move</span><span><kbd>Shift</kbd> sprint</span>
        <span><kbd>Space</kbd> interact</span><span><kbd>Ctrl</kbd> shove</span>
      </div>
      <div className="meter-hud">
        <div className="meter-row">
          <span className="hud-label">Sprint</span>
          <div
            className={`meter sprint-meter${sprint.exhausted ? ' is-exhausted' : ''}${sprint.sprinting ? ' is-draining' : ''}`}
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(sprint.fraction * 100)}
            aria-label={`Sprint stamina ${Math.round(sprint.fraction * 100)} percent${sprint.exhausted ? ', spent — walk to recover' : ''}${sprint.recovering ? ', recovering from a shove' : ''}`}
          ><i style={{ width: `${sprint.fraction * 100}%` }} /></div>
        </div>
        <div className="meter-row">
          <span className="hud-label">Shove</span>
          <div
            className={`meter shove-meter${sprint.shoveCooldownFraction > 0 ? ' is-charging' : ' is-ready'}`}
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((1 - sprint.shoveCooldownFraction) * 100)}
            aria-label={sprint.shoveCooldownFraction > 0 ? 'Shove recharging' : 'Shove ready'}
          ><i style={{ width: `${(1 - sprint.shoveCooldownFraction) * 100}%` }} /></div>
        </div>
        {/* Visual only: both meters already carry this state in their own labels,
            and a second polite region would talk over the feedback indicator. */}
        <span className="meter-note" aria-hidden="true">
          {sprint.recovering ? 'Recovering' : sprint.exhausted ? 'Walk to recover' : ''}
        </span>
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
      <span>Get ready</span><strong>{remainingSeconds ?? '…'}</strong>
    </div>}
    <div className={`game-action-indicator ${feedback ? 'is-visible' : ''}`} role="status" aria-live="polite">
      {feedback?.message ?? ''}
    </div>
    <p className="focus-hint">Click the store to capture controls · focus is released when you tab away</p>
  </main>;
}

function formatMatchTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

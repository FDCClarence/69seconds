import { GAME, type RoomPublicState } from '@69-seconds/shared';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { RoomClient, SocketConnectionState } from '../../room-client.js';
import {
  gameAudio,
  loadAudioSettings,
  saveAudioSettings,
  type GameAudioCue,
  type GameAudioSettings,
} from '../audio/game-audio.js';
import {
  BINDABLE_ACTIONS,
  DEFAULT_INPUT_BINDINGS,
  bindingLabel,
  isBindableCode,
  loadInputBindings,
  rebindAction,
  saveInputBindings,
  type BindableAction,
  type InputBindings,
} from '../input/key-bindings.js';
import { CarryableArt } from '../../carryable-art.js';
import type { CarryHudItem, CarryHudState, GameFeedback, GroceryGameFactory, SprintHudState } from '../types.js';
import { mountGroceryGame } from './game-lifecycle.js';
import { usePrefersReducedMotion } from '../../prefers-reduced-motion.js';

const READY_SPRINT: SprintHudState = {
  fraction: 1,
  sprinting: false,
  exhausted: false,
  shoveCooldownFraction: 0,
  recovering: false,
};

const ACTION_LABELS: Readonly<Record<BindableAction, string>> = {
  up: 'Move up', down: 'Move down', left: 'Move left', right: 'Move right',
  sprint: 'Sprint', interact: 'Interact', shove: 'Shove', drop: 'Put down item',
};

const EMPTY_CARRY: CarryHudState = { carriedItems: [], slotsUsed: 0, depositedCount: 0, synchronized: false };

/**
 * One rendered carry slot. A person consumes the whole inventory, so they fill
 * the first slot and *block* the rest: those slots show an ✕ naming who is in
 * your arms, rather than looking merely empty and pickable.
 */
type CarrySlot =
  | { kind: 'empty' }
  | { kind: 'held'; item: CarryHudItem }
  | { kind: 'blocked'; item: CarryHudItem };

function carrySlots(carriedItems: readonly CarryHudItem[]): CarrySlot[] {
  const slots: CarrySlot[] = [];
  for (const item of carriedItems) {
    slots.push({ kind: 'held', item });
    for (let extra = 1; extra < item.slotCost; extra += 1) slots.push({ kind: 'blocked', item });
  }
  while (slots.length < GAME.maxCarriedItems) slots.push({ kind: 'empty' });
  return slots.slice(0, GAME.maxCarriedItems);
}

export function MatchGame({
  room,
  localPlayerId,
  roomClient,
  connection,
  networkError,
  onDismissNetworkError,
  onLeave,
  gameFactory,
}: {
  room: RoomPublicState;
  localPlayerId: string;
  roomClient: RoomClient;
  connection: SocketConnectionState;
  networkError: string | null;
  onDismissNetworkError: () => void;
  onLeave: () => Promise<void>;
  gameFactory: GroceryGameFactory | undefined;
}) {
  const gameHost = useRef<HTMLDivElement>(null);
  const bindingSubscribers = useRef(new Set<(bindings: InputBindings) => void>());
  const [ready, setReady] = useState(false);
  const [feedback, setFeedback] = useState<GameFeedback | null>(null);
  const [persistentNetworkError, setPersistentNetworkError] = useState<string | null>(null);
  const [inventory, setInventory] = useState<CarryHudState>(EMPTY_CARRY);
  const [sprint, setSprint] = useState<SprintHudState>(READY_SPRINT);
  const [displayPhase, setDisplayPhase] = useState(room.phase);
  const [phaseEndsAtMs, setPhaseEndsAtMs] = useState(room.phaseEndsAtMs);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bindings, setBindings] = useState<InputBindings>(() => loadInputBindings());
  const [audioSettings, setAudioSettings] = useState<GameAudioSettings>(() => loadAudioSettings());
  const bindingsRef = useRef(bindings);
  const reducedMotion = usePrefersReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  const serverClock = useRef({ serverTimeMs: room.serverTimeMs, receivedAtMs: Date.now() });
  const initialRoom = useRef(room);
  const actionTimer = useRef<number | undefined>(undefined);
  const lastCountdownCue = useRef('');

  const showFeedback = useCallback((nextFeedback: GameFeedback) => {
    setFeedback(nextFeedback);
    if (nextFeedback.kind === 'DESYNCHRONIZED') setPersistentNetworkError(nextFeedback.message);
    playFeedbackCue(nextFeedback);
    window.clearTimeout(actionTimer.current);
    actionTimer.current = window.setTimeout(
      () => setFeedback(null),
      nextFeedback.kind === 'DESYNCHRONIZED' ? 5_000 : 1_500,
    );
  }, []);

  useEffect(() => {
    bindingsRef.current = bindings;
    saveInputBindings(bindings);
    for (const listener of bindingSubscribers.current) listener(bindings);
  }, [bindings]);
  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);
  useEffect(() => {
    gameAudio.setSettings(audioSettings);
    saveAudioSettings(audioSettings);
  }, [audioSettings]);
  useEffect(() => {
    if (connection !== 'CONNECTED') gameHost.current?.dispatchEvent(new Event('game-input-blur'));
  }, [connection]);
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
    if (remainingSeconds === null) return;
    const cueKey = `${displayPhase}:${remainingSeconds}`;
    if (lastCountdownCue.current === cueKey) return;
    lastCountdownCue.current = cueKey;
    if (displayPhase === 'COUNTDOWN' && remainingSeconds > 0 && remainingSeconds <= 3) gameAudio.play('countdown');
    if (displayPhase === 'COUNTDOWN' && remainingSeconds === 0) gameAudio.play('go');
  }, [displayPhase, remainingSeconds]);

  useEffect(() => {
    const parent = gameHost.current;
    if (!parent) return undefined;
    setReady(false);
    setInventory(EMPTY_CARRY);
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
        sendInput: (movement, sprintHeld) => roomClient.sendInput?.(movement, sprintHeld) ?? null,
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
        getBindings: () => bindingsRef.current,
        subscribeBindings: (listener) => {
          bindingSubscribers.current.add(listener);
          return () => bindingSubscribers.current.delete(listener);
        },
        prefersReducedMotion: () => reducedMotionRef.current,
      });
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(actionTimer.current);
      cleanup?.();
    };
  }, [gameFactory, localPlayerId, roomClient, showFeedback]);

  const controlsReady = ready && inventory.synchronized;
  const disconnected = connection !== 'CONNECTED';
  const inventoryFull = inventory.slotsUsed >= GAME.maxCarriedItems;
  const carriedPerson = inventory.carriedItems.find((item) => item.isNpc);
  const feedbackTone = feedback ? feedbackClass(feedback) : '';

  /**
   * Bubble phase on purpose. Phaser's KeyboardManager listens on this same host
   * element and drops any event whose `defaultPrevented` is already set, so a
   * capture-phase `preventDefault` here (React binds capture listeners on the
   * root container, above this element) would silently kill every gameplay key.
   * Cancelling after the game has read the event still suppresses the browser
   * default, and covers the modified-key case Phaser's own capture list skips.
   */
  function captureGameplayKey(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (Object.values(bindings).includes(event.code)) {
      event.preventDefault();
    }
  }

  function focusGame(): void {
    gameHost.current?.focus();
    void gameAudio.unlock();
  }

  return <main className={`game-route${sprint.sprinting ? ' is-sprinting' : ''}${sprint.recovering ? ' is-recovering' : ''}`}>
    <div
      className="phaser-focus-frame"
      ref={gameHost}
      tabIndex={0}
      role="application"
      aria-label="69 Seconds grocery store. Focus to control your shopper; Tab releases gameplay controls."
      aria-keyshortcuts={`${bindingLabel(bindings.interact)} ${bindingLabel(bindings.shove)} ${bindingLabel(bindings.drop)}`}
      onPointerDown={focusGame}
      onKeyDown={captureGameplayKey}
      onBlur={() => gameHost.current?.dispatchEvent(new Event('game-input-blur'))}
    />

    <section className="game-hud" aria-label="Gameplay status, controls, and inventory">
      <div className="game-hud-topline">
        <div><span className="hud-label">Room</span><strong>{room.code}</strong></div>
        <div className={`hud-status ${controlsReady && !disconnected ? 'is-ready' : ''}`}>
          <i aria-hidden="true" />
          <span>{disconnected ? 'Connection interrupted' : !ready ? 'Loading store' : inventory.synchronized ? 'Server synchronized' : 'Syncing inventory'}</span>
        </div>
        <div className="match-clock">
          <span className="hud-label">Server clock</span>
          <strong>{displayPhase === 'LOOTING' && remainingSeconds !== null ? formatMatchTime(remainingSeconds) : phaseLabel(displayPhase)}</strong>
        </div>
      </div>
      <div className="game-controls" aria-label="Current controls">
        <span><kbd>{bindingLabel(bindings.up)}{bindingLabel(bindings.left)}{bindingLabel(bindings.down)}{bindingLabel(bindings.right)}</kbd> move</span>
        <span><kbd>{bindingLabel(bindings.sprint)}</kbd> sprint</span>
        <span><kbd>{bindingLabel(bindings.interact)}</kbd> interact</span>
        <span><kbd>{bindingLabel(bindings.shove)}</kbd> shove</span>
        <span><kbd>{bindingLabel(bindings.drop)}</kbd> put down</span>
        <button type="button" className="hud-settings" aria-expanded={settingsOpen} onClick={() => { void gameAudio.unlock(); setSettingsOpen((open) => !open); }}>Settings</button>
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
        <span className="meter-note" aria-hidden="true">
          {sprint.recovering ? '✕ Recovering' : sprint.exhausted ? '! Walk to recover' : sprint.sprinting ? '» Sprinting' : '✓ Ready'}
        </span>
      </div>
      <div className={`carry-hud${inventoryFull ? ' is-full' : ''}`}>
        <span className="hud-label">Carry</span>
        <ol aria-label={`${inventory.slotsUsed} of ${GAME.maxCarriedItems} carry slots filled`}>
          {carrySlots(inventory.carriedItems).map((slot, index) => {
            if (slot.kind === 'blocked') {
              return <li key={index} className="is-blocked" aria-label={`Carry slot ${index + 1} taken up by ${slot.item.label}`}>
                <span>{index + 1}</span><i aria-hidden="true">✕</i>
              </li>;
            }
            if (slot.kind === 'empty') {
              return <li key={index} aria-label={`Empty carry slot ${index + 1}`}><span>{index + 1}</span></li>;
            }
            const { item } = slot;
            return <li
              key={index}
              className={`is-filled${item.pending ? ' is-pending' : ''}${item.isNpc ? ' is-person' : ''}`}
              aria-label={`${item.label}${item.isNpc ? ', carried person filling every slot,' : ''} in carry slot ${index + 1}${item.pending ? ', awaiting confirmation' : ''}`}
            >
              <span>{index + 1}</span>
              <CarryableArt
                imageUrl={item.imageUrl}
                crop={item.crop}
                color={item.color}
                label={item.label}
                className="carry-art"
              />
            </li>;
          })}
        </ol>
        <span className="deposit-count" aria-label={`${inventory.depositedCount} items deposited`}><b>{inventory.depositedCount}</b> banked</span>
        {carriedPerson
          ? <span className="carry-warning is-person" aria-hidden="true">{carriedPerson.label.toUpperCase()}</span>
          : inventoryFull && <span className="carry-warning" aria-hidden="true">FULL</span>}
      </div>
      <button type="button" className="hud-leave" onClick={() => void onLeave()}>Leave match</button>
    </section>

    {settingsOpen && <GameSettings
      bindings={bindings}
      audio={audioSettings}
      onBindingsChange={setBindings}
      onAudioChange={setAudioSettings}
      onClose={() => {
        setSettingsOpen(false);
        window.setTimeout(() => gameHost.current?.focus(), 0);
      }}
    />}

    {!controlsReady && !disconnected && <div className="game-loading-overlay" role="status" aria-live="polite" aria-busy="true">
      <span className="loading-mark" aria-hidden="true">69</span>
      <strong>{!ready ? 'Opening the store' : 'Synchronizing inventory'}</strong>
      <small>Authoritative match state is loading</small>
    </div>}

    {disconnected && <div className="connection-overlay" role="alert" aria-live="assertive">
      <span className="connection-icon" aria-hidden="true">!</span>
      <div>
        <strong>{connection === 'RECONNECTING' ? 'Connection lost — reconnecting' : 'Match server unavailable'}</strong>
        <p>Your inputs are paused. The server still owns the match clock and outcome.</p>
      </div>
    </div>}

    {(persistentNetworkError || networkError) && <div className="network-error-banner" role="alert">
      <span><b>Network error</b> {persistentNetworkError ?? networkError}</span>
      <button type="button" onClick={() => { setPersistentNetworkError(null); onDismissNetworkError(); }} aria-label="Dismiss network error">×</button>
    </div>}

    {displayPhase === 'COUNTDOWN' && <div className="countdown-overlay" role="timer" aria-label={`Match begins in ${remainingSeconds ?? 'a moment'}`}>
      <span>Doors open in</span>
      <strong key={remainingSeconds}>{remainingSeconds ?? '…'}</strong>
      <small>Move on GO</small>
    </div>}

    <div className={`game-action-indicator ${feedback ? `is-visible ${feedbackTone}` : ''}`} role="status" aria-live="polite">
      {feedback && <><span aria-hidden="true">{feedbackIcon(feedback)}</span><strong>{feedback.message}</strong></>}
    </div>
    <p className="focus-hint"><b>Click store</b> to capture controls <span aria-hidden="true">·</span> <b>Tab</b> to release</p>
  </main>;
}

function GameSettings({ bindings, audio, onBindingsChange, onAudioChange, onClose }: {
  bindings: InputBindings;
  audio: GameAudioSettings;
  onBindingsChange: (bindings: InputBindings) => void;
  onAudioChange: (settings: GameAudioSettings) => void;
  onClose: () => void;
}) {
  const [listening, setListening] = useState<BindableAction | null>(null);

  useEffect(() => {
    if (!listening) return undefined;
    const capture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Escape') {
        setListening(null);
        return;
      }
      if (!isBindableCode(event.code)) return;
      onBindingsChange(rebindAction(bindings, listening, event.code));
      setListening(null);
    };
    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
  }, [bindings, listening, onBindingsChange]);

  return <aside className="game-settings-panel" aria-label="Game settings">
    <header><div><span className="hud-label">Game settings</span><h2>Controls & audio</h2></div><button type="button" onClick={onClose} aria-label="Close settings">×</button></header>
    <section>
      <div className="settings-heading"><h3>Key bindings</h3><button type="button" onClick={() => onBindingsChange(DEFAULT_INPUT_BINDINGS)}>Reset</button></div>
      <div className="binding-grid">
        {BINDABLE_ACTIONS.map((action) => <div key={action}>
          <span>{ACTION_LABELS[action]}</span>
          <button
            type="button"
            className={listening === action ? 'is-listening' : ''}
            aria-label={`${ACTION_LABELS[action]} key: ${bindingLabel(bindings[action])}. Activate to rebind.`}
            onClick={() => setListening(action)}
          >{listening === action ? 'Press key…' : bindingLabel(bindings[action])}</button>
        </div>)}
      </div>
      <p className="settings-note">A conflicting key swaps assignments. Escape cancels.</p>
    </section>
    <section>
      <div className="settings-heading"><h3>Audio</h3><button type="button" aria-pressed={audio.muted} onClick={() => onAudioChange({ ...audio, muted: !audio.muted })}>{audio.muted ? 'Unmute' : 'Mute'}</button></div>
      <label>Music <output>{Math.round(audio.musicVolume * 100)}%</output><input aria-label="Music volume" type="range" min="0" max="1" step="0.05" value={audio.musicVolume} onChange={(event) => onAudioChange({ ...audio, musicVolume: Number(event.target.value) })} /></label>
      <label>SFX <output>{Math.round(audio.sfxVolume * 100)}%</output><input aria-label="Sound effects volume" type="range" min="0" max="1" step="0.05" value={audio.sfxVolume} onChange={(event) => onAudioChange({ ...audio, sfxVolume: Number(event.target.value) })} /></label>
      <p className="settings-note">Original procedural placeholder tones; no third-party audio assets.</p>
    </section>
  </aside>;
}

function playFeedbackCue(feedback: GameFeedback): void {
  const cues: Partial<Record<GameFeedback['kind'], GameAudioCue>> = {
    PICKED_UP: 'pickup', DEPOSITED: 'deposit', HANDS_FULL: 'inventory-full',
    SPRINT_EXHAUSTED: 'sprint-empty', SHOVE_LANDED: 'shove', SHOVE_TAKEN: 'shoved',
    DESYNCHRONIZED: 'error',
  };
  gameAudio.play(cues[feedback.kind] ?? (feedbackClass(feedback) === 'is-negative' ? 'error' : 'pickup'));
}

function feedbackClass(feedback: GameFeedback): 'is-positive' | 'is-warning' | 'is-negative' {
  if (feedback.kind === 'PICKED_UP' || feedback.kind === 'DEPOSITED' || feedback.kind === 'SHOVE_LANDED') return 'is-positive';
  // A deliberate put-down is neither a win nor an error: it reads as a notice.
  if (feedback.kind === 'DROPPED' || feedback.kind === 'HANDS_FULL' || feedback.kind === 'SPRINT_EXHAUSTED' || feedback.kind === 'ON_COOLDOWN' || feedback.kind === 'RECOVERING') return 'is-warning';
  return 'is-negative';
}

function feedbackIcon(feedback: GameFeedback): string {
  const tone = feedbackClass(feedback);
  return tone === 'is-positive' ? '✓' : tone === 'is-warning' ? '!' : '×';
}

function phaseLabel(phase: RoomPublicState['phase']): string {
  if (phase === 'COUNTDOWN') return 'GET READY';
  if (phase === 'TALLY') return 'TIME';
  return phase;
}

function formatMatchTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

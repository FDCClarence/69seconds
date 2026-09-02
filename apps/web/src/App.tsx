import { GAME, roomCodeSchema, type PublicUser, type RoomPublicState } from '@69-seconds/shared';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { authApi, ApiError, type AuthApi } from './api.js';
import { MatchGame } from './game/react/MatchGame.js';
import type { GroceryGameFactory } from './game/types.js';
import {
  createRoomClient,
  RoomClientError,
  type RoomClient,
  type SocketConnectionState,
} from './room-client.js';

type StaticRoute = '/' | '/login' | '/register' | '/home' | '/room/create' | '/room/join';
type Route = StaticRoute | `/room/${string}`;
type AuthState = { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: PublicUser };
type FormMode = 'login' | 'register';

export interface AppProps {
  api?: AuthApi;
  roomClient?: RoomClient;
  gameFactory?: GroceryGameFactory;
}

function routeFromPath(pathname: string): Route {
  if (pathname === '/login' || pathname === '/register' || pathname === '/home') return pathname;
  if (pathname === '/room/create' || pathname === '/room/join') return pathname;
  const lobby = /^\/room\/([A-HJ-KM-NP-Z2-9]{6})$/i.exec(pathname);
  if (lobby?.[1]) return `/room/${lobby[1].toUpperCase()}`;
  return '/';
}

function lobbyCode(route: Route): string | null {
  if (!route.startsWith('/room/') || route === '/room/create' || route === '/room/join') return null;
  return route.slice('/room/'.length);
}

function fieldErrors(mode: FormMode, email: string, password: string, confirmPassword: string) {
  const errors: Record<string, string> = {};
  if (!email.trim()) errors.email = 'Enter your email address.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'Enter a valid email address.';
  if (!password) errors.password = 'Enter your password.';
  else if (mode === 'register' && password.length < 12) errors.password = 'Use at least 12 characters.';
  if (mode === 'register' && password !== confirmPassword) errors.confirmPassword = 'Passwords do not match.';
  return errors;
}

function authErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'EMAIL_ALREADY_REGISTERED') return 'That email already has a player record. Try logging in instead.';
    if (error.code === 'INVALID_CREDENTIALS') return 'Email or password is incorrect.';
    if (error.code === 'RATE_LIMITED') return 'Too many attempts. Please wait a moment, then try again.';
    if (error.code === 'INVALID_PAYLOAD') return 'Please check the highlighted details and try again.';
  }
  return 'The signal dropped before we could finish. Please try again.';
}

function roomErrorMessage(error: unknown): string {
  if (error instanceof RoomClientError) {
    const messages: Partial<Record<RoomClientError['code'], string>> = {
      UNAUTHENTICATED: 'Your player session expired. Log in again to enter a room.',
      ROOM_NOT_FOUND: 'No open room matches that code.',
      ROOM_FULL: 'That room already has four players.',
      MATCH_ALREADY_STARTED: 'That crew has already started its run.',
      ALREADY_IN_ROOM: 'Leave your current room before entering another.',
      NOT_IN_ROOM: 'You are no longer in this room.',
      PLAYERS_NOT_READY: 'Every player must be connected and ready before the host can start.',
      FORBIDDEN: 'Only the current host can start the match.',
      INVALID_PAYLOAD: 'Check the room code and try again.',
    };
    return messages[error.code] ?? error.message;
  }
  return 'The room signal dropped. Please try again.';
}

export function App({ api = authApi, roomClient: suppliedRoomClient, gameFactory }: AppProps) {
  const [rooms] = useState<RoomClient>(() => suppliedRoomClient ?? createRoomClient());
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname));
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomPublicState | null>(null);
  const [connection, setConnection] = useState<SocketConnectionState>('DISCONNECTED');

  const navigate = useCallback((destination: Route, replace = false) => {
    if (window.location.pathname !== destination) {
      window.history[replace ? 'replaceState' : 'pushState']({}, '', destination);
    }
    setRoute(destination);
    setNotice(null);
  }, []);

  const restoreSession = useCallback(async () => {
    setAuth({ status: 'loading' });
    setRestoreError(null);
    try {
      const user = await api.currentUser();
      setAuth(user ? { status: 'authenticated', user } : { status: 'anonymous' });
    } catch {
      setAuth({ status: 'anonymous' });
      setRestoreError('We could not verify your session. Check your connection and try again.');
    }
  }, [api]);

  useEffect(() => { void restoreSession(); }, [restoreSession]);
  useEffect(() => {
    const onPopState = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => rooms.subscribe({
    onRoom: setRoom,
    onConnection: setConnection,
    onError: (error) => setNotice(roomErrorMessage(error)),
    onClosed: () => {
      setRoom(null);
      setNotice('That room closed after everyone left.');
      window.history.replaceState({}, '', '/home');
      setRoute('/home');
    },
  }), [rooms]);
  useEffect(() => {
    if (auth.status === 'authenticated') rooms.connect();
    else rooms.disconnect();
  }, [auth.status, rooms]);

  const completeAuthentication = useCallback((user: PublicUser, message: string) => {
    setAuth({ status: 'authenticated', user });
    setNotice(message);
    window.history.replaceState({}, '', '/home');
    setRoute('/home');
  }, []);

  const logout = useCallback(async () => {
    if (room) await rooms.leaveRoom().catch(() => undefined);
    rooms.disconnect();
    setRoom(null);
    await api.logout();
    setAuth({ status: 'anonymous' });
    setNotice('You are safely out of the store.');
    window.history.replaceState({}, '', '/');
    setRoute('/');
  }, [api, room, rooms]);

  const createRoom = useCallback(async () => {
    const created = await rooms.createRoom();
    setRoom(created);
    navigate(`/room/${created.code}`);
  }, [navigate, rooms]);

  const joinRoom = useCallback(async (code: string) => {
    const joined = await rooms.joinRoom(code);
    setRoom(joined);
    navigate(`/room/${joined.code}`);
  }, [navigate, rooms]);

  const leaveRoom = useCallback(async () => {
    await rooms.leaveRoom();
    setRoom(null);
    navigate('/home');
  }, [navigate, rooms]);

  if (auth.status === 'loading') return <SessionGate />;
  const protectedRoute = route === '/home' || route.startsWith('/room/');
  if (protectedRoute && auth.status === 'anonymous') {
    return <AuthRequired onLogin={() => navigate('/login', true)} />;
  }
  if (auth.status === 'authenticated') {
    if (route === '/home') {
      return <Home
        user={auth.user}
        notice={notice}
        onLogout={logout}
        onCreate={() => navigate('/room/create')}
        onJoin={() => navigate('/room/join')}
      />;
    }
    if (route === '/room/create') {
      return <CreateRoom onCreate={createRoom} onBack={() => navigate('/home')} />;
    }
    if (route === '/room/join') {
      return <JoinRoom onJoin={joinRoom} onBack={() => navigate('/home')} />;
    }
    const code = lobbyCode(route);
    if (code) {
      return <Lobby
        code={code}
        room={room?.code === code ? room : null}
        user={auth.user}
        connection={connection}
        onJoin={joinRoom}
        onReady={async (ready) => { setRoom(await rooms.setReady(ready)); }}
        onStart={async () => { setRoom(await rooms.startMatch()); }}
        onLeave={leaveRoom}
        onBack={() => navigate('/home')}
        gameFactory={gameFactory}
      />;
    }
  }
  if (route === '/login' || route === '/register') {
    return <AuthScreen
      mode={route === '/login' ? 'login' : 'register'}
      api={api}
      onAuthenticated={completeAuthentication}
      onNavigate={navigate}
    />;
  }
  return <Landing
    onLogin={() => navigate('/login')}
    onRegister={() => navigate('/register')}
    restoreError={restoreError}
    onRetry={() => void restoreSession()}
  />;
}

function BrandMark() {
  return <a className="brand" href="/" aria-label="69 Seconds home"><span aria-hidden="true" className="brand-mark">69</span><span>SECONDS</span></a>;
}

function SessionGate() {
  return <main className="session-gate" aria-live="polite" aria-busy="true"><div className="signal-loader" aria-hidden="true"><span /><span /><span /></div><p>Checking the checkout clock…</p></main>;
}

function AuthRequired({ onLogin }: { onLogin: () => void }) {
  return <main className="session-gate" aria-live="polite"><p>You need a player pass to enter the stockroom.</p><button className="button button-primary" type="button" onClick={onLogin}>Go to login</button></main>;
}

function Landing({ onLogin, onRegister, restoreError, onRetry }: { onLogin: () => void; onRegister: () => void; restoreError: string | null; onRetry: () => void }) {
  return <main className="landing-shell"><header className="topbar"><BrandMark /><p className="topbar-note">Private grocery-store scramble</p></header><section className="hero" aria-labelledby="landing-title"><div className="hero-copy"><p className="kicker">One cart. One chance.</p><h1 id="landing-title"><span>69</span> seconds<br />to make it count.</h1><p className="hero-description">Gather the good stuff, beat the bell, and make your cart proud. Bring up to three co-conspirators when the store opens.</p>{restoreError && <div className="notice notice-error" role="alert"><span>{restoreError}</span><button type="button" onClick={onRetry}>Try again</button></div>}<div className="hero-actions"><button className="button button-primary" type="button" onClick={onRegister}>Make a player pass <span aria-hidden="true">→</span></button><button className="button button-quiet" type="button" onClick={onLogin}>I already have one</button></div></div><ClockIllustration /></section><section className="rules-strip" aria-label="How 69 Seconds works"><div><strong>01</strong><span>Form a private crew</span></div><div><strong>02</strong><span>Fill your own cart</span></div><div><strong>03</strong><span>Beat the closing bell</span></div></section></main>;
}

function ClockIllustration() {
  return <div className="clock-scene" aria-hidden="true"><div className="scene-ticket">AISLE<br /><b>69</b></div><div className="scene-clock"><i /><i /><i /><i /><div className="clock-hands"><span /><span /></div><strong>GO</strong></div><div className="scene-cart"><span className="cart-basket" /><i /><i /></div><div className="scene-spark spark-one" /><div className="scene-spark spark-two" /><div className="scene-spark spark-three" /></div>;
}

function AuthScreen({ mode, api, onAuthenticated, onNavigate }: { mode: FormMode; api: AuthApi; onAuthenticated: (user: PublicUser, message: string) => void; onNavigate: (route: Route) => void }) {
  const isRegister = mode === 'register';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const errors = useMemo(() => fieldErrors(mode, email, password, confirmPassword), [confirmPassword, email, mode, password]);
  const showError = (name: string) => touched[name] ? errors[name] : undefined;
  const markTouched = (name: string) => setTouched((current) => ({ ...current, [name]: true }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(isRegister ? { email: true, password: true, confirmPassword: true } : { email: true, password: true });
    setServerError(null);
    if (Object.keys(errors).length > 0) return;
    setIsSubmitting(true);
    try {
      const user = isRegister
        ? await api.register({ email: email.trim(), password })
        : await api.login({ email: email.trim(), password });
      onAuthenticated(user, isRegister ? 'Player pass created. The aisles are yours.' : 'Welcome back. Your cart is waiting.');
    } catch (error) {
      setServerError(authErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return <main className="auth-shell"><header className="topbar"><BrandMark /><button className="text-button" type="button" onClick={() => onNavigate('/')}>Back to briefing</button></header><section className="auth-layout" aria-labelledby="auth-title"><aside className="auth-aside"><p className="kicker">{isRegister ? 'Fresh pass, fresh start' : 'Your cart is still here'}</p><h1>{isRegister ? 'Claim your countdown.' : 'Step back into the rush.'}</h1><p>The store only opens for a moment. Your session stays private and returns when you do.</p><div className="auth-aside-number" aria-hidden="true">69</div></aside><div className="auth-card"><p className="form-overline">Player access</p><h2 id="auth-title">{isRegister ? 'Create your player pass' : 'Log in to play'}</h2><p className="form-intro">{isRegister ? 'Use an email you can remember. No marketing maze, no social accounts.' : 'Use the email and password attached to your player pass.'}</p>{serverError && <div className="notice notice-error" role="alert">{serverError}</div>}<form noValidate onSubmit={(event) => void submit(event)}><fieldset disabled={isSubmitting}><Field label="Email address" id="email" type="email" value={email} onChange={setEmail} onBlur={() => markTouched('email')} error={showError('email')} autoComplete="email" /><Field label="Password" id="password" type="password" value={password} onChange={setPassword} onBlur={() => markTouched('password')} error={showError('password')} autoComplete={isRegister ? 'new-password' : 'current-password'} hint={isRegister ? 'At least 12 characters.' : undefined} />{isRegister && <Field label="Confirm password" id="confirm-password" type="password" value={confirmPassword} onChange={setConfirmPassword} onBlur={() => markTouched('confirmPassword')} error={showError('confirmPassword')} autoComplete="new-password" />}</fieldset><button className="button button-primary form-submit" type="submit" disabled={isSubmitting}>{isSubmitting ? (isRegister ? 'Creating your pass…' : 'Opening the gate…') : (isRegister ? 'Create player pass' : 'Log in')} <span aria-hidden="true">→</span></button></form><p className="switch-auth">{isRegister ? 'Already on the roster?' : 'New around here?'} <button type="button" onClick={() => onNavigate(isRegister ? '/login' : '/register')}>{isRegister ? 'Log in' : 'Create a player pass'}</button></p></div></section></main>;
}

function Field({ label, id, type, value, onChange, onBlur, error, autoComplete, hint }: { label: string; id: string; type: 'email' | 'password'; value: string; onChange: (value: string) => void; onBlur: () => void; error?: string | undefined; autoComplete: string; hint?: string | undefined }) {
  const messageId = `${id}-message`;
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} name={id} type={type} value={value} autoComplete={autoComplete} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} aria-invalid={Boolean(error)} aria-describedby={error || hint ? messageId : undefined} required />{(error || hint) && <p className={error ? 'field-error' : 'field-hint'} id={messageId}>{error ?? hint}</p>}</div>;
}

function Home({ user, notice, onLogout, onCreate, onJoin }: { user: PublicUser; notice: string | null; onLogout: () => Promise<void>; onCreate: () => void; onJoin: () => void }) {
  const [leaving, setLeaving] = useState(false);
  async function handleLogout() {
    setLeaving(true);
    try { await onLogout(); } finally { setLeaving(false); }
  }
  return <main className="home-shell"><header className="topbar"><BrandMark /><div className="player-menu"><span title={user.email}>Signed in</span><button className="text-button" type="button" disabled={leaving} onClick={() => void handleLogout()}>{leaving ? 'Leaving…' : 'Log out'}</button></div></header><section className="home-hero" aria-labelledby="home-title"><p className="kicker">The bell has not rung yet</p><h1 id="home-title">Ready when your crew is.</h1><p>Build a private grocery scramble for one to {GAME.maxPlayers} players. You’ll get a room code to share before the countdown begins.</p>{notice && <p className="notice notice-success" role="status">{notice}</p>}</section><section className="room-actions" aria-label="Room actions"><button type="button" className="room-action create" onClick={onCreate}><span className="action-number">01</span><strong>Create room</strong><span>Start a private crew and get a shareable code.</span><b aria-hidden="true">+</b></button><button type="button" className="room-action join" onClick={onJoin}><span className="action-number">02</span><strong>Join room</strong><span>Enter a friend’s code and meet them at the carts.</span><b aria-hidden="true">→</b></button></section><footer className="home-footer"><span>Player pass: <b>{user.email}</b></span><span>69 seconds. No extensions.</span></footer></main>;
}

function RoomShell({ children, onBack }: { children: React.ReactNode; onBack: () => void }) {
  return <main className="room-shell"><header className="topbar"><BrandMark /><button className="text-button" type="button" onClick={onBack}>Back to home</button></header>{children}</main>;
}

function CreateRoom({ onCreate, onBack }: { onCreate: () => Promise<void>; onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    setError(null);
    try { await onCreate(); } catch (cause) { setError(roomErrorMessage(cause)); } finally { setBusy(false); }
  }
  return <RoomShell onBack={onBack}><section className="room-card room-entry" aria-labelledby="create-room-title"><p className="kicker">New private crew</p><h1 id="create-room-title">Create a room.</h1><p>We’ll generate a six-character code without easily confused letters or numbers. Share it only with the players you want in your crew.</p>{error && <p className="notice notice-error" role="alert">{error}</p>}<button className="button button-primary" type="button" disabled={busy} onClick={() => void create()}>{busy ? 'Opening room…' : 'Generate room code'}</button></section></RoomShell>;
}

function JoinRoom({ onJoin, onBack }: { onJoin: (code: string) => Promise<void>; onBack: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = roomCodeSchema.safeParse(code);
    if (!parsed.success) {
      setError('Enter the six-character room code. Codes do not use 0, 1, I, L, or O.');
      return;
    }
    setBusy(true);
    setError(null);
    try { await onJoin(parsed.data); } catch (cause) { setError(roomErrorMessage(cause)); } finally { setBusy(false); }
  }
  return <RoomShell onBack={onBack}><section className="room-card room-entry" aria-labelledby="join-room-title"><p className="kicker">Find your crew</p><h1 id="join-room-title">Join by code.</h1><form onSubmit={(event) => void submit(event)}><label htmlFor="room-code">Room code</label><input id="room-code" className="room-code-input" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={GAME.roomCodeLength} autoComplete="off" autoCapitalize="characters" spellCheck={false} />{error && <p className="notice notice-error" role="alert">{error}</p>}<button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Finding room…' : 'Join room'}</button></form></section></RoomShell>;
}

function Lobby({ code, room, user, connection, onJoin, onReady, onStart, onLeave, onBack, gameFactory }: { code: string; room: RoomPublicState | null; user: PublicUser; connection: SocketConnectionState; onJoin: (code: string) => Promise<void>; onReady: (ready: boolean) => Promise<void>; onStart: () => Promise<void>; onLeave: () => Promise<void>; onBack: () => void; gameFactory: GroceryGameFactory | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (room?.code === code) return;
    let active = true;
    void onJoin(code).catch((cause) => { if (active) setError(roomErrorMessage(cause)); });
    return () => { active = false; };
  }, [code, onJoin, room?.code]);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await action(); } catch (cause) { setError(roomErrorMessage(cause)); } finally { setBusy(false); }
  }

  if (!room) {
    return <RoomShell onBack={onBack}><section className="room-card room-entry" aria-live="polite"><p className="kicker">Room {code}</p><h1>{error ? 'Could not enter.' : 'Connecting to crew…'}</h1>{error && <p className="notice notice-error" role="alert">{error}</p>}</section></RoomShell>;
  }

  const self = room.players.find((player) => player.id === user.id);
  const isHost = room.hostPlayerId === user.id;
  const canStart = room.players.every((player) => player.isConnected && player.isReady);
  const lobbyOpen = room.phase === 'LOBBY';
  if (!lobbyOpen) {
    return <MatchGame phase={room.phase} roomCode={room.code} onLeave={onLeave} gameFactory={gameFactory} />;
  }
  return <main className="room-shell lobby-shell"><header className="topbar"><BrandMark /><div className={`socket-status status-${connection.toLowerCase()}`}><span aria-hidden="true" />{connection === 'CONNECTED' ? 'Live' : connection.toLowerCase()}</div></header><section className="lobby-heading"><div><p className="kicker">Private room</p><h1>Crew at the carts.</h1></div><div className="room-code-display"><span>Room code</span><strong>{room.code}</strong></div></section>{error && <p className="notice notice-error lobby-error" role="alert">{error}</p>}<section className="lobby-grid"><div className="roster-panel"><div className="panel-heading"><h2>Players</h2><span>{room.players.length} / {GAME.maxPlayers}</span></div><ol className="player-roster">{room.players.map((player) => <li key={player.id} className={!player.isConnected ? 'player-reconnecting' : ''}><span className="player-slot">{player.slot + 1}</span><span className="player-name"><strong>{player.displayName}{player.id === user.id ? ' (you)' : ''}</strong><small>{player.isHost ? 'Host' : 'Crew member'}</small></span><span className={`connection-pill ${player.connectionState.toLowerCase()}`}>{player.connectionState === 'CONNECTED' ? 'Connected' : 'Reconnecting'}</span><span className={`ready-pill ${player.isReady ? 'is-ready' : ''}`}>{player.isReady ? 'Ready' : 'Not ready'}</span></li>)}</ol></div><aside className="lobby-controls"><p className="form-overline">Start rule</p><h2>Everyone checks in.</h2><p>Every rostered player—including the host—must be connected and ready. Only the current host can start.</p>{lobbyOpen ? <><button className={`button ${self?.isReady ? 'button-quiet' : 'button-primary'}`} type="button" disabled={busy || connection !== 'CONNECTED'} onClick={() => void act(() => onReady(!self?.isReady))}>{self?.isReady ? 'Mark not ready' : 'I’m ready'}</button>{isHost && <button className="button start-button" type="button" disabled={busy || !canStart || connection !== 'CONNECTED'} onClick={() => void act(onStart)}>Start match</button>}</> : <div className="match-started" role="status"><strong>Match started.</strong><span>The roster is locked and the countdown is server-owned.</span></div>}<button className="text-button leave-room" type="button" disabled={busy} onClick={() => void act(onLeave)}>Leave room</button></aside></section></main>;
}

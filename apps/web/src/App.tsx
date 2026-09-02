import { GAME, roomCodeSchema, type PublicUser, type RoomPublicState } from '@69-seconds/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { authApi, ApiError, type AuthApi } from './api.js';
import { MatchGame } from './game/react/MatchGame.js';
import type { GroceryGameFactory } from './game/types.js';
import {
  createRoomClient,
  RoomClientError,
  type RoomClient,
  type SocketConnectionState,
} from './room-client.js';

type Route = '/' | '/home' | `/room/${string}`;
type AuthState = { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: PublicUser };
type FormMode = 'login' | 'register';

export interface AppProps {
  api?: AuthApi;
  roomClient?: RoomClient;
  gameFactory?: GroceryGameFactory;
}

function routeFromPath(pathname: string): Route {
  if (pathname === '/home') return '/home';
  const lobby = /^\/room\/([A-HJ-KM-NP-Z2-9]{6})$/i.exec(pathname);
  if (lobby?.[1]) return `/room/${lobby[1].toUpperCase()}`;
  return '/';
}

function lobbyCode(route: Route): string | null {
  return route.startsWith('/room/') ? route.slice('/room/'.length) : null;
}

function fieldErrors(mode: FormMode, values: { username: string; email: string; identifier: string; password: string }) {
  const errors: Record<string, string> = {};
  if (mode === 'register') {
    if (!values.username.trim()) errors.username = 'Choose a username.';
    else if (!/^[a-zA-Z0-9_]{4,24}$/.test(values.username.trim())) errors.username = 'Use 4–24 letters, numbers, or underscores.';
    if (!values.email.trim()) errors.email = 'Enter your email address.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) errors.email = 'Enter a valid email address.';
    if (!values.password) errors.password = 'Enter a password.';
    else if (values.password.length < 8) errors.password = 'Use at least 8 characters.';
    return errors;
  }
  if (!values.identifier.trim()) errors.identifier = 'Enter your username or email.';
  if (!values.password) errors.password = 'Enter your password.';
  return errors;
}

function authErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'EMAIL_ALREADY_REGISTERED') return 'That email is already registered.';
    if (error.code === 'USERNAME_ALREADY_TAKEN') return 'That username is already taken.';
    if (error.code === 'INVALID_CREDENTIALS') return 'Those credentials are incorrect.';
    if (error.code === 'RATE_LIMITED') return 'Too many attempts. Wait a moment, then try again.';
    if (error.code === 'INVALID_PAYLOAD') return 'Check the highlighted details and try again.';
  }
  return 'Something went wrong. Please try again.';
}

function roomErrorMessage(error: unknown): string {
  if (error instanceof RoomClientError) {
    const messages: Partial<Record<RoomClientError['code'], string>> = {
      UNAUTHENTICATED: 'Your session expired. Log in again.',
      ROOM_NOT_FOUND: 'No open room matches that code.',
      ROOM_FULL: 'That room is full.',
      MATCH_ALREADY_STARTED: 'That match has already started.',
      ALREADY_IN_ROOM: 'Leave your current room first.',
      NOT_IN_ROOM: 'You are no longer in this room.',
      PLAYERS_NOT_READY: 'Everyone must be connected and ready.',
      FORBIDDEN: 'Only the host can start the match.',
      INVALID_PAYLOAD: 'Check the room code and try again.',
    };
    return messages[error.code] ?? error.message;
  }
  return 'The room connection dropped. Please try again.';
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
      window.history.replaceState({}, '', '/home');
      setRoute('/home');
      setNotice('That room closed after everyone left.');
    },
  }), [rooms]);
  useEffect(() => {
    if (auth.status === 'authenticated') rooms.connect();
    else rooms.disconnect();
  }, [auth.status, rooms]);
  // The rendered screen follows the session, so the address bar is corrected to match it.
  useEffect(() => {
    if (auth.status === 'loading') return;
    if (auth.status === 'anonymous' && route !== '/') navigate('/', true);
    if (auth.status === 'authenticated' && route === '/') navigate('/home', true);
  }, [auth.status, navigate, route]);

  const logout = useCallback(async () => {
    if (room) await rooms.leaveRoom().catch(() => undefined);
    rooms.disconnect();
    setRoom(null);
    await api.logout();
    setAuth({ status: 'anonymous' });
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
  if (auth.status === 'anonymous') {
    return <AuthLanding
      api={api}
      restoreError={restoreError}
      onRetry={() => void restoreSession()}
      onAuthenticated={(user) => {
        setAuth({ status: 'authenticated', user });
        navigate('/home', true);
      }}
    />;
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
      onLogout={logout}
      gameFactory={gameFactory}
    />;
  }
  return <Home user={auth.user} notice={notice} onLogout={logout} onCreate={createRoom} onJoin={joinRoom} />;
}

function SessionGate() {
  return <main className="gate" aria-live="polite" aria-busy="true"><p>Loading…</p></main>;
}

function Brand() {
  return <span className="brand">69<span>SECONDS</span></span>;
}

function TopBar({ user, onLogout }: { user: PublicUser; onLogout: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function logout() {
    setLeaving(true);
    try { await onLogout(); } finally { setLeaving(false); }
  }

  return <header className="topbar">
    <Brand />
    <div className="account" ref={container}>
      <button
        type="button"
        className="account-toggle"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
        <span className="account-email">{user.email}</span>
        <span className="chevron" aria-hidden="true" />
      </button>
      {open && <div className="account-menu" role="menu">
        <button type="button" role="menuitem" disabled={leaving} onClick={() => void logout()}>
          {leaving ? 'Logging out…' : 'Log out'}
        </button>
      </div>}
    </div>
  </header>;
}

function AuthLanding({ api, restoreError, onRetry, onAuthenticated }: {
  api: AuthApi;
  restoreError: string | null;
  onRetry: () => void;
  onAuthenticated: (user: PublicUser) => void;
}) {
  const [mode, setMode] = useState<FormMode>('login');
  const [identifier, setIdentifier] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const isRegister = mode === 'register';
  const errors = useMemo(
    () => fieldErrors(mode, { username, email, identifier, password }),
    [email, identifier, mode, password, username],
  );

  function switchMode(next: FormMode) {
    setMode(next);
    setTouched({});
    setServerError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(isRegister ? { username: true, email: true, password: true } : { identifier: true, password: true });
    setServerError(null);
    if (Object.keys(errors).length > 0) return;
    setSubmitting(true);
    try {
      const user = isRegister
        ? await api.register({ username: username.trim().toLowerCase(), email: email.trim().toLowerCase(), password })
        : await api.login({ identifier: identifier.trim().toLowerCase(), password });
      onAuthenticated(user);
    } catch (error) {
      setServerError(authErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  const showError = (name: string) => touched[name] ? errors[name] : undefined;
  const markTouched = (name: string) => setTouched((current) => ({ ...current, [name]: true }));

  return <main className="page">
    <header className="topbar"><Brand /></header>
    <div className="center">
      <div className="panel">
        <h1 className="sr-only">Log in or register</h1>
        <div className="tabs" role="tablist" aria-label="Account access">
          <button type="button" role="tab" aria-selected={!isRegister} onClick={() => switchMode('login')}>Log in</button>
          <button type="button" role="tab" aria-selected={isRegister} onClick={() => switchMode('register')}>Register</button>
        </div>
        {restoreError && <p className="alert" role="alert">
          {restoreError} <button type="button" className="link" onClick={onRetry}>Retry</button>
        </p>}
        {serverError && <p className="alert" role="alert">{serverError}</p>}
        <form noValidate onSubmit={(event) => void submit(event)}>
          <fieldset disabled={submitting}>
            {isRegister ? <>
              <Field label="Username" id="username" type="text" value={username} onChange={setUsername}
                onBlur={() => markTouched('username')} error={showError('username')} autoComplete="username" />
              <Field label="Email" id="email" type="email" value={email} onChange={setEmail}
                onBlur={() => markTouched('email')} error={showError('email')} autoComplete="email" />
              <Field label="Password" id="password" type="password" value={password} onChange={setPassword}
                onBlur={() => markTouched('password')} error={showError('password')} autoComplete="new-password"
                hint="At least 12 characters." />
            </> : <>
              <Field label="Username or email" id="identifier" type="text" value={identifier} onChange={setIdentifier}
                onBlur={() => markTouched('identifier')} error={showError('identifier')} autoComplete="username" />
              <Field label="Password" id="password" type="password" value={password} onChange={setPassword}
                onBlur={() => markTouched('password')} error={showError('password')} autoComplete="current-password" />
            </>}
          </fieldset>
          <button className="button primary block" type="submit" disabled={submitting}>
            {isRegister ? (submitting ? 'Creating account…' : 'Create account') : (submitting ? 'Logging in…' : 'Log in')}
          </button>
        </form>
      </div>
    </div>
  </main>;
}

function Field({ label, id, type, value, onChange, onBlur, error, autoComplete, hint }: {
  label: string;
  id: string;
  type: 'text' | 'email' | 'password';
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  error?: string | undefined;
  autoComplete: string;
  hint?: string | undefined;
}) {
  const messageId = `${id}-message`;
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    <input
      id={id}
      name={id}
      type={type}
      value={value}
      autoComplete={autoComplete}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      aria-invalid={Boolean(error)}
      aria-describedby={error || hint ? messageId : undefined}
      required
    />
    {(error || hint) && <p className={error ? 'field-error' : 'field-hint'} id={messageId}>{error ?? hint}</p>}
  </div>;
}

function Home({ user, notice, onLogout, onCreate, onJoin }: {
  user: PublicUser;
  notice: string | null;
  onLogout: () => Promise<void>;
  onCreate: () => Promise<void>;
  onJoin: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try { await onCreate(); } catch (cause) { setError(roomErrorMessage(cause)); } finally { setBusy(false); }
  }

  async function join(event: FormEvent) {
    event.preventDefault();
    const parsed = roomCodeSchema.safeParse(code);
    if (!parsed.success) {
      setError('Enter the six-character room code.');
      return;
    }
    setBusy(true);
    setError(null);
    try { await onJoin(parsed.data); } catch (cause) { setError(roomErrorMessage(cause)); } finally { setBusy(false); }
  }

  return <main className="page">
    <TopBar user={user} onLogout={onLogout} />
    <div className="center">
      <div className="panel menu">
        <h1 className="sr-only">Room menu</h1>
        {notice && <p className="notice" role="status">{notice}</p>}
        <button className="button primary block" type="button" disabled={busy} onClick={() => void create()}>
          {busy ? 'Working…' : 'Create room'}
        </button>
        <p className="divider"><span>or</span></p>
        <form onSubmit={(event) => void join(event)}>
          <div className="field">
            <label htmlFor="room-code">Room code</label>
            <input
              id="room-code"
              className="code-input"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              maxLength={GAME.roomCodeLength}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </div>
          <button className="button block" type="submit" disabled={busy}>Join room</button>
        </form>
        {error && <p className="alert" role="alert">{error}</p>}
      </div>
    </div>
  </main>;
}

function Lobby({ code, room, user, connection, onJoin, onReady, onStart, onLeave, onLogout, gameFactory }: {
  code: string;
  room: RoomPublicState | null;
  user: PublicUser;
  connection: SocketConnectionState;
  onJoin: (code: string) => Promise<void>;
  onReady: (ready: boolean) => Promise<void>;
  onStart: () => Promise<void>;
  onLeave: () => Promise<void>;
  onLogout: () => Promise<void>;
  gameFactory: GroceryGameFactory | undefined;
}) {
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
    return <main className="page">
      <TopBar user={user} onLogout={onLogout} />
      <div className="center">
        <div className="panel" aria-live="polite">
          <h1 className="sr-only">Lobby</h1>
          <p className="label">Room {code}</p>
          {error ? <p className="alert" role="alert">{error}</p> : <p>Connecting…</p>}
        </div>
      </div>
    </main>;
  }

  if (room.phase !== 'LOBBY') {
    return <MatchGame phase={room.phase} roomCode={room.code} onLeave={onLeave} gameFactory={gameFactory} />;
  }

  const self = room.players.find((player) => player.id === user.id);
  const isHost = room.hostPlayerId === user.id;
  const canStart = room.players.every((player) => player.isConnected && player.isReady);

  return <main className="page">
    <TopBar user={user} onLogout={onLogout} />
    <div className="center">
      <div className="panel lobby">
        <h1 className="sr-only">Lobby</h1>
        <div className="lobby-head">
          <div>
            <p className="label">Room code</p>
            <strong className="code">{room.code}</strong>
          </div>
          <span className={`status status-${connection.toLowerCase()}`}>
            {connection === 'CONNECTED' ? 'Live' : 'Offline'}
          </span>
        </div>
        <ol className="players">
          {room.players.map((player) => <li key={player.id}>
            <span className="player-name">{player.displayName}{player.id === user.id ? ' (you)' : ''}</span>
            {player.isHost && <span className="tag">Host</span>}
            <span className={`state ${player.isReady ? 'is-ready' : ''}`}>
              {!player.isConnected ? 'Reconnecting' : player.isReady ? 'Ready' : 'Not ready'}
            </span>
          </li>)}
          {room.players.length < GAME.maxPlayers && <li className="empty-slot">
            <span>{GAME.maxPlayers - room.players.length} open {room.players.length === GAME.maxPlayers - 1 ? 'slot' : 'slots'}</span>
          </li>}
        </ol>
        {error && <p className="alert" role="alert">{error}</p>}
        <button
          className="button block"
          type="button"
          disabled={busy || connection !== 'CONNECTED'}
          onClick={() => void act(() => onReady(!self?.isReady))}
        >
          {self?.isReady ? 'Not ready' : 'Ready'}
        </button>
        {isHost && <button
          className="button primary block"
          type="button"
          disabled={busy || !canStart || connection !== 'CONNECTED'}
          onClick={() => void act(onStart)}
        >
          Start match
        </button>}
        <button className="link leave" type="button" disabled={busy} onClick={() => void act(onLeave)}>Leave room</button>
      </div>
    </div>
  </main>;
}

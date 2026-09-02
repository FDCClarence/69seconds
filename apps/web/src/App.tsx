import { GAME, type PublicUser } from '@69-seconds/shared';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { authApi, ApiError, type AuthApi } from './api.js';

type Route = '/' | '/login' | '/register' | '/home';
type AuthState = { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: PublicUser };
type FormMode = 'login' | 'register';

interface AppProps { api?: AuthApi; }

function routeFromPath(pathname: string): Route {
  if (pathname === '/login') return '/login';
  if (pathname === '/register') return '/register';
  if (pathname === '/home') return '/home';
  return '/';
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

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'EMAIL_ALREADY_REGISTERED') return 'That email already has a player record. Try logging in instead.';
    if (error.code === 'INVALID_CREDENTIALS') return 'Email or password is incorrect.';
    if (error.code === 'RATE_LIMITED') return 'Too many attempts. Please wait a moment, then try again.';
    if (error.code === 'INVALID_PAYLOAD') return 'Please check the highlighted details and try again.';
  }
  return 'The signal dropped before we could finish. Please try again.';
}

export function App({ api = authApi }: AppProps) {
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname));
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const restoreSession = useCallback(async () => {
    setAuth({ status: 'loading' }); setRestoreError(null);
    try { const user = await api.currentUser(); setAuth(user ? { status: 'authenticated', user } : { status: 'anonymous' }); }
    catch { setAuth({ status: 'anonymous' }); setRestoreError('We could not verify your session. Check your connection and try again.'); }
  }, [api]);
  useEffect(() => { void restoreSession(); }, [restoreSession]);
  useEffect(() => { const onPopState = () => setRoute(routeFromPath(window.location.pathname)); window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState); }, []);
  const navigate = useCallback((destination: Route, replace = false) => { if (window.location.pathname !== destination) window.history[replace ? 'replaceState' : 'pushState']({}, '', destination); setRoute(destination); setNotice(null); }, []);
  const completeAuthentication = useCallback((user: PublicUser, message: string) => { setAuth({ status: 'authenticated', user }); setNotice(message); window.history.replaceState({}, '', '/home'); setRoute('/home'); }, []);
  const logout = useCallback(async () => { await api.logout(); setAuth({ status: 'anonymous' }); setNotice('You are safely out of the store.'); window.history.replaceState({}, '', '/'); setRoute('/'); }, [api]);

  if (auth.status === 'loading') return <SessionGate />;
  if (route === '/home' && auth.status === 'anonymous') return <AuthRequired onLogin={() => navigate('/login', true)} />;
  if (route === '/home' && auth.status === 'authenticated') return <Home user={auth.user} notice={notice} onLogout={logout} />;
  if (route === '/login' || route === '/register') return <AuthScreen mode={route === '/login' ? 'login' : 'register'} api={api} onAuthenticated={completeAuthentication} onNavigate={navigate} />;
  return <Landing onLogin={() => navigate('/login')} onRegister={() => navigate('/register')} restoreError={restoreError} onRetry={() => void restoreSession()} />;
}

function BrandMark() { return <a className="brand" href="/" aria-label="69 Seconds home" onClick={(event) => event.preventDefault()}><span aria-hidden="true" className="brand-mark">69</span><span>SECONDS</span></a>; }
function SessionGate() { return <main className="session-gate" aria-live="polite" aria-busy="true"><div className="signal-loader" aria-hidden="true"><span /><span /><span /></div><p>Checking the checkout clock…</p></main>; }
function AuthRequired({ onLogin }: { onLogin: () => void }) { return <main className="session-gate" aria-live="polite"><p>You need a player pass to enter the stockroom.</p><button className="button button-primary" type="button" onClick={onLogin}>Go to login</button></main>; }

function Landing({ onLogin, onRegister, restoreError, onRetry }: { onLogin: () => void; onRegister: () => void; restoreError: string | null; onRetry: () => void }) {
  return <main className="landing-shell"><header className="topbar"><BrandMark /><p className="topbar-note">Private grocery-store scramble</p></header><section className="hero" aria-labelledby="landing-title"><div className="hero-copy"><p className="kicker">One cart. One chance.</p><h1 id="landing-title"><span>69</span> seconds<br />to make it count.</h1><p className="hero-description">Gather the good stuff, beat the bell, and make your cart proud. Bring up to three co-conspirators when the store opens.</p>{restoreError && <div className="notice notice-error" role="alert"><span>{restoreError}</span><button type="button" onClick={onRetry}>Try again</button></div>}<div className="hero-actions"><button className="button button-primary" type="button" onClick={onRegister}>Make a player pass <span aria-hidden="true">→</span></button><button className="button button-quiet" type="button" onClick={onLogin}>I already have one</button></div></div><ClockIllustration /></section><section className="rules-strip" aria-label="How 69 Seconds works"><div><strong>01</strong><span>Form a private crew</span></div><div><strong>02</strong><span>Fill your own cart</span></div><div><strong>03</strong><span>Beat the closing bell</span></div></section></main>;
}
function ClockIllustration() { return <div className="clock-scene" aria-hidden="true"><div className="scene-ticket">AISLE<br /><b>69</b></div><div className="scene-clock"><i /><i /><i /><i /><div className="clock-hands"><span /><span /></div><strong>GO</strong></div><div className="scene-cart"><span className="cart-basket" /><i /><i /></div><div className="scene-spark spark-one" /><div className="scene-spark spark-two" /><div className="scene-spark spark-three" /></div>; }

function AuthScreen({ mode, api, onAuthenticated, onNavigate }: { mode: FormMode; api: AuthApi; onAuthenticated: (user: PublicUser, message: string) => void; onNavigate: (route: Route) => void }) {
  const isRegister = mode === 'register'; const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState(''); const [touched, setTouched] = useState<Record<string, boolean>>({}); const [serverError, setServerError] = useState<string | null>(null); const [isSubmitting, setIsSubmitting] = useState(false);
  const errors = useMemo(() => fieldErrors(mode, email, password, confirmPassword), [confirmPassword, email, mode, password]);
  const showError = (name: string) => touched[name] ? errors[name] : undefined;
  const markTouched = (name: string) => setTouched((current) => ({ ...current, [name]: true }));
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const allTouched = isRegister ? { email: true, password: true, confirmPassword: true } : { email: true, password: true }; setTouched(allTouched); setServerError(null); if (Object.keys(errors).length > 0) return; setIsSubmitting(true); try { const user = isRegister ? await api.register({ email: email.trim(), password }) : await api.login({ email: email.trim(), password }); onAuthenticated(user, isRegister ? 'Player pass created. The aisles are yours.' : 'Welcome back. Your cart is waiting.'); } catch (error) { setServerError(errorMessage(error)); } finally { setIsSubmitting(false); } }
  return <main className="auth-shell"><header className="topbar"><BrandMark /><button className="text-button" type="button" onClick={() => onNavigate('/')}>Back to briefing</button></header><section className="auth-layout" aria-labelledby="auth-title"><aside className="auth-aside"><p className="kicker">{isRegister ? 'Fresh pass, fresh start' : 'Your cart is still here'}</p><h1>{isRegister ? 'Claim your countdown.' : 'Step back into the rush.'}</h1><p>The store only opens for a moment. Your session stays private and returns when you do.</p><div className="auth-aside-number" aria-hidden="true">69</div></aside><div className="auth-card"><p className="form-overline">Player access</p><h2 id="auth-title">{isRegister ? 'Create your player pass' : 'Log in to play'}</h2><p className="form-intro">{isRegister ? 'Use an email you can remember. No marketing maze, no social accounts.' : 'Use the email and password attached to your player pass.'}</p>{serverError && <div className="notice notice-error" role="alert">{serverError}</div>}<form noValidate onSubmit={(event) => void submit(event)}><fieldset disabled={isSubmitting}><Field label="Email address" id="email" type="email" value={email} onChange={setEmail} onBlur={() => markTouched('email')} error={showError('email')} autoComplete="email" /><Field label="Password" id="password" type="password" value={password} onChange={setPassword} onBlur={() => markTouched('password')} error={showError('password')} autoComplete={isRegister ? 'new-password' : 'current-password'} hint={isRegister ? 'At least 12 characters.' : undefined} />{isRegister && <Field label="Confirm password" id="confirm-password" type="password" value={confirmPassword} onChange={setConfirmPassword} onBlur={() => markTouched('confirmPassword')} error={showError('confirmPassword')} autoComplete="new-password" />}</fieldset><button className="button button-primary form-submit" type="submit" disabled={isSubmitting}>{isSubmitting ? (isRegister ? 'Creating your pass…' : 'Opening the gate…') : (isRegister ? 'Create player pass' : 'Log in')} <span aria-hidden="true">→</span></button></form><p className="switch-auth">{isRegister ? 'Already on the roster?' : 'New around here?'} <button type="button" onClick={() => onNavigate(isRegister ? '/login' : '/register')}>{isRegister ? 'Log in' : 'Create a player pass'}</button></p></div></section></main>;
}
function Field({ label, id, type, value, onChange, onBlur, error, autoComplete, hint }: { label: string; id: string; type: 'email' | 'password'; value: string; onChange: (value: string) => void; onBlur: () => void; error?: string | undefined; autoComplete: string; hint?: string | undefined }) { const messageId = `${id}-message`; return <div className="field"><label htmlFor={id}>{label}</label><input id={id} name={id} type={type} value={value} autoComplete={autoComplete} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} aria-invalid={Boolean(error)} aria-describedby={error || hint ? messageId : undefined} required />{(error || hint) && <p className={error ? 'field-error' : 'field-hint'} id={messageId}>{error ?? hint}</p>}</div>; }
function Home({ user, notice, onLogout }: { user: PublicUser; notice: string | null; onLogout: () => Promise<void> }) {
  const [leaving, setLeaving] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [roomMessage, setRoomMessage] = useState<string | null>(null);

  async function handleLogout() {
    setLeaving(true);
    setLogoutError(null);
    try {
      await onLogout();
    } catch (error) {
      setLogoutError(errorMessage(error));
    } finally {
      setLeaving(false);
    }
  }

  return <main className="home-shell"><header className="topbar"><BrandMark /><div className="player-menu"><span title={user.email}>Signed in</span><button className="text-button" type="button" disabled={leaving} onClick={() => void handleLogout()}>{leaving ? 'Leaving…' : 'Log out'}</button></div></header><section className="home-hero" aria-labelledby="home-title"><p className="kicker">The bell has not rung yet</p><h1 id="home-title">Ready when your crew is.</h1><p>Build a private grocery scramble for one to {GAME.maxPlayers} players. You’ll get a room code to share before the countdown begins.</p>{notice && <p className="notice notice-success" role="status">{notice}</p>}{logoutError && <p className="notice notice-error" role="alert">{logoutError}</p>}</section><section className="room-actions" aria-label="Room actions"><button type="button" className="room-action create" onClick={() => setRoomMessage('Room creation is the next build step. Your player pass is ready.')}><span className="action-number">01</span><strong>Create room</strong><span>Start a private crew and get a shareable code.</span><b aria-hidden="true">+</b></button><button type="button" className="room-action join" onClick={() => setRoomMessage('Room joining is the next build step. Ask your host to keep the code handy.')}><span className="action-number">02</span><strong>Join room</strong><span>Enter a friend’s code and meet them at the carts.</span><b aria-hidden="true">→</b></button></section>{roomMessage && <p className="room-message" role="status">{roomMessage}</p>}<footer className="home-footer"><span>Player pass: <b>{user.email}</b></span><span>69 seconds. No extensions.</span></footer></main>;
}

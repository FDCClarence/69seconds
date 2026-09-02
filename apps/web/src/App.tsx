import { GAME, gamePhaseSchema, type GamePhase } from '@69-seconds/shared';

const initialPhase: GamePhase = gamePhaseSchema.parse('LOBBY');

export function App() {
  return (
    <main className="shell">
      <p className="eyebrow">Architecture scaffold · {initialPhase}</p>
      <h1>69 Seconds</h1>
      <p>
        A server-authoritative grocery scramble for one to {GAME.maxPlayers} players.
        The playable room and game scene arrive in later build steps.
      </p>
      <div className="timer" aria-label="Looting phase duration">69</div>
    </main>
  );
}

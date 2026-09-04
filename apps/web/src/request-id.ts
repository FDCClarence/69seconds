/**
 * One request id per intent the client sends the server.
 *
 * Every authoritative request the server can commit — a loot interaction, a
 * shove, a feed — carries one of these so a retry is recognizable as a replay
 * rather than a second decision. It lives here, outside both the Phaser scene
 * and the React tree, because the two send those requests from different places
 * and must not disagree about the format the server's `requestIdSchema` accepts.
 */
export function newRequestId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  // Deterministic fallback for environments without Web Crypto; still unique per press.
  const random = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${random()}${random()}-${random()}-4${random().slice(1)}-8${random().slice(1)}-${random()}${random()}${random()}`;
}

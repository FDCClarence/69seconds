import { createServer } from 'node:http';
import { createApp } from './app.js';
import { AuthService } from './auth/service.js';
import { config } from './config.js';
import { createDatabase } from './db/client.js';
import { attachSocketServer } from './socket.js';

const database = createDatabase(config.databaseUrl);
const auth = new AuthService(database.db, config.cookie.ttlMs);
const app = createApp({ config, auth });
const httpServer = createServer(app);
const sockets = attachSocketServer(httpServer, {
  webOrigins: config.webOrigins,
  auth,
  cookie: config.cookie,
});

httpServer.listen(config.port, () => {
  console.log(`69 Seconds server listening on http://localhost:${config.port}`);
});

let shutdownStarted = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`Received ${signal}; closing realtime connections and database pool`);
  try {
    await sockets.close();
    await database.pool.end();
    console.log('Server shutdown complete');
  } catch (error) {
    console.error('Server shutdown failed', error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

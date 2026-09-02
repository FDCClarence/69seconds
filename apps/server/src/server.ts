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

async function shutdown(): Promise<void> {
  await sockets.close();
  await database.pool.end();
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

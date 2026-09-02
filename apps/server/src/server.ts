import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { attachSocketServer } from './socket.js';

const app = createApp(config.webOrigin);
const httpServer = createServer(app);
attachSocketServer(httpServer, config.webOrigin);

httpServer.listen(config.port, () => {
  console.log(`69 Seconds server listening on http://localhost:${config.port}`);
});

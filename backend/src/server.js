import http from 'http';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { connectDb } from './db.js';
import { createApiRouter } from './routes.js';
import { createSocketServer } from './socket.js';

function isAllowedLocalOrigin(origin) {
  if (!origin) return true;

  try {
    const url = new URL(origin);
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1'
    );
  } catch {
    return origin === config.corsOrigin;
  }
}

async function bootstrap() {
  await connectDb();

  const app = express();
  app.use(
    cors({
      origin: (origin, callback) => callback(null, isAllowedLocalOrigin(origin)),
      credentials: true,
    })
  );
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createApiRouter());

  const server = http.createServer(app);
  createSocketServer(server, config.corsOrigin);

  server.listen(config.port, () => {
    console.log(`Backend API listening on http://localhost:${config.port}`);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start backend:', error);
  process.exit(1);
});

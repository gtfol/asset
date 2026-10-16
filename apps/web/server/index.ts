import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { enqueueStaleSyncs, processJob } from './plaid.js';
import { userPlaidProvider } from './plaid-credentials.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const db = await openDatabase(),
  app = createApp(db);
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
let processing = false;
let lastSweep = 0;
const interval = setInterval(async () => {
  if (processing) return;
  processing = true;
  try {
    if (Date.now() - lastSweep >= 60000) {
      await enqueueStaleSyncs(db);
      lastSweep = Date.now();
    }
    await processJob(db, (owner) => userPlaidProvider(db, owner));
  } catch {
    /* Persisted jobs retry without logging financial/provider payloads. */
  } finally {
    processing = false;
  }
}, 3000);
const host = process.env.HOST ?? '127.0.0.1',
  port = Number(process.env.PORT ?? 4317);
const server = app.listen(port, host, () =>
  console.log(`Asset is available at http://localhost:${port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    clearInterval(interval);
    server.close(() => void db.close().then(() => process.exit(0)));
  });

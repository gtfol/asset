import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db';
import { createApp } from './app';
import { PlaidSandbox, processJob } from './plaid';
const root = fileURLToPath(new URL('..', import.meta.url));
const db = await openDatabase(),
  provider = new PlaidSandbox(),
  app = createApp(db, provider);
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
let processing = false;
const interval = setInterval(async () => {
  if (processing) return;
  processing = true;
  try {
    await processJob(db, provider);
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

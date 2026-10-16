import express, { type Express } from 'express';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db.js';
import { hostedPayloadGuard } from '../server/hosting.js';

async function initializeApplication(): Promise<Express> {
  const db = await openDatabase();
  try {
    return createApp(db);
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
}

export function createServerlessApp(initialize = initializeApplication): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostedPayloadGuard);
  let application: Promise<Express> | undefined;
  app.use(async (req, res, next) => {
    try {
      application ??= Promise.resolve()
        .then(initialize)
        .catch((error) => {
          application = undefined;
          throw error;
        });
      const ready = await application;
      ready(req, res, next);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      console.error('Asset API initialization failed', {
        code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'INITIALIZATION_FAILED',
      });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'Service is temporarily unavailable. Try again shortly.' });
    }
  });
  return app;
}

// Export Express itself so the runtime leaves request streams intact for JSON/webhook parsing.
export default createServerlessApp();

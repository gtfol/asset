import express from 'express';
import { appleRoutes } from './apple.js';
import { securityRoutes, verificationGate } from './security.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { applyCommand, backup, validateState, type Command } from '../shared/core.js';
import { createDemo } from '../shared/demo.js';
import { getState, mutateState, type Database } from './db.js';
import { authenticated, newSession, readToken, tokenHash } from './auth.js';
import {
  venmoRoutes,
  venmoWebhook,
  purgeVenmoReviewContent,
  type ReceivingProvider,
} from './venmo.js';
import { bitcoinRoutes, type BitcoinProvider } from './bitcoin.js';
import { notificationRoutes, notificationWorker } from './notifications.js';
import {
  PlaidClient,
  assertConnectionEnvironment,
  PlaidError,
  createLinkToken,
  exchangeLink,
  listConnections,
  ownedConnection,
  enqueueSync,
  enqueueStaleSyncs,
  invalidateSync,
  processJob,
  withPlaidDeadline,
  verifyWebhook,
  enqueueWebhook,
  disconnect,
  decryptToken,
  type PlaidProvider,
} from './plaid.js';
import { acceptedOrigins, jsonBodyLimit } from './hosting.js';
import { googleRoutes, GoogleOAuth, type GoogleProvider } from './google.js';
import {
  plaidConfiguration,
  plaidWorkerReady,
  removePlaidCredentials,
  savePlaidCredentials,
  userPlaidProvider,
} from './plaid-credentials.js';
export function createApp(
  db: Database,
  provider?: PlaidProvider,
  google: GoogleProvider = new GoogleOAuth(),
  bitcoin?: BitcoinProvider,
  receiving?: ReceivingProvider,
) {
  const resolveProvider = async (owner: string) => provider ?? userPlaidProvider(db, owner);
  const requestProvider = async (owner: string) =>
    withPlaidDeadline(await resolveProvider(owner), Date.now() + 40000);
  const app = express();
  app.disable('x-powered-by');
  if (process.env.VERCEL === '1') app.set('trust proxy', 1);
  const limits = new Map<string, { count: number; until: number }>();
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/internal/plaid-worker', async (req, res) => {
    const expected = process.env.CRON_SECRET ?? '';
    const supplied = req.header('authorization') ?? '';
    const authorization = Buffer.from(`Bearer ${expected}`);
    const suppliedBytes = Buffer.from(supplied);
    if (
      expected.length < 32 ||
      suppliedBytes.length !== authorization.length ||
      !timingSafeEqual(suppliedBytes, authorization)
    ) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const deadline = Date.now() + 45000;
    let processed = 0;
    await purgeVenmoReviewContent(db);
    await enqueueStaleSyncs(db);
    while (
      Date.now() < deadline - 3000 &&
      processed < 20 &&
      (await processJob(db, resolveProvider, { deadline }))
    )
      processed++;
    console.info('Plaid sync worker completed', { processed });
    const delivered = await notificationWorker(db, deadline);
    res.json({ ok: true, processed, delivered });
  });
  app.post(
    '/api/plaid/webhook',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: 'Invalid webhook body' });
        return;
      }
      let verifier = provider;
      if (!verifier) {
        let item: unknown;
        try {
          item = JSON.parse(req.body.toString('utf8')).item_id;
        } catch {
          res.status(400).json({ error: 'Invalid webhook body' });
          return;
        }
        if (typeof item !== 'string' || item.length > 256) {
          res.status(202).json({ accepted: true });
          return;
        }
        const connection = (
          await db.query<{ owner_id: string }>(
            "SELECT owner_id FROM connections WHERE item_id=$1 AND status<>'disconnected'",
            [item],
          )
        ).rows[0];
        // Unknown Items have no configured owner and cannot affect a workspace.
        if (!connection) {
          res.status(202).json({ accepted: true });
          return;
        }
        verifier = await requestProvider(connection.owner_id);
      }
      if (!(await verifyWebhook(verifier, req.body, req.header('plaid-verification') ?? ''))) {
        res.status(401).json({ error: 'Invalid webhook' });
        return;
      }
      await enqueueWebhook(db, req.body);
      res.status(202).json({ accepted: true });
    },
  );
  app.use('/api/venmo/webhook', venmoWebhook(db, receiving));
  app.use('/api', express.json({ limit: jsonBodyLimit() }));
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET') {
      next();
      return;
    }
    const origin = req.header('origin');
    if (origin && !acceptedOrigins().has(origin)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    if (
      req.header('x-asset-client') !== 'web' &&
      req.header('x-asset-client') !== 'ios' &&
      !req.header('authorization')
    ) {
      res.status(403).json({ error: 'Client header required' });
      return;
    }
    next();
  });
  app.use('/api/auth', (req, res, next) => {
    const key = req.ip ?? 'local',
      now = Date.now();
    let entry = limits.get(key);
    if (!entry || entry.until < now) {
      entry = { count: 0, until: now + 60000 };
      limits.set(key, entry);
    }
    if (++entry.count > 30) {
      res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
      return;
    }
    next();
  });
  app.post('/api/auth/demo', async (req, res) => {
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO users(id,email,demo) VALUES($1,$2,true)', [
        id,
        `${id}@demo.invalid`,
      ]);
      await tx.query('INSERT INTO workspaces(owner_id,state) VALUES($1,$2)', [
        id,
        JSON.stringify(createDemo()),
      ]);
    });
    const token = await newSession(db, id, res);
    res.json({ ...(req.header('x-asset-client') === 'ios' ? { token } : {}), demo: true });
  });
  app.use('/api/auth', googleRoutes(db, google));
  app.all(['/api/auth/login', '/api/auth/register'], (_req, res) => {
    res.status(410).json({ error: 'Email sign-in is no longer supported. Continue with Google.' });
  });
  app.use('/api', authenticated(db));
  app.post('/api/auth/logout', async (req, res) => {
    await db.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(readToken(req) ?? '')]);
    res.clearCookie('asset_session', { path: '/' });
    res.json({ ok: true });
  });
  app.use('/api/security', securityRoutes(db));
  app.use('/api', verificationGate(db));
  app.use('/api/apple', appleRoutes(db));
  app.use('/api/notifications', notificationRoutes(db));
  app.use(['/api/bitcoin', '/api/venmo'], (req, res, next) => {
    const expected = req.header('x-asset-session');
    if (
      expected !== undefined &&
      expected !== tokenHash('plaid-context:' + (readToken(req) ?? ''))
    ) {
      res
        .status(409)
        .json({ error: 'Your sign-in changed. Reload Asset before managing connections.' });
      return;
    }
    next();
  });
  app.use('/api/bitcoin', bitcoinRoutes(db, bitcoin));
  app.use('/api/venmo', venmoRoutes(db));
  app.get('/api/state', async (req, res) => {
    // A missing encryption key must not make manual financial records inaccessible.
    const configuration = await plaidConfiguration(db, res.locals.owner).catch(() => null);
    res.json({
      ...(await getState(db, res.locals.owner)),
      sessionId: tokenHash('plaid-context:' + (readToken(req) ?? '')),
      connections: await listConnections(db, res.locals.owner),
      plaidConfigured: !!configuration?.configured && configuration.workerReady,
    });
  });
  app.post('/api/command', async (req, res) => {
    const c = z
      .object({
        type: z.string(),
        payload: z.record(z.string(), z.unknown()),
        revision: z.number().int(),
      })
      .parse(req.body);
    res.json(
      await mutateState(
        db,
        res.locals.owner,
        async (s, tx) => {
          if (
            c.type === 'backup.restore' &&
            (s.accounts.some((a) => a.source === 'financekit') ||
              (await listConnections(tx, res.locals.owner)).some(
                (c: any) => c.status !== 'disconnected',
              ) ||
              (
                await tx.query('SELECT id FROM venmo_routes WHERE owner_id=$1 AND active=true', [
                  res.locals.owner,
                ])
              ).rows.length > 0)
          )
            throw Error('Disconnect active connections before restoring a backup');
          return applyCommand(s, c as Command);
        },
        c.revision,
        c.type.startsWith('import.') || c.type === 'backup.restore',
      ),
    );
  });
  app.get('/api/backup', async (_req, res) => {
    const { state } = await getState(db, res.locals.owner);
    res.setHeader('Content-Disposition', 'attachment; filename="asset-backup.json"');
    res.json(backup(state));
  });
  app.use('/api/plaid', (req, res, next) => {
    const expectedSession = req.header('x-asset-session');
    if (
      expectedSession !== undefined &&
      expectedSession !== tokenHash('plaid-context:' + (readToken(req) ?? ''))
    ) {
      res
        .status(409)
        .json({ error: 'Your sign-in changed. Reload Asset before managing connections.' });
      return;
    }
    next();
  });
  const clientPlatform = (req: express.Request) =>
    req.header('x-asset-client') === 'ios' ? 'ios' : 'web';
  app.get('/api/plaid/config', async (req, res) => {
    res.json(await plaidConfiguration(db, res.locals.owner, clientPlatform(req)));
  });
  app.put('/api/plaid/config', async (req, res) => {
    const { state } = await getState(db, res.locals.owner);
    if (state.settings.demo) {
      res.status(403).json({ error: 'Sign in to add your Plaid credentials.' });
      return;
    }
    await savePlaidCredentials(db, res.locals.owner, req.body, async (credentials) => {
      try {
        await withPlaidDeadline(new PlaidClient(credentials), Date.now() + 15000).call(
          '/institutions/get',
          { country_codes: ['US'], count: 1, offset: 0 },
        );
      } catch {
        throw Object.assign(
          Error(
            'Plaid could not verify these credentials. Check the client ID, secret, and environment, then try again.',
          ),
          { status: 400 },
        );
      }
    });
    res.json(await plaidConfiguration(db, res.locals.owner, clientPlatform(req)));
  });
  app.delete('/api/plaid/config', async (req, res) => {
    await removePlaidCredentials(db, res.locals.owner);
    res.json(await plaidConfiguration(db, res.locals.owner, clientPlatform(req)));
  });
  app.post('/api/plaid/:id/disconnect', async (req, res) => {
    const remove = z.boolean().parse(req.body.deleteData ?? false);
    if (remove && req.body.confirm !== 'DELETE') throw Error('Type DELETE to delete imported data');
    res.json(
      await disconnect(
        db,
        await requestProvider(res.locals.owner),
        res.locals.owner,
        req.params.id as string,
        remove,
      ),
    );
  });
  app.use('/api/plaid', (_req, res, next) => {
    if (!plaidWorkerReady()) {
      res.status(503).json({ error: 'Bank connections are not available on this deployment yet.' });
      return;
    }
    next();
  });
  app.post('/api/plaid/link-token', async (req, res) => {
    const p = z
      .object({
        product: z.enum(['transactions', 'investments']),
        connectionId: z.string().optional(),
      })
      .parse(req.body);
    const { state } = await getState(db, res.locals.owner);
    if (state.settings.demo) throw Error('Sign in to connect your bank accounts');
    res.json(
      await createLinkToken(
        db,
        await requestProvider(res.locals.owner),
        res.locals.owner,
        p.product,
        p.connectionId,
        req.header('x-asset-client') === 'ios' ? 'ios' : 'web',
      ),
    );
  });
  app.post('/api/plaid/exchange', async (req, res) => {
    const p = z
      .object({
        publicToken: z.string(),
        product: z.enum(['transactions', 'investments']),
        selected: z.array(z.string()),
      })
      .parse(req.body);
    const { state } = await getState(db, res.locals.owner);
    if (state.settings.demo) throw Error('Demo cannot connect external data');
    const id = await exchangeLink(
      db,
      await requestProvider(res.locals.owner),
      res.locals.owner,
      p.publicToken,
      p.product,
      p.selected,
    );
    res.status(202).json({ id, status: 'initial_loading' });
  });
  app.post('/api/plaid/:id/update-complete', async (req, res) => {
    const selected = z.array(z.string()).min(1).parse(req.body.selected);
    const c = await ownedConnection(db, req.params.id as string, res.locals.owner);
    if (c.status === 'disconnected') throw Error('Connection is disconnected');
    const provider = await requestProvider(res.locals.owner);
    assertConnectionEnvironment(provider, c);
    const metadata = await provider.call('/accounts/get', {
      access_token: decryptToken(c.encrypted_token),
    });
    if (selected.some((id) => !metadata.accounts.some((a: any) => a.account_id === id)))
      throw Error('Unknown account selection');
    await mutateState(db, res.locals.owner, async (state, tx) => {
      await tx.query('SELECT id FROM connections WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
        c.id,
        res.locals.owner,
      ]);
      const current = await ownedConnection(tx, c.id, res.locals.owner);
      if (current.status === 'disconnected') throw Error('Connection is disconnected');
      if (current.item_id !== c.item_id || current.encrypted_token !== c.encrypted_token)
        throw Object.assign(Error('This connection changed. Reload Asset and try again.'), {
          status: 409,
        });
      await tx.query(
        "UPDATE connections SET selected_accounts=$1,cursor=NULL,status='initial_loading',error_code=NULL WHERE id=$2 AND owner_id=$3",
        [JSON.stringify(selected), c.id, res.locals.owner],
      );
      await invalidateSync(tx, c.id);
      await enqueueSync(tx, c.id);
      return state;
    });
    res.status(202).json({ status: 'queued' });
  });
  app.post('/api/plaid/:id/sync', async (req, res) => {
    const connection = await ownedConnection(db, req.params.id as string, res.locals.owner);
    if (connection.status === 'disconnected') throw Error('Connection is disconnected');
    await enqueueSync(db, connection.id);
    res.status(202).json({ status: 'queued' });
  });
  app.post('/api/plaid/:id/accounts', async (req, res) => {
    const selected = z.array(z.string()).parse(req.body.selected);
    const c = await ownedConnection(db, req.params.id as string, res.locals.owner);
    await mutateState(db, res.locals.owner, async (s, tx) => {
      await tx.query('SELECT id FROM connections WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
        c.id,
        res.locals.owner,
      ]);
      const current = await ownedConnection(tx, c.id, res.locals.owner);
      if (current.status === 'disconnected') throw Error('Connection is disconnected');
      if (current.item_id !== c.item_id || current.encrypted_token !== c.encrypted_token)
        throw Object.assign(Error('This connection changed. Reload Asset and try again.'), {
          status: 409,
        });
      const accounts = s.accounts.filter((a) => a.connectionId === c.id);
      if (selected.some((id) => !accounts.some((a) => a.providerId === id)))
        throw Error('Unknown account selection');
      for (const a of accounts) a.enabled = selected.includes(a.providerId!);
      await tx.query('UPDATE connections SET selected_accounts=$1 WHERE id=$2 AND owner_id=$3', [
        JSON.stringify(selected),
        c.id,
        res.locals.owner,
      ]);
      await invalidateSync(tx, c.id);
      await enqueueSync(tx, c.id);
      return s;
    });
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(
    (error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      res.status(error.status ?? (error instanceof PlaidError ? 503 : 400)).json({
        error:
          error instanceof z.ZodError
            ? error.issues.map((x) => x.message).join('; ')
            : error instanceof PlaidError
              ? error.code
              : (error.message ?? 'Request failed'),
      });
    },
  );
  return app;
}

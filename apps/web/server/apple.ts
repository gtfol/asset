import { Router } from 'express';
import { z } from 'zod';
import { mutateState, type Database } from './db.js';
import {
  appleAccountInput,
  appleBatchInput,
  applyAppleBatch,
  connectAppleAccount,
  removeAppleData,
} from '../shared/apple.js';
import { readToken, tokenHash } from './auth.js';
import { verificationStatus } from './security.js';
import type { StateScope } from './state-scope.js';

export function appleSyncScope(input: z.infer<typeof appleBatchInput>): StateScope {
  const balanceIDs = [...input.balances.map((b) => b.providerId), ...input.deletedBalances].map(
    (id) => `apple-balance-${input.accountId}-${id}`,
  );
  return {
    transactions: {
      providerIds: [...input.transactions.map((t) => t.providerId), ...input.deleted],
      amounts: [...new Set(input.transactions.map((t) => String(t.amount)))],
      amountAccountId: input.accountId,
    },
    snapshots: {
      ids: balanceIDs,
      latestAppleBalance: { accountId: input.accountId, excluding: balanceIDs },
    },
  };
}
export function appleConnectScope(input: z.infer<typeof appleAccountInput>): StateScope {
  // Linking only inspects accounts and the target's investment records.
  // Transaction history stays in the database until individual sync batches need it.
  return input.targetId ? {
    holdings: { accountId: input.targetId },
    investmentActivity: { accountId: input.targetId },
  } : {};
}
export function appleRoutes(db: Database) {
  const router = Router();
  router.get('/', async (req, res) => {
    const { rows } = await db.query<{ accounts: unknown[] }>(
      `SELECT COALESCE((SELECT jsonb_agg(a) FROM jsonb_array_elements(state->'accounts') a WHERE a->>'source'='financekit'),'[]'::jsonb) AS accounts FROM workspaces WHERE owner_id=$1`,
      [res.locals.owner],
    );
    res.json({
      available: process.env.FINANCEKIT_ENABLED === 'true',
      security: await verificationStatus(db, res.locals.owner, readToken(req) ?? ''),
      accounts: rows[0]?.accounts ?? [],
    });
  });
  router.post('/disconnect', async (req, res) => {
    const { accountId } = z.object({ accountId: z.string().max(160) }).parse(req.body);
    const result = await mutateState(
      db,
      res.locals.owner,
      async (state, tx) => {
        removeAppleData(state, accountId);
        // Notification records are derived data too; clear queued notifications on revocation.
        await tx.query('DELETE FROM notification_deliveries WHERE owner_id=$1', [res.locals.owner]);
        return state;
      },
      undefined,
      true,
    );
    res.json({ revision: result.revision });
  });
  router.use(async (req, res, next) => {
    if (process.env.FINANCEKIT_ENABLED !== 'true') {
      res.status(503).json({ error: 'Apple account syncing is not enabled on this server.' });
      return;
    }
    const security = await verificationStatus(db, res.locals.owner, readToken(req) ?? '');
    if (!security.enabled || !security.verified) {
      res.status(403).json({
        error: 'Set up an authenticator and verify this device before connecting Apple accounts.',
      });
      return;
    }
    const { rows } = await db.query<{ demo: boolean }>(
      `SELECT (state#>>'{settings,demo}')::boolean AS demo FROM workspaces WHERE owner_id=$1`,
      [res.locals.owner],
    );
    if (rows[0]?.demo) {
      res.status(403).json({ error: 'Sign in to connect Apple accounts.' });
      return;
    }
    next();
  });
  router.post('/connect', async (req, res) => {
    const input = appleAccountInput.parse(req.body);
    let accountId = '';
    const result = await mutateState(
      db,
      res.locals.owner,
      (state) => {
        accountId = connectAppleAccount(state, input, new Date().toISOString()).id;
        return state;
      },
      undefined,
      true,
      undefined,
      appleConnectScope(input),
    );
    res.json({ revision: result.revision, accountId });
  });
  router.post('/reset', async (req, res) => {
    const input = z
      .object({ accountId: z.string().max(160), deviceId: z.string().uuid() })
      .parse(req.body);
    const result = await mutateState(
      db,
      res.locals.owner,
      (state) => {
        const account = state.accounts.find(
          (a) => a.id === input.accountId && a.source === 'financekit',
        );
        if (!account?.financekit || account.financekit.deviceId !== input.deviceId)
          throw Error('Apple account is not linked to this device.');
        // Keep transaction edits and import provenance while rebuilding an expired
        // history cursor. Returned records reactivate by provider ID; missing ones
        // stay removed. Disconnect is the separate, explicit deletion action.
        for (const transaction of state.transactions)
          if (transaction.accountId === account.id && transaction.source === 'financekit')
            transaction.removed = true;
        state.snapshots = state.snapshots.filter(
          (snapshot) => snapshot.accountId !== account.id || snapshot.source !== 'financekit',
        );
        account.balance = null;
        account.financekit = {
          deviceId: input.deviceId,
          sequence: 0,
          consentAt: account.financekit.consentAt,
          original: account.financekit.original,
        };
        return state;
      },
      undefined,
      true,
    );
    res.json({ revision: result.revision });
  });
  router.post('/sync', async (req, res) => {
    const input = appleBatchInput.parse(req.body);
    const result = await mutateState(
      db,
      res.locals.owner,
      (state) => {
        applyAppleBatch(state, input, new Date().toISOString(), tokenHash(JSON.stringify(input)));
        return state;
      },
      undefined,
      true,
      undefined,
      appleSyncScope(input),
    );
    res.json({ revision: result.revision });
  });
  return router;
}

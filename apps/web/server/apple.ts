import { Router } from 'express';
import { z } from 'zod';
import { getState, mutateState, type Database } from './db.js';
import {
  appleAccountInput,
  appleBatchInput,
  applyAppleBatch,
  connectAppleAccount,
  removeAppleData,
} from '../shared/apple.js';
import { readToken, tokenHash } from './auth.js';
import { verificationStatus } from './security.js';
export function appleRoutes(db: Database) {
  const router = Router();
  router.get('/', async (req, res) => {
    const { state } = await getState(db, res.locals.owner);
    res.json({
      available: process.env.FINANCEKIT_ENABLED === 'true',
      security: await verificationStatus(db, res.locals.owner, readToken(req) ?? ''),
      accounts: state.accounts.filter((a) => a.source === 'financekit'),
    });
  });
  router.post('/disconnect', async (req, res) => {
    const { accountId } = z.object({ accountId: z.string().max(160) }).parse(req.body);
    res.json(
      await mutateState(
        db,
        res.locals.owner,
        async (state, tx) => {
          removeAppleData(state, accountId);
          // Notification records are derived data too; clear queued notifications on revocation.
          await tx.query('DELETE FROM notification_deliveries WHERE owner_id=$1', [
            res.locals.owner,
          ]);
          return state;
        },
        undefined,
        true,
      ),
    );
  });
  router.use(async (req, res, next) => {
    if (process.env.FINANCEKIT_ENABLED !== 'true') {
      res.status(503).json({ error: 'Apple account syncing is awaiting Apple approval.' });
      return;
    }
    const security = await verificationStatus(db, res.locals.owner, readToken(req) ?? '');
    if (!security.enabled || !security.verified) {
      res
        .status(403)
        .json({
          error: 'Set up an authenticator and verify this device before connecting Apple accounts.',
        });
      return;
    }
    const { state } = await getState(db, res.locals.owner);
    if (state.settings.demo) {
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
    );
    res.json({ ...result, accountId });
  });
  router.post('/reset', async (req, res) => {
    const input = z
      .object({ accountId: z.string().max(160), deviceId: z.string().uuid() })
      .parse(req.body);
    res.json(
      await mutateState(
        db,
        res.locals.owner,
        (state) => {
          const account = state.accounts.find(
            (a) => a.id === input.accountId && a.source === 'financekit',
          );
          if (!account?.financekit || account.financekit.deviceId !== input.deviceId)
            throw Error('Apple account is not linked to this device.');
          const saved = structuredClone(account);
          removeAppleData(state, account.id);
          state.accounts = state.accounts.filter((a) => a.id !== account.id);
          saved.balance = null;
          saved.financekit = {
            deviceId: input.deviceId,
            sequence: 0,
            consentAt: saved.financekit!.consentAt,
            original: saved.financekit!.original,
          };
          state.accounts.push(saved);
          return state;
        },
        undefined,
        true,
      ),
    );
  });
  router.post('/sync', async (req, res) => {
    const input = appleBatchInput.parse(req.body);
    res.json(
      await mutateState(
        db,
        res.locals.owner,
        (state) => {
          applyAppleBatch(state, input, new Date().toISOString(), tokenHash(JSON.stringify(input)));
          return state;
        },
        undefined,
        true,
      ),
    );
  });
  return router;
}

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import { openDatabase, getState, getSyncState, mutateState, type Database } from '../server/db';
import { newSession } from '../server/auth';
import { applyCommand } from '../shared/core';
import { newWorkspace, createLocalWorkspace, localCommand, assertWorkspaceChanges, mergeLocalWorkspace, workspaceSyncPath, workspaceUnchanged, type LocalWorkspace } from '../shared/workspace';
import { createDemo } from '../shared/demo';
import { Workspace, type WorkspaceStorage } from '../src/workspace';

const account = (id = 'checking', name = 'Checking') => ({ type: 'account.save', payload: {
  id, name, type: 'checking', currency: 'USD', balance: 12300, source: 'manual', updatedAt: '2026-10-18T12:00:00Z',
} });
class MemoryStorage implements WorkspaceStorage {
  data = new Map<string, unknown>();
  fail = false;
  writes = 0;
  locks = new Map<string, Promise<unknown>>();
  lock<T>(name: string, action: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(name) ?? Promise.resolve()).then(action);
    this.locks.set(name, next.catch(() => {})); return next;
  }
  async read(key: string) { return structuredClone(this.data.get(key)); }
  async write(values: Record<string, unknown>) {
    if (this.fail) throw Error('Storage is full');
    this.writes++;
    for (const [key, value] of Object.entries(values)) this.data.set(key, structuredClone(value));
  }
}
describe('local workspace synchronization', () => {
  let db: Database, server: Server, base: string;
  beforeAll(async () => {
    db = await openDatabase(':memory:'); server = createApp(db).listen(0, '127.0.0.1');
    await once(server, 'listening'); base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  }, 30000);
  afterAll(async () => { await new Promise<void>(r => server.close(() => r())); await db.close(); });
  async function identity() {
    const owner = randomUUID();
    await db.query('INSERT INTO users(id,email) VALUES($1,$2)', [owner, owner + '@example.invalid']);
    await db.query('INSERT INTO workspaces(owner_id,state) VALUES($1,$2)', [owner, JSON.stringify(newWorkspace())]);
    const token = await newSession(db, owner, { cookie() {} } as any);
    const api = async (path: string, body?: unknown) => {
      const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-asset-client': 'web', authorization: 'Bearer ' + token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await r.json();
      if (!r.ok) throw Object.assign(Error(data.error), { status: r.status, code: data.code });
      return data;
    };
    return { owner, api };
  }
  it('returns only metadata for a matching owner/version, including on the database connection', async () => {
    const { owner, api } = await identity();
    await db.query('UPDATE workspaces SET state=$1 WHERE owner_id=$2', [JSON.stringify(createDemo('2026-10-15')), owner]);
    const full = await api('/state');
    const known = { owner, revision: full.revision };
    const unchanged = await api(workspaceSyncPath(known));
    expect(unchanged).toMatchObject({ ownerId: owner, revision: full.revision, unchanged: true, connections: [] });
    expect(unchanged).not.toHaveProperty('state');
    expect(unchanged.sessionId).toBe(full.sessionId);
    let transferred = '';
    const result = await getSyncState({ query: async (sql, params) => {
      const result = await db.query(sql, params); transferred = JSON.stringify(result.rows); return result;
    } }, owner, { ownerId: owner, revision: full.revision });
    expect(result).toEqual({ unchanged: true, revision: full.revision });
    expect(transferred).not.toContain('transactions');
    expect(transferred.length).toBeLessThan(100);
    expect(JSON.stringify(unchanged).length).toBeLessThan(JSON.stringify(full).length / 100);
    for (const query of [`?ownerId=${owner}&revision=99`, '?ownerId=different-owner&revision=0']) {
      expect(await api('/state' + query)).toHaveProperty('state');
    }
    await expect(api(`/state?ownerId=${owner}&revision=-1`)).rejects.toMatchObject({ status: 400 });
    await expect(api('/state?revision=0')).rejects.toMatchObject({ status: 400 });
    expect((await fetch(base + workspaceSyncPath(known))).status).toBe(401);
  });
  it('keeps an unchanged local copy across repeated checks and reloads, then receives another device’s edit', async () => {
    const { owner, api } = await identity(), storage = new MemoryStorage();
    const responses: any[] = [];
    const tracked = async (path: string, body?: unknown) => {
      const response = await api(path, body); responses.push(response); return response;
    };
    const app = new Workspace(tracked, () => {}, storage); await app.open(); await app.sync();
    const writes = storage.writes;
    for (let i = 0; i < 3; i++) await app.sync();
    expect(storage.writes).toBe(writes);
    expect(responses.slice(1).every(r => r.unchanged && !r.state)).toBe(true);
    const reopened = new Workspace(tracked, () => {}, storage); await reopened.open(); await reopened.sync();
    expect(responses.at(-1)).toMatchObject({ unchanged: true });
    expect(reopened.status).toBe('Synced'); expect(reopened.metadata.sessionId).toBeTruthy();
    await mutateState(db, owner, state => applyCommand(state, account('other-device')));
    await reopened.sync();
    expect(reopened.doc.state.accounts[0].id).toBe('other-device');
    await reopened.sync(); expect(responses.at(-1)).toMatchObject({ unchanged: true });
    await reopened.command(account('this-device')); await reopened.sync();
    expect(reopened.doc.pending).toHaveLength(0);
    expect((await getState(db, owner)).state.accounts).toHaveLength(2);
  });
  it('refreshes connection status without re-downloading financial records', async () => {
    const { owner, api } = await identity();
    const first = await api('/state');
    await db.query(`INSERT INTO connections(id,owner_id,item_id,institution_id,institution_name,encrypted_token,product,status)
      VALUES($1,$2,$1,$1,'Test Bank','encrypted','transactions','healthy')`, [randomUUID(), owner]);
    const r = await api(workspaceSyncPath({ owner, revision: first.revision }));
    expect(r.unchanged).toBe(true); expect(r.connections[0].institution_name).toBe('Test Bank');
    expect(r).not.toHaveProperty('state');
  });
  it('does not suppress the first download when the authenticated account has the same version', async () => {
    const first = await identity(), second = await identity();
    let current = first.api;
    const app = new Workspace((p, b) => current(p, b), () => {}, new MemoryStorage());
    await app.open(); await app.sync();
    current = second.api; await app.sync();
    expect(app.doc.owner).toBe(second.owner); expect(app.doc.revision).toBe(0);
    expect(app.metadata.ownerId).toBe(second.owner);
  });
  it('rejects mismatched unchanged responses and always loads initial/legacy workspaces', () => {
    expect(workspaceSyncPath({ owner: null, revision: 0 })).toBe('/state');
    expect(workspaceSyncPath({ owner: 'legacy', revision: 0 })).toBe('/state');
    for (const response of [{ ownerId: 'other', revision: 1 }, { ownerId: 'owner', revision: 2 }])
      expect(() => workspaceUnchanged({ owner: 'owner', revision: 1 }, { ...response, unchanged: true })).toThrow('saved version');
  });
  it('does not create revisions for no-op updates and still acknowledges/retries the operation', async () => {
    const { owner, api } = await identity();
    const first = await mutateState(db, owner, state => applyCommand(state, account()));
    const unchanged = await mutateState(db, owner, state => state);
    expect(unchanged.revision).toBe(first.revision);
    const local = localCommand({ ...createLocalWorkspace(randomUUID()), owner, ...first }, account(), randomUUID());
    const request = { ownerId: owner, operation: local.pending[0] };
    expect((await api('/sync/command', request)).revision).toBe(first.revision);
    expect((await api('/sync/command', request)).revision).toBe(first.revision);
    expect((await db.query('SELECT id FROM workspace_operations WHERE owner_id=$1', [owner])).rows).toHaveLength(1);
  });
  it('opens locally, persists edits across reloads, and never invents demo records', async () => {
    const storage = new MemoryStorage();
    const noSession = async () => { throw Object.assign(Error('Sign in'), { status: 401 }); };
    const app = new Workspace(noSession, () => {}, storage); await app.open(); await app.sync();
    expect(app.doc.state.accounts).toEqual([]); expect(app.doc.state.settings.demo).toBe(false);
    await app.command(account());
    const reopened = new Workspace(noSession, () => {}, storage); await reopened.open();
    expect(reopened.doc.state.accounts[0].balance).toBe(12300);
    storage.fail = true;
    await expect(reopened.command(account('other'))).rejects.toThrow('Storage is full');
    expect(reopened.doc.state.accounts).toHaveLength(1);
  });
  it('adds local records to an existing cloud account without replacing its records', async () => {
    const { owner, api } = await identity();
    const cloud = applyCommand(newWorkspace(), account('cloud', 'Cloud account'));
    await db.query('UPDATE workspaces SET state=$1 WHERE owner_id=$2', [JSON.stringify(cloud), owner]);
    const app = new Workspace(api, () => {}, new MemoryStorage()); await app.open();
    await app.command(account()); await app.sync();
    expect(app.doc.state.accounts.map(a => a.name).sort()).toEqual(['Checking', 'Cloud account']);
    expect(app.doc.pending).toEqual([]);
    await app.sync(); expect((await getState(db, owner)).state.accounts).toHaveLength(2);
  });
  it('clears cloud controls after access is restricted and preserves pending local edits', async () => {
    const { api } = await identity();
    let restricted = false;
    const app = new Workspace((path, body) => restricted
      ? Promise.reject(Object.assign(Error('Cloud access restricted'), { status: 403, code: 'ACCESS_RESTRICTED' }))
      : api(path, body), () => {}, new MemoryStorage());
    await app.open(); await app.sync();
    expect(app.metadata.sessionId).toBeTruthy();
    restricted = true;
    await app.command(account()); await app.sync();
    expect(app.metadata).toEqual({});
    expect(app.doc.state.accounts).toHaveLength(1);
    expect(app.doc.pending).toHaveLength(1);
    expect(app.status).toBe('Saved here · cloud access is restricted');
  });
  it('retries a committed operation after a lost response and restart without duplicates', async () => {
    const { owner, api } = await identity(); const storage = new MemoryStorage();
    let drop = true;
    const unreliable = async (path: string, body?: unknown) => {
      const result = await api(path, body);
      if (path === '/sync/command' && drop) { drop = false; throw Error('Connection lost'); }
      return result;
    };
    const app = new Workspace(unreliable, () => {}, storage); await app.open(); await app.sync();
    await app.command(account()); await app.sync();
    expect(app.doc.pending).toHaveLength(1);
    const reopened = new Workspace(api, () => {}, storage); await reopened.open(); await reopened.sync();
    expect(reopened.doc.pending).toHaveLength(0);
    expect((await getState(db, owner)).state.accounts).toHaveLength(1);
  });
  it('queues signed-in changes offline and keeps them isolated from another account', async () => {
    const first = await identity(), other = await identity(), storage = new MemoryStorage();
    let api = first.api; let offline = false;
    const app = new Workspace((p, b) => offline ? Promise.reject(Error('Offline')) : api(p, b), () => {}, storage);
    await app.open(); await app.sync(); offline = true;
    await app.command(account()); await app.sync();
    const operation = app.doc.pending[0]; expect(operation).toBeDefined();
    await expect(other.api('/sync/command', { ownerId: first.owner, operation })).rejects.toMatchObject({ status: 409 });
    offline = false; api = other.api; await app.sync();
    expect(app.doc.state.accounts).toHaveLength(0);
    api = first.api; await app.sync();
    expect(app.doc.state.accounts).toHaveLength(1); expect(app.doc.pending).toHaveLength(0);
    expect((await getState(db, other.owner)).state.accounts).toHaveLength(0);
  });
  it('merges independent edits and preserves conflicting edits for resolution', async () => {
    const { owner, api } = await identity();
    const state = applyCommand(newWorkspace(), account());
    await db.query('UPDATE workspaces SET state=$1 WHERE owner_id=$2', [JSON.stringify(state), owner]);
    let local: LocalWorkspace = { ...createLocalWorkspace(randomUUID()), owner, state };
    local = localCommand(local, account('checking', 'My name'), randomUUID());
    const operation = local.pending[0];
    let remote = applyCommand(state, { type: 'settings.save', payload: { currency: 'EUR' } });
    assertWorkspaceChanges(remote, operation.changes);
    remote = applyCommand(remote, account('checking', 'Other name'));
    await db.query('UPDATE workspaces SET state=$1 WHERE owner_id=$2', [JSON.stringify(remote), owner]);
    await expect(api('/sync/command', { ownerId: owner, operation })).rejects.toMatchObject({ status: 409, code: 'SYNC_CONFLICT' });
    expect((await getState(db, owner)).state.accounts[0].name).toBe('Other name');
  });
  it('rejects demo/provider data and corrupt storage without overwriting it', async () => {
    expect(() => mergeLocalWorkspace(newWorkspace(), { ...newWorkspace(), settings: { ...newWorkspace().settings, demo: true } }, randomUUID())).toThrow();
    const storage = new MemoryStorage(); storage.data.set('guest', { broken: true });
    const app = new Workspace(async () => {}, () => {}, storage);
    await expect(app.open()).rejects.toThrow(); expect(await storage.read('guest')).toEqual({ broken: true });
  });
  it('preserves simultaneous tab edits and rejects a stale full-record form', async () => {
    const storage = new MemoryStorage(), offline = async () => { throw Error('Offline'); };
    const a = new Workspace(offline, () => {}, storage), b = new Workspace(offline, () => {}, storage);
    await Promise.all([a.open(), b.open()]);
    await Promise.all([a.command(account('one')), b.command(account('two'))]);
    await a.sync(); await b.sync();
    expect(a.doc.state.accounts).toHaveLength(2);
    const old = account('one', 'Old tab name');
    await a.command({ ...account('one'), payload: { ...account('one').payload, balance: 98700 } });
    await expect(b.command(old)).rejects.toThrow('overlaps');
    await b.sync(); expect(b.doc.state.accounts.find(a => a.id === 'one')?.balance).toBe(98700);
  });
  it('keeps local preferences and custom categories when signing in to an empty account', async () => {
    const { api } = await identity();
    const app = new Workspace(api, () => {}, new MemoryStorage()); await app.open();
    await app.command({ type: 'settings.save', payload: { currency: 'EUR' } });
    await app.command({ type: 'category.save', payload: { id: 'custom', name: 'Cycling', icon: 'activity', group: 'Everyday', color: '#123456', archived: false } });
    await app.sync();
    expect(app.doc.state.settings.currency).toBe('EUR');
    expect(app.doc.state.categories.some(c => c.name === 'Cycling')).toBe(true);
  });
  it('replays a delayed import with its original timestamp before later account edits', async () => {
    const { owner, api } = await identity();
    let local: LocalWorkspace = { ...createLocalWorkspace(randomUUID()), owner };
    local = localCommand(local, { type: 'import.copilot', payload: {
      text: 'date,name,amount,status,category,excluded,type,account,account mask\n2020-01-01,Cafe,12.34,posted,Food,false,regular,Checking,1234',
      options: { currency: 'USD' },
    } }, randomUUID());
    const imported = local.state.accounts[0];
    local = localCommand(local, { type: 'account.save', payload: { ...imported, name: 'Personal checking' } }, randomUUID());
    for (const operation of local.pending) await api('/sync/command', { ownerId: owner, operation });
    expect((await getState(db, owner)).state.accounts[0].name).toBe('Personal checking');
  });
});

import { applyCommand, backup, type Command } from '../shared/core';
import { assertWorkspaceChanges, createLocalWorkspace, hasLocalRecords, localCommand, receiveWorkspace, validateLocalWorkspace, workspaceChanges,
  type LocalWorkspace } from '../shared/workspace';

type API = (path: string, body?: unknown) => Promise<any>;
const open = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('asset-workspaces', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('workspaces');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(Error('Device storage could not be opened. Your saved data has not been changed.'));
});
export interface WorkspaceStorage {
  read(key: string): Promise<unknown>;
  write(values: Record<string, unknown>): Promise<void>;
  lock?<T>(name: string, action: () => Promise<T>): Promise<T>;
}
export const deviceStorage: WorkspaceStorage = {
  async lock(name, action) {
    if (!navigator.locks) throw Error('Update your browser to save your workspace safely.');
    return navigator.locks.request('asset-' + name, action);
  },
  async read(key) {
    const db = await open();
    try { return await new Promise((resolve, reject) => {
      const r = db.transaction('workspaces').objectStore('workspaces').get(key);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    }); } finally { db.close(); }
  },
  async write(values) {
    const db = await open();
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('workspaces', 'readwrite');
      for (const [key, value] of Object.entries(values)) tx.objectStore('workspaces').put(value, key);
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(Error('Changes could not be saved on this device. Free some storage and try again.'));
    }); } finally { db.close(); }
  },
};

export class Workspace {
  doc!: LocalWorkspace;
  metadata: any = {};
  status = 'Saved on this device';
  conflict = false;
  private serial = Promise.resolve();
  private syncing?: Promise<void>;
  private generation = 0;
  constructor(private api: API, private changed: () => void, private storage = deviceStorage) {}
  async open() {
    await this.lock('storage', async () => {
    const active = await this.storage.read('active');
    const saved = await this.storage.read(typeof active === 'string' ? active : 'guest');
    this.doc = saved ? validateLocalWorkspace(saved) : createLocalWorkspace(crypto.randomUUID());
    await this.save(this.doc);
    });
  }
  private lock<T>(name: string, action: () => Promise<T>) { return this.storage.lock ? this.storage.lock(name, action) : action(); }
  private async save(doc: LocalWorkspace, extra: Record<string, unknown> = {}) {
    const key = doc.owner ?? 'guest';
    await this.storage.write({ [key]: doc, active: key, ...extra });
    this.doc = doc;
    this.changed();
  }
  private mutate(fn: () => Promise<void>) {
    const result = this.serial.then(() => this.lock('storage', async () => {
      const active = await this.storage.read('active');
      const saved = await this.storage.read(typeof active === 'string' ? active : 'guest');
      if (saved) {
        const next = validateLocalWorkspace(saved);
        if (next.owner !== this.doc.owner) { this.metadata = {}; this.conflict = false; }
        this.doc = next;
      }
      await fn();
    }));
    this.serial = result.catch(() => {});
    return result;
  }
  async command(command: Command) {
    const previous = this.doc;
    if (command.type === 'backup.restore' && this.doc.owner) {
      await this.sync();
      if (this.doc.pending.length) throw Error('Sync your saved changes before restoring a backup.');
      const r = await this.api('/command', { ...command, revision: this.doc.revision, ownerId: this.doc.owner });
      await this.accept(r);
      return;
    }
    await this.mutate(async () => {
      if (previous.owner !== this.doc.owner) throw Error('Your sign-in changed in another tab. Open the current workspace before editing.');
      assertWorkspaceChanges(this.doc.state, workspaceChanges(previous.state, applyCommand(previous.state, command)));
      await this.save(localCommand(this.doc, command, crypto.randomUUID()));
      this.status = this.doc.owner ? 'Changes saved · syncing' : 'Saved on this device';
      this.changed();
    });
    if (this.doc.owner) void this.sync();
  }
  async accept(remote: any) {
    const owner = this.doc.owner;
    await this.mutate(async () => {
      if (owner !== this.doc.owner) throw Error('Your sign-in changed in another tab. Refresh this workspace.');
      if (remote.revision >= this.doc.revision) await this.save(receiveWorkspace(this.doc, remote));
    });
  }
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    const generation = this.generation;
    const current = this.lock('sync', () => this.pullAndPush(generation)).finally(() => {
      if (this.syncing === current) this.syncing = undefined;
    });
    this.syncing = current;
    return current;
  }
  private async pullAndPush(generation: number) {
    try {
      await this.mutate(async () => { this.changed(); });
      const remote = await this.api('/state');
      if (generation !== this.generation) return;
      if (remote.state.settings.demo) {
        await this.api('/auth/logout', {});
        this.metadata = {}; this.status = 'Saved on this device'; this.changed(); return;
      }
      if (!remote.ownerId) throw Error('Sync is updating. Your changes are saved on this device.');
      await this.mutate(async () => {
        if (generation !== this.generation) return;
        if (this.doc.owner !== remote.ownerId) {
          const guest = this.doc.owner === null ? this.doc : undefined;
          const previous = await this.storage.read(remote.ownerId);
          const cached = previous ? validateLocalWorkspace(previous) : undefined;
          let next = cached ? cached.pending.length ? cached : receiveWorkspace(cached, remote) : {
            ...createLocalWorkspace(crypto.randomUUID()), owner: remote.ownerId, state: remote.state, revision: remote.revision,
          };
          if (guest && hasLocalRecords(guest.state)) {
            next = localCommand(next, { type: 'workspace.merge', payload: { state: guest.state, id: guest.id } }, guest.id);
          }
          // Ownership and the pending merge are committed together, before clearing the guest.
          await this.save(next, guest ? { guest: createLocalWorkspace(crypto.randomUUID()), ['recovery-' + guest.id]: guest } : {});
        } else if (!this.doc.pending.length && remote.revision >= this.doc.revision) await this.save(receiveWorkspace(this.doc, remote));
        this.metadata = remote;
      });
      while (generation === this.generation && this.doc.owner === remote.ownerId && this.doc.pending.length) {
        const owner = this.doc.owner, operation = this.doc.pending[0];
        const result = await this.api('/sync/command', { ownerId: owner, operation });
        await this.mutate(async () => {
          if (generation === this.generation && owner === this.doc.owner)
            await this.save(receiveWorkspace(this.doc, result, operation.id));
        });
      }
      this.conflict = false;
      this.status = 'Synced';
    } catch (e: any) {
      if (generation !== this.generation) return;
      this.conflict = e.status === 409 || (e.status === 400 && this.doc.pending.length > 0);
      this.status = this.conflict ? e.message : !this.doc.owner ? 'Saved on this device' : e.status === 401
        ? this.doc.owner ? 'Saved here · sign in to sync' : 'Saved on this device'
        : 'Saved here · sync paused';
      if (e.status === 401) this.metadata = {};
    }
    this.changed();
  }
  async signOut() {
    return this.lock('sync', async () => {
    await this.mutate(async () => {
    if (this.doc.pending.length) throw Error('Sync your saved changes before signing out. You can export a backup in Settings.');
    await this.api('/auth/logout', {});
    this.generation++;
      const guest = await this.storage.read('guest');
      // Remove the signed-in cache from this browser on explicit sign-out.
      const previousOwner = this.doc.owner;
      await this.save(guest ? validateLocalWorkspace(guest) : createLocalWorkspace(crypto.randomUUID()), previousOwner ? { [previousOwner]: null } : {});
      this.metadata = {}; this.status = 'Saved on this device'; this.conflict = false;
    });
    this.changed();
    });
  }
  async useSyncedChanges() {
    return this.lock('sync', async () => {
    const remote = await this.api('/state');
    if (remote.ownerId !== this.doc.owner) throw Error('Sign in with the same Google account to resolve these changes.');
    await this.mutate(async () => {
      if (remote.ownerId !== this.doc.owner) throw Error('Your sign-in changed in another tab.');
      await this.save({ ...this.doc, state: remote.state, revision: remote.revision, pending: [] },
        { ['recovery-' + crypto.randomUUID()]: backup(this.doc.state) });
      this.conflict = false; this.status = 'Synced';
    });
    this.changed();
    });
  }
}

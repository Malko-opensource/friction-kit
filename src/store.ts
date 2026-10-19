import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { RunStore, WorkflowSnapshot } from './types.js';

export class RevisionConflictError extends Error {
  constructor(id: string) {
    super(`Workflow ${id} already exists or its revision changed. Reload before retrying.`);
    this.name = 'RevisionConflictError';
  }
}

function validateRevision(snapshot: WorkflowSnapshot, expectedRevision?: number): void {
  if (!snapshot.id?.trim() || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new Error('A snapshot needs a nonempty id and a nonnegative integer revision.');
  }
  if (expectedRevision === undefined ? snapshot.revision !== 0 :
    !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || snapshot.revision !== expectedRevision + 1) {
    throw new Error('Create requires revision 0; save requires expectedRevision + 1.');
  }
}

export class MemoryStore implements RunStore {
  private readonly snapshots = new Map<string, WorkflowSnapshot>();

  create(snapshot: WorkflowSnapshot): void {
    validateRevision(snapshot);
    if (this.snapshots.has(snapshot.id)) throw new RevisionConflictError(snapshot.id);
    this.snapshots.set(snapshot.id, structuredClone(snapshot));
  }

  load(id: string): WorkflowSnapshot | undefined {
    const snapshot = this.snapshots.get(id);
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  }

  save(snapshot: WorkflowSnapshot, expectedRevision: number): void {
    validateRevision(snapshot, expectedRevision);
    if (this.snapshots.get(snapshot.id)?.revision !== expectedRevision) {
      throw new RevisionConflictError(snapshot.id);
    }
    this.snapshots.set(snapshot.id, structuredClone(snapshot));
  }
}

/** SQLite stores an entire workflow and its revision in one atomic row update. */
export class SQLiteStore implements RunStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (!path.trim()) throw new Error('SQLite path is required.');
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS friction_runs (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      snapshot TEXT NOT NULL
    )`);
  }

  create(snapshot: WorkflowSnapshot): void {
    validateRevision(snapshot);
    const result = this.db.prepare(
      'INSERT OR IGNORE INTO friction_runs (id, revision, snapshot) VALUES (?, ?, ?)',
    ).run(snapshot.id, snapshot.revision, JSON.stringify(snapshot));
    if (Number(result.changes) !== 1) throw new RevisionConflictError(snapshot.id);
  }

  load(id: string): WorkflowSnapshot | undefined {
    const row = this.db.prepare('SELECT snapshot FROM friction_runs WHERE id = ?').get(id);
    return row === undefined ? undefined : JSON.parse(String(row.snapshot)) as WorkflowSnapshot;
  }

  save(snapshot: WorkflowSnapshot, expectedRevision: number): void {
    validateRevision(snapshot, expectedRevision);
    const result = this.db.prepare(
      'UPDATE friction_runs SET revision = ?, snapshot = ? WHERE id = ? AND revision = ?',
    ).run(snapshot.revision, JSON.stringify(snapshot), snapshot.id, expectedRevision);
    if (Number(result.changes) !== 1) throw new RevisionConflictError(snapshot.id);
  }

  close(): void {
    this.db.close();
  }
}

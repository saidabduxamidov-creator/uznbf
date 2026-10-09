/**
 * SQLite access through Node's built-in `node:sqlite` (no native addon to build or ship).
 * WAL mode lets the separate server processes started by each MCP client share one database.
 * Statements are cached; migrations are versioned and applied transactionally at startup.
 *
 * The driver is synchronous. Every statement here is a small indexed read/write (microseconds),
 * which is cheaper than a thread hop; bulk work does not belong in this database.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { InternalError } from "@lmp/core";

type SqliteModule = typeof import("node:sqlite");
type DatabaseSync = InstanceType<SqliteModule["DatabaseSync"]>;
type StatementSync = ReturnType<DatabaseSync["prepare"]>;
export type SqlValue = null | number | bigint | string | Uint8Array;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

let sqliteModule: SqliteModule | undefined;

/** Loads node:sqlite lazily so the experimental-feature warning can be filtered first. */
export async function loadSqlite(): Promise<SqliteModule> {
  sqliteModule ??= await import("node:sqlite");
  return sqliteModule;
}

export class SqliteDatabase {
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;

  private constructor(private readonly db: DatabaseSync, readonly file: string) {}

  static async open(file: string): Promise<SqliteDatabase> {
    const { DatabaseSync } = await loadSqlite();
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    const instance = new SqliteDatabase(db, file);
    instance.exec("PRAGMA busy_timeout = 5000");
    if (file !== ":memory:") instance.exec("PRAGMA journal_mode = WAL");
    instance.exec("PRAGMA synchronous = NORMAL");
    instance.exec("PRAGMA foreign_keys = ON");
    return instance;
  }

  exec(sql: string): void {
    this.assertOpen();
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): { readonly changes: number; readonly lastInsertRowid: number | bigint } {
    const result = this.statement(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  /** Runs `fn` in an IMMEDIATE transaction (takes the write lock up front to avoid upgrade deadlocks). */
  transaction<T>(fn: () => T): T {
    this.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.exec("ROLLBACK");
      } catch {
        /* the original error matters */
      }
      throw error;
    }
  }

  migrate(migrations: readonly Migration[]): number {
    this.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    let applied = 0;
    for (const migration of sorted) {
      this.transaction(() => {
        // Re-check inside the lock: another server process may have migrated concurrently.
        if (this.get("SELECT version FROM schema_migrations WHERE version = ?", migration.version)) return;
        this.exec(migration.sql);
        this.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", migration.version, migration.name, Date.now());
        applied++;
      });
    }
    return applied;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  private statement(sql: string): StatementSync {
    this.assertOpen();
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      if (this.statements.size >= 256) this.statements.clear();
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  private assertOpen(): void {
    if (this.closed) throw new InternalError("Database is closed");
  }
}

import type { Migration } from "./sqlite.js";

export const PLATFORM_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "audit, jobs, kv",
    sql: `
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        tool TEXT NOT NULL,
        request_id TEXT NOT NULL,
        client TEXT NOT NULL,
        kind TEXT NOT NULL,
        target TEXT,
        effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
        rule TEXT NOT NULL
      );
      CREATE INDEX audit_log_ts ON audit_log (ts);

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        client TEXT NOT NULL,
        request_id TEXT NOT NULL,
        resource_class TEXT NOT NULL,
        state TEXT NOT NULL,
        pid INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        error_code TEXT,
        error_message TEXT
      );
      CREATE INDEX jobs_created ON jobs (created_at);

      CREATE TABLE kv (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, key)
      ) WITHOUT ROWID;
    `,
  },
];

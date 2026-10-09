/**
 * Repositories over the platform database. Each owns one table; nothing else issues SQL.
 */
import type { Clock, KeyValueStore } from "@lmp/core";
import type { AuditSink } from "../permissions/gate.js";
import type { JobSnapshot } from "../queue.js";
import type { SqliteDatabase } from "./sqlite.js";

export interface AuditRecord {
  readonly ts: number;
  readonly tool: string;
  readonly requestId: string;
  readonly client: string;
  readonly kind: string;
  readonly target: string | null;
  readonly effect: "allow" | "deny";
  readonly rule: string;
}

export class AuditRepository implements AuditSink {
  constructor(private readonly db: SqliteDatabase, private readonly clock: Clock) {}

  record(entry: Omit<AuditRecord, "ts">): void {
    this.db.run(
      "INSERT INTO audit_log (ts, tool, request_id, client, kind, target, effect, rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      this.clock.now(), entry.tool, entry.requestId, entry.client, entry.kind, entry.target, entry.effect, entry.rule,
    );
  }

  recent(limit: number): AuditRecord[] {
    return this.db.all<AuditRecord>(
      "SELECT ts, tool, request_id AS requestId, client, kind, target, effect, rule FROM audit_log ORDER BY id DESC LIMIT ?",
      Math.max(1, Math.min(1000, Math.trunc(limit))),
    );
  }

  pruneOlderThan(cutoffMs: number): number {
    return this.db.run("DELETE FROM audit_log WHERE ts < ?", cutoffMs).changes;
  }
}

export interface StoredJob {
  readonly id: string;
  readonly tool: string;
  readonly client: string;
  readonly requestId: string;
  readonly resourceClass: string;
  readonly state: string;
  readonly pid: number;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export class JobRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(job: JobSnapshot): void {
    this.db.run(
      `INSERT INTO jobs (id, tool, client, request_id, resource_class, state, pid, created_at, started_at, finished_at, error_code, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, started_at = excluded.started_at, finished_at = excluded.finished_at,
         error_code = excluded.error_code, error_message = excluded.error_message`,
      job.id, job.tool, job.client, job.requestId, job.resourceClass, job.state, process.pid, job.createdAt,
      job.startedAt ?? null, job.finishedAt ?? null, job.error?.code ?? null, job.error?.message ?? null,
    );
  }

  /** Jobs left queued/running by a process that no longer exists become "interrupted". */
  markOrphansInterrupted(isAlive: (pid: number) => boolean, now: number): number {
    const open = this.db.all<{ id: string; pid: number }>("SELECT id, pid FROM jobs WHERE state IN ('queued', 'running')");
    let count = 0;
    for (const row of open) {
      if (isAlive(row.pid)) continue;
      count += this.db.run(
        "UPDATE jobs SET state = 'interrupted', finished_at = ?, error_code = 'CANCELLED', error_message = 'The server stopped before the job finished.' WHERE id = ?",
        now, row.id,
      ).changes;
    }
    return count;
  }

  recent(limit: number): StoredJob[] {
    return this.db.all<StoredJob>(
      `SELECT id, tool, client, request_id AS requestId, resource_class AS resourceClass, state, pid, created_at AS createdAt,
              started_at AS startedAt, finished_at AS finishedAt, error_code AS errorCode, error_message AS errorMessage
       FROM jobs ORDER BY created_at DESC LIMIT ?`,
      Math.max(1, Math.min(1000, Math.trunc(limit))),
    );
  }

  pruneOlderThan(cutoffMs: number): number {
    return this.db.run("DELETE FROM jobs WHERE created_at < ? AND state NOT IN ('queued', 'running')", cutoffMs).changes;
  }
}

const MAX_KEY = 512;
const MAX_VALUE_BYTES = 1024 * 1024;

export class KeyValueRepository {
  constructor(private readonly db: SqliteDatabase, private readonly clock: Clock) {}

  scope(namespace: string): KeyValueStore {
    const check = (key: string) => {
      if (key.length === 0 || key.length > MAX_KEY) throw new RangeError(`Key length must be 1..${MAX_KEY}`);
    };
    return {
      get: async <T>(key: string) => {
        check(key);
        const row = this.db.get<{ value: string }>("SELECT value FROM kv WHERE namespace = ? AND key = ?", namespace, key);
        return row ? (JSON.parse(row.value) as T) : undefined;
      },
      set: async (key, value) => {
        check(key);
        const json = JSON.stringify(value);
        if (json === undefined) throw new TypeError("Value must be JSON-serializable");
        if (Buffer.byteLength(json) > MAX_VALUE_BYTES) throw new RangeError("Value exceeds 1 MiB");
        this.db.run(
          "INSERT INTO kv (namespace, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          namespace, key, json, this.clock.now(),
        );
      },
      delete: async (key) => {
        check(key);
        return this.db.run("DELETE FROM kv WHERE namespace = ? AND key = ?", namespace, key).changes > 0;
      },
      keys: async (prefix = "") => {
        const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
        return this.db
          .all<{ key: string }>("SELECT key FROM kv WHERE namespace = ? AND key LIKE ? ESCAPE '\\' ORDER BY key LIMIT 10000", namespace, `${escaped}%`)
          .map((r) => r.key);
      },
    };
  }
}

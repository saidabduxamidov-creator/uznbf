/**
 * Runs SQLite statements in a short-lived child Node process. node:sqlite is synchronous and a
 * worker thread cannot be stopped while SQLite's native code runs, so a runaway query would pin a
 * thread for ever; a child process can always be killed on cancel or timeout.
 *
 * The child's source is an inline script so the package keeps working when bundled.
 */
import { CancelledError, ExternalProcessError, ValidationError } from "@lmp/core";
import { runProcess } from "@lmp/toolkit";

export type Cell = null | number | string | { readonly blob: number };

export interface QueryRequest {
  readonly file: string;
  readonly readOnly: boolean;
  readonly sql: string;
  readonly params: readonly (string | number | null)[] | Readonly<Record<string, string | number | null>>;
  readonly maxRows: number;
  /** Script mode: several statements, no parameters, executed in one transaction. */
  readonly script: boolean;
}

export interface QueryResponse {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
  readonly truncated: boolean;
  readonly changes: number;
  readonly lastInsertRowid: number | string | null;
}

const CHILD_SOURCE = `
const { DatabaseSync } = require("node:sqlite");
const send = (m) => process.stdout.write(JSON.stringify(m));
const cell = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return { blob: v.length };
  return v;
};
const r = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
let db;
try {
  db = new DatabaseSync(r.file, { readOnly: r.readOnly });
  db.exec("PRAGMA busy_timeout = 5000");
  if (r.script) {
    const before = db.prepare("SELECT total_changes() AS n").get().n;
    db.exec("BEGIN IMMEDIATE");
    try { db.exec(r.sql); db.exec("COMMIT"); } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
    const after = db.prepare("SELECT total_changes() AS n").get().n;
    send({ ok: true, columns: [], rows: [], truncated: false, changes: Number(after) - Number(before), lastInsertRowid: null });
  } else {
    const st = db.prepare(r.sql);
    st.setReadBigInts(true);
    st.setReturnArrays(true);
    const columns = st.columns().map((c) => c.name);
    const params = Array.isArray(r.params) ? r.params : [r.params];
    if (columns.length > 0) {
      const rows = [];
      let truncated = false;
      for (const row of st.iterate(...params)) {
        if (rows.length >= r.maxRows) { truncated = true; break; }
        rows.push(row.map(cell));
      }
      send({ ok: true, columns, rows, truncated, changes: 0, lastInsertRowid: null });
    } else {
      const res = st.run(...params);
      send({ ok: true, columns: [], rows: [], truncated: false, changes: Number(res.changes), lastInsertRowid: cell(res.lastInsertRowid) });
    }
  }
} catch (e) {
  send({ ok: false, message: String((e && e.message) || e), code: e && e.code });
} finally {
  try { db && db.close(); } catch {}
}
`;

/** Removes string literals, quoted identifiers and comments, leaving only SQL keywords to inspect. */
export function stripSqlLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Statements that would reach files other than the one the permission was granted for are
 * rejected: ATTACH/DETACH, VACUUM INTO and extension loading.
 */
export function assertContained(sql: string): void {
  const bare = stripSqlLiterals(sql);
  if (/\b(ATTACH|DETACH)\b/i.test(bare)) throw new ValidationError("ATTACH and DETACH are not allowed; open each database with its own call.");
  if (/\bVACUUM\b[\s\S]*\bINTO\b/i.test(bare)) throw new ValidationError("VACUUM INTO is not allowed.");
  if (/\bload_extension\b/i.test(bare)) throw new ValidationError("Loading SQLite extensions is not allowed.");
}

export async function runSqlite(request: QueryRequest, signal: AbortSignal): Promise<QueryResponse> {
  assertContained(request.sql);
  if (signal.aborted) throw new CancelledError();
  const result = await runProcess(process.execPath, ["--no-warnings", "--max-old-space-size=512", "-e", CHILD_SOURCE], {
    input: JSON.stringify(request),
    signal,
    label: "SQLite",
    maxOutputBytes: 64 * 1024 * 1024,
    env: { NODE_OPTIONS: "" },
  });
  if (result.stdoutTruncated) throw new ValidationError("The result is too large; lower maxRows or select fewer columns.");
  let message: ({ ok: true } & QueryResponse) | { ok: false; message: string };
  try {
    message = JSON.parse(result.stdout) as typeof message;
  } catch (error) {
    throw new ExternalProcessError(`SQLite child process returned no result: ${result.stderr.slice(0, 500)}`, { cause: error });
  }
  if (!message.ok) throw new ValidationError(`SQLite: ${message.message}`);
  return message;
}

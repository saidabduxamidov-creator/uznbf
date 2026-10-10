/**
 * Database package: query and modify local SQLite databases (project catalogues, app databases,
 * logs) and keep persistent project notes for the assistant. Reading a database needs
 * database.read on its path, changing it database.write; both ask the user by default. Queries run
 * in a separate process and are cancellable.
 */
import { stat } from "node:fs/promises";
import { NotFoundError, ValidationError, defineTool, defineToolPackage, text } from "@lmp/core";
import { canonicalizePath } from "@lmp/toolkit";
import { z } from "zod";
import { runSqlite, type Cell, type QueryResponse } from "./sqlite-runner.js";

const PATH = z.string().min(1).max(32_767).describe("Absolute path of a SQLite database file");
const canonical = (p: string) => canonicalizePath(p, { platform: process.platform });
const PARAM = z.union([z.string(), z.number(), z.null()]);
const PARAMS = z.union([z.array(PARAM).max(999), z.record(z.string().regex(/^[:@$]?[A-Za-z_][A-Za-z0-9_]*$/), PARAM)]).default([]);
const NOTE_KEY = z.string().min(1).max(120).regex(/^[\p{L}\p{N} _.\-/]+$/u, "letters, digits, space, _ . - /");

async function existing(p: string): Promise<string> {
  const file = await canonical(p);
  if (!(await stat(file).catch(() => undefined))?.isFile()) throw new NotFoundError(`Database not found: ${file}`);
  return file;
}

const show = (c: Cell) => (c === null ? "NULL" : typeof c === "object" ? `<blob ${c.blob} bytes>` : String(c).replace(/\s+/g, " ").slice(0, 200));

function table(r: QueryResponse, limit = 50): string {
  if (!r.columns.length) return "";
  const lines = [r.columns.join(" | "), ...r.rows.slice(0, limit).map((row) => row.map(show).join(" | "))];
  const more = r.rows.length > limit ? `\n… ${r.rows.length - limit} more row(s) in the structured result` : "";
  return `${lines.join("\n")}${more}${r.truncated ? "\n(row limit reached)" : ""}`;
}

interface Note {
  readonly text: string;
  readonly tags: readonly string[];
  readonly updatedAt: string;
}

export default defineToolPackage({
  manifest: {
    id: "database",
    version: "0.1.0",
    displayName: "Local databases",
    description: "Queries and edits local SQLite databases and keeps persistent project notes.",
    platforms: ["win32", "darwin", "linux"],
    capabilities: ["database.read", "database.write"],
  },
  register: ({ services }) => {
    const noteKey = (key: string) => `note:${key.trim().toLowerCase()}`;
    return {
      tools: [
        defineTool({
          name: "database.schema",
          title: "Database structure",
          description: "Lists the tables and views of a SQLite database with their columns and row counts.",
          input: z.object({ path: PATH }).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "io", timeoutMs: 60_000 },
          capabilities: (input) => [{ kind: "database.read", target: input.path, reason: "read database structure" }],
          run: async (input, ctx) => {
            const file = await existing(input.path);
            const objects = await runSqlite(
              { file, readOnly: true, sql: "SELECT name, type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name", params: [], maxRows: 2000, script: false },
              ctx.signal,
            );
            const tables = [];
            for (const [name, type] of objects.rows as [string, string][]) {
              const cols = await runSqlite({ file, readOnly: true, sql: "SELECT name, type, \"notnull\", pk FROM pragma_table_info(?)", params: [name], maxRows: 2000, script: false }, ctx.signal);
              const count = type === "table"
                ? await runSqlite({ file, readOnly: true, sql: `SELECT count(*) FROM "${name.replace(/"/g, '""')}"`, params: [], maxRows: 1, script: false }, ctx.signal)
                : null;
              tables.push({
                name,
                type,
                rows: count ? (count.rows[0]?.[0] as number) : null,
                columns: (cols.rows as [string, string, number, number][]).map(([n, t, nn, pk]) => ({ name: n, type: t, notNull: nn === 1, primaryKey: pk > 0 })),
              });
            }
            const summary = tables.map((t) => `${t.type} ${t.name}${t.rows !== null ? ` (${t.rows} rows)` : ""}: ${t.columns.map((c) => `${c.name} ${c.type}${c.primaryKey ? " PK" : ""}`).join(", ")}`);
            return { content: [text(summary.length ? summary.join("\n") : "The database has no tables.")], structured: { path: file, tables } };
          },
        }),

        defineTool({
          name: "database.query",
          title: "Query database",
          description: "Runs one read-only SQL statement (SELECT, WITH, read-only PRAGMA) with optional ? or :named parameters. The database is opened read-only.",
          input: z.object({ path: PATH, sql: z.string().min(1).max(100_000), params: PARAMS, maxRows: z.number().int().min(1).max(10_000).default(500) }).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "io", timeoutMs: 120_000 },
          capabilities: (input) => [{ kind: "database.read", target: input.path, reason: "query database" }],
          run: async (input, ctx) => {
            const file = await existing(input.path);
            const r = await runSqlite({ file, readOnly: true, sql: input.sql, params: input.params, maxRows: input.maxRows, script: false }, ctx.signal);
            return {
              content: [text(r.columns.length ? `${r.rows.length} row(s)\n${table(r)}` : "The statement returned no columns.")],
              structured: { columns: r.columns, rows: r.rows, truncated: r.truncated },
            };
          },
        }),

        defineTool({
          name: "database.execute",
          title: "Change database",
          description:
            "Changes a SQLite database: one statement with parameters, or (script: true) several statements without parameters run in a single transaction that is rolled back on any error. Creates the file when it does not exist.",
          input: z.object({ path: PATH, sql: z.string().min(1).max(1_000_000), params: PARAMS, script: z.boolean().default(false) }).strict(),
          annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: false },
          execution: { resourceClass: "io", timeoutMs: 10 * 60_000 },
          capabilities: (input) => [{ kind: "database.write", target: input.path, reason: "change database" }],
          run: async (input, ctx) => {
            if (input.script && (Array.isArray(input.params) ? input.params.length : Object.keys(input.params).length)) {
              throw new ValidationError("Scripts cannot take parameters; run parameterised statements one at a time.");
            }
            const file = await canonical(input.path);
            const r = await runSqlite({ file, readOnly: false, sql: input.sql, params: input.params, maxRows: 500, script: input.script }, ctx.signal);
            const rows = r.columns.length ? `\n${table(r)}` : "";
            return {
              content: [text(`${r.changes} row(s) changed.${r.lastInsertRowid !== null ? ` Last inserted row id: ${r.lastInsertRowid}.` : ""}${rows}`)],
              structured: { changes: r.changes, lastInsertRowid: r.lastInsertRowid, columns: r.columns, rows: r.rows },
            };
          },
        }),

        defineTool({
          name: "database.note_save",
          title: "Save note",
          description: "Saves a persistent note (project facts, client preferences, edit decisions) that both Claude and ChatGPT can read in later conversations.",
          input: z.object({ key: NOTE_KEY, text: z.string().min(1).max(100_000), tags: z.array(z.string().min(1).max(40)).max(20).default([]) }).strict(),
          annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async (input) => {
            const note: Note = { text: input.text, tags: input.tags, updatedAt: new Date().toISOString() };
            await services.kv.set(noteKey(input.key), note);
            return { content: [text(`Saved note "${input.key}".`)], structured: { key: input.key } };
          },
        }),

        defineTool({
          name: "database.note_get",
          title: "Read note",
          description: "Reads a saved note.",
          input: z.object({ key: NOTE_KEY }).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async (input) => {
            const note = await services.kv.get<Note>(noteKey(input.key));
            if (!note) throw new NotFoundError(`No note named "${input.key}". List notes with database.note_list.`);
            return { content: [text(note.text)], structured: { key: input.key, ...note } };
          },
        }),

        defineTool({
          name: "database.note_list",
          title: "List notes",
          description: "Lists saved notes, optionally filtered by tag or text.",
          input: z.object({ tag: z.string().max(40).optional(), search: z.string().max(200).optional() }).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async (input) => {
            const keys = (await services.kv.keys()).filter((k) => k.startsWith("note:"));
            const notes = [];
            for (const k of keys.sort()) {
              const note = await services.kv.get<Note>(k);
              if (!note) continue;
              if (input.tag && !note.tags.includes(input.tag)) continue;
              if (input.search && !`${k} ${note.text}`.toLowerCase().includes(input.search.toLowerCase())) continue;
              notes.push({ key: k.slice(5), tags: note.tags, updatedAt: note.updatedAt, preview: note.text.slice(0, 120) });
            }
            return {
              content: [text(notes.length ? notes.map((n) => `${n.key}${n.tags.length ? ` [${n.tags.join(", ")}]` : ""}: ${n.preview}`).join("\n") : "No notes.")],
              structured: { notes },
            };
          },
        }),

        defineTool({
          name: "database.note_delete",
          title: "Delete note",
          description: "Deletes a saved note.",
          input: z.object({ key: NOTE_KEY }).strict(),
          annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async (input) => {
            const removed = await services.kv.delete(noteKey(input.key));
            return { content: [text(removed ? `Deleted note "${input.key}".` : `No note named "${input.key}".`)], structured: { deleted: Boolean(removed) } };
          },
        }),
      ],
    };
  },
});

export { assertContained, stripSqlLiterals } from "./sqlite-runner.js";

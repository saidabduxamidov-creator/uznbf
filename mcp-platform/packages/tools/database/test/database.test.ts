import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import path from "node:path";
import { CancelledError, NotFoundError, ValidationError, type ToolPackage } from "@lmp/core";
import { createToolHarness, type ToolHarness } from "@lmp/toolkit";
import databasePackage, { assertContained } from "../src/index.js";

describe("SQL containment", () => {
  it("rejects statements that reach other files, ignoring literals and comments", () => {
    assert.throws(() => assertContained("ATTACH DATABASE 'C:/x.db' AS x"), ValidationError);
    assert.throws(() => assertContained("vacuum\n into 'D:/copy.db'"), ValidationError);
    assert.throws(() => assertContained("SELECT load_extension('evil')"), ValidationError);
    assert.doesNotThrow(() => assertContained("SELECT 'attach me' AS label -- detach\n FROM t /* vacuum into */"));
    assert.doesNotThrow(() => assertContained('SELECT "attach" FROM t'));
  });
});

describe("database tools", () => {
  let h: ToolHarness;
  let db: string;
  before(async () => {
    h = await createToolHarness(databasePackage as ToolPackage<unknown>);
    db = path.join(h.dir, "loyiha.db");
  });
  after(() => h.close());

  it("creates, changes and queries a database", async () => {
    const s = await h.run("database.execute", {
      path: db,
      script: true,
      sql: "CREATE TABLE clips(id INTEGER PRIMARY KEY, name TEXT NOT NULL, seconds REAL, thumb BLOB); INSERT INTO clips(name, seconds) VALUES ('intro', 4.5), ('toʻy', 120);",
    });
    assert.equal((s.structured as { changes: number }).changes, 2);
    const ins = await h.run("database.execute", { path: db, sql: "INSERT INTO clips(name, seconds, thumb) VALUES (?, ?, x'0102')", params: ["outro", 3] });
    assert.deepEqual(ins.structured, { changes: 1, lastInsertRowid: 3, columns: [], rows: [] });
    const q = await h.run("database.query", { path: db, sql: "SELECT id, name, thumb FROM clips WHERE seconds > :min ORDER BY id", params: { min: 4 } });
    assert.deepEqual(q.structured, { columns: ["id", "name", "thumb"], rows: [[1, "intro", null], [2, "toʻy", null]], truncated: false });
    const blob = await h.run("database.query", { path: db, sql: "SELECT thumb FROM clips WHERE id = 3" });
    assert.deepEqual((blob.structured as { rows: unknown[] }).rows, [[{ blob: 2 }]]);
    const lim = await h.run("database.query", { path: db, sql: "SELECT * FROM clips", maxRows: 2 });
    assert.equal((lim.structured as { truncated: boolean }).truncated, true);
    const schema = await h.run("database.schema", { path: db });
    const t = (schema.structured as { tables: { name: string; rows: number; columns: { name: string; primaryKey: boolean }[] }[] }).tables[0];
    assert.equal(t?.name, "clips");
    assert.equal(t?.rows, 3);
    assert.equal(t?.columns.find((c) => c.primaryKey)?.name, "id");
  });

  it("keeps queries read-only and scripts atomic", async () => {
    await assert.rejects(h.run("database.query", { path: db, sql: "DELETE FROM clips" }), /readonly/);
    await assert.rejects(h.run("database.execute", { path: db, script: true, sql: "INSERT INTO clips(name) VALUES ('a'); INSERT INTO nope VALUES (1);" }), ValidationError);
    const count = await h.run("database.query", { path: db, sql: "SELECT count(*) AS n FROM clips" });
    assert.deepEqual((count.structured as { rows: unknown[] }).rows, [[3]], "rolled back");
    await assert.rejects(h.run("database.execute", { path: db, script: true, sql: "SELECT 1", params: [1] }), ValidationError);
    await assert.rejects(h.run("database.query", { path: path.join(h.dir, "none.db"), sql: "SELECT 1" }), NotFoundError);
  });

  it("cancels a runaway query", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const run = h.run("database.query", { path: db, sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n" }, { signal: ac.signal });
    setTimeout(() => ac.abort(new CancelledError()), 200);
    await assert.rejects(run, CancelledError);
    assert.ok(Date.now() - started < 3000);
  });

  it("declares path capabilities", () => {
    assert.deepEqual(h.capabilities("database.query", { path: db, sql: "SELECT 1" }), [{ kind: "database.read", target: db, reason: "query database" }]);
    assert.equal((h.capabilities("database.execute", { path: db, sql: "x" }) as { kind: string }[])[0]?.kind, "database.write");
  });

  it("stores notes", async () => {
    await h.run("database.note_save", { key: "Mijoz/Aziz", text: "Rang: iliq, musiqa: sokin", tags: ["mijoz"] });
    await h.run("database.note_save", { key: "eslatma", text: "Logotip pastki o'ngda" });
    assert.equal((await h.run("database.note_get", { key: "mijoz/aziz" })).content[0]?.type, "text");
    const byTag = await h.run("database.note_list", { tag: "mijoz" });
    assert.deepEqual((byTag.structured as { notes: { key: string }[] }).notes.map((n) => n.key), ["mijoz/aziz"]);
    const search = await h.run("database.note_list", { search: "logotip" });
    assert.equal((search.structured as { notes: unknown[] }).notes.length, 1);
    await h.run("database.note_delete", { key: "eslatma" });
    await assert.rejects(h.run("database.note_get", { key: "eslatma" }), NotFoundError);
    await assert.rejects(h.run("database.note_save", { key: "bad<key>", text: "x" }), ValidationError);
  });
});

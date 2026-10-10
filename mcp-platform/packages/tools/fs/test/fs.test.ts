import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ConflictError, NotFoundError, ValidationError, type ToolPackage } from "@lmp/core";
import { createToolHarness, type ToolHarness } from "@lmp/toolkit";
import fsPackage, { decodeText } from "../src/index.js";

const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("fs tool package", () => {
  let h: ToolHarness;
  let root: string;
  before(async () => {
    h = await createToolHarness(fsPackage as ToolPackage<unknown>);
    root = path.join(h.dir, "work");
    await mkdir(path.join(root, "clips", "day1"), { recursive: true });
    await writeFile(path.join(root, "clips", "a.mp4"), "x");
    await writeFile(path.join(root, "clips", "day1", "interview.mp4"), "xy");
    await writeFile(path.join(root, ".hidden"), "");
    await writeFile(path.join(root, "pic.png"), PNG_1x1);
  });
  after(() => h.close());

  it("declares the exact capability and target for every call", () => {
    assert.deepEqual(h.capabilities("fs.move", { from: "/a", to: "/b" }).map((c) => (c as { kind: string }).kind), ["fs.write", "fs.write"]);
    assert.deepEqual(h.capabilities("fs.read_text", { path: "/x.txt" }), [{ kind: "fs.read", target: "/x.txt", reason: "read file" }]);
  });

  it("lists, filters, recurses and hides dot files", async () => {
    const flat = await h.run("fs.list_directory", { path: root });
    const names = (flat.structured as { entries: Array<{ name: string }> }).entries.map((e) => e.name);
    assert.deepEqual(names, ["clips", "pic.png"]);
    const deep = await h.run("fs.list_directory", { path: root, recursive: true, pattern: "*.mp4" });
    assert.deepEqual((deep.structured as { entries: Array<{ name: string }> }).entries.map((e) => e.name).sort(), ["a.mp4", "interview.mp4"]);
    await assert.rejects(h.run("fs.list_directory", { path: path.join(root, "pic.png") }), ValidationError);
    await assert.rejects(h.run("fs.list_directory", { path: path.join(root, "nope") }), NotFoundError);
    await assert.rejects(h.run("fs.list_directory", { path: "relative" }), ValidationError);
  });

  it("writes atomically with create/overwrite/append semantics", async () => {
    const file = path.join(root, "notes", "a.srt");
    await assert.rejects(h.run("fs.write_text", { path: file, content: "x" }), NotFoundError);
    await h.run("fs.write_text", { path: file, content: "1\n", createDirectories: true, bom: true });
    await assert.rejects(h.run("fs.write_text", { path: file, content: "again" }), ConflictError);
    await h.run("fs.write_text", { path: file, content: "2\n", mode: "append" });
    const raw = await readFile(file);
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const read = await h.run("fs.read_text", { path: file });
    assert.match((read.content[0] as { text: string }).text, /^1\n2\n$/);
    await h.run("fs.write_text", { path: file, content: "new", mode: "overwrite" });
    assert.equal(await readFile(file, "utf8"), "new");
  });

  it("reads in chunks without splitting UTF-8 characters, and decodes UTF-16", async () => {
    const file = path.join(root, "uz.txt");
    await writeFile(file, "Oʻzbekiston".repeat(10));
    const first = await h.run("fs.read_text", { path: file, maxBytes: 5 });
    const s = first.structured as { nextOffset: number; truncated: boolean };
    assert.ok(s.truncated);
    let all = (first.content[0] as { text: string }).text.split("\n…")[0] ?? "";
    let offset = s.nextOffset;
    for (let i = 0; i < 100 && offset; i++) {
      const r = await h.run("fs.read_text", { path: file, offset, maxBytes: 7 });
      all += (r.content[0] as { text: string }).text.split("\n…")[0];
      offset = (r.structured as { nextOffset?: number }).nextOffset ?? 0;
    }
    assert.equal(all, "Oʻzbekiston".repeat(10));
    assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Salom", "utf16le")])).text, "Salom");
    await assert.rejects(h.run("fs.read_text", { path: path.join(root, "pic.png") }), /binary file/);
  });

  it("returns images by content type, not extension", async () => {
    const r = await h.run("fs.read_image", { path: path.join(root, "pic.png") });
    assert.equal(r.content[0]?.type, "image");
    await writeFile(path.join(root, "fake.png"), "not an image");
    await assert.rejects(h.run("fs.read_image", { path: path.join(root, "fake.png") }), /not a PNG/);
  });

  it("finds, moves without clobbering, stats and hashes", async () => {
    const found = await h.run("fs.find", { root, pattern: "*interview*" });
    assert.equal((found.structured as { matches: string[] }).matches.length, 1);
    const from = path.join(root, "clips", "a.mp4");
    const to = path.join(root, "clips", "day1", "interview.mp4");
    await assert.rejects(h.run("fs.move", { from, to }), ConflictError);
    await h.run("fs.move", { from, to: path.join(root, "renamed.mp4") });
    const st = await h.run("fs.stat", { path: from });
    assert.equal((st.structured as { exists: boolean }).exists, false);
    const hash = await h.run("fs.hash", { path: path.join(root, "renamed.mp4") });
    assert.equal((hash.structured as { hex: string }).hex, "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
  });

  it("operates on the real target of symlinks (same path the permission gate checked)", async () => {
    const real = path.join(h.dir, "outside");
    await mkdir(real);
    await writeFile(path.join(real, "secret.txt"), "s");
    await symlink(real, path.join(root, "link"), "dir");
    const r = await h.run("fs.stat", { path: path.join(root, "link", "secret.txt") });
    assert.equal((r.structured as { path: string }).path, path.join(real, "secret.txt"));
  });
});
